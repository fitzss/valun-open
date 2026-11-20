// The worked example on the home page: public/story-fragment.html (the markup of home.html's <section id="how">, between
// its STORY:BEGIN and STORY:END markers once pasted there), public/story.css and public/story.js. An illustration with
// made-up agents (Ana, Bo, Cy) in five steps, then the same moves in the live records (claude-live-1's run of Nov 16).
// Once home.html carries the markers, the story is checked there, as it is served, and story-fragment.html, while it is
// still in the repository, must be the same text. The markup is read as text and through test/network-dom.mjs's small
// HTML reader; story.js runs on that reader's elements (test/console-dom.mjs). Not a browser: no layout, no cascade.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readBody, Element} from './network-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const exists = f => fs.existsSync(path.join(root, 'public', f));
const MARKS = /<!-- STORY:BEGIN -->([\s\S]*?)<!-- STORY:END -->/;
const inHome = MARKS.exec(pub('home.html'));
const fragment = exists('story-fragment.html') ? pub('story-fragment.html') : null;
const story = (inHome ? inHome[1] : fragment ?? '').trim();
const css = pub('story.css'), js = pub('story.js');
const text = n => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();
const num = s => Number(String(s).replace('−', '-'));
const page = () => readBody(`<body>${story}</body>`);

// What the live records said (GET https://valun.tech/pilot/v1/loops/<id>, read 2026-11-17 01:56 and 02:42 UTC, build 09875a4).
const TX = 'f2a146cf387f7c95a9d95b6c772e04069ae34c6a5cd994d29d6feaf5981fe455';
const LOOPS = {
  vs_4f8d53475c9e591a: {members: ['sandbox-mallory', 'claude-live-1', 'sandbox-exact'], each: 1_000_000, amount: 3_000_000},
  vs_f8254530b0cf5e5d: {members: ['claude-live-1', 'sandbox-exact'], each: 1_000_000, amount: 2_000_000},
};

test('the story is in one place: home.html between its markers (once pasted), the same as story-fragment.html', () => {
  assert.ok(story.length > 1000, 'the story markup');
  if (inHome && fragment !== null) assert.equal(inHome[1].trim(), fragment.trim(), 'home.html and story-fragment.html: the same story');
  assert.ok(story.startsWith('<h2 id="how-title">'), 'it opens with the section heading that <section id="how"> names');
});

// ---- the markup ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SVG_EMPTY = new Set(['path', 'line', 'circle', 'rect', 'stop', 'polygon', 'polyline', 'ellipse', 'use']);
const BLOCK = new Set(['div', 'p', 'ul', 'ol', 'li', 'table', 'dl', 'h1', 'h2', 'h3', 'h4', 'figure', 'aside', 'section', 'pre']);
const PARENT = {li: ['ol', 'ul'], tr: ['thead', 'tbody'], td: ['tr'], th: ['tr'], caption: ['table'], thead: ['table'], tbody: ['table'], dt: ['div', 'dl'], dd: ['div', 'dl']};
function wellFormed(html) {
  const problems = [], stack = [], ids = [];
  const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[a-zA-Z_:][\w:.-]*(?:="[^"<>]*")?)*)\s*(\/?)>/g;
  let last = 0, m;
  const textOk = t => { if (/[<>]/.test(t)) problems.push(`a stray < or > in text: ${t.slice(0, 60)}`); if (/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/i.test(t)) problems.push(`an unescaped &: ${t.slice(0, 60)}`); };
  while ((m = TAG.exec(html))) {
    textOk(html.slice(last, m.index)); last = TAG.lastIndex;
    const [all, close, tagName, attrs, self] = m;
    if (all.startsWith('<!--')) continue;
    const tag = tagName.toLowerCase();
    if (close) {
      if (VOID.has(tag)) problems.push(`</${tag}> closes a void element`);
      const top = stack.pop();
      if (top !== tag) { problems.push(`</${tag}> where </${top}> was due`); break; }
      continue;
    }
    for (const [, k, v] of attrs.matchAll(/\s([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)) if (k === 'id') ids.push(v);
    const parent = stack.at(-1);
    if (PARENT[tag] && !PARENT[tag].includes(parent)) problems.push(`<${tag}> inside <${parent}>`);
    if (parent === 'p' && BLOCK.has(tag)) problems.push(`<${tag}> inside a <p>`);
    if (tag === 'a' && stack.includes('a')) problems.push('a link inside a link');
    if (self) { if (!SVG_EMPTY.has(tag)) problems.push(`<${tag} /> is not an empty SVG element`); continue; }
    if (!VOID.has(tag)) stack.push(tag);
  }
  textOk(html.slice(last));
  if (stack.length) problems.push(`left open: ${stack.join(' > ')}`);
  return {problems, ids};
}

test('the markup is well formed: every element closed in order, attributes quoted, ids unique, and every reference to an id met', () => {
  const {problems, ids} = wellFormed(story);
  assert.deepEqual(problems, []);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
  for (const id of ids) assert.match(id, /^(story(-[a-z0-9]+)*|how-title)$/, `${id}: the story's ids start with story- (the home page has others)`);
  const refs = [...story.matchAll(/aria-(?:describedby|labelledby)="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/))
    .concat([...story.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]), [...story.matchAll(/href="#([^"]+)"/g)].map(m => m[1]));
  assert.ok(refs.length >= 25, `${refs.length} references`);
  for (const r of refs) assert.ok(ids.includes(r), `#${r} is referenced but not defined`);
  // headings: the section's h2, then h3s; no h1 (the page has one)
  assert.equal((story.match(/<h1\b/g) ?? []).length, 0);
  assert.equal((story.match(/<h2\b/g) ?? []).length, 1);
  assert.equal(page().querySelectorAll('h3').length, 5 + 2 + 1, 'five steps, two asides, the live records');
});

test('the CSP holds: no inline style, script or handler, nothing loaded from outside; outside links only to the transaction and the real run\'s records on valun.tech', () => {
  assert.doesNotMatch(story, /<style\b|\sstyle=|<script\b|\son[a-z]+=|javascript:/i);
  assert.doesNotMatch(story, /<(?:img|iframe|object|embed|link|video|audio|source)\b|\ssrc=/i);
  const outside = [...story.matchAll(/href="(https?:[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(outside.filter(h => !h.startsWith('https://valun.tech/')), [`https://testnet.ergoplatform.com/en/transactions/${TX}`]);
  // The real run's records exist on valun.tech's testnet only (staging and a local preview run their own tracker, where
  // they are 404s), so their links name valun.tech.
  assert.deepEqual(outside.filter(h => h.startsWith('https://valun.tech/')).sort(),
    ['https://valun.tech/agent/claude-live-1', ...Object.keys(LOOPS).map(id => `https://valun.tech/loop/${id}`)].sort());
  for (const f of [css, js]) assert.doesNotMatch(f, /@import|url\(\s*['"]?(?:https?:|\/\/)|https?:\/\//i);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest|localStorage|sessionStorage|\.style\b|setAttribute\(\s*'style'/);
});

// ---- the labels ----
test('the example says it is one, in words: on its frame and in each picture\'s name, with names no agent can have', () => {
  const body = page(), frame = body.querySelector('.story');
  assert.equal(frame.getAttribute('data-story'), '', 'the stepper finds it by data-story');
  const label = frame.querySelector('.story-label .tag');
  assert.equal(text(label), 'Example: made-up agents, not live data');
  assert.ok(label.classList.contains('example'), 'site.css draws an example\'s tag dashed');
  const svgs = body.querySelectorAll('svg.story-svg');
  assert.equal(svgs.length, 5);
  svgs.forEach((s, i) => {
    assert.equal(s.getAttribute('role'), 'img');
    assert.match(s.getAttribute('aria-label'), new RegExp(`^Example, step ${i + 1} of 5: \\S`), 'the accessible name says it is an example');
    const d = s.querySelector(`desc#${s.getAttribute('aria-describedby')}`);
    assert.ok(d && text(d).length > 80, `step ${i + 1}: the picture described in words, inside it`);
  });
  // A handle is ^[a-z][a-z0-9_-]{2,23}$ (lib/pilot): the cast's capitalised, short names can never be a real agent's.
  for (const name of ['Ana', 'Bo', 'Cy']) assert.doesNotMatch(name, /^[a-z][a-z0-9_-]{2,23}$/);
  // the swatches of the key say nothing of their own: the words beside them do
  for (const s of body.querySelector('.story-key').querySelectorAll('svg')) assert.equal(s.getAttribute('aria-hidden'), 'true');
  assert.deepEqual(body.querySelector('.story-key').querySelectorAll('li').map(text), [
    'owes: the arrow points to the agent owed', 'work done: the arrow points to the client',
    'a note, with its issuer\'s name, beside the agent that holds it', 'a loop that cleared', '1 = 0.001 tERG, test coins with no monetary value']);
});

test('the live records are labelled for what they are: our own test agent and the operator\'s practice agents, no AI in the loops', () => {
  const real = page().querySelector('.story-real');
  const tag = real.querySelector('.story-label .tag');
  assert.ok(!tag.classList.contains('example'), 'a real run: a solid tag');
  assert.equal(text(tag), 'Real run on the testnet, Nov 16, 2026');
  const t = text(real);
  for (const s of ['our own test agent, claude-live-1 (a Claude session acting as a newcomer), with the operator\'s two practice agents',
    'The work in these loops was deterministic, not AI.']) assert.ok(t.includes(s), s);
  const cast = real.querySelector('.story-cast').querySelectorAll('li').map(li => [text(li.querySelector('code')), text(li.querySelector('.tag')), li.querySelector('.tag').className]);
  assert.deepEqual(cast, [['sandbox-exact', 'operator-run', 'tag operator'], ['claude-live-1', 'our test agent', 'tag team'], ['sandbox-mallory', 'operator-run', 'tag operator']]);
  assert.match(t, /sandbox-mallory operator-run practice agent, no AI, wrong on purpose about half the time/);
  assert.doesNotMatch(t, /\b(?:users?|community|customers?|adoption|partners?)\b/i, 'test agents are never presented as adoption');
});

// ---- the steps, their tables and their numbers ----
const STEP_TITLES = ['Ask and agree', 'Work, and pay with a note', 'Pass it on, if Cy accepts it', 'A loop forms', 'The loop clears'];
function readTable(t) {
  const head = t.querySelector('thead').querySelectorAll('th');
  assert.deepEqual(head.map(h => h.getAttribute('scope')), ['col', 'col', 'col']);
  assert.deepEqual(head.slice(1).map(text), ['Before', 'After']);
  return {caption: text(t.querySelector('caption')), first: text(head[0]), rows: t.querySelector('tbody').querySelectorAll('tr').map(tr => {
    const th = tr.querySelector('th'), td = tr.querySelectorAll('td');
    assert.equal(th.getAttribute('scope'), 'row');
    assert.equal(td.length, 2);
    return {who: text(th), before: td[0], after: td[1]};
  })};
}
const cellNum = td => num(td.childNodes.filter(n => !n.tagName).map(n => n.textContent).join('').trim());

test('five steps, each with its heading, its picture, its words and a before-and-after table with a caption; a step list that links them', () => {
  const body = page(), steps = body.querySelector('.story-steps').children;
  assert.equal(steps.length, 5);
  steps.forEach((s, i) => {
    assert.equal(s.id, `story-step-${i + 1}`);
    assert.equal(text(s.querySelector('h3 .story-step-name')), STEP_TITLES[i]);
    assert.equal(text(s.querySelector('h3 .story-n')), `Step ${i + 1}`);
    assert.ok(s.querySelector('figure svg.story-svg'), 'its picture');
    assert.ok(text(s.querySelector('.story-text')).length > 100, 'its words');
    const t = readTable(s.querySelector('table.story-table'));
    assert.equal(t.caption, `Who owes whom, before and after step ${i + 1}`);
    assert.equal(t.first, 'Who owes whom');
  });
  const links = body.querySelector('.story-track').querySelectorAll('a');
  assert.deepEqual(links.map(a => a.getAttribute('href')), [1, 2, 3, 4, 5].map(n => `#story-step-${n}`));
  assert.deepEqual(links.map(text), ['Step 1 Ask and agree', 'Step 2 Pay with a note', 'Step 3 Pass it on', 'Step 4 A loop forms', 'Step 5 The loop clears']);
  const nets = readTable(steps[4].querySelector('table.story-nets'));
  assert.equal(nets.caption, 'Net positions, before and after step 5');
});

test('the numbers agree: each table starts where the last ended, the loop falls by its smallest note, no net position moves, and every picture draws its table', () => {
  const steps = page().querySelector('.story-steps').children;
  let ledger = {};   // "Ana>Bo" -> what Ana owes Bo
  const nets = l => Object.fromEntries(['Ana', 'Bo', 'Cy'].map(w => [w, Object.entries(l).reduce((s, [k, v]) => {
    const [i, h] = k.split('>'); return s + (h === w ? v : 0) - (i === w ? v : 0);
  }, 0)]));
  const ledgers = [];
  steps.forEach((s, i) => {
    const before = {...ledger};
    for (const r of readTable(s.querySelector('table.story-table')).rows) {
      const m = /^(Ana|Bo|Cy) owes (Ana|Bo|Cy)$/.exec(r.who);
      assert.ok(m && m[1] !== m[2], r.who);
      const k = `${m[1]}>${m[2]}`;
      assert.equal(num(text(r.before)), ledger[k] ?? 0, `step ${i + 1}, ${r.who}: before is what the last step left`);
      ledger[k] = num(text(r.after));
      assert.ok(Number.isInteger(ledger[k]) && ledger[k] >= 0);
    }
    ledgers.push({before, after: {...ledger}});
    // the picture: every arrow of a debt is the table's; a faint one is a debt at 0; every IOU drawn is what its issuer owes its holder
    const svg = s.querySelector('svg.story-svg');
    for (const g of svg.querySelectorAll('g.story-owes')) {
      const k = `${g.getAttribute('data-from')}>${g.getAttribute('data-to')}`, a = num(g.getAttribute('data-amount'));
      assert.equal(a, ledger[k], `step ${i + 1}: the arrow ${k}`);
      assert.equal(g.classList.contains('is-faint'), a === 0, `step ${i + 1}: ${k} is faint exactly when nothing is owed`);
      const [owes, was] = g.querySelectorAll('text').map(text);
      assert.equal(owes, `owes ${a}`);
      if (was !== undefined) assert.equal(was, `was ${before[k]}`, `step ${i + 1}: ${k} was what the last step left`);
    }
    const drawn = new Set(svg.querySelectorAll('g.story-owes').map(g => `${g.getAttribute('data-from')}>${g.getAttribute('data-to')}`));
    for (const [k, v] of Object.entries(ledger)) if (v > 0) assert.ok(drawn.has(k), `step ${i + 1}: the debt ${k} is drawn`);
    for (const g of svg.querySelectorAll('g.story-ticket')) {
      const k = `${g.getAttribute('data-issuer')}>${g.getAttribute('data-holder')}`, a = num(g.getAttribute('data-amount'));
      const [name, amount] = g.querySelectorAll('text').map(text);
      assert.equal(name, `${g.getAttribute('data-issuer')}'s note`, 'the ticket carries its issuer\'s name');
      assert.equal(a, ledger[k] ?? 0, `step ${i + 1}: the note ${k}`);
      assert.equal(g.classList.contains('is-spent'), a === 0, `step ${i + 1}: ${k} is drawn spent exactly when it holds nothing`);
      const was = g.getAttribute('data-was');
      assert.equal(num(amount), was === null ? a : num(was), 'the ticket shows its amount, or where it was, what it had there');
      if (was !== null) assert.equal(num(was), before[k], `step ${i + 1}: the outline of ${k} shows what it held before`);
    }
    for (const [k, v] of Object.entries(ledger)) if (v > 0) assert.ok(svg.querySelectorAll('g.story-ticket').some(g => `${g.getAttribute('data-issuer')}>${g.getAttribute('data-holder')}` === k && !g.classList.contains('is-spent')), `step ${i + 1}: the note ${k} is drawn`);
  });
  // step 1 agrees and owes nothing; step 2 issues; step 3 passes Ana's IOU on (same issuer, new holder, same total)
  assert.deepEqual(ledgers[0].after, {'Ana>Bo': 0});
  assert.deepEqual(ledgers[1].after, {'Ana>Bo': 3});
  assert.deepEqual(ledgers[2].after, {'Ana>Bo': 0, 'Ana>Cy': 3});
  // step 4: a loop, Ana > Cy > Bo > Ana
  const L = ledgers[3].after, cycle = ['Ana>Cy', 'Cy>Bo', 'Bo>Ana'];
  for (const k of cycle) assert.ok(L[k] > 0, k);
  // step 5: each debt of the loop falls by the same amount, the smallest one; nobody's net position moves
  const drop = Math.min(...cycle.map(k => L[k]));
  assert.equal(drop, 2);
  for (const k of cycle) assert.equal(ledgers[4].after[k], L[k] - drop, k);
  assert.deepEqual(nets(ledgers[4].after), nets(ledgers[4].before), 'clearing moves no net position');
  assert.deepEqual(nets(ledgers[4].after), {Ana: -1, Bo: 0, Cy: 1});
  assert.equal(Object.values(nets(ledgers[4].after)).reduce((a, b) => a + b, 0), 0);
  // the net table, its breakdowns, and the picture's labels say the same
  const netRows = readTable(steps[4].querySelector('table.story-nets')).rows;
  const owedTo = (l, w) => Object.entries(l).reduce((s, [k, v]) => s + (k.split('>')[1] === w ? v : 0), 0);
  const owesOf = (l, w) => Object.entries(l).reduce((s, [k, v]) => s + (k.split('>')[0] === w ? v : 0), 0);
  assert.deepEqual(netRows.map(r => r.who), ['Ana', 'Bo', 'Cy']);
  for (const r of netRows) {
    for (const [cell, l] of [[r.before, ledgers[4].before], [r.after, ledgers[4].after]]) {
      assert.equal(cellNum(cell), nets(l)[r.who], `${r.who}'s net position`);
      assert.equal(text(cell.querySelector('.story-why')), `is owed ${owedTo(l, r.who)}, owes ${owesOf(l, r.who)}`);
    }
  }
  const svg5 = steps[4].querySelector('svg.story-svg');
  assert.deepEqual(svg5.querySelectorAll('.story-net').map(text), ['net −1', 'net 0', 'net +1']);
  assert.equal(text(svg5.querySelector('.story-ring-t')), `−${drop}`);
  assert.equal(svg5.querySelectorAll('.story-ring').length, 1, 'the rainbow: one ring, for the loop that cleared');
  assert.equal(story.match(/stroke="url\(#story-rb-/g).length, 2, 'the rainbow nowhere else (the other one is the key\'s swatch)');
  // and the words
  const words = steps.map(s => text(s.querySelector('.story-text')));
  assert.match(words[0], /Nothing is owed yet: agreeing isn't paying\./);
  assert.match(words[1], /pays with a note: a promise of 3, signed with Ana's key\. Bo now holds it, and Ana owes Bo 3\./);
  assert.match(words[2], /Now Ana owes Cy 3, though Cy never dealt with Ana/);
  assert.match(words[3], /so Cy owes Bo 2\. .* so Bo owes Ana 2\./);
  assert.match(words[4], /every note in the loop falls by the same amount, 2, the smallest one in it\. Ana now owes Cy 1/);
});

// ---- the claims ----
test('what it claims stays within what is true: passing on is conditional, clearing is committed and no more, backing is a promise, redemption needs a reserve', () => {
  const body = page(), t = text(body);
  // passing on needs the next agent's acceptance and the issuer's consent; another agent could refuse
  assert.ok(t.includes('This works only because Cy accepts Ana\'s notes and Ana consents to the move, within both sides\' limits. Another agent could refuse Ana\'s notes, and Bo would have to pay another way.'));
  // and what the testnet does by default: a self-serve join accepts any issuer's notes by transfer (lib/pilot/core.mjs
  // SANDBOX_CIRCULATION('any') on the open network), up to max_accept_per_issuer (SANDBOX_CAPS: test/home-page.test.mjs
  // checks the number), and valun 0.7.1's SANDBOX_CONSENT_POLICY signs as_new_creditor by itself in every approval mode,
  // and as_issuer the same way in the issuer's own client: each client signs only for its own key (the lead's D3b; it
  // read as if Cy's client signed Ana's consent)
  assert.ok(t.includes("On the testnet a new self-serve agent accepts any issuer's notes as payment by transfer, up to 0.04 tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way. Its owner can narrow whose notes it accepts under 'Accept notes from' in the owner console."));
  assert.doesNotMatch(t, /signs that consent, and the issuer's/);
  // a loop clears: what changes, what does not, no coins; committed by the next tracker box, as long as the key behaves
  // (moved here from the old home page's "How it works", fix inbox #85 and #100), in the one wording of the anchoring
  // wait every page uses (the lead's D7b: the muse run's measurements, and Ergo testnet's slow blocks since Nov 16)
  for (const s of ['What changes Those three notes, each by 2.',
    'What doesn\'t Anyone\'s net position (what it is owed minus what it owes), the work, which stays done, and the record. No coins move.',
    "The clearing is committed when the next tracker box on Ergo testnet commits it: usually 5 to 15 minutes; up to about 30 when Ergo testnet blocks are slow (as since late Nov 16); hours later once the day's cap of 50 tracker boxes is used up.",
    'It stays committed only as long as the tracker key never commits an earlier total again. The operator holds that key, and nothing on chain stops it.']) assert.ok(t.includes(s), s);
  // backing is a promise, not collateral, and paying a call is the backer's own act (lib/pilot/guarantees.mjs: within
  // honor_within_hours, or it is overdue); redemption only against the issuer's reserve, which the operator's key signs
  assert.ok(t.includes('A backer can promise to pay Ana\'s creditor, up to a cap, if Ana doesn\'t. It is a signed promise, not coins set aside. A backer that is called should pay with its own note, worth what the backer can and will pay; a call it leaves unpaid shows as overdue on its record.'));
  assert.ok(t.includes('Only if Ana posted a reserve of tERG on Ergo testnet, and only up to what the reserve holds. Most agents that owe have no reserve. The tracker key signs each redemption, so the operator can refuse one.'));
  // the open gap, with its condition: an earlier redemption build (lib/pilot/http.mjs: /redemption/submit checks a
  // built redemption again; a broadcast of one's own does not pass there)
  assert.ok(t.includes('One gap is still open: a holder that already got a redemption built (a dry run is enough) could, with a client it writes itself, redeem outside the server\'s checks; the documented 0.7.3 commands can\'t.'));
  // the words the copy rules keep out
  assert.doesNotMatch(t, /trustless|decentrali[sz]ed|revolutioni|limitless|agent economy|guaranteed|risk-free|seamless|\bfinal\b|irreversible|\bsettle|\bmoney\b|\bcredits?\b|debt is gone/i);
  assert.doesNotMatch(story.replace(/<circle\b/g, ''), /circle/i, 'no "circle" in the copy (it reads as the company Circle)');
  // amounts in prose are tERG only (as on the rest of the home page): the live records' 0.003, 0.002 and 0.001 tERG
  assert.doesNotMatch(t, /nanoERG/, 'no nanoERG in the story: prose names tERG');
  for (const a of ['a note of 0.003 tERG', '0.002 tERG of that note', 'Each note fell by 0.001 tERG']) assert.ok(t.includes(a), a);
  assert.ok(t.includes('1 = 0.001 tERG, test coins with no monetary value'));
});

test('the live records: the loops, amounts and transaction GET /pilot/v1/loops gave, and every link to a page the server serves', () => {
  const body = page(), real = body.querySelector('.story-real'), t = text(real);
  // the two loops and the transaction that committed both (on valun.tech, where these records are)
  for (const [id, loop] of Object.entries(LOOPS)) {
    assert.ok(real.querySelectorAll('a').some(a => a.getAttribute('href') === `https://valun.tech/loop/${id}` && text(a) === `loop ${id}`), id);
    assert.equal(loop.amount, loop.each * loop.members.length);
  }
  // which part the newcomer played, as the reader's agent does in the tour (valun 0.7.1 TOUR_GOALS: sandbox-exact pays
  // the new agent, which passes that IOU on to sandbox-mallory)
  assert.ok(t.includes('claude-live-1 played Bo\'s part, as your agent does in the tour.'));
  assert.ok(text(body.querySelector('.story-lede')).endsWith('Your agent could take any of the three parts: hire like Ana, work and get paid like Bo, or take a passed-on note like Cy. In the guided tour, it plays Bo.'));
  assert.ok(t.includes('Take the same tour: 2 to 3 minutes, with no wallet, no tERG and no AI model.'), 'the tour\'s length as every page gives it (fix inbox #124)');
  assert.ok(t.includes('sandbox-exact owed sandbox-mallory, sandbox-mallory owed claude-live-1, and claude-live-1 owed sandbox-exact'),
    'the 3-agent loop in its members\' order (vs_4f8d53475c9e591a: sandbox-mallory > claude-live-1 > sandbox-exact)');
  assert.ok(t.includes('Each note fell by 0.001 tERG'));
  assert.ok(t.includes('A two-agent loop between claude-live-1 and sandbox-exact had cleared a minute before'));
  assert.ok(t.includes('The loops cleared at 17:29 and 17:30 UTC, and the next tracker box on Ergo testnet committed both at 17:33 UTC'));
  const tx = real.querySelectorAll('a').find(a => a.getAttribute('href').includes(TX));
  assert.equal(text(tx), `transaction ${TX.slice(0, 8)}…${TX.slice(-4)}`);
  // the welcome job and the IOU passed on (the sandbox tour's fixed prices: valun 0.7.1 TOUR_GOALS 1 and 2)
  assert.ok(t.includes('claude-live-1 did sandbox-exact\'s welcome job (word counts and a hash), and sandbox-exact paid with a note of 0.003 tERG.'));
  assert.ok(t.includes('claude-live-1 paid sandbox-mallory for a job with 0.002 tERG of that note. sandbox-mallory accepts sandbox-exact\'s notes.'));
  // links: the server's own pages (its static map, or the loop and agent pages it renders), and anchors that exist
  const http = fs.readFileSync(path.join(root, 'lib', 'http.mjs'), 'utf8');
  const STATIC = new Set([...http.matchAll(/\[\s*'(\/[^']*)'\s*,\s*'[^']+'\s*\]/g)].map(m => m[1]));
  assert.ok(http.includes('/^\\/loop\\/([^/]{1,64})$/') && http.includes('/^\\/agent\\/([^/]{1,64})$/'), 'the server renders /loop/<id> and /agent/<handle>');
  const TRUST = ['who-runs-what', 'chain', 'netting', 'backing', 'redemption', 'check', 'not-proven'];   // the copy rules' /trust anchors
  const trustIds = [...pub('trust.html').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]).filter(id => TRUST.includes(id));
  const hrefs = [...story.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(hrefs.filter(h => h.startsWith('/')).sort(), ['/start#tour', '/trust#backing', '/trust#netting', '/trust#redemption']);
  assert.deepEqual(hrefs.filter(h => h.startsWith('https://valun.tech/')).sort(), ['https://valun.tech/agent/claude-live-1',
    'https://valun.tech/loop/vs_4f8d53475c9e591a', 'https://valun.tech/loop/vs_f8254530b0cf5e5d']);
  for (const h of hrefs.filter(x => x.startsWith('/') || x.startsWith('https://valun.tech/')).map(x => x.replace('https://valun.tech', ''))) {
    const [p, frag] = h.split('#');
    assert.ok(STATIC.has(p) || /^\/loop\/vs_[0-9a-f]{16}$/.test(p) || /^\/agent\/[a-z][a-z0-9_-]{2,23}$/.test(p), `${p}: a page the server serves`);
    if (p === '/trust') {
      assert.ok(TRUST.includes(frag), `/trust#${frag}: one of the copy rules' anchors`);
      if (trustIds.length) assert.ok(trustIds.includes(frag), `/trust#${frag}: the page has it`);
    }
    if (p === '/start') assert.match(pub('start.html'), new RegExp(`\\sid="${frag}"`), `/start#${frag}`);
  }
});

// ---- the stylesheet ----
test('story.css: it styles the story only, its pictures\' text stays readable on a phone, and it moves nothing under reduced motion', () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // every selector is within the story (its own story- classes), so it cannot change the rest of the home page
  for (const [, sel] of rules.matchAll(/(?:^|[{}])\s*([^{}@;]+?)\s*{/g)) {
    if (/^(from|to|\d+%)/.test(sel.trim())) continue;   // keyframes
    for (const s of sel.split(',')) assert.match(s.trim(), /\.story/, `${s.trim()}: a selector outside the story`);
  }
  for (const [, name] of rules.matchAll(/@keyframes\s+([\w-]+)/g)) assert.match(name, /^story-/);
  // SVG text is set in viewBox units (360 wide); on a 390px phone the picture is about 330px wide, so 14 units are
  // about 12.8px: nothing smaller
  for (const [, sel, body] of rules.matchAll(/([^{}]+){([^{}]*)}/g)) {
    if (!/\.story-svg|\.story-swatch/.test(sel)) continue;
    for (const [, px] of body.matchAll(/font(?:-size)?:[^;]*?(\d+(?:\.\d+)?)px/g)) assert.ok(Number(px) >= 14, `${sel.trim()}: ${px}px`);
  }
  assert.match(css, /\.story-svg text \{ font-family: var\(--mono\); font-size: 14px;/);
  // and the story's own small labels (What changes, the step numbers, the cast's parts) stay at 12 px or more
  for (const [, sel, body] of rules.matchAll(/([^{}]+){([^{}]*)}/g))
    for (const [, n] of body.matchAll(/font(?:-size)?:[^;]*?(\d*\.?\d+)rem/g)) assert.ok(Number(n) >= 0.75, `${sel.trim()}: ${n}rem`);
  // Forced colors (Windows high contrast) force a page's colors but not an SVG's fills and strokes: the pictures take the
  // system colors there, and the rainbow ring keeps its own.
  const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(rules)?.[1] ?? '';
  for (const k of ['fill: CanvasText', 'stroke: Canvas;', 'stroke: CanvasText', 'fill: Canvas;', 'GrayText', 'forced-color-adjust: none']) assert.ok(forced.includes(k), k);
  // the pager at the foot is hidden only where a step fits on the screen beside its picture: wide and tall (on a 1280 x
  // 720 laptop or at 1024 x 600 steps 3 and 5 are taller than the screen, and the reader had to scroll back up for Next)
  assert.match(rules, /@media \(min-width: 900px\) and \(min-height: 820px\) \{\s*\.story-pager\.is-end \{ display: none; \}\s*\}/);
  assert.doesNotMatch(rules, /@media \(min-width: 900px\) \{[^@]*\.story-pager\.is-end \{ display: none; \}/, 'never by width alone');
  // forced colours drop the current step's filled circle (a background): it takes the system's Highlight instead
  assert.match(forced, /\.story-track \[aria-current="step"\] \.story-n \{ forced-color-adjust: none; background: Highlight; border-color: Highlight; color: HighlightText; \}/);
  // motion only inside prefers-reduced-motion: no-preference (site.css stops everything under reduce besides)
  const outside = rules.replace(/@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '');
  assert.doesNotMatch(outside, /animation(?:-name)?\s*:/, 'no animation outside the no-preference block');
  assert.match(rules, /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*\.story-step\.is-entering/);
  // tokens from site.css, not new colors: the only literal colors are the rainbow's, in the markup
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'colors come from site.css\'s tokens');
});

// ---- the stepper ----
Element.prototype.after = function (...nodes) {
  const p = this.parentNode, i = p.childNodes.indexOf(this);
  for (const n of nodes) { if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter(c => c !== n); n.parentNode = p; }
  p.childNodes.splice(i + 1, 0, ...nodes);
};
Element.prototype.scrollIntoView = function (opts) { (this.scrolls ??= []).push(opts ?? {}); };
const {enhance} = await import(pathToFileURL(path.join(root, 'public', 'story.js')).href);
function stepper({hash = ''} = {}) {
  const body = page(), doc = {body, activeElement: null, createElement: t => new Element(t)};
  globalThis.document = doc;   // console-dom's focus() records document.activeElement there
  const r = body.querySelector('[data-story]'), api = enhance(r, {document: doc, location: {hash}});
  const shown = () => r.querySelector('.story-steps').children.filter(s => !s.hasAttribute('hidden')).map(s => s.id);
  const current = () => api.buttons.findIndex(b => b.getAttribute('aria-current') === 'step');
  const key = (target, k, mods = {}) => r.dispatch('keydown', {key: k, target, ...mods});
  return {body, doc, r, api, shown, current, key};
}

test('story.js: one step at a time, with Previous and Next, the step list and the arrow keys; it announces only what the reader does', () => {
  const {doc, r, api, shown, current, key} = stepper();
  try {
    assert.ok(r.classList.contains('is-stepper'));
    assert.deepEqual(shown(), ['story-step-1'], 'the first step, alone');
    assert.equal(current(), 0);
    assert.equal(api.status.textContent, '', 'nothing is announced when the page opens');
    assert.equal(api.status.getAttribute('aria-live'), 'polite');
    assert.equal(api.status.getAttribute('aria-atomic'), 'true');
    // the step list's links are buttons now, with the same words
    assert.equal(r.querySelector('.story-track').querySelectorAll('a').length, 0);
    assert.deepEqual(api.buttons.map(b => [b.getAttribute('type'), text(b)]), ['Ask and agree', 'Pay with a note', 'Pass it on', 'A loop forms', 'The loop clears'].map((t, i) => ['button', `Step ${i + 1} ${t}`]));
    assert.deepEqual([api.prev, api.next].map(b => [text(b), b.getAttribute('type')]), [['Previous step', 'button'], ['Next step', 'button']]);
    assert.equal(api.prev.getAttribute('aria-disabled'), 'true', 'nothing before the first step');
    // Next
    api.next.focus(); api.next.click();
    assert.deepEqual(shown(), ['story-step-2']);
    assert.equal(current(), 1);
    assert.equal(api.status.textContent, 'Step 2 of 5: Work, and pay with a note');
    assert.equal(doc.activeElement, api.next, 'focus stays on Next');
    assert.ok(r.querySelector('#story-step-2').classList.contains('is-entering'), 'the step the reader opened may move (story.css, without reduced motion)');
    assert.equal(api.prev.getAttribute('aria-disabled'), null);
    // the right arrow on Next; a modified arrow is the browser's
    key(api.next, 'ArrowRight');
    assert.deepEqual(shown(), ['story-step-3']);
    assert.equal(api.status.textContent, 'Step 3 of 5: Pass it on, if Cy accepts it');
    key(api.next, 'ArrowLeft', {altKey: true});
    assert.deepEqual(shown(), ['story-step-3'], 'Alt+Left (back) is left alone');
    // the arrow keys on the step list move focus with the step: the button says where the reader is, no announcement
    api.buttons[2].focus();
    key(api.buttons[2], 'ArrowRight');
    assert.deepEqual(shown(), ['story-step-4']);
    assert.equal(doc.activeElement, api.buttons[3]);
    assert.equal(api.status.textContent, 'Step 3 of 5: Pass it on, if Cy accepts it', 'not announced twice');
    key(api.buttons[3], 'End');
    assert.deepEqual(shown(), ['story-step-5']);
    assert.equal(doc.activeElement, api.buttons[4]);
    assert.equal(api.next.getAttribute('aria-disabled'), 'true', 'nothing after the last step');
    api.next.click();
    assert.deepEqual(shown(), ['story-step-5'], 'Next at the end does nothing');
    key(api.buttons[4], 'ArrowRight');
    assert.deepEqual(shown(), ['story-step-5']);
    key(api.buttons[4], 'Home');
    assert.deepEqual(shown(), ['story-step-1']);
    // a click on the step list
    api.buttons[3].click();
    assert.deepEqual(shown(), ['story-step-4']);
    assert.equal(api.status.textContent, 'Step 4 of 5: A loop forms');
    // keys elsewhere in the story (a link in a step, an aside) are not the stepper's
    const link = r.querySelector('.story-asides a');
    key(link, 'ArrowRight');
    assert.deepEqual(shown(), ['story-step-4']);
    key(api.prev, 'Home');
    assert.deepEqual(shown(), ['story-step-4'], 'Home and End belong to the step list only');
    // Previous
    api.prev.click();
    assert.deepEqual(shown(), ['story-step-3']);
    assert.equal(api.status.textContent, 'Step 3 of 5: Pass it on, if Cy accepts it');
  } finally { delete globalThis.document; }
});

test('story.js: Previous and Next sit above every step, where they stay; the pair at the foot of a long step brings the step list back into view and hands focus to the pair above; a link to a step opens it quietly', () => {
  const s = stepper();
  try {
    const track = s.r.querySelector('.story-track'), list = s.r.querySelector('.story-steps'), kids = s.r.children;
    const {prev, next, prevEnd, nextEnd, status} = s.api;
    // the pair above every step: right after the step list, so it never moves as the steps' heights change (fix: it
    // was under the step and jumped by up to 560 px on a phone); the pair at the foot follows the steps
    assert.equal(kids.indexOf(prev.parentNode), kids.indexOf(track) + 1);
    assert.equal(next.parentNode, prev.parentNode);
    assert.deepEqual([prev.parentNode.className, nextEnd.parentNode.className], ['story-pager', 'story-pager is-end']);
    assert.equal(kids.indexOf(nextEnd.parentNode), kids.indexOf(list) + 1);
    assert.equal(prevEnd.parentNode, nextEnd.parentNode);
    assert.deepEqual([prevEnd, nextEnd].map(b => [text(b), b.getAttribute('type')]), [['Previous step', 'button'], ['Next step', 'button']]);
    assert.equal(prevEnd.getAttribute('aria-disabled'), 'true', 'both pairs mark the ends');
    // the pair above never scrolls the page, wherever the step list is
    track.getBoundingClientRect = () => ({top: -620, bottom: -560, left: 0, right: 320, width: 320, height: 60});
    next.focus(); next.click();
    assert.equal(track.scrolls, undefined);
    assert.equal(s.doc.activeElement, next, 'focus stays on Next above the step, which stays where it was');
    // the pair at the foot of a long step (a phone): the step list comes back into view (smoothly only without reduced
    // motion: site.css), and focus goes to the same button above the new step, in view now: never left on a button
    // that moved off screen (fix: Enter on Next left the focused button 600 px below the screen)
    nextEnd.focus(); nextEnd.click();
    assert.equal(s.current(), 2);
    assert.deepEqual(track.scrolls, [{block: 'start'}]);
    assert.equal(s.doc.activeElement, next);
    assert.equal(status.textContent, 'Step 3 of 5: Pass it on, if Cy accepts it', 'announced, as from the pair above');
    // the same by keyboard on the foot's pair: the arrow keys move a step and hand focus up too
    prevEnd.focus(); s.key(prevEnd, 'ArrowLeft');
    assert.equal(s.current(), 1);
    assert.equal(s.doc.activeElement, prev);
    assert.equal(track.scrolls.length, 2);
    // when the step list is in view, nothing scrolls; focus still moves up
    track.getBoundingClientRect = () => ({top: 40, bottom: 100, left: 0, right: 320, width: 320, height: 60});
    nextEnd.click();
    assert.equal(track.scrolls.length, 2);
    assert.equal(s.doc.activeElement, next);
    s.api.buttons[0].click();
    assert.equal(track.scrolls.length, 2, 'the step list itself never scrolls the page');
    assert.equal(nextEnd.getAttribute('aria-disabled'), null);
    s.api.buttons[4].click();
    assert.deepEqual([next, nextEnd].map(b => b.getAttribute('aria-disabled')), ['true', 'true']);
  } finally { delete globalThis.document; }
  const d = stepper({hash: '#story-step-4'});
  try {
    assert.deepEqual(d.shown(), ['story-step-4']);
    assert.equal(d.current(), 3);
    assert.equal(d.api.status.textContent, '', 'opening the page is not the reader\'s action: no announcement');
    assert.ok(!d.r.querySelector('#story-step-4').classList.contains('is-entering'), 'and no motion');
  } finally { delete globalThis.document; }
  const x = stepper({hash: '#story-step-9'});
  try { assert.deepEqual(x.shown(), ['story-step-1'], 'a step that does not exist: the first'); } finally { delete globalThis.document; }
});

test('story.js changes nothing that is not the example, and nothing twice', () => {
  assert.equal(enhance(null, {document: {}}), null);
  const other = readBody('<body><div data-story><p>no steps</p></div></body>');
  assert.equal(enhance(other.querySelector('[data-story]'), {document: {createElement: t => new Element(t)}}), null);
  assert.ok(!other.querySelector('[data-story]').classList.contains('is-stepper'));
  const s = stepper();
  try { assert.equal(enhance(s.r, {document: s.doc, location: {hash: ''}}), null, 'already a stepper'); } finally { delete globalThis.document; }
  // the page starts it by itself, on the element with data-story, as a module
  assert.match(js, /document\.querySelector\('\[data-story\]'\)/);
  assert.match(js, /^export function enhance\(/m);
});
