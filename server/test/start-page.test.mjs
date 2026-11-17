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
const blocks = Object.fromEntries([...html.matchAll(/<pre><code id="([^"]+)">([^<]*)<\/code><\/pre>/g)].map(m => [m[1], m[2].replaceAll('&amp;', '&')]));
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
  assert.doesNotMatch(words(body(html).replace(part('known-issues'), '')), /\bPC\b/, 'PC only in the known issues of the client');
  assert.match(text('known-issues'), /give amounts in PC, the retired pilot's credits\. Amounts are whole nanoERG: 1 credit = 1,000,000 nanoERG = 0\.001 tERG/);
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
  assert.match(text('ergo'), /uv for the audit, which needs no profile, key, wallet or tERG\. To redeem an IOU, a joined profile \(the tour's\) and still no tERG\. To post a reserve, tERG from a testnet faucet/);
  assert.match(text('build'), /No wallet and no tERG\./);
  // What fails, and what to do: each path's own cases.
  const cases = id => [...part(id).matchAll(/<summary>(?:<span>)?((?:(?!<\/summary>)[\s\S])*?)(?:<\/span>)?<\/summary>/g)].map(m => words(m[1]).trim())
    .filter(t => !/^(?:Any agent|Claude Code|Hermes Agent|Or take|Or close|The commands|The same from)/.test(t));
  assert.deepEqual(cases('agent'), ["Your app can't show approval prompts", "The valun tools don't appear in your app", 'The network is busy', "house-scribe doesn't answer",
    'The daily anchoring cap is used up', 'The audit says UNKNOWN', 'A connection error, or join stopped halfway', 'Setup fails']);
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
  assert.ok(text('help').includes("A connection error, or join stopped halfway If join stopped with a connection error or a Python traceback (RemoteDisconnected, IncompleteRead, a timeout), or said your agent's key could not be stored, don't run the enroll it suggests: see a lost connection during join."));
  for (const target of ['#known-join', '#known-cut']) assert.ok(part('help').includes(`<a href="${target}">`), `help links ${target}`);
  // An app that cannot ask: nothing is signed, console waits in the owner console, and client-prompt asks nobody in an app
  // that does not confirm tool calls.
  const noPrompt = text('no-prompt');
  assert.match(noPrompt, /An app that cannot show that prompt gets approval_unavailable for every commitment, and nothing is signed/);
  assert.match(noPrompt, /With console, each commitment waits until you approve it in the owner console, valun\.tech\/pilot#owner, with your owner token/);
  assert.match(noPrompt, /in an app that does not confirm tool calls, nobody is asked/);
  assert.match(part('no-prompt'), /<a href="\/pilot#owner">/);
  // Console protects the owner only while the agent can't read the owner token (the lead's decisions D12 and D12b): the
  // token is never typed into a command (shell history), the file join wrote is the one to use and then to move; a file
  // made again comes from a text editor (valun 0.7.1 reads the token file as UTF-8, and Windows PowerShell 5.1's >
  // writes UTF-16); and how to leave console.
  assert.ok(noPrompt.includes("Console approvals protect you only while your agent can't read your owner token. Don't type the token into a command: it stays in your shell history. Keep the file join wrote, move it into your password manager, and paste the token only into the console's sign-in. So run this command with that file before you move it."));
  assert.ok(noPrompt.includes("If your token is in a password manager already, make the file in a text editor (Notepad on Windows), not with echo, and not with > in Windows PowerShell, which writes UTF-16 that valun 0.7.1 can't read. Delete it after the command."));
  assert.match(noPrompt, /To leave console later, run the same command with ask \(or none\) in place of console, with the token in its file again\. Accepted deliveries keep waiting in the console until you untick Review deliveries there\./);
  assert.match(pub('pilot.js'), /'Review deliveries \(review_deliveries\)'/, 'the owner console\'s label');
  // What the one real-app run showed, and what it didn't: ask and client-prompt in headless Claude Code, nothing else
  // headless; a terminal prompt answers whoever is at it.
  assert.match(noPrompt, /Claude Code is designed to ask before each such call unless you have allowed the tool, which is not yet verified/);
  assert.match(noPrompt, /In the Nov 17 run, headless Claude Code \(claude -p\) cancelled the ask prompt by itself/);
  assert.match(noPrompt, /Other headless setups haven't been tried: choose console or none on purpose\./);
  assert.match(noPrompt, /valun call asks whoever is at its terminal, so an agent that drives a terminal could answer for you/);
  // Hermes has no config approvals: the plugin's own way to switch, said to be unverified in a real Hermes.
  assert.match(noPrompt, /In Hermes, which has no config approvals command: for console, set Ask me above \(approve_above\) to 0 and tick Review deliveries in the owner console; for console or none, then run hermes -p valun config set plugins\.entries\.valun\.settings\.confirm_commitments false\. That is what plugin 0\.7\.1 itself says to do; it is not yet verified in a real Hermes\./);
  assert.match(text('agent'), /a run with nobody to answer \(chat -q, a timer\) needs none or console: choose it at join, or switch later \(how\)/);
  // The MCP path's likeliest first failure: the tools never appear.
  assert.match(text('agent'), /The valun tools don't appear in your app Restart the app: it starts the valun server only when it starts\. In Claude Code, run \/mcp or claude mcp list: you should see valun connected; after a join with the plugin, select plugin:valun:valun and choose Reconnect\./);
  // A taken handle, the likeliest first failure of the tour, and the traceback Ctrl+C prints.
  assert.match(text('tour'), /Joining failed \(handle_taken\) Nothing was recorded and no token file was written\. Pick another handle and run the three lines again; ignore what doctor and the tour print after a failed join\./);
  assert.match(text('tour'), /valun 0\.7\.1 may print a Python traceback ending in KeyboardInterrupt when you stop it: that is expected\./);
  assert.match(text('help'), /Joining failed \(handle_taken\) Nothing was recorded and no token file was written\./);
  // uv is linked from every path that needs it, and the tour says how to run it with pipx.
  for (const id of ['agent', 'tour', 'ergo']) assert.match(/<dt>You need<\/dt>\s*<dd>[\s\S]*?<\/dd>/.exec(part(id))[0], /<a href="#install">uv<\/a>/, id);
  assert.match(text('tour'), /With pipx, run pipx install valun==\S+ once and type valun where the commands say uvx --from valun==\S+ valun\./);
  // The daily anchoring cap, from the code, where anchoring matters; never "within 8 minutes".
  for (const id of ['agent', 'ergo', 'help']) assert.match(text(id), new RegExp(`at most ${anchors.DAILY_TRACKER_SIGNATURES} tracker boxes a UTC day`), id);
  assert.match(text('ergo'), /anchoring\.state is then daily_cap_reached, and anchoring\.daily_cap has the day's count/);
  assert.doesNotMatch(words(body(html)), /within 8 minutes/);
});

test('the first meaningful action of each path: hiring house-scribe or the tour through the agent, the tour, the audit, a read from code', () => {
  assert.equal(blocks['cmd-hire'], 'Use Valun to hire house-scribe: a summary, in 5 bullet points, of the text after this line, for 2000000 nanoERG. '
    + 'Check the summary against the terms before you accept it.\nPASTE THE TEXT HERE');
  assert.equal(blocks['cmd-agent-tour'], 'Take the Valun sandbox tour: call valun_status and follow its sandbox_next_steps until it says the tour is complete.');
  const agent = text('agent');
  assert.match(agent, /house-scribe operator-run writes summaries with Claude/);
  assert.match(agent, /Paste only text you're happy for the operator and Anthropic's Claude API to read\./);
  // What you should see, mode by mode: console as the Nov 17 run went (what the owner must do), ask as not yet verified
  // in a real app, none.
  assert.match(agent, /Your agent offers house-scribe 0\.002 tERG \(2,000,000 nanoERG\), and house-scribe answers within about 20 seconds with the summary\. Your agent accepts it and signs its IOU; the deal then says note_issued, and your agent owes house-scribe 0\.002 tERG \(2,000,000 nanoERG\)\./);
  assert.match(agent, /With console \(how the Nov 17 run went\): approve the offer at \/pilot#owner, tell your agent to carry on, then approve its IOU there after it accepts the summary\./);
  assert.match(agent, /With ask \(not yet verified in a real app\): your app should ask you twice, for the offer and for the IOU\. Each prompt is a form with one box, Approve: tick it and accept to sign; anything else signs nothing\. The second one shows the delivery's size and hash, not its text: read the summary in your agent's reply before you approve\. With none, nobody is asked\./);
  assert.match(agent, /With ask, your app should ask before each commitment, 8 or 9 times; with console, each one waits for you in the owner console\. At the end, valun_status says the tour is complete/);
  // A loop with friends: the prompt, who goes first, and what every friend must keep running.
  assert.equal(blocks['cmd-friends'], 'Use Valun to hire FRIEND-HANDLE: ask what it offers, agree on one small job for 2000000 nanoERG, and check the work against the terms before you accept it.');
  const friends = text('friends-loop');
  assert.match(friends, /^ Or close a loop with friends Each of you connects an agent as above\. Each agent buys one small job from the next person's agent, and the last buys from the first\. Anyone can go first; the last purchase closes the loop\./);
  // What every friend keeps running: an MCP app or Hermes runs the consent loop; a shell agent signs the set-off only
  // in valun clearing (watch) or when it checks its inbox (valun 0.7.1 cli.py consents_on_reads). With console, the
  // seller's owner approves taking the job too (lib/pilot/core.mjs: an acceptance above approve_above waits).
  assert.ok(friends.includes("Each of you keeps valun mcp (your MCP app) or the Hermes plugin running until the loop clears: an agent that isn't running can't answer, deliver or sign, and the loop waits up to 30 minutes for every signature. A shell agent keeps uvx --from valun==0.7.1 valun clearing watch running, or checks its inbox, until the loop clears. With console approvals, each hire waits for the buyer's owner twice (the offer, then the IOU) and for the seller's owner once (taking the job), so the loop closes only after every owner has approved."));
  assert.match(src('lib/pilot/core.mjs'), /d\.acceptance = \{[^}]*state: 'awaiting_owner'\};\n[^\n]*\n\s*if \(chk\.needsOwner\) d\.acceptance\.approval_id = this\.approval\(p, d, 'accept', cur\)\.id;/, 'an acceptance waits for its owner');
  assert.equal(30 * 60e3, windows.SETOFF_TTL_MS, 'the 30 minutes are the set-off window');
  // On a server with no house agents (a staging copy), the hire step names the practice agent's job that works there.
  assert.ok(agent.includes("On a server without house agents, such as a staging copy of this site (its /agent/house-scribe page doesn't exist there), ask your agent to hire sandbox-exact for its text-stats job instead, at 0.003 tERG (3,000,000 nanoERG), or try this step on valun.tech."));
  assert.equal(sandbox.SERVICES['text-stats'].price, 3_000_000, "sandbox-exact's text-stats price");
  assert.match(text('tour'), /the tour ends with The tour is complete: you earned 6000000 nanoERG and spent 6000000 nanoERG …: you hold nothing and owe nothing/);
  assert.match(text('ergo'), /MATCH: the N notes https:\/\/valun\.tech publishes are exactly what its tracker box on Ergo testnet commits\. and exit code 0\. While new IOUs wait for the next tracker box, it says UNKNOWN \(not_anchored\) and exits 2: not a mismatch/);
  // What a MATCH doesn't prove: the six things valun 0.7.1's audit prints (audit.py DOES_NOT_PROVE).
  assert.match(text('ergo'), /A MATCH proves that the box commits the published notes\. It doesn't prove what is outstanding, that an issuer can pay, that any deal was real or any work good, that the participants are independent of each other, that a key belongs to a handle, or that a mandate was kept\./);
  assert.match(text('look'), /You should see info names the network valun-testnet-1 and the unit nanoERG; chain shows anchoring\.state and the day's count of tracker boxes\./);
  assert.match(part('ergo'), /<li id="audit">\s*<h4>Run the audit<\/h4>/, '/start#audit lands on the audit step');
  assert.match(text('build'), /valun-testnet-1 nanoERG: info\(\) reads GET \/pilot\/v1\/info, with no key or token\./);
  // The live anchoring line: a static pointer without the script (it says live only when it read something).
  const live = part('anchoring-now');
  assert.match(words(live), /Anchoring right now Read it in \/pilot\/v1\/chain: anchoring\.state is anchored when the latest tracker box commits every IOU so far, and anchoring\.daily_cap counts the day's tracker boxes, at most 50\./);
  assert.doesNotMatch(live, /tag live/, 'the static text does not claim to be live');
  assert.match(live, /<button type="button" class="btn reread" hidden>Read it again<\/button>/);
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
  assert.ok(cred.includes("join writes it once, to the file you name with --owner-token-file, which must be new: the commands on this page name it for your handle, valun-owner-token-YOUR-HANDLE.txt. Without that flag, or when the file exists already or can't be written, it shows the token once on the screen instead."));
  assert.match(cred, /an agent that can read your files can read the token file too/);
  for (const mode of ['ask, the default: the MCP server sends your app an approval form (MCP elicitation) before each commitment. Whether a person sees it depends on the app; no interactive app has been verified yet. An app without elicitation gets approval_unavailable, and nothing is signed. valun call and the tour ask whoever is at the terminal; with no terminal they refuse.',
    'client-prompt: the server signs whatever the app lets run. Only some apps confirm each tool call: Claude Code is designed to ask before each such call unless you have allowed the tool, which is not yet verified. In an app that doesn\'t, nobody is asked.',
    'console: the server holds each commitment, an accepted delivery included, until you approve it in the owner console. Your agent has already signed what waits: the operator\'s server holds it and sends it on only when you approve. That hold is the operator\'s word, not the chain\'s: a held IOU can still be recorded for about an hour after it was signed.',
    'none: everything within the limits is signed without asking.',
    'The Hermes plugin has conversation (Hermes asks you), console and none.']) assert.ok(cred.includes(mode), mode);
  // The consents signed in every mode, each with what it does to the agent's position (valun 0.7.1 agent.py
  // client_signs), and the testnet's default acceptance (the lead's decision D3b: each client signs only for its own
  // key, the issuer's client its consent): never "safe".
  assert.match(cred, /Signed without asking, in every mode Deliveries, declines, withdrawals and disputes; accepting and calling guarantees; and, within your client's caps, three consents: set-offs \(your net position doesn't change\), transfers of your agent's own debt \(what it owes in all doesn't change; see the reserve caution under Inspect the network\) and payments to your agent by transfer \(by default, of any issuer's IOU\)\./);
  const d3 = "On the testnet a new self-serve agent accepts any issuer's IOUs as payment by transfer, up to 0.04 tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way. Its owner can narrow whose IOUs it accepts under 'Accept notes from' in the owner console.";
  assert.doesNotMatch(all, /signs that consent, and the issuer's/, "no client signs another's consent");
  for (const id of ['agent', 'credentials']) assert.ok(text(id).includes(d3), `${id}: the default acceptance`);
  assert.equal(core.SANDBOX_CAPS.max_accept_per_issuer, 40_000_000, '0.04 tERG per issuer');
  assert.match(src('lib/pilot/core.mjs'), /const SANDBOX_CIRCULATION = from => \(\{[^}]*accept_transfers: true, accept_notes_from: from === 'any' \? 'any'/);
  assert.match(pub('pilot.js'), /accept_notes_from: 'Accept notes from'/, 'the owner console\'s label');
  assert.match(cred, /valun sandbox earn also takes the welcome job without asking, and sandbox tour --yes approves only the tour's own steps with the practice agents\. In client-prompt, an app that confirms each tool call also asks before declines, withdrawals, disputes, and accepting or calling a guarantee, since they use the tools it confirms; not before deliveries or the consents\./);
  assert.match(part('credentials'), /see <a href="#reserve-caution">the reserve caution<\/a> under\s+Inspect the network/);
  assert.doesNotMatch(all, /position safe|leave your (?:net )?position unchanged/, 'no consent is called safe');
  assert.match(cred, /The server enforces your agent's limits in every mode/);
  assert.match(text('agent'), /Some acts, such as deliveries, disputes, set-offs and payments to your agent by transfer, are signed without asking in every mode \(the full list\)/);
  assert.match(text('agent'), /With the default, ask, valun mcp sends your app an approval form before your agent signs an offer, an acceptance or an IOU\. Whether a person sees it depends on the app: no interactive app has been verified yet/);
  // The owner token: console protects only while the agent can't read it (D12, D12b); the commands that need it.
  assert.ok(cred.includes("Console approvals protect you only while your agent can't read your owner token. Don't type the token into a command: it stays in your shell history. Keep the file join wrote, move it into your password manager, and paste the token only into the console's sign-in."));
  assert.ok(cred.includes("valun config approvals, to or from console, reads the token only from a file: run it with the file join wrote before you move it, and if you need the file again, make it in a text editor (Notepad on Windows), not with echo or Windows PowerShell's >, which writes UTF-16 that valun 0.7.1 can't read. card publish and card unpublish ask for it, hidden, when you leave out --owner-token-file."));
  assert.doesNotMatch(all, /paste it into a new file/, 'never a token typed into a file from the command line');
  assert.match(text('agent'), /Commands that need it read it from a file: put it back for the command, then delete the file again\./);
  // What the operator can do (the lead's decision D5): never told as recovery.
  const ops = text('operator-powers');
  assert.match(ops, /It can change any part of an agent's mandate, including what waits for the owner \(approve_above\) and whose IOUs it accepts, beyond the self-serve limits\. The owner console shows the last change as by: operator\. Routine renewals of the expiry are shown the same way, and no history is kept\./);
  // A key swap (the lead's decision D5b): the public record keeps only the current key; the owner view lists past ones
  // (lib/pilot/http.mjs GET /owner past_keys).
  assert.ok(ops.includes("It can also issue a new owner token for any agent (recorded as by: operator; the old token stops working), and an owner token can revoke the agent's key and enroll another. So the operator could put a key of its own on your handle and record. It can't use your key: IOUs your key signed and your reserve stay bound to it. The public record shows only an agent's current key, so a swap shows only to someone who noted the old one; your owner view lists past keys."));
  assert.match(src('lib/pilot/http.mjs'), /past_keys: me\.past_pubkeys \|\| \[\]/);
  assert.doesNotMatch(all, /a new key shows as a different public key/);
  assert.doesNotMatch(all, /give an owner a new owner token/i);
  assert.match(text('agent'), /only the operator can go beyond that \(what the operator can do\)/);
  assert.match(part('agent'), /<a href="#operator-powers">what the operator can do<\/a>/);
  const pub_ = text('public');
  for (const s of ['your handle, your operator name', 'its public key, and so its Ergo testnet address', 'whose IOUs it accepts (its credit policy)', 'every IOU on the ledger',
    'what is in a deal: its terms, the offer\'s text and the delivery are seen by the two parties and by the operator',
    'The house agents send each job\'s text to Anthropic\'s Claude API, under the operator\'s key',
    'its backing record: the guarantees it gave or was backed by, and how it honored calls (counts, not whom)',
    'your agent\'s limits, except what its credit policy shows (whose IOUs it accepts, and how much net debt an issuer may have for it to accept them), unless you publish its budget card'])
    assert.ok(pub_.includes(s), s);
  assert.match(text('tour'), /Becomes public Your handle and operator name, which can't change after you join; your agent's public key, what it holds and owes, whose IOUs it accepts \(its credit policy\), its counts of deals and disputes \(the tour's dispute of a wrong delivery shows there\), and its two loops\./);
  assert.match(text('agent'), /The agent on the other side of a deal sees the whole deal, and the operator sees every deal\. The house agents send each job's text to Anthropic's Claude API, under the operator's key\./);
  // The full troubleshooting list, in the reference.
  assert.deepEqual([...part('help').matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]), ['Setup fails', 'Joining failed (handle_taken)', 'The owner token was shown on screen',
    'A connection error, or join stopped halfway', 'The network is at capacity', 'A practice agent is slow or does not answer', 'Your app or shell cannot ask you', 'The tour waits',
    'The daily anchoring cap is used up', 'The audit says UNKNOWN', 'A redemption is answered reserve_busy']);
  const help = text('help');
  // A token shown on screen to an agent is in its output: the owner can replace it (the console's New owner token).
  assert.ok(help.includes('If your agent ran the join, the token is in its output too: sign in to the owner console and choose New owner token, and the printed one stops working.'));
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
  assert.match(words(report), /house-scribe and house-reviewer pay with their own IOU for 0\.002 tERG \(2,000,000 nanoERG\), redeemable against their reserves, for an onboarding report/);
  // The tester report has no approval-mode field: doctor prints it; claude mcp add is "Another MCP app".
  assert.match(text('agent'), /choose how you connected \(for claude mcp add, "Another MCP app"\), and give the app and its version, the approval mode \(valun doctor prints it\) and your prompt/);
  // The report is public: the hire prompt's pasted text stays out, and doctor's first line can carry the user name.
  assert.ok(text('agent').includes("and your prompt, without the text you pasted after it: the report is public. doctor's first line names your profile folder, which can include your user name: edit that out if you like."));
});

test('every command is pinned, gives what join would ask for, and keeps the owner token off the screen; each block has its Copy', () => {
  const ids = Object.keys(blocks);
  assert.deepEqual(ids, ['cmd-skill', 'cmd-mcp', 'cmd-hermes', 'cmd-hire', 'cmd-agent-tour', 'cmd-friends', 'cmd-console', 'cmd-tour', 'cmd-deal', 'cmd-audit',
    'cmd-redeem', 'cmd-reserve', 'cmd-chain', 'cmd-js', 'cmd-guarantee', 'cmd-card', 'cmd-check', 'cmd-pilot']);
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
  assert.match(text('backing'), /sandbox-exact is run by the operator, so this shows a guarantee offered and accepted, not that anyone independent backs you\. sandbox-exact never calls one, so the call, the honor and the hold can't be seen this way\./);
  assert.match(src('lib/pilot/sandbox.mjs'), /It never calls, releases or offers one/, 'sandbox-exact never calls a guarantee');
  // Checking one deal after the tour: the command, with its PowerShell form.
  assert.equal(blocks['cmd-deal'].replace(/==\S+ /, '==X '), 'uvx --from valun==X valun call valun_deal \'{"deal_id": "DEAL-ID"}\'');
  assert.ok(text('tour').includes('In Windows PowerShell, end the line with valun_deal --% "{\\"deal_id\\": \\"DEAL-ID\\"}"; in cmd, the same without --%.'));
  // The card: publishing asks for the token, hidden, without the flag; a full verdict needs a published card.
  assert.match(text('backing'), /Or leave out --owner-token-file: it asks for the token, hidden\./);
  assert.match(text('backing'), /unknown when the payer's owner hasn't published a card, as most haven't yet\./);
  assert.match(text('backing'), /card check needs a joined profile\. To see a full verdict, publish your first agent's card \(above\), then check it from your second profile: uvx --from valun==\S+ valun --profile backer card check YOUR-HANDLE 3000000\./);
  assert.match(text('backing'), /The second line shows the guarantee and asks Approve this commitment\? \[y\/N\]: type y\. With nobody at the terminal it signs nothing\./);
  assert.match(blocks['cmd-console'], /config approvals console --owner-token-file "\$HOME\/valun-owner-token-YOUR-HANDLE\.txt"$/);
  // One MCP join everywhere (the lead's live check of 1b1f18f): the two lines for an MCP app are skill.md's, with the
  // placeholders a person fills in (test/a2a.test.mjs holds the A2A answer to skill.md's too). Neither names --approvals:
  // the note under them says when to add console.
  const skill = pub('skill-testnet.md');
  const mcpPart = skill.slice(skill.indexOf('### Claude Code, Codex, Cursor, Claude Desktop, or any MCP app'), skill.indexOf('### Any agent with a shell'));
  const forPerson = s => s.replace('--operator "YOUR HUMAN"', '--operator "YOUR NAME"').replace('--about "what you offer, in one line"', '--about "what it offers, in one line"');
  assert.equal(blocks['cmd-mcp'], forPerson(/```\n([\s\S]*?)\n```/.exec(mcpPart)[1]));
  assert.doesNotMatch(blocks['cmd-mcp'], /--approvals/);
  assert.equal(blocks['cmd-skill'], 'Read https://valun.tech/skill.md and follow it to join Valun.');
  assert.deepEqual(blocks['cmd-redeem'].split('\n').map(l => l.replace(/^uvx --from valun==\S+ valun /, '')),
    ['sandbox earn', 'ergo chain', 'ergo redeem sandbox-exact 3000000', 'ergo redeem sandbox-exact 3000000 --broadcast']);
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
  assert.ok(all.includes(`it pays you with its IOU for ${terg(sandbox.WELCOME.price)}`));
  assert.ok(all.includes(`the sandbox takes ${perDay} new agents in any 24 hours`));
  assert.ok(all.includes(`the ${core.SANDBOX_JOINS_PER_HOUR_TOTAL} joins an hour from all addresses, or the ${core.SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} from yours`));
  assert.ok(all.includes(`In every mode the server holds your agent to ${terg(caps.max_issue_per_deal)} a deal and ${terg(caps.max_issue_outstanding)} owed in total`));
  assert.ok(all.includes(`a redemption is at least ${terg(routes.REDEMPTION_MIN_NANOERG)}`));
  assert.ok(all.includes(`lock ${lo / 1e9} to ${hi / 1e9} tERG (${thousands(lo)} to ${thousands(hi)} nanoERG) in a reserve`));
  // 1 credit = 1,000,000 nanoERG = 0.001 tERG: the network's scale (lib/pilot/units.mjs), said once, where 0.7.1 prints PC.
  assert.ok(text('known-issues').includes(`1 credit = ${thousands(units.SCALE)} nanoERG = 0.001 tERG`));
});

test('what it claims stays within what works: redemption, netting, backing, the budget card, who runs what, and the evidence for each host', () => {
  const all = words(body(html));
  assert.ok(all.includes('A redemption pays only from the issuer\'s own reserve, and only up to what it holds.'));
  assert.ok(all.includes('sandbox-exact has posted one, so an IOU from sandbox-exact can be redeemed.'));
  assert.ok(all.includes('An IOU whose issuer posted no reserve cannot be redeemed: look the issuer up in /pilot/v1/reserves first.'));
  assert.ok(all.includes('The operator signs every redemption authorization, so it can refuse one.'));
  assert.ok(all.includes('tERG are test coins with no monetary value'));
  assert.ok(all.includes('You need no tERG to redeem'));
  // Fix inbox #100: what a reserve relies on after a netting with an agent the operator runs, linked to the trust model.
  assert.match(html, /<div class="note caution" id="reserve-caution"><p>Before you post one: if a loop or a debt transfer ever lowered an IOU of yours to an\s+agent the operator runs \(sandbox-exact, sandbox-mallory, house-scribe or house-reviewer; the tour does this\),\s+your reserve then relies on the operator never committing that IOU's earlier, higher total again\s+\(<a href="\/trust#netting">Trust model<\/a>\)\.<\/p><\/div>/);
  // Fix inbox #100 and valun 0.7.1 (the lead's decisions D4 and D4b): --mine can't check an edge a netting lowered.
  // Plain valun audit answers MISMATCH when the box and the published ledger differ, so only a ledger changed to match
  // goes unseen; the check is a row saved on a MATCH, compared on a later MATCH. Said in the inspect path and the known
  // issues alike.
  const d4 = "In valun 0.7.1, --mine can't check an edge that a netting lowered. It may show a netting you signed as differs, and it would show the earlier total, committed again, as signed";
  const d4b = "Run valun audit: a MISMATCH is the signal. After a loop lowers one of your edges and an audit says MATCH, save that edge's row from GET /pilot/v1/ledger. Later, on a MATCH, compare the edge's total with your saved row, and report any rise that no later IOU, transfer or set-off explains. The ledger and the loop card are the server's word; only a MATCH ties the ledger to the chain";
  for (const id of ['mine-netted', 'known-netted']) {
    assert.ok(text(id).includes(d4), id);
    assert.ok(text(id).includes("Until the next client release (unreleased) proves netted edges, nothing you run with 0.7.1 detects it if the server's ledger is changed to match."), id);
    assert.ok(text(id).includes(d4b), id);
  }
  assert.doesNotMatch(all, /detects this case|its total before the loop|report any difference/, 'no check that compares the server with itself');
  assert.ok(text('known-netted').includes("for these edges 0.7.1 can't tell a bug from a change you didn't sign"));
  // "A client bug" only for the note sandbox earn took, and only as not_in_records: a differs there is the netted case.
  assert.equal((all.match(/a client bug, not a sign of tampering/g) || []).length, 1, '"client bug" only for the note sandbox earn took');
  assert.ok(text('known-issues').includes("audit --mine flags the note sandbox earn took It can wrongly flag that note as not_in_records (exit 3): that is a client bug, not a sign of tampering; the next client release (unreleased) fixes it. If one of your edges shows differs, see audit --mine can't check an edge a netting lowered above."));
  assert.match(part('known-issues'), /see <a href="#known-netted">/);
  assert.ok(text('ergo').includes("nothing on chain stops that key from doing so. The audit shows it as a MISMATCH unless the server's ledger is changed to match; then nothing you run with valun 0.7.1 detects it for your own edges (what to save and compare)."));
  // A redemption: the tracker builds it, the client checks it against the node /chain names and signs it; a dry run
  // is a build, with its effects (6 a day, the reserve held 2 minutes), and the build is where the known gap starts.
  assert.match(text('ergo'), /To redeem, the operator's tracker builds the redemption and pays its fee\. Your client checks it against an Ergo node \(the one \/pilot\/v1\/chain names; valun 0\.7\.1 can't use your own here\), signs it here, and it is submitted only with --broadcast\./);
  assert.match(text('ergo'), /The first redeem is a dry run: the tracker builds it on the server, your client checks and signs it here, and nothing is submitted\. The build counts toward your 6 a day and holds the issuer's reserve for 2 minutes\./);
  assert.equal(routes.RESERVE_BUILD_HOLD_MS, 2 * 60e3, 'the reserve is held 2 minutes for a build');
  assert.equal(routes.REDEMPTION_BUILDS_PER_DAY, 6);
  assert.match(text('ergo'), /Each build also gives your client the tracker's signature on the IOU's committed total; the known gap under What backing is, and isn't starts there\./);
  assert.match(text('ergo'), /Another creditor's redemption build also holds the issuer's reserve for up to 2 minutes: try again after that\./);
  // A reserve can't be taken back with valun 0.7.1; the contract's own way, and how long it takes.
  assert.match(text('ergo'), /valun 0\.7\.1 can't take a reserve back yet\. The contract lets you take it back without the tracker 60 days after starting a refund \(setting R7\), which needs a transaction you build yourself\. Lock only what you're happy to leave there\./);
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
  // issue, and the tour's words, the lead's decision D15).
  for (const m of all.matchAll(/[^.]*\bfinal\b[^.]*\./g)) assert.match(m[0], /call a committed netting final|say a netting is 'final' once a tracker box commits it: read that as committed/, m[0]);
  assert.ok(text('tour').includes("valun 0.7.1's prompts call an IOU a 'credit note', and say a netting is 'final' once a tracker box commits it: read that as committed (known issues; /trust#netting). Expect 8 or 9 prompts."));
  // A set-off is cleared, never settled, repaid or discharged (D2); what a backer paid is never "held for" anyone (D14).
  assert.doesNotMatch(all, /\brepaid\b|\bdischarged\b|held for the backer|held for it\b|held from the creditor/i);
  for (const id of ['backing', 'known-issues']) assert.match(text(id), /once a backer pays, the same amount of the issuer's IOU is held, so the creditor isn't paid twice/, id);
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
  for (const s of ['A guarantee is a promise, not locked collateral: it is worth what the backer can and will pay. A paid call is the backer\'s own IOU to the creditor.',
    'Since Nov 16, 2026, once a backer pays, the same amount of the issuer\'s IOU is held, so the creditor isn\'t paid twice: it can\'t spend, set off or redeem that part.',
    'The backer doesn\'t take over the claim; that would be subrogation, which isn\'t built.',
    'A backer\'s honor waits (pair_busy) while the creditor has a redemption build of the same IOU that could still be spent, a dry run included, until the next tracker box. On a day the cap is used up that can be hours, and the wait still counts against the backer as overdue.',
    'A budget card is the server\'s statement of the limits it enforces. The owner doesn\'t sign it, and nothing ties it to an anchor on Ergo testnet.',
    'a creditor with a hand-built client and an earlier redemption build can redeem outside the server\'s checks. The documented 0.7.1 commands can\'t.',
    'Nothing is locked up: a call is paid with your agent\'s own IOU']) assert.ok(backing.includes(s), s);
  // The evidence for each way to connect, word for word (the site's copy rules), and the label each host carries.
  const rows = [...part('compat').matchAll(/<tr><th scope="row">([\s\S]*?)<\/th><td>([\s\S]*?)<\/td><\/tr>/g)].map(m => [words(m[1]).trim(), words(m[2]).trim()]);
  assert.deepEqual(rows, [
    ['valun CLI 0.7.1', "Scripted: our QA bot daily (Nov 16-17, builds 103b25f and 09875a4), and a Claude session acting as a newcomer on a clean profile (Nov 16, build d11e6b4); and an AI agent of the team's (muse) used it end to end on Nov 16-17: the tour, real jobs (a code review it acted on) and a redemption, after the join and connection failures in Known issues"],
    ['valun mcp (MCP server)', 'Scripted MCP clients against the live testnet (Nov 16), and the Claude Code run below'],
    ['Claude Code, with claude mcp add', "One complete exchange in Claude Code 2.1.326 on Nov 17 (build 09875a4): the join in a terminal (CLI), claude mcp add, then a summary hired from house-scribe and paid with the agent's IOU. Run headless (claude -p) with console approvals; the owner's side was scripted (approvals through the owner console's API, and Claude Code's permission prompts answered by a script). Claude Code's own approval prompts are not yet verified"],
    ['Hermes plugin', 'End to end in a real Hermes (v0.23.1) with plugin 0.6.0, Nov 13 (our QA bot). 0.7.1 is not yet verified in a real Hermes'],
    ['Claude Code plugin', 'Install check only (Claude Code 2.1.322, Nov 11, plugin 0.4.1). Not run end to end'],
    ['Codex, Cursor, Claude Desktop, VS Code, OpenClaw', 'Setup command documented; never verified'],
    ['The one-line prompt (skill.md), any agent', "Never verified end to end; the commands it runs are the CLI's, scripted"],
    ['Python / JS libraries', "Scripted use plus CI. The JS library was also used end to end by an AI agent of the team's (muse, Nov 16-17), on the same profile file as the Python client. No third-party app"]]);
  assert.match(text('compat'), /Valun should work with any MCP app\. Of MCP apps, only Claude Code has run it end to end \(headless, with console approvals, Nov 17\), and Hermes has run it end to end with its own plugin \(plugin 0\.6\.0, Nov 13\)\. The rest of the evidence is scripted clients\./);
  // A scripted run is dated, with the builds it ran on, as a closed range: never "since" a build, which reads as the build
  // live now (the lead's live check of 1b1f18f; the QA bot's daily sweeps of Nov 16 and 17 ran on 103b25f and 09875a4).
  assert.doesNotMatch(all, /since Nov 16, 20:00 UTC|build 09875a4 since/);
  // The label each way to connect carries where you choose it (the lead's decision D6 for the MCP apps).
  assert.deepEqual([...part('agent').matchAll(/<span class="ev">([^<]+)<\/span>/g)].map(m => m[1].replace(/\s+/g, ' ')),
    ['Not yet verified end to end', 'Run end to end once in Claude Code (headless, console approvals)', 'Run end to end with plugin 0.6.0; 0.7.1 not yet verified']);
  assert.match(text('agent'), /Your app's own approval form \(ask, the default\) hasn't been verified in any app yet; the Claude Code run used console\. If you don't know whether your app shows MCP approval prompts \(elicitation\), add --approvals console to the join: each commitment then waits for you at \/pilot#owner\./);
  assert.ok(text('agent').includes('Took the tour already? Your agent can use that identity: skip the join and only add the server. For a separate agent, join with --profile NAME and a handle of its own (so the token file has a new name too), and put --profile NAME before mcp too.'));
  assert.match(text('agent'), /ask Claude to join Valun; after the join, run \/mcp, select plugin:valun:valun and choose Reconnect\./);
  assert.match(text('agent'), /The install takes the plugin's default branch on GitHub \(version 0\.7\.1 on Nov 17\), so it can change\./);
  // The one-line route: what pasting it does, read first (the lead's decision D9), and a shell agent's two modes (D10).
  const paste = text('before-paste');
  for (const s of ['Before you paste it', 'Read /skill.md first. It is served live, so it can change.',
    'Your agent will ask you for a handle and your name (both public and permanent), one line about what it offers, and whether you approve each commitment or let it act alone.',
    'It runs valun 0.7.1 from PyPI with uvx, and may offer to install uv.',
    'It makes its key, stored unencrypted in your Valun profile folder, and writes your owner token to ~/valun-owner-token-YOUR-HANDLE.txt, named for its handle. Move that file into your password manager. If your agent says join printed the token instead, replace it in the owner console (New owner token).',
    'In an MCP app it adds the valun server to the app\'s config and asks you to restart.',
    'It may set itself a schedule to check its inbox (skill.md section 4). Say no if you don\'t want that.']) assert.ok(paste.includes(s), s);
  assert.match(part('before-paste'), /<a href="\/skill\.md">\/skill\.md<\/a>/);
  assert.ok(html.indexOf('id="before-paste"') < html.indexOf('id="cmd-skill"'), 'read before the line to paste');
  assert.match(text('agent'), /A shell agent can't show you a prompt: it joins with console \(you approve each commitment in the owner console\) or none \(it acts alone within the limits\), and it asks you which\./);
  // The next client release is named only as unreleased.
  assert.doesNotMatch(all, /0\.7\.2/);
  for (const m of all.matchAll(/[^.]*next client release[^.]*/gi)) assert.match(m[0], /the next client release \(unreleased\)/i, m[0]);
});

test('the known issues of the client release, in one place: each with what to do', () => {
  const titles = [...part('known-issues').matchAll(/<summary>(?:<span>)?([\s\S]*?)(?:<\/span>)?<\/summary>/g)].map(m => words(m[1]).trim());
  assert.deepEqual(titles, ['A lost connection during join can leave your agent without its key', 'Connection errors in Python but not in curl or Node',
    'audit --mine can\'t check an edge a netting lowered', 'Hints say valun, not the uvx command', '"Cannot ask" names an incomplete command',
    'A dismissed prompt reads as a refusal', 'Prompts call a committed netting final', 'The tour\'s step 3, offered again', 'audit --mine flags the note sandbox earn took',
    'Amounts in PC before you join', 'A dry run prints a link to nothing', 'Guarantee texts predate the hold', 'valun audit makes an empty folder',
    'The MCP server calls its counterparties independent', 'The package pages describe the retired pilot', 'The Claude Code marketplace names an old client']);
  const known = text('known-issues'), all = words(body(html));
  assert.match(known, /Next: valun --profile default doctor\. With uvx, type uvx --from valun==\S+ valun where a hint says valun/);
  assert.match(known, /Before a join, an MCP app's hint to run valun join in a terminal also leaves out --sandbox: use the join command on this page\./);
  assert.match(known, /names valun config approvals console without --owner-token-file, and that command refuses to run without it/);
  // 0.7.1's "cannot ask" message also offers client-prompt (the lead's decision D16), with skill.md's caveat on Claude
  // Code (never stated as tested with Valun).
  assert.ok(known.includes('The same message also offers client-prompt. Choose that only if your app confirms each tool call itself (Claude Code asks for each Valun tool call unless the tool has been allowed; with Valun that is not yet tested); otherwise nobody is asked. Use console or none instead.'));
  assert.doesNotMatch(all, /\(Claude Code does\)/);
  // An answer read to its last byte counts as complete: the server sends each answer's length (lib/http.mjs), in the
  // release this page ships with, so the sentence carries no date. It arrives only when the client doesn't ask for
  // compression: valun.tech's edge compresses for a client that does (Node's fetch, which the JS client uses, asks for br)
  // and sends that answer chunked, without Content-Length (the lead's live check of 1b1f18f); Python's urllib asks for none.
  assert.ok(known.includes("The server also sends each answer's length when the client doesn't ask for compression (the Python client doesn't), so an answer read to its last byte counts as complete. Answers to a client that asks for compression, such as Node's fetch, come compressed and in chunks instead."));
  assert.match(src('lib/http.mjs'), /'Content-Length': Buffer\.byteLength\(payload\)/);
  assert.doesNotMatch(all, /Since Nov 17 the server|sends each answer's length, so/);
  // A join retried after a cut names a new token file through its new handle (the lead's decision D12b).
  assert.ok(known.includes('join again with another handle (the commands here then name a new token file; the first join may have written one, and that token opens the first agent)'));
  assert.match(known, /An approval prompt that was dismissed, or never shown, is reported as "your owner did not approve" \(owner_answer cancel\)\. Nothing was signed\. If no one is at the app, use console\./);
  assert.match(known, /valun 0\.7\.1's prompts still call a committed netting final\. Read that as committed: it stays committed only as long as the tracker key never commits an earlier total again/);
  assert.match(known, /They also call an IOU a credit note\./);
  assert.match(known, /valun 0\.7\.1's MCP server tells every agent that Valun is for deals "with other, independently controlled agents"\. So far almost all of them are the team's test agents or the operator's/);
  assert.match(known, /While you install the Claude Code plugin, its marketplace entry says it runs valun 0\.4\.5\. The plugin runs valun 0\.7\.1\./);
  assert.match(known, /a redemption against an issuer with no reserve is answered "busy, try again in 60 s" every time\. That answer is a known bug on the server, and no retry helps/);
  // The caveats live in the box, not across the paths: the paths link to it.
  for (const id of ['agent', 'tour', 'ergo', 'build']) assert.doesNotMatch(text(id), /0\.7\.1's message names|still call a committed netting final|offer the tour's step 3 again/, id);
  for (const id of ['ergo', 'build']) assert.match(part(id), /href="#known-issues"/, id);
});

test('every anchor that tests, docs and released clients link to is still on the page, and every link inside the page has its target', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  for (const id of ['main', 'look', 'tour', 'agent', 'ergo', 'build', 'report', 'credentials', 'install', 'no-prompt', 'public', 'limits', 'pilot', 'help',
    'compat', 'known-issues', 'backing', 'reference', 'anchoring-now']) assert.ok(ids.has(id), `#${id}`);
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
  assert.equal(said()[1], 'Anchored: the latest tracker box commits every IOU recorded so far, so an audit run now can say MATCH.');
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
  assert.match(line('daily_cap_reached').lines[0], /^Today's 50 tracker boxes are used up, so nothing more is committed on chain until 00:00 UTC\. Until then an audit says UNKNOWN, and IOUs recorded since the last box cannot be redeemed\.$/);
  // The wait in the same words as the page's prose (the lead's decision D7b), undated in a live line; never "a few
  // minutes" or "about two minutes" for the full wait.
  assert.equal(line('waiting_for_next_update').lines[0], 'Waiting for the next tracker box: the newest IOUs are not committed yet, so an audit says UNKNOWN until that box is confirmed. A new IOU is usually committed 5 to 15 minutes after it is recorded, up to about 30 when Ergo testnet blocks are slow.');
  assert.equal(line('update_in_flight').lines[0], 'A new tracker box is on its way: once a block includes it, usually within minutes, up to about 30 when Ergo testnet blocks are slow, the IOUs recorded before it are committed.');
  for (const s of ['anchored', 'waiting_for_next_update', 'update_in_flight', 'daily_cap_reached', 'overdue']) assert.doesNotMatch(line(s).lines.join(' '), /a few minutes|about two minutes|normally/, s);
  assert.match(line('overdue').lines[0], /a fault of the tracker, not of any IOU/);
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
  for (const f of ['public/start.html', 'public/home.html', 'public/network.html', 'public/network.js', 'lib/a2a.mjs', 'lib/pilot/agents.mjs']) {
    const t = src(f);
    for (const v of pins(t)) assert.equal(v, release, f);
    assert.doesNotMatch(t, /uvx valun |uvx --from valun valun|pipx install valun(?!==)(?! inside)|uv tool install valun(?!==)|npm install @fitzdoud\/valun(?!@)/, `${f}: no unpinned client`);
  }
  for (const f of ['public/start.html', 'public/home.html', 'public/network.html', 'lib/a2a.mjs']) assert.ok(pins(src(f)).length, `${f} pins the client`);
  assert.ok(html.includes(`valun ${release} is the current client release`), 'the known issues name the release they are about');
  assert.match(html, new RegExp(`<h2 id="known-issues-h">Known issues in valun ${release.replaceAll('.', '\\.')}</h2>`));
  const tracker = t => /tracker v(\d+\.\d+\.\d+)\)/.exec(t)?.[1];
  assert.equal(tracker(html), tracker(skill));
});
