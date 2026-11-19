// The server's own pages as a local server serves them (VALUN_ENVIRONMENT=local, the local image; fix inbox #155: the
// local-readiness audit of Nov 18, FB-2, the page half of FB-7, SRV-15, COV-3). A local server served the public
// network's pages byte for byte under its banner, so everything a person or an agent could copy or follow on them sent
// them to the public testnet, the client's default server (valun 0.7.1 home.py DEFAULT_SERVER): the landing's and
// /start's agent prompt read https://valun.tech/skill.md, every join and owner command named no profile and no server
// (a join without --server, in a profile that has joined nowhere yet, joins the public network; a command without
// --profile acts on the default profile, which may hold an identity there, and `valun config approvals ... --owner-token-
// file` sent a LOCAL owner token to it: SRV-6), the story's links and the maintainers page's named valun.tech, /trust's
// check ran the public network's chain and explorer, and the pages' canonical and og tags named valun.tech.
//
// On a local server (lib/http.mjs ownPage, before send's banner), each of the server's own pages gets the edits below:
//   - every command it shows runs in the client profile local and names this server (--server <origin>) wherever the
//     command takes it, in the form the page had (`valun ...` or `uvx --from valun==X valun ...`), as this server's
//     skill.md writes them (public/skill-local.md); its agent prompts read this server's skill.md; owner commands
//     name the local token file;
//   - its canonical, og:url and og:image name this server;
//   - links to the public network's pages and the Ergo explorer become text, said to be the public network's;
//   - what needs the chain (the audit, the explorer, reserves, redemption, tracker boxes) or the public network's house
//     agents is marked as not on this server (class valun-local-note, styled by public/local.css), with this server's
//     own facts beside it (its limits in PC, whoever runs it).
// The rest of each page is the public network's, as the banner says. /start is this server's own page instead
// (public/start-local.html, rendered by scripts/build-local-docs.mjs; it names the origin as {origin}). The owner
// console's script (public/pilot.js) gets the same treatment for the commands it shows. An agent page and a loop card
// show what participants wrote, and get no edit (the review of PR #9, code 1): their own links name this server
// already (lib/pilot/loops.mjs PUBLIC_ORIGIN, startHref).
//
// Each edit names the text it changes and how many times it is there; a page that no longer has it exactly that often
// throws (test/local-pages.unit.test.mjs runs every edit on today's files), so a changed page can't quietly lose its
// local form. Elsewhere (the testnet, staging, the pilot) nothing here runs: the pages go as they are. Pure.
import {CLIENT, LOCAL_CLIENT} from './a2a.mjs';
import {SANDBOX_CAPS, SANDBOX_DAYS, OPEN_NETWORK_MAX_OPEN_OFFERS} from './pilot/core.mjs';
import {amt} from './pilot/units.mjs';

// The owner token file a local join writes, as this server's skill.md names it (one file per server and handle: valun
// 0.7.1 never replaces a file).
export const LOCAL_TOKEN_FILE = '$HOME/valun-local-owner-token-YOUR-HANDLE.txt';
// The public network's origin, as its pages write it.
const NET = 'https://valun.tech';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// In a JavaScript string of pilot.js: a template literal's text, and a single-quoted string's.
const jsTemplate = s => String(s).replace(/[\\`]/g, '\\$&').replace(/\$\{/g, '\\${');
const jsQuoted = s => String(s).replace(/[\\']/g, '\\$&');

// The edits. Each is one of:
//   {from, to, count = 1}  the text `from`, there `count` times, becomes `to` each time;
//   {re, to, count}        each match of `re` (global) becomes to(match, ...groups);
//   {from, until, to}      the text from `from` (there once) up to the first `until` after it becomes `to` (`until` stays);
//   {all, to}              `all` becomes `to` wherever it is, at least once.
// Line breaks are written as \n and stand for the page's own (its files may have \r\n, as a Windows checkout does).
const note = text => `<p class="valun-local-note">${text}</p>`;
// A page's canonical, og:url and og:image, at `route` of the public network, name this server.
const selfLinks = (origin, route) => [
  {from: `<link rel="canonical" href="${NET}${route}">`, to: `<link rel="canonical" href="${esc(origin)}${route}">`},
  {from: `<meta property="og:url" content="${NET}${route}">`, to: `<meta property="og:url" content="${esc(origin)}${route}">`},
  {from: `<meta property="og:image" content="${NET}/og.png">`, to: `<meta property="og:image" content="${esc(origin)}/og.png">`}];
const FOOTER = {from: '<p>Ergo testnet · test coins only, with no monetary value</p>', to: '<p>Local: no chain · PC have no monetary value</p>'};
// What a new self-serve agent accepts by default on this server (core.mjs SANDBOX_CIRCULATION; skill-local.md section 0).
const PER_ISSUER = amt(SANDBOX_CAPS.max_accept_per_issuer);

export const LOCAL_EDITS = Object.freeze({
  // The landing (/ and /home).
  'home.html': origin => {
    const o = esc(origin), host = esc(origin.replace(/^https?:\/\//, ''));
    return [
      ...selfLinks(origin, '/'),
      {from: '<p class="first-try"><span class="k">First thing to try:</span> hire sandbox-exact, a practice agent with no AI, for a text-stats job (0.003 tERG), paid with your agent\'s note.</p>',
        to: '<p class="first-try"><span class="k">First thing to try here:</span> the tour, with the two practice agents that run inside this server (no AI model): earn an IOU, pass it on, and see two loops clear. The public network\'s house agents don\'t run here.</p>'},
      {from: '<p class="sky-labels">Labels: <b>operator-run</b> is run by the operator of valun.tech; <b>team test</b> is an agent whose operator field names our team (Fitz, Valun, our QA bot Basis, or a Claude test session), as it declares. Basis is our QA bot, not the Basis protocol team. Most unlabelled agents are ours too, under other names.</p>',
        to: '<p class="sky-labels">Labels: <b>operator-run</b> is run by whoever runs this server (here, the two practice agents); <b>team test</b> is an agent whose operator field names the Valun team (Fitz, Valun, Basis or a Claude session), as it declares.</p>'},
      {from: '<li class="story-unit">1 = 0.001 tERG, test coins with no monetary value</li>', to: '<li class="story-unit">1 = 1 PC on this server: synthetic credits with no monetary value</li>'},
      {from: 'On the testnet a new self-serve agent accepts any issuer\'s notes as payment by transfer, up to 0.04 tERG per issuer.',
        to: `On this server a new self-serve agent accepts any issuer's IOUs as payment by transfer, up to ${PER_ISSUER} per issuer.`, count: 2},
      {from: '<p class="story-commit">The clearing is committed when the next tracker box on Ergo testnet commits it:', until: '</p>',
        to: '<p class="story-commit">On this local server a clearing is recorded by its tracker and nowhere else: no chain commits it. <a href="/trust#netting">How a netting is committed on the public network</a>'},
      {from: '<h3>Can Cy turn Ana\'s note into tERG?</h3>', until: ' <a href="/trust#redemption">How redemption works</a>',
        to: '<h3>Can Cy redeem Ana\'s IOU?</h3>\n<p>Not on this local server: it has no chain, so there are no reserves and nothing is redeemed. On the public network, only if Ana posted a reserve, and only up to what it holds.'},
      {from: '<p class="story-label"><span class="tag">Real run on the testnet, Nov 16, 2026</span></p>',
        to: '<p class="story-label"><span class="tag">Real run on the public network, Nov 16, 2026: not on this server</span></p>'},
      // That run's loops, transaction and agent page are the public network's: named, not linked.
      {re: /<a href="https:\/\/(?:valun\.tech|testnet\.ergoplatform\.com)\/[^"]*">([^<]*)<\/a>/g, to: (all, text) => text, count: 4},
      {from: '<h3>Hire house-scribe for a summary, a rewrite or a translation</h3>',
        to: `<h3>Hire house-scribe for a summary, a rewrite or a translation</h3>\n        ${note('On the public network only: its house agents don\'t run on this local server. Here, hire a practice agent, sandbox-exact or sandbox-mallory, for text-stats or notary.')}`},
      {from: '<h3>Check the operator\'s ledger against the chain</h3>',
        to: `<h3>Check the operator's ledger against the chain</h3>\n        ${note('Not on this local server: it has no chain, so there is no tracker box to check the ledger against.')}`},
      {from: '<code>valun mcp</code> or the Hermes plugin does this, and a shell agent keeps <code>valun clearing watch</code> running',
        to: `<code>valun --profile local mcp</code> or the Hermes plugin does this, and a shell agent keeps <code>valun --profile local clearing watch --server ${o}</code> running`},
      {from: 'then add the local server, <code>valun mcp</code>, to your app.', to: 'then add the local server, <code>valun --profile local mcp</code>, to your app.'},
      {from: '<a href="/pilot#owner">valun.tech/pilot#owner</a>', to: `<a href="/pilot#owner">${host}/pilot#owner</a>`},
      {from: `<code id="cmd-agent">Read ${NET}/skill.md and follow it to join Valun.</code>`, to: `<code id="cmd-agent">Read ${o}/skill.md and follow it to join Valun.</code>`},
      {from: 'writes your owner token to a new file named for its handle, <code>~/<wbr><span class="nw">valun-owner-token-</span>',
        to: 'writes your owner token to a new file named for this server and its handle, <code>~/<wbr><span class="nw">valun-local-owner-token-</span>'},
      // This server's skill.md doesn't save itself as an OpenClaw skill, as the public network's says to.
      {from: '\n        <li>In OpenClaw it also saves skill.md as a skill, <code>~/<wbr>.openclaw/<wbr>skills/<wbr>valun/<wbr>SKILL.md</code> (a copy that won\'t follow later changes to skill.md), and restarts the gateway.</li>', to: ''},
      {from: '<div><dt>Your limits</dt><dd>The server enforces them in every mode: at most 0.005 tERG per deal and 0.04 tERG owed in all, 10 open offers, for 7 days, renewed while your agent is active.</dd></div>',
        to: `<div><dt>Your limits</dt><dd>The server enforces them in every mode: at most ${amt(SANDBOX_CAPS.max_issue_per_deal)} per deal and ${amt(SANDBOX_CAPS.max_issue_outstanding)} owed in all, ${OPEN_NETWORK_MAX_OPEN_OFFERS} open offers, for ${SANDBOX_DAYS} days, renewed while your agent is active.</dd></div>`},
      {from: 'and the MCP server <code>valun mcp</code> (<code>io.github.fitzss/valun</code> in the MCP Registry).',
        to: 'and the MCP server your agent runs on its own machine, <code>valun --profile local mcp</code>.'},
      {from: '<p class="who">Fitz Doud, who runs valun.tech.</p>',
        to: `<p class="who">On this local server, whoever runs it: on your own machine, you. On the public network, Fitz Doud.</p>\n        ${note('Here: the server, its tracker and the tracker\'s key, and the two practice agents. No house agents, and no chain: no tracker box and no redemption.')}`},
      {from: '<h3>Ergo testnet</h3>', to: `<h3>Ergo testnet</h3>\n        ${note('Not on this local server: it has no chain.')}`},
      {from: '<li>Can run <code>valun audit</code> to check the tracker box against them.</li>',
        to: '<li>Can run <code>valun audit</code> to check the tracker box against them, on the public network: this server has no chain.</li>'},
      {from: '<li><b>The audit.</b> ', to: '<li><b>The audit, on the public network only (this server has no chain).</b> '},
      {from: '<li><b>The reserves.</b> ', to: '<li><b>The reserves, on the public network only.</b> '},
      FOOTER];
  },
  // The live network (/network).
  'network.html': origin => [
    ...selfLinks(origin, '/network'),
    // Its join is this server's skill.md's (public/skill-local.md), each word in a span as before (its Copy copies the text),
    // with the client release that skill.md pins (lib/a2a.mjs LOCAL_CLIENT, which may be older than the testnet's).
    {from: `<span>--from ${CLIENT}</span> <span>valun join</span>`, to: `<span>--from ${LOCAL_CLIENT}</span> <span>valun join</span>`},
    {from: '<span>valun join</span> <span>--sandbox</span> <span>--handle YOUR-HANDLE</span> <span>--operator "YOUR NAME"</span> <span>--owner-token-file</span> <span class="path"><span>"$HOME/</span><span>valun-owner-token-YOUR-HANDLE.txt"</span></span></code>',
      to: `<span>valun --profile local join</span> <span>--sandbox</span> <span>--server ${esc(origin)}</span> <span>--handle YOUR-HANDLE</span> <span>--operator "YOUR NAME"</span> <span>--about "what it offers, in one line"</span> <span>--owner-token-file</span> <span class="path"><span>"$HOME/</span><span>valun-local-owner-token-YOUR-HANDLE.txt"</span></span> <span>--approvals console</span></code>`},
    {from: '<p class="small">Test traffic, almost all of it our own agents\'. The records check compares the server\'s records with its own tracker; to check the tracker box on Ergo testnet yourself, run <code>valun audit</code> (<a href="/trust#check">how</a>).</p>',
      to: '<p class="small">The records check compares the server\'s records with its own tracker. This local server has no chain, so there is no tracker box to audit.</p>'},
    {from: '<p class="small">tERG are test coins on Ergo testnet with no monetary value. A note can be redeemed for tERG only against a reserve locked under the key that signed it, if one was posted.</p>',
      to: '<p class="small">PC are synthetic credits with no monetary value. This local server has no chain: there are no reserves, and nothing is redeemed.</p>'},
    FOOTER],
  // The owner console (/pilot): its guide, its sign-in and its join tab.
  'pilot.html': origin => {
    const o = esc(origin);
    return [
      {from: '<span class="nw">valun-owner-token-</span>', to: '<span class="nw">valun-local-owner-token-</span>', count: 2},
      {from: '<code>valun attempts resolve DEAL \'#n\' <span class="nw">--not-applied</span></code>',
        to: `<code>valun --profile local attempts resolve DEAL '#n' <span class="nw">--not-applied</span> <span class="nw">--server ${o}</span></code>`},
      {from: '<dt>Valun’s operator (Fitz Doud, who runs valun.tech)</dt>', to: '<dt>Whoever runs this server (on your own machine, you)</dt>'},
      {from: 'may then need <code>valun attempts resolve</code>.', to: `may then need <code>valun --profile local attempts resolve DEAL '#n' --not-applied --server ${o}</code>.`},
      // The owner's own command: in the profile local, naming this server, so the token goes to it and nowhere else.
      {from: '<code>valun config approvals ask</code> or <code>none</code>, adding <code><span class="nw">--owner-token-file</span></code>\n              and the file join wrote)',
        to: `<code>valun --profile local config approvals ask --server ${o} --owner-token-file "${LOCAL_TOKEN_FILE}"</code>,\n              or the same with <code>none</code>; the file is the one join wrote)`},
      {from: '<p class="guide-after">On the testnet a new self-serve agent', to: '<p class="guide-after">On this server a new self-serve agent'},
      {from: 'transfer, up to 0.04 tERG per issuer.', to: `transfer, up to ${PER_ISSUER} per issuer.`},
      {from: '<code>valun join <span class="nw">--sandbox</span></code> (<a href="/start#agent">see Start</a>). This form is for an invite code from',
        to: `<code>valun --profile local join <span class="nw">--sandbox</span> <span class="nw">--server ${o}</span></code> (<a href="/start#agent">see Start</a>). This form is for an invite code from`},
      {from: 'Valun’s operator: it creates your participant here', to: 'whoever runs this server (<code>docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 1 --code-only</code>): it creates your participant here'},
      {from: '(<code>valun join <span class="nw">--sandbox</span></code>) starts with the self-serve limits',
        to: `(<code>valun --profile local join <span class="nw">--sandbox</span> <span class="nw">--server ${o}</span></code>) starts with the self-serve limits`},
      // valun 0.7.2 has `valun console` (cli.py cmd_console: the console's address and the token file's path, never the
      // token), and shows the token only on stderr at a terminal, when no file can be written (_hand_over).
      {from: 'The next client\n          release (unreleased) is planned to add <code>valun console</code>, which prints where that file is if the\n          profile recorded it (a join with valun 0.7.1 doesn’t). If join showed the token in the terminal instead, that\n          was its only copy.',
        to: `<code>valun --profile local console <span class="nw">--server ${o}</span></code>\n          prints where that file is (never the token). If join showed the token in the terminal instead (valun 0.7.2 does\n          only when no file could be written), that was its only copy.`},
      {from: '<span id="net-footer-facts">Ergo testnet · test coins only, with no monetary value</span>', to: '<span id="net-footer-facts">Local: no chain · PC have no monetary value</span>'}];
  },
  // The trust model (/trust): the public network's, built from its skill.md (scripts/build-trust.mjs), with what this
  // server's own trust model is first, and each part that needs the chain marked.
  'trust.html': origin => {
    const o = esc(origin);
    const head = (id, title) => `<div class="part-head"><h2 id="${id}">${title}</h2><a class="anchor" href="#${id}" aria-label="Link to this part: ${title}">#${id}</a></div>`;
    const marked = (id, title, text) => ({from: head(id, title), to: `${head(id, title)}\n${note(text)}`});
    return [
      ...selfLinks(origin, '/trust'),
      {from: '<p class="source">The same text as the Trust model in <a href="/skill.md">skill.md</a>, the file agents read: this page is built from it, so the two cannot differ.</p>',
        to: '<p class="source">This page is the public network\'s trust model, built from its skill.md. This server\'s own skill.md, <a href="/skill.md">/skill.md</a>, has a local server\'s.</p>\n'
          + `    ${note('On this local server: whoever runs it runs everything on it (the server, which sees every deal; the tracker and its key; the two practice agents). Your agent\'s key is made on your machine, and only its public key reaches the server. Nothing is anchored: no chain commits what the tracker records, so there is nothing to audit and nothing to redeem.')}`},
      {from: '<h2 class="path-h" id="path-h">The life of a note, in short</h2>',
        to: `<h2 class="path-h" id="path-h">The life of an IOU, in short</h2>\n    ${note('On this local server it stops at the second step: its tracker records the IOU, and no chain commits it.')}`},
      // The chain's live read: none here (trust.js reads it only where the page has #now).
      {from: '<aside class="now" id="now" aria-labelledby="now-h">', until: '</aside>',
        to: '<aside class="now" aria-labelledby="now-h">\n    <h2 class="now-h" id="now-h">No chain on this local server</h2>\n'
          + '    <p class="now-what">This server\'s tracker has no blockchain connection: <a href="/pilot/v1/chain">GET /pilot/v1/chain</a> and <a href="/pilot/v1/reserves">GET /pilot/v1/reserves</a> answer <code>404 no_chain</code>, so there is no tracker box to read or audit, and no reserve.</p>\n  '},
      {from: '<p><strong>That the tracker box commits the notes the server publishes.</strong>', until: '<p><strong>An agent\'s record and budget card</strong>',
        to: `${note('On this local server there is no chain, so none of the public network\'s checks apply: no tracker box to audit, no reserve contract to compare, no chain view.')}\n`
          + '<p><strong>What this server records.</strong> <a href="/pilot/v1/ledger"><code>GET /pilot/v1/ledger</code></a> lists every open IOU and compares the server\'s records with its own tracker; <a href="/pilot/v1/loops"><code>GET /pilot/v1/loops</code></a> lists the set-offs. Both are this server\'s word.</p>\n'},
      {from: 'its page, <code>https://valun.tech/agent/HANDLE</code>, and <code>valun card check HANDLE AMOUNT</code>.',
        to: `its page, <code>${o}/agent/HANDLE</code>, and <code>valun --profile local card check HANDLE AMOUNT --server ${o}</code>.`},
      {from: '<p><strong>The operator.</strong> Fitz Doud runs valun.tech, and with it:</p>', to: '<p><strong>The operator.</strong> Fitz Doud runs the public network, and with it:</p>'},
      marked('chain', 'The chain', 'Not on this local server: it has no chain. This part is the public network\'s.'),
      marked('netting', 'Netting', 'On this local server a set-off is recorded by its tracker and nowhere else: no chain commits it, and there is nothing to audit. The rest of this part is the public network\'s.'),
      {from: '<code>valun audit <span class="nw">--mine</span></code>', to: 'valun audit --mine', count: 2},
      marked('backing', 'Reserves and guarantees', 'Guarantees work on this server as described here, in PC. Nothing here is redeemed, so the redemption gap below is the public network\'s.'),
      {from: 'The commands are in section 6 of <a href="/skill.md">skill.md</a>.', to: 'On this server, your agent offers a guarantee with <code>valun_offer_guarantee</code> (<a href="/start#backing">Start</a>).'},
      marked('redemption', 'Redemption', 'Not on this local server: nothing is redeemed (no chain, no reserves). This part is the public network\'s.'),
      {from: '<code>valun ergo redeem</code>', to: 'valun ergo redeem'},
      {from: 'Section 7 of <a href="/skill.md">skill.md</a> has the commands, and what your client checks before your key signs.',
        to: 'The public network\'s skill.md has the commands, and what the client checks before a key signs.'},
      FOOTER];
  },
  // The record's evidence (/memory).
  'memory.html': origin => [...selfLinks(origin, '/memory'), FOOTER],
  // /start: this server's own page, which names the origin as {origin} (scripts/build-local-docs.mjs).
  'start-local.html': origin => [{all: '{origin}', to: esc(origin)}],
  // The maintainers page (/maintainers, lib/pilot/agents.mjs renderMaintainersPage), as rendered.
  maintainers: origin => {
    const o = esc(origin);
    return [
      // The commands name the client release this server's skill.md pins (LOCAL_CLIENT), not the testnet's.
      {from: `<code>claude mcp add valun -- uvx --from ${CLIENT} valun mcp</code>`, to: `<code>claude mcp add valun-local -- uvx --from ${LOCAL_CLIENT} valun --profile local mcp</code>`},
      {from: ' There is also a plugin (<code>/plugin marketplace add fitzss/valun-open</code>, then <code>/plugin install valun@valun</code>): an install check only, not yet run end to end.',
        to: ' Valun\'s Claude Code plugin is not for this server: its MCP server runs your default profile.'},
      {from: 'Hermes: <code>hermes profile create valun --no-alias</code>, <code>hermes -p valun plugins install ',
        to: 'Hermes, in a Hermes profile of its own (not yet run against a local server): <code>hermes profile create valun-local --no-alias</code>, <code>hermes -p valun-local plugins install '},
      {from: '<code>hermes -p valun valun join --sandbox --direct-tools --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"</code>',
        to: `<code>hermes -p valun-local valun join --sandbox --direct-tools --server ${o} --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file "${LOCAL_TOKEN_FILE}"</code>`},
      {re: new RegExp(`<code>(uvx --from ${CLIENT.replaceAll('.', '\\.')} valun) (profile --(?:services|wants) "[^"<]*")</code>`, 'g'),
        to: (all, run, args) => `<code>uvx --from ${LOCAL_CLIENT} valun --profile local ${args} --server ${o}</code>`, count: 2},
      {from: 'Not sure where to start? ', until: ' To earn notes back,',
        to: 'Not sure where to start? The public network\'s house agents don\'t run on a local server: here, the two practice agents, sandbox-exact and sandbox-mallory, sell text-stats and notary (no AI model).'},
      {re: /<code>(uvx --from &quot;valun\[ai\]==[\d.]+&quot; valun) (sell --services code-review)<\/code>/g,
        to: (all, run, args) => `<code>uvx --from &quot;${LOCAL_CLIENT.replace(/^valun/, 'valun[ai]')}&quot; valun --profile local ${args} --server ${o}</code>`, count: 1},
      // Amounts in this server's unit (the page says credits, the retired pilot's word, off the testnet).
      {re: / · about (\d+) credits<br>/g, to: (all, n) => ` · about ${n} PC<br>`, count: 4}];
  },
  // The owner console's script (/pilot.js): the commands it shows an owner.
  'pilot.js': origin => [
    {from: 'el(\'code\', {}, `valun attempts resolve ${dealId} \'#n\' --not-applied`)',
      to: `el('code', {}, \`valun --profile local attempts resolve \${dealId} '#n' --not-applied --server ${jsTemplate(origin)}\`)`},
    {from: 'el(\'code\', {}, \'valun attempts list\')', to: `el('code', {}, 'valun --profile local attempts list --server ${jsQuoted(origin)}')`, count: 2},
    {from: '[el(\'code\', {}, `valun card ${word}`), \' with \', el(\'code\', {}, \'--owner-token-file\'), \' and the file that holds your owner token (the one join wrote).\']',
      to: `[el('code', {}, \`valun --profile local card \${word} --server ${jsTemplate(origin)} --owner-token-file "${jsTemplate(LOCAL_TOKEN_FILE)}"\`), ' (that file holds your owner token: the one join wrote).']`}],
});

// The edits of `name` applied to `text`; throws when one does not find its text as often as it says.
export function applyEdits(name, text, edits) {
  let t = String(text);
  const eol = t.includes('\r\n') ? '\r\n' : '\n', nl = s => String(s).replace(/\r?\n/g, eol);
  const fail = what => { throw new Error(`lib/local-pages.mjs: ${name}: ${what}`); };
  for (const e of edits) {
    if (e.re) {
      const n = [...t.matchAll(e.re)].length;
      if (n !== e.count) fail(`${n} matches of ${e.re}, not ${e.count}`);
      t = t.replace(e.re, (...m) => nl(e.to(...m)));
    } else if (e.all !== undefined) {
      if (!t.includes(e.all)) fail(`no ${e.all}`);
      t = t.split(e.all).join(e.to);
    } else if (e.until !== undefined) {
      const from = nl(e.from), at = t.indexOf(from);
      if (at < 0 || t.indexOf(from, at + 1) >= 0) fail(`"${e.from.slice(0, 80)}" is not there once`);
      const end = t.indexOf(nl(e.until), at + from.length);
      if (end < 0) fail(`no "${e.until}" after "${e.from.slice(0, 80)}"`);
      t = t.slice(0, at) + nl(e.to) + t.slice(end);
    } else {
      const from = nl(e.from), parts = t.split(from), count = e.count ?? 1;
      if (parts.length - 1 !== count) fail(`"${e.from.slice(0, 80)}" is there ${parts.length - 1} times, not ${count}`);
      t = parts.join(nl(e.to));
    }
  }
  return t;
}

// The names of the files and pages a local server serves its own way.
export const LOCAL_FILES = new Set(Object.keys(LOCAL_EDITS));
// A page (or pilot.js) as a local server serves it: `name` is its file in public/ (or 'maintainers'); `body` its text
// or bytes; `origin` this server's (PUBLIC_ORIGIN). A file with no edits goes as it is, the same bytes.
export const localPage = (name, body, origin) => (LOCAL_FILES.has(name) ? applyEdits(name, body, LOCAL_EDITS[name](origin)) : body);
