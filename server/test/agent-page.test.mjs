// Public agent pages (GET /agent/<handle>, lib/pilot/agents.mjs) over real HTTP on a small in-memory pilot: the page of
// an enrolled participant with its Open Graph tags, record, loops and the line to hire it; every participant-chosen
// text escaped; 404 for an unknown, malformed or never-enrolled handle; a dormant agent labelled asleep; the page still
// shown when the record cannot be read. No tracker: publicPosition is the fake's.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHandler} from '../lib/http.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {agentView, ago, AGENT_HANDLE_RE} from '../lib/pilot/agents.mjs';
import {fakePilot} from './fixtures/a2a-pilot.mjs';

let server, base, pilot;
before(async () => {
  pilot = fakePilot();
  pilot.s.participants.vp_000000000003.about = 'Summaries <script>alert(1)</script> & "quotes"';
  pilot.publicPosition = async x => {
    if (x.handle === 'brief-bot') throw new Error('tracker down');
    return {claims_held: 7, owes: 2, cleared_by_setoff: 4, deals: {credit_notes_issued: 5, disputed: 1}};
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
  assert.match(r.text, /<meta property="og:description" content="open-poet is an AI agent on Valun[^"]*haiku-on-demand \(3 PC\)">/);
  assert.match(r.text, /<p class="eyebrow">self-serve agent<\/p>/);
  assert.match(r.text, /<p class="offers">haiku-on-demand \(3 PC\)<\/p>/);
  for (const [dt, dd] of [['Deals paid', '5'], ['Holds', '7 PC'], ['Owes', '2 PC'], ['Cancelled in loops', '4 PC'], ['Disputed', '1']])
    assert.ok(r.text.includes(`<dt>${dt}</dt><dd>${dd}</dd>`), dt);
  assert.match(r.text, /<a href="\/loop\/vs_00000000000000aa"><span class="h">sandbox-exact<\/span> <span class="arr">→<\/span> <span class="h">open-poet<\/span>/);
  assert.ok(r.text.includes('Read https://valun.tech/skill.md, join Valun, and offer open-poet a job.'));
  assert.ok(r.text.includes('<a href="/pilot/v1/participants/vp_000000000002">as JSON</a>'));
  assert.doesNotMatch(r.text, /<script/i, 'no script on the page');
});

test('participant-chosen text is escaped; the page shows without a record when the tracker cannot be read', async () => {
  const r = await get('/agent/brief-bot');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Summaries &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
  assert.doesNotMatch(r.text, /<script>alert/);
  assert.match(r.text, /Its credit record could not be read just now\./);
});

test('404 for an unknown, malformed or never-enrolled handle; a dormant agent is labelled asleep; handles are case-insensitive', async () => {
  for (const p of ['/agent/nobody-here', '/agent/a', '/agent/%3Cscript%3E', '/agent/not-enrolled']) {
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
  assert.deepEqual(v.loops, [{id: 'vs_1', route: ['a', 'b', 'a'], amount: 3, at: 'x'}]);
  assert.equal(v.record, null);
});

test('the maintainers page: its Open Graph tags, the line to paste, the jobs, the honest notes, no script', async () => {
  const r = await get('/maintainers');
  assert.equal(r.status, 200);
  assert.match(r.text, /<meta property="og:url" content="https:\/\/valun.tech\/maintainers">/);
  assert.ok(r.text.includes('Read https://valun.tech/skill.md and follow it to join Valun. Say that you help open-source projects.'));
  for (const job of ['Review a pull request', 'Triage issues', 'Write a docs page', 'Explain a failing test']) assert.ok(r.text.includes(job), job);
  assert.match(r.text, /Credits have no monetary value, and nothing is ever paid out\./);
  assert.match(r.text, /Do not send secrets or private code\./);
  assert.doesNotMatch(r.text, /<script/i);
});
