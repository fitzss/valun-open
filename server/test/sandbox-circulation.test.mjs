// Sandbox circulation: the stranger's five-step tour (design §9.2, §5.8; spec 18.15) over real HTTP, against a throwaway
// REAL tracker v3.2 (port 3132), a Pilot in circulation mode on with self-serve sandbox joining, the server's sandbox
// agents (lib/pilot/sandbox.mjs, tick every 150 ms; the server signs for them, pilot.serverSigner) and the clearing
// engine (lib/pilot/clearing.mjs, started as server.mjs starts it). The stranger S is this test, acting as a 0.4 client:
// it joins the sandbox, declares its consent roles (X-Valun-Features), rebuilds every message it signs and checks every
// template and consent item before signing, with its own key. X = sandbox-exact, M = sandbox-mallory. After each step
// the six tracker totals between S, X and M are asserted exactly (an edge that does not exist counts 0):
//   1. the welcome job: X buys text-stats from S (3) and pays with a bound note           X>S 3
//   2. S buys notary from M (2), disputes a wrong delivery, buys again, pays with X's note X>S 1, X>M 2
//   3. S buys notary from X (2) with its own bound note; the 2-cycle S>X>S clears when
//      S's client signs the set-off at its next consent call                              X>S 0, S>X 1, X>M 2
//   4. S sells text-stats to M (3); M holds only 2 of X's notes, so it pays with its own
//      note; the 3-cycle M>S>X>M clears at S's next consent call                          M>S 2, S>X 0, X>M 1
//   5. S buys notary from X (2) paying with M's note; then the server-only 2-cycle X<>M
//      clears                                                                             M>S 0, M>X 1, X>M 0
// After the tour, its three set-offs are public loops (GET /pilot/v1/loops, the loop card /loop/<id>).
// Skipped unless the tracker's capabilities validate and its binary's sha256 is pinned (lib/pilot/pins.mjs): with the
// default (old) binaries every test here is skipped.
// Run: MSYS2_ENV_CONV_EXCL=VALUN_ VALUN_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release node --test test/sandbox-circulation.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest} from '../lib/pilot/novation.mjs';
import {Clearing} from '../lib/pilot/clearing.mjs';
import {Sandbox, COMPUTE, extractText, whichService, render, malloryIsWrong, WELCOME} from '../lib/pilot/sandbox.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const TRACKER_PORT = 3132, H = 3600e3, FEATURES = 'consents/1;roles=setoff,issuer,creditor';
let tracker, server, base, basis, pilot, sandbox, clearing, dataDir, enabled = false, skipWhy = 'the tracker did not start', broken = null;
const logs = [], sandboxLog = [];
let S = null, X = null, M = null;          // the stranger (this test, with its key) and the two sandbox agents {id, handle, pubkey}
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  const caps = await capabilities(tracker.url), v = validateCaps(caps);
  const bin = caps ? await trackerSha256() : null;
  enabled = v.ok && TRACKER_SHA256_PINS.includes(bin) && caps.novation?.setoff?.per_edge_timestamps === true;
  skipWhy = !caps ? 'this tracker reports no capabilities (a tracker before v3)' : !v.ok ? `capabilities do not validate: ${v.reason}`
    : !TRACKER_SHA256_PINS.includes(bin) ? `basis_server ${bin} is not pinned` : !enabled ? 'this tracker has no per-edge set-off timestamps' : '';
  if (!enabled) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-tour-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(dataDir), basis, openSandbox: true, circulation: 'on', trackerCaps: caps, trackerSha256: bin, log: m => logs.push(m)});
  assert.equal(pilot.mode, 'on', JSON.stringify(logs));
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // As server.mjs starts them: the sandbox agents, then the clearing engine.
  sandbox = await new Sandbox(pilot, {dataDir, intervalMs: 150, log: m => sandboxLog.push(m)}).start();
  clearing = new Clearing({pilot, log: m => logs.push(m)}).start();
  pilot.clearing = clearing;
  const agent = h => { const k = sandbox.keys[h]; return {id: k.id, handle: h, pubkey: k.pubkey}; };
  X = agent('sandbox-exact'); M = agent('sandbox-mallory');
});
after(async () => {
  clearing?.stop(); sandbox?.stop();
  if (server) { server.closeAllConnections?.(); server.close(); }
  for (let i = 0; i < 100 && sandbox?.busy; i++) await new Promise(r => setTimeout(r, 50));   // a tick in flight ends first
  await tracker?.stop();
  // After a failure (or with VALUN_TEST_LOG=1): what the sandbox agents and the pilot logged.
  if (broken || process.env.VALUN_TEST_LOG) console.log(`sandbox log (last 60):\n${sandboxLog.slice(-60).join('\n')}\npilot log:\n${logs.slice(-20).join('\n')}`);
  if (dataDir) fs.rmSync(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});
// Each step builds on the one before: once a step fails, the later ones are skipped.
const step = (name, fn) => test(name, async t => {
  if (!enabled) return t.skip(skipWhy);
  if (broken) return t.skip(`an earlier step failed (${broken})`);
  try { await fn(t); } catch (e) { broken = name.slice(0, 40); throw e; }
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP, as S's client: every agent request carries its consent roles (X-Valun-Features).
async function call(method, p, body, token = S?.agent) {
  const h = {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...(token && token === S?.agent ? {'x-valun-features': FEATURES} : {})};
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: h, body: body === undefined || body === null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 600)); return r.body; };
async function waitFor(fn, what, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
const sign = stmt => basis.signHex(S.pubkey, hex(stmt), S.secret);
const msg = async (i, r, total, ts) => (await basis.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex;
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) of edge I>R's state (X, p) at T.
const paMsg = async (i, r, total, priorTs, ts) => (await basis.priorAckMessage({issuer: i, recipient: r, priorTotal: total, priorTimestamp: priorTs, timestamp: ts})).message_hex;
const verifyState = async (I, R, st) => assert.ok(await basis.verify(I, await msg(I, R, st.total, st.timestamp), st.signature), 'the edge state carries its issuer\'s signature');
const view = async id => ok(await call('GET', `/deals/${id}`));
const until = (id, statuses, what) => waitFor(async () => { const v = await view(id); return statuses.includes(v.status) && v; }, what ?? `deal ${id} to be ${statuses.join(' or ')}`);
// The six tracker totals between S, X and M ('<issuer>><recipient>'; an edge that does not exist counts 0).
async function totals() {
  const P = {S, X, M}, out = {};
  for (const i of ['S', 'X', 'M']) for (const r of ['S', 'X', 'M']) if (i !== r) {
    const n = await basis.note(P[i].pubkey, P[r].pubkey);
    out[`${i}>${r}`] = n ? Number(n.amount_collected) : 0;
  }
  return out;
}
const expectTotals = async (want, what) => assert.deepEqual(await totals(), {'S>X': 0, 'S>M': 0, 'X>S': 0, 'X>M': 0, 'M>S': 0, 'M>X': 0, ...want}, what);
const holdsOwes = async () => { const pos = ok(await call('GET', '/me')).position; return [pos.claims_held, pos.owes]; };

// ---------- S's client: offers, deliveries, payments, consents ----------
const job = (service, text) => ({title: `${service} job`, description: `${service} for this text:\n\`\`\`\n${text}\n\`\`\``, deliverable: `The exact ${service} result as JSON.`});
// S proposes; `dealId` lets the test choose a deal id (sandbox-mallory is wrong exactly when malloryIsWrong(deal id)).
async function propose({payer, payee, price, service, text, dealId = 'vd_' + rnd(8)}) {
  const now = Date.now();
  const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: dealId, version: 1, prior_terms_hash: null,
    nonce: rnd(16), proposer: S.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: job(service, text),
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 24 * H).toISOString(), offer_expires_at: new Date(now + H).toISOString()};
  const h = termsHash(t);
  return ok(await call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(statements.propose(h))}), 201).id;
}
const dealIdWhere = wrong => { for (;;) { const id = 'vd_' + rnd(8); if (malloryIsWrong(id) === wrong) return id; } };
// The exact result S's client computes from the agreed terms, and the delivery it renders (valun_deliver exact_result).
const exactOf = terms => { const service = whichService(terms), text = extractText(terms.service.description); return {service, text, result: COMPUTE[service](text)}; };
const resultOf = content => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
async function deliverExact(id) {
  const v = await view(id), {service, text, result} = exactOf(v.current.terms), content = render(service, result, text), h = sha(content);
  return ok(await call('POST', `/deals/${id}/deliver`, {terms_hash: v.agreement.terms_hash, content, title: `${service} result`, sha256: h,
    signature: await sign(statements.deliver(v.agreement.terms_hash, h))}));
}
// The delivery S bought, checked exactly as its client does.
const deliveryRight = v => JSON.stringify(resultOf(v.delivery.content)) === JSON.stringify(exactOf(v.current.terms).result);
async function dispute(v, reason) {
  return ok(await call('POST', `/deals/${v.id}/dispute`, {terms_hash: v.agreement.terms_hash, deliverable_sha256: v.delivery.sha256, reason,
    signature: await sign(statements.dispute(v.agreement.terms_hash, v.delivery.sha256, reason))}));
}
// S pays with its own bound note: the client checks the template (residue 997, after the prior note, which carries S's
// own signature), rebuilds both messages (the note M and its prior acknowledgment PA of the prior note, (0, 0) for none)
// and signs them, asserting the prior state's timestamp.
async function payOwnNote(id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1&bound=1`));
  assert.deepEqual([tpl.timestamp % 1000, tpl.issuer_pubkey, tpl.total], [997, S.pubkey, tpl.prior_total + tpl.price]);
  if (tpl.prior_note) { assert.ok(tpl.timestamp > tpl.prior_note.timestamp); await verifyState(S.pubkey, tpl.recipient_pubkey, tpl.prior_note); }
  const note = await basis.signHex(S.pubkey, await msg(S.pubkey, tpl.recipient_pubkey, tpl.total, tpl.timestamp), S.secret);
  const priorTs = tpl.prior_note ? tpl.prior_note.timestamp : 0, ack = await paMsg(S.pubkey, tpl.recipient_pubkey, tpl.prior_total, priorTs, tpl.timestamp);
  assert.deepEqual([tpl.prior_timestamp, tpl.prior_message_hex], [priorTs, ack], 'the template\'s acknowledgment is PA of the state it shows');
  const prior = await basis.signHex(S.pubkey, ack, S.secret);
  return ok(await call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: note, prior_total: tpl.prior_total, prior_timestamp: priorTs, prior_signature: prior}}));
}
// S pays with a note it holds (pay_with): the client checks the template (residue 999; S as payer; the payee's key;
// the amount; the quote digest it computes itself; the from-edge state carries the issuer's signature; the new totals)
// and signs its three slots, the completion and the pay statement.
async function payWith(id, A) {
  const tpl = ok(await call('GET', `/deals/${id}/transfer-template?issuer=${A.id}`)), v = await view(id);
  const T = tpl.timestamp, a = tpl.amount, Xf = tpl.from_edge.before.total, Yt = tpl.to_edge.before?.total ?? 0, C = tpl.payee.pubkey;
  assert.deepEqual([T % 1000, tpl.issuer.pubkey, tpl.payer.pubkey, C, a], [999, A.pubkey, S.pubkey, v.current.terms.payee.pubkey, v.current.terms.price.amount]);
  await verifyState(A.pubkey, S.pubkey, tpl.from_edge.before);
  assert.deepEqual([tpl.from_edge.new_total, tpl.to_edge.new_total], [Xf - a, Yt + a]);
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: id, terms_hash: v.agreement.terms_hash,
    deliverable_sha256: v.delivery.sha256, issuer_pubkey: A.pubkey, payer_pubkey: S.pubkey, payee_pubkey: C, amount: a});
  assert.equal(tpl.quote_digest, q, 'the server quotes what the client computes');
  const AB = `${A.pubkey}>${S.pubkey}`, AC = `${A.pubkey}>${C}`, slot = async (r, total) => basis.signHex(S.pubkey, await msg(A.pubkey, r, total, T), S.secret);
  const pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  return ok(await call('POST', `/deals/${id}/pay-by-transfer`, {issuer_id: A.id, terms_hash: v.agreement.terms_hash, deliverable_sha256: v.delivery.sha256, quote_digest: q,
    timestamp: T, from_prior_total: Xf, to_prior_total: Yt, from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await sign(statements.complete(v.agreement.terms_hash, v.delivery.sha256)), pay_signature: await sign(circulationStatements.pay(id, q)),
    signatures: {[`${AB}:prior`]: await basis.signHex(S.pubkey, await paMsg(A.pubkey, S.pubkey, Xf, pX, T), S.secret), [`${AB}:new`]: await slot(S.pubkey, Xf - a),
      [`${AC}:new`]: await slot(C, Yt + a)}}));
}
// S's client signs a set-off consent item after its checks (spec 15.3): only its own edges, every EdgeState its issuer's
// own signature, every change a decrease at residue 998 after the state it changes, and its claims falling by exactly as
// much as its debts. Returns the answer (the item as it stands, with the result).
async function signSetoff(item) {
  assert.deepEqual([item.kind, item.your_roles, item.state], ['setoff', ['member'], 'collecting']);
  let asCreditor = 0, asIssuer = 0;
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    assert.ok(I === S.pubkey || R === S.pubkey, 'only its own edges');
    assert.ok(e.change < 0 && e.new_total === e.before.total + e.change && e.timestamp % 1000 === 998 && e.timestamp > e.before.timestamp);
    await verifyState(I, R, e.before);
    if (R === S.pubkey) asCreditor -= e.change; else asIssuer -= e.change;
    revisions[e.edge] = e.revision;
    if (!e.signed_by_you.includes('new')) signatures[`${e.edge}:new`] = await basis.signHex(S.pubkey, await msg(I, R, e.new_total, e.timestamp), S.secret);
  }
  assert.equal(asCreditor, asIssuer, 'net-neutral for S');
  assert.deepEqual(item.summary, {your_net_change_PC: 0, your_total_owed_change_PC: -asIssuer});
  return ok(await call('POST', `/consents/${item.id}`, {signatures, revisions}));
}
// S's next consent call (GET /consents, which also lets the engine propose cycles through S) until it lists a set-off.
const nextSetoff = what => waitFor(async () => ok(await call('GET', '/consents')).consents.find(c => c.kind === 'setoff'), what);
const setoffApplied = id => waitFor(() => pilot.s.setoffs[id]?.state === 'applied' && pilot.s.setoffs[id], `set-off ${id} to apply`);
// The edges of a set-off as {'<I>><R>': [before, after]} with S, X and M named.
const named = k => { const n = {[S.pubkey]: 'S', [X.pubkey]: 'X', [M.pubkey]: 'M'}, [i, r] = k.split('>'); return `${n[i] ?? '?'}>${n[r] ?? '?'}`; };
const setoffEdges = o => Object.fromEntries(o.edges.map(e => [named(e.edge), [e.before.total, e.new_total]]));

// ---------------------------------------------------------------------------------------------------------------
step('setup: S joins the sandbox with a 0.4 client; the sandbox agents are labelled operator_run', async () => {
  const j = ok(await call('POST', '/join-sandbox', {handle: 'tour-stranger', operator: 'a tester taking the tour'}, null), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}, null), 201);
  S = {id: j.participant_id, handle: 'tour-stranger', pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  const me = ok(await call('GET', '/me'));
  assert.deepEqual(me.features.consent_roles, ['setoff', 'issuer', 'creditor'], 'S\'s client signs every consent role');
  assert.deepEqual([me.mandate.auto_clear, me.mandate.accept_transfers, [...me.mandate.accept_notes_from].sort(), me.mandate.pay_with_held_notes],
    [true, true, [X.id, M.id].sort(), 'when_asked'], 'a sandbox joiner clears, takes transfers of the sandbox agents\' notes, and pays with notes when asked');
  const dir = ok(await call('GET', '/participants', null, null));
  for (const A of [X, M]) assert.equal(dir.find(p => p.id === A.id).operator_run, true, `${A.handle} is operator_run`);
  assert.equal(dir.find(p => p.id === S.id).operator_run, undefined);
  await expectTotals({}, 'nothing owed yet');
});

step('step 1: the welcome job: X buys text-stats from S (3 PC), S delivers the exact result, X pays with a bound note -> X>S 3', async () => {
  const w = await waitFor(async () => ok(await call('GET', '/inbox')).respond.find(i => i.counterparty === X.handle), 'the welcome job');
  const v = await view(w.deal_id), t = v.current.terms, text = `Welcome to the Valun sandbox, ${S.handle}. This text is your first paid job.`;
  assert.deepEqual([t.payer.id, t.payee.id, t.price.amount, t.service.title, t.service.deliverable], [X.id, S.id, 3, 'Welcome job: text-stats', WELCOME.deliverable]);
  assert.ok(t.service.description.includes(`\n\`\`\`\n${text}\n\`\`\``), 'the welcome text, in a fenced block');
  assert.equal(extractText(t.service.description), text);
  const made = Date.parse(v.versions[0].created_at);
  assert.ok(Math.abs(Date.parse(t.offer_expires_at) - made - 24 * H) < 60e3 && Math.abs(Date.parse(t.deliver_by) - made - 48 * H) < 60e3, 'open 24 h, delivery within 48 h');
  // S's client checks the offer (its hash, X's signature) and accepts.
  assert.equal(termsHash(t), v.current.terms_hash);
  assert.ok(await basis.verify(X.pubkey, hex(statements.propose(v.current.terms_hash)), v.current.signature), 'signed by sandbox-exact');
  assert.equal(ok(await call('POST', `/deals/${v.id}/accept`, {terms_hash: v.current.terms_hash, signature: await sign(statements.accept(v.current.terms_hash))})).status, 'agreed');
  await deliverExact(v.id);
  const paid = await until(v.id, ['note_issued', 'disputed', 'note_failed'], 'X to check the delivery and pay');
  assert.equal(paid.status, 'note_issued');
  const n = paid.credit_note;
  assert.deepEqual([n.issuer_pubkey, n.recipient_pubkey, n.note.total, n.note.timestamp % 1000, typeof n.note.prior_signature, n.prior_total], [X.pubkey, S.pubkey, 3, 997, 'string', 0],
    'a bound note (residue 997, with the prior acknowledgment)');
  assert.equal(Object.values(pilot.s.deals).filter(d => d.payer === X.id && d.payee === S.id).length, 1, 'one welcome job');
  assert.equal(pilot.s.participants[S.id].sandbox_welcome.deal_id, v.id);
  await expectTotals({'X>S': 3}, 'after step 1');
  assert.deepEqual(await holdsOwes(), [3, 0]);
  const claim = ok(await call('GET', '/me')).position.claims.find(c => c.issuer_id === X.id);
  assert.deepEqual([claim.amount, claim.operator_run, claim.label], [3, true, 'issued with keys the operator holds']);
});

step('step 2: S buys notary from M (2 PC), disputes the wrong delivery, buys again, and pays with pay_with X -> X>S 1, X>M 2', async () => {
  const wrongId = await propose({payer: S, payee: M, price: 2, service: 'notary', text: 'Valun sandbox tour, step 2: paid with a note I hold.', dealId: dealIdWhere(true)});
  const w = await until(wrongId, ['delivered']);
  assert.equal(deliveryRight(w), false, 'sandbox-mallory is wrong on purpose on this deal');
  assert.equal((await dispute(w, 'The delivered notary result does not match the exact result of the agreed text (differs in: bytes).')).status, 'disputed');
  const id = await propose({payer: S, payee: M, price: 2, service: 'notary', text: 'Valun sandbox tour, step 2: paid with a note I hold.', dealId: dealIdWhere(false)});
  const v = await until(id, ['delivered']);
  assert.equal(deliveryRight(v), true);
  const opts = ok(await call('GET', `/deals/${id}/payment-options`)), held = opts.held_notes.find(h => h.issuer.id === X.id);
  assert.deepEqual([held.issuer.operator_run, held.spendable, held.enough, held.payee_accepts, held.issuer_consents, held.payee_consents, held.why_not],
    [true, 3, true, true, 'immediate', 'immediate', null], 'X and M sign at once');
  const r = await payWith(id, X);
  assert.deepEqual([r.status, r.transfer.state], ['paid_by_transfer', 'applied'], 'applied in the same request: X and M are server-run');
  await expectTotals({'X>S': 1, 'X>M': 2}, 'after step 2');
  assert.deepEqual(await holdsOwes(), [1, 0]);
});

step('step 3: S buys notary from X (2 PC) with its own bound note; S\'s next consent call signs the 2-cycle S>X>S -> X>S 0, S>X 1, X>M 2', async () => {
  const id = await propose({payer: S, payee: X, price: 2, service: 'notary', text: 'Valun sandbox tour, step 3: paid with my own note.'});
  const v = await until(id, ['delivered']);
  assert.equal(deliveryRight(v), true, 'sandbox-exact is exact');
  assert.equal((await payOwnNote(id)).status, 'note_issued');
  await expectTotals({'X>S': 1, 'S>X': 2, 'X>M': 2}, 'before the set-off');
  const item = await nextSetoff('the set-off of the 2-cycle');
  const o = pilot.s.setoffs[item.id];
  assert.deepEqual([o.amount, setoffEdges(o)], [2, {'S>X': [2, 1], 'X>S': [1, 0]}], 'the 2-cycle, 1 PC on each edge');
  const nets = (await holdsOwes()).reduce((a, b) => a - b);
  await signSetoff(item);
  await setoffApplied(item.id);
  await expectTotals({'X>S': 0, 'S>X': 1, 'X>M': 2}, 'after step 3');
  assert.deepEqual(await holdsOwes(), [0, 1]);
  assert.equal((await holdsOwes()).reduce((a, b) => a - b), nets, 'the set-off left S\'s net position as it was');
});

step('step 4: S sells text-stats to M (3 PC); M holds only 2 of X\'s notes, so it pays with its own note; the 3-cycle clears at S\'s next consent call -> M>S 2, S>X 0, X>M 1', async () => {
  const id = await propose({payer: M, payee: S, price: 3, service: 'text-stats', text: 'Valun sandbox tour, step 4: I sell my work.'});
  await until(id, ['agreed'], 'M to buy');
  await deliverExact(id);
  const paid = await until(id, ['note_issued', 'paying_by_transfer', 'paid_by_transfer', 'disputed'], 'M to check the delivery and pay');
  assert.equal(paid.status, 'note_issued', 'M paid with its own note');
  assert.deepEqual([paid.credit_note.issuer_pubkey, paid.credit_note.note.total, paid.credit_note.note.timestamp % 1000], [M.pubkey, 3, 997]);
  assert.equal(pilot.s.deals[id].transfer_ids, undefined, 'no payment by transfer was tried: 2 PC of X\'s notes do not cover 3 PC');
  const item = await nextSetoff('the set-off of the 3-cycle');
  const o = pilot.s.setoffs[item.id];
  assert.deepEqual([o.amount, setoffEdges(o)], [3, {'M>S': [3, 2], 'S>X': [1, 0], 'X>M': [2, 1]}], 'the 3-cycle M>S>X>M, 1 PC on each edge');
  assert.deepEqual(item.edges.map(e => named(e.edge)).sort(), ['M>S', 'S>X'], 'S sees only its own edges');
  await signSetoff(item);
  await setoffApplied(item.id);
  await expectTotals({'M>S': 2, 'S>X': 0, 'X>M': 1}, 'after step 4');
  assert.deepEqual(await holdsOwes(), [2, 0]);
});

step('step 5: S buys notary from X (2 PC) paying with pay_with M; then the server-only 2-cycle X<>M clears -> M>S 0, M>X 1, X>M 0', async () => {
  const id = await propose({payer: S, payee: X, price: 2, service: 'notary', text: 'Valun sandbox tour, step 5: paid with a note I hold again.'});
  const v = await until(id, ['delivered']);
  assert.equal(deliveryRight(v), true);
  const r = await payWith(id, M);
  assert.deepEqual([r.status, r.transfer.state], ['paid_by_transfer', 'applied']);
  const o = await waitFor(() => Object.values(pilot.s.setoffs).find(x => x.state === 'applied' && x.edges.every(e => e.server_only)), 'the server-only set-off');
  assert.deepEqual([o.amount, setoffEdges(o)], [2, {'X>M': [1, 0], 'M>X': [2, 1]}], 'X<>M, 1 PC on each edge, signed by the server for both');
  await expectTotals({'M>X': 1}, 'after step 5');
  assert.deepEqual(await holdsOwes(), [0, 0]);
});

step('after the tour: S earned 6 PC and spent 6 PC (4 by transfer), set-offs cleared 7 PC in three cycles, and the server signer never signed two operations at one edge and timestamp', async () => {
  const me = ok(await call('GET', '/me')).position;
  // 4 PC of S's claims moved to its payees by transfer; 2 PC of its debts (and as much of its claims) were set off.
  assert.deepEqual([me.claims_held, me.owes, me.net, me.transferred_in, me.transferred_out, me.cleared_by_setoff], [0, 0, 0, 0, 4, 2], 'S\'s position');
  const deals = Object.values(pilot.s.deals).filter(d => d.payer === S.id || d.payee === S.id);
  assert.deepEqual(deals.map(d => d.status).sort(), ['disputed', 'note_issued', 'note_issued', 'note_issued', 'paid_by_transfer', 'paid_by_transfer'].sort());
  const c = ok(await call('GET', '/clearing', null, null));
  assert.deepEqual([c.totals.setoffs_applied, c.totals.cleared_PC, c.totals.transfers_applied, c.totals.transferred_PC], [3, 7, 2, 4]);
  // One operation per (edge, timestamp) for each agent, and at most two totals there (a prior and a new one).
  const signed = Object.entries(sandbox.records.signed);
  assert.ok(signed.length > 0, 'the server signed for the agents');
  for (const [k, r] of signed) assert.ok(r.totals.length <= 2 && typeof r.op === 'string', k);
  // Every recorded edge reconciles exactly with Valun's journal.
  // (exact is in the server's own rows; the public GET /ledger keeps v15's rows, SV-PRIV-1.)
  const rows = (await pilot.reconcile()).filter(x => [S, X, M].some(P => P.handle === x.issuer) && [S, X, M].some(P => P.handle === x.recipient));
  assert.ok(rows.length >= 5 && rows.every(x => x.status === 'match' && x.exact === true), JSON.stringify(rows));
  assert.deepEqual(sandboxLog.filter(l => /ALARM/.test(l)), [], 'no alarm from the sandbox');
});

step('after the tour: the three set-offs are public loops (GET /pilot/v1/loops and the loop cards) with handles only', async () => {
  const list = ok(await call('GET', '/loops', null, null));
  const applied = Object.values(pilot.s.setoffs).filter(o => o.state === 'applied');
  assert.equal(applied.length, 3);
  assert.deepEqual(list.loops.map(l => l.id).sort(), applied.map(o => o.id).sort());
  assert.deepEqual(list.loops.map(l => l.applied_at), [...list.loops.map(l => l.applied_at)].sort().reverse(), 'newest first');
  assert.deepEqual(list.loops.map(l => [l.cycle_length, l.amount_PC, l.each_PC]), [[2, 2, 1], [3, 3, 1], [2, 2, 1]]);
  // The 3-cycle in cycle order: each member owed the next (M>S, S>X, X>M), whatever member the engine started from.
  const three = list.loops[1], names = three.members.map(m => m.handle), kinds = Object.fromEntries(three.members.map(m => [m.handle, m.kind]));
  const owes = new Set([[M.handle, S.handle], [S.handle, X.handle], [X.handle, M.handle]].map(x => x.join('>')));
  assert.ok(names.every((h, i) => owes.has(`${h}>${names[(i + 1) % 3]}`)), names.join(' -> '));
  assert.deepEqual(kinds, {[X.handle]: 'sandbox_agent', [M.handle]: 'sandbox_agent', [S.handle]: 'sandbox_participant'});
  assert.deepEqual(list.loops[0].members.map(m => m.handle).sort(), [X.handle, M.handle].sort(), 'the last one is the server-only X<>M');
  const text = JSON.stringify(list);
  for (const secret of [S.id, X.id, M.id, S.pubkey, X.pubkey, M.pubkey, S.agent, S.owner]) assert.ok(!text.includes(secret), 'no ids, keys or tokens');
  for (const o of applied) for (const e of o.edges) for (const r of ['issuer', 'recipient']) if (e.slots[r]?.signature) assert.ok(!text.includes(e.slots[r].signature), 'no signatures');
  // Its card, server-rendered, as a link preview reads it.
  const r = await fetch(`${base}/loop/${three.id}`), html = await r.text();
  assert.equal(r.status, 200);
  const og = k => (new RegExp(`<meta property="og:${k}" content="([^"]*)">`).exec(html) || [])[1];
  assert.equal(og('title'), `Loop closed: ${[...names, names[0]].join(' → ')}`);
  assert.equal(og('description'), '3 agents cancelled 3 credits of IOUs in one set-off. No money moved. Recorded on a Basis tracker (pilot network; credits have no value).');
  assert.equal(og('url'), `https://valun.tech/loop/${three.id}`);
  assert.deepEqual(ok(await call('GET', `/loops/${three.id}`, null, null)), three);
});
