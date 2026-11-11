// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) (design v3.2 sections 2, 4 and 7), in the default `npm test` (no
// tracker v3.2 needed): the shared fixed vector, and a Pilot in circulation mode on over a STUB tracker that checks
// transfers and bound notes as tracker v3.2 does. The stub verifies, with the real valun_signer (VALUN_BINS, or the
// default 3df7ed93 release: its sign and verify take any message), a transfer's two creditor prior slots and a bound
// note's prior_signature over PA of the edge's stored state (0 and 0 for an edge with no note), every other slot over
// the 80-byte note message M, the optional prior totals and timestamps (409 stale_prior when they differ), and T after
// both edges' timestamps. PA is built here from the debt key the signer reports (17-byte tag || debt key || X || p ||
// T || NFT); with a signer that has prior-ack-message (tracker v3.2's) the Pilot's messages come from it and are
// checked against this model and the vector.
// What it shows: the server's prior slots are PA of the state its templates show, and its tracker requests carry the
// prior timestamps; the same-prior exemption (decision D-1) lets a retry through the same note on the same prior state
// start at once, and then at most one of the two attempts applies, even when both edges come back to the earlier
// totals in between (audit VS-1's ABA); a bound note is checked the same way, and a v3.1-style acknowledgment
// M(I,R,X,T) is refused.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, NETWORK, statements, circulationStatements} from '../lib/pilot/core.mjs';
import {appendEntries} from '../lib/pilot/journal.mjs';
import {quoteDigest, TRANSFER_SLOTS, fallbackAfter} from '../lib/pilot/novation.mjs';
import {runner, signerPath} from './tracker-harness.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const DAY = 864e5, PIN = 'ef'.repeat(32), NFT = 'ab'.repeat(32), TAG = Buffer.from('basis/prior-ack/1', 'ascii');
const V32_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'],
    prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
// The seven signatures in the tracker's order.
const ORDER = V32_CAPS.novation.transfer.signatures;
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;      // a timestamp ending in `ms` a little before t

const runSigner = makeSignerRunner({mode: runner, signerPath});
const real = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: NFT, runSigner, denomination: PILOT_DENOMINATION});
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const debtKeys = new Map();
// PA(I,R,X,p,T) as design v3.2 section 2 defines it, from the debt key the signer reports for the edge.
async function paModel({issuer, recipient, priorTotal, priorTimestamp, timestamp, denomination = PILOT_DENOMINATION, nft = NFT}) {
  const k = `${issuer}>${recipient}>${denomination}>${nft}`;
  if (!debtKeys.has(k)) debtKeys.set(k, (await runSigner(['note-message', issuer, recipient, '0', '0', nft, denomination])).debt_key_hex);
  return Buffer.concat([TAG, Buffer.from(debtKeys.get(k), 'hex'), u64(priorTotal), u64(priorTimestamp), u64(timestamp), Buffer.from(nft, 'hex')]).toString('hex');
}
// Whether this signer builds PA itself (tracker v3.2's valun_signer; the 3df7ed93 one answers its usage error for the
// unknown subcommand). Any other failure is an error, not a "no".
const VA = '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f', VB = '024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766';
let signerPA;
async function hasPriorAck() {
  if (signerPA === undefined) {
    signerPA = await runSigner(['prior-ack-message', VA, VB, '0', '0', '1', NFT]).then(() => true, e => { if (/usage/.test(String(e?.message))) return false; throw e; });
  }
  return signerPA;
}

test('PA: the shared fixed vector of design v3.2 section 7 (105 bytes, starting with "basis/prior-ack/1"); Basis.priorAckMessage gives the same bytes when the signer has prior-ack-message', async t => {
  const A = (await runSigner(['pubkey'], '01'.repeat(32))).pubkey_hex, B = (await runSigner(['pubkey'], '02'.repeat(32))).pubkey_hex;
  assert.deepEqual([A, B], [VA, VB]);
  const args = {issuer: A, recipient: B, priorTotal: 1000, priorTimestamp: 1762650000123, timestamp: 1762650060999, denomination: 'erg'};
  const M = await runSigner(['note-message', A, B, '1000', '1762650060999', NFT, 'erg']);
  assert.equal(M.debt_key_hex, '8655e13a7d5c621d55abe7b76cd86399fee984d67ecc48a72f2f8aea80fd94e1');
  assert.equal(M.message_hex, '8655e13a7d5c621d55abe7b76cd86399fee984d67ecc48a72f2f8aea80fd94e100000000000003e80000019a662178c7abababababababababababababababababababababababababababababababab',
    'the v3.1 acknowledgment M(A,B,X,T), 80 bytes');
  const VECTOR = '62617369732f7072696f722d61636b2f318655e13a7d5c621d55abe7b76cd86399fee984d67ecc48a72f2f8aea80fd94e100000000000003e80000019a66208afb0000019a662178c7abababababababababababababababababababababababababababababababab';
  assert.equal(await paModel(args), VECTOR);
  assert.equal(VECTOR.length, 210);
  if (!(await hasPriorAck())) { t.diagnostic('this valun_signer has no prior-ack-message (a 3df7ed93 build): the model alone is checked'); return; }
  const b = new Basis({trackerUrl: 'http://127.0.0.1:9', trackerNftId: NFT, runSigner, denomination: 'erg'});
  assert.deepEqual(await b.priorAckMessage(args), {message_hex: VECTOR, debt_key_hex: M.debt_key_hex});
  // The PA of a token denomination, the same way.
  const tok = {...args, denomination: PILOT_DENOMINATION};
  assert.equal((await real.priorAckMessage(tok)).message_hex, await paModel(tok));
});

// ---------------------------------------------------------------------------------------------------------------
// The stub tracker v3.2 (in memory): edges '<issuer>><recipient>' -> {total, timestamp, signature}.
class StubTracker {
  constructor() { this.edges = new Map(); this.posts = []; this.now = () => Date.now(); }
  note(i, r) {
    const e = this.edges.get(`${i}>${r}`);
    return e ? {issuer_pubkey: i, recipient_pubkey: r, amount_collected: e.total, amount_redeemed: 0, timestamp: e.timestamp, signature: e.signature, tracker_nft_id: NFT,
      denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}} : null;
  }
  all() { return [...this.edges.keys()].map(k => { const [i, r] = k.split('>'); return this.note(i, r); }); }
  async M(i, r, total, ts) { return (await real.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex; }
  async ok(pub, msg, sig) { return typeof sig === 'string' && /^0[23][0-9a-f]{128}$/.test(sig) && real.verify(pub, msg, sig).catch(() => false); }
  // POST /notes: an ordinary note, or (timestamp ending in 997 ms) a bound note with its prior acknowledgment.
  async postNote(b) {
    this.posts.push({path: '/notes', body: b});
    const allowed = ['issuer_pubkey', 'recipient_pubkey', 'amount', 'timestamp', 'signature', 'tracker_nft_id', 'denomination', 'prior_signature', 'prior_total', 'prior_timestamp'];
    if (Object.keys(b).some(k => !allowed.includes(k))) return [422, 'unknown field'];
    const k = `${b.issuer_pubkey}>${b.recipient_pubkey}`, s = this.edges.get(k), bound = b.timestamp % 1000 === 997;
    if (!bound && b.timestamp % 1000 >= 995) return [400, {success: false, code: 'reserved_timestamp'}];
    if (b.timestamp <= (s?.timestamp ?? 0) || b.timestamp > this.now() || b.amount <= (s?.total ?? 0)) return [400, {success: false, code: 'not_an_increase'}];
    if (!(await this.ok(b.issuer_pubkey, await this.M(b.issuer_pubkey, b.recipient_pubkey, b.amount, b.timestamp), b.signature))) return [400, {success: false, code: 'invalid_signature'}];
    if (bound) {
      if (b.timestamp < this.now() - 3600e3) return [400, {success: false, code: 'novation_expired'}];
      if ((b.prior_total != null && b.prior_total !== (s?.total ?? 0)) || (b.prior_timestamp != null && b.prior_timestamp !== (s?.timestamp ?? 0))) return [409, {success: false, code: 'stale_prior'}];
      const pa = await paModel({issuer: b.issuer_pubkey, recipient: b.recipient_pubkey, priorTotal: s?.total ?? 0, priorTimestamp: s?.timestamp ?? 0, timestamp: b.timestamp});
      if (!(await this.ok(b.issuer_pubkey, pa, b.prior_signature))) return [400, {success: false, code: 'invalid_prior_signature'}];
    } else if (b.prior_signature != null || b.prior_total != null || b.prior_timestamp != null) return [400, {success: false, code: 'not_bound'}];
    this.edges.set(k, {total: b.amount, timestamp: b.timestamp, signature: b.signature});
    return [200, {success: true, data: null}];
  }
  // POST /notes/transfer, version 4.
  async transfer(b) {
    this.posts.push({path: '/notes/transfer', body: b});
    const allowed = ['issuer_pubkey', 'from_recipient_pubkey', 'to_recipient_pubkey', 'denomination', 'amount', 'timestamp', ...ORDER.map(n => `${n}_signature`),
      'from_prior_total', 'to_prior_total', 'from_prior_timestamp', 'to_prior_timestamp'];
    const no = (status, code) => ({status, success: false, code, error: code, data: null});
    if (Object.keys(b).some(k => !allowed.includes(k))) return no(422, 'unknown_field');
    const A = b.issuer_pubkey, B = b.from_recipient_pubkey, C = b.to_recipient_pubkey, a = b.amount, T = b.timestamp;
    if (T % 1000 !== 999 || T > this.now() || T < this.now() - 3600e3) return no(400, 'bad_timestamp');
    const f = this.edges.get(`${A}>${B}`), c = this.edges.get(`${A}>${C}`) ?? null;
    if (!f || f.total < a) return no(400, 'insufficient');
    const X = f.total, Y = c?.total ?? 0, pX = f.timestamp, pY = c?.timestamp ?? 0;
    if ((b.from_prior_total != null && b.from_prior_total !== X) || (b.to_prior_total != null && b.to_prior_total !== Y)
      || (b.from_prior_timestamp != null && b.from_prior_timestamp !== pX) || (b.to_prior_timestamp != null && b.to_prior_timestamp !== pY)) return no(409, 'stale_prior');
    if (T <= pX || T <= pY) return no(409, 'edge_changed');
    const want = {issuer_from: [A, await this.M(A, B, X - a, T)], issuer_to: [A, await this.M(A, C, Y + a, T)],
      from_recipient_prior: [B, await paModel({issuer: A, recipient: B, priorTotal: X, priorTimestamp: pX, timestamp: T})], from_recipient: [B, await this.M(A, B, X - a, T)],
      from_recipient_to: [B, await this.M(A, C, Y + a, T)], to_recipient_prior: [C, await paModel({issuer: A, recipient: C, priorTotal: Y, priorTimestamp: pY, timestamp: T})],
      to_recipient: [C, await this.M(A, C, Y + a, T)]};
    for (const n of ORDER) if (!(await this.ok(want[n][0], want[n][1], b[`${n}_signature`]))) return no(400, n.endsWith('_prior') ? 'invalid_prior_signature' : 'invalid_signature');
    this.edges.set(`${A}>${B}`, {total: X - a, timestamp: T, signature: b.issuer_from_signature});
    this.edges.set(`${A}>${C}`, {total: Y + a, timestamp: T, signature: b.issuer_to_signature});
    return {status: 200, success: true, code: null, error: null, data: null};
  }
}

// A Pilot in mode on over the stub tracker, with real keys. A (the issuer) and P (the payer) are clients (A declares
// the issuer role); Q (the payee) is server-run (its slots are signed through pilot.serverSigner, which keeps what it
// signs). `clock.t` is the Pilot's (and the stub tracker's) clock.
async function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-prior-ack-')); dirs.push(dir);
  const clock = {t: Date.now()}, tracker = new StubTracker();
  tracker.now = () => clock.t;
  const pa = await hasPriorAck();
  const basis = {nft: NFT, denomination: PILOT_DENOMINATION, capabilities: async () => V32_CAPS, note: async (i, r) => tracker.note(i, r), allNotes: async () => tracker.all(),
    proof: async () => null, noteMessage: a => real.noteMessage(a), priorAckMessage: a => (pa ? real.priorAckMessage(a) : paModel(a).then(message_hex => ({message_hex}))),
    verify: (k, m, s) => real.verify(k, m, s), signHex: (k, m, s) => real.signHex(k, m, s), transfer: b => tracker.transfer(b),
    api: async (method, p, body) => { const [status, json] = await tracker.postNote(body); return {status, json: typeof json === 'object' ? json : null, text: typeof json === 'string' ? json : JSON.stringify(json)}; }};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: 'on', trackerCaps: V32_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, 'on');
  const person = async handle => {
    const k = await real.keygen();
    return {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: k.pubkey_hex, secret: k.secret_hex, status: 'active',
      created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
      mandate: {...DEFAULT_MANDATE, max_issue_outstanding: 500, max_accept_per_issuer: 500, auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any',
        refuse_notes_from: [], pay_with_held_notes: 'when_asked'},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: iso(clock.t), last_seen_owner: null, client_features: {consents: true, roles: ['issuer', 'creditor'], at: iso(clock.t)}};
  };
  const [A, P, Q] = [await person('pa-issuer'), await person('pa-payer'), await person('pa-payee')];
  for (const x of [A, P, Q]) pilot.s.participants[x.id] = x;
  const signed = new Map();                                    // what the server signer made for Q: message hex -> signature
  pilot.serverSigner = {has: id => id === Q.id, signFor: async (id, m) => { const s = await real.signHex(Q.pubkey, m, Q.secret); signed.set(m, s); return s; }};
  return {pilot, tracker, clock, dir, A, P, Q, signed};
}
// An ordinary note I>R raised to `total` at `ts`, signed by I, at the stub tracker and in Valun's journal.
async function issue(w, I, R, total, ts) {
  const sig = await real.signHex(I.pubkey, await w.tracker.M(I.pubkey, R.pubkey, total, ts), I.secret);
  const prev = w.tracker.edges.get(`${I.pubkey}>${R.pubkey}`)?.total ?? 0;
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total - prev, total_after: total, timestamp: ts, signature: sig}]);
  w.tracker.edges.set(`${I.pubkey}>${R.pubkey}`, {total, timestamp: ts, signature: sig});
}
// A delivered deal: P pays Q `price`.
function deal(w, price = 3) {
  const {pilot, P, Q, clock} = w, id = 'vd_' + hex(8);
  const terms = {network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey},
    service: {title: 'prior-ack job', description: 'synthetic', deliverable: 'text'}, price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
  const v = {v: 1, by: P.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
  const d = {id, payer: P.id, payee: Q.id, created_at: iso(clock.t), status: 'delivered', versions: [v], history: [], agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)},
    delivery: {by: Q.id, sha256: hex(32), content: 'x', at: iso(clock.t)}};
  pilot.s.deals[id] = d;
  return d;
}
const sign = (X, m) => real.signHex(X.pubkey, m, X.secret);
const signText = (X, s) => sign(X, Buffer.from(s, 'utf8').toString('hex'));
// The payer's client, as a v3.2 client builds a payment by transfer from a template: its prior slot PA(A,P,X,p,T) of
// the state the template shows, its two new slots M, and both prior states asserted.
async function payBody(w, d, tpl) {
  const {P} = w, A = tpl.issuer.pubkey, B = P.pubkey, C = tpl.payee.pubkey, T = tpl.timestamp, a = tpl.amount, X = tpl.from_edge.before.total, pX = tpl.from_edge.before.timestamp;
  const Y = tpl.to_edge.before?.total ?? 0, pY = tpl.to_edge.before?.timestamp ?? 0;
  const q = quoteDigest({network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: d.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256,
    issuer_pubkey: A, payer_pubkey: B, payee_pubkey: C, amount: a});
  const priorHex = await paModel({issuer: A, recipient: B, priorTotal: X, priorTimestamp: pX, timestamp: T});
  assert.equal(tpl.messages[`${A}>${B}:prior`], priorHex, "the template's prior slot is PA of the state it shows");
  assert.equal(tpl.messages[`${A}>${C}:prior`], await paModel({issuer: A, recipient: C, priorTotal: Y, priorTimestamp: pY, timestamp: T}));
  return {issuer_id: tpl.issuer.id, terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, quote_digest: q, timestamp: T,
    from_prior_total: X, to_prior_total: Y, from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await signText(P, statements.complete(d.agreement.terms_hash, d.delivery.sha256)), pay_signature: await signText(P, circulationStatements.pay(d.id, q)),
    signatures: {[`${A}>${B}:prior`]: await sign(P, priorHex), [`${A}>${B}:new`]: await sign(P, await w.tracker.M(A, B, X - a, T)), [`${A}>${C}:new`]: await sign(P, await w.tracker.M(A, C, Y + a, T))}};
}
// The issuer's consent signatures for transfer t (both new slots), as its client makes them from its consent item.
async function issuerSigs(w, t) {
  const item = w.pilot.consentsFor(w.A).consents.find(x => x.id === t.id), out = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    assert.equal(e.prior_timestamp, e.before ? e.before.timestamp : 0, 'the item names its prior state\'s timestamp');
    out[`${e.edge}:new`] = await sign(w.A, await w.tracker.M(I, R, e.new_total, e.timestamp));
  }
  return out;
}
// The tracker request of transfer t as its parties signed it (the stub server signer's signatures for Q, the test's
// for A and P), with or without the prior timestamps.
function trackerBody(w, t, body, aSigs, {timestamps = true} = {}) {
  const AB = t.from_edge.edge, AC = t.to_edge.edge, q = m => w.signed.get(m);
  const b = {issuer_pubkey: t.issuer.pubkey, from_recipient_pubkey: t.payer.pubkey, to_recipient_pubkey: t.payee.pubkey, denomination: PILOT_DENOMINATION, amount: t.amount, timestamp: t.timestamp,
    issuer_from_signature: aSigs[`${AB}:new`], issuer_to_signature: aSigs[`${AC}:new`], from_recipient_prior_signature: body.signatures[`${AB}:prior`],
    from_recipient_signature: body.signatures[`${AB}:new`], from_recipient_to_signature: body.signatures[`${AC}:new`],
    to_recipient_prior_signature: q(t.messages[`${AC}:prior`]), to_recipient_signature: q(t.messages[`${AC}:new`]),
    from_prior_total: t.from_edge.before.total, to_prior_total: t.to_edge.before?.total ?? 0};
  if (timestamps) Object.assign(b, {from_prior_timestamp: t.from_edge.before.timestamp, to_prior_timestamp: t.to_edge.before?.timestamp ?? 0});
  assert.ok(Object.values(b).every(v => v !== undefined), 'every signature of the attempt');
  return b;
}

test('stub tracker v3.2: a payment by transfer whose prior slots are PA of the shown state applies; the request carries both prior timestamps; a v3.1-style prior slot M(A,P,X,T) is refused by the server (403), nothing recorded', async () => {
  const w = await world(), {pilot, tracker, clock, A, P, Q} = w;
  await issue(w, A, P, 6, clock.t - 60e3);
  const d = deal(w, 3), tpl = await pilot.transferTemplate(P, d.id, A.id, {wait: false}), body = await payBody(w, d, tpl);
  assert.deepEqual([tpl.from_edge.prior_timestamp, tpl.to_edge.prior_timestamp], [clock.t - 60e3, 0]);
  // The v3.1 acknowledgment of the prior total at T (80 bytes) is not the prior slot any more.
  const v31 = {...body, signatures: {...body.signatures, [`${A.pubkey}>${P.pubkey}:prior`]: await sign(P, await tracker.M(A.pubkey, P.pubkey, 6, tpl.timestamp))}};
  await assert.rejects(pilot.payByTransfer(P, d.id, v31), e => e instanceof PilotError && e.code === 'bad_signature' && /prior acknowledgment \(basis\/prior-ack\/1/.test(e.message));
  assert.equal(pilot.transfersOf(d).length, 0, 'nothing recorded');
  const r = await pilot.payByTransfer(P, d.id, body), t = pilot.transfer(r.transfer.id);
  assert.equal(t.state, 'collecting', 'waits for the issuer (a client)');
  // Q's prior slot, signed by the server signer: PA(A,Q,0,0,T) (a new to-edge).
  assert.ok(w.signed.has(await paModel({issuer: A.pubkey, recipient: Q.pubkey, priorTotal: 0, priorTimestamp: 0, timestamp: t.timestamp})), "the server signer signed Q's PA");
  const c = await pilot.submitConsent(A, t.id, {signatures: await issuerSigs(w, t), revisions: {}});
  assert.equal(c.state, 'applied', JSON.stringify(c.result));
  const sent = tracker.posts.filter(x => x.path === '/notes/transfer').map(x => x.body);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].from_prior_total, sent[0].from_prior_timestamp, sent[0].to_prior_total, sent[0].to_prior_timestamp], [6, clock.t - 60e3, 0, 0]);
  assert.deepEqual([tracker.edges.get(`${A.pubkey}>${P.pubkey}`).total, tracker.edges.get(`${A.pubkey}>${Q.pubkey}`).total, d.status], [3, 3, 'paid_by_transfer']);
  assert.equal(TRANSFER_SLOTS.length, 7);
});

test('stub tracker v3.2 (audit VS-1, the same-prior exemption): after a cancelled attempt, a retry through the same note on the same prior state starts at once; at the tracker at most one of the two applies, also after both edges come back to the earlier totals in between (ABA); on another prior state a retry waits for the window', async () => {
  const w = await world(), {pilot, tracker, clock, A, P, Q} = w, AP = `${A.pubkey}>${P.pubkey}`, AQ = `${A.pubkey}>${Q.pubkey}`;
  const t0 = ending(clock.t - 60e3, 500);
  await issue(w, A, P, 6, t0);
  const d = deal(w, 3);
  // Attempt 1 (T1): posted, collecting; the issuer's consent signatures are made (and kept here, never sent); cancelled.
  const tpl1 = await pilot.transferTemplate(P, d.id, A.id, {wait: false}), body1 = await payBody(w, d, tpl1);
  const t1 = pilot.transfer((await pilot.payByTransfer(P, d.id, body1)).transfer.id), a1 = await issuerSigs(w, t1);
  await pilot.cancelTransfer(P, d.id);
  assert.deepEqual([t1.state, d.status], ['cancelled', 'payment_due']);
  // Attempt 2 (T2 > T1) at once, on the same prior state (6 PC at t0): not held back by attempt 1's window (it would
  // be without the exemption: 409 transfer_window_open). An own note still waits.
  clock.t += 1000;
  assert.equal((await pilot.paymentBlock(d, {route: 'note'}))?.code, 'transfer_window_open', 'an own note waits');
  const tpl2 = await pilot.transferTemplate(P, d.id, A.id, {wait: false});
  assert.ok(tpl2.timestamp > t1.timestamp);
  assert.deepEqual(tpl2.from_edge.before, tpl1.from_edge.before);
  const body2 = await payBody(w, d, tpl2), t2 = pilot.transfer((await pilot.payByTransfer(P, d.id, body2)).transfer.id);
  assert.equal(t2.state, 'collecting');
  // Attempt 1 reaches the tracker around Valun (all seven signatures exist): it applies (its PA matches (6, t0)).
  const r1 = await tracker.transfer(trackerBody(w, t1, body1, a1));
  assert.equal(r1.success, true, JSON.stringify(r1));
  assert.deepEqual(tracker.edges.get(AP).timestamp, t1.timestamp);
  // ABA: both edges come back to the totals attempt 2 found (A->P 6, A->Q 0), at timestamps between T1 and T2.
  const back = t1.timestamp + 1, sigAP = await sign(A, await tracker.M(A.pubkey, P.pubkey, 6, back)), sigAQ = await sign(A, await tracker.M(A.pubkey, Q.pubkey, 0, back + 1));
  tracker.edges.set(AP, {total: 6, timestamp: back, signature: sigAP}); tracker.edges.set(AQ, {total: 0, timestamp: back + 1, signature: sigAQ});
  assert.ok(back + 1 < t2.timestamp);
  // Attempt 2 can never apply: the tracker refuses it with or without the prior timestamps (stale_prior; or, without
  // them, its PA of (6, t0) and (0, 0) does not verify for (6, back) and (0, back + 1)) ...
  const a2 = await issuerSigs(w, t2);
  assert.deepEqual(pick(await tracker.transfer(trackerBody(w, t2, body2, a2))), [409, 'stale_prior']);
  assert.deepEqual(pick(await tracker.transfer(trackerBody(w, t2, body2, a2, {timestamps: false}))), [400, 'invalid_prior_signature']);
  // ... and the server does not submit it: the edges are not as it found them (failed, edge_changed).
  const c = await pilot.submitConsent(A, t2.id, {signatures: a2, revisions: {}});
  assert.deepEqual([c.state, c.result.code], ['failed', 'edge_changed']);
  assert.equal(tracker.posts.filter(x => x.path === '/notes/transfer').length, 3, 'only the two direct posts and attempt 1 reached the tracker (the server posted nothing)');
  assert.deepEqual([tracker.edges.get(AP).total, tracker.edges.get(AQ).total], [6, 0], 'nothing else moved: one of the two attempts applied');
  // A retry on the edge's new state (6 PC at another timestamp) waits for both attempts' windows.
  await assert.rejects(pilot.transferTemplate(P, d.id, A.id, {wait: false}),
    e => e instanceof PilotError && e.code === 'transfer_window_open' && e.extra.retry_after_ms === fallbackAfter(t2.timestamp) - clock.t + 1);
});
const pick = r => [r.status, r.code];

test('stub tracker v3.2: a bound note\'s prior_signature is PA of the pair\'s note (0 and 0 for none); the posted prior_timestamp must be that note\'s (409 stale_note), a v3.1-style M(I,R,P,ts) acknowledgment is refused (403), and the tracker request carries prior_total and prior_timestamp', async () => {
  const w = await world(), {pilot, tracker, clock, P, Q} = w;
  const bound = async (d, tpl, {ackTs = tpl.prior_note ? tpl.prior_note.timestamp : 0, priorTs = ackTs, v31 = false} = {}) => {
    const ack = v31 ? await tracker.M(P.pubkey, Q.pubkey, tpl.prior_total, tpl.timestamp)
      : await paModel({issuer: P.pubkey, recipient: Q.pubkey, priorTotal: tpl.prior_total, priorTimestamp: ackTs, timestamp: tpl.timestamp});
    return {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await signText(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
      note: {total: tpl.total, timestamp: tpl.timestamp, signature: await sign(P, tpl.message_hex), prior_total: tpl.prior_total, prior_timestamp: priorTs, prior_signature: await sign(P, ack)}};
  };
  // A new pair: PA(P,Q,0,0,ts).
  const d1 = deal(w, 2), tpl1 = await pilot.noteTemplate(P, d1.id, {bound: true, wait: false});
  assert.deepEqual([tpl1.prior_note, tpl1.prior_timestamp, tpl1.prior_message_hex], [null, 0, await paModel({issuer: P.pubkey, recipient: Q.pubkey, priorTotal: 0, priorTimestamp: 0, timestamp: tpl1.timestamp})]);
  const b1 = await bound(d1, tpl1);
  assert.equal((await pilot.complete(P, d1.id, {...b1, credit_note: b1.note})).status, 'note_issued');
  assert.deepEqual([tracker.posts.at(-1).body.prior_total, tracker.posts.at(-1).body.prior_timestamp], [0, 0]);
  // On the pair's note (2 PC at tpl1's timestamp).
  clock.t += 2000;
  const d2 = deal(w, 3), tpl2 = await pilot.noteTemplate(P, d2.id, {bound: true, wait: false});
  assert.deepEqual([tpl2.prior_total, tpl2.prior_timestamp], [2, tpl1.timestamp]);
  for (const [why, opts, code] of [['v3.1-style acknowledgment', {v31: true}, 'bad_signature'], ['another prior timestamp acknowledged', {ackTs: tpl1.timestamp - 1, priorTs: null}, 'bad_signature'],
    ['another prior timestamp asserted', {ackTs: tpl1.timestamp - 1}, 'stale_note']]) {
    const b = await bound(d2, tpl2, opts);
    await assert.rejects(pilot.complete(P, d2.id, {...b, credit_note: b.note}), e => e instanceof PilotError && e.code === code, why);
  }
  const b2 = await bound(d2, tpl2);
  assert.equal((await pilot.complete(P, d2.id, {...b2, credit_note: b2.note})).status, 'note_issued');
  assert.deepEqual([tracker.posts.at(-1).body.prior_total, tracker.posts.at(-1).body.prior_timestamp], [2, tpl1.timestamp]);
  assert.deepEqual(tracker.edges.get(`${P.pubkey}>${Q.pubkey}`), {total: 5, timestamp: tpl2.timestamp, signature: b2.note.signature});
});
