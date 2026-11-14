// valun_directory answers one page (fix inbox #36), the JavaScript twin of python/tests/test_directory.py. In an
// agent bake-off a small model stalled after the whole directory (137 participants, about 72 KB, with one
// GET /participants/{id} for each). Now the default page is 10 participants, `limit` asks for up to 50 and `offset`
// pages on. The order comes from the list's own fields: a query's matches in the handle or name first, then in services
// or wants, then only in about; then the agents active in the last 24 hours; then the most recently seen (never seen
// last); then the handle (code points). Only the page's participants are looked up, and about, services and wants are
// cut to 160 code points. The same over a recorded server, value for value with Python: the 'directory:' scenarios of
// agent-parity.test.js.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NETWORK, ValunAgent, ValunError} from '../src/index.js';

const ME = 'vp_000000000000';
const NOW = Date.UTC(2026, 10, 13, 12, 34, 56, 789);
const HOUR = 3_600_000;
// What GET /participants/{id} adds: a public position as the server shows one (every deal count it lists).
const POSITION = {participant_id: null, unit: 'nanoERG', claims_held: 12_000_000, owes: 3_000_000, net: 9_000_000,
  deals: {credit_notes_issued: 4, open: 1, agreed_note_not_issued: 0, disputed: 1, declined: 0, expired_or_withdrawn: 2, paid_by_transfer: 0,
    payment_due: 0, notes_issued_as_payer: 2, notes_received: 2}};
const ago = hours => new Date(NOW - Math.round(hours * HOUR)).toISOString();
const pad = (n, w) => String(n).padStart(w, '0');

/**
 * Participant n as GET /participants lists it: its agent last seen `seen` hours ago (null: never), joined `joined` hours
 * ago (by default long ago, so only `seen` makes it active).
 */
function person(n, handle = null, {seen = null, joined = 24 * 30, ...fields} = {}) {
  return {id: `vp_${n.toString(16).padStart(12, '0')}`, handle: handle ?? `agent-${pad(n, 3)}`, display_name: `Agent ${n}`,
    operator: 'Example operator', about: 'An agent.', services: 'Summaries', pubkey: '02' + '11'.repeat(32), status: 'active',
    joined_at: ago(joined), agent_last_seen: seen === null ? null : ago(seen), ...fields};
}

/** n participants whose agents were last seen 1, 2, ... n hours ago (the first 23 active), and this agent itself. */
const crowd = (n, fields = {}) => [...Array.from({length: n}, (_, i) => person(i + 1, null, {seen: i + 1, ...fields})),
  person(0, 'me', {id: ME, seen: 0})];

class FakeClient {
  constructor(people) {
    Object.assign(this, {people, reads: 0, lookups: [], network: NETWORK});
  }
  get connected() { return true; }
  get participantId() { return ME; }
  async directory() {
    this.reads++;
    return JSON.parse(JSON.stringify(this.people));
  }
  async participant(id) {
    this.lookups.push(id);
    return {id, handle: 'x', public_position: {...POSITION, participant_id: id}};
  }
  async deal() { throw new Error('not read here'); }
  async complete() { throw new Error('not called here'); }
}

const agentOf = people => {
  const c = new FakeClient(people);
  const a = new ValunAgent(c, {now: () => NOW});
  a.fake = c;
  return a;
};
const handles = r => r.participants.map(e => e.handle);
const agents = (from, to) => Array.from({length: to - from + 1}, (_, i) => `agent-${pad(from + i, 3)}`);

// ---------- order ----------
test('directory: without a query the most recently active come first', async () => {
  const twoDays = NOW - 48 * HOUR;
  const people = [
    person(1, 'seen-1h', {seen: 1}), person(2, 'seen-30min', {seen: 0.5}), person(3, 'new-never-seen', {joined: 2}),
    person(4, 'seen-2d-b', {seen: 48}), person(5, 'seen-2d-a', {seen: 48}), person(6, 'never-seen'),
    person(7, 'naive-time', {agent_last_seen: ago(0.2).replace(/Z$/, '')}),      // no UTC offset: not readable as a time
    person(8, 'unreadable', {agent_last_seen: 'yesterday'}), person(9, 'seen-3d', {seen: 72}),
    // the same instant as seen-2d-a and seen-2d-b, written with another UTC offset
    person(10, 'seen-2d-offset', {agent_last_seen: new Date(twoDays + 5 * HOUR).toISOString().replace('Z', '+05:00')}),
    person(11, 'not-enrolled', {seen: 0.1, status: 'awaiting_agent'}), person(0, 'me', {id: ME, seen: 0}),
  ];
  const r = await agentOf(people).call('valun_directory', {limit: 50});
  // active (seen within 24 h, or joined within 24 h), most recently seen first, never seen last; then the rest, the
  // same; equal times (the same instant in any offset) by handle
  assert.deepEqual(handles(r), ['seen-30min', 'seen-1h', 'new-never-seen', 'seen-2d-a', 'seen-2d-b', 'seen-2d-offset', 'seen-3d',
    'naive-time', 'never-seen', 'unreadable']);
  assert.deepEqual(r.participants.map(e => e.agent_recently_active), [true, true, true, false, false, false, false, false, false, false]);
  assert.deepEqual([r.total_matching, r.offset], [10, 0]);
  assert.ok(!('next_offset' in r) && !('how_to_see_more' in r));
});

test('directory: a query ranks handle or name, then services or wants, then about', async () => {
  const people = [
    person(1, 'about-only', {seen: 0.1, about: 'I read research BRIEFS.'}),
    person(2, 'wants-it', {wants: 'A brief a week'}),
    person(3, 'briefs-bot'),
    person(4, 'named', {seen: 5, display_name: 'Daily Brief'}),
    person(5, 'services-it', {seen: 1, services: 'Research briefs, 300-500 words'}),
    person(6, 'no-match', {seen: 0.1}),
    person(7, 'across', {about: 'ends in brie', services: 'f? no: two fields'}),     // 'brie f': the space is in the query only
  ];
  let r = await agentOf(people).call('valun_directory', {query: 'Brief'});
  assert.deepEqual(handles(r), ['named', 'briefs-bot', 'services-it', 'wants-it', 'about-only']);
  assert.equal(r.total_matching, 5);
  // the text filter has always matched across two fields (they are joined with a space): such a match comes last
  r = await agentOf(people).call('valun_directory', {query: 'BRIE F'});
  assert.deepEqual(handles(r), ['across']);
  r = await agentOf(people).call('valun_directory', {query: 'nothing like this'});
  assert.deepEqual([r.participants, r.total_matching, r.offset], [[], 0, 0]);
  assert.ok(!('next_offset' in r));
});

test('directory: ties go by handle in code point order (as Python compares strings), not UTF-16 order', async () => {
  const seen = ago(3);
  const people = ['b', 'a\u{1F600}', 'aａ', 'A', 'a'].map((h, i) => person(i + 1, h, {agent_last_seen: seen}));
  const r = await agentOf(people).call('valun_directory', {});
  assert.deepEqual(handles(r), ['A', 'a', 'aａ', 'a\u{1F600}', 'b']);
});

// ---------- paging ----------
test('directory: the default page is ten and says how to see more', async () => {
  const a = agentOf(crowd(25));
  const r = await a.call('valun_directory', {});
  assert.deepEqual(handles(r), agents(1, 10));
  assert.deepEqual(Object.keys(r), ['participants', 'total_matching', 'offset', 'next_offset', 'note', 'how_to_see_more']);
  assert.deepEqual([r.total_matching, r.offset, r.next_offset], [25, 0, 10]);
  assert.equal(r.how_to_see_more, 'Showing 1-10 of 25 (most recently active first). For more, call valun_directory again with offset 10, '
    + 'or narrow it with query.');
  assert.ok(r.note.endsWith(' A participant whose agent has not been seen in the last 24 hours may never answer an offer.'));
  assert.equal(a.fake.reads, 1);
});

test('directory: offset pages on through every match once', async () => {
  const a = agentOf(crowd(25));
  const pages = [];
  for (const offset of [0, 10, 20]) pages.push(await a.call('valun_directory', {offset}));
  const all = pages.flatMap(handles);
  assert.deepEqual(all, handles(await a.call('valun_directory', {limit: 50})));
  assert.equal(new Set(all).size, 25);
  const r = pages[1];
  assert.deepEqual([r.offset, r.next_offset, r.total_matching], [10, 20, 25]);
  assert.equal(r.how_to_see_more, 'Showing 11-20 of 25 (most recently active first). For more, call valun_directory again with offset 20, '
    + 'or narrow it with query.');
  const last = pages[2];                                // the last page: nothing more to show
  assert.deepEqual([handles(last), last.offset, last.total_matching], [agents(21, 25), 20, 25]);
  assert.deepEqual(Object.keys(last), ['participants', 'total_matching', 'offset', 'note']);
});

test('directory: past the end is empty, and a negative offset counts as 0', async () => {
  const a = agentOf(crowd(25));
  let r = await a.call('valun_directory', {offset: 25});
  assert.deepEqual([r.participants, r.total_matching, r.offset], [[], 25, 25]);
  assert.ok(!('next_offset' in r));
  r = await a.call('valun_directory', {offset: 10 ** 12});
  assert.deepEqual([r.participants, r.offset], [[], 10 ** 12]);
  r = await a.call('valun_directory', {offset: -5});
  assert.deepEqual([r.offset, r.next_offset, handles(r)[0]], [0, 10, 'agent-001']);
  assert.deepEqual(a.fake.lookups.slice(-10), r.participants.map(e => e.id));
});

test('directory: paging a query says to pass the same query', async () => {
  const r = await agentOf(crowd(25, {services: 'Research briefs'})).call('valun_directory', {query: 'brief', limit: 4, offset: 4});
  assert.deepEqual([handles(r), r.total_matching, r.next_offset], [agents(5, 8), 25, 8]);
  assert.equal(r.how_to_see_more, 'Showing 5-8 of 25 matching the query (best matches first). For more, call valun_directory again with '
    + 'the same query and offset 8, or narrow the query.');
});

test('directory: limit is clamped to 1..50, and null is the default', async () => {
  const a = agentOf(crowd(60));
  for (const [limit, n] of [[0, 1], [-3, 1], [1, 1], [7, 7], [50, 50], [51, 50], [10 ** 9, 50]]) {
    const r = await a.call('valun_directory', {limit});
    assert.deepEqual([r.participants.length, r.next_offset], [n, n], String(limit));
  }
  const r = await a.call('valun_directory', {limit: null, offset: null});
  assert.deepEqual([r.participants.length, r.offset, r.next_offset], [10, 0, 10]);
  assert.equal((await a.call('valun_directory', {limit: undefined})).participants.length, 10);
});

test('directory: a limit or offset that is not a whole number is refused before anything is read', async () => {
  const a = agentOf(crowd(3));
  // (JavaScript cannot tell 10.0 from 10: Python refuses 10.0, here it is 10)
  for (const k of ['limit', 'offset']) {
    for (const v of ['10', true, false, 2.5, [], {}, 2 ** 53, -(2 ** 53), Infinity, NaN]) {
      await assert.rejects(a.call('valun_directory', {[k]: v}), e => e instanceof ValunError && e.code === 'bad_arguments', `${k} ${String(v)}`);
    }
  }
  assert.equal(a.fake.reads, 0);
  assert.deepEqual(await a.callSafe('valun_directory', {limit: '10'}),
    {error: 'bad_arguments', message: 'limit must be a whole number (how many participants to show: 1 to 50, 10 by default), not "10"'});
  assert.equal((await a.callSafe('valun_directory', {offset: true})).message,
    'offset must be a whole number (how many participants to skip: next_offset from the last answer, 0 by default), not true');
  assert.equal((await a.callSafe('valun_directory', {limit: 'x'.repeat(60)})).message,
    'limit must be a whole number (how many participants to show: 1 to 50, 10 by default), not "' + 'x'.repeat(36) + '...');
  assert.equal((await a.call('valun_directory', {limit: 2 ** 53 - 1})).total_matching, 3);   // the largest safe integer is one
});

// ---------- entries ----------
test('directory: only the page is looked up', async () => {
  const a = agentOf(crowd(150));
  let r = await a.call('valun_directory', {});
  assert.deepEqual(a.fake.lookups, r.participants.map(e => e.id));
  assert.equal(a.fake.lookups.length, 10);
  a.fake.lookups.length = 0;
  r = await a.call('valun_directory', {offset: 145});
  assert.deepEqual(a.fake.lookups, [146, 147, 148, 149, 150].map(i => `vp_${i.toString(16).padStart(12, '0')}`));
  assert.deepEqual(r.participants.map(e => e.credit_notes_they_hold_PC), Array(5).fill(12_000_000));
  a.fake.lookups.length = 0;
  await a.call('valun_directory', {offset: 150});
  assert.deepEqual(a.fake.lookups, []);
});

test('directory: entries keep their fields, and long texts are cut to 160 code points', async () => {
  const emoji = '\u{1F600}'.repeat(200);                // 200 code points, 400 UTF-16 units
  const people = [person(1, 'long', {seen: 1, about: 'a'.repeat(300), services: 's'.repeat(160), wants: 'w'.repeat(161)}),
    person(2, 'astral', {seen: 2, about: emoji, services: ''}),
    person(3, 'odd', {seen: 3, about: null, services: 5})];
  const r = await agentOf(people).call('valun_directory', {});
  const [long, astral, odd] = r.participants;
  assert.deepEqual(Object.keys(long), ['handle', 'id', 'name', 'operator', 'about', 'services', 'wants', 'credit_notes_they_hold_PC',
    'credit_notes_they_owe_PC', 'deals', 'agent_last_seen', 'agent_recently_active']);
  assert.deepEqual([long.about, long.services, long.wants], ['a'.repeat(160) + '…', 's'.repeat(160), 'w'.repeat(160) + '…']);
  assert.deepEqual([long.handle, long.id, long.name, long.operator], ['long', 'vp_000000000001', 'Agent 1', 'Example operator']);
  assert.deepEqual([long.credit_notes_they_hold_PC, long.credit_notes_they_owe_PC, long.deals], [12_000_000, 3_000_000, POSITION.deals]);
  assert.deepEqual([long.agent_last_seen, long.agent_recently_active], [people[0].agent_last_seen, true]);
  assert.deepEqual([astral.about, astral.services, astral.wants], ['\u{1F600}'.repeat(160) + '…', '', '']);
  assert.equal(Array.from(astral.about).length, 161);
  assert.deepEqual([odd.about, odd.services], [null, 5]);     // not text: shown as the server sent it
});

test('directory: the default answer stays small with 150 participants at the server\'s maximum', async () => {
  // The server keeps about, services and wants to 300 characters each, display_name to 40, operator to 60 and a handle
  // to 24: here every one of 150 participants is at those maximums.
  const people = Array.from({length: 150}, (_, i) => person(i + 1, `h${pad(i + 1, 3)}` + 'h'.repeat(20), {seen: (i + 1) / 10,
    display_name: 'N'.repeat(40), operator: 'O'.repeat(60), about: 'A'.repeat(300), services: 'S'.repeat(300), wants: 'W'.repeat(300)}));
  const a = agentOf(people);
  const r = await a.call('valun_directory', {});
  assert.deepEqual([r.participants.length, r.total_matching, r.next_offset], [10, 150, 10]);
  assert.ok(JSON.stringify(r).length <= 15_000, `${JSON.stringify(r).length} characters`);
  assert.ok(JSON.stringify(r, null, 1).length <= 15_000, `${JSON.stringify(r, null, 1).length} characters, indented`);
  assert.equal(a.fake.lookups.length, 10);
});
