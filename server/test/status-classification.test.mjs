// Closed-world classification of deal statuses (lib/pilot/status.mjs; design §5.2, invariant I-MANDATE): exactly the
// 19 statuses are classified, every classification is complete and consistent, every status the server code names is
// classified, and exposure(), position(), inbox() and revokeAgent() treat synthetic deals in every status as expected.
// The expectations for the 16 statuses of v15 are written out by hand (what v15 does), not derived from the table.
// No tracker: the Pilot gets a stub basis and an explicit ledger; nothing here calls the tracker or the signer.
// Run: node --test test/status-classification.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../lib/pilot/core.mjs';
import {STATUS_CLASS, statusClass, bucketCounts, inboxSection, INBOX_SECTIONS, POSITION_BUCKETS, BUCKETS, REVOKE_ACTIONS, EXPIRY_KINDS, ACTION_SETS} from '../lib/pilot/status.mjs';

// The closed list: the 16 statuses of v15 and the three of circulating credit (design §4.8).
const ALL_STATUSES = ['open', 'proposed_awaiting_owner', 'accepted_awaiting_owner', 'agreed', 'delivered', 'completion_awaiting_owner',
  'issuing_note', 'note_failed', 'note_issued', 'disputed', 'declined', 'withdrawn', 'expired', 'rejected_by_owner', 'cancelled',
  'expired_undelivered', 'paying_by_transfer', 'paid_by_transfer', 'payment_due'];
const FIELDS = ['committed', 'reserved', 'terminal', 'offer_phase', 'bucket', 'payer_inbox', 'payee_inbox', 'revoke', 'expiry', 'actions'];
const COMMITTED = ['accepted_awaiting_owner', 'agreed', 'delivered', 'completion_awaiting_owner', 'issuing_note', 'note_failed', 'paying_by_transfer', 'payment_due'];
const RESERVED_IF_OWN = ['open', 'proposed_awaiting_owner'];
const TERMINAL = ['note_issued', 'paid_by_transfer', 'disputed', 'declined', 'withdrawn', 'expired', 'rejected_by_owner', 'cancelled', 'expired_undelivered'];

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();

// A Pilot over a throwaway store, with two active participants: P (payer of every deal) and Q (payee). `options` go to
// the Pilot (the circulation mode and what makes it effective).
function world(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-status-')); dirs.push(dir);
  const pilot = new Pilot({store: new PilotStore(dir), basis: {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION}, ...options});
  const person = handle => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(Date.now()), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE}, mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null});
  const P = person('st-payer'), Q = person('st-payee');
  pilot.s.participants[P.id] = P; pilot.s.participants[Q.id] = Q;
  return {pilot, P, Q};
}
// A synthetic deal in `status` between payer P and payee Q, with its current (only) version made by `by`. Everything
// is in the future, so sweep() changes nothing. A proposal still waiting for its proposer's owner was never offered.
function addDeal(pilot, status, {P, Q, by, price}) {
  const now = Date.now(), id = 'vd_' + hex(8);
  const terms = {deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey},
    service: {title: `job in ${status}`, description: 'synthetic', deliverable: 'text'}, price: {amount: price, unit: 'PC'},
    offer_expires_at: iso(now + 864e5), deliver_by: iso(now + 2 * 864e5)};
  const v = {v: 1, by: by.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(now),
    state: STATUS_CLASS[status].offer_phase ? 'open' : 'accepted', offered_at: status === 'proposed_awaiting_owner' ? null : iso(now)};
  const d = {id, payer: P.id, payee: Q.id, created_at: iso(now), status, versions: [v], history: []};
  if (!STATUS_CLASS[status].offer_phase) d.agreement = {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(now)};
  pilot.s.deals[id] = d;
  return d;
}
const sum = (deals, statuses) => deals.filter(d => statuses.includes(d.status)).reduce((a, d) => a + d.versions[0].terms.price.amount, 0);

test('closed world: exactly the 19 statuses are classified', () => {
  assert.equal(ALL_STATUSES.length, 19);
  assert.equal(new Set(ALL_STATUSES).size, 19);
  assert.deepEqual(Object.keys(STATUS_CLASS).sort(), [...ALL_STATUSES].sort());
  assert.ok(Object.isFrozen(STATUS_CLASS) && Object.values(STATUS_CLASS).every(Object.isFrozen), 'the table cannot be changed at run time');
  for (const s of ['paid', 'toString', 'constructor', '__proto__', '', null, undefined, 42]) assert.equal(statusClass(s), null, `not a status: ${String(s)}`);
});

test('every classification has every field, with a valid and consistent value', () => {
  const inboxValues = new Set([...INBOX_SECTIONS, 'respond_or_waiting', 'waiting_on_counterparty_owner', null]);
  for (const [s, c] of Object.entries(STATUS_CLASS)) {
    assert.deepEqual(Object.keys(c).sort(), [...FIELDS].sort(), `${s}: fields`);
    for (const f of ['committed', 'reserved', 'terminal', 'offer_phase']) assert.equal(typeof c[f], 'boolean', `${s}.${f}`);
    assert.ok(BUCKETS.includes(c.bucket), `${s}.bucket ${c.bucket}`);
    assert.ok(inboxValues.has(c.payer_inbox) && inboxValues.has(c.payee_inbox), `${s}: inbox values`);
    assert.ok(REVOKE_ACTIONS.includes(c.revoke), `${s}.revoke ${c.revoke}`);
    assert.equal(c.committed, COMMITTED.includes(s), `${s}.committed`);
    assert.equal(c.reserved, RESERVED_IF_OWN.includes(s), `${s}.reserved`);
    assert.equal(c.terminal, TERMINAL.includes(s), `${s}.terminal`);
    assert.ok(!(c.committed && c.reserved), `${s}: committed and reserved exclude each other`);
    if (c.terminal) {
      assert.deepEqual([c.committed, c.reserved, c.offer_phase, c.revoke, c.payer_inbox, c.payee_inbox], [false, false, false, 'keep', 'recent_closed', 'recent_closed'], `${s}: ended`);
    } else {
      assert.notEqual(c.payer_inbox, 'recent_closed', s); assert.notEqual(c.payee_inbox, 'recent_closed', s);
      assert.ok(c.committed || c.reserved, `${s}: an open deal counts against a mandate`);
    }
    assert.equal(c.offer_phase, ['open', 'proposed_awaiting_owner', 'accepted_awaiting_owner'].includes(s), `${s}.offer_phase`);
    if (c.offer_phase) assert.deepEqual([c.bucket, c.revoke], ['open', 'cancel'], `${s}: not agreed yet`);
    assert.ok(c.expiry === null || EXPIRY_KINDS.includes(c.expiry), `${s}.expiry ${c.expiry}`);
    assert.ok(Object.isFrozen(c.actions), `${s}.actions cannot be changed at run time`);
    assert.deepEqual(Object.keys(c.actions), ['payer', 'payee'], `${s}.actions`);
    for (const r of ['payer', 'payee']) assert.ok(c.actions[r] === null || ACTION_SETS.includes(c.actions[r]), `${s}.actions.${r} ${c.actions[r]}`);
    if (c.terminal) assert.deepEqual([c.expiry, c.actions.payer, c.actions.payee], [null, null, null], `${s}: nothing expires or is left to do`);
  }
  // What sweep() expires (v15: core.mjs sweep) and which action set each party's view lists (v15: core.mjs view).
  assert.deepEqual(Object.fromEntries(ALL_STATUSES.map(s => [s, STATUS_CLASS[s].expiry]).filter(([, e]) => e)),
    {open: 'offer', proposed_awaiting_owner: 'offer', accepted_awaiting_owner: 'held_acceptance', agreed: 'delivery'});
  assert.deepEqual(Object.fromEntries(ALL_STATUSES.filter(s => !TERMINAL.includes(s)).map(s => [s, [STATUS_CLASS[s].actions.payer, STATUS_CLASS[s].actions.payee]])), {
    open: ['offer', 'offer'], proposed_awaiting_owner: ['wait_for_owner', 'wait_for_owner'], accepted_awaiting_owner: ['held_acceptance', 'held_acceptance'],
    agreed: [null, 'deliver'], delivered: ['review', null], completion_awaiting_owner: ['wait_for_owner', 'wait_for_owner'], issuing_note: [null, null],
    note_failed: ['pay', null], paying_by_transfer: ['paying', 'wait_for_consents'], payment_due: ['pay', null]});
  assert.deepEqual(POSITION_BUCKETS, ['credit_notes_issued', 'open', 'agreed_note_not_issued', 'disputed', 'declined', 'expired_or_withdrawn'], 'the v15 buckets, in order');
  assert.deepEqual(Object.fromEntries(ALL_STATUSES.map(s => [s, STATUS_CLASS[s].revoke])), {
    open: 'cancel', proposed_awaiting_owner: 'cancel', accepted_awaiting_owner: 'cancel', agreed: 'keep', delivered: 'keep',
    completion_awaiting_owner: 'void_held_note', issuing_note: 'keep', note_failed: 'keep', note_issued: 'keep', disputed: 'keep',
    declined: 'keep', withdrawn: 'keep', expired: 'keep', rejected_by_owner: 'keep', cancelled: 'keep', expired_undelivered: 'keep',
    paying_by_transfer: 'void_transfer', paid_by_transfer: 'keep', payment_due: 'keep'});
});

test('every deal status the server code names is classified', () => {
  const named = new Set();
  for (const f of ['../lib/pilot/core.mjs', '../lib/pilot/http.mjs', '../lib/pilot/sandbox.mjs']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\bd\.status\s*(?:=|===|!==)\s*'([a-z_]+)'/g)) named.add(m[1]);
    for (const m of src.matchAll(/\[((?:\s*'[a-z_]+',?)+)\]\.includes\(d\.status\)/g)) for (const w of m[1].matchAll(/'([a-z_]+)'/g)) named.add(w[1]);
    for (const m of src.matchAll(/status: chk\.needsOwner \? '([a-z_]+)' : '([a-z_]+)'/g)) { named.add(m[1]); named.add(m[2]); }
    for (const m of src.matchAll(/const renamed = \{([^}]*)\}/g)) for (const w of m[1].matchAll(/:\s*'([a-z_]+)'/g)) named.add(w[1]);
  }
  assert.ok(named.size >= 15, `the scan must find the statuses the code names (found ${[...named]})`);
  for (const s of named) assert.ok(statusClass(s), `the server code names deal status ${s}, which STATUS_CLASS does not classify`);
});

test('exposure: committed and reserved amounts per status, for the payer and for the payee', () => {
  const {pilot, P, Q} = world();
  // One deal per status, each priced 2^i, so a sum tells exactly which statuses were counted. Proposed by the payer P.
  const deals = ALL_STATUSES.map((s, i) => addDeal(pilot, s, {P, Q, by: P, price: 2 ** i}));
  const ledger = [{issuer: P.id, recipient: Q.id, outstanding: 7}, {issuer: Q.id, recipient: P.id, outstanding: 1000}];
  const payer = pilot.exposure(P, ledger, {asRole: 'payer'});
  assert.deepEqual(payer, {tracker: 7, committed: sum(deals, COMMITTED), reserved: sum(deals, RESERVED_IF_OWN), total: 7 + sum(deals, COMMITTED) + sum(deals, RESERVED_IF_OWN)});
  const payee = pilot.exposure(Q, ledger, {asRole: 'payee', counterpartyId: P.id});
  assert.deepEqual(payee, {tracker: 7, committed: sum(deals, COMMITTED), reserved: 0, total: 7 + sum(deals, COMMITTED)}, "the payer's own offers are not reserved by the payee");
  // excludeDealId leaves out the deal being acted on
  const ex = deals.find(d => d.status === 'agreed');
  assert.equal(pilot.exposure(P, ledger, {asRole: 'payer', excludeDealId: ex.id}).committed, sum(deals, COMMITTED) - ex.versions[0].terms.price.amount);
  // the v15 lists exactly, for the 16 statuses of v15
  const v15 = deals.filter(d => !['paying_by_transfer', 'paid_by_transfer', 'payment_due'].includes(d.status));
  assert.equal(sum(v15, COMMITTED), sum(v15, ['agreed', 'delivered', 'completion_awaiting_owner', 'issuing_note', 'note_failed', 'accepted_awaiting_owner']));
  // offers made by the payee are reserved by the payee, not the payer
  const w = world(), deals2 = ALL_STATUSES.map((s, i) => addDeal(w.pilot, s, {P: w.P, Q: w.Q, by: w.Q, price: 2 ** i}));
  assert.equal(w.pilot.exposure(w.P, [], {asRole: 'payer'}).reserved, 0);
  assert.equal(w.pilot.exposure(w.Q, [], {asRole: 'payee', counterpartyId: w.P.id}).reserved, sum(deals2, RESERVED_IF_OWN));
  assert.equal(w.pilot.exposure(w.Q, [], {asRole: 'payee', counterpartyId: w.P.id}).committed, sum(deals2, COMMITTED));
  assert.ok(deals.every(d => pilot.s.deals[d.id].status === d.status), 'nothing was swept away');
});

test('position: deal counts per bucket, in the v15 keys and order', async () => {
  const {pilot, P, Q} = world();
  const deals = ALL_STATUSES.map((s, i) => addDeal(pilot, s, {P, Q, by: P, price: i + 1}));
  const ledger = [{issuer: P.id, issuer_handle: P.handle, recipient: Q.id, recipient_handle: Q.handle, outstanding: 9}];
  const pos = await pilot.position(P, ledger);
  assert.deepEqual(Object.keys(pos.deals), POSITION_BUCKETS, 'the same keys, in the same order');
  assert.deepEqual(pos.deals, {credit_notes_issued: 1, open: 3, agreed_note_not_issued: 7, disputed: 1, declined: 1, expired_or_withdrawn: 5});
  assert.deepEqual(pos.debts, [{to: Q.handle, amount: 9}]);
  // the payee never saw the proposal still waiting for P's owner
  assert.deepEqual((await pilot.position(Q, ledger)).deals, {credit_notes_issued: 1, open: 2, agreed_note_not_issued: 7, disputed: 1, declined: 1, expired_or_withdrawn: 5});
  // paid_by_transfer has its own bucket, which position() reports only with circulating credit on
  assert.deepEqual(bucketCounts(deals), {credit_notes_issued: 1, open: 3, agreed_note_not_issued: 7, disputed: 1, declined: 1, expired_or_withdrawn: 5, paid_by_transfer: 1});
  const v15 = deals.filter(d => !['paying_by_transfer', 'paid_by_transfer', 'payment_due'].includes(d.status));
  assert.deepEqual(bucketCounts(v15), {credit_notes_issued: 1, open: 3, agreed_note_not_issued: 5, disputed: 1, declined: 1, expired_or_withdrawn: 5, paid_by_transfer: 0});
  assert.deepEqual(bucketCounts([{status: 'unknown_status'}]), Object.fromEntries(BUCKETS.map(b => [b, 0])), 'an unknown status is in no bucket');
});

test('inbox: the section of a deal in every status, for the payer and for the payee', () => {
  const {pilot, P, Q} = world();
  const deals = ALL_STATUSES.map((s, i) => addDeal(pilot, s, {P, Q, by: P, price: i + 1}));
  const of = s => deals.find(d => d.status === s);
  // An acceptance by Q waiting for P's owner (P must confirm its offer: confirm_offer), and one waiting for nobody listed.
  const held = of('accepted_awaiting_owner');
  pilot.s.approvals.va_000000000001 = {id: 'va_000000000001', participant: P.id, deal_id: held.id, kind: 'confirm_offer', version: 1, terms_hash: held.versions[0].terms_hash, created_at: iso(Date.now()), state: 'pending'};
  const quiet = addDeal(pilot, 'accepted_awaiting_owner', {P, Q, by: P, price: 99});
  const theirs = addDeal(pilot, 'open', {P, Q, by: Q, price: 98});               // an open offer made by the payee
  const sections = x => {
    const box = pilot.inbox(x), out = {};
    for (const k of INBOX_SECTIONS) for (const b of box[k]) { assert.equal(out[b.deal_id], undefined, `${b.deal_id} listed twice`); out[b.deal_id] = k; }
    assert.deepEqual(Object.keys(box), ['respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed']);
    return {box, out};
  };
  const expected = {
    payer: {open: 'waiting_on_others', accepted_awaiting_owner: undefined, agreed: 'waiting_on_others', delivered: 'review_delivery',
      note_failed: 'review_delivery', paying_by_transfer: 'waiting_on_others', payment_due: 'review_delivery'},
    payee: {open: 'respond', accepted_awaiting_owner: 'waiting_on_others', agreed: 'deliver', delivered: 'waiting_on_others',
      completion_awaiting_owner: 'waiting_on_others', paying_by_transfer: 'waiting_on_others', payment_due: 'waiting_on_others'},
  };
  for (const [x, role] of [[P, 'payer'], [Q, 'payee']]) {
    const {box, out} = sections(x);
    for (const s of ALL_STATUSES) {
      const want = TERMINAL.includes(s) ? 'recent_closed' : expected[role][s];
      assert.equal(out[of(s).id], want, `${role} sees a deal in ${s} in ${want ?? 'no section'}`);
    }
    assert.equal(out[quiet.id], undefined, `${role}: an acceptance waiting for no owner is in no section`);
    assert.equal(out[theirs.id], role === 'payer' ? 'respond' : 'waiting_on_others', `${role}: an open offer made by the payee`);
    assert.equal(box.recent_closed.length, TERMINAL.length);
    for (const k of INBOX_SECTIONS) assert.deepEqual(box[k].map(b => b.deal_id), [...pilot.dealsFor(x)].filter(d => out[d.id] === k).map(d => d.id), `${role}.${k} keeps deal order`);
    if (role === 'payer') assert.deepEqual(box.awaiting_your_owner.map(a => a.approval_id), ['va_000000000001']);
  }
  // inboxSection evaluates its conditions only when the status needs them
  const never = () => { throw new Error('not needed'); };
  assert.equal(inboxSection('agreed', 'payee', {ownOffer: never, counterpartyOwnerPending: never}), 'deliver');
  assert.equal(inboxSection('open', 'payer', {ownOffer: () => false, counterpartyOwnerPending: never}), 'respond');
  assert.equal(inboxSection('accepted_awaiting_owner', 'payer', {ownOffer: never, counterpartyOwnerPending: () => true}), 'waiting_on_others');
  assert.equal(inboxSection('no_such_status', 'payer', {ownOffer: never, counterpartyOwnerPending: never}), null);
});

test('next_actions come from STATUS_CLASS for every status and role: v15\'s lists with circulation off; with circulation on, payment by transfer and the D-1 waits', () => {
  // Every status, viewed by its payer P and its payee Q, for deals proposed by P. The v15 lists are written out by hand.
  const V15 = {open: [['withdraw', 'wait_for_counterparty'], ['accept', 'decline', 'counter']], proposed_awaiting_owner: [['wait_for_owner_approval'], ['wait_for_owner_approval']],
    accepted_awaiting_owner: [['wait_for_owner_approval', 'withdraw'], ['wait_for_owner_approval']], agreed: [[], ['deliver']], delivered: [['complete', 'dispute'], []],
    completion_awaiting_owner: [['wait_for_owner_approval'], ['wait_for_owner_approval']], issuing_note: [[], []], note_failed: [['complete'], []],
    ...Object.fromEntries(TERMINAL.filter(s => s !== 'paid_by_transfer').map(s => [s, [[], []]]))};
  const check = ({pilot, P, Q}, want, what) => {
    for (const [s, [payer, payee]] of Object.entries(want)) {
      const d = addDeal(pilot, s, {P, Q, by: P, price: 1});
      assert.deepEqual(pilot.view(d, P).next_actions, payer, `${what}: the payer of a deal in ${s}`);
      assert.deepEqual(pilot.view(d, Q).next_actions, payee, `${what}: the payee of a deal in ${s}`);
    }
  };
  const off = world();
  check(off, V15, 'circulation off');
  // an open offer by the other party while one's own counter-offer waits for one's owner (since v8)
  const mine = addDeal(off.pilot, 'open', {...off, by: off.Q, price: 2});
  mine.pending_counter = {...structuredClone(mine.versions[0]), v: 2, by: off.P.id, state: 'awaiting_owner'};
  assert.deepEqual(off.pilot.view(mine, off.P).next_actions, ['wait_for_owner_approval', 'withdraw', 'decline']);
  assert.deepEqual(off.pilot.view(mine, off.Q).next_actions, ['withdraw', 'wait_for_counterparty']);
  // circulation on (a stub tracker whose capabilities validate, and a pinned binary)
  const PIN = 'ab'.repeat(32);
  const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
    bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
      setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
  const on = world({circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(on.pilot.mode, 'on');
  on.P.mandate.pay_with_held_notes = 'when_asked';
  const ON = {...V15, delivered: [['complete', 'pay_by_transfer', 'dispute'], []], note_failed: [['complete', 'pay_by_transfer'], []], payment_due: [['complete', 'pay_by_transfer'], []],
    paying_by_transfer: [['wait_for_consents'], ['wait_for_consents']], paid_by_transfer: [[], []]};
  check(on, ON, 'circulation on');
  on.P.mandate.pay_with_held_notes = 'never';                          // the payer's own policy does not pay with held notes
  check(on, {delivered: [['complete', 'dispute'], []], note_failed: [['complete'], []], payment_due: [['complete'], []]}, 'pay_with_held_notes never');
  on.P.mandate.pay_with_held_notes = 'when_asked';
  // a deal's payment by transfer, synthetic: collecting (it can be cancelled), ended with its fallback window open,
  // ended long ago, and of an outcome only the owner can resolve
  const pay = (d, state, extra = {}) => {
    const id = 'vt_' + hex(8), key = () => '02' + hex(32);
    on.pilot.s.transfers[id] = {id, kind: 'transfer', deal_id: d.id, state, attempt: 1, timestamp: Date.now() - 1500, amount: 1, created_at: iso(Date.now()), updated_at: iso(Date.now()),
      expires_at: iso(Date.now() + 600e3), fallback_after: null, issuer: {id: on.Q.id, pubkey: key()}, payer: {id: on.P.id, pubkey: on.P.pubkey}, payee: {id: on.Q.id, pubkey: on.Q.pubkey},
      from_edge: {edge: 'a>b', before: {total: 5, timestamp: 1, signature: '02' + hex(64)}, new_total: 4, revision: 1}, to_edge: {edge: 'a>c', before: null, new_total: 1, revision: 1},
      slots: {}, messages: {}, history: [], ...extra};
    d.transfer_ids = [...(d.transfer_ids || []), id]; d.payment = {method: 'transfer', transfer_id: id};
    return on.pilot.s.transfers[id];
  };
  const paying = addDeal(on.pilot, 'paying_by_transfer', {...on, by: on.P, price: 1});
  pay(paying, 'collecting');
  assert.deepEqual([on.pilot.view(paying, on.P).next_actions, on.pilot.view(paying, on.Q).next_actions], [['wait_for_consents', 'cancel_transfer'], ['wait_for_consents']]);
  on.pilot.s.transfers[paying.payment.transfer_id].state = 'applying';
  assert.deepEqual(on.pilot.view(paying, on.P).next_actions, ['wait_for_consents'], 'an applying transfer cannot be cancelled');
  const due = addDeal(on.pilot, 'payment_due', {...on, by: on.P, price: 1});
  const ended = pay(due, 'expired', {fallback_after: Date.now() + 3600e3});
  assert.deepEqual(on.pilot.view(due, on.P).next_actions, ['wait_for_transfer_window'], 'an own note waits for the window, and so does the same note again at a new T (audit VS-1)');
  ended.fallback_after = Date.now() - 1;
  assert.deepEqual(on.pilot.view(due, on.P).next_actions, ['complete', 'pay_by_transfer'], 'after fallback_after');
  const delivered = addDeal(on.pilot, 'delivered', {...on, by: on.P, price: 1});   // a held transfer the owner rejected
  pay(delivered, 'void_rejected', {fallback_after: Date.now() + 3600e3});
  assert.deepEqual(on.pilot.view(delivered, on.P).next_actions, ['wait_for_transfer_window', 'dispute']);
  const unknown = addDeal(on.pilot, 'payment_due', {...on, by: on.P, price: 1});
  pay(unknown, 'outcome_unknown');
  assert.deepEqual([on.pilot.view(unknown, on.P).next_actions, on.pilot.view(unknown, on.Q).next_actions], [[], []], 'only the owner can resolve an attempt that may have applied');
  // the payer's own bound note failed and can still apply until its timestamp + 1 h: a transfer waits, a new note does not
  const failed = addDeal(on.pilot, 'note_failed', {...on, by: on.P, price: 1});
  failed.credit_note = {state: 'failed', issuer_pubkey: on.P.pubkey, recipient_pubkey: on.Q.pubkey, note: {total: 1, timestamp: Date.now() - 2000 - (Date.now() % 1000) + 997, signature: '02' + hex(64), prior_signature: '02' + hex(64)}, prior_total: 0, amount: 1};
  assert.deepEqual(on.pilot.view(failed, on.P).next_actions, ['complete', 'wait_for_transfer_window']);
  // An ordinary failed note (no prior acknowledgment, an ordinary timestamp) never expires: while it could still be
  // recorded, a payment by transfer is refused (409 pending_unbound_note), so it is not offered (SV-5's finding, fix 16).
  delete failed.credit_note.note.prior_signature;
  failed.credit_note.note.timestamp -= 497;                              // ends in 500 ms: an ordinary note
  assert.deepEqual(on.pilot.view(failed, on.P).next_actions, ['complete'], 'an ordinary failed note that can still be recorded: no transfer offered');
  // Once Valun's own journal shows the pair past the note (a later note recorded there), or the pair is bound-only
  // (novated: the tracker refuses ordinary notes there), it can never be recorded: a transfer is offered again.
  const k = `${on.P.pubkey}>${on.Q.pubkey}`;
  on.pilot.s.edges[k] = {issuer: on.P.id, recipient: on.Q.id, expected_total: 1, issued_PC: 1, setoff_PC: 0, transferred_in_PC: 0, transferred_out_PC: 0, novated: false,
    last: {total: 1, timestamp: failed.credit_note.note.timestamp + 1000, signature: '02' + hex(64)}, last_seq: 1};
  assert.deepEqual(on.pilot.view(failed, on.P).next_actions, ['complete', 'pay_by_transfer'], 'the journal shows the pair past the ordinary note');
  on.pilot.s.edges[k].last.timestamp = failed.credit_note.note.timestamp - 1000; on.pilot.s.edges[k].novated = true;
  assert.deepEqual(on.pilot.view(failed, on.P).next_actions, ['complete', 'pay_by_transfer'], 'a bound-only pair: an ordinary note can never be recorded there');
  delete on.pilot.s.edges[k];
});

test('revokeAgent: offer-phase deals are cancelled, a held note is voided, every other status stands', async () => {
  const {pilot, P, Q} = world();
  const deals = ALL_STATUSES.map((s, i) => addDeal(pilot, s, {P, Q, by: P, price: i + 1}));
  const held = deals.find(d => d.status === 'completion_awaiting_owner');
  held.credit_note = {state: 'signed', approval_id: 'va_000000000002', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, note: {total: 5, timestamp: 1, signature: '02' + hex(64)}, prior_total: 0, amount: 5};
  held.completion = {by: P.id};
  pilot.s.approvals.va_000000000002 = {id: 'va_000000000002', participant: P.id, deal_id: held.id, kind: 'issue_note', version: 1, terms_hash: held.agreement.terms_hash, created_at: iso(Date.now()), state: 'pending'};
  const before = Object.fromEntries(deals.map(d => [d.id, d.status]));
  const r = await pilot.revokeAgent(P);
  const byStatus = s => deals.filter(d => before[d.id] === s).map(d => d.id);
  assert.deepEqual(r.cancelled_deals, [...byStatus('open'), ...byStatus('proposed_awaiting_owner'), ...byStatus('accepted_awaiting_owner')]);
  assert.deepEqual(r.voided_credit_notes, byStatus('completion_awaiting_owner'));
  for (const d of deals) {
    const was = before[d.id], now = pilot.s.deals[d.id].status;
    const want = STATUS_CLASS[was].offer_phase ? 'cancelled' : was === 'completion_awaiting_owner' ? 'delivered' : was;
    assert.equal(now, want, `${was} -> ${want}`);
  }
  assert.equal(held.credit_note, null); assert.equal(held.void_notes.at(-1).state, 'void_key_revoked');
  assert.equal(pilot.s.approvals.va_000000000002.state, 'void_key_revoked');
  assert.equal(P.pubkey, null); assert.equal(P.status, 'awaiting_agent');
});
