// The client's own records of its edges (records.js) and Client.complete() over them, offline against a fake Valun
// server and tracker with real signatures (the JavaScript twin of python/tests/test_records.py and
// test_client_complete.py): what is recorded (pending vs confirmed), OQ-23 (an owner who rejects a held note no longer
// leaves the record ahead of the tracker), when the prior note is accepted, the reserved-residue refusal, the payee's
// delivery signature, the tracker pins, a profile not pinned yet served exactly as by 0.3, and the FileStore lock shared
// with the Python client (two JavaScript stores, and a Python and a JavaScript process, on one profile). Temporary files
// live only in js/test/.tmp-* and are removed afterwards.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  Client, MemoryStore, NETWORK, PILOT_DENOMINATION, PROTOCOL, ValunAgent, ValunError, basis, bytesToHex, records, sha256Hex,
  statements, termsHash, utf8, verifyNote,
} from '../src/index.js';
import {FileStore} from '../src/file-store.js';
import {jsonResponse, testKey} from './helpers.js';

const NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa';
const OTHER_NFT = '11'.repeat(32);
const DENOM = PILOT_DENOMINATION;
const SERVER = 'http://valun.invalid';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');       // a whole second: NOW - 1500 ends in 500 ms
const key = label => { const secret = testKey(label); return {secret, pubkey: bytesToHex(basis.publicKey(secret))}; };
const ALICE = key('test/alice'), BOB = key('test/bob'), BOB2 = key('test/bob-rotated'), MALLORY = key('test/mallory');
const ALICE_ID = 'vp_a1a1a1a1a1a1', BOB_ID = 'vp_b0b0b0b0b0b0';
const PAIR = `${ALICE.pubkey}>${BOB.pubkey}`;
const signText = (k, text) => bytesToHex(basis.sign(utf8(text), k.secret));
const signNote = (k, recipientPk, total, ts, nft = NFT) => bytesToHex(basis.sign(basis.noteMessage(k.pubkey, recipientPk, total, ts, nft, DENOM), k.secret));
const verify = (i, r, total, ts, sig) => verifyNote(i, r, total, ts, sig, NFT, DENOM);
const edge = (total, ts, signer = ALICE) => ({total, timestamp: ts, signature: signNote(signer, BOB.pubkey, total, ts)});
const isCode = code => e => e instanceof ValunError && e.code === code;
const clone = v => JSON.parse(JSON.stringify(v));

const TMP = fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-'));
after(() => fs.rmSync(TMP, {recursive: true, force: true}));
let n = 0;
const freshDir = () => { const d = path.join(TMP, `r${n++}`); fs.mkdirSync(d, {recursive: true}); return d; };

/** A fake Valun server with a fake tracker: just enough of /pilot/v1 for complete(). Alice pays, Bob is the payee. */
class World {
  constructor({features = null, reviewDeliveries = false, nft = NFT} = {}) {
    Object.assign(this, {features, reviewDeliveries, nft});
    this.payeeKey = BOB;                // Bob's current directory key
    this.tracker = {};                  // pair -> {total, timestamp, signature}
    this.deals = {};
    this.held = {};
    this.log = [];
    this.templateTs = null;             // force the next template timestamp (tests of the residue rule)
    this.completeAnswer = null;         // force the POST /complete answer: ['status', s] | ['error', http, code] | ['unreachable']
    this.lyingTemplate = null;          // a function that edits each template before it is sent
    this.now = NOW;                     // the server's clock (templates are made from it)
    this.fetch = (url, init) => this.#fetch(url, init);
  }

  addDeal(dealId, {price = 20, content = '# Brief\n\nThree sources.\n', deliveryKey = null, termsPayee = null} = {}) {
    const payee = termsPayee || BOB;
    const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: this.nft, denomination: DENOM, deal_id: dealId, version: 1,
      prior_terms_hash: null, nonce: 'ab'.repeat(16), proposer: ALICE_ID, payer: {id: ALICE_ID, pubkey: ALICE.pubkey},
      payee: {id: BOB_ID, pubkey: payee.pubkey}, service: {title: 'Short research brief', description: 'Three sources.', deliverable: 'markdown'},
      price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
      deliver_by: '2099-01-02T00:00:00.000Z', offer_expires_at: '2099-01-01T00:00:00.000Z'};
    const h = termsHash(t), dh = sha256Hex(content);
    this.deals[dealId] = {id: dealId, status: 'delivered', your_role: 'payer', counterparty: {id: BOB_ID, handle: 'bob'},
      current: {version: 1, by: ALICE_ID, state: 'accepted', terms: t, terms_hash: h, signature: signText(ALICE, statements.propose(h))},
      agreement: {version: 1, terms_hash: h, proposer_signature: signText(ALICE, statements.propose(h)), acceptor_signature: signText(payee, statements.accept(h))},
      delivery: {by: BOB_ID, title: 'Brief', content, sha256: dh, bytes: utf8(content).length,
        signature: signText(deliveryKey || payee, statements.deliver(h, content))},
      credit_note: null};
    return this.deals[dealId];
  }

  get pair() { return `${ALICE.pubkey}>${this.payeeKey.pubkey}`; }

  setEdge(total, timestamp, signer = ALICE) {
    this.tracker[this.pair] = {total, timestamp, signature: signNote(signer, this.payeeKey.pubkey, total, timestamp)};
  }

  info() {
    const out = {network: NETWORK, protocol: PROTOCOL, unit: 'PC', tracker_nft_id: this.nft, denomination: DENOM};
    if (this.features !== null) {
      out.features = this.features;
      // GET /info novation of a v16 server on tracker v3.2 (design v3.2): what the client signs a bound note for
      out.novation = {transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000,
        transfer_ttl_ms: 1200000, setoff_ttl_ms: 1800000, fallback_margin_ms: 60000, tracker_build: 'valun-circulating-credit/4',
        transfer_version: 4, bound_note_version: 3, prior_ack: 'basis/prior-ack/1'};
    }
    return out;
  }

  ownerReject(dealId) {
    delete this.held[dealId];
    Object.assign(this.deals[dealId], {status: 'delivered', credit_note: null});
  }

  ownerApprove(dealId) {
    const note = this.held[dealId];
    delete this.held[dealId];
    this.#apply(dealId, note);
  }

  #apply(dealId, note) {
    note = {total: note.total, timestamp: note.timestamp, signature: note.signature};   // the EdgeState
    this.tracker[this.pair] = {...note};
    Object.assign(this.deals[dealId], {status: 'note_issued', credit_note: {state: 'recorded', note: {...note}, tracker_note: {
      amount_collected: note.total, amount_redeemed: 0, timestamp: note.timestamp, signature: note.signature, confirmation: 'local_only'}}});
  }

  async #fetch(url, init = {}) {
    const p = url.slice(SERVER.length), method = init.method || 'GET';
    this.log.push(`${method} ${p}`);
    if (method === 'POST' && this.completeAnswer?.[0] === 'unreachable') throw new TypeError('fetch failed');
    try {
      return jsonResponse(200, this.#handle(method, p, init.body ? JSON.parse(init.body) : undefined));
    } catch (e) {
      if (!(e instanceof ValunError)) throw e;
      return jsonResponse(e.status, {error: e.code, message: e.message});
    }
  }

  #handle(method, p, body) {
    if (method === 'GET' && p === '/pilot/v1/info') return this.info();
    if (method === 'GET' && p === `/pilot/v1/participants/${BOB_ID}`) return {id: BOB_ID, handle: 'bob', status: 'active', pubkey: this.payeeKey.pubkey};
    const parts = p.split('?')[0].split('/');
    const did = parts[4];
    if (parts[3] === 'deals' && Object.hasOwn(this.deals, did)) {
      if (method === 'GET' && parts.length === 5) return clone(this.deals[did]);
      if (method === 'GET' && parts[5] === 'credit-note-template') {
        const query = (p.split('?')[1] || '').split('&');
        return this.template(did, query.includes('prior=1'), query.includes('bound=1'));
      }
      if (method === 'POST' && parts[5] === 'complete') return this.complete(did, body);
    }
    throw new ValunError('not_found', `no route ${method} ${p}`, 404);
  }

  template(did, prior, bound = false) {
    const d = this.deals[did], cur = this.tracker[this.pair];
    const price = d.current.terms.price.amount, last = cur ? cur.timestamp : 0;
    const mod = (a, n) => ((a % n) + n) % n;
    let ts;
    if (this.templateTs !== null) {
      ts = this.templateTs;
    } else if (bound) {                         // v16 ?bound=1: the largest ts ending in 997 ms, <= now - 1500, > last
      ts = (this.now - 1500) - mod(this.now - 1500 - 997, 1000);
      if (ts <= last) ts = last + 1 + mod(997 - (last + 1), 1000);   // the next one (the server waits up to 3 s for it)
    } else {
      ts = Math.max(this.now - 1500, last + 1);
      if (this.features?.length && ts % 1000 >= 995) ts += 1000 - ts % 1000;   // what the v16 server does for ordinary notes
    }
    const priorTotal = cur ? cur.total : 0;
    const tpl = {deal_id: did, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, issuer_pubkey: ALICE.pubkey,
      recipient_pubkey: this.payeeKey.pubkey, keys_as_agreed: true, prior_total: priorTotal, price, total: priorTotal + price, timestamp: ts,
      tracker_nft_id: this.nft, denomination: DENOM, message_hex: '00'};
    if (prior || bound) tpl.prior_note = cur ? {...cur} : null;
    if (bound) tpl.prior_message_hex = '00';
    return this.lyingTemplate ? this.lyingTemplate(tpl) : tpl;
  }

  complete(did, body) {
    if (this.completeAnswer?.[0] === 'error') {
      const [, status, code] = this.completeAnswer;
      throw new ValunError(code, `forced ${code}`, status);
    }
    const note = body.credit_note;
    if (!verifyNote(ALICE.pubkey, this.payeeKey.pubkey, note.total, note.timestamp, note.signature, this.nft, DENOM)) {
      throw new ValunError('bad_signature', 'the Basis note signature does not verify', 403);
    }
    if (this.features?.length && note.timestamp % 1000 === 997) {     // a bound note (v16, PROTOCOL.md 18.5)
      const cur = this.tracker[this.pair];
      const [prior, priorTs] = cur ? [cur.total, cur.timestamp] : [0, 0];
      if (note.prior_total !== prior || (note.prior_timestamp ?? priorTs) !== priorTs) {
        throw new ValunError('stale_note', "a bound credit note's prior_total and prior_timestamp must be the pair's current state", 409);
      }
      // tracker v3.2: the prior acknowledgment is PA(I,R,prior,priorTs,ts) over the stored state
      const pa = basis.priorAckMessage(ALICE.pubkey, this.payeeKey.pubkey, prior, priorTs, note.timestamp, this.nft, DENOM);
      if (!basis.verifyHex(note.prior_signature ?? '', pa, ALICE.pubkey)) {
        throw new ValunError('bad_signature', 'the prior acknowledgment does not verify', 403);
      }
    }
    if (this.completeAnswer) {
      this.deals[did].status = this.completeAnswer[1];
      return {id: did, status: this.completeAnswer[1]};
    }
    if (this.reviewDeliveries) {
      this.held[did] = {...note};
      this.deals[did].status = 'completion_awaiting_owner';
      return {id: did, status: 'completion_awaiting_owner', credit_note: {state: 'signed'}};
    }
    this.#apply(did, note);
    return clone(this.deals[did]);
  }
}

const memStore = (extra = {}) => new MemoryStore({state: {server: SERVER, participant_id: ALICE_ID, pubkey: ALICE.pubkey, issued: {}, ...clone(extra)},
  secret: bytesToHex(ALICE.secret), token: 'vpa_test-only'});
const pinnedStore = (extra = {}) => memStore({pins: {tracker_nft_id: NFT, denomination: DENOM}, ...extra});
const clientOf = (w, store) => new Client({store, server: SERVER, fetch: w.fetch, now: () => NOW});
const complete = (w, store, dealId, opts) => clientOf(w, store).complete(dealId, opts);
const rec = store => records.get(store.state.records, PAIR);
const posted = (w, did) => w.log.filter(k => k === `POST /pilot/v1/deals/${did}/complete`).length;

// ---------- records.js ----------
test('records: pending entries are added once, removed by ref, and need whole numbers and a direction', () => {
  const recs = {};
  const p = records.addPending(recs, PAIR, 20, 1000, 'note', 'vd_1', 'out', '2026-11-08T00:00:00.000Z');
  assert.equal(records.addPending(recs, PAIR, 20, 1000, 'note', 'vd_1', 'out'), p, 'no second copy');
  assert.deepEqual(recs[PAIR], {confirmed: null, pending: [p]});
  assert.deepEqual(p, {total: 20, timestamp: 1000, kind: 'note', ref: 'vd_1', direction: 'out', signed_at: '2026-11-08T00:00:00.000Z'});
  assert.equal(records.removePending(recs, PAIR, 20, 1000, 'vd_other'), 0);
  assert.equal(records.removePending(recs, PAIR, 20, 1000, 'vd_1'), 1);
  for (const [total, ts] of [[true, 1], [-1, 1], [1, 1.5], ['1', 1]]) {
    assert.throws(() => records.addPending(recs, PAIR, total, ts, 'note'), e => e.name === 'ValueError', String(total));
  }
  assert.throws(() => records.addPending(recs, PAIR, 1, 1, 'note', null, 'sideways'), e => e.name === 'ValueError');
});

test('records: confirm promotes the matching entry, drops what can never apply, and never moves back in time', () => {
  const recs = {};
  for (const [total, ts] of [[10, 1000], [20, 2000], [99, 2000], [30, 3000]]) records.addPending(recs, PAIR, total, ts, 'note', `vd_${total}`);
  const e = records.confirm(recs, PAIR, {total: 20, timestamp: 2000, signature: 'aa'});
  assert.deepEqual(e.confirmed, {total: 20, timestamp: 2000, signature: 'aa'});
  assert.deepEqual(e.pending.map(p => [p.total, p.timestamp]), [[30, 3000]], '10@1000 and 99@2000 are dead');
  assert.equal(records.confirmedTotal(recs, PAIR), 20);
  records.confirm(recs, PAIR, {total: 5, timestamp: 1500, signature: 'bb'});
  assert.equal(records.get(recs, PAIR).confirmed.total, 20, 'never back in time');
  assert.throws(() => records.confirm(recs, PAIR, {total: 5, timestamp: 1500}), e => e.name === 'ValueError');
});

test('records: syncEdge promotes a matching entry, drops one the edge moved past, ignores an older row', () => {
  const recs = {};
  records.addPending(recs, PAIR, 20, 2000, 'note', 'vd_1');
  records.addPending(recs, PAIR, 25, 3000, 'setoff', 'vs_1', 'out');
  let r = records.syncEdge(recs, {edge: PAIR, total: 20, timestamp: 2000, signature: 'aa', exact: true});
  assert.equal(r.changed, true);
  assert.equal(r.promoted.ref, 'vd_1');
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.confirmed, {total: 20, timestamp: 2000, signature: 'aa'});
  assert.deepEqual(records.get(recs, PAIR).pending.map(p => p.ref), ['vs_1'], 'still possible');
  r = records.syncEdge(recs, {issuer_pubkey: ALICE.pubkey, recipient_pubkey: BOB.pubkey, total: 40, timestamp: 4000, signature: 'cc'});
  assert.deepEqual([r.pair, r.promoted, r.dropped.map(p => p.ref)], [PAIR, null, ['vs_1']]);
  r = records.syncEdge(recs, {edge: PAIR, total: 20, timestamp: 2000, signature: 'aa'});
  assert.equal(r.changed, false);
  assert.equal(r.confirmed.total, 40);
  for (const bad of [{total: 1, timestamp: 1, signature: 's'}, {edge: 'nokey', total: 1, timestamp: 1, signature: 's'},
    {edge: PAIR, total: '1', timestamp: 1, signature: 's'}, ['not', 'a', 'row']]) {
    assert.throws(() => records.syncEdge(recs, bad), e => e.name === 'ValueError', JSON.stringify(bad));
  }
});

test('records: acceptPrior takes a prior signed by me as issuer that is not older than my confirmed state', () => {
  const recs = {};
  const mine = edge(30, 5000);
  assert.equal(records.acceptPrior(recs, PAIR, mine, ALICE.pubkey, verify), true, 'nothing confirmed yet');
  records.confirm(recs, PAIR, edge(10, 4000));
  assert.equal(records.acceptPrior(recs, PAIR, mine, ALICE.pubkey, verify), true, 'newer than my record');
  records.confirm(recs, PAIR, edge(10, 6000));
  assert.equal(records.priorProblem(recs, PAIR, mine, ALICE.pubkey, verify), 'stale_prior');
  assert.equal(records.priorProblem(recs, PAIR, edge(11, 6000), ALICE.pubkey, verify), 'stale_prior');
  assert.equal(records.priorProblem(recs, PAIR, edge(10, 6000), ALICE.pubkey, verify), null);
  assert.equal(records.priorProblem({}, PAIR, edge(30, 5000, MALLORY), ALICE.pubkey, verify), 'bad_prior_signature');
  assert.equal(records.priorProblem({}, PAIR, mine, BOB.pubkey, verify), 'bad_prior_signature', 'not my edge');
  assert.equal(records.priorProblem({}, PAIR, {total: 30, timestamp: 5000}, ALICE.pubkey, verify), 'bad_prior_signature');
  assert.equal(records.acceptPrior({}, PAIR, mine, ALICE.pubkey, () => { throw new Error('down'); }), false, 'a broken verifier accepts nothing');
});

// ---------- complete(): what is recorded ----------
test('complete(): note_issued is confirmed; held and issuing notes are pending, not issued (OQ-23)', async () => {
  const w = new World(), s = memStore();
  w.addDeal('vd_1');
  assert.equal((await complete(w, s, 'vd_1')).status, 'note_issued');
  assert.deepEqual(s.state.issued, {[w.pair]: 20});
  assert.deepEqual(rec(s).confirmed, w.tracker[w.pair]);
  assert.deepEqual(rec(s).pending, []);
  for (const answer of ['completion_awaiting_owner', 'issuing_note']) {
    const w2 = new World(), s2 = memStore();
    w2.addDeal('vd_1');
    w2.completeAnswer = ['status', answer];
    await complete(w2, s2, 'vd_1');
    assert.deepEqual(s2.state.issued, {}, answer);
    assert.equal(rec(s2).confirmed, null);
    assert.deepEqual(rec(s2).pending.map(p => [p.total, p.kind, p.ref, p.direction]), [[20, 'note', 'vd_1', 'out']]);
    assert.equal(rec(s2).pending[0].signed_at, '2026-11-08T12:00:00.000Z');
  }
});

test('complete(): a failed or refused note is forgotten; an unknown outcome stays pending', async () => {
  const w = new World(), s = memStore();
  w.addDeal('vd_1');
  w.completeAnswer = ['status', 'note_failed'];
  await complete(w, s, 'vd_1');
  assert.deepEqual(rec(s).pending, []);
  w.completeAnswer = ['error', 409, 'stale_note'];
  await assert.rejects(complete(w, s, 'vd_1'), isCode('stale_note'));
  assert.deepEqual(rec(s).pending, []);
  w.completeAnswer = ['unreachable'];                          // no answer: the server may have recorded it
  await assert.rejects(complete(w, s, 'vd_1'), isCode('unreachable'));
  assert.equal(rec(s).pending.length, 1);
  w.completeAnswer = ['error', 503, 'tracker_unavailable'];    // a 5xx: unknown too
  w.addDeal('vd_2');
  await assert.rejects(complete(w, s, 'vd_2'), isCode('tracker_unavailable'));
  assert.equal(rec(s).pending.length, 2);
  assert.deepEqual(s.state.issued, {});
});

test('complete(): a record that cannot be written after the answer does not hide it', async () => {
  for (const failure of [() => new ValunError('profile_busy', 'busy'), () => Object.assign(new Error('ENOSPC: no space left on device'), {errno: -28, code: 'ENOSPC', syscall: 'write'})]) {
    const w = new World();
    let sent = false;
    const s = memStore();
    s.update = fn => {                                         // a store with update(): fails once the note is sent
      if (sent) throw failure();
      const work = clone(s.state);
      const result = fn(work);
      for (const k of Object.keys(s.state)) delete s.state[k];
      Object.assign(s.state, work);
      return result;
    };
    const marking = (url, init) => { if (init?.method === 'POST') sent = true; return w.fetch(url, init); };
    w.addDeal('vd_1');
    const c = new Client({store: s, server: SERVER, fetch: marking, now: () => NOW});
    assert.equal((await c.complete('vd_1')).status, 'note_issued', 'issued: the answer is returned');
    assert.equal(w.tracker[w.pair].total, 20);
    assert.deepEqual(rec(s).pending.map(p => p.total), [20], 'settled later');
    sent = false;
    await assert.rejects(c.complete('vd_1'), isCode('already_paid'), 'the entry still pending is enough to refuse paying again');
    w.addDeal('vd_2');
    w.completeAnswer = ['error', 409, 'stale_note'];
    sent = false;
    await assert.rejects(c.complete('vd_2'), isCode('stale_note'), "the server's refusal, not the store's failure");
  }
});

test('complete(): terms other than the ones reviewed are not paid; the pending entry is written before the note is sent', async () => {
  const w = new World(), s = memStore();
  w.addDeal('vd_1');
  await assert.rejects(complete(w, s, 'vd_1', {expectedTermsHash: 'e'.repeat(64)}), isCode('stale_terms'));
  assert.deepEqual(w.log, ['GET /pilot/v1/deals/vd_1'], 'refused before the template is even asked for');
  const seen = [];
  const spy = (url, init) => { if (init?.method === 'POST') seen.push(clone(rec(s).pending)); return w.fetch(url, init); };
  const h = w.deals.vd_1.agreement.terms_hash;
  const r = await new Client({store: s, server: SERVER, fetch: spy, now: () => NOW}).complete('vd_1',
    {expectedDeliverableSha256: w.deals.vd_1.delivery.sha256, expectedTermsHash: h});
  assert.equal(r.status, 'note_issued');
  assert.deepEqual(seen.map(p => p.map(x => x.total)), [[20]]);
});

test('complete(): a FileStore profile holds the records, the 0.3 record and the pins; no lock is left behind', async () => {
  const file = path.join(freshDir(), 'alice.json');
  fs.writeFileSync(file, JSON.stringify({...memStore().state, secret: bytesToHex(ALICE.secret), agent_token: 'vpa_test-only'}));
  const w = new World();
  w.addDeal('vd_1');
  await complete(w, new FileStore(file), 'vd_1');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.issued, {[w.pair]: 20});
  assert.equal(disk.records[w.pair].confirmed.total, 20);
  assert.deepEqual(disk.pins, {tracker_nft_id: NFT, denomination: DENOM});
  assert.equal(disk.server, SERVER);
  assert.equal(disk.secret, bytesToHex(ALICE.secret));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['alice.json']);
});

test('end to end: a delivery acceptance signs only the agreement the owner was shown', async () => {
  // The snapshot shows a delivery on a 5 PC agreement; when the client signs, the same text is shown on another,
  // genuinely agreed 500 PC deal under this id: nothing is signed, not even the template is asked for.
  const review = {deal_id: 'vd_1', decision: 'accept'};
  const w = new World(), s = memStore();
  w.addDeal('vd_1', {price: 5});
  const a = new ValunAgent(clientOf(w, s));
  const p = await a.prepare('valun_review_delivery', review);
  assert.ok(p.text.includes('ISSUE A CREDIT NOTE of 5 PC'), p.text);
  w.addDeal('vd_1', {price: 500});
  w.log.length = 0;
  await assert.rejects(a.call('valun_review_delivery', p.args), isCode('stale_terms'));
  assert.deepEqual(w.log, ['GET /pilot/v1/deals/vd_1']);
  assert.deepEqual(w.tracker, {});
  const w2 = new World(), a2 = new ValunAgent(clientOf(w2, memStore()));   // the consistent case pays exactly the price shown
  w2.addDeal('vd_1', {price: 5});
  assert.equal((await a2.call('valun_review_delivery', (await a2.prepare('valun_review_delivery', review)).args)).status, 'note_issued');
  assert.equal(w2.tracker[w2.pair].total, 5);
});

// ---------- 0.3 compatibility ----------
test('complete(): a profile not pinned yet reads no /info and asks for no prior note (0.3 rules), and is pinned by the call', async () => {
  const w = new World({features: ['bound_notes/1']}), s = memStore();
  w.addDeal('vd_1');
  w.templateTs = Math.floor(NOW / 1000) * 1000 - 1001;          // ends in 999: 0.3 rules accept it
  assert.equal((await complete(w, s, 'vd_1')).status, 'note_issued');
  assert.deepEqual(w.log, ['GET /pilot/v1/deals/vd_1', 'GET /pilot/v1/deals/vd_1/credit-note-template',
    `GET /pilot/v1/participants/${BOB_ID}`, 'POST /pilot/v1/deals/vd_1/complete']);
  assert.deepEqual(s.state.pins, {tracker_nft_id: NFT, denomination: DENOM});
});

test('complete(): without a prior note the ledger rule is kept', async () => {
  const w = new World(), s = memStore({issued: {}});
  w.addDeal('vd_1');
  w.setEdge(10, NOW - 60_000);
  s.state.issued = {[w.pair]: 30};
  await assert.rejects(complete(w, s, 'vd_1'), isCode('ledger_mismatch'));
  assert.equal(posted(w, 'vd_1'), 0);
});

// ---------- the prior note (a server offering bound_notes/1) ----------
test('complete(): a pinned profile asks for the prior note and accepts a lower prior it signed itself over its old record', async () => {
  const w = new World({features: ['bound_notes/1']});
  const s = pinnedStore({issued: {[PAIR]: 50}, records: {[PAIR]: {confirmed: {total: 50, timestamp: NOW - 600_000, signature: 'x'}, pending: []}}});
  w.addDeal('vd_1');
  w.setEdge(30, NOW - 60_000);                                  // a set-off since lowered the edge to 30, signed by me as issuer
  assert.equal((await complete(w, s, 'vd_1')).status, 'note_issued');
  assert.ok(w.log.includes('GET /pilot/v1/info'));
  assert.ok(w.log.includes('GET /pilot/v1/deals/vd_1/credit-note-template?prior=1&bound=1'));   // a bound template (0.4)
  assert.equal(w.tracker[w.pair].total, 50);                    // 30 + 20
  assert.deepEqual(s.state.issued, {[w.pair]: 50});
  assert.equal(rec(s).confirmed.total, 50);
});

test('complete(): a prior note not signed by me, older than my records, or not the template prior is refused', async () => {
  let w = new World({features: ['bound_notes/1']});
  w.addDeal('vd_1');
  w.setEdge(30, NOW - 60_000, MALLORY);
  await assert.rejects(complete(w, pinnedStore(), 'vd_1'), isCode('bad_prior_signature'));
  assert.equal(posted(w, 'vd_1'), 0);
  // F-B shape: the server shows the higher total from before a decrease my records confirm.
  w = new World({features: ['bound_notes/1']});
  w.addDeal('vd_1');
  w.setEdge(30, NOW - 60_000);
  const s = pinnedStore({records: {[PAIR]: {confirmed: {total: 10, timestamp: NOW - 30_000, signature: 'x'}, pending: []}}});
  await assert.rejects(complete(w, s, 'vd_1'), e => isCode('ledger_mismatch')(e) && /older prior credit note/.test(e.message));
  assert.equal(posted(w, 'vd_1'), 0);
  w = new World({features: ['bound_notes/1']});
  w.addDeal('vd_1');
  w.setEdge(30, NOW - 60_000);
  w.lyingTemplate = tpl => ({...tpl, prior_total: 40, total: 60});   // a higher prior than the note it shows
  await assert.rejects(complete(w, pinnedStore(), 'vd_1'), isCode('bad_template'));
});

test('complete(): a pending note shown as the prior applied: it is confirmed, and its own deal is never paid again', async () => {
  const w = new World({features: ['bound_notes/1'], reviewDeliveries: true}), s = pinnedStore();
  w.addDeal('vd_0', {price: 10});
  await complete(w, s, 'vd_0');                                 // held: pending 10
  w.ownerApprove('vd_0');
  w.reviewDeliveries = false;
  w.addDeal('vd_1');
  assert.equal((await complete(w, s, 'vd_1')).status, 'note_issued');
  assert.deepEqual([s.state.issued, w.tracker[w.pair].total], [{[w.pair]: 30}, 30]);
  assert.deepEqual(rec(s).pending, []);
  // and a deal whose own note applied is not paid again, even if the server shows it unpaid
  const w2 = new World({features: ['bound_notes/1'], reviewDeliveries: true}), s2 = pinnedStore();
  w2.addDeal('vd_1');
  await complete(w2, s2, 'vd_1');
  w2.ownerApprove('vd_1');
  Object.assign(w2.deals.vd_1, {status: 'delivered'});
  w2.reviewDeliveries = false;
  await assert.rejects(complete(w2, s2, 'vd_1'), isCode('already_paid'));
  assert.equal(posted(w2, 'vd_1'), 1);
  assert.deepEqual([s2.state.issued, w2.tracker[w2.pair].total], [{[w2.pair]: 20}, 20]);
});

// ---------- the reserved residues ----------
test('complete(): with features advertised, a template timestamp ending in 995-999 is refused; without, the 0.3 rules apply', async () => {
  for (const residue of [995, 997, 999]) {      // an ordinary template (features advertised, but not bound_notes/1)
    const w = new World({features: ['example/1']});
    w.addDeal('vd_1');
    w.templateTs = Math.floor(NOW / 1000) * 1000 - 2000 + residue;
    await assert.rejects(complete(w, pinnedStore(), 'vd_1'), e => isCode('bad_template')(e) && new RegExp(`ends in ${residue}`).test(e.message), String(residue));
    assert.equal(posted(w, 'vd_1'), 0);
  }
  for (const residue of [0, 994, 995, 996, 998, 999]) {   // with bound_notes/1 only a bound template is signed (R3, R12)
    const w = new World({features: ['bound_notes/1']});
    w.addDeal('vd_1');
    w.templateTs = Math.floor(NOW / 1000) * 1000 - 2000 + residue;
    await assert.rejects(complete(w, pinnedStore(), 'vd_1'), isCode('bound_note_required'), String(residue));
    assert.equal(posted(w, 'vd_1'), 0);
  }
  for (const features of [['circulation/1'], 'bound_notes/1']) {   // any feature; a malformed list counts as advertised
    const w = new World({features});
    w.addDeal('vd_1');
    w.templateTs = Math.floor(NOW / 1000) * 1000 - 1003;
    await assert.rejects(complete(w, pinnedStore(), 'vd_1'), isCode('bad_template'), JSON.stringify(features));
  }
  const w = new World({features: []});                          // no features: the 0.3 rules
  w.addDeal('vd_1');
  w.templateTs = Math.floor(NOW / 1000) * 1000 - 1001;
  assert.equal((await complete(w, pinnedStore(), 'vd_1')).status, 'note_issued');
  const clamped = new World({features: ['example/1']});         // a v16 server moves an ordinary timestamp out of 995-999 itself
  clamped.addDeal('vd_1');
  clamped.now = Math.floor(NOW / 1000) * 1000 + 1497;           // now - 1500 would end in 997
  assert.equal((await complete(clamped, pinnedStore(), 'vd_1')).status, 'note_issued');
  assert.equal(clamped.tracker[clamped.pair].timestamp % 1000, 0);
});

// ---------- paid once ----------
test('complete(): a first note approved later is not paid again, on the 0.3 path and pinned without features', async () => {
  for (const pinned of [false, true]) {
    const s = pinned ? pinnedStore() : memStore();
    const w = new World({features: pinned ? [] : null, reviewDeliveries: true});
    w.addDeal('vd_1');
    assert.equal((await complete(w, s, 'vd_1')).status, 'completion_awaiting_owner');
    w.ownerApprove('vd_1');                                      // the tracker now holds the note
    w.reviewDeliveries = false;
    Object.assign(w.deals.vd_1, {status: 'delivered', credit_note: null});   // a server that hides it and offers the deal again
    await assert.rejects(complete(w, s, 'vd_1'), isCode('already_paid'), String(pinned));
    assert.equal(posted(w, 'vd_1'), 1);
    assert.equal(w.tracker[w.pair].total, 20);
  }
  // the deal itself says the note was issued: confirmed from it, and refused as paid
  const s = memStore(), w = new World({reviewDeliveries: true});
  w.addDeal('vd_1');
  await complete(w, s, 'vd_1');
  w.ownerApprove('vd_1');
  w.reviewDeliveries = false;
  await assert.rejects(complete(w, s, 'vd_1'), isCode('already_paid'));
  assert.deepEqual([s.state.issued, rec(s).pending], [{[w.pair]: 20}, []]);
});

test('OQ-23: an owner rejects a held note, and the next completion to that payee succeeds', async () => {
  for (const pinned of [false, true]) {
    const s = pinned ? pinnedStore() : memStore();
    const w = new World({features: pinned ? [] : null, reviewDeliveries: true});
    w.addDeal('vd_1');
    assert.equal((await complete(w, s, 'vd_1')).status, 'completion_awaiting_owner');
    w.ownerReject('vd_1');                                       // the tracker never saw the note
    w.reviewDeliveries = false;
    // 0.3.1 had recorded issued[pair] = 20 here and refused this with ledger_mismatch (tracker prior 0).
    assert.equal((await complete(w, s, 'vd_1')).status, 'note_issued');
    assert.deepEqual([w.tracker[w.pair].total, s.state.issued], [20, {[w.pair]: 20}]);
    assert.equal(rec(s).confirmed.total, 20);
    assert.deepEqual(rec(s).pending, [], 'the rejected note is dead: dropped');
  }
});

test('OQ-23: a held note approved later is confirmed from its deal; one its deal does not show issued is not', async () => {
  let w = new World(), s = memStore();
  w.addDeal('vd_0', {price: 10});
  await complete(w, s, 'vd_0');                                 // confirmed 10
  w.reviewDeliveries = true;
  w.addDeal('vd_1', {price: 20});
  await complete(w, s, 'vd_1');                                 // held: 30 pending
  w.ownerApprove('vd_1');
  w.reviewDeliveries = false;
  w.addDeal('vd_2', {price: 5});
  assert.equal((await complete(w, s, 'vd_2')).status, 'note_issued');
  assert.ok(w.log.includes('GET /pilot/v1/deals/vd_1'), 'read the held deal to confirm its note');
  assert.deepEqual(s.state.issued, {[w.pair]: 35});
  assert.deepEqual(rec(s).pending, []);
  // a deal its own (held, then approved) note paid is not paid again, whatever the server shows
  w = new World();
  s = memStore();
  w.addDeal('vd_0', {price: 10});
  await complete(w, s, 'vd_0');                                 // confirmed 10
  w.reviewDeliveries = true;
  w.addDeal('vd_1', {price: 20});
  await complete(w, s, 'vd_1');                                 // held: 30 pending
  w.ownerApprove('vd_1');                                       // applied; its deal records it as issued
  w.reviewDeliveries = false;
  await assert.rejects(complete(w, s, 'vd_1'), isCode('already_paid'));
  assert.deepEqual(s.state.issued, {[w.pair]: 30});
  assert.equal(posted(w, 'vd_1'), 1);
  // the tracker moved, but the held deal does not say so: nothing is confirmed, and the 0.3 rule refuses
  w = new World();
  s = memStore();
  w.addDeal('vd_0', {price: 10});
  await complete(w, s, 'vd_0');
  w.reviewDeliveries = true;
  w.addDeal('vd_1', {price: 20});
  await complete(w, s, 'vd_1');
  w.setEdge(30, w.tracker[w.pair].timestamp + 1);
  w.reviewDeliveries = false;
  w.addDeal('vd_2', {price: 5});
  await assert.rejects(complete(w, s, 'vd_2'), isCode('ledger_mismatch'));
  assert.deepEqual(s.state.issued, {[w.pair]: 10});
});

// ---------- the payee's delivery signature ----------
test("complete(): the delivery must be signed by the payee's agreed or current key", async () => {
  let w = new World();
  w.addDeal('vd_1', {deliveryKey: MALLORY});
  await assert.rejects(complete(w, memStore(), 'vd_1'), isCode('bad_delivery_signature'));
  assert.equal(posted(w, 'vd_1'), 0);
  w = new World();                                              // the terms name Bob's old key; his agent signed with the new one
  w.addDeal('vd_1', {deliveryKey: BOB2});
  w.payeeKey = BOB2;
  assert.equal((await complete(w, memStore(), 'vd_1')).status, 'note_issued');
  w = new World();
  const d = w.addDeal('vd_1');
  const signed = {...d.delivery};
  delete d.delivery.signature;
  await assert.rejects(complete(w, memStore(), 'vd_1'), isCode('bad_delivery_signature'));
  const h = d.agreement.terms_hash;
  assert.doesNotThrow(() => Client.checkDeliverySignature(signed, h, null, BOB.pubkey), 'keys that are not text are skipped');
  assert.throws(() => Client.checkDeliverySignature(signed, h, MALLORY.pubkey), isCode('bad_delivery_signature'));
  assert.throws(() => Client.checkDeliverySignature({...signed, sha256: sha256Hex('other')}, h, BOB.pubkey), isCode('bad_delivery_signature'));
});

// ---------- pins ----------
test('pins: the first /info pins an enrolled profile; another tracker later, or in complete(), is refused', async () => {
  const w = new World(), s = memStore();
  const c = clientOf(w, s);
  await c.info();
  assert.deepEqual(s.state.pins, {tracker_nft_id: NFT, denomination: DENOM});
  w.nft = OTHER_NFT;
  await assert.rejects(c.info(), e => isCode('tracker_mismatch')(e) && e.extra.pinned.tracker_nft_id === NFT);
  const un = new MemoryStore({state: {server: SERVER}});
  await clientOf(new World(), un).info();
  assert.equal('pins' in un.state, false, 'an unenrolled profile is not pinned');
  const w2 = new World({nft: OTHER_NFT, features: ['bound_notes/1']});
  w2.addDeal('vd_1');
  await assert.rejects(complete(w2, pinnedStore(), 'vd_1'), isCode('tracker_mismatch'));
  assert.equal(posted(w2, 'vd_1'), 0);
});

test('pins: the pins on disk are checked again before the note is sent', async () => {
  const w = new World({nft: OTHER_NFT});
  w.addDeal('vd_1');
  const s = memStore();
  s.update = fn => {                                            // update() reloads what is on disk: pinned meanwhile elsewhere
    const work = clone(s.state);
    work.pins = {tracker_nft_id: NFT, denomination: DENOM};
    const result = fn(work);
    for (const k of Object.keys(s.state)) delete s.state[k];
    Object.assign(s.state, work);
    return result;
  };
  await assert.rejects(complete(w, s, 'vd_1'), isCode('tracker_mismatch'));
  assert.equal(posted(w, 'vd_1'), 0);
  assert.equal('pins' in s.state, false, 'nothing was saved');
});

test('one Client completing two deals at once records both (its changes run one after another)', async () => {
  const w = new World(), s = memStore();
  let updates = 0, inside = 0, overlapped = false;
  s.update = async fn => {                                      // a store whose update() reads, waits, then writes back
    inside++;
    overlapped ||= inside > 1;
    const work = clone(s.state);
    await sleep(5);
    const result = fn(work);
    for (const k of Object.keys(s.state)) delete s.state[k];
    Object.assign(s.state, work);
    updates++;
    inside--;
    return result;
  };
  w.addDeal('vd_1', {price: 20});
  w.addDeal('vd_2', {price: 7});
  w.reviewDeliveries = true;                                    // both held: two pending entries on one edge
  const c = clientOf(w, s);
  const [a, b] = await Promise.all([c.complete('vd_1'), c.complete('vd_2')]);
  assert.deepEqual([a.status, b.status], ['completion_awaiting_owner', 'completion_awaiting_owner']);
  assert.deepEqual(rec(s).pending.map(p => p.ref).sort(), ['vd_1', 'vd_2'], 'neither write lost the other');
  assert.equal(updates, 2);
  assert.equal(overlapped, false, 'the second change started only after the first one finished');
});

// ---------- the FileStore lock (the Python FileStore's protocol, on the same files) ----------
const PROFILE = {server: SERVER, issued: {}};
function profileFile() {
  const file = path.join(freshDir(), 'profile.json');
  fs.writeFileSync(file, JSON.stringify({...PROFILE, secret: 'ab'.repeat(32), agent_token: 'vpa_test-only'}));
  return file;
}
const disk = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const leftovers = file => fs.readdirSync(path.dirname(file)).filter(f => /\.(lock|tmp|break)$/.test(f));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const counted = name => (st, i) => {
  st.n = {...(st.n || {}), [name]: ((st.n || {})[name] || 0) + 1};
  records.addPending(st.records ??= {}, `${name}>x`, i + 1, 1000 + i, 'note', `vd_${i}`);
};
function checkCounts(file, names, count) {
  const d = disk(file);
  assert.deepEqual(d.n, Object.fromEntries(names.map(x => [x, count])));
  for (const name of names) assert.deepEqual(d.records[`${name}>x`].pending.map(p => p.total), Array.from({length: count}, (_, i) => i + 1));
  assert.deepEqual([d.secret, d.agent_token, d.server], ['ab'.repeat(32), 'vpa_test-only', SERVER]);
  assert.deepEqual(leftovers(file), []);
}

test('FileStore.update(): two stores on one profile, updating at the same time, lose no updates', async () => {
  const file = profileFile();
  const stores = {a: new FileStore(file), b: new FileStore(file)};   // both loaded before either writes
  const N = 30;
  await Promise.all(Object.entries(stores).map(async ([name, st]) => {
    const fn = counted(name);
    for (let i = 0; i < N; i++) {
      await st.update(s => fn(s, i));
      await sleep(Math.random() * 3);
    }
  }));
  checkCounts(file, ['a', 'b'], N);
  await stores.a.update(() => {});
  assert.deepEqual(stores.a.state.n, {a: N, b: N}, "a store sees the other store's updates when it updates");
});

function findPython() {
  for (const cmd of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {encoding: 'utf8'});
    if (r.status === 0 && r.stdout.trim() === 'True') return cmd;
  }
  return null;
}
const PY_SRC = fileURLToPath(new URL('../../python/src/', import.meta.url));
const PYTHON = fs.existsSync(path.join(PY_SRC, 'valun', 'client.py')) ? findPython() : null;

test('FileStore.update(): a Python FileStore and a JavaScript FileStore on one profile lose none of each other\'s updates',
  {skip: !PYTHON && 'needs python/src and Python 3.10+ (the published package has no python/src)'}, async () => {
    const file = profileFile();
    const go = file + '.go';
    const N = 40;
    const worker = [
      'import os, sys, time, random',
      `sys.path.insert(0, ${JSON.stringify(PY_SRC)})`,
      'from valun import client as vc, records',
      `path, go, n = ${JSON.stringify(file)}, ${JSON.stringify(go)}, ${N}`,
      'deadline = time.monotonic() + 20',
      'while not os.path.exists(go) and time.monotonic() < deadline: time.sleep(0.001)',
      's = vc.FileStore(path)',
      'for i in range(n):',
      '    def fn(st, i=i):',
      "        st.setdefault('n', {})['py'] = st.get('n', {}).get('py', 0) + 1",
      "        records.add_pending(st.setdefault('records', {}), 'py>x', i + 1, 1000 + i, 'note', 'vd_%d' % i)",
      '    s.update(fn)',
      '    time.sleep(random.random() * 0.003)',
      "print('ok')",
    ].join('\n');
    const child = spawn(PYTHON, ['-I', '-B', '-c', worker], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const done = new Promise(resolve => child.on('close', code => resolve(code)));
    const js = new FileStore(file);
    const fn = counted('js');
    fs.writeFileSync(go, '');
    for (let i = 0; i < N; i++) {
      await js.update(s => fn(s, i));
      await sleep(Math.random() * 3);
    }
    assert.equal(await done, 0, err);
    assert.equal(out.trim(), 'ok');
    fs.unlinkSync(go);
    checkCounts(file, ['js', 'py'], N);
  });

test('FileStore lock: the lock file holds "<pid> <time> <random>" while held, and is gone after', async () => {
  const file = profileFile();
  let mark;
  await new FileStore(file).update(() => { mark = fs.readFileSync(file + '.lock', 'latin1'); });
  assert.match(mark, new RegExp(`^${process.pid} \\d+\\.\\d{3} [0-9a-f]{16}\\n$`));
  assert.deepEqual(leftovers(file), []);
});

function makeLock(file, content = '99999 0\n', ageMs = 0) {
  const lock = file + '.lock';
  fs.writeFileSync(lock, content);
  if (ageMs) {
    const old = (Date.now() - ageMs) / 1000;
    fs.utimesSync(lock, old, old);
  }
  return lock;
}

class Quick extends FileStore {
  static LOCK_WAIT_MS = 300;
}

test('FileStore lock: a stale lock is replaced; a live one makes others wait, then profile_busy; a released one lets them in', async () => {
  let file = profileFile();
  makeLock(file, '99999 0\n', 120_000);
  await new FileStore(file).update(st => { st.k = 1; });
  assert.equal(disk(file).k, 1);
  assert.deepEqual(leftovers(file), []);
  file = profileFile();
  const lock = makeLock(file);                                  // another process holds the profile
  const t0 = performance.now();
  await assert.rejects(new Quick(file).update(st => { st.k = 2; }), isCode('profile_busy'));
  assert.ok(performance.now() - t0 >= 250);
  assert.equal('k' in disk(file), false);
  fs.unlinkSync(lock);
  file = profileFile();
  const lock2 = makeLock(file);
  setTimeout(() => fs.unlinkSync(lock2), 300);
  await new FileStore(file).update(st => { st.k = 3; });
  assert.equal(disk(file).k, 3);
  assert.deepEqual(leftovers(file), []);
});

test('FileStore lock: a waiter never removes a lock taken after it judged the old one stale', () => {
  // Two waiters find the same stale lock. The first removes it and takes the profile; the second judged the old lock
  // stale just before that, and must not remove the first one's new lock (both would then hold the profile).
  const file = profileFile();
  const lock = makeLock(file, '99999 0\n', 120_000);
  const first = new FileStore(file), taken = [];
  class Second extends FileStore {
    _age(p) {
      const age = super._age(p);
      if (p === lock && !taken.length) {                        // right after the second waiter looked at the stale lock
        taken.push(first._replaceStale(lock));
        fs.writeFileSync(lock, 'first', {flag: 'wx'});
      }
      return age;
    }
  }
  new Second(file)._replaceStale(lock);
  assert.deepEqual(taken, [true]);
  assert.equal(fs.readFileSync(lock, 'latin1'), 'first', "the first waiter's lock is still in place");
  assert.equal(fs.existsSync(lock + '.break'), false);
  fs.unlinkSync(lock);
});

test('FileStore lock: a holder never removes a lock that is no longer its own; .break files of dead waiters are removed', async () => {
  let file = profileFile();
  const lock = file + '.lock';
  await new FileStore(file).update(st => {                      // held so long that another process replaced the lock as stale
    fs.unlinkSync(lock);
    fs.writeFileSync(lock, 'another process');
    st.k = 4;
  });
  assert.equal(fs.readFileSync(lock, 'latin1'), 'another process');
  fs.unlinkSync(lock);
  assert.equal(disk(file).k, 4);
  file = profileFile();
  makeLock(file, '99999 0\n', 120_000);
  const brk = file + '.lock.break';
  fs.writeFileSync(brk, '');
  const old = (Date.now() - 120_000) / 1000;
  fs.utimesSync(brk, old, old);
  await new FileStore(file).update(st => { st.k = 5; });
  assert.equal(disk(file).k, 5);
  assert.deepEqual(leftovers(file), []);
  file = profileFile();                                         // a live .break: another waiter is replacing the lock right now
  makeLock(file, '99999 0\n', 120_000);
  fs.writeFileSync(file + '.lock.break', '');
  await assert.rejects(new Quick(file).update(st => { st.k = 6; }), isCode('profile_busy'));
  assert.ok(fs.existsSync(file + '.lock'));
  fs.unlinkSync(file + '.lock.break');
  fs.unlinkSync(file + '.lock');
});

test('FileStore.update(): an unreadable profile is never overwritten; a failed update saves nothing; state is reloaded in place', async () => {
  let file = profileFile();
  const s = new FileStore(file);
  const before = clone(s.state);
  fs.writeFileSync(file, '{"cut off');
  await assert.rejects(s.update(st => { st.k = 1; }), e => isCode('records_unreadable')(e) && !e.message.includes('cut off'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"cut off');
  assert.deepEqual(s.state, before);
  assert.throws(() => s.reload(), isCode('records_unreadable'));
  assert.deepEqual(leftovers(file), []);
  file = profileFile();
  const f = new FileStore(file), onDisk = fs.readFileSync(file, 'utf8'), st0 = clone(f.state);
  await assert.rejects(f.update(st => { st.k = 1; throw new Error('boom'); }), /boom/);
  await assert.rejects(f.update(async () => {}), TypeError, 'fn must be synchronous');
  assert.deepEqual([f.state, fs.readFileSync(file, 'utf8')], [st0, onDisk]);
  assert.deepEqual(leftovers(file), []);
  file = profileFile();
  const a = new FileStore(file), b = new FileStore(file);
  const held = a.state;
  await b.update(st => { st.x = 1; });
  await a.update(st => { st.y = 2; });
  assert.equal(a.state, held, 'a client holding a.state sees the reloaded state');
  assert.deepEqual([a.state.x, a.state.y, disk(file).x, disk(file).y], [1, 2, 1, 2]);
  assert.deepEqual([a.secret(), a.token()], ['ab'.repeat(32), 'vpa_test-only']);
  const fresh = path.join(freshDir(), 'sub', 'new.json');
  const c = new FileStore(fresh);
  c.state.server = SERVER;
  await c.update(st => { st.pins = {tracker_nft_id: OTHER_NFT, denomination: 'erg'}; });
  assert.deepEqual(disk(fresh), {server: SERVER, pins: {tracker_nft_id: OTHER_NFT, denomination: 'erg'}});
});

test("Client over FileStore: two clients on one profile, completing at the same time, keep each other's records", async () => {
  const file = path.join(freshDir(), 'alice.json');
  fs.writeFileSync(file, JSON.stringify({...memStore().state, secret: bytesToHex(ALICE.secret), agent_token: 'vpa_test-only'}));
  const w = new World();
  w.addDeal('vd_1', {price: 20});
  w.addDeal('vd_2', {price: 7});
  w.reviewDeliveries = true;
  await Promise.all([complete(w, new FileStore(file), 'vd_1'), complete(w, new FileStore(file), 'vd_2')]);
  assert.deepEqual(disk(file).records[PAIR].pending.map(p => p.ref).sort(), ['vd_1', 'vd_2']);
  assert.deepEqual(leftovers(file), []);
});
