// The home page's live view and numbers (public/home.html, home.js, home.css): what the hero's live view says and does
// on the testnet's public reads, and that the page's numbers are the server's. The view names one IOU at a time in words
// ("X holds Y's IOU for 0.003 tERG", with who runs each), lists the latest ones as text, scales line brightness by amount
// in tERG (in raw nanoERG every line sat at the brightest), reads at most once a minute and only while it is visible and
// not paused, and moves nothing by itself under reduced motion. test/close-the-loop.test.mjs pins the page's copy and
// its CSP; this file checks its behaviour. The pilot is retired: this runs as the testnet.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readBody, runNetworkPage, cssRules} from './network-dom.mjs';
import {settle} from './console-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const core = await import('../lib/pilot/core.mjs');
const caps = await import('../lib/pilot/caps.mjs');
const home = await import(pathToFileURL(path.join(root, 'public', 'home.js')).href);
// The page's words, as a reader sees them (a <wbr> in inline code, lib/code-words.mjs, is no character).
const words = h => (/<body>([\s\S]*)<\/body>/.exec(h)?.[1] ?? h).replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<\/?(?:code|a|b|strong|em|span|wbr)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const terg = n => String(n / 1e9);

test("the home's numbers are the server's: a self-serve agent's limits and days, joins from one address, how long a loop waits", () => {
  const text = words(pub('home.html')), c = core.SANDBOX_CAPS;
  assert.equal(c.max_issue_per_deal, 5_000_000, 'the testnet: nanoERG');
  assert.ok(text.includes(`at most ${terg(c.max_issue_per_deal)} tERG per deal and ${terg(c.max_issue_outstanding)} tERG owed in all, ${core.OPEN_NETWORK_MAX_OPEN_OFFERS} open offers, for ${core.SANDBOX_DAYS} days, renewed while your agent is active`));
  assert.ok(text.includes(`Every self-serve agent can owe at most ${terg(c.max_issue_outstanding)} tERG in all, and ${terg(c.max_issue_per_deal)} tERG per deal.`));
  assert.ok(text.includes(`At most ${core.SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} agents an hour can join from one address.`));
  assert.ok(text.includes(`The loop waits up to ${caps.SETOFF_TTL_MS / 60_000} minutes for every signature.`));
  // The testnet's default acceptance, in the worked example and under "Your approvals": what a self-serve join's mandate
  // accepts by transfer (SANDBOX_CAPS.max_accept_per_issuer), who signs it (each client for its own key: the lead's D3b),
  // and that the operator's own agents are outside these caps.
  const accept = `On the testnet a new self-serve agent accepts any issuer's IOUs as payment by transfer, up to ${terg(c.max_accept_per_issuer)} tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way. Its owner can narrow whose IOUs it accepts under 'Accept notes from' in the owner console.`;
  assert.equal(text.split(accept).length - 1, 2, 'the default, in the example and in "Your approvals"');
  assert.ok(text.includes(`Limits cap what each self-serve agent can owe (${terg(c.max_issue_outstanding)} tERG); the operator's own agents, and any agent whose limits the operator changes, aren't bound by them.`));
  // How an IOU last changed, from its timestamp's residue: the server's own (GET /info novation).
  assert.deepEqual(Object.keys(home.HOW).map(Number).sort(), [caps.BOUND_NOTE_MS, caps.SETOFF_MS, caps.TRANSFER_MS].sort());
  assert.equal(home.HOW[caps.TRANSFER_MS], 'Passed on');
  assert.equal(home.HOW[caps.SETOFF_MS], 'A loop cleared part of it');
  assert.equal(home.HOW[caps.BOUND_NOTE_MS], 'New IOU');
});

test('the live view, its pure parts: who runs whom, the open IOUs newest first, amounts in tERG, the turn to the spotlight, when to read', () => {
  const {kindOf, openIOUs, latestIOUs, lineAlpha, spotWords, newestLoop, constellation, spotAngle, turn, nextReadIn, ago, utcTime} = home;
  // Who runs an agent: public/who.js, the rule /network and the server's pages use. The practice agents by their reserved
  // handles; the house agents by the server's house_agent flag; operator_run; a team test agent by what its operator
  // field declares; no label for anyone else (a handle alone says nothing: a stranger can pick 'claude-x').
  for (const h of ['sandbox-exact', 'sandbox-mallory']) assert.equal(kindOf(h), 'operator', h);
  assert.equal(kindOf('house-scribe', {handle: 'house-scribe', house_agent: true, operator: 'Valun (house agents)'}), 'operator');
  assert.equal(kindOf('ops-new', {operator_run: true}), 'operator');
  for (const op of ['Basis QA', 'Claude live check', 'Claude host test (Valun team)', 'Fitz', 'Valun (house agents)']) assert.equal(kindOf('x-agent', {operator: op}), 'team', op);
  for (const op of ['Robin Owner', 'Ada Lovelace', 'anonymous (frontier lab)', '']) assert.equal(kindOf('x-agent', {operator: op}), null, op);
  for (const h of ['claude-live-1', 'basis-x-v107cb', 'ana-tester', '', null]) assert.equal(kindOf(h), null, `${h}: no record, no label`);
  assert.deepEqual(home.KIND_WORDS, {operator: 'operator-run', team: 'team test'});
  // The open IOUs: one per pair (several notes of a pair added up, its newest change kept), closed ones and self-notes out.
  const s = 1_794_607_000;
  const ledger = {unit: 'nanoERG', notes: [
    {issuer_handle: 'ana', recipient_handle: 'bo', outstanding: 3_000_000, timestamp: s * 1000 + 997},
    {issuer_handle: 'ana', recipient_handle: 'bo', outstanding: 1_000_000, timestamp: (s + 60) * 1000 + 999},
    {issuer_handle: 'bo', recipient_handle: 'cy', outstanding: 0, timestamp: (s + 120) * 1000 + 998},
    {issuer_handle: 'cy', recipient_handle: 'ana', outstanding: 2_000_000, timestamp: (s + 30) * 1000 + 998},
    {issuer_handle: 'cy', recipient_handle: 'cy', outstanding: 5, timestamp: (s + 200) * 1000 + 997},
    {issuer_handle: 'dee', recipient_handle: 'ana', outstanding: 2_000_000, timestamp: (s + 10) * 1000 + 123}]};
  const ious = openIOUs(ledger);
  assert.deepEqual(ious.map(e => [e.key, e.amount, e.how]), [['ana>bo', 4_000_000, 'Passed on'], ['cy>ana', 2_000_000, 'A loop cleared part of it'], ['dee>ana', 2_000_000, null]]);
  assert.deepEqual(latestIOUs(ious).map(e => e.key), ['ana>bo', 'cy>ana', 'dee>ana'], 'newest first');
  assert.equal(latestIOUs(Array.from({length: 30}, (_, i) => ({key: `k${i}`, ts: i}))).length, home.LATEST_SHOWN);
  assert.deepEqual(openIOUs({}), []);
  // A line's brightness by its amount in tERG: distinct for 0.001 and 0.021 tERG (in raw nanoERG both sat at the cap).
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
  near(lineAlpha(1_000_000, 'nanoERG'), 0.15);
  near(lineAlpha(21_000_000, 'nanoERG'), 0.1 + 0.05 * Math.sqrt(21));
  assert.ok(lineAlpha(21_000_000, 'nanoERG') < 0.5 && lineAlpha(1_000_000, 'nanoERG') < lineAlpha(21_000_000, 'nanoERG'));
  assert.equal(lineAlpha(10_000_000_000, 'nanoERG'), 0.5, 'at most 0.5');
  assert.equal(lineAlpha(1_000_000, undefined), 0.18, 'no unit named: one neutral brightness');
  // The spotlight's words: who holds whose IOU, for how much.
  assert.deepEqual(spotWords(ious[0], 'nanoERG'), {holder: 'bo', issuer: 'ana', amount: '0.004 tERG', text: "bo holds ana's IOU for 0.004 tERG."});
  assert.equal(spotWords({holder: 'bo', issuer: 'ana', amount: 1_500_000}, 'nanoERG').amount, '0.0015 tERG');
  assert.equal(spotWords({holder: 'bo', issuer: 'ana', amount: 1_500_000}, undefined).amount, '– tERG', 'no unit named: no number');
  // The newest loop, in words (the one with the rainbow ring).
  const now = Date.parse('2026-11-17T01:00:00Z');
  assert.deepEqual(newestLoop({unit: 'nanoERG', loops: [{id: 'nope', members: []}, {id: 'vs_f8254530b0cf5e5d', applied_at: '2026-11-17T00:55:00Z', each: 1_000_000,
    members: [{handle: 'sandbox-mallory'}, {handle: 'claude-live-1'}, {handle: 'sandbox-exact'}]}]}, now),
  {id: 'vs_f8254530b0cf5e5d', path: 'sandbox-mallory → claude-live-1 → sandbox-exact → sandbox-mallory', each: '0.001 tERG', when: '5 min ago'});
  assert.equal(newestLoop({loops: []}), null);
  assert.equal(ago(now - 7200e3, now), '2 h ago');
  assert.equal(utcTime(Date.parse('2026-11-17T01:12:40Z')), '01:12 UTC');
  // What the sphere draws: every agent of the directory, and one only the ledger names (newer than the last directory
  // read); each open IOU with its brightness; loops whose members are points.
  const sky = constellation({participants: [{handle: 'ana'}, {handle: 'bo'}, {handle: 'sandbox-exact', operator_run: true}], ledger,
    loops: {loops: [{id: 'vs_0000000000000001', members: [{handle: 'ana'}, {handle: 'bo'}]}, {id: 'vs_0000000000000002', members: [{handle: 'gone'}]}]}});
  assert.deepEqual(sky.nodes.map(n => [n.handle, n.kind]), [['ana', null], ['bo', null], ['sandbox-exact', 'operator'], ['cy', null], ['dee', null]]);
  assert.deepEqual(sky.edges.map(e => [e.key, e.alpha]), [['ana>bo', lineAlpha(4_000_000, 'nanoERG')], ['cy>ana', lineAlpha(2_000_000, 'nanoERG')], ['dee>ana', lineAlpha(2_000_000, 'nanoERG')]]);
  assert.deepEqual(sky.rings.map(r => [r.id, r.pts.length]), [['vs_0000000000000001', 2]], 'a loop whose members are not points is not drawn');
  assert.deepEqual(constellation({}), {nodes: [], edges: [], rings: []});
  // The turn that brings the spotlight's middle to face the viewer; the shortest way round.
  for (const e of sky.edges) {
    const t = spotAngle(e), x = e.a.x + e.b.x, z = e.a.z + e.b.z;
    assert.ok(Math.abs(x * Math.cos(t) + z * Math.sin(t)) < 1e-9, `${e.key}: centred`);
    assert.ok(-x * Math.sin(t) + z * Math.cos(t) > 0, `${e.key}: in front`);
  }
  assert.ok(Math.abs(turn(0, 1.5 * Math.PI) + 0.5 * Math.PI) < 1e-12);
  assert.ok(Math.abs(turn(0.1, 0.1 + 2 * Math.PI)) < 1e-12);
  // When to read: at most once a minute; never while paused, hidden or off screen; longer after failures, up to 5 min.
  assert.ok(home.REFRESH_MS >= 60_000);
  assert.equal(nextReadIn(), home.REFRESH_MS);
  assert.deepEqual([1, 2, 3, 9].map(f => nextReadIn({failures: f})), [120_000, 240_000, 300_000, 300_000]);
  for (const o of [{paused: true}, {hidden: true}, {onScreen: false}]) assert.equal(nextReadIn(o), null, JSON.stringify(o));
  assert.equal(home.PEOPLE_MS, 300_000, 'the directory, the heaviest read, at most once in 5 minutes');
  // The bar: what it reads (one real IOU at a time), when, and a Live tag only while that is so.
  const {readLabel, nextSaid, curveMiddle, clearOf} = home, at = Date.parse('2026-11-17T01:12:40Z');
  assert.deepEqual(readLabel({}), {text: 'Testnet records: reading…', tag: null});
  assert.deepEqual(readLabel({failures: 2}), {text: 'Testnet records: cannot be read right now', tag: null}, 'no read has answered: no tag');
  assert.deepEqual(readLabel({readAt: at}), {lead: 'Testnet records, one real IOU at a time, ', read: 'read 01:12 UTC', tail: '', tag: 'Live'});
  // Paused is said once, by the tag (the label said it too: a screen reader read "Paused Paused; testnet records").
  assert.deepEqual(readLabel({readAt: at, paused: true}), {lead: 'Testnet records, one real IOU at a time, ', read: 'read 01:12 UTC', tail: '', tag: 'Paused'});
  assert.deepEqual(readLabel({readAt: at, failures: 1}), {lead: 'Testnet records, one real IOU at a time, ', read: 'read 01:12 UTC', tail: ' (retrying)', tag: 'Offline'});
  // What Next says (the spotlight's words are no live region: they change by themselves every 8 s).
  assert.equal(nextSaid(ious[0], 0, 3, 'nanoERG'), "IOU 1 of 3: bo holds ana's IOU for 0.004 tERG.");
  assert.equal(nextSaid(undefined, 0, 0, 'nanoERG'), 'No open IOUs right now.');
  // The newest loop's glow and ring are left out where they would cover the spotlight's arrow.
  assert.deepEqual(curveMiddle({x: 0, y: 0}, {x: 10, y: 20}, {x: 20, y: 0}), {x: 10, y: 10});
  assert.equal(clearOf({x: 10, y: 12}, {x: 10, y: 10}, 24), false);
  assert.equal(clearOf({x: 60, y: 10}, {x: 10, y: 10}, 24), true);
  assert.equal(clearOf({x: 10, y: 10}, null, 24), true, 'no spotlight: nothing to keep clear');
});

// The page itself (home.html and home.js, as a browser starts them) on fixed public reads, with timers a test runs.
const S = Math.floor(Date.now() / 1000);
const READS = {
  '/pilot/v1/participants?all=1': [{handle: 'sandbox-exact', operator_run: true}, {handle: 'sandbox-mallory', operator_run: true},
    {handle: 'house-scribe', sandbox_only: true, house_agent: true, operator: 'Valun (house agents)'},
    {handle: 'basis-x-1', sandbox_only: true, operator: 'Basis QA'}, {handle: 'ana-tester', sandbox_only: true, operator: 'Ana'},
    {handle: 'tn-hidden', unlisted: true, operator: 'Valun operator test'}],
  '/pilot/v1/ledger': {unit: 'nanoERG', notes: [
    {issuer_handle: 'basis-x-1', recipient_handle: 'sandbox-exact', outstanding: 3_000_000, timestamp: (S - 90_000) * 1000 + 997},
    {issuer_handle: 'sandbox-exact', recipient_handle: 'house-scribe', outstanding: 4_000_000, timestamp: (S - 330) * 1000 + 999},
    {issuer_handle: 'ana-tester', recipient_handle: 'basis-x-1', outstanding: 1_500_000, timestamp: (S - 7300) * 1000 + 998},
    {issuer_handle: 'sandbox-mallory', recipient_handle: 'ana-tester', outstanding: 0, timestamp: (S - 60) * 1000 + 998}]},
  '/pilot/v1/loops': {unit: 'nanoERG', network: 'valun-testnet-1', loops: [{id: 'vs_4f8d53475c9e591a', applied_at: new Date((S - 600) * 1000).toISOString(), each: 1_000_000,
    amount: 2_000_000, members: [{handle: 'sandbox-exact'}, {handle: 'sandbox-mallory'}]}]},
  '/pilot/v1/clearing': {unit: 'nanoERG', totals: {setoffs_applied: 47, cleared: 104_475_000}}};
function openPage({reads = READS, reduce = false, status = 200} = {}) {
  const body = readBody(pub('home.html')), live = new Map(), fetched = [];
  let n = 0;
  body.all('canvas').find(e => e.id === 'sky').getContext = () => null;   // no 2D context here: nothing is drawn
  const doc = runNetworkPage(pub('home.js'), body, async p => {
    fetched.push(p);
    return status === 200 && reads[p] ? {ok: true, status, json: async () => structuredClone(reads[p])} : {ok: false, status: status === 200 ? 404 : status, json: async () => ({})};
  }, {setTimeout: (fn, ms) => { live.set(++n, {fn, ms}); return n; },
    globals: {clearTimeout: id => { live.delete(id); }, navigator: {clipboard: {writeText: async () => {}}},
      window: reduce ? {matchMedia: q => ({matches: /reduce/.test(q), addEventListener() {}})} : {}}});
  const $ = id => body.all('*').find(e => e.id === id);
  // The timers the page has set and not cleared, by delay; run(ms): fire the one with that delay.
  const pending = () => [...live.values()].map(t => t.ms).sort((a, b) => a - b);
  const run = ms => { const [id, t] = [...live.entries()].find(([, x]) => x.ms === ms); live.delete(id); return t.fn(); };
  return {body, doc, $, pending, run, fetched};
}
const meta = el => el.children.map(c => [c.className, c.textContent]);

test('the live view on the page: one IOU at a time in words, with who runs each; the latest as a list; the counts and the newest loop', async () => {
  const {$, body, pending} = openPage();
  await settle();
  assert.equal($('sky-ctl').hidden, false, 'the controls, shown once a read answered (hidden in the HTML)');
  assert.equal($('sky-legend').hidden, false);
  assert.equal($('sky-tag').hidden, false, 'Live, once a read answered');
  assert.deepEqual([$('sky-tag').textContent, $('sky-tag').className], ['Live', 'tag live']);
  assert.match($('sky-read').textContent, /^Testnet records, one real IOU at a time, read \d\d:\d\d UTC$/, 'what it reads, and when');
  // The spotlight: the newest open IOU first.
  assert.equal($('spot').textContent, "house-scribe holds sandbox-exact's IOU for 0.004 tERG.");
  assert.deepEqual(meta($('spot-meta')), [['role', 'holder'], ['tag operator', 'operator-run'], ['role', 'issuer'], ['tag operator', 'operator-run'], ['when', 'Passed on, 5 min ago']]);
  assert.equal($('spot-meta').textContent, 'holder operator-run issuer operator-run Passed on, 5 min ago', 'its parts read apart');
  // Next steps through the latest, and round again; each press says the new one in the status line (role=status), and
  // nothing else does.
  assert.equal($('sky-said').getAttribute('role'), 'status');
  assert.equal($('sky-said').textContent, '', 'nothing said before the reader asks');
  $('sky-next').click();
  assert.equal($('spot').textContent, "basis-x-1 holds ana-tester's IOU for 0.0015 tERG.");
  assert.equal($('sky-said').textContent, "IOU 2 of 3: basis-x-1 holds ana-tester's IOU for 0.0015 tERG.");
  assert.deepEqual(meta($('spot-meta')), [['role', 'holder'], ['tag team', 'team test'], ['when', 'A loop cleared part of it, 2 h ago']], 'no label for an agent the record does not place');
  $('sky-next').click();
  assert.equal($('spot').textContent, "sandbox-exact holds basis-x-1's IOU for 0.003 tERG.");
  assert.deepEqual(meta($('spot-meta')), [['role', 'holder'], ['tag operator', 'operator-run'], ['role', 'issuer'], ['tag team', 'team test'], ['when', 'New IOU, 1 d ago']]);
  $('sky-next').click();
  assert.equal($('spot').textContent, "house-scribe holds sandbox-exact's IOU for 0.004 tERG.");
  assert.equal($('sky-next').getAttribute('aria-label'), 'Next IOU');
  // The same as a list: issuer to holder (the arrow read as "owes"), each linked to its agent page, what is still owed,
  // and its last change. A closed IOU (nothing outstanding) is not listed.
  const rows = $('latest').children;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(li => li.querySelector('.pair').textContent),
    ['sandbox-exact operator-run →  owes house-scribe operator-run', 'ana-tester →  owes basis-x-1 team test', 'basis-x-1 team test →  owes sandbox-exact operator-run']);
  assert.deepEqual(rows.map(li => li.querySelector('.amt').textContent), ['0.004 tERG', '0.0015 tERG', '0.003 tERG']);
  assert.deepEqual(rows.map(li => li.querySelector('.how').textContent), ['Passed on, 5 min ago', 'A loop cleared part of it, 2 h ago', 'New IOU, 1 d ago']);
  assert.deepEqual(rows[0].querySelectorAll('a').map(a => a.href), ['/agent/sandbox-exact', '/agent/house-scribe']);
  assert.equal(rows[0].querySelector('.arw').getAttribute('aria-hidden'), 'true');
  assert.equal($('stats').textContent, '6 agents and 3 open IOUs now. 47 loops cleared so far, cutting 0.104 tERG of IOUs in all.');
  assert.equal($('sky-loop').textContent, 'The newest loop that cleared, with the rainbow ring: sandbox-exact → sandbox-mallory → sandbox-exact, 0.001 tERG off each IOU in it, 10 min ago (its loop card).');
  assert.doesNotMatch(body.textContent, /\bcredits\b|nanoERG|\d{1,3}(,\d{3})+ tERG/, 'tERG, rounded, in words');
  // It reads again in a minute, and the spotlight moves on in 8 s.
  assert.deepEqual(pending(), [home.SPOT_MS, home.REFRESH_MS]);
});

// Fix inbox #141: the list linked every handle, and an agent the operator unlisted has no page (its link was a 404). A
// handle is linked only when the directory lists it and the operator has not unlisted it; otherwise, and for a handle
// the last directory read did not name, it is text, as on /network.
test('the latest list links only agents that have a page: an unlisted one, or one the directory has not named yet, is named as text', async () => {
  assert.deepEqual([...home.pageHandles(READS['/pilot/v1/participants?all=1'])].sort(), ['ana-tester', 'basis-x-1', 'house-scribe', 'sandbox-exact', 'sandbox-mallory']);
  assert.deepEqual([...home.pageHandles({participants: [{handle: 'ok-one'}, {handle: 'Not A Handle'}, {handle: 'gone-one', unlisted: true}, null]})], ['ok-one']);
  assert.equal(home.pageHandles(null).size, 0);
  const notes = [...READS['/pilot/v1/ledger'].notes,
    {issuer_handle: 'tn-hidden', recipient_handle: 'house-scribe', outstanding: 5_000_000, timestamp: (S - 20) * 1000 + 997},
    {issuer_handle: 'brand-new-1', recipient_handle: 'sandbox-exact', outstanding: 2_000_000, timestamp: (S - 10) * 1000 + 997}];
  const {$} = openPage({reads: {...READS, '/pilot/v1/ledger': {unit: 'nanoERG', notes}}});
  await settle();
  const rows = $('latest').children;
  assert.deepEqual(rows.slice(0, 2).map(li => li.querySelector('.pair').textContent),
    ['brand-new-1 →  owes sandbox-exact operator-run', 'tn-hidden team test →  owes house-scribe operator-run']);
  assert.deepEqual(rows.slice(0, 3).map(li => [li.querySelectorAll('.pair a').map(a => a.href), li.querySelectorAll('.pair .h').map(s => s.textContent)]), [
    [['/agent/sandbox-exact'], ['brand-new-1']],
    [['/agent/house-scribe'], ['tn-hidden']],
    [['/agent/sandbox-exact', '/agent/house-scribe'], []]]);
  assert.ok(rows.every(li => li.querySelectorAll('a').every(a => !/tn-hidden|brand-new-1/.test(a.href))), 'no link to an agent without a page');
});

test('Pause stops the spotlight and the reads; Resume starts them again; the spotlight moves on by itself; the directory is read at most once in 5 minutes', async () => {
  const {$, pending, run, fetched} = openPage();
  await settle();
  assert.deepEqual(fetched.sort(), ['/pilot/v1/clearing', '/pilot/v1/ledger', '/pilot/v1/loops', '/pilot/v1/participants?all=1']);
  // The spotlight moves on by itself, and sets its next move.
  run(home.SPOT_MS);
  assert.equal($('spot').textContent, "basis-x-1 holds ana-tester's IOU for 0.0015 tERG.");
  assert.deepEqual(pending(), [home.SPOT_MS, home.REFRESH_MS]);
  // Pause: nothing moves and nothing is read; the label and the tag say so (no Live tag over a paused view). Next still
  // steps.
  $('sky-pause').click();
  assert.equal($('sky-pause').textContent, 'Resume');
  assert.match($('sky-read').textContent, /^Testnet records, one real IOU at a time, read \d\d:\d\d UTC$/);
  assert.deepEqual([$('sky-tag').hidden, $('sky-tag').textContent, $('sky-tag').className], [false, 'Paused', 'tag']);
  assert.doesNotMatch($('sky-read').textContent, /Paused/, 'Paused once, in the tag');
  assert.deepEqual(pending(), []);
  $('sky-next').click();
  assert.equal($('spot').textContent, "sandbox-exact holds basis-x-1's IOU for 0.003 tERG.");
  assert.deepEqual(pending(), [], 'paused: Next sets no timer');
  // Resume: the last read is recent, so the next one is a minute away again.
  $('sky-pause').click();
  assert.equal($('sky-pause').textContent, 'Pause');
  assert.match($('sky-read').textContent, /^Testnet records, one real IOU at a time, read \d\d:\d\d UTC$/);
  assert.deepEqual([$('sky-tag').textContent, $('sky-tag').className], ['Live', 'tag live']);
  assert.deepEqual(pending(), [home.SPOT_MS, home.REFRESH_MS]);
  // The next read: the ledger, the loops and the counts, not the directory (read less than 5 minutes ago). The spotlight
  // stays on the IOU it was showing.
  fetched.length = 0;
  await run(home.REFRESH_MS);
  await settle();
  assert.deepEqual(fetched.sort(), ['/pilot/v1/clearing', '/pilot/v1/ledger', '/pilot/v1/loops']);
  assert.equal($('spot').textContent, "sandbox-exact holds basis-x-1's IOU for 0.003 tERG.");
  assert.deepEqual(pending(), [home.SPOT_MS, home.REFRESH_MS]);
});

test('reduced motion: the spotlight moves only when asked (Next); the reads go on', async () => {
  const {$, pending} = openPage({reduce: true});
  await settle();
  assert.equal($('spot').textContent, "house-scribe holds sandbox-exact's IOU for 0.004 tERG.");
  assert.deepEqual(pending(), [home.REFRESH_MS], 'no spotlight timer');
  $('sky-next').click();
  assert.equal($('spot').textContent, "basis-x-1 holds ana-tester's IOU for 0.0015 tERG.");
  assert.deepEqual(pending(), [home.REFRESH_MS]);
});

test('when the network cannot be read: the view says so, keeps no stale claim, and tries again later', async () => {
  const {$, pending} = openPage({status: 503});
  await settle();
  assert.equal($('sky-read').textContent, 'Testnet records: cannot be read right now');
  assert.equal($('spot').textContent, 'The network cannot be read right now. Trying again soon.');
  assert.equal($('stats').textContent, 'The network cannot be read right now; the page tries again soon.');
  assert.equal($('latest').textContent, 'The ledger cannot be read right now.');
  assert.deepEqual([$('sky-tag').hidden, $('sky-ctl').hidden], [true, true], 'no Live tag, and no Pause or Next over the placeholder');
  assert.deepEqual(pending(), [2 * home.REFRESH_MS], 'after a failed read, twice as long');
  // A read that fails after one that answered: what is shown stays that read's, and the label says it is retrying; the
  // tag says Offline, not Live.
  const reads = {...READS}, later = openPage({reads});
  await settle();
  for (const k of Object.keys(reads)) delete reads[k];
  await later.run(home.REFRESH_MS);
  await settle();
  assert.match(later.$('sky-read').textContent, /^Testnet records, one real IOU at a time, read \d\d:\d\d UTC \(retrying\)$/);
  assert.deepEqual([later.$('sky-tag').hidden, later.$('sky-tag').textContent, later.$('sky-tag').className], [false, 'Offline', 'tag']);
  assert.equal(later.$('sky-ctl').hidden, false, 'Next still steps through what was read');
  assert.equal(later.$('spot').textContent, "house-scribe holds sandbox-exact's IOU for 0.004 tERG.");
  assert.deepEqual(later.pending(), [home.SPOT_MS, 2 * home.REFRESH_MS]);
  // An empty ledger: said plainly.
  const empty = openPage({reads: {...READS, '/pilot/v1/ledger': {unit: 'nanoERG', notes: []}}});
  await settle();
  assert.equal(empty.$('spot').textContent, 'No open IOUs right now.');
  assert.equal(empty.$('spot-meta').children.length, 0);
});

test('home.css builds on site.css: loaded after it, and redefining none of its tokens or components', () => {
  const html = pub('home.html');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site.css', '/home.css', '/story.css']);
  const site = new Set(cssRules(pub('site.css')).map(r => r.selector)), own = cssRules(pub('home.css'));
  assert.ok(own.length > 40);
  for (const r of own) assert.ok(!site.has(r.selector), `home.css redefines site.css's ${r.selector}`);
  assert.doesNotMatch(pub('home.css'), /@font-face|:root|(?:^|[;{\s])--[a-z-]+\s*:/, 'no fonts or tokens of its own');
  // Its colors are site.css's tokens (and the operator's amber in the key's swatch, which is --work).
  assert.doesNotMatch(pub('home.css'), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colors by token only');
  // Nothing animates in CSS; the sphere's motion is the script's, and it honours reduced motion (site.css stops the rest).
  assert.doesNotMatch(pub('home.css'), /animation|transition/);
  // Touch targets: the view's controls, the text links of each section.
  const rule = sel => own.find(r => r.selector === sel && !r.media)?.decls ?? {};
  for (const sel of ['.ctl', '.go a', '.inspect a']) assert.equal(rule(sel)['min-height'], '44px', sel);
  // The small mono labels (Pause and Next, the key, You get, Tested so far) stay at 12 px or more: site.css's floor,
  // which page rules at 0.72rem used to undo.
  for (const r of own) for (const [k, v] of Object.entries(r.decls)) if (/^font(?:-size)?$/.test(k))
    for (const [, n] of v.matchAll(/(\d*\.?\d+)rem/g)) assert.ok(Number(n) >= 0.75, `${r.selector}: ${v}`);
  // The headline's second line in the secondary ink; forced colors keep the sphere's own dark field.
  assert.equal(Object.assign({}, ...own.filter(r => r.selector === '.hero h1 .h1b' && !r.media).map(r => r.decls)).color, 'var(--dust)');
  assert.deepEqual(own.filter(r => r.media === '(forced-colors: active)').map(r => [r.selector, r.decls['forced-color-adjust']]), [['.sky-box', 'none'], ['.sky-key svg', 'none']]);
  // Phones (360 x 640, 375 x 667): the two-line headline, the lede and both calls to action on the first screen.
  const phone = sel => own.find(r => r.selector === sel && r.media === '(max-width: 480px)')?.decls ?? {};
  assert.equal(phone('.hero h1')['font-size'], 'clamp(1.85rem, 8.4vw, 4rem)');
  assert.equal(phone('.hero .lede')['font-size'], '1.05rem');
});

// Inline code never breaks inside a flag, a handle or a placeholder (lib/code-words.mjs; the lead's decision on inline
// code in fix round 2): a browser may end a line after any hyphen, and "--" at a line's end with "sandbox" on the next,
// or "-" then "-owner-token-file", reads as another command. Each word of inline code with a hyphen is a span.nw
// (site.css: white-space: nowrap); a path or URL too long for a phone's line may break after a / or \ and before a
// placeholder in capitals, never inside one, and never pushes the page sideways.
test('inline code keeps its flags, handles and placeholders whole, and breaks only between its words (lib/code-words.mjs)', async () => {
  const {codeWords, keepCodeWhole, WHOLE_MAX, PAGES} = await import('../lib/code-words.mjs');
  assert.equal(codeWords('--sandbox'), '<span class="nw">--sandbox</span>');
  assert.equal(codeWords('valun --profile testnet mcp'), 'valun <span class="nw">--profile</span> testnet mcp');
  assert.equal(codeWords('uvx --from valun==0.7.1 valun'), 'uvx <span class="nw">--from</span> valun==0.7.1 valun');
  assert.equal(WHOLE_MAX, 24, 'a handle is at most 24 characters (lib/pilot: ^[a-z][a-z0-9_-]{2,23}$)');
  for (const w of ['claude-live-1', 'client-prompt', '--owner-token-file', '/agent/YOUR-HANDLE', '~/valun-owner-token.txt', `${'a'.repeat(20)}-bcd`])
    assert.equal(codeWords(w), `<span class="nw">${w}</span>`, w);
  // A long path or URL: it may break after a / or \ and before a placeholder in capitals, never inside YOUR-HANDLE.
  assert.equal(codeWords('~/valun-owner-token-YOUR-HANDLE.txt'), '~/<wbr><span class="nw">valun-owner-token-</span><wbr><span class="nw">YOUR-HANDLE.txt</span>');
  assert.equal(codeWords('"$HOME/valun-owner-token-YOUR-HANDLE.txt"'), '"$HOME/<wbr><span class="nw">valun-owner-token-</span><wbr><span class="nw">YOUR-HANDLE.txt"</span>');
  assert.equal(codeWords('%USERPROFILE%\\valun-owner-token-YOUR-HANDLE.txt'), '%USERPROFILE%\\<wbr><span class="nw">valun-owner-token-</span><wbr><span class="nw">YOUR-HANDLE.txt</span>');
  assert.equal(codeWords('https://valun.tech/agent/YOUR-HANDLE'), 'https://valun.tech/<wbr>agent/<wbr><span class="nw">YOUR-HANDLE</span>');
  // a browser breaks after a / only where told: a long path without a hyphen gets the same points (never after a
  // leading / nor inside https://)
  assert.equal(codeWords('~/.openclaw/skills/valun/SKILL.md'), '~/<wbr>.openclaw/<wbr>skills/<wbr>valun/<wbr>SKILL.md');
  assert.equal(codeWords('/pilot/v1/participants/{id}'), '/pilot/<wbr>v1/<wbr>participants/<wbr>{id}');
  // Words without a hyphen, character references and the source's own line breaks stay as they are; a piece longer
  // than WHOLE_MAX breaks as it would anyway.
  for (const w of ['valun audit', 'GET /pilot/v1/ledger', '/agent/&lt;handle&gt;', 'valun==0.7.1', `${'a'.repeat(21)}-bcd`]) assert.equal(codeWords(w), w);
  assert.equal(codeWords('--owner-token-file\n  "$HOME/x"'), '<span class="nw">--owner-token-file</span>\n  "$HOME/x"');
  // A page: inline code only (a <pre> block keeps its text), code with markup of its own left alone; idempotent; and what
  // a reader sees or copies is unchanged.
  const page = '<p>Add <code>--approvals console</code>.</p><pre><code id="c">uvx --from valun==0.7.1 valun</code></pre><p><code><a href="/x">a-b</a></code></p>';
  const kept = keepCodeWhole(page);
  assert.equal(kept, '<p>Add <code><span class="nw">--approvals</span> console</code>.</p><pre><code id="c">uvx --from valun==0.7.1 valun</code></pre><p><code><a href="/x">a-b</a></code></p>');
  assert.equal(keepCodeWhole(kept), kept);
  assert.equal(kept.replace(/<span class="nw">|<\/span>|<wbr>/g, ''), page);
  // The static pages are written so (node scripts/code-words.mjs), and site.css keeps the words whole.
  for (const f of ['home.html', 'story-fragment.html', 'memory.html']) {
    assert.ok(PAGES.includes(f), f);
    assert.equal(keepCodeWhole(pub(f)), pub(f), `${f}: run node scripts/code-words.mjs`);
  }
  assert.ok(cssRules(pub('site.css')).some(r => r.selector === 'code .nw' && r.decls['white-space'] === 'nowrap' && !r.media), 'site.css: code .nw { white-space: nowrap; }');
  const home = pub('home.html').replace(/<pre\b[\s\S]*?<\/pre>/g, '');
  assert.ok((home.match(/<span class="nw">/g) ?? []).length >= 7, 'the handles, flags and the token file of the home');
  for (const [, inner] of home.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/g))
    for (const w of inner.replace(/<span class="nw">[^<]*<\/span>/g, ' ').replace(/<wbr>/g, ' ').split(/\s+/)) assert.ok(!w.includes('-'), `a hyphen left breakable in <code>${inner}</code>`);
});
