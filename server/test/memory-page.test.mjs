// The memory page (/memory): its static routes and the report it shows (/evidence-attacks.json), the page's CSP
// compliance (no inline script, style or handler; same-origin public reads only; text, never markup), the report being
// current with the evidence code (scripts/evidence-attacks.mjs --check), and public/memory.js rendering the evidence
// totals and the attacks table on a minimal DOM (test/console-dom.mjs), in credits and in tERG.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHandler} from '../lib/http.mjs';
import {Element, Text, Node, settle, text} from './console-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
let server, base;
before(async () => {
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('/memory, its script, its style and the attacks report are served with their types and the security headers', async () => {
  for (const [route, file, type] of [['/memory', 'memory.html', 'text/html; charset=utf-8'], ['/memory.js', 'memory.js', 'text/javascript; charset=utf-8'],
    ['/memory.css', 'memory.css', 'text/css; charset=utf-8'], ['/evidence-attacks.json', 'evidence-attacks.json', 'application/json; charset=utf-8']]) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    assert.equal(r.headers.get('content-type'), type, route);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'; connect-src 'self'/, route);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', route);
    assert.equal(await r.text(), pub(file), route);
  }
  for (const route of ['/memory.html', '/memory/x', '/evidence-attacks.md']) assert.equal((await fetch(base + route)).status, 404, route);
});

test('the page keeps the CSP and says what it cannot show: its own files only, text not markup, no claim of credit granted', () => {
  const html = pub('memory.html'), js = pub('memory.js');
  for (const m of html.matchAll(/<script\b[^>]*>/g)) assert.match(m[0], /\ssrc="\/memory\.js"/, 'every script is the page\'s own file');
  assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i, 'no inline style or event handler');
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]), ['/home.css', '/memory.css']);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|authorization|bearer|x-valun|localStorage|sessionStorage/i);
  assert.deepEqual([...js.matchAll(/getJson\('([^']+)'\)/g)].map(m => m[1]).sort(), ['/evidence-attacks.json', '/pilot/v1/evidence']);
  // The honest parts are on the page, not only in the report.
  for (const s of ['A hypothesis, tested in public', 'What the record cannot show', 'Who is independent.', 'That accepting is repaying.', 'None of the rules is built into Valun',
    'built: guarantees', 'not a score', 'Most of this is our own test agents']) assert.ok(html.includes(s), s);
  assert.doesNotMatch(html, /nobody else|no agent can|guarantee[sd]? (your|repayment)/i);
});

test('the attacks report is current with the evidence code (scripts/evidence-attacks.mjs --check)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'evidence-attacks.mjs'), '--check'], {cwd: root, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const x = JSON.parse(pub('evidence-attacks.json'));
  assert.deepEqual(x.scenarios.map(s => s.id), ['honest_trio', 'honest_newcomer', 'staged_circle', 'staged_circle_opened', 'identity_reset', 'slow_burn']);
  const by = Object.fromEntries(x.scenarios.map(s => [s.id, s]));
  // What the report rests on: the honest trio and the opened staged circle are taken alike by every candidate rule, and
  // the box caps the slow burn whatever its record.
  for (const p of x.policies) assert.equal(by.honest_trio.policies[p.id].accepts, by.staged_circle_opened.policies[p.id].accepts, p.id);
  for (const p of x.policies) assert.ok(by.slow_burn.policies[p.id].takeable_PC <= x.inputs.box.max_issue_outstanding, p.id);
  assert.equal(by.honest_newcomer.policies.settled.accepts, false);
  assert.equal(by.identity_reset.policies.settled.accepts, false);
});

function page() {
  const body = new Element('body');
  const E = (tag, attrs = {}, ...kids) => { const e = new Element(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; };
  const card = (cls, big, d) => E('article', {class: `card ${cls}`}, E('p', {class: 'big', id: big}, '–'), E('p', {class: 'card-u'}, 'unit'), E('p', {class: 'card-d', id: d}, '–'));
  body.append(E('span', {id: 'live'}, '· live'), card('c-del', 'del-n', 'del-d'), card('c-rep', 'rep-pct', 'rep-d'), card('c-acc', 'acc-n', 'acc-d'), E('p', {id: 'groups'}),
    E('table', {}, E('thead', {id: 'atk-head'}), E('tbody', {id: 'atk-body'}, E('tr', {}, E('td', {class: 'empty'}, 'Loading…')))), E('p', {id: 'earned'}), E('ol', {id: 'findings'}));
  return {body, createElement: t => new Element(t), createTextNode: t => new Text(t), querySelector: s => body.querySelector(s), getElementById: id => body.querySelector(`#${id}`)};
}
async function render(evidence, n) {
  const doc = page(), timers = [];
  Object.assign(globalThis, {document: doc, Node, Text, Element});
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (f, ms) => { timers.push(ms); return 0; };
  globalThis.fetch = async p => (p === '/pilot/v1/evidence' ? {ok: true, json: async () => evidence} : p === '/evidence-attacks.json' ? {ok: true, json: async () => JSON.parse(pub('evidence-attacks.json'))} : {ok: false, status: 404});
  try { await import(pathToFileURL(path.join(root, 'public', 'memory.js')).href + `?n=${n}`); await settle(); } finally { globalThis.setInterval = realInterval; }
  return {doc, timers, $: id => doc.getElementById(id)};
}
const TOTALS = {unit: 'PC', participants_with_exchanges: 4, delivery: {accepted: {count: 5, PC: 10}, paid: {count: 4, PC: 7}, disputed: 1, not_delivered: 0},
  repayment: {owed_ever_PC: 5, settled: {by_setoff_PC: 4}, settled_pct: 80, outstanding_PC: 1, unpaid_accepted_work: {count: 1, PC: 3}},
  acceptance: {taken_by_transfer: {count: 1, PC: 2}}, groups: {count: 2, anchored: 1, self_serve_only: 1, largest: 4, self_serve_only_sizes: [3]}};

test('memory.js renders the three kinds, the groups and the attacks table, as text', async () => {
  const {$, timers} = await render(TOTALS, 1);
  assert.equal(text($('del-n')), '5');
  assert.equal(text($('del-d')), '10 credits · 1 disputed · 0 not delivered');
  assert.equal(text($('rep-pct')), '80%');
  assert.equal(text($('rep-d')), '4 of 5 credits, cancelled in loops · 1 credit outstanding · 1 accepted and unpaid');
  assert.equal(text($('acc-n')), '2');
  assert.equal(text($('acc-d')), '1 time, someone took an IOU from a party it never dealt with');
  assert.match(text($('groups')), /^4 participants with exchanges, in 2 groups \(the largest has 4\)\. 1 group has no invited or operator-run member: what a staged circle looks like/);
  assert.equal($('live').className, 'on');
  const x = JSON.parse(pub('evidence-attacks.json'));
  assert.equal($('atk-head').childNodes[0].childNodes.length, x.policies.length + 1);
  assert.equal($('atk-body').childNodes.length, x.scenarios.length);
  const staged = $('atk-body').childNodes.find(tr => text(tr).startsWith('A staged circleattack'));
  assert.ok(staged, 'the staged circle row, tagged attack');
  assert.equal(staged.className, 'attack');
  assert.match(text($('earned')), /about \d[\d,]* credits a day to each identity's limit, for nothing\. So Valun grants no credit from evidence/);
  assert.equal($('findings').childNodes.length, 5);
  assert.deepEqual(timers, [60_000], 'it refreshes the totals once a minute');
});

test('on the testnet the amounts are tERG', async () => {
  const tn = {...TOTALS, unit: 'nanoERG', delivery: {...TOTALS.delivery, accepted: {count: 5, PC: 10_000_000}}, acceptance: {taken_by_transfer: {count: 1, PC: 2_000_000}},
    repayment: {...TOTALS.repayment, owed_ever_PC: 5_000_000, settled: {by_setoff_PC: 3_000_000, by_redemption_PC: 1_000_000}, outstanding_PC: 1_000_000}};
  const {$, doc} = await render(tn, 2);
  assert.equal(text($('del-d')), '0.01 tERG · 1 disputed · 0 not delivered');
  assert.equal(text($('acc-n')), '0.002');
  assert.equal(text(doc.querySelector('.c-acc .card-u')), 'tERG of IOUs taken by transfer');
  assert.equal(text($('rep-d')), '0.004 of 0.005 tERG, cancelled in loops or redeemed on chain · 0.001 tERG outstanding · 1 accepted and unpaid');
});
