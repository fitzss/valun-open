// Server-side sandbox agents (lib/pilot/sandbox.mjs) over real HTTP, with a throwaway REAL Basis tracker (port 3072).
// A buyer deals with sandbox-exact (always right) and sandbox-mallory (wrong on purpose in about half of its deals),
// verifies every delivery exactly, and accepts or disputes. Also: results identical to the Python implementation.
// Circulating credit (design §5.8, spec 18.15): with the mode off (the pilot below) the agents are exactly as before;
// with tracker v3.2 (VALUN_BINS=<v3.2 bins>) a second Pilot in circulation mode on, on the same tracker with its own
// store, server and sandbox agents, checks what the agents add: their mandates, the server signer, the welcome job,
// buying within the limits and the earn cap, exact review and disputes, dormant debt, sandbox-mallory paying with a
// note it holds (and not again by transfer once a payee refused), their own notes and decision D-1, the tick (consent
// items with nothing left to sign are not work; the consent step signs what the core could not; retry_after_ms) and
// poke(). Those tests are skipped on older trackers.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PilotError, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest} from '../lib/pilot/novation.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {Sandbox, textStats, notary, extractText, malloryIsWrong, COMPUTE, render, corrupt, mandateFor, checkDelivery, parseNoteMessage, WELCOME, STRANGER_EARN_CAP, WELCOME_PER_TICK} from '../lib/pilot/sandbox.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let tracker, server, base, basis, pilot, sandbox, dataDir;
// Mode on (tracker v3.2 only): {pilot, sandbox, server, base, dir, X, M} (X, M: the agents' participant records there).
let on = null, onSkip = 'needs tracker v3.2 (VALUN_BINS=<v3.2 bins>): this tracker reports no capabilities';
const onTokens = new Map(), onLog = [], H = 3600e3;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sigHash = s => crypto.createHash('sha256').update(Buffer.from(s, 'hex')).digest('hex');     // of a signature's 65 bytes
const rnd = n => crypto.randomBytes(n).toString('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  tracker = await startTracker(3072, {servedTokenId: PILOT_TOKEN_ID});
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-sandbox-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(dataDir), basis});
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha('admin-secret')});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  sandbox = await new Sandbox(pilot, {dataDir, intervalMs: 150, log: m => { if (/failed|: [a-z_]+$/.test(m)) console.log(m); }}).start();
  // Mode on, when the tracker's capabilities validate and its binary is pinned.
  const caps = await capabilities(tracker.url), v = validateCaps(caps), bin = caps ? await trackerSha256() : null;
  if (caps) onSkip = !v.ok ? `needs tracker v3.2: capabilities do not validate (${v.reason})` : `needs tracker v3.2: basis_server ${bin} is not pinned`;
  if (!v.ok || !TRACKER_SHA256_PINS.includes(bin)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-sandbox-on-'));
  const p = new Pilot({store: new PilotStore(dir), basis, openSandbox: true, circulation: 'on', trackerCaps: caps, trackerSha256: bin, log: m => onLog.push(m)});
  assert.equal(p.mode, 'on', JSON.stringify(onLog));
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot: p, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha('admin-secret')})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const sb = await new Sandbox(p, {dataDir: dir, intervalMs: 150, log: m => { onLog.push(m); if (/ALARM|failed/.test(m)) console.log(`(mode on) ${m}`); }}).start();
  on = {pilot: p, sandbox: sb, server: srv, base: `http://127.0.0.1:${srv.address().port}`, dir,
    X: p.s.participants[sb.keys['sandbox-exact'].id], M: p.s.participants[sb.keys['sandbox-mallory'].id]};
});
after(async () => {
  sandbox?.stop(); server?.close();
  if (on) { on.sandbox.stop(); on.server.closeAllConnections?.(); on.server.close(); }
  for (let i = 0; i < 100 && (sandbox?.busy || on?.sandbox.busy); i++) await new Promise(r => setTimeout(r, 50));   // a tick in flight ends first
  await tracker?.stop();
  for (const d of [dataDir, on?.dir]) if (d) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});

const call = async (method, p, body, token, headers = {}) => {
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}, body: body && JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
async function buyer(handle) {
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `test operator of ${handle}`}), 201);
  const key = await basis.keygen();
  const sig = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: sig}), 201);
  const P = {id: j.participant_id, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 1000}, P.owner));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
function terms(P, seller, price, service, dealId = 'vd_' + crypto.randomBytes(8).toString('hex')) {
  const now = Date.now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: dealId, version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'),
    proposer: P.id, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: seller.id, pubkey: seller.pubkey},
    service, price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * 3600e3).toISOString(), offer_expires_at: new Date(now + 24 * 3600e3).toISOString()};
}
async function offer(P, seller, price, service, dealId) {
  const t = terms(P, seller, price, service, dealId), h = termsHash(t);
  return ok(await call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent), 201);
}
async function until(P, id, statuses, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const d = ok(await call('GET', `/deals/${id}`, null, P.agent));
    if (statuses.includes(d.status)) return d;
  }
  throw new Error(`deal ${id} did not reach ${statuses}`);
}
const resultOf = content => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(content)[1]);
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  const note = await basis.signHex(P.pubkey, message_hex, P.secret);
  return call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)), credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: note}}, P.agent);
}
async function dispute(P, d, reason) {
  return call('POST', `/deals/${d.id}/dispute`, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, reason,
    signature: await sign(P, statements.dispute(d.agreement.terms_hash, d.delivery.sha256, reason))}, P.agent);
}
const seller = handle => { const k = sandbox.keys[handle]; return {id: k.id, pubkey: k.pubkey}; };
const job = (svc, text, extra = '') => ({title: `${svc} job`, description: `${svc} for this text:\n\`\`\`\n${text}\n\`\`\`${extra}`, deliverable: `The exact ${svc} result as JSON.`});
// A deal id on which sandbox-mallory is wrong on purpose (true) or right (false).
const dealIdWhere = wrong => { for (;;) { const id = 'vd_' + rnd(8); if (malloryIsWrong(id) === wrong) return id; } };

test('identical results to the Python implementation (valun-open sandbox.py), including Unicode edge cases', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sandbox-python.json'), 'utf8'));
  for (const s of fx.stats) {
    assert.deepEqual(textStats(s.text), s.text_stats, `text-stats of ${JSON.stringify(s.text)}`);
    assert.deepEqual(notary(s.text), s.notary, `notary of ${JSON.stringify(s.text)}`);
  }
  for (const e of fx.extract) assert.equal(extractText(e.description), e.text, `extract from ${JSON.stringify(e.description)}`);
});

test('sandbox participants exist, are labelled, and have fresh mandates', async () => {
  const dir = ok(await call('GET', '/participants'));
  for (const h of ['sandbox-exact', 'sandbox-mallory']) {
    const p = (dir.participants || dir).find(x => x.handle === h);
    assert.ok(p, h);
    assert.match(p.operator, /sandbox agent run by the server, no AI/);
    assert.ok(Date.parse(pilot.s.participants[p.id].mandate.expires_at) > Date.now() + 20 * 864e5);
  }
  assert.equal(fs.statSync(path.join(dataDir, 'sandbox-keys.json')).isFile(), true);
});

test('sandbox-exact: offer -> accepted -> delivered exactly -> verified -> credit note issued', async () => {
  const B = await buyer('sbx-buyer-1'), S = seller('sandbox-exact');
  for (const [svc, text] of [['text-stats', 'The cat saw the dog.\nThe end'], ['notary', 'na\u00efve caf\u00e9 \u2615 \u{1F469}\u200d\u{1F4BB}']]) {
    const d0 = await offer(B, S, svc === 'notary' ? 2 : 3, job(svc, text));
    const d = await until(B, d0.id, ['delivered']);
    assert.deepEqual(resultOf(d.delivery.content), COMPUTE[svc](text));
    assert.equal(ok(await complete(B, d.id)).status, 'note_issued');
  }
});

test('sandbox-mallory: wrong on purpose exactly when malloryIsWrong(deal id); a verifying buyer disputes those', async () => {
  const B = await buyer('sbx-buyer-2'), M = seller('sandbox-mallory');
  let wrong = 0, right = 0;
  // The deal ids are chosen so that both outcomes occur, four times each: with random ids this test failed about once
  // in 128 runs (phase-0 punch list, SV-1). Every deal is still checked against malloryIsWrong(deal id).
  for (let i = 0; i < 8; i++) {
    const text = `test text number ${i} for mallory`;
    const d0 = await offer(B, M, 3, job('text-stats', text), dealIdWhere(i % 2 === 0));
    const d = await until(B, d0.id, ['delivered']);
    const good = JSON.stringify(resultOf(d.delivery.content)) === JSON.stringify(textStats(text));
    assert.equal(!good, malloryIsWrong(d.id), `deal ${d.id}`);
    if (good) { right++; assert.equal(ok(await complete(B, d.id)).status, 'note_issued'); }
    else { wrong++; assert.equal(ok(await dispute(B, d, 'The delivered word count does not match the exact text-stats of the agreed text.')).status, 'disputed'); }
  }
  assert.ok(wrong > 0 && right > 0, `expected both outcomes in 8 deals: ${wrong} wrong, ${right} right`);
});

test('sandbox declines what it cannot do, with a reason: underpriced, unknown service, no text, asked to buy', async () => {
  const B = await buyer('sbx-buyer-3'), S = seller('sandbox-exact');
  const cases = [
    [2, job('text-stats', 'x y'), /price for text-stats is 3 PC/],
    [3, {title: 'Write a poem', description: 'A poem about credit.', deliverable: 'A poem.'}, /do not offer that service/],
    [3, {title: 'text-stats job', description: 'text-stats please, but I forgot the text', deliverable: 'JSON'}, /could not find the text/],
  ];
  for (const [price, svc, why] of cases) {
    const d = await until(B, (await offer(B, S, price, svc)).id, ['declined']);
    assert.match(d.decline.reason, why);
  }
  // The sandbox as payer (asked to buy): it declines.
  const t = {...terms(B, S, 3, job('text-stats', 'x')), payer: {id: S.id, pubkey: S.pubkey}, payee: {id: B.id, pubkey: B.pubkey}};
  const h = termsHash(t);
  const r = await call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(B, statements.propose(h))}, B.agent);
  if (r.status === 201) assert.match((await until(B, r.body.id, ['declined'])).decline.reason, /only sell/);
  else assert.equal(r.status, 403, JSON.stringify(r.body));          // or the server refuses it outright (sandbox may not issue credit)
});

// ---------------------------------------------------------------------------------------------------------------
// The tick (design §5.3): only actions that succeed count toward PER_TICK (8); at most 32 attempts per tick; an item
// that fails backs off (10 s, doubling, at most 1 h); offers above the agent's own limit, and acceptances the server
// refuses for good, are declined with a signed reason. The timer is stopped so that the test drives (and counts) ticks.
async function manualTicks(fn) {
  sandbox.stop();
  while (sandbox.busy) await new Promise(r => setTimeout(r, 20));
  try { return await fn(); } finally { await sandbox.start(); }
}
const declinedBySandbox = async (B, S, id, why) => {
  const v = ok(await call('GET', `/deals/${id}`, null, B.agent));
  assert.equal(v.status, 'declined', id);
  assert.match(v.decline.reason, why);
  assert.equal(v.decline.by, S.id);
  assert.ok(await basis.verify(S.pubkey, hex(statements.decline(v.current.terms_hash, v.decline.reason)), v.decline.signature), 'the reason is signed by the agent');
};

test('tick: eight offers above the agent\'s own max_accept_per_deal and one valid offer: the valid one is accepted within two ticks, the others are declined with a signed reason', async () => {
  await manualTicks(async () => {
    const B = await buyer('sbx-buyer-cap'), S = seller('sandbox-exact');
    const cap = pilot.effectiveLimits(pilot.s.participants[S.id]).max_accept_per_deal;
    assert.equal(cap, 25, 'precondition: the sandbox mandate');
    const bad = [];
    for (let i = 0; i < 8; i++) bad.push(await offer(B, S, cap + 1 + i, job('text-stats', `above the limit, offer ${i}`)));
    const good = await offer(B, S, 3, job('text-stats', 'within the limit'));
    await sandbox.tick();
    assert.deepEqual(bad.map(d => pilot.s.deals[d.id].status), Array(8).fill('declined'), 'tick 1: eight declines are eight successful actions');
    assert.equal(pilot.s.deals[good.id].status, 'open', 'tick 1 stopped at PER_TICK successes');
    await sandbox.tick();
    assert.equal(pilot.s.deals[good.id].status, 'agreed', 'tick 2: the valid offer is accepted (failed or declined items no longer starve it)');
    for (const d of bad) await declinedBySandbox(B, S, d.id, /Above my limit: I accept at most 25 PC per deal/);
  });
});

test('tick: an acceptance the server refuses for good (offer_not_authorized) is declined with a signed reason, not retried', async () => {
  await manualTicks(async () => {
    const B = await buyer('sbx-buyer-perm'), S = seller('sandbox-exact');
    const d = await offer(B, S, 3, job('text-stats', 'the buyer\'s owner changes its mind'));
    ok(await call('PUT', '/owner/mandate', {max_issue_per_deal: 1}, B.owner));       // the offer is now outside B's mandate
    await sandbox.tick();
    await declinedBySandbox(B, S, d.id, /no longer within your mandate/);
    assert.equal(sandbox.backoff.get('sandbox-exact')?.has(d.id) ?? false, false, 'a success, not a failure');
  });
});

test('tick: an acceptance its own mandate refuses for good (mandate_exceeded: max_accept_per_issuer) is declined with a signed reason naming the rule', async () => {
  await manualTicks(async () => {
    const B = await buyer('sbx-buyer-rule'), S = seller('sandbox-exact'), x = pilot.s.participants[S.id];
    pilot.setAgentLimits(x, {max_accept_per_issuer: 2}, {by: 'owner'});           // 3 PC from one issuer is now above the agent's own limit
    try {
      const d = await offer(B, S, 3, job('text-stats', 'more than this agent accepts from one issuer'));
      await sandbox.tick();
      await declinedBySandbox(B, S, d.id, /accepting it would exceed my own mandate \(max_accept_per_issuer\)/);
      assert.equal(sandbox.backoff.get('sandbox-exact')?.has(d.id) ?? false, false, 'a success, not a failure');
    } finally { pilot.setAgentLimits(x, {max_accept_per_issuer: null}, {by: 'owner'}); }
  });
});

test('mode off: the agents keep the v15 mandate (payee only), carry no operator_run label, send no welcome job, and the server signer signs nothing', async () => {
  for (const h of ['sandbox-exact', 'sandbox-mallory']) {
    const x = pilot.participant(sandbox.keys[h].id), want = mandateFor(h, false);
    assert.deepEqual(Object.keys(x.mandate).sort(), [...Object.keys(want), 'expires_at'].sort(), `${h}: no credit-policy field`);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(x.mandate[k], v, `${h}.${k}`);
    assert.deepEqual([x.mandate.may_issue_credit, x.mandate.max_issue_per_deal, x.mandate.max_issue_outstanding], [false, 0, 0], `${h} never issues credit`);
    assert.equal(pilot.serverSigner.has(x.id), false, `${h}: nothing is signed for it`);
    assert.equal('operator_run' in pilot.publicParticipant(x), false);
  }
  const k = sandbox.keys['sandbox-exact'], ts = Math.floor((Date.now() - 2000) / 1000) * 1000 - 3;      // ends in 997
  const {message_hex} = await basis.noteMessage({issuer: k.pubkey, recipient: (await basis.keygen()).pubkey_hex, total: 1, timestamp: ts});
  await assert.rejects(sandbox.signFor(k.id, message_hex, {op: 'test'}), e => e.code === 'not_server_run');
  assert.deepEqual(Object.keys(sandbox.records.signed), [], 'nothing was ever signed');
  assert.ok(Object.values(pilot.s.deals).filter(d => Object.values(sandbox.keys).some(a => a.id === d.payer)).every(d => !d.agreement), 'the agents never bought anything');
});

test('tick: a failing item is skipped while it backs off (10 s, then 20 s, ...) and does not hold up the items after it', async () => {
  await manualTicks(async () => {
    const B = await buyer('sbx-buyer-backoff'), S = seller('sandbox-exact');
    const stuck = await offer(B, S, 3, job('text-stats', 'this offer fails for a while'));
    const next = await offer(B, S, 3, job('text-stats', 'this offer is fine'));
    const accept = pilot.accept, clock = sandbox.now;
    let tries = 0, t = Date.now();
    pilot.accept = async (x, id, body) => {
      if (id === stuck.id) { tries++; throw new PilotError('signer_unavailable', 'simulated outage', 503); }
      return accept.call(pilot, x, id, body);
    };
    sandbox.now = () => t;
    try {
      await sandbox.tick();
      assert.equal(tries, 1); assert.equal(pilot.s.deals[next.id].status, 'agreed', 'the item after the failing one is done in the same tick');
      await sandbox.tick();
      assert.equal(tries, 1, 'skipped while backing off');
      t += 10e3 + 1; await sandbox.tick();
      assert.equal(tries, 2, 'tried again after 10 s');
      t += 10e3 + 1; await sandbox.tick();
      assert.equal(tries, 2, 'the second backoff is 20 s');
      t += 10e3; await sandbox.tick();
      assert.equal(tries, 3, 'tried again after 20 s');
      delete pilot.accept;                                           // the failure is gone
      t += 40e3 + 1; await sandbox.tick();
      assert.equal(pilot.s.deals[stuck.id].status, 'agreed', 'accepted once the failure is gone');
      assert.equal(sandbox.backoff.get('sandbox-exact').has(stuck.id), false, 'success clears the backoff');
    } finally { delete pilot.accept; sandbox.now = clock; }
  });
});

test('tick: at most 32 attempts per tick when every item fails; failed items wait for their backoff', async () => {
  await manualTicks(async () => {
    const S = seller('sandbox-exact'), inbox = pilot.inbox, answer = sandbox.answer;
    const items = Array.from({length: 40}, (_, i) => ({deal_id: 'vd_' + String(i).padStart(16, '0')}));
    const tried = [];
    pilot.inbox = x => (x.id === S.id ? {respond: items, deliver: []} : inbox.call(pilot, x));
    // Only sandbox-exact's items fail (and are counted); sandbox-mallory's own inbox is answered as usual, so the counts
    // do not depend on what earlier tests left there.
    sandbox.answer = async (handle, x, item) => {
      if (handle !== 'sandbox-exact') return answer.call(sandbox, handle, x, item);
      tried.push(item.deal_id); throw new Error('simulated failure');
    };
    try {
      await sandbox.tick();
      assert.equal(tried.length, 32, 'at most 32 attempts in one tick');
      await sandbox.tick();
      assert.deepEqual(tried.slice(32), items.slice(32).map(i => i.deal_id), 'the next tick tries only the items not backing off');
      await sandbox.tick();
      assert.equal(tried.length, 40, 'then nothing until a backoff ends');
    } finally { delete pilot.inbox; delete sandbox.answer; sandbox.backoff.clear(); }
  });
});

// =================================================================================================================
// Circulating credit, mode on (tracker v3.2 only): the second Pilot, its server and its own sandbox agents (tick every
// 150 ms). Strangers are self-serve sandbox participants (Pilot.joinSandbox, as the HTTP route calls it, without the
// route's per-address limit) whose agents declare every consent role (X-Valun-Features) and sign as a 0.4 client.
const FEATURES = 'consents/1;roles=setoff,issuer,creditor';
const onLive = t => { if (!on) { t.skip(onSkip); return false; } return true; };
const callOn = async (method, p, body, token, headers = {}) => {
  const P = onTokens.get(token);
  const r = await fetch(on.base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}),
    ...(P && token === P.agent ? {'x-valun-features': FEATURES} : {}), ...headers}, body: body && JSON.stringify(body)});
  return {status: r.status, body: await r.json().catch(() => null)};
};
async function waitForCond(fn, what, ms = 30000) {
  for (const end = Date.now() + ms; ; await new Promise(r => setTimeout(r, 100))) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
  }
}
async function enrollStranger(P) {
  const key = await basis.keygen();
  const sig = await basis.signHex(key.pubkey_hex, hex(statements.enroll(P.id, key.pubkey_hex, sha(P.j.enrollment_code))), key.secret_hex);
  const e = ok(await callOn('POST', '/enroll', {participant_id: P.id, code: P.j.enrollment_code, pubkey: key.pubkey_hex, signature: sig}), 201);
  Object.assign(P, {pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token});
  onTokens.set(P.agent, P);
  ok(await callOn('GET', '/me', null, P.agent));                       // its client declares its consent roles
  return P;
}
async function stranger(handle, {enroll = true} = {}) {
  const j = await on.pilot.joinSandbox({handle, operator: `test operator of ${handle}`});
  const P = {id: j.participant_id, handle, j, owner: j.owner_token};
  return enroll ? enrollStranger(P) : P;
}
async function invitedOn(handle) {
  const inv = ok(await callOn('POST', '/admin/invites', {note: handle}, null, {'x-valun-admin': 'admin-secret'}), 201);
  const j = ok(await callOn('POST', '/join', {invite: inv.code, handle, operator: `test operator of ${handle}`}), 201);
  ok(await callOn('PUT', '/owner/mandate', {approve_above: 1000}, j.owner_token));                // its offers go out without its owner
  return enrollStranger({id: j.participant_id, handle, j, owner: j.owner_token});
}
const agentOn = h => { const q = on.pilot.s.participants[on.sandbox.keys[h].id]; return {id: q.id, handle: h, pubkey: q.pubkey}; };
const signAs = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
const noteMsg = async (i, r, total, ts) => (await basis.noteMessage({issuer: i, recipient: r, total, timestamp: ts})).message_hex;
// Tracker v3.2's prior acknowledgment PA(I,R,X,p,T) of edge I>R's state (X, p) at T.
const paMsg = async (i, r, total, priorTs, ts) => (await basis.priorAckMessage({issuer: i, recipient: r, priorTotal: total, priorTimestamp: priorTs, timestamp: ts})).message_hex;
// P proposes (as payer or payee) to a sandbox agent.
async function offerOn(P, {payer, payee, price, service, dealId = 'vd_' + rnd(8)}) {
  const now = Date.now();
  const t = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: dealId, version: 1, prior_terms_hash: null,
    nonce: rnd(16), proposer: P.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service,
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * H).toISOString(), offer_expires_at: new Date(now + 24 * H).toISOString()};
  const h = termsHash(t);
  return ok(await callOn('POST', '/deals', {terms: t, terms_hash: h, signature: await signAs(P, statements.propose(h))}, P.agent), 201).id;
}
const viewOn = async (P, id) => ok(await callOn('GET', `/deals/${id}`, null, P.agent));
const untilOn = (P, id, statuses, ms = 30000) => waitForCond(async () => { const v = await viewOn(P, id); return statuses.includes(v.status) && v; }, `deal ${id} to be ${statuses.join(' or ')}`, ms);
async function deliverOn(P, id, content) {
  const v = await viewOn(P, id), h = v.agreement.terms_hash, dh = sha(content);
  return ok(await callOn('POST', `/deals/${id}/deliver`, {terms_hash: h, content, title: 'result', sha256: dh, signature: await signAs(P, statements.deliver(h, dh))}, P.agent));
}
async function acceptOn(P, id) {
  const v = await viewOn(P, id);
  return ok(await callOn('POST', `/deals/${id}/accept`, {terms_hash: v.current.terms_hash, signature: await signAs(P, statements.accept(v.current.terms_hash))}, P.agent));
}
// Declined by agent A with a signed reason matching `why`.
async function declinedOn(P, A, id, why) {
  const v = await untilOn(P, id, ['declined', 'agreed']);
  assert.equal(v.status, 'declined', `${id}: ${JSON.stringify(v.decline)}`);
  assert.match(v.decline.reason, why);
  assert.equal(v.decline.by, A.id);
  assert.ok(await basis.verify(A.pubkey, hex(statements.decline(v.current.terms_hash, v.decline.reason)), v.decline.signature), 'the reason is signed by the agent');
}
// P pays deal id with a note of A's it holds (pay_with), as a 0.4 client: it checks the template and signs its slots.
async function payWithOn(P, id, A) {
  const tpl = ok(await callOn('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, P.agent)), v = await viewOn(P, id);
  const T = tpl.timestamp, a = tpl.amount, Xf = tpl.from_edge.before.total, Yt = tpl.to_edge.before?.total ?? 0, C = tpl.payee.pubkey;
  const pX = tpl.from_edge.before.timestamp, pY = tpl.to_edge.before?.timestamp ?? 0;
  assert.deepEqual([T % 1000, tpl.issuer.pubkey, tpl.payer.pubkey, C, a], [999, A.pubkey, P.pubkey, v.current.terms.payee.pubkey, v.current.terms.price.amount]);
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: id, terms_hash: v.agreement.terms_hash,
    deliverable_sha256: v.delivery.sha256, issuer_pubkey: A.pubkey, payer_pubkey: P.pubkey, payee_pubkey: C, amount: a});
  assert.equal(tpl.quote_digest, q);
  const AB = `${A.pubkey}>${P.pubkey}`, AC = `${A.pubkey}>${C}`, slot = async (r, total) => basis.signHex(P.pubkey, await noteMsg(A.pubkey, r, total, T), P.secret);
  return ok(await callOn('POST', `/deals/${id}/pay-by-transfer`, {issuer_id: A.id, terms_hash: v.agreement.terms_hash, deliverable_sha256: v.delivery.sha256, quote_digest: q,
    timestamp: T, from_prior_total: Xf, to_prior_total: Yt, from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await signAs(P, statements.complete(v.agreement.terms_hash, v.delivery.sha256)), pay_signature: await signAs(P, circulationStatements.pay(id, q)),
    signatures: {[`${AB}:prior`]: await basis.signHex(P.pubkey, await paMsg(A.pubkey, P.pubkey, Xf, pX, T), P.secret), [`${AB}:new`]: await slot(P.pubkey, Xf - a),
      [`${AC}:new`]: await slot(C, Yt + a)}}, P.agent));
}
const totalOf = async (I, R) => { const n = await basis.note(I.pubkey, R.pubkey); return n ? Number(n.amount_collected) : 0; };
const exactDelivery = (service, text) => render(service, COMPUTE[service](text), text);

test('mode on: the agents get the circulation mandate (re-applied by the drift check); the server signer signs only note messages and tracker v3.2 prior acknowledgments for them at residues 997-999, written ahead, and never two operations (nor two acknowledged prior states) at one edge and timestamp', async t => {
  if (!onLive(t)) return;
  const p = on.pilot;
  for (const h of ['sandbox-exact', 'sandbox-mallory']) {
    const x = p.s.participants[on.sandbox.keys[h].id];
    for (const [k, v] of Object.entries(mandateFor(h, true))) assert.deepEqual(x.mandate[k], v, `${h}.${k}`);
    assert.ok(p.serverSigner.has(x.id) && p.serverRun(x), `${h} is server-run`);
    assert.equal(p.publicParticipant(x).operator_run, true, `${h} is labelled operator_run`);
  }
  const m0 = on.X.mandate;
  assert.deepEqual([m0.may_issue_credit, m0.max_issue_per_deal, m0.max_issue_outstanding, m0.max_accept_per_deal, m0.max_accept_per_issuer, m0.accept_transfers,
    m0.accept_notes_from, m0.refuse_notes_from, m0.novate_own_debt, m0.auto_clear, m0.approve_above, m0.review_deliveries, m0.counterparties],
  [true, 5, 1000, 25, 1000, true, 'any', [], true, true, 1000, false, 'any']);
  assert.deepEqual([on.X.mandate.pay_with_held_notes, on.M.mandate.pay_with_held_notes], ['never', 'prefer']);
  p.setMandate(on.X, {max_issue_outstanding: 7, accept_transfers: false}, {by: 'operator'});
  await on.sandbox.ensure();
  assert.deepEqual([on.X.mandate.max_issue_outstanding, on.X.mandate.accept_transfers], [1000, true], 'the drift check re-applies the circulation mandate');
  // The server signer.
  const S = await stranger('sbx-on-signer'), X = agentOn('sandbox-exact'), R = (await basis.keygen()).pubkey_hex;
  const ts = Math.floor((Date.now() - 2000) / 1000) * 1000 - 3;                    // ends in 997
  const m = (total, timestamp = ts) => noteMsg(X.pubkey, R, total, timestamp);
  const sf = (msgHex, op, id = X.id) => on.sandbox.signFor(id, msgHex, {op});
  const refusedWith = (pr, code) => assert.rejects(pr, e => e.code === code, code);
  const s5 = await sf(await m(5), 'test:a');
  assert.ok(await basis.verify(X.pubkey, await m(5), s5), 'signed with the key of sandbox-exact');
  await sf(await m(4), 'test:a');                                               // a second total of one operation (a prior and a new one)
  await sf(await m(5), 'test:a');                                               // the same message again
  await refusedWith(sf(await m(6), 'test:a'), 'timestamp_reused');              // a third total at the same edge and timestamp
  await refusedWith(sf(await m(5), 'test:b'), 'timestamp_reused');              // another operation there
  await sf(await m(5, ts - 1000), 'test:b');                                    // another timestamp
  await refusedWith(sf(await m(5), 'test:a', S.id), 'not_server_run');          // a participant the server does not run
  await refusedWith(sf(hex(statements.accept('ab'.repeat(32))), 'test:c'), 'not_a_note_message');
  await refusedWith(sf(await m(5, ts - 497), 'test:c'), 'timestamp_domain');    // residue 500: an ordinary note
  await refusedWith(sf(await m(5, ts - 2 * H), 'test:c'), 'timestamp_stale');   // older than the tracker accepts
  await refusedWith(sf(await m(5, ts + 61e3), 'test:c'), 'timestamp_stale');    // ahead of the clock
  await refusedWith(sf((await m(5, ts - 2000)).slice(0, 96) + 'cd'.repeat(32), 'test:c'), 'tracker_mismatch');
  // Tracker v3.2's prior acknowledgments (105 bytes): signed like a note message of their prior total at their T (one
  // operation, at most two totals), and never for two different prior states at one edge and timestamp.
  const pa = (total, priorTs, timestamp = ts) => paMsg(X.pubkey, R, total, priorTs, timestamp), tsP = ts - 4000;
  const sp = await sf(await pa(3, tsP - 60e3, tsP), 'test:p');
  assert.ok(await basis.verify(X.pubkey, await pa(3, tsP - 60e3, tsP), sp), 'a PA signed with the key of sandbox-exact');
  await sf(await m(5, tsP), 'test:p');                                          // the operation's new total at the same edge and T
  await sf(await pa(3, tsP - 60e3, tsP), 'test:p');                             // the same acknowledgment again
  await refusedWith(sf(await pa(3, tsP - 59e3, tsP), 'test:p'), 'timestamp_reused');   // the same total, another prior state
  await refusedWith(sf(await pa(3, tsP - 60e3, tsP), 'test:q'), 'timestamp_reused');   // another operation there
  await refusedWith(sf((await pa(3, 0, ts - 5000)).slice(0, 146) + 'cd'.repeat(32), 'test:c'), 'tracker_mismatch');
  await refusedWith(sf(await pa(3, 0, ts - 5497), 'test:c'), 'timestamp_domain');
  await refusedWith(sf(await pa(3, 0, ts - 2 * H), 'test:c'), 'timestamp_stale');
  // The record is on the data volume; one that cannot be read stops all signing.
  const {debt_key_hex} = await basis.noteMessage({issuer: X.pubkey, recipient: R, total: 5, timestamp: ts});
  const kept = new Sandbox(p, {dataDir: on.dir}).records.signed[`${X.id}|${debt_key_hex}|${ts}`];
  assert.ok(kept, 'the record is on the data volume (written before the signature was made)');
  assert.deepEqual([kept.op, kept.totals], ['test:a', [5, 4]]);
  const keptP = new Sandbox(p, {dataDir: on.dir}).records.signed[`${X.id}|${debt_key_hex}|${tsP}`];
  assert.deepEqual([keptP.op, keptP.totals, keptP.prior_ack], ['test:p', [3, 5], `3@${tsP - 60e3}`], 'a PA record keeps the prior state it acknowledged');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-sandbox-records-'));
  try {
    fs.copyFileSync(path.join(on.dir, 'sandbox-keys.json'), path.join(tmp, 'sandbox-keys.json'));
    fs.writeFileSync(path.join(tmp, 'sandbox-records.json'), '{"version": 1, "signed": ');
    await refusedWith(new Sandbox(p, {dataDir: tmp}).signFor(X.id, await m(5, ts - 3000), {op: 'test:d'}), 'records_unreadable');
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
});

test('mode on: sandbox-exact sends every new sandbox participant one welcome job (3 PC for the text-stats of a fixed text, open 24 h, delivery within 48 h), and none to invited or dormant participants', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, X = agentOn('sandbox-exact'), welcomes = q => Object.values(p.s.deals).filter(d => d.payer === X.id && d.payee === q.id);
  const S = await stranger('sbx-on-welcome');
  await waitForCond(() => welcomes(S).length > 0, 'the welcome job');
  const [d] = welcomes(S), v = d.versions[0], terms = v.terms, text = WELCOME.text(S.handle);
  assert.equal(text, `Welcome to the Valun sandbox, ${S.handle}. This text is your first paid job.`);
  assert.deepEqual([d.status, terms.price.amount, terms.service.title, terms.service.deliverable, extractText(terms.service.description)],
    ['open', 3, 'Welcome job: text-stats', 'the exact text-stats result as JSON (your Valun client can compute it: valun_deliver exact_result=true)', text]);
  assert.ok(terms.service.description.includes('```\n' + text + '\n```'), 'the text in a fenced block');
  const made = Date.parse(v.created_at);
  assert.ok(Math.abs(Date.parse(terms.offer_expires_at) - made - 24 * H) < 60e3 && Math.abs(Date.parse(terms.deliver_by) - made - 48 * H) < 60e3);
  assert.ok(await basis.verify(X.pubkey, hex(statements.propose(v.terms_hash)), v.signature), 'signed by sandbox-exact');
  assert.equal(p.s.participants[S.id].sandbox_welcome.deal_id, d.id);
  assert.deepEqual(ok(await callOn('GET', '/inbox', null, S.agent)).respond.map(i => i.deal_id), [d.id], 'an offer for the stranger to answer');
  const I = await invitedOn('sbx-on-invited');
  const D = await stranger('sbx-on-dormant', {enroll: false});
  p.s.participants[D.id].sandbox_expires_at = new Date(Date.now() - 1000).toISOString();          // its sandbox time has ended
  await enrollStranger(D);
  await new Promise(r => setTimeout(r, 1500));                                                      // many ticks later
  assert.deepEqual([welcomes(S).length, welcomes(I).length, welcomes(D).length], [1, 0, 0], 'once per joiner; none to an invited or a dormant participant');
});

test('mode on: an agent buys a stranger\'s job at list price within its limits, checks the delivery exactly and pays with a bound note; above list price, another service, no text, more than 4000 bytes of text or a fourth purchase in 24 h are declined with a signed reason', async t => {
  if (!onLive(t)) return;
  const S = await stranger('sbx-on-seller'), X = agentOn('sandbox-exact'), sell = (price, service) => offerOn(S, {payer: X, payee: S, price, service});
  const wide = String.fromCodePoint(0x4e2d).repeat(1400);                                          // 1400 characters, 4200 bytes
  for (const [price, svc, why] of [
    [4, job('text-stats', 'four is above the list price'), /I pay at most 3 PC for text-stats/],
    [3, {title: 'Write a poem', description: 'A poem about credit.', deliverable: 'A poem.'}, /I buy only text-stats and notary jobs/],
    [2, {title: 'notary job', description: 'notary please, but I forgot the text', deliverable: 'JSON'}, /could not find the text/],
    [3, job('text-stats', wide), /I buy jobs on at most 4000 bytes of text/],
  ]) await declinedOn(S, X, await sell(price, svc), why);
  const text = 'An exact job for sandbox-exact to buy.';
  const id = await sell(3, job('text-stats', text));
  await untilOn(S, id, ['agreed']);
  await deliverOn(S, id, exactDelivery('text-stats', text));
  const v = await untilOn(S, id, ['note_issued', 'disputed', 'note_failed']);
  assert.equal(v.status, 'note_issued', 'checked exactly and paid');
  const n = v.credit_note;
  assert.deepEqual([n.issuer_pubkey, n.recipient_pubkey, n.amount, n.prior_total, n.note.total, n.note.timestamp % 1000, typeof n.note.prior_signature], [X.pubkey, S.pubkey, 3, 0, 3, 997, 'string'],
    'a bound note with its prior acknowledgment');
  assert.ok(await basis.verify(X.pubkey, await paMsg(X.pubkey, S.pubkey, 0, 0, n.note.timestamp), n.note.prior_signature), 'the prior acknowledgment PA(X,S,0,0,ts) is signed by sandbox-exact');
  assert.equal(await totalOf(X, S), 3);
  const claim = ok(await callOn('GET', '/me', null, S.agent)).position.claims.find(c => c.issuer_id === X.id);
  assert.deepEqual([claim.amount, claim.operator_run, claim.label], [3, true, 'issued with keys the operator holds']);
  const debt = ok(await callOn('GET', `/participants/${X.id}`)).public_position.debts.find(c => c.recipient_id === S.id);
  assert.deepEqual([debt.amount, debt.operator_run], [3, true], 'the agent\'s own credit history is labelled');
  for (let i = 2; i <= 3; i++) await untilOn(S, await sell(2, job('notary', `purchase number ${i}`)), ['agreed']);
  await declinedOn(S, X, await sell(2, job('notary', 'a fourth purchase today')), /I buy at most 3 jobs from you in 24 hours/);
});

test('mode on: the earn cap: no agent buys once the stranger\'s claims on the sandbox agents (purchases agreed and not yet paid included) plus the price would exceed 20 PC', async t => {
  if (!onLive(t)) return;
  const S = await stranger('sbx-on-earner'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  for (const A of [X, M]) for (let i = 0; i < 3; i++) await untilOn(S, await offerOn(S, {payer: A, payee: S, price: 3, service: job('text-stats', `earning ${i} from ${A.handle}`)}), ['agreed']);
  assert.equal(await on.sandbox.strangerClaims(S.id), 18);
  assert.equal(STRANGER_EARN_CAP, 20);
  const clock = on.sandbox.now;
  on.sandbox.now = () => Date.now() + 25 * H;          // a day later for the per-stranger purchase limit; the claims stay
  try {
    await declinedOn(S, X, await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', 'this would make 21')}),
      /your claims on the sandbox agents \(18 PC[\s\S]*plus 3 PC would be above the sandbox limit of 20 PC/);
    await untilOn(S, await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', 'this makes exactly 20')}), ['agreed']);
    await declinedOn(S, M, await offerOn(S, {payer: M, payee: S, price: 2, service: job('notary', 'this would make 22')}), /\(20 PC[\s\S]*above the sandbox limit of 20 PC/);
  } finally { on.sandbox.now = clock; }
});

test('mode on: a wrong delivery is disputed with a signed reason naming the first field that differs; a delivery without a result block is disputed too; nothing is paid', async t => {
  if (!onLive(t)) return;
  const S = await stranger('sbx-on-wrong'), X = agentOn('sandbox-exact');
  const cases = [
    ['notary', 2, 'a notary job delivered one byte off', text => render('notary', corrupt('notary', notary(text)), text), text => `the first field that differs is "bytes" (exactly ${notary(text).bytes})`],
    // Two fields wrong: the reason names the first in the order of the exact result (characters before lines).
    ['text-stats', 3, 'a text-stats job with the characters and lines off', text => { const r = textStats(text); r.characters += 1; r.lines += 1; return render('text-stats', r, text); },
      text => `the first field that differs is "characters" (exactly ${textStats(text).characters})`],
    ['notary', 2, 'a notary job delivered without its block', () => 'I computed it; there is no JSON block here.', () => 'has no ```json block with the exact notary result'],
  ];
  for (const [service, price, text, content, why] of cases) {
    const id = await offerOn(S, {payer: X, payee: S, price, service: job(service, text)});
    await untilOn(S, id, ['agreed']);
    await deliverOn(S, id, content(text));
    const v = await untilOn(S, id, ['disputed', 'note_issued', 'note_failed']);
    assert.equal(v.status, 'disputed', `${service}: ${text}`);
    assert.ok(v.dispute.reason.includes(why(text)), v.dispute.reason);
    assert.equal(v.dispute.by, X.id);
    assert.ok(await basis.verify(X.pubkey, hex(statements.dispute(v.agreement.terms_hash, v.delivery.sha256, v.dispute.reason)), v.dispute.signature), 'signed by sandbox-exact');
    assert.equal(checkDelivery(v.current.terms, exactDelivery(service, text)), null, 'the exact result passes the same check');
  }
  assert.equal(await totalOf(X, S), 0, 'nothing paid');
});

test('mode on: debt an agent owes sandbox participants whose sandbox time has ended does not count against its own max_issue_outstanding, and is reported as dormant_PC', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, S = await stranger('sbx-on-dormant-debt'), X = agentOn('sandbox-exact'), x = p.s.participants[X.id];
  await waitForCond(() => p.s.participants[S.id].sandbox_welcome, 'the welcome job (it reserves 3 PC of what sandbox-exact may issue)');
  const text = 'sandbox-exact will owe this stranger 3 PC.';
  const id = await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', text)});
  await untilOn(S, id, ['agreed']);
  await deliverOn(S, id, exactDelivery('text-stats', text));
  assert.equal((await untilOn(S, id, ['note_issued', 'disputed'])).status, 'note_issued');
  const q = p.s.participants[S.id], until = q.sandbox_expires_at;
  const entry = async () => (await p.checkMandate(x, 'payer', S.id, 1)).checks.find(c => c.rule === 'max_issue_outstanding');
  const live = await entry();
  assert.equal(live.dormant_PC, 0);
  q.sandbox_expires_at = new Date(Date.now() - 1000).toISOString();                     // its sandbox time has ended
  try {
    const e = await entry();
    assert.deepEqual([e.dormant_PC, e.owed_on_tracker, e.committed, e.reserved], [3, live.owed_on_tracker - 3, live.committed, live.reserved]);
    p.setAgentLimits(x, {max_issue_outstanding: e.owed_on_tracker + e.committed + e.reserved + 1}, {by: 'owner'});
    await p.checkMandate(x, 'payer', S.id, 1);                                           // fits: the dormant debt does not count
    q.sandbox_expires_at = until;
    await assert.rejects(p.checkMandate(x, 'payer', S.id, 1), err => err.code === 'mandate_exceeded' && err.extra.rule === 'max_issue_outstanding',
      'once the creditor is not dormant, the same issue is above the limit');
  } finally { q.sandbox_expires_at = until; p.setAgentLimits(x, {max_issue_outstanding: null}, {by: 'owner'}); }
  const own = (await p.checkMandate(p.s.participants[S.id], 'payer', X.id, 1)).checks.find(c => c.rule === 'max_issue_outstanding');
  assert.equal('dormant_PC' in own, false, 'any other participant\'s check is as before');
});

test('mode on: sandbox-mallory pays with a note of sandbox-exact it holds when it covers the price, the payee accepts it and is present; the stranger\'s client signs as payee', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, S = await stranger('sbx-on-transfer'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  // The welcome job: S earns 3 PC of X's notes.
  const w = await waitForCond(() => Object.values(p.s.deals).find(d => d.payer === X.id && d.payee === S.id), 'the welcome job');
  assert.equal((await acceptOn(S, w.id)).status, 'agreed');
  await deliverOn(S, w.id, exactDelivery('text-stats', WELCOME.text(S.handle)));
  assert.equal((await untilOn(S, w.id, ['note_issued', 'disputed'])).status, 'note_issued');
  // S buys notary from M (2 PC; a deal on which M is right) and pays with X's note: M now holds 2 PC of X's notes.
  const buy = await offerOn(S, {payer: S, payee: M, price: 2, service: job('notary', 'paid with a note of sandbox-exact'), dealId: dealIdWhere(false)});
  await untilOn(S, buy, ['delivered']);
  assert.equal((await payWithOn(S, buy, X)).status, 'paid_by_transfer');
  assert.deepEqual([await totalOf(X, S), await totalOf(X, M)], [1, 2]);
  // S sells notary to M (2 PC): M pays with X's note, which covers the price; S's client signs its consent as payee.
  const text = 'sandbox-mallory pays with a note it holds.';
  const sold = await offerOn(S, {payer: M, payee: S, price: 2, service: job('notary', text)});
  await untilOn(S, sold, ['agreed']);
  await deliverOn(S, sold, exactDelivery('notary', text));
  assert.equal((await untilOn(S, sold, ['paying_by_transfer', 'note_issued', 'disputed'])).status, 'paying_by_transfer');
  const item = await waitForCond(async () => ok(await callOn('GET', '/consents', null, S.agent)).consents.find(c => c.kind === 'transfer'), 'the consent to sign');
  assert.deepEqual([item.your_roles, item.context.amount, item.context.issuer.id, item.context.payer.id, item.context.payee.id, item.context.deal.deal_id], [['payee'], 2, X.id, M.id, S.id, sold]);
  const [e] = item.edges;
  assert.deepEqual([item.edges.length, e.edge, e.your_role, e.slots, e.before.total, e.new_total, e.timestamp % 1000], [1, `${X.pubkey}>${S.pubkey}`, 'creditor', ['prior', 'new'], 1, 3, 999]);
  assert.ok(await basis.verify(X.pubkey, await noteMsg(X.pubkey, S.pubkey, e.before.total, e.before.timestamp), e.before.signature), 'the edge state is a note of sandbox-exact');
  assert.equal(e.prior_timestamp, e.before.timestamp);
  const sigs = {[`${e.edge}:prior`]: await basis.signHex(S.pubkey, await paMsg(X.pubkey, S.pubkey, 1, e.before.timestamp, e.timestamp), S.secret),
    [`${e.edge}:new`]: await basis.signHex(S.pubkey, await noteMsg(X.pubkey, S.pubkey, 3, e.timestamp), S.secret)};
  assert.equal(ok(await callOn('POST', `/consents/${item.id}`, {signatures: sigs, revisions: {[e.edge]: e.revision}}, S.agent)).result.code, 'applied');
  assert.equal((await viewOn(S, sold)).status, 'paid_by_transfer');
  assert.deepEqual([await totalOf(X, M), await totalOf(X, S), await totalOf(M, S)], [0, 3, 0], '2 PC of the debt of sandbox-exact moved from sandbox-mallory to S; sandbox-mallory issued no note');
  const tr = p.s.transfers[item.id];
  assert.deepEqual([tr.issuer.id, tr.payer.id, tr.payee.id, tr.slots.from_recipient.by, tr.slots.issuer_from.by, tr.slots.issuer_from.server_signed], [X.id, M.id, S.id, M.id, X.id, true]);
  // Once more, with S away (not seen for 11 minutes) when sandbox-mallory pays: the payee is not present, so it pays with
  // its own note although it holds enough of sandbox-exact's notes. The loop is stopped meanwhile, and one tick is run.
  const buy2 = await offerOn(S, {payer: S, payee: M, price: 2, service: job('notary', 'paid with a note of sandbox-exact again'), dealId: dealIdWhere(false)});
  await untilOn(S, buy2, ['delivered']);
  assert.equal((await payWithOn(S, buy2, X)).status, 'paid_by_transfer');
  assert.deepEqual([await totalOf(X, S), await totalOf(X, M)], [1, 2]);
  const text2 = 'sandbox-mallory pays with its own note: the payee is away.';
  const sold2 = await offerOn(S, {payer: M, payee: S, price: 2, service: job('notary', text2)});
  await untilOn(S, sold2, ['agreed']);
  on.sandbox.stop();
  for (let i = 0; i < 100 && on.sandbox.busy; i++) await new Promise(r => setTimeout(r, 50));
  try {
    await deliverOn(S, sold2, exactDelivery('notary', text2));
    p.s.participants[S.id].last_seen_agent = new Date(Date.now() - 11 * 60e3).toISOString();
    await on.sandbox.tick();
    const d2 = p.s.deals[sold2];
    assert.deepEqual([d2.status, d2.transfer_ids ?? null, d2.credit_note?.issuer_pubkey], ['note_issued', null, M.pubkey], 'the payee is not present: no payment by transfer');
  } finally { await on.sandbox.start(); }
  assert.deepEqual([await totalOf(X, M), await totalOf(M, S)], [2, 2]);
});

test('mode on: an agent\'s own credit notes: one the tracker does not record (note_failed) is tried again at once with the same prior acknowledgment; another prior waits until the earlier note is dead (D-1); none is signed once an earlier one applied or may have', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-retry'), X = agentOn('sandbox-exact'), x = p.s.participants[X.id];
  const text = 'the first credit note for this job is refused';
  const id = await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', text)});
  await untilOn(S, id, ['agreed']);
  // The tracker refuses sandbox-exact's first note to S (nothing recorded); the agent signs a new one against the same
  // prior (0) and the deal is paid. When the second note is posted, both are in the signer's records as attempts: as
  // the sha256 of their signatures only (an unapplied note's signature is withheld), in a file only the server's user
  // can read.
  let posts = 0, first = null, kept = null;
  const api = basis.api, recordsFile = path.join(on.dir, 'sandbox-records.json');
  basis.api = function (method, route, body) {
    if (method === 'POST' && route === '/notes' && body?.issuer_pubkey === X.pubkey && body?.recipient_pubkey === S.pubkey) {
      posts++;
      if (posts === 1) { first = body.signature; return Promise.resolve({status: 409, json: {success: false, error: 'simulated refusal', code: 'stale_prior'}, text: ''}); }
      if (posts === 2) kept = {text: fs.readFileSync(recordsFile, 'utf8'), mode: fs.statSync(recordsFile).mode, second: body.signature};
    }
    return api.call(this, method, route, body);
  };
  try {
    await deliverOn(S, id, exactDelivery('text-stats', text));
    assert.equal((await untilOn(S, id, ['note_issued', 'disputed'], 45000)).status, 'note_issued');
  } finally { delete basis.api; }
  const d = p.s.deals[id];
  assert.deepEqual([posts, d.history.filter(h => h.event === 'credit_note_failed').length, d.replaced_notes?.length, d.credit_note.prior_total, await totalOf(X, S)], [2, 1, 1, 0, 3],
    'two notes posted (the first refused), the second against the same prior, recorded once');
  const attempts = JSON.parse(kept.text).attempts[`${X.id}|${id}`];
  assert.deepEqual(attempts.map(a => [a.signature_sha256, a.prior_total, a.total, 'signature' in a, 'signature' in (a.before ?? {})]),
    [[sigHash(first), 0, 3, false, false], [sigHash(kept.second), 0, 3, false, false]], 'both attempts, kept by the sha256 of their signatures');
  assert.ok(!kept.text.includes(first) && !kept.text.includes(kept.second), 'no note signature in the records');
  if (process.platform !== 'win32') assert.equal(kept.mode & 0o077, 0, 'sandbox-records.json is readable by the server\'s user only');
  // D-1 between two of the agent's own notes (Sandbox.ownNoteBlock), against the edge as the tracker holds it now.
  // Attempts are kept as the signer records them: {edge, before {total, timestamp, signature_sha256}, prior_total,
  // total, timestamp, signature_sha256}.
  const n = await basis.note(X.pubkey, S.pubkey), st = {total: Number(n.amount_collected), timestamp: n.timestamp, signature: n.signature}, edge = `${X.pubkey}>${S.pubkey}`;
  const key = `${X.id}|vd_${rnd(8)}`, fake = {id: key.split('|')[1]}, now = Date.now(), recent = Math.floor((now - 5000) / 1000) * 1000 - 3;
  const tpl = prior => ({issuer_pubkey: X.pubkey, recipient_pubkey: S.pubkey, prior_total: prior});
  const block = async (list, prior) => { sb.records.attempts[key] = list; try { return await sb.ownNoteBlock(x, fake, tpl(prior)); } finally { delete sb.records.attempts[key]; } };
  const keptState = (total, timestamp, signature) => ({total, timestamp, signature_sha256: sigHash(signature)}), other = '02' + 'ab'.repeat(64);
  const alive = {edge, before: keptState(st.total, st.timestamp, st.signature), prior_total: st.total, total: st.total + 3, timestamp: recent, signature_sha256: sigHash(other)};
  assert.equal(await block([alive], st.total), null, 'the same prior acknowledgment: at once (the two exclude each other)');
  const w = await block([alive], st.total + 1);
  assert.equal(w.code, 'transfer_window_open', 'another prior while the earlier note can still apply');
  assert.ok(Math.abs(w.retry_after_ms - (recent + 3600e3 + 120e3 - now)) < 10e3, 'until its timestamp + 1 h + 2 min');
  assert.equal(await block([{...alive, timestamp: recent - 2 * H}], st.total + 1), null, 'an earlier note older than 1 h + 2 min is dead');
  assert.equal(await block([{...alive, timestamp: st.timestamp - 1000, before: keptState(st.total, 1, other)}], st.total + 1), null,
    'an earlier note the edge moved past at its prior total is dead');
  assert.deepEqual(await block([{edge, before: null, prior_total: 0, total: st.total, timestamp: st.timestamp, signature_sha256: sigHash(st.signature)}], st.total), {code: 'already_paid'},
    'an earlier note the tracker holds: nothing more is signed');
  // An earlier note from the prior the edge's next recorded note also followed (here: the deal's own second note, from
  // 0): Valun's journal proves it never applied and never can (decision D-2 e), although the edge now holds its total
  // past its timestamp (which alone reads as applied_moved).
  assert.equal(await block([{...alive, timestamp: st.timestamp - 1000, before: keptState(st.total - 3, 1, other), prior_total: st.total - 3, total: st.total}], st.total),
    null, 'an earlier note the journal proves dead does not stop a payment');
  // One the journal cannot prove dead (the edge's next recorded note followed another prior) is still taken as applied.
  assert.deepEqual(await block([{...alive, timestamp: st.timestamp - 1000, before: keptState(st.total - 2, 1, other), prior_total: st.total - 2, total: st.total}], st.total),
    {code: 'already_paid'}, 'an earlier note the edge moved past at that note\'s own new total applied (applied_moved): nothing more is signed');
  assert.deepEqual(await block([{...alive, timestamp: st.timestamp - 1000, before: keptState(st.total + 7, 1, other), total: st.total + 9}], st.total),
    {code: 'attempt_outcome_unknown'}, 'an earlier note the edge moved past at another total may have applied: nothing more is signed');
  // An attempt recorded with its signature itself (as the records were written before they kept sha256) is read the
  // same way.
  assert.deepEqual(await block([{edge, before: null, prior_total: 0, total: st.total, timestamp: st.timestamp, signature: st.signature}], st.total), {code: 'already_paid'});
});

// The stop/tick/start pattern of the tests below: the loop is stopped (and a tick in flight ends) so that the test
// runs the ticks itself; it starts again afterwards.
async function stopLoop(sb) { sb.stop(); for (let i = 0; i < 200 && sb.busy; i++) await sleep(25); }

test('mode on: tick: consent items an agent has nothing left to sign are not work: a collecting transfer sandbox-exact signed as issuer when it was made is not listed, and 40 such items, listed by the core or by the loop, never keep a new offer from being answered in the next tick', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, X = agentOn('sandbox-exact'), x = p.s.participants[X.id];
  // A real one: H holds a note of sandbox-exact (it sold sandbox-exact a job) and pays Q with it; Q's client has not
  // signed yet, so the transfer collects; sandbox-exact, its issuer, signed when the transfer was made.
  const H = await invitedOn('sbx-on-holder'), Q = await invitedOn('sbx-on-slow-payee');
  ok(await callOn('PUT', '/owner/mandate', {accept_transfers: true, accept_notes_from: 'any'}, Q.owner));
  const work = 'H sells sandbox-exact a notary job';
  const sold = await offerOn(H, {payer: X, payee: H, price: 2, service: job('notary', work)});
  await untilOn(H, sold, ['agreed']);
  await deliverOn(H, sold, exactDelivery('notary', work));
  assert.equal((await untilOn(H, sold, ['note_issued', 'disputed'])).status, 'note_issued');
  const bought = await offerOn(Q, {payer: H, payee: Q, price: 2, service: job('notary', 'Q sells H a notary job')});
  await acceptOn(H, bought);
  await deliverOn(Q, bought, 'the work');
  const r = await payWithOn(H, bought, X);
  assert.deepEqual([r.status, r.transfer.state], ['paying_by_transfer', 'collecting']);
  const real = p.consentsFor(x).consents.find(c => c.id === r.transfer.id);
  assert.ok(real && real.edges.length === 2 && real.edges.every(e => e.slots.length && e.slots.every(s => e.signed_by_you.includes(s))), 'sandbox-exact signed its slots when the transfer was made');
  assert.equal(sb.itemsFor('sandbox-exact', x).some(([kind]) => kind === 'consent'), false, 'so the item is not listed as work');
  const clones = Array.from({length: 40}, (_, i) => ({...structuredClone(real), id: `vt_${String(i).padStart(16, '0')}`}));
  await stopLoop(sb);
  const consentsFor = p.consentsFor, itemsFor = sb.itemsFor, consent = sb.consent;
  let consentCalls = 0;
  sb.consent = async (...a) => { consentCalls++; return consent.apply(sb, a); };
  try {
    const S = await stranger('sbx-on-busy-seller');
    // (1) The core lists 41 such items for sandbox-exact: none is taken up, and the offer is answered in the next tick
    // (before the fix the first eight of them used up PER_TICK on every tick).
    p.consentsFor = q => (q.id === X.id ? {consents: [real, ...clones], recently_resolved: []} : consentsFor.call(p, q));
    const one = await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', 'offered while 41 signed consent items wait')});
    await sb.tick();
    assert.deepEqual([p.s.deals[one].status, consentCalls], ['agreed', 0], 'answered in the next tick; no consent item was taken up');
    delete p.consentsFor;
    // (2) Even when the loop lists them first: an action that finds nothing to do counts neither as a success (PER_TICK
    // 8) nor as an attempt (32).
    sb.itemsFor = (h, q) => [...(h === 'sandbox-exact' ? clones.map(c => ['consent', c, c.id]) : []), ...itemsFor.call(sb, h, q)];
    const two = await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', 'offered while 40 signed consent items are listed')});
    await sb.tick();
    assert.deepEqual([p.s.deals[two].status, consentCalls], ['agreed', 40], 'answered in the same tick, after 40 consent items with nothing to sign');
  } finally { delete p.consentsFor; delete sb.itemsFor; delete sb.consent; await sb.start(); }
  // Q refuses: the transfer ends, and nothing is left collecting.
  ok(await callOn('POST', `/consents/${r.transfer.id}/refuse`, {reason: 'test: not now'}, Q.agent));
  assert.equal(p.s.transfers[r.transfer.id].state, 'refused');
});

test('mode on: the tick\'s consent step: when the core could not sign the agents\' slots as a transfer was made, sandbox-exact (issuer) and sandbox-mallory (payee) sign them through POST /consents with the transfer as the operation, and the last signature applies it', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-fallback'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  // The welcome job: S earns 3 PC of sandbox-exact's notes.
  const w = await waitForCond(() => Object.values(p.s.deals).find(d => d.payer === X.id && d.payee === S.id), 'the welcome job');
  assert.equal((await acceptOn(S, w.id)).status, 'agreed');
  await deliverOn(S, w.id, exactDelivery('text-stats', WELCOME.text(S.handle)));
  assert.equal((await untilOn(S, w.id, ['note_issued', 'disputed'])).status, 'note_issued');
  // S buys notary from sandbox-mallory (a deal on which it is right) and pays with sandbox-exact's note, while the
  // server signer is away for that payment's own signing (serverSignatures signs nothing for it).
  const buy = await offerOn(S, {payer: S, payee: M, price: 2, service: job('notary', 'the agents sign this transfer at their next tick'), dealId: dealIdWhere(false)});
  await untilOn(S, buy, ['delivered']);
  const xm = await totalOf(X, M), serverSignatures = p.serverSignatures;
  p.serverSignatures = async function (tr, roles) { return tr.deal_id === buy ? {} : serverSignatures.call(this, tr, roles); };
  let r;
  try { r = await payWithOn(S, buy, X); } finally { delete p.serverSignatures; }
  assert.deepEqual([r.status, r.transfer.state], ['paying_by_transfer', 'collecting'], 'made without the agents\' signatures');
  assert.equal((await untilOn(S, buy, ['paid_by_transfer', 'payment_due'])).status, 'paid_by_transfer', 'the agents signed at their next tick');
  const tr = p.s.transfers[r.transfer.id];
  assert.deepEqual(['issuer_from', 'issuer_to', 'to_recipient_prior', 'to_recipient'].map(n => [tr.slots[n].by, tr.slots[n].server_signed === true]),
    [[X.id, false], [X.id, false], [M.id, false], [M.id, false]], 'signed by the agents through POST /consents, not just in time');
  assert.deepEqual([tr.state, await totalOf(X, S), await totalOf(X, M)], ['applied', 1, xm + 2]);
  // The server signer recorded each (edge, T) under the transfer's id: sandbox-exact on both edges, sandbox-mallory on X>M.
  for (const [who, R] of [[X, S], [X, M], [M, M]]) {
    const {debt_key_hex} = await basis.noteMessage({issuer: X.pubkey, recipient: R.pubkey, total: 0, timestamp: tr.timestamp});
    assert.equal(sb.records.signed[`${who.id}|${debt_key_hex}|${tr.timestamp}`]?.op, tr.id, `${who.handle} on sandbox-exact>${R.handle ?? 'S'}`);
  }
  for (const h of ['sandbox-exact', 'sandbox-mallory']) assert.ok(onLog.some(l => l.startsWith(`sandbox: ${h} signed its consent to ${tr.id}`)), h);
});

test('mode on: sandbox-mallory never asks a payee who refused its payment by transfer again: its next payment of that deal is its own note, once the refused attempt is dead (D-1)', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-refuser'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  // S earns 3 PC of sandbox-exact's notes (the welcome job) and pays sandbox-mallory 2 of them for a job.
  const w = await waitForCond(() => Object.values(p.s.deals).find(d => d.payer === X.id && d.payee === S.id), 'the welcome job');
  assert.equal((await acceptOn(S, w.id)).status, 'agreed');
  await deliverOn(S, w.id, exactDelivery('text-stats', WELCOME.text(S.handle)));
  assert.equal((await untilOn(S, w.id, ['note_issued', 'disputed'])).status, 'note_issued');
  const buy = await offerOn(S, {payer: S, payee: M, price: 2, service: job('notary', 'sandbox-mallory is paid with a note of sandbox-exact'), dealId: dealIdWhere(false)});
  await untilOn(S, buy, ['delivered']);
  assert.equal((await payWithOn(S, buy, X)).status, 'paid_by_transfer');
  // S sells sandbox-mallory a job. Its payment: sandbox-exact's note (it covers 2 PC, S accepts it and is present).
  const text = 'sandbox-mallory pays me, and I refuse its transfer.';
  const sold = await offerOn(S, {payer: M, payee: S, price: 2, service: job('notary', text)});
  await untilOn(S, sold, ['agreed']);
  await stopLoop(sb);
  try {
    await deliverOn(S, sold, exactDelivery('notary', text));
    await sb.tick();
    const d = p.s.deals[sold], [tr] = p.transfersOf(d);
    assert.deepEqual([d.status, p.transfersOf(d).length, tr.payer.id, tr.issuer.id, tr.state], ['paying_by_transfer', 1, M.id, X.id, 'collecting']);
    ok(await callOn('POST', `/consents/${tr.id}/refuse`, {reason: 'I would rather have a credit note'}, S.agent));
    assert.equal(d.status, 'payment_due');
    // The next tick makes no second payment by transfer (S refused one), and its own note waits while the refused
    // attempt could still apply at the tracker (D-1: until its T + 1 h + 60 s; the tick's backoff is at most 1 h).
    await sb.tick();
    assert.deepEqual([d.status, p.transfersOf(d).length], ['payment_due', 1], 'no second payment by transfer');
    const b = sb.backoff.get('sandbox-mallory')?.get(sold);
    assert.ok(b && b.until - sb.now() > 50 * 60e3, `its own note waits for the refused attempt's window (${JSON.stringify(b)})`);
    // Once that attempt is dead (its fallback_after passed: set here rather than waiting an hour), sandbox-mallory pays
    // with its own note, although it still holds sandbox-exact's notes and S is still present.
    const ms = await totalOf(M, S);
    tr.fallback_after = p.now() - 1; sb.backoff.get('sandbox-mallory').delete(sold);
    await sb.tick();
    assert.deepEqual([d.status, p.transfersOf(d).length, d.credit_note?.issuer_pubkey, d.credit_note?.note?.timestamp % 1000, await totalOf(M, S)], ['note_issued', 1, M.pubkey, 997, ms + 2]);
  } finally { await sb.start(); }
});

test('mode on: a bound-note template that is not ready (409 note_timestamp_ahead) is tried again after its retry_after_ms, not after the 10 s backoff', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-ahead'), X = agentOn('sandbox-exact');
  const text = 'the first credit-note template is not ready yet';
  const id = await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', text)});
  await untilOn(S, id, ['agreed']);
  await stopLoop(sb);
  const noteTemplate = p.noteTemplate;
  let calls = 0;
  p.noteTemplate = async function (q, dealId, o) {
    if (dealId === id && !calls++) throw new PilotError('note_timestamp_ahead', 'simulated: a timestamp ending in 997 ms comes in 2 s', 409, {retry_after_ms: 2000});
    return noteTemplate.call(this, q, dealId, o);
  };
  try {
    await deliverOn(S, id, exactDelivery('notary', text));
    await sb.tick();
    const b = sb.backoff.get('sandbox-exact')?.get(id);
    assert.ok(b && b.failures === 1 && b.until - sb.now() <= 2000, `backs off for retry_after_ms (${JSON.stringify(b)})`);
    assert.equal(p.s.deals[id].status, 'delivered');
    await sb.tick();
    assert.equal(calls, 1, 'not tried again before then');
    await sleep(Math.max(0, b.until - sb.now()) + 50);
    await sb.tick();
    assert.deepEqual([calls, p.s.deals[id].status], [2, 'note_issued']);
  } finally { delete p.noteTemplate; await sb.start(); }
});

test('mode on: poke() alone drives the agents: with the loop\'s interval at 10 minutes, a new sandbox participant gets its welcome job, an offer is answered and delivered, and the welcome delivery is checked and paid, each within seconds', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, X = agentOn('sandbox-exact'), interval = sb.intervalMs, ms = {};
  await stopLoop(sb);
  sb.intervalMs = 600e3;
  await sb.start();
  try {
    let t0 = Date.now();
    const S = await stranger('sbx-on-poke');
    await waitForCond(() => p.s.participants[S.id].sandbox_welcome, 'the welcome job', 15000);
    ms.welcome = Date.now() - t0;
    t0 = Date.now();
    const id = await offerOn(S, {payer: S, payee: X, price: 2, service: job('notary', 'a job poke() answers')});
    assert.equal((await untilOn(S, id, ['delivered', 'declined'], 15000)).status, 'delivered');
    ms.offer_to_delivery = Date.now() - t0;
    const w = p.s.participants[S.id].sandbox_welcome.deal_id;
    await acceptOn(S, w);
    t0 = Date.now();
    await deliverOn(S, w, exactDelivery('text-stats', WELCOME.text(S.handle)));
    assert.equal((await untilOn(S, w, ['note_issued', 'disputed'], 15000)).status, 'note_issued');
    ms.delivery_to_payment = Date.now() - t0;
    console.log(`poke() latencies with a 10-minute interval (ms): ${JSON.stringify(ms)}`);
  } finally { await stopLoop(sb); sb.intervalMs = interval; await sb.start(); }
});

// ---------- fix round after phase 1 (decisions D-1 and D-2) ----------
test('mode on: an agent\'s own note the tracker refused, followed on its pair by a recorded note for another deal from the same prior, is proven dead by Valun\'s journal (D-2 e): the agent pays the first deal, without an alarm', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-dead'), X = agentOn('sandbox-exact');
  const text1 = 'the first job: its credit notes are refused', text2 = 'the second job: paid at once';
  const d1 = await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', text1)});
  await untilOn(S, d1, ['agreed']);
  await stopLoop(sb);
  const api = basis.api;
  try {
    // Every note of sandbox-exact to S for 3 PC (deal 1) is refused by the tracker (nothing recorded): note_failed.
    basis.api = function (method, route, body) {
      if (method === 'POST' && route === '/notes' && body?.issuer_pubkey === X.pubkey && body?.recipient_pubkey === S.pubkey && body?.amount === 3)
        return Promise.resolve({status: 409, json: {success: false, error: 'simulated refusal', code: 'stale_prior'}, text: ''});
      return api.call(this, method, route, body);
    };
    await deliverOn(S, d1, exactDelivery('text-stats', text1));
    await sb.tick();
    assert.equal(p.s.deals[d1].status, 'note_failed');
    const attempts = sb.records.attempts[`${X.id}|${d1}`];
    assert.ok(attempts.length >= 1 && attempts.every(a => a.prior_total === 0), JSON.stringify(attempts));
    // Deal 2 (2 PC) is paid with a note on the same pair from the same prior (0), at a later timestamp.
    await sleep(2600);
    const d2 = await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', text2)});
    await sb.tick();
    await untilOn(S, d2, ['agreed']);
    await deliverOn(S, d2, exactDelivery('notary', text2));
    sb.backoff.get('sandbox-exact')?.set(d1, {failures: 1, until: Date.now() + 600e3});      // deal 1 waits meanwhile
    await sb.tick();
    assert.equal(p.s.deals[d2].status, 'note_issued');
    assert.equal(await totalOf(X, S), 2);
    // Deal 1 again: its earlier notes would read back as of unknown outcome (the pair is past them at another total), but
    // the journal proves them dead: paid now, from the new prior.
    sb.backoff.get('sandbox-exact')?.delete(d1);
    onLog.length = 0;
    await sb.tick();
    assert.equal(p.s.deals[d1].status, 'note_issued', JSON.stringify(onLog.filter(l => l.includes(d1))));
    assert.deepEqual([p.s.deals[d1].credit_note.prior_total, await totalOf(X, S)], [2, 5]);
    assert.ok(!onLog.some(l => /ALARM/.test(l) && l.includes(d1)), 'no alarm');
  } finally { basis.api = api; delete basis.api; await sb.start(); }
});

test('mode on: rule R1 for the server signer: the agents sign only note messages they rebuild from the deal and the participants; a template whose message hex differs from those (another edge, the same totals and timestamp) is refused (bad_template) and never signed', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-r1'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  const x = p.s.participants[X.id], m = p.s.participants[M.id], Z = (await basis.keygen()).pubkey_hex;
  const signed = [], signFor = sb.signFor;
  sb.signFor = async function (pid, hexMsg, o) { signed.push(hexMsg); return signFor.call(this, pid, hexMsg, o); };
  await stopLoop(sb);
  try {
    // sandbox-exact's own bound note: both messages of the template made for another recipient (same totals, timestamp).
    const t1 = 'R1: an own note';
    const d1 = await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', t1)});
    await sb.tick();
    await untilOn(S, d1, ['agreed']);
    await deliverOn(S, d1, exactDelivery('notary', t1));
    const real = await p.noteTemplate(x, d1, {bound: true});
    const forged = {...real, message_hex: await noteMsg(X.pubkey, Z, real.total, real.timestamp), prior_message_hex: await paMsg(X.pubkey, Z, real.prior_total, real.prior_timestamp, real.timestamp)};
    p.noteTemplate = async () => forged;
    try { await assert.rejects(sb.payOwnNote('sandbox-exact', x, p.s.deals[d1]), e => e.code === 'bad_template', 'refused'); } finally { delete p.noteTemplate; }
    assert.ok(!signed.includes(forged.message_hex) && !signed.includes(forged.prior_message_hex), 'the forged messages were never signed');
    assert.equal(p.s.deals[d1].status, 'delivered', 'nothing posted');
    // sandbox-mallory paying with a held note of sandbox-exact: the template's three messages for other edges.
    const t2 = 'R1: a held note';
    const d2 = await offerOn(S, {payer: M, payee: S, price: 2, service: job('notary', t2)});
    await sb.tick();
    await untilOn(S, d2, ['agreed']);
    await deliverOn(S, d2, exactDelivery('notary', t2));
    const d = p.s.deals[d2], terms = d.agreement.terms, T = Math.floor((Date.now() - 2000) / 1000) * 1000 - 1, X0 = 5, a = 2;
    const q = quoteDigest({network: terms.network, tracker_nft_id: terms.tracker_nft_id, denomination: terms.denomination, deal_id: d.id, terms_hash: d.agreement.terms_hash,
      deliverable_sha256: d.delivery.sha256, issuer_pubkey: X.pubkey, payer_pubkey: M.pubkey, payee_pubkey: S.pubkey, amount: a});
    const tpl = {deal_id: d.id, issuer: {id: X.id, pubkey: X.pubkey}, payer: {id: M.id, pubkey: M.pubkey}, payee: {id: S.id, pubkey: S.pubkey}, amount: a, timestamp: T, quote_digest: q,
      from_edge: {edge: `${X.pubkey}>${M.pubkey}`, before: {total: X0, timestamp: 1, signature: '02' + 'ab'.repeat(64)}, new_total: X0 - a}, to_edge: {edge: `${X.pubkey}>${S.pubkey}`, before: null, new_total: a},
      messages: {[`${X.pubkey}>${M.pubkey}:prior`]: await paMsg(X.pubkey, Z, X0, 1, T), [`${X.pubkey}>${M.pubkey}:new`]: await noteMsg(X.pubkey, Z, X0 - a, T), [`${X.pubkey}>${S.pubkey}:new`]: await noteMsg(Z, S.pubkey, a, T)}};
    p.paymentOptions = async () => ({held_notes: [{issuer: {id: X.id}, enough: true, payee_accepts: true, why_not: null, payee_consents: 'immediate'}]});
    p.transferTemplate = async () => tpl;
    try { await assert.rejects(sb.payByHeldNote('sandbox-mallory', m, d), e => e.code === 'bad_template', 'refused'); } finally { delete p.paymentOptions; delete p.transferTemplate; }
    assert.ok(!Object.values(tpl.messages).some(h => signed.includes(h)), 'the forged messages were never signed');
    assert.equal(p.s.deals[d2].status, 'delivered', 'nothing posted');
  } finally { delete sb.signFor; await sb.start(); }
});

test('mode on: sandbox-mallory pays a self-serve sandbox participant that owes sandbox-exact with its own note (the tour\'s step 4 and its 3-cycle, whatever notes M holds); otherwise, and for an invited payee, it tries a held note first', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, S = await stranger('sbx-on-own'), I = await invitedOn('sbx-on-own-inv'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  const m = p.s.participants[M.id], tried = [], held = sb.payByHeldNote, ledger = p.ledger;
  await stopLoop(sb);
  // An earlier test can leave a delivery sandbox-mallory has not paid yet (the loop pays it once that test restarts
  // it, which a fast run outpaces): one tick pays it first, so that only this test's deals reach the stub below.
  await sb.tick();
  sb.payByHeldNote = async function (handle, x, d) { tried.push(d.id); return null; };
  try {
    const sell = async (P, text) => {
      const id = await offerOn(P, {payer: M, payee: P, price: 2, service: job('notary', text)});
      await sb.tick();
      await untilOn(P, id, ['agreed']);
      await deliverOn(P, id, exactDelivery('notary', text));
      await sb.pay('sandbox-mallory', m, p.s.deals[id]);
      assert.equal(p.s.deals[id].status, 'note_issued', `${text}: paid with M's own note`);
      return id;
    };
    const plain = await sell(S, 'S owes no sandbox agent');
    assert.deepEqual(tried, [plain], 'S owes nothing: a held note is tried first');
    const owes = (who, to, outstanding) => async () => [...(await ledger.call(p)), {issuer: who.id, recipient: to.id, outstanding}];
    p.ledger = owes(S, M, 4);
    const owesM = await sell(S, 'S owes only sandbox-mallory');
    assert.deepEqual(tried, [plain, owesM], 'a debt to the payer itself changes nothing');
    p.ledger = owes(S, X, 1);
    await sell(S, 'S owes sandbox-exact (tour step 4)');
    assert.deepEqual(tried, [plain, owesM], 'S owes sandbox-exact: no held note is tried');
    p.ledger = owes(I, X, 1);
    const inv = await sell(I, 'an invited payee that owes sandbox-exact');
    assert.deepEqual(tried, [plain, owesM, inv], 'an invited payee: a held note is tried first');
  } finally { sb.payByHeldNote = held; p.ledger = ledger; await sb.start(); }
});

test('mode on: welcome jobs wait while sandbox-exact\'s room under its own max_issue_outstanding is below the welcome price (no attempt is spent on them), and at most WELCOME_PER_TICK are attempted in one tick', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, sb = on.sandbox, x = p.s.participants[on.sandbox.keys['sandbox-exact'].id];
  await stopLoop(sb);
  const welcome = sb.welcome, calls = [];
  try {
    const room = await sb.welcomeRoom(x), used = p.effectiveLimits(x).max_issue_outstanding - room;
    p.setAgentLimits(x, {max_issue_outstanding: used + WELCOME.price - 1}, {by: 'owner'});
    assert.equal(await sb.welcomeRoom(x), WELCOME.price - 1);
    const S = [];
    for (let i = 0; i < WELCOME_PER_TICK + 2; i++) S.push(await stranger(`sbx-on-room${i}`));
    const mine = new Set(S.map(q => q.id));
    sb.welcome = async function (handle, ax, q) { if (mine.has(q.id)) calls.push(q.id); return welcome.call(this, handle, ax, q); };
    await sb.tick();
    assert.deepEqual(calls, [], 'no welcome job attempted while the room is below its price');
    assert.ok(S.every(q => !p.s.participants[q.id].sandbox_welcome));
    assert.ok(S.every(q => !sb.backoff.get('sandbox-exact')?.has(`welcome:${q.id}`)), 'nor backing off: they simply wait');
    p.setAgentLimits(x, {max_issue_outstanding: null}, {by: 'owner'});
    await sb.tick();
    assert.ok(calls.length >= 1 && calls.length <= WELCOME_PER_TICK, `at most ${WELCOME_PER_TICK} in one tick: ${calls.length}`);
    for (let i = 0; i < 4 && !S.every(q => p.s.participants[q.id].sandbox_welcome); i++) await sb.tick();
    assert.ok(S.every(q => p.s.participants[q.id].sandbox_welcome), 'every one welcomed in the next ticks');
    assert.equal(calls.length, S.length, 'each once');
  } finally { delete sb.welcome; p.setAgentLimits(x, {max_issue_outstanding: null}, {by: 'owner'}); await sb.start(); }
});

test('mode on: the earn cap counts the stranger\'s claims on the sandbox agents on the tracker (18 PC paid, a 3 PC purchase declined, a 2 PC one bought) and live incoming transfers of the agents\' notes for a deal no agent pays', async t => {
  if (!onLive(t)) return;
  const S = await stranger('sbx-on-earned'), X = agentOn('sandbox-exact'), M = agentOn('sandbox-mallory');
  // 18 PC of the agents' notes, paid on the tracker: three jobs sold to each agent, delivered exactly and paid.
  for (const A of [X, M]) for (let i = 0; i < 3; i++) {
    const text = `paid job ${i} for ${A.handle}`, id = await offerOn(S, {payer: A, payee: S, price: 3, service: job('text-stats', text)});
    await untilOn(S, id, ['agreed']);
    await deliverOn(S, id, exactDelivery('text-stats', text));
    assert.ok(['note_issued', 'paid_by_transfer'].includes((await untilOn(S, id, ['note_issued', 'paid_by_transfer', 'disputed'], 45000)).status), `${A.handle} ${i}: paid`);
  }
  const ledger = await on.pilot.ledger(), ids = new Set([X.id, M.id]);
  assert.equal(ledger.filter(l => l.recipient === S.id && ids.has(l.issuer)).reduce((s, l) => s + l.outstanding, 0), 18, 'on the tracker');
  assert.equal(await on.sandbox.strangerClaims(S.id), 18, 'nothing agreed and unpaid: all of it is on the tracker');
  const clock = on.sandbox.now;
  on.sandbox.now = () => Date.now() + 25 * H;                            // a day later for the per-stranger purchase limit
  try {
    await declinedOn(S, X, await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', 'this would make 21')}),
      /your claims on the sandbox agents \(18 PC[\s\S]*plus 3 PC would be above the sandbox limit of 20 PC/);
    await untilOn(S, await offerOn(S, {payer: X, payee: S, price: 2, service: job('notary', 'this makes exactly 20')}), ['agreed']);
  } finally { on.sandbox.now = clock; }
  // A live incoming transfer: H (invited) holds a note of sandbox-exact and pays Q (invited, a stranger) with it; Q's
  // client has not signed yet. No agent pays that deal: it counts toward Q's claims on the agents.
  const Hd = await invitedOn('sbx-on-earn-h'), Q = await invitedOn('sbx-on-earn-q');
  ok(await callOn('PUT', '/owner/mandate', {accept_transfers: true, accept_notes_from: 'any'}, Q.owner));
  const sold = await offerOn(Hd, {payer: X, payee: Hd, price: 2, service: job('notary', 'H sells sandbox-exact a job')});
  await untilOn(Hd, sold, ['agreed']);
  await deliverOn(Hd, sold, exactDelivery('notary', 'H sells sandbox-exact a job'));
  assert.equal((await untilOn(Hd, sold, ['note_issued', 'disputed'])).status, 'note_issued');
  const bought = await offerOn(Q, {payer: Hd, payee: Q, price: 2, service: job('notary', 'Q sells H a job')});
  await acceptOn(Hd, bought);
  await deliverOn(Q, bought, 'the work Q did for H');
  const r = await payWithOn(Hd, bought, X);
  assert.deepEqual([r.status, r.transfer.state], ['paying_by_transfer', 'collecting']);
  assert.equal(await on.sandbox.strangerClaims(Q.id), 2, 'the collecting transfer of sandbox-exact\'s note to Q counts');
  ok(await callOn('POST', `/consents/${r.transfer.id}/refuse`, {reason: 'test'}, Q.agent));
  assert.equal(await on.sandbox.strangerClaims(Q.id), 0, 'and no longer once it has ended');
});

test('mode sandbox: the agents buy only from sandbox participants; an invited participant offering to sell is declined, told so', async t => {
  if (!onLive(t)) return;
  const p = on.pilot, X = agentOn('sandbox-exact');
  const I = await invitedOn('sbx-on-invited-seller'), S = await stranger('sbx-on-mode-sandbox');
  p.circulation = 'sandbox';
  try {
    assert.equal(p.mode, 'sandbox');
    await declinedOn(I, X, await offerOn(I, {payer: X, payee: I, price: 3, service: job('text-stats', 'an invited seller in mode sandbox')}),
      /^Circulating credit is on for sandbox participants only, so I buy only from them \(participants who joined with join-sandbox\), not from you; you can still buy from me\. text-stats \(3 PC\)/);
    await untilOn(S, await offerOn(S, {payer: X, payee: S, price: 3, service: job('text-stats', 'a sandbox seller in mode sandbox')}), ['agreed']);
  } finally { p.circulation = 'on'; }
  assert.equal(p.mode, 'on');
});
