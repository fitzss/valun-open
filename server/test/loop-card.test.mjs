// The loop card (/loop/<id>, lib/pilot/loops.mjs) and the agent page (/agent/<handle>, lib/pilot/agents.mjs) as the
// testnet renders them (PILOT_NETWORK=valun-testnet-1, in this file's own process), after the site's redesign
// (2026-11-17): the ring's arrows and its centre in tERG, who runs each member (the operator's agents from the server's
// records; a team test agent from what its operator field declares), what changed and what didn't (every member's net
// position the same), committed and not final, the shared navigation; and the same amounts and the same who-runs-it rule
// as /network (public/network.js). The loop is claude-live-1's of Nov 16, the site's worked example.
process.env.PILOT_NETWORK = 'valun-testnet-1';
process.env.VALUN_PUBLIC_ORIGIN = 'https://valun.tech';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loops = await import('../lib/pilot/loops.mjs');
const agents = await import('../lib/pilot/agents.mjs');
const net = await import(pathToFileURL(path.join(root, 'public', 'network.js')).href);

const TX = 'f2a146cf387f7c95a9d95b6c772e04069ae34c6a5cd994d29d6feaf5981fe455';
const member = (handle, kind) => ({handle, kind});
const LOOP = {id: 'vs_4f8d53475c9e591a', applied_at: '2026-11-16T17:30:57.003Z', cycle_length: 3, amount_PC: 3_000_000, each_PC: 1_000_000, participants: 3,
  members: [member('sandbox-mallory', 'sandbox_agent'), member('claude-live-1', 'sandbox_participant'), member('sandbox-exact', 'sandbox_agent')],
  card_url: 'https://valun.tech/loop/vs_4f8d53475c9e591a',
  on_chain: {anchored: true, tx_id: TX, explorer_url: `https://testnet.ergoplatform.com/en/transactions/${TX}`, signed_at: '2026-11-16T17:33:07.695Z'}};
LOOP.cycles = [{length: 3, each_PC: 1_000_000, members: LOOP.members}];
const RECORDS = new Map([['sandbox-mallory', {handle: 'sandbox-mallory', operator: 'Valun operator (sandbox agent run by the server, no AI)', operator_run: true}],
  ['claude-live-1', {handle: 'claude-live-1', operator: 'Claude live check', sandbox_only: true}],
  ['sandbox-exact', {handle: 'sandbox-exact', operator: 'Valun operator (sandbox agent run by the server, no AI)', operator_run: true}]]);
// The members whose agent page the server shows (lib/pilot/agents.mjs pageHandles): all three, as on valun.tech.
const PAGES = new Set(RECORDS.keys());
const NOW = Date.parse('2026-11-17T01:12:00Z');

test('the ring: an arrow from each member to the one it owed, the centre in tERG in light type, who runs each by its shape, a frame that fits', () => {
  const html = loops.renderLoopPage(LOOP, {records: RECORDS, now: NOW});
  const svg = /<svg class="ring" viewBox="0 (-?\d+) 400 (\d+)" role="img" aria-label="([^"]+)">[\s\S]*?<\/svg>/.exec(html);
  assert.ok(svg, 'the ring');
  assert.equal(svg[3], 'Live: the loop sandbox-mallory → claude-live-1 → sandbox-exact → sandbox-mallory. Each arrow points from the agent that owed to the agent it owed; each of these debts fell by 0.001 tERG.');
  assert.equal((svg[0].match(/<path class="arc" d="[^"]+" marker-end="url\(#loop-arrow-0\)"\/>/g) || []).length, 3, 'three arrows, each with its head');
  assert.match(svg[0], /<text class="mid" x="200" y="178" text-anchor="middle">−0\.001<\/text><text class="mid-u" x="200" y="198" text-anchor="middle">tERG each<\/text>/);
  assert.doesNotMatch(svg[0], /−1000000|1000000/, 'never raw nanoERG');
  assert.deepEqual([...svg[0].matchAll(/<g class="node w-(\w+)"><(rect|circle)/g)].map(m => `${m[1]}:${m[2]}`), ['practice:rect', 'team:circle', 'practice:rect'],
    'a diamond for an agent the operator runs, a hollow circle for a team test agent');
  assert.match(svg[0], /<circle class="rainbow" [^>]*stroke="url\(#loop-rainbow-0\)"/, 'the rainbow: a loop that cleared');
  // Every label inside the frame (an estimate of its width: 8.6 units a character at 14 units).
  const [y0, h] = [Number(svg[1]), Number(svg[2])];
  for (const [, x, y, text] of svg[0].matchAll(/<text x="([\d.]+)" y="([\d.]+)" text-anchor="middle">([^<]+)<\/text>/g)) {
    const w = [...text].length * 8.6;
    assert.ok(Number(x) - w / 2 >= 0 && Number(x) + w / 2 <= 400 && Number(y) - 14 >= y0 && Number(y) <= y0 + h, `${text} inside the frame`);
  }
});

test('the card: what changed and what didn\'t, who runs each member, committed not final, what is not public, live and labelled', () => {
  const html = loops.renderLoopPage(LOOP, {records: RECORDS, now: NOW, pages: PAGES});
  assert.ok(html.includes('<p class="lede">3 agents\' IOUs formed a loop. Each agent signed once, and every debt in the loop fell by 0.001 tERG: 0.003 tERG of debt cancelled in all. Nobody\'s net position changed, the work stays done, and no coins moved.</p>'));
  assert.ok(html.includes('<p class="live-line"><span class="tag live">Live record</span> <span>valun-testnet-1</span> <span>read 01:12 UTC</span> <a href="/pilot/v1/loops/vs_4f8d53475c9e591a">the record as JSON</a></p>'));
  // What changed: each debt in the loop, by the same amount.
  const debts = [...html.matchAll(/<li><a class="h" href="\/agent\/([\w-]+)">[\w-]+<\/a> <span class="arr">owed<\/span> <a class="h" href="\/agent\/([\w-]+)">[\w-]+<\/a> <span class="num">([^<]+)<\/span><\/li>/g)].map(m => [m[1], m[2], m[3]]);
  assert.deepEqual(debts, [['sandbox-mallory', 'claude-live-1', '−0.001 tERG'], ['claude-live-1', 'sandbox-exact', '−0.001 tERG'], ['sandbox-exact', 'sandbox-mallory', '−0.001 tERG']]);
  // What didn't: every member's net position. The cells are changes, and the caption says so; the unit keeps its case in
  // the uppercase caption.
  assert.ok(html.includes('<caption>How each member\'s totals changed (in <span class="unit">tERG</span>)</caption>'));
  assert.ok(html.includes('<th scope="col" class="num">What it owes</th><th scope="col" class="num">What it is owed</th><th scope="col">Net position</th>'));
  assert.doesNotMatch(html, /after the loop cleared \(in/);
  const rows = [...html.matchAll(/<tr><th scope="row"><a class="h" href="\/agent\/([\w-]+)">[\w-]+<\/a><\/th><td class="num">([^<]+)<\/td><td class="num">([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)].map(m => m.slice(1));
  assert.deepEqual(rows, [['sandbox-mallory', '−0.001', '−0.001', 'unchanged'], ['claude-live-1', '−0.001', '−0.001', 'unchanged'], ['sandbox-exact', '−0.001', '−0.001', 'unchanged']]);
  assert.ok(html.includes('The work behind these IOUs stays done, the record keeps every IOU and this loop, and no coins moved.'));
  // Who runs each member, in words.
  assert.ok(html.includes('<a class="h" href="/agent/sandbox-mallory">sandbox-mallory</a> <span class="tag operator">operator-run</span> <span class="who-line">Practice agent. The operator runs it inside the server and holds its key. It uses no AI.</span>'));
  assert.ok(html.includes('<a class="h" href="/agent/claude-live-1">claude-live-1</a> <span class="tag team">team test agent</span> <span class="who-line">Its operator field names the team, so we count it as one of our own test agents (the field is self-declared).</span>'));
  assert.ok(html.includes('So far almost all agents are our own test and practice agents: they show the mechanics working, not adoption.'));
  assert.doesNotMatch(html, /op-name|Claude live check/, 'the operator field itself stays on the agent\'s page');
  // On Ergo testnet: committed by the next box, in the past tense; committed, not final, with its condition.
  // Which box committed it is the server's reading of the times, and the audit checks only the current box.
  assert.ok(html.includes(`<strong>Committed on Ergo testnet</strong> by the next tracker box: <a href="https://testnet.ergoplatform.com/en/transactions/${TX}">tx f2a146cf387f…</a>, signed 17:33 UTC, 2 minutes after the loop cleared. The server matches that box to the loop by time (the first one signed after it); <code>valun audit</code> checks only the current box.`));
  assert.ok(html.includes('Committed, not final: a netting the tracker commits stays committed as long as the tracker key never commits an earlier total again. The operator holds that key, and nothing on chain stops it. <a href="/trust#netting">How netting is committed</a>.'));
  assert.doesNotMatch(html, /stays final|\bis final\b|irreversible|settled|\bmoney\b|nanoERG|\bcredits\b/i, 'committed, never final; tERG, never the pilot\'s credits');
  assert.ok(html.includes('Not public, so not shown: which job each IOU paid for.'));
  // The shared shell: skip link, navigation (none current), one h1, a heading for each section, the shared footer.
  assert.match(html, /<body>\n<a class="skip" href="#main">Skip to content<\/a>\n<header class="top"><a class="brand" href="\/" aria-label="Valun home">/);
  assert.doesNotMatch(html, /aria-current/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.equal((html.match(/<section\b/g) || []).length, (html.match(/<section aria-labelledby="([\w-]+)">\n<h2 id="\1">/g) || []).length + (html.match(/<section class="chain" aria-labelledby="chain-h">\n<h2 id="chain-h">/g) || []).length);
  assert.ok(html.includes('<footer class="foot">\n  <p>Ergo testnet · test coins only, with no monetary value</p>'));
  assert.doesNotMatch(html, /<script|\sstyle=|\son[a-z]+=/i);
});

// The styles of the server's pages (public/loop.css): labels at 12 px at least (site.css's floor); under forced colours
// (Windows High Contrast recolours HTML but not SVG fill and stroke) the ring and the shapes in the system colours, a
// filled circle still filled; tERG keeps its case in the uppercase caption; the table's four columns fit a phone.
test('loop.css: no label under 12 px; forced colours draw the ring and the shapes; the unit keeps its case; the table fits from 320 px', async () => {
  const {cssRules} = await import('./network-dom.mjs');
  const fs = await import('node:fs');
  const css = cssRules(fs.readFileSync(path.join(root, 'public', 'loop.css'), 'utf8'));
  for (const r of css) for (const [k, v] of Object.entries(r.decls)) {
    const rem = k === 'font' || k === 'font-size' ? /(?:^|\s)(\d*\.?\d+)rem\b/.exec(v) : null;
    if (rem) assert.ok(Number(rem[1]) >= 0.75, `${r.selector} ${k}: ${v}`);
  }
  const forced = sel => css.find(r => r.media === '(forced-colors: active)' && r.selector === sel)?.decls ?? {};
  assert.deepEqual([forced('.ring .node text').fill, forced('.ring .node text').stroke], ['CanvasText', 'Canvas']);
  assert.deepEqual([forced('.ring .arc').stroke, forced('.ring .node.w-practice rect').stroke, forced('.ring .node.w-other circle').fill], ['CanvasText', 'CanvasText', 'CanvasText']);
  assert.deepEqual([forced('.shape.w-other')['forced-color-adjust'], forced('.shape.w-other').background], ['none', 'CanvasText']);
  assert.equal(forced('.tag.live::before')['forced-color-adjust'], 'none');
  assert.equal(css.find(r => r.selector === 'table.changed caption .unit')?.decls['text-transform'], 'none');
  assert.equal(css.find(r => r.selector === 'table.changed thead th.num')?.decls['white-space'], 'normal', 'the headers wrap');
  assert.equal(css.find(r => r.media === '(max-width: 480px)' && r.selector === 'table.changed td')?.decls['padding-right'], '0.5rem');
});

test('who runs a member comes from the server\'s records: a house agent by its record, never by its handle; without records only the kind is known', () => {
  const two = {...LOOP, id: 'vs_00000000000000b2', cycle_length: 2, amount_PC: 4_000_000, each_PC: 2_000_000, participants: 2, on_chain: {anchored: false},
    members: [member('house-scribe', 'sandbox_participant'), member('ada-persona', 'sandbox_participant')]};
  two.cycles = [{length: 2, each_PC: 2_000_000, members: two.members}];
  const html = rec => loops.renderLoopPage(two, {records: new Map(rec), now: NOW, pages: new Set(['house-scribe', 'ada-persona'])});
  const house = html([['house-scribe', {handle: 'house-scribe', operator: 'Valun (house agents)', house_agent: true}], ['ada-persona', {handle: 'ada-persona', operator: 'Ada Lovelace'}]]);
  assert.match(house, /<g class="node w-house"><rect/);
  assert.ok(house.includes('<span class="who-line">House agent. The operator runs it on a machine of its own and holds its key. Its work is real, done with Claude.</span>'));
  assert.ok(house.includes('<span class="shape w-other" aria-hidden="true"></span><a class="h" href="/agent/ada-persona">ada-persona</a>  <span class="who-line">Its operator field names no one on the team.</span>'));
  const stranger = html([['house-scribe', {handle: 'house-scribe', operator: 'Valun fan'}], ['ada-persona', {handle: 'ada-persona', operator: 'x'}]]);
  assert.doesNotMatch(stranger, /w-house|House agent/, 'the handle alone: not the operator\'s');
  assert.ok(stranger.includes('<strong>Not committed on Ergo testnet yet.</strong> The next tracker box commits it, usually within minutes, up to about 30 when Ergo testnet blocks are slow.'));
  assert.match(stranger, /<text class="mid" [^>]+>−0\.002<\/text>/);
  // Without records (another caller): a sandbox agent by its kind, everyone else unlabelled, nothing invented.
  const bare = loops.renderLoopPage(LOOP);
  assert.deepEqual([...bare.matchAll(/<g class="node w-(\w+)">/g)].map(m => m[1]), ['practice', 'unknown', 'practice']);
  assert.doesNotMatch(bare, /team test agent/);
});

// Fix inbox #141: a link to an agent the operator unlisted was a 404. The card links a member only to a page the server
// shows; any other member is named as text, everywhere on the card, and a card rendered without knowing links none.
test('fix inbox #141: a member with no page of its own is named, not linked, in the debts, the totals and who was in it', () => {
  const hidden = loops.renderLoopPage(LOOP, {records: RECORDS, now: NOW, pages: new Set(['sandbox-mallory', 'sandbox-exact'])});
  assert.doesNotMatch(hidden, /href="\/agent\/claude-live-1"/);
  assert.ok(hidden.includes('<li><a class="h" href="/agent/sandbox-mallory">sandbox-mallory</a> <span class="arr">owed</span> <span class="h">claude-live-1</span> <span class="num">−0.001 tERG</span></li>'));
  assert.ok(hidden.includes('<li><span class="h">claude-live-1</span> <span class="arr">owed</span> <a class="h" href="/agent/sandbox-exact">sandbox-exact</a> <span class="num">−0.001 tERG</span></li>'));
  assert.ok(hidden.includes('<tr><th scope="row"><span class="h">claude-live-1</span></th><td class="num">−0.001</td>'));
  assert.ok(hidden.includes('<li><span class="shape w-team" aria-hidden="true"></span><span class="h">claude-live-1</span> <span class="tag team">team test agent</span>'));
  assert.deepEqual([...new Set([...hidden.matchAll(/href="\/agent\/([^"]+)"/g)].map(m => m[1]))].sort(), ['sandbox-exact', 'sandbox-mallory']);
  assert.doesNotMatch(loops.renderLoopPage(LOOP, {records: RECORDS, now: NOW}), /href="\/agent\//, 'no pages known: no member linked');
  // A name that is not a handle stays text, whatever the pages say.
  assert.equal(loops.agentLink('<b>x</b>', true), '<span class="h">&lt;b&gt;x&lt;/b&gt;</span>');
  assert.equal(loops.agentLink('ana-tester', true), '<a class="h" href="/agent/ana-tester">ana-tester</a>');
  assert.equal(loops.agentLink('ana-tester'), '<span class="h">ana-tester</span>');
});

test('memberRecords: the public records of a set-off\'s members, by handle; whoRuns and the amounts are the same on /network', () => {
  const participants = {vp_a: {id: 'vp_a', handle: 'ann'}, vp_b: {id: 'vp_b', handle: 'bo'}, vp_c: {id: 'vp_c', handle: 'cy'}};
  const o = {members: ['vp_a', 'vp_b'], edges: [{issuer: {id: 'vp_a'}, recipient: {id: 'vp_b'}}, {issuer: {id: 'vp_b'}, recipient: {id: 'vp_a'}}]};
  const m = loops.memberRecords(o, participants, x => ({handle: x.handle, operator: 'op'}));
  assert.deepEqual([...m.keys()], ['ann', 'bo']);
  for (const n of [0, 1, 999, 250_000, 1_000_000, 3_000_000, 493_002, 443_616_002, -2_000_000, 1_500_000_000]) {
    assert.equal(loops.terg(n), net.terg(n), `${n}`);
    assert.equal(loops.terg(n, {total: true}), net.terg(n, {total: true}), `${n}, a total`);
  }
  assert.equal(loops.terg(3_000_000), '0.003 tERG');
  assert.equal(loops.terg(373_823_000, {total: true}), '0.374 tERG');
  assert.equal(loops.signed(-1_000_000), '−0.001 tERG');
});

test('the agent page on the testnet: amounts in tERG, live and labelled, a house agent\'s sentence about the Claude API', () => {
  const pub = {id: 'vp_6dc99db9c420', handle: 'house-scribe', display_name: 'House scribe', operator: 'Valun (house agents)', about: 'House agent run by the Valun operator.',
    services: 'summary (2000000 nanoERG (0.002 tERG))', joined_at: '2026-11-12T22:15:42.291Z', agent_last_seen: '2026-11-17T01:12:30.867Z', sandbox_only: true, house_agent: true};
  const pos = {claims_held: 22_000_000, owes: 0, cleared_by_setoff: 0, deals: {credit_notes_issued: 9, disputed: 0, notes_received: 9, notes_issued_as_payer: 0, paid_by_transfer: 2},
    credit_history: {received_by_transfer: {count: 2}, paid_by_transfer: {count: 0}}, claims: [{from: 'basis-x-d14a', amount: 4_000_000}, {from: 'claude-live-1', amount: 2_000_000}], debts: []};
  const html = agents.renderAgentPage(agents.agentView(pub, pos, [], {now: NOW}));
  for (const [dt, dd] of [['Paid for its work', '11 deals'], ['Paid others', '0 deals'], ['Is owed', '0.022 tERG'], ['Owes', '0 tERG'], ['Cleared in loops', '0 tERG']])
    assert.ok(html.includes(`<dt>${dt}</dt><dd>${dd}</dd>`), dt);
  assert.ok(html.includes('<p class="live-line"><span class="tag live">Live record</span> <span>valun-testnet-1</span> <span>read 01:12 UTC</span> <a href="/pilot/v1/participants/vp_6dc99db9c420">the record as JSON</a></p>'));
  assert.match(html, /<span class="tag operator">operator-run<\/span> <span class="who-name">House agent<\/span>/);
  assert.ok(html.includes("The text you send it goes to Anthropic's Claude API, under the operator's key."));
  assert.ok(html.includes('Nobody: it owes nothing on the tracker.'));
  assert.ok(html.includes('<p>Paste this into an agent that can run shell commands:</p>'), 'no app named as tested');
  assert.ok(html.includes('This prompt hasn\'t been verified in a real agent app yet: <a href="/start#report">tell us how it went</a>.'));
  assert.doesNotMatch(html.slice(html.indexOf('<body>')).replace(/<p class="offers">[^<]*<\/p>/g, ''), /nanoERG|\bPC\b|self-serve agent|Deals paid/, 'participant-written offers aside, people read tERG');
});

// claude-live-1's record as valun.tech served it (Nov 17): it owed 0.004 tERG, two loops cleared 0.002 of it with the
// practice agents, nothing was redeemed. The page called that "Repaid ... settled"; a set-off clears a debt (committed,
// not final) and a redemption pays it, so the two are shown apart and neither word is used.
test('the agent page on the testnet: cleared in loops and redeemed, apart, never "repaid" or "settled"; each loop by what each debt fell', () => {
  const pub = {id: 'vp_c93601acafff', handle: 'claude-live-1', operator: 'Claude live check', joined_at: '2026-11-16T17:20:00.000Z', agent_last_seen: '2026-11-16T17:40:00.000Z', sandbox_only: true};
  const evidence = {delivery: {accepted: {count: 1, buyers: 1, buyers_by_kind: {sandbox_agent: 1}}, disputed_by_buyer: 0, not_delivered: 0},
    repayment: {owed_ever_PC: 4_000_000, settled: {by_setoff_PC: 2_000_000, by_redemption_PC: 0, creditors: 1, creditors_by_kind: {sandbox_agent: 1}}, outstanding_PC: 2_000_000,
      unpaid_accepted_work: {count: 0, PC: 0}}, acceptance: {holders_ever: 2, taken_by_transfer: {PC: 0}}, circle: {size: 3, closed: false}};
  const pos = {claims_held: 0, owes: 2_000_000, cleared_by_setoff: 2_000_000, deals: {credit_notes_issued: 5, disputed: 0, notes_received: 3, notes_issued_as_payer: 2}, evidence, claims: [], debts: []};
  const html = agents.renderAgentPage(agents.agentView(pub, pos, [LOOP], {now: NOW}));
  assert.ok(html.includes('<li><strong>Cleared or redeemed.</strong> 0.002 tERG of the 0.004 tERG it owed cleared in loops (committed, not final), 0 tERG redeemed, with 1 creditor (1 practice agent); 0.002 tERG outstanding; 0 accepted jobs unpaid.</li>'));
  assert.doesNotMatch(html, /Repaid|\bsettled\b|\brepaid\b/i);
  assert.ok(html.includes('</a> · 0.001 tERG off each debt (0.003 tERG in all)</li>'), 'the loop by what each debt fell, as the loop card says');
  // The maintainers page on the testnet: the join command is on /start, and every price is in tERG.
  const m = agents.renderMaintainersPage();
  assert.ok(m.includes('Claude Code: join in a terminal (<a href="https://valun.tech/start#agent">the command</a>)'));
  assert.ok(m.includes('<code>uvx --from valun==0.7.1 valun profile --wants "docs for new modules (3000000 nanoERG (0.003 tERG))"</code>'));
});
