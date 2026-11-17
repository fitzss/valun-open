// Fix inbox #107, review of a4b5eb8: the races in which a creditor could still be paid twice. The hold for backers is
// checked when a payment, set-off or redemption is created; these are the ones created before the honor. An honor now
// waits (409 pair_busy, GuaranteeBook.assertDebtFree) while the creditor is collecting the same debt another way: a
// transfer of the issuer's note to it (collecting, awaiting its owner, or applying), a set-off of it being applied. When
// that ends, the debt fell and the call lapses: the backer pays nothing. A transfer or set-off that reaches the tracker
// after an honor (a recovery resubmit) is checked again and ends failed. Real valun_signer, a stub tracker that applies
// POST /notes/transfer and /notes/setoff with every signature verified (the review's harness).
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, PROTOCOL, statements, circulationStatements, guaranteeStatements, termsHash, sha256} from '../lib/pilot/core.mjs';
import {appendEntries} from '../lib/pilot/journal.mjs';
import {GUARANTEE_PROTOCOL, COVERS} from '../lib/pilot/guarantees.mjs';
import {runner, signerPath} from './tracker-harness.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const HOUR = 3600e3, PIN = 'ef'.repeat(32), NFT = 'ab'.repeat(32), TAG = Buffer.from('basis/prior-ack/1', 'ascii');
const V32_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'],
    prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};

const runSigner = makeSignerRunner({mode: runner, signerPath});
const real = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: NFT, runSigner, denomination: PILOT_DENOMINATION});
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const debtKeys = new Map();
async function paModel({issuer, recipient, priorTotal, priorTimestamp, timestamp}) {
  const k = `${issuer}>${recipient}`;
  if (!debtKeys.has(k)) debtKeys.set(k, (await runSigner(['note-message', issuer, recipient, '0', '0', NFT, PILOT_DENOMINATION])).debt_key_hex);
  return Buffer.concat([TAG, Buffer.from(debtKeys.get(k), 'hex'), u64(priorTotal), u64(priorTimestamp), u64(timestamp), Buffer.from(NFT, 'hex')]).toString('hex');
}
let signerPA;
async function hasPriorAck() {
  if (signerPA === undefined) signerPA = await runSigner(['prior-ack-message', '02' + '11'.repeat(32), '03' + '22'.repeat(32), '0', '0', '1', NFT]).then(() => true, () => false);
  return signerPA;
}
const PA = a => (signerPA ? real.priorAckMessage(a).then(r => r.message_hex) : paModel(a));

class StubTracker {
  constructor(now) { this.edges = new Map(); this.posts = []; this.now = now; this.fail = {}; }
  note(i, r) {
    const e = this.edges.get(`${i}>${r}`);
    return e ? {issuer_pubkey: i, recipient_pubkey: r, amount_collected: e.total, amount_redeemed: e.redeemed ?? 0, timestamp: e.timestamp, signature: e.signature, tracker_nft_id: NFT,
      denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}} : null;
  }
  all() { return [...this.edges.keys()].map(k => { const [i, r] = k.split('>'); return this.note(i, r); }); }
  async M(i, r, total, ts) { return (await real.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex; }
  async ok(pub, msg, sig) { return typeof sig === 'string' && /^0[23][0-9a-f]{128}$/.test(sig) && real.verify(pub, msg, sig).catch(() => false); }
  async postNote(b) {
    this.posts.push(b);
    const k = `${b.issuer_pubkey}>${b.recipient_pubkey}`, s = this.edges.get(k), bound = b.timestamp % 1000 === 997;
    if (!bound && b.timestamp % 1000 >= 995) return [400, {success: false, code: 'reserved_timestamp'}];
    if (b.timestamp <= (s?.timestamp ?? 0) || b.timestamp > this.now() || b.amount <= (s?.total ?? 0)) return [400, {success: false, code: 'not_an_increase'}];
    if (!(await this.ok(b.issuer_pubkey, await this.M(b.issuer_pubkey, b.recipient_pubkey, b.amount, b.timestamp), b.signature))) return [400, {success: false, code: 'invalid_signature'}];
    if (bound) {
      if ((b.prior_total != null && b.prior_total !== (s?.total ?? 0)) || (b.prior_timestamp != null && b.prior_timestamp !== (s?.timestamp ?? 0))) return [409, {success: false, code: 'stale_prior'}];
      const pa = await paModel({issuer: b.issuer_pubkey, recipient: b.recipient_pubkey, priorTotal: s?.total ?? 0, priorTimestamp: s?.timestamp ?? 0, timestamp: b.timestamp});
      if (!(await this.ok(b.issuer_pubkey, pa, b.prior_signature))) return [400, {success: false, code: 'invalid_prior_signature'}];
    } else if (b.prior_signature != null) return [400, {success: false, code: 'not_bound'}];
    this.edges.set(k, {total: b.amount, redeemed: s?.redeemed ?? 0, timestamp: b.timestamp, signature: b.signature});
    return [200, {success: true, data: null}];
  }
  // POST /notes/transfer (v4): all seven signatures verified, both edges move at T.
  async transfer(b) {
    this.posts.push({transfer: b});
    if (this.fail.transfer) { this.fail.transfer--; return [503, {success: false, code: 'unavailable'}]; }
    const A = b.issuer_pubkey, B = b.from_recipient_pubkey, C = b.to_recipient_pubkey, fk = `${A}>${B}`, tk = `${A}>${C}`, f = this.edges.get(fk), t = this.edges.get(tk);
    if (!f || f.total !== b.from_prior_total || (t?.total ?? 0) !== b.to_prior_total || f.timestamp !== b.from_prior_timestamp || (t?.timestamp ?? 0) !== b.to_prior_timestamp) return [409, {success: false, code: 'stale_prior'}];
    if (b.timestamp % 1000 !== 999 || b.timestamp <= f.timestamp || (t && b.timestamp <= t.timestamp) || b.timestamp > this.now()) return [400, {success: false, code: 'bad_timestamp'}];
    const X = f.total, Y = t?.total ?? 0, a = b.amount, T = b.timestamp;
    if (X < a) return [400, {success: false, code: 'insufficient'}];
    const checks = [[A, await this.M(A, B, X - a, T), b.issuer_from_signature], [A, await this.M(A, C, Y + a, T), b.issuer_to_signature],
      [B, await PA({issuer: A, recipient: B, priorTotal: X, priorTimestamp: f.timestamp, timestamp: T}), b.from_recipient_prior_signature],
      [B, await this.M(A, B, X - a, T), b.from_recipient_signature], [B, await this.M(A, C, Y + a, T), b.from_recipient_to_signature],
      [C, await PA({issuer: A, recipient: C, priorTotal: Y, priorTimestamp: t?.timestamp ?? 0, timestamp: T}), b.to_recipient_prior_signature],
      [C, await this.M(A, C, Y + a, T), b.to_recipient_signature]];
    for (const [k, m, s] of checks) if (!(await this.ok(k, m, s))) return [400, {success: false, code: 'invalid_signature'}];
    this.edges.set(fk, {total: X - a, redeemed: f.redeemed ?? 0, timestamp: T, signature: b.issuer_from_signature});
    this.edges.set(tk, {total: Y + a, redeemed: t?.redeemed ?? 0, timestamp: T, signature: b.issuer_to_signature});
    return [200, {success: true, data: null}];
  }
  // POST /notes/setoff (v3, per-edge timestamps): both signatures of every edge verified, every edge lowered.
  async setoff(b) {
    this.posts.push({setoff: b});
    if (this.fail.setoff) { this.fail.setoff--; return [503, {success: false, code: 'unavailable'}]; }
    const next = [];
    for (const e of b.edges) {
      const k = `${e.issuer_pubkey}>${e.recipient_pubkey}`, s = this.edges.get(k);
      if (!s || s.total < e.decrease || e.timestamp <= s.timestamp || e.timestamp > this.now()) return [400, {success: false, code: 'bad_edge'}];
      const m = await this.M(e.issuer_pubkey, e.recipient_pubkey, s.total - e.decrease, e.timestamp);
      if (!(await this.ok(e.issuer_pubkey, m, e.issuer_signature)) || !(await this.ok(e.recipient_pubkey, m, e.recipient_signature))) return [400, {success: false, code: 'invalid_signature'}];
      next.push([k, {total: s.total - e.decrease, redeemed: s.redeemed ?? 0, timestamp: e.timestamp, signature: e.issuer_signature}]);
    }
    for (const [k, v] of next) this.edges.set(k, v);
    return [200, {success: true, data: null}];
  }
}

const novation = ([status, json]) => ({status, success: json?.success === true, code: typeof json?.code === 'string' ? json.code : null, error: null, data: null});
async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-rev-held-')); dirs.push(dir);
  const clock = {t: Date.now() - 10 * 60e3}, tracker = new StubTracker(() => clock.t), pa = await hasPriorAck();
  const basis = {nft: NFT, denomination: PILOT_DENOMINATION, capabilities: async () => V32_CAPS, note: async (i, r) => tracker.note(i, r), allNotes: async () => tracker.all(),
    proof: async () => null, noteMessage: a => real.noteMessage(a), priorAckMessage: a => (pa ? real.priorAckMessage(a) : paModel(a).then(message_hex => ({message_hex}))),
    verify: (k, m, s) => real.verify(k, m, s), signHex: (k, m, s) => real.signHex(k, m, s),
    transfer: async body => novation(await tracker.transfer(body)), setoff: async body => novation(await tracker.setoff(body)),
    api: async (method, p, body) => { const [status, json] = await tracker.postNote(body); return {status, json: typeof json === 'object' ? json : null, text: JSON.stringify(json)}; }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: 'on', trackerCaps: V32_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, 'on');
  const person = async (handle, mandate = {}) => {
    const k = await real.keygen(), token = `vpa_${handle}_${hex(8)}`;
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: k.pubkey_hex, secret: k.secret_hex, status: 'active',
      created_at: iso(clock.t), owner_token_hash: sha256(`vpo_${token}`), agent_token_hash: sha256(token), token, enrollment: null,
      mandate: {...DEFAULT_MANDATE, max_issue_per_deal: 25, max_issue_outstanding: 50, max_accept_per_deal: 25, max_accept_per_issuer: 50, approve_above: 1000,
        auto_clear: false, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked', ...mandate},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: iso(clock.t), last_seen_owner: null,
      // Its client signs consents in every role (as valun 0.6+ declares on its reads).
      client_features: {consents: true, roles: ['setoff', 'issuer', 'creditor'], at: iso(clock.t)}};
    pilot.s.participants[p.id] = p;
    return p;
  };
  const A = await person('alice'), C = await person('charlie'), F = await person('fred'), D = await person('dave');
  return {pilot, tracker, clock, dir, A, C, F, D, book: pilot.guarantees, person};
}
const sign = (X, m) => real.signHex(X.pubkey, m, X.secret);
const signText = (X, s) => sign(X, Buffer.from(s, 'utf8').toString('hex'));
const refresh = (w, ...ps) => { for (const p of ps) { p.client_features.at = iso(w.clock.t); p.last_seen_agent = iso(w.clock.t); } };
async function issue(w, I, R, total, {ts = w.clock.t - 60e3} = {}) {
  const sig = await sign(I, await w.tracker.M(I.pubkey, R.pubkey, total, ts)), prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, redeemed: 0, timestamp: ts, signature: sig});
}
function gTerms(w, {cap, backer, issuer, creditor, dueIn = 0, window = 6 * HOUR, honorHours = 24, offerFor = HOUR}) {
  return {protocol: GUARANTEE_PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, guarantee_id: 'vg_' + hex(8), nonce: hex(16),
    backer: {id: backer.id, pubkey: backer.pubkey}, issuer: {id: issuer.id, pubkey: issuer.pubkey}, creditor: {id: creditor.id, pubkey: creditor.pubkey},
    cap: {amount: cap, unit: 'PC'}, covers: COVERS, due_at: iso(w.clock.t + dueIn), expires_at: iso(w.clock.t + dueIn + window), honor_within_hours: honorHours,
    offer_expires_at: iso(w.clock.t + offerFor), note: 'backs what the issuer owes the creditor'};
}
// A floating guarantee by `backer` of what `issuer` owes `creditor`, offered and accepted.
async function guarantee(w, {cap, backer = w.F, issuer = w.A, creditor = w.C}) {
  const t = gTerms(w, {cap, backer, issuer, creditor}), h = termsHash(t);
  const g = await w.book.offer(backer, {terms: t, terms_hash: h, signature: await signText(backer, guaranteeStatements.offer(h))});
  return w.book.accept(creditor, g.guarantee_id, {terms_hash: g.terms_hash, signature: await signText(creditor, guaranteeStatements.accept(g.terms_hash))});
}
async function call(w, g, amount, {C = w.C, id = 'vgc_' + hex(8)} = {}) {
  await w.book.call(C, g.guarantee_id, {call_id: id, amount, terms_hash: g.terms_hash, signature: await signText(C, guaranteeStatements.call(g.terms_hash, id, amount))});
  return id;
}
async function honor(w, g, callId, {B = w.F} = {}) {
  const tpl = await w.book.noteTemplate(B, g.guarantee_id, callId, {bound: true, wait: false});
  const note = {total: tpl.total, timestamp: tpl.timestamp, signature: await sign(B, tpl.message_hex)};
  const pa = await paModel({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, priorTotal: tpl.prior_total, priorTimestamp: tpl.prior_timestamp, timestamp: tpl.timestamp});
  Object.assign(note, {prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp, prior_signature: await sign(B, pa)});
  return w.book.honor(B, g.guarantee_id, callId, {terms_hash: g.terms_hash, amount: tpl.amount, signature: await signText(B, guaranteeStatements.honor(g.terms_hash, callId, tpl.amount)), credit_note: note});
}
function dealTerms(w, payer, payee, price) {
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + hex(8), version: 1, prior_terms_hash: null, nonce: hex(16),
    proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'a report', description: 'a short report', deliverable: 'one markdown file'}, price: {amount: price, unit: 'PC'},
    consideration: 'credit_note_on_delivery_accepted', deliver_by: iso(w.clock.t + 2 * HOUR), offer_expires_at: iso(w.clock.t + HOUR)};
}
// A deal payer -> payee taken to delivered (real proposal, acceptance and delivery).
async function delivered(w, payer, payee, price) {
  const {pilot} = w, t = dealTerms(w, payer, payee, price), h = termsHash(t);
  await pilot.propose(payer, {terms: t, terms_hash: h, signature: await signText(payer, statements.propose(h))});
  await pilot.accept(payee, t.deal_id, {terms_hash: h, signature: await signText(payee, statements.accept(h))});
  const content = `the report (${hex(4)})`, sh = sha256(content);
  await pilot.deliver(payee, t.deal_id, {terms_hash: h, content, sha256: sh, signature: await signText(payee, statements.deliver(h, sh))});
  return t.deal_id;
}
// The payer starts paying deal `id` by transfer with `issuer`'s note it holds: the template, its three slots, the post.
async function startTransfer(w, payer, id, issuer) {
  const {pilot} = w, d = pilot.s.deals[id];
  const tpl = await pilot.transferTemplate(payer, id, issuer.id, {wait: false});
  const AB = tpl.from_edge.edge, AC = tpl.to_edge.edge, signatures = {};
  for (const k of [`${AB}:prior`, `${AB}:new`, `${AC}:new`]) signatures[k] = await sign(payer, tpl.messages[k]);
  const r = await pilot.payByTransfer(payer, id, {issuer_id: issuer.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, quote_digest: tpl.quote_digest,
    timestamp: tpl.timestamp, from_prior_total: tpl.from_edge.before.total, to_prior_total: tpl.to_edge.before?.total ?? 0,
    from_prior_timestamp: tpl.from_edge.prior_timestamp, to_prior_timestamp: tpl.to_edge.prior_timestamp, signatures,
    completion_signature: await signText(payer, statements.complete(d.agreement.terms_hash, d.delivery.sha256)),
    pay_signature: await signText(payer, circulationStatements.pay(id, tpl.quote_digest))});
  return {tpl, transfer: r.transfer ?? null, deal: r};
}
// A party signs its slots of a collecting transfer, rebuilding each message itself (M for a new slot, PA for a prior).
async function consentTransfer(w, p, t) {
  const role = t.issuer.id === p.id ? 'issuer' : t.payee.id === p.id ? 'payee' : 'payer';
  const A = t.issuer.pubkey, AB = t.from_edge.edge, AC = t.to_edge.edge, T = t.timestamp, X = t.from_edge.before.total, Y = t.to_edge.before?.total ?? 0, a = t.amount;
  const sigs = {};
  if (role === 'issuer') {
    sigs[`${AB}:new`] = await sign(p, await w.tracker.M(A, t.payer.pubkey, X - a, T));
    sigs[`${AC}:new`] = await sign(p, await w.tracker.M(A, t.payee.pubkey, Y + a, T));
  } else if (role === 'payee') {
    sigs[`${AC}:prior`] = await sign(p, await PA({issuer: A, recipient: t.payee.pubkey, priorTotal: Y, priorTimestamp: t.to_edge.before?.timestamp ?? 0, timestamp: T}));
    sigs[`${AC}:new`] = await sign(p, await w.tracker.M(A, t.payee.pubkey, Y + a, T));
  }
  return w.pilot.submitConsent(p, t.id, {signatures: sigs});
}
const edgeTotal = (w, I, R) => w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
const spendable = (w, I, R) => w.pilot.spendableNote(R, I, w.tracker.note(I.pubkey, R.pubkey));

// The common start: alice owes charlie 10 (a recorded note); fred guarantees that debt (cap 10) and charlie accepted;
// charlie bought a job from dave for 10, delivered and not yet paid.
async function start() {
  await hasPriorAck();
  const w = await world(), {A, C, F, D} = w;
  await issue(w, A, C, 10);
  const g = await guarantee(w, {cap: 10});
  const dealG = await delivered(w, C, D, 10);
  w.clock.t += 5000;
  return {w, g, dealG};
}


const busyOrLapsed = async (w, g, cid, code) => assert.rejects(honor(w, g, cid), e => e.code === code);

test('#107 race 1: a transfer of the covered note collecting at the honor: the honor waits (pair_busy), the transfer applies, the call lapses', async () => {
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock} = w;
  const {transfer} = await startTransfer(w, C, dealG, A);
  const t = pilot.s.transfers[transfer.id];
  assert.equal(t.state, 'collecting');
  clock.t += 2000; refresh(w, A, C, F, D);
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await busyOrLapsed(w, g, cid, 'pair_busy');
  assert.equal(edgeTotal(w, F, C), 0, 'fred paid nothing');
  clock.t += 2000; refresh(w, A, C, F, D);
  await consentTransfer(w, A, t);
  await consentTransfer(w, D, t);
  assert.equal(t.state, 'applied');
  clock.t += 2000; refresh(w, A, C, F, D);
  await busyOrLapsed(w, g, cid, 'call_lapsed');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, A, D), edgeTotal(w, F, C)], [0, 10, 0], "charlie was paid once: with alice's note");
});

test('#107 race 1b: the call first, then a transfer (an open call holds nothing): the honor waits for the transfer', async () => {
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock} = w;
  const cid = await call(w, g, 10);
  clock.t += 2000; refresh(w, A, C, F, D);
  const {transfer} = await startTransfer(w, C, dealG, A);
  const t = pilot.s.transfers[transfer.id];
  clock.t += 2000;
  await busyOrLapsed(w, g, cid, 'pair_busy');
  clock.t += 2000; refresh(w, A, C, F, D);
  await consentTransfer(w, A, t);
  await consentTransfer(w, D, t);
  assert.equal(t.state, 'applied');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, A, D), edgeTotal(w, F, C)], [0, 10, 0]);
});

test("#107 race 1c: a transfer awaiting charlie's owner holds the honor the same way", async () => {
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock} = w;
  C.mandate.review_deliveries = true;
  const {transfer} = await startTransfer(w, C, dealG, A);
  assert.equal(transfer.state, 'awaiting_owner');
  clock.t += 2000; refresh(w, A, C, F, D);
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await busyOrLapsed(w, g, cid, 'pair_busy');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, F, C)], [10, 0]);
});

test('#107 race 2: a transfer left applying (tracker 503) holds the honor; recovery applies it and the call lapses', async () => {
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock, tracker} = w;
  const {transfer} = await startTransfer(w, C, dealG, A);
  const t = pilot.s.transfers[transfer.id];
  clock.t += 2000; refresh(w, A, C, F, D);
  await consentTransfer(w, A, t);
  tracker.fail.transfer = 1;
  await consentTransfer(w, D, t);
  assert.equal(t.state, 'applying');
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await busyOrLapsed(w, g, cid, 'pair_busy');
  await pilot.recoverTransfer(t);
  assert.equal(t.state, 'applied');
  clock.t += 2000; refresh(w, A, C, F, D);
  await busyOrLapsed(w, g, cid, 'call_lapsed');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, A, D), edgeTotal(w, F, C)], [0, 10, 0]);
});

test('#107 race 2b: a transfer that reaches the tracker after an honor is checked again and ends failed (held_for_backers)', async () => {
  // The second guard (Pilot.submitTransfer): reached only if an honor were recorded while the transfer was live, which
  // assertDebtFree prevents; forced here by recording the honor past it.
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock, tracker} = w;
  const {transfer} = await startTransfer(w, C, dealG, A);
  const t = pilot.s.transfers[transfer.id];
  clock.t += 2000; refresh(w, A, C, F, D);
  await consentTransfer(w, A, t);
  tracker.fail.transfer = 1;
  await consentTransfer(w, D, t);
  assert.equal(t.state, 'applying');
  const cid = await call(w, g, 10);
  clock.t += 2000;
  const guard = pilot.guarantees.assertDebtFree;
  pilot.guarantees.assertDebtFree = async () => {};
  try { await honor(w, g, cid); } finally { pilot.guarantees.assertDebtFree = guard; }
  assert.equal(pilot.heldForBackers(A.id, C.id), 10);
  await pilot.recoverTransfer(t);
  assert.equal(t.state, 'failed');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, A, D), edgeTotal(w, F, C)], [10, 0, 10], "charlie keeps fred's 10 and alice's 10 stays held");
});
// Set-offs: alice owes charlie 10 and charlie owes alice 10 (a 2-cycle), both members sign set-offs as clients.
async function cycle() {
  await hasPriorAck();
  const w = await world(), {pilot, A, C} = w;
  for (const p of [A, C]) p.mandate.auto_clear = true;
  await issue(w, A, C, 10, {ts: w.clock.t - 120e3});
  await issue(w, C, A, 10, {ts: w.clock.t - 100e3});
  const g = await guarantee(w, {cap: 10});
  w.clock.t += 5000;
  const o = await pilot.createSetoff({edges: [{edge: `${A.pubkey}>${C.pubkey}`, decrease: 10}, {edge: `${C.pubkey}>${A.pubkey}`, decrease: 10}], cycles: []}, {source: 'admin'});
  assert.ok(o && !o.skipped, `set-off created: ${JSON.stringify(o?.skipped)}`);
  return {w, g, o};
}
async function signSetoff(w, p, o) {
  const sigs = {};
  for (const e of o.edges) if (e.issuer.id === p.id || e.recipient.id === p.id) sigs[`${e.edge}:new`] = await sign(p, await w.tracker.M(e.issuer.pubkey, e.recipient.pubkey, e.new_total, e.timestamp));
  return w.pilot.setoffConsent(p, o.id, {signatures: sigs});
}


test('#107: a set-off of the covered edge collecting at the honor is superseded at apply (refreshSetoff checks the hold)', async () => {
  const {w, g, o} = await cycle(), {pilot, A, C, clock} = w;
  await signSetoff(w, A, o);
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await honor(w, g, cid);
  refresh(w, A, C);
  await signSetoff(w, C, o);
  assert.equal(o.state, 'superseded');
  assert.equal(edgeTotal(w, A, C), 10);
});

test('#107 race 3: a set-off left applying (tracker 503) holds the honor; recovery applies it and the call lapses', async () => {
  const {w, g, o} = await cycle(), {pilot, A, C, F, clock, tracker} = w;
  await signSetoff(w, A, o);
  tracker.fail.setoff = 1;
  refresh(w, A, C);
  await signSetoff(w, C, o);
  assert.equal(o.state, 'applying');
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await busyOrLapsed(w, g, cid, 'pair_busy');
  await pilot.recoverSetoff(o);
  assert.equal(o.state, 'applied');
  clock.t += 2000; refresh(w, A, C, F);
  await busyOrLapsed(w, g, cid, 'call_lapsed');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, C, A), edgeTotal(w, F, C)], [0, 0, 0]);
});

test('#107 race 3b: a set-off recovered after an honor is checked again and ends failed', async () => {
  const {w, g, o} = await cycle(), {pilot, A, C, F, clock, tracker} = w;
  await signSetoff(w, A, o);
  tracker.fail.setoff = 1;
  refresh(w, A, C);
  await signSetoff(w, C, o);
  assert.equal(o.state, 'applying');
  const cid = await call(w, g, 10);
  clock.t += 2000;
  const guard = pilot.guarantees.assertDebtFree;
  pilot.guarantees.assertDebtFree = async () => {};
  try { await honor(w, g, cid); } finally { pilot.guarantees.assertDebtFree = guard; }
  await pilot.recoverSetoff(o);
  assert.equal(o.state, 'failed');
  assert.deepEqual([edgeTotal(w, A, C), edgeTotal(w, C, A), edgeTotal(w, F, C)], [10, 10, 10]);
});
// Key rotation: the covered 10 stays on alice's past key (frozen: never spent, set off or redeemed through the server),
// and a new debt of 6 on her new key, which no backer paid, is held as well.
async function rotate(w, p) {
  const k = await real.keygen();
  p.past_pubkeys = [...(p.past_pubkeys || []), {pubkey: p.pubkey, registered_at: null, revoked_at: iso(w.clock.t)}];
  p.pubkey = k.pubkey_hex; p.secret = k.secret_hex;
}

test("#107 follow-up, key rotation: a new debt on the issuer's new key is not held for a payment on its past key", {todo: 'split the pair hold across its edges, past-key edges first'}, async () => {
  await hasPriorAck();
  const w = await world(), {pilot, A, C, F, clock} = w;
  await issue(w, A, C, 10, {ts: clock.t - 120e3});
  const g = await guarantee(w, {cap: 10});
  clock.t += 5000;
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await honor(w, g, cid);
  await rotate(w, A);
  clock.t += 5000; refresh(w, A, C, F);
  await issue(w, A, C, 6, {ts: clock.t - 1000});
  assert.equal(spendable(w, A, C), 6);
});

test('#107: a held note is named held_for_backers in the payment options and in the template refusal', async () => {
  const {w, g, dealG} = await start(), {pilot, A, C, F, D, clock} = w;
  const cid = await call(w, g, 10);
  clock.t += 2000;
  await honor(w, g, cid);
  refresh(w, A, C, F, D);
  const opts = await pilot.paymentOptions(C, dealG), h = opts.held_notes.find(x => x.issuer.id === A.id);
  assert.deepEqual([h.spendable, h.why_not, h.held_for_backers], [0, 'held_for_backers', 10]);
  await assert.rejects(pilot.transferTemplate(C, dealG, A.id, {wait: false}), e => e.code === 'insufficient_claim' && /held: backers already paid you that much/.test(e.message));
});
