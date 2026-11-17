// Sandbox tours at once: three strangers take the five-step tour (design §9.2) interleaved, over real HTTP, against a
// throwaway REAL tracker v3.2 or later (port 3162), a Pilot in circulation mode on with self-serve sandbox joining, the
// server's sandbox agents (lib/pilot/sandbox.mjs, tick every 150 ms) and the clearing engine, as
// test/sandbox-circulation.test.mjs runs one tour. A, B and C are this test, each acting as a 0.4 client with its own
// key; D is a fourth stranger, who sells to sandbox-mallory outside any tour. X = sandbox-exact, M = sandbox-mallory.
// Every tour's step 2 moves 2 PC of X's debt to M (X>M), and its step 4 clears the 3-cycle M>S>X>M through that debt;
// every tour's step 5 leaves M>X 1 PC higher. Before the fix (the tour's step 4 stall, onboarding review of
// 2026-11-16), the server set off X>M against M>X by itself as soon as both were outstanding, and M paid other sellers
// with X's notes it held, so a later tour's step 4 waited for a 3-cycle that could never be proposed: C's tour below,
// after A's and B's, is also what the third tour in a row met on a quiet server. Now the agents keep that debt for each
// open tour (Sandbox.tourHolds) until its 3-cycle clears. The order and the totals expected:
//   welcome jobs to A, B and C                                                     X>A 3, X>B 3, X>C 3
//   A2, B2: each pays M with X's note                                              X>M 4, all of it kept
//   D sells text-stats to M (3): M pays with its own note, not with X's (all kept)  M>D 3
//   A3, A4: A's 2-cycle, then its 3-cycle M>A>X>M                                  X>M 3, M>A 2 (B keeps 2)
//   A5: A pays X with M's note; the server-only X<>M set-off clears 1 PC only      X>M 2, M>X 1
//   B3, B4, B5: B's 3-cycle through what it kept; the server-only set-off, 1 PC    X>M 0, M>X 2
//   C2 with M>X 2 outstanding: no server-only set-off (C keeps all of X>M)         X>M 2, M>X 2
//   C3, C4: C's 3-cycle clears (before the fix, step 4 waited here); C5            X>M 0, M>X 3
// Skipped unless the tracker's capabilities validate and its binary's sha256 is pinned (lib/pilot/pins.mjs).
// Run: BASIS_RUNNER=direct VALUN_BINS=$HOME/valun-bins/v441 node --test test/sandbox-tours.test.mjs (in Ubuntu)
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK,
  PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest} from '../lib/pilot/novation.mjs';
import {Clearing} from '../lib/pilot/clearing.mjs';
import {Sandbox, COMPUTE, extractText, whichService, render, malloryIsWrong} from '../lib/pilot/sandbox.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const TRACKER_PORT = 3162, H = 3600e3, FEATURES = 'consents/1;roles=setoff,issuer,creditor';
let tracker, server, base, basis, pilot, sandbox, clearing, dataDir, enabled = false, broken = null;
let skipWhy = 'the tracker did not start';
const logs = [], sandboxLog = [];
// The strangers (this test, with their keys) and the two agents: {id, handle, name, pubkey, ...}.
let A = null, B = null, C = null, D = null, X = null, M = null;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  const caps = await capabilities(tracker.url), v = validateCaps(caps);
  const bin = caps ? await trackerSha256() : null;
  enabled = v.ok && TRACKER_SHA256_PINS.includes(bin) && caps.novation?.setoff?.per_edge_timestamps === true;
  skipWhy = !caps ? 'this tracker reports no capabilities (a tracker before v3)'
    : !v.ok ? `capabilities do not validate: ${v.reason}`
      : !TRACKER_SHA256_PINS.includes(bin) ? `basis_server ${bin} is not pinned`
        : !enabled ? 'this tracker has no per-edge set-off timestamps' : '';
  if (!enabled) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-tours-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION,
    runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(dataDir), basis, openSandbox: true, circulation: 'on', trackerCaps: caps,
    trackerSha256: bin, log: m => logs.push(m)});
  assert.equal(pilot.mode, 'on', JSON.stringify(logs));
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // As server.mjs starts them: the sandbox agents, then the clearing engine.
  sandbox = await new Sandbox(pilot, {dataDir, intervalMs: 150, log: m => sandboxLog.push(m)}).start();
  clearing = new Clearing({pilot, log: m => logs.push(m)}).start();
  pilot.clearing = clearing;
  const agent = (h, name) => ({id: sandbox.keys[h].id, handle: h, name, pubkey: sandbox.keys[h].pubkey});
  X = agent('sandbox-exact', 'X'); M = agent('sandbox-mallory', 'M');
});
after(async () => {
  clearing?.stop(); sandbox?.stop();
  if (server) { server.closeAllConnections?.(); server.close(); }
  for (let i = 0; i < 100 && sandbox?.busy; i++) await sleep(50);   // a tick in flight ends first
  await tracker?.stop();
  // After a failure (or with VALUN_TEST_LOG=1): what the sandbox agents and the pilot logged.
  if (broken || process.env.VALUN_TEST_LOG) {
    console.log(`sandbox log (last 80):\n${sandboxLog.slice(-80).join('\n')}`);
    console.log(`pilot log:\n${logs.slice(-30).join('\n')}`);
  }
  if (dataDir) fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});
// Each step builds on the one before: once a step fails, the later ones are skipped.
const step = (name, fn) => test(name, async t => {
  if (!enabled) return t.skip(skipWhy);
  if (broken) return t.skip(`an earlier step failed (${broken})`);
  try { await fn(t); } catch (e) { broken = name.slice(0, 40); throw e; }
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP, as stranger P's client: every agent request carries its consent roles (X-Valun-Features). P null: anonymous.
async function call(method, p, body, P) {
  const headers = {'content-type': 'application/json',
    ...(P ? {authorization: `Bearer ${P.agent}`, 'x-valun-features': FEATURES} : {})};
  const r = await fetch(base + '/pilot/v1' + p, {method, headers,
    body: body == null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 600));
  return r.body;
};
async function waitFor(fn, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
const msg = async (i, r, total, timestamp) =>
  (await basis.noteMessage({issuer: i, recipient: r, total, timestamp})).message_hex;
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) of edge I>R's state (X, p) at T.
const paMsg = async (i, r, priorTotal, priorTimestamp, timestamp) =>
  (await basis.priorAckMessage({issuer: i, recipient: r, priorTotal, priorTimestamp, timestamp})).message_hex;
const verifyState = async (I, R, st) => {
  const signed = await basis.verify(I, await msg(I, R, st.total, st.timestamp), st.signature);
  assert.ok(signed, 'the edge state carries its issuer\'s signature');
};
const view = async (P, id) => ok(await call('GET', `/deals/${id}`, null, P));
const until = (P, id, statuses, what) => waitFor(async () => {
  const v = await view(P, id);
  return statuses.includes(v.status) && v;
}, what ?? `deal ${id} to be ${statuses.join(' or ')}`);
// The tracker totals between every two of A, B, C, D, X and M that are not 0 ('<name>><name>').
async function totals() {
  const out = {}, all = [A, B, C, D, X, M];
  for (const i of all) for (const r of all) if (i !== r) {
    const n = await basis.note(i.pubkey, r.pubkey), t = n ? Number(n.amount_collected) : 0;
    if (t) out[`${i.name}>${r.name}`] = t;
  }
  return out;
}
const expectTotals = async (want, what) => assert.deepEqual(await totals(), want, what);
const position = async P => {
  const pos = ok(await call('GET', '/me', null, P)).position;
  return [pos.claims_held, pos.owes];
};
const XM = () => `${X.pubkey}>${M.pubkey}`;
const keptNow = () => Object.fromEntries([...sandbox.tourHolds()].map(([k, v]) => [k === XM() ? 'X>M' : k, v]));

// ---------- a stranger's client: offers, deliveries, payments, consents ----------
const fenced = text => `\n\`\`\`\n${text}\n\`\`\``;
const job = (service, text) => ({title: `${service} job`, description: `${service} for this text:${fenced(text)}`,
  deliverable: `The exact ${service} result as JSON.`});
// P proposes; `dealId` lets the test choose a deal id (sandbox-mallory is wrong exactly when malloryIsWrong(deal id)).
async function propose(P, {payer, payee, price, service, text, dealId = 'vd_' + rnd(8)}) {
  const now = Date.now();
  const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: dealId, version: 1, prior_terms_hash: null, nonce: rnd(16), proposer: P.id,
    payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: job(service, text), price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 24 * H).toISOString(), offer_expires_at: new Date(now + H).toISOString()};
  const h = termsHash(t), signature = await sign(P, statements.propose(h));
  return ok(await call('POST', '/deals', {terms: t, terms_hash: h, signature}, P), 201).id;
}
const rightDealId = () => { for (;;) { const id = 'vd_' + rnd(8); if (!malloryIsWrong(id)) return id; } };
// The exact result P's client computes from the agreed terms, and the delivery it renders (valun_deliver exact_result).
const exactOf = terms => {
  const service = whichService(terms), text = extractText(terms.service.description);
  return {service, text, result: COMPUTE[service](text)};
};
const resultOf = content => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
async function deliverExact(P, id) {
  const v = await view(P, id), h = v.agreement.terms_hash, {service, text, result} = exactOf(v.current.terms);
  const content = render(service, result, text), sha256 = sha(content);
  return ok(await call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, title: `${service} result`, sha256,
    signature: await sign(P, statements.deliver(h, sha256))}, P));
}
const deliveryRight = v =>
  JSON.stringify(resultOf(v.delivery.content)) === JSON.stringify(exactOf(v.current.terms).result);
// P pays with its own bound note: the template checked (residue 997, after the prior note, which carries P's own
// signature), both messages rebuilt (the note M and its prior acknowledgment PA of the prior note, (0, 0) for none).
async function payOwnNote(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`, null, P));
  const R = tpl.recipient_pubkey;
  assert.deepEqual([tpl.timestamp % 1000, tpl.issuer_pubkey, tpl.total], [997, P.pubkey, tpl.prior_total + tpl.price]);
  if (tpl.prior_note) {
    assert.ok(tpl.timestamp > tpl.prior_note.timestamp);
    await verifyState(P.pubkey, R, tpl.prior_note);
  }
  const note = await basis.signHex(P.pubkey, await msg(P.pubkey, R, tpl.total, tpl.timestamp), P.secret);
  const priorTs = tpl.prior_note ? tpl.prior_note.timestamp : 0;
  const ack = await paMsg(P.pubkey, R, tpl.prior_total, priorTs, tpl.timestamp);
  assert.deepEqual([tpl.prior_timestamp, tpl.prior_message_hex], [priorTs, ack],
    'the template\'s acknowledgment is PA of the state it shows');
  const prior = await basis.signHex(P.pubkey, ack, P.secret), h = tpl.terms_hash, dh = tpl.deliverable_sha256;
  return ok(await call('POST', `/deals/${id}/complete`, {terms_hash: h, deliverable_sha256: dh,
    signature: await sign(P, statements.complete(h, dh)), credit_note: {total: tpl.total, timestamp: tpl.timestamp,
      signature: note, prior_total: tpl.prior_total, prior_timestamp: priorTs, prior_signature: prior}}, P));
}
// P pays with a note it holds, issued by agent I (pay_with): the template checked (residue 999; P as payer; the payee's
// key; the amount; the quote digest computed here; the from-edge state carries the issuer's signature; the new totals)
// and its three slots, the completion and the pay statement signed.
async function payWith(P, id, I) {
  const tpl = ok(await call('GET', `/deals/${id}/transfer-template?issuer=${I.id}`, null, P)), v = await view(P, id);
  const T = tpl.timestamp, a = tpl.amount, Cp = tpl.payee.pubkey, h = v.agreement.terms_hash, dh = v.delivery.sha256;
  const Xf = tpl.from_edge.before.total, Yt = tpl.to_edge.before?.total ?? 0;
  const pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  assert.deepEqual([T % 1000, tpl.issuer.pubkey, tpl.payer.pubkey, Cp, a],
    [999, I.pubkey, P.pubkey, v.current.terms.payee.pubkey, v.current.terms.price.amount]);
  await verifyState(I.pubkey, P.pubkey, tpl.from_edge.before);
  assert.deepEqual([tpl.from_edge.new_total, tpl.to_edge.new_total], [Xf - a, Yt + a]);
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: id,
    terms_hash: h, deliverable_sha256: dh, issuer_pubkey: I.pubkey, payer_pubkey: P.pubkey, payee_pubkey: Cp,
    amount: a});
  assert.equal(tpl.quote_digest, q, 'the server quotes what the client computes');
  const IB = `${I.pubkey}>${P.pubkey}`, IC = `${I.pubkey}>${Cp}`;
  const slot = async (r, total) => basis.signHex(P.pubkey, await msg(I.pubkey, r, total, T), P.secret);
  const prior = await basis.signHex(P.pubkey, await paMsg(I.pubkey, P.pubkey, Xf, pX, T), P.secret);
  const signatures = {[`${IB}:prior`]: prior, [`${IB}:new`]: await slot(P.pubkey, Xf - a),
    [`${IC}:new`]: await slot(Cp, Yt + a)};
  return ok(await call('POST', `/deals/${id}/pay-by-transfer`, {issuer_id: I.id, terms_hash: h, deliverable_sha256: dh,
    quote_digest: q, timestamp: T, from_prior_total: Xf, to_prior_total: Yt, from_prior_timestamp: pX,
    to_prior_timestamp: pY, completion_signature: await sign(P, statements.complete(h, dh)),
    pay_signature: await sign(P, circulationStatements.pay(id, q)), signatures}, P));
}
// P's client signs a set-off consent item after its checks (spec 15.3): only its own edges, every EdgeState its
// issuer's own signature, every change a decrease at residue 998 after the state it changes, and its claims falling by
// exactly as much as its debts.
async function signSetoff(P, item) {
  assert.deepEqual([item.kind, item.your_roles, item.state], ['setoff', ['member'], 'collecting']);
  let asCreditor = 0, asIssuer = 0;
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    assert.ok(I === P.pubkey || R === P.pubkey, 'only its own edges');
    assert.ok(e.change < 0 && e.new_total === e.before.total + e.change, 'a decrease');
    assert.ok(e.timestamp % 1000 === 998 && e.timestamp > e.before.timestamp, 'at 998 ms, after the state it changes');
    await verifyState(I, R, e.before);
    if (R === P.pubkey) asCreditor -= e.change; else asIssuer -= e.change;
    revisions[e.edge] = e.revision;
    if (!e.signed_by_you.includes('new')) {
      signatures[`${e.edge}:new`] = await basis.signHex(P.pubkey, await msg(I, R, e.new_total, e.timestamp), P.secret);
    }
  }
  assert.equal(asCreditor, asIssuer, 'net-neutral for the stranger');
  return ok(await call('POST', `/consents/${item.id}`, {signatures, revisions}, P));
}
// P's next consent calls (GET /consents, which also lets the engine propose cycles through P) until one lists a
// set-off.
const nextSetoff = (P, what) =>
  waitFor(async () => ok(await call('GET', '/consents', null, P)).consents.find(c => c.kind === 'setoff'), what);
const setoffApplied = id => waitFor(() => pilot.s.setoffs[id]?.state === 'applied' && pilot.s.setoffs[id],
  `set-off ${id} to apply`);
// The edges of a set-off as {'<I>><R>': [before, after]}, the participants named.
const named = k => {
  const n = Object.fromEntries([A, B, C, D, X, M].map(P => [P.pubkey, P.name])), [i, r] = k.split('>');
  return `${n[i] ?? '?'}>${n[r] ?? '?'}`;
};
const setoffEdges = o => Object.fromEntries(o.edges.map(e => [named(e.edge), [e.before.total, e.new_total]]));
const serverOnly = o => o.edges.every(e => e.server_only);
const tourText = n => `Valun sandbox tour, step ${n}: ${{2: 'paid with a note I hold.', 3: 'paid with my own note.',
  4: 'I sell my work.', 5: 'paid with a note I hold again.'}[n]}`;
const paidStates = ['note_issued', 'paying_by_transfer', 'paid_by_transfer', 'disputed'];

// The tour's steps, as stranger P's client takes them (sandbox_next_steps, with the deal ids chosen so that
// sandbox-mallory's deliveries are right: disputing a wrong one is test/sandbox-circulation.test.mjs's).
async function welcome(P) {
  const offer = async () => ok(await call('GET', '/inbox', null, P)).respond.find(i => i.counterparty === X.handle);
  const v = await view(P, (await waitFor(offer, `the welcome job of ${P.name}`)).deal_id), h = v.current.terms_hash;
  assert.equal(termsHash(v.current.terms), h);
  assert.ok(await basis.verify(X.pubkey, hex(statements.propose(h)), v.current.signature), 'signed by sandbox-exact');
  const signature = await sign(P, statements.accept(h));
  const accepted = ok(await call('POST', `/deals/${v.id}/accept`, {terms_hash: h, signature}, P));
  assert.equal(accepted.status, 'agreed');
  await deliverExact(P, v.id);
  const paid = await until(P, v.id, ['note_issued', 'disputed', 'note_failed'], `X to pay ${P.name}'s welcome job`);
  assert.equal(paid.status, 'note_issued');
}
// Step 2: buy notary from M (2 PC) and pay with X's note (applied at once: X and M are server-run).
async function step2(P) {
  const id = await propose(P, {payer: P, payee: M, price: 2, service: 'notary', text: tourText(2),
    dealId: rightDealId()});
  assert.equal(deliveryRight(await until(P, id, ['delivered'])), true);
  const r = await payWith(P, id, X);
  assert.deepEqual([r.status, r.transfer.state], ['paid_by_transfer', 'applied']);
}
// Step 3: buy notary from X (2 PC) with its own note; its next consent call signs the 2-cycle P>X>P (1 PC).
async function step3(P) {
  const id = await propose(P, {payer: P, payee: X, price: 2, service: 'notary', text: tourText(3)});
  assert.equal(deliveryRight(await until(P, id, ['delivered'])), true);
  assert.equal((await payOwnNote(P, id)).status, 'note_issued');
  const item = await nextSetoff(P, `the set-off of ${P.name}'s 2-cycle`), o = pilot.s.setoffs[item.id];
  assert.deepEqual([o.amount, setoffEdges(o)], [2, {[`${P.name}>X`]: [2, 1], [`X>${P.name}`]: [1, 0]}],
    `${P.name}'s 2-cycle, 1 PC on each edge`);
  await signSetoff(P, item);
  await setoffApplied(item.id);
}
// Step 4: sell text-stats to M (3 PC); M pays with its own note; the 3-cycle M>P>X>M (1 PC) clears at P's next consent
// call. `xm`: X>M's total before it.
async function step4(P, xm) {
  const id = await propose(P, {payer: M, payee: P, price: 3, service: 'text-stats', text: tourText(4)});
  await until(P, id, ['agreed'], 'M to buy');
  await deliverExact(P, id);
  const paid = await until(P, id, paidStates, 'M to check the delivery and pay');
  assert.deepEqual([paid.status, paid.credit_note?.issuer_pubkey], ['note_issued', M.pubkey],
    'M paid with its own note');
  const item = await nextSetoff(P, `the set-off of ${P.name}'s 3-cycle M>${P.name}>X>M`), o = pilot.s.setoffs[item.id];
  const want = {[`M>${P.name}`]: [3, 2], [`${P.name}>X`]: [1, 0], 'X>M': [xm, xm - 1]};
  assert.deepEqual([o.amount, setoffEdges(o)], [3, want], `${P.name}'s 3-cycle, 1 PC on each edge`);
  await signSetoff(P, item);
  await setoffApplied(item.id);
}
// Step 5: buy notary from X (2 PC) and pay with M's note. Returns the set-offs made in that request whose members are
// all server-run (the engine looks for cycles through the raised edge M>X before the payment answers).
async function step5(P) {
  const id = await propose(P, {payer: P, payee: X, price: 2, service: 'notary', text: tourText(5)});
  assert.equal(deliveryRight(await until(P, id, ['delivered'])), true);
  const known = new Set(Object.keys(pilot.s.setoffs));
  const r = await payWith(P, id, M);
  assert.deepEqual([r.status, r.transfer.state], ['paid_by_transfer', 'applied']);
  return Object.values(pilot.s.setoffs).filter(o => !known.has(o.id) && serverOnly(o));
}
// The one server-only set-off made by a step 5, once applied, with its edges.
async function serverOnlyApplied(made) {
  assert.equal(made.length, 1, 'one server-only set-off');
  const o = await setoffApplied(made[0].id);
  return [o.amount, setoffEdges(o)];
}

// ---------------------------------------------------------------------------------------------------------------
step('setup: A, B, C and D join the sandbox with 0.4 clients', async () => {
  const join = async (handle, name) => {
    const operator = `a tester taking the tour (${name})`;
    const j = ok(await call('POST', '/join-sandbox', {handle, operator}, null), 201);
    const key = await basis.keygen(), pid = j.participant_id, pubkey = key.pubkey_hex;
    const enrolment = statements.enroll(pid, pubkey, sha(j.enrollment_code));
    const pop = await basis.signHex(pubkey, hex(enrolment), key.secret_hex);
    const enroll = {participant_id: pid, code: j.enrollment_code, pubkey, signature: pop};
    const e = ok(await call('POST', '/enroll', enroll, null), 201);
    const P = {id: pid, handle, name, pubkey, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
    assert.deepEqual(ok(await call('GET', '/me', null, P)).features.consent_roles, ['setoff', 'issuer', 'creditor']);
    return P;
  };
  A = await join('tour-a', 'A'); B = await join('tour-b', 'B'); C = await join('tour-c', 'C');
  D = await join('seller-d', 'D');
  await expectTotals({}, 'nothing owed yet');
});

step('step 1 for A, B and C: X buys each one\'s welcome job (3 PC) and pays with its own note', async () => {
  for (const P of [A, B, C]) await welcome(P);
  await expectTotals({'X>A': 3, 'X>B': 3, 'X>C': 3});
});

step('step 2 for A and B: each pays M with X\'s note -> X>M 4, all of it kept for their two tours', async () => {
  await step2(A);
  await step2(B);
  await expectTotals({'X>A': 1, 'X>B': 1, 'X>C': 3, 'X>M': 4});
  assert.deepEqual(await position(A), [1, 0]);
});

step('D, outside any tour, sells to M (3 PC): M pays with its own note, not with the X notes it holds', async () => {
  const id = await propose(D, {payer: M, payee: D, price: 3, service: 'text-stats', text: 'A job for M.'});
  await until(D, id, ['agreed'], 'M to buy');
  await deliverExact(D, id);
  const paid = await until(D, id, paidStates, 'M to check the delivery and pay');
  assert.deepEqual([paid.status, paid.credit_note?.issuer_pubkey], ['note_issued', M.pubkey],
    'M paid D with its own note');
  await expectTotals({'X>A': 1, 'X>B': 1, 'X>C': 3, 'X>M': 4, 'M>D': 3});
  assert.deepEqual(keptNow(), {'X>M': 4}, 'A and B keep 2 PC each: all of what M holds of X\'s notes');
});

step('steps 3 and 4 for A: its 2-cycle, then its 3-cycle M>A>X>M through what it kept -> X>M 3', async () => {
  await step3(A);
  await step4(A, 4);
  await expectTotals({'M>A': 2, 'X>B': 1, 'X>C': 3, 'X>M': 3, 'M>D': 3});
  assert.deepEqual(keptNow(), {'X>M': 2}, 'A\'s 3-cycle cleared: only B\'s tour keeps any');
});

step('step 5 for A: the server-only set-off of X<>M clears 1 PC, leaving the 2 B keeps -> X>M 2, M>X 1', async () => {
  assert.deepEqual(await serverOnlyApplied(await step5(A)), [2, {'X>M': [3, 2], 'M>X': [2, 1]}]);
  await expectTotals({'X>B': 1, 'X>C': 3, 'X>M': 2, 'M>X': 1, 'M>D': 3});
  assert.deepEqual(await position(A), [0, 0], 'A\'s tour is done: it holds 0 and owes 0');
});

step('steps 3, 4 and 5 for B: its 3-cycle clears; then the server-only set-off, 1 PC -> X>M 0, M>X 2', async () => {
  await step3(B);
  await step4(B, 2);
  assert.deepEqual(keptNow(), {});
  assert.deepEqual(await serverOnlyApplied(await step5(B)), [2, {'X>M': [1, 0], 'M>X': [3, 2]}]);
  await expectTotals({'X>C': 3, 'M>X': 2, 'M>D': 3});
  assert.deepEqual(await position(B), [0, 0]);
});

step('step 2 for C, with M>X 2 outstanding: no server-only set-off takes the debt C\'s step 4 needs', async () => {
  const known = new Set(Object.keys(pilot.s.setoffs));
  await step2(C);
  // The engine looked for cycles through X>M before the payment answered: the 2-cycle X>M>X is all kept for C.
  const made = Object.values(pilot.s.setoffs).filter(o => !known.has(o.id)).map(o => [o.state, setoffEdges(o)]);
  assert.deepEqual(made, [], 'no set-off');
  assert.deepEqual(keptNow(), {'X>M': 2});
  assert.deepEqual(pilot.clearingDiagnostics().kept_for_clients, {[XM()]: 2}, 'GET /admin/clearing shows it');
  await expectTotals({'X>C': 1, 'X>M': 2, 'M>X': 2, 'M>D': 3});
});

step('steps 3 and 4 for C: its 3-cycle M>C>X>M clears (before the fix, step 4 waited here)', async () => {
  await step3(C);
  await step4(C, 2);
  await expectTotals({'M>C': 2, 'X>M': 1, 'M>X': 2, 'M>D': 3});
});

step('step 5 for C: the server-only set-off clears 1 PC; every tour is done and nothing is kept -> M>X 3', async () => {
  assert.deepEqual(await serverOnlyApplied(await step5(C)), [2, {'X>M': [1, 0], 'M>X': [4, 3]}]);
  await expectTotals({'M>X': 3, 'M>D': 3});
  for (const P of [A, B, C]) assert.deepEqual(await position(P), [0, 0], `${P.name} holds 0 and owes 0`);
  assert.deepEqual(keptNow(), {});
  // Every recorded edge between these six reconciles exactly with Valun's journal, and the sandbox raised no alarm.
  const handles = new Set([A, B, C, D, X, M].map(P => P.handle));
  const rows = (await pilot.reconcile()).filter(x => handles.has(x.issuer) && handles.has(x.recipient));
  assert.ok(rows.length >= 10 && rows.every(x => x.status === 'match' && x.exact === true), JSON.stringify(rows));
  assert.deepEqual(sandboxLog.filter(l => /ALARM/.test(l)), [], 'no alarm from the sandbox');
  const c = ok(await call('GET', '/clearing', null, null));
  assert.deepEqual([c.totals.setoffs_applied, c.totals.transfers_applied], [9, 6],
    'three 2-cycles, three 3-cycles and three server-only set-offs; six transfers');
});
