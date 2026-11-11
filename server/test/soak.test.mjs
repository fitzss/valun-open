// Soak / property test: a seeded random workload of many participants acting concurrently over real HTTP, against a
// throwaway REAL Basis tracker (port 3092). Valid and deliberately invalid actions are mixed. Not part of `npm test`
// (it takes minutes; scripts/run-tests.mjs leaves it out).
//
// Environment:
//   SOAK_SEED         the seed of the workload's random choices (default 20261107). Eight actions run at a time, so the
//                     timing of the server and the tracker also shapes a run: a seed fixes the mix of actions and their
//                     parameters, not the exact interleaving.
//   SOAK_ACTIONS      how many random actions the participants take (default 400; 600 with SOAK_CIRCULATION=1).
//   SOAK_PEOPLE       how many invited participants the workload creates (default 12; at least 8 with SOAK_CIRCULATION=1).
//   SOAK_CIRCULATION  1: the circulation mode below; anything else (the default): circulation off, as before.
//   VALUN_BINS        the tracker binaries (test/tracker-harness.mjs; also VALUN_TRACKER_BIN, VALUN_SIGNER, BASIS_RUNNER).
//                     Circulation mode needs tracker v3.2 (its capabilities must validate and its basis_server sha256 must
//                     be pinned in lib/pilot/pins.mjs) and fails otherwise; circulation off runs on any tracker.
//
// Circulation off (the default): a Pilot in mode off; offers, counters, acceptances, deliveries, disputes, credit notes
// and owner decisions. At the end, invariants that must hold whatever happened, against the server state AND the tracker:
//   I1 no 5xx response, ever (refusals are 4xx)
//   I2 every tracker total for a (payer, payee) pair equals the sum of the credit notes Valun issued for that pair
//   I3 nobody owes (tracker) more than its owner's max_issue_outstanding
//   I4 every agreement: proposer and acceptor differ, both are the deal's parties, the acceptor signed the agreed terms
//   I5 every issued note: price within the payer's max_issue_per_deal and the payee's max_accept_per_deal
//
// SOAK_CIRCULATION=1 (tracker v3.2): a Pilot in mode on, with the sandbox agents (lib/pilot/sandbox.mjs; a tick every
// 250 ms, the server signs for them) and the clearing engine (lib/pilot/clearing.mjs; a batch every 3 s) started as
// server.mjs starts them. Most participants are simulated 0.4 clients (bound notes, X-Valun-Features consent roles, the
// client's checks before it signs, a record of what it signed per (edge, timestamp)); every fourth is a 0.3 client
// (ordinary notes only, no consents). A warm-up first: each participant buys one job from two others and pays it with
// its own note (so notes are held, and short cycles exist), then the clients poll their consents once; then a few cases
// made on purpose, so that every run has them: two payments by transfer left of unknown outcome (a crash after, and
// before, the tracker call), which their payers then try to pay again; a refused attempt; a key revocation while a
// payment by transfer collects; a payment by transfer over the payee's per-issuer cap; an offer over the payer's
// max_issue_outstanding; a credit note held for its owner.
// Then, besides the actions above:
//   - payment by transfer with a random held note (payment options, the template, the payer's checks, its three slots);
//     a payer whose payment options allow nothing now waits (decision D-1), and now and then tries anyway;
//   - consent processing for a random subset of the 0.4 clients (the issuer's and payee's clients, when present, also
//     right after a payment by transfer is posted): each transfer and set-off item is checked as a client checks it
//     (its owner's policy included), then signed (and followed: GET /transfers, /setoffs), or refused;
//   - payers cancelling transfers that still collect; deals with the sandbox agents (exactly checkable jobs, bought
//     and sold); held notes and held payments (review_deliveries, decision D-2 c); refused payment attempts that the
//     server records (stale priors, decision D-2 b); a key rotation (revoke, enroll a new key; a party of a novation
//     still collecting when there is one); two participants with caps they reach; engine runs (POST
//     /admin/clearing/run); recovery (Pilot.recover, as server.mjs runs it every 60 s);
//   - clock jumps past the transfer collection TTL (20 min), the set-off TTL (30 min) and the D-1 fallback windows
//     (T + 1 h + 60 s): the sandbox and the engine are paused, the participants and owners read (reads sweep), recovery
//     and the engine's housekeeping run, then the clock returns (the tracker keeps the real clock, so nothing is signed
//     at the jumped time);
//   - faults on the tracker's transfer and set-off calls (a crash before or after the call, an unreachable tracker),
//     and a faulty read-back during recovery that leaves a transfer outcome_unknown; its payer's owner resolves it
//     (decision D-2 d) as the tracker shows it, as an owner does after asking the payee.
// After every action and every event these are checked inside the server's lock (no tracker write is in flight), against
// the tracker and the server state:
//   I1  no 5xx response, except the 502 of a request during which the soak injected a crash
//   I2' on every edge Valun touched, the tracker's total equals the journal's expected_total and its note is the state
//       the journal's last entry left; no tracker edge was written around Valun; no novation is inconsistent. Edges of
//       a transfer or set-off being applied or of unknown outcome, and of a note being issued, wait until decided; at
//       the end (after recovery and the owners' resolutions) every edge is checked, and the journal file too
//   I3  nobody owes (tracker) more than its owner's max_issue_outstanding, as today
//   I6  every set-off the tracker applied left every participant's net unchanged (the tracker read before and after
//       the call) and every applied set-off record balances for each member; every transfer the tracker applied moved
//       exactly its amount from the payer's claim to the payee's, its issuer's debt unchanged
//   I7  no transfer or set-off signature appears in any HTTP response body, to anyone (its own signer and owner included),
//       before the tracker applied a request carrying it (each response is scanned as it is sent)
//   I8  the nets of all participants (Pilot.position over one ledger) sum to 0, and every tracker note is between
//       registered keys
//   I9  no transfer or set-off the tracker applied had an edge under a key that was not its participant's current key
//       when it was sent, and no collecting novation names a key that is no longer current
//   I10 per-issuer caps hold: for each payee and issuer, the payee's claim on the tracker + committed deals + transfers
//       being collected or applied <= the payee's max_accept_per_issuer
//   I11 at most one payment applied per deal (its credit note recorded or one transfer applied), and a paid deal's
//       status says which; at the end also from the edge journal file
//   R   the server never asks a 0.4 client to sign what its signing firewall must refuse: every EdgeState carries its
//       issuer's signature, residues 997/998/999, set-offs are net-neutral decreases of the client's own edges, a
//       transfer moves the deal's price, no two set-offs share an (edge, timestamp), and no item made after the owner's
//       last mandate change goes against it (auto_clear, novate_own_debt, accept_transfers)
// The run must also exercise what it checks (asserted at the end): transfers and set-offs the tracker applied, consents
// signed, owners' resolutions both ways, refused attempts recorded, held notes, clock jumps, engine runs, and novation
// signatures the I7 scan saw where they may be shown (so it can see a leak). I4 and I5 are checked at the end as with
// circulation off.
// Run: MSYS2_ENV_CONV_EXCL=VALUN_ SOAK_CIRCULATION=1 VALUN_BINS=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release node --test test/soak.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {Basis, BasisError, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {quoteDigest} from '../lib/pilot/novation.mjs';
import {edgeKey, EDGE_LOG_FILE} from '../lib/pilot/journal.mjs';
import {statusClass} from '../lib/pilot/status.mjs';
import {Clearing} from '../lib/pilot/clearing.mjs';
import {Sandbox, SERVICES, COMPUTE, render, corrupt, extractText, whichService, checkDelivery} from '../lib/pilot/sandbox.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath, capabilities, trackerSha256} from './tracker-harness.mjs';

const CIRCULATION = process.env.SOAK_CIRCULATION === '1';
const SEED = Number(process.env.SOAK_SEED || 20261107), ACTIONS = Number(process.env.SOAK_ACTIONS || (CIRCULATION ? 600 : 400)), PEOPLE = Number(process.env.SOAK_PEOPLE || 12);
let tracker, server, base, basis, pilot, storeDir;
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let rng = (a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(SEED);
const pick = xs => xs[Math.floor(rng() * xs.length)], int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const statuses = new Map(), fivexx = [];

async function startOff() {
  tracker = await startTracker(3092, {servedTokenId: PILOT_TOKEN_ID});
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-soak-'));
  pilot = new Pilot({store: new PilotStore(storeDir), basis});
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6, pilotIpReadLimitPerMinute: 1e6}, adminTokenHash: sha('admin-secret')});
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stopOff() {
  server?.close(); await tracker?.stop();
  if (storeDir) fs.rmSync(storeDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
before(() => (CIRCULATION ? startCirculation() : startOff()));
after(() => (CIRCULATION ? stopCirculation() : stopOff()));

async function call(method, p, body, token, what = method + ' ' + p.split('/').slice(0, 2).join('/')) {
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}, body: body && JSON.stringify(body)});
  const out = {status: r.status, body: await r.json().catch(() => null)};
  const k = `${what} -> ${r.status}${out.body?.error ? ' ' + out.body.error : ''}`;
  statuses.set(k, (statuses.get(k) || 0) + 1);
  if (r.status >= 500) fivexx.push({what, status: r.status, body: out.body});
  return out;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);

async function participant(i) {
  const handle = `soak-${i}`;
  const inv = (await call('POST', '/admin/invites', {note: handle}, null)).body;   // admin needs the header: use the pilot directly
  void inv;
  const invite = pilot.createInvite({note: handle, maxUses: 1, ttlDays: 1});
  const j = (await call('POST', '/join', {invite: invite.code, handle, operator: `soak operator ${i}`})).body;
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = (await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop})).body;
  const P = {i, id: j.participant_id, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  // Varied owners: tight and loose caps; some hold commitments above a threshold for the owner.
  const m = {max_issue_per_deal: pick([10, 20, 40]), max_issue_outstanding: pick([30, 60, 120]), max_accept_per_deal: pick([15, 30, 40]),
    max_accept_per_issuer: pick([40, 80]), approve_above: pick([1000, 1000, 15, 0]), min_price_as_payee: pick([0, 0, 5])};
  await call('PUT', '/owner/mandate', m, P.owner);
  P.mandate = m;
  return P;
}

function terms(P, Q, payerIsP, price) {
  const now = Date.now(), payer = payerIsP ? P : Q, payee = payerIsP ? Q : P;
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + crypto.randomBytes(8).toString('hex'), version: 1, prior_terms_hash: null, nonce: crypto.randomBytes(16).toString('hex'),
    proposer: P.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Soak job', description: `Soak test job ${int(1, 1e9)}`, deliverable: 'any text'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(now + 48 * 3600e3).toISOString(), offer_expires_at: new Date(now + 24 * 3600e3).toISOString()};
}

// One random action by one participant. Roughly 1 in 6 is deliberately wrong (stale hash, wrong party, bad signature).
async function act(people) {
  const P = pick(people), bad = rng() < 0.17, deals = Object.values(pilot.s.deals);
  // Like a real agent: mostly act on what is waiting in its own inbox, so deals move through their whole life.
  const box = pilot.inbox(pilot.s.participants[P.id]);
  const waiting = [...box.respond.map(i => ['respond', i]), ...box.deliver.map(i => ['deliver', i]), ...box.review_delivery.map(i => ['review', i])];
  const r = rng();
  let kind, d;
  if (r < 0.62 && waiting.length) { const [k, item] = pick(waiting); kind = k; d = pilot.s.deals[item.deal_id]; }
  else if (r < 0.74) kind = 'owner';
  else if (r < 0.77) kind = 'limits';
  else kind = 'propose';
  if (!d) { const mine = deals.filter(x => x.payer === P.id || x.payee === P.id); d = mine.length ? pick(mine) : null; }
  if (kind === 'propose' || !d) {
    const Q = pick(people.filter(x => x !== P)), t = terms(P, Q, rng() < 0.6, int(1, 50)), h = termsHash(t);
    return call('POST', '/deals', {terms: t, terms_hash: bad ? sha('x') : h, signature: await sign(bad ? Q : P, statements.propose(h))}, P.agent, 'propose');
  }
  const cur = d.versions?.at(-1), h = d.agreement?.terms_hash ?? cur?.terms_hash;
  if (kind === 'respond' && d.status === 'open') {
    const choice = pick(['accept', 'accept', 'decline', 'withdraw', 'counter']);
    if (choice === 'accept') return call('POST', `/deals/${d.id}/accept`, {terms_hash: bad ? sha('y') : h, signature: await sign(P, statements.accept(h))}, P.agent, 'accept');
    if (choice === 'decline') { const reason = pick(['too expensive', 'not now\n', 'no thanks']);
      return call('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: await sign(P, statements.decline(h, reason))}, P.agent, 'decline'); }
    if (choice === 'withdraw') return call('POST', `/deals/${d.id}/withdraw`, {terms_hash: h, signature: await sign(P, statements.withdraw(h))}, P.agent, 'withdraw');
    const t = {...cur.terms, version: cur.v + 1, prior_terms_hash: cur.terms_hash, proposer: P.id, nonce: crypto.randomBytes(16).toString('hex'),
      price: {amount: int(1, 50), unit: 'PC'}, offer_expires_at: new Date(Date.now() + 24 * 3600e3).toISOString()};
    const th = termsHash(t);
    return call('POST', `/deals/${d.id}/counter`, {terms: t, terms_hash: th, signature: await sign(P, statements.propose(th))}, P.agent, 'counter');
  }
  if (kind === 'deliver' && d.status === 'agreed') {
    const content = `delivery ${int(1, 1e9)}`, dh = sha(content);
    return call('POST', `/deals/${d.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(bad ? pick(people) : P, statements.deliver(h, dh))}, P.agent, 'deliver');
  }
  if (kind === 'review' && ['delivered', 'note_failed'].includes(d.status)) {
    if (rng() < 0.25) { const reason = 'not what was agreed';
      return call('POST', `/deals/${d.id}/dispute`, {terms_hash: h, deliverable_sha256: d.delivery.sha256, reason, signature: await sign(P, statements.dispute(h, d.delivery.sha256, reason))}, P.agent, 'dispute'); }
    const tpl = await call('GET', `/deals/${d.id}/credit-note-template`, null, P.agent, 'template');
    if (tpl.status !== 200) return tpl;
    const tp = tpl.body, total = tp.total + (bad ? 1 : 0);
    const {message_hex} = await basis.noteMessage({issuer: tp.issuer_pubkey, recipient: tp.recipient_pubkey, total, timestamp: tp.timestamp});
    return call('POST', `/deals/${d.id}/complete`, {terms_hash: tp.terms_hash, deliverable_sha256: tp.deliverable_sha256,
      signature: await sign(P, statements.complete(tp.terms_hash, tp.deliverable_sha256)), credit_note: {total, timestamp: tp.timestamp, signature: await basis.signHex(P.pubkey, message_hex, P.secret)}}, P.agent, 'complete');
  }
  if (kind === 'owner') {
    const o = await call('GET', '/owner', null, P.owner, 'owner view');
    const ap = (o.body?.approvals || []).filter(a => a.state === 'pending');
    if (ap.length) return call('POST', `/owner/approvals/${pick(ap).id}`, {decision: rng() < 0.8 ? 'approve' : 'reject'}, P.owner, 'owner decision');
  }
  if (kind === 'limits') return call('PUT', '/limits', {max_issue_per_deal: int(0, 60)}, P.agent, 'limits');   // above the mandate is refused
  return call('GET', `/deals/${d.id}`, null, P.agent, 'read deal');
}

if (!CIRCULATION) test(`soak: ${ACTIONS} random actions by ${PEOPLE} participants (seed ${SEED}); all invariants hold`, {timeout: 30 * 60e3}, async () => {
  const people = [];
  for (let i = 0; i < PEOPLE; i++) people.push(await participant(i));
  for (let done = 0; done < ACTIONS; done += 8) await Promise.all(Array.from({length: Math.min(8, ACTIONS - done)}, () => act(people).catch(e => fivexx.push({what: 'client', error: e.message}))));

  const deals = Object.values(pilot.s.deals), byStatus = {};
  for (const d of deals) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  console.log('deals by status:', JSON.stringify(byStatus));
  console.log('responses:', JSON.stringify([...statuses].sort((a, b) => b[1] - a[1]).slice(0, 25)));

  assert.deepEqual(fivexx, [], 'I1: no 5xx');
  const issued = deals.filter(d => d.status === 'note_issued');
  assert.ok(issued.length > 0, 'the workload must issue some notes for the invariants to mean anything');
  const pairs = new Map();
  for (const d of issued) { const k = `${d.payer}|${d.payee}`; pairs.set(k, (pairs.get(k) || 0) + d.agreement.terms.price.amount); }
  for (const [k, sum] of pairs) {
    const [payer, payee] = k.split('|'), P = pilot.s.participants[payer], Q = pilot.s.participants[payee];
    const note = await basis.note(P.pubkey, Q.pubkey);
    assert.equal(Number(note?.amount_collected ?? 0), sum, `I2: tracker total for ${P.handle} -> ${Q.handle}`);
  }
  for (const P of people) {
    const owed = [...pairs].filter(([k]) => k.startsWith(P.id + '|')).reduce((a, [, v]) => a + v, 0);
    assert.ok(owed <= P.mandate.max_issue_outstanding, `I3: ${P.id} owes ${owed} > ${P.mandate.max_issue_outstanding}`);
  }
  for (const d of deals.filter(x => x.agreement)) {
    const a = d.agreement;
    assert.notEqual(a.proposer, a.acceptor, `I4: ${d.id} proposer = acceptor`);
    assert.ok([d.payer, d.payee].includes(a.acceptor) && [d.payer, d.payee].includes(a.proposer), `I4: ${d.id} parties`);
    const acc = pilot.s.participants[a.acceptor];
    const keys = [acc.pubkey, ...(acc.past_pubkeys || []).map(k => k.pubkey)];
    let okSig = false;
    for (const k of keys) if (await basis.verify(k, hex(statements.accept(a.terms_hash)), a.acceptor_signature)) okSig = true;
    assert.ok(okSig, `I4: ${d.id} acceptor signature over the agreed terms`);
  }
  for (const d of issued) {
    const price = d.agreement.terms.price.amount, P = people.find(x => x.id === d.payer), Q = people.find(x => x.id === d.payee);
    assert.ok(price <= P.mandate.max_issue_per_deal, `I5: ${d.id} price ${price} > payer cap ${P.mandate.max_issue_per_deal}`);
    assert.ok(price <= Q.mandate.max_accept_per_deal, `I5: ${d.id} price ${price} > payee cap ${Q.mandate.max_accept_per_deal}`);
  }
});

// =================================================================================================================
// SOAK_CIRCULATION=1: circulating credit on (tracker v3.2)
// =================================================================================================================
const MIN = 60e3, BATCH = 8;
const CIRC_ADMIN = 'soak-circulation-admin', ADM = {'x-valun-admin': CIRC_ADMIN};
const SANDBOX_TICK_MS = 250, CLEARING_INTERVAL_MS = 3000;
// How far a clock jump moves the server's clock: past the transfer collection TTL (20 min), the set-off TTL (30 min) and
// the D-1 fallback window after an attempt (T + 1 h + 60 s).
const JUMP = Object.freeze({transfer_ttl: 21 * MIN, setoff_ttl: 31 * MIN, fallback: 62 * MIN});
// Faults on the tracker's novation calls, per call: [kind, probability].
const FAULTS = Object.freeze({transfer: [['before', 0.05], ['after', 0.04], ['unreachable', 0.03]], setoff: [['before', 0.03], ['after', 0.03], ['unreachable', 0.02]]});
const LIVE = new Set(['awaiting_owner', 'collecting', 'applying']), UNDECIDED_TRANSFER = new Set(['applying', 'outcome_unknown', 'inconsistent']);
const SIG_G = /0[23][0-9a-f]{128}/g;
const REFUSALS = ['not now', 'my owner does not want this note', 'too much exposure to that issuer'];
// Prices between the soak's participants: mostly small, so the notes they hold often cover a later deal (a transfer moves
// exactly the price).
const PRICES = Object.freeze([1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 8, 12]);
let clockOffset = 0, sandbox = null, clearing = null;
const cnow = () => Date.now() + clockOffset;
const als = new AsyncLocalStorage();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The run's own records.
const K = {
  people: [], byId: new Map(), agents: null, tokens: new Map(),   // soak participants; bearer token -> participant id
  produced: new Map(),        // every transfer or set-off slot signature made (by the clients here or the server signer): hex -> {by, what}
  applied: new Set(),         // the signatures carried by a novation request the tracker applied (when it applied it)
  truth: new Map(),           // transfer id -> 'applied' | 'not_applied': what the tracker shows for an attempt left outcome_unknown
  forced: [], forcedHits: [], readFault: null, faultsOn: true, crashes: 0, usedPayers: new Set(),   // forced: faults queued for the next soak payers' transfers
  violations: [], expected5xx: 0, responses: 0, sigsSeen: 0, checks: 0, stats: new Map(), pilotLog: [], sandboxLog: [], debtKeys: new Map(), verified: new Set(), orig: null,
};
const bump = (k, n = 1) => K.stats.set(k, (K.stats.get(k) || 0) + n);
const count = k => K.stats.get(k) || 0;
const short = s => String(s).replace(/0[23][0-9a-f]{64}/g, k => k.slice(0, 10)).replace(/0[23][0-9a-f]{128}/g, k => k.slice(0, 12) + '...');
const violation = (inv, what) => { K.violations.push(`${inv}: ${short(what)}`); };
const label = (what, r) => `${what}: ${r.status}${r.body?.error ? ' ' + r.body.error : ''}`;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 400)); return r.body; };
const noteKey = n => edgeKey(n.issuer_pubkey, n.recipient_pubkey);
const outstanding = n => Number(n.amount_collected) - Number(n.amount_redeemed ?? 0);
const randomSig = () => '02' + crypto.randomBytes(64).toString('hex');

// ---------- the server, observed ----------
// Every response is seen as it is sent (res.end), with whose token asked: I1 (a 5xx only from a request during which the
// soak injected a crash: 502 internal error) and I7 (no transfer or set-off signature in any response, not even to its
// signer, until the tracker applied a request carrying it).
function observed(handler) {
  return (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const ctx = {crashed: false, crashesAtStart: K.crashes, viewer: m ? K.tokens.get(m[1]) ?? null : null, what: `${req.method} ${req.url.split('?')[0]}`};
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => { try { seen(ctx, res.statusCode, chunk); } catch (e) { violation('soak', `the response observer failed: ${e.message}`); } return end(chunk, ...rest); };
    return als.run(ctx, () => handler(req, res));
  };
}
function seen(ctx, status, chunk) {
  K.responses++;
  const text = chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (status >= 500) {
    if ((ctx.crashed || K.crashes > ctx.crashesAtStart) && status === 502 && /"error": "internal error"/.test(text)) K.expected5xx++;
    else violation('I1', `${ctx.what} answered ${status}: ${text.slice(0, 200)}`);
  }
  for (const [s] of text.matchAll(SIG_G)) {
    const p = K.produced.get(s);
    if (!p) continue;
    K.sigsSeen++;
    if (K.applied.has(s)) continue;
    const to = ctx.viewer === p.by ? `its own signer (${p.by})` : ctx.viewer ?? 'an unauthenticated caller';
    violation('I7', `${ctx.what} (${status}) showed ${p.what} signed by ${p.by} (${s}) to ${to} before the tracker applied it`);
  }
}
// Soak-internal calls (recovery, the read-back fault) run in a context of their own, so a crash they meet is known.
async function internal(fn) {
  const ctx = {crashed: false, crashesAtStart: K.crashes, viewer: null, what: 'internal'};
  try { return {ctx, value: await als.run(ctx, fn)}; } catch (error) { return {ctx, error}; }
}

// ---------- the tracker's novation calls, observed (and faults injected) ----------
const pilotNotes = async () => (await K.orig.allNotes()).filter(n => n?.denomination === PILOT_DENOMINATION);
function instrument(b) {
  K.orig = {transfer: b.transfer.bind(b), setoff: b.setoff.bind(b), note: b.note.bind(b), allNotes: b.allNotes.bind(b)};
  b.transfer = body => novationCall('transfer', body);
  b.setoff = body => novationCall('setoff', body);
  // The read-back fault (unknownOutcome): the next reads of one edge return a state at the attempt's timestamp that is
  // neither its prior nor its new one, as a write around Valun would leave it.
  b.note = (i, r) => { const f = K.readFault; if (f && f.issuer === i && f.recipient === r) { f.used++; return Promise.resolve(f.note); } return K.orig.note(i, r); };
}
function changedEdges(before, after) {
  const b = new Map(before.map(n => [noteKey(n), n])), out = [];
  for (const n of after) { const o = b.get(noteKey(n)); if (!o || Number(o.amount_collected) !== Number(n.amount_collected) || o.timestamp !== n.timestamp || o.signature !== n.signature) out.push(noteKey(n)); }
  return out;
}
// Each participant's net position (claims - debts over every key it has had) from tracker notes.
function netsOf(notes) {
  const m = new Map(), add = (k, v) => { const id = pilot.byPubkey(k)?.id ?? `unregistered key ${k.slice(0, 10)}`; m.set(id, (m.get(id) ?? 0) + v); };
  for (const n of notes) { add(n.recipient_pubkey, outstanding(n)); add(n.issuer_pubkey, -outstanding(n)); }
  return m;
}
const bodySignatures = (kind, body) => (kind === 'transfer' ? Object.entries(body).filter(([k]) => k.endsWith('_signature')).map(([, v]) => v)
  : body.edges.flatMap(e => [e.issuer_signature, e.recipient_signature]));
async function novationCall(kind, body) {
  const ctx = als.getStore();
  let fault = null;
  if (K.faultsOn) {
    // A forced fault (scheduled) takes the next transfer whose payer is a soak participant (its owner can resolve it).
    if (kind === 'transfer' && K.forced.length && K.byId.has(pilot.byPubkey(body.from_recipient_pubkey)?.id)) {
      fault = K.forced.shift();
      K.forcedHits.push({fault, issuer: body.issuer_pubkey, payer: body.from_recipient_pubkey, timestamp: body.timestamp, done: false});
    } else { let x = rng(); for (const [f, p] of FAULTS[kind]) { if (x < p) { fault = f; break; } x -= p; } }
  }
  if (fault) bump(`fault: ${kind} ${fault}`);
  if (fault === 'unreachable') throw new BasisError('tracker unreachable: ECONNREFUSED (soak fault injection)');
  if (fault === 'before') { K.crashes++; if (ctx) ctx.crashed = true; throw new Error(`simulated crash before the tracker's ${kind} call (soak fault injection)`); }
  const keys = kind === 'transfer' ? [body.issuer_pubkey, body.from_recipient_pubkey, body.to_recipient_pubkey] : body.edges.flatMap(e => [e.issuer_pubkey, e.recipient_pubkey]);
  const notCurrent = [...new Set(keys)].filter(k => { const q = pilot.byPubkey(k); return !q || q.pubkey !== k || q.status !== 'active'; });
  const before = await pilotNotes();
  const r = await K.orig[kind](body);
  const after = await pilotNotes(), changed = changedEdges(before, after);
  if (changed.length) {
    bump(`tracker applied: ${kind}`);
    for (const s of bodySignatures(kind, body)) K.applied.add(s);
    if (notCurrent.length) violation('I9', `the tracker applied a ${kind} with an edge under a key that was not its participant's current key when it was sent: ${notCurrent.join(', ')}`);
    if (kind === 'setoff') {
      const nb = netsOf(before), na = netsOf(after);
      for (const id of new Set([...nb.keys(), ...na.keys()])) if ((nb.get(id) ?? 0) !== (na.get(id) ?? 0))
        violation('I6', `a set-off the tracker applied changed ${id}'s net from ${nb.get(id) ?? 0} to ${na.get(id) ?? 0}`);
    } else {
      const A = body.issuer_pubkey, B = body.from_recipient_pubkey, C = body.to_recipient_pubkey, a = body.amount, ab = edgeKey(A, B), ac = edgeKey(A, C);
      const tot = (notes, k) => Number(notes.find(n => noteKey(n) === k)?.amount_collected ?? 0);
      const owed = notes => notes.filter(n => n.issuer_pubkey === A).reduce((x, n) => x + outstanding(n), 0);
      if (!changed.every(k => k === ab || k === ac) || tot(after, ab) !== tot(before, ab) - a || tot(after, ac) !== tot(before, ac) + a || owed(after) !== owed(before))
        violation('I6', `a transfer the tracker applied did not move exactly ${a} from ${B}'s claim on ${A} to ${C}'s (changed edges ${changed.join(', ')})`);
    }
  }
  if (fault === 'after') { K.crashes++; if (ctx) ctx.crashed = true; throw new Error(`simulated crash after the tracker's ${kind} call (soak fault injection)`); }
  return r;
}
// The server signer's signatures (the sandbox agents'): those of transfer (999) and set-off (998) slots are kept for I7.
// The operation's timestamp is bytes 40-47 of a note message M, and bytes 65-72 of a 105-byte prior acknowledgment PA.
function watchSigner(sb) {
  const signFor = sb.signFor.bind(sb);
  sb.signFor = async (pid, msgHex, o) => {
    const at = msgHex.length === 210 ? msgHex.slice(130, 146) : msgHex.slice(80, 96);
    const s = await signFor(pid, msgHex, o), residue = Number(BigInt('0x' + at) % 1000n);
    if (residue === 998 || residue === 999) K.produced.set(s, {by: pid, what: residue === 999 ? 'a transfer slot' : 'a set-off slot'});
    return s;
  };
}

// ---------- the clients' signing ----------
// M(I,R,t,ts): the 80-byte Basis note message (debt key || total BE8 || timestamp BE8 || tracker NFT id); the debt key of
// an edge comes from the signer once, then messages are built here (startCirculation checks both ways agree).
async function msgHex(I, R, total, ts) {
  const k = edgeKey(I, R), dk = K.debtKeys.get(k);
  if (!dk) { const m = await basis.noteMessage({issuer: I, recipient: R, total, timestamp: ts}); K.debtKeys.set(k, m.message_hex.slice(0, 64)); return m.message_hex; }
  const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(total)); b.writeBigUInt64BE(BigInt(ts), 8);
  return dk + b.toString('hex') + tracker.nft;
}
// PA(I,R,X,p,T): tracker v3.2's 105-byte prior acknowledgment ("basis/prior-ack/1" || debt key || X BE8 || p BE8 ||
// T BE8 || tracker NFT id), built here from the edge's debt key (startCirculation checks it against the signer).
const PRIOR_ACK_TAG = Buffer.from('basis/prior-ack/1', 'ascii').toString('hex');
async function paHex(I, R, total, priorTs, ts) {
  if (!K.debtKeys.has(edgeKey(I, R))) await msgHex(I, R, 0, 1000);
  const b = Buffer.alloc(24); b.writeBigUInt64BE(BigInt(total)); b.writeBigUInt64BE(BigInt(priorTs), 8); b.writeBigUInt64BE(BigInt(ts), 16);
  return PRIOR_ACK_TAG + K.debtKeys.get(edgeKey(I, R)) + b.toString('hex') + tracker.nft;
}
async function slotSig(P, I, R, total, ts, what) {
  const s = await basis.signHex(P.pubkey, await msgHex(I, R, total, ts), P.secret);
  K.produced.set(s, {by: P.id, what});
  return s;
}
// A prior slot (a transfer's creditor acknowledgment): PA of the edge's state (total, priorTs) at T.
async function priorSlotSig(P, I, R, total, priorTs, ts, what) {
  const s = await basis.signHex(P.pubkey, await paHex(I, R, total, priorTs, ts), P.secret);
  K.produced.set(s, {by: P.id, what});
  return s;
}
const noteSig = async (P, I, R, total, ts) => basis.signHex(P.pubkey, await msgHex(I, R, total, ts), P.secret);
const priorNoteSig = async (P, I, R, total, priorTs, ts) => basis.signHex(P.pubkey, await paHex(I, R, total, priorTs, ts), P.secret);
// Rule R2: an EdgeState the server shows carries its issuer's signature (null: the edge does not exist).
async function stateOk(I, R, st) {
  if (!st) return true;
  const k = `${edgeKey(I, R)}|${st.total}|${st.timestamp}|${st.signature}`;
  if (K.verified.has(k)) return true;
  const good = await basis.verify(I, await msgHex(I, R, st.total, st.timestamp), st.signature);
  if (good) K.verified.add(k);
  return good;
}
// Rule R4: one operation per (edge, timestamp), kept per client key. false: another operation was signed there.
function claim(P, keys, op) {
  if (keys.some(k => P.signedAt.has(k) && P.signedAt.get(k) !== op)) return false;
  for (const k of keys) P.signedAt.set(k, op);
  return true;
}

async function cCall(method, p, body, token, what, headers = {}) {
  const pid = token ? K.tokens.get(token) : null, P = pid ? K.byId.get(pid) : null;
  const h = {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...(P?.features && token === P.agent ? {'x-valun-features': P.features} : {}), ...headers};
  const r = await fetch(base + '/pilot/v1' + p, {method, headers: h, body: body == null ? undefined : JSON.stringify(body)});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const k = `${what} -> ${r.status}${json?.error ? ' ' + json.error : ''}`;
  statuses.set(k, (statuses.get(k) || 0) + 1);
  return {status: r.status, body: json};
}

// ---------- setup ----------
async function startCirculation() {
  tracker = await startTracker(3092, {servedTokenId: PILOT_TOKEN_ID});
  const caps = await capabilities(tracker.url), v = validateCaps(caps), bin = caps ? await trackerSha256() : null;
  if (!caps || !v.ok || !TRACKER_SHA256_PINS.includes(bin) || caps.novation?.setoff?.per_edge_timestamps !== true)
    throw new Error(`SOAK_CIRCULATION=1 needs the tracker v3.2 binaries (VALUN_BINS): ${!caps ? 'this tracker reports no capabilities (a tracker before v3)'
      : !v.ok ? `its capabilities do not validate: ${v.reason}` : !TRACKER_SHA256_PINS.includes(bin) ? `basis_server ${bin} is not pinned in lib/pilot/pins.mjs` : 'it has no per-edge set-off timestamps'}`);
  assert.ok(PEOPLE >= 8, "SOAK_PEOPLE must be at least 8 with SOAK_CIRCULATION=1 (the warm-up's cases need that many kinds of participant)");
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-soak-circulation-'));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  instrument(basis);
  pilot = new Pilot({store: new PilotStore(storeDir), basis, now: cnow, circulation: 'on', trackerCaps: caps, trackerSha256: bin, log: m => K.pilotLog.push(m)});
  assert.equal(pilot.mode, 'on', K.pilotLog.join('\n'));
  const routes = createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6, pilotIpReadLimitPerMinute: 1e6}, adminTokenHash: sha(CIRC_ADMIN)});
  server = http.createServer(observed(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: routes})));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // As server.mjs starts them: the sandbox agents (the server signs for them), then the clearing engine.
  sandbox = new Sandbox(pilot, {dataDir: storeDir, intervalMs: SANDBOX_TICK_MS, now: cnow, log: m => K.sandboxLog.push(m)});
  watchSigner(sandbox);
  await sandbox.start();
  clearing = new Clearing({pilot, intervalMs: CLEARING_INTERVAL_MS, log: m => K.pilotLog.push(m)}).start();
  pilot.clearing = clearing;
  const agent = h => { const k = sandbox.keys[h]; return {id: k.id, handle: h, pubkey: k.pubkey}; };
  K.agents = {X: agent('sandbox-exact'), M: agent('sandbox-mallory')};
  // The messages built here are the signer's, byte for byte.
  const [i, r] = [await basis.keygen(), await basis.keygen()];
  await msgHex(i.pubkey_hex, r.pubkey_hex, 1, 1000);
  for (const [t, ts] of [[0, 2997], [41, Date.now() - 1501], [2 ** 40 + 3, 999]]) {
    assert.equal(await msgHex(i.pubkey_hex, r.pubkey_hex, t, ts), (await basis.noteMessage({issuer: i.pubkey_hex, recipient: r.pubkey_hex, total: t, timestamp: ts})).message_hex);
    assert.equal(await paHex(i.pubkey_hex, r.pubkey_hex, t, ts - 7, ts), (await basis.priorAckMessage({issuer: i.pubkey_hex, recipient: r.pubkey_hex, priorTotal: t, priorTimestamp: ts - 7, timestamp: ts})).message_hex);
  }
}
async function stopCirculation() {
  clearing?.stop(); sandbox?.stop();
  for (let i = 0; i < 200 && sandbox?.busy; i++) await sleep(25);              // a tick in flight ends first
  if (server) { server.closeAllConnections?.(); server.close(); }
  await tracker?.stop();
  if (storeDir) fs.rmSync(storeDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}

// Invited participants: most are 0.4 clients declaring every consent role (some only a few, or none), every fourth a 0.3
// client. Their owners' mandates: varied caps (fixed for the run, as I3 and I10 compare against them); some hold
// commitments above a threshold, or review every delivery (held notes and held payments). What the clients can do and
// the credit policies (whether notes move, clear and pay) follow the participant's place, so every seed has the same
// mix of them: most let notes move.
async function cParticipant(i) {
  const handle = `soak-${i}`;
  const inv = ok(await cCall('POST', '/admin/invites', {note: handle}, null, 'invite', ADM), 201);
  const j = ok(await cCall('POST', '/join', {invite: inv.code, handle, operator: `soak operator ${i}`}, null, 'join'), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await cCall('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}, null, 'enroll'), 201);
  const client = i % 4 === 3 ? '0.3' : '0.4';
  const roles = client === '0.3' ? [] : i % 5 === 4 ? pick([['setoff'], ['issuer', 'creditor'], ['creditor'], []]) : ['setoff', 'issuer', 'creditor'];
  const P = {i, id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token, client, roles,
    features: roles.length ? `consents/1;roles=${roles.join(',')}` : null, signedAt: new Map()};
  K.byId.set(P.id, P); K.tokens.set(P.agent, P.id); K.tokens.set(P.owner, P.id);
  // The owner's mandate for the run (set after the warm-up, which runs on a permissive one).
  P.mandate = {max_issue_per_deal: pick([10, 20, 40]), max_issue_outstanding: pick([40, 80, 160]), max_accept_per_deal: pick([15, 30, 40]),
    max_accept_per_issuer: pick([30, 60]), approve_above: pick([1000, 1000, 1000, 15, 0]), min_price_as_payee: pick([0, 0, 0, 5]),
    review_deliveries: i % 6 === 1, accept_transfers: i % 7 !== 6, accept_notes_from: 'any', novate_own_debt: i % 8 !== 7, auto_clear: i % 6 !== 5,
    pay_with_held_notes: client === '0.3' || i % 12 === 10 ? 'never' : i % 3 === 0 ? 'prefer' : 'when_asked'};
  ok(await cCall('PUT', '/owner/mandate', {max_issue_per_deal: 40, max_issue_outstanding: 160, max_accept_per_deal: 40, max_accept_per_issuer: 60, approve_above: 1000,
    min_price_as_payee: 0, review_deliveries: false, accept_transfers: true, accept_notes_from: 'any', novate_own_debt: true, auto_clear: true, pay_with_held_notes: 'when_asked'},
    P.owner, 'mandate (warm-up)'));
  if (P.features) ok(await cCall('GET', '/me', null, P.agent, 'me'));            // declares its consent roles
  return P;
}
// The warm-up, on permissive mandates: every participant buys a job from the next one (6 PC) and from the one four places
// on (3 PC: with 12 participants these close cycles of three), and pays it with its own note (bound for a 0.4 client). So
// participants hold notes they can pay later deals with, and the engine has cycles to propose from the start; every
// client with consent roles polls once and signs what it is asked (no refusal in this round). Then two payments by
// transfer whose tracker call meets a crash, after the call and before it, are left of unknown outcome (unknownAttempts;
// their payers' clients then try to pay those deals again, which the server must refuse), a refused attempt is recorded
// (refusedAttempt), a collecting transfer meets a key revocation (revocationVoids), and each owner sets the mandate of
// the run (the warm-up's debts fit every one of them: at most 9 PC owed, 6 PC on one issuer, plus a few PC of these
// deals; two participants get caps just above that). Then a transfer over a payee's per-issuer cap and an offer over a
// payer's max_issue_outstanding are refused (overCapSetup, overCapAttempt, overIssueAttempt), and a credit note is held
// for its owner (heldNoteSetup, heldNotePay).
async function warmUp() {
  const n = K.people.length;
  for (const [off, price] of [[1, 6], [4, 3]]) await Promise.all(K.people.map(async (P, i) => {
    const Q = K.people[(i + off) % n], t = terms(P, Q, true, price), h = termsHash(t);
    const d = ok(await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, 'propose (warm-up)'), 201);
    ok(await cCall('POST', `/deals/${d.id}/accept`, {terms_hash: h, signature: await sign(Q, statements.accept(h))}, Q.agent, 'accept (warm-up)'));
    const content = `warm-up work ${int(1, 1e9)}`, dh = sha(content);
    ok(await cCall('POST', `/deals/${d.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Q, statements.deliver(h, dh))}, Q.agent, 'deliver (warm-up)'));
    const paid = await payOwnNote(P, pilot.s.deals[d.id], false);
    assert.equal(pilot.s.deals[d.id].status, 'note_issued', `warm-up: ${P.handle} pays ${Q.handle}: ${paid}`);
  }));
  for (const P of K.people.filter(x => x.roles.length)) await consentsOf(P, {refusals: false});
  await unknownAttempts();
  await refusedAttempt();
  await revocationVoids();
  const overCap = await overCapSetup(), held = await heldNoteSetup();
  // Tight caps, a little above what the warm-up left (so the run reaches them, and every cap the invariants compare
  // against holds from the start): what two participants may owe (I3); and overCapSetup's payee's per-issuer cap (I10).
  const ledger = await pilot.ledger();
  for (const P of K.people) if (P.i % 6 === 2)
    Object.assign(P.mandate, {max_issue_outstanding: pilot.exposure(pilot.s.participants[P.id], ledger, {asRole: 'payer'}).total + 8, max_issue_per_deal: 40, approve_above: 1000});
  for (const P of K.people) ok(await cCall('PUT', '/owner/mandate', P.mandate, P.owner, 'mandate'));
  if (overCap) await overCapAttempt(overCap);
  await overIssueAttempt(overCap?.C);
  if (held) await heldNotePay(held);
}
// Deliberately: a deal that would take a participant's debt on the tracker over its owner's max_issue_outstanding (I3):
// one of the two with a tight cap offers to pay one PC more than its room on the tracker. The server must refuse the offer
// (mandate_exceeded, max_issue_outstanding: its committed deals count too); a server that let it through would, once the
// deal is paid, leave the payer owing more than its cap.
async function overIssueAttempt(notQ) {
  const ledger = await pilot.ledger(), byId = id => pilot.s.participants[id];
  for (const P of K.people.filter(x => x.i % 6 === 2 && x.agent)) {
    const price = P.mandate.max_issue_outstanding - pilot.exposure(byId(P.id), ledger, {asRole: 'payer'}).tracker + 1;
    // The counterparty matters only to a server that lets the offer through (it accepts, delivers and is paid).
    const fits = x => x !== P && x !== notQ && x.client === '0.4' && x.agent && x.mandate.max_accept_per_deal >= price && !(x.mandate.min_price_as_payee > price)
      && pilot.exposure(byId(x.id), ledger, {asRole: 'payee', counterpartyId: P.id}).total + price <= x.mandate.max_accept_per_issuer;
    const Q = K.people.find(x => fits(x) && x.mandate.approve_above >= 1000) ?? K.people.find(fits) ?? K.people.find(x => x !== P && x.client === '0.4' && x.agent);
    if (!Q || price > 40) continue;
    const t = terms(P, Q, true, price), h = termsHash(t);
    const r = await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, "propose (over the payer's cap)");
    if (r.status === 403 && r.body?.error === 'mandate_exceeded' && r.body.rule === 'max_issue_outstanding') { bump('over-issue offer refused'); return; }
    if (r.status !== 201) { violation('I3', `an offer over ${P.handle}'s max_issue_outstanding got ${r.status} ${r.body?.error} ${r.body?.rule ?? ''}, not 403 mandate_exceeded (max_issue_outstanding)`); return; }
    // A server that let it through: the deal runs its course, and I3 sees the payer's debt on the tracker.
    ok(await cCall('POST', `/deals/${r.body.id}/accept`, {terms_hash: h, signature: await sign(Q, statements.accept(h))}, Q.agent, "accept (over the payer's cap)"));
    const held = Object.values(pilot.s.approvals).find(a => a.deal_id === r.body.id && a.state === 'pending' && a.participant === Q.id);
    if (held) await cCall('POST', `/owner/approvals/${held.id}`, {decision: 'approve'}, Q.owner, "owner decision (over the payer's cap)");
    const content = `work ${int(1, 1e9)}`, dh = sha(content);
    ok(await cCall('POST', `/deals/${r.body.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Q, statements.deliver(h, dh))}, Q.agent, "deliver (over the payer's cap)"));
    await payOwnNote(P, pilot.s.deals[r.body.id], false);
    return;
  }
  assert.fail('the warm-up found no participant for its offer over max_issue_outstanding');
}
// A credit note held for its owner (decision D-2 c): a payer whose owner reviews deliveries (from its run mandate on) pays
// a job delivered during the warm-up with its own note; the note waits for that owner (who decides during the run), and no
// set-off applies on its pair meanwhile.
async function heldNoteSetup() {
  const P = K.people.find(x => x.client === '0.4' && x.mandate.review_deliveries), Q = K.people.find(x => x !== P && x.client === '0.4');
  return P && Q ? {P, id: await scriptedDeal(P, Q, 1)} : null;
}
async function heldNotePay({P, id}) {
  const r = await payOwnNote(P, pilot.s.deals[id], false);
  assert.equal(pilot.s.deals[id].status, 'completion_awaiting_owner', `the warm-up's note of a payer whose owner reviews deliveries is held (${r})`);
}
// Deliberately: a payment by transfer still collecting (the issuer signed, the payee not yet) when the payee's owner
// revokes the payee's agent key. The revocation must void it (void_key_revoked; I9: no novation goes on under a key that
// is not current); the payee enrolls a new key (its earlier claims stay under the old one).
async function revocationVoids() {
  const clients = K.people.filter(x => x.client === '0.4');
  for (const P of clients) {
    const A = K.people[(K.people.indexOf(P) + K.people.length - 1) % K.people.length];
    const Q = clients.find(x => x !== P && x !== A && x.roles.includes('creditor'));
    if (K.usedPayers.has(P.id) || !A.roles.includes('issuer') || !Q) continue;
    const id = await scriptedDeal(P, Q, 1), o = ok(await cCall('GET', `/deals/${id}/payment-options`, null, P.agent, 'payment options (warm-up)'));
    const note = o.held_notes.find(x => x.issuer.id === A.id && !x.why_not);
    if (!note) continue;
    K.usedPayers.add(P.id);
    await payWithHeldNote(P, pilot.s.deals[id], false, note, {pollAtOnce: false});
    await consentsOf(A, {refusals: false});
    const t = pilot.s.transfers[pilot.s.deals[id].payment?.transfer_id];
    assert.equal(t?.state, 'collecting', `the warm-up's payment by transfer waits for its payee's consent (${JSON.stringify(t?.result)})`);
    await cCheck("a payment by transfer collecting its payee's consent");
    await rotate(Q);
    if (t.state === 'collecting' || t.state === 'awaiting_owner') violation('I9', `revoking ${Q.handle}'s agent key left transfer ${t.id} ${t.state}, naming the revoked key`);
    else bump(`revocation ended a collecting transfer: ${t.state}`);
    return;
  }
  assert.fail('the warm-up found no payer for its payment by transfer interrupted by a revocation');
}
// Deliberately: a payment by transfer that the payee's per-issuer cap does not allow. C's largest exposure is to issuer A
// (its warm-up note); B (which owes C nothing) gets a note of A's and buys a job from C; C's owner sets max_accept_per_issuer
// one above that largest exposure, so the 2 PC of A's note would take C's claim on A over it (I10). overCapAttempt (once
// the mandates are set): the server must refuse the payment (payment_not_accepted, max_accept_per_issuer); a server that
// let it through would leave a transfer I10 counts against C's cap.
async function overCapSetup() {
  const ledger = await pilot.ledger(), byId = id => pilot.s.participants[id];
  for (const C of K.people.filter(x => x.client === '0.4' && x.roles.includes('creditor') && x.mandate.accept_transfers)) {
    const exp = q => pilot.exposure(byId(C.id), ledger, {asRole: 'payee', counterpartyId: q.id}).total;
    const issuers = Object.values(pilot.s.participants).filter(q => q.id !== C.id), most = Math.max(0, ...issuers.map(exp));
    const A = K.people.find(x => x !== C && x.roles.includes('issuer') && x.mandate.novate_own_debt && most > 0 && exp(byId(x.id)) === most);
    const B = K.people.find(x => x !== C && x !== A && x.client === '0.4' && x.mandate.pay_with_held_notes !== 'never' && exp(byId(x.id)) === 0);
    if (!A || !B) continue;
    await scriptedDeal(A, B, 3, {pay: true});                  // B holds 3 PC of A's notes
    const id = await scriptedDeal(B, C, 2);                     // B owes C 2 PC for a delivered job
    C.mandate.max_accept_per_issuer = most + 1;
    return {A, B, C, id};
  }
  return null;
}
async function overCapAttempt({A, B, C, id}) {
  const tr = await cCall('GET', `/deals/${id}/transfer-template?issuer=${A.id}`, null, B.agent, "transfer template (over the payee's cap)");
  if (tr.status === 403 && tr.body?.error === 'payment_not_accepted' && tr.body.rule === 'max_accept_per_issuer' && tr.body.by === 'payee') { bump('over-cap transfer refused'); return; }
  if (tr.status === 200) return payWithHeldNote(B, pilot.s.deals[id], false, {issuer: {id: A.id}});   // the post, and I10 then counts it
  violation('I10', `a payment by transfer over ${C.handle}'s per-issuer cap got ${tr.status} ${tr.body?.error} ${tr.body?.rule ?? ''}, not 403 payment_not_accepted (max_accept_per_issuer)`);
}
// A deal taken to "delivered" (the payer proposes, the payee accepts and delivers), and with `pay` paid with the payer's
// own note.
async function scriptedDeal(P, Q, price, {pay = false} = {}) {
  const t = terms(P, Q, true, price), h = termsHash(t);
  const deal = ok(await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, 'propose (warm-up)'), 201);
  ok(await cCall('POST', `/deals/${deal.id}/accept`, {terms_hash: h, signature: await sign(Q, statements.accept(h))}, Q.agent, 'accept (warm-up)'));
  const content = `warm-up work ${int(1, 1e9)}`, dh = sha(content);
  ok(await cCall('POST', `/deals/${deal.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Q, statements.deliver(h, dh))}, Q.agent, 'deliver (warm-up)'));
  if (pay) { const r = await payOwnNote(P, pilot.s.deals[deal.id], false); assert.equal(pilot.s.deals[deal.id].status, 'note_issued', `warm-up: ${P.handle} pays ${Q.handle}: ${r}`); }
  return deal.id;
}
// A payment attempt the server refuses and records (decision D-2 b): a bound note signed over a stale prior total, posted;
// then the deal is paid with a correct bound note (another own note may follow at once).
async function refusedAttempt() {
  const [P, Q] = K.people.filter(x => x.client === '0.4');
  const t = terms(P, Q, true, 2), h = termsHash(t);
  const deal = ok(await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, 'propose (warm-up)'), 201);
  ok(await cCall('POST', `/deals/${deal.id}/accept`, {terms_hash: h, signature: await sign(Q, statements.accept(h))}, Q.agent, 'accept (warm-up)'));
  const content = `warm-up work ${int(1, 1e9)}`, dh = sha(content);
  ok(await cCall('POST', `/deals/${deal.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Q, statements.deliver(h, dh))}, Q.agent, 'deliver (warm-up)'));
  const d = pilot.s.deals[deal.id], refused = await payOwnNote(P, d, true, {variant: 'stale_prior'});
  assert.equal(d.refused_attempts?.length, 1, `the warm-up's bound note over a stale prior is refused and recorded (${refused})`);
  // A new template a second later: one operation per (edge, timestamp) (R4) never lets the client sign another note at the
  // refused one's timestamp.
  for (let i = 0; i < 5 && d.status !== 'note_issued'; i++) { await sleep(1100); await payOwnNote(P, d, false); }
  assert.equal(d.status, 'note_issued', 'the warm-up pays that deal with a correct bound note');
}
// Two payments by transfer of a warm-up note (a client issuer and a client payee, who both consent at once), with a crash
// forced on the tracker call: after it (the tracker applied the transfer), then before it (it never got it). Each is left
// applying, then of unknown outcome by the faulty read-back during recovery (unknownOutcome), so its payer's owner has an
// attempt to resolve each way (decision D-2 d); the owners do so during the run, or at the end.
async function unknownAttempts() {
  const used = K.usedPayers, clients = K.people.filter(x => x.client === '0.4');
  for (const fault of ['after', 'before']) {
    let made = null;
    for (const P of clients) {
      const A = K.people[(K.people.indexOf(P) + K.people.length - 1) % K.people.length];     // P holds A's warm-up note (6 PC)
      const Q = clients.find(x => x !== P && x !== A && x.roles.includes('creditor'));
      if (used.has(P.id) || !A.roles.includes('issuer') || !Q) continue;
      const t = terms(P, Q, true, 2), h = termsHash(t);
      const deal = ok(await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, 'propose (warm-up)'), 201);
      ok(await cCall('POST', `/deals/${deal.id}/accept`, {terms_hash: h, signature: await sign(Q, statements.accept(h))}, Q.agent, 'accept (warm-up)'));
      const content = `warm-up work ${int(1, 1e9)}`, dh = sha(content);
      ok(await cCall('POST', `/deals/${deal.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(Q, statements.deliver(h, dh))}, Q.agent, 'deliver (warm-up)'));
      const o = ok(await cCall('GET', `/deals/${deal.id}/payment-options`, null, P.agent, 'payment options (warm-up)'));
      const note = o.held_notes.find(x => x.issuer.id === A.id && !x.why_not);
      if (!note) continue;                                       // e.g. a warm-up set-off took the note: the next payer
      used.add(P.id);
      K.forced.unshift(fault);
      const posted = await payWithHeldNote(P, pilot.s.deals[deal.id], false, note, {pollAtOnce: false});
      for (const C of [A, Q]) await consentsOf(C, {refusals: false});
      await forcedUnknowns();
      made = pilot.s.transfers[pilot.s.deals[deal.id].payment?.transfer_id];
      assert.equal(made?.state, 'outcome_unknown', `the warm-up's payment by transfer with a crash ${fault} the tracker call is of unknown outcome (${posted}; ${JSON.stringify(made?.result)})`);
      // Deliberately wrong: the payer's client pays the deal again with its own note while the attempt may have applied
      // (decision D-1 item 3: only the owner resolves it). The server must refuse every payment of it until then.
      const again = await payOwnNote(P, pilot.s.deals[deal.id], false);
      if (pilot.s.deals[deal.id].status !== 'payment_due') violation('I11', `deal ${deal.id}, whose payment by transfer is of unknown outcome, took another payment (${again}): it may be paid twice`);
      break;
    }
    assert.ok(made, `the warm-up found a payer for its payment by transfer with a crash ${fault} the tracker call`);
  }
}
// Whose notes some owners accept, refuse, or whether they take notes of operator-run issuers.
async function policies() {
  const ids = [...K.people.map(x => x.id), K.agents.X.id, K.agents.M.id];
  for (const P of K.people) {
    const m = {};
    if (rng() < 0.2) m.accept_notes_from = [...new Set(Array.from({length: int(1, 3)}, () => pick(ids)))].filter(id => id !== P.id);
    if (rng() < 0.15) m.refuse_notes_from = [pick(K.people.filter(x => x !== P)).id];
    if (P.i === 2) m.accept_operator_issuers = false;
    if (Object.keys(m).length) ok(await cCall('PUT', '/owner/mandate', m, P.owner, 'credit policy'));
  }
}

// ---------- the actions ----------
// A job a sandbox agent buys or sells (an exactly checkable text-stats or notary job, the text in a fenced block).
function jobTerms(P, A, buy) {
  const service = pick(['notary', 'text-stats']), list = SERVICES[service].price;
  const text = `soak ${P.handle} ${int(1, 1e9)}: ${pick(['credit', 'notes', 'agents', 'cycles'])} ${pick(['move', 'clear', 'net'])} ${pick(['slowly', 'today', 'exactly'])}`;
  const price = buy ? list + (rng() < 0.15 ? 1 : 0) : Math.max(1, list - (rng() < 0.2 ? 1 : 0));
  const t = terms(P, A, buy, price);
  t.service = {title: `${service} job`, description: `${service} for this text:\n\`\`\`\n${text}\n\`\`\``, deliverable: `The exact ${service} result as JSON.`};
  return t;
}
async function cPropose(P, bad) {
  if (rng() < 0.3) {
    const A = pick([K.agents.X, K.agents.M]), buy = rng() < 0.55, t = jobTerms(P, A, buy), h = termsHash(t);
    return label(`propose (${buy ? 'buy from' : 'sell to'} ${A.handle})`, await cCall('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent, 'propose (sandbox)'));
  }
  const Q = pick(K.people.filter(x => x !== P)), t = terms(P, Q, rng() < 0.6, pick(PRICES)), h = termsHash(t);
  return label('propose', await cCall('POST', '/deals', {terms: t, terms_hash: bad ? sha('x') : h, signature: await sign(bad ? Q : P, statements.propose(h))}, P.agent, 'propose'));
}
async function cRespond(P, d, bad) {
  if (d?.status !== 'open') return 'respond: not open';
  const cur = d.versions.at(-1), h = cur.terms_hash, choice = pick(['accept', 'accept', 'accept', 'decline', 'withdraw', 'counter']);
  if (choice === 'accept') return label('accept', await cCall('POST', `/deals/${d.id}/accept`, {terms_hash: bad ? sha('y') : h, signature: await sign(P, statements.accept(h))}, P.agent, 'accept'));
  if (choice === 'decline') { const reason = pick(['too expensive', 'not now', 'no thanks']);
    return label('decline', await cCall('POST', `/deals/${d.id}/decline`, {terms_hash: h, reason, signature: await sign(P, statements.decline(h, reason))}, P.agent, 'decline')); }
  if (choice === 'withdraw') return label('withdraw', await cCall('POST', `/deals/${d.id}/withdraw`, {terms_hash: h, signature: await sign(P, statements.withdraw(h))}, P.agent, 'withdraw'));
  const t = {...cur.terms, version: cur.v + 1, prior_terms_hash: cur.terms_hash, proposer: P.id, nonce: crypto.randomBytes(16).toString('hex'),
    price: {amount: pick(PRICES), unit: 'PC'}, offer_expires_at: new Date(Date.now() + 24 * 3600e3).toISOString()};
  const th = termsHash(t);
  return label('counter', await cCall('POST', `/deals/${d.id}/counter`, {terms: t, terms_hash: th, signature: await sign(P, statements.propose(th))}, P.agent, 'counter'));
}
// A delivery; for a sandbox agent that bought the job, its exact result (now and then a wrong one, which it disputes).
async function cDeliver(P, d, bad) {
  if (d?.status !== 'agreed') return 'deliver: not agreed';
  const t = d.agreement.terms, h = d.agreement.terms_hash, service = whichService(t), text = service ? extractText(t.service.description) : null;
  let content = `delivery ${int(1, 1e9)}`;
  if (pilot.sandboxIds.has(d.payer) && service && text != null) { const result = COMPUTE[service](text); content = render(service, rng() < 0.85 ? result : corrupt(service, result), text); }
  const dh = sha(content);
  return label('deliver', await cCall('POST', `/deals/${d.id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(bad ? pick(K.people) : P, statements.deliver(h, dh))}, P.agent, 'deliver'));
}
// The payer reviews: a dispute (mostly of a wrong sandbox delivery), else a payment: by transfer with a held note
// (0.4 clients, as their owner's pay_with_held_notes allows), else with its own note (bound for a 0.4 client), else it
// waits (D-1).
async function cReview(P, d, bad) {
  if (!d || d.payer !== P.id || !['delivered', 'note_failed', 'payment_due'].includes(d.status)) return 'review: nothing to do';
  if (d.status === 'delivered') {
    const wrong = pilot.sandboxIds.has(d.payee) ? checkDelivery(d.agreement.terms, d.delivery?.content) : null;
    if ((wrong && rng() < 0.8) || rng() < 0.12) {
      const h = d.agreement.terms_hash, reason = wrong ? 'the delivered result does not match the exact result of the agreed text' : 'not what was agreed';
      return label('dispute', await cCall('POST', `/deals/${d.id}/dispute`, {terms_hash: h, deliverable_sha256: d.delivery.sha256, reason,
        signature: await sign(P, statements.dispute(h, d.delivery.sha256, reason))}, P.agent, 'dispute'));
    }
  }
  if (P.client === '0.3') return payOwnNote(P, d, bad);
  // A 0.4 client reads the payment options first: a held note that can pay now (as its owner's pay_with_held_notes
  // allows), else its own note, else (decision D-1: an earlier attempt can still apply) it waits until the server says
  // another payment may start, and only now and then asks anyway (the server's refusal is then the check).
  const o = await cCall('GET', `/deals/${d.id}/payment-options`, null, P.agent, 'payment options');
  if (o.status !== 200) return label('payment options', o);
  const held = o.body.held_notes ?? [], free = held.filter(x => !x.why_not), own = o.body.own_note, pay = pilot.s.participants[P.id]?.mandate?.pay_with_held_notes;
  for (const x of held) bump(`held note: ${x.why_not ?? 'spendable'}`);
  const may = !!pay && pay !== 'never';
  if (may && free.length && (rng() < (pay === 'prefer' ? 0.9 : 0.6) || !own?.available)) return payWithHeldNote(P, d, bad, pick(free));
  if (own?.available) return payOwnNote(P, d, bad);
  if (rng() < 0.1) return may && held.length ? payWithHeldNote(P, d, bad, pick(held)) : payOwnNote(P, d, bad);
  notBefore.set(d.id, Date.now() + Math.min(Math.max((o.body.fallback_after ? Date.parse(o.body.fallback_after) : 0) - cnow(), 5e3), 30 * MIN));
  bump(`payer waits: ${own?.why_not}`);
  return `review: waits (${own?.why_not})`;
}
async function payWithHeldNote(P, d, bad, choice, {pollAtOnce = true} = {}) {
  const tr = await cCall('GET', `/deals/${d.id}/transfer-template?issuer=${choice.issuer.id}`, null, P.agent, 'transfer template');
  if (tr.status !== 200) return label('transfer template', tr);
  // The payer's client checks the template (rules R1-R7) before it signs.
  const t = tr.body, deal = pilot.s.deals[d.id], a = t.amount, X = t.from_edge.before?.total, Y = t.to_edge.before?.total ?? 0, A = t.issuer.pubkey, C = t.payee.pubkey, T = t.timestamp;
  const pX = t.from_edge.before?.timestamp, pY = t.to_edge.before?.timestamp ?? 0;
  const q = quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: d.id, terms_hash: deal.agreement.terms_hash,
    deliverable_sha256: deal.delivery.sha256, issuer_pubkey: A, payer_pubkey: P.pubkey, payee_pubkey: C, amount: a});
  const fails = [];
  if (T % 1000 !== 999 || !(T > (t.from_edge.before?.timestamp ?? 0)) || !(T > (t.to_edge.before?.timestamp ?? 0))) fails.push('timestamp');
  if (t.payer.pubkey !== P.pubkey || t.payee.id !== deal.payee || C !== pilot.s.participants[deal.payee].pubkey || A === P.pubkey || A === C) fails.push('parties');
  if (a !== deal.agreement.terms.price.amount || t.from_edge.new_total !== X - a || t.to_edge.new_total !== Y + a) fails.push('amount');
  if (t.quote_digest !== q || t.terms_hash !== deal.agreement.terms_hash || t.deliverable_sha256 !== deal.delivery.sha256) fails.push('quote');
  if (!(await stateOk(A, P.pubkey, t.from_edge.before)) || !(await stateOk(A, C, t.to_edge.before))) fails.push('edge state signature');
  if (t.from_edge.prior_timestamp !== pX || t.to_edge.prior_timestamp !== pY) fails.push('prior timestamps');
  if (fails.length) { violation('R', `the transfer template for ${d.id} fails the payer's checks: ${fails.join(', ')}`); return 'pay by transfer: template refused by the client'; }
  // Deliberately wrong posts: a stale prior the payer signs consistently (refused and recorded: decision D-2 b), or a
  // slot signed with another key (refused, nothing recorded).
  const variant = bad ? pick(['stale_prior', 'bad_signature']) : null, X2 = variant === 'stale_prior' ? X + 1 : X;
  const AB = edgeKey(A, P.pubkey), AC = edgeKey(A, C);
  if (!claim(P, [`${AB}|${T}`, `${AC}|${T}`], `pay:${d.id}:${T}:${X2}:${Y}`)) { bump('client refused: timestamp reused (R4)'); return 'pay by transfer: R4'; }
  const other = variant === 'bad_signature' ? pick(K.people.filter(x => x !== P)) : P;
  const body = {issuer_id: t.issuer.id, terms_hash: t.terms_hash, deliverable_sha256: t.deliverable_sha256, quote_digest: q, timestamp: T, from_prior_total: X2, to_prior_total: Y,
    from_prior_timestamp: pX, to_prior_timestamp: pY,
    completion_signature: await sign(P, statements.complete(t.terms_hash, t.deliverable_sha256)), pay_signature: await sign(P, circulationStatements.pay(d.id, q)),
    signatures: {[`${AB}:prior`]: await priorSlotSig(other, A, P.pubkey, X2, pX, T, 'a transfer slot'), [`${AB}:new`]: await slotSig(P, A, P.pubkey, X2 - a, T, 'a transfer slot'),
      [`${AC}:new`]: await slotSig(P, A, C, Y + a, T, 'a transfer slot')}};
  const r = await cCall('POST', `/deals/${d.id}/pay-by-transfer`, body, P.agent, variant ? `pay-by-transfer (${variant})` : 'pay-by-transfer');
  if (r.status === 200) bump('payment by transfer posted');
  if (r.status === 200 && r.body?.transfer?.id) await cCall('GET', `/transfers/${r.body.transfer.id}`, null, P.agent, 'read transfer (after paying)');
  // The issuer's and the payee's clients, when present (consent speed auto), poll at once most of the time; otherwise the
  // transfer waits for their next poll (or a cancellation, a refusal, its expiry).
  if (pollAtOnce && r.status === 200 && r.body?.transfer?.state === 'collecting' && rng() < 0.7)
    for (const id of [t.issuer.id, t.payee.id]) { const Q = K.byId.get(id); if (Q?.agent && Q.roles.length) await consentsOf(Q); }
  return label(variant ? `pay by transfer (${variant})` : 'pay by transfer', r);
}
async function payOwnNote(P, d, bad, {variant: forced = null} = {}) {
  const bound = P.client === '0.4';
  const tr = await cCall('GET', `/deals/${d.id}/credit-note-template${bound ? '?prior=1&bound=1' : ''}`, null, P.agent, bound ? 'bound template' : 'template');
  if (tr.status !== 200) return label('template', tr);
  const t = tr.body, deal = pilot.s.deals[d.id];
  if (bound) {
    const fails = [];
    if (t.timestamp % 1000 !== 997 || (t.prior_note && !(t.timestamp > t.prior_note.timestamp))) fails.push('timestamp');
    if (t.issuer_pubkey !== P.pubkey || t.recipient_pubkey !== pilot.s.participants[deal.payee].pubkey) fails.push('keys');
    if (t.price !== deal.agreement.terms.price.amount || t.total !== t.prior_total + t.price || (t.prior_note?.total ?? 0) !== t.prior_total) fails.push('total');
    if (t.prior_timestamp !== (t.prior_note ? t.prior_note.timestamp : 0)) fails.push('prior timestamp');
    if (!(await stateOk(P.pubkey, t.recipient_pubkey, t.prior_note))) fails.push('prior note signature');
    if (fails.length) { violation('R', `the bound credit-note template for ${d.id} fails the payer's checks: ${fails.join(', ')}`); return 'bound note: template refused by the client'; }
  }
  // Deliberately wrong notes: a total one too high (stale), a stale prior the payer signs consistently (refused and
  // recorded: decision D-2 b), or a note signed with another key.
  const variant = forced ?? (bad ? pick(bound ? ['total_plus_one', 'stale_prior', 'bad_signature'] : ['total_plus_one', 'bad_signature']) : null);
  const total = t.total + (variant === 'total_plus_one' ? 1 : 0), prior = t.prior_total + (variant === 'stale_prior' ? 1 : 0);
  if (!claim(P, [`${edgeKey(t.issuer_pubkey, t.recipient_pubkey)}|${t.timestamp}`], `note:${d.id}:${total}:${prior}`)) { bump('client refused: timestamp reused (R4)'); return 'own note: R4'; }
  const signer = variant === 'bad_signature' ? pick(K.people.filter(x => x !== P)) : P;
  const note = {total, timestamp: t.timestamp, signature: await noteSig(signer, t.issuer_pubkey, t.recipient_pubkey, total, t.timestamp),
    ...(bound ? {prior_total: prior, prior_timestamp: t.prior_timestamp, prior_signature: await priorNoteSig(P, t.issuer_pubkey, t.recipient_pubkey, prior, t.prior_timestamp, t.timestamp)} : {})};
  const r = await cCall('POST', `/deals/${d.id}/complete`, {terms_hash: t.terms_hash, deliverable_sha256: t.deliverable_sha256,
    signature: await sign(P, statements.complete(t.terms_hash, t.deliverable_sha256)), credit_note: note}, P.agent, variant ? `complete (${variant})` : bound ? 'complete (bound)' : 'complete');
  return label(variant ? `own note (${variant})` : 'own note', r);
}
// A 0.4 client's consent processing: GET /consents, then each item checked as its signing firewall checks it (its own
// edges, EdgeStates signed by their issuers, the residue, net-neutral set-offs, the transfer's amount) and signed, or
// refused now and then. What the firewall must refuse is a violation (R): the server built the item.
async function cConsents() {
  const clients = K.people.filter(P => P.agent && P.roles.length);
  if (!clients.length) return 'consents: no 0.4 client with consent roles';
  // Mostly clients something waits for (their next poll), sometimes any.
  const waiting = clients.filter(P => pilot.pendingOf(pilot.s.participants[P.id]).consents_waiting_for_you > 0), from = waiting.length && rng() < 0.8 ? waiting : clients;
  const chosen = [...new Set(Array.from({length: int(1, 3)}, () => pick(from)))], out = [];
  for (const P of chosen) out.push(await consentsOf(P));
  return `consents: ${out.join('; ')}`;
}
async function consentsOf(P, {refusals = true} = {}) {
  const c = await cCall('GET', '/consents', null, P.agent, 'consents');
  if (c.status !== 200) return `${P.handle} ${c.status}`;
  let signed = 0, refused = 0;
  for (const item of c.body.consents) {
    if (refusals && rng() < 0.12) {
      const r = await cCall('POST', `/consents/${item.id}/refuse`, {reason: pick(REFUSALS)}, P.agent, `refuse ${item.kind}`);
      if (r.status === 200) { refused++; bump(`consent refused: ${item.kind}`); }
      continue;
    }
    const body = await consentBody(P, item);
    if (!body) continue;
    const r = await cCall('POST', `/consents/${item.id}`, body, P.agent, `consent ${item.kind}`);
    if (r.status === 200 && !r.body?.rejected?.length) { signed++; bump(`consent signed: ${item.kind} (${item.your_roles.join(',')})`); }
    // The client follows what it signed (its receipts come with the application): GET /transfers or /setoffs.
    await cCall('GET', `/${item.kind === 'transfer' ? 'transfers' : 'setoffs'}/${item.id}`, null, rng() < 0.7 ? P.agent : P.owner, `read ${item.kind} (after a consent)`);
  }
  return `${P.handle} signed ${signed}, refused ${refused}`;
}
async function consentBody(P, item) {
  const fails = [], residue = item.kind === 'transfer' ? 999 : 998, role = item.your_roles?.[0];
  let asCreditor = 0, asIssuer = 0;
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    if (e.timestamp % 1000 !== residue || (e.before && !(e.timestamp > e.before.timestamp))) fails.push('timestamp');
    if (e.new_total !== (e.before?.total ?? 0) + e.change || e.new_total < 0) fails.push('totals');
    if (!(await stateOk(I, R, e.before))) fails.push('edge state signature');
    if (item.kind === 'setoff') {
      if (I !== P.pubkey && R !== P.pubkey) fails.push('not my edge');
      if (!(e.change < 0)) fails.push('an increase in a set-off');
      if (R === P.pubkey) asCreditor -= e.change; else asIssuer -= e.change;
    }
  }
  const deal = item.context?.deal ? pilot.s.deals[item.context.deal.deal_id] : null, a = item.context?.amount;
  if (item.kind === 'setoff') { if (asCreditor !== asIssuer || item.summary?.your_net_change_PC !== 0) fails.push('not net-neutral'); }
  else if (role === 'issuer') {
    if (item.edges.length !== 2 || !item.edges.every(e => e.edge.split('>')[0] === P.pubkey) || item.edges[0].change !== -a || item.edges[1].change !== a) fails.push('the total owed changes');
  } else if (role === 'payee') {
    if (item.edges.length !== 1 || item.edges[0].edge.split('>')[1] !== P.pubkey || item.edges[0].change !== a || !deal || deal.payee !== P.id || a !== deal.agreement.terms.price.amount) fails.push('the deal');
  } else if (role === 'payer') {
    const [from, to] = item.edges, [A] = from.edge.split('>'), C = to.edge.split('>')[1];
    const q = deal && quoteDigest({network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION, deal_id: deal.id, terms_hash: deal.agreement.terms_hash,
      deliverable_sha256: deal.delivery.sha256, issuer_pubkey: A, payer_pubkey: P.pubkey, payee_pubkey: C, amount: a});
    if (!deal || deal.payer !== P.id || from.edge.split('>')[1] !== P.pubkey || from.change !== -a || to.change !== a || q !== item.context.deal.quote_digest) fails.push('the payment');
    // The server makes no transfer again by itself (no regeneration), so a payer consent is never offered; a client
    // signs none (a retry is a new payment of its own, from a fresh template).
    fails.push('a payer consent');
  } else fails.push(`role ${role}`);
  if (fails.length) { violation('R', `${P.handle}'s client must refuse consent item ${item.id} (${item.kind}, ${role}): ${[...new Set(fails)].join(', ')}`); return null; }
  // Rule R8: the owner's policy. The client refuses what its owner's mandate no longer allows; when the server made the
  // item after the owner's last change, it should not have offered it at all (R).
  const me = pilot.s.participants[P.id], m = me.mandate, since = Date.parse(me.mandate_changed_at ?? 0) < Date.parse(item.created_at);
  const policy = item.kind === 'setoff' ? (m.auto_clear ? null : 'auto_clear') : role === 'issuer' ? (m.novate_own_debt ? null : 'novate_own_debt')
    : role === 'payee' ? (m.accept_transfers ? null : 'accept_transfers') : null;
  if (policy) { if (since) violation('R', `${P.handle} was offered consent item ${item.id} (${item.kind}, ${role}) made after its owner turned ${policy} off`); bump(`client refused: policy (${policy})`); return null; }
  // Rule R4: a set-off never takes an (edge, timestamp) another set-off took (the server keeps that too); any other
  // reuse the client refuses by itself.
  const keys = item.edges.map(e => `${e.edge}|${e.timestamp}`);
  if (item.kind === 'setoff') for (const k of keys) { const prev = P.signedAt.get(k); if (prev && prev !== item.id && prev.startsWith('vs_')) violation('R', `${P.handle} was asked to sign set-off ${item.id} at an (edge, timestamp) of set-off ${prev}`); }
  if (!claim(P, keys, item.id)) { bump('client refused: timestamp reused (R4)'); return null; }
  const signatures = {}, revisions = {};
  for (const e of item.edges) {
    const [I, R] = e.edge.split('>');
    revisions[e.edge] = e.revision;
    if (e.prior_timestamp !== undefined && e.prior_timestamp !== (e.before ? e.before.timestamp : 0)) { violation('R', `consent item ${item.id}: edge ${e.edge}'s prior_timestamp is not its before's timestamp`); return null; }
    for (const slot of e.slots) if (!e.signed_by_you.includes(slot))
      signatures[`${e.edge}:${slot}`] = slot === 'prior'
        ? await priorSlotSig(P, I, R, e.before?.total ?? 0, e.before?.timestamp ?? 0, e.timestamp, 'a transfer slot')
        : await slotSig(P, I, R, e.new_total, e.timestamp, item.kind === 'transfer' ? 'a transfer slot' : 'a set-off slot');
  }
  return Object.keys(signatures).length ? {signatures, revisions} : null;
}
// The owner: decides a pending approval (held offers, acceptances, notes and payments), and resolves the attempts of
// unknown outcome its deals wait on (decision D-2 d) as the tracker shows them (it asked the payee).
async function cOwner(P, bad) {
  const out = [], o = await cCall('GET', '/owner', null, P.owner, 'owner view');
  const ap = (o.body?.approvals || []).filter(a => a.state === 'pending');
  if (ap.length) {
    const a = pick(ap), r = await cCall('POST', `/owner/approvals/${a.id}`, {decision: rng() < 0.8 ? 'approve' : 'reject'}, P.owner, `owner decision (${a.kind})`);
    if (r.status === 200) bump(`owner decided: ${a.kind}`);
    out.push(label(a.kind, r));
  }
  for (const [vt, truth] of K.truth) {
    const t = pilot.s.transfers[vt];
    if (t?.state !== 'outcome_unknown' || t.payer.id !== P.id || rng() < 0.3) continue;
    const who = bad ? pick(K.people.filter(x => x !== P)) : P;          // another owner: 403 not_payer (the payee) or 404
    const r = await cCall('POST', `/owner/deals/${t.deal_id}/attempts/${vt}/resolve`, {outcome: truth, note: 'the payee confirmed it'}, who.owner, 'resolve attempt');
    if (r.status === 200) bump(`owner resolved: ${truth}`);
    out.push(label('resolve', r));
  }
  return `owner: ${out.join(', ') || 'nothing pending'}`;
}
async function cCancel() {
  const live = Object.values(pilot.s.transfers).filter(t => t.state === 'collecting' && K.byId.get(t.payer.id)?.agent);
  if (!live.length) return 'cancel: no transfer collecting';
  const t = pick(live), r = await cCall('POST', `/deals/${t.deal_id}/cancel-transfer`, {}, K.byId.get(t.payer.id).agent, 'cancel transfer');
  if (r.status === 200) bump('transfer cancelled');
  return label('cancel', r);
}
async function cEngine() {
  const r = await cCall('POST', '/admin/clearing/run', {}, null, 'engine run', ADM);
  if (r.status === 200) bump('engine run');
  return label('engine run', r);
}
// Recovery (server.mjs: at startup and every 60 s). Not while a transfer a forced fault left applying waits for its
// read-back fault at the next batch boundary.
async function cRecover() {
  if (forcedWaiting().length) return 'recover: later (a forced fault waits)';
  const {ctx, value, error} = await internal(() => pilot.recover());
  if (error) {
    if (ctx.crashed || K.crashes > ctx.crashesAtStart) { bump('recovery met an injected crash'); return 'recover: crashed (injected)'; }
    violation('I1', `recovery failed: ${error.message}`); return 'recover: failed';
  }
  bump('recovery');
  return `recover: ${value.join(', ') || 'nothing'}`;
}
async function cLimits(P) { return label('limits', await cCall('PUT', '/limits', {max_issue_per_deal: int(0, 60)}, P.agent, 'limits')); }   // above the mandate is refused
// Reads: every response is scanned (I7), whoever asks and whatever it is about.
async function cRead(P) {
  const x = rng(), token = rng() < 0.5 ? P.agent : P.owner;
  const any = o => { const ks = Object.keys(o); return ks.length ? pick(ks) : null; };
  if (x < 0.2) { const ds = pilot.dealsFor(pilot.s.participants[P.id]); if (ds.length) return label('read deal', await cCall('GET', `/deals/${pick(ds).id}`, null, P.agent, 'read deal')); }
  if (x < 0.35) { const id = any(pilot.s.transfers); if (id) return label('read transfer', await cCall('GET', `/transfers/${id}`, null, token, 'read transfer')); }
  if (x < 0.5) { const id = any(pilot.s.setoffs); if (id) return label('read set-off', await cCall('GET', `/setoffs/${id}`, null, token, 'read set-off')); }
  if (x < 0.58) return label('edges', await cCall('GET', '/edges', null, token, 'edges'));
  if (x < 0.64) return label('consents', await cCall('GET', '/consents', null, P.owner, 'consents (owner)'));
  if (x < 0.7) return label('me', await cCall('GET', '/me', null, P.agent, 'me'));
  if (x < 0.76) return label('inbox', await cCall('GET', '/inbox', null, P.agent, 'inbox'));
  if (x < 0.82) return label('clearing', await cCall('GET', '/clearing', null, null, 'clearing'));
  if (x < 0.88) return label('ledger', await cCall('GET', '/ledger', null, null, 'ledger'));
  if (x < 0.94) return label('participant', await cCall('GET', `/participants/${pick(K.people).id}`, null, null, 'participant'));
  return label('admin clearing', await cCall('GET', '/admin/clearing', null, null, 'admin clearing', ADM));
}
// One random action. Like real agents, mostly work that waits: a deal in some participant's inbox (an offer to answer,
// a delivery to make, a delivery to review and pay), consents waiting for a client, approvals waiting for an owner.
const busyDeals = new Set();          // deals an action in flight works on (two actions never take the same deal at once)
const notBefore = new Map();          // deal -> when (ms) its payer's client tries to pay it again (it waits out a D-1 window)
// A deal whose payment waits for its payer's owner (an attempt of unknown outcome): its client does not pay it again.
const waitsForOwner = d => (d.transfer_ids || []).some(id => ['outcome_unknown', 'inconsistent'].includes(pilot.s.transfers[id]?.state));
async function cAct() {
  const bad = rng() < 0.17, r = rng(), agents = K.people.filter(x => x.agent);
  if (r < 0.55) {
    const work = [];
    for (const P of agents) {
      const box = pilot.inbox(pilot.s.participants[P.id]), add = (k, i) => { if (!busyDeals.has(i.deal_id)) work.push([P, k, i]); };
      for (const i of box.respond) add('respond', i);
      for (const i of box.deliver) add('deliver', i);
      // A deal waiting for its payer's owner (an attempt of unknown outcome) or out of a D-1 window: its client leaves it,
      // but now and then tries anyway (deliberately wrong: the server must refuse).
      for (const i of box.review_delivery) if (i.your_role === 'payer' && ((!waitsForOwner(pilot.s.deals[i.deal_id]) && !(notBefore.get(i.deal_id) > Date.now())) || rng() < 0.1)) add('review', i);
    }
    if (work.length) {
      const [P, k, item] = pick(work), d = pilot.s.deals[item.deal_id];
      busyDeals.add(d.id);
      try { return await (k === 'respond' ? cRespond(P, d, bad) : k === 'deliver' ? cDeliver(P, d, bad) : cReview(P, d, bad)); }
      finally { busyDeals.delete(d.id); }
    }
  }
  const P = pick(agents), q = rng();
  if (q < 0.3) return cConsents();
  if (q < 0.46) {
    const owners = K.people.filter(x => Object.values(pilot.s.approvals).some(a => a.participant === x.id && a.state === 'pending')
      || [...K.truth.keys()].some(vt => pilot.s.transfers[vt]?.state === 'outcome_unknown' && pilot.s.transfers[vt].payer.id === x.id));
    return cOwner(owners.length && rng() < 0.85 ? pick(owners) : P, bad);
  }
  if (q < 0.48) return cLimits(P);
  if (q < 0.5) return cCancel();
  if (q < 0.53) return cEngine();
  if (q < 0.56) return cRecover();
  if (q < 0.63) return cRead(P);
  return cPropose(P, bad);
}

// ---------- events at a batch boundary (nothing else of the soak runs; the sandbox and the engine are paused) ----------
async function exclusive(fn) {
  clearing.stop(); sandbox.stop();
  for (let i = 0; i < 800 && (sandbox.busy || clearing.running || clearing.ticking); i++) await sleep(25);
  await pilot.serial(() => {});
  try { return await fn(); }
  finally { await sandbox.start(); clearing.start(); }
}
// The server's clock (and the sandbox's) moves `name`'s distance ahead while the participants and owners read what they
// would on coming back (their consents as owners, so no proposal is made at the jumped time; their owner views; payment
// options), and recovery and the engine's housekeeping run; then it returns.
async function clockJump(name) {
  const counts = () => {
    const c = {};
    for (const t of Object.values(pilot.s.transfers)) c[`transfer ${t.state}`] = (c[`transfer ${t.state}`] || 0) + 1;
    for (const o of Object.values(pilot.s.setoffs)) c[`set-off ${o.state}`] = (c[`set-off ${o.state}`] || 0) + 1;
    for (const a of Object.values(pilot.s.approvals)) c[`approval ${a.state}`] = (c[`approval ${a.state}`] || 0) + 1;
    return c;
  };
  return exclusive(async () => {
    const was = counts();
    clockOffset += JUMP[name];
    try {
      for (const P of K.people) {
        await cCall('GET', '/consents', null, P.owner, 'consents (owner, clock ahead)');
        await cCall('GET', '/owner', null, P.owner, 'owner view (clock ahead)');
        if (P.agent && P.client === '0.4') for (const d of pilot.dealsFor(pilot.s.participants[P.id]))
          if (d.payer === P.id && ['delivered', 'note_failed', 'payment_due'].includes(d.status)) await cCall('GET', `/deals/${d.id}/payment-options`, null, P.agent, 'payment options (clock ahead)');
      }
      const rec = await internal(() => pilot.recover());
      if (rec.error && !(rec.ctx.crashed || K.crashes > rec.ctx.crashesAtStart)) violation('I1', `recovery failed: ${rec.error.message}`);
      await pilot.serial(() => pilot.setoffHousekeeping());
    } finally { clockOffset -= JUMP[name]; }
    const now = counts(), moved = Object.keys(now).filter(k => now[k] !== was[k]).map(k => `${k} ${was[k] || 0}->${now[k]}`);
    bump('clock jump'); bump(`clock jump: ${name}`);
    for (const k of ['transfer expired', 'set-off expired', 'approval void_expired']) if ((now[k] || 0) > (was[k] || 0)) bump(`clock jump: ${k}`, now[k] - (was[k] || 0));
    return `clock jump ${name} (+${JUMP[name] / MIN} min): ${moved.join(', ') || 'nothing changed'}`;
  });
}
// A transfer a fault left applying, recovered while its from-edge reads back in a state at its timestamp that is neither
// its prior nor its new one: outcome_unknown (an alarm), for its payer's owner to resolve. What the tracker really shows
// (applied or not) is what that owner later answers.
async function unknownOutcome(t) {
  return exclusive(async () => {
    if (t.state !== 'applying') return `unknown outcome: ${t.id} is ${t.state} by now`;
    const [from, to] = [await K.orig.note(t.issuer.pubkey, t.payer.pubkey), await K.orig.note(t.issuer.pubkey, t.payee.pubkey)];
    const at = (n, total, sig) => !!n && Number(n.amount_collected) === total && n.timestamp === t.timestamp && n.signature === sig;
    const applied = at(from, t.from_edge.new_total, t.slots.issuer_from?.signature) && at(to, t.to_edge.new_total, t.slots.issuer_to?.signature);
    K.readFault = {issuer: t.issuer.pubkey, recipient: t.payer.pubkey, used: 0, note: {...from, timestamp: t.timestamp, signature: randomSig()}};
    let res;
    try { res = await internal(() => pilot.serial(() => pilot.recoverTransfer(t))); } finally { K.readFault = null; }
    if (res.error) violation('I1', `recovery of ${t.id} failed: ${res.error.message}`);
    if (t.state === 'outcome_unknown') { K.truth.set(t.id, applied ? 'applied' : 'not_applied'); bump(`outcome unknown: the tracker shows it ${applied ? 'applied' : 'not applied'}`); }
    return `unknown outcome: ${t.id} -> ${t.state} (the tracker shows it ${applied ? 'applied' : 'not applied'})`;
  });
}
const forcedWaiting = () => Object.values(pilot.s.transfers).filter(t => t.state === 'applying'
  && K.forcedHits.some(h => !h.done && h.timestamp === t.timestamp && h.issuer === t.issuer.pubkey && h.payer === t.payer.pubkey));
// Every transfer a forced fault left applying is left of unknown outcome (then checked).
async function forcedUnknowns() {
  for (const t of forcedWaiting().filter(x => K.byId.has(x.payer.id))) {
    await cCheck(await unknownOutcome(t));
    for (const h of K.forcedHits) if (h.timestamp === t.timestamp && h.issuer === t.issuer.pubkey && h.payer === t.payer.pubkey) h.done = true;
  }
}
// The owner revokes its agent's key and a new key is enrolled (decision I9's case: novations naming the old key end).
async function rotate(P) {
  return exclusive(async () => {
    const r = await cCall('POST', '/owner/revoke-agent', {}, P.owner, 'revoke agent');
    if (r.status !== 200) return label(`rotate ${P.handle}`, r);
    K.tokens.delete(P.agent); P.agent = null;
    const key = await basis.keygen();
    const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(P.id, key.pubkey_hex, sha(r.body.enrollment_code))), key.secret_hex);
    const e = await cCall('POST', '/enroll', {participant_id: P.id, code: r.body.enrollment_code, pubkey: key.pubkey_hex, signature: pop}, null, 'enroll again');
    if (e.status !== 201) return label(`rotate ${P.handle}: enroll`, e);
    Object.assign(P, {pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.body.agent_token, signedAt: new Map()});
    K.tokens.set(P.agent, P.id);
    if (P.features) await cCall('GET', '/me', null, P.agent, 'me');
    bump('key rotated');
    const n = k => r.body[k]?.length ?? 0;
    return `rotate ${P.handle}: voided ${n('voided_transfers')} transfers, ${n('voided_setoffs')} set-offs, ${n('voided_credit_notes')} held notes; cancelled ${n('cancelled_deals')} deals`;
  });
}

// ---------- the invariants ----------
// Checked inside the server's lock: every tracker write Valun makes (notes, transfers, set-offs, recovery) runs under it,
// so the tracker read here and the journal agree unless a novation's outcome is still undecided.
async function cCheck(what, {strict = false} = {}) {
  K.checks++;
  await pilot.serial(async () => {
    const notes = await pilotNotes(), ledger = await pilot.ledger();
    evaluate(notes, ledger, {strict});
    let sum = 0;
    for (const p of Object.values(pilot.s.participants)) sum += (await pilot.position(p, ledger)).net;
    if (sum !== 0) violation('I8', `the nets of all participants sum to ${sum}`);
  });
  if (K.violations.length) {
    throw new assert.AssertionError({message: `after ${short(what)}: ${K.violations.length} violation(s):\n  ${K.violations.slice(0, 15).join('\n  ')}\n${tails()}`});
  }
}
function evaluate(notes, ledger, {strict}) {
  const s = pilot.s, byEdge = new Map(notes.map(n => [noteKey(n), n]));
  for (const t of Object.values(s.transfers)) pilot.sweepTransfer(t);          // what a read sees: expired ones end first
  // I2': the tracker against the journal, on every edge whose outcome is decided.
  const open = new Set();
  for (const t of Object.values(s.transfers)) if (UNDECIDED_TRANSFER.has(t.state)) { open.add(t.from_edge.edge); open.add(t.to_edge.edge); }
  for (const o of Object.values(s.setoffs)) if (o.state === 'applying' || o.state === 'inconsistent') for (const e of o.edges) open.add(e.edge);
  for (const d of Object.values(s.deals)) if (d.status === 'issuing_note' && d.credit_note) { const k = pilot.noteKeysOf(d); open.add(edgeKey(k.issuer, k.recipient)); }
  if (strict && open.size) violation('I2\'', `${open.size} edge(s) still wait for a novation's or a note's outcome at the end`);
  for (const t of Object.values(s.transfers)) if (t.state === 'inconsistent') violation('I2\'', `transfer ${t.id} is inconsistent (one tracker batch cannot apply half a transfer)`);
  for (const o of Object.values(s.setoffs)) if (o.state === 'inconsistent') violation('I2\'', `set-off ${o.id} is inconsistent (${o.result?.code})`);
  for (const [k, e] of Object.entries(s.edges)) {
    if (open.has(k)) continue;
    const n = byEdge.get(k), total = n ? Number(n.amount_collected) : 0;
    if (total !== e.expected_total) violation('I2\'', `edge ${k}: tracker total ${total}, journal expected_total ${e.expected_total}`);
    else if (n && !(e.last && e.last.total === total && e.last.timestamp === n.timestamp && e.last.signature === n.signature))
      violation('I2\'', `edge ${k}: the tracker's note (total ${total}, timestamp ${n.timestamp}) is not the state the journal's last entry left (${JSON.stringify(e.last && {total: e.last.total, timestamp: e.last.timestamp})})`);
  }
  for (const k of byEdge.keys()) if (!s.edges[k] && !open.has(k)) violation('I2\'', `edge ${k} is on the tracker but not in the journal (written around Valun)`);
  // I3: what each participant owes on the tracker, against its owner's max_issue_outstanding.
  const owes = new Map();
  for (const l of ledger) if (l.issuer) owes.set(l.issuer, (owes.get(l.issuer) ?? 0) + l.outstanding);
  for (const p of Object.values(s.participants)) {
    const o = owes.get(p.id) ?? 0, cap = p.mandate?.max_issue_outstanding;
    if (Number.isFinite(cap) && o > cap) violation('I3', `${p.handle} owes ${o} on the tracker, above its owner's max_issue_outstanding ${cap}`);
  }
  // I6: every applied set-off record balances for each member.
  for (const o of Object.values(s.setoffs)) if (o.state === 'applied') {
    const bal = new Map(), add = (id, v) => bal.set(id, (bal.get(id) ?? 0) + v);
    for (const e of o.edges) { add(e.recipient.id, -e.decrease); add(e.issuer.id, e.decrease); }
    for (const [id, b] of bal) if (b !== 0) violation('I6', `applied set-off ${o.id} changes ${s.participants[id]?.handle ?? id}'s net by ${b}`);
  }
  // I8: every tracker note is between registered keys (the sum of the nets is checked by the caller).
  for (const l of ledger) if (!l.issuer || !l.recipient) violation('I8', `a tracker note between keys no participant registered: ${l.issuer_pubkey}>${l.recipient_pubkey}`);
  // I9: no novation still collecting names a key that is no longer current (a revocation voids them).
  const current = x => { const q = s.participants[x.id]; return q?.status === 'active' && q.pubkey === x.pubkey; };
  for (const t of Object.values(s.transfers)) if ((t.state === 'collecting' || t.state === 'awaiting_owner') && ![t.issuer, t.payer, t.payee].every(current))
    violation('I9', `transfer ${t.id} (${t.state}) names a key that is no longer current`);
  for (const o of Object.values(s.setoffs)) if (o.state === 'collecting' && !o.edges.every(e => current(e.issuer) && current(e.recipient)))
    violation('I9', `set-off ${o.id} (collecting) names a key that is no longer current`);
  // I10: per payee and issuer, the claim on the tracker + committed deals + transfers being collected or applied.
  const exp = new Map(), add = (A, C, k, v) => { const key = `${A}|${C}`, x = exp.get(key) ?? {tracker: 0, committed: 0, pending: 0}; x[k] += v; exp.set(key, x); };
  for (const l of ledger) if (l.issuer && l.recipient) add(l.issuer, l.recipient, 'tracker', l.outstanding);
  for (const d of Object.values(s.deals)) if (statusClass(pilot.sweep(d).status)?.committed) add(d.payer, d.payee, 'committed', d.versions.at(-1).terms.price.amount);
  for (const t of Object.values(s.transfers)) if (LIVE.has(t.state)) add(t.issuer.id, t.payee.id, 'pending', t.amount);
  for (const [key, x] of exp) {
    const [A, Cid] = key.split('|'), C = s.participants[Cid], cap = C?.mandate?.max_accept_per_issuer;
    if (Number.isFinite(cap) && x.tracker + x.committed + x.pending > cap)
      violation('I10', `${C.handle}'s exposure to ${s.participants[A]?.handle ?? A}: tracker ${x.tracker} + committed ${x.committed} + incoming transfers ${x.pending} > max_accept_per_issuer ${cap}`);
  }
  // I11: at most one payment applied per deal, and a paid deal's status says which.
  for (const d of Object.values(s.deals)) {
    const transfers = (d.transfer_ids || []).filter(id => s.transfers[id]?.state === 'applied').length, note = d.credit_note?.state === 'recorded' ? 1 : 0;
    if (transfers + note > 1) violation('I11', `deal ${d.id} was paid ${transfers + note} times (${note} credit note, ${transfers} transfers)`);
    else if (d.status === 'note_issued' ? !(note === 1 && transfers === 0) : d.status === 'paid_by_transfer' ? !(transfers === 1 && note === 0) : transfers + note !== 0)
      violation('I11', `deal ${d.id} is ${d.status} with ${note} credit note and ${transfers} transfers applied`);
  }
}
// The edge journal file at the end: every entry once, its per-edge sums the state's expected totals, set-offs neutral for
// every participant, and at most one payment per deal (I2', I6, I11).
function journalChecks() {
  const file = path.join(storeDir, EDGE_LOG_FILE), s = pilot.s;
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const seqs = lines.map(e => e.seq);
  if (seqs.length !== s.counters.edge_seq || !seqs.every((x, i) => x === i + 1)) violation('I2\'', `the journal file holds seqs ${seqs.length ? `${seqs[0]}..${seqs.at(-1)} (${seqs.length})` : 'none'}, the state counts ${s.counters.edge_seq}`);
  const sums = new Map(), setoffNet = new Map(), paid = new Map(), dealOf = new Map(Object.values(s.transfers).map(t => [t.id, t.deal_id]));
  for (const e of lines) {
    sums.set(e.edge, (sums.get(e.edge) ?? 0) + e.delta);
    if (e.kind === 'setoff') {
      const m = setoffNet.get(e.ref) ?? new Map(), add = (k, v) => { const id = pilot.byPubkey(k)?.id ?? k; m.set(id, (m.get(id) ?? 0) + v); };
      add(e.recipient_pubkey, e.delta); add(e.issuer_pubkey, -e.delta); setoffNet.set(e.ref, m);
    }
    const deal = e.kind === 'issue' ? e.ref : e.kind === 'transfer_in' ? dealOf.get(e.ref) : null;
    if (deal) paid.set(deal, (paid.get(deal) ?? 0) + 1);
  }
  for (const [k, e] of Object.entries(s.edges)) if ((sums.get(k) ?? 0) !== e.expected_total) violation('I2\'', `the journal file sums ${k} to ${sums.get(k) ?? 0}, the state's expected_total is ${e.expected_total}`);
  for (const [ref, m] of setoffNet) for (const [id, v] of m) if (v !== 0) violation('I6', `the journal's set-off ${ref} changes ${id}'s net by ${v}`);
  for (const [deal, n] of paid) if (n > 1) violation('I11', `the edge journal pays deal ${deal} ${n} times`);
  return lines.length;
}
function tails() {
  const alarms = K.pilotLog.filter(l => /ALARM/.test(l));
  return `pilot log (last 8): ${K.pilotLog.slice(-8).map(short).join(' | ')}\nalarms: ${alarms.length}\nsandbox log (last 8): ${K.sandboxLog.slice(-8).map(short).join(' | ')}`;
}

// ---------- the run ----------
async function finish() {
  // Faults off; the sandbox and the engine stop; recovery decides whatever was left applying (as at a restart); then each
  // attempt of unknown outcome is resolved by its payer's owner, as the tracker shows it.
  K.faultsOn = false;
  await forcedUnknowns();                    // a forced fault met at the very end is left of unknown outcome first
  clearing.stop(); sandbox.stop();
  for (let i = 0; i < 800 && (sandbox.busy || clearing.running || clearing.ticking); i++) await sleep(25);
  await pilot.serial(() => {});
  for (let i = 0; i < 4; i++) {
    const r = await internal(() => pilot.recover());
    if (r.error) violation('I1', `recovery failed: ${r.error.message}`);
    if (!Object.values(pilot.s.transfers).some(t => t.state === 'applying') && !Object.values(pilot.s.setoffs).some(o => o.state === 'applying')) break;
  }
  for (const t of Object.values(pilot.s.transfers).filter(x => x.state === 'outcome_unknown' || x.state === 'inconsistent')) {
    const P = K.byId.get(t.payer.id), truth = K.truth.get(t.id);
    if (!P || !truth) { violation('I2\'', `transfer ${t.id} is ${t.state} and the soak cannot resolve it`); continue; }
    const r = await cCall('POST', `/owner/deals/${t.deal_id}/attempts/${t.id}/resolve`, {outcome: truth, note: 'the payee confirmed it'}, P.owner, 'resolve attempt (end)');
    if (r.status === 200) bump(`owner resolved: ${truth}`); else violation('I1', `the owner could not resolve ${t.id}: ${r.status} ${r.body?.error}`);
  }
  await cCheck('the end (recovery done, every attempt resolved)', {strict: true});
  return journalChecks();
}

// What the run did (printed whether it passed or not).
function report(started, journalEntries) {
  const s = pilot?.s;
  if (!s) return;
  const tally = (xs, f) => { const o = {}; for (const x of xs) o[f(x)] = (o[f(x)] || 0) + 1; return o; };
  const deals = Object.values(s.deals), approvals = Object.values(s.approvals);
  console.log(`circulation soak, seed ${SEED}: ${ACTIONS} actions, ${PEOPLE} participants, ${Math.round((Date.now() - started) / 1000)} s; ${K.checks} invariant checks, `
    + `${K.responses} responses scanned, ${K.produced.size} novation signatures followed (seen ${K.sigsSeen} times in responses, each after the tracker applied it), ${journalEntries ?? '?'} journal entries`);
  console.log('deals by status:', JSON.stringify(tally(deals, d => d.status)));
  console.log('transfers by state:', JSON.stringify(tally(Object.values(s.transfers), t => t.state)), '; set-offs by state:', JSON.stringify(tally(Object.values(s.setoffs), o => o.state)));
  console.log(`refused attempts recorded ${deals.reduce((n, d) => n + (d.refused_attempts?.length ?? 0), 0)}; held notes ${approvals.filter(a => a.kind === 'issue_note').length}; `
    + `held payments ${approvals.filter(a => a.kind === 'pay_by_transfer').length}; set-offs applied with a client member `
    + `${Object.values(s.setoffs).filter(o => o.state === 'applied' && o.members.some(id => K.byId.has(id))).length}; expected 502s ${K.expected5xx}; `
    + `alarms ${K.pilotLog.filter(l => /ALARM/.test(l)).length}`);
  console.log('workload:', JSON.stringify(Object.fromEntries([...K.stats].sort())));
  console.log('responses:', JSON.stringify([...statuses].sort((a, b) => b[1] - a[1]).slice(0, 40)));
  if (K.violations.length) console.log(`violations (${K.violations.length}):\n  ${K.violations.slice(0, 30).join('\n  ')}`);
}

if (CIRCULATION) test(`soak in circulation mode: ${ACTIONS} random actions by ${PEOPLE} participants and the sandbox agents (seed ${SEED}); I1, I2', I3, I6-I11 hold after every action`, {timeout: 45 * 60e3}, async () => {
  const started = Date.now();
  for (let i = 0; i < PEOPLE; i++) K.people.push(await cParticipant(i));
  await warmUp();
  await policies();
  await cCheck('setup');
  // Events at fixed points (batch boundaries): clock jumps past each TTL, forced faults whose transfers are then left of
  // unknown outcome (applied at the tracker, and not), and a key rotation.
  const at = f => Math.max(BATCH, Math.round(ACTIONS * f / BATCH) * BATCH);
  const events = new Map();
  for (const [f, ev] of [[0.2, 'jump:transfer_ttl'], [0.25, 'force:after'], [0.4, 'rotate'], [0.45, 'force:before'], [0.6, 'jump:fallback'], [0.7, 'force:after'], [0.85, 'jump:setoff_ttl']])
    events.set(at(f), [...(events.get(at(f)) ?? []), ev]);
  const event = async ev => {
    if (ev.startsWith('jump:')) return clockJump(ev.slice(5));
    if (ev === 'rotate') {
      // A party of a transfer or set-off still collecting, when there is one: the revocation must void it (I9).
      const live = new Set([...Object.values(pilot.s.transfers).filter(t => t.state === 'collecting' || t.state === 'awaiting_owner').flatMap(t => [t.issuer.id, t.payer.id, t.payee.id]),
        ...Object.values(pilot.s.setoffs).filter(o => o.state === 'collecting').flatMap(o => o.members)]);
      const busy = K.people.filter(P => P.agent && live.has(P.id));
      return rotate(pick(busy.length ? busy : K.people.filter(P => P.agent)));
    }
    K.forced.push(ev.slice(6)); return `the next transfer of a soak payer will crash ${ev.slice(6)} the tracker call (queued: ${K.forced.join(', ')})`;
  };
  const one = async n => {
    let what;
    try { what = await cAct(); } catch (e) { violation('client', `action ${n} threw: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); what = 'threw'; }
    bump(`action: ${String(what).split(/[:(]/)[0].trim()}`);
    await cCheck(`action ${n} (${what})`);
  };
  let journalEntries = null;
  try {
    for (let done = 0; done < ACTIONS;) {
      // A transfer a forced fault left applying is left of unknown outcome at once; one a random fault left applying, now
      // and then. Then the scheduled events, and rarely an extra clock jump.
      await forcedUnknowns();
      const faulted = Object.values(pilot.s.transfers).filter(t => t.state === 'applying' && K.byId.has(t.payer.id));
      if (faulted.length && rng() < 0.25) await cCheck(await unknownOutcome(pick(faulted)));
      for (const ev of events.get(done) ?? []) await cCheck(await event(ev));
      if (rng() < 0.015) await cCheck(await clockJump(pick(Object.keys(JUMP))));
      const n = Math.min(BATCH, ACTIONS - done);
      await Promise.all(Array.from({length: n}, (_, j) => one(done + j)));
      done += n;
    }
    journalEntries = await finish();
  } finally { report(started, journalEntries); }      // what the run did, whether it passed or not

  // I4, I5 (as with circulation off), over every deal.
  const s = pilot.s, deals = Object.values(s.deals);
  for (const d of deals.filter(x => x.agreement)) {
    const a = d.agreement, acc = s.participants[a.acceptor];
    assert.notEqual(a.proposer, a.acceptor, `I4: ${d.id} proposer = acceptor`);
    assert.ok([d.payer, d.payee].includes(a.acceptor) && [d.payer, d.payee].includes(a.proposer), `I4: ${d.id} parties`);
    let okSig = false;
    for (const k of [acc.pubkey, ...(acc.past_pubkeys || []).map(x => x.pubkey)].filter(Boolean)) if (await basis.verify(k, hex(statements.accept(a.terms_hash)), a.acceptor_signature)) okSig = true;
    assert.ok(okSig, `I4: ${d.id} acceptor signature over the agreed terms`);
  }
  for (const d of deals.filter(x => x.status === 'note_issued' || x.status === 'paid_by_transfer')) {
    const price = d.agreement.terms.price.amount, P = s.participants[d.payer], Q = s.participants[d.payee];
    assert.ok(price <= P.mandate.max_issue_per_deal, `I5: ${d.id} price ${price} > payer cap ${P.mandate.max_issue_per_deal}`);
    assert.ok(price <= Q.mandate.max_accept_per_deal, `I5: ${d.id} price ${price} > payee cap ${Q.mandate.max_accept_per_deal}`);
  }
  const refusedAttempts = deals.reduce((n, d) => n + (d.refused_attempts?.length ?? 0), 0);
  const heldNotes = Object.values(s.approvals).filter(a => a.kind === 'issue_note').length;
  // The workload exercised what the invariants are about.
  assert.ok(count('tracker applied: transfer') >= 2, `the tracker applied only ${count('tracker applied: transfer')} transfers`);
  assert.ok(count('tracker applied: setoff') >= 1, 'the tracker applied no set-off');
  assert.ok([...K.stats.keys()].some(k => k.startsWith('consent signed: ')), 'no client signed a consent');
  assert.ok(count('owner resolved: applied') >= 1 && count('owner resolved: not_applied') >= 1, `owners resolved attempts of unknown outcome ${count('owner resolved: applied')} times as applied and ${count('owner resolved: not_applied')} times as not applied`);
  assert.ok(refusedAttempts >= 1, 'no refused payment attempt was recorded (decision D-2 b)');
  assert.ok(heldNotes >= 1, 'no credit note was held for its owner (decision D-2 c)');
  assert.ok(count('clock jump') >= 3 && count('engine run') >= 1, 'clock jumps and engine runs');
  assert.ok(K.sigsSeen > 0, 'the I7 scan sees novation signatures in responses (receipts, edge states), so it can see a leak');
  assert.ok(deals.some(d => d.status === 'note_issued') && deals.some(d => d.status === 'paid_by_transfer'), 'deals paid both ways');
  assert.deepEqual(K.violations, []);
});
