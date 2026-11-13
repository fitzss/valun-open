// Payment by debt transfer (design §4.5, §5.4, §5.5; spec 18.6, 18.8, 18.9; decision D-1) over real HTTP, against a
// throwaway REAL tracker v3.2 (port 3112) and a Pilot in circulation mode on. Server-run parties sign through a stub
// pilot.serverSigner (keys from basis.keygen); every other party signs in this test, as its client would, rebuilding each
// message itself. Every response body is kept, and the last test checks that none carried a signature collected from
// another party before the tracker recorded its transfer.
// Skipped unless the tracker's capabilities validate and its binary's sha256 is pinned (lib/pilot/pins.mjs): with the
// default (old) binaries every test here is skipped.
// Run: MSYS2_ENV_CONV_EXCL=VALUN_ VALUN_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release node --test test/transfer.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, BasisError, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest, TRANSFER_SLOTS, MAX_AGE_MS, FALLBACK_MARGIN_MS} from '../lib/pilot/novation.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const TRACKER_PORT = 3112, ADMIN = 'transfer-admin-secret', ADM = {'x-valun-admin': ADMIN}, MIN = 60e3, H = 3600e3;
let tracker, server, base, basis, pilot, storeDir, enabled = false, skipWhy = 'the tracker did not start', clockOffset = 0;
const logs = [], hooks = {}, serverKeys = new Map(), tokens = new Map();
const LOG = [];                // every response: {i, viewer (the caller's participant id, or null), method, path, status, text}
const produced = new Map();    // every signature a party made for a transfer slot: hex -> participant id
const appliedAt = new Map();   // transfer id -> index in LOG of the first response after the tracker applied it
const now = () => Date.now() + clockOffset;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const SIGSHA = s => crypto.createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex');

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  const caps = await capabilities(tracker.url), v = validateCaps(caps);
  const bin = caps ? await trackerSha256() : null;
  enabled = v.ok && TRACKER_SHA256_PINS.includes(bin);
  skipWhy = !caps ? 'this tracker reports no capabilities (a tracker before v3)' : !v.ok ? `capabilities do not validate: ${v.reason}` : !enabled ? `basis_server ${bin} is not pinned` : '';
  if (!enabled) return;
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-transfer-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  // Crash injection: a test may replace the tracker call (hooks.transfer(body, original)).
  const original = basis.transfer.bind(basis);
  basis.transfer = body => (hooks.transfer ? hooks.transfer(body, original) : original(body));
  pilot = new Pilot({store: new PilotStore(storeDir), basis, now, circulation: 'on', trackerCaps: caps, trackerSha256: bin, log: m => logs.push(m)});
  assert.equal(pilot.mode, 'on', JSON.stringify(logs));
  pilot.serverSigner = {has: id => serverKeys.has(id), signFor: async (id, msgHex) => {
    const k = serverKeys.get(id), s = await basis.signHex(k.pubkey, msgHex, k.secret);
    produced.set(s, id);
    return s;
  }};
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { server.closeAllConnections?.(); server.close(); }
  await tracker?.stop();
  if (storeDir) fs.rmSync(storeDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});
const live = t => { if (!enabled) { t.skip(skipWhy); return false; } return true; };

// ---------------------------------------------------------------------------------------------------------------
// HTTP: every response is logged with whose token asked (for the withholding scan at the end).
async function call(method, p, body, token, headers = {}) {
  const P = token ? tokens.get(token) : null;
  const h = {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...(P?.features && token === P.agent ? {'x-valun-features': P.features} : {}), ...headers};
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: h, body: body === undefined || body === null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const i = LOG.length;
  LOG.push({i, viewer: P?.id ?? null, method, path: p, status: r.status, text});
  for (const t of Object.values(pilot.s.transfers)) if (t.state === 'applied' && !appliedAt.has(t.id)) appliedAt.set(t.id, i);
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 600)); return r.body; };
const refused = (r, status, code, what = '') => {
  assert.equal(r.status, status, `${what}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 400)}`);
  assert.equal(r.body?.error, code, `${what}: expected ${code}, got ${JSON.stringify(r.body)?.slice(0, 400)}`);
  return r.body;
};
const notAccepted = (r, by, rule, what = '') => { refused(r, 403, 'payment_not_accepted', what); assert.deepEqual([r.body.by, r.body.rule], [by, rule], what); };

// ---------------------------------------------------------------------------------------------------------------
// Participants. Invited (mode on: the invite defaults), then the owner's mandate: room for the tests, and the credit
// policy that lets notes move. `serverRun`: its key goes to the stub server signer. `roles`: its client declares these
// consent roles (X-Valun-Features) on every agent request.
const TEST_MANDATE = {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 5000, max_accept_per_deal: 100, max_accept_per_issuer: 5000};
const CIRCULATING = {accept_transfers: true, accept_notes_from: 'any', novate_own_debt: true, pay_with_held_notes: 'when_asked'};
let handles = 0;
async function party(name, {mandate = {}, serverRun = false, roles = null} = {}) {
  const handle = `t${++handles}-${name}`.slice(0, 24);
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `transfer test operator of ${handle}`}), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token, features: roles ? `consents/1;roles=${roles}` : null};
  tokens.set(P.agent, P); tokens.set(P.owner, P);
  ok(await call('PUT', '/owner/mandate', {...TEST_MANDATE, ...CIRCULATING, ...mandate}, P.owner));
  if (serverRun) serverKeys.set(P.id, {pubkey: P.pubkey, secret: P.secret});
  if (roles) ok(await call('GET', '/me', null, P.agent));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
const msg = async (i, r, total, ts) => (await basis.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex;
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T): the prior state (X, p) of edge I>R at the operation's T.
const pa = async (i, r, total, priorTs, ts) => (await basis.priorAckMessage({issuer: i, recipient: r, priorTotal: total, priorTimestamp: priorTs, timestamp: ts})).message_hex;
// A bound template's prior acknowledgment as the payer rebuilds it (the pair's note as the template shows it, (0, 0) for
// none); it must be the template's prior_message_hex.
async function boundAck(tpl) {
  const p = tpl.prior_note ? tpl.prior_note.timestamp : 0, m = await pa(tpl.issuer_pubkey, tpl.recipient_pubkey, tpl.prior_total, p, tpl.timestamp);
  assert.deepEqual([tpl.prior_timestamp, tpl.prior_message_hex], [p, m], 'the bound template\'s prior acknowledgment is PA of the state it shows');
  return m;
}
// A transfer slot signature, kept as produced by P (for the withholding scan): a new slot over M, a prior slot over PA.
async function slotSig(P, i, r, total, ts) { const s = await basis.signHex(P.pubkey, await msg(i, r, total, ts), P.secret); produced.set(s, P.id); return s; }
async function priorSig(P, i, r, total, priorTs, ts) { const s = await basis.signHex(P.pubkey, await pa(i, r, total, priorTs, ts), P.secret); produced.set(s, P.id); return s; }
const setMandate = async (P, m) => ok(await call('PUT', '/owner/mandate', m, P.owner));

function terms(proposer, payer, payee, price) {
  const t = now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: 'vd_' + rnd(8), version: 1, prior_terms_hash: null,
    nonce: rnd(16), proposer: proposer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Short research brief', description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(t + 48 * H).toISOString(), offer_expires_at: new Date(t + 24 * H).toISOString()};
}
const view = async (P, id) => ok(await call('GET', `/deals/${id}`, null, P.agent));
// A deal taken to "delivered": payer X proposes, payee Y accepts and delivers.
async function delivered(X, Y, price) {
  const t = terms(X, X, Y, price), h = termsHash(t);
  const d = ok(await call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(X, statements.propose(h))}, X.agent), 201);
  assert.equal(ok(await call('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: await sign(Y, statements.accept(h))}, Y.agent)).status, 'agreed');
  const content = `work for ${price} (${rnd(4)})`, dh = sha(content);
  ok(await call('POST', `/deals/${d.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Y, statements.deliver(h, dh))}, Y.agent));
  return d.id;
}
// The payer's own credit note (an ordinary note from the template).
async function completeBody(P, id, tpl) {
  return {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, tpl.message_hex, P.secret)}};
}
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  return call('POST', `/deals/${id}/complete`, await completeBody(P, id, tpl), P.agent);
}
// X owes Y `price` more: X buys from Y and pays with its own credit note.
async function owes(X, Y, price) { const id = await delivered(X, Y, price); assert.equal(ok(await complete(X, id)).status, 'note_issued'); return id; }
const edge = async (I, R) => { const n = await basis.note(I.pubkey, R.pubkey); return n && {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature}; };
const netOf = async P => ok(await call('GET', `/participants/${P.id}`)).public_position.net;

// The payer's client: it checks the template, rebuilds the messages and the quote digest itself, and signs (its prior
// slot PA(A,B,X,p_AB,T) of the state the template shows), and asserts both prior states, as a v3.2 client does.
async function payBody(B, tpl) {
  const A = tpl.issuer.pubkey, Bk = tpl.payer.pubkey, C = tpl.payee.pubkey, T = tpl.timestamp, a = tpl.amount, X = tpl.from_edge.before.total, Y = tpl.to_edge.before?.total ?? 0;
  const pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  assert.equal(T % 1000, 999); assert.equal(Bk, B.pubkey);
  assert.equal(tpl.from_edge.new_total, X - a); assert.equal(tpl.to_edge.new_total, Y + a);
  assert.deepEqual([tpl.from_edge.prior_timestamp, tpl.to_edge.prior_timestamp], [pX, pY], 'the template names the prior states\' timestamps');
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: tpl.deal_id, terms_hash: tpl.terms_hash,
    deliverable_sha256: tpl.deliverable_sha256, issuer_pubkey: A, payer_pubkey: Bk, payee_pubkey: C, amount: a});
  assert.equal(tpl.quote_digest, q, 'the server quotes what the client computes');
  const AB = `${A}>${Bk}`, AC = `${A}>${C}`;
  return {issuer_id: tpl.issuer.id, terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, quote_digest: q, timestamp: T, from_prior_total: X, to_prior_total: Y,
    from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await sign(B, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), pay_signature: await sign(B, circulationStatements.pay(tpl.deal_id, q)),
    signatures: {[`${AB}:prior`]: await priorSig(B, A, Bk, X, pX, T), [`${AB}:new`]: await slotSig(B, A, Bk, X - a, T), [`${AC}:new`]: await slotSig(B, A, C, Y + a, T)}};
}
const template = async (B, id, A) => ok(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent));
async function pay(B, id, A, mutate = b => b) { const tpl = await template(B, id, A); return call('POST', `/deals/${id}/pay-by-transfer`, mutate(await payBody(B, tpl), tpl), B.agent); }
// A consent item's signatures, as the party's client makes them (every unsigned slot on its edges).
async function consentBody(P, item) {
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    revisions[e.edge] = e.revision;
    assert.equal(e.prior_timestamp, e.before?.timestamp ?? 0, 'the item names its prior state\'s timestamp');
    for (const slot of e.slots) if (!e.signed_by_you.includes(slot)) signatures[`${e.edge}:${slot}`] = slot === 'prior'
      ? await priorSig(P, I, R, e.before?.total ?? 0, e.before?.timestamp ?? 0, e.timestamp) : await slotSig(P, I, R, e.new_total, e.timestamp);
  }
  return {signatures, revisions};
}
async function itemFor(P, vt) { const c = ok(await call('GET', '/consents', null, P.agent)); const it = c.consents.find(x => x.id === vt); assert.ok(it, `${P.handle} has a consent item for ${vt}`); return it; }
async function consent(P, vt) { const it = await itemFor(P, vt); return call('POST', `/consents/${vt}`, await consentBody(P, it), P.agent); }
const T_ = id => pilot.s.transfers[id];
// What a refusal must leave untouched: everything but the record of a refused payment attempt (d.refused_attempts,
// decision D-2 b), which the tests check on its own.
const snap = dealId => { const {refused_attempts: _, ...deal} = pilot.s.deals[dealId] ?? {};
  return JSON.stringify({transfers: Object.keys(pilot.s.transfers).length, approvals: Object.keys(pilot.s.approvals).length, deal, seq: pilot.s.counters.edge_seq}); };
// The D-2 b record of a refused payment by transfer whose payer slots were `body`'s: its kind, timestamp, issuer, edges
// with their prior and new totals, and the sha256 of the payer's three signatures, never a signature.
function assertRefusedRecord(rec, body, A, B, C, X, Y, a) {
  assert.deepEqual([rec.kind, rec.timestamp, rec.issuer.id, rec.amount, rec.edges], ['transfer', body.timestamp, A.id, a,
    [{which: 'from', edge: `${A.pubkey}>${B.pubkey}`, prior_total: X, prior_timestamp: body.from_prior_timestamp, new_total: X - a},
      {which: 'to', edge: `${A.pubkey}>${C.pubkey}`, prior_total: Y, prior_timestamp: body.to_prior_timestamp ?? null, new_total: Y + a}]]);
  assert.deepEqual(rec.signature_sha256, Object.fromEntries(Object.entries(body.signatures).map(([k, s]) => [k, SIGSHA(s)])));
  const text = JSON.stringify(rec);
  assert.ok(![...Object.values(body.signatures), body.pay_signature, body.completion_signature].some(s => text.includes(s)), 'no signature in the record');
}

// =================================================================================================================
test('mode on: /info lists circulation; with circulation off the new routes are 404 like any unknown route', async t => {
  if (!live(t)) return;
  const info = ok(await call('GET', '/info'));
  assert.deepEqual(info.features, ['bound_notes/1', 'circulation/1', 'guarantees/1']);
  const B = await party('m-b'), C = await party('m-c'), id = await delivered(B, C, 2);
  pilot.circulation = 'off';
  try {
    assert.equal(pilot.mode, 'off');
    const unknown = await call('GET', '/no-such-route', null, B.agent);
    for (const [m, p] of [['GET', `/deals/${id}/payment-options`], ['GET', `/deals/${id}/transfer-template?issuer=${C.id}`], ['GET', '/consents'],
      ['GET', '/transfers/vt_0123456789abcdef'], ['POST', `/deals/${id}/pay-by-transfer`], ['POST', `/deals/${id}/cancel-transfer`], ['POST', '/consents/vt_0123456789abcdef'],
      ['POST', '/consents/vt_0123456789abcdef/refuse']]) {
      const r = await call(m, p, m === 'POST' ? {} : null, B.agent);
      assert.deepEqual([r.status, r.body], [unknown.status, unknown.body], `${m} ${p}`);
    }
  } finally { pilot.circulation = 'on'; }
  assert.equal(pilot.mode, 'on');
});

test('(a, b) happy path, server-run issuer and payee: paid_by_transfer in the same request; V(A) unchanged, V(B) -a, V(C) +a; the journal and reconciliation match exactly; receipts per party', async t => {
  if (!live(t)) return;
  const A = await party('h-a', {serverRun: true}), B = await party('h-b', {roles: 'setoff,issuer'}), C = await party('h-c', {serverRun: true}), D = await party('h-d');
  await owes(A, B, 5);                                                   // A->B 5
  const id = await delivered(B, C, 3);
  const before = {A: await netOf(A), B: await netOf(B), C: await netOf(C)};
  const opts = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent));
  assert.deepEqual([opts.deal_id, opts.price, opts.own_note], [id, 3, {available: true, why_not: null}]);
  const h = opts.held_notes.find(x => x.issuer.id === A.id);
  assert.deepEqual(h, {issuer: {id: A.id, handle: A.handle, pubkey: A.pubkey, operator_run: true}, held: 5, reserved: 0, spendable: 5, enough: true, payee_accepts: true,
    issuer_consents: 'immediate', payee_consents: 'immediate', why_not: null});
  assert.equal(opts.pending_transfer, null); assert.equal(opts.fallback_after, null);
  const tpl = await template(B, id, A);
  assert.equal(tpl.timestamp % 1000, 999); assert.ok(tpl.timestamp <= now() - 1500);
  assert.deepEqual(tpl.from_edge.before, await edge(A, B)); assert.equal(tpl.to_edge.before, null);
  assert.deepEqual([tpl.from_edge.new_total, tpl.to_edge.new_total, tpl.amount], [2, 3, 3]);
  assert.deepEqual(Object.keys(tpl.messages).sort(), [`${A.pubkey}>${B.pubkey}:new`, `${A.pubkey}>${B.pubkey}:prior`, `${A.pubkey}>${C.pubkey}:new`, `${A.pubkey}>${C.pubkey}:prior`].sort());
  assert.equal(tpl.messages[`${A.pubkey}>${C.pubkey}:new`], await msg(A.pubkey, C.pubkey, 3, tpl.timestamp), 'informational, and correct');
  assert.equal(tpl.messages[`${A.pubkey}>${B.pubkey}:prior`], await pa(A.pubkey, B.pubkey, 5, tpl.from_edge.before.timestamp, tpl.timestamp), 'a prior slot: PA of the state shown');
  assert.equal(tpl.messages[`${A.pubkey}>${C.pubkey}:prior`], await pa(A.pubkey, C.pubkey, 0, 0, tpl.timestamp), 'a new to-edge: PA of (0, 0)');
  const r = ok(await call('POST', `/deals/${id}/pay-by-transfer`, await payBody(B, tpl), B.agent));
  assert.equal(r.status, 'paid_by_transfer'); assert.equal(r.transfer.state, 'applied');
  assert.deepEqual(r.completion && [r.completion.by, r.completion.deliverable_sha256], [B.id, tpl.deliverable_sha256], 'the completion is recorded: an unconditional acceptance');
  const vt = r.transfer.id, tr = T_(vt);
  assert.match(vt, /^vt_[0-9a-f]{16}$/);
  // The tracker: A->B fell by 3 and A->C rose by 3, both at T, each holding A's signature.
  assert.deepEqual(await edge(A, B), {total: 2, timestamp: tpl.timestamp, signature: tr.slots.issuer_from.signature});
  assert.deepEqual(await edge(A, C), {total: 3, timestamp: tpl.timestamp, signature: tr.slots.issuer_to.signature});
  const after = {A: await netOf(A), B: await netOf(B), C: await netOf(C)};
  assert.deepEqual([after.A - before.A, after.B - before.B, after.C - before.C], [0, -3, 3], 'I-VALUE: V(A) unchanged, V(B) -a, V(C) +a');
  // The journal (transfer_out on A>B, transfer_in on A>C) and reconciliation v2: match and exact.
  // (The journal columns are the server's own rows; the public GET /ledger keeps v15's rows, SV-PRIV-1.)
  const rows = await pilot.reconcile();
  assert.ok(ok(await call('GET', '/ledger')).reconciliation.every(r => !('transferred_in' in r) && !('exact' in r)), "the public rows are v15's");
  for (const [I, R, total, inPC, outPC] of [[A, B, 2, 0, 3], [A, C, 3, 3, 0]]) {
    const row = rows.find(x => x.issuer === I.handle && x.recipient === R.handle);
    assert.deepEqual([row.tracker_total, row.expected_total, row.status, row.exact, row.transferred_in, row.transferred_out], [total, total, 'match', true, inPC, outPC], `${I.handle}>${R.handle}`);
  }
  const jb = ok(await call('GET', '/edges', null, B.agent)).journal.filter(e => e.ref === vt), jc = ok(await call('GET', '/edges', null, C.agent)).journal.filter(e => e.ref === vt);
  assert.deepEqual(jb.map(e => [e.kind, e.delta, e.total_after, e.timestamp]), [['transfer_out', -3, 2, tpl.timestamp]]);
  assert.deepEqual(jc.map(e => [e.kind, e.delta, e.total_after, e.timestamp]), [['transfer_in', 3, 3, tpl.timestamp]]);
  assert.ok((await view(C, id)).history.some(e => e.event === 'paid_by_transfer'));
  // Receipts: every party sees the signatures on its own edges once applied; the issuer never sees the deal.
  const ra = ok(await call('GET', `/transfers/${vt}`, null, A.agent)), rb = ok(await call('GET', `/transfers/${vt}`, null, B.owner)), rc = ok(await call('GET', `/transfers/${vt}`, null, C.agent));
  assert.deepEqual(Object.keys(ra.signatures).sort(), TRANSFER_SLOTS.map(s => s.name).sort());
  assert.equal(ra.deal, undefined, 'the issuer sees the amount and both creditors, never the deal');
  assert.deepEqual(ra.edges.map(e => e.edge), [tr.from_edge.edge, tr.to_edge.edge]);
  assert.deepEqual(Object.keys(rb.signatures).sort(), ['from_recipient', 'from_recipient_prior', 'from_recipient_to', 'issuer_from'].sort());
  assert.equal(rb.deal.deal_id, id);
  assert.deepEqual(rc.edges.map(e => e.edge), [tr.to_edge.edge], 'the payee sees only its own edge');
  assert.deepEqual(Object.keys(rc.signatures).sort(), ['from_recipient_to', 'issuer_to', 'to_recipient', 'to_recipient_prior'].sort());
  assert.deepEqual(rc.tracker_after.to, await edge(A, C));
  // Receipts cover only the edges a party is on: the payee never sees A->B (B's remaining total, A's issuer_from
  // signature); the payer never sees A->C as read back (A's issuer_to signature).
  assert.deepEqual([Object.keys(ra.tracker_after), Object.keys(rb.tracker_after), Object.keys(rc.tracker_after)], [['from', 'to'], ['from'], ['to']]);
  assert.deepEqual(rb.tracker_after.from, await edge(A, B));
  const rcText = JSON.stringify(rc), rbText = JSON.stringify(rb);
  assert.ok(!rcText.includes(tr.slots.issuer_from.signature) && !rcText.includes(tr.slots.from_recipient.signature), 'nothing of A->B in the payee\'s receipt');
  assert.ok(!rbText.includes(tr.slots.issuer_to.signature) && !rbText.includes(tr.slots.to_recipient.signature), 'nothing of A->C\'s read-back in the payer\'s');
  // (j) a non-party gets the same 404 as for an unknown id
  const unknown = refused(await call('GET', '/transfers/vt_0000000000000000', null, D.agent), 404, 'not_found');
  const other = refused(await call('GET', `/transfers/${vt}`, null, D.agent), 404, 'not_found');
  assert.equal(other.message.replace(vt, 'X'), unknown.message.replace('vt_0000000000000000', 'X'));
  refused(await call('POST', `/consents/${vt}`, {signatures: {}}, D.agent), 404, 'not_found');
  refused(await call('POST', `/consents/${vt}/refuse`, {}, D.agent), 404, 'not_found');
  assert.equal(ok(await call('GET', '/consents', null, D.agent)).consents.length, 0);
  // The deal is terminal: no second payment.
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'wrong_state');
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'wrong_state');
});

test('(a) client issuer and payee: consents (each sees only its own edges, no message hex and no other party\'s signature), novation_pending for the issuer\'s own note, then applied', async t => {
  if (!live(t)) return;
  const A = await party('c-a', {roles: 'setoff,issuer'}), B = await party('c-b'), C = await party('c-c', {roles: 'setoff,issuer,creditor'});
  await owes(A, B, 6);
  const id = await delivered(B, C, 4), other = await delivered(A, C, 2);   // A also buys from C (its note would go on A->C)
  const opts = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent));
  assert.deepEqual(opts.held_notes.map(h => [h.issuer.id, h.spendable, h.issuer_consents, h.payee_consents]), [[A.id, 6, 'auto', 'auto']]);
  const r = ok(await pay(B, id, A));
  assert.equal(r.status, 'paying_by_transfer'); assert.equal(r.transfer.state, 'collecting'); assert.equal(r.transfer.signatures, null);
  const vt = r.transfer.id, tr = T_(vt);
  assert.equal(ok(await call('GET', '/edges', null, B.agent)).incoming.find(e => e.edge === tr.from_edge.edge).reserved, 4, 'the amount is reserved on the spent edge');
  // The issuer's item: both of its edges, one slot each, no deal; its total owed does not change.
  const ia = await itemFor(A, vt);
  assert.deepEqual(ia.your_roles, ['issuer']);
  assert.deepEqual(ia.edges.map(e => [e.edge, e.your_role, e.change, e.new_total, e.slots, e.signed_by_you, e.revision, e.timestamp]),
    [[tr.from_edge.edge, 'issuer', -4, 2, ['new'], [], 1, tr.timestamp], [tr.to_edge.edge, 'issuer', 4, 4, ['new'], [], 1, tr.timestamp]]);
  assert.deepEqual(ia.edges[0].before, await edge(A, B)); assert.equal(ia.edges[1].before, null);
  assert.deepEqual(ia.summary, {your_net_change_PC: 0, your_total_owed_change_PC: 0});
  assert.equal(ia.context.deal, undefined); assert.deepEqual([ia.context.amount, ia.context.payer.id, ia.context.payee.id], [4, B.id, C.id]);
  // The payee's item: A->C only, prior and new, and the deal.
  const ic = await itemFor(C, vt);
  assert.deepEqual(ic.edges.map(e => [e.edge, e.your_role, e.change, e.slots]), [[tr.to_edge.edge, 'creditor', 4, ['prior', 'new']]]);
  assert.deepEqual(ic.context.deal, {deal_id: id, terms_hash: pilot.s.deals[id].agreement.terms_hash, price: 4, quote_digest: tr.quote_digest});
  assert.deepEqual(ic.summary, {your_net_change_PC: 4, your_total_owed_change_PC: 0});
  for (const it of [ia, ic]) assert.ok(!/message_hex|messages/.test(JSON.stringify(it)), 'no message hex in a consent');
  assert.equal(ok(await call('GET', '/consents', null, B.agent)).consents.length, 0, 'the payer signed already: nothing for it');
  assert.equal(ok(await call('GET', '/consents', null, C.owner)).consents.length, 1, 'the owner token reads the consents too');
  // While A has not signed, A's own credit note on either edge waits for that consent.
  const np = refused(await call('GET', `/deals/${other}/credit-note-template`, null, A.agent), 409, 'novation_pending');
  assert.deepEqual(np.consent_ids, [vt]);
  const od = await view(A, other);
  const nc = refused(await call('POST', `/deals/${other}/complete`, {terms_hash: od.agreement.terms_hash, deliverable_sha256: od.delivery.sha256,
    signature: await sign(A, statements.complete(od.agreement.terms_hash, od.delivery.sha256)), credit_note: {total: 2, timestamp: now() - 2000, signature: '02' + '1'.repeat(128)}}, A.agent), 409, 'novation_pending');
  assert.deepEqual(nc.consent_ids, [vt]);
  assert.equal(pilot.s.deals[other].status, 'delivered', 'nothing recorded');
  // Consent errors: not all slots, a bad signature, a stale revision (nothing recorded by any of them).
  const body = await consentBody(A, ia), one = Object.keys(body.signatures)[0];
  refused(await call('POST', `/consents/${vt}`, {signatures: {[one]: body.signatures[one]}}, A.agent), 400, 'invalid_field', 'all of the caller\'s slots or none');
  refused(await call('POST', `/consents/${vt}`, {signatures: {...body.signatures, [one]: body.signatures[Object.keys(body.signatures)[1]]}}, A.agent), 403, 'bad_signature');
  const stale = ok(await call('POST', `/consents/${vt}`, {signatures: body.signatures, revisions: {[tr.from_edge.edge]: 0}}, A.agent));
  assert.deepEqual(stale.rejected, [{slot: `${tr.from_edge.edge}:new`, code: 'stale_revision', revision: 1}]);
  assert.ok(!T_(vt).slots.issuer_from, 'nothing recorded');
  refused(await call('POST', `/consents/${vt}`, await consentBody(B, ia), B.agent), 409, 'already_signed');
  // A signs; its note on the edge is now busy (not pending on it).
  const sa = ok(await call('POST', `/consents/${vt}`, body, A.agent));
  assert.deepEqual([sa.state, sa.edges.map(e => e.signed_by_you)], ['collecting', [['new'], ['new']]]);
  refused(await call('GET', `/deals/${other}/credit-note-template`, null, A.agent), 409, 'edge_busy');
  refused(await call('POST', `/consents/${vt}`, body, A.agent), 409, 'already_signed');
  // The payee signs last: applied in that request.
  const sc = ok(await consent(C, vt));
  assert.deepEqual([sc.state, sc.result.code], ['applied', 'applied']);
  assert.equal((await view(B, id)).status, 'paid_by_transfer');
  assert.deepEqual([(await edge(A, B)).total, (await edge(A, C)).total], [2, 4]);
  assert.equal(ok(await call('GET', `/deals/${other}/credit-note-template`, null, A.agent)).deal_id, other, 'the edge is free again');
  assert.deepEqual(ok(await call('GET', '/consents', null, A.agent)).recently_resolved.find(x => x.id === vt)?.state, 'applied');
});

test('(c, i) every refusal records nothing: wrong state, party, terms, issuer, priors, timestamp, quote, each of the five signatures, the three checks, the claim, a busy edge; owner tokens are refused', async t => {
  if (!live(t)) return;
  const A = await party('r-a', {serverRun: true}), B = await party('r-b'), C = await party('r-c', {serverRun: true});
  const Q = await party('r-q', {roles: 'issuer'});                     // a client issuer, for a transfer that stays collecting
  await owes(A, B, 5); await owes(Q, B, 5);
  const id = await delivered(B, C, 3), tpl = await template(B, id, A), good = await payBody(B, tpl);
  const before = snap(id), post = (b, token = B.agent) => call('POST', `/deals/${id}/pay-by-transfer`, b, token);
  const same = what => assert.equal(snap(id), before, `${what}: nothing recorded`);
  // The stale posts whose signatures do not state what they post (another prior, another residue) are no attempt, so
  // the first ones, made before any attempt is recorded, come with a fresh template.
  const cases = [
    ['not the payer', () => post(good, C.agent), 403, 'not_payer'],
    ['from prior', () => post({...good, from_prior_total: 4}), 409, 'transfer_stale'],
    ['to prior', () => post({...good, to_prior_total: 1}), 409, 'transfer_stale'],
    ['timestamp residue', () => post({...good, timestamp: good.timestamp - 1}), 409, 'transfer_stale'],
    ['stale terms', () => post({...good, terms_hash: 'f'.repeat(64)}), 409, 'stale_terms'],
    // Tracker v3.2: a prior timestamp asserted that is not the edge's note's is stale (the from-edge's: its prior slot
    // was signed over it, so no attempt; the to-edge's: the payer's signatures do not cover it, the same attempt again).
    ['from prior timestamp', () => post({...good, from_prior_timestamp: good.from_prior_timestamp - 1}), 409, 'transfer_stale'],
    ['to prior timestamp', () => post({...good, to_prior_timestamp: 5}), 409, 'transfer_stale'],
    ['issuer is the payer', () => post({...good, issuer_id: B.id}), 400, 'self_edge'],
    ['issuer is the payee', () => post({...good, issuer_id: C.id}), 400, 'pay_with_is_payee'],
    ['unknown issuer', () => post({...good, issuer_id: 'vp_000000000000'}), 404, 'not_found'],
    ['malformed issuer', () => post({...good, issuer_id: 'ana'}), 400, 'invalid_field'],
    ['quote', () => post({...good, quote_digest: 'a'.repeat(64)}), 409, 'transfer_stale'],
    ['completion signature', () => post({...good, completion_signature: good.pay_signature}), 403, 'bad_signature'],
    ['pay signature', () => post({...good, pay_signature: good.completion_signature}), 403, 'bad_signature'],
    ['missing slot', () => post({...good, signatures: Object.fromEntries(Object.entries(good.signatures).slice(1))}), 400, 'invalid_field'],
    ['extra slot', () => post({...good, signatures: {...good.signatures, [`${A.pubkey}>${C.pubkey}:prior`]: good.pay_signature}}), 400, 'invalid_field'],
  ];
  const keys = Object.keys(good.signatures);
  for (const k of keys) {
    const other = keys.find(x => x !== k);
    cases.push([`slot ${k.slice(-12)}`, () => post({...good, signatures: {...good.signatures, [k]: good.signatures[other]}}), 403, 'bad_signature']);
  }
  for (const [what, run, status, code] of cases) {
    const recorded = !!pilot.s.deals[id].refused_attempts?.length;
    const r = await run(); refused(r, status, code, what); same(what);
    if (code === 'transfer_stale') {
      // A fresh template comes with it, also once an earlier attempt of the deal (the refused stale-terms post, recorded
      // under D-2 b) can still apply: the fresh one is on the same prior state of the same note (the same-prior
      // exemption, design v3.2 section 4), so at the tracker at most one of the two can apply.
      assert.ok(r.body.template?.timestamp % 1000 === 999, `${what}: a fresh template comes with it (recorded attempt before: ${recorded})`);
      assert.deepEqual(r.body.template.from_edge.before, tpl.from_edge.before, `${what}: on the same prior state`);
      assert.equal(r.body.freshTransferTemplate, undefined);
    }
  }
  // Decision D-2 b: the posts whose payer signatures the tracker could take (valid for what they state) are one payment
  // attempt (the same three signatures each time), recorded once; a post with another prior, another residue, a missing
  // or swapped slot, by another party, or with another issuer is no such attempt and is not recorded.
  const recs = pilot.s.deals[id].refused_attempts;
  assert.equal(recs?.length, 1, JSON.stringify(recs));
  assert.equal(recs[0].code, 'stale_terms');
  assertRefusedRecord(recs[0], good, A, B, C, 5, 0, 3);
  // The payer's own check, the payee's and the issuer's: rule names only. The post is the recorded attempt posted again
  // (the identical operation, which its window does not hold back); templates are asked for on a deal with no attempt.
  const fresh = await delivered(B, C, 3);
  const policy = async (P, m, by, rule, restore) => {
    await setMandate(P, m);
    try {
      notAccepted(await post(good), by, rule, `${by} ${rule}`); same(`${by} ${rule}`);
      notAccepted(await call('GET', `/deals/${fresh}/transfer-template?issuer=${A.id}`, null, B.agent), by, rule, `template: ${by} ${rule}`);
    } finally { await setMandate(P, restore); }
  };
  await policy(B, {pay_with_held_notes: 'never'}, 'payer', 'pay_with_held_notes', {pay_with_held_notes: 'when_asked'});
  await policy(C, {accept_transfers: false}, 'payee', 'accept_transfers', {accept_transfers: true});
  await policy(C, {accept_notes_from: [Q.id]}, 'payee', 'accept_notes_from', {accept_notes_from: 'any'});
  await policy(C, {refuse_notes_from: [A.id]}, 'payee', 'refuse_notes_from', {refuse_notes_from: []});
  await policy(C, {max_accept_per_issuer: 2}, 'payee', 'max_accept_per_issuer', {max_accept_per_issuer: 5000});
  await policy(C, {counterparties: [B.id]}, 'payee', 'counterparties', {counterparties: 'any'});
  await policy(C, {min_payer_coverage_pct: 100}, 'payee', 'min_payer_coverage_pct', {min_payer_coverage_pct: 0});
  await policy(A, {novate_own_debt: false}, 'issuer', 'novate_own_debt', {novate_own_debt: true});
  await policy(A, {counterparties: [B.id]}, 'issuer', 'counterparties', {counterparties: 'any'});
  // A payee and an issuer whose clients sign no consents (no X-Valun-Features role).
  const C2 = await party('r-c2'), id2 = await delivered(B, C2, 3);
  notAccepted(await call('GET', `/deals/${id2}/transfer-template?issuer=${A.id}`, null, B.agent), 'payee', 'creditor_consent');
  const A2 = await party('r-a2'); await owes(A2, B, 4);
  notAccepted(await call('GET', `/deals/${id}/transfer-template?issuer=${A2.id}`, null, B.agent), 'issuer', 'issuer_consent');
  // Not enough of A's note (5 held, 7 to pay).
  const big = await delivered(B, C, 7);
  refused(await call('GET', `/deals/${big}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'insufficient_claim');
  // A busy edge: Q's transfer to C stays collecting (Q is a client), so a second one through Q->B is refused (on a deal
  // with no earlier attempt; on deal `id` the refused attempt through A makes another issuer wait first, D-2 b).
  const first = ok(await pay(B, await delivered(B, C, 2), Q));
  assert.equal(first.transfer.state, 'collecting');
  refused(await call('GET', `/deals/${await delivered(B, C, 3)}/transfer-template?issuer=${Q.id}`, null, B.agent), 409, 'edge_busy');
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${Q.id}`, null, B.agent), 409, 'transfer_window_open', 'another issuer than the refused attempt\'s');
  // The refused attempt's note on the same prior state, at a new T: not held back (the same-prior exemption).
  const sameAgain = ok(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent));
  // Its T is not before the refused post's (the clock's 999 slot; it may be the same slot on a fast machine: a post
  // refused before it was recorded, D-2 b, does not move later templates, transferAfter). The same T on the same prior
  // is the identical operation, so at most one of the two can apply either way.
  assert.ok(sameAgain.timestamp >= good.timestamp && sameAgain.from_edge.before.timestamp === good.from_prior_timestamp, 'the same note on the same prior state: a template at once');
  // Wrong state: an agreed deal is not delivered yet.
  const tt = terms(B, B, C, 2), th = termsHash(tt);
  const agreed = ok(await call('POST', '/deals', {terms: tt, terms_hash: th, signature: await sign(B, statements.propose(th))}, B.agent), 201).id;
  ok(await call('POST', `/deals/${agreed}/accept`, {terms_hash: th, signature: await sign(C, statements.accept(th))}, C.agent));
  refused(await call('GET', `/deals/${agreed}/payment-options`, null, B.agent), 409, 'wrong_state');
  refused(await call('GET', `/deals/${agreed}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'wrong_state');
  refused(await call('POST', `/deals/${agreed}/pay-by-transfer`, good, B.agent), 409, 'wrong_state');
  // (i) owner tokens: reads that build what an agent signs are agent-only; owners cannot post payments or consents.
  const before2 = snap(id);
  refused(await call('GET', `/deals/${id}/payment-options`, null, B.owner), 403, 'agent_only');
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.owner), 403, 'agent_only');
  for (const [p, b] of [[`/deals/${id}/pay-by-transfer`, good], [`/deals/${id}/cancel-transfer`, {}], [`/consents/${first.transfer.id}`, {signatures: {}}], [`/consents/${first.transfer.id}/refuse`, {}]])
    refused(await call('POST', p, b, p.startsWith('/consents') ? Q.owner : B.owner), 404, 'not_found', `owner POST ${p}`);
  assert.equal(snap(id), before2, 'owner tokens: nothing recorded');
  assert.equal(pilot.s.deals[id].refused_attempts.length, 1, 'still the one attempt');
  // And now the good body still works: the refused attempt is the same payment (the same note, the same prior).
  assert.equal(ok(await post(good)).status, 'paid_by_transfer');
});

test('pending incoming transfers count against their issuer (exposure): the payee cannot accept a new deal from the same issuer that its cap no longer covers', async t => {
  if (!live(t)) return;
  const A = await party('x-a', {roles: 'issuer'}), B = await party('x-b'), C = await party('x-c', {roles: 'creditor', mandate: {max_accept_per_issuer: 5}});
  await owes(A, B, 6);
  const r = ok(await pay(B, await delivered(B, C, 3), A));
  assert.equal(r.transfer.state, 'collecting');
  // A offers C a 3 PC deal: C's claim on A would be 0 on the tracker + 3 pending + 3 > 5.
  const tt = terms(A, A, C, 3), th = termsHash(tt);
  const d = ok(await call('POST', '/deals', {terms: tt, terms_hash: th, signature: await sign(A, statements.propose(th))}, A.agent), 201);
  const ref = refused(await call('POST', `/deals/${d.id}/accept`, {terms_hash: th, signature: await sign(C, statements.accept(th))}, C.agent), 403, 'mandate_exceeded');
  assert.equal(ref.rule, 'max_accept_per_issuer');
  ok(await call('POST', `/deals/${r.id}/cancel-transfer`, {}, B.agent));
  assert.equal(ok(await call('POST', `/deals/${d.id}/accept`, {terms_hash: th, signature: await sign(C, statements.accept(th))}, C.agent)).status, 'agreed', 'with the transfer gone it fits');
});

test('(d) staleness: an edge moved by a direct tracker note fails the transfer (edge_changed) and the deal is payment_due; the same issuer on the moved held edge waits for the window; a moved destination edge is not made again by the server (the payer is asked to sign nothing), and the payer\'s own retry through the same note, still in the state it acknowledged, starts at once and applies (the same-prior exemption)', async t => {
  if (!live(t)) return;
  const A = await party('s-a', {roles: 'issuer'}), B = await party('s-b'), C = await party('s-c', {roles: 'creditor'});
  await owes(A, B, 6);
  // 1. The held edge moves (A issues 1 PC more to B straight at the tracker): the payer's acknowledgment no longer holds.
  const id = await delivered(B, C, 3), vt = ok(await pay(B, id, A)).transfer.id;
  ok(await consent(A, vt));
  const moved = await basis.issueNote({issuer: A.pubkey, recipient: B.pubkey, total: 7, secretHex: A.secret});
  assert.equal(moved.response.success, true, JSON.stringify(moved.response));
  const sc = ok(await consent(C, vt));
  assert.deepEqual([sc.state, sc.result.code], ['failed', 'edge_changed']);
  const d = await view(B, id), tr = T_(vt);
  assert.equal(d.status, 'payment_due');
  assert.equal(tr.regenerated_as ?? null, null, 'the held edge has another total now: not made again');
  assert.equal(tr.fallback_after, tr.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS);
  assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature) && Object.keys(tr.signature_sha256).length === 7, 'purged, sha256 kept');
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [7, null], 'nothing moved');
  // From payment_due the same issuer waits for the window too: its note is in another state now (7 PC), not the one the
  // failed attempt acknowledged.
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'transfer_window_open');
  // The held edge no longer reconciles with Valun's journal (a note around Valun): it is not spendable for a new deal.
  refused(await call('GET', `/deals/${await delivered(B, C, 1)}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'insufficient_claim');
  // 2. The destination edge moves (A2 issues to C2 at the tracker) while the held edge keeps its state. The server does
  //    not make the transfer again by itself; the payer's client may (a new attempt on the same prior state of the held
  //    note: at the tracker at most one of the two can apply, tracker v3.2).
  const A2 = await party('s-a2', {roles: 'issuer'}), B2 = await party('s-b2'), C2 = await party('s-c2', {roles: 'creditor'});
  await owes(A2, B2, 6);
  const id2 = await delivered(B2, C2, 2), vt2 = ok(await pay(B2, id2, A2)).transfer.id;
  ok(await consent(A2, vt2));
  const toC = await basis.issueNote({issuer: A2.pubkey, recipient: C2.pubkey, total: 1, secretHex: A2.secret});
  assert.equal(toC.response.success, true, JSON.stringify(toC.response));
  const s2 = ok(await consent(C2, vt2));
  assert.deepEqual([s2.state, s2.result.code], ['failed', 'edge_changed']);
  const tr2 = T_(vt2);
  assert.equal(tr2.regenerated_as ?? null, null, 'not made again');
  assert.equal(pilot.transfersOf(pilot.s.deals[id2]).length, 1, 'no second transfer');
  assert.ok(!pilot.s.deals[id2].history.some(e => e.event === 'payment_by_transfer_regenerated'));
  const v2 = await view(B2, id2);
  assert.deepEqual([v2.status, v2.next_actions, v2.payment.fallback_after], ['payment_due', ['wait_for_transfer_window', 'pay_by_transfer'], new Date(tr2.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS).toISOString()]);
  assert.equal(ok(await call('GET', '/consents', null, B2.agent)).consents.length, 0, 'the payer is asked to sign nothing');
  refused(await call('GET', `/deals/${id2}/credit-note-template`, null, B2.agent), 409, 'transfer_window_open', 'an own note waits');
  assert.deepEqual([(await edge(A2, B2)).total, (await edge(A2, C2)).total], [6, 1], 'nothing moved');
  const t2 = await template(B2, id2, A2);
  assert.ok(t2.timestamp > tr2.timestamp, 'the same note on the same prior state: a template at once, at a later T');
  assert.deepEqual([t2.from_edge.before, t2.to_edge.before.total], [tr2.from_edge.before, 1]);
  const vt3 = ok(await call('POST', `/deals/${id2}/pay-by-transfer`, await payBody(B2, t2), B2.agent)).transfer.id;
  ok(await consent(A2, vt3));
  assert.equal(ok(await consent(C2, vt3)).state, 'applied');
  assert.deepEqual([(await edge(A2, B2)).total, (await edge(A2, C2)).total, (await view(B2, id2)).status], [4, 3, 'paid_by_transfer'], 'the retry applied, once');
});

test('(e) expiry on an injected clock: payment_due, signatures purged; an own note and another issuer are refused until fallback_after (transfer_window_open), the same issuer on the same prior state is not (the same-prior exemption); afterwards the own note is issued', async t => {
  if (!live(t)) return;
  // Built 70 minutes in the past (this server's clock; the tracker accepts old ordinary notes), so that T + 1 h + 60 s
  // passes within this test on the real clock.
  clockOffset = -70 * MIN;
  try {
    const A = await party('e-a', {roles: 'issuer'}), A2 = await party('e-a2', {serverRun: true}), B = await party('e-b'), C = await party('e-c', {roles: 'creditor'});
    await owes(A, B, 5); await owes(A2, B, 5);
    const id = await delivered(B, C, 3), tpl = await template(B, id, A), body = await payBody(B, tpl);
    const r = ok(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent)), vt = r.transfer.id, T = T_(vt).timestamp;
    assert.equal(r.transfer.state, 'collecting');
    clockOffset = -30 * MIN;                                              // past expires_at (T + 20 min), before T + 1 h + 60 s
    const d = await view(B, id);
    assert.equal(d.status, 'payment_due');
    const tr = T_(vt);
    assert.deepEqual([tr.state, tr.result.code, tr.fallback_after], ['expired', 'expired', T + MAX_AGE_MS + FALLBACK_MARGIN_MS]);
    assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature), 'purged');
    assert.deepEqual(tr.signature_sha256, {from_recipient_prior: SIGSHA(body.signatures[`${A.pubkey}>${B.pubkey}:prior`]),
      from_recipient: SIGSHA(body.signatures[`${A.pubkey}>${B.pubkey}:new`]), from_recipient_to: SIGSHA(body.signatures[`${A.pubkey}>${C.pubkey}:new`])}, 'their sha256 kept');
    // Each party's view shows the sha256 of the signatures on its own edges only (the payee: A->C).
    const shaSeen = async P => Object.keys(ok(await call('GET', `/transfers/${vt}`, null, P.agent)).signature_sha256 ?? {}).sort();
    assert.deepEqual([await shaSeen(C), await shaSeen(B), await shaSeen(A)], [['from_recipient_to'], ['from_recipient', 'from_recipient_prior', 'from_recipient_to'],
      ['from_recipient', 'from_recipient_prior', 'from_recipient_to']]);
    assert.equal(ok(await call('GET', '/consents', null, A.agent)).recently_resolved.find(x => x.id === vt).state, 'expired');
    const w1 = refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'transfer_window_open');
    assert.ok(Math.abs(w1.retry_after_ms - (T + MAX_AGE_MS + FALLBACK_MARGIN_MS - now())) < 5000, JSON.stringify(w1));
    refused(await call('POST', `/deals/${id}/complete`, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256,
      signature: await sign(B, statements.complete(d.agreement.terms_hash, d.delivery.sha256)), credit_note: {total: 3, timestamp: now() - 2000, signature: '02' + '1'.repeat(128)}}, B.agent), 409, 'transfer_window_open');
    refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A2.id}`, null, B.agent), 409, 'transfer_window_open', 'another issuer');
    const opts = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent));
    assert.deepEqual(opts.own_note, {available: false, why_not: 'transfer_window_open'});
    assert.deepEqual(opts.held_notes.map(h => [h.issuer.id, h.why_not]).sort(), [[A.id, null], [A2.id, 'transfer_window_open']].sort());
    assert.equal(opts.pending_transfer.id, vt); assert.ok(opts.fallback_after);
    const again = await template(B, id, A);
    assert.ok(again.timestamp > T && again.from_edge.before.timestamp === body.from_prior_timestamp, 'the same issuer on the same prior state: a template at once');
    assert.deepEqual(d.next_actions, ['wait_for_transfer_window', 'pay_by_transfer']);
    clockOffset = -5 * MIN;                                               // now > T + 1 h + 60 s
    assert.equal((await template(B, id, A)).from_edge.before.total, 5, 'after the window: the same issuer again');
    assert.equal(ok(await complete(B, id)).status, 'note_issued');
    assert.deepEqual((await edge(B, C)).total, 3);
  } finally { clockOffset = 0; }
});

test('(f) two attempts through the same issuer on the same prior state: the second starts at once (the same-prior exemption, tracker v3.2), then only the second applies (the first, cancelled, is refused at the tracker); on another prior state the second waits for the first\'s window', async t => {
  if (!live(t)) return;
  const A = await party('f-a', {roles: 'issuer'}), B = await party('f-b'), C = await party('f-c', {roles: 'creditor'});
  let tpl1, b1, vt1, a1, c1;
  {
    await owes(A, B, 6);
    const id0 = await delivered(B, C, 3);
    tpl1 = await template(B, id0, A); b1 = await payBody(B, tpl1);
    vt1 = ok(await call('POST', `/deals/${id0}/pay-by-transfer`, b1, B.agent)).transfer.id;
    // Everyone's signatures for attempt 1 exist (the test holds every key): A's and C's from their consent items, kept
    // here and never sent to Valun.
    a1 = (await consentBody(A, await itemFor(A, vt1))).signatures; c1 = (await consentBody(C, await itemFor(C, vt1))).signatures;
    // (g) the payer cancels attempt 1: payment_due, purged; a second cancel is refused; the payee cannot cancel.
    refused(await call('POST', `/deals/${id0}/cancel-transfer`, {}, C.agent), 403, 'not_payer');
    const cx = ok(await call('POST', `/deals/${id0}/cancel-transfer`, {}, B.agent));
    assert.deepEqual([cx.status, cx.transfer.state, cx.transfer.result.code], ['payment_due', 'cancelled', 'cancelled_by_payer']);
    assert.ok(TRANSFER_SLOTS.every(s => !T_(vt1).slots[s.name]?.signature));
    refused(await call('POST', `/deals/${id0}/cancel-transfer`, {}, B.agent), 409, 'wrong_state');
    refused(await call('POST', `/consents/${vt1}`, {signatures: {}}, A.agent), 409, 'wrong_state');
  }
  const id = T_(vt1).deal_id;
  // Attempt 2, same issuer and same prior state, at once: PA(A,B,6,p,T) of both attempts acknowledges the same state of
  // A->B, which the edge has once, so at most one of them can apply.
  const r2 = ok(await pay(B, id, A)), vt2 = r2.transfer.id;
  assert.equal(r2.transfer.attempt, 2);
  assert.ok(T_(vt2).timestamp > tpl1.timestamp && T_(vt2).timestamp - tpl1.timestamp < 10 * MIN, 'at once, at a later T');
  assert.deepEqual(T_(vt2).from_edge.before, tpl1.from_edge.before, 'on the same prior state');
  ok(await consent(A, vt2));
  assert.equal(ok(await consent(C, vt2)).state, 'applied');
  const ab = await edge(A, B), ac = await edge(A, C);
  assert.deepEqual([ab.total, ac.total, ab.timestamp], [3, 3, T_(vt2).timestamp]);
  // Attempt 1 with all seven signatures, straight to the tracker: refused, and nothing changes.
  const k = (e, s) => `${e}:${s}`, AB = `${A.pubkey}>${B.pubkey}`, AC = `${A.pubkey}>${C.pubkey}`;
  const body = {issuer_pubkey: A.pubkey, from_recipient_pubkey: B.pubkey, to_recipient_pubkey: C.pubkey, denomination: PILOT_DENOMINATION, amount: 3, timestamp: tpl1.timestamp,
    issuer_from_signature: a1[k(AB, 'new')], issuer_to_signature: a1[k(AC, 'new')],
    from_recipient_prior_signature: b1.signatures[k(AB, 'prior')], from_recipient_signature: b1.signatures[k(AB, 'new')], from_recipient_to_signature: b1.signatures[k(AC, 'new')],
    to_recipient_prior_signature: c1[k(AC, 'prior')], to_recipient_signature: c1[k(AC, 'new')], from_prior_total: 6, to_prior_total: 0};
  assert.ok(Object.values(body).every(v => v !== undefined), 'all seven signatures of attempt 1');
  const replay = await basis.transfer(body);
  assert.ok(replay.status >= 400 && replay.status < 500 && !replay.success, JSON.stringify({status: replay.status, code: replay.code}));
  assert.deepEqual([await edge(A, B), await edge(A, C)], [ab, ac], 'only one attempt applied');
  // Another prior state of the same note: a third deal's attempt is cancelled, A's note to B then moves (a note straight
  // at the tracker, so Valun's journal does not prove the attempt dead), and a new attempt waits for its window.
  const id3 = await delivered(B, C, 2), vt4 = ok(await pay(B, id3, A)).transfer.id;
  ok(await call('POST', `/deals/${id3}/cancel-transfer`, {}, B.agent));
  // A->B is bound-only now (a transfer changed it): the note must be a bound one, with A's PA of the edge's state.
  const cur = await edge(A, B), ts = cur.timestamp - (cur.timestamp % 1000) + 997 + (cur.timestamp % 1000 >= 997 ? 1000 : 0);
  while (Date.now() < ts + 50) await sleep(50);
  const ack = await basis.signHex(A.pubkey, await pa(A.pubkey, B.pubkey, cur.total, cur.timestamp, ts), A.secret);
  const around = await basis.issueNote({issuer: A.pubkey, recipient: B.pubkey, total: cur.total + 1, secretHex: A.secret, timestamp: ts, priorSignature: ack, priorTotal: cur.total,
    priorTimestamp: cur.timestamp});
  assert.equal(around.response.success, true, JSON.stringify(around.response));
  const w = refused(await call('GET', `/deals/${id3}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'transfer_window_open', 'the same issuer on another prior state');
  assert.ok(Math.abs(w.retry_after_ms - (T_(vt4).fallback_after - now())) < 5000, JSON.stringify(w));
});

test('(h) a revoked key voids the transfer in any role: collecting -> payment_due, awaiting the owner -> delivered (completion cleared, approval void)', async t => {
  if (!live(t)) return;
  for (const role of ['issuer', 'payer', 'payee']) {
    const A = await party(`v${role[2]}-a`, {roles: 'issuer'}), B = await party(`v${role[2]}-b`), C = await party(`v${role[2]}-c`, {roles: 'creditor'});
    await owes(A, B, 4);
    const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id;
    const P = {issuer: A, payer: B, payee: C}[role];
    const rv = ok(await call('POST', '/owner/revoke-agent', null, P.owner));
    assert.deepEqual(rv.voided_transfers, [vt], role);
    assert.deepEqual([T_(vt).state, T_(vt).result.code], ['void_key_revoked', 'key_revoked'], role);
    assert.ok(TRANSFER_SLOTS.every(s => !T_(vt).slots[s.name]?.signature), `${role}: purged`);
    assert.equal(pilot.s.deals[id].status, 'payment_due', role);
    assert.equal((await view(role === 'payer' ? C : B, id)).status, 'payment_due');
    assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [4, null], `${role}: nothing moved`);
  }
  // Waiting for the payer's owner (review_deliveries): a pay_by_transfer approval; the issuer's revocation voids it.
  const A = await party('vo-a', {serverRun: true}), B = await party('vo-b', {mandate: {review_deliveries: true}}), C = await party('vo-c', {serverRun: true});
  await owes(A, B, 4);
  const id = await delivered(B, C, 2), r = ok(await pay(B, id, A)), vt = r.transfer.id;
  assert.deepEqual([r.status, r.transfer.state], ['completion_awaiting_owner', 'awaiting_owner']);
  assert.equal(T_(vt).slots.issuer_from, undefined, 'server-run parties sign only once the owner approves');
  const own = ok(await call('GET', '/owner', null, B.owner));
  const ap = own.approvals.find(a => a.deal_id === id && a.state === 'pending');
  assert.equal(ap.kind, 'pay_by_transfer');
  assert.deepEqual([ap.subject.what, ap.subject.transfer.id], ['payment_by_transfer', vt], 'GET /owner describes the held payment');
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'wrong_state');
  const other = await delivered(A, C, 1);                                // A's own note on A->C waits meanwhile
  refused(await call('GET', `/deals/${other}/credit-note-template`, null, A.agent), 409, 'edge_busy');
  const rv = ok(await call('POST', '/owner/revoke-agent', null, A.owner));
  assert.deepEqual(rv.voided_transfers, [vt]);
  const d = pilot.s.deals[id];
  assert.deepEqual([d.status, d.completion, T_(vt).state, pilot.s.approvals[ap.id].state], ['delivered', null, 'void_key_revoked', 'void_key_revoked']);
});

test('awaiting the owner: the transfer expires with its collection window and the deal returns to delivered (the approval is void)', async t => {
  if (!live(t)) return;
  const A = await party('w-a', {serverRun: true}), B = await party('w-b', {mandate: {review_deliveries: true}}), C = await party('w-c', {serverRun: true});
  await owes(A, B, 4);
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id, ap = Object.values(pilot.s.approvals).find(a => a.deal_id === id);
  clockOffset = 21 * MIN;
  try {
    const d = await view(B, id);
    assert.deepEqual([d.status, d.completion, T_(vt).state, pilot.s.approvals[ap.id].state], ['delivered', null, 'expired', 'void_expired']);
    assert.ok(d.history.some(e => e.event === 'payment_void'));
    refused(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, B.owner), 409, 'not_pending', 'an expired approval cannot be decided');
  } finally { clockOffset = 0; }
  // The payer may now dispute (the acceptance never stood); paying again waits for the expired attempt's window, except
  // through the same note on the same prior state (the same-prior exemption).
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'transfer_window_open', 'an own note');
  assert.ok((await template(B, id, A)).timestamp > T_(vt).timestamp, 'the same issuer on the same prior state: a template at once');
  assert.deepEqual((await view(B, id)).next_actions, ['wait_for_transfer_window', 'pay_by_transfer', 'dispute']);
});

test('refusing a consent ends the transfer (refused) and the deal is payment_due; the reason is checked', async t => {
  if (!live(t)) return;
  const A = await party('f2-a', {roles: 'issuer'}), B = await party('f2-b'), C = await party('f2-c', {roles: 'creditor'});
  await owes(A, B, 4);
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id;
  refused(await call('POST', `/consents/${vt}/refuse`, {reason: 'x'.repeat(301)}, C.agent), 400, 'invalid_field');
  refused(await call('POST', `/consents/${vt}/refuse`, {reason: 'hidden​text'}, C.agent), 400, 'invalid_field');
  refused(await call('POST', `/consents/${vt}/refuse`, {}, B.agent), 409, 'wrong_state', 'the payer cancels instead');
  const r = ok(await call('POST', `/consents/${vt}/refuse`, {reason: 'policy_off'}, C.agent));
  assert.deepEqual([r.state, r.result.code, r.result.by, r.result.reason], ['refused', 'refused', 'payee', 'policy_off']);
  assert.equal((await view(B, id)).status, 'payment_due');
  refused(await call('POST', `/consents/${vt}/refuse`, {}, A.agent), 409, 'wrong_state');
  // The acceptance stands: no dispute any more.
  const d = await view(B, id);
  refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, reason: 'late',
    signature: await sign(B, statements.dispute(d.agreement.terms_hash, d.delivery.sha256, 'late'))}, B.agent), 409, 'wrong_state');
});

test('(l) crash injection: a crash after the write-ahead leaves the transfer applying (saved on disk); recover() adopts one the tracker applied and resubmits one it never got', async t => {
  if (!live(t)) return;
  const A = await party('k-a', {serverRun: true}), B = await party('k-b'), C = await party('k-c', {serverRun: true});
  await owes(A, B, 9);
  const onDisk = vt => JSON.parse(fs.readFileSync(path.join(storeDir, 'pilot-state.json'), 'utf8')).transfers[vt].state;
  // 1. The tracker applied it, then the process "crashed" before reading back.
  hooks.transfer = async (body, original) => { await original(body); throw new Error('simulated crash after the tracker call'); };
  const id1 = await delivered(B, C, 2);
  let r;
  try { r = await pay(B, id1, A); } finally { delete hooks.transfer; }
  assert.equal(r.status, 502, JSON.stringify(r.body));
  const vt1 = Object.values(pilot.s.transfers).find(x => x.deal_id === id1).id;
  assert.deepEqual([T_(vt1).state, onDisk(vt1), pilot.s.deals[id1].status], ['applying', 'applying', 'paying_by_transfer']);
  assert.equal(refused(await call('GET', `/deals/${id1}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'wrong_state').error, 'wrong_state');
  assert.ok((await pilot.recover()).includes(`${vt1}:applied`));
  assert.deepEqual([T_(vt1).result.recovered, pilot.s.deals[id1].status, (await edge(A, B)).total], [true, 'paid_by_transfer', 7]);
  // 2. The process "crashed" before the tracker got it: resubmitted.
  hooks.transfer = async () => { throw new Error('simulated crash before the tracker call'); };
  const id2 = await delivered(B, C, 3);
  try { r = await pay(B, id2, A); } finally { delete hooks.transfer; }
  assert.equal(r.status, 502);
  const vt2 = Object.values(pilot.s.transfers).find(x => x.deal_id === id2).id;
  assert.deepEqual([T_(vt2).state, onDisk(vt2), (await edge(A, B)).total], ['applying', 'applying', 7]);
  assert.ok((await pilot.recover()).includes(`${vt2}:applied`));
  assert.deepEqual([pilot.s.deals[id2].status, (await edge(A, B)).total, (await edge(A, C)).total], ['paid_by_transfer', 4, 5]);
  // 3. The tracker is unreachable for the submission: the transfer stays applying (200: the deal shows it), never a 502.
  hooks.transfer = async () => { throw new BasisError('tracker unreachable: ECONNREFUSED'); };
  const id3 = await delivered(B, C, 1);
  try { r = ok(await pay(B, id3, A)); } finally { delete hooks.transfer; }
  assert.deepEqual([r.status, r.transfer.state], ['paying_by_transfer', 'applying']);
  assert.ok((await pilot.recover()).includes(`${r.transfer.id}:applied`));
  // 4. A transfer left applying past the tracker's maximum age is not resubmitted: failed.
  hooks.transfer = async () => { throw new Error('simulated crash'); };
  const id4 = await delivered(B, C, 1);
  try { await pay(B, id4, A); } finally { delete hooks.transfer; }
  const vt4 = Object.values(pilot.s.transfers).find(x => x.deal_id === id4).id;
  clockOffset = 61 * MIN;
  try { assert.ok((await pilot.recover()).includes(`${vt4}:failed`)); } finally { clockOffset = 0; }
  assert.deepEqual([T_(vt4).result.code, pilot.s.deals[id4].status, (await edge(A, B)).total], ['novation_expired', 'payment_due', 3]);
});

test('D-1: an applying transfer whose edge moved past T to another total is outcome_unknown (an alarm); every payment of the deal is then refused with attempt_outcome_unknown', async t => {
  if (!live(t)) return;
  const A = await party('u-a', {serverRun: true}), B = await party('u-b'), C = await party('u-c', {serverRun: true});
  await owes(A, B, 5);
  const id = await delivered(B, C, 2);
  hooks.transfer = async () => { throw new Error('simulated crash before the tracker call'); };
  try { await pay(B, id, A); } finally { delete hooks.transfer; }
  const vt = Object.values(pilot.s.transfers).find(x => x.deal_id === id).id;
  // A note around Valun moves A->B past T to a total that is neither the prior (5) nor the new one (3).
  await new Promise(r => setTimeout(r, 30));
  const moved = await basis.issueNote({issuer: A.pubkey, recipient: B.pubkey, total: 8, secretHex: A.secret});
  assert.equal(moved.response.success, true, JSON.stringify(moved.response));
  assert.ok((await edge(A, B)).timestamp > T_(vt).timestamp);
  logs.length = 0;
  assert.ok((await pilot.recover()).includes(`${vt}:outcome_unknown`));
  assert.ok(logs.some(l => /ALARM/.test(l) && l.includes(vt)), 'an alarm');
  assert.deepEqual([T_(vt).result.code, pilot.s.deals[id].status], ['attempt_outcome_unknown', 'payment_due']);
  refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'attempt_outcome_unknown');
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'attempt_outcome_unknown');
  const opts = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent));
  assert.deepEqual([opts.own_note.why_not, opts.held_notes.find(h => h.issuer.id === A.id).why_not], ['attempt_outcome_unknown', 'attempt_outcome_unknown']);
  // How the read-back classified each edge goes only to that edge's parties.
  const edgesSeen = async P => Object.keys(ok(await call('GET', `/transfers/${vt}`, null, P.owner)).result.edges);
  assert.deepEqual([await edgesSeen(A), await edgesSeen(B), await edgesSeen(C)], [['from', 'to'], ['from'], ['to']]);
});

test('D-2 d: the payer\'s owner resolves an attempt of unknown outcome (owner token only, audited): not_applied releases it (another kind of payment after its window) and applied pays the deal by it; nothing else is resolved', async t => {
  if (!live(t)) return;
  const A = await party('ur-a', {serverRun: true}), A2 = await party('ur-a2', {serverRun: true}), A3 = await party('ur-a3', {serverRun: true});
  const B = await party('ur-b'), C = await party('ur-c', {serverRun: true});
  for (const I of [A, A2, A3]) await owes(I, B, 9);
  // An attempt through I's note left applying (a crash before the tracker got it), then I->B moved past T to a total
  // that is neither its prior nor its new one (a note around Valun): recovery leaves it outcome_unknown, with the
  // payee's edge I->C untouched ('prior'). With appliedAtTracker the tracker applied it before the crash (I->C holds its
  // new state, 'new'), and a bound note around Valun (I->B is bound-only now) moves I->B past T.
  const unknown = async (I, price, {appliedAtTracker = false} = {}) => {
    const id = await delivered(B, C, price);
    hooks.transfer = appliedAtTracker ? async (body, original) => { await original(body); throw new Error('simulated crash after the tracker call'); }
      : async () => { throw new Error('simulated crash before the tracker call'); };
    try { await pay(B, id, I); } finally { delete hooks.transfer; }
    const vt = Object.values(pilot.s.transfers).find(x => x.deal_id === id).id, ab = await edge(I, B);
    await new Promise(r => setTimeout(r, 30));
    if (!appliedAtTracker) assert.equal((await basis.issueNote({issuer: I.pubkey, recipient: B.pubkey, total: ab.total + 1, secretHex: I.secret})).response.success, true);
    else {
      const ts = ab.timestamp - (ab.timestamp % 1000) + 997 + (ab.timestamp % 1000 >= 997 ? 1000 : 0);
      while (Date.now() < ts + 50) await new Promise(r => setTimeout(r, 50));
      const prior = await basis.signHex(I.pubkey, await pa(I.pubkey, B.pubkey, ab.total, ab.timestamp, ts), I.secret);
      const r = await basis.issueNote({issuer: I.pubkey, recipient: B.pubkey, total: ab.total + 1, secretHex: I.secret, timestamp: ts, priorSignature: prior, priorTotal: ab.total,
        priorTimestamp: ab.timestamp});
      assert.equal(r.response.success, true, JSON.stringify(r.response));
    }
    assert.ok((await pilot.recover()).includes(`${vt}:outcome_unknown`));
    return {id, vt};
  };
  const u1 = await unknown(A, 2), tr1 = T_(u1.vt), path1 = `/owner/deals/${u1.id}/attempts/${u1.vt}/resolve`;
  assert.ok(TRANSFER_SLOTS.every(s => typeof tr1.slots[s.name]?.signature === 'string'), 'an unresolved attempt keeps its signatures (withheld) for its owner to resolve');
  assert.equal(ok(await call('GET', `/transfers/${u1.vt}`, null, B.agent)).signatures, null, 'still withheld');
  const holdsBefore = pilot.paymentAttemptHolds();
  assert.ok(holdsBefore.has(tr1.from_edge.edge) && holdsBefore.has(tr1.to_edge.edge), 'it holds both edges for set-offs');
  // Who may resolve, and how.
  refused(await call('POST', path1, {outcome: 'not_applied'}, C.owner), 403, 'not_payer', 'the payee\'s owner');
  refused(await call('POST', path1, {outcome: 'not_applied'}, B.agent), 404, 'not_found', 'an agent token');
  refused(await call('POST', path1, {outcome: 'maybe'}, B.owner), 400, 'invalid_field');
  refused(await call('POST', path1, {outcome: 'not_applied', note: 'hidden​text'}, B.owner), 400, 'invalid_field');
  refused(await call('POST', `/owner/deals/${u1.id}/attempts/vt_0123456789abcdef/resolve`, {outcome: 'not_applied'}, B.owner), 404, 'not_found');
  pilot.circulation = 'off';
  try { refused(await call('POST', path1, {outcome: 'not_applied'}, B.owner), 404, 'not_found', 'with circulation off the route does not exist'); } finally { pilot.circulation = 'on'; }
  assert.equal(T_(u1.vt).state, 'outcome_unknown', 'nothing resolved yet');
  // SV-AUTH-1: applied is refused while the payee's edge shows nothing of it (I->C at its earlier state).
  const nope = refused(await call('POST', path1, {outcome: 'applied'}, B.owner), 409, 'payee_edge_not_applied', "applied, with the payee's edge untouched");
  assert.equal(nope.payee_edge, 'prior');
  assert.deepEqual([T_(u1.vt).state, pilot.s.deals[u1.id].status], ['outcome_unknown', 'payment_due'], 'nothing changed');
  // not_applied.
  refused(await call('POST', path1, {outcome: 'not_applied', note: 'x'.repeat(301)}, B.owner), 400, 'invalid_field', 'a note over 300 characters');
  const r1 = ok(await call('POST', path1, {outcome: 'not_applied', note: 'the payee confirmed nothing arrived'}, B.owner));
  assert.deepEqual([r1.resolution.outcome, r1.resolution.previous_state, r1.transfer.state, r1.deal.status, tr1.state, tr1.result.code], ['not_applied', 'outcome_unknown', 'resolved_not_applied', 'payment_due', 'resolved_not_applied', 'resolved_not_applied']);
  assert.deepEqual(r1.attempt, {id: u1.vt, kind: 'transfer', timestamp: tr1.timestamp}, 'the answer names the attempt and its T, which a client matches its records by');
  assert.ok(TRANSFER_SLOTS.every(s => !tr1.slots[s.name]?.signature) && Object.keys(tr1.signature_sha256).length === 7, 'purged now, sha256 kept');
  assert.equal(tr1.fallback_after, tr1.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS);
  assert.ok(!pilot.paymentAttemptHolds().has(tr1.to_edge.edge), 'its holds are released');
  assert.ok(r1.deal.history.some(e => e.event === 'payment_attempt_resolved' && e.outcome === 'not_applied'));
  const audit = fs.readFileSync(path.join(storeDir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'transfer.resolved_by_owner' && l.id === u1.vt);
  assert.deepEqual(audit.map(l => [l.outcome, l.previous_state, l.owner]), [['not_applied', 'outcome_unknown', B.id]]);
  refused(await call('POST', path1, {outcome: 'applied'}, B.owner), 409, 'wrong_state', 'resolved once');
  // Another kind of payment waits for the attempt's window; the same note on the same prior is not possible here (A->B moved).
  refused(await call('GET', `/deals/${u1.id}/credit-note-template`, null, B.agent), 409, 'transfer_window_open');
  clockOffset = tr1.fallback_after - Date.now() + 1000;
  try { assert.equal(ok(await call('GET', `/deals/${u1.id}/credit-note-template`, null, B.agent)).deal_id, u1.id, 'after the window'); } finally { clockOffset = 0; }
  // applied: the tracker did apply it (the payee's edge shows its new state).
  const u2 = await unknown(A2, 3, {appliedAtTracker: true}), tr2 = T_(u2.vt), seq = pilot.s.counters.edge_seq;
  assert.deepEqual(tr2.result.edges, {from: 'unknown', to: 'new'}, 'precondition: only the payer\'s edge is undecidable');
  const r2 = ok(await call('POST', `/owner/deals/${u2.id}/attempts/${u2.vt}/resolve`, {outcome: 'applied'}, B.owner));
  assert.deepEqual([r2.transfer.state, r2.deal.status, r2.transfer.result.resolved_by_owner], ['applied', 'paid_by_transfer', true]);
  assert.deepEqual(r2.attempt, {id: u2.vt, kind: 'transfer', timestamp: tr2.timestamp});
  assert.deepEqual(pilot.s.edge_log_tail.filter(e => e.seq > seq).map(e => [e.kind, e.ref, e.delta, e.total_after, e.timestamp]),
    [['transfer_out', u2.vt, -3, tr2.from_edge.new_total, tr2.timestamp], ['transfer_in', u2.vt, 3, tr2.to_edge.new_total, tr2.timestamp]], 'journaled as applied');
  const rc = ok(await call('GET', `/transfers/${u2.vt}`, null, C.agent));
  assert.deepEqual(Object.keys(rc.signatures).sort(), ['from_recipient_to', 'issuer_to', 'to_recipient', 'to_recipient_prior'].sort(), 'the payee\'s receipt');
  assert.equal(rc.signatures.issuer_to, tr2.slots.issuer_to.signature);
  assert.equal((await view(C, u2.id)).status, 'paid_by_transfer');
  refused(await call('POST', `/owner/deals/${u2.id}/attempts/${u2.vt}/resolve`, {outcome: 'not_applied'}, B.owner), 409, 'wrong_state');
  // An attempt in any other state is not the owner's to resolve.
  const id3 = await delivered(B, C, 1), vt3 = ok(await pay(B, id3, A3)).transfer.id;
  assert.equal(T_(vt3).state, 'applied');
  refused(await call('POST', `/owner/deals/${id3}/attempts/${vt3}/resolve`, {outcome: 'not_applied'}, B.owner), 409, 'wrong_state');
});

test('D-1 item 4: a bound note held past the tracker\'s maximum age fails at release (novation_expired, note_failed); a transfer then waits until its timestamp + 1 h + 60 s; the payer signs a new bound note', async t => {
  if (!live(t)) return;
  // Built 65 minutes in the past (this server's clock): the held bound note is then more than an hour old at the tracker,
  // with 5 minutes to spare for any skew between this clock and the tracker's.
  const boundComplete = async (P, id, tpl) => call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, tpl.message_hex, P.secret), prior_total: tpl.prior_total,
      prior_timestamp: tpl.prior_timestamp, prior_signature: await basis.signHex(P.pubkey, await boundAck(tpl), P.secret)}}, P.agent);
  let A, B, C, id, ts;
  clockOffset = -65 * MIN;
  try {
    A = await party('b-a', {serverRun: true}); B = await party('b-b', {mandate: {review_deliveries: true}}); C = await party('b-c', {serverRun: true});
    await owes(A, B, 5);                                                 // A's own note to B (A does not review its deliveries)
    id = await delivered(B, C, 3);
    const tpl = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, B.agent));
    ts = tpl.timestamp;
    assert.equal(ts % 1000, 997);
    assert.equal(ok(await boundComplete(B, id, tpl)).status, 'completion_awaiting_owner');
  } finally { clockOffset = 0; }
  // The owner approves an hour later: the tracker refuses the note as expired; the read-back shows it did not apply.
  const ap = ok(await call('GET', '/owner', null, B.owner)).approvals.find(a => a.deal_id === id && a.state === 'pending');
  // The tracker's own answer, as it is sent: its text must never be stored or shown (decision D-2 f), only its status and code.
  let raw = null;
  basis.api = async function (m, p, b) { const r = await Object.getPrototypeOf(basis).api.call(this, m, p, b); if (m === 'POST' && p === '/notes') raw = r.json; return r; };
  let dec;
  try { dec = ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, B.owner)); } finally { delete basis.api; }
  assert.equal(dec.deal.status, 'note_failed');
  assert.equal(pilot.s.deals[id].credit_note.error_code, 'novation_expired');
  assert.equal(await edge(B, C), null);
  assert.ok(typeof raw?.error === 'string' && raw.error.length > 0 && raw.code === 'novation_expired', JSON.stringify(raw));
  const cn = pilot.s.deals[id].credit_note;
  assert.deepEqual([cn.error, cn.error_code, cn.tracker_status], ['the tracker did not record the note (HTTP 400, novation_expired)', 'novation_expired', 400]);
  for (const [what, text] of [['the deal record', JSON.stringify(pilot.s.deals[id])], ['the payer\'s view', JSON.stringify(dec.deal)], ['the payee\'s view', JSON.stringify(await view(C, id))]])
    assert.ok(!text.includes(raw.error), `${what}: no tracker text`);
  // The failed bound note could still apply until ts + 1 h at the tracker: another kind of payment waits until
  // ts + 1 h + 60 s (here on this server's clock, set back).
  clockOffset = -50 * MIN;
  try {
    const w = refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'transfer_window_open');
    assert.ok(Math.abs(w.retry_after_ms - (ts + MAX_AGE_MS + FALLBACK_MARGIN_MS - now())) < 5000, JSON.stringify(w));
    assert.equal(ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).held_notes.find(h => h.issuer.id === A.id).why_not, 'transfer_window_open');
  } finally { clockOffset = 0; }
  assert.equal((await template(B, id, A)).amount, 3, 'afterwards the transfer may be signed');
  // The same kind again (a new bound note on the same prior) is allowed at once.
  await setMandate(B, {review_deliveries: false});
  const tpl2 = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, B.agent));
  assert.equal(tpl2.prior_total, 0);
  assert.equal(ok(await boundComplete(B, id, tpl2)).status, 'note_issued');
  assert.equal((await edge(B, C)).total, 3);
  // complete() refuses a bound note older than the maximum age outright (409 stale_note, nothing recorded).
  const C3 = await party('b-c3'), id3 = await delivered(B, C3, 1), d3 = await view(B, id3), old = now() - MAX_AGE_MS - 5000, oldTs = old - (old % 1000) - 3;
  assert.equal(oldTs % 1000, 997);
  const stale = refused(await call('POST', `/deals/${id3}/complete`, {terms_hash: d3.agreement.terms_hash, deliverable_sha256: d3.delivery.sha256,
    signature: await sign(B, statements.complete(d3.agreement.terms_hash, d3.delivery.sha256)),
    credit_note: {total: 1, timestamp: oldTs, signature: '02' + '1'.repeat(128), prior_total: 0, prior_signature: '02' + '2'.repeat(128)}}, B.agent), 409, 'stale_note');
  assert.match(stale.message, /more than one hour old/);
  assert.equal(stale.template?.timestamp % 1000, 997, 'with a fresh bound template');
  assert.deepEqual([pilot.s.deals[id3].status, pilot.s.deals[id3].completion ?? null], ['delivered', null]);
});

// =================================================================================================================
// The pay_by_transfer approval (design §4.8, spec 18.11); the deal views, the inbox, the positions, /me and /owner with
// circulation on (spec 10.4, 14.4, 16.1, 18.14).
const SETTLEMENT = 'not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, there is no reserve, and PC have no value.';
const WITHHELD_TEXT = 'withheld until the Basis tracker records the transfer; then each party sees the signatures on its own edges';
const INBOX_KEYS_ON = ['respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed', 'consents_waiting_for_your_client', 'payments_in_progress'];
const pendingApproval = async (P, dealId) => {
  const a = ok(await call('GET', '/owner', null, P.owner)).approvals.find(x => x.deal_id === dealId && x.state === 'pending');
  assert.ok(a, `${P.handle}'s owner has a pending approval for ${dealId}`);
  return a;
};
const decide = (P, a, decision, note) => call('POST', `/owner/approvals/${a.id}`, {decision, ...(note ? {note} : {})}, P.owner);
const policyOf = m => ({auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked', ...m});

test('pay_by_transfer approval: review_deliveries holds the payment (nobody else signs yet); GET /owner shows exactly what is approved; the owner approves and the server-run issuer and payee sign, so it applies in that request', async t => {
  if (!live(t)) return;
  const A = await party('pa-a', {serverRun: true}), B = await party('pa-b', {mandate: {review_deliveries: true}}), C = await party('pa-c', {serverRun: true});
  await owes(A, B, 5);
  const id = await delivered(B, C, 3);
  assert.deepEqual([(await view(B, id)).next_actions, (await view(C, id)).next_actions], [['complete', 'pay_by_transfer', 'dispute'], []], 'delivered');
  const tpl = await template(B, id, A), body = await payBody(B, tpl);
  const r = ok(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent)), vt = r.transfer.id;
  assert.deepEqual([r.status, r.transfer.state, r.next_actions], ['completion_awaiting_owner', 'awaiting_owner', ['wait_for_owner_approval']]);
  assert.ok(TRANSFER_SLOTS.filter(s => s.role !== 'payer').every(s => !T_(vt).slots[s.name]), 'the server-run parties sign only once the owner approves');
  const payment = {method: 'transfer', state: 'awaiting_owner', transfer_id: vt, issuer: {id: A.id, handle: A.handle}, amount: 3, expires_at: T_(vt).expires_at, fallback_after: null,
    signatures_withheld: WITHHELD_TEXT};
  assert.deepEqual(r.payment, payment, "the payer's view: the payment block");
  const cv = await view(C, id);
  assert.deepEqual([cv.payment, cv.next_actions, cv.labels.settlement], [payment, ['wait_for_owner_approval'], SETTLEMENT], "the payee's view");
  // GET /owner: 200, with the pending approval, exactly what it approves, and what each decision does
  const own = ok(await call('GET', '/owner', null, B.owner));
  const ap = own.approvals.find(a => a.deal_id === id && a.state === 'pending'), d0 = pilot.s.deals[id], s = ap.subject;
  assert.equal(ap.kind, 'pay_by_transfer');
  assert.deepEqual(Object.keys(s), ['what', 'version', 'terms', 'terms_hash', 'signer', 'signer_pubkey', 'statement', 'signature', 'signed_at', 'mandate_check', 'delivery', 'transfer', 'completion']);
  assert.deepEqual([s.what, s.version, s.terms, s.terms_hash, s.signer, s.signer_pubkey], ['payment_by_transfer', 1, d0.agreement.terms, d0.agreement.terms_hash, B.id, B.pubkey]);
  assert.deepEqual([s.statement, s.signature], [circulationStatements.pay(id, tpl.quote_digest), body.pay_signature], 'the pay statement and the agent\'s signature over it');
  assert.ok(await basis.verify(B.pubkey, hex(s.statement), s.signature), 'it verifies with the agent\'s key');
  assert.deepEqual(s.completion, {statement: statements.complete(tpl.terms_hash, tpl.deliverable_sha256), signature: body.completion_signature});
  assert.deepEqual([s.delivery.sha256, s.delivery.content], [tpl.deliverable_sha256, d0.delivery.content]);
  const who = P => ({id: P.id, handle: P.handle, pubkey: P.pubkey});
  assert.deepEqual(s.transfer, {id: vt, state: 'awaiting_owner', issuer: who(A), payer: who(B), payee: who(C), amount: 3,
    from_edge: {edge: `${A.pubkey}>${B.pubkey}`, issuer: who(A), recipient: who(B), before: tpl.from_edge.before, new_total: 2, change: -3},
    to_edge: {edge: `${A.pubkey}>${C.pubkey}`, issuer: who(A), recipient: who(C), before: null, new_total: 3, change: 3},
    timestamp: tpl.timestamp, quote_digest: tpl.quote_digest, expires_at: T_(vt).expires_at});
  assert.equal(ap.effect.if_approved, `The transfer is submitted once ${A.handle} and ${C.handle} sign: ${A.handle} then owes ${C.handle} 3 PC more and you 3 PC less; you issue no credit note.`);
  // The D-1 wait is part of what a rejection means (fix 16): any payment only after T + 1 h + 60 s, except one through
  // the same note while it is as this payment found it (the same-prior exemption).
  assert.equal(ap.effect.if_rejected, `Nothing moves. The deal returns to delivered: your agent may accept again (paying only after ${new Date(tpl.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS).toISOString()}, with its own credit note or any note it holds (${A.handle}'s included), since the tracker could still apply this payment until one hour after its timestamp; through ${A.handle}'s note at once, but only while ${A.handle}'s note to you is exactly as this payment found it (the tracker applies at most one of the two)) or dispute.`);
  assert.match(ap.effect.checks_on_approve, /totals, timestamps and signatures/); assert.match(ap.effect.checks_on_approve, /keys/); assert.match(ap.effect.checks_on_approve, /accepts/);
  assert.equal(ap.deal.status, 'completion_awaiting_owner');
  assert.deepEqual(Object.keys(own).slice(-2), ['credit_policy', 'features'], '/owner adds the credit policy and the features');
  assert.deepEqual(own.credit_policy, policyOf({}));
  // the inbox: the approval is deal-bound (awaiting_your_owner); the payment is under way for both parties
  const ib = ok(await call('GET', '/inbox', null, B.agent));
  assert.deepEqual(Object.keys(ib), INBOX_KEYS_ON);
  assert.deepEqual(ib.awaiting_your_owner.find(x => x.deal_id === id), {approval_id: ap.id, deal_id: id, kind: 'pay_by_transfer', version: 1, terms_hash: d0.agreement.terms_hash,
    title: d0.agreement.terms.service.title, price: {amount: 3, unit: 'PC'}});
  assert.deepEqual(ib.payments_in_progress.map(x => [x.deal_id, x.status, x.payment]), [[id, 'completion_awaiting_owner', payment]]);
  assert.equal(ib.consents_waiting_for_your_client, 0);
  for (const k of ['respond', 'deliver', 'review_delivery', 'waiting_on_others', 'recent_closed']) assert.ok(!ib[k].some(x => x.deal_id === id), `not in ${k}`);
  assert.deepEqual(ok(await call('GET', '/inbox', null, C.agent)).payments_in_progress.map(x => x.deal_id), [id]);
  assert.deepEqual(ok(await call('GET', '/inbox', null, B.owner)).awaiting_your_owner.map(x => x.kind), ['pay_by_transfer']);
  // the payer's own position: one payment in progress; A's note is held whole by it, so nothing of it is spendable now
  const pos = ok(await call('GET', '/me', null, B.agent)).position;
  assert.deepEqual(pos.pending, {paying_by_transfer: 1, consents_waiting_for_you: 0, consents_waiting_for_others: 0});
  assert.deepEqual(pos.spendable_notes, [{issuer_id: A.id, issuer_handle: A.handle, issuer_pubkey: A.pubkey, outstanding: 5, reserved: 3, spendable: 0, issuer_consents: 'immediate'}]);
  // approve: A and C (server-run) sign; every slot is signed; it is applied in this request
  const dec = ok(await decide(B, ap, 'approve', 'fine'));
  assert.deepEqual([dec.approval.state, dec.approval.note, dec.deal.status, dec.transfer.state, dec.transfer.result.code], ['approved', 'fine', 'paid_by_transfer', 'applied', 'applied']);
  assert.deepEqual([(await edge(A, B)).total, (await edge(A, C)).total], [2, 3]);
  refused(await decide(B, ap, 'approve'), 409, 'not_pending', 'decided once');
  const after = await view(C, id);
  assert.equal(after.labels.basis, `${A.handle} now owes ${C.handle} 3 PC that it owed ${B.handle} before; ${B.handle} issued no credit note for this deal`);
  assert.deepEqual([after.payment.state, after.payment.signatures_withheld, after.next_actions], ['applied', null, []]);
  assert.ok(after.history.some(e => e.event === 'owner_approved' && e.kind === 'pay_by_transfer'));
  assert.deepEqual(ok(await call('GET', '/inbox', null, B.agent)).payments_in_progress, [], 'no longer in progress');
  assert.equal(ok(await call('GET', '/me', null, B.agent)).position.pending.paying_by_transfer, 0);
});

test('pay_by_transfer approval with a client issuer and payee: approving starts the collection (a new window, at most until T + 50 min); next_actions, the inbox and the positions follow it; their consents apply it', async t => {
  if (!live(t)) return;
  const A = await party('pb-a', {roles: 'issuer'}), B = await party('pb-b', {mandate: {review_deliveries: true}}), C = await party('pb-c', {roles: 'creditor'});
  await owes(A, B, 6);
  const id = await delivered(B, C, 4), vt = ok(await pay(B, id, A)).transfer.id, first = Date.parse(T_(vt).expires_at);
  assert.equal(ok(await call('GET', '/consents', null, A.agent)).consents.length, 0, 'nothing to sign while the payer\'s owner decides');
  assert.equal(ok(await call('GET', '/inbox', null, A.agent)).consents_waiting_for_your_client, 0);
  clockOffset = 10 * MIN;                                                // the owner decides 10 minutes later
  try {
    const dec = ok(await decide(B, await pendingApproval(B, id), 'approve'));
    assert.deepEqual([dec.deal.status, dec.transfer.state, dec.deal.next_actions], ['paying_by_transfer', 'collecting', ['wait_for_consents', 'cancel_transfer']]);
    const exp = Date.parse(T_(vt).expires_at);
    assert.ok(exp > first && exp === Math.min(Date.parse(dec.approval.decided_at) + 20 * MIN, T_(vt).timestamp + 50 * MIN), `a new collection window: ${T_(vt).expires_at}`);
    assert.deepEqual((await view(C, id)).next_actions, ['wait_for_consents']);
    for (const [P, mine, others] of [[A, 1, 0], [B, 0, 1], [C, 1, 0]]) {
      const ib = ok(await call('GET', '/inbox', null, P.agent));
      assert.deepEqual([ib.consents_waiting_for_your_client, Object.keys(ib)], [mine, INBOX_KEYS_ON], `${P.handle}'s inbox`);
      const pend = ok(await call('GET', '/me', null, P.agent)).position.pending;
      assert.deepEqual([pend.consents_waiting_for_you, pend.consents_waiting_for_others, pend.paying_by_transfer], [mine, others, P === B ? 1 : 0], `${P.handle}'s pending`);
    }
    ok(await consent(A, vt));
    assert.equal(ok(await call('GET', '/inbox', null, A.agent)).consents_waiting_for_your_client, 0, 'signed: nothing left for its client');
    assert.equal(ok(await call('GET', '/me', null, A.agent)).position.pending.consents_waiting_for_others, 1);
    assert.equal(ok(await consent(C, vt)).state, 'applied');
  } finally { clockOffset = 0; }
  assert.equal((await view(B, id)).status, 'paid_by_transfer');
  assert.deepEqual([(await edge(A, B)).total, (await edge(A, C)).total], [2, 4]);
});

test('pay_by_transfer approval rejected: the transfer is void_rejected and purged, the deal returns to delivered (completion cleared); every other payment waits for the window (D-1), except one through the same note on the same prior state (the same-prior exemption); a dispute is possible', async t => {
  if (!live(t)) return;
  const A = await party('pr-a', {serverRun: true}), B = await party('pr-b', {mandate: {review_deliveries: true}}), C = await party('pr-c', {serverRun: true});
  await owes(A, B, 5);
  const id = await delivered(B, C, 2), tpl = await template(B, id, A), body = await payBody(B, tpl);
  const vt = ok(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent)).transfer.id, ap = await pendingApproval(B, id);
  const dec = ok(await decide(B, ap, 'reject', 'not with this note'));
  assert.deepEqual([dec.approval.state, dec.approval.note, dec.deal.status, dec.deal.completion, dec.transfer.state, dec.transfer.result.code],
    ['rejected', 'not with this note', 'delivered', null, 'void_rejected', 'rejected_by_owner']);
  const tr = T_(vt);
  assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature), 'purged');
  assert.deepEqual(tr.signature_sha256, {from_recipient_prior: SIGSHA(body.signatures[`${A.pubkey}>${B.pubkey}:prior`]), from_recipient: SIGSHA(body.signatures[`${A.pubkey}>${B.pubkey}:new`]),
    from_recipient_to: SIGSHA(body.signatures[`${A.pubkey}>${C.pubkey}:new`])}, 'their sha256 kept');
  assert.equal(tr.fallback_after, tr.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS);
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [5, null], 'nothing moved');
  const v = await view(B, id);
  assert.deepEqual([v.status, v.next_actions, v.payment.state, v.payment.fallback_after], ['delivered', ['wait_for_transfer_window', 'pay_by_transfer', 'dispute'], 'void_rejected',
    new Date(tr.fallback_after).toISOString()]);
  assert.ok(v.history.some(e => e.event === 'owner_rejected' && e.kind === 'pay_by_transfer') && v.history.some(e => e.event === 'payment_void'));
  assert.ok(!v.history.some(e => e.note !== undefined), 'the owner\'s note stays on the approval');
  const seen = ok(await call('GET', '/owner', null, B.owner)).approvals.find(a => a.id === ap.id);
  assert.deepEqual([seen.state, seen.subject.what, seen.subject.transfer.state, seen.note], ['rejected', 'payment_by_transfer', 'void_rejected', 'not with this note']);
  assert.deepEqual(ok(await call('GET', '/inbox', null, B.agent)).payments_in_progress, []);
  // D-1: the payer signed its slots, so its own note waits until T + 1 h + 60 s; the same note on the same prior state
  // at a new T does not (at the tracker at most one of the two can apply).
  const w = refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'transfer_window_open');
  assert.ok(Math.abs(w.retry_after_ms - (tr.fallback_after - now())) < 5000, JSON.stringify(w));
  const ws = await template(B, id, A);
  assert.deepEqual([ws.timestamp > tr.timestamp, ws.from_edge.before], [true, tr.from_edge.before], 'the same note on the same prior state: a template at once');
  const po = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent));
  assert.deepEqual([po.own_note.why_not, po.held_notes.find(h => h.issuer.id === A.id).why_not], ['transfer_window_open', null]);
  // the acceptance never stood: the payer may dispute
  const d = await view(B, id);
  assert.equal(ok(await call('POST', `/deals/${id}/dispute`, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, reason: 'wrong',
    signature: await sign(B, statements.dispute(d.agreement.terms_hash, d.delivery.sha256, 'wrong'))}, B.agent)).status, 'disputed');
});

test('pay_by_transfer approval gone stale: a moved edge or a changed policy makes it 409 stale_payment (approval and transfer void_stale, purged; the deal back to delivered; nothing moved); a signer outage changes nothing', async t => {
  if (!live(t)) return;
  const A = await party('ps-a', {serverRun: true}), A2 = await party('ps-a2', {serverRun: true}), A3 = await party('ps-a3', {serverRun: true});
  const B = await party('ps-b', {mandate: {review_deliveries: true}}), C = await party('ps-c', {serverRun: true});
  await owes(A, B, 6); await owes(A2, B, 4); await owes(A3, B, 6);
  // 1. The server-run parties cannot sign just now: 503, nothing changes and the approval stays pending.
  const id0 = await delivered(B, C, 1), vt0 = ok(await pay(B, id0, A)).transfer.id, ap0 = await pendingApproval(B, id0);
  const signer = pilot.serverSigner, state = () => JSON.stringify([pilot.s.deals[id0], T_(vt0), pilot.s.approvals[ap0.id]]), before = state();
  pilot.serverSigner = {has: signer.has, signFor: async () => { throw new Error('signer down'); }};
  try { refused(await decide(B, ap0, 'approve'), 503, 'signer_unavailable'); } finally { pilot.serverSigner = signer; }
  assert.equal(state(), before, 'nothing changed');
  assert.equal(ok(await decide(B, ap0, 'approve')).deal.status, 'paid_by_transfer', 'decided once the signer is back');
  // 2. A3's note to B moves (an ordinary note around Valun: A3->B was never novated, so it is not bound-only) while the
  //    owner decides.
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A3)).transfer.id, ap = await pendingApproval(B, id);
  const ab = await edge(A3, B), ac = await edge(A3, C);
  const moved = await basis.issueNote({issuer: A3.pubkey, recipient: B.pubkey, total: ab.total + 1, secretHex: A3.secret});
  assert.equal(moved.response.success, true, JSON.stringify(moved.response));
  const st = refused(await decide(B, ap, 'approve'), 409, 'stale_payment');
  assert.deepEqual([st.reason, st.transfer_id, st.deal_status], ['edge_changed', vt, 'delivered']);
  const d = pilot.s.deals[id], tr = T_(vt);
  assert.deepEqual([pilot.s.approvals[ap.id].state, tr.state, tr.result.code, d.status, d.completion], ['void_stale', 'void_stale', 'edge_changed', 'delivered', null]);
  assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature), 'purged');
  assert.deepEqual([(await edge(A3, B)).total, await edge(A3, C)], [ab.total + 1, ac], 'nothing moved');
  const sv = await view(B, id);
  assert.ok(sv.history.some(e => e.event === 'owner_approval_void_stale' && e.kind === 'pay_by_transfer'));
  // Since release v16.1 next_actions judge the payment as the route does, with the tracker's state of A3's note (it moved
  // around Valun: another prior state of it), so they no longer offer a transfer the route refuses (the window). Release
  // v16 read Valun's journal there, which still showed the note as the attempt found it, and offered pay_by_transfer.
  assert.deepEqual([sv.status, sv.next_actions, sv.payment.state], ['delivered', ['wait_for_transfer_window', 'dispute'], 'void_stale']);
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A3.id}`, null, B.agent), 409, 'transfer_window_open', 'the moved note: another prior state');
  refused(await decide(B, ap, 'approve'), 409, 'not_pending');
  // 3. The payee's owner stops accepting transfers while the payer's owner decides: the payee's rule is named, its policy is not.
  const id3 = await delivered(B, C, 2), vt3 = ok(await pay(B, id3, A2)).transfer.id, ap3 = await pendingApproval(B, id3);
  await setMandate(C, {accept_transfers: false});
  try {
    const s3 = refused(await decide(B, ap3, 'approve'), 409, 'stale_payment');
    assert.deepEqual([s3.reason, s3.rule, s3.by], ['payment_not_accepted', 'accept_transfers', 'payee']);
  } finally { await setMandate(C, {accept_transfers: true}); }
  assert.deepEqual([T_(vt3).state, T_(vt3).result.code, T_(vt3).result.rule, pilot.s.deals[id3].status], ['void_stale', 'payment_not_accepted', 'accept_transfers', 'delivered']);
  assert.deepEqual((await edge(A2, B)).total, 4, 'nothing moved');
});

test('pay_by_transfer approval from payment_due: a rejection or a stale approval returns the deal to payment_due (the acceptance stands, the completion is kept); the effect text says so', async t => {
  if (!live(t)) return;
  const A = await party('pd-a', {roles: 'issuer'}), B = await party('pd-b'), C = await party('pd-c', {roles: 'creditor'});
  // Each attempt is on the same prior state of the same note (the same-prior exemption: none waits for the previous
  // one); the first is made on this server's clock 124 minutes behind and the second 62 minutes behind (neither reaches
  // the tracker; it accepts old ordinary notes), the third on the real clock.
  clockOffset = -124 * MIN;
  let id, second, ap;
  try {
    await owes(A, B, 6);
    id = await delivered(B, C, 2);
    ok(await pay(B, id, A));
    ok(await call('POST', `/deals/${id}/cancel-transfer`, {}, B.agent));
    const due = await view(B, id);
    assert.deepEqual([due.status, due.next_actions, (await view(C, id)).next_actions], ['payment_due', ['wait_for_transfer_window', 'pay_by_transfer'], []]);
    assert.equal((await template(B, id, A)).from_edge.before.total, 6, 'the same note at once (the same prior state)');
    clockOffset = -62 * MIN;
    await setMandate(B, {review_deliveries: true});
    second = ok(await pay(B, id, A));                                      // the same note on the same prior state
    assert.deepEqual([second.status, second.transfer.state], ['completion_awaiting_owner', 'awaiting_owner']);
    ap = await pendingApproval(B, id);
    assert.equal(ap.effect.if_rejected, `Nothing moves. The deal returns to payment_due: the delivery stays accepted, and your agent must still pay it (only after ${new Date(T_(second.transfer.id).timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS).toISOString()}, with its own credit note or any note it holds (${A.handle}'s included), since the tracker could still apply this payment until one hour after its timestamp; through ${A.handle}'s note at once, but only while ${A.handle}'s note to you is exactly as this payment found it (the tracker applies at most one of the two)).`);
    const dec = ok(await decide(B, ap, 'reject'));
    assert.deepEqual([dec.deal.status, dec.deal.completion?.by, dec.transfer.state], ['payment_due', B.id, 'void_rejected'], 'the acceptance stands');
    const d = await view(B, id);
    refused(await call('POST', `/deals/${id}/dispute`, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, reason: 'late',
      signature: await sign(B, statements.dispute(d.agreement.terms_hash, d.delivery.sha256, 'late'))}, B.agent), 409, 'wrong_state', 'no dispute after an acceptance stood');
  } finally { clockOffset = 0; }
  // A stale one: A's note to C appears (a note around Valun) while the owner decides.
  const third = ok(await pay(B, id, A));
  assert.equal(third.transfer.attempt, 3);
  ap = await pendingApproval(B, id);
  const toC = await basis.issueNote({issuer: A.pubkey, recipient: C.pubkey, total: 1, secretHex: A.secret});
  assert.equal(toC.response.success, true, JSON.stringify(toC.response));
  assert.equal(refused(await decide(B, ap, 'approve'), 409, 'stale_payment').reason, 'edge_changed');
  assert.deepEqual([pilot.s.deals[id].status, pilot.s.deals[id].completion?.by, T_(third.transfer.id).state], ['payment_due', B.id, 'void_stale']);
  notAccepted(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 'payer', 'max_attempts_per_deal', 'three attempts in 24 hours');
});

test('views with circulation on: credit_note.pair_changes_since lists the transfers on a note\'s pair; /me and /owner add credit_policy and features; the own position adds spendable_notes and pending, the public one does not', async t => {
  if (!live(t)) return;
  const A = await party('pv-a', {serverRun: true}), B = await party('pv-b', {roles: 'setoff,issuer,creditor'}), C = await party('pv-c', {serverRun: true});
  const noteDeal = await owes(A, B, 5);                                    // the deal whose note B holds: A->B 5
  for (const P of [A, B]) assert.deepEqual((await view(P, noteDeal)).credit_note.pair_changes_since, [], `${P.handle}: nothing moved yet`);
  const id = await delivered(B, C, 3), r = ok(await pay(B, id, A)), vt = r.transfer.id;   // applied at once: A and C are server-run
  assert.equal(r.status, 'paid_by_transfer');
  for (const P of [A, B]) {
    const v = await view(P, noteDeal);
    assert.deepEqual(v.credit_note.pair_changes_since, [{kind: 'transfer_out', ref: vt, delta: -3}], `${P.handle}: part of the note moved to ${C.handle}`);
    assert.deepEqual([v.credit_note.outstanding, v.credit_note.amount, v.payment, v.labels.settlement], [true, 5, null, SETTLEMENT], 'the note as it was recorded; no payment by transfer');
  }
  assert.equal((await view(B, noteDeal)).credit_note.tracker_note.amount_collected, 5, 'the recorded note itself is unchanged');
  // /me and /owner
  const me = ok(await call('GET', '/me', null, B.agent));
  assert.deepEqual(Object.keys(me).slice(-2), ['credit_policy', 'features']);
  assert.deepEqual(me.credit_policy, policyOf({}));
  assert.deepEqual([me.features.server, me.features.consent_roles, me.features.server_run], [['bound_notes/1', 'circulation/1', 'guarantees/1'], ['setoff', 'issuer', 'creditor'], false]);
  assert.ok(Date.parse(me.features.consents_count_until) - Date.parse(me.features.consents_declared_at) === 7 * 24 * H);
  const ma = ok(await call('GET', '/me', null, A.agent)).features;
  assert.deepEqual([ma.consent_roles, ma.server_run], [['setoff', 'issuer', 'creditor'], true], 'a server-run participant signs every role');
  const o = ok(await call('GET', '/owner', null, B.owner));
  assert.deepEqual([Object.keys(o).slice(-2), o.credit_policy, o.features], [['credit_policy', 'features'], me.credit_policy, me.features]);
  // positions: the participant's own adds spendable_notes and pending; the public one does not
  const spend = {issuer_id: A.id, issuer_handle: A.handle, issuer_pubkey: A.pubkey, outstanding: 2, reserved: 0, spendable: 2, issuer_consents: 'immediate'};
  assert.deepEqual([me.position.spendable_notes, o.position.spendable_notes], [[spend], [spend]]);
  assert.deepEqual(me.position.pending, {paying_by_transfer: 0, consents_waiting_for_you: 0, consents_waiting_for_others: 0});
  const keysOn = ['participant_id', 'unit', 'claims_held', 'owes', 'net', 'gross', 'cleared_by_setoff', 'transferred_in', 'transferred_out', 'novated_as_issuer', 'spendable_notes',
    'frozen_claims', 'pending', 'claims', 'debts', 'deals', 'settled', 'settled_how', 'backing', 'meaning'];
  assert.deepEqual(Object.keys(me.position), keysOn);
  const pub = ok(await call('GET', `/participants/${B.id}`)).public_position;
  // The public position also publishes the credit policy's predicate fields and the credit history (phase 2, SV-8).
  assert.deepEqual(Object.keys(pub), [...keysOn.filter(k => k !== 'spendable_notes' && k !== 'pending'), 'credit_policy', 'credit_history', 'evidence'], 'the public position shows no transfer in progress');
  assert.deepEqual(ok(await call('GET', '/me', null, C.agent)).position.spendable_notes, [{...spend, outstanding: 3, spendable: 3}], 'C holds A\'s note now');
  assert.deepEqual((await view(B, id)).payment.state, 'applied');
});

// A request that takes no lock (a read that sweeps), arriving while a call holding the lock awaits obj[name]: `during`
// runs once, right after the first call of obj[name] returns and before its caller resumes. Returns the undo.
function interleave(obj, name, during) {
  const own = Object.hasOwn(obj, name), orig = obj[name];
  let fired = false;
  obj[name] = async function (...args) {
    const r = await orig.apply(this, args);
    if (!fired) { fired = true; await during(); }
    return r;
  };
  return () => { if (own) obj[name] = orig; else delete obj[name]; };
}
const PAYEE_AND_ISSUER_SLOTS = TRANSFER_SLOTS.filter(s => s.role !== 'payer').map(s => s.name);

test('pay_by_transfer approval racing a read that sweeps: a held transfer that expires while the approval awaits the tracker or the server signer is neither revived nor ended twice (409 not_pending, nothing decided; the approval void_expired, the deal delivered with the completion cleared)', async t => {
  if (!live(t)) return;
  const A = await party('pz-a', {serverRun: true}), A2 = await party('pz-a2', {serverRun: true}), B = await party('pz-b', {mandate: {review_deliveries: true}}), C = await party('pz-c', {serverRun: true});
  await owes(A, B, 9); await owes(A2, B, 5);
  // [what, the call the approval awaits, the issuer, whether A2's note to B moves first (the approval would be stale),
  //  whether anyone reads meanwhile (if not, the window just ends: the approval itself must see that)]
  const cases = [['while it reads the tracker', () => [basis, 'note'], A, false, true], ['while the server signs', () => [pilot.serverSigner, 'signFor'], A, false, true],
    ['while it reads the tracker, stale', () => [basis, 'note'], A2, true, true], ['while the server signs, nobody reading', () => [pilot.serverSigner, 'signFor'], A, false, false]];
  for (const [what, at, I, stale, read] of cases) {
    const id = await delivered(B, C, 2), vt = ok(await pay(B, id, I)).transfer.id, ap = await pendingApproval(B, id);
    if (stale) { const ab0 = await edge(I, B); assert.equal((await basis.issueNote({issuer: I.pubkey, recipient: B.pubkey, total: ab0.total + 1, secretHex: I.secret})).response.success, true); }
    const ab = await edge(I, B), ac = await edge(I, C);
    let seen = null;
    const [obj, name] = at();
    const undo = interleave(obj, name, async () => {
      clockOffset = Date.parse(T_(vt).expires_at) - Date.now() + 1000;     // the collection window has just ended
      if (read) seen = await call('GET', `/deals/${id}`, null, C.agent);    // the payee reads the deal meanwhile: the read sweeps
    });
    let r;
    try { r = await decide(B, ap, 'approve'); } finally { undo(); clockOffset = 0; }
    assert.match(refused(r, 409, 'not_pending', what).message, /void_expired/, what);
    if (read) assert.deepEqual([seen.status, seen.body.status, seen.body.payment.state, seen.body.completion], [200, 'delivered', 'expired', null], `${what}: the read ended it`);
    const tr = T_(vt), d = pilot.s.deals[id];
    assert.deepEqual([pilot.s.approvals[ap.id].state, tr.state, tr.result.code, tr.fallback_after], ['void_expired', 'expired', 'expired', tr.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS], what);
    assert.deepEqual([d.status, d.completion, d.payment_due_since ?? null], ['delivered', null, null], `${what}: the acceptance never stood`);
    assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature) && PAYEE_AND_ISSUER_SLOTS.every(n => !(n in tr.slots)), `${what}: purged; no server signature recorded`);
    const events = d.history.map(e => e.event);
    assert.ok(events.includes('payment_void') && !events.some(e => e === 'owner_approved' || e === 'owner_approval_void_stale' || e === 'payment_due'), `${what}: ${events}`);
    assert.equal(ok(await call('GET', '/consents', null, B.agent)).consents.filter(x => x.id === vt).length, 0, `${what}: nothing for the payer to sign again`);
    assert.deepEqual([await edge(I, B), await edge(I, C)], [ab, ac], `${what}: nothing moved`);
    refused(await decide(B, ap, 'approve'), 409, 'not_pending', `${what}: decided never`);
    if (stale) {                                                            // the payer may dispute: its acceptance never stood
      const v = await view(B, id);
      // (A2's note moved around Valun: since release v16.1 next_actions read its state on the tracker, as the route does,
      // so a transfer through it, which the route refuses for the window, is not offered; release v16 offered it.)
      assert.deepEqual(v.next_actions, ['wait_for_transfer_window', 'dispute']);
      assert.equal(ok(await call('POST', `/deals/${id}/dispute`, {terms_hash: v.agreement.terms_hash, deliverable_sha256: v.delivery.sha256, reason: 'wrong',
        signature: await sign(B, statements.dispute(v.agreement.terms_hash, v.delivery.sha256, 'wrong'))}, B.agent)).status, 'disputed');
    }
  }
});

test('pay_by_transfer approval: every stale reason voids it (409 stale_payment; the approval and the transfer void_stale, purged; nothing moved): an edge changed at the same total (only its timestamp and signature), a key gone without the revocation that voids, a claim no longer spendable, and the D-1 codes of an earlier attempt', async t => {
  if (!live(t)) return;
  const A = await party('pt-a', {serverRun: true}), Af = await party('pt-af', {serverRun: true}), At = await party('pt-at', {serverRun: true});
  const B = await party('pt-b', {mandate: {review_deliveries: true}}), C = await party('pt-c', {serverRun: true});
  await owes(A, B, 9); await owes(Af, B, 5); await owes(At, B, 5); await owes(At, C, 1);
  const held = async I => { const id = await delivered(B, C, 1), vt = ok(await pay(B, id, I)).transfer.id; return {id, vt, ap: await pendingApproval(B, id)}; };
  const isStale = async ({id, vt, ap}, reason, what, status = 'delivered') => {
    const st = refused(await decide(B, ap, 'approve'), 409, 'stale_payment', what);
    assert.deepEqual([st.reason, st.transfer_id, st.deal_status], [reason, vt, status], what);
    const tr = T_(vt), d = pilot.s.deals[id];
    assert.deepEqual([pilot.s.approvals[ap.id].state, tr.state, tr.result.code, d.status], ['void_stale', 'void_stale', reason, status], what);
    assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature) && PAYEE_AND_ISSUER_SLOTS.every(n => !(n in tr.slots)), `${what}: purged; nobody else signed`);
    assert.ok(d.history.some(e => e.event === 'owner_approval_void_stale' && e.reason === reason), what);
    return st;
  };
  // 1. The same total, another note: Af re-issues its note to B (the held edge), and At its note to C (the destination
  //    edge), each at the total it had, at the tracker (ordinary notes around Valun; neither edge was ever novated).
  for (const [what, I, R] of [['the held edge', Af, B], ['the destination edge', At, C]]) {
    const h = await held(I), before = await edge(I, R);
    const again = await basis.issueNote({issuer: I.pubkey, recipient: R.pubkey, total: before.total, secretHex: I.secret});
    assert.equal(again.response.success, true, JSON.stringify(again.response));
    const now_ = await edge(I, R);
    assert.ok(now_.total === before.total && now_.timestamp > before.timestamp && now_.signature !== before.signature, `${what}: the same total, another note`);
    await isStale(h, 'edge_changed', `${what} at the same total`);
    assert.deepEqual([(await edge(I, B)).total, await edge(I, C)], [5, R === B ? null : now_], `${what}: nothing moved`);
  }
  // 2. A party's key is gone without the revocation that would have voided the payment (a state no route produces).
  const k = await held(A), q = pilot.s.participants[C.id];
  q.status = 'awaiting_agent';
  try { await isStale(k, 'key_changed', 'a key gone'); } finally { q.status = 'active'; }
  // 3. The held claim no longer reconciles exactly with Valun's journal (a state no route produces either).
  const sp = await held(A), e = pilot.s.edges[`${A.pubkey}>${B.pubkey}`];
  e.expected_total += 1;
  try { await isStale(sp, 'insufficient_claim', 'a claim no longer spendable'); } finally { e.expected_total -= 1; }
  // 4. D-1: an earlier attempt of the deal (rejected, so it ended without effect). On the same prior state of the same
  //    note it does not hold the second back (the same-prior exemption): the second is made at once. The first is then
  //    turned into one that can still apply on another prior state of the note (its recorded state's timestamp moved:
  //    a state no route produces), that might have applied, or that applied, and put back afterwards.
  const shift = d => x => { x.from_edge.before = {...x.from_edge.before, timestamp: x.from_edge.before.timestamp + d}; };
  for (const [code, change, undo] of [
    ['transfer_window_open', shift(-1), shift(1)],
    ['attempt_outcome_unknown', x => { x.state = 'outcome_unknown'; }, x => { x.state = 'void_rejected'; }],
    ['already_paid', x => { x.state = 'applied'; }, x => { x.state = 'void_rejected'; }]]) {
    const first = await held(A);
    ok(await decide(B, first.ap, 'reject'));
    const second = ok(await pay(B, first.id, A)).transfer.id;           // at once: the same prior state
    const h = {id: first.id, vt: second, ap: await pendingApproval(B, first.id)};
    change(T_(first.vt));
    try {
      await isStale(h, code, `D-1 ${code}`);
      // While an earlier attempt applied (or may have), no payment is offered.
      if (code !== 'transfer_window_open') assert.deepEqual((await view(B, h.id)).next_actions, [], `${code}: next_actions`);
    } finally { undo(T_(first.vt)); }
    assert.deepEqual((await view(B, h.id)).next_actions, ['wait_for_transfer_window', 'pay_by_transfer', 'dispute'], `${code}: as before once undone`);
  }
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [9, null], 'nothing moved');
});

test('pay_by_transfer approval whose transfer the tracker then refuses: the approval stands (200, as for a held credit note the tracker refuses); transfer.state and transfer.result name the outcome; nothing moved and the deal is payment_due', async t => {
  if (!live(t)) return;
  // Built 70 minutes in the past (this server's clock): when the owner approves, T is more than an hour old at the
  // tracker, which refuses the transfer (novation_expired), while this server still sees a fresh, held payment.
  clockOffset = -70 * MIN;
  try {
    const A = await party('pf-a', {serverRun: true}), B = await party('pf-b', {mandate: {review_deliveries: true}}), C = await party('pf-c', {serverRun: true});
    await owes(A, B, 4);
    const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id, ap = await pendingApproval(B, id);
    const dec = ok(await decide(B, ap, 'approve'));
    assert.deepEqual([dec.approval.state, dec.deal.status, dec.transfer.id, dec.transfer.state, dec.transfer.result.code, dec.transfer.result.tracker_status],
      ['approved', 'payment_due', vt, 'failed', 'novation_expired', 400]);
    assert.equal(dec.deal.completion.by, B.id, 'the owner approved the acceptance: it stands');
    assert.deepEqual([dec.deal.payment.state, dec.deal.next_actions], ['failed', ['wait_for_transfer_window', 'pay_by_transfer']], 'its edges did not move: the same note at once');
    assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [4, null], 'nothing moved');
    assert.ok(TRANSFER_SLOTS.every(s => !T_(vt).slots[s.name]?.signature), 'purged');
  } finally { clockOffset = 0; }
});

test('pay_by_transfer approval while circulation is switched off: the payment record survives the mode changes, GET /owner still shows the approval, and approving fails closed (409 stale_payment circulation_off: void_stale, purged, the deal delivered)', async t => {
  if (!live(t)) return;
  const A = await party('pm-a', {serverRun: true}), B = await party('pm-b', {mandate: {review_deliveries: true}}), C = await party('pm-c', {serverRun: true});
  await owes(A, B, 4);
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id, ap = await pendingApproval(B, id);
  const payment = structuredClone(pilot.s.deals[id].payment);
  assert.deepEqual(payment, {method: 'transfer', transfer_id: vt});
  let st;
  pilot.circulation = 'off';                                              // migrate() runs again
  try {
    assert.equal(pilot.mode, 'off');
    assert.deepEqual([pilot.s.deals[id].payment, pilot.s.deals[id].credit_note ?? null], [payment, null], 'a payment by transfer is never taken for a first-version note record');
    const seen = ok(await call('GET', '/owner', null, B.owner)).approvals.find(a => a.id === ap.id);
    assert.deepEqual([seen.state, seen.kind, seen.subject.what, seen.subject.transfer.id, seen.deal.status, 'payment' in seen.deal],
      ['pending', 'pay_by_transfer', 'payment_by_transfer', vt, 'completion_awaiting_owner', false]);
    st = refused(await decide(B, ap, 'approve'), 409, 'stale_payment');
  } finally { pilot.circulation = 'on'; }
  assert.deepEqual([st.reason, st.transfer_id, st.deal_status], ['circulation_off', vt, 'delivered']);
  const tr = T_(vt), d = pilot.s.deals[id];
  assert.deepEqual([pilot.s.approvals[ap.id].state, tr.state, tr.result.code, d.status, d.completion, d.payment], ['void_stale', 'void_stale', 'circulation_off', 'delivered', null, payment]);
  assert.ok(TRANSFER_SLOTS.every(s => !tr.slots[s.name]?.signature), 'purged');
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [4, null], 'nothing moved');
  assert.deepEqual((await view(B, id)).payment.state, 'void_stale');
});

test('a restart (a new Pilot over a copy of the saved state, built as server.mjs builds it) keeps every payment by transfer: the views, approvals and labels are the same; a held payment can be approved and another rejected; a collecting one applies with the consents given after it, and another can be cancelled', async t => {
  if (!live(t)) return;
  const A = await party('rs-a', {serverRun: true}), A3 = await party('rs-a3', {serverRun: true}), A4 = await party('rs-a4', {serverRun: true});
  const B = await party('rs-b'), C = await party('rs-c', {serverRun: true}), C3 = await party('rs-c3', {serverRun: true});
  const A2 = await party('rs-a2', {roles: 'issuer'}), A5 = await party('rs-a5', {roles: 'issuer'}), B2 = await party('rs-b2'), C2 = await party('rs-c2', {roles: 'creditor'});
  await owes(A, B, 5); await owes(A3, B, 5); await owes(A4, B, 5); await owes(A2, B2, 6); await owes(A5, B2, 4);
  const paid = await delivered(B, C3, 3), vtPaid = ok(await pay(B, paid, A3)).transfer.id;
  assert.equal(pilot.s.deals[paid].status, 'paid_by_transfer');
  await setMandate(B, {review_deliveries: true});
  const held1 = await delivered(B, C, 2), vt1 = ok(await pay(B, held1, A)).transfer.id, ap1 = await pendingApproval(B, held1);
  const held2 = await delivered(B, C, 1), vt2 = ok(await pay(B, held2, A4)).transfer.id, ap2 = await pendingApproval(B, held2);
  const collecting = await delivered(B2, C2, 2), vt3 = ok(await pay(B2, collecting, A2)).transfer.id;
  const toCancel = await delivered(B2, C2, 1), vt5 = ok(await pay(B2, toCancel, A5)).transfer.id;
  const deals = [[paid, vtPaid, B, C3, A3], [held1, vt1, B, C, A], [held2, vt2, B, C, A4], [collecting, vt3, B2, C2, A2], [toCancel, vt5, B2, C2, A5]];
  // What every party sees now, as an HTTP answer would carry it.
  const json = x => JSON.parse(JSON.stringify(x));
  const seenBy = (P, Q) => {
    const out = {};
    for (const [id, vt, payer, payee, issuer] of deals) {
      for (const R of [payer, payee]) out[`deal ${id} by ${R.handle}`] = json(P.view(P.s.deals[id], Q(R)));
      for (const R of [payer, payee, issuer]) out[`transfer ${vt} by ${R.handle}`] = json(P.transferView(P.s.transfers[vt], Q(R)));
    }
    for (const a of [ap1, ap2]) out[`approval ${a.id}`] = json(P.approvalView(P.s.approvals[a.id], Q(B)));
    for (const R of [B, B2, C, C2, A2]) { out[`inbox of ${R.handle}`] = json(P.inbox(Q(R))); out[`consents of ${R.handle}`] = json(P.consentsFor(Q(R))); }
    return out;
  };
  const before = seenBy(pilot, R => pilot.s.participants[R.id]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-transfer-restart-'));
  try {
    for (const f of fs.readdirSync(storeDir)) fs.copyFileSync(path.join(storeDir, f), path.join(dir2, f));
    // As server.mjs: constructed before the tracker's capabilities are read (migrate() runs with the mode pending), then
    // given them (migrate() runs again), then recovery.
    const p2 = new Pilot({store: new PilotStore(dir2), basis, now, circulation: 'on', trackerSha256: pilot.trackerSha256, log: m => logs.push(m)});
    p2.trackerCaps = pilot.trackerCaps;
    p2.serverSigner = pilot.serverSigner;
    assert.equal(p2.mode, 'on');
    const recovered = await p2.recover();
    assert.ok(!deals.some(([, vt]) => recovered.some(x => x.startsWith(vt))), JSON.stringify(recovered));
    const Q = R => p2.s.participants[R.id];
    for (const [id] of deals) assert.deepEqual([p2.s.deals[id].payment, p2.s.deals[id].credit_note ?? null], [pilot.s.deals[id].payment, null], `${id}: the payment record is kept`);
    const after = seenBy(p2, Q);
    for (const k of Object.keys(before)) assert.deepEqual(after[k], before[k], `${k}: the same after the restart`);
    const pv = after[`deal ${paid} by ${C3.handle}`];
    assert.deepEqual([pv.status, pv.payment.state, pv.credit_note, pv.labels.basis], ['paid_by_transfer', 'applied', null,
      `${A3.handle} now owes ${C3.handle} 3 PC that it owed ${B.handle} before; ${B.handle} issued no credit note for this deal`]);
    // The held payments: one approved (the server-run issuer and payee sign; applied in that call), the other rejected.
    const d1 = await p2.decideApproval(Q(B), ap1.id, {decision: 'approve'});
    assert.deepEqual([d1.approval.state, d1.deal.status, d1.transfer.state], ['approved', 'paid_by_transfer', 'applied']);
    const d2 = await p2.decideApproval(Q(B), ap2.id, {decision: 'reject'});
    assert.deepEqual([d2.approval.state, d2.deal.status, d2.deal.completion, d2.transfer.state], ['rejected', 'delivered', null, 'void_rejected']);
    // The collecting payment applies with the issuer's and the payee's consents given after the restart.
    for (const P of [A2, C2]) {
      const item = p2.consentsFor(Q(P)).consents.find(x => x.id === vt3);
      assert.ok(item, `${P.handle} has its consent item after the restart`);
      await p2.submitConsent(Q(P), vt3, await consentBody(P, item));
    }
    assert.deepEqual([p2.s.transfers[vt3].state, p2.s.deals[collecting].status, p2.view(p2.s.deals[collecting], Q(B2)).next_actions], ['applied', 'paid_by_transfer', []]);
    const cx = await p2.cancelTransfer(Q(B2), toCancel);
    assert.deepEqual([cx.status, cx.transfer.state], ['payment_due', 'cancelled']);
    assert.deepEqual([(await edge(A, B)).total, (await edge(A, C)).total, (await edge(A4, B)).total, await edge(A4, C), (await edge(A2, B2)).total, (await edge(A2, C2)).total,
      (await edge(A5, B2)).total, await edge(A5, C2)], [3, 2, 5, null, 4, 2, 4, null]);
    // This test's parties are not used again: the first Pilot still holds the state from before the restart.
  } finally { fs.rmSync(dir2, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
});

// =================================================================================================================
// Fix round after phase 1 (decisions D-1 and D-2).
// The payer's bound credit note for a template asked for with bound=1 (a 0.4 client: the note and its prior
// acknowledgment PA(I,R,prior_total,prior_timestamp,ts), which it rebuilds itself and which must be the template's).
async function boundCompleteBody(P, tpl, {termsHash = tpl.terms_hash} = {}) {
  return {terms_hash: termsHash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(termsHash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, tpl.message_hex, P.secret), prior_total: tpl.prior_total,
      prior_timestamp: tpl.prior_timestamp, prior_signature: await basis.signHex(P.pubkey, await boundAck(tpl), P.secret)}};
}
const boundTemplate = async (P, id) => ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, P.agent));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A payment body for template `tpl` at another timestamp T, the payer's slots signed at T (as a client would sign them).
async function payBodyAt(B, tpl, T) { return payBody(B, {...tpl, timestamp: T}); }

test('D-1 across kinds: the owner rejects a held bound note; a payment by transfer then waits until the note\'s timestamp + 1 h + 60 s (409 transfer_window_open; the approval\'s text, payment options and next_actions say so); once a later note on the pair followed the same prior, the journal proves it dead (D-2 e) and a transfer may start at once', async t => {
  if (!live(t)) return;
  const A = await party('hn-a', {serverRun: true}), B = await party('hn-b', {mandate: {review_deliveries: true}}), C = await party('hn-c', {serverRun: true});
  await owes(A, B, 5);
  const id = await delivered(B, C, 2), tpl = await boundTemplate(B, id);
  assert.equal(ok(await call('POST', `/deals/${id}/complete`, await boundCompleteBody(B, tpl), B.agent)).status, 'completion_awaiting_owner');
  const ap = await pendingApproval(B, id), until = tpl.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS;
  assert.ok(ap.effect.if_rejected.endsWith(` A payment by transfer can start only after ${new Date(until).toISOString()}: the tracker could still record this note until one hour after its timestamp.`), ap.effect.if_rejected);
  ok(await decide(B, ap, 'reject'));
  assert.equal(pilot.s.deals[id].status, 'delivered');
  const w = refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 409, 'transfer_window_open', 'the rejected note can still apply');
  assert.ok(Math.abs(w.retry_after_ms - (until - now())) < 5000, JSON.stringify(w));
  assert.equal(ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).held_notes.find(h => h.issuer.id === A.id).why_not, 'transfer_window_open');
  assert.deepEqual((await view(B, id)).next_actions, ['complete', 'wait_for_transfer_window', 'dispute']);
  // B pays C for another deal with a bound note on the same pair, recorded after the rejected note's timestamp and from
  // the same prior total: the rejected note never applied and never can (D-2 e).
  await setMandate(B, {review_deliveries: false});
  const other = await delivered(B, C, 1);
  while (now() < tpl.timestamp + 2600) await sleep(50);                  // a later timestamp ending in 997 ms
  const tpl2 = await boundTemplate(B, other);
  assert.ok(tpl2.timestamp > tpl.timestamp && tpl2.prior_total === tpl.prior_total, 'precondition: a later note from the same prior');
  assert.equal(ok(await call('POST', `/deals/${other}/complete`, await boundCompleteBody(B, tpl2), B.agent)).status, 'note_issued');
  assert.deepEqual((await view(B, id)).next_actions, ['complete', 'pay_by_transfer', 'dispute']);
  const paid = ok(await pay(B, id, A));
  assert.equal(paid.status, 'paid_by_transfer', 'at once');
});

test('D-2 b: a payment refused when posted is recorded as an attempt (timestamp, edges, prior states, signature sha256 only): after a refused transfer every other payment waits for its window, except a new one through the same note on the same prior state (the same-prior exemption), and after a refused bound note a transfer waits; a later journal entry from the attempt\'s prior proves it dead (D-2 e)', async t => {
  if (!live(t)) return;
  const A = await party('ra-a', {serverRun: true}), A2 = await party('ra-a2', {serverRun: true}), B = await party('ra-b'), C = await party('ra-c', {serverRun: true});
  await owes(A, B, 5); await owes(A2, B, 5);
  const id = await delivered(B, C, 2), tpl = await template(B, id, A), body = await payBody(B, tpl);
  refused(await call('POST', `/deals/${id}/pay-by-transfer`, {...body, quote_digest: 'a'.repeat(64)}, B.agent), 409, 'transfer_stale', 'a stale quote');
  const [rec] = pilot.s.deals[id].refused_attempts;
  assertRefusedRecord(rec, body, A, B, C, 5, 0, 2);
  assert.equal(rec.code, 'transfer_stale');
  assert.equal(Object.values(pilot.s.transfers).filter(x => x.deal_id === id).length, 0, 'no transfer recorded');
  const until = body.timestamp + MAX_AGE_MS + FALLBACK_MARGIN_MS;
  const w = refused(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent), 409, 'transfer_window_open', 'an own note waits');
  assert.ok(Math.abs(w.retry_after_ms - (until - now())) < 5000, JSON.stringify(w));
  refused(await call('GET', `/deals/${id}/transfer-template?issuer=${A2.id}`, null, B.agent), 409, 'transfer_window_open', 'another issuer waits');
  assert.equal(ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).own_note.why_not, 'transfer_window_open');
  assert.deepEqual((await view(B, id)).next_actions, ['wait_for_transfer_window', 'pay_by_transfer', 'dispute']);
  // Not before the refused post's T (the same 999 slot on a fast machine: a post refused before it was recorded does not
  // move later templates, transferAfter; then it is the identical operation, value-safe either way).
  const again = await template(B, id, A);
  assert.ok(again.timestamp >= body.timestamp && again.from_edge.before.timestamp === body.from_prior_timestamp, 'the same note on the same prior state: a template at once');
  assert.equal(pilot.paymentAttemptHolds().get(`${A.pubkey}>${B.pubkey}`), body.timestamp, 'the payer\'s claim is held for set-offs');
  // A buys from B: A's note to B is recorded after T, from the attempt's prior (5): the attempt can never apply.
  await sleep(10);
  await owes(A, B, 1);
  assert.equal(ok(await call('GET', `/deals/${id}/credit-note-template`, null, B.agent)).deal_id, id, 'proven dead by the journal: an own note at once');
  assert.equal((await template(B, id, A)).issuer.id, A.id, 'and a new transfer through the same note');
  // A bound note refused when posted (a stale terms hash; its signatures are valid) makes a payment by transfer wait.
  const id2 = await delivered(B, C, 1), nt = await boundTemplate(B, id2), nb = await boundCompleteBody(B, nt);
  refused(await call('POST', `/deals/${id2}/complete`, {...nb, terms_hash: 'f'.repeat(64)}, B.agent), 409, 'stale_terms');
  const [rn] = pilot.s.deals[id2].refused_attempts;
  assert.deepEqual([rn.kind, rn.bound, rn.timestamp, rn.edges, rn.code], ['note', true, nt.timestamp,
    [{edge: `${B.pubkey}>${C.pubkey}`, prior_total: nt.prior_total, prior_timestamp: nt.prior_timestamp, new_total: nt.total}], 'stale_terms']);
  assert.deepEqual(rn.signature_sha256, {note: SIGSHA(nb.credit_note.signature), prior: SIGSHA(nb.credit_note.prior_signature)});
  assert.ok(!JSON.stringify(rn).includes(nb.credit_note.signature) && !JSON.stringify(rn).includes(nb.credit_note.prior_signature), 'no signature in the record');
  refused(await call('GET', `/deals/${id2}/transfer-template?issuer=${A2.id}`, null, B.agent), 409, 'transfer_window_open', 'a transfer waits for the refused bound note');
  // A bad signature is no attempt: nothing is recorded for it.
  const id3 = await delivered(B, C, 1), n3 = await boundCompleteBody(B, await boundTemplate(B, id3));
  refused(await call('POST', `/deals/${id3}/complete`, {...n3, credit_note: {...n3.credit_note, signature: n3.credit_note.prior_signature}}, B.agent), 403, 'bad_signature');
  assert.equal(pilot.s.deals[id3].refused_attempts, undefined);
  // Another own note is not restricted by the server: the same deal's fresh note is issued.
  assert.equal(ok(await call('POST', `/deals/${id2}/complete`, await boundCompleteBody(B, await boundTemplate(B, id2)), B.agent)).status, 'note_issued');
});

test('a fully signed transfer whose apply never started (the process stopped between saving the last signature and the write-ahead) is applied by recover()', async t => {
  if (!live(t)) return;
  const A = await party('cr-a', {roles: 'issuer'}), B = await party('cr-b'), C = await party('cr-c', {roles: 'creditor'});
  await owes(A, B, 4);
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id;
  ok(await consent(A, vt));
  pilot.applyTransfer = async () => { throw new Error('simulated crash before the write-ahead'); };
  let r;
  try { r = await consent(C, vt); } finally { delete pilot.applyTransfer; }
  assert.equal(r.status, 502, JSON.stringify(r.body));
  const onDisk = JSON.parse(fs.readFileSync(path.join(storeDir, 'pilot-state.json'), 'utf8')).transfers[vt];
  assert.deepEqual([T_(vt).state, onDisk.state, pilot.transferComplete(T_(vt))], ['collecting', 'collecting', true], 'every slot signed, nothing applied');
  refused(await call('POST', `/consents/${vt}`, {signatures: {}}, C.agent), 409, 'already_signed', 'nobody can sign it any more');
  assert.ok((await pilot.recover()).includes(`${vt}:applied`));
  assert.deepEqual([pilot.s.deals[id].status, (await edge(A, B)).total, (await edge(A, C)).total], ['paid_by_transfer', 2, 2]);
});

test('rule R1 for the server signer: the server-run parties\' slots are signed over messages rebuilt from the transfer itself (its parties, totals and T), never over stored message hex', async t => {
  if (!live(t)) return;
  const A = await party('r1-a', {serverRun: true}), B = await party('r1-b', {mandate: {review_deliveries: true}}), C = await party('r1-c', {serverRun: true});
  await owes(A, B, 5);
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id, ap = await pendingApproval(B, id), tr = T_(vt);
  // The stored message of A->C:new damaged (another total): the server must not sign it.
  const AC = `${A.pubkey}>${C.pubkey}`, wrong = await msg(A.pubkey, C.pubkey, 999, tr.timestamp), right = await msg(A.pubkey, C.pubkey, 2, tr.timestamp);
  tr.messages[`${AC}:new`] = wrong;
  const signer = pilot.serverSigner, signed = [];
  pilot.serverSigner = {has: signer.has, signFor: async (pid, hexMsg, o) => { signed.push(hexMsg); return signer.signFor(pid, hexMsg, o); }};
  let dec;
  try { dec = ok(await decide(B, ap, 'approve')); } finally { pilot.serverSigner = signer; }
  assert.ok(!signed.includes(wrong) && signed.includes(right), 'signed over the rebuilt message');
  assert.deepEqual([dec.transfer.state, (await edge(A, C)).total], ['applied', 2]);
});

test('(c) more refusals: the payer\'s max_collecting_transfers; an expired mandate of the payer, the payee or the issuer; may_accept_credit; issuer_key; 503 signer_unavailable (nothing recorded but the attempt); a posted T more than 10 minutes old (the initiation window alone) or ahead of the clock (each recorded as a refused attempt), or not later than the edge\'s last note (no attempt: its prior acknowledgment can never be taken)', async t => {
  if (!live(t)) return;
  const A = await party('rx-a', {serverRun: true}), B = await party('rx-b'), C = await party('rx-c', {serverRun: true});
  const Q1 = await party('rx-q1', {roles: 'issuer'}), Q2 = await party('rx-q2', {roles: 'issuer'}), K = await party('rx-k', {serverRun: true});
  const C2 = await party('rx-c2', {roles: 'creditor'});
  await owes(A, B, 9); await owes(Q1, B, 3); await owes(Q2, B, 3); await owes(K, B, 3);
  const id = await delivered(B, C, 2);
  const attemptsOf = () => JSON.stringify(pilot.s.deals[id].refused_attempts ?? null);
  const tplRefused = async (by, rule, what, issuer = A) => {
    const before = snap(id), attempts = attemptsOf();
    notAccepted(await call('GET', `/deals/${id}/transfer-template?issuer=${issuer.id}`, null, B.agent), by, rule, what);
    assert.equal(snap(id), before, `${what}: nothing recorded`);
    assert.equal(attemptsOf(), attempts, `${what}: no attempt recorded either (a template is not one)`);
  };
  // Expired mandates and may_accept_credit (the owner's policy names only its rule).
  const past = new Date(now() - 60e3).toISOString(), later = new Date(now() + 14 * 24 * H).toISOString();
  for (const [P, by] of [[B, 'payer'], [C, 'payee'], [A, 'issuer']]) {
    await setMandate(P, {expires_at: past});
    try { await tplRefused(by, 'expires_at', `${by} expires_at`); } finally { await setMandate(P, {expires_at: later}); }
  }
  await setMandate(C, {may_accept_credit: false});
  try { await tplRefused('payee', 'may_accept_credit', 'may_accept_credit'); } finally { await setMandate(C, {may_accept_credit: true}); }
  // issuer_key: K's owner revoked its agent; B still holds K's note under K's earlier key.
  ok(await call('POST', '/owner/revoke-agent', null, K.owner));
  await tplRefused('issuer', 'issuer_key', 'issuer_key', K);
  // max_collecting_transfers: two of B's payments collect (their client issuers have not signed); a third is refused.
  for (const Q of [Q1, Q2]) assert.equal(ok(await pay(B, await delivered(B, C2, 1), Q)).transfer.state, 'collecting');
  await tplRefused('payer', 'max_collecting_transfers', 'max_collecting_transfers');
  assert.equal(ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).held_notes.find(h => h.issuer.id === A.id).why_not, 'payment_not_accepted:max_collecting_transfers');
  for (const x of Object.values(pilot.s.transfers).filter(x => x.payer.id === B.id && x.state === 'collecting')) ok(await call('POST', `/deals/${x.deal_id}/cancel-transfer`, {}, B.agent));
  // 503 signer_unavailable: no transfer, approval or deal change (only the refused attempt is recorded, D-2 b); the
  // same body works later.
  const tpl = await template(B, id, A), body = await payBody(B, tpl), signer = pilot.serverSigner, before = snap(id);
  const recs = () => pilot.s.deals[id].refused_attempts ?? [];
  pilot.serverSigner = {has: signer.has, signFor: async () => { throw new Error('signer down'); }};
  try { refused(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent), 503, 'signer_unavailable'); } finally { pilot.serverSigner = signer; }
  assert.equal(snap(id), before, 'signer outage: no transfer, approval or deal change');
  assert.equal(recs().length, 1, 'signer outage: the attempt is recorded');
  assertRefusedRecord(recs()[0], body, A, B, C, 9, 0, 2);
  assert.equal(recs()[0].code, 'signer_unavailable');
  // The 10-minute initiation window alone (rule R5): body's T is later than both edges' last notes and not ahead of the
  // clock, but with this server's clock 11 minutes ahead it is more than 10 minutes old: 409 transfer_stale, with a fresh
  // template made at that clock. The same body is the same attempt as the one refused above: still one record.
  assert.ok(tpl.timestamp > tpl.from_edge.before.timestamp && !tpl.to_edge.before && tpl.timestamp < now(), 'only the 10-minute window can refuse body');
  clockOffset = 11 * MIN;
  let stale;
  try { stale = refused(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent), 409, 'transfer_stale', 'more than 10 minutes old'); } finally { clockOffset = 0; }
  // A fresh template comes with the refusal: a new attempt on the same prior state of the same note as the recorded one
  // (this body), which at the tracker excludes it (the same-prior exemption).
  assert.ok(stale.template?.timestamp % 1000 === 999 && stale.template.from_edge.before.timestamp === body.from_prior_timestamp, 'more than 10 minutes old: a fresh template on the same prior state');
  assert.equal(snap(id), before, 'more than 10 minutes old: no transfer, approval or deal change');
  assert.deepEqual(recs().map(r => [r.timestamp, r.code]), [[body.timestamp, 'signer_unavailable']], 'more than 10 minutes old: the same attempt, recorded once');
  // The first body, inside the window now that this server's clock is right, with the signer back: it pays the deal, so
  // the window alone refused it above.
  assert.equal(ok(await call('POST', `/deals/${id}/pay-by-transfer`, body, B.agent)).status, 'paid_by_transfer', 'the first body, once the signer is back, inside the window');
  // Signed at a T ahead of this server's clock, or not later than A->B's last note (each on a deal of its own):
  // transfer_stale, with a fresh template on the same prior state. Ahead of the clock it is an attempt of its own and is
  // recorded (D-2 b); not later than the note it acknowledges, its prior acknowledgment PA(A,B,X,p,T) can never be taken
  // (the tracker needs T after p while A->B is at (X, p)), so it is no attempt and nothing is recorded.
  for (const what of ['not later than the edge\'s last note', 'ahead of the clock']) {
    const idk = await delivered(B, C, 2), tk = await template(B, idk, A), last = tk.from_edge.before.timestamp;
    const T = what === 'ahead of the clock' ? tk.timestamp + 2 * MIN : last - ((last - 999) % 1000), beforeK = snap(idk);
    const b = await payBodyAt(B, tk, T), r = refused(await call('POST', `/deals/${idk}/pay-by-transfer`, b, B.agent), 409, 'transfer_stale', what);
    assert.ok(r.template?.timestamp % 1000 === 999 && r.template.from_edge.before.timestamp === last, `${what}: a fresh template on the same prior state`);
    assert.equal(snap(idk), beforeK, `${what}: no transfer, approval or deal change`);
    const ks = pilot.s.deals[idk].refused_attempts ?? [], rec = ks.find(x => x.timestamp === T);
    if (what === 'ahead of the clock') {
      assert.ok(rec && ks.length === 1, `${what}: recorded as a refused attempt`);
      assertRefusedRecord(rec, b, A, B, C, 7, 2, 2);
      assert.equal(rec.code, 'transfer_stale', what);
    } else assert.equal(ks.length, 0, `${what}: no attempt`);
  }
});

test('more refusals: mandate_changed right before apply (another party\'s policy changed after its signature: failed, the deal payment_due), key_changed at a consent, the inconsistent outcome (an alarm; every payment refused until the owner resolves it), and mode sandbox scoping', async t => {
  if (!live(t)) return;
  const A = await party('ry-a', {roles: 'issuer'}), B = await party('ry-b'), C = await party('ry-c', {roles: 'creditor'});
  await owes(A, B, 6);
  // mandate_changed: A signs, then B's owner stops paying with held notes, then C's consent arrives (its own check passes).
  const id = await delivered(B, C, 2), vt = ok(await pay(B, id, A)).transfer.id;
  ok(await consent(A, vt));
  const ic = await itemFor(C, vt), cb = await consentBody(C, ic);
  await setMandate(B, {pay_with_held_notes: 'never'});
  let sc;
  try { sc = ok(await call('POST', `/consents/${vt}`, cb, C.agent)); } finally { await setMandate(B, {pay_with_held_notes: 'when_asked'}); }
  assert.deepEqual([sc.state, sc.result.code, sc.result.rule, sc.result.by, pilot.s.deals[id].status], ['failed', 'mandate_changed', 'pay_with_held_notes', 'payer', 'payment_due']);
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [6, null], 'nothing moved');
  // key_changed: C's registered key is not the one the transfer names (a state no route produces: a revocation voids the
  // payment first).
  const id2 = await delivered(B, C, 1), vt2 = ok(await pay(B, id2, A)).transfer.id, c2 = await consentBody(C, await itemFor(C, vt2)), q = pilot.s.participants[C.id], key = q.pubkey;
  q.pubkey = (await basis.keygen()).pubkey_hex;
  try { refused(await call('POST', `/consents/${vt2}`, c2, C.agent), 409, 'key_changed'); } finally { q.pubkey = key; }
  assert.equal(T_(vt2).state, 'collecting', 'nothing recorded');
  ok(await call('POST', `/deals/${id2}/cancel-transfer`, {}, B.agent));
  // max_attempts_per_deal: three attempts on one deal in 24 hours (the same note on the same prior state after each
  // cancel: each at once, the same-prior exemption); a fourth is refused, and nothing is recorded.
  const A4 = await party('ry-a4', {roles: 'issuer'});
  await owes(A4, B, 6);
  const idM = await delivered(B, C, 1);
  for (const i of [1, 2, 3]) {
    assert.equal(ok(await pay(B, idM, A4)).transfer.attempt, i);
    ok(await call('POST', `/deals/${idM}/cancel-transfer`, {}, B.agent));
  }
  const s2 = snap(idM);
  notAccepted(await call('GET', `/deals/${idM}/transfer-template?issuer=${A4.id}`, null, B.agent), 'payer', 'max_attempts_per_deal', 'a fourth attempt');
  assert.equal(snap(idM), s2, 'max_attempts_per_deal: nothing recorded');
  // inconsistent: left applying (a crash before the tracker got it), then the read-back finds A->C at its new state and
  // A->B at its prior one (the tracker's answer is shaped here: one tracker batch cannot produce it).
  const A3 = await party('ry-a3', {serverRun: true}), C3 = await party('ry-c3', {serverRun: true});
  await owes(A3, B, 4);
  const id3 = await delivered(B, C3, 2);
  hooks.transfer = async () => { throw new Error('simulated crash before the tracker call'); };
  try { await pay(B, id3, A3); } finally { delete hooks.transfer; }
  const vt3 = Object.values(pilot.s.transfers).find(x => x.deal_id === id3).id, t3 = T_(vt3);
  const note = basis.note;
  basis.note = async (i, r) => (i === A3.pubkey && r === C3.pubkey
    ? {amount_collected: String(t3.to_edge.new_total), amount_redeemed: '0', timestamp: t3.timestamp, signature: t3.slots.issuer_to.signature} : Object.getPrototypeOf(basis).note.call(basis, i, r));
  logs.length = 0;
  let out;
  try { out = await pilot.recover(); } finally { basis.note = note; delete basis.note; }
  assert.ok(out.includes(`${vt3}:inconsistent`), JSON.stringify(out));
  assert.ok(logs.some(l => /ALARM/.test(l) && l.includes(vt3)), 'an alarm');
  assert.deepEqual([t3.result.code, pilot.s.deals[id3].status], ['inconsistent', 'payment_due']);
  refused(await call('GET', `/deals/${id3}/credit-note-template`, null, B.agent), 409, 'attempt_outcome_unknown');
  assert.deepEqual((await view(B, id3)).next_actions, []);
  assert.equal(ok(await call('POST', `/owner/deals/${id3}/attempts/${vt3}/resolve`, {outcome: 'not_applied'}, B.owner)).transfer.state, 'resolved_not_applied', 'the owner resolves it');
  // Mode sandbox: a caller outside the sandbox gets the same 404 as an unknown route; an issuer or a payee outside it is
  // refused (sandbox_only); inside it the payment can be made.
  const S1 = await party('ry-s1', {serverRun: true}), S2 = await party('ry-s2'), S3 = await party('ry-s3', {serverRun: true});
  await owes(S1, S2, 3);
  const id4 = await delivered(S2, S3, 1), ids = pilot.sandboxIds;
  pilot.sandboxIds = new Set();
  pilot.circulation = 'sandbox';
  try {
    assert.equal(pilot.mode, 'sandbox');
    const unknownRoute = await call('GET', '/no-such-route', null, S2.agent), r = await call('GET', `/deals/${id4}/transfer-template?issuer=${S1.id}`, null, S2.agent);
    assert.deepEqual([r.status, r.body], [unknownRoute.status, unknownRoute.body], 'a caller outside the sandbox');
    pilot.sandboxIds.add(S2.id);
    notAccepted(await call('GET', `/deals/${id4}/transfer-template?issuer=${S1.id}`, null, S2.agent), 'issuer', 'sandbox_only', 'an issuer outside the sandbox');
    pilot.sandboxIds.add(S1.id);
    notAccepted(await call('GET', `/deals/${id4}/transfer-template?issuer=${S1.id}`, null, S2.agent), 'payee', 'sandbox_only', 'a payee outside the sandbox');
    pilot.sandboxIds.add(S3.id);
    assert.equal(ok(await pay(S2, id4, S1)).status, 'paid_by_transfer', 'every party in the sandbox');
  } finally { pilot.circulation = 'on'; pilot.sandboxIds = ids; }
  assert.equal(pilot.mode, 'on');
});

test('handles shaped like participant ids are refused (join and join-sandbox)', async t => {
  if (!live(t)) return;
  const inv = ok(await call('POST', '/admin/invites', {}, null, ADM), 201);
  refused(await call('POST', '/join', {invite: inv.code, handle: 'vp_0123456789ab', operator: 'x'}), 400, 'invalid_field');
  assert.equal(ok(await call('POST', '/join', {invite: inv.code, handle: 'vp_0123456789abc', operator: 'x'}), 201).handle, 'vp_0123456789abc', 'one more character is no id');
});

test('phase-2 credit policies (SV-8): accept_operator_issuers, max_claims_total, max_issuer_net_debt and refuse_notes_from refuse a payment by transfer (payment_not_accepted, by payee; nothing recorded; payment options say so) and an acceptance (mandate_exceeded); the deal being paid is not counted twice; a held acceptance shows the rules set in mandate_check; GET /participants publishes credit_policy and credit_history', async t => {
  if (!live(t)) return;
  const A = await party('pp-a', {serverRun: true}), B = await party('pp-b'), C = await party('pp-c', {serverRun: true});
  await owes(A, B, 5);                                                   // A->B 5; A is operator-run here (the stub server signer)
  const id = await delivered(B, C, 3), good = await payBody(B, await template(B, id, A)), before = snap(id);
  const post = () => call('POST', `/deals/${id}/pay-by-transfer`, good, B.agent);
  // C's owner sets one rule at a time. A owes 5 and holds nothing (net debt 5); C holds nothing yet and is paid 3.
  const rules = [
    [{accept_operator_issuers: false}, 'accept_operator_issuers', {accept_operator_issuers: true}],
    [{max_claims_total: 2}, 'max_claims_total', {max_claims_total: null}],
    [{max_issuer_net_debt: 4}, 'max_issuer_net_debt', {max_issuer_net_debt: null}],
    [{refuse_notes_from: [A.id]}, 'refuse_notes_from', {refuse_notes_from: []}],
  ];
  // The templates and payment options first: once a refused post is recorded (D-2 b), a new attempt of the deal waits
  // for its window (audit VS-1), and that is what they would say then.
  for (const [m, rule, restore] of rules) {
    await setMandate(C, m);
    try {
      notAccepted(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent), 'payee', rule, `template: ${rule}`);
      const h = ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).held_notes.find(x => x.issuer.id === A.id);
      assert.deepEqual([h.payee_accepts, h.why_not], [false, 'payment_not_accepted:payee'], `payment options: ${rule}`);
    } finally { await setMandate(C, restore); }
  }
  // The posts (the same body each time: the identical operation, which the recorded attempt's window does not hold back).
  for (const [m, rule, restore] of rules) {
    await setMandate(C, m);
    try { notAccepted(await post(), 'payee', rule, rule); assert.equal(snap(id), before, `${rule}: nothing recorded`); }
    finally { await setMandate(C, restore); }
  }
  // At exactly the limits it is paid: the deal being paid (3, committed for C) is not counted again with the transfer.
  await setMandate(C, {max_claims_total: 3, max_issuer_net_debt: 5});
  assert.equal(ok(await call('GET', `/deals/${id}/payment-options`, null, B.agent)).held_notes.find(x => x.issuer.id === A.id).payee_accepts, true);
  assert.equal(ok(await post()).status, 'paid_by_transfer');
  assert.deepEqual([(await edge(A, B)).total, (await edge(A, C)).total], [2, 3]);
  // An acceptance: A offers C 2 PC. A owes 2 + 3 = 5 and holds nothing, so with this deal its net debt is 7; C holds 3
  // of A's notes, so its claims would be 5.
  const tt = terms(A, A, C, 2), th = termsHash(tt);
  const offer = ok(await call('POST', '/deals', {terms: tt, terms_hash: th, signature: await sign(A, statements.propose(th))}, A.agent), 201);
  const accept = async () => call('POST', `/deals/${offer.id}/accept`, {terms_hash: th, signature: await sign(C, statements.accept(th))}, C.agent);
  for (const [m, rule] of [[{accept_operator_issuers: false}, 'accept_operator_issuers'], [{max_claims_total: 4}, 'max_claims_total'], [{max_issuer_net_debt: 6}, 'max_issuer_net_debt'],
    [{refuse_notes_from: [A.id]}, 'refuse_notes_from']]) {
    await setMandate(C, {accept_operator_issuers: true, max_claims_total: 5, max_issuer_net_debt: 7, refuse_notes_from: [], ...m});
    const r = refused(await accept(), 403, 'mandate_exceeded', rule);
    assert.deepEqual([r.rule, r.source, r.mandate_version], [rule, 'owner_mandate', ok(await call('GET', '/owner', null, C.owner)).mandate_version], rule);
    assert.equal(pilot.s.deals[offer.id].status, 'open', `${rule}: nothing recorded`);
  }
  // Within every limit, held for C's owner (approve_above 0): its mandate_check lists the rules that are set, after the
  // existing ones, with their figures.
  await setMandate(C, {accept_operator_issuers: true, max_claims_total: 5, max_issuer_net_debt: 7, refuse_notes_from: [B.id], approve_above: 0});
  assert.equal(ok(await accept()).status, 'accepted_awaiting_owner');
  const ap = await pendingApproval(C, offer.id);
  assert.deepEqual(ap.mandate_check.checks, [
    {rule: 'max_accept_per_issuer', claim_on_tracker: 3, committed: 0, reserved: 0, this_deal: 2, limit: 5000},
    {rule: 'refuse_notes_from', issuer_listed: false},
    {rule: 'max_claims_total', claims_on_tracker: 3, committed: 0, pending_in: 0, this_deal: 2, limit: 5},
    {rule: 'max_issuer_net_debt', issuer_owes_on_tracker: 5, issuer_committed: 0, this_deal: 2, issuer_adjusted_claims: 0, issuer_net_debt: 7, limit: 7}]);
  // What GET /participants publishes: the predicates (never a cap), and the credit history (aggregates only).
  const pc = ok(await call('GET', `/participants/${C.id}`)).public_position, pa = ok(await call('GET', `/participants/${A.id}`)).public_position;
  const pb = ok(await call('GET', `/participants/${B.id}`)).public_position;
  assert.deepEqual(pc.credit_policy, {accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [B.id], accept_operator_issuers: true, max_issuer_net_debt: 7});
  assert.deepEqual([pc.credit_history.received_by_transfer, pc.credit_history.operator_run], [{count: 1, PC: 3}, true]);
  assert.deepEqual([pa.credit_history.notes_issued, pa.credit_history.operator_run], [{count: 1, PC: 5}, true]);
  assert.deepEqual([pb.credit_history.paid_by_transfer, pb.credit_history.notes_issued, pb.credit_history.operator_run], [{count: 1, PC: 3}, {count: 0, PC: 0}, false]);
  for (const k of ['max_claims_total', 'max_accept_per_issuer']) assert.equal(k in pc.credit_policy, false, `${k} stays private`);
  // /owner shows the owner its own credit policy with the phase-2 fields it set.
  const own = ok(await call('GET', '/owner', null, C.owner)).credit_policy;
  assert.deepEqual([own.max_claims_total, own.max_issuer_net_debt, own.accept_operator_issuers], [5, 7, true]);
});

test('(k) no response body ever carried a signature collected from another party before the tracker recorded its transfer', async t => {
  if (!live(t)) return;
  // Which transfer each collected signature belongs to: by its value, or by the sha256 kept once it was purged.
  const owner = new Map();
  for (const tr of Object.values(pilot.s.transfers)) for (const s of TRANSFER_SLOTS) {
    const v = tr.slots[s.name]?.signature;
    if (v) owner.set(v, tr.id);
    const h = tr.signature_sha256?.[s.name];
    if (h) owner.set(h, tr.id);
  }
  let checked = 0, matched = 0;
  const violations = [];
  for (const [sig, by] of produced) {
    const vt = owner.get(sig) ?? owner.get(SIGSHA(sig)) ?? null;
    const applied = vt ? appliedAt.get(vt) : undefined;
    for (const e of LOG) {
      if (!e.text.includes(sig)) continue;
      matched++;
      if (e.viewer === by) continue;                                     // its own signature
      if (applied !== undefined && e.i >= applied) continue;             // a receipt, after the tracker recorded it
      violations.push({sig: sig.slice(0, 16), by, viewer: e.viewer, i: e.i, path: e.path, status: e.status, transfer: vt});
    }
    checked++;
  }
  assert.ok(checked > 50 && LOG.length > 300, JSON.stringify({checked, responses: LOG.length}));
  assert.ok(matched > 0, 'receipts and own views do contain signatures, so the scan can see them');
  assert.deepEqual(violations, []);
});
