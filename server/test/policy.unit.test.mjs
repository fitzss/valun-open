// Phase-2 credit policies and the aggregate credit history (design §8, spec 18.13; lib/pilot/policy.mjs) at the unit
// level: a Pilot over a stub tracker (no tracker binary), so these run in the default `npm test` with any binaries.
//   - the credit rules in their order, each passing and failing (a decision table), at an agreement and for a payment
//     by transfer; null means off, and a rule adds a mandate_check entry only when it is set;
//   - the one-level haircut's numbers, exact; only reconciled edges count for claims, every edge for debts;
//   - the operator flag (accept_operator_issuers), the sandbox box (max_claims_total 40, shown in credit_policy and
//     effective_limits also when the mandate predates the field), the agent limit kinds (only ever tighter), and what
//     GET /participants/{id} publishes (credit_policy, credit_history);
//   - max_claims_total counts a payment by transfer in flight once (its transfer, not also its deal);
//   - with circulation off (and in mode bound) none of it runs, and nothing new appears.
// Run: node --test test/policy.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../lib/pilot/core.mjs';
import {appendEntries} from '../lib/pilot/journal.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {creditCheck, haircutNetDebt, exceeds, cents, strictestLimit, agentLimitWidens, offValue, phase2Default, policyValue, publicCreditPolicy,
  CREDIT_RULES, PHASE2_FIELDS, PUBLIC_POLICY_FIELDS, SANDBOX_MAX_CLAIMS_TOTAL} from '../lib/pilot/policy.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const DAY = 864e5, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};

// A Pilot over a stub tracker. `notes`: the tracker's notes (what basis.note and basis.allNotes read). person() adds an
// active participant with a key; owe(I, R, total) puts I->R at `total` on the tracker and, unless {match: false}, in
// Valun's edge journal too (the edge reconciles); deal() and transfer() add a deal or a payment by transfer as stored
// state. `operator`: the ids the stub server signer runs (Pilot.serverRun).
function world({mode = 'on', openSandbox = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-policy-')); dirs.push(dir);
  const notes = new Map(), clock = {t: Date.now()}, operator = new Set();
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async (i, r) => notes.get(`${i}>${r}`) ?? null, allNotes: async () => [...notes.values()],
    capabilities: async () => V3_CAPS};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, openSandbox, circulation: mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, mode);
  pilot.serverSigner = {has: id => operator.has(id), signFor: async () => { throw new Error('no signing in this test'); }};
  let ts = 1_000_000;
  const person = (handle, mandate = {}) => {
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32), status: 'active', created_at: iso(clock.t),
      owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null, mandate: {...DEFAULT_MANDATE, max_accept_per_issuer: 1000, max_accept_per_deal: 100, ...(mode === 'on' || mode === 'sandbox' ? POLICY : {}), ...mandate},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null};
    pilot.s.participants[p.id] = p;
    return p;
  };
  const owe = (I, R, total, {match = true} = {}) => {
    const k = `${I.pubkey}>${R.pubkey}`, prev = pilot.s.edges[k]?.expected_total ?? 0, at = (ts += 1000), signature = '02' + hex(64);
    notes.set(k, {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(total), amount_redeemed: '0', timestamp: at, signature, denomination: PILOT_DENOMINATION});
    if (match && total > prev) appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: at, signature}]);
  };
  const deal = (payer, payee, status, price, {by = payer, offeredAt = iso(clock.t)} = {}) => {
    const id = 'vd_' + hex(8);
    const terms = {deal_id: id, version: 1, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: {title: 'job', description: 'synthetic', deliverable: 'text'},
      price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
    const agreed = !['open', 'proposed_awaiting_owner'].includes(status);
    const v = {v: 1, by: by.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: agreed ? 'accepted' : 'open', offered_at: offeredAt};
    pilot.s.deals[id] = {id, payer: payer.id, payee: payee.id, created_at: iso(clock.t), status, versions: [v], history: [],
      ...(agreed ? {agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)}} : {})};
    return pilot.s.deals[id];
  };
  // `deal`: the deal the transfer pays (it becomes the deal's payment); without one the transfer pays a deal not in the state.
  const transfer = (A, B, C, amount, state = 'collecting', {deal: paid = null} = {}) => {
    const id = 'vt_' + hex(8);
    if (paid) { paid.payment = {method: 'transfer', transfer_id: id}; paid.transfer_ids = [...(paid.transfer_ids || []), id]; }
    pilot.s.transfers[id] = {id, kind: 'transfer', deal_id: paid?.id ?? 'vd_' + hex(8), state, timestamp: ts + 999, amount, created_at: iso(clock.t), updated_at: iso(clock.t), expires_at: iso(clock.t + 20 * 60e3),
      issuer: {id: A.id, pubkey: A.pubkey}, payer: {id: B.id, pubkey: B.pubkey}, payee: {id: C.id, pubkey: C.pubkey},
      from_edge: {edge: `${A.pubkey}>${B.pubkey}`, before: {total: amount, timestamp: 1, signature: '02' + hex(64)}, new_total: 0, revision: 1}, to_edge: {edge: `${A.pubkey}>${C.pubkey}`, before: null, new_total: amount, revision: 1},
      slots: {}, messages: {}, history: [], result: null};
    return pilot.s.transfers[id];
  };
  return {pilot, notes, clock, dir, operator, person, owe, deal, transfer};
}

// The scenario of the decision table. C would hold the claim; X is the issuer (the payer at an agreement, the note's issuer
// in a payment by transfer); Y another participant; Z an issuer whose own claims cover a quarter of its debt; O a
// participant the operator runs. On the tracker (all reconciled): X->C 4, Y->C 3, Z->X 8, W->Z 2.
//   C's claims on all issuers: 4 + 3 = 7.   X: owes 4; holds 8 on Z, whose coverage q(Z) = 2/8, so they count for 2.
//   X's net debt: 4 + delta - 2 (2 for a transfer; 5 at an agreement of 3).
function scenario(mode = 'on') {
  const w = world({mode}), {person, owe, operator} = w;
  const C = person('pc-holder'), X = person('pc-issuer'), Y = person('pc-other'), Z = person('pc-thin'), W = person('pc-w'), O = person('pc-operator');
  operator.add(O.id);
  owe(X, C, 4); owe(Y, C, 3); owe(Z, X, 8); owe(W, Z, 2);
  return {...w, C, X, Y, Z, W, O};
}
const run = (w, X, via, amount = 3) => creditCheck(w.pilot, w.C, X, amount, {via});
const set = (w, m) => Object.assign(w.C.mandate, m);

// =================================================================================================================
test('the credit rules in their order, each passing and failing (a decision table): refuse_notes_from, accept_notes_from (transfers only), accept_operator_issuers, max_accept_per_issuer (transfers; at an agreement checkMandate\'s own), max_claims_total, max_issuer_net_debt; null means off; an entry only when a rule is set', async () => {
  assert.deepEqual(CREDIT_RULES, ['refuse_notes_from', 'accept_notes_from', 'accept_operator_issuers', 'max_accept_per_issuer', 'max_claims_total', 'max_issuer_net_debt']);
  // [what, C's mandate for the row, via, the issuer (a scenario key), expected: null (passes) or the rule that refuses, the rules with an entry when it passes]
  const rows = [
    ['nothing set: no entry at an agreement', {}, 'agreement', 'X', null, []],
    ['nothing set: a transfer checks whose notes, and the per-issuer cap', {}, 'transfer', 'X', null, ['accept_notes_from', 'max_accept_per_issuer']],
    // (a)
    ['(a) refuse_notes_from lists another', {refuse_notes_from: ['Y']}, 'agreement', 'X', null, ['refuse_notes_from']],
    ['(a) refuse_notes_from lists the issuer (agreement)', {refuse_notes_from: ['X']}, 'agreement', 'X', 'refuse_notes_from', null],
    ['(a) refuse_notes_from lists the issuer (transfer)', {refuse_notes_from: ['Y', 'X']}, 'transfer', 'X', 'refuse_notes_from', null],
    // (b)
    ['(b) accept_notes_from "any"', {accept_notes_from: 'any'}, 'transfer', 'X', null, ['accept_notes_from', 'max_accept_per_issuer']],
    ['(b) accept_notes_from lists the issuer', {accept_notes_from: ['Y', 'X']}, 'transfer', 'X', null, ['accept_notes_from', 'max_accept_per_issuer']],
    ['(b) accept_notes_from [] (nobody)', {accept_notes_from: []}, 'transfer', 'X', 'accept_notes_from', null],
    ['(b) accept_notes_from lists only another', {accept_notes_from: ['Y']}, 'transfer', 'X', 'accept_notes_from', null],
    ['(b) is for transfers only: at an agreement counterparties says whom C deals with', {accept_notes_from: []}, 'agreement', 'X', null, []],
    // (c)
    ['(c) accept_operator_issuers true: an operator-run issuer is fine', {accept_operator_issuers: true}, 'agreement', 'O', null, []],
    ['(c) accept_operator_issuers false, an ordinary issuer', {accept_operator_issuers: false}, 'agreement', 'X', null, ['accept_operator_issuers']],
    ['(c) accept_operator_issuers false, an operator-run issuer (agreement)', {accept_operator_issuers: false}, 'agreement', 'O', 'accept_operator_issuers', null],
    ['(c) accept_operator_issuers false, an operator-run issuer (transfer)', {accept_operator_issuers: false}, 'transfer', 'O', 'accept_operator_issuers', null],
    // (d): C holds 4 of X's notes; 4 + 3 = 7
    ['(d) max_accept_per_issuer at exactly 7', {max_accept_per_issuer: 7}, 'transfer', 'X', null, ['accept_notes_from', 'max_accept_per_issuer']],
    ['(d) max_accept_per_issuer 6', {max_accept_per_issuer: 6}, 'transfer', 'X', 'max_accept_per_issuer', null],
    ['(d) at an agreement it is checkMandate\'s check, not repeated here', {max_accept_per_issuer: 0}, 'agreement', 'X', null, []],
    // (e): C's claims on all issuers 7 + 3 = 10
    ['(e) max_claims_total null: no cap', {max_claims_total: null}, 'agreement', 'X', null, []],
    ['(e) max_claims_total at exactly 10', {max_claims_total: 10}, 'agreement', 'X', null, ['max_claims_total']],
    ['(e) max_claims_total 9 (agreement)', {max_claims_total: 9}, 'agreement', 'X', 'max_claims_total', null],
    ['(e) max_claims_total 9 (transfer)', {max_claims_total: 9}, 'transfer', 'X', 'max_claims_total', null],
    ['(e) max_claims_total 0, nothing to hold', {max_claims_total: 0}, 'agreement', 'X', 'max_claims_total', null],
    // (f): X's net debt 4 + 3 - 2 = 5 at an agreement, 4 - 2 = 2 for a transfer
    ['(f) max_issuer_net_debt null: off', {max_issuer_net_debt: null}, 'agreement', 'X', null, []],
    ['(f) max_issuer_net_debt at exactly 5 (agreement)', {max_issuer_net_debt: 5}, 'agreement', 'X', null, ['max_issuer_net_debt']],
    ['(f) max_issuer_net_debt 4 (agreement)', {max_issuer_net_debt: 4}, 'agreement', 'X', 'max_issuer_net_debt', null],
    ['(f) max_issuer_net_debt at exactly 2 (transfer: X\'s total debt does not change)', {max_issuer_net_debt: 2}, 'transfer', 'X', null, ['accept_notes_from', 'max_accept_per_issuer', 'max_issuer_net_debt']],
    ['(f) max_issuer_net_debt 1 (transfer)', {max_issuer_net_debt: 1}, 'transfer', 'X', 'max_issuer_net_debt', null],
    // the order: the first rule that fails is the one named
    ['order: (a) before (c), (e) and (f)', {refuse_notes_from: ['O'], accept_operator_issuers: false, max_claims_total: 0, max_issuer_net_debt: 0}, 'agreement', 'O', 'refuse_notes_from', null],
    ['order: (b) before (c)', {accept_notes_from: [], accept_operator_issuers: false}, 'transfer', 'O', 'accept_notes_from', null],
    ['order: (c) before (e) and (f)', {accept_operator_issuers: false, max_claims_total: 0, max_issuer_net_debt: 0}, 'agreement', 'O', 'accept_operator_issuers', null],
    ['order: (d) before (e)', {max_accept_per_issuer: 0, max_claims_total: 0}, 'transfer', 'X', 'max_accept_per_issuer', null],
    ['order: (e) before (f)', {max_claims_total: 0, max_issuer_net_debt: 0}, 'agreement', 'X', 'max_claims_total', null],
  ];
  for (const [what, m, via, who, expected, entries] of rows) {
    const w = scenario(), ids = {X: w.X.id, Y: w.Y.id, O: w.O.id};
    const resolve = v => (Array.isArray(v) ? v.map(x => ids[x]) : v);
    set(w, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, resolve(v)])));
    const r = await run(w, w[who], via);
    if (expected === null) {
      assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.checks.map(c => c.rule), entries, `${what}: entries`);
    } else {
      assert.deepEqual([r.ok, r.rule, r.source], [false, expected, 'owner_mandate'], `${what}: ${JSON.stringify(r)}`);
      assert.equal(typeof r.detail, 'string');
    }
  }
});

test('the figures the rules count: pending incoming transfers and committed deals (the deal being agreed or paid left out), the entries\' numbers', async () => {
  const w = scenario(), {pilot, C, X, Y, deal, transfer} = w;
  set(w, {max_claims_total: 100, max_issuer_net_debt: 100, max_accept_per_issuer: 100});
  // C is also owed 5 by Y on an agreed deal, and 2 of X's notes are being transferred to it; X has committed 6 as payer.
  deal(Y, C, 'agreed', 5);
  const t = transfer(X, Y, C, 2);
  deal(X, Y, 'delivered', 6);
  const paying = deal(Y, C, 'payment_due', 3);                       // the deal a transfer would pay: never counted twice
  const tr = await creditCheck(pilot, C, X, 3, {via: 'transfer', excludeDealId: paying.id});
  assert.deepEqual(tr.checks.find(c => c.rule === 'max_accept_per_issuer'), {rule: 'max_accept_per_issuer', claim_on_tracker: 4, committed: 0, reserved: 0, pending_in: 2, this_deal: 3, limit: 100});
  assert.deepEqual(tr.checks.find(c => c.rule === 'max_claims_total'), {rule: 'max_claims_total', claims_on_tracker: 7, committed: 5, pending_in: 2, this_deal: 3, limit: 100});
  assert.deepEqual(tr.checks.find(c => c.rule === 'max_issuer_net_debt'),
    {rule: 'max_issuer_net_debt', issuer_owes_on_tracker: 4, issuer_committed: 6, this_deal: 0, issuer_adjusted_claims: 2, issuer_net_debt: 8, limit: 100});
  // checkMandate's own max_accept_per_issuer entry (an agreement with payer X) shows the pending transfer it counts.
  assert.deepEqual((await pilot.checkMandate(C, 'payee', X.id, 3)).checks[0], {rule: 'max_accept_per_issuer', claim_on_tracker: 4, committed: 0, reserved: 0, pending_in: 2, this_deal: 3, limit: 100});
  // The transfer being checked is left out of the pending ones.
  const self = await creditCheck(pilot, C, X, 2, {via: 'transfer', excludeDealId: paying.id, excludeTransferId: t.id});
  assert.equal(self.checks.find(c => c.rule === 'max_claims_total').pending_in, 0);
  // At an agreement of 3 with payer X: the deal's own amount is X's delta.
  const ag = await creditCheck(pilot, C, X, 3, {via: 'agreement'});
  assert.deepEqual(ag.checks.map(c => c.rule), ['max_claims_total', 'max_issuer_net_debt']);
  assert.deepEqual(ag.checks[0], {rule: 'max_claims_total', claims_on_tracker: 7, committed: 8, pending_in: 2, this_deal: 3, limit: 100});
  assert.deepEqual(ag.checks[1], {rule: 'max_issuer_net_debt', issuer_owes_on_tracker: 4, issuer_committed: 6, this_deal: 3, issuer_adjusted_claims: 2, issuer_net_debt: 11, limit: 100});
  // Exactly at a limit passes; one less refuses (7 + 5 + 2 + 3 = 17 for the claims; 4 + 6 - 2 and 4 + 6 + 3 - 2 for the net debt).
  for (const [k, total, via, opts] of [['max_claims_total', 17, 'transfer', {excludeDealId: paying.id}], ['max_claims_total', 20, 'agreement', {}],
    ['max_issuer_net_debt', 8, 'transfer', {}], ['max_issuer_net_debt', 11, 'agreement', {}]]) {
    set(w, {[k]: total});
    assert.equal((await creditCheck(pilot, C, X, 3, {via, ...opts})).ok, true, `${k} ${total}`);
    set(w, {[k]: total - 1});
    assert.equal((await creditCheck(pilot, C, X, 3, {via, ...opts})).rule, k, `${k} ${total - 1}`);
    set(w, {[k]: 100});
  }
  // A transfer that ended no longer counts.
  t.state = 'cancelled';
  assert.equal((await creditCheck(pilot, C, X, 3, {via: 'transfer', excludeDealId: paying.id})).checks.find(c => c.rule === 'max_claims_total').pending_in, 0);
});

test('max_claims_total counts a payment by transfer in flight once: as its transfer (pending_in), never also as its deal (committed); for a deal paying_by_transfer with its collecting transfer and for one held for its payer\'s owner (completion_awaiting_owner, the transfer awaiting_owner)', async () => {
  for (const variant of ['collecting', 'awaiting_owner']) {
    const w = world(), {pilot, person, owe, deal, transfer, clock} = w;
    const C = person('ct-payee'), A = person('ct-issuer'), B = person('ct-payer'), Y = person('ct-other');
    owe(A, B, 10);                                                       // B holds A's notes; C holds nothing on the tracker
    C.mandate.max_claims_total = 6;
    const d = deal(B, C, variant === 'collecting' ? 'paying_by_transfer' : 'completion_awaiting_owner', 3);
    const t = transfer(A, B, C, 3, variant, {deal: d});
    const held = () => pilot.ledger().then(l => pilot.claimsHeld(C, l));
    assert.deepEqual(await held(), {tracker: 0, committed: 0, pending_in: 3, total: 3}, `${variant}: the 3 PC on their way count once`);
    // Another agreement of 3 as payee: 3 + 3 = 6, exactly the cap.
    const ag = await creditCheck(pilot, C, Y, 3, {via: 'agreement'});
    assert.equal(ag.ok, true, `${variant}: an agreement of 3 more is within 6 (${ag.detail ?? ''})`);
    assert.deepEqual(ag.checks.find(c => c.rule === 'max_claims_total'), {rule: 'max_claims_total', claims_on_tracker: 0, committed: 0, pending_in: 3, this_deal: 3, limit: 6});
    assert.equal((await creditCheck(pilot, C, Y, 4, {via: 'agreement'})).rule, 'max_claims_total', `${variant}: 3 + 4 = 7 is above 6`);
    // The payment itself, checked again (its deal and its transfer left out; the caller adds its amount once).
    const again = await creditCheck(pilot, C, A, 3, {via: 'transfer', excludeDealId: d.id, excludeTransferId: t.id});
    assert.deepEqual(again.checks.find(c => c.rule === 'max_claims_total'), {rule: 'max_claims_total', claims_on_tracker: 0, committed: 0, pending_in: 0, this_deal: 3, limit: 6});
    // The deal being paid, checked without its transfer's id (its live transfer is the same payment): counted once too.
    assert.equal((await creditCheck(pilot, C, A, 3, {via: 'transfer', excludeDealId: d.id})).checks.find(c => c.rule === 'max_claims_total').pending_in, 0);
    // A second payment by transfer of 3, for another deal that is due: 3 + 3 = 6 once both complete, accepted.
    const d2 = deal(B, C, 'payment_due', 3);
    const second = await creditCheck(pilot, C, A, 3, {via: 'transfer', excludeDealId: d2.id});
    assert.equal(second.ok, true, `${variant}: a second payment by transfer of 3 (${second.detail ?? ''})`);
    assert.deepEqual(second.checks.find(c => c.rule === 'max_claims_total'), {rule: 'max_claims_total', claims_on_tracker: 0, committed: 0, pending_in: 3, this_deal: 3, limit: 6});
    delete pilot.s.deals[d2.id];
    // Once the transfer's time passes (nobody read it since: claimsHeld sweeps it first), the deal returns to
    // payment_due or delivered and counts as committed, once.
    clock.t = Date.parse(t.expires_at) + 1000;
    assert.deepEqual(await held(), {tracker: 0, committed: 3, pending_in: 0, total: 3}, `${variant}: the deal counts again once its transfer ended`);
    assert.equal(t.state, 'expired');
    assert.equal(d.status, variant === 'collecting' ? 'payment_due' : 'delivered');
  }
});

test('a sandbox participant whose mandate predates max_claims_total is held to the box\'s 40 and sees it: credit_policy and effective_limits (/me, /owner) show 40 in modes sandbox and on; an agent limit below it shows the lower; nothing new in modes off and bound, nor for an invited participant', async () => {
  for (const mode of ['off', 'bound', 'sandbox', 'on']) {
    const w = world({mode}), {pilot, person} = w, circulating = mode === 'sandbox' || mode === 'on';
    const X = person('sbx-agent-x');
    pilot.sandboxIds = new Set([X.id]);
    const until = iso(w.clock.t + 7 * DAY);
    const old = person('sbx-before', {counterparties: [X.id], max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40,
      expires_at: until, ...(circulating ? {accept_notes_from: [X.id]} : {})});
    old.sandbox_only = true; old.sandbox_expires_at = until;
    const invited = person('invited');
    assert.equal('max_claims_total' in old.mandate, false, 'precondition: the mandate predates the field');
    const token = 'vpo_' + hex(16), agentToken = 'vpa_' + hex(16);
    old.owner_token_hash = crypto.createHash('sha256').update(token).digest('hex');
    old.agent_token_hash = crypto.createHash('sha256').update(agentToken).digest('hex');
    const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}});
    const get = async (p, tok) => {
      let out;
      await routes({method: 'GET', headers: {authorization: `Bearer ${tok}`}, socket: {remoteAddress: '127.0.0.1'}}, {}, new URL(`http://x/pilot/v1${p}`), (res, status, body) => { out = {status, body}; }, () => '127.0.0.1');
      assert.equal(out.status, 200, `${mode} ${p}`);
      return out.body;
    };
    const me = await get('/me', agentToken), owner = await get('/owner', token);
    if (!circulating) {
      for (const b of [me, owner]) {
        assert.equal('max_claims_total' in b.effective_limits, false, `${mode}: effective_limits as before`);
        assert.equal('credit_policy' in b, false, `${mode}: no credit_policy`);
      }
      assert.deepEqual(pilot.effectiveLimits(old), {...old.mandate}, `${mode}: the effective limits are the mandate`);
      continue;
    }
    for (const b of [me, owner]) {
      assert.equal(b.effective_limits.max_claims_total, 40, `${mode}: effective_limits shows the enforced cap`);
      assert.equal(b.credit_policy.max_claims_total, 40, `${mode}: credit_policy shows the enforced cap`);
      assert.equal('max_issuer_net_debt' in b.credit_policy || 'accept_operator_issuers' in b.credit_policy, false, `${mode}: the fields at their plain defaults stay absent`);
      assert.equal('max_claims_total' in b.mandate, false, `${mode}: the stored mandate is unchanged`);
    }
    // It is the value the rule applies: 38 on the tracker + 3 > 40.
    w.owe(X, old, 38);
    assert.deepEqual((r => [r.ok, r.rule])(await creditCheck(pilot, old, X, 3, {via: 'agreement'})), [false, 'max_claims_total']);
    // An agent limit below it: the lower shows, and applies.
    pilot.setAgentLimits(old, {max_claims_total: 30});
    assert.equal(pilot.effectiveLimits(old).max_claims_total, 30);
    assert.equal(pilot.creditPolicy(old).max_claims_total, 40, 'credit_policy is the owner\'s side');
    // Once the owner sets the field, it is the mandate's value.
    pilot.setMandate(old, {max_claims_total: 20});
    assert.equal(pilot.creditPolicy(old).max_claims_total, 20);
    assert.equal(pilot.effectiveLimits(old).max_claims_total, 20);
    // An invited participant who never set the field: nothing new.
    assert.equal('max_claims_total' in pilot.creditPolicy(invited), false, `${mode}: invited, no field`);
    assert.equal('max_claims_total' in pilot.effectiveLimits(invited), false, `${mode}: invited, no field`);
  }
});

test('the one-level haircut: q(I) = 1 when I owes nothing, else min(1, claims(I) / owes(I)); exact fractions, never passed or missed by rounding; net debt is never below 0', () => {
  const nd = x => Number(x.num) / Number(x.den);
  // No claims: owes + committed + delta.
  let r = haircutNetDebt({owes: 10, committed: 2, delta: 3, issuers: []});
  assert.deepEqual([nd(r.adjusted), nd(r.net)], [0, 15]);
  // An issuer that owes nothing counts in full (q = 1); one that holds more than it owes is capped at q = 1.
  r = haircutNetDebt({owes: 10, issuers: [{held: 4, claims: 0, owes: 0}, {held: 3, claims: 50, owes: 5}]});
  assert.deepEqual([nd(r.adjusted), nd(r.net)], [7, 3]);
  // q = claims / owes: 10 held on an issuer that owes 20 and holds 5 count for 2.5.
  r = haircutNetDebt({owes: 10, committed: 2, delta: 3, issuers: [{held: 10, claims: 5, owes: 20}]});
  assert.deepEqual([nd(r.adjusted), nd(r.net)], [2.5, 12.5]);
  assert.deepEqual([exceeds(r.net, 12), exceeds(r.net, 13), cents(r.net, 'up'), cents(r.adjusted, 'down')], [true, false, 12.5, 2.5]);
  // An issuer with no claims of its own counts for nothing (q = 0).
  r = haircutNetDebt({owes: 6, issuers: [{held: 9, claims: 0, owes: 9}]});
  assert.deepEqual([nd(r.adjusted), nd(r.net)], [0, 6]);
  // Thirds that add up to exactly 2: a limit of 4 is met exactly, not missed by a rounding error.
  r = haircutNetDebt({owes: 6, issuers: [{held: 1, claims: 1, owes: 3}, {held: 5, claims: 1, owes: 3}]});
  assert.deepEqual([r.adjusted.num, r.adjusted.den, r.net.num, r.net.den], [2n, 1n, 4n, 1n]);
  assert.deepEqual([exceeds(r.net, 4), exceeds(r.net, 3)], [false, true]);
  // A third short of an integer: 4 + 2/3 exceeds 4 and is shown as 4.67 (up) / its adjusted claims as 1.33 (down).
  r = haircutNetDebt({owes: 6, issuers: [{held: 4, claims: 1, owes: 3}]});
  assert.deepEqual([exceeds(r.net, 4), exceeds(r.net, 5), cents(r.net, 'up'), cents(r.adjusted, 'down')], [true, false, 4.67, 1.33]);
  // Claims worth more than the debts: net debt 0.
  r = haircutNetDebt({owes: 2, issuers: [{held: 10, claims: 0, owes: 0}]});
  assert.deepEqual([nd(r.net), exceeds(r.net, 0)], [0, false]);
});

test('the haircut over the ledger: only reconciled edges count for claims (a note issued around Valun neither raises a holder\'s claims nor an issuer\'s coverage); every tracker edge counts for debts', async () => {
  const net = async w => (await creditCheck(w.pilot, w.C, w.X, 0, {via: 'transfer'})).checks.find(c => c.rule === 'max_issuer_net_debt');
  let w = scenario();
  set(w, {max_issuer_net_debt: 1000});
  assert.deepEqual([(await net(w)).issuer_owes_on_tracker, (await net(w)).issuer_adjusted_claims, (await net(w)).issuer_net_debt], [4, 2, 2]);
  // A note around Valun on Z's own incoming edge (W->Z now 8 on the tracker, 2 in the journal): that edge does not
  // reconcile, so it counts for none of Z's claims: q(Z) = 0 and X's 8 on Z count for nothing.
  w.owe(w.W, w.Z, 8, {match: false});
  assert.deepEqual([(await net(w)).issuer_adjusted_claims, (await net(w)).issuer_net_debt], [0, 4]);
  // A note around Valun to X (Y->X 50, not in the journal) is no claim of X's.
  w = scenario(); set(w, {max_issuer_net_debt: 1000});
  w.owe(w.Y, w.X, 50, {match: false});
  assert.deepEqual([(await net(w)).issuer_adjusted_claims, (await net(w)).issuer_net_debt], [2, 2]);
  // A debt of X's around Valun (X->W 5, not in the journal) still counts for what X owes.
  w.owe(w.X, w.W, 5, {match: false});
  assert.deepEqual([(await net(w)).issuer_owes_on_tracker, (await net(w)).issuer_net_debt], [9, 7]);
  // Z reconciled and better covered: Z holds 6 of W's (W->Z 6), so q(Z) = 6/8 and X's 8 on Z count for 6.
  w = scenario(); set(w, {max_issuer_net_debt: 1000});
  w.owe(w.W, w.Z, 6);
  assert.deepEqual([(await net(w)).issuer_adjusted_claims, (await net(w)).issuer_net_debt], [6, 0]);
});

test('Pilot.checkMandate (payee, an agreement): a refusal is 403 mandate_exceeded {rule, source, mandate_version}; the new entries follow the existing ones only when a rule is set; with circulation off and in mode bound none of the rules runs', async () => {
  const w = scenario(), {pilot, C, X, O} = w, base = structuredClone(C.mandate);
  const before = await pilot.checkMandate(C, 'payee', X.id, 3);
  assert.deepEqual(before.checks, [{rule: 'max_accept_per_issuer', claim_on_tracker: 4, committed: 0, reserved: 0, this_deal: 3, limit: 1000}], 'nothing set: as before');
  set(w, {refuse_notes_from: [w.Y.id], accept_operator_issuers: false, max_claims_total: 10, max_issuer_net_debt: 5, min_payer_coverage_pct: 1});
  const all = await pilot.checkMandate(C, 'payee', X.id, 3);
  assert.deepEqual(all.checks.map(c => c.rule), ['max_accept_per_issuer', 'min_payer_coverage_pct', 'refuse_notes_from', 'accept_operator_issuers', 'max_claims_total', 'max_issuer_net_debt']);
  assert.deepEqual(all.checks.slice(2), [{rule: 'refuse_notes_from', issuer_listed: false}, {rule: 'accept_operator_issuers', issuer_operator_run: false, limit: false},
    {rule: 'max_claims_total', claims_on_tracker: 7, committed: 0, pending_in: 0, this_deal: 3, limit: 10},
    {rule: 'max_issuer_net_debt', issuer_owes_on_tracker: 4, issuer_committed: 0, this_deal: 3, issuer_adjusted_claims: 2, issuer_net_debt: 5, limit: 5}]);
  C.mandate = structuredClone(base);
  const refusal = async (rule, m, issuer = X) => {
    const saved = structuredClone(C.mandate);
    Object.assign(C.mandate, m);
    try {
      await assert.rejects(pilot.checkMandate(C, 'payee', issuer.id, 3), e => e instanceof PilotError && e.code === 'mandate_exceeded' && e.status === 403
        && e.extra.rule === rule && e.extra.source === 'owner_mandate' && e.extra.mandate_version === C.mandate_version && /^mandate: /.test(e.message), rule);
    } finally { C.mandate = saved; }
  };
  await refusal('refuse_notes_from', {refuse_notes_from: [X.id]});
  await refusal('accept_operator_issuers', {accept_operator_issuers: false}, O);
  await refusal('max_claims_total', {max_claims_total: 9});
  await refusal('max_issuer_net_debt', {max_issuer_net_debt: 4});
  // The existing check comes first: the per-issuer cap is refused before the new rules run.
  await refusal('max_accept_per_issuer', {max_accept_per_issuer: 6, max_claims_total: 0});
  // A value the agent recorded that refuses names agent_limits as the source, and who recorded it.
  C.mandate.max_claims_total = null;
  pilot.setAgentLimits(C, {max_claims_total: 9});
  await assert.rejects(pilot.checkMandate(C, 'payee', X.id, 3), e => e.extra.rule === 'max_claims_total' && e.extra.source === 'agent_limits' && e.extra.recorded_by === 'agent'
    && /^limit recorded from the owner's instructions: /.test(e.message));
  pilot.setAgentLimits(C, {max_claims_total: null, refuse_notes_from: [w.Y.id, X.id]});
  await assert.rejects(pilot.checkMandate(C, 'payee', X.id, 3), e => e.extra.rule === 'refuse_notes_from' && e.extra.source === 'agent_limits');
  C.mandate.refuse_notes_from = [X.id];
  await assert.rejects(pilot.checkMandate(C, 'payee', X.id, 3), e => e.extra.rule === 'refuse_notes_from' && e.extra.source === 'owner_mandate', 'the owner listed it too');
  // Modes off and bound: none of the rules runs (the fields stay in the mandate and are ignored), the checks are v15's,
  // although in mode on X is refused (refuse_notes_from) and so is any claim (max_claims_total 0).
  Object.assign(C.mandate, {max_claims_total: 0, accept_operator_issuers: false, max_issuer_net_debt: 0});
  for (const mode of ['off', 'bound']) {
    pilot.circulation = mode;
    assert.equal(pilot.mode, mode);
    for (const payer of [X, O]) {
      const chk = await pilot.checkMandate(C, 'payee', payer.id, 3);
      assert.deepEqual(chk.checks, [{rule: 'max_accept_per_issuer', claim_on_tracker: payer === X ? 4 : 0, committed: 0, reserved: 0, this_deal: 3, limit: 1000}], `${mode}, payer ${payer.handle}`);
    }
  }
  pilot.circulation = 'on';
  await assert.rejects(pilot.checkMandate(C, 'payee', X.id, 3), e => e.extra?.rule === 'refuse_notes_from');
});

test('Pilot.receivingTransferCheck (a payment by transfer): each new rule refuses with 403 payment_not_accepted {rule, by: payee}; the deal being paid is not counted twice', async () => {
  const w = scenario(), {pilot, C, X, O, Y, deal} = w;
  C.client_features = {consents: true, roles: ['creditor'], at: iso(w.clock.t)};
  const paying = deal(Y, C, 'delivered', 3);
  await pilot.receivingTransferCheck(C, X, 3, {dealId: paying.id});
  const refused = async (rule, m, issuer = X, opts = {dealId: paying.id}) => {
    const saved = structuredClone(C.mandate);
    Object.assign(C.mandate, m);
    try {
      await assert.rejects(pilot.receivingTransferCheck(C, issuer, 3, opts), e => e instanceof PilotError && e.code === 'payment_not_accepted' && e.status === 403
        && e.extra.rule === rule && e.extra.by === 'payee', rule);
    } finally { C.mandate = saved; }
  };
  await refused('refuse_notes_from', {refuse_notes_from: [X.id]});
  await refused('accept_notes_from', {accept_notes_from: [Y.id]});
  await refused('accept_operator_issuers', {accept_operator_issuers: false}, O);
  await refused('max_accept_per_issuer', {max_accept_per_issuer: 6});
  await refused('max_issuer_net_debt', {max_issuer_net_debt: 1});
  // C's claims 7 + this 3 = 10: the deal being paid (3, committed) is left out, so 10 passes; counted, it would be 13.
  Object.assign(C.mandate, {max_claims_total: 10});
  await pilot.receivingTransferCheck(C, X, 3, {dealId: paying.id});
  await refused('max_claims_total', {max_claims_total: 9});
  await refused('max_claims_total', {max_claims_total: 12}, X, {});
  // Checks that are not credit rules keep their place: the mandate's expiry and counterparties come first, the
  // coverage floor and the client's creditor role after.
  await refused('counterparties', {counterparties: [Y.id], refuse_notes_from: [X.id]});
  await refused('expires_at', {expires_at: iso(w.clock.t - 1000), accept_operator_issuers: false}, O);
  C.client_features = null;
  await refused('max_claims_total', {max_claims_total: 9});
  await refused('creditor_consent', {});
});

test('accept_operator_issuers: notes of a participant whose keys the operator holds (the sandbox agents) are refused only when it is off; its default is true; the flag follows the server signer', async () => {
  const w = scenario(), {pilot, C, X, O, operator} = w;
  assert.equal('accept_operator_issuers' in C.mandate, false, 'not set: its default applies');
  assert.equal(policyValue(C, C.mandate, 'accept_operator_issuers'), true);
  assert.equal((await run(w, O, 'agreement')).ok, true);
  set(w, {accept_operator_issuers: false});
  assert.equal((await run(w, O, 'agreement')).rule, 'accept_operator_issuers');
  assert.equal((await run(w, O, 'transfer')).rule, 'accept_operator_issuers');
  assert.equal((await run(w, X, 'transfer')).ok, true, 'an issuer the operator does not run');
  operator.delete(O.id);
  assert.equal((await run(w, O, 'agreement')).ok, true, 'once the server no longer signs for it');
  operator.add(X.id);
  assert.equal((await run(w, X, 'agreement')).rule, 'accept_operator_issuers');
  // Its credit history says so.
  assert.equal((await pilot.publicPosition(X)).credit_history.operator_run, true);
  assert.equal((await pilot.publicPosition(C)).credit_history.operator_run, false);
});

test('the sandbox box: a sandbox joiner\'s max_claims_total is 40 (SANDBOX_CAPS); its owner may lower it, never raise it or set null (no cap); the operator may; one who joined before the field existed has 40 too; with circulation off the field does not exist', async () => {
  for (const mode of ['off', 'on']) {
    const w = world({mode, openSandbox: true}), {pilot, person} = w;
    const X = person('sbx-agent-x'), M = person('sbx-agent-m');
    pilot.sandboxIds = new Set([X.id, M.id]);
    const j = await pilot.joinSandbox({handle: `sbx-${mode}-joiner`}), S = pilot.s.participants[j.participant_id];
    if (mode === 'off') {
      assert.equal('max_claims_total' in S.mandate, false, 'mode off: the v15 mandate');
      for (const k of PHASE2_FIELDS) assert.equal(k in S.mandate, false, k);
      pilot.setMandate(S, {max_claims_total: 1000});
      assert.equal('max_claims_total' in S.mandate, false, 'ignored like any unknown field');
      continue;
    }
    assert.equal(S.mandate.max_claims_total, SANDBOX_MAX_CLAIMS_TOTAL);
    assert.equal(S.mandate_version, 2, 'one change: the sandbox mandate');
    assert.equal(pilot.setMandate(S, {max_claims_total: 30}).mandate.max_claims_total, 30, 'lowering is allowed');
    assert.equal(pilot.setMandate(S, {max_claims_total: 40}).mandate.max_claims_total, 40, 'up to the box again');
    for (const v of [41, null]) assert.throws(() => pilot.setMandate(S, {max_claims_total: v}), e => e.code === 'sandbox_only' && e.status === 403 && /max_claims_total is at most 40/.test(e.message), String(v));
    assert.equal(S.mandate.max_claims_total, 40);
    // The other phase-2 fields are within the box whatever their value (their widest is the joiner's own default).
    assert.equal(pilot.setMandate(S, {max_issuer_net_debt: 5, accept_operator_issuers: false}).changed, true);
    assert.equal(pilot.setMandate(S, {max_issuer_net_debt: null, accept_operator_issuers: true}).changed, true);
    assert.equal(pilot.setMandate(S, {max_claims_total: null}, {by: 'operator'}).mandate.max_claims_total, null, 'the operator may widen it');
    // A sandbox participant who joined before the field existed (its mandate inside the box, without max_claims_total):
    // its default is the box's 40, and it is enforced.
    const until = iso(w.clock.t + 7 * DAY);
    const old = person('sbx-before', {counterparties: [X.id, M.id], max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40,
      expires_at: until, accept_notes_from: [X.id, M.id]});
    old.sandbox_only = true; old.sandbox_expires_at = until;
    assert.equal('max_claims_total' in old.mandate, false);
    assert.equal(phase2Default(old, 'max_claims_total'), 40);
    w.owe(X, old, 38);
    const r = await creditCheck(pilot, old, X, 3, {via: 'agreement'});
    assert.deepEqual([r.ok, r.rule], [false, 'max_claims_total'], 'claims 38 + 3 > 40');
    assert.throws(() => pilot.setMandate(old, {max_claims_total: null}), e => e.code === 'sandbox_only');
    assert.equal(pilot.setMandate(old, {objective: 'try the sandbox'}).changed, true, 'its owner can still change other fields');
  }
});

test('setMandate: the phase-2 fields are validated and stored only in modes sandbox and on; a field set to its default is no change (OQ-13)', () => {
  const w = world(), {pilot, person} = w, P = person('pm-owner');
  for (const [m, msg] of [[{max_claims_total: -1}, /max_claims_total must be null/], [{max_claims_total: 100001}, /max_claims_total/], [{max_claims_total: '5'}, /max_claims_total/],
    [{max_issuer_net_debt: 1.5}, /max_issuer_net_debt must be null/], [{accept_operator_issuers: 'no'}, /accept_operator_issuers must be true or false/]])
    assert.throws(() => pilot.setMandate(P, m), e => e.code === 'invalid_field' && msg.test(e.message), JSON.stringify(m));
  const v0 = P.mandate_version;
  for (const m of [{max_claims_total: null}, {max_issuer_net_debt: null}, {accept_operator_issuers: true}, {max_claims_total: null, max_issuer_net_debt: null, accept_operator_issuers: true}]) {
    const r = pilot.setMandate(P, m);
    assert.deepEqual([r.changed, P.mandate_version], [false, v0], `${JSON.stringify(m)}: the default, no change`);
  }
  for (const k of PHASE2_FIELDS) assert.equal(k in P.mandate, false, `${k}: not stored`);
  const r = pilot.setMandate(P, {max_claims_total: 25, max_issuer_net_debt: 0, accept_operator_issuers: false});
  assert.deepEqual([r.changed, r.mandate_version, P.mandate.max_claims_total, P.mandate.max_issuer_net_debt, P.mandate.accept_operator_issuers], [true, v0 + 1, 25, 0, false]);
  assert.equal(pilot.setMandate(P, {max_claims_total: 25}).changed, false);
  // Back to mode bound: the fields stay and are ignored.
  pilot.circulation = 'bound';
  assert.equal(pilot.setMandate(P, {max_claims_total: 1}).changed, false);
  assert.equal(P.mandate.max_claims_total, 25);
});

test('agent limit kinds only ever tighten: ncap (null = no cap), allow (subset only), deny (superset only), off_only (booleans and pay_with_held_notes only off); effectiveLimits takes the strictest; with circulation off the new fields are ignored', () => {
  // The pure rules.
  assert.deepEqual([strictestLimit('ncap', 'x', null, 5), strictestLimit('ncap', 'x', 3, 5), strictestLimit('ncap', 'x', 9, 5)], [5, 3, 5]);
  assert.deepEqual([strictestLimit('allow', 'x', 'any', ['a']), strictestLimit('allow', 'x', ['a', 'b'], ['b', 'c']), strictestLimit('allow', 'x', ['a'], 'any')], [['a'], ['b'], ['a']]);
  assert.deepEqual(strictestLimit('deny', 'x', ['a'], ['b', 'a']), ['a', 'b']);
  assert.deepEqual([strictestLimit('off_only', 'auto_clear', true, false), strictestLimit('off_only', 'auto_clear', false, true), strictestLimit('off_only', 'pay_with_held_notes', 'prefer', 'never')], [false, false, 'never']);
  assert.deepEqual([offValue('pay_with_held_notes'), offValue('accept_transfers')], ['never', false]);
  assert.equal(agentLimitWidens('ncap', 'x', null, 100000), null);
  assert.equal(agentLimitWidens('ncap', 'x', 5, 6).code, 'above_owner_mandate');
  assert.equal(agentLimitWidens('allow', 'x', ['a'], ['a', 'b']).code, 'above_owner_mandate');
  assert.equal(agentLimitWidens('deny', 'x', ['a', 'b'], ['b']).code, 'below_owner_mandate');
  assert.equal(agentLimitWidens('off_only', 'x', false, true).code, 'above_owner_mandate');
  assert.equal(agentLimitWidens('off_only', 'x', true, true), null, 'the owner\'s own value: no change');
  // Through the Pilot (mode on).
  const w = world(), {pilot, person} = w, P = person('al-agent'), X = person('al-x'), Y = person('al-y'), Z = person('al-z');
  const lim = body => pilot.setAgentLimits(P, body);
  const refused = (body, code) => assert.throws(() => lim(body), e => e instanceof PilotError && e.code === code && e.status === (code === 'invalid_field' ? 400 : 403), JSON.stringify(body));
  const eff = k => pilot.effectiveLimits(P)[k];
  // ncap: the owner has no cap; the agent sets one, the owner sets a lower one, the agent cannot go above it.
  lim({max_claims_total: 30, max_issuer_net_debt: 8});
  assert.deepEqual([eff('max_claims_total'), eff('max_issuer_net_debt')], [30, 8]);
  pilot.setMandate(P, {max_claims_total: 20});
  assert.equal(eff('max_claims_total'), 20, 'the owner\'s lower cap applies');
  refused({max_claims_total: 25}, 'above_owner_mandate');
  refused({max_claims_total: -1}, 'invalid_field');
  lim({max_claims_total: 12});
  assert.equal(eff('max_claims_total'), 12);
  // off_only: booleans can only be turned off; pay_with_held_notes only to never.
  lim({accept_operator_issuers: false, auto_clear: false, accept_transfers: false, novate_own_debt: false, pay_with_held_notes: 'never'});
  assert.deepEqual(['accept_operator_issuers', 'auto_clear', 'accept_transfers', 'novate_own_debt', 'pay_with_held_notes'].map(eff), [false, false, false, false, 'never']);
  pilot.setMandate(P, {accept_transfers: false, pay_with_held_notes: 'when_asked'});
  refused({accept_transfers: true}, 'above_owner_mandate');
  refused({pay_with_held_notes: 'prefer'}, 'above_owner_mandate');
  refused({auto_clear: 'off'}, 'invalid_field');
  refused({pay_with_held_notes: 'always'}, 'invalid_field');
  lim({auto_clear: true});                                           // the owner's own value: allowed, changes nothing
  assert.equal(eff('auto_clear'), true);
  // allow: a subset of the owner's list ('any' = everyone); deny: a superset of the owner's.
  lim({accept_notes_from: [X.id, Y.id]});
  assert.deepEqual(eff('accept_notes_from'), [X.id, Y.id], 'the owner accepts any: the agent\'s list applies');
  pilot.setMandate(P, {accept_notes_from: [Y.id, Z.id]});
  assert.deepEqual(eff('accept_notes_from'), [Y.id], 'the intersection');
  refused({accept_notes_from: [X.id]}, 'above_owner_mandate');
  refused({accept_notes_from: 'any'}, 'invalid_field');
  refused({accept_notes_from: ['vp_000000000000']}, 'invalid_field');
  pilot.setMandate(P, {refuse_notes_from: [X.id]});
  lim({refuse_notes_from: [X.id, Z.id, Z.id]});
  assert.deepEqual(eff('refuse_notes_from'), [X.id, Z.id], 'the union (no repeats)');
  refused({refuse_notes_from: [Z.id]}, 'below_owner_mandate');
  assert.equal(pilot.limitSource(P, 'refuse_notes_from', {issuer: Z.id}), 'agent_limits');
  assert.equal(pilot.limitSource(P, 'refuse_notes_from', {issuer: X.id}), 'owner_mandate');
  assert.equal(pilot.limitSource(P, 'accept_notes_from', {issuer: Z.id}), 'agent_limits', 'the owner accepts Z, the agent does not');
  assert.equal(pilot.limitSource(P, 'accept_notes_from', {issuer: X.id}), 'owner_mandate');
  assert.equal(pilot.limitSource(P, 'max_claims_total'), 'agent_limits');
  assert.equal(pilot.limitSource(P, 'accept_operator_issuers'), 'agent_limits');
  // null clears an agent limit; the owner's value applies again.
  lim({max_claims_total: null, refuse_notes_from: null, accept_operator_issuers: null});
  assert.deepEqual([eff('max_claims_total'), eff('refuse_notes_from'), eff('accept_operator_issuers')], [20, [X.id], undefined]);
  assert.equal(policyValue(P, pilot.effectiveLimits(P), 'accept_operator_issuers'), true, 'not set anywhere: its default');
  assert.deepEqual(Object.keys(P.agent_limits_recorded_by).sort(), ['accept_notes_from', 'accept_transfers', 'auto_clear', 'max_issuer_net_debt', 'novate_own_debt', 'pay_with_held_notes']);
  // The existing kinds are as before.
  refused({max_accept_per_issuer: 1001}, 'above_owner_mandate');
  refused({min_payer_coverage_pct: -1}, 'invalid_field');
  // Mode off: the new fields are ignored as unknown fields were (agent_limits and effective_limits are v15's).
  const off = world({mode: 'off'}), Q = off.person('al-off'), before = structuredClone(Q);
  const r = off.pilot.setAgentLimits(Q, {max_claims_total: 1, accept_operator_issuers: false, accept_notes_from: [], refuse_notes_from: [Q.id], auto_clear: false, pay_with_held_notes: 'never', max_issue_per_deal: 7});
  assert.deepEqual(Object.keys(r.agent_limits).sort(), ['max_issue_per_deal', 'set_at']);
  assert.deepEqual(r.agent_limits_recorded_by, {max_issue_per_deal: 'agent'});
  assert.deepEqual(r.effective_limits, {...before.mandate, max_issue_per_deal: 7});
});

test('GET /participants/{id} (circulation on): public_position.credit_policy shows the predicate fields as applied (never a cap), public_position.credit_history aggregates only; the own position has neither; modes off and bound show neither', async () => {
  const w = scenario(), {pilot, C, X, Y, Z, deal, clock} = w;
  // C's deals: two notes issued as payer (3 + 4), one paid by transfer as payer (2) and one as payee (5), one accepted and
  // unpaid, a dispute raised and two received, one not delivered as payee, and some still open or agreed.
  deal(C, X, 'note_issued', 3, {offeredAt: iso(clock.t - 5 * DAY)}); deal(C, Y, 'note_issued', 4);
  deal(C, Y, 'paid_by_transfer', 2); deal(Y, C, 'paid_by_transfer', 5);
  deal(C, Z, 'payment_due', 6); deal(C, X, 'disputed', 1); deal(X, C, 'disputed', 1); deal(Y, C, 'disputed', 2);
  deal(X, C, 'expired_undelivered', 3); deal(C, X, 'agreed', 9); deal(X, C, 'open', 2, {by: X, offeredAt: iso(clock.t - 9 * DAY)});
  deal(Y, C, 'proposed_awaiting_owner', 7, {by: Y, offeredAt: null});
  // One applied set-off with C as a member, 2 PC on its edges (journal entries on C>X and X>C).
  appendEntries(pilot, [{kind: 'issue', ref: 'vd_x', issuer_pubkey: C.pubkey, recipient_pubkey: X.pubkey, delta: 2, total_after: 2, timestamp: 5_000_000, signature: '02' + hex(64)}]);
  w.notes.set(`${C.pubkey}>${X.pubkey}`, {issuer_pubkey: C.pubkey, recipient_pubkey: X.pubkey, amount_collected: '0', amount_redeemed: '0', timestamp: 5_000_998, signature: '02' + hex(64), denomination: PILOT_DENOMINATION});
  appendEntries(pilot, [{kind: 'setoff', ref: 'vs_0000000000000001', issuer_pubkey: C.pubkey, recipient_pubkey: X.pubkey, delta: -2, total_after: 0, timestamp: 5_000_998, signature: '02' + hex(64)},
    {kind: 'setoff', ref: 'vs_0000000000000001', issuer_pubkey: X.pubkey, recipient_pubkey: C.pubkey, delta: -2, total_after: 2, timestamp: 5_000_998, signature: '02' + hex(64)}]);
  pilot.s.setoffs.vs_0000000000000001 = {id: 'vs_0000000000000001', kind: 'setoff', state: 'applied', members: [C.id, X.id], edges: [], updated_at: iso(clock.t)};
  pilot.s.setoffs.vs_0000000000000002 = {id: 'vs_0000000000000002', kind: 'setoff', state: 'expired', members: [C.id, X.id], edges: [], updated_at: iso(clock.t)};
  // The owner's credit policy, tightened by its agent.
  set(w, {refuse_notes_from: [Z.id], max_claims_total: 500, max_issuer_net_debt: 50, max_accept_per_issuer: 300, accept_operator_issuers: true});
  pilot.setAgentLimits(C, {accept_notes_from: [X.id], accept_operator_issuers: false});
  const pub = await pilot.publicPosition(C);
  assert.deepEqual(Object.keys(pub).slice(-2), ['credit_policy', 'credit_history']);
  assert.deepEqual(Object.keys(pub.credit_policy), [...PUBLIC_POLICY_FIELDS]);
  assert.deepEqual(pub.credit_policy, {accept_transfers: true, accept_notes_from: [X.id], refuse_notes_from: [Z.id], accept_operator_issuers: false, max_issuer_net_debt: 50});
  assert.deepEqual(publicCreditPolicy(pilot, C), pub.credit_policy);
  for (const cap of ['max_claims_total', 'max_accept_per_issuer', 'max_accept_per_deal', 'min_payer_coverage_pct', 'counterparties', 'approve_above'])
    assert.equal(cap in pub.credit_policy, false, `${cap} stays private`);
  assert.deepEqual(pub.credit_history, {notes_issued: {count: 2, PC: 7}, paid_by_transfer: {count: 1, PC: 2}, received_by_transfer: {count: 1, PC: 5},
    cleared_by_setoff: {count: 1, PC: 2}, payment_due: 1, disputes: {raised: 1, received: 2}, expired_undelivered_as_payee: 1,
    first_activity_at: iso(clock.t - 9 * DAY), operator_run: false});
  const text = JSON.stringify(pub.credit_history);
  assert.ok(!/vd_|vs_|vp_/.test(text), 'no deal, set-off or participant id');
  // The own position (/me, /owner) has neither, and Pilot.position keeps its keys: publicPosition (GET /participants)
  // adds the two.
  const own = await pilot.position(C, null, {own: true}), plain = await pilot.position(C);
  assert.equal('credit_history' in own || 'credit_policy' in own, false);
  assert.deepEqual(Object.keys(pub), [...Object.keys(plain), 'credit_policy', 'credit_history']);
  // A participant with no deals.
  const fresh = await pilot.publicPosition(w.W);
  assert.deepEqual(fresh.credit_history, {notes_issued: {count: 0, PC: 0}, paid_by_transfer: {count: 0, PC: 0}, received_by_transfer: {count: 0, PC: 0},
    cleared_by_setoff: {count: 0, PC: 0}, payment_due: 0, disputes: {raised: 0, received: 0}, expired_undelivered_as_payee: 0, first_activity_at: null, operator_run: false});
  // Modes off and bound: the public position is v15's.
  for (const mode of ['off', 'bound']) {
    pilot.circulation = mode;
    const p0 = await pilot.publicPosition(C);
    assert.equal('credit_history' in p0 || 'credit_policy' in p0, false, mode);
    assert.deepEqual(Object.keys(p0), ['participant_id', 'unit', 'claims_held', 'owes', 'net', 'claims', 'debts', 'deals', 'settled', 'backing', 'meaning'], mode);
  }
});

test('/me and /owner credit_policy (circulation on): the owner\'s fields as before, plus each phase-2 field the owner has set', () => {
  const w = world(), {pilot, person} = w, P = person('cp-me');
  assert.deepEqual(pilot.creditPolicy(P), POLICY, 'none set: as before');
  pilot.setMandate(P, {max_claims_total: 12, accept_operator_issuers: false});
  assert.deepEqual(pilot.creditPolicy(P), {...POLICY, max_claims_total: 12, accept_operator_issuers: false});
});
