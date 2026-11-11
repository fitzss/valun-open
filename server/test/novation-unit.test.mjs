// Unit tests for lib/pilot/novation.mjs, the pure helpers of payment by debt transfer (design §3.3, §4.2-§4.5, §5.5;
// spec 18.3, 18.4, 18.6, 18.8; decision D-1). No tracker, no signer.
// Run: node --test test/novation-unit.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {RESIDUE, MAX_AGE_MS, TRANSFER_TTL_MS, SETOFF_TTL_MS, FALLBACK_MARGIN_MS, MAX_ATTEMPTS_PER_DAY, QUOTE_KIND, QUOTE_FIELDS, TRANSFER_SLOTS,
  novationTimestamp, quoteDigest, transferSlots, transferMessages, slotMessage, samePriorState, trackerTransferBody, fallbackAfter, parseFeatures, classifyEdge, transferOutcome, edgeKey} from '../lib/pilot/novation.mjs';
import {canonical, circulationStatements, residueTimestamp} from '../lib/pilot/core.mjs';
import * as caps from '../lib/pilot/caps.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const KEY = () => '02' + crypto.randomBytes(32).toString('hex'), SIG = () => '03' + crypto.randomBytes(64).toString('hex');

test('constants: residues 999/998/997, a one-hour maximum age, 20 and 30 minute windows, a 60 s server margin, 3 attempts a day (the same values as caps.mjs)', () => {
  assert.deepEqual(RESIDUE, {transfer: 999, setoff: 998, bound: 997});
  assert.equal(MAX_AGE_MS, 3600000); assert.equal(TRANSFER_TTL_MS, 1200000); assert.equal(SETOFF_TTL_MS, 1800000);
  assert.equal(FALLBACK_MARGIN_MS, 60000); assert.equal(MAX_ATTEMPTS_PER_DAY, 3);
  assert.equal(RESIDUE.transfer, caps.TRANSFER_MS); assert.equal(RESIDUE.setoff, caps.SETOFF_MS); assert.equal(RESIDUE.bound, caps.BOUND_NOTE_MS);
  assert.equal(MAX_AGE_MS, caps.NOVATION_MAX_AGE_MS);
  for (const k of ['TRANSFER_TTL_MS', 'SETOFF_TTL_MS', 'FALLBACK_MARGIN_MS']) assert.equal({TRANSFER_TTL_MS, SETOFF_TTL_MS, FALLBACK_MARGIN_MS}[k], caps[k], k);
  assert.ok(TRANSFER_TTL_MS < MAX_AGE_MS && SETOFF_TTL_MS < MAX_AGE_MS, 'collection windows are shorter than the maximum age');
  assert.equal(fallbackAfter(1_794_000_000_999), 1_794_000_000_999 + 3600000 + 60000);
});

test('novationTimestamp: the largest t ending in the residue, at least 1.5 s back and after `after`; otherwise how long until there is one (brute force over every residue and many clocks)', () => {
  const base = 1_794_000_000_000;
  let found = 0, ahead = 0;
  for (const residue of [0, 1, 500, 994, 995, 996, 997, 998, 999]) {
    for (let i = 0; i < 400; i++) {
      const now = base + i * 37 + (i % 7) * 1000, after = i % 3 === 0 ? 0 : now - 1500 - (i % 2500) + (i % 5) * 700;
      const r = novationTimestamp({now, residue, after});
      // brute force: the candidates below now - 1500, from the top
      let want = null;
      for (let t = now - 1500; t > now - 1500 - 1000; t--) if (t % 1000 === residue) { want = t; break; }
      assert.deepEqual(residueTimestamp(now, residue, after), r, 'core.mjs residueTimestamp gives the same answer');
      if (want > after) { assert.deepEqual(r, {timestamp: want}); found++; continue; }
      assert.ok(Number.isSafeInteger(r.ahead_ms) && r.ahead_ms > 0, JSON.stringify({now, residue, after, r}));
      let first = after + 1;
      while (first % 1000 !== residue) first++;
      assert.equal(r.ahead_ms, first + 1500 - now);
      assert.deepEqual(novationTimestamp({now: now + r.ahead_ms, residue, after}), {timestamp: first}, 'there is one exactly then');
      assert.ok(novationTimestamp({now: now + r.ahead_ms - 1, residue, after}).ahead_ms === 1, 'and not a millisecond earlier');
      ahead++;
    }
  }
  assert.ok(found > 1000 && ahead > 300, JSON.stringify({found, ahead}));
  assert.deepEqual(novationTimestamp({now: base + 5000, residue: 999}), {timestamp: base + 2999}, 'after defaults to 0 (an absent edge)');
  for (const bad of [{now: -1, residue: 999}, {now: 1.5, residue: 999}, {now: base, residue: 1000}, {now: base, residue: -1}, {now: base, residue: 999, after: -1}, {now: '5', residue: 999}])
    assert.throws(() => novationTimestamp(bad), TypeError, JSON.stringify(bad));
});

test('quoteDigest: the worked example of spec 18.3 item 4 (696 canonical bytes, 377beb8f...); key order and extra keys do not matter; the pay statement is 102 bytes', () => {
  const fields = {network: 'valun-pilot-1', tracker_nft_id: '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa',
    denomination: 'token:01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274', deal_id: 'vd_0123456789abcdef',
    terms_hash: '5f7bccd0e836183a82fbab738a617faa25673c4ead77eeb3da94c7ef4c9e6003', deliverable_sha256: sha('example delivery'),
    issuer_pubkey: '0265ad727818ed16c0dc99185145ba5c0413efa30465f783b7de4b43c799a2e124',
    payer_pubkey: '035e2b6f7e5a63fc1335cca864db07e5872b9c21f3cafe766a6c1987977221e7b5',
    payee_pubkey: '039ce92ed225dafa349eff0a99eca476219acdcc5991d7c12cdd587c3ee365bf05', amount: 20};
  assert.equal(fields.deliverable_sha256, 'd6823e3f1b084c3135394414d58c8da1bec863f96cdec489f123426d4085c9fc');
  const text = canonical({kind: QUOTE_KIND, ...fields});
  assert.equal(Buffer.byteLength(text), 696);
  assert.ok(text.startsWith('{"amount":20,"deal_id":"vd_0123456789abcdef","deliverable_sha256":'));
  assert.equal(quoteDigest(fields), '377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e');
  assert.equal(quoteDigest({...Object.fromEntries(Object.entries(fields).reverse()), handle: 'ignored', kind: 'ignored too'}), quoteDigest(fields));
  const pay = circulationStatements.pay(fields.deal_id, quoteDigest(fields));
  assert.equal(pay, 'valun-pilot/pay/1\nvd_0123456789abcdef\n377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e');
  assert.equal(Buffer.byteLength(pay), 102, 'never 80 bytes: it cannot be taken for a note message');
  assert.deepEqual(QUOTE_FIELDS, ['network', 'tracker_nft_id', 'denomination', 'deal_id', 'terms_hash', 'deliverable_sha256', 'issuer_pubkey', 'payer_pubkey', 'payee_pubkey', 'amount']);
  for (const [k, v] of [['amount', 0], ['amount', true], ['amount', 2.5], ['amount', '20'], ['amount', 2 ** 53], ['deal_id', ''], ['deal_id', null], ['network', 'valun-pilot-é'],
    ['terms_hash', 'a\nb'], ['payee_pubkey', 5]]) assert.throws(() => quoteDigest({...fields, [k]: v}), TypeError, `${k}=${JSON.stringify(v)}`);
  const {issuer_pubkey, ...missing} = fields; void issuer_pubkey;
  assert.throws(() => quoteDigest(missing), TypeError);
  assert.throws(() => quoteDigest(null), TypeError);
});

// A transfer as the server records it: A issues, B pays (old creditor), C is paid (new creditor).
function transfer({X = 10, Y = 4, a = 3, T = 1_794_000_000_999, toAbsent = false} = {}) {
  const A = KEY(), B = KEY(), C = KEY();
  return {id: 'vt_0000000000000001', issuer: {id: 'vp_aaaaaaaaaaaa', pubkey: A}, payer: {id: 'vp_bbbbbbbbbbbb', pubkey: B}, payee: {id: 'vp_cccccccccccc', pubkey: C},
    amount: a, timestamp: T, denomination: 'token:' + 'cd'.repeat(32),
    from_edge: {edge: edgeKey(A, B), before: {total: X, timestamp: T - 5000, signature: SIG()}, new_total: X - a},
    to_edge: {edge: edgeKey(A, C), before: toAbsent ? null : {total: Y, timestamp: T - 9000, signature: SIG()}, new_total: (toAbsent ? 0 : Y) + a}, slots: {}};
}

test('transferSlots: the seven slots of spec 18.6 (who signs which total on which edge), the tracker field of each, one timestamp; the two prior slots name the prior state\'s timestamp (tracker v3.2 PA)', () => {
  const t = transfer(), A = t.issuer.pubkey, B = t.payer.pubkey, C = t.payee.pubkey, AB = `${A}>${B}`, AC = `${A}>${C}`, T = t.timestamp, pAB = T - 5000, pAC = T - 9000;
  const got = transferSlots(t).map(s => [s.name, s.role, s.key, s.field, s.issuer_pubkey, s.recipient_pubkey, s.total, s.timestamp, s.prior_timestamp]);
  assert.deepEqual(got, [
    ['from_recipient_prior', 'payer', `${AB}:prior`, 'from_recipient_prior_signature', A, B, 10, T, pAB],
    ['from_recipient', 'payer', `${AB}:new`, 'from_recipient_signature', A, B, 7, T, null],
    ['from_recipient_to', 'payer', `${AC}:new`, 'from_recipient_to_signature', A, C, 7, T, null],
    ['issuer_from', 'issuer', `${AB}:new`, 'issuer_from_signature', A, B, 7, T, null],
    ['issuer_to', 'issuer', `${AC}:new`, 'issuer_to_signature', A, C, 7, T, null],
    ['to_recipient_prior', 'payee', `${AC}:prior`, 'to_recipient_prior_signature', A, C, 4, T, pAC],
    ['to_recipient', 'payee', `${AC}:new`, 'to_recipient_signature', A, C, 7, T, null]]);
  assert.deepEqual(TRANSFER_SLOTS.map(s => s.name), got.map(g => g[0]));
  // An absent to-edge: Y = 0, so the payee acknowledges (0, 0) and the destination's new total is a.
  const n = transfer({toAbsent: true, a: 2}), nC = n.payee.pubkey;
  assert.deepEqual(transferSlots(n).filter(s => s.which === 'to').map(s => [s.slot, s.total, s.prior_timestamp]), [['new', 2, null], ['new', 2, null], ['prior', 0, 0], ['new', 2, null]]);
  assert.deepEqual(Object.keys(transferMessages(n)), [`${n.issuer.pubkey}>${n.payer.pubkey}:prior`, `${n.issuer.pubkey}>${n.payer.pubkey}:new`,
    `${n.issuer.pubkey}>${nC}:new`, `${n.issuer.pubkey}>${nC}:prior`], 'four distinct messages');
  // A prior slot's message is PA (prior_timestamp given), a new slot's the note message M (none).
  assert.deepEqual(transferMessages(t)[`${AC}:prior`], {issuer: A, recipient: C, total: 4, timestamp: T, prior_timestamp: pAC});
  assert.deepEqual(transferMessages(t)[`${AB}:prior`], {issuer: A, recipient: B, total: 10, timestamp: T, prior_timestamp: pAB});
  assert.deepEqual(transferMessages(t)[`${AB}:new`], {issuer: A, recipient: B, total: 7, timestamp: T});
  assert.deepEqual(transferMessages(n)[`${n.issuer.pubkey}>${nC}:prior`], {issuer: n.issuer.pubkey, recipient: nC, total: 0, timestamp: n.timestamp, prior_timestamp: 0});
  for (const s of transferSlots(t)) assert.deepEqual(slotMessage(s), transferMessages(t)[s.key], s.name);
  // what is not a transfer
  const bad = [
    c => { c.payee.pubkey = c.payer.pubkey; }, c => { c.issuer.pubkey = c.payer.pubkey; }, c => { c.amount = 0; }, c => { c.amount = 11; },
    c => { c.timestamp += 1; }, c => { c.timestamp = 1_794_000_000_998; }, c => { c.from_edge.before = null; }, c => { c.issuer.pubkey = 'nope'; },
    c => { c.to_edge.before.total = -1; },
    // a prior state without a whole-number timestamp before T
    c => { delete c.from_edge.before.timestamp; }, c => { c.from_edge.before.timestamp = c.timestamp; }, c => { c.from_edge.before.timestamp = '1'; },
    c => { c.to_edge.before.timestamp = c.timestamp + 1; }, c => { c.to_edge.before.timestamp = -1; },
  ];
  for (const f of bad) { const c = structuredClone(t); f(c); assert.throws(() => transferSlots(c), TypeError, f.toString()); }
});

test('trackerTransferBody: exactly the tracker v3.2 request fields (it refuses unknown ones), with both prior states (totals and timestamps); a missing or malformed slot is a TypeError', () => {
  const t = transfer();
  for (const s of TRANSFER_SLOTS) t.slots[s.name] = {signature: SIG(), by: 'x', at: 'y'};
  const body = trackerTransferBody(t);
  assert.deepEqual(Object.keys(body).sort(), ['amount', 'denomination', 'from_prior_timestamp', 'from_prior_total', 'from_recipient_prior_signature', 'from_recipient_pubkey', 'from_recipient_signature',
    'from_recipient_to_signature', 'issuer_from_signature', 'issuer_pubkey', 'issuer_to_signature', 'timestamp', 'to_prior_timestamp', 'to_prior_total', 'to_recipient_prior_signature',
    'to_recipient_pubkey', 'to_recipient_signature']);
  assert.equal(body.issuer_pubkey, t.issuer.pubkey); assert.equal(body.from_recipient_pubkey, t.payer.pubkey); assert.equal(body.to_recipient_pubkey, t.payee.pubkey);
  assert.equal(body.amount, 3); assert.equal(body.timestamp, t.timestamp); assert.equal(body.from_prior_total, 10); assert.equal(body.to_prior_total, 4);
  assert.deepEqual([body.from_prior_timestamp, body.to_prior_timestamp], [t.from_edge.before.timestamp, t.to_edge.before.timestamp]);
  assert.equal(body.denomination, t.denomination);
  for (const s of TRANSFER_SLOTS) assert.equal(body[`${s.name}_signature`], t.slots[s.name].signature, s.name);
  const absent = trackerTransferBody({...transfer({toAbsent: true}), slots: t.slots});
  assert.deepEqual([absent.to_prior_total, absent.to_prior_timestamp], [0, 0], 'a new to-edge: (0, 0)');
  for (const name of ['issuer_from', 'to_recipient']) {
    const c = structuredClone(t); delete c.slots[name].signature;
    assert.throws(() => trackerTransferBody(c), TypeError, name);
    c.slots[name].signature = 'ab'; assert.throws(() => trackerTransferBody(c), TypeError, name);
  }
  assert.throws(() => trackerTransferBody({...t, denomination: ''}), TypeError);
});

test('samePriorState (decision D-1, design v3.2 section 4): two transfers on the same from-edge acknowledging the same prior total AND timestamp exclude each other; anything else is not exempt', () => {
  const e = 'a>b', base = {kind: 'transfer', edge: e, prior: 10, prior_timestamp: 1_794_000_000_123};
  assert.equal(samePriorState(base, {...base}), true);
  assert.equal(samePriorState({...base, kind: 'bound'}, {...base, kind: 'bound'}), true, 'two bound notes on the same edge and prior state');
  for (const [why, earlier, next] of [
    ['another edge (another issuer)', base, {...base, edge: 'c>b'}],
    ['another prior total', base, {...base, prior: 9}],
    ['the same total at another timestamp (the edge moved and came back: ABA)', base, {...base, prior_timestamp: base.prior_timestamp + 1}],
    ['an earlier attempt that recorded no prior timestamp', {...base, prior_timestamp: null}, base],
    ['an earlier attempt without the field', (({prior_timestamp, ...x}) => x)(base), base],
    ['no prior timestamp asserted for the new one', {...base, prior_timestamp: null}, {...base, prior_timestamp: null}],
    ['a prior timestamp of another type', {...base, prior_timestamp: String(base.prior_timestamp)}, {...base, prior_timestamp: String(base.prior_timestamp)}],
    ['another kind (a bound note after a transfer)', base, {...base, kind: 'bound'}],
    ['an ordinary note', {...base, kind: 'note'}, {...base, kind: 'note'}],
    ['no new attempt (a template for an own note)', base, null],
  ]) assert.equal(samePriorState(earlier, next), false, why);
});

test('parseFeatures: consents/1 with the roles it lists (known ones, in a fixed order); anything else is ignored (null)', () => {
  assert.deepEqual(parseFeatures('consents/1;roles=setoff,issuer,creditor'), {consents: true, roles: ['setoff', 'issuer', 'creditor']});
  assert.deepEqual(parseFeatures('consents/1; roles=creditor,setoff'), {consents: true, roles: ['setoff', 'creditor']});
  assert.deepEqual(parseFeatures('consents/1;roles=issuer,payer,admin'), {consents: true, roles: ['issuer']});
  assert.deepEqual(parseFeatures('consents/1'), {consents: true, roles: []});
  assert.deepEqual(parseFeatures('consents/1;roles='), {consents: true, roles: []});
  for (const bad of [undefined, null, '', 'consents/2;roles=issuer', 'circulation/1', 'consents/1;roles=Issuer', 'consents/1;other=1', 'x'.repeat(201), 42, ['consents/1']])
    assert.equal(parseFeatures(bad), null, JSON.stringify(bad));
});

test('classifyEdge and transferOutcome: the read-back decides (design §5.5, D-1 item 3)', () => {
  const T = 1_794_000_000_999, before = {total: 10, timestamp: T - 5000, signature: SIG()}, next = {total: 7, timestamp: T, signature: SIG()};
  assert.equal(classifyEdge({...next}, before, next), 'new');
  assert.equal(classifyEdge({...before}, before, next), 'prior');
  assert.equal(classifyEdge(null, null, next), 'prior', 'an absent edge that is still absent');
  assert.equal(classifyEdge({total: 12, timestamp: T - 100, signature: SIG()}, before, next), 'changed', 'moved before T: it did not apply');
  assert.equal(classifyEdge({total: 10, timestamp: T - 100, signature: SIG()}, before, next), 'changed', 'same total, another note');
  assert.equal(classifyEdge({total: 7, timestamp: T, signature: SIG()}, before, next), 'unknown', 'the new total at T under another signature');
  assert.equal(classifyEdge({total: 9, timestamp: T, signature: SIG()}, before, next), 'unknown', 'another state at T');
  assert.equal(classifyEdge({total: 7, timestamp: T + 2000, signature: SIG()}, before, next), 'applied_moved');
  assert.equal(classifyEdge({total: 10, timestamp: T + 2000, signature: SIG()}, before, next), 'moved_past');
  assert.equal(classifyEdge({total: 12, timestamp: T + 2000, signature: SIG()}, before, next), 'unknown', 'moved past T to neither total: it may have applied');
  assert.equal(classifyEdge({total: 3, timestamp: T + 2000, signature: SIG()}, null, {total: 3, timestamp: T, signature: SIG()}), 'applied_moved', 'an edge the transfer created');
  assert.equal(classifyEdge({total: 0, timestamp: T + 2000, signature: SIG()}, null, {total: 3, timestamp: T, signature: SIG()}), 'moved_past');
  const table = [
    ['new', 'new', 'applied'], ['applied_moved', 'new', 'applied'], ['new', 'applied_moved', 'applied'],
    ['prior', 'prior', 'prior'],
    ['changed', 'prior', 'not_applied'], ['prior', 'moved_past', 'not_applied'], ['moved_past', 'changed', 'not_applied'],
    ['unknown', 'prior', 'unknown'], ['new', 'unknown', 'unknown'], ['prior', 'unknown', 'unknown'],
    ['new', 'prior', 'inconsistent'], ['changed', 'new', 'inconsistent'], ['applied_moved', 'moved_past', 'inconsistent'],
  ];
  for (const [f, t, want] of table) assert.equal(transferOutcome(f, t), want, `${f} + ${t}`);
});
