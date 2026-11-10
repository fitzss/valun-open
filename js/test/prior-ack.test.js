// Tracker v3.2 in the JavaScript client (design v3.2; audit VS-1): a prior slot is signed as the 105-byte prior
// acknowledgment PA(I,R,X,p,T) over the state the item shows; what signs a prior slot is signed only for the contract
// GET /info novation reports; and R11's same-prior exemption lets a transfer retry on the same prior state be signed at
// once, which the tracker v3.2 check makes safe. Each test fails without the behaviour it names (the Python decision
// table, replayed through the fixtures by python-parity.test.js, covers the same rules case by case).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {test} from 'node:test';
import {basis, bytesToHex, novation as nv} from '../src/index.js';
import {testKey} from './helpers.js';

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const DENOM = 'token:' + sha('valun-pilot-credit/1');
const NETWORK = 'valun-pilot-1';
const DEAL = 'vd_0123456789abcdef', TID = 'vt_0123456789abcdef';
const TH = sha('novation test: terms'), DH = sha('novation test: delivery');
const PRICE = 3;
const A_ID = 'vp_a0a0a0a0a0a0', B_ID = 'vp_b0b0b0b0b0b0', C_ID = 'vp_c0c0c0c0c0c0';
const key = label => {
  const secret = testKey(label);
  return {secret, pk: bytesToHex(basis.publicKey(secret))};
};
const [A, B, C] = ['issuer', 'payer', 'payee'].map(n => key(`test/novation/${n}`));
const AB = `${A.pk}>${B.pk}`, AC = `${A.pk}>${C.pk}`, BC = `${B.pk}>${C.pk}`;
const NOW = 1_793_966_460_123;
const res = (t, r) => t - (((t - r) % 1000) + 1000) % 1000;
const T999 = res(NOW - 1500, 999), T997 = res(NOW - 1500, 997), T_OLD = T999 - 60_000;
const TS_AB = NOW - 900_000, TS_AC = NOW - 800_000 + 1, TS_BC = NOW - 700_000 + 2;
// GET /info novation of a v16 server on tracker v3.2
const NOVATION = {transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000,
  transfer_ttl_ms: 1200000, setoff_ttl_ms: 1800000, fallback_margin_ms: 60000, tracker_build: 'valun-circulating-credit/4',
  transfer_version: 4, bound_note_version: 3, prior_ack: 'basis/prior-ack/1'};

const signed = (k, msg) => bytesToHex(basis.sign(msg, k.secret));
const verify = (pk, msg, sig) => basis.verifyHex(sig, msg, pk);
const st = (i, r, total, ts) => ({total, timestamp: ts, signature: signed(i, nv.message(i.pk, r.pk, total, ts, NFT, DENOM))});
const quote = () => nv.quoteDigest({network: NETWORK, tracker_nft_id: NFT, denomination: DENOM, deal_id: DEAL, terms_hash: TH,
  deliverable_sha256: DH, issuer_pubkey: A.pk, payer_pubkey: B.pk, payee_pubkey: C.pk, amount: PRICE});
const TERMS = {deal_id: DEAL, network: NETWORK, tracker_nft_id: NFT, denomination: DENOM, price: {amount: PRICE, unit: 'PC'},
  payer: {id: B_ID, pubkey: B.pk}, payee: {id: C_ID, pubkey: C.pk}};
const POLICY = {setoff: true, as_issuer: true, as_new_creditor: true, max_PC: 20};
const MANDATE = {auto_clear: true, novate_own_debt: true, accept_transfers: true, may_accept_credit: true, accept_notes_from: [A_ID],
  refuse_notes_from: [], max_accept_per_issuer: 50, pay_with_held_notes: 'when_asked'};

const fromState = st(A, B, 10, TS_AB), toState = st(A, C, 4, TS_AC), boundPrior = st(B, C, 6, TS_BC);

function payerTpl({T = T999, from = fromState} = {}) {
  return {deal_id: DEAL, terms_hash: TH, deliverable_sha256: DH, issuer: {id: A_ID, handle: 'issuer-a', pubkey: A.pk},
    payer: {id: B_ID, handle: 'payer-b', pubkey: B.pk}, payee: {id: C_ID, handle: 'payee-c', pubkey: C.pk}, amount: PRICE, timestamp: T,
    from_edge: {before: from, new_total: from.total - PRICE}, to_edge: {before: toState, new_total: 4 + PRICE},
    tracker_nft_id: NFT, denomination: DENOM, quote_digest: quote()};
}
function boundTpl({prior = boundPrior} = {}) {
  const P = prior === null ? 0 : prior.total;
  return {deal_id: DEAL, terms_hash: TH, deliverable_sha256: DH, issuer_pubkey: B.pk, recipient_pubkey: C.pk, prior_total: P,
    price: PRICE, total: P + PRICE, timestamp: T997, tracker_nft_id: NFT, denomination: DENOM, prior_note: prior};
}
function row(i, r, before, newTotal, T, yourRole, slots, ids) {
  return {edge: `${i.pk}>${r.pk}`, issuer: {id: ids[0]}, recipient: {id: ids[1]}, your_role: yourRole, before,
    change: newTotal - (before === null ? 0 : before.total), new_total: newTotal, timestamp: T, revision: 1, slots, signed_by_you: []};
}
function item(role, edges, context) {
  return {kind: 'transfer', id: TID, state: 'collecting', your_roles: [role], network: NETWORK, tracker_nft_id: NFT, denomination: DENOM,
    edges, context};
}
const parties = {issuer: {id: A_ID}, payer: {id: B_ID}, payee: {id: C_ID}};
const payeeItem = (T = T999) => item('payee', [row(A, C, toState, 4 + PRICE, T, 'creditor', ['prior', 'new'], [A_ID, C_ID])],
  {...parties, amount: PRICE, deal: {deal_id: DEAL, terms_hash: TH, price: PRICE, quote_digest: quote()}});
const issuerItem = () => item('issuer', [row(A, B, fromState, 10 - PRICE, T999, 'issuer', ['new'], [A_ID, B_ID]),
  row(A, C, toState, 4 + PRICE, T999, 'issuer', ['new'], [A_ID, C_ID])], {...parties, amount: PRICE});
const payerItem = (T = T999) => item('payer', [row(A, B, fromState, 10 - PRICE, T, 'creditor', ['prior', 'new'], [A_ID, B_ID]),
  row(A, C, toState, 4 + PRICE, T, 'payer', ['new'], [A_ID, C_ID])],
{...parties, amount: PRICE, deal: {deal_id: DEAL, terms_hash: TH, price: PRICE, quote_digest: quote()}});

function base(me, meId, over) {
  return {me_pk: me.pk, me_id: meId, now_ms: NOW, verify, pins: {tracker_nft_id: NFT, denomination: DENOM}, records: {}, signed: {},
    transfer_attempts: {}, novated_edges: {}, features: ['bound_notes/1', 'circulation/1'], novation: {...NOVATION}, ...over};
}
const payerCtx = (over = {}) => base(B, B_ID, {deal: nv.dealContext(TERMS, TH, DH), payee_current_pk: C.pk,
  mandate: {pay_with_held_notes: 'when_asked'}, ...over});
const payeeCtx = (over = {}) => base(C, C_ID, {consent_policy: {...POLICY}, mandate: {...MANDATE},
  deal: nv.dealContext(TERMS, TH, DH, true, TID), issuer_ids: {[A.pk]: A_ID}, ...over});
const issuerCtx = (over = {}) => base(A, A_ID, {consent_policy: {...POLICY}, mandate: {...MANDATE}, ...over});
const attempt = (over = {}) => ({deal_id: DEAL, route: 'transfer', edge: AB, prior: 10, prior_timestamp: TS_AB,
  prior_signature: fromState.signature, total: 7, timestamp: T_OLD, quote_digest: quote(), ...over});

test('PA: every prior slot is the 105-byte acknowledgment of the state the item shows; new slots stay the 80-byte M', () => {
  const cases = [
    [nv.evaluatePayerTemplate(payerTpl(), payerCtx()), {[`${AB}:prior`]: [A, B, 10, TS_AB, T999]}],
    [nv.evaluateBoundTemplate(boundTpl(), payerCtx()), {[`${BC}:prior`]: [B, C, 6, TS_BC, T997]}],
    [nv.evaluateBoundTemplate(boundTpl({prior: null}), payerCtx()), {[`${BC}:prior`]: [B, C, 0, 0, T997]}],   // (0, 0): no edge
    [nv.evaluateConsent(payeeItem(), payeeCtx()), {[`${AC}:prior`]: [A, C, 4, TS_AC, T999]}],
    [nv.evaluateConsent(payerItem(), payerCtx({transfer_attempts: {[DEAL]: [attempt({timestamp: T999})]}})),
      {[`${AB}:prior`]: [A, B, 10, TS_AB, T999]}],
  ];
  for (const [r, priors] of cases) {
    assert.equal(r.ok, true, r.summary.reason);
    const msgs = nv.slotMessages(r.to_sign, NFT, DENOM);
    for (const [slot, m] of Object.entries(msgs)) {
      if (slot.endsWith(':prior')) {
        const [i, rc, X, p, T] = priors[slot];
        assert.equal(bytesToHex(m), bytesToHex(basis.priorAckMessage(i.pk, rc.pk, X, p, T, NFT, DENOM)), slot);
        assert.equal(m.length, 105, slot);
        assert.notEqual(bytesToHex(m), bytesToHex(nv.message(i.pk, rc.pk, X, T, NFT, DENOM)), `${slot}: not v3.1's M(I,R,X,T)`);
      } else {
        assert.equal(m.length, 80, slot);
      }
    }
    for (const x of r.to_sign) assert.equal(x.length, x[0].endsWith(':prior') ? 6 : 5);
  }
  // the attempt records the acknowledged state (the R11 exemption compares it)
  assert.deepEqual(cases[0][0].write_ahead.attempt.prior_timestamp, TS_AB);
});

test('slotMessages never signs a prior slot as an 80-byte note message', () => {
  const r = nv.evaluatePayerTemplate(payerTpl(), payerCtx());
  assert.throws(() => nv.slotMessages([r.to_sign[0].slice(0, 5), ...r.to_sign.slice(1)], NFT, DENOM), e => e.name === 'ValueError' || /to_sign entry/.test(e.message));
  assert.throws(() => nv.slotMessages([r.to_sign[0], [...r.to_sign[1], TS_AB]], NFT, DENOM), /to_sign entry/);
  assert.equal(bytesToHex(nv.priorMessage(A.pk, B.pk, 10, TS_AB, T999, NFT, DENOM)),
    bytesToHex(basis.priorAckMessage(A.pk, B.pk, 10, TS_AB, T999, NFT, DENOM)));
});

test('contractProblem: exactly the tracker v3.2 contract, same values and JSON types', () => {
  assert.deepEqual({...nv.CONTRACT}, {tracker_build: 'valun-circulating-credit/4', transfer_version: 4, bound_note_version: 3,
    prior_ack: 'basis/prior-ack/1'});
  assert.equal(nv.PRIOR_ACK, 'basis/prior-ack/1');
  assert.equal(nv.contractProblem(NOVATION), null);
  for (const bad of [null, undefined, [], 'v3.2', {}, {...NOVATION, transfer_version: 3}, {...NOVATION, transfer_version: '4'},
    {...NOVATION, bound_note_version: 2}, {...NOVATION, bound_note_version: true}, {...NOVATION, prior_ack: 'basis/prior-ack/2'},
    {...NOVATION, tracker_build: 'valun-circulating-credit/3'}, (({prior_ack, ...rest}) => rest)(NOVATION)]) {
    assert.match(nv.contractProblem(bad) ?? '', /tracker/, JSON.stringify(bad));
  }
});

test('the evaluators sign a prior slot only for the v3.2 contract; issuer consents are not gated', () => {
  const v31 = {...NOVATION, tracker_build: 'valun-circulating-credit/3', transfer_version: 3, bound_note_version: 2};
  delete v31.prior_ack;
  for (const novation of [null, v31]) {
    for (const r of [nv.evaluatePayerTemplate(payerTpl(), payerCtx({novation})), nv.evaluateBoundTemplate(boundTpl(), payerCtx({novation})),
      nv.evaluateConsent(payeeItem(), payeeCtx({novation})),
      nv.evaluateConsent(payerItem(), payerCtx({novation, transfer_attempts: {[DEAL]: [attempt({timestamp: T999})]}}))]) {
      assert.deepEqual([r.ok, r.code, r.to_sign, r.write_ahead], [false, 'feature_unavailable', [], null], r.summary.reason);
    }
    assert.equal(nv.evaluateConsent(issuerItem(), issuerCtx({novation})).ok, true);
  }
  assert.ok(nv.REFUSAL_CODES.includes('feature_unavailable'));
});

test('a prior timestamp the template names must be its prior state\'s (bound: prior_timestamp; transfer: from/to_edge)', () => {
  assert.equal(nv.evaluateBoundTemplate({...boundTpl(), prior_timestamp: TS_BC}, payerCtx()).ok, true);
  assert.equal(nv.evaluateBoundTemplate({...boundTpl(), prior_timestamp: TS_BC - 1}, payerCtx()).code, 'bad_template');
  assert.equal(nv.evaluateBoundTemplate({...boundTpl({prior: null}), prior_timestamp: 0}, payerCtx()).ok, true);
  assert.equal(nv.evaluateBoundTemplate({...boundTpl({prior: null}), prior_timestamp: TS_BC}, payerCtx()).code, 'bad_template');
  const t = payerTpl();
  assert.equal(nv.evaluatePayerTemplate({...t, from_edge: {...t.from_edge, prior_timestamp: TS_AB}}, payerCtx()).ok, true);
  assert.equal(nv.evaluatePayerTemplate({...t, from_edge: {...t.from_edge, prior_timestamp: TS_AB + 1}}, payerCtx()).code, 'bad_template');
  assert.equal(nv.evaluatePayerTemplate({...t, to_edge: {...t.to_edge, prior_timestamp: String(TS_AC)}}, payerCtx()).code, 'bad_template');
  const it = payeeItem();
  it.edges[0].prior_timestamp = TS_AC + 1;
  assert.equal(nv.evaluateConsent(it, payeeCtx()).code, 'bad_consent');
});

test('R11 same-prior exemption: a transfer at a new T on the same prior state is signed at once; another state waits', () => {
  // the earlier attempt (T_OLD) acknowledged (10, TS_AB): the template at T999 shows exactly that state of my claim
  let r = nv.evaluatePayerTemplate(payerTpl(), payerCtx({transfer_attempts: {[DEAL]: [attempt()]}}));
  assert.equal(r.ok, true, r.summary.reason);
  assert.deepEqual(r.write_ahead.attempts_seen, [['transfer', AB, 7, T_OLD]]);
  // ... and so is a regenerated transfer shown as a payer consent, under the earlier attempt's quote
  r = nv.evaluateConsent(payerItem(), payerCtx({transfer_attempts: {[DEAL]: [attempt()]}}));
  assert.equal(r.ok, true, r.summary.reason);
  // still windowed: another timestamp of the same total, an attempt that recorded no prior state, another issuer
  const retryAfter = T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW;
  for (const earlier of [attempt({prior_timestamp: TS_AB - 1000}), attempt({prior_timestamp: null, prior_signature: null}),
    attempt({edge: `${C.pk}>${B.pk}`})]) {
    r = nv.evaluatePayerTemplate(payerTpl(), payerCtx({transfer_attempts: {[DEAL]: [earlier]}}));
    assert.deepEqual([r.code, r.summary.retry_after_ms], ['transfer_window_open', retryAfter], JSON.stringify(earlier));
  }
  // the same state but another signature than the one recorded (D-2 a): only the owner can resolve it
  r = nv.evaluatePayerTemplate(payerTpl(), payerCtx({transfer_attempts: {[DEAL]: [attempt({prior_signature: 'ab'.repeat(64)})]}}));
  assert.equal(r.code, 'attempt_outcome_unknown');
  // checkPayment (an ordinary note) acknowledges no prior state: never exempt
  assert.equal(nv.checkPayment(DEAL, PRICE, 'transfer', AB, 10, payerCtx({transfer_attempts: {[DEAL]: [attempt()]}})).code,
    'transfer_window_open');
});

test('VS-1 closed: of two same-prior transfers the tracker v3.2 check applies at most one (the audit sequence)', () => {
  // A model of tracker v3.2 check_transfer's prior slots: each creditor's prior signature over PA of the STORED state.
  const trackerV32 = (edges, T, bSig, cSig) => {
    const [X, p] = edges[AB], [Y, q] = edges[AC];
    if (T <= p || T <= q || !verify(B.pk, nv.priorMessage(A.pk, B.pk, X, p, T, NFT, DENOM), bSig)
        || !verify(C.pk, nv.priorMessage(A.pk, C.pk, Y, q, T, NFT, DENOM), cSig)) return false;
    edges[AB] = [X - PRICE, T];
    edges[AC] = [Y + PRICE, T];
    return true;
  };
  const bPrior = r => signed(B, nv.slotMessages(r.to_sign, NFT, DENOM)[`${AB}:prior`]);
  const cPrior = T => {
    const r = nv.evaluateConsent(payeeItem(T), payeeCtx());
    assert.equal(r.ok, true, r.summary.reason);
    return signed(C, nv.slotMessages(r.to_sign, NFT, DENOM)[`${AC}:prior`]);
  };
  const T1 = T_OLD, T2 = T999;
  const first = nv.evaluatePayerTemplate(payerTpl({T: T1}), payerCtx({now_ms: T1 + 1500}));
  assert.equal(first.ok, true, first.summary.reason);
  const state = {};
  nv.applyWriteAhead(state, first.write_ahead, 'x');
  const second = nv.evaluatePayerTemplate(payerTpl({T: T2}), payerCtx({records: state.records, signed: state.signed,
    transfer_attempts: state.transfer_attempts}));
  assert.equal(second.ok, true, second.summary.reason);           // signed at once (v3.1 clients waited an hour)
  // attempt 1 applies; A raises A->B back to 10 and C moves 3 out of A->C, both between T1 and T2: attempt 2 never applies
  let edges = {[AB]: [10, TS_AB], [AC]: [4, TS_AC]};
  assert.equal(trackerV32(edges, T1, bPrior(first), cPrior(T1)), true);
  edges[AB] = [10, T1 + 10_000];
  edges[AC] = [4, T1 + 20_000];
  assert.equal(trackerV32(edges, T2, bPrior(second), cPrior(T2)), false);
  // the other order: attempt 2 first, then attempt 1 is older than the edge
  edges = {[AB]: [10, TS_AB], [AC]: [4, TS_AC]};
  assert.equal(trackerV32(edges, T2, bPrior(second), cPrior(T2)), true);
  assert.equal(trackerV32(edges, T1, bPrior(first), cPrior(T1)), false);
});
