// Multilateral set-off and the clearing engine (design §4.6, §5.4, §5.5, §5.7; spec 18.7, 18.9, 18.12, 18.14) over real
// HTTP, against a throwaway REAL tracker v3.2 (port 3122) and a Pilot in circulation mode on, with a clearing engine
// (lib/pilot/clearing.mjs) whose timers are not started: its incremental search runs after every increase, and the batch
// through POST /admin/clearing/run. Server-run members sign through a stub pilot.serverSigner (keys from basis.keygen);
// every other member signs in this test, as its client would, from its consent item, rebuilding each message itself.
// Every response body is kept, and the last test checks that none carried a set-off signature collected from another
// member before the tracker recorded its set-off.
// Skipped unless the tracker's capabilities validate and its binary's sha256 is pinned (lib/pilot/pins.mjs): with the
// default (old) binaries every test here is skipped.
// Run: MSYS2_ENV_CONV_EXCL=VALUN_ VALUN_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release node --test test/setoff.test.mjs
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
import {quoteDigest, novationTimestamp, MAX_AGE_MS} from '../lib/pilot/novation.mjs';
import {Clearing, edgeSetId} from '../lib/pilot/clearing.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const TRACKER_PORT = 3122, ADMIN = 'setoff-admin-secret', ADM = {'x-valun-admin': ADMIN}, MIN = 60e3, H = 3600e3;
let tracker, server, base, basis, pilot, clearing, storeDir, enabled = false, skipWhy = 'the tracker did not start', clockOffset = 0;
const logs = [], hooks = {}, serverKeys = new Map(), tokens = new Map();
const LOG = [];                // every response: {i, viewer (the caller's participant id, or null), method, path, status, text}
const produced = new Map();    // every signature a member made for a set-off (or transfer) slot: hex -> participant id
const appliedAt = new Map();   // set-off or transfer id -> index in LOG of the first response after the tracker applied it
const now = () => Date.now() + clockOffset;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const SIGSHA = s => crypto.createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex');

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  const caps = await capabilities(tracker.url), v = validateCaps(caps);
  const bin = caps ? await trackerSha256() : null;
  enabled = v.ok && TRACKER_SHA256_PINS.includes(bin) && caps.novation?.setoff?.per_edge_timestamps === true;
  skipWhy = !caps ? 'this tracker reports no capabilities (a tracker before v3)' : !v.ok ? `capabilities do not validate: ${v.reason}`
    : !TRACKER_SHA256_PINS.includes(bin) ? `basis_server ${bin} is not pinned` : !enabled ? 'this tracker has no per-edge set-off timestamps' : '';
  if (!enabled) return;
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-setoff-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  // Crash injection: a test may replace the tracker call (hooks.setoff(body, original)).
  const original = basis.setoff.bind(basis);
  basis.setoff = body => (hooks.setoff ? hooks.setoff(body, original) : original(body));
  pilot = new Pilot({store: new PilotStore(storeDir), basis, now, circulation: 'on', trackerCaps: caps, trackerSha256: bin, log: m => logs.push(m)});
  assert.equal(pilot.mode, 'on', JSON.stringify(logs));
  pilot.serverSigner = {has: id => serverKeys.has(id), signFor: async (id, msgHex) => {
    const k = serverKeys.get(id), s = await basis.signHex(k.pubkey, msgHex, k.secret);
    produced.set(s, id);
    return s;
  }};
  clearing = new Clearing({pilot, log: m => logs.push(m)});           // not started: no timers but the ones it schedules
  pilot.clearing = clearing;
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  clearing?.stop();
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
  for (const x of [...Object.values(pilot.s.setoffs), ...Object.values(pilot.s.transfers)]) if (x.state === 'applied' && !appliedAt.has(x.id)) appliedAt.set(x.id, i);
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 600)); return r.body; };
const refused = (r, status, code, what = '') => {
  assert.equal(r.status, status, `${what}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 400)}`);
  assert.equal(r.body?.error, code, `${what}: expected ${code}, got ${JSON.stringify(r.body)?.slice(0, 400)}`);
  return r.body;
};
async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Participants (invited, mode on) with the owner's mandate: room for the tests and the credit policy (auto_clear on).
// `serverRun`: its key goes to the stub server signer. `roles`: its client declares these consent roles
// (X-Valun-Features) on every agent request (default setoff; none for a server-run participant).
const TEST_MANDATE = {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 5000, max_accept_per_deal: 100, max_accept_per_issuer: 5000};
const CIRCULATING = {auto_clear: true, accept_transfers: true, accept_notes_from: 'any', novate_own_debt: true, pay_with_held_notes: 'when_asked'};
const SERVER = {serverRun: true, roles: null};
let handles = 0;
async function party(name, {mandate = {}, serverRun = false, roles = 'setoff'} = {}) {
  const handle = `s${++handles}-${name}`.slice(0, 24);
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `set-off test operator of ${handle}`}), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token, features: roles ? `consents/1;roles=${roles}` : null};
  tokens.set(P.agent, P); tokens.set(P.owner, P);
  ok(await call('PUT', '/owner/mandate', {...TEST_MANDATE, ...CIRCULATING, ...mandate}, P.owner));
  if (serverRun) serverKeys.set(P.id, {pubkey: P.pubkey, secret: P.secret});
  ok(await call('GET', '/me', null, P.agent));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
const msg = async (i, r, total, ts) => (await basis.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex;
// A slot signature, kept as produced by P (for the withholding scan).
async function slotSig(P, i, r, total, ts) { const s = await basis.signHex(P.pubkey, await msg(i, r, total, ts), P.secret); produced.set(s, P.id); return s; }
const setMandate = async (P, m) => ok(await call('PUT', '/owner/mandate', m, P.owner));
const K = (I, R) => `${I.pubkey}>${R.pubkey}`;

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
// The payer's bound credit note (a 0.4 client with circulation on: the note and its prior acknowledgment).
async function boundBody(P, tpl) {
  assert.equal(tpl.timestamp % 1000, 997);
  return {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, tpl.message_hex, P.secret), prior_total: tpl.prior_total,
      prior_timestamp: tpl.prior_timestamp, prior_signature: await basis.signHex(P.pubkey, tpl.prior_message_hex, P.secret)}};
}
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, P.agent));
  return call('POST', `/deals/${id}/complete`, await boundBody(P, tpl), P.agent);
}
// X owes Y `price` more: X buys from Y and pays with its own (bound) credit note.
async function owes(X, Y, price) { const id = await delivered(X, Y, price); assert.equal(ok(await complete(X, id)).status, 'note_issued'); return id; }
const edge = async (I, R) => { const n = await basis.note(I.pubkey, R.pubkey); return n && {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature}; };
const pos = async P => ok(await call('GET', `/participants/${P.id}`)).public_position;

// ---------- set-offs ----------
const S_ = id => pilot.s.setoffs[id];
const setoffsWith = (...ps) => Object.values(pilot.s.setoffs).filter(o => ps.every(P => o.members.includes(P.id)));
const liveWith = (...ps) => setoffsWith(...ps).find(o => o.state === 'collecting' || o.state === 'applying');
async function itemFor(P, vs) { const c = ok(await call('GET', '/consents', null, P.agent)); const it = c.consents.find(x => x.id === vs); assert.ok(it, `${P.handle} has a consent item for ${vs}`); return it; }
// What a member's client checks on its item before it signs (the signing firewall's set-off rules, 15.3): only its own
// edges, each EdgeState the issuer's own signature, every change a decrease ending in 998 ms after the state it
// changes, and its claims falling by exactly as much as its debts.
async function checkAsClient(P, item) {
  assert.deepEqual([item.kind, item.your_roles, item.state, item.tracker_nft_id, item.denomination], ['setoff', ['member'], 'collecting', tracker.nft, PILOT_DENOMINATION]);
  assert.ok(!/message_hex|messages/.test(JSON.stringify(item)), 'no message hex in a consent');
  let asCreditor = 0, asIssuer = 0;
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    assert.ok(I === P.pubkey || R === P.pubkey, 'only its own edges');
    assert.equal(e.your_role, I === P.pubkey ? 'issuer' : 'creditor');
    assert.deepEqual(e.slots, ['new']);
    assert.ok(e.change < 0 && e.new_total === e.before.total + e.change && e.new_total >= 0, 'a decrease');
    assert.ok(e.timestamp % 1000 === 998 && e.timestamp > e.before.timestamp, 'residue 998, after the state it changes');
    assert.ok(await basis.verify(I, await msg(I, R, e.before.total, e.before.timestamp), e.before.signature), 'the EdgeState is the issuer\'s own signature');
    if (R === P.pubkey) asCreditor -= e.change; else asIssuer -= e.change;
  }
  assert.equal(asCreditor, asIssuer, 'net-neutral for this member');
  assert.deepEqual(item.summary, {your_net_change_PC: 0, your_total_owed_change_PC: -asIssuer});
  assert.deepEqual(item.context, {amount: asCreditor});
}
// The member's signatures for its unsigned slots, as its client makes them.
async function setoffBody(P, item) {
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    revisions[e.edge] = e.revision;
    if (!e.signed_by_you.includes('new')) signatures[`${e.edge}:new`] = await slotSig(P, I, R, e.new_total, e.timestamp);
  }
  return {signatures, revisions};
}
async function consent(P, vs) { const it = await itemFor(P, vs); await checkAsClient(P, it); return call('POST', `/consents/${vs}`, await setoffBody(P, it), P.agent); }
// A transfer consent item's signatures (issuer or payee), as the party's client makes them: every unsigned slot on its
// edges ('prior' over tracker v3.2's PA of the edge's state before, 'new' over its new total).
async function transferBody(P, item) {
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    revisions[e.edge] = e.revision;
    for (const slot of e.slots) if (!e.signed_by_you.includes(slot)) signatures[`${e.edge}:${slot}`] = slot === 'prior'
      ? await priorSig(P, I, R, e.before?.total ?? 0, e.before?.timestamp ?? 0, e.timestamp) : await slotSig(P, I, R, e.new_total, e.timestamp);
  }
  return {signatures, revisions};
}
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T), signed by P.
const pa = async (i, r, total, priorTs, ts) => (await basis.priorAckMessage({issuer: i, recipient: r, priorTotal: total, priorTimestamp: priorTs, timestamp: ts})).message_hex;
const priorSig = async (P, i, r, total, priorTs, ts) => basis.signHex(P.pubkey, await pa(i, r, total, priorTs, ts), P.secret);
async function consentTransfer(P, vt) { const it = await itemFor(P, vt); return call('POST', `/consents/${vt}`, await transferBody(P, it), P.agent); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The set-offs whose alarm (inconsistent) a test provokes on purpose; the last test allows exactly those.
const expectedAlarms = new Set();
// The batch (POST /admin/clearing/run) until `pred` holds, at most `tries` runs a second apart: a run may skip a cycle for
// a passing reason (no timestamp ending in 998 ms 1.5 s back yet, a slow tracker or signer).
async function runUntil(pred, what, tries = 4) {
  const runs = [];
  for (let i = 0; i < tries && !pred(); i++) {
    runs.push(ok(await call('POST', '/admin/clearing/run', {}, null, ADM)));
    if (!pred()) await sleep(1000);
  }
  assert.ok(pred(), `${what}: ${JSON.stringify(runs.map(x => [x.cycles_found, x.proposed, x.skipped]))}`);
  return runs;
}

// ---------- payments by transfer (for the tests where a payment meets a set-off) ----------
async function payBody(B, tpl) {
  const A = tpl.issuer.pubkey, Bk = tpl.payer.pubkey, C = tpl.payee.pubkey, T = tpl.timestamp, a = tpl.amount, X = tpl.from_edge.before.total, Y = tpl.to_edge.before?.total ?? 0;
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: tpl.deal_id, terms_hash: tpl.terms_hash,
    deliverable_sha256: tpl.deliverable_sha256, issuer_pubkey: A, payer_pubkey: Bk, payee_pubkey: C, amount: a});
  assert.equal(tpl.quote_digest, q);
  const AB = `${A}>${Bk}`, AC = `${A}>${C}`, pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  return {issuer_id: tpl.issuer.id, terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, quote_digest: q, timestamp: T, from_prior_total: X, to_prior_total: Y,
    from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await sign(B, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), pay_signature: await sign(B, circulationStatements.pay(tpl.deal_id, q)),
    signatures: {[`${AB}:prior`]: await priorSig(B, A, Bk, X, pX, T), [`${AB}:new`]: await slotSig(B, A, Bk, X - a, T), [`${AC}:new`]: await slotSig(B, A, C, Y + a, T)}};
}
const template = async (B, id, A) => ok(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent));
async function pay(B, id, A) { const tpl = await template(B, id, A); return {tpl, r: await call('POST', `/deals/${id}/pay-by-transfer`, await payBody(B, tpl), B.agent)}; }

// =================================================================================================================
test('a 2-cycle between two clients: proposed when the note that closes it is recorded; each member sees only its own edges, and both sign; applied: nets unchanged, gross lower by what it cleared; the journal, the reconciliation, the receipts; the edges are bound-only', async t => {
  if (!live(t)) return;
  const A = await party('two-a'), B = await party('two-b'), D = await party('two-d');
  await owes(A, B, 3);
  assert.equal(setoffsWith(A, B).length, 0, 'no cycle yet');
  await owes(B, A, 2);                                                   // closes A>B>A
  const o = await waitFor(() => liveWith(A, B), 'the proposal');
  assert.match(o.id, /^vs_[0-9a-f]{16}$/);
  assert.deepEqual([o.source, o.amount, o.edges.length, o.state, [...o.members].sort()], ['incremental', 4, 2, 'collecting', [A.id, B.id].sort()]);
  assert.ok(Date.parse(o.expires_at) - Date.parse(o.created_at) === 30 * MIN, 'collects for 30 minutes');
  const before = {A: await pos(A), B: await pos(B)}, ab0 = await edge(A, B), ba0 = await edge(B, A);
  assert.deepEqual([before.A.net, before.B.net, before.A.gross, before.B.gross], [-1, 1, 5, 5]);
  // What each member is shown: both of its edges (it is issuer on one and creditor on the other), net-neutral.
  const ia = await itemFor(A, o.id), ib = await itemFor(B, o.id);
  await checkAsClient(A, ia); await checkAsClient(B, ib);
  assert.deepEqual(ia.edges.map(e => [e.edge, e.your_role, e.before, e.change, e.new_total, e.revision, e.signed_by_you]).sort(),
    [[K(A, B), 'issuer', ab0, -2, 1, 1, []], [K(B, A), 'creditor', ba0, -2, 0, 1, []]].sort());
  assert.deepEqual(ia.summary, {your_net_change_PC: 0, your_total_owed_change_PC: -2});
  assert.ok(ia.edges.every(e => e.timestamp <= now() - 1500), 'the timestamps are behind this server\'s clock');
  assert.equal(ok(await call('GET', '/consents', null, D.agent)).consents.length, 0, 'a non-member has nothing');
  assert.equal(ok(await call('GET', '/consents', null, B.owner)).consents.length, 1, 'the owner token reads the consents too');
  refused(await call('POST', `/consents/${o.id}`, await setoffBody(B, ib), B.owner), 404, 'not_found', 'owners never sign');
  // Errors record nothing: not all of the caller's slots, a bad signature, a stale revision.
  const body = await setoffBody(A, ia), [k1, k2] = Object.keys(body.signatures);
  refused(await call('POST', `/consents/${o.id}`, {signatures: {[k1]: body.signatures[k1]}}, A.agent), 400, 'invalid_field');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {[k1]: body.signatures[k2], [k2]: body.signatures[k1]}}, A.agent), 403, 'bad_signature');
  const stale = ok(await call('POST', `/consents/${o.id}`, {signatures: body.signatures, revisions: {[K(A, B)]: 7}}, A.agent));
  assert.deepEqual(stale.rejected, [{slot: `${K(A, B)}:new`, code: 'stale_revision', revision: 1}]);
  assert.ok(o.edges.every(e => !e.slots.issuer && !e.slots.recipient), 'nothing recorded');
  // A signs: still collecting; then it has nothing left to sign.
  const sa = ok(await call('POST', `/consents/${o.id}`, body, A.agent));
  assert.deepEqual([sa.state, sa.edges.map(e => e.signed_by_you), sa.rejected], ['collecting', [['new'], ['new']], []]);
  refused(await call('POST', `/consents/${o.id}`, body, A.agent), 409, 'already_signed');
  const mid = ok(await call('GET', `/setoffs/${o.id}`, null, A.agent));
  assert.deepEqual([mid.signatures, typeof mid.signatures_withheld], [null, 'string'], 'withheld until the tracker records it');
  // B signs last: applied in that request.
  const sb = ok(await consent(B, o.id));
  assert.deepEqual([sb.state, sb.result.code], ['applied', 'applied']);
  const ab = await edge(A, B), ba = await edge(B, A), eAB = o.edges.find(e => e.edge === K(A, B)), eBA = o.edges.find(e => e.edge === K(B, A));
  assert.deepEqual(ab, {total: 1, timestamp: eAB.timestamp, signature: eAB.slots.issuer.signature}, 'A>B holds A\'s set-off signature');
  assert.deepEqual(ba, {total: 0, timestamp: eBA.timestamp, signature: eBA.slots.issuer.signature});
  assert.equal(produced.get(eAB.slots.issuer.signature), A.id);
  // Every net unchanged, gross lower by the 4 PC cleared (2 on each edge).
  const after = {A: await pos(A), B: await pos(B)};
  assert.deepEqual([after.A.net, after.B.net, after.A.gross, after.B.gross], [before.A.net, before.B.net, 1, 1]);
  assert.deepEqual([after.A.cleared_by_setoff, after.B.cleared_by_setoff, after.A.settled], [2, 2, 2]);
  // The journal (setoff -2 on each edge) and the reconciliation: match and exact.
  const jr = ok(await call('GET', '/edges', null, A.agent)).journal.filter(e => e.ref === o.id);
  assert.deepEqual(jr.map(e => [e.kind, e.edge, e.delta, e.total_after, e.timestamp]).sort(), [['setoff', K(A, B), -2, 1, eAB.timestamp], ['setoff', K(B, A), -2, 0, eBA.timestamp]].sort());
  // (The journal columns are the server's own rows; the public GET /ledger keeps v15's rows, SV-PRIV-1.)
  const rows = await pilot.reconcile();
  assert.ok(ok(await call('GET', '/ledger')).reconciliation.every(r => !('set_off' in r) && !('exact' in r)), "the public rows are v15's");
  for (const [I, R, total] of [[A, B, 1], [B, A, 0]]) {
    const row = rows.find(x => x.issuer === I.handle && x.recipient === R.handle);
    assert.deepEqual([row.tracker_total, row.expected_total, row.status, row.exact, row.set_off], [total, total, 'match', true, 2], `${I.handle}>${R.handle}`);
  }
  // Receipts: each member sees the signatures on its own edges; a non-member gets the same 404 as for an unknown id.
  const ra = ok(await call('GET', `/setoffs/${o.id}`, null, A.agent)), rb = ok(await call('GET', `/setoffs/${o.id}`, null, B.owner));
  assert.deepEqual(ra.signatures[K(A, B)], {issuer: eAB.slots.issuer.signature, recipient: eAB.slots.recipient.signature});
  assert.deepEqual(rb.tracker_after[K(B, A)], ba);
  assert.deepEqual([ra.state, ra.result.code, ra.summary], ['applied', 'applied', {your_net_change_PC: 0, your_total_owed_change_PC: -2}]);
  assert.ok(!('members' in ra) && !JSON.stringify(ra).includes(D.id));
  const unknown = refused(await call('GET', '/setoffs/vs_0000000000000000', null, D.agent), 404, 'not_found');
  const other = refused(await call('GET', `/setoffs/${o.id}`, null, D.agent), 404, 'not_found');
  assert.equal(other.message.replace(o.id, 'X'), unknown.message.replace('vs_0000000000000000', 'X'));
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, D.agent), 404, 'not_found');
  refused(await call('POST', `/consents/${o.id}/refuse`, {}, D.agent), 404, 'not_found');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, A.agent), 409, 'wrong_state');
  assert.equal(ok(await call('GET', '/consents', null, A.agent)).recently_resolved.find(x => x.id === o.id)?.state, 'applied');
  // Both edges are bound-only now: an ordinary note on A>B is refused by the tracker itself.
  const plain = await basis.issueNote({issuer: A.pubkey, recipient: B.pubkey, total: 2, secretHex: A.secret});
  assert.equal(plain.response.status, 400, JSON.stringify(plain.response));
  assert.equal(ok(await call('GET', '/edges', null, A.agent)).outgoing.find(e => e.edge === K(A, B)).bound_only, true);
  // And a bound note there still works (the 0.4 client's way): the edge reconciles again.
  await owes(A, B, 1);
  assert.equal((await edge(A, B)).total, 2);
});

test('a 3-cycle with a server-run member (it signs at apply time) and a 4-cycle proposed by the batch (admin run): nets unchanged, gross lower', async t => {
  if (!live(t)) return;
  const X = await party('three-x', SERVER), Y = await party('three-y'), Z = await party('three-z');
  await owes(X, Y, 2); await owes(Y, Z, 3); await owes(Z, X, 4);       // closes X>Y>Z>X (bottleneck 2)
  const o = await waitFor(() => liveWith(X, Y, Z), 'the 3-cycle');
  assert.deepEqual([o.edges.length, o.amount, o.edges.every(e => e.decrease === 2)], [3, 6, true]);
  assert.equal(ok(await call('GET', '/consents', null, X.agent)).consents.length, 0, 'the server signs for a server-run member');
  const nets = [await pos(X), await pos(Y), await pos(Z)].map(p => p.net);
  ok(await consent(Y, o.id));
  assert.ok(o.edges.every(e => !e.slots.issuer?.server_signed && !e.slots.recipient?.server_signed), 'server-run roles sign only at apply time');
  assert.equal(ok(await consent(Z, o.id)).state, 'applied');
  for (const e of o.edges) for (const r of ['issuer', 'recipient']) if (e[r].id === X.id) assert.equal(e.slots[r].server_signed, true);
  assert.deepEqual([(await edge(X, Y)).total, (await edge(Y, Z)).total, (await edge(Z, X)).total], [0, 1, 2]);
  assert.deepEqual([await pos(X), await pos(Y), await pos(Z)].map(p => p.net), nets, 'every net unchanged');
  // A 4-cycle whose last member clears only once its owner allows it: then the batch (POST /admin/clearing/run) finds it.
  const P1 = await party('four-1'), P2 = await party('four-2'), P3 = await party('four-3'), P4 = await party('four-4', {mandate: {auto_clear: false}});
  await owes(P1, P2, 2); await owes(P2, P3, 2); await owes(P3, P4, 2); await owes(P4, P1, 2);
  assert.equal(liveWith(P1, P2, P3, P4), undefined, 'P4 is not a clearing member yet');
  await setMandate(P4, {auto_clear: true});
  const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(run.reason, 'admin');
  assert.ok(run.eligible_edges >= 4 && run.cycles_found >= 1 && /^rn_[0-9a-f]{16}$/.test(run.id), JSON.stringify(run));
  const o4 = liveWith(P1, P2, P3, P4);
  assert.ok(o4 && run.setoffs.includes(o4.id), JSON.stringify(run));
  assert.deepEqual([o4.source, o4.run_id, o4.edges.length, o4.amount], ['admin', run.id, 4, 8]);
  const diag = ok(await call('GET', '/admin/clearing', null, null, ADM));
  assert.ok(diag.live.some(x => x.id === o4.id && x.members.length === 4) && diag.runs.some(r => r.id === run.id));
  assert.ok(!JSON.stringify(diag).match(/0[23][0-9a-f]{128}/), 'diagnostics carry no signature');
  const nets4 = await Promise.all([P1, P2, P3, P4].map(async P => (await pos(P)).net));
  for (const P of [P1, P2, P3]) assert.equal(ok(await consent(P, o4.id)).state, 'collecting');
  assert.equal(ok(await consent(P4, o4.id)).state, 'applied');
  assert.deepEqual(await Promise.all([[P1, P2], [P2, P3], [P3, P4], [P4, P1]].map(async ([I, R]) => (await edge(I, R)).total)), [0, 0, 0, 0]);
  assert.deepEqual(await Promise.all([P1, P2, P3, P4].map(async P => (await pos(P)).net)), nets4);
  assert.deepEqual((await pilot.publicClearing()).cycles_by_length['4'] >= 1, true);
  // P1's receipt: its own two edges only (their signatures and states as read back). P3 shares no edge with P1: it is
  // never named, and neither are the signatures on P2>P3 and P3>P4.
  const rec = ok(await call('GET', `/setoffs/${o4.id}`, null, P1.agent)), own = [K(P1, P2), K(P4, P1)].sort();
  assert.deepEqual([rec.edges.map(e => e.edge).sort(), Object.keys(rec.signatures).sort(), Object.keys(rec.tracker_after).sort()], [own, own, own]);
  const recText = JSON.stringify(rec);
  assert.ok(![P3.id, `"${P3.handle}"`, P3.pubkey].some(x => recText.includes(x)), 'the member P1 shares no edge with never appears');
  for (const k of [K(P2, P3), K(P3, P4)]) for (const r of ['issuer', 'recipient']) assert.ok(!recText.includes(o4.edges.find(e => e.edge === k).slots[r].signature), `no signature of ${r} on another member's edge`);
});

test('a cycle among server-run members only applies at once, without any consent: the server signs every slot at apply time, on a fresh timestamp', async t => {
  if (!live(t)) return;
  const S1 = await party('srv-1', SERVER), S2 = await party('srv-2', SERVER), S3 = await party('srv-3', SERVER);
  await owes(S1, S2, 2); await owes(S2, S3, 2); await owes(S3, S1, 3);
  const o = await waitFor(() => setoffsWith(S1, S2, S3).find(x => x.state === 'applied'), 'the server-only set-off applied');
  assert.ok(o.edges.every(e => e.server_only && e.slots.issuer.server_signed && e.slots.recipient.server_signed && e.timestamp % 1000 === 998));
  assert.deepEqual([(await edge(S1, S2)).total, (await edge(S2, S3)).total, (await edge(S3, S1)).total], [0, 0, 1]);
  for (const e of o.edges) assert.ok(e.timestamp > e.before.timestamp, 'after the edge\'s state when it was applied');
  assert.deepEqual(o.history.map(h => h.event).filter(e => e !== 'created').at(-1), 'applied');
});

test('nothing applies without every signature: an expiry (a signature missing) and a refusal leave every edge as it was and purge the signatures; their cooldowns keep the engine from proposing them again; three expiries in a row exclude a member for 24 h', async t => {
  if (!live(t)) return;
  // Expiry: C signs, D never does.
  const C = await party('exp-c'), D = await party('exp-d');
  await owes(C, D, 2); await owes(D, C, 2);
  const o = await waitFor(() => liveWith(C, D), 'the proposal');
  ok(await consent(C, o.id));
  const cd = await edge(C, D), dc = await edge(D, C);
  clockOffset = 31 * MIN;
  try { assert.deepEqual(ok(await call('GET', '/consents', null, C.agent)).recently_resolved.find(x => x.id === o.id)?.state, 'expired', 'swept on a read'); }
  finally { clockOffset = 0; }
  assert.deepEqual([o.state, o.result.code], ['expired', 'expired']);
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature) && Object.keys(o.signature_sha256).length === 2, 'purged, sha256 kept');
  assert.deepEqual([await edge(C, D), await edge(D, C)], [cd, dc], 'nothing applied');
  const cool = pilot.s.clearing.cooldowns[`set:${edgeSetId([K(C, D), K(D, C)])}`];
  assert.ok(cool && cool.until - now() > 5.9 * H && cool.reason === 'expired', JSON.stringify(cool));
  assert.equal(pilot.s.clearing.expiry_streaks?.[D.id], 1, 'the expiry counts against the member that did not sign');
  assert.equal(pilot.s.clearing.expiry_streaks?.[C.id], undefined, 'not against the one that signed');
  const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(C, D), undefined, `not proposed again during its cooldown (${JSON.stringify(run.skipped)})`);
  // Refusal: E refuses; nothing applies; a 24-hour cooldown for E and that edge set.
  const E = await party('ref-e'), F = await party('ref-f');
  await owes(E, F, 3); await owes(F, E, 1);
  const r = await waitFor(() => liveWith(E, F), 'the proposal');
  ok(await consent(F, r.id));
  const ef = await edge(E, F), fe = await edge(F, E);
  refused(await call('POST', `/consents/${r.id}/refuse`, {reason: 'no‮thanks'}, E.agent), 400, 'invalid_field');
  refused(await call('POST', `/consents/${r.id}/refuse`, {reason: 'x'.repeat(301)}, E.agent), 400, 'invalid_field');
  const rf = ok(await call('POST', `/consents/${r.id}/refuse`, {reason: 'not now'}, E.agent));
  assert.deepEqual([rf.state, rf.result.code, r.state], ['refused', 'refused', 'refused']);
  assert.deepEqual([await edge(E, F), await edge(F, E)], [ef, fe], 'nothing applied');
  assert.ok(r.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'F\'s signatures purged');
  const rc = pilot.s.clearing.cooldowns[`refusal:${E.id}:${edgeSetId([K(E, F), K(F, E)])}`];
  assert.ok(rc && rc.until - now() > 23.9 * H, JSON.stringify(rc));
  const log = pilot.s.clearing.refusals.at(-1);
  assert.deepEqual([log.setoff, log.member, log.reason, typeof log.at], [r.id, E.id, 'not now', 'string'], 'who refused, and why, is kept for the operator');
  const fv = ok(await call('GET', `/setoffs/${r.id}`, null, F.agent));
  assert.deepEqual(fv.result, {code: 'refused', at: r.result.at}, 'the other member sees that it was refused, never by whom');
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(E, F), undefined, 'not proposed again within 24 h');
  // Once the cooldown is over (set back here), the engine proposes it again. (A run may skip it for a passing reason, a
  // slow tracker or signer, or no timestamp ending in 998 ms 1.5 s back yet: then the next run proposes it.)
  pilot.s.clearing.cooldowns[`refusal:${E.id}:${edgeSetId([K(E, F), K(F, E)])}`].until = now() - 1;
  const runs = [];
  for (let i = 0; i < 3 && !liveWith(E, F); i++) {
    runs.push(ok(await call('POST', '/admin/clearing/run', {}, null, ADM)));
    if (!liveWith(E, F)) await new Promise(res => setTimeout(res, 1000));
  }
  const again = liveWith(E, F);
  assert.ok(again, `proposed again: ${JSON.stringify(runs.map(x => [x.cycles_found, x.proposed, x.skipped]))}`);
  assert.ok(runs.slice(0, -1).every(x => x.skipped.every(s => ['timestamp_ahead', 'tracker_unavailable', 'signer_unavailable'].includes(s))), JSON.stringify(runs.map(x => x.skipped)));
  assert.ok(again.id !== r.id && again.edges.every(e => e.timestamp > r.edges.find(x => x.edge === e.edge).timestamp), 'a new proposal, at new timestamps (never the same (edge, timestamp) twice)');
  ok(await call('POST', `/consents/${again.id}/refuse`, {}, F.agent));
  // Three expiries in a row exclude a member (Hx never signs) from clearing for 24 hours.
  const Hx = await party('exp-h');
  for (let i = 1; i <= 3; i++) {
    const G = await party(`exp-g${i}`);
    await owes(G, Hx, 1); await owes(Hx, G, 1);
    const g = await waitFor(() => liveWith(G, Hx), `proposal ${i}`);
    ok(await consent(G, g.id));
    clockOffset = 31 * MIN;
    try { ok(await call('GET', '/consents', null, G.agent)); } finally { clockOffset = 0; }
    assert.equal(g.state, 'expired');
  }
  const ex = pilot.s.clearing.cooldowns[`participant:${Hx.id}`];
  assert.ok(ex && ex.reason === 'expiries_in_a_row' && ex.until - now() > 23.9 * H, JSON.stringify(ex));
  assert.equal(pilot.s.clearing.expiry_streaks?.[Hx.id], undefined, 'the count starts again');
  assert.equal(pilot.clearingParticipantCheck(pilot.s.participants[Hx.id]), 'cooldown');
  const G4 = await party('exp-g4');
  await owes(G4, Hx, 1); await owes(Hx, G4, 1);
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(G4, Hx), undefined, 'an excluded member is in no proposal');
});

test('a new note on one edge during collection makes only that edge again: its parties sign it again (revision 2, a new timestamp), the other edges keep their signatures; then it applies', async t => {
  if (!live(t)) return;
  const Ka = await party('regen-k'), L = await party('regen-l'), M = await party('regen-m');
  await owes(Ka, L, 3); await owes(L, M, 3); await owes(M, Ka, 3);
  const o = await waitFor(() => liveWith(Ka, L, M), 'the 3-cycle');
  ok(await consent(Ka, o.id)); ok(await consent(L, o.id));
  const kept = Object.fromEntries(o.edges.filter(e => e.edge !== K(L, M)).map(e => [e.edge, structuredClone(e.slots)])), lm0 = o.edges.find(e => e.edge === K(L, M));
  const ts0 = lm0.timestamp;
  await owes(L, M, 1);                                                   // L>M moves to 4 during collection
  assert.equal(liveWith(L, M)?.id, o.id, 'a collecting set-off never blocks a note, and the edge stays in it');
  const sm = ok(await consent(M, o.id));                                 // the last signature: the edge moved, made again
  assert.equal(sm.state, 'collecting');
  const lm = o.edges.find(e => e.edge === K(L, M));
  assert.deepEqual([lm.revision, lm.before.total, lm.new_total, lm.slots.issuer, lm.slots.recipient], [2, 4, 1, null, null]);
  assert.ok(lm.timestamp > ts0 && lm.timestamp % 1000 === 998 && lm.timestamp > lm.before.timestamp);
  // The other edges keep the signatures they had (M's own, on M>Ka, came with this consent).
  assert.deepEqual(o.edges.find(e => e.edge === K(Ka, L)).slots, kept[K(Ka, L)], 'Ka>L keeps both signatures');
  const mk = o.edges.find(e => e.edge === K(M, Ka));
  assert.deepEqual([mk.slots.recipient, mk.slots.issuer.by, kept[K(M, Ka)].issuer], [kept[K(M, Ka)].recipient, M.id, null], "M>Ka keeps Ka's signature, and has M's now");
  assert.deepEqual(o.history.map(h => h.event).filter(e => e === 'regenerated'), ['regenerated']);
  // Ka has nothing to sign again; L and M sign the made-again edge only.
  const ik = await itemFor(Ka, o.id);
  assert.ok(ik.edges.every(e => e.revision === 1 && e.signed_by_you.includes('new')));
  const il = await itemFor(L, o.id);
  assert.deepEqual(il.edges.map(e => [e.edge, e.revision, e.signed_by_you]).sort(), [[K(Ka, L), 1, ['new']], [K(L, M), 2, []]].sort());
  // a signature over the old revision is refused as stale, nothing recorded
  const oldSig = await slotSig(L, L.pubkey, M.pubkey, 0, ts0);
  const st = ok(await call('POST', `/consents/${o.id}`, {signatures: {[`${K(L, M)}:new`]: oldSig}, revisions: {[K(L, M)]: 1}}, L.agent));
  assert.deepEqual(st.rejected, [{slot: `${K(L, M)}:new`, code: 'stale_revision', revision: 2}]);
  refused(await call('POST', `/consents/${o.id}`, {signatures: {[`${K(L, M)}:new`]: oldSig}}, L.agent), 403, 'bad_signature');
  assert.equal(ok(await consent(L, o.id)).state, 'collecting');
  assert.equal(ok(await consent(M, o.id)).state, 'applied');
  assert.deepEqual([(await edge(Ka, L)).total, (await edge(L, M)).total, (await edge(M, Ka)).total], [0, 1, 0]);
  assert.equal((await edge(L, M)).timestamp, lm.timestamp);
});

test('a payment by transfer on a collecting set-off\'s edge supersedes the set-off at once (payment_attempt, decision D-2 c): set-offs never block payments, and nothing of the set-off applies', async t => {
  if (!live(t)) return;
  const A = await party('sup-a', SERVER), B = await party('sup-b'), C = await party('sup-c', SERVER);
  await owes(A, B, 3); await owes(B, A, 2);
  const o = await waitFor(() => liveWith(A, B), 'the proposal');
  assert.deepEqual(o.edges.map(e => e.decrease), [2, 2]);
  const ba = await edge(B, A);
  const id = await delivered(B, C, 2), {r} = await pay(B, id, A);    // B pays C with 2 of A's note: A>B 3 -> 1
  assert.equal(ok(r).status, 'paid_by_transfer', 'the collecting set-off does not block the payment');
  assert.deepEqual([o.state, o.result.code], ['superseded', 'payment_attempt'], 'superseded when the payment was made');
  assert.equal(ok(await call('GET', '/consents', null, B.agent)).consents.some(x => x.id === o.id), false, 'no longer offered to sign');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, B.agent), 409, 'wrong_state');
  assert.deepEqual([(await edge(A, B)).total, await edge(B, A)], [1, ba], 'nothing of the set-off applied');
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature));
  assert.equal(pilot.s.clearing.cooldowns[`set:${o.edge_set}`], undefined, 'no cooldown after a supersession');
});

test('the tracker refuses a set-off that does not balance, sent straight to it, and transfer signatures replayed as set-off edges; the edges stay as they were', async t => {
  if (!live(t)) return;
  // A 3-cycle among members whose owners keep them out of clearing: the test holds every key and signs itself.
  const off = {mandate: {auto_clear: false}};
  const N1 = await party('raw-1', off), N2 = await party('raw-2', off), N3 = await party('raw-3', off);
  await owes(N1, N2, 2); await owes(N2, N3, 2); await owes(N3, N1, 2);
  const e12 = await edge(N1, N2), e23 = await edge(N2, N3), e31 = await edge(N3, N1);
  let r = novationTimestamp({now: Date.now(), residue: 998, after: Math.max(e12.timestamp, e23.timestamp, e31.timestamp)});
  if (r.timestamp === undefined) { await new Promise(res => setTimeout(res, r.ahead_ms + 10)); r = novationTimestamp({now: Date.now(), residue: 998, after: Math.max(e12.timestamp, e23.timestamp, e31.timestamp)}); }
  const ts = r.timestamp;
  // Signed here and sent straight to the tracker (never through Valun, so not part of the withholding scan).
  const raw = async (P, i, r, total, at) => basis.signHex(P.pubkey, await msg(i, r, total, at), P.secret);
  const signed = async (I, R, prior, d, at = ts) => ({issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, decrease: d, timestamp: at,
    issuer_signature: await raw(I, I.pubkey, R.pubkey, prior - d, at), recipient_signature: await raw(R, I.pubkey, R.pubkey, prior - d, at)});
  const good = [await signed(N1, N2, 2, 2), await signed(N2, N3, 2, 2), await signed(N3, N1, 2, 2)];
  const unchanged = async what => assert.deepEqual([await edge(N1, N2), await edge(N2, N3), await edge(N3, N1)], [e12, e23, e31], what);
  const send = edges => basis.setoff({denomination: PILOT_DENOMINATION, timestamp: ts, edges});
  // two of the three edges: N1's debts fall and its claims do not
  let x = await send(good.slice(0, 2));
  assert.deepEqual([x.status, x.code, x.success], [400, 'invalid_setoff', false]); await unchanged('a subset of a cycle');
  // all three, one decrease different (each edge validly signed over its own new total)
  x = await send([good[0], good[1], await signed(N3, N1, 2, 1)]);
  assert.deepEqual([x.status, x.code], [400, 'invalid_setoff']); await unchanged('unequal decreases');
  // a signature by the wrong key
  x = await send([{...good[0], issuer_signature: good[0].recipient_signature}, good[1], good[2]]);
  assert.deepEqual([x.status, x.code], [400, 'invalid_signature']); await unchanged('a wrong signer');
  // a timestamp in another operation's residue (999, a transfer's)
  x = await send([await signed(N1, N2, 2, 2, ts + 1), good[1], good[2]]);
  assert.deepEqual([x.status, x.code], [400, 'invalid_setoff']); await unchanged('residue 999');
  // an unknown field
  x = await send([{...good[0], prior_total: 2}, good[1], good[2]]);
  assert.equal(x.status, 422); await unchanged('an unknown field');
  // Transfer signatures replayed as set-off edges. A3's note to B3 is being spent (a transfer collecting its payee's
  // consent): the issuer's and the old creditor's signatures over A3>B3's new total at T.
  const A3 = await party('raw-a3', SERVER), B3 = await party('raw-b3', off), C3 = await party('raw-c3', {roles: 'creditor'});
  await owes(A3, B3, 4); await owes(B3, A3, 2);
  const id = await delivered(B3, C3, 2), {tpl, r: pr} = await pay(B3, id, A3), vt = ok(pr).transfer.id, tr = pilot.s.transfers[vt], T = tpl.timestamp;
  assert.equal(tr.state, 'collecting');
  const ab = await edge(A3, B3), ba3 = await edge(B3, A3);
  const fromEdge = at => ({issuer_pubkey: A3.pubkey, recipient_pubkey: B3.pubkey, decrease: 2, timestamp: at, issuer_signature: tr.slots.issuer_from.signature, recipient_signature: tr.slots.from_recipient.signature});
  // as they are (at T, residue 999): refused for the residue
  x = await basis.setoff({denomination: PILOT_DENOMINATION, timestamp: T, edges: [fromEdge(T), await signed(B3, A3, 2, 2, T)]});
  assert.deepEqual([x.status, x.code], [400, 'invalid_setoff'], 'residue 999');
  // at T - 1 (residue 998), balanced with a valid B3>A3 edge: the transfer's signatures do not verify there
  x = await basis.setoff({denomination: PILOT_DENOMINATION, timestamp: T - 1, edges: [fromEdge(T - 1), await signed(B3, A3, 2, 2, T - 1)]});
  assert.deepEqual([x.status, x.code], [400, 'invalid_signature'], 'transfer signatures at a set-off timestamp');
  assert.deepEqual([await edge(A3, B3), await edge(B3, A3)], [ab, ba3], 'nothing changed');
  const cx = ok(await call('POST', `/deals/${id}/cancel-transfer`, {}, B3.agent));
  assert.equal(cx.transfer.state, 'cancelled');
  // The control: the correct body applies (the test's signatures are right, so the refusals above are the rules').
  x = await send(good);
  assert.deepEqual([x.status, x.success], [200, true], JSON.stringify(x));
  assert.deepEqual([(await edge(N1, N2)).total, (await edge(N2, N3)).total, (await edge(N3, N1)).total], [0, 0, 0]);
});

test('an edge that does not reconcile exactly with the journal (a note recorded around Valun) is never cleared: the engine leaves it out, and a proposal made directly is refused (not_reconciled); the reconciliation flags it', async t => {
  if (!live(t)) return;
  const U = await party('rec-u'), V = await party('rec-v', {mandate: {auto_clear: false}});
  await owes(U, V, 2); await owes(V, U, 2);
  const moved = await basis.issueNote({issuer: U.pubkey, recipient: V.pubkey, total: 3, secretHex: U.secret});   // straight at the tracker
  assert.equal(moved.response.success, true, JSON.stringify(moved.response));
  await setMandate(V, {auto_clear: true});
  const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.ok(run.excluded.not_reconciled >= 1, JSON.stringify(run.excluded));
  assert.equal(liveWith(U, V), undefined, 'not eligible');
  const uv = await edge(U, V), vu = await edge(V, U);
  const res = await pilot.serial(() => pilot.createSetoff({edges: [{edge: K(U, V), decrease: 2, state: uv}, {edge: K(V, U), decrease: 2, state: vu}],
    cycles: [{edges: [K(U, V), K(V, U)], length: 2, amount: 2}]}, {source: 'admin'}));
  assert.deepEqual(res, {skipped: 'not_reconciled'});
  const row = (await pilot.reconcile()).find(x => x.issuer === U.handle && x.recipient === V.handle);
  assert.deepEqual([row.tracker_total, row.expected_total, row.status, row.exact], [3, 2, 'tracker-has-debt-not-agreed-in-valun', false], 'flagged, never corrected');
  assert.equal(ok(await call('GET', '/ledger')).reconciliation.find(x => x.issuer === U.handle && x.recipient === V.handle).status, 'tracker-has-debt-not-agreed-in-valun', 'and so is the public row');
});

test('revoking a member\'s key voids its collecting set-off (void_key_revoked, purged)', async t => {
  if (!live(t)) return;
  const R1 = await party('rev-1'), R2 = await party('rev-2');
  await owes(R1, R2, 2); await owes(R2, R1, 2);
  const o = await waitFor(() => liveWith(R1, R2), 'the proposal');
  ok(await consent(R1, o.id));
  const rv = ok(await call('POST', '/owner/revoke-agent', null, R2.owner));
  assert.deepEqual(rv.voided_setoffs, [o.id]);
  assert.deepEqual([o.state, o.result.code], ['void_key_revoked', 'key_revoked']);
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature));
  assert.deepEqual([(await edge(R1, R2)).total, (await edge(R2, R1)).total], [2, 2]);
  assert.equal(ok(await call('GET', '/consents', null, R1.agent)).recently_resolved.find(x => x.id === o.id)?.state, 'void_key_revoked');
});

test('a credit note held for its owner on a pair supersedes a collecting set-off there at once (held_note, decision D-2 c), whatever their timestamps; no set-off is proposed on the pair while it is held; the owner\'s approval records the note; a held note that went stale stays a payment attempt holding its pair, also once newer notes replace it', async t => {
  if (!live(t)) return;
  const P = await party('held-p'), Q = await party('held-q', SERVER);
  await owes(P, Q, 3); await owes(Q, P, 2);
  const o = await waitFor(() => liveWith(P, Q), 'the proposal');
  await setMandate(P, {review_deliveries: true});
  const id = await delivered(P, Q, 1);
  // The held note's timestamp (ending in 997 ms) is later than the set-off's on P>Q: a note template fetched at least
  // 2.5 s after that timestamp. Under D-1 alone the set-off would still have applied (and the note gone stale); under
  // D-2 c it never applies while the note is held (the next test: a held note whose timestamp precedes it).
  const ts = o.edges.find(e => e.edge === K(P, Q)).timestamp;
  while (now() < ts + 2500) await sleep(50);
  const pq = await edge(P, Q), qp = await edge(Q, P);
  assert.equal(ok(await complete(P, id)).status, 'completion_awaiting_owner');
  assert.ok(pilot.s.deals[id].credit_note.note.timestamp > ts);
  assert.deepEqual([o.state, o.result?.code], ['superseded', 'held_note'], 'superseded when the note was held');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, P.agent), 409, 'wrong_state');
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  assert.deepEqual([await edge(P, Q), await edge(Q, P)], [pq, qp], 'nothing applied');
  const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(P, Q), undefined, `not proposed again while the note is held: ${JSON.stringify(run.excluded)}`);
  const ap = ok(await call('GET', '/owner', null, P.owner)).approvals.find(a => a.deal_id === id && a.state === 'pending');
  assert.equal(ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, P.owner)).deal.status, 'note_issued');
  assert.equal((await edge(P, Q)).total, 4, 'the pair is as the note was signed against: recorded');
  // A held note that went stale (here its pair moved around Valun) is still a payment attempt the payer's client checks
  // by reading P>Q back (decision D-1): the pair stays held at its timestamp, also once a newer note (held again, then
  // rejected by the owner) replaces it.
  await setMandate(Q, {auto_clear: false});                              // keeps the engine off the pair (it no longer reconciles anyway)
  const id2 = await delivered(P, Q, 1);
  assert.equal(ok(await complete(P, id2)).status, 'completion_awaiting_owner');
  const ts1 = pilot.s.deals[id2].credit_note.note.timestamp;
  const moved = await basis.issueNote({issuer: P.pubkey, recipient: Q.pubkey, total: 9, secretHex: P.secret});
  assert.equal(moved.response.success, true, JSON.stringify(moved.response));
  const ap2 = ok(await call('GET', '/owner', null, P.owner)).approvals.find(a => a.deal_id === id2 && a.state === 'pending');
  refused(await call('POST', `/owner/approvals/${ap2.id}`, {decision: 'approve'}, P.owner), 409, 'stale_note');
  assert.deepEqual([pilot.s.approvals[ap2.id].state, pilot.s.deals[id2].status, pilot.s.deals[id2].credit_note.state], ['void_stale', 'delivered', 'stale']);
  assert.equal(pilot.paymentAttemptHolds().get(K(P, Q)), ts1);
  assert.equal(ok(await complete(P, id2)).status, 'completion_awaiting_owner');
  assert.ok(pilot.s.deals[id2].credit_note.note.timestamp > ts1);
  assert.equal(pilot.paymentAttemptHolds().get(K(P, Q)), ts1, 'held from the earlier note\'s timestamp');
  const ap3 = ok(await call('GET', '/owner', null, P.owner)).approvals.find(a => a.deal_id === id2 && a.state === 'pending');
  ok(await call('POST', `/owner/approvals/${ap3.id}`, {decision: 'reject'}, P.owner));
  assert.deepEqual([pilot.s.deals[id2].status, pilot.paymentAttemptHolds().get(K(P, Q))], ['delivered', ts1], 'the deal is unpaid: still held');
});

test('a credit note held for its owner whose timestamp precedes a set-off\'s on its pair supersedes the set-off at once too (held_note, decision D-2 c: moved past the note\'s timestamp, the pair would read back to the payer\'s client as a note of unknown outcome); the owner\'s approval then records the note, and the engine proposes the cycle again', async t => {
  if (!live(t)) return;
  const P = await party('hold2-p'), Q = await party('hold2-q', SERVER);
  await owes(P, Q, 3);
  const pq0 = await edge(P, Q);
  while (now() < pq0.timestamp + 3000) await sleep(50);                // P>Q's last note well before the set-off's timestamp
  await owes(Q, P, 2);
  const o = await waitFor(() => liveWith(P, Q), 'the proposal');
  const ts = o.edges.find(e => e.edge === K(P, Q)).timestamp;
  await setMandate(P, {review_deliveries: true});
  const id = await delivered(P, Q, 1);
  // Decision D-2 b: the bound template itself comes after the live set-off's timestamp on P>Q. A client may still sign
  // its note at an earlier timestamp the server accepts (after the pair's last note, not in the future): P's agent signs
  // at ts - 1, before the set-off's timestamp on P>Q.
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, P.agent));
  assert.ok(tpl.timestamp > ts && tpl.timestamp % 1000 === 997, `the template follows the set-off: ${tpl.timestamp} > ${ts}`);
  const at = ts - 1, signAt = async total => basis.signHex(P.pubkey, await msg(P.pubkey, Q.pubkey, total, at), P.secret);
  const ackAt = await priorSig(P, P.pubkey, Q.pubkey, tpl.prior_total, tpl.prior_timestamp, at);       // PA of the pair's note, at the note's own timestamp
  const held = ok(await call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: at, signature: await signAt(tpl.total), prior_total: tpl.prior_total, prior_timestamp: tpl.prior_timestamp, prior_signature: ackAt}}, P.agent));
  assert.deepEqual([held.status, pilot.s.deals[id].credit_note.note.timestamp], ['completion_awaiting_owner', ts - 1]);
  assert.equal(pilot.paymentAttemptHolds().get(K(P, Q)), ts - 1, 'the held note holds its pair at its timestamp');
  const pq = await edge(P, Q), qp = await edge(Q, P);
  assert.deepEqual([o.state, o.result?.code], ['superseded', 'held_note'], 'superseded when the note was held');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, P.agent), 409, 'wrong_state');
  assert.deepEqual([await edge(P, Q), await edge(Q, P)], [pq, qp], 'nothing applied');
  assert.equal(pilot.s.clearing.cooldowns[`set:${o.edge_set}`], undefined, 'no cooldown after a supersession');
  // The owner approves: the pair is exactly as the note was signed against, so the tracker records it.
  const ap = ok(await call('GET', '/owner', null, P.owner)).approvals.find(a => a.deal_id === id && a.state === 'pending');
  ok(await call('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'}, P.owner));
  assert.deepEqual([pilot.s.deals[id].status, (await edge(P, Q)).total], ['note_issued', 4]);
  assert.equal(pilot.paymentAttemptHolds().has(K(P, Q)), false, 'paid: the hold has ended');
  // The raised edge closes the cycle again (P>Q 4, Q>P 2): proposed, and applied.
  const o2 = await waitFor(() => liveWith(P, Q), 'proposed again once the note is recorded');
  assert.ok(o2.id !== o.id && o2.edges.every(e => e.decrease === 2));
  assert.equal(ok(await consent(P, o2.id)).state, 'applied');
  assert.deepEqual([(await edge(P, Q)).total, (await edge(Q, P)).total], [2, 0]);
});

test('crash injection: a crash after the write-ahead leaves the set-off applying (on disk) and its edges busy; recover() adopts one the tracker applied and resubmits one it never got (after a restart too); an unreachable tracker leaves it applying (200); one past the maximum age fails', async t => {
  if (!live(t)) return;
  const onDisk = vs => JSON.parse(fs.readFileSync(path.join(storeDir, 'pilot-state.json'), 'utf8')).setoffs[vs].state;
  const pairWithSetoff = async (name, {xRoles = 'setoff'} = {}) => {
    const X = await party(`${name}-x`, {roles: xRoles}), Y = await party(`${name}-y`);
    await owes(X, Y, 3); await owes(Y, X, 3);
    const o = await waitFor(() => liveWith(X, Y), 'the proposal');
    ok(await consent(X, o.id));
    return {X, Y, o};
  };
  // 1. The tracker applied it, then the process "crashed" before reading back.
  const a = await pairWithSetoff('crash1');
  hooks.setoff = async (body, original) => { await original(body); throw new Error('simulated crash after the tracker call'); };
  let r;
  try { r = await consent(a.Y, a.o.id); } finally { delete hooks.setoff; }
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.deepEqual([a.o.state, onDisk(a.o.id)], ['applying', 'applying']);
  const busy = await delivered(a.X, a.Y, 1);
  refused(await call('GET', `/deals/${busy}/credit-note-template?prior=1&bound=1`, null, a.X.agent), 409, 'edge_busy', 'its edges wait for the read-back');
  assert.ok((await pilot.recover()).includes(`${a.o.id}:applied`));
  assert.deepEqual([a.o.result.recovered, (await edge(a.X, a.Y)).total, (await edge(a.Y, a.X)).total], [true, 0, 0]);
  assert.equal(ok(await call('GET', '/edges', null, a.X.agent)).journal.filter(e => e.ref === a.o.id).length, 2);
  // 2. The process "crashed" before the tracker got it: a restarted server (a new Pilot over a copy of the saved state,
  //    built as server.mjs builds it) resubmits it.
  const b = await pairWithSetoff('crash2');
  hooks.setoff = async () => { throw new Error('simulated crash before the tracker call'); };
  try { r = await consent(b.Y, b.o.id); } finally { delete hooks.setoff; }
  assert.equal(r.status, 502);
  assert.deepEqual([onDisk(b.o.id), (await edge(b.X, b.Y)).total], ['applying', 3]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-setoff-restart-'));
  try {
    for (const f of fs.readdirSync(storeDir)) fs.copyFileSync(path.join(storeDir, f), path.join(dir2, f));
    const p2 = new Pilot({store: new PilotStore(dir2), basis, now, circulation: 'on', trackerSha256: pilot.trackerSha256, log: m => logs.push(m)});
    p2.trackerCaps = pilot.trackerCaps; p2.serverSigner = pilot.serverSigner;
    assert.equal(p2.s.setoffs[b.o.id].state, 'applying');
    assert.ok((await p2.recover()).includes(`${b.o.id}:applied`));
    assert.deepEqual([p2.s.setoffs[b.o.id].result.code, p2.s.setoffs[b.o.id].result.tracker_status], ['applied', 200], 'resubmitted, and applied');
  } finally { fs.rmSync(dir2, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
  assert.deepEqual([(await edge(b.X, b.Y)).total, (await edge(b.Y, b.X)).total], [0, 0]);
  assert.ok((await pilot.recover()).includes(`${b.o.id}:applied`), 'this server decides it by read-back as well');
  // 3. The tracker is unreachable for the submission: it stays applying (the consent answers 200), recovery applies it.
  //    Meanwhile Y's payment options show X's note as busy (a payment by transfer from it would be refused so), while
  //    its own note to Z, on an edge the set-off does not touch, stays available.
  const c = await pairWithSetoff('crash3', {xRoles: 'setoff,issuer'});
  const Z = await party('crash3-z', {roles: 'creditor'}), zDeal = await delivered(c.Y, Z, 1);
  const heldX = po => po.held_notes.find(h => h.issuer.id === c.X.id);
  assert.equal(heldX(ok(await call('GET', `/deals/${zDeal}/payment-options`, null, c.Y.agent))).why_not, null, 'usable before');
  hooks.setoff = async () => { throw new BasisError('tracker unreachable: ECONNREFUSED'); };
  try { r = ok(await consent(c.Y, c.o.id)); } finally { delete hooks.setoff; }
  assert.equal(r.state, 'applying');
  const po = ok(await call('GET', `/deals/${zDeal}/payment-options`, null, c.Y.agent));
  assert.deepEqual([heldX(po).why_not, po.own_note.available], ['edge_busy', true]);
  refused(await call('GET', `/deals/${zDeal}/transfer-template?issuer=${c.X.id}`, null, c.Y.agent), 409, 'edge_busy', 'and the template says so too');
  assert.ok((await pilot.recover()).includes(`${c.o.id}:applied`));
  // 4. Left applying past the tracker's maximum age: not resubmitted; failed (nothing applied).
  const d = await pairWithSetoff('crash4');
  hooks.setoff = async () => { throw new Error('simulated crash'); };
  try { await consent(d.Y, d.o.id); } finally { delete hooks.setoff; }
  clockOffset = 61 * MIN;
  try { assert.ok((await pilot.recover()).includes(`${d.o.id}:failed`)); } finally { clockOffset = 0; }
  assert.deepEqual([d.o.result.code, (await edge(d.X, d.Y)).total, (await edge(d.Y, d.X)).total], ['novation_expired', 3, 3]);
  assert.ok(d.o.edges.every(e => e.timestamp < now() + 61 * MIN - MAX_AGE_MS), 'its timestamps were past the maximum age');
  // 5. Left applying and untouched while an earlier payment attempt of a deal not yet paid holds one of its edges at an
  //    earlier timestamp (applySetoff never lets one start applying so, and while it applies no payment starts on its
  //    edges; recovery checks again, here with such a hold made up): failed, never submitted again.
  const f = await pairWithSetoff('crash5');
  hooks.setoff = async () => { throw new BasisError('tracker unreachable: ECONNREFUSED'); };
  try { assert.equal(ok(await consent(f.Y, f.o.id)).state, 'applying'); } finally { delete hooks.setoff; }
  const k5 = K(f.X, f.Y), ts5 = f.o.edges.find(e => e.edge === k5).timestamp;
  pilot.paymentAttemptHolds = () => new Map([[k5, ts5 - 1]]);
  try { assert.ok((await pilot.recover()).includes(`${f.o.id}:failed`)); } finally { delete pilot.paymentAttemptHolds; }
  assert.deepEqual([f.o.result?.code, (await edge(f.X, f.Y)).total, (await edge(f.Y, f.X)).total], ['payment_attempt', 3, 3]);
});

test('a cycle whose member was away when it closed is proposed at that member\'s next consent poll (GET /consents, in the same answer), and searched again at most once per 30 s', async t => {
  if (!live(t)) return;
  const X = await party('poll-x'), Y = await party('poll-y');
  await owes(X, Y, 2);
  const id = await delivered(Y, X, 2);
  pilot.s.participants[X.id].last_seen_agent = new Date(now() - 11 * MIN).toISOString();   // X's agent has been away 11 minutes
  assert.equal(ok(await complete(Y, id)).status, 'note_issued');                          // closes X>Y>X while X is away
  assert.equal(liveWith(X, Y), undefined, 'not proposed while a member is away');
  const c = ok(await call('GET', '/consents', null, X.agent));
  const item = c.consents.find(x => x.kind === 'setoff');
  assert.ok(item, 'proposed on X\'s poll, and listed in the answer to it');
  const o = S_(item.id);
  assert.deepEqual([o.source, o.amount, clearing.lastRun.reason], ['presence', 4, 'presence']);
  await checkAsClient(X, item);
  const seen = clearing.lastRun.id;
  ok(await call('GET', '/consents', null, X.agent));
  assert.equal(clearing.lastRun.id, seen, 'within 30 s of its last poll, not searched again');
  assert.equal(setoffsWith(X, Y).length, 1);
  ok(await call('POST', `/consents/${o.id}`, await setoffBody(X, item), X.agent));
  assert.equal(ok(await consent(Y, o.id)).state, 'applied');
  assert.deepEqual([(await edge(X, Y)).total, (await edge(Y, X)).total], [0, 0]);
});

test('a live payment by transfer on one of its edges supersedes a collecting set-off at once (payment_attempt, decision D-2 c; it never blocks the payment); once the payment applied and paid its deal, the engine proposes the cycle again', async t => {
  if (!live(t)) return;
  const A = await party('wait-a', {roles: 'setoff,issuer'}), B = await party('wait-b'), C = await party('wait-c', {roles: 'creditor'});
  await owes(A, B, 3); await owes(B, A, 2);
  const o = await waitFor(() => liveWith(A, B), 'the proposal');
  ok(await consent(A, o.id));
  const id = await delivered(B, C, 1), {r} = await pay(B, id, A), vt = ok(r).transfer.id;   // A and C must still sign it
  assert.equal(pilot.s.transfers[vt].state, 'collecting', 'the collecting set-off did not block the payment');
  assert.deepEqual([o.state, o.result?.code], ['superseded', 'payment_attempt'], 'superseded when the payment was made');
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, B.agent), 409, 'wrong_state');
  assert.equal((await edge(A, B)).total, 3, 'nothing applied');
  await clearing.tick();
  assert.equal(liveWith(A, B), undefined, 'not proposed again while the payment is live');
  ok(await consentTransfer(A, vt));
  assert.equal(ok(await consentTransfer(C, vt)).state, 'applied');
  assert.equal(pilot.s.deals[id].status, 'paid_by_transfer');
  // A>B 2, B>A 2: once the deal is paid the pair is free again.
  await runUntil(() => liveWith(A, B), 'proposed again once the deal is paid');
  const o2 = liveWith(A, B);
  assert.deepEqual(o2.edges.map(e => e.decrease), [2, 2]);
  ok(await consent(A, o2.id));
  assert.equal(ok(await consent(B, o2.id)).state, 'applied');
  assert.deepEqual([(await edge(A, B)).total, (await edge(B, A)).total], [0, 0]);
});

test('a new proposal on edges an earlier one used never takes its timestamps again (one operation per (edge, timestamp), rule R4)', async t => {
  if (!live(t)) return;
  const U = await party('r4-u'), V = await party('r4-v', {mandate: {auto_clear: false}});
  await owes(U, V, 2); await owes(V, U, 2);
  await setMandate(V, {auto_clear: true});
  const uv = await edge(U, V), vu = await edge(V, U);
  while (Date.now() < Math.max(uv.timestamp, vu.timestamp) + 5000) await new Promise(r => setTimeout(r, 100));   // both notes well behind the clock
  const pkg = {edges: [{edge: K(U, V), decrease: 2, state: uv}, {edge: K(V, U), decrease: 2, state: vu}], cycles: [{edges: [K(U, V), K(V, U)], length: 2, amount: 2}]};
  // This server's clock is set just after a timestamp ending in 998 ms (1.5 s back), so both proposals below choose
  // their timestamps within the same second: the second must not take the first one's.
  clockOffset = -((Date.now() - 1503) % 1000);
  let o1, o2;
  try {
    o1 = await pilot.serial(() => pilot.createSetoff(pkg, {source: 'admin'}));
    assert.ok(o1.id, JSON.stringify(o1));
    pilot.endSetoff(o1, 'superseded', 'ended_by_test');                  // ended at once (no cooldown after a supersession)
    o2 = await pilot.serial(() => pilot.createSetoff(pkg, {source: 'admin'}));
  } finally { clockOffset = 0; }
  assert.ok(o2.skipped === 'timestamp_ahead' || o2.edges.every(e => e.timestamp > o1.edges.find(x => x.edge === e.edge).timestamp), JSON.stringify(o2.skipped ?? o2.edges.map(e => e.timestamp)));
  if (o2.id) pilot.endSetoff(o2, 'superseded', 'ended_by_test');
});

// ---------- set-offs and payment attempts (decision D-1) ----------
test('an earlier payment attempt of a deal not yet paid keeps the engine off the edges it would change (decision D-1): after a cancelled payment by transfer, a 2-cycle through its from-edge whose amount is the price is not proposed while the deal is payment_due (nor made directly: busy), and is once a retry through the same note (on the same prior state: it need not wait for the attempt\'s window) has paid the deal', async t => {
  if (!live(t)) return;
  const A = await party('hold-a', {roles: 'setoff,issuer'}), B = await party('hold-b'), C = await party('hold-c', {roles: 'creditor'});
  // The attempt is made on this server's clock 62 minutes behind (the tracker accepts old ordinary notes, so the notes
  // made then are ordinary ones; the attempt never reaches it), so that its window (T + 1 h + 60 s) has passed on the
  // real clock, where the retry is made.
  const ordinaryOwes = async (X, Y, price) => {
    const did = await delivered(X, Y, price), tpl = ok(await call('GET', `/deals/${did}/credit-note-template`, null, X.agent));
    const body = {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256, signature: await sign(X, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
      credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(X.pubkey, tpl.message_hex, X.secret)}};
    assert.equal(ok(await call('POST', `/deals/${did}/complete`, body, X.agent)).status, 'note_issued');
  };
  clockOffset = -62 * MIN;
  let id, ab;
  try {
    await ordinaryOwes(A, B, 3);                                         // A>B 3
    id = await delivered(B, C, 2);
    const {tpl, r} = await pay(B, id, A), vt = ok(r).transfer.id;       // A and C have not signed it
    assert.equal(ok(await call('POST', `/deals/${id}/cancel-transfer`, {}, B.agent)).transfer.state, 'cancelled');
    assert.equal(pilot.s.deals[id].status, 'payment_due');
    const T = pilot.s.transfers[vt].timestamp;
    ab = await edge(A, B);
    assert.deepEqual(ab, tpl.from_edge.before, 'A>B is as the attempt found it');
    const holds = pilot.paymentAttemptHolds();
    assert.deepEqual([holds.get(K(A, B)), holds.get(K(A, C))], [T, T], 'both edges of the attempt, at its timestamp');
    // B buys from A for 2 with its own note: A>B 3 and B>A 2 close a cycle of 2, the price. Applied, it would leave A>B
    // at 1 = 3 - 2 after T, which the payer's client reads back as its attempt applied (already_paid): it would never pay C.
    await ordinaryOwes(B, A, 2);
    assert.equal(setoffsWith(A, B).length, 0, 'not proposed when the cycle closes');
    const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
    assert.ok(run.excluded.busy >= 1 && setoffsWith(A, B).length === 0, `nor by the batch: ${JSON.stringify(run.excluded)}`);
    const ba = await edge(B, A);
    const pkg = {edges: [{edge: K(A, B), decrease: 2, state: ab}, {edge: K(B, A), decrease: 2, state: ba}], cycles: [{edges: [K(A, B), K(B, A)], length: 2, amount: 2}]};
    assert.deepEqual(await pilot.serial(() => pilot.createSetoff(pkg, {source: 'admin'})), {skipped: 'busy'}, 'nor when made directly');
    assert.deepEqual(await edge(A, B), ab, 'A>B is untouched: the attempt still reads back as not applied');
    // A retry through the same note at once is not held back by the attempt's window: A>B is in the state the attempt
    // acknowledged, so at the tracker at most one of the two can apply (the same-prior exemption, tracker v3.2).
    assert.deepEqual((await template(B, id, A)).from_edge.before, ab, 'the same note within the window: a template, on the same prior state');
  } finally { clockOffset = 0; }
  // Past the window (the real clock): the deal is still unpaid, so the hold on A>B stays and no set-off is proposed.
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(setoffsWith(A, B).length, 0, 'the deal is still unpaid: none on A>B');
  // A retry through the same note, signed by A and C, pays the deal.
  const {r: r2} = await pay(B, id, A), vt2 = ok(r2).transfer.id;
  ok(await consentTransfer(A, vt2));
  assert.equal(ok(await consentTransfer(C, vt2)).state, 'applied');
  assert.equal(pilot.s.deals[id].status, 'paid_by_transfer');
  assert.equal(pilot.paymentAttemptHolds().has(K(A, B)), false, 'paid: the hold has ended');
  await runUntil(() => liveWith(A, B), 'proposed once the deal is paid');
  const o = liveWith(A, B);
  assert.deepEqual(o.edges.map(e => [e.edge, e.decrease]).sort(), [[K(A, B), 1], [K(B, A), 1]].sort(), 'A>B 1, B>A 2: a cycle of 1');
  ok(await consent(A, o.id));
  assert.equal(ok(await consent(B, o.id)).state, 'applied');
  assert.deepEqual([(await edge(A, B)).total, (await edge(B, A)).total], [0, 1]);
});

test('a payment attempt on any edge of a collecting set-off supersedes it at once whatever their timestamps (payment_attempt, decision D-2 c): an edge between server-run members and a client edge that moved; nothing applies, nothing is made again, and the engine keeps off them while the deal is unpaid', async t => {
  if (!live(t)) return;
  // 1. X and M are run by the server; C1 signs last. M pays C2 with X's note (from-edge X>M), then cancels it.
  const X = await party('pa-x', SERVER), M = await party('pa-m', SERVER), C1 = await party('pa-c1'), C2 = await party('pa-c2', {roles: 'creditor'});
  await owes(X, M, 4); await owes(M, C1, 2); await owes(C1, X, 2);      // closes X>M>C1>X
  const o = await waitFor(() => liveWith(X, M, C1), 'the 3-cycle');
  assert.equal(o.edges.find(e => e.edge === K(X, M)).server_only, true);
  const before1 = [await edge(X, M), await edge(M, C1), await edge(C1, X)];
  const id = await delivered(M, C2, 1), {r} = await pay(M, id, X), vt = ok(r).transfer.id;  // C2 must still sign it
  assert.equal(pilot.s.transfers[vt].state, 'collecting', 'the collecting set-off does not block the payment');
  assert.deepEqual([o.state, o.result?.code], ['superseded', 'payment_attempt'], 'superseded when the payment was made');
  assert.equal(ok(await call('POST', `/deals/${id}/cancel-transfer`, {}, M.agent)).transfer.state, 'cancelled');
  refused(await call('POST', `/consents/${o.id}`, {signatures: {}}, C1.agent), 409, 'wrong_state');
  assert.deepEqual([await edge(X, M), await edge(M, C1), await edge(C1, X)], before1, 'nothing applied');
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  assert.equal(pilot.s.clearing.cooldowns[`set:${o.edge_set}`], undefined, 'no cooldown after a supersession');
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(X, M, C1), undefined, 'not proposed again while the deal is unpaid');
  // 2. A 2-cycle between clients; A>B moves with a new note during collection (an edge to be made again at apply); then
  //    B pays C with A's note. The set-off's own timestamp on A>B precedes the attempt's: superseded all the same.
  const A = await party('pa-a', {roles: 'setoff,issuer'}), B = await party('pa-b'), C = await party('pa-c', {roles: 'creditor'});
  await owes(A, B, 3); await owes(B, A, 2);
  const o2 = await waitFor(() => liveWith(A, B), 'the 2-cycle');
  ok(await consent(A, o2.id));
  await owes(A, B, 1);                                                   // A>B moves to 4
  const before2 = [await edge(A, B), await edge(B, A)];
  const id2 = await delivered(B, C, 1), {r: rb} = await pay(B, id2, A), vt2 = ok(rb).transfer.id;
  assert.deepEqual([o2.state, o2.result?.code], ['superseded', 'payment_attempt'], 'superseded when the payment was made');
  assert.ok(o2.edges.find(e => e.edge === K(A, B)).timestamp < pilot.s.transfers[vt2].timestamp, 'precondition: the set-off\'s timestamp precedes the attempt\'s');
  assert.equal(ok(await call('POST', `/deals/${id2}/cancel-transfer`, {}, B.agent)).transfer.state, 'cancelled');
  assert.deepEqual([await edge(A, B), await edge(B, A)], before2, 'nothing applied');
  assert.ok(!o2.history.some(h => h.event === 'regenerated'), 'not made again');
  ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(A, B), undefined, 'not proposed again while the deal is unpaid');
});

test('two set-offs that share an edge between server-run members: while the first is being applied (the tracker never got it), the second waits, collecting with every signature, and its tick does nothing; recovery applies the first, then the tick applies the second at the edge\'s state after the first; no alarm', async t => {
  if (!live(t)) return;
  const X = await party('sh-x', SERVER), M = await party('sh-m', SERVER), C1 = await party('sh-c1'), C2 = await party('sh-c2');
  await owes(X, M, 4);
  await owes(M, C1, 2); await owes(C1, X, 2);
  const s1 = await waitFor(() => liveWith(X, M, C1), 'S1');
  await owes(M, C2, 2); await owes(C2, X, 2);
  const s2 = await waitFor(() => liveWith(X, M, C2), 'S2');
  assert.deepEqual([s1, s2].map(o => o.edges.find(e => e.edge === K(X, M))).map(e => [e.server_only, e.decrease]), [[true, 2], [true, 2]], 'both on X>M, which only reserves their decreases');
  hooks.setoff = async () => { throw new BasisError('tracker unreachable: ECONNREFUSED'); };
  try { assert.equal(ok(await consent(C1, s1.id)).state, 'applying'); } finally { delete hooks.setoff; }
  const xm = await edge(X, M);
  assert.equal(xm.total, 4, 'the tracker never got S1');
  refused(await call('GET', `/deals/${await delivered(X, M, 1)}/credit-note-template?prior=1&bound=1`, null, X.agent), 409, 'edge_busy', 'X>M waits for the read-back');
  assert.equal(ok(await consent(C2, s2.id)).state, 'collecting', 'S2 waits while S1 is being applied');
  assert.ok(pilot.setoffComplete(s2));
  await clearing.tick();
  assert.deepEqual([s1.state, s2.state, await edge(X, M)], ['applying', 'collecting', xm], 'the tick leaves S2 waiting');
  // Recovery submits S1 again (applied), then applies S2, complete and collecting (recover() applies a complete set-off
  // whose apply never started as well), at the edge's state after S1.
  // S2's server-only X>M needs a fresh timestamp after every set-off timestamp on X>M, S1's included (residue 998, at
  // least TIMESTAMP_LAG_MS behind the clock): until there is one, recover() rightly defers S2 ('waiting'). On a fast
  // machine (Linux) the steps above take less than that, so wait for it here, by the server's own rule.
  const afterXM = Math.max(xm.timestamp, pilot.lastSetoffTimestamp(K(X, M)));
  for (let w; (w = novationTimestamp({now: now(), residue: 998, after: afterXM})).timestamp === undefined;) await sleep(w.ahead_ms + 10);
  const rec = await pilot.recover();
  assert.ok(rec.includes(`${s1.id}:applied`) && rec.indexOf(`${s1.id}:applied`) < rec.indexOf(`${s2.id}:applied`), `S1 first, then S2: ${JSON.stringify(rec)}`);
  await clearing.tick();
  assert.equal(s2.state, 'applied', 'S2 applied after S1');
  const exm = s2.edges.find(e => e.edge === K(X, M));
  assert.deepEqual([exm.before.total, exm.new_total, (await edge(X, M)).total, (await edge(C2, X)).total, (await edge(M, C2)).total], [2, 0, 0, 0, 0]);
  assert.deepEqual([s1.result?.code, s2.result?.code], ['applied', 'applied']);
  assert.deepEqual(logs.filter(l => /ALARM/.test(l) && (l.includes(s1.id) || l.includes(s2.id))), [], 'no alarm');
});

test('a consent whose own mandate no longer allows it ends the novation at once (failed, mandate_changed; 403 payment_not_accepted names the rule), instead of leaving it to expire: a member whose owner turned auto_clear off, and a payee whose owner stopped accepting transfers', async t => {
  if (!live(t)) return;
  const U = await party('mc-u'), V = await party('mc-v');
  await owes(U, V, 2); await owes(V, U, 2);
  const o = await waitFor(() => liveWith(U, V), 'the proposal');
  ok(await consent(U, o.id));
  const body = await setoffBody(V, await itemFor(V, o.id));
  await setMandate(V, {auto_clear: false});
  const r = refused(await call('POST', `/consents/${o.id}`, body, V.agent), 403, 'payment_not_accepted');
  assert.deepEqual([r.by, r.rule], ['member', 'auto_clear']);
  assert.deepEqual([o.state, o.result?.code, o.result?.rule], ['failed', 'mandate_changed', 'auto_clear']);
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  assert.equal(pilot.s.clearing.expiry_streaks?.[V.id], undefined, 'no expiry counted against it');
  assert.deepEqual([(await edge(U, V)).total, (await edge(V, U)).total], [2, 2], 'nothing applied');
  assert.deepEqual(ok(await call('GET', `/setoffs/${o.id}`, null, U.agent)).result, {code: 'mandate_changed', at: o.result?.at}, 'the other member sees the code, not whose rule');
  // A transfer: A signs; then C's owner stops accepting transfers, and C's consent arrives.
  const A = await party('mc-a', {roles: 'setoff,issuer'}), B = await party('mc-b'), C = await party('mc-c', {roles: 'creditor'});
  await owes(A, B, 3);
  const id = await delivered(B, C, 2), {r: pr} = await pay(B, id, A), vt = ok(pr).transfer.id;
  ok(await consentTransfer(A, vt));
  const cb = await transferBody(C, await itemFor(C, vt));
  await setMandate(C, {accept_transfers: false});
  const rc = refused(await call('POST', `/consents/${vt}`, cb, C.agent), 403, 'payment_not_accepted');
  assert.deepEqual([rc.by, rc.rule], ['payee', 'accept_transfers']);
  const tr = pilot.s.transfers[vt];
  assert.deepEqual([tr.state, tr.result?.code, tr.result?.rule, pilot.s.deals[id].status], ['failed', 'mandate_changed', 'accept_transfers', 'payment_due']);
  assert.ok(Object.values(tr.slots).every(s => !s?.signature), 'purged');
  assert.deepEqual([(await edge(A, B)).total, await edge(A, C)], [3, null], 'nothing moved');
});

test('a proposal handed to createSetoff that does not balance for every key is refused before anything is read or recorded (not_balanced)', async t => {
  if (!live(t)) return;
  const off = {mandate: {auto_clear: false}};
  const U = await party('ub-u', off), V = await party('ub-v', off);
  await owes(U, V, 3); await owes(V, U, 3);
  await setMandate(U, {auto_clear: true}); await setMandate(V, {auto_clear: true});
  const n = Object.keys(pilot.s.setoffs).length, uv = await edge(U, V), vu = await edge(V, U);
  try {
    for (const [d1, d2] of [[2, 1], [3, 2], [1, 3]]) {
      const res = await pilot.serial(() => pilot.createSetoff({edges: [{edge: K(U, V), decrease: d1, state: uv}, {edge: K(V, U), decrease: d2, state: vu}], cycles: []}, {source: 'admin'}));
      assert.deepEqual(res, {skipped: 'not_balanced'}, `${d1}/${d2}`);
    }
    assert.equal(Object.keys(pilot.s.setoffs).length, n, 'nothing recorded');
    assert.deepEqual([await edge(U, V), await edge(V, U)], [uv, vu]);
  } finally { await setMandate(U, {auto_clear: false}); }
});

test('in mode sandbox only sandbox participants clear: a proposal with a member outside the sandbox is refused (sandbox_only, nothing recorded); one among sandbox participants is made', async t => {
  if (!live(t)) return;
  const off = {mandate: {auto_clear: false}};
  const W = await party('sb-w', off), Z = await party('sb-z', off), Y = await party('sb-y', off);
  await owes(W, Z, 2); await owes(Z, W, 2); await owes(W, Y, 2); await owes(Y, W, 2);
  for (const P of [W, Z, Y]) await setMandate(P, {auto_clear: true});
  const pkg = async (I, R) => ({edges: [{edge: K(I, R), decrease: 2, state: await edge(I, R)}, {edge: K(R, I), decrease: 2, state: await edge(R, I)}],
    cycles: [{edges: [K(I, R), K(R, I)], length: 2, amount: 2}]});
  const [wz, wy] = [await pkg(W, Z), await pkg(W, Y)];
  const last = Math.max(...wy.edges.map(e => e.state.timestamp));
  while (Date.now() < last + 3000) await sleep(100);                    // a timestamp ending in 998 ms after both notes
  pilot.sandboxIds.add(W.id); pilot.sandboxIds.add(Y.id);              // W and Y as sandbox participants; Z is not
  pilot.circulation = 'sandbox';
  try {
    assert.equal(pilot.mode, 'sandbox');
    const n = Object.keys(pilot.s.setoffs).length;
    assert.deepEqual(await pilot.serial(() => pilot.createSetoff(wz, {source: 'admin'})), {skipped: 'sandbox_only'});
    assert.equal(Object.keys(pilot.s.setoffs).length, n, 'nothing recorded');
    const o = await pilot.serial(() => pilot.createSetoff(wy, {source: 'admin'}));
    assert.ok(o.id && o.state === 'collecting' && o.members.length === 2, JSON.stringify(o));
    pilot.endSetoff(o, 'superseded', 'ended_by_test');
  } finally {
    pilot.circulation = 'on'; pilot.sandboxIds.delete(W.id); pilot.sandboxIds.delete(Y.id);
    for (const P of [W, Z, Y]) await setMandate(P, {auto_clear: false});
  }
  assert.equal(pilot.mode, 'on');
});

test('a read-back that finds the set-off\'s edges at its timestamps in another state (a different set-off at those very timestamps, sent around Valun) cannot tell whether it applied: inconsistent (outcome_unknown), one alarm for the operator, nothing journaled or corrected (the reconciliation flags the edges)', async t => {
  if (!live(t)) return;
  const U = await party('fs-u'), V = await party('fs-v');
  await owes(U, V, 3); await owes(V, U, 3);
  const o = await waitFor(() => liveWith(U, V), 'the proposal');
  ok(await consent(U, o.id));
  hooks.setoff = async () => { throw new BasisError('tracker unreachable: ECONNREFUSED'); };
  try { assert.equal(ok(await consent(V, o.id)).state, 'applying'); } finally { delete hooks.setoff; }
  // Around Valun, with both keys: a set-off of 1 (not 3) on both edges, at the timestamps this one chose.
  const raw = async (P, i, r, total, at) => basis.signHex(P.pubkey, await msg(i, r, total, at), P.secret);
  const foreign = async (I, R) => {
    const e = o.edges.find(x => x.edge === K(I, R));
    return {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, decrease: 1, timestamp: e.timestamp,
      issuer_signature: await raw(I, I.pubkey, R.pubkey, e.before.total - 1, e.timestamp), recipient_signature: await raw(R, I.pubkey, R.pubkey, e.before.total - 1, e.timestamp)};
  };
  const x = await basis.setoff({denomination: PILOT_DENOMINATION, timestamp: Math.max(...o.edges.map(e => e.timestamp)), edges: [await foreign(U, V), await foreign(V, U)]});
  assert.deepEqual([x.status, x.success], [200, true], JSON.stringify(x));
  expectedAlarms.add(o.id);
  assert.ok((await pilot.recover()).includes(`${o.id}:inconsistent`));
  assert.deepEqual([o.state, o.result?.code, o.read_back], ['inconsistent', 'outcome_unknown', ['unknown', 'unknown']]);
  assert.equal(logs.filter(l => /ALARM/.test(l) && l.includes(o.id)).length, 1, 'one alarm');
  assert.ok(o.edges.every(e => !e.slots.issuer?.signature && !e.slots.recipient?.signature), 'purged');
  assert.equal(ok(await call('GET', '/edges', null, U.agent)).journal.filter(e => e.ref === o.id).length, 0, 'nothing journaled');
  const rows = await pilot.reconcile();
  for (const [I, R] of [[U, V], [V, U]]) {
    const row = rows.find(y => y.issuer === I.handle && y.recipient === R.handle);
    assert.deepEqual([row.tracker_total, row.expected_total, row.exact], [2, 3, false], `${I.handle}>${R.handle}: flagged, never corrected`);
  }
  assert.equal(ok(await call('GET', `/setoffs/${o.id}`, null, V.agent)).result.code, 'outcome_unknown');
  const run = ok(await call('POST', '/admin/clearing/run', {}, null, ADM));
  assert.equal(liveWith(U, V), undefined, `its edges no longer reconcile: never cleared again (${JSON.stringify(run.excluded)})`);
});

test('against a tracker without per-edge set-off timestamps every edge of a proposal has one timestamp, chosen when it is made (an edge between server-run members too), and the request carries none per edge; an edge that moves makes the whole proposal stale (superseded, edge_changed)', async t => {
  if (!live(t)) return;
  const caps = pilot.trackerCaps, noPerEdge = structuredClone(caps), sent = [];
  noPerEdge.novation.setoff.per_edge_timestamps = false;
  hooks.setoff = async (body, original) => { sent.push(structuredClone(body)); return original(body); };
  pilot.trackerCaps = noPerEdge;
  try {
    assert.equal(pilot.mode, 'on');
    const X = await party('np-x', SERVER), Z = await party('np-z', SERVER), Y = await party('np-y');
    await owes(X, Z, 2); await owes(Z, Y, 2); await owes(Y, X, 2);       // X>Z is between server-run members
    const o = await waitFor(() => liveWith(X, Y, Z), 'the 3-cycle');
    const T = o.edges[0].timestamp;
    assert.deepEqual([o.per_edge_timestamps, o.edges.every(e => e.timestamp === T), T % 1000, o.edges.find(e => e.edge === K(X, Z)).server_only], [false, true, 998, true]);
    assert.equal(ok(await consent(Y, o.id)).state, 'applied');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].timestamp === T && sent[0].edges.every(e => !('timestamp' in e)), JSON.stringify(sent[0].edges.map(e => Object.keys(e))));
    assert.deepEqual([await edge(X, Z), await edge(Z, Y), await edge(Y, X)].map(e => [e.total, e.timestamp]), [[0, T], [0, T], [0, T]]);
    // A moved edge: the proposal is stale as a whole (its other edges' signatures are over the same timestamp).
    const P = await party('np-p'), Q = await party('np-q');
    await owes(P, Q, 2); await owes(Q, P, 2);
    const o2 = await waitFor(() => liveWith(P, Q), 'the 2-cycle');
    assert.equal(o2.per_edge_timestamps, false);
    ok(await consent(P, o2.id));
    await owes(P, Q, 1);
    assert.deepEqual([ok(await consent(Q, o2.id)).state, o2.result?.code], ['superseded', 'edge_changed']);
    assert.deepEqual([(await edge(P, Q)).total, (await edge(Q, P)).total], [3, 2], 'nothing applied');
    assert.equal(sent.length, 1, 'nothing sent');
    await setMandate(P, {auto_clear: false});                            // not proposed again later in this file
  } finally { pilot.trackerCaps = caps; delete hooks.setoff; }
  assert.equal(pilot.perEdgeTimestamps(), true);
});

test('Clearing.start() with this Pilot runs a batch at startup (recorded, reason startup), its timers do not keep the process alive, and stop() clears them', async t => {
  if (!live(t)) return;
  const lastRun = pilot.s.clearing.runs.at(-1)?.id, c2 = new Clearing({pilot, log: m => logs.push(m)});
  pilot.clearing = c2;
  try {
    c2.start();
    assert.ok(c2.started && c2.interval && c2.interval.hasRef() === false, 'started, its interval unref\'d');
    await waitFor(() => pilot.s.clearing.runs.at(-1)?.id !== lastRun && pilot.s.clearing.runs.at(-1)?.reason === 'startup', 'the startup run', 30000);
    await waitFor(() => !c2.ticking && !c2.running, 'the startup tick to finish', 30000);
    assert.equal(c2.engineInfo().last_run.reason, 'startup');
  } finally { c2.stop(); pilot.clearing = clearing; }
  assert.deepEqual([c2.started, c2.timers.size, c2.interval], [false, 0, null]);
});

test('GET /clearing: the documented aggregates, without participant ids, handles or keys, cached for 10 s; with circulation off it, GET /setoffs, the set-off consents and the admin clearing routes answer as any unknown route does', async t => {
  if (!live(t)) return;
  const A = await party('pub-a');
  const c = ok(await call('GET', '/clearing'));
  assert.deepEqual(Object.keys(c), ['as_of', 'unit', 'tier', 'engine', 'graph_now', 'totals', 'last_7_days', 'proposals', 'cycles_by_length', 'sandbox']);
  assert.deepEqual([c.unit, c.tier], ['PC', 'pure_credit']);
  assert.deepEqual(Object.keys(c.engine), ['enabled', 'interval_ms', 'limits', 'last_run']);
  assert.deepEqual(Object.keys(c.engine.last_run), ['at', 'reason', 'eligible_edges', 'excluded']);
  assert.deepEqual(Object.keys(c.graph_now), ['participants_with_positions', 'edges', 'gross_PC', 'net_floor_PC', 'clearable_mtcs_PC', 'clearable_within_limits_PC', 'bound_gap']);
  assert.deepEqual(Object.keys(c.totals), ['setoffs_applied', 'cleared_PC', 'edges_closed', 'transfers_applied', 'transferred_PC']);
  assert.deepEqual(Object.keys(c.last_7_days), ['issued_PC', 'cleared_PC', 'liquidity_saving_pct', 'capacity_restored_PC']);
  assert.deepEqual(Object.keys(c.proposals), ['collecting', 'applied', 'stale', 'expired', 'refused', 'failed', 'completion_rate_pct', 'median_ms_to_apply']);
  assert.deepEqual(Object.keys(c.sandbox), ['dormant_PC']);
  assert.ok(c.totals.setoffs_applied >= 6 && c.totals.cleared_PC >= 30 && c.proposals.expired >= 4 && c.proposals.refused >= 2 && c.proposals.stale >= 1, JSON.stringify(c));
  assert.ok(c.graph_now.gross_PC > 0 && c.graph_now.edges > 0 && c.last_7_days.issued_PC > 0 && c.cycles_by_length['2'] >= 1);
  const text = JSON.stringify(c);
  for (const p of Object.values(pilot.s.participants)) assert.ok(!text.includes(p.id) && !text.includes(`"${p.handle}"`) && !(p.pubkey && text.includes(p.pubkey)), `nothing of ${p.handle}`);
  assert.ok(!/vp_|vs_|vt_|vd_|0[23][0-9a-f]{64}/.test(text), 'no ids or keys of any kind');
  assert.equal(ok(await call('GET', '/clearing')).as_of, c.as_of, 'cached for 10 s');
  // Mode off: the same answers as any unknown route (unauthenticated, and with a token).
  pilot.circulation = 'off';
  try {
    assert.equal(pilot.mode, 'off');
    const anon = await call('GET', '/no-such-route'), withToken = await call('GET', '/no-such-route', null, A.agent);
    const same = (r, u, what) => assert.deepEqual([r.status, r.body], [u.status, u.body], what);
    same(await call('GET', '/clearing'), anon, 'GET /clearing');
    same(await call('GET', '/clearing', null, A.agent), withToken, 'GET /clearing with a token');
    same(await call('GET', '/setoffs/vs_0123456789abcdef', null, A.agent), withToken, 'GET /setoffs');
    for (const p of ['/consents/vs_0123456789abcdef', '/consents/vs_0123456789abcdef/refuse']) same(await call('POST', p, {}, A.agent), await call('POST', '/no-such-route', {}, A.agent), `POST ${p}`);
    const adminUnknown = await call('GET', '/admin/no-such-route', null, null, ADM);
    same(await call('GET', '/admin/clearing', null, null, ADM), adminUnknown, 'GET /admin/clearing');
    same(await call('POST', '/admin/clearing/run', {}, null, ADM), await call('POST', '/admin/no-such-route', {}, null, ADM), 'POST /admin/clearing/run');
    assert.deepEqual(await clearing.afterChange([K(A, A)]), [], 'the engine does nothing');
  } finally { pilot.circulation = 'on'; }
  assert.equal(pilot.mode, 'on');
});

// ---------- fix round after phase 1 (decisions D-1 and D-2) ----------
test('decision D-2 b: transfer and bound-note templates take a timestamp later than every live set-off\'s on their edges, so a set-off applied between a template and its post leaves the edge at a timestamp before the payment\'s', async t => {
  if (!live(t)) return;
  const A = await party('tts-a', {roles: 'setoff,issuer'}), B = await party('tts-b'), C = await party('tts-c', {roles: 'creditor'});
  await owes(A, B, 3); await owes(B, A, 2);
  const o = await waitFor(() => liveWith(A, B), 'the proposal');
  const tsAB = o.edges.find(e => e.edge === K(A, B)).timestamp, tsBA = o.edges.find(e => e.edge === K(B, A)).timestamp;
  const payDeal = await delivered(B, C, 1), noteDeal = await delivered(B, A, 1);     // B pays C with A's note (A>B); B pays A with its own note (B>A)
  // This server's clock is set so that the largest timestamps 1.5 s back come before the set-off's on each edge: a
  // template that ignored the set-off would take one of them.
  const behind = ts => ts - 600 - (Date.now() - 1500);
  try {
    clockOffset = behind(tsAB);
    const tpl = await template(B, payDeal, A);
    assert.ok(tpl.timestamp > tsAB && tpl.timestamp % 1000 === 999, `transfer T ${tpl.timestamp} after the set-off's ${tsAB}`);
    clockOffset = behind(tsBA);
    const nt = ok(await call('GET', `/deals/${noteDeal}/credit-note-template?prior=1&bound=1`, null, B.agent));
    assert.ok(nt.timestamp > tsBA && nt.timestamp % 1000 === 997, `bound note ${nt.timestamp} after the set-off's ${tsBA}`);
  } finally { clockOffset = 0; }
  assert.equal(o.state, 'collecting', 'a template is not an attempt: the set-off goes on');
  pilot.endSetoff(o, 'superseded', 'ended_by_test');
  await setMandate(B, {auto_clear: false});
});

test('a complete set-off whose apply never started (the process stopped between saving the last signature and the apply) is applied by recover()', async t => {
  if (!live(t)) return;
  const U = await party('rc-u'), V = await party('rc-v');
  await owes(U, V, 2); await owes(V, U, 2);
  const o = await waitFor(() => liveWith(U, V), 'the proposal');
  ok(await consent(U, o.id));
  pilot.applySetoff = async () => { throw new Error('simulated crash before the apply'); };
  let r;
  try { r = await consent(V, o.id); } finally { delete pilot.applySetoff; }
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.deepEqual([o.state, pilot.setoffComplete(o)], ['collecting', true], 'every signature, nothing applied');
  assert.ok((await pilot.recover()).includes(`${o.id}:applied`));
  assert.deepEqual([(await edge(U, V)).total, (await edge(V, U)).total], [0, 0]);
});

test('rule R1 for the server signer: a server-run member\'s set-off slots are signed over messages rebuilt from each edge (its keys, new total and timestamp), never over stored message hex', async t => {
  if (!live(t)) return;
  const A = await party('r1s-a'), Q = await party('r1s-q', SERVER), B = await party('r1s-b');
  await owes(A, Q, 2); await owes(Q, B, 2); await owes(B, A, 2);       // closes A>Q>B>A; Q's slots are signed by the server at apply time
  const o = await waitFor(() => liveWith(A, Q, B), 'the 3-cycle');
  ok(await consent(A, o.id));
  const e = o.edges.find(x => x.edge === K(A, Q)), right = await msg(A.pubkey, Q.pubkey, e.new_total, e.timestamp), wrong = await msg(A.pubkey, Q.pubkey, e.new_total + 1, e.timestamp);
  assert.equal(o.messages[e.edge], right);
  o.messages[e.edge] = wrong;                                            // as if the stored record were damaged
  const signer = pilot.serverSigner, signed = [];
  pilot.serverSigner = {has: signer.has, signFor: async (pid, hexMsg, opts) => { signed.push(hexMsg); return signer.signFor(pid, hexMsg, opts); }};
  let r;
  try { r = ok(await consent(B, o.id)); } finally { pilot.serverSigner = signer; }
  assert.ok(!signed.includes(wrong) && signed.includes(right), 'signed over the rebuilt message');
  assert.equal(r.state, 'applied');
  assert.deepEqual([(await edge(A, Q)).total, (await edge(Q, B)).total, (await edge(B, A)).total], [0, 0, 0]);
});

test('no response body ever carried a set-off signature collected from another member before the tracker recorded its set-off', async t => {
  if (!live(t)) return;
  // Which set-off (or transfer) each collected signature belongs to: by its value, or by the sha256 kept once purged.
  const owner = new Map();
  for (const o of Object.values(pilot.s.setoffs)) for (const e of o.edges) for (const r of ['issuer', 'recipient']) {
    const v = e.slots[r]?.signature;
    if (v) owner.set(v, o.id);
    const h = o.signature_sha256?.[e.edge]?.[r];
    if (h) owner.set(h, o.id);
  }
  for (const tr of Object.values(pilot.s.transfers)) for (const [name, s] of Object.entries(tr.slots)) {
    if (s?.signature) owner.set(s.signature, tr.id);
    const h = tr.signature_sha256?.[name];
    if (h) owner.set(h, tr.id);
  }
  let checked = 0, matched = 0;
  const violations = [];
  for (const [sig, by] of produced) {
    const id = owner.get(sig) ?? owner.get(SIGSHA(sig)) ?? null;
    const applied = id ? appliedAt.get(id) : undefined;
    for (const e of LOG) {
      if (!e.text.includes(sig)) continue;
      matched++;
      if (e.viewer === by) continue;                                     // its own signature
      if (applied !== undefined && e.i >= applied) continue;             // a receipt, after the tracker recorded it
      violations.push({sig: sig.slice(0, 16), by, viewer: e.viewer, i: e.i, path: e.path, status: e.status, id});
    }
    checked++;
  }
  assert.ok(checked > 60 && LOG.length > 400, JSON.stringify({checked, responses: LOG.length}));
  assert.ok(matched > 0, 'receipts and own views do contain signatures, so the scan can see them');
  assert.deepEqual(violations, []);
  // The engine logged no failure and no alarm in this whole file, but the alarms a test provoked on purpose (each of
  // which that test checked was logged once).
  assert.ok(expectedAlarms.size >= 1, 'the inconsistent read-back test ran');
  assert.deepEqual(logs.filter(l => /clearing:|ALARM/.test(l) && ![...expectedAlarms].some(id => l.includes(id))), []);
});
