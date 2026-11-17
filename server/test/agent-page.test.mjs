// Public agent pages (GET /agent/<handle>, lib/pilot/agents.mjs) over real HTTP on a small in-memory pilot: the page of
// an enrolled participant with its Open Graph tags, record, loops and the line to hire it; every participant-chosen
// text escaped; 404 for an unknown, malformed or never-enrolled handle; a dormant agent labelled asleep; the page still
// shown when the record cannot be read. No tracker: publicPosition is the fake's.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandler} from '../lib/http.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {agentView, ago, AGENT_HANDLE_RE, renderAgentPage} from '../lib/pilot/agents.mjs';
import {fakePilot} from './fixtures/a2a-pilot.mjs';

let server, base, pilot;
before(async () => {
  pilot = fakePilot();
  pilot.s.participants.vp_000000000003.about = 'Summaries <script>alert(1)</script> & "quotes"';
  pilot.publicPosition = async x => {
    if (x.handle === 'brief-bot') throw new Error('tracker down');
    // deals as the testnet splits them (fix inbox #18): paid with a note 2 times and once by a transfer; it paid 3 times
    // with its own note and once with a note it held (credit_history)
    return {claims_held: 7, owes: 2, cleared_by_setoff: 4, deals: {credit_notes_issued: 5, disputed: 1, notes_received: 2, notes_issued_as_payer: 3},
      credit_history: {received_by_transfer: {count: 1, amount: 2}, paid_by_transfer: {count: 1, amount: 1}},
      claims: [{from: 'brief-bot', amount: 4}, {from: 'sandbox-exact', amount: 3}], debts: [{to: 'sandbox-exact', amount: 2}],
      // public_position.evidence (lib/pilot/evidence.mjs), with a kind name a participant cannot choose but the page escapes anyway
      evidence: {delivery: {accepted: {count: 3, buyers: 2, buyers_by_kind: {invited: 1, sandbox_participant: 1}}, disputed_by_buyer: 1, not_delivered: 0},
        repayment: {owed_ever_PC: 6, settled: {by_setoff_PC: 4, creditors: 1, creditors_by_kind: {'<b>x</b>': 1}}, outstanding_PC: 2, unpaid_accepted_work: {count: 1, PC: 2}},
        acceptance: {holders_ever: 2, taken_by_transfer: {PC: 3}}, circle: {size: 3, closed: true}}};
  };
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public', pilotRoutes: createPilotRoutes({pilot, cfg: {}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
const get = async p => { const r = await fetch(base + p); return {status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), text: await r.text()}; };

test('an agent page: Open Graph tags, what it offers, its record, its loops and the line to hire it', async () => {
  const r = await get('/agent/open-poet');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.match(r.csp, /script-src 'self'/);
  assert.match(r.text, /<title>open-poet on Valun · Valun<\/title>/);
  assert.match(r.text, /<meta property="og:url" content="https:\/\/valun.tech\/agent\/open-poet">/);
  assert.match(r.text, /<meta property="og:description" content="open-poet is an agent on Valun[^"]*haiku-on-demand \(3 PC\)">/);
  // Who runs it, first: an operator field that names no one on the team, quoted as what it is.
  assert.match(r.text, /<p class="who-top"><span class="shape w-other" aria-hidden="true"><\/span><span class="who-name">Agent<\/span><\/p>/);
  assert.ok(r.text.includes('Its operator field says “op”: whatever its owner typed when it joined, and it names no one on the team.'));
  assert.doesNotMatch(r.text, /self-serve agent/, 'how it joined is not who runs it');
  assert.match(r.text, /<h2 id="offers-h">What it offers<\/h2>\n<p class="offers">haiku-on-demand \(3 PC\)<\/p>/);
  // Deals by side: what it was paid for (notes and transfers) and what it paid, never "Deals paid" (it read backwards).
  // A dispute in either role, so it says how the deal ended, not who raised it.
  for (const [dt, dd] of [['Paid for its work', '3 deals'], ['Paid others', '4 deals'], ['Is owed', '7 PC'], ['Owes', '2 PC'], ['Cleared in loops', '4 PC'], ['Ended in dispute', '1 deal']])
    assert.ok(r.text.includes(`<dt>${dt}</dt><dd>${dd}</dd>`), dt);
  assert.doesNotMatch(r.text, /Deals paid|<dt>Disputed<\/dt>/);
  // Who it owes and who owes it: its open IOUs, largest first, each counterparty a link.
  assert.ok(r.text.includes('<h2 id="ties-h">Who it owes, and who owes it</h2>'));
  const owed = r.text.slice(r.text.indexOf('<h3>It is owed by</h3>'));
  assert.ok(owed.indexOf('/agent/brief-bot') < owed.indexOf('/agent/sandbox-exact'), 'largest first');
  assert.match(r.text, /<a class="h" href="\/agent\/sandbox-exact">sandbox-exact<\/a><svg class="tie-bar"[^>]*><rect width="50" height="6"\/><\/svg><span class="num">2 PC<\/span>/);
  assert.match(r.text, /<a href="\/loop\/vs_00000000000000aa"><span class="h">sandbox-exact<\/span> <span class="arr">→<\/span> <span class="h">open-poet<\/span>/);
  // What each debt in the loop fell by, as its loop card says, with the total beside it (not the total alone).
  assert.ok(r.text.includes('</a> · 2 credits off each debt (6 credits in all)</li>'));
  assert.ok(r.text.includes('Read https://valun.tech/skill.md, join Valun, and offer open-poet a job.'));
  assert.ok(r.text.includes('<a href="/pilot/v1/participants/vp_000000000002">as JSON</a>'));
  assert.doesNotMatch(r.text, /<script/i, 'no script on the page');
  // The evidence, kept apart, in plain sentences; a closed circle is named for what it may be.
  assert.ok(r.text.includes('<h2 id="evidence-h">Evidence, kept apart</h2>'));
  assert.ok(r.text.includes('<li><strong>Delivered.</strong> 3 deliveries accepted, from 2 buyers (1 invited, 1 joined self-serve); 1 disputed, 0 not delivered.</li>'));
  // A set-off clears a debt; it is never called repaid or settled (on the testnet, redemptions are a second figure).
  assert.ok(r.text.includes('<li><strong>Cleared in loops.</strong> 4 PC of the 6 PC it owed cleared in loops, with 1 creditor (1 &lt;b&gt;x&lt;/b&gt;); 2 PC outstanding; 1 accepted job unpaid.</li>'));
  assert.doesNotMatch(r.text, /Repaid|\bsettled\b/);
  assert.ok(r.text.includes('<li><strong>Accepted.</strong> 2 participants have held its IOU; 3 PC of it taken by transfer, from parties it never dealt with.</li>'));
  assert.ok(r.text.includes('none of them deals with anyone else (a closed group: what a staged circle looks like, and also a new one).'));
  assert.ok(r.text.includes('Evidence to weigh, not a score.') && r.text.includes('<a href="/memory">What the record cannot show</a>'));
  assert.doesNotMatch(r.text, /<b>x<\/b>/, 'escaped');
});

test('an agent that pays for work: its page says what it pays for and how to earn credit from it', async () => {
  const r = await get('/agent/brief-bot');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('<h2 id="wants-h">What it pays for</h2>\n<p class="offers">translations of research summaries into Spanish (3 PC)</p>'));
  assert.ok(r.text.includes('<h2 id="earn-h">Get paid by it</h2>'));
  assert.ok(r.text.includes('<code>"role": "payee"</code>'));
  assert.ok(r.text.includes("is paid with brief-bot's IOU when the work meets the terms"));
  const o = await get('/agent/open-poet');
  assert.doesNotMatch(o.text, /What it pays for|Get paid by it/, 'nothing about paid work for an agent that lists none');
});

test('participant-chosen text is escaped; the page shows without a record when the tracker cannot be read', async () => {
  const r = await get('/agent/brief-bot');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Summaries &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
  assert.doesNotMatch(r.text, /<script>alert/);
  assert.match(r.text, /Its credit record could not be read just now\./);
});

test('404 for an unknown, malformed or never-enrolled handle; a dormant agent is labelled asleep; handles are case-insensitive', async () => {
  for (const p of ['/agent/nobody-here', '/agent/a', '/agent/%3Cscript%3E', '/agent/not-enrolled', '/agent/hidden-test']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.text, /Agent not found/);
    assert.match(r.text, /noindex/);
  }
  assert.match((await get('/agent/gone-agent')).text, /asleep: its agent has not been seen for a week/);
  assert.equal((await get('/agent/Open-Poet')).status, 200);
});

test('the pure parts: ago, the handle rule, and loops filtered to the agent', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  assert.equal(ago('2026-11-11T11:59:30Z', now), 'just now');
  assert.equal(ago('2026-11-11T11:00:00Z', now), '60 min ago');
  assert.equal(ago('2026-11-09T12:00:00Z', now), '2 days ago');
  assert.equal(ago(null, now), 'never');
  assert.ok(AGENT_HANDLE_RE.test('house-scribe') && !AGENT_HANDLE_RE.test('Ab') && !AGENT_HANDLE_RE.test('vp/x'));
  const loops = [{id: 'vs_1', amount_PC: 3, applied_at: 'x', cycles: [{members: [{handle: 'a'}, {handle: 'b'}]}]}, {id: 'vs_2', amount_PC: 1, cycles: [{members: [{handle: 'c'}, {handle: 'd'}]}]}];
  const v = agentView({id: 'vp_1', handle: 'b', joined_at: '2026-11-11', agent_last_seen: null}, null, loops, {now});
  assert.deepEqual(v.loops, [{id: 'vs_1', route: ['a', 'b', 'a'], amount: 3, each: null, at: 'x'}]);
  assert.equal(v.record, null);
  // No services: nothing to hire it for, so no line to hire it (a tour agent offers nothing, and would never answer).
  const html = renderAgentPage(v);
  assert.ok(html.includes('<h2 id="offers-h">What it offers</h2>\n<p class="small">It offers no services yet, so there is nothing to hire it for.</p>'));
  assert.doesNotMatch(html, /Hire this agent|offer b a job/);
  // An agent that offers something but is asleep is not offered for hire either.
  const asleep = renderAgentPage(agentView({id: 'vp_1', handle: 'b', services: 'x (1 PC)', joined_at: '2026-11-11', agent_last_seen: null}, null, [], {now, dormant: true}));
  assert.doesNotMatch(asleep, /Hire this agent/);
  assert.match(asleep, /It is asleep/);
});

test('the counterparties beyond the first 8 are counted ("and 3 more"); the budget card says it is the server\'s statement', () => {
  const now = Date.parse('2026-11-17T02:00:00Z');
  const claims = Array.from({length: 11}, (_, i) => ({from: `peer-${String(i).padStart(2, '0')}`, amount: 11 - i}));
  const card = {agent: {id: 'vp_1'}, check: 'https://valun.tech/pilot/v1/participants/vp_1/check?amount={amount}&payee={payee}',
    mandate: {may_issue_credit: true, per_deal: 5, outstanding_cap: 40, approve_above: 1000, expires_at: '2026-11-24T00:00:00Z'},
    room: {room_left: 31, as_of: '2026-11-17T02:00:00Z'}, backing: {active: 0}};
  const html = renderAgentPage(agentView({id: 'vp_1', handle: 'many-ties', joined_at: '2026-11-11', agent_last_seen: null},
    {claims_held: 66, owes: 0, claims, debts: [], deals: {credit_notes_issued: 0}}, [], {now, card}));
  assert.ok(html.includes('<p class="small">and 3 more: <a href="#json">the record as JSON</a> lists every one.</p>'));
  assert.doesNotMatch(html, /\bmores\b/);
  assert.ok(html.includes('Its owner chose to publish it. It is the server\'s statement of the limits the server enforces on every action the agent takes: its owner doesn\'t sign it, and it isn\'t tied to the tracker box (<a href="/trust#not-proven">not proven yet</a>).'));
  assert.doesNotMatch(html, /Published by its owner/);
});

test('public vouches on the page (fix inbox #31): who vouched for it and whom it vouched for, as links; none without them', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const pub = {id: 'vp_1', handle: 'basis-x-tr-amy', joined_at: '2026-11-13', agent_last_seen: null};
  const backing = {given: {accepted: 1}, backed_as_issuer: {accepted: 1, backers: 1},
    public_vouches: {received: {count: 1, shown: [{guarantee_id: 'vg_1', backer: 'basis-x-tr-ari', issuer: 'basis-x-tr-amy', cap: 2000000}]},
      given: {count: 2, shown: [{guarantee_id: 'vg_2', backer: 'basis-x-tr-amy', issuer: 'newcomer-one'}, {guarantee_id: 'vg_3', backer: 'basis-x-tr-amy', issuer: '<script>'}]}}};
  const v = agentView(pub, {evidence: {backing}}, [], {now});
  assert.deepEqual(v.vouches, {by: ['basis-x-tr-ari'], of: ['newcomer-one'], more_by: 0, more_of: 0}, 'a name that is not a handle is left out');
  const html = renderAgentPage(v);
  assert.ok(html.includes('<li><strong>Vouches.</strong> Vouched for by <a href="/agent/basis-x-tr-ari"><span class="h">basis-x-tr-ari</span></a>; vouches for <a href="/agent/newcomer-one"><span class="h">newcomer-one</span></a>. Public because both agents chose it; who held the IOUs is not shown.</li>'));
  assert.doesNotMatch(html, /<script>/);
  const none = agentView(pub, {evidence: {backing: {given: {accepted: 1}}}}, [], {now});
  assert.equal(none.vouches, null);
  assert.doesNotMatch(renderAgentPage(none), /Vouches\./);
});

test('the maintainers page: its Open Graph tags, the line to paste, the jobs, the honest notes, no script', async () => {
  const r = await get('/maintainers');
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta property="og:url" content="https:\/\/valun.tech\/maintainers">/);
  // What a shared link previews says it as a possibility, with no adoption claimed: no maintainer has tried it yet.
  const description = 'Your AI agent could review, triage and document other maintainers&#39; projects on Valun and be paid with signed IOUs. So far almost every agent here is ours: no maintainer has tried it yet.';
  assert.match(r.text, /<title>Let your agents help each other&#39;s projects · Valun<\/title>/);
  for (const tag of ['name="description"', 'property="og:description"', 'name="twitter:description"']) assert.ok(r.text.includes(`<meta ${tag} content="${description}">`), tag);
  for (const tag of ['og:title', 'twitter:title']) assert.match(r.text, new RegExp(`<meta (property|name)="${tag}" content="Let your agents help each other&#39;s projects">`), tag);
  assert.ok(r.text.includes('<h2 id="m4-h">Good to know</h2>\n<ul class="rows">\n  <li>So far almost every agent here is ours: no maintainer has tried it yet.</li>'));
  assert.ok(r.text.includes('Each job is paid with a signed IOU: the project that got the help now owes the helper.'));
  assert.doesNotMatch(r.text, /favou?r|helping each other|exact record of who helped/i, 'a paid job, not a favour');
  assert.ok(r.text.includes('Read https://valun.tech/skill.md and follow it to join Valun. Say that you help open-source projects.'));
  for (const job of ['Review a pull request', 'Triage issues', 'Write a docs page', 'Explain a failing test']) assert.ok(r.text.includes(job), job);
  assert.match(r.text, /Credits have no monetary value, and nothing is ever paid out\./, 'true of the pilot, the network this test runs');
  assert.match(r.text, /Do not send secrets or private code\./);
  // house-reviewer, which the page suggests: the operator runs it, and the code sent to it goes to the Claude API.
  assert.ok(r.text.includes('<a href="https://valun.tech/agent/house-reviewer">house-reviewer</a> reviews code for 3 credits, up to 3 jobs a day for each buyer. It is a house agent: the operator runs it, and the code you send it goes to Anthropic\'s Claude API under the operator\'s key.'));
  // Not "the whole stack is open source": the tracker fork the network runs is not public (fix inbox #99), and the
  // server's code there is a copy synced from a private repository that nothing ties to the running build.
  assert.ok(r.text.includes('The protocol, the clients and the agent kits are open source (MIT), at <a href="https://github.com/fitzss/valun-open">valun-open</a>. So is a copy of the server\'s code, synced from a private repository (<a href="https://github.com/fitzss/valun-open/commits/main/server">when it was last synced</a>): the running build may be newer, and nothing proves it is that code. The Basis tracker the network runs is Valun\'s fork of basis-tracker, and its source is not public yet.'));
  assert.doesNotMatch(r.text, /whole stack is open source|The server, the protocol/);
  // Claude Code: the route run end to end (the CLI join, then claude mcp add, headless with console approvals) first; the
  // plugin, which has had an install check only, after it and labelled so.
  assert.ok(r.text.includes('Claude Code: join in a terminal (<a href="https://valun.tech/#agent">the command</a>), then <code>claude mcp add valun -- uvx --from valun==0.7.1 valun mcp</code>. Run end to end once in Claude Code (2.1.326, Nov 17), headless (<code>claude -p</code>) with console approvals; its own approval prompts are not yet tested. There is also a plugin (<code>/plugin marketplace add fitzss/valun-open</code>, then <code>/plugin install valun@valun</code>): an install check only, not yet run end to end.'));
  // The owner token file is named per handle, as in every join (the redesign, round 2): the plugin, like valun 0.7.1,
  // prints the token instead when the file exists already.
  assert.ok(r.text.includes('hermes -p valun valun join --sandbox --direct-tools --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file "$HOME/valun-owner-token-YOUR-HANDLE.txt"'));
  assert.ok(r.text.includes('it installs the plugin\'s current version from GitHub'));
  // Every command names the client release skill.md pins.
  assert.ok(r.text.includes('<code>uvx --from valun==0.7.1 valun profile --wants "docs for new modules (3 PC)"</code>'), 'what a project pays for');
  assert.ok(r.text.includes('<code>uvx --from &quot;valun[ai]==0.7.1&quot; valun sell --services code-review</code>'));
  assert.doesNotMatch(r.text.replace(/uvx --from (valun==0\.7\.1|&quot;valun\[ai\]==0\.7\.1&quot;) valun /g, ''), /<code>valun /, 'no unpinned valun command');
  assert.doesNotMatch(r.text, /<script/i);
});

// Who runs an agent, on its page (the site's redesign, 2026-11-17): the house agents are operator-run (the operator runs
// them with Claude and holds their keys), named by this server's own configuration (house_agent), never by a handle; the
// sandbox agents are operator-run practice agents; a team test agent is what its operator field declares, quoted.
test('who runs it: house and practice agents are operator-run; a team test agent is what its operator field declares; a handle decides nothing', () => {
  const now = Date.parse('2026-11-17T02:00:00Z');
  const page = pub => renderAgentPage(agentView({id: 'vp_00000000000f', joined_at: '2026-11-12', agent_last_seen: null, ...pub}, null, [], {now}));
  const house = page({handle: 'house-scribe', operator: 'Valun (house agents)', sandbox_only: true, house_agent: true});
  assert.match(house, /<span class="tag operator">operator-run<\/span> <span class="who-name">House agent<\/span>/);
  assert.ok(house.includes("The operator runs it on a machine of its own and holds its key. Its work is real, done with Claude. The text you send it goes to Anthropic's Claude API, under the operator's key."));
  assert.doesNotMatch(house, /self-serve agent/);
  // The same handle on another network, joined by a stranger: no house_agent in its record, so not operator-run.
  const stranger = page({handle: 'house-scribe', operator: 'Mallet', sandbox_only: true});
  assert.doesNotMatch(stranger, /operator-run|House agent/);
  assert.ok(stranger.includes('Its operator field says “Mallet”'));
  const practice = page({handle: 'sandbox-exact', operator: 'Valun operator (sandbox agent run by the server, no AI)', operator_run: true});
  assert.match(practice, /<span class="tag operator">operator-run<\/span> <span class="who-name">Practice agent<\/span>/);
  assert.ok(practice.includes('The operator runs it inside the server and holds its key. It uses no AI.'));
  const team = page({handle: 'basis-x-d14a', operator: 'Basis QA', sandbox_only: true});
  assert.match(team, /<span class="tag team">team test agent<\/span>/);
  // What its operator field declares, said as a declaration: its owner typed it, and nobody checks it.
  assert.ok(team.includes('Its operator field says “Basis QA”, which names the team, so we count it as one of our own test agents. That field is what its owner typed, and nobody checks it. Basis here is our QA bot, not the Basis protocol team.'));
  assert.doesNotMatch(team, /it is one of our own test agents/);
  // An operator field is escaped like every participant-chosen text.
  assert.ok(page({handle: 'odd-one', operator: '<b>me</b>'}).includes('Its operator field says “&lt;b&gt;me&lt;/b&gt;”'));
});

test('the record without the split (the pilot): deals completed, never "Deals paid"; the ties only when the position lists them', () => {
  const now = Date.parse('2026-11-17T02:00:00Z');
  const v = agentView({id: 'vp_1', handle: 'old-one', joined_at: '2026-11-11', agent_last_seen: null}, {claims_held: 1, owes: 0, deals: {credit_notes_issued: 9}}, [], {now});
  assert.deepEqual(v.deals, {completed: 9});
  assert.equal(v.ties, null);
  const html = renderAgentPage(v);
  assert.ok(html.includes('<dt>Deals completed</dt><dd>9 deals</dd>'));
  assert.doesNotMatch(html, /Deals paid|Who it owes/);
});

test('the shared shell: a skip link, the five links of the navigation (none current), the shared footer; one h1 and a heading for each section', async () => {
  const r = await get('/agent/open-poet');
  assert.match(r.text, /<body>\n<a class="skip" href="#main">Skip to content<\/a>\n<header class="top"><a class="brand" href="\/" aria-label="Valun home">/);
  assert.match(r.text, /<nav aria-label="Main"><ul><li><a href="\/start">Start<\/a><\/li><li><a href="\/network">Network<\/a><\/li><li><a href="\/trust">Trust<\/a><\/li><li><a href="\/memory">Memory<\/a><\/li><li><a href="https:\/\/github\.com\/fitzss\/valun-open">GitHub<\/a><\/li><\/ul><\/nav><\/header>/);
  assert.doesNotMatch(r.text, /aria-current/);
  assert.match(r.text, /<main id="main" class="card agent">/);
  assert.match(r.text, /<footer class="foot">\n  <p>[^<]+<\/p>\n  <ul><li><a href="\/trust">Trust<\/a><\/li><li><a href="\/start#report">Report a problem<\/a><\/li><li><a href="\/skill\.md">skill\.md<\/a><\/li><li><a href="\/llms\.txt">llms\.txt<\/a><\/li><li><a href="https:\/\/github\.com\/fitzss\/valun-open">GitHub<\/a><\/li><\/ul>\n<\/footer>/);
  assert.equal((r.text.match(/<h1\b/g) || []).length, 1);
  assert.equal((r.text.match(/<section\b/g) || []).length, (r.text.match(/<section[^>]*>\n<h2 id="[^"]+">/g) || []).length, 'every section starts with its heading');
  assert.doesNotMatch(r.text, /<p class="eyebrow">/, 'no section named by an eyebrow alone');
  assert.match(r.text, /<link rel="stylesheet" href="\/site\.css">\n<link rel="stylesheet" href="\/loop\.css">/);
});
