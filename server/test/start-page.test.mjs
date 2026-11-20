// Try Valun (/start, public/start.html): the first-use page for people who try the testnet. It is served like the
// other public pages (lib/http.mjs STATIC) under the CSP, with the shared navigation and footer. A visitor picks one of
// four paths (connect my agent, explore without an agent, inspect the network, build an integration), and each path
// says, in this order, who it is for, what it needs, what you approve and what stays on your machine, what becomes
// public, the first thing to do with what you should see, how to check it, what to do when something fails, and how to
// report. Then: backing and budget cards, the evidence for each way to connect, the known issues of the client release,
// the reference (install, credentials, public, limits, the old pilot, troubleshooting), and where to report.
// Its commands are pinned to the client release skill.md pins; its numbers are the server's own; and it claims nothing
// beyond what works (redemption only against the issuer's reserve; a netting committed, not final; a guarantee a
// promise, not collateral; no host app called tested beyond the evidence). Its script wraps and copies commands, turns
// the chooser into tabs, and reads one public route, GET /pilot/v1/chain, with no token.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {readBody, Element} from './network-dom.mjs';
import {settle} from './console-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const src = f => fs.readFileSync(path.join(root, f), 'utf8');
const {createHandler} = await import('../lib/http.mjs');
const core = await import('../lib/pilot/core.mjs');
const routes = await import('../lib/pilot/http.mjs');
const sandbox = await import('../lib/pilot/sandbox.mjs');
const units = await import('../lib/pilot/units.mjs');
const anchors = await import('../lib/pilot/anchors.mjs');
const windows = await import('../lib/pilot/caps.mjs');
const html = pub('start.html');
// The page's words, as a reader sees them: no tags (an inline one leaves no space), character references decoded,
// whitespace collapsed.
const words = h => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<\/?(?:code|a|b|strong|em|span|wbr)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const body = h => /<body>([\s\S]*)<\/body>/.exec(h)[1];
// The element with id `id`, from its opening tag to its own closing tag (elements of the same name nest inside).
function part(id, h = html) {
  const open = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\sid="${id}"[^>]*>`).exec(h);
  if (!open) return null;
  const tag = new RegExp(`<(/?)${open[1]}\\b[^>]*>`, 'g');
  tag.lastIndex = open.index + open[0].length;
  for (let depth = 1, m; (m = tag.exec(h));) if (!(depth += m[1] ? -1 : 1)) return h.slice(open.index, m.index + m[0].length);
  return null;
}
const text = id => words(part(id));
// The command blocks: {id: text}, as written in the page.
const blocks = Object.fromEntries([...html.matchAll(/<pre><code id="([^"]+)">([^<]*)<\/code><\/pre>/g)].map(m => [m[1], m[2].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')]));
const thousands = n => n.toLocaleString('en-US');
const PATHS = [['agent', 'Connect my agent', 'Connect your agent'], ['tour', 'Explore without an agent', 'Explore without an agent'],
  ['ergo', 'Inspect the network', 'Inspect the network'], ['build', 'Build an integration', 'Build an integration']];

let server, base;
before(async () => {
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const get = (p, host) => new Promise((resolve, reject) => {
  const r = http.request(base + p, {headers: host ? {host} : {}}, res => {
    let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: b}));
  });
  r.on('error', reject); r.end();
});

test('/start is served like the other public pages: on every host, with its stylesheets and script, under the CSP', async () => {
  for (const [p, host] of [['/start'], ['/start/'], ['/start', 'valun.tech'], ['/start', 'valun-testnet.fly.dev']]) {
    const r = await get(p, host);
    assert.equal(r.status, 200, `${p} ${host ?? ''}`);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(r.headers['content-security-policy'], /default-src 'self'.*style-src 'self'; script-src 'self'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.text, html);
  }
  for (const [p, type] of [['/start.css', 'text/css; charset=utf-8'], ['/start.js', 'text/javascript; charset=utf-8'], ['/site.css', 'text/css; charset=utf-8']]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.text, pub(p.slice(1)), p);
  }
  assert.equal((await get('/start.html')).status, 404, 'only the route is served, not the file name');
  assert.match(src('lib/http.mjs'), /\['\/start', 'start\.html'\]/);
});

test('the page keeps the CSP: its own script and stylesheets only, nothing inline, outside links only as links; the script reads one public route', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]);
  assert.deepEqual(scripts, ['<script type="module" src="/start.js">']);
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|javascript:/i, 'no inline style or event handler');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site.css', '/start.css']);
  assert.doesNotMatch(html, /<(?:img|iframe|object|embed)\b[^>]*\ssrc="https?:/i);
  const outside = [...new Set([...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(outside, ['https://docs.astral.sh/uv/', 'https://github.com/fitzss/hermes-plugin-valun', 'https://github.com/fitzss/valun-open',
    'https://github.com/fitzss/valun-open/blob/main/server/docs/PILOT-API.md', 'https://github.com/fitzss/valun-open/blob/main/spec/PROTOCOL.md',
    'https://github.com/fitzss/valun-open/issues/new?template=tester-report.yml', 'https://github.com/fitzss/valun-open/tree/main/js',
    'https://github.com/fitzss/valun-open/tree/main/python', 'https://testnet.ergofaucet.org', 'https://valun.tech/start']);
  // The script reads exactly one thing, the public chain view, as a GET without credentials, and keeps nothing.
  const js = pub('start.js');
  const fetches = [...js.matchAll(/\bfetch\(([^)]*)\)/g)].map(m => m[1]);
  assert.deepEqual(fetches, ["'/pilot/v1/chain', {credentials: 'omit', cache: 'no-store', headers: {accept: 'application/json'}}"]);
  assert.doesNotMatch(js, /XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|authorization|bearer|method:/i,
    'no other read, no storage, no HTML from data, no token');
  assert.doesNotMatch(pub('start.css'), /@import|url\(/i, 'no outside font or image');
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/valun\.tech\/start">/);
  assert.match(html, /<title>Try Valun<\/title>/);
});

test('the shared navigation (Start marked as the current page), the skip link, one main, and the shared footer', () => {
  const b = body(html);
  assert.match(b, /^\s*<a class="skip" href="#main">Skip to content<\/a>\s*<header class="top"><a class="brand" href="\/" aria-label="Valun home"><svg class="mark" [^]*?<\/svg><span class="wordmark">Valun<\/span><\/a>/);
  const nav = /<nav aria-label="Main"><ul>([\s\S]*?)<\/ul><\/nav><\/header>/.exec(b)?.[1];
  assert.equal(nav, '<li><a href="/start" aria-current="page">Start</a></li><li><a href="/network">Network</a></li><li><a href="/trust">Trust</a></li>'
    + '<li><a href="/memory">Memory</a></li><li><a href="https://github.com/fitzss/valun-open">GitHub</a></li>');
  assert.equal((b.match(/<main\b/g) || []).length, 1);
  assert.match(b, /<main id="main" class="start">/);
  assert.equal((b.match(/aria-current=/g) || []).length, 1);
  const foot = /<footer class="foot">([\s\S]*?)<\/footer>/.exec(b)?.[1] ?? '';
  assert.match(foot, /<p>Ergo testnet · test coins only, with no monetary value<\/p>/);
  assert.deepEqual([...foot.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]),
    [['/trust', 'Trust'], ['/start#report', 'Report a problem'], ['/skill.md', 'skill.md'], ['/llms.txt', 'llms.txt'], ['https://github.com/fitzss/valun-open', 'GitHub']]);
  // One h1; every section of the page is named by an h2 (no eyebrow stands for a heading).
  assert.equal((b.match(/<h1\b/g) || []).length, 1);
  for (const m of b.matchAll(/<section\b[^>]*\sid="([^"]+)"[^>]*aria-labelledby="([^"]+)"/g)) assert.match(b, new RegExp(`<h2 id="${m[2]}">`), m[1]);
  assert.doesNotMatch(b, /class="eyebrow"/);
});

test('no pilot units: PC only where the known issues explain it, and the pilot only as retired', () => {
  const text_ = words(body(html));
  assert.doesNotMatch(text_, /pilot credits|synthetic/i);
  // valun 0.7.2 names nanoERG with tERG before a join too (its CHANGELOG: "Amounts in the network's unit, never PC"), so
  // the page no longer explains a PC: only what some of 0.7.1's texts called a credit.
  assert.doesNotMatch(words(body(html)), /\bPC\b/, 'no PC on the testnet\'s page');
  assert.match(text('build'), /Some of valun 0\.7\.1's texts gave amounts in the retired pilot's credits: 1 credit = 1,000,000 nanoERG = 0\.001 tERG\. Amounts are whole nanoERG\./);
  // Outside its own reference section "pilot" is only in the URLs /pilot#owner and /pilot/v1/..., or "the retired pilot".
  const rest = words(body(html).replace(part('pilot'), '')).replace(/\/pilot(?:\/v1(?:\/[a-z]+)?|#owner)/g, '');
  for (const m of rest.matchAll(/.{0,40}\bpilot\b.{0,20}/gi)) assert.match(m[0], /retired pilot/, m[0]);
  const old = text('pilot');
  assert.match(old, /Used the old pilot\?/);
  assert.match(old, /The pilot network \(valun-pilot-1, credits with no chain\) was retired on 2026-11-13/);
  assert.match(old, /Join again in a new profile, with a new owner token file/);
  assert.match(blocks['cmd-pilot'], /^uvx --from valun==\S+ valun --profile testnet join --sandbox /);
  assert.match(old, /claude mcp add valun -- uvx --from valun==\S+ valun --profile testnet mcp/);
});

test('the chooser comes first, with the four paths; each path says what it needs, approves, keeps and makes public, then its steps, checks, failures and report', () => {
  const b = body(html);
  // The help link sits above the chooser, and the chooser above every path.
  assert.ok(b.indexOf('<p class="stuck"><a href="#report">Stuck? Tell us</a></p>') > 0);
  assert.ok(b.indexOf('Stuck? Tell us') < b.indexOf('id="paths"'));
  assert.ok(b.indexOf('id="paths"') < b.indexOf('<section class="path" id="agent"'));
  const chooser = part('paths');
  assert.deepEqual([...chooser.matchAll(/<li><a href="(#[a-z]+)"><span class="t" id="([^"]+)">([^<]+)<\/span>/g)].map(m => [m[1], m[3]]),
    PATHS.map(([id, tab]) => [`#${id}`, tab]));
  assert.match(html, /<h2 id="paths-h">Pick a path<\/h2>/);
  for (const [id, , h2] of PATHS) {
    const s = part(id);
    assert.ok(s, id);
    assert.match(s, new RegExp(`^<section class="path" id="${id}" aria-labelledby="${id}-h">\\s*<h2 id="${id}-h">${h2}</h2>\\s*<p class="path-lede">For `), `${id}: who it is for`);
    assert.deepEqual([...s.matchAll(/<h3 id="[^"]+">([^<]+)<\/h3>/g)].map(m => m[1]), ['Before you start', 'Steps', 'Check it', 'If something goes wrong', 'Tell us'], id);
    assert.deepEqual([...s.matchAll(/<dt>([^<]+)<\/dt>/g)].slice(0, 4).map(m => m[1]), ['You need', 'You approve', 'Stays on your machine', 'Becomes public'], id);
    const steps = /<ol class="steps">[\s\S]*?<h3 id="[a-z]+-check">/.exec(s)?.[0] ?? '';
    assert.match(steps, /<div class="cmd">/, `${id}: the exact command or prompt`);
    assert.match(steps, /<div class="expect seen">\s*<p class="expect-k">You should see<\/p>/, `${id}: what you should see`);
    assert.match(/<h3 id="[a-z]+-tell">Tell us<\/h3>[\s\S]*$/.exec(s)[0], /<a href="#report">tester report<\/a>/, `${id}: how to report`);
    assert.match(words(/<h3 id="[a-z]+-tell">[\s\S]*$/.exec(s)[0]), /Never paste your owner token, a key or a profile file|Leave out tokens and keys/, `${id}: credentials stay out`);
  }
  // Whether each path needs an agent, a model, a wallet or tERG.
  assert.match(text('agent'), /You need Your agent, with the model it already uses: Valun needs no model or API key of its own\. [^.]*\. No wallet and no tERG\./);
  assert.match(text('tour'), /No AI model, no wallet and no tERG\./);
  assert.match(text('ergo'), /uv for the audit, which needs no profile, key, wallet or tERG\. To redeem a note, a joined profile \(the tour's\) and still no tERG\. To post a reserve, tERG from a testnet faucet/);
  assert.match(text('build'), /No wallet and no tERG\./);
  // What fails, and what to do: each path's own cases.
  const cases = id => [...part(id).matchAll(/<summary>(?:<span>)?((?:(?!<\/summary>)[\s\S])*?)(?:<\/span>)?<\/summary>/g)].map(m => words(m[1]).trim())
    .filter(t => !/^(?:Any agent|Claude Code|Hermes Agent|Or take|Or close|Then house-scribe|The commands|The same from)/.test(t));
  assert.deepEqual(cases('agent'), ["Your app can't show approval prompts", "The valun tools don't appear in your app", 'The network is busy', "house-scribe declines or doesn't answer",
    'The daily anchoring cap is used up', 'The audit says UNKNOWN', 'A connection error, or join stopped halfway', 'A tool answered internal_error or a connection error', 'Setup fails']);
  assert.deepEqual(cases('tour'), ['The tour waits', 'Joining failed (handle_taken)', 'The network is busy', 'No one is at the terminal',
    'A connection error, or join stopped halfway', 'Setup fails']);
  assert.deepEqual(cases('ergo'), ['The audit says UNKNOWN', 'The daily anchoring cap is used up', 'The audit says MISMATCH', 'A redemption is answered reserve_busy',
    'ergo chain says the profile is not joined', 'A connection error, or join stopped halfway', 'Setup fails']);
  assert.deepEqual(cases('build'), ['not_configured', 'approval_unavailable', '503 signer_unavailable', 'The network is busy', 'Your digest differs from R5',
    'Connection errors in Python only', 'A text speaks of the retired pilot']);
  // The join a lost connection stopped, and the connection errors only Python gets (the muse agent's run): each path's
  // own list, and the reference's, sends you to both known issues; never to the enroll 0.7.1 suggests.
  for (const id of ['agent-trouble', 'tour-trouble', 'ergo-trouble', 'build-trouble']) {
    const list = /<div class="trouble">[\s\S]*?<\/div>\s*<h3/.exec(html.slice(html.indexOf(`<h3 id="${id}">`)))[0];
    for (const target of ['#known-join', '#known-cut']) assert.ok(list.includes(`<a href="${target}">`), `${id} links ${target}`);
  }
  assert.ok(text('help').includes("A connection error, or join stopped halfway If join stopped before it finished, run the command it printed (doctor names it again); in Hermes, don't run the enroll the plugin's join suggests: see a lost connection during join."));
  for (const target of ['#known-join', '#known-cut']) assert.ok(part('help').includes(`<a href="${target}">`), `help links ${target}`);
  // An app that cannot ask: nothing is signed, console waits in the owner console, and client-prompt asks nobody in an app
  // that does not confirm tool calls.
  const noPrompt = text('no-prompt');
  assert.match(noPrompt, /An app that cannot show that prompt gets approval_unavailable for every commitment, and nothing is signed/);
  assert.match(noPrompt, /With console, what your agent signs \(its offers, acceptances, guarantee offers and the note at each delivery\) waits until you approve it in the owner console, valun\.tech\/pilot#owner, with your owner token/);
  assert.match(noPrompt, /in an app that does not confirm tool calls, nobody is asked/);
  assert.match(part('no-prompt'), /<a href="\/pilot#owner">/);
  // Console protects the owner only while the agent can't read the owner token (the lead's decisions D12 and D12b): the
  // token is never typed into a command (shell history), the file join wrote is the one to use and then to move; a file
  // made again comes from a text editor (valun 0.7.1 reads the token file as UTF-8, and Windows PowerShell 5.1's >
  // writes UTF-16); and how to leave console.
  assert.ok(noPrompt.includes("Console approvals protect you only while your agent can't read your owner token. Don't type the token into a command: it stays in your shell history. Keep the file join wrote, move it into your password manager, and paste the token only into the console's sign-in. So run this command with that file before you move it."));
  // valun 0.7.2's config approvals asks for the token at a terminal when no file is given (cli.py cmd_config,
  // _owner_token: getpass), and reads a file as UTF-8 only.
  assert.ok(noPrompt.includes("If your token is in a password manager already, leave out --owner-token-file: in a terminal, valun 0.7.3 asks you for the token (not shown), reads it once and never stores it. A file you make for it is read as UTF-8: make it in a text editor (Notepad on Windows), not with echo, and not with > in Windows PowerShell, which writes UTF-16 that valun can't read there. Delete it after the command."));
  assert.match(noPrompt, /To leave console later, run the same command with ask \(or none\) in place of console, with the token again\. Accepted deliveries keep waiting in the console until you untick Review deliveries there\. valun console prints the owner console's address and where your token file is \(never the token\), and opens it in your browser\./);
  assert.match(pub('pilot.js'), /'Review deliveries \(review_deliveries\)'/, 'the owner console\'s label');
  // What the one real-app run showed, and what it didn't: ask and client-prompt in headless Claude Code, nothing else
  // headless; a terminal prompt answers whoever is at it.
  assert.match(noPrompt, /Claude Code is designed to ask before each such call unless you have allowed the tool, which is not yet verified/);
  assert.match(noPrompt, /In the Nov 17 run, headless Claude Code \(claude -p\) cancelled the ask prompt by itself/);
  assert.match(noPrompt, /Other headless setups haven't been tried: choose console or none on purpose\./);
  assert.match(noPrompt, /valun call asks whoever is at its terminal, so an agent that drives a terminal could answer for you/);
  // Hermes has no config approvals: the plugin's own way to switch, said to be unverified in a real Hermes.
  assert.match(noPrompt, /In Hermes, which has no config approvals command: for console, set Ask me above \(approve_above\) to 0 and tick Review deliveries in the owner console; for console or none, then run hermes -p valun config set plugins\.entries\.valun\.settings\.confirm_commitments false\. That is what plugin 0\.7\.1 itself says to do; it is not yet verified in a real Hermes\./);
  // Console needs someone approving (the newcomer run of Nov 18, finding 3: "none or console" for a run with nobody).
  assert.match(text('agent'), /a run with nobody to answer \(chat -q, a timer\) needs none, or console with you approving: choose it at join, or switch later \(how\)/);
  // The MCP path's likeliest first failure: the tools never appear.
  assert.match(text('agent'), /The valun tools don't appear in your app Restart the app: it starts the valun server only when it starts\. In Claude Code, run \/mcp or claude mcp list: you should see valun connected; after a join with the plugin, select plugin:valun:valun and choose Reconnect\./);
  // A taken handle, the likeliest first failure of the tour, and the traceback Ctrl+C prints.
  // The refused join recorded nothing; the handle is another participant's, or an earlier join's that didn't finish (its
  // token file, if it wrote one, is not to be overwritten: valun 0.7.1 prints the token instead).
  assert.match(text('tour'), /Joining failed \(handle_taken\) This join recorded nothing and wrote no token file: another participant has the handle, or an earlier join with it didn't finish\. Pick another handle and run the three lines again; ignore what doctor and the tour print after a failed join\./);
  for (const id of ['tour', 'help']) assert.ok(text(id).includes('If that earlier join wrote a token file, give the next one another file name.'), id);
  // valun 0.7.2 ends Ctrl+C with a short message, never a traceback (cli.py: "The tour stopped (Ctrl+C). Run ... again").
  assert.match(text('tour'), /what was done stays done, and it continues from the step it reached: it says so when you stop it\./);
  assert.doesNotMatch(words(body(html)), /KeyboardInterrupt/);
  assert.match(text('help'), /Joining failed \(handle_taken\) This join recorded nothing and wrote no token file: another participant has the handle, or an earlier join with it didn't finish\./);
  assert.doesNotMatch(words(body(html)), /Nothing was recorded and no token file was written/);
  // uv is linked from every path that needs it, and the tour says how to run it with pipx.
  for (const id of ['agent', 'tour', 'ergo']) assert.match(/<dt>You need<\/dt>\s*<dd>[\s\S]*?<\/dd>/.exec(part(id))[0], /<a href="#install">uv<\/a>/, id);
  assert.match(text('tour'), /With pipx, run pipx install valun==\S+ once and type valun where the commands say uvx --from valun==\S+ valun\./);
  // The daily anchoring cap, from the code, where anchoring matters; never "within 8 minutes".
  for (const id of ['agent', 'ergo', 'help']) assert.match(text(id), new RegExp(`at most ${anchors.DAILY_TRACKER_SIGNATURES} tracker boxes a UTC day`), id);
  assert.match(text('ergo'), /anchoring\.state is then daily_cap_reached, and anchoring\.daily_cap has the day's count/);
  assert.doesNotMatch(words(body(html)), /within 8 minutes/);
});

// Fix inbox #173: the first job is sandbox-exact's text-stats, which needs no AI budget, so it always answers; house-scribe
// comes after it, labelled as possibly out of its shared AI budget.
test('the first meaningful action of each path: hiring sandbox-exact or the tour through the agent, the tour, the audit, a read from code', () => {
  assert.equal(blocks['cmd-hire'], 'Use Valun to hire sandbox-exact: text-stats of the text after this line, for 3000000 nanoERG. '
    + 'Check the result against the terms before you accept it.\nPASTE THE TEXT HERE');
  assert.equal(blocks['cmd-agent-tour'], 'Take the Valun sandbox tour: call valun_status and follow its sandbox_next_steps until it says the tour is complete.');
  const agent = text('agent');
  assert.match(agent, /Hire sandbox-exact for a text-stats job sandbox-exact operator-run is a practice agent with no AI model: exact results, no budget to run out, an answer within seconds\./);
  assert.ok(agent.indexOf('Hire sandbox-exact for a text-stats job') < agent.indexOf('Then house-scribe, for a real summary (it may be out of budget)'), 'sandbox-exact first, house-scribe after it');
  assert.match(agent, /house-scribe operator-run writes summaries with Claude \(if it declines\)\./);
  assert.match(agent, /Paste only text you're happy for the operator and Anthropic's Claude API to read\./);
  // What you should see, mode by mode: console (what the owner must do), ask as not yet verified in a real app, none.
  assert.match(agent, /Your agent offers sandbox-exact 0\.003 tERG \(3,000,000 nanoERG\) and gets the result in seconds\. It checks it, accepts it and signs its note; the deal then says note_issued, and your agent owes sandbox-exact 0\.003 tERG, less what a loop clears once its client signs the set-off, if it still holds the welcome job's note\./);
  assert.match(agent, /With console: approve the offer at \/pilot#owner, tell your agent to carry on, then approve its note there after it accepts the result\./);
  assert.match(agent, /With ask \(not yet verified in a real app\): your app should ask twice, for the offer and the note, each a form with one box, Approve: tick it and accept to sign; anything else signs nothing\. The second shows the delivery's size and hash, not its text: read the result in your agent's reply first\. With none, nobody is asked\./);
  // valun 0.7.2 reads the tour's step from what you hold and owe with the practice agents (agent.py _sandbox_next_steps).
  assert.match(agent, /Want the tour\? Take it first: valun 0\.7\.3 reads its step from what you hold and owe with the practice agents\./);
  assert.match(agent, /With ask, your app should ask before each commitment, 8 or 9 times; with console, each offer and acceptance, and the note or payment by transfer at each delivery, waits for you in the owner console\. At the end, valun_status says the tour is complete/);
  // A loop with friends: the prompt, who goes first, and what every friend must keep running.
  assert.equal(blocks['cmd-friends'], 'Use Valun to hire FRIEND-HANDLE: ask what it offers, agree on one small job for 2000000 nanoERG, and check the work against the terms before you accept it.');
  const friends = text('friends-loop');
  assert.match(friends, /^ Or close a loop with friends Each of you connects an agent as above\. Each agent buys one small job from the next person's agent, and the last buys from the first\. Anyone can go first; the last purchase closes the loop\./);
  // What every friend keeps running: an MCP app or Hermes runs the consent loop; a shell agent signs the set-off only
  // in valun clearing (watch) or when it checks its inbox (valun 0.7.1 cli.py consents_on_reads). With console, the
  // seller's owner approves taking the job too (lib/pilot/core.mjs: an acceptance above approve_above waits).
  assert.ok(friends.includes("Each of you keeps valun mcp (your MCP app) or the Hermes plugin running until the loop clears: an agent that isn't running can't answer, deliver or sign, and the loop waits up to 30 minutes for every signature. A shell agent keeps uvx --from valun==0.7.3 valun clearing watch running, or checks its inbox, until the loop clears. With console approvals, each hire waits for the buyer's owner twice (the offer, then the note) and for the seller's owner once (taking the job), so the loop closes only after every owner has approved."));
  assert.match(src('lib/pilot/core.mjs'), /d\.acceptance = \{[^}]*state: 'awaiting_owner'\};\n[^\n]*\n\s*if \(chk\.needsOwner\) d\.acceptance\.approval_id = this\.approval\(p, d, 'accept', cur\)\.id;/, 'an acceptance waits for its owner');
  assert.equal(30 * 60e3, windows.SETOFF_TTL_MS, 'the 30 minutes are the set-off window');
  // The hire step is the practice agent's job, which works on a server with no house agents too (a staging copy).
  assert.doesNotMatch(agent, /On a server without house agents/);
  assert.equal(sandbox.SERVICES['text-stats'].price, 3_000_000, "sandbox-exact's text-stats price");
  assert.match(text('tour'), /the tour ends with The tour is complete: you earned 6000000 nanoERG and spent 6000000 nanoERG …: you hold nothing and owe nothing/);
  assert.match(text('ergo'), /MATCH: the N notes https:\/\/valun\.tech publishes are exactly what its tracker box on Ergo testnet commits\. and exit code 0\. While new notes wait for the next tracker box, it says UNKNOWN \(not_anchored\) and exits 2: not a mismatch/);
  // What a MATCH doesn't prove: the six things valun 0.7.1's audit prints (audit.py DOES_NOT_PROVE).
  assert.match(text('ergo'), /A MATCH proves that the box commits the published notes\. It doesn't prove what is outstanding, that an issuer can pay, that any deal was real or any work good, that the participants are independent of each other, that a key belongs to a handle, or that a mandate was kept\./);
  assert.match(text('look'), /You should see info names the network valun-testnet-1 and the unit nanoERG; chain shows anchoring\.state and the day's count of tracker boxes\./);
  assert.match(part('ergo'), /<li id="audit">\s*<h4>Run the audit<\/h4>/, '/start#audit lands on the audit step');
  assert.match(text('build'), /valun-testnet-1 nanoERG: info\(\) reads GET \/pilot\/v1\/info, with no key or token\./);
  // The live anchoring line: a static pointer without the script (it says live only when it read something).
  const live = part('anchoring-now');
  assert.match(words(live), /Anchoring right now Read it in \/pilot\/v1\/chain: anchoring\.state is anchored when the latest tracker box commits every note so far, and anchoring\.daily_cap counts the day's tracker boxes, at most 50\./);
  assert.doesNotMatch(live, /tag live/, 'the static text does not claim to be live');
  assert.match(live, /<button type="button" class="btn reread" hidden>Read it again<\/button>/);
});

// Fitz's decisions of 2026-11-18: console is the first tester's default, and the owner reads, once, what they approve
// (the approval semantics of 2026-11-17, from the server's code and three staging probes; a held IOU's approval ends a
// minute before the tracker's hour since the approval probe's D3).
test('"What you approve": console first, what waits and what never does, what is already signed and held, what approving and rejecting do, the deadlines, and how the other modes differ', () => {
  const s = text('approve'), heads = [...part('approve').matchAll(/<h3 id="([^"]+)">([^<]+)<\/h3>/g)].map(m => [m[1], m[2]]);
  assert.match(part('approve'), /^<section class="section shared" id="approve" aria-labelledby="approve-h">\s*<h2 id="approve-h">What you approve<\/h2>/);
  assert.deepEqual(heads, [['approve-waits', 'What waits for you'], ['approve-held', 'While it waits'], ['approve-yes', 'If you approve'], ['approve-no', 'If you reject'],
    ['approve-deadlines', 'Deadlines'], ['approve-never', 'Never held, even with console'], ['approve-modes', 'The other modes']]);
  assert.ok(html.indexOf('id="approve"') < html.indexOf('id="backing"'), 'right after the paths');
  assert.match(/<ul class="more" aria-label="Also on this page">([\s\S]*?)<\/ul>/.exec(html)[1], /^\s*<li><a href="#approve">What you approve<\/a><\/li>/, 'first in the rail\'s "Also on this page"');
  for (const x of [
    "Join with console approvals: add --approvals console to valun join (without it, valun 0.7.3's join --sandbox asks whether a person will). It is the first tester's default, and the setup that has run end to end.",
    'every offer and counter-offer your agent makes;', "every acceptance: your agent accepting another agent's offer, or taking a job;", "every guarantee offer your agent makes, to guarantee another agent's notes;",
    'the note your agent signs when it accepts a delivery, or the payment by transfer it signs instead (Review deliveries).', 'A hire waits twice (the offer, then the note); taking a job waits once.',
    // The review of console/first-use: a rejected payment by transfer is purged (endTransfer purgeTransfer), not kept.
    "Your agent has already signed it, and Valun's server holds it. Rejecting doesn't unsign it: Valun keeps what was signed on record, except a payment by transfer, whose three transfer signatures it deletes, keeping only their hashes.",
    "A held note is complete: the tracker would record it if it were submitted. Only Valun's server can submit to the testnet tracker, and it sends a held note only when you approve. That is the operator's word, not the chain's.",
    // What approving signs (a payment by transfer: the other parties, Valun for the agents it runs), what a failed check
    // does by kind, and when an IOU is committed on chain (the tracker's daily cap).
    "Approving signs nothing with your agent's key. The server checks everything again first. For a note or a payment by transfer, if the note between the agents or a key has changed since your agent signed, the approval becomes void and your agent signs again; an offer, acceptance or guarantee offer that fails a check stays pending.",
    'committed on Ergo testnet by a later tracker box. The tracker checks every 5 minutes and posts at most 50 tracker boxes a UTC day; once they are used, the note is committed only after 00:00 UTC.',
    "their clients sign by themselves, and Valun signs for the agents it runs",
    // Once sent; an approval whose checks fail is void instead (decideApproval void_stale). A note the tracker refuses
    // leaves no payment_due_since (core.mjs submitNote), so a later payment held for the owner and never sent (rejected,
    // expired, or void: stale on approval, a key revoked) releases the deal, unless it was payment due by then
    // (releaseAcceptance: the review of PR #8, F8; of PR #9, item 10).
    'Once the server sends a note or a payment you approved (one whose checks fail becomes void instead, and the deal goes back to your agent), the delivery stays accepted. If the transfer then fails, your agent must pay again, and the delivery can no longer be disputed. If the tracker refuses the note, your agent must pay again too, and can\'t dispute the delivery unless a later note or payment of the deal waits for you and isn\'t sent (you reject it, it expires, or it becomes void: its checks fail when you approve it, or a party\'s agent key is revoked): that sends the deal back to your agent, which may then dispute it, unless the deal was payment due before that (it then stays payment due).',
    'a deal that was already payment due stays payment due: the delivery stays accepted, and your agent must still pay it.',
    // Valun's own wait, exactly (the review of PR #8, F4 and F7; of PR #9, item 8: on the rejected IOU's own key pair, from
    // the first change signed after it); 0.7.1's is the next item's.
    "Valun keeps the rejected note with its signature, and the tracker could record it until an hour after your agent signed it, so paying that deal by transfer waits until a minute after that, unless the first change signed after the rejected note to the note between the two keys it names moves that note from the total the rejected one acknowledged, as a later note of your agent's to the same agent with the same keys does when nothing else changed that note first: Valun then doesn't wait for it.",
    // A rejected payment by transfer: Valun's rule (the same-prior exemption, fallback_after, the journal's proof), and
    // the per-deal cap (core.mjs spendingPayerCheck: the review of PR #9, final round).
    'A rejected payment by transfer is deleted, its signatures included (Valun keeps only their hashes). Valun lets your agent pay through the same note again at once, while it is unchanged, and any other way an hour and a minute after your agent signed the payment, or sooner once either note the payment would have changed has changed since. Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became of them: after the third, it refuses another, through the same note too, until 24 hours after the first of the three (the card says until when), so until then your agent can pay that deal only with its own note.',
    "Your agent isn't told until it next reads the deal. Tell it: it carries on when it next checks.",
    // What stays blocked after a rejection: the server keeps every set-off off the IOU the rejected one would have
    // changed until the deal is paid or disputed (core.mjs paymentAttemptHolds; staging's first-use round, 2026-11-18).
    "Until your agent pays that deal, or disputes the delivery while it still can, no loop clears through the note the rejected one would have changed: what your agent owes the payee after a rejected note, or what the issuer owes your agent after a rejected payment by transfer. Valun keeps set-offs off it.",
    // valun 0.7.2 reads the owner's decision from the deal view and counts the attempt as not applied
    // (client.learn_owner_decisions); valun_deal's owner_decisions gives what may be paid now and from when, at the
    // client's own times (agent.free_after: + 1 h + 2 min); the owner's resolve stays for a record it could not mark,
    // the attempt in double quotes (cli.py cmd_attempts). An agent on 0.7.1 is never told (the approval probe's D2): the
    // console's card says what it does (scripts/client-071-attempts.py checks those words on 0.7.1's own rules).
    "valun 0.7.3 then counts a rejected, expired or void note or payment by transfer as not applied, and valun_deal's owner_decisions tells your agent what it may pay now, and from when the rest, at the client's own times, a minute after the console's: after a rejected note, a new note at once, and a payment by transfer once an hour and 2 minutes have passed since it signed the rejected note; after a rejected payment by transfer, a payment through the same note at once (while it is unchanged, and Valun takes another), and its own note or another note once those 62 minutes have passed.",
    'If it answers attempt_outcome_unknown (it could not count the attempt as not applied, and the note it would have changed has moved on since), run uvx --from valun==0.7.3 valun attempts resolve DEAL "#n" --not-applied in a terminal (#n from valun attempts list, in double quotes): Valun never sent that note or applied that payment. For a payment by transfer, answer yes to both of its questions, the second to record your decision in your client\'s records only.',
    "An agent on valun 0.7.1, or on the Hermes plugin 0.7.1, isn't told, and keeps counting what it signed as a payment that may still apply: the card in the owner console says what it does then (in Hermes, hermes -p valun valun attempts takes the same words as valun attempts).",
    "A held payment by transfer ends 20 minutes after your agent signed it, as after a rejection: valun 0.7.3 counts it as not applied once it reads the deal; 0.7.1 isn't told, and may need valun attempts resolve.",
    'can reach the tracker only within an hour of your agent signing it, so its approval ends a minute before that. Valun never sends it then, and the deal goes back to your agent, as after a rejection (one that was already payment due stays payment due): tell it to accept the work again. As after a rejection, valun 0.7.3 counts it as not applied once it reads the deal; 0.7.1 isn\'t told, and may need valun attempts resolve.',
    // What the console does at a card's deadline (pilot.js watchDeadline; the next read lists it as void).
    "Each card in the console shows its deadline. When it passes, the card says that the approval expired and turns Approve and Reject off; the console's next read lists it under decided and void approvals (void expired), and a late decision is refused.",
    "honoring a guarantee call: your agent's own note to the creditor;", 'accepting, calling and releasing guarantees; deliveries, declines, withdrawals and disputes;',
    "clearing a limit recorded from your conversation, one you recorded included: it goes back to your mandate. Your agent can make a limit stricter, never looser than your mandate, and can't raise its caps.",
    'ask (what an invited join uses without --approvals): your app shows you an approval form before your agent signs an offer, acceptance, note, payment by transfer, guarantee offer, honor or release, or loosens a limit. Decline, and nothing is signed or sent.',
    "client-prompt: your app's own confirmation of each Valun signing tool call. Whatever it lets run is signed at once; an app that doesn't confirm tool calls asks nobody.",
    'Leaving console keeps Review deliveries on until you untick it in the owner console, so notes and payments by transfer still wait there.'])
    assert.ok(s.includes(x), x);
  // Never "every commitment waits", never "about an hour" for a held IOU without saying it is bound, never "signs
  // nothing new" (a payment by transfer is then signed by the others), never "every 5 minutes" alone.
  assert.doesNotMatch(s, /every commitment|each commitment|about an hour after it was signed|signs nothing new|about every 5 minutes/);
  // The "You approve" of Connect your agent leads with console and points here. Only the MCP join adds console: the
  // Hermes join's default is conversation (hermes-plugin-valun join --approvals), as its own text below says.
  assert.match(words(part('agent')), /You approve With console approvals, the first tester's default \(the MCP join below adds --approvals console; the Hermes join defaults to conversation, where Hermes asks you, so add --approvals console to it for the console\), your agent signs, and Valun's server holds its offers, acceptances and guarantee offers, and the note at each delivery it accepts, until you approve or reject them in the owner console\. What each does, and what never waits: What you approve\./);
  assert.ok(/<code id="cmd-mcp">[^<]*--approvals console/.test(html), 'the MCP join adds it');
  assert.ok(!/<code id="cmd-hermes">[^<]*--approvals/.test(html), 'the Hermes join does not');
  assert.match(words(part('agent')), /Hermes's approval modes are conversation \(the default: Hermes asks you\), console and none/);
});

test('approvals as the 0.7.1 client does them (never "always asked"), what stays local, and what becomes public', () => {
  const all = words(body(html));
  assert.doesNotMatch(all, /\balways asked\b|asks you before every commitment|you are always/i);
  const cred = text('credentials');
  assert.match(cred, /join makes it on your machine/);
  assert.match(cred, /It is stored as plain hex: anyone, or any agent, that can read the file can sign as your agent/);
  assert.match(cred, /Only its public key and a proof that you hold it reach the server\. The server never sees it, so the operator cannot sign for your agent/);
  // valun 0.7.1 never replaces a token file: one that exists already or can't be written gets the token shown instead
  // (cli.py _hand_over), so every command here names the file for its handle (the lead's decision D12b).
  assert.ok(cred.includes("join writes it once, to the file you name with --owner-token-file, which must be new: the commands on this page name it for your handle, valun-owner-token-YOUR-HANDLE.txt. Without that flag, valun 0.7.3 writes it to $HOME/valun-owner-token-HANDLE.txt; a file that exists already, or a folder that can't take one, is refused before anything is sent (\"Nothing was sent\"). It never prints the token on stdout, and shows it, on stderr, only at a terminal when no file can be written at all."));
  assert.match(cred, /an agent that can read your files can read the token file too/);
  for (const mode of ['ask: the MCP server sends your app an approval form (MCP elicitation) before each commitment. Whether a person sees it depends on the app; no interactive app has been verified yet. An app without elicitation gets approval_unavailable, and nothing is signed. valun call and the tour ask whoever is at the terminal; with no terminal they refuse.',
    'client-prompt: the server signs whatever the app lets run. Only some apps confirm each tool call: Claude Code is designed to ask before each such call unless you have allowed the tool, which is not yet verified. In an app that doesn\'t, nobody is asked.',
    // What console holds, and what never waits (the approval semantics of 2026-11-17).
    'console, the first tester\'s default: your agent signs everything, and the server holds its offers, counter-offers, acceptances and guarantee offers, and the note or payment by transfer at each delivery, until you approve them in the owner console. If you reject them, it keeps them on record, unsent, except a payment by transfer, which it deletes (keeping only its signatures\' hashes). Honors of guarantee calls, guarantee calls and releases, and the consents are never held (What you approve). That hold is the operator\'s word, not the chain\'s: a held or rejected bound note, which valun signs on the testnet, could still be recorded for an hour after your agent signed it, if the server submitted it.',
    'none: everything within the limits is signed without asking.',
    'The Hermes plugin has conversation (Hermes asks you), console and none.']) assert.ok(cred.includes(mode), mode);
  // The consents signed in every mode, each with what it does to the agent's position (valun 0.7.1 agent.py
  // client_signs), and the testnet's default acceptance (the lead's decision D3b: each client signs only for its own
  // key, the issuer's client its consent): never "safe".
  assert.match(cred, /Signed without asking, in every mode Deliveries, declines, withdrawals and disputes; accepting and calling guarantees; and, within your client's caps, three consents: set-offs \(your net position doesn't change\), transfers of notes your agent issued \(what it owes in all doesn't change; see the reserve caution under Inspect the network\) and payments to your agent by transfer \(by default, of any issuer's note\)\./);
  const d3 = "On the testnet a new self-serve agent accepts any issuer's notes as payment by transfer, up to 0.04 tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way. Its owner can narrow whose notes it accepts under 'Accept notes from' in the owner console.";
  assert.doesNotMatch(all, /signs that consent, and the issuer's/, "no client signs another's consent");
  for (const id of ['agent', 'credentials']) assert.ok(text(id).includes(d3), `${id}: the default acceptance`);
  assert.equal(core.SANDBOX_CAPS.max_accept_per_issuer, 40_000_000, '0.04 tERG per issuer');
  assert.match(src('lib/pilot/core.mjs'), /const SANDBOX_CIRCULATION = from => \(\{[^}]*accept_transfers: true, accept_notes_from: from === 'any' \? 'any'/);
  assert.match(pub('pilot.js'), /accept_notes_from: 'Accept notes from'/, 'the owner console\'s label');
  assert.match(cred, /In console and none the client also signs these without asking, and nothing holds them for you: honoring a guarantee call \(your agent's own note, recorded at once\), releasing a guarantee, and clearing a limit recorded from your conversation \(it goes back to your mandate; your agent can't raise your mandate's caps\)\. In ask it asks before an honor, a release and a limit it loosens\./);
  assert.match(cred, /valun sandbox earn also signs its acceptance of the welcome job without asking \(with console approvals the acceptance then waits for you\), and sandbox tour --yes approves only the tour's own steps with the practice agents\. In client-prompt, an app that confirms each tool call also asks before declines, withdrawals, disputes, and accepting or calling a guarantee, since they use the tools it confirms; not before deliveries or the consents\./);
  assert.match(part('credentials'), /see <a href="#reserve-caution">the reserve caution<\/a> under\s+Inspect the network/);
  assert.doesNotMatch(all, /position safe|leave your (?:net )?position unchanged/, 'no consent is called safe');
  assert.match(cred, /The server enforces your agent's limits in every mode/);
  assert.match(text('agent'), /Some acts, such as deliveries, disputes, set-offs and payments to your agent by transfer, are signed without asking in every mode \(the full list\)/);
  // Console first (Fitz's decision of 2026-11-18); ask after it, as valun's own default, never said to be verified.
  assert.match(text('agent'), /Without --approvals, valun 0\.7\.3's join --sandbox asks whether a person will approve \(console or none\), and with no terminal sends nothing\. With ask, valun mcp sends your app an approval form before your agent signs; no interactive app has been verified with it yet, and in an app that can't show it, nothing is signed\./);
  // The owner token: console protects only while the agent can't read it (D12, D12b); the commands that need it.
  assert.ok(cred.includes("Console approvals protect you only while your agent can't read your owner token. Don't type the token into a command: it stays in your shell history. Keep the file join wrote, move it into your password manager, and paste the token only into the console's sign-in."));
  assert.ok(cred.includes("valun config approvals, to or from console, card publish, card unpublish and attempts resolve read it from --owner-token-file, or ask for it, hidden, at a terminal when you leave that out. A file you make for it is read as UTF-8: make it in a text editor (Notepad on Windows), not with echo or Windows PowerShell's >, which writes UTF-16 that valun can't read there. valun console prints the owner console's address and where the token file is (never the token), and opens it in your browser."));
  assert.doesNotMatch(all, /paste it into a new file/, 'never a token typed into a file from the command line');
  assert.match(text('agent'), /Commands that need it read it from a file, or ask you for it at your terminal \(not shown\), and never store it\./);
  // What the operator can do (the lead's decision D5): never told as recovery.
  const ops = text('operator-powers');
  assert.match(ops, /It can change any part of an agent's mandate, including what waits for the owner \(approve_above\) and whose notes it accepts, beyond the self-serve limits\. The owner console shows the last change as by: operator\. Routine renewals of the expiry are shown the same way, and no history is kept\./);
  // A key swap (the lead's decision D5b): the public record keeps only the current key; the owner view lists past ones
  // (lib/pilot/http.mjs GET /owner past_keys).
  assert.ok(ops.includes("It can also issue a new owner token for any agent (recorded as by: operator; the old token stops working), and an owner token can revoke the agent's key and enroll another. So the operator could put a key of its own on your handle and record. It can't use your key: notes your key signed and your reserve stay bound to it. The public record shows only an agent's current key, so a swap shows only to someone who noted the old one; your owner view lists past keys."));
  assert.match(src('lib/pilot/http.mjs'), /past_keys: me\.past_pubkeys \|\| \[\]/);
  assert.doesNotMatch(all, /a new key shows as a different public key/);
  assert.doesNotMatch(all, /give an owner a new owner token/i);
  assert.match(text('agent'), /only the operator can go beyond that \(what the operator can do\)/);
  assert.match(part('agent'), /<a href="#operator-powers">what the operator can do<\/a>/);
  const pub_ = text('public');
  for (const s of ['your handle, your operator name', 'its public key, and so its Ergo testnet address', 'whose notes it accepts (its credit policy)', 'every note on the ledger',
    'what is in a deal: its terms, the offer\'s text and the delivery are seen by the two parties and by the operator',
    'The house agents send each job\'s text to Anthropic\'s Claude API, under the operator\'s key',
    'its guarantee record: the guarantees it gave or was given, and how it honored calls (counts, not whom)',
    'your agent\'s limits, except what its credit policy shows (whose notes it accepts, and how much an issuer may owe, net, for it to accept them), unless you publish its budget card'])
    assert.ok(pub_.includes(s), s);
  assert.match(text('tour'), /Becomes public Your handle and operator name, which can't change after you join; your agent's public key, what it holds and owes, whose notes it accepts \(its credit policy\), its counts of deals and disputes \(the tour's dispute of a wrong delivery shows there\), and its two loops\./);
  assert.match(text('agent'), /The agent on the other side of a deal sees the whole deal, and the operator sees every deal\. The house agents send each job's text to Anthropic's Claude API, under the operator's key\./);
  // The full troubleshooting list, in the reference.
  assert.deepEqual([...part('help').matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]), ['Setup fails', 'Joining failed (handle_taken)', 'The owner token was shown on screen',
    'A connection error, or join stopped halfway', 'The network is at capacity', 'A practice agent is slow or does not answer', 'Your app or shell cannot ask you', 'The tour waits',
    'The daily anchoring cap is used up', 'The audit says UNKNOWN', 'A redemption is answered reserve_busy']);
  const help = text('help');
  // A token shown on screen to an agent is in its output: the owner can replace it (the console's New owner token).
  assert.ok(help.includes('If your agent ran the join, the token is in its output too: sign in to the owner console and choose New owner token, and the printed one stops working.'));
  // When it is shown, by client and plugin version (fix inbox #174): plugin 0.7.3 refuses the file before anything is
  // sent and never prints the token on stdout, as valun 0.7.2 does; plugin 0.7.2 and older show it.
  assert.ok(help.includes('and shows the token, on stderr, only at a terminal when no file could be written at all; the Hermes plugin\'s join before 0.7.3 shows it when its file exists already or can\'t be written.'));
  assert.match(pub('pilot.js'), /'New owner token…'/, "the owner console's button");
  assert.match(help, /429 sandbox_full names the time the next place frees/);
  assert.match(help, /approval_unavailable: nothing was signed/);
  assert.match(help, /run it again later: what was done stays done, and it continues from the step it reached/);
  // Where to report: the tester report, doctor's output, never a token, a key or a profile file.
  const report = part('report');
  assert.ok(report.includes('href="https://github.com/fitzss/valun-open/issues/new?template=tester-report.yml"'));
  assert.match(words(report), /the output of uvx --from valun==\S+ valun doctor/);
  assert.match(words(report), /Never include your owner token, or your agent's token or key; your profile file, or anything from the valun\/profiles folder\./);
  assert.match(words(report), /everything in a report is public/);
  // doctor's first line names the profile folder, which can carry the user name into a public issue.
  assert.match(words(report), /doctor prints no token or key\. Its first line shows your profile folder, which can include your user name: edit it out if you like\./);
  assert.match(text('tour'), /Its first line names your profile folder, which can include your user name: edit that out if you like\./);
  assert.match(words(report), /house-scribe and house-reviewer pay with their own note for 0\.002 tERG \(2,000,000 nanoERG\), redeemable against their reserves, for an onboarding report/);
  // The tester report has no approval-mode field: doctor prints it; claude mcp add is "Another MCP app".
  assert.match(text('agent'), /choose how you connected \(for claude mcp add, "Another MCP app"\), and give the app and its version, the approval mode \(valun doctor prints it\) and your prompt/);
  // The report is public: the hire prompt's pasted text stays out, and doctor's first line can carry the user name.
  assert.ok(text('agent').includes("and your prompt, without the text you pasted after it: the report is public. doctor's first line names your profile folder, which can include your user name: edit that out if you like."));
});

test('every command is pinned, gives what join would ask for, and keeps the owner token off the screen; each block has its Copy', () => {
  const ids = Object.keys(blocks);
  assert.deepEqual(ids, ['cmd-skill', 'cmd-mcp', 'cmd-hermes', 'cmd-hire', 'cmd-agent-tour', 'cmd-friends', 'cmd-console', 'cmd-tour', 'cmd-deal', 'cmd-audit',
    'cmd-redeem', 'cmd-reserve', 'cmd-chain', 'cmd-js', 'cmd-guarantee', 'cmd-card', 'cmd-check', 'cmd-ps-json', 'cmd-cmd-json', 'cmd-pilot']);
  assert.deepEqual([...html.matchAll(/<button type="button" class="copy" data-copy="([^"]+)">Copy<\/button>/g)].map(m => m[1]), ids, 'one Copy per block');
  const lines = Object.values(blocks).flatMap(b => b.split('\n'));
  for (const l of lines.filter(l => /\bvalun\b/.test(l) && !/^(?:Read|hermes |claude |codex |npm install @fitzdoud\/valun@|node --input-type=module )/.test(l)))
    assert.match(l, /^uvx (?:--python 3\.13 )?--from (?:valun|"valun\[ergo\])==\d+\.\d+\.\d+"? valun /, l);
  for (const l of lines.filter(l => /\bjoin --sandbox\b/.test(l))) {
    for (const flag of ['--handle ', '--operator "', '--owner-token-file "$HOME/']) assert.ok(l.includes(flag), `${flag} in ${l}`);
  }
  assert.equal(lines.filter(l => /\bjoin --sandbox\b/.test(l)).length, 5, 'the MCP app, Hermes, the tour, the backer and the new profile');
  // valun 0.7.1 never replaces a token file: one that exists (an earlier join's, the tour's) gets the token printed
  // instead, into an agent's output when an agent runs it. So each join names a file of its own handle's (the lead's
  // decision D12b), and every command that reads the token names the same file.
  for (const l of lines.filter(l => /\bjoin --sandbox\b/.test(l))) {
    const handle = /--handle (\S+)/.exec(l)[1];
    assert.ok(l.includes(`--owner-token-file "$HOME/valun-owner-token-${handle}.txt"`), `the token file of ${handle}: ${l}`);
  }
  for (const l of lines.filter(l => /--owner-token-file/.test(l) && !/\bjoin\b/.test(l))) assert.match(l, /--owner-token-file "\$HOME\/valun-owner-token-YOUR-HANDLE\.txt"$/, l);
  assert.doesNotMatch(html, /valun-owner-token\.txt|valun-backer-owner-token|valun-testnet-owner-token/, 'no shared token file name');
  // Since fix inbox #84 one person can see backing: a second profile offers sandbox-exact a guarantee of the first's
  // IOUs.
  assert.match(blocks['cmd-guarantee'], /--profile backer call valun_offer_guarantee '\{"issuer": "YOUR-HANDLE", "creditor": "sandbox-exact", "cap": 2000000,/);
  assert.match(text('backing'), /sandbox-exact is run by the operator, so this shows a guarantee offered and accepted, not that anyone independent guarantees you\. sandbox-exact never calls one, so the call, the honor and the hold can't be seen this way\./);
  assert.match(src('lib/pilot/sandbox.mjs'), /It never calls, releases or offers one/, 'sandbox-exact never calls a guarantee');
  // Checking one deal after the tour: the command, and for Windows the --json-file form (fix inbox #165), whose lines
  // are skill.md's, word for word (valun-open's python/tests/test_call_json.py runs them through Windows PowerShell 5.1
  // and cmd).
  assert.equal(blocks['cmd-deal'].replace(/==\S+ /, '==X '), 'uvx --from valun==X valun call valun_deal \'{"deal_id": "DEAL-ID"}\'');
  assert.ok(text('tour').includes('The JSON is quoted for Git Bash, macOS and Linux. In Windows PowerShell or cmd, put the JSON in a file and give it with --json-file (how).'));
  assert.match(part('tour'), /--json-file<\/span><\/code> \(<a href="#windows-json">how<\/a>\)/);
  const skillMd = pub('skill-testnet.md').replace(/\r\n/g, '\n');
  for (const id of ['cmd-ps-json', 'cmd-cmd-json']) {
    const lines = blocks[id].replaceAll('&gt;', '>');
    assert.ok(skillMd.includes('```\n' + lines + '\n```'), `${id}: skill.md's lines`);
    assert.match(lines, /\nuvx --from valun==\S+ valun call valun_deal --json-file args\.json$/, id);
  }
  assert.doesNotMatch(words(body(html)), /--% "\{/, 'no --% form: a launcher strips its quotes');
  // The card: publishing asks for the token, hidden, without the flag; a full verdict needs a published card.
  assert.match(text('backing'), /Or leave out --owner-token-file: it asks for the token, hidden\./);
  assert.match(text('backing'), /unknown when the payer's owner hasn't published a card, as most haven't yet\./);
  assert.match(text('backing'), /card check needs a joined profile\. To see a full verdict, publish your first agent's card \(above\), then check it from your second profile: uvx --from valun==\S+ valun --profile backer card check YOUR-HANDLE 3000000\./);
  assert.match(text('backing'), /The join names --approvals ask, so the second line shows the guarantee and asks Approve this commitment\? \[y\/N\]: type y\. With nobody at the terminal it signs nothing\./);
  assert.match(blocks['cmd-guarantee'].split('\n')[0], / --approvals ask$/, 'the backer asks at the terminal, as the page says');
  assert.match(blocks['cmd-console'], /config approvals console --owner-token-file "\$HOME\/valun-owner-token-YOUR-HANDLE\.txt"$/);
  // One MCP join everywhere (the lead's live check of 1b1f18f): the two lines for an MCP app are skill.md's, with the
  // placeholders a person fills in (test/a2a.test.mjs holds the A2A answer to skill.md's too). The join holds each
  // commitment for the owner console, the setup of the one run that went end to end (fix inbox #138: console is the
  // first tester's default until an interactive app's approval forms are verified); claude mcp add names no mode.
  const skill = pub('skill-testnet.md');
  const mcpPart = skill.slice(skill.indexOf('### Claude Code, Codex, Cursor, Claude Desktop, or any MCP app'), skill.indexOf('### Any agent with a shell'));
  const forPerson = s => s.replace('--operator "YOUR HUMAN"', '--operator "YOUR NAME"').replace('--about "what you offer, in one line"', '--about "what it offers, in one line"');
  assert.equal(blocks['cmd-mcp'], forPerson(/```\n([\s\S]*?)\n```/.exec(mcpPart)[1]));
  const [mcpJoin, mcpAdd] = blocks['cmd-mcp'].split('\n');
  assert.match(mcpJoin, / --owner-token-file "\$HOME\/valun-owner-token-YOUR-HANDLE\.txt" --approvals console$/);
  assert.doesNotMatch(mcpAdd, /--approvals/);
  assert.equal(blocks['cmd-skill'], 'Read https://valun.tech/skill.md and follow it to join Valun.');
  assert.deepEqual(blocks['cmd-redeem'].split('\n').map(l => l.replace(/^uvx --from valun==\S+ valun /, '')),
    ['sandbox earn', 'ergo chain', 'ergo redeem sandbox-exact 3000000', 'ergo redeem sandbox-exact 3000000 --broadcast']);
  // With console approvals, sandbox earn waits 10 minutes for the held acceptance (valun 0.7.1 sandbox.py earn: wait_s
  // 600, then it exits unpaid), and run again it starts a new job (sell): what to do instead (the review of
  // console/first-use). skill.md says the same.
  assert.ok(text('ergo').includes("Approve it within 10 minutes, while the command waits: it then delivers. If it stopped first (it prints the deal, unpaid), deliver the agreed job with uvx --from valun==0.7.3 valun call valun_deliver '{\"deal_id\": \"DEAL\", \"exact_result\": true}', DEAL being the deal_id it printed, rather than running sandbox earn again, which starts a new job."));
  assert.match(pub('skill-testnet.md').replace(/\s+/g, ' '), /the command waits 10 minutes for their approval before it delivers: if it stops first, unpaid, deliver the agreed job with `valun_deliver` and `"exact_result": true` rather than running `sandbox earn` again, which starts a new job/);
  assert.match(blocks['cmd-audit'], / audit --explorer https:\/\/api-testnet\.ergoplatform\.com$/);
  // The budget card: the owner publishes it with the owner token's file, as skill.md says; anyone checks a payer.
  assert.equal(blocks['cmd-card'].replace(/==\S+ /, '==X '), 'uvx --from valun==X valun card publish --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"');
  assert.ok(pub('skill-testnet.md').includes(blocks['cmd-card']), 'the same command as skill.md section 6');
  assert.match(blocks['cmd-check'], /^uvx --from valun==\S+ valun card check PAYER-HANDLE 3000000$/);
  assert.match(pub('skill-testnet.md'), /`valun card check <handle> 3000000`/);
  // A read from code: the JavaScript client at the same release, naming the server (it has no default).
  assert.match(blocks['cmd-js'], /^npm install @fitzdoud\/valun@\d+\.\d+\.\d+\nnode --input-type=module -e "import \{Client\} from '@fitzdoud\/valun'; const info = await new Client\(\{server: 'https:\/\/valun\.tech'\}\)\.info\(\); console\.log\(info\.network, info\.unit\)"$/);
});

test('its numbers are the server\'s: limits and days, capacity, the welcome job, redemption and reserve bounds, anchoring and guarantees', () => {
  const limits = text('limits');
  const caps = core.SANDBOX_CAPS;
  assert.equal(caps.max_issue_per_deal, 5_000_000);
  assert.ok(limits.includes(`Per deal at most ${thousands(caps.max_issue_per_deal)} nanoERG (0.005 tERG)`));
  assert.ok(limits.includes(`Owed in total at most ${thousands(caps.max_issue_outstanding)} nanoERG (0.04 tERG)`));
  assert.ok(limits.includes(`How long ${core.SANDBOX_DAYS} days, renewed while your agent is active`));
  assert.ok(limits.includes(`at most ${core.OPEN_NETWORK_MAX_OPEN_OFFERS} of your own at once`));
  const perDay = Number(/const SANDBOX_JOINS_PER_DAY = (\d+);/.exec(src('lib/pilot/core.mjs'))[1]);
  assert.ok(limits.includes(`${perDay} in any 24 hours, ${core.SANDBOX_JOINS_PER_HOUR_TOTAL} an hour from all addresses, and ${core.SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} an hour from one address`));
  assert.ok(limits.includes(`at least ${thousands(routes.REDEMPTION_MIN_NANOERG)} nanoERG each, and at most ${routes.REDEMPTION_BUILDS_PER_DAY} built a day by one agent`));
  const [lo, hi] = /erg < ([\d_]+) \|\| erg > ([\d_]+)/.exec(src('lib/pilot/http.mjs')).slice(1).map(x => Number(x.replaceAll('_', '')));
  assert.ok(limits.includes(`${thousands(lo)} to ${thousands(hi)} nanoERG (0.01 to 2 tERG)`));
  assert.ok(limits.includes(`Tracker boxes at most ${anchors.DAILY_TRACKER_SIGNATURES} a UTC day`));
  assert.ok(limits.includes(`sandbox-exact accepts at most ${sandbox.GUARANTEES_PER_BACKER_PER_DAY} from one backer in 24 hours`));
  assert.doesNotMatch(limits, /credits?\b/, 'the limits in nanoERG and tERG only');
  const all = words(body(html));
  // In prose an amount leads in tERG (1 tERG = 10^9 nanoERG), with the nanoERG the commands use beside it.
  const terg = n => `${n / 1e9} tERG (${thousands(n)} nanoERG)`;
  assert.ok(all.includes(`it pays you with its note for ${terg(sandbox.WELCOME.price)}`));
  assert.ok(all.includes(`the sandbox takes ${perDay} new agents in any 24 hours`));
  assert.ok(all.includes(`the ${core.SANDBOX_JOINS_PER_HOUR_TOTAL} joins an hour from all addresses, or the ${core.SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} from yours`));
  assert.ok(all.includes(`In every mode the server holds your agent to ${terg(caps.max_issue_per_deal)} a deal and ${terg(caps.max_issue_outstanding)} owed in total`));
  assert.ok(all.includes(`a redemption is at least ${terg(routes.REDEMPTION_MIN_NANOERG)}`));
  assert.ok(all.includes(`lock ${lo / 1e9} to ${hi / 1e9} tERG (${thousands(lo)} to ${thousands(hi)} nanoERG) in a reserve`));
  // 1 credit = 1,000,000 nanoERG = 0.001 tERG: the network's scale (lib/pilot/units.mjs), said once, where 0.7.1 prints PC.
  assert.ok(text('build').includes(`1 credit = ${thousands(units.SCALE)} nanoERG = 0.001 tERG`));
});

test('what it claims stays within what works: redemption, netting, backing, the budget card, who runs what, and the evidence for each host', () => {
  const all = words(body(html));
  assert.ok(all.includes('A redemption pays only from a reserve locked under the key that signed the note, and only up to what it holds.'));
  assert.ok(all.includes('sandbox-exact has posted one, so a note from sandbox-exact can be redeemed.'));
  assert.ok(all.includes('A note whose issuer posted no reserve cannot be redeemed: look the issuer up in /pilot/v1/reserves first.'));
  assert.ok(all.includes('The operator signs every redemption authorization, so it can refuse one.'));
  assert.ok(all.includes('tERG are test coins with no monetary value'));
  assert.ok(all.includes('You need no tERG to redeem'));
  // Fix inbox #100: what a reserve relies on after a netting with an agent the operator runs, linked to the trust model.
  assert.match(html, /<div class="note caution" id="reserve-caution"><p>Before you post one: if a loop or a transfer ever lowered a note of yours to an\s+agent the operator runs \(sandbox-exact, sandbox-mallory, house-scribe or house-reviewer; the tour does this\),\s+your reserve then relies on the operator never committing that note's earlier, higher total again\s+\(<a href="\/trust#netting">Trust model<\/a>\)\.<\/p><\/div>/);
  // Fix inbox #100 (the lead's decisions D4 and D4b) with valun 0.7.2: --mine proves an edge a set-off its client signed
  // lowered (netted), against the client's own records, not the server's ledger. Plain valun audit answers MISMATCH when
  // the box and the published ledger differ, so only a ledger changed to match goes unseen there; the check is then
  // --mine where the records confirm the lowered total, or a row saved on a MATCH, compared on a later MATCH. Said in the
  // inspect path and the known issues alike.
  const d4 = "valun 0.7.3's --mine proves an edge that a set-off your client signed lowered: it says netted when the box commits the total your client signed in that set-off. It compares the box with your client's own records, not with the server's ledger: an edge whose box total is not the total your records confirm shows as differs, such as an earlier total committed again on an edge whose lowered total your records confirm. A set-off signed with valun 0.7.1 is not proven this way.";
  const d4b = "Run valun audit: a MISMATCH is the signal. After a loop lowers one of your edges and an audit says MATCH, save that edge's row from GET /pilot/v1/ledger. Later, on a MATCH, compare the edge's total with your saved row, and report any rise that no later note, transfer or set-off explains. The ledger and the loop card are the server's word; only a MATCH ties the ledger to the chain";
  for (const id of ['mine-netted', 'known-netted']) {
    assert.ok(text(id).includes(d4), id);
    assert.ok(text(id).includes(d4b), id);
  }
  assert.doesNotMatch(all, /detects this case|its total before the loop|report any difference/, 'no check that compares the server with itself');
  // valun 0.7.2 fixes the note sandbox earn took (it reads its edges back: Client.sync_edges) and --mine refreshes the
  // records first, so the page no longer calls a flagged edge "a client bug"; it keeps no known issue of either.
  assert.doesNotMatch(all, /a client bug, not a sign of tampering/);
  assert.doesNotMatch(part('known-issues'), /known-mine-approved|flags the note sandbox earn took/);
  assert.ok(text('ergo').includes("nothing on chain stops that key from doing so. The audit shows it as a MISMATCH unless the server's ledger is changed to match; then only valun audit --mine, on an edge whose lowered total your client's records confirm, or a row you saved, shows it (what to save and compare)."));
  // A redemption: the tracker builds it, the client checks it against the node /chain names and signs it; a dry run
  // is a build, with its effects (6 a day, the reserve held 2 minutes), and the build is where the known gap starts.
  assert.match(text('ergo'), /To redeem, the operator's tracker builds the redemption and pays its fee\. Your client checks it against an Ergo node \(the one \/pilot\/v1\/chain names; valun 0\.7\.3 can't use your own here\), signs it here, and it is submitted only with --broadcast\./);
  assert.match(text('ergo'), /The first redeem is a dry run: the tracker builds it on the server, your client checks and signs it here, and nothing is submitted\. The build counts toward your 6 a day and holds the issuer's reserve for 2 minutes\./);
  assert.equal(routes.RESERVE_BUILD_HOLD_MS, 2 * 60e3, 'the reserve is held 2 minutes for a build');
  assert.equal(routes.REDEMPTION_BUILDS_PER_DAY, 6);
  assert.match(text('ergo'), /Each build also gives your client the tracker's signature on the note's committed total; the known gap under What a guarantee is, and isn't starts there\./);
  assert.match(text('ergo'), /Another holder's redemption build also holds the issuer's reserve for up to 2 minutes: try again after that\./);
  // A reserve can't be taken back with valun 0.7.1; the contract's own way, and how long it takes.
  assert.match(text('ergo'), /valun 0\.7\.3 can't take a reserve back yet\. The contract lets you take it back without the tracker 60 days after starting a refund \(setting R7\), which needs a transaction you build yourself\. Lock only what you're happy to leave there\./);
  // The reserves figure says when it was read; a server without sandbox-exact's reserve (staging) is named.
  assert.match(text('ergo'), /at 01:15 UTC on Nov 17, 131 of the 133 agents that owed anything had no reserve/);
  assert.match(text('ergo'), /Look it up in \/pilot\/v1\/reserves first: on a server that doesn't list it there, such as a staging copy of this site, it can't be\./);
  // The day the anchoring cap ran out, as the chain shows it (the lead's decision D7: Nov 16's last box at 18:36 UTC).
  assert.match(text('ergo'), /On a busy day they run out \(on 2026-11-16, at about 18:40 UTC\)/);
  assert.doesNotMatch(all, /at about 20:00 UTC/);
  // The anchoring wait, one wording (the lead's decision D7b): never "a few minutes" or "about two minutes" for the full
  // wait, and no "30 or more", which goes past what was measured.
  assert.doesNotMatch(all, /a few minutes|about two minutes|30 or more|lost its main miner/);
  assert.ok(text('ergo').includes("usually 5 to 15 minutes in all; up to about 30 when Ergo testnet blocks are slow (as since Nov 16); and hours once the day's tracker boxes are used up"));
  for (const id of ['ergo', 'help']) assert.ok(text(id).includes('Run it again after the next box: usually 5 to 15 minutes; up to about 30 when Ergo testnet blocks are slow (as since Nov 16).'), id);
  // The tour passes on what it earns (an IOU is passed on, not spent).
  assert.ok(text('ergo').includes('You need no tERG, and the tour passes on what it earns, so earn one on its own.'));
  assert.doesNotMatch(all, /spends what it earns/);
  // People read the trust model at /trust; the agent-facing anchor (skill.md#trust-model) is for agents.
  assert.ok((html.match(/href="\/trust(?:#[a-z-]+)?"/g) || []).length >= 4, 'the trust model, linked');
  assert.doesNotMatch(html, /href="\/skill\.md#trust-model"/);
  // A netting is committed, never final: "final" only where the page says the 0.7.1 client calls it so (the known
  // issue of older clients; valun 0.7.2 says committed: its CHANGELOG, the lead's decision D15).
  for (const m of all.matchAll(/[^.]*\bfinal\b[^.]*\./g)) assert.match(m[0], /its prompts call a netting final \(read that as committed/, m[0]);
  // valun 0.7.3 says "note" (fix inbox #177): the tour's gloss of 0.7.2's "credit note" and "IOU" is gone.
  assert.ok(text('tour').includes("without it, valun 0.7.3's join --sandbox asks whether a person will approve, and with console each step waits for you in the owner console instead. Expect 8 or 9 prompts."));
  assert.doesNotMatch(text('tour'), /credit note|IOU/);
  // A set-off is cleared, never settled, repaid or discharged (D2); what a backer paid is never "held for" anyone (D14).
  assert.doesNotMatch(all, /\brepaid\b|\bdischarged\b|held for the backer|held for it\b|held from the creditor/i);
  for (const id of ['backing', 'known-issues']) assert.match(text(id), /once a backer pays, the same amount of the issuer's note is held, so the creditor isn't paid twice/, id);
  assert.match(text('ergo'), /The netting is committed once the next box commits it, and stays committed only as long as the tracker key never commits an earlier total again: nothing on chain stops that key from doing so\. /);
  assert.doesNotMatch(all, /debt is gone|\bsettled\b|\bguarantee[sd]? (?:that|your)|risk-free|real money|\bguaranteed\b|trustless|decentrali[sz]ed|revolutioni[sz]e|limitless|agent economy|seamless|final settlement|\busers\b|\bcommunity\b|\bpartners?\b|\bsupported\b|works with/i);
  for (const m of all.matchAll(/[^.]*\badoption\b[^.]*\./gi)) assert.match(m[0], /not adoption/, m[0]);
  // "Tested" only as the evidence section's name, a scripted-only claim, or a "not yet tested" (the lead's D16 caveat).
  for (const m of all.matchAll(/[^.]*\btested\b[^.]*/gi)) assert.match(m[0], /What has been tested|tested so far only with scripted clients|has been tested only with scripted clients|with Valun that is not yet tested/i, m[0]);
  assert.match(all, /The tracker is Valun's fork of basis-tracker \(tracker v\d+\.\d+\.\d+\); its source is not public yet/);
  // Who runs what: the four agents the operator runs, the tracker key, the QA bot that is not the Basis team.
  const ergo = text('ergo');
  assert.match(ergo, /The operator, who runs valun\.tech, holds the tracker key\. It signs every tracker box and every redemption authorization, so it can refuse a redemption\. It also holds the keys of the four agents it runs: sandbox-exact, sandbox-mallory, house-scribe and house-reviewer\./);
  assert.match(ergo, /The basis-\* agents are Basis, our QA bot, which is not the team that develops the Basis protocol/);
  assert.match(ergo, /So far almost all of these agents are our own test and practice agents: they show the mechanics working, not adoption\./);
  assert.match(text('compat'), /Our QA bot is Basis, a bot the team runs; it is not the team that develops the Basis protocol\./);
  // Backing: a promise, not collateral; the hold, not subrogation; the card, the server's word; the known gap.
  const backing = text('backing');
  for (const s of ['A guarantee is a promise, not locked collateral: it is worth what the backer can and will pay. A paid call is the backer\'s own note to the creditor.',
    'Since Nov 16, 2026, once a backer pays, the same amount of the issuer\'s note is held, so the creditor isn\'t paid twice: it can\'t spend, set off or redeem that part.',
    'The backer doesn\'t take over the claim; that would be subrogation, which isn\'t built.',
    'A backer\'s honor waits (pair_busy) while the creditor has a redemption build of the same note that could still be spent, a dry run included, until the next tracker box. On a day the cap is used up that can be hours, and the wait still counts against the backer as overdue.',
    'A budget card is the server\'s statement of the limits it enforces. The owner doesn\'t sign it, and nothing ties it to an anchor on Ergo testnet.',
    'a holder with a hand-built client and an earlier redemption build can redeem outside the server\'s checks. The documented 0.7.3 commands can\'t.',
    'Nothing is locked up: a call is paid with your agent\'s own note']) assert.ok(backing.includes(s), s);
  // The evidence for each way to connect, word for word (the site's copy rules), and the label each host carries.
  const rows = [...part('compat').matchAll(/<tr><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><\/tr>/g)].map(m => [words(m[1]).trim(), words(m[2]).trim()]);
  assert.deepEqual(rows, [
    // The release these pages pin, with only the evidence there is: the candidate's staging check (fix inbox #177, #164,
    // #175, #176: build 16652fc, Nov 20), and not our QA bot yet. 0.7.2: our QA bot's live run of Nov 19 (fix inbox
    // #172, Run 2: the quickstart with none; a console join with nobody watching kept both steps held, #164).
    ['valun CLI 0.7.3', "New, the release these pages pin: its candidate on staging (Nov 20): the quickstart with none, the join's question and its refusal with no terminal, and a console tour that waits for its held steps. Our QA bot has not run it yet"],
    ['valun CLI 0.7.2', 'Our QA bot, live (Nov 19): the quickstart with none; a console join nobody watched stayed held'],
    ['valun CLI 0.7.1', "Scripted: our QA bot daily (Nov 16-17, builds 103b25f and 09875a4), and a Claude session acting as a newcomer on a clean profile (Nov 16, build d11e6b4); and an AI agent of the team's (muse) used it end to end on Nov 16-17: the tour, real jobs (a code review it acted on) and a redemption, after the join and connection failures in Known issues"],
    ['valun mcp (MCP server)', 'Scripted MCP clients against the live testnet (Nov 16), and the Claude Code run below'],
    ['Claude Code, with claude mcp add', "One complete exchange in Claude Code 2.1.326 on Nov 17 (build 09875a4): the join in a terminal (CLI), claude mcp add, then a summary hired from house-scribe and paid with the agent's note. Run headless (claude -p) with console approvals; the owner's side was scripted (approvals through the owner console's API, and Claude Code's permission prompts answered by a script). Claude Code's own approval prompts are not yet verified"],
    // Our QA bot's run of Nov 19 (Hermes v0.23.3 at caafe53, plugin f318d3b, build 9616a37, --approvals none): the
    // approvals it ran with, and that the plugin's other two (conversation, the default, and console) were not run.
    ['Hermes plugin', 'End to end in a real Hermes (v0.23.3) with plugin 0.7.3 and approvals none, Nov 19 (our QA bot, build 9616a37). Not yet verified with the other approvals'],
    ['Claude Code plugin', 'Install check only (Claude Code 2.1.322, Nov 11, plugin 0.4.1). Not run end to end'],
    ['Codex, Cursor, Claude Desktop, VS Code, OpenClaw', 'Setup command documented; never verified'],
    ['The one-line prompt (skill.md), any agent', "Never verified end to end; the commands it runs are the CLI's, scripted"],
    ['Python / JS libraries', "Scripted use plus CI. The JS library was also used end to end by an AI agent of the team's (muse, Nov 16-17), on the same profile file as the Python client. No third-party app"]]);
  assert.match(text('compat'), /Valun should work with any MCP app\. Of MCP apps, only Claude Code has run it end to end \(headless, with console approvals, Nov 17\), and Hermes has run it end to end with its own plugin \(plugin 0\.7\.3, Nov 19\)\. The rest of the evidence is scripted clients\./);
  // A scripted run is dated, with the builds it ran on, as a closed range: never "since" a build, which reads as the build
  // live now (the lead's live check of 1b1f18f; the QA bot's daily sweeps of Nov 16 and 17 ran on 103b25f and 09875a4).
  assert.doesNotMatch(all, /since Nov 16, 20:00 UTC|build 09875a4 since/);
  // The label each way to connect carries where you choose it (the lead's decision D6 for the MCP apps).
  assert.deepEqual([...part('agent').matchAll(/<span class="ev">([^<]+)<\/span>/g)].map(m => m[1].replace(/\s+/g, ' ')),
    ['Not yet verified end to end', 'Run end to end once in Claude Code (headless, console approvals)', 'Run end to end with plugin 0.7.3 (approvals none)']);
  // What console means, once, under the join that uses it; ask is the way for an app that shows approval forms, never
  // said to be verified (fix inbox #138).
  assert.ok(text('agent').includes("With console, what your agent signs (its offers, acceptances, guarantee offers and the note at each delivery) waits for you at /pilot#owner, where you sign in with the owner token join wrote to that file (what you approve). Then move the token file out of your agent's reach (why). If your app shows MCP approval forms (elicitation), you can join with --approvals ask instead and approve in the app: that form is not yet verified in any app."));
  assert.doesNotMatch(text('agent'), /add --approvals console to the join|the Claude Code run used console/);
  assert.ok(text('agent').includes('Took the tour already? Your agent can use that identity: skip the join and only add the server. For a separate agent, join with --profile NAME and a handle of its own (so the token file has a new name too), and put --profile NAME before mcp too.'));
  assert.match(text('agent'), /ask Claude to join Valun; after the join, run \/mcp, select plugin:valun:valun and choose Reconnect\./);
  // The default branch's version (0.7.3 since Nov 19), and what an older plugin's join does with the owner token (fix
  // inbox #174: up to 0.7.2 it prints it when the file exists; 0.7.3, f318d3b, refuses the file before anything is sent):
  // what to do is in the known issues.
  assert.match(text('agent'), /The install takes the plugin's default branch on GitHub \(version 0\.7\.3 on Nov 19\), so it can change; before 0\.7\.3 its join prints the owner token if its file exists \(more\)\./);
  assert.ok(part('agent').includes('prints the owner token if its file exists (<a href="#known-join">more</a>)'));
  // The one-line route: what pasting it does, read first (the lead's decision D9), and a shell agent's two modes (D10).
  const paste = text('before-paste');
  for (const s of ['Before you paste it', 'Read /skill.md first. It is served live, so it can change.',
    'Your agent will ask you for a handle and your name (both public and permanent), one line about what it offers, and whether you approve what it signs (console approvals, the first tester\'s default) or let it act alone.',
    'It runs valun 0.7.3 from PyPI with uvx, and may offer to install uv.',
    'It makes its key, stored unencrypted in your Valun profile folder, and writes your owner token to ~/valun-owner-token-YOUR-HANDLE.txt, named for its handle. Move that file into your password manager. If your agent says join showed it the token, replace it in the owner console (New owner token).',
    'In an MCP app it adds the valun server to the app\'s config and asks you to restart.',
    'It may set itself a schedule to check its inbox (skill.md section 4). Say no if you don\'t want that.']) assert.ok(paste.includes(s), s);
  assert.match(part('before-paste'), /<a href="\/skill\.md">\/skill\.md<\/a>/);
  assert.ok(html.indexOf('id="before-paste"') < html.indexOf('id="cmd-skill"'), 'read before the line to paste');
  assert.match(text('agent'), /A shell agent can't show you a prompt: it joins with console \(you approve what it signs, its offers, acceptances, guarantee offers and the note at each delivery, in the owner console\) or none \(it acts alone within the limits\), and it asks you which\./);
  // The release these pages pin is named as it is, never as a next release to come, and nothing names a later one
  // (0.7.3 is the client release since the pin of fix inbox #177; the Hermes plugin's 0.7.3 is its own, Nov 19, fix
  // inbox #174). Any 0.7.4 or later on the page is said of the plugin, never of the client.
  for (const m of all.matchAll(/0\.7\.(?:[4-9]|\d\d)/g)) assert.match(all.slice(Math.max(0, m.index - 100), m.index), /plugin/i, all.slice(m.index - 100, m.index + 20));
  assert.doesNotMatch(all, /valun(?:==| )0\.7\.(?:[4-9]|\d\d)/);
  assert.match(all, /valun 0\.7\.3 is the current client release\./);
  assert.doesNotMatch(all, /next client release|\(unreleased\)|0\.[89]\.\d/i);
});

test('the known issues of the client release, in one place: each with what to do', () => {
  const titles = [...part('known-issues').matchAll(/<summary>(?:<span>)?([\s\S]*?)(?:<\/span>)?<\/summary>/g)].map(m => words(m[1]).trim());
  // valun 0.7.2 fixes what the 0.7.1 list had besides these (its CHANGELOG): hints that work as written, the complete
  // "cannot ask" commands, approval_cancelled, what console holds, a netting committed, the tour's end kept, --mine's
  // refresh and the notes earn takes, amounts in nanoERG, who the counterparties are, the package descriptions, and a
  // marketplace entry with no version.
  assert.deepEqual(titles, ['A lost connection during join', 'Connection errors in Python but not in curl or Node',
    'audit --mine and an edge a netting lowered', 'A dry run prints a link to nothing',
    'Guarantee texts predate the hold', 'valun audit makes an empty folder', 'Older clients']);
  const known = text('known-issues'), all = words(body(html));
  // A lost answer with valun 0.7.2 (cli.py _join_unanswered, _enroll_and_settle, _enroll_refusal, _join_not_sent,
  // _token_file_refusal): the key is kept and join prints the command that finishes it; the owner's console steps where
  // it names them. The Hermes plugin's own join (hermes-plugin-valun 0.7.1 __init__.py) stops as 0.7.1's did, told
  // apart by the token file (fix inbox #131; the newcomer test of Nov 17): one written, never revoke; the key could not
  // be stored (usually registered, so the handle stays taken) or not registered (a join that didn't finish, held for the
  // hour). None written: the join's own answer may be lost, which the agent page can't show (a page exists only once an
  // agent has a key: lib/pilot/agents.mjs agentPageShown), so the directory's ?q= does: nothing made, or a join that
  // didn't finish, whose handle is held for an hour (core.mjs UNCLAIMED_JOIN_TTL_MS) and then freed, the 409 saying
  // until when.
  const lost = text('known-join');
  for (const s of ["If valun join stops before it finishes (a cut connection, a timeout, an answer lost on the way), it says so. valun 0.7.3 makes your agent's key before the join is sent and keeps it in the profile, says what the server may hold now, and prints the command that finishes the join; uvx --from valun==0.7.3 valun doctor names it again. Run that command as printed, and revoke nothing unless it says to:",
    'The join was sent and no answer came: the owner token was only in that answer, so join wrote no token file. The same command, run again, finishes the join or answers handle_taken.',
    "Your participant was created, but no answer to the enrollment of your agent's key came (join wrote your owner token file): the key and its enrollment code are kept in the profile. Run valun enroll, or the same join, while the code is valid, as join says.",
    "The server registered your agent's key, but its answer was lost for good (enroll_token_lost): revoke this agent in the owner console, which gives a new enrollment code, then run the enroll command join named.",
    '"Nothing was sent": the server was not reached, or your token file exists already, or its folder is missing or can\'t take a new file. The server holds nothing of this join',
    "In Hermes, the plugin's own join stops as valun 0.7.1's did",
    "Don't revoke anything, and don't run the enroll it suggests: on a profile its join didn't save, it signs for the retired pilot network and gets a 403, and it skips the sandbox settings, so the tour stalls at step 3.",
    'Run hermes -p valun valun doctor: if it says the server accepted your agent, the join finished. If not:',
    "It said your agent's key could not be stored (join wrote your owner token file): the server has usually registered your agent's key, but the plugin didn't save it here, most often because the server's answer was lost. A participant with a registered key is never released, so that handle stays taken:",
    "It said your agent's key could not be registered (join wrote your owner token file): the server refused the enrollment or never got it, so no key is registered, and the join didn't finish.",
    'The same command, run again, says until when (handle_taken, "held until …"). Join again now with another handle (the commands here then name a new token file), or with the same handle after that time and a new token file name,',
    "It wrote no token file: the answer to the join itself may have been lost, with the only copy of its owner token. Your agent's page can't tell you: it exists only once an agent has a key.",
    'Look your handle up at https://valun.tech/pilot/v1/participants?q=YOUR-HANDLE. [] means the server holds nothing under that handle (the join made nothing, or what it made has been released since): run the same command again.',
    // "most likely": a participant whose key was revoked shows the same two fields (its past keys are not public).
    '"status": "awaiting_agent" with "pubkey": null is most likely a join that didn\'t finish, which nobody can use.',
    'The handle is held for an hour after that join, then freed: the same command, run again, says until when (handle_taken, "held until …").',
    // The first participant lasts the hour unless its owner signs in (core.mjs joinHeldUntil: its owner's last request),
    // so help that takes longer would find nothing (the review of #131); one with a registered key lasts.
    'A participant whose agent never got a key is released an hour after the join, unless you sign in to the owner console with the token in that file: it is then kept until an hour after your last visit.',
    'or tell us within the hour and we will help you enroll a new key for the first agent.',
    'or tell us and we will help you enroll a new key for the first agent.',
    // By version (fix inbox #174): plugin 0.7.3 refuses the file before anything is sent; 0.7.2 and older print the token.
    'Before plugin 0.7.3 (the Hermes catalog pins 0.6.2), the Hermes plugin\'s join prints the owner token when its token file exists: update it, or give each join a new file name.'])
    assert.ok(lost.includes(s), s);
  // A join retried after a cut names a new token file through its new handle (the lead's decision D12b).
  assert.ok(known.includes('join again with another handle (the commands here then name a new token file; the first join wrote one for the first agent)'));
  // A participant that was never released is no join that didn't finish: the page never promises it a release.
  const stored = lost.slice(lost.indexOf("It said your agent's key could not be stored"), lost.indexOf("It said your agent's key could not be registered"));
  assert.doesNotMatch(stored, /within the hour|released an hour|held until|free again/);
  assert.ok(part('known-join').includes('<a href="/pilot#owner">owner console</a>'));
  assert.doesNotMatch(lost, /Open \/agent\/YOUR-HANDLE|if the page exists/);
  assert.equal(core.UNCLAIMED_JOIN_TTL_MS, 3600e3, 'the hour the page names');
  assert.match(src('lib/pilot/core.mjs'), /`that handle is held until \$\{hold\.held_until\} by a join that didn't finish/, 'the words the page quotes');
  // A cut connection: Python's proxy settings, what 0.7.2 does about a cut (a read sent again; "refused" only for a 401
  // or 403), and the Hermes plugin's doctor, which words any failure as a refusal (its __init__.py doctor).
  assert.ok(known.includes("valun 0.7.3 sends a read again when its answer was cut, names a cut connection for what it is, and says \"refused\" only when the server refused your agent (401 or 403). The Hermes plugin's doctor words any failure as a refusal: when it says the server refused your agent right after a connection error, run it again before you revoke anything."));
  // valun 0.7.3 says "note" (fix inbox #177): the known issue is gone, and an older client's words are said once.
  assert.doesNotMatch(known, /prompts and answers call a note/);
  assert.match(known, /valun 0\.7\.2 calls a note a credit note or an IOU, and its join --sandbox uses console without --approvals\./);
  assert.match(known, /The guarantee tools \(valun 0\.7\.3\) say "The issuer's notes to the creditor stay as they are, and it still owes them; the backer pays a call with its own note\."/);
  assert.match(known, /An agent still on valun 0\.7\.1, or on the Hermes plugin 0\.7\.1, keeps 0\.7\.1's problems/);
  assert.match(known, /a redemption against an issuer with no reserve is answered "busy, try again in 60 s" every time\. That answer is a known bug on the server, and no retry helps/);
  assert.doesNotMatch(known, /unreleased|next client release/, 'no fix promised to a release that is out');
  // The caveats live in the box, not across the paths: the paths link to it.
  for (const id of ['agent', 'tour', 'ergo', 'build']) assert.doesNotMatch(text(id), /0\.7\.1's message names|still call a committed netting final|offer the tour's step 3 again/, id);
  for (const id of ['ergo']) assert.match(part(id), /href="#known-issues"/, id);
});

// The first use, as the assessment of Nov 17 found it: Claude Code's way in that ran end to end comes before the plugin,
// and says where claude mcp add puts the server; the first hire is an agent that answers; join names its server; the
// placeholders are refused; a handle a join that didn't finish holds is free again later.
test('first use: Claude Code\'s two lines before the plugin and their scope, a first hire that answers, --server, the placeholders, a held handle', () => {
  const agent = text('agent'), mcp = part('agent');
  // The plugin has had an install check only (plugin 0.4.1, Nov 11): it comes after the two lines that ran end to end.
  assert.ok(mcp.indexOf('id="cmd-mcp"') < mcp.indexOf('Claude Code also has a plugin'), 'the two lines before the plugin');
  // The run that went end to end had console approvals (skill.md says it so too), and the block's join now sets them
  // (fix inbox #138), so the sentence needs no flag of its own. That run set console after its join, with config
  // approvals console, which leaves the owner mandate as join --approvals console does: hence "the setup".
  assert.ok(agent.includes('For any MCP app, join in a terminal, then add the server and restart the app. In Claude Code these two lines are the setup that has run end to end:'));
  assert.doesNotMatch(agent, /with --approvals console added to the join/);
  assert.ok(agent.includes('Claude Code also has a plugin: /plugin marketplace add fitzss/valun-open, then /plugin install valun@valun, and ask Claude to join Valun; after the join, run /mcp, select plugin:valun:valun and choose Reconnect. The plugin runs your default profile. It has had an install check only (plugin 0.4.1, Nov 11), not a run end to end, so the two lines above come first.'));
  // claude mcp add's scope, as Claude Code 2.1.326 says it (claude mcp add --help: '-s, --scope <scope> Configuration scope
  // (local, user, or project) (default: "local")'; its docs: a local-scoped server "loads only in the project where you
  // added it", a user-scoped one in all your projects).
  assert.ok(agent.includes("claude mcp add adds the server only for the folder you run it in (Claude Code's default scope, local), so the tools appear only in sessions started there. To add it for every folder, run claude mcp add --scope user valun -- uvx --from valun==0.7.3 valun mcp instead."));
  assert.ok(agent.includes("Both list only the servers of the folder Claude Code runs in: a server added with claude mcp add in another folder isn't there, so add it again in this one, or for every folder with --scope user (above)."));
  // The first hire answers: the practice agent sandbox-exact, which needs no AI budget (fix inbox #173); a house agent
  // is labelled as one (as the console's cards name it: pilot.js nameOf; the review of PR #8, P9: they do paid work, so
  // not "test agents"). agent_last_seen is no proof that another agent will (Basis's paused agents check in), so an
  // unanswered offer is withdrawn after a while.
  assert.ok(agent.includes('sandbox-exact operator-run is a practice agent with no AI model: exact results, no budget to run out, an answer within seconds.'));
  assert.match(pub('pilot.js'), /p\.house_agent \? "one of the operator's house agents"/);
  assert.ok(agent.includes("Other agents answer only while they run, and most of them are the team's own test agents. agent_last_seen in the directory says when an agent last called the server, not that it will take a job: an agent can check in while its owner has paused it. If an offer gets no answer within about 15 minutes, have your agent withdraw it (valun_respond, action withdraw) and hire one of the operator's agents instead: sandbox-exact first (no AI budget), house-scribe or house-reviewer."));
  // A house agent out of its shared AI budget declines, in valun 0.7.2's ai_seller words, and nothing is owed (fix inbox #173).
  assert.ok(text('house-budget').includes('The house agents share a daily and a monthly AI budget. Once either is used up, they decline each offer ("My AI budget for today is used up …"): the deal ends declined, and nothing is owed, until 00:00 UTC or the next UTC month.'));
  // Another server: --server on join, and https://valun.tech without it (valun 0.7.1, home.py DEFAULT_SERVER).
  assert.ok(text('tour').includes('Without --server, the client uses https://valun.tech: --server URL on join points it at another Valun server instead (a staging copy, or one on your machine), and the profile keeps that server.'));
  // The placeholders, which the server refuses as they are (core.mjs PLACEHOLDER_HANDLES and PLACEHOLDER_OPERATORS).
  assert.ok(text('tour').includes("The commands below show them as YOUR-HANDLE and YOUR NAME: put yours in their place, in the token file's name too. The server refuses the placeholders as they are."));
  assert.equal(core.PLACEHOLDER_HANDLES.get('yourhandle'), 'YOUR-HANDLE');
  assert.equal(core.PLACEHOLDER_OPERATORS.get('yourname'), '"YOUR NAME"');
  // A handle that a join which didn't finish holds: the refusal says until when, and it is free again then.
  for (const id of ['tour', 'help']) assert.ok(text(id).includes("If it says the handle is held until a time, a join with that handle didn't finish (a lost connection during join): the handle is free again after that time."), id);
});

// The tour under console approvals (the readiness assessment of Nov 18): one `valun sandbox tour --yes` in console mode
// waited for its owner 8 times (staging, 01:03-01:05Z) and printed "step N done" at each wait; the owner console reads
// its approvals again every 30 s only while its tab is shown (public/pilot.js); and the advice to stop a tour whose step
// waits 5 minutes would have stopped one that waited for its owner. The tour's owner waits, step by step, as valun 0.7.1
// plans them (agent.py _sandbox_next_steps; every offer, acceptance, IOU and payment by transfer waits in console): step 1
// the welcome job taken (or the tour's own offer to sandbox-exact), step 2 an offer and a payment by transfer, step 3 an
// offer and an IOU, step 4 an offer, step 5 an offer and a payment by transfer.
const TOUR_OWNER_WAITS = {1: 1, 2: 2, 3: 2, 4: 1, 5: 2};
test('the tour under console approvals: what the owner does before it, how often it waits, the deadlines, and the 5-minute advice for the practice agents only', () => {
  const before = text('tour-console'), all = words(body(html));
  assert.match(part('agent'), /<summary>Or take the tour through your agent<\/summary>\s*<div class="note" id="tour-console">/, 'before the prompt, in the tour through an agent');
  assert.ok(before.includes('With console approvals, before the tour Keep /pilot#owner open and signed in: it checks for new approvals every 30 seconds while its tab is in front.'));
  assert.match(part('tour-console'), /<a href="\/pilot#owner">\/pilot#owner<\/a>/);
  assert.match(pub('pilot.js'), /setInterval\(\(\) => \{ if \(!document\.hidden && [^}]*loadOwner\(\{quiet: true\}\); \}, 30000\);/, 'every 30 s, while the tab is shown');
  const n = Object.values(TOUR_OWNER_WAITS).reduce((a, b) => a + b, 0);
  assert.equal(n, 8);
  assert.ok(before.includes(`The tour waits for you about ${n} times: once in steps 1 and 4, and twice in steps 2, 3 and 5 (your agent's offer, then its note or its payment by transfer), plus once each time sandbox-mallory's work is wrong and the tour buys again.`));
  // The tour command's own lines only where the agent runs it: the prompt here has it follow sandbox_next_steps, which
  // prints nothing. valun 0.7.2's tour asks nothing at its terminal while console holds every step, says where each
  // waits, and says a step is done only once it has moved past it (sandbox.py tour: top), where 0.7.1 printed
  // "step N done" at each owner wait and its last edges line before the last approval (staging's first-use round of
  // 2026-11-18).
  assert.ok(before.includes("A step that waits for you is not the practice agents being down: your agent should tell you what waits, not stop the tour. If your agent runs valun sandbox tour, it asks nothing at its terminal with console approvals (each step waits in the console instead), says where each step waits, and says a step is done only when the tour has moved past it."));
  assert.doesNotMatch(before, /valun 0\.7\.1 prints|(?<!If your agent runs )valun sandbox tour, that command stops|itself stops after/);
  // The deadlines: the tour's offers stay open an hour (0.7.1 offer_valid_hours 1); a held payment by transfer ends
  // TRANSFER_TTL_MS after the agent signed it; a bound IOU reaches the tracker only within NOVATION_MAX_AGE_MS of its
  // timestamp, so the owner approves it before the time its card gives (what a late approval does is the console's to
  // say: the approval semantics of Nov 17, D3, and the console's own deadline); the tour command stops after 30 minutes
  // (0.7.1 sandbox.tour timeout_s 1800).
  assert.equal(windows.TRANSFER_TTL_MS, 20 * 60e3);
  assert.equal(windows.NOVATION_MAX_AGE_MS, 3600e3);
  // The hour is a bound note's, which is what 0.7.1 signs on the testnet (the approval semantics of Nov 17, must_change).
  assert.ok(before.includes("Approve each one soon. The tour's offers expire an hour after your agent signs them, a payment by transfer waits only 20 minutes, and a note (a bound note, which valun signs on the testnet) reaches the tracker only within an hour of your agent's signature: approve it before the time its card gives. If your agent runs valun sandbox tour, that command stops after 30 minutes; running it again continues it."));
  // The tour at a terminal points to the same, and its waits are told apart: the practice agents, or the owner.
  assert.ok(text('tour').includes('With console approvals, the tour waits for its owner in the owner console about 8 times: what the owner does before the tour.'));
  assert.ok(text('tour').includes("If a step waits more than about 5 minutes for a practice agent, other testers' tours may be using the practice agents, or they may be down."));
  assert.ok(text('tour').includes("With console approvals, a step can also wait for you (\"Your owner must first approve a commitment in the owner console, …\"): that is not the practice agents, so don't stop the tour; approve it at /pilot#owner (before the tour)."));
  assert.ok(text('help').includes('If a step of the tour waits more than about 5 minutes for a practice agent, not for you in the owner console (before the tour), other testers\' tours may be using the same practice agents'));
  assert.ok(text('help').includes('With console approvals it also waits for you in the owner console, about 8 times (before the tour).'));
  assert.doesNotMatch(all, /waits more than about 5 minutes(?! for a practice agent)/, 'the 5-minute advice is for the practice agents only');
  const tourTrouble = html.slice(html.indexOf('<h3 id="tour-trouble">'), html.indexOf('<h3 id="tour-tell">'));
  for (const [name, h] of [['tour-trouble', tourTrouble], ['help', part('help')]]) assert.match(h, /<a href="#tour-console">before the\s+tour<\/a>/, name);
  // A link to it from the tour at a terminal opens the agent path and the folded tour through an agent.
  const p = runPage({hash: '#tour-console'});
  assert.deepEqual(p.shown(), ['agent']);
  assert.equal(p.document.getElementById('tour-console').parentNode.open, true);
});

// The tools of valun 0.7.1 (python/src/valun/schemas.py TOOLS, as its MCP server lists them): the only tool names a rule
// may name. The ones that sign or write, and the reads that show what they did.
const TOOLS_071 = ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond', 'valun_deliver',
  'valun_review_delivery', 'valun_set_limits', 'valun_guarantees', 'valun_offer_guarantee', 'valun_respond_guarantee', 'valun_call_guarantee', 'valun_check_payer'];
// A lost answer to a commitment (the readiness assessment of Nov 18, staging and a local 185adcf through a fault
// proxy): 0.7.1 reports it as internal_error ("RemoteDisconnected: Remote end closed connection without response";
// agent.py error_payload) or unreachable (client.py, a URLError), and the natural retry made a second offer (two held for
// the owner in console, two agreed deals with none). The rule: read before sending it again.
test('a lost answer: /start says to read valun_inbox before a tool that signs is sent again, naming valun 0.7.1\'s tools', () => {
  const lost = text('lost-answer');
  assert.ok(html.slice(html.indexOf('<h3 id="agent-trouble">'), html.indexOf('<h3 id="agent-tell">')).includes('<details id="lost-answer">'), 'in the agent path\'s troubles');
  // After the request went out, the server may have done it; unreachable is a request 0.7.1 could not send (client.py:
  // a URLError), so it most likely did nothing (the review of gap/first-use). Read first either way.
  assert.ok(lost.includes("If valun_propose, valun_respond, valun_deliver, valun_review_delivery, valun_offer_guarantee, valun_respond_guarantee or valun_call_guarantee answers internal_error or a connection error (RemoteDisconnected, IncompleteRead, ConnectionResetError, timed out), the server may have done it anyway: its answer may have been lost. After unreachable, valun could not send the request, so the server most likely did nothing."));
  // What to match (staging's first-use round of 2026-11-18): title, price and counterparty, which every inbox item names
  // (core.mjs inbox: awaiting_your_owner too, since then).
  assert.ok(lost.includes('Either way, before your agent sends it again, it calls valun_inbox (or valun_deal, or valun_guarantees) and looks for one with the same title, price and counterparty: an offer that waits for you is under awaiting_your_owner, and a deal offer that went out under waiting_on_others; a guarantee offer that went out is in valun_guarantees, with the same issuer, creditor and cap. Sent again, valun_propose makes a second offer, which the other side can accept as well.'));
  // A guarantee offer that went out (state offered) is in no section of its backer's inbox (guarantees.mjs inboxOf) and
  // waiting_on_others lists deals only (core.mjs inbox): the review of PR #8, F6.
  assert.doesNotMatch(words(body(html)), /only its answer was lost/);
  assert.ok(lost.includes('Your agent can withdraw a duplicate offer while it is open (valun_respond, action withdraw); with console approvals you can also reject one that waits for you in the owner console.'));
  for (const m of lost.matchAll(/\bvalun_[a-z_]+/g)) assert.ok(TOOLS_071.includes(m[0]), `${m[0]} is a tool of valun 0.7.1`);
});

// A join that stopped halfway (the readiness assessment of Nov 18; fix inbox #131): valun 0.7.1 prints a Python
// traceback when the answer to /join-sandbox is lost (it wraps only HTTP and URL errors), and says the agent's key could
// not be stored, or registered, when the enrollment's is lost or refused; the way out it prints (revoke, a new code,
// enroll) signs for the retired pilot network on a profile join did not save, and ends in 403 bad_signature. A join that
// didn't finish holds its handle (core.mjs joinHeldUntil) and the same join meanwhile gets handle_taken "held until",
// and 0.7.1 never overwrites a token file. So under every join command: never revoke or enroll; another handle and a
// new token file name, or the same handle after the hold, with a new file name if the first join wrote one. The review
// of gap/first-use: "could not be stored" (0.7.1 cli.py _join_steps, after the request went out) usually leaves the key
// registered, a participant never released (test/unfinished-join.unit.test.mjs: with a key, handle_taken for good, with
// no held_until), as the assessment's S1/S2 found it, so only a handle_taken with a time lets the same handle back.
// valun 0.7.2 (every valun join on the page): it keeps the key and prints the command that finishes the join (cli.py
// _join_unanswered, _enroll_and_settle), and the owner's console steps where it names them. The Hermes plugin's join is
// its own code (hermes-plugin-valun 0.7.1 __init__.py), so the Hermes block keeps 0.7.1's words (LOST_JOIN_071).
const LOST_JOIN = "If join stops before it finishes (a cut connection, a timeout, an answer lost on the way), it says so, keeps your agent's key in its profile, says what the server may hold now, and prints the command to run next: the same join again, or valun enroll, which sends the same enrollment again. Run that command as printed. If it answers handle_taken with a time (\"held until …\"), run it again after that time; if it says the handle is taken, join with another handle and a new token file name. Where it says to revoke your agent, you do that in the owner console, with your owner token (a lost connection during join).";
const LOST_JOIN_071 = "If join stops with a Python traceback or a timeout, or says your agent's key could not be stored or registered: don't revoke anything, and don't run the enroll it suggests. Join again with another handle and a new token file name. Only if the same join, run again, answers handle_taken with a time (\"held until …\") can you use that handle again after that time, with a new token file name if the first join wrote one. After \"could not be stored\", the server has usually registered your agent's key, which valun didn't save here, so that handle stays taken (a lost connection during join).";
// Where the page names "could not be stored" alone: only to tell it from "could not be registered".
const STORED_ALONE = ['After "could not be stored", the server has usually registered', "It said your agent's key could not be stored (join wrote your owner token file)"];
test('a lost join: under every join command, never revoke or enroll; another handle and a new token file name, or the same one only after a held_until', () => {
  const joins = Object.entries(blocks).filter(([, b]) => /\bjoin --sandbox\b/.test(b)).map(([id]) => id);
  assert.deepEqual(joins, ['cmd-mcp', 'cmd-hermes', 'cmd-tour', 'cmd-guarantee', 'cmd-pilot']);
  for (const id of joins) {
    const after = html.slice(html.indexOf(`<pre><code id="${id}">`));
    const next = /<\/div>\s*<p class="small lost-join">([\s\S]*?)<\/p>/.exec(after);
    assert.ok(next && next.index === after.indexOf('</div>'), `${id}: the line right under the command`);
    assert.equal(words(next[1]).trim(), id === 'cmd-hermes' ? LOST_JOIN_071 : LOST_JOIN, id);
    assert.match(next[1], /<a href="#known-join">/, id);
  }
  assert.equal((html.match(/<p class="small lost-join">/g) || []).length, joins.length, 'one line for each join command');
  // What valun 0.7.1 prints, and the server's words for the hold.
  assert.match(src('lib/pilot/core.mjs'), /`that handle is held until \$\{hold\.held_until\} by a join that didn't finish/);
  // Every place that sends a lost join to the known issue names both of 0.7.1's messages; one alone only where the
  // page tells them apart.
  const all = words(body(html));
  assert.doesNotMatch(STORED_ALONE.reduce((t, s) => t.split(s).join(''), all), /could not be stored(?! or registered)/, 'stored or registered, as 0.7.1 says either');
  for (const s of STORED_ALONE) assert.ok(all.includes(s), s);
  assert.ok(text('known-join').includes("In Hermes, the plugin's own join stops as valun 0.7.1's did: with a connection error (a timeout, RemoteDisconnected, IncompleteRead, a Python traceback), or saying your agent's key could not be stored or registered."));
});

// A shell agent (the readiness assessment of Nov 18): valun 0.7.1's join ends with "add `valun --profile default mcp` to
// your agent", and without valun mcp's consent loop a set-off waited until `valun clearing run`. From a shell,
// `valun call valun_inbox` signs set-offs and payments to the agent (0.7.1 cli.py _agent: consents_on_reads, at most once
// a minute), and `valun clearing watch` every consent its policy allows, transfers of its own debt too, every 30 s.
test('a shell agent keeps its client signing: valun_inbox regularly, or clearing watch running', () => {
  const shell = text('shell-signing');
  assert.ok(part('agent').indexOf('id="cmd-skill"') < part('agent').indexOf('id="shell-signing"'), 'under the one line a shell agent follows');
  assert.ok(shell.includes("A shell agent doesn't run valun mcp, which signs set-offs and payments to your agent in the background in an MCP app (join's last lines name both ways). So it runs uvx --from valun==0.7.3 valun call valun_inbox regularly (that signs them too), or keeps uvx --from valun==0.7.3 valun clearing watch running (which also signs transfers of notes it issued). Until one of them runs, a set-off or a payment to your agent waits for its signature."));
  for (const m of part('shell-signing').replace(/<[^>]+>/g, '').matchAll(/uvx --from (\S+) valun/g)) assert.equal(m[1], 'valun==0.7.3');
});

// The resulting IOU, in one set of words (the readiness assessment of Nov 18): after a hire and a set-off on staging,
// `valun clearing run` printed "3000000 PC", and `valun audit --mine` said UNKNOWN (not_anchored) and listed nothing at
// 00:58Z and 01:09Z while the ledger already showed the edges confirmed; MATCH came at 01:14Z, with the next box. The
// page says how to read the IOU from its ledger row (GET /ledger rows carry the tracker's confirmation status:
// local_only, pending, confirmed; lib/pilot/core.mjs ledger), and how long the audit says UNKNOWN.
test('the note: read it from its ledger row first; the audit says UNKNOWN until a box commits the whole ledger; PC in 0.7.1 is nanoERG', () => {
  const check = text('agent').slice(text('agent').indexOf('Check it'));
  // local_only until a box carries the IOU, pending while that box waits (lib/pilot/committed.mjs; the review of
  // gap/first-use), as skill.md section 5 says it.
  // The tracker sets a note's status by comparing its total with the totals a box commits or carries (tracker v4.4.1
  // basis_store recompute_confirmation_status, recomputed_confirmation): a row a loop lowered back to the committed total
  // reads confirmed before the next box (staging's first-use round of 2026-11-18).
  assert.ok(check.includes("That row's confirmation says local_only until a tracker box carries your note, pending while that box waits for an Ergo testnet block, then confirmed. The tracker compares totals only: a loop that clears makes a row it lowered local_only again until the next box commits the new total, but a row it lowered back to the very total the last box commits reads confirmed at once. The loop's card says when a box has committed it."));
  // After a console approval: valun 0.7.2's --mine reads the edges first (cli.py cmd_audit: Client.sync_edges), and
  // --wait-anchored waits for an anchored moment (default 600 s).
  assert.ok(check.includes('Read your ledger row first; valun audit --wait-anchored waits for an anchored moment (up to 10 minutes by default). --mine first reads your agent\'s edges from the server, as valun_status does, so a note you approved in the console is in its records when it compares them.'));
  // The wait in the words the page gives it everywhere else (the review of gap/first-use: "5 to 15 while regular, 10 to
  // 30 while slow" gave a second answer, above the measured figures), and what is the audit's own: other agents' IOUs.
  assert.ok(check.includes('Until a box commits the whole ledger, valun audit --mine says UNKNOWN (not_anchored) and lists nothing of yours: usually 5 to 15 minutes after your note; up to about 30 when Ergo testnet blocks are slow; and longer while other agents keep recording notes, since the audit needs a box with nothing recorded after it. Read your ledger row first;'));
  for (const id of ['ergo', 'help']) assert.ok(text(id).includes('usually 5 to 15 minutes; up to about 30 when Ergo testnet blocks are slow'), id);
  assert.doesNotMatch(words(body(html)), /10 to 30|while (?:Ergo testnet )?blocks are regular, \d/);
  assert.match(src('lib/pilot/core.mjs'), /confirmation: n\.confirmation\?\.status \?\? 'unknown', unit: this\.unit\}/, 'each ledger row names its status');
  for (const s of ['local_only', 'pending', 'confirmed']) assert.match(src('lib/pilot/committed.mjs') + pub('pilot.js'), new RegExp(`\\b${s}\\b`), s);
  // The tracker checks every 300 s on the testnet and posts a box only after the one before it is confirmed; then a
  // block. The audit compares the whole ledger, so other agents' IOUs since the box keep it UNKNOWN longer.
  assert.match(src('fly.testnet.toml'), /BASIS_TRACKER_UPDATE_INTERVAL_SECONDS = "300"/);
  // valun 0.7.2 names nanoERG with tERG in its clearing commands and status (its CHANGELOG), so no PC is explained.
  assert.doesNotMatch(words(body(html)), /\bPC\b|max_PC/);
});

test('every anchor that tests, docs and released clients link to is still on the page, and every link inside the page has its target', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const id of ['main', 'look', 'tour', 'agent', 'ergo', 'build', 'report', 'credentials', 'install', 'no-prompt', 'public', 'limits', 'pilot', 'help',
    'compat', 'known-issues', 'backing', 'reference', 'anchoring-now', 'approve']) assert.ok(ids.has(id), `#${id}`);
  for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(m[1]), `#${m[1]} links to nothing`);
  assert.equal(new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])).size, [...html.matchAll(/\sid="([^"]+)"/g)].length, 'ids are unique');
  // #look, the old "look first" path, is the first step of inspecting the network.
  assert.match(part('ergo'), /<li id="look">\s*<h4>Look first, without joining<\/h4>/);
});

// The page as start.js finds it: the body read into test/network-dom.mjs's elements (a <details open> is open), the
// script run in a context of its own with the window given, and every scrollIntoView recorded.
function runPage({hash = '', narrow = false, fetchFn = undefined, reduce = false} = {}) {
  const page = readBody(html), scrolled = [], replaced = [], listeners = {};
  for (const d of page.querySelectorAll('details')) if (d.hasAttribute('open')) d.open = true;
  for (const e of page.all('*')) e.scrollIntoView = function (opts) { scrolled.push([this.id || this.tagName, opts?.behavior]); };
  const document = {body: page, activeElement: null, getElementById: id => page.all('*').find(e => e.id === id) ?? null, createElement: t => new Element(t),
    querySelectorAll: s => page.querySelectorAll(s), querySelector: s => page.querySelector(s)};
  const window = {location: {hash}, innerHeight: 844, history: {replaceState: (s, t, url) => { replaced.push(url); window.location.hash = url; }},
    addEventListener: (t, f) => { (listeners[t] ??= []).push(f); },
    matchMedia: q => ({matches: (q.includes('max-width: 719px') && narrow) || (q.includes('reduced-motion') && reduce)})};
  const context = vm.createContext({document, window, setTimeout: () => 0, navigator: {clipboard: {writeText: async () => {}}},
    ...(fetchFn ? {fetch: fetchFn} : {})});
  vm.runInContext(pub('start.js').replace(/^export /gm, ''), context, {filename: 'public/start.js'});
  const tab = id => page.querySelector(`#tab-${id}`);
  const shown = () => ['agent', 'tour', 'ergo', 'build'].filter(id => !document.getElementById(id).hidden);
  const hashchange = h => { window.location.hash = h; for (const f of listeners.hashchange || []) f(); };
  return {page, document, window, context, scrolled, replaced, tab, shown, hashchange};
}

test('start.js: the chooser becomes tabs; a link to a path, to anything in one, or to a folded section opens it first', async () => {
  // No fragment: the first path, the others hidden, the tabs wired to their panels.
  let p = runPage();
  assert.deepEqual(p.shown(), ['agent']);
  const list = p.document.getElementById('paths');
  assert.equal(list.getAttribute('role'), 'tablist');
  assert.equal(list.getAttribute('aria-labelledby'), 'paths-h');
  for (const [id] of PATHS) {
    const t = p.tab(id), panel = p.document.getElementById(id);
    assert.equal(t.getAttribute('role'), 'tab');
    assert.equal(t.getAttribute('aria-controls'), id);
    assert.equal(t.getAttribute('aria-labelledby'), `path-${id}-t`);
    assert.equal(t.getAttribute('aria-describedby'), `path-${id}-d`);
    assert.equal(t.getAttribute('aria-selected'), String(id === 'agent'));
    assert.equal(t.getAttribute('tabindex'), id === 'agent' ? '0' : '-1');
    assert.equal(t.parentNode.getAttribute('role'), 'presentation');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('tabindex'), '0');
  }
  assert.deepEqual(p.scrolled, [], 'nothing scrolls on a plain load');
  // A click opens a path, names it in the address (without a new history entry), and keeps the others hidden.
  p.tab('build').click();
  assert.deepEqual(p.shown(), ['build']);
  assert.deepEqual(p.replaced, ['#build']);
  assert.equal(p.tab('build').getAttribute('aria-selected'), 'true');
  assert.equal(p.tab('agent').getAttribute('aria-selected'), 'false');
  // Arrow keys, Home and End move the focus along the tabs (wrapping); Space opens the focused one.
  globalThis.document = p.document;
  try {
    const key = (t, k) => t.dispatch('keydown', {key: k});
    key(p.tab('build'), 'ArrowDown');
    assert.equal(p.document.activeElement, p.tab('agent'), 'from the last to the first');
    key(p.tab('agent'), 'ArrowUp');
    assert.equal(p.document.activeElement, p.tab('build'));
    key(p.tab('build'), 'Home');
    assert.equal(p.document.activeElement, p.tab('agent'));
    key(p.tab('agent'), 'End');
    assert.equal(p.document.activeElement, p.tab('build'));
    const ev = key(p.tab('tour'), ' ');
    assert.ok(ev.defaultPrevented);
    assert.deepEqual(p.shown(), ['tour']);
  } finally { delete globalThis.document; }
  // A path by its fragment, the old #look, and a later change of fragment (a link inside the page).
  for (const [hash, want] of [['#tour', 'tour'], ['#ergo', 'ergo'], ['#look', 'ergo'], ['#build', 'build'], ['#cmd-redeem', 'ergo'], ['#report', 'agent']]) {
    p = runPage({hash});
    assert.deepEqual(p.shown(), [want], hash);
    assert.deepEqual(p.scrolled.at(-1), [hash.slice(1), 'auto'], `${hash}: scrolled to at once on load`);
  }
  p = runPage({hash: '#tour'});
  p.hashchange('#ergo');
  assert.deepEqual(p.shown(), ['ergo']);
  assert.deepEqual(p.scrolled.at(-1), ['ergo', 'smooth']);
  p.hashchange('#ergo');
  assert.equal(p.scrolled.length, 2, 'nothing moved: no second scroll');
  // Something inside a closed disclosure: its path is shown and the disclosure opened.
  p = runPage({hash: '#no-prompt'});
  assert.deepEqual(p.shown(), ['agent']);
  assert.equal(p.document.getElementById('no-prompt').open, true);
  p = runPage({hash: '#cmd-reserve'});
  assert.deepEqual(p.shown(), ['ergo']);
  assert.equal(p.document.getElementById('reserve').open, true);
  for (const id of ['credentials', 'help', 'pilot', 'limits', 'public', 'install']) {
    p = runPage({hash: `#${id}`});
    assert.equal(p.document.getElementById(id).open, true, id);
  }
  // The evidence table is open on a wide screen, folded on a narrow one, and opened again by a link to its section.
  p = runPage({narrow: true});
  const fold = p.page.querySelector('details.fold');
  assert.equal(fold.open, false);
  p.hashchange('#compat');
  assert.equal(fold.open, true);
  assert.deepEqual(p.scrolled.at(-1), ['compat', 'smooth']);
  assert.equal(runPage().page.querySelector('details.fold').open, true);
  assert.deepEqual(runPage({hash: '#tour', reduce: true}).scrolled.at(-1), ['tour', 'auto'], 'reduced motion: no smooth scrolling');
  // A path opened while it is out of sight (on a phone it begins below the chooser) is scrolled to. Opened from the
  // keyboard (Enter or Space: a click with detail 0), it takes the focus too, so the focus is not left on a tab scrolled
  // out of view; a pointer's click (detail 1 or more) leaves the focus where it is.
  p = runPage();
  globalThis.document = p.document;
  try {
    for (const id of ['tour', 'ergo']) p.document.getElementById(id).getBoundingClientRect = () => ({top: 900});
    p.tab('agent').focus();
    p.tab('tour').dispatch('click', {detail: 1});
    assert.deepEqual(p.scrolled.at(-1), ['tour', 'smooth']);
    assert.equal(p.document.activeElement, p.tab('agent'), 'a pointer leaves the focus');
    p.tab('ergo').click();
    assert.deepEqual(p.scrolled.at(-1), ['ergo', 'smooth']);
    assert.equal(p.document.activeElement, p.document.getElementById('ergo'), 'the keyboard moves it to the path');
    p.tab('agent').click();
    assert.equal(p.document.activeElement, p.document.getElementById('ergo'), 'a path in sight: nothing scrolls, the focus stays');
    assert.deepEqual(p.scrolled.at(-1), ['ergo', 'smooth']);
  } finally { delete globalThis.document; }
  await settle();
});

test('start.js: the live line reads GET /pilot/v1/chain only once the inspect path is shown, says what it read in words, and shows data only as text', async () => {
  const calls = [];
  let answer = {status: 200, body: {network: 'valun-testnet-1', anchoring: {state: 'anchored', daily_cap: {limit: 50, signed_today: 4, resets_at: '2026-11-18T00:00:00.000Z'}}}};
  const fetchFn = async (url, opts) => { calls.push([url, opts]); return {ok: answer.status === 200, status: answer.status, text: async () => JSON.stringify(answer.body)}; };
  const p = runPage({fetchFn});
  await settle();
  assert.equal(calls.length, 0, 'nothing is read while another path is shown');
  p.tab('ergo').click();
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/pilot/v1/chain', {credentials: 'omit', cache: 'no-store', headers: {accept: 'application/json'}}]]);
  const out = p.page.querySelector('#anchoring-now .live-out'), again = p.page.querySelector('#anchoring-now button.reread');
  const said = () => out.children.map(e => e.textContent);
  assert.equal(again.hidden, false);
  assert.equal(said()[0], 'Live valun-testnet-1: anchoring right now');
  assert.equal(out.children[0].children[0].className, 'tag live');
  assert.equal(said()[1], 'Anchored: the latest tracker box commits every note recorded so far, so an audit run now can say MATCH.');
  assert.equal(said()[2], 'Tracker boxes today: 4 of 50. The count starts again at 00:00 UTC.');
  assert.match(said()[3], /^Read at \d\d:\d\d UTC from \/pilot\/v1\/chain$/);
  assert.equal(out.getAttribute('aria-live'), 'polite', 'announced from the next reading on');
  // Shown again: not read again. The button reads it again.
  p.tab('tour').click(); p.tab('ergo').click();
  await settle();
  assert.equal(calls.length, 1);
  answer = {status: 200, body: {network: 'valun-testnet-1', anchoring: {state: '<img src=x onerror=alert(1)>', daily_cap: {limit: 50, signed_today: 50}}}};
  again.click();
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(said()[1], 'The tracker reports its anchoring as "<img src=x onerror=alert(1)>".', 'what the server wrote, as text');
  assert.ok(out.all('*').every(e => ['P', 'SPAN'].includes(e.tagName)), 'no element from the data');
  answer = {status: 503, body: {error: 'testnet_bootstrapping'}};
  again.click();
  await settle();
  assert.deepEqual(said().slice(0, 2), ['Anchoring right now', 'The anchoring could not be read just now. Try again in a minute, or open /pilot/v1/chain.']);
  // Each state of lib/pilot/anchors.mjs in words: the daily cap says until when, and none calls a netting final.
  const now = new Date('2026-11-17T01:15:00Z');
  const line = (state, cap = {limit: 50, signed_today: 50}) => p.context.anchoringNow({network: 'valun-testnet-1', anchoring: {state, daily_cap: cap}}, now);
  assert.match(line('daily_cap_reached').lines[0], /^Today's 50 tracker boxes are used up, so nothing more is committed on chain until 00:00 UTC\. Until then an audit says UNKNOWN, and notes recorded since the last box cannot be redeemed\.$/);
  // The wait in the same words as the page's prose (the lead's decision D7b), undated in a live line; never "a few
  // minutes" or "about two minutes" for the full wait.
  assert.equal(line('waiting_for_next_update').lines[0], 'Waiting for the next tracker box: the newest notes are not committed yet, so an audit says UNKNOWN until that box is confirmed. A new note is usually committed 5 to 15 minutes after it is recorded, up to about 30 when Ergo testnet blocks are slow.');
  assert.equal(line('update_in_flight').lines[0], 'A new tracker box is on its way: once a block includes it, usually within minutes, up to about 30 when Ergo testnet blocks are slow, the notes recorded before it are committed.');
  for (const s of ['anchored', 'waiting_for_next_update', 'update_in_flight', 'daily_cap_reached', 'overdue']) assert.doesNotMatch(line(s).lines.join(' '), /a few minutes|about two minutes|normally/, s);
  assert.match(line('overdue').lines[0], /a fault of the tracker, not of any note/);
  assert.equal(line('anchored').read, 'Read at 01:15 UTC from /pilot/v1/chain');
  assert.deepEqual(line('anchored', null).lines.length, 1, 'no count without the cap');
  assert.equal(p.context.anchoringNow(null, now).state, null);
  for (const s of ['anchored', 'waiting_for_next_update', 'update_in_flight', 'daily_cap_reached', 'overdue']) assert.doesNotMatch(line(s).lines.join(' '), /final/);
  for (const s of ['anchored', 'waiting_for_next_update', 'update_in_flight', 'daily_cap_reached', 'overdue']) assert.match(src('lib/pilot/anchors.mjs'), new RegExp(`state: '${s}'`), s);
});

// The command blocks of /start and of the landing (public/home.js, the same function): each command is shown whole,
// wrapped only between its words, and Copy copies the block exactly as written.
test('start.js wraps each command between its words only, and Copy copies the block as written; the landing does the same', async () => {
  const page = readBody(html), copied = [];
  const document = {body: page, getElementById: id => page.all('*').find(e => e.id === id) ?? null, createElement: t => new Element(t),
    querySelectorAll: s => page.querySelectorAll(s)};
  vm.runInContext(pub('start.js').replace(/^export /gm, ''), vm.createContext({document, setTimeout: () => 0,
    navigator: {clipboard: {writeText: async t => { copied.push(t); }}}}), {filename: 'public/start.js'});
  const codes = page.querySelectorAll('.cmd pre > code');
  assert.equal(codes.length, Object.keys(blocks).length);
  for (const code of codes) {
    assert.ok(code.classList.contains('wrapped'), code.id);
    const lines = code.children.filter(e => e.className === 'ln');
    assert.equal(lines.map(l => l.textContent).join('\n'), blocks[code.id], `${code.id}: the text as written`);
    for (const l of lines) for (const w of l.children) assert.ok(w.className === 'w' && !w.textContent.includes(' '), `${code.id}: one word a span`);
  }
  for (const b of page.querySelectorAll('button.copy')) b.click();
  await settle();
  assert.deepEqual(copied, Object.values(blocks), 'Copy: each block exactly as written, its lines joined by newlines');
  // What Copy did is said in one status line a screen reader announces, and each button is described by its command.
  const status = page.querySelector('main > p.vh');
  assert.equal(status?.getAttribute('role'), 'status');
  assert.equal(status.textContent, 'Copied.');
  for (const b of page.querySelectorAll('button.copy')) assert.equal(b.getAttribute('aria-describedby'), b.dataset.copy);
  assert.match(pub('start.css'), /\.vh \{ position: absolute; width: 1px; height: 1px;[^}]*clip-path: inset\(50%\);/, 'shown to no one, read to screen readers');
  const fn = js => /export function wrapCommand\(code, doc = document\) \{[\s\S]*?\n\}/.exec(js)?.[0];
  assert.ok(fn(pub('start.js')));
  assert.equal(fn(pub('home.js')), fn(pub('start.js')), 'the landing wraps its blocks with the same function');
});

// Every page that names a client release names the one skill.md pins, so a release bump that misses one fails here.
test('every client release the site pins is the one skill.md pins, and the tracker version is skill.md\'s', () => {
  const pins = text_ => [...text_.matchAll(/valun(?:\[\w+\])?==(\d+\.\d+\.\d+)|@fitzdoud\/valun@(\d+\.\d+\.\d+)/g)].map(m => m[1] ?? m[2]);
  const skill = pub('skill-testnet.md'), [release, ...more] = new Set(pins(skill));
  assert.ok(release && !more.length, `skill.md pins one release: ${[release, ...more]}`);
  // lib/a2a.mjs also names the release a local server's docs pin (LOCAL_CLIENT: the one the local image was verified
  // with), apart from the testnet's: it is the one public/skill-local.md pins, and nothing else there names it.
  const LOCAL_LINE = /^export const LOCAL_CLIENT = 'valun==(\d+\.\d+\.\d+)';$/m;
  assert.deepEqual([...new Set(pins(pub('skill-local.md')))], [LOCAL_LINE.exec(src('lib/a2a.mjs'))[1]], 'LOCAL_CLIENT is the local skill\'s pin');
  for (const f of ['public/start.html', 'public/home.html', 'public/network.html', 'public/network.js', 'lib/a2a.mjs', 'lib/pilot/agents.mjs']) {
    const t = f === 'lib/a2a.mjs' ? src(f).replace(LOCAL_LINE, '') : src(f);
    for (const v of pins(t)) assert.equal(v, release, f);
    assert.doesNotMatch(t, /uvx valun |uvx --from valun valun|pipx install valun(?!==)(?! inside)|uv tool install valun(?!==)|npm install @fitzdoud\/valun(?!@)/, `${f}: no unpinned client`);
  }
  for (const f of ['public/start.html', 'public/home.html', 'public/network.html', 'lib/a2a.mjs']) assert.ok(pins(src(f)).length, `${f} pins the client`);
  assert.ok(html.includes(`valun ${release} is the current client release`), 'the known issues name the release they are about');
  assert.match(html, new RegExp(`<h2 id="known-issues-h">Known issues in valun ${release.replaceAll('.', '\\.')}</h2>`));
  const tracker = t => /tracker v(\d+\.\d+\.\d+)\)/.exec(t)?.[1];
  assert.equal(tracker(html), tracker(skill));
});
