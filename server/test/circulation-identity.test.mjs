// Circulating credit, effective mode off (design §4.1, invariant I-DARK): with circulation off, v16 answers exactly like
// v15. Against a real tracker (the old binaries by default; VALUN_BINS picks others) and a Pilot built without any
// circulation option: /info, /me, /owner, deal views, the inbox, the ledger, the credit-note template asked for without
// the new query parameters, and every kind of approval view have exactly v15's keys in v15's order (the lists below are
// written out by hand from release v15), and no mandate has a credit-policy field; the new route and the bound-note
// parameter are refused. migrate() run twice gives the same state, adds the new collections to a v15 state and backfills
// the edge journal to exactly the sums v15's reconciliation computed. The effective mode stays off unless the tracker's
// capabilities validate exactly and its binary's sha256 is pinned, and the log names the reason. Then, against a stub
// tracker, what the other modes add: /info, the credit-policy mandate fields, the edge journal, reconciliation v2,
// positions and GET /edges.
// Tracker port 3152. Run: node --test test/circulation-identity.test.mjs
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Pilot, PilotStore, PILOT_TOKEN_ID, PILOT_DENOMINATION, DEFAULT_MANDATE, termsHash, statements, circulationStatements, NETWORK, PROTOCOL} from '../lib/pilot/core.mjs';
import {validateCaps, effectiveMode, NOVATION_INFO} from '../lib/pilot/caps.mjs';
import {TRACKER_SHA256_PINS} from '../lib/pilot/pins.mjs';
import {appendEntries, journalFor, EDGE_LOG_TAIL} from '../lib/pilot/journal.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

const TRACKER_PORT = 3152, ADMIN = 'identity-admin-secret', ADM = {'x-valun-admin': ADMIN};
const H = 3600e3;
let tracker, server, base, basis, pilot, storeDir;
const dirs = [];
const hex = s => Buffer.from(s, 'utf8').toString('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rnd = n => crypto.randomBytes(n).toString('hex');

before(async () => {
  tracker = await startTracker(TRACKER_PORT, {servedTokenId: PILOT_TOKEN_ID});
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-identity-')); dirs.push(storeDir);
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, denomination: PILOT_DENOMINATION, runSigner: makeSignerRunner({mode: runner, signerPath})});
  pilot = new Pilot({store: new PilotStore(storeDir), basis});               // no circulation option at all: what a v15 server gets
  server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 100000}, adminTokenHash: sha(ADMIN)})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) { server.closeAllConnections?.(); server.close(); }
  await tracker?.stop();
  for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
});

// ---------------------------------------------------------------------------------------------------------------
// v15's keys, in order (lib/pilot/http.mjs and core.mjs of release v15, 495624c / 729a4c1).
const INFO_KEYS = ['network', 'protocol', 'unit', 'denomination', 'tracker_nft_id', 'tracker_on_chain', 'experimental', 'description', 'statements', 'participants'];
const STATEMENT_SOURCES = {
  enroll: '(pid, pubkey, codeHash) => `valun-pilot/enroll/1\\n${NETWORK}\\n${pid}\\n${pubkey}\\n${codeHash}`',
  propose: 'h => `valun-pilot/propose/1\\n${h}`',
  accept: 'h => `valun-pilot/accept/1\\n${h}`',
  decline: '(h, reason) => `valun-pilot/decline/1\\n${h}\\n${sha256(reason)}`',
  withdraw: 'h => `valun-pilot/withdraw/1\\n${h}`',
  deliver: '(h, d) => `valun-pilot/deliver/1\\n${h}\\n${d}`',
  complete: '(h, d) => `valun-pilot/complete/1\\n${h}\\n${d}`',
  dispute: '(h, d, reason) => `valun-pilot/dispute/1\\n${h}\\n${d}\\n${sha256(reason)}`',
};
const MANDATE_KEYS = ['objective', 'may_issue_credit', 'may_accept_credit', 'max_issue_per_deal', 'max_issue_outstanding', 'max_accept_per_deal', 'max_accept_per_issuer',
  'min_price_as_payee', 'min_payer_coverage_pct', 'counterparties', 'approve_above', 'review_deliveries', 'expires_at'];
const CIRCULATION_FIELDS = ['auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from', 'refuse_notes_from', 'pay_with_held_notes'];
const ME_KEYS = ['role', 'participant', 'mandate', 'mandate_version', 'agent_limits', 'agent_limits_recorded_by', 'effective_limits', 'mandate_changed_by', 'position', 'network', 'unit', 'authority'];
const PARTICIPANT_KEYS = ['id', 'handle', 'display_name', 'operator', 'about', 'services', 'pubkey', 'status', 'joined_at', 'agent_last_seen'];
const POSITION_KEYS = ['participant_id', 'unit', 'claims_held', 'owes', 'net', 'claims', 'debts', 'deals', 'settled', 'backing', 'meaning'];
const POSITION_DEAL_KEYS = ['credit_notes_issued', 'open', 'agreed_note_not_issued', 'disputed', 'declined', 'expired_or_withdrawn'];
const POSITION_MEANING = 'claims and debts are outstanding credit notes (cumulative per pair, as the tracker records them). None has been settled: the pilot has no redemption, reserve or clearing.';
const BACKING = 'none: the pilot tracker has no chain and no reserves; PC are simulated units';
const OWNER_KEYS = ['participant', 'mandate', 'mandate_version', 'mandate_changed_by', 'mandate_changed_at', 'agent_limits', 'agent_limits_recorded_by', 'effective_limits',
  'owner_token_rotated_at', 'owner_token_rotated_by', 'agent', 'past_keys', 'approvals', 'deals', 'inbox', 'position'];
const OWNER_AGENT_KEYS = ['enrolled', 'pubkey', 'last_seen', 'enrollment_pending', 'enrollment_expires_at', 'enrollment_issued_by', 'key_registered_at'];
// A deal view; acceptance, agreement and delivery are left out (undefined) while the deal has none.
const DEAL_KEYS = ['id', 'status', 'overdue', 'you', 'your_role', 'counterparty', 'next_actions', 'current', 'pending_counter', 'versions', 'acceptance', 'agreement',
  'delivery_grace_ends_at', 'decline', 'delivery', 'completion', 'dispute', 'credit_note', 'cancellation', 'approvals', 'history', 'labels'];
const LABELS = {
  signed_by_parties: "proposals, acceptances, deliveries, completions and disputes carry the acting participant's key signature",
  owner_approvals: "owner approvals are recorded by the Valun server under the owner token (not key-signed); an owner's note is seen only by that participant's side",
  settlement: 'not settled: issuing a credit note creates an outstanding obligation; the pilot has no redemption, reserve or clearing, so nothing is ever settled here',
  work: "delivery and acceptance are the parties' statements; Valun does not judge the work",
};
const RECORDED_NOTE_KEYS = ['state', 'issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'note', 'prior_total', 'amount', 'signed_at', 'completion', 'outstanding', 'settled',
  'tracker_status', 'recorded_at', 'tracker_note', 'verified_by_valun', 'proof'];
const NOTE_KEYS = ['total', 'timestamp', 'signature', 'message_hex'];
const TRACKER_NOTE_KEYS = ['amount_collected', 'amount_redeemed', 'timestamp', 'signature', 'confirmation'];
const PROOF_KEYS = ['key', 'value', 'proof', 'tracker_state_digest'];
const HELD_NOTE_PAYER_KEYS = ['state', 'issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'note', 'prior_total', 'amount', 'signed_at', 'completion', 'approval_id'];
const HELD_NOTE_PAYEE_KEYS = ['state', 'issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'prior_total', 'amount', 'signed_at', 'note', 'signature_withheld'];
const INBOX_KEYS = ['respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed'];
const BRIEF_KEYS = ['deal_id', 'status', 'counterparty', 'your_role', 'title', 'price', 'version', 'offer_expires_at', 'deliver_by'];
const AWAITING_KEYS = ['approval_id', 'deal_id', 'kind', 'version', 'terms_hash', 'title', 'price'];
const LEDGER_KEYS = ['unit', 'notes', 'reconciliation'];
const LEDGER_NOTE_KEYS = ['issuer', 'issuer_handle', 'recipient', 'recipient_handle', 'issuer_pubkey', 'recipient_pubkey', 'total', 'redeemed', 'outstanding', 'timestamp', 'confirmation', 'unit'];
const RECON_KEYS = ['issuer', 'recipient', 'tracker_total', 'issued_via_valun', 'status'];
const RECON_VALUN_ONLY_KEYS = ['pair', 'tracker_total', 'issued_via_valun', 'status'];
const TEMPLATE_KEYS = ['deal_id', 'terms_hash', 'deliverable_sha256', 'issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'prior_total', 'price', 'total', 'timestamp',
  'tracker_nft_id', 'denomination', 'message_hex'];
const APPROVAL_KEYS = ['id', 'participant', 'deal_id', 'kind', 'version', 'terms_hash', 'created_at', 'state', 'subject', 'mandate_check', 'effect', 'deal'];
const DECIDED_APPROVAL_KEYS = ['id', 'participant', 'deal_id', 'kind', 'version', 'terms_hash', 'created_at', 'state', 'decided_at', 'note', 'subject', 'mandate_check', 'effect', 'deal'];
const SUBJECT_KEYS = {
  propose: ['what', 'version', 'terms', 'terms_hash', 'signer', 'signer_pubkey', 'statement', 'signature', 'signed_at', 'mandate_check', 'countered'],
  accept: ['what', 'version', 'terms', 'terms_hash', 'offered_by', 'offer_signature', 'signer', 'signer_pubkey', 'statement', 'signature', 'signed_at', 'mandate_check'],
  confirm_offer: ['what', 'version', 'terms', 'terms_hash', 'signer', 'signer_pubkey', 'statement', 'signature', 'signed_at', 'mandate_check', 'accepted_by', 'accepted_at',
    'acceptance_state', 'acceptor_owner_must_approve', 'why'],
  issue_note: ['what', 'version', 'terms', 'terms_hash', 'signer', 'signer_pubkey', 'statement', 'signature', 'signed_at', 'mandate_check', 'delivery', 'credit_note'],
};
const SUBJECT_NOTE_KEYS = ['issuer_pubkey', 'recipient_pubkey', 'keys_as_agreed', 'amount', 'prior_total', 'total', 'timestamp', 'message_hex', 'signature', 'signed_at'];
const SUBJECT_DELIVERY_KEYS = ['by', 'title', 'content', 'sha256', 'bytes', 'at', 'late'];
const EFFECT_KEYS = ['if_approved', 'if_rejected', 'checks_on_approve'];
const keys = o => Object.keys(o);

// ---------------------------------------------------------------------------------------------------------------
// HTTP helpers (as in test/robustness.test.mjs)
async function call(method, p, body, token, headers = {}, at = base) {
  const r = await fetch(at + '/pilot/v1' + p, {method, headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {}), ...headers},
    body: body === undefined || body === null ? undefined : JSON.stringify(body)});
  const text = await r.text(); let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: r.status, body: json};
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)?.slice(0, 400)); return r.body; };
const refused = (r, status, code, what = '') => {
  assert.equal(r.status, status, `${what}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);
  assert.equal(r.body?.error, code, `${what}: expected ${code}, got ${JSON.stringify(r.body)?.slice(0, 300)}`);
  return r.body;
};
const TEST_MANDATE = {approve_above: 1000, max_issue_per_deal: 100, max_issue_outstanding: 5000, max_accept_per_deal: 100, max_accept_per_issuer: 5000};
async function newParticipant(handle, mandate = {}) {
  const inv = ok(await call('POST', '/admin/invites', {note: handle}, null, ADM), 201);
  const j = ok(await call('POST', '/join', {invite: inv.code, handle, operator: `identity operator of ${handle}`}), 201);
  const key = await basis.keygen();
  const pop = await basis.signHex(key.pubkey_hex, hex(statements.enroll(j.participant_id, key.pubkey_hex, sha(j.enrollment_code))), key.secret_hex);
  const e = ok(await call('POST', '/enroll', {participant_id: j.participant_id, code: j.enrollment_code, pubkey: key.pubkey_hex, signature: pop}), 201);
  const P = {id: j.participant_id, handle, pubkey: key.pubkey_hex, secret: key.secret_hex, agent: e.agent_token, owner: j.owner_token};
  ok(await call('PUT', '/owner/mandate', {...TEST_MANDATE, ...mandate}, P.owner));
  return P;
}
const sign = (P, stmt) => basis.signHex(P.pubkey, hex(stmt), P.secret);
function terms(proposer, payer, payee, price) {
  const t = Date.now();
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: tracker.nft, denomination: PILOT_DENOMINATION,
    deal_id: 'vd_' + rnd(8), version: 1, prior_terms_hash: null, nonce: rnd(16),
    proposer: proposer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: 'Identity check job', description: 'Summarise three sources on agent credit.', deliverable: 'markdown, under 500 words'},
    price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
    deliver_by: new Date(t + 48 * H).toISOString(), offer_expires_at: new Date(t + 24 * H).toISOString()};
}
async function propose(P, t) { const h = termsHash(t); return call('POST', '/deals', {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent); }
const view = async (P, id) => ok(await call('GET', `/deals/${id}`, null, P.agent));
async function accept(P, id) { const h = (await view(P, id)).current.terms_hash; return call('POST', `/deals/${id}/accept`, {terms_hash: h, signature: await sign(P, statements.accept(h))}, P.agent); }
async function counter(P, id, price) {
  const cur = (await view(P, id)).current;
  const t = {...cur.terms, version: cur.version + 1, prior_terms_hash: cur.terms_hash, nonce: rnd(16), proposer: P.id, price: {amount: price, unit: 'PC'}};
  const h = termsHash(t);
  return call('POST', `/deals/${id}/counter`, {terms: t, terms_hash: h, signature: await sign(P, statements.propose(h))}, P.agent);
}
async function deliver(P, id, content) {
  const h = (await view(P, id)).agreement.terms_hash, dh = sha(content);
  return call('POST', `/deals/${id}/deliver`, {terms_hash: h, content, sha256: dh, signature: await sign(P, statements.deliver(h, dh))}, P.agent);
}
async function complete(P, id) {
  const tpl = ok(await call('GET', `/deals/${id}/credit-note-template`, null, P.agent));
  const {message_hex} = await basis.noteMessage({issuer: tpl.issuer_pubkey, recipient: tpl.recipient_pubkey, total: tpl.total, timestamp: tpl.timestamp});
  return call('POST', `/deals/${id}/complete`, {terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    signature: await sign(P, statements.complete(tpl.terms_hash, tpl.deliverable_sha256)),
    credit_note: {total: tpl.total, timestamp: tpl.timestamp, signature: await basis.signHex(P.pubkey, message_hex, P.secret)}}, P.agent);
}
async function delivered(X, Y, price) {
  const d = ok(await propose(X, terms(X, X, Y, price)), 201);
  assert.equal(ok(await accept(Y, d.id)).status, 'agreed', 'precondition: agreed');
  ok(await deliver(Y, d.id, `work for ${price}`));
  return d.id;
}
const approvalsFor = async (P, dealId) => ok(await call('GET', '/owner', null, P.owner)).approvals.filter(a => a.deal_id === dealId && a.state === 'pending');

function assertDealView(v, what) {
  assert.deepEqual(keys(v), DEAL_KEYS.filter(k => k in v), `${what}: deal view keys`);
  for (const k of DEAL_KEYS.filter(x => !['acceptance', 'agreement', 'delivery'].includes(x))) assert.ok(k in v, `${what}: deal view has ${k}`);
  assert.deepEqual(keys(v.labels), ['signed_by_parties', 'owner_approvals', 'basis', 'settlement', 'work'], `${what}: labels`);
  for (const [k, text] of Object.entries(LABELS)) assert.equal(v.labels[k], text, `${what}: labels.${k} word for word`);
  assert.deepEqual(keys(v.counterparty), PARTICIPANT_KEYS, `${what}: counterparty`);
}
function assertPosition(pos, what) {
  assert.deepEqual(keys(pos), POSITION_KEYS, `${what}: position keys`);
  assert.deepEqual(keys(pos.deals), POSITION_DEAL_KEYS, `${what}: position deal buckets`);
  for (const c of pos.claims) assert.deepEqual(keys(c), ['from', 'amount'], `${what}: claims row`);
  for (const c of pos.debts) assert.deepEqual(keys(c), ['to', 'amount'], `${what}: debts row`);
  assert.equal(pos.settled, 0); assert.equal(pos.backing, BACKING); assert.equal(pos.meaning, POSITION_MEANING, `${what}: meaning word for word`);
}
function assertMandate(m, what) {
  assert.deepEqual(keys(m), MANDATE_KEYS, `${what}: mandate keys`);
  for (const f of CIRCULATION_FIELDS) assert.ok(!(f in m), `${what}: no ${f}`);
}

// =================================================================================================================
// Mode off against a real tracker: v15's keys everywhere
// =================================================================================================================
let A, B, C, D;
test('mode off: /info, /me, /owner, deal views, the inbox, the ledger, the template and every approval view have exactly v15\'s keys; mandates have no credit-policy field', async () => {
  assert.equal(pilot.mode, 'off'); assert.equal(pilot.circulating, false);
  assert.deepEqual(keys(DEFAULT_MANDATE), MANDATE_KEYS, 'DEFAULT_MANDATE is unchanged');
  assert.deepEqual({...DEFAULT_MANDATE}, {objective: '', may_issue_credit: true, may_accept_credit: true, max_issue_per_deal: 25, max_issue_outstanding: 50, max_accept_per_deal: 25,
    max_accept_per_issuer: 50, min_price_as_payee: 0, min_payer_coverage_pct: 0, counterparties: 'any', approve_above: 0, review_deliveries: false, expires_at: null}, '... and so are its values');
  assert.deepEqual(keys(statements), keys(STATEMENT_SOURCES), 'the statements object is unchanged (no pay statement in it)');
  A = await newParticipant('id-ana'); B = await newParticipant('id-ben'); C = await newParticipant('id-cyd');
  D = await newParticipant('id-dee', {approve_above: 0});
  // note_issued deals: A>B 5 + 3, C>A 4
  for (const [X, Y, price] of [[A, B, 5], [A, B, 3], [C, A, 4]]) assert.equal(ok(await complete(X, await delivered(X, Y, price))).status, 'note_issued');
  // a delivered deal, for the template
  const open = await delivered(A, C, 2);
  // a held note (issue_note approval)
  ok(await call('PUT', '/owner/mandate', {review_deliveries: true}, B.owner));
  const held = await delivered(B, C, 6);
  assert.equal(ok(await complete(B, held)).status, 'completion_awaiting_owner');
  // a new proposal held for its owner (propose / new_proposal), then approved (a decided approval)
  const p1 = ok(await propose(D, terms(D, D, A, 4)), 201);
  assert.equal(p1.status, 'proposed_awaiting_owner');
  const p2 = ok(await propose(D, terms(D, D, B, 4)), 201);
  const [a2] = await approvalsFor(D, p2.id);
  ok(await call('POST', `/owner/approvals/${a2.id}`, {decision: 'approve', note: 'fine'}, D.owner));
  // a counter-offer held for its owner (propose / counter_offer)
  const c1 = ok(await propose(A, terms(A, A, D, 9)), 201);
  ok(await counter(D, c1.id, 11));
  // an acceptance held for the acceptor's owner (accept)
  const ac = ok(await propose(A, terms(A, A, D, 7)), 201);
  assert.equal(ok(await accept(D, ac.id)).status, 'accepted_awaiting_owner');
  // an accepted offer held for the proposer's owner, who lowered approve_above meanwhile (confirm_offer)
  const W = await newParticipant('id-wil'), Z = await newParticipant('id-zed');
  const cf = ok(await propose(W, terms(W, W, Z, 50)), 201);
  ok(await call('PUT', '/owner/mandate', {approve_above: 10}, W.owner));
  assert.equal(ok(await accept(Z, cf.id)).status, 'accepted_awaiting_owner');

  // /info
  const info = ok(await call('GET', '/info'));
  assert.deepEqual(keys(info), INFO_KEYS, '/info keys');
  assert.deepEqual(info.statements, STATEMENT_SOURCES, '/info statements: the same source texts');
  // /me, /owner and the public participant
  for (const P of [A, B, C, D, W, Z]) {
    const me = ok(await call('GET', '/me', null, P.agent));
    assert.deepEqual(keys(me), ME_KEYS, `${P.handle} /me`);
    assert.deepEqual(keys(me.participant), PARTICIPANT_KEYS); assertMandate(me.mandate, `${P.handle} /me`); assertMandate(me.effective_limits, `${P.handle} /me effective_limits`);
    assertPosition(me.position, `${P.handle} /me`);
    const o = ok(await call('GET', '/owner', null, P.owner));
    assert.deepEqual(keys(o), OWNER_KEYS, `${P.handle} /owner`);
    assert.deepEqual(keys(o.agent), OWNER_AGENT_KEYS); assertMandate(o.mandate, `${P.handle} /owner`); assertPosition(o.position, `${P.handle} /owner`);
    assert.deepEqual(keys(o.inbox), INBOX_KEYS);
    for (const d of o.deals) assertDealView(d, `${P.handle} /owner deal ${d.status}`);
    for (const a of o.approvals) {
      assert.deepEqual(keys(a), a.state === 'pending' ? APPROVAL_KEYS : DECIDED_APPROVAL_KEYS, `${P.handle} approval ${a.kind} ${a.state}`);
      assert.deepEqual(keys(a.subject), SUBJECT_KEYS[a.kind], `${P.handle} approval ${a.kind}: subject`);
      assert.deepEqual(keys(a.effect), EFFECT_KEYS); assertDealView(a.deal, `${P.handle} approval ${a.kind}: deal`);
      if (a.kind === 'issue_note') { assert.deepEqual(keys(a.subject.credit_note), SUBJECT_NOTE_KEYS); assert.deepEqual(keys(a.subject.delivery), SUBJECT_DELIVERY_KEYS); }
    }
    const pub = ok(await call('GET', `/participants/${P.id}`));
    assert.deepEqual(keys(pub), [...PARTICIPANT_KEYS, 'public_position']); assertPosition(pub.public_position, `${P.handle} public`);
    const ib = ok(await call('GET', '/inbox', null, P.agent));
    assert.deepEqual(keys(ib), INBOX_KEYS, `${P.handle} /inbox`);
    for (const [s, items] of Object.entries(ib)) for (const i of items) assert.deepEqual(keys(i), s === 'awaiting_your_owner' ? AWAITING_KEYS : BRIEF_KEYS, `${P.handle} inbox ${s}`);
  }
  const kinds = new Set();
  for (const P of [B, D, W]) for (const a of ok(await call('GET', '/owner', null, P.owner)).approvals) kinds.add(`${a.kind}/${a.subject.what}/${a.state}`);
  assert.deepEqual([...kinds].sort(), ['accept/acceptance/pending', 'confirm_offer/accepted_offer/pending', 'issue_note/credit_note/pending', 'propose/counter_offer/pending',
    'propose/new_proposal/approved', 'propose/new_proposal/pending'], 'every kind of approval view was looked at');
  // deal views: an issued note (both sides) and a held one (both sides)
  const issued = Object.values(pilot.s.deals).find(d => d.status === 'note_issued' && d.payer === A.id).id;
  for (const P of [A, B]) {
    const v = await view(P, issued);
    assertDealView(v, `${P.handle} issued deal`);
    assert.deepEqual(keys(v.credit_note), RECORDED_NOTE_KEYS, `${P.handle} recorded credit note`);
    assert.deepEqual(keys(v.credit_note.note), NOTE_KEYS); assert.deepEqual(keys(v.credit_note.tracker_note), TRACKER_NOTE_KEYS);
    assert.deepEqual(keys(v.credit_note.proof), PROOF_KEYS); assert.deepEqual(keys(v.credit_note.completion), ['signature', 'deliverable_sha256']);
  }
  const hp = await view(B, held), hc = await view(C, held);
  assertDealView(hp, 'payer of the held note'); assertDealView(hc, 'payee of the held note');
  assert.deepEqual(keys(hp.credit_note), HELD_NOTE_PAYER_KEYS); assert.deepEqual(keys(hp.credit_note.note), NOTE_KEYS);
  assert.deepEqual(keys(hc.credit_note), HELD_NOTE_PAYEE_KEYS); assert.deepEqual(keys(hc.credit_note.note), ['total', 'timestamp', 'signature']);
  assert.equal(hc.credit_note.note.signature, null, 'still withheld from the payee');
  // the ledger
  const led = ok(await call('GET', '/ledger'));
  assert.deepEqual(keys(led), LEDGER_KEYS);
  for (const n of led.notes) assert.deepEqual(keys(n), LEDGER_NOTE_KEYS);
  for (const r of led.reconciliation) { assert.deepEqual(keys(r), RECON_KEYS); assert.equal(r.status, 'match', JSON.stringify(r)); }
  const ab = led.reconciliation.find(r => r.issuer === A.handle && r.recipient === B.handle);
  assert.deepEqual([ab.tracker_total, ab.issued_via_valun], [8, 8]);
  // a pair only Valun records (the tracker row left out of the ledger): v15's {pair, ...} row
  const only = (await pilot.reconcile(led.notes.filter(n => !(n.issuer_pubkey === A.pubkey && n.recipient_pubkey === B.pubkey)))).find(r => r.pair);
  assert.deepEqual(keys(only), RECON_VALUN_ONLY_KEYS);
  assert.deepEqual(only, {pair: `${A.pubkey}>${B.pubkey}`, tracker_total: 0, issued_via_valun: 8, status: 'valun-records-exceed-tracker'});
  // the template asked for without parameters
  const tpl = ok(await call('GET', `/deals/${open}/credit-note-template`, null, A.agent));
  assert.deepEqual(keys(tpl), TEMPLATE_KEYS, 'template keys');
});

test('mode off: GET /edges is a 404 like any unknown route, bound=1 is 409 feature_unavailable, prior=1 adds only prior_note, and the credit-policy fields are ignored like unknown ones', async () => {
  const unknown = refused(await call('GET', '/no-such-route', null, A.agent), 404, 'not_found');
  for (const [tok, who] of [[A.agent, 'agent'], [A.owner, 'owner']]) {
    const r = refused(await call('GET', '/edges', null, tok), 404, 'not_found', `${who}: /edges`);
    assert.deepEqual(r, unknown, `${who}: the same answer as for an unknown route`);
    assert.deepEqual(refused(await call('GET', '/edges?since=3', null, tok), 404, 'not_found'), unknown);
  }
  const id = await delivered(A, B, 3);                                       // A>B already has notes
  const plain = ok(await call('GET', `/deals/${id}/credit-note-template`, null, A.agent));
  const withPrior = ok(await call('GET', `/deals/${id}/credit-note-template?prior=1`, null, A.agent));
  assert.deepEqual(keys(withPrior), [...TEMPLATE_KEYS, 'prior_note'], '?prior=1 adds prior_note at the end');
  const cur = await basis.note(A.pubkey, B.pubkey);
  assert.deepEqual(withPrior.prior_note, {total: Number(cur.amount_collected), timestamp: cur.timestamp, signature: cur.signature}, 'the pair\'s tracker note');
  assert.equal(withPrior.prior_total, plain.prior_total); assert.equal(withPrior.prior_total, 8);
  assert.ok(await basis.verify(A.pubkey, (await basis.noteMessage({issuer: A.pubkey, recipient: B.pubkey, total: withPrior.prior_note.total, timestamp: withPrior.prior_note.timestamp})).message_hex,
    withPrior.prior_note.signature), 'prior_note is self-authenticating: the issuer\'s own signature');
  const fresh = await delivered(C, B, 2);                                    // the tracker has no note for C>B yet
  assert.equal(await basis.note(C.pubkey, B.pubkey), null, 'precondition');
  const none = ok(await call('GET', `/deals/${fresh}/credit-note-template?prior=1`, null, C.agent));
  assert.deepEqual([none.prior_note, none.prior_total], [null, 0], 'no note on the pair: prior_note null');
  assert.equal(ok(await complete(C, fresh)).status, 'note_issued');
  for (const q of ['?bound=1', '?prior=1&bound=1']) refused(await call('GET', `/deals/${id}/credit-note-template${q}`, null, A.agent), 409, 'feature_unavailable', q);
  for (const q of ['?bound=0', '?prior=0', '?prior=true', '?x=1']) assert.deepEqual(keys(ok(await call('GET', `/deals/${id}/credit-note-template${q}`, null, A.agent))), TEMPLATE_KEYS, `${q} is not the opt-in`);
  // PUT /owner/mandate with the credit-policy fields: ignored, as unknown fields are (no change, no new version)
  const o0 = ok(await call('GET', '/owner', null, A.owner));
  const r = ok(await call('PUT', '/owner/mandate', {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'prefer'}, A.owner));
  assert.equal(r.changed, false); assert.equal(r.mandate_version, o0.mandate_version); assertMandate(r.mandate, 'after a PUT with the new fields');
  ok(await call('PUT', '/owner/mandate', {accept_notes_from: 'nonsense', pay_with_held_notes: 42}, A.owner));   // not even validated
  assertMandate(ok(await call('GET', '/me', null, A.agent)).mandate, '/me after');
  assert.equal(ok(await complete(A, id)).status, 'note_issued');
});

test('migrate(): run twice it gives the same state; on a v15 state it adds the new collections and backfills the edge journal to exactly v15\'s reconciliation sums', async () => {
  const s = pilot.s;
  assert.deepEqual(s.transfers, {}); assert.deepEqual(s.setoffs, {}); assert.deepEqual(s.clearing, {runs: [], cooldowns: {}, refusals: []});
  assert.equal(s.counters.journal_backfilled, true);
  const issued = Object.values(s.deals).filter(d => d.status === 'note_issued');
  assert.equal(s.counters.edge_seq, issued.length, 'one journal entry per issued note');
  assert.ok(s.edge_log_tail.every(e => e.kind === 'issue') && issued.every(d => Number.isSafeInteger(d.journal_seq)));
  // v15's reconciliation sums: the prices of note_issued deals per key pair
  const v15 = new Map();
  for (const d of issued) { const k = `${d.credit_note.issuer_pubkey}>${d.credit_note.recipient_pubkey}`; v15.set(k, (v15.get(k) ?? 0) + d.agreement.terms.price.amount); }
  assert.deepEqual(Object.fromEntries(Object.entries(s.edges).map(([k, e]) => [k, e.expected_total])), Object.fromEntries(v15), 'the live journal');
  const led = ok(await call('GET', '/ledger'));
  for (const r of led.reconciliation) {
    const n = led.notes.find(x => x.issuer_handle === r.issuer && x.recipient_handle === r.recipient);
    assert.equal(r.issued_via_valun, v15.get(`${n.issuer_pubkey}>${n.recipient_pubkey}`) ?? 0, `${r.issuer}>${r.recipient}`);
    assert.equal(r.status, 'match');
  }
  // the same state as a v15 server left it: no collections, no journal
  const v15State = structuredClone(s);
  for (const k of ['transfers', 'setoffs', 'clearing', 'edges', 'edge_log_tail', 'counters']) delete v15State[k];
  for (const d of Object.values(v15State.deals)) delete d.journal_seq;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-identity-v15-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify(v15State));
  const fresh = new Pilot({store: new PilotStore(dir), basis});
  const f = fresh.s;
  assert.deepEqual([f.transfers, f.setoffs, f.clearing], [{}, {}, {runs: [], cooldowns: {}, refusals: []}], 'the collections are added');
  for (const p of Object.values(f.participants)) assertMandate(p.mandate, `${p.handle} after migrate() in mode off`);
  assert.deepEqual(Object.values(f.participants).map(p => p.mandate), Object.values(v15State.participants).map(p => p.mandate), 'mandates are not touched in mode off');
  assert.deepEqual(f.counters, {edge_seq: issued.length, journal_backfilled: true});
  // backfill order: credit_note.recorded_at, then the deal id
  const order = [...issued].sort((x, y) => (x.credit_note.recorded_at < y.credit_note.recorded_at ? -1 : x.credit_note.recorded_at > y.credit_note.recorded_at ? 1 : x.id < y.id ? -1 : 1));
  assert.deepEqual(f.edge_log_tail.map(e => [e.seq, e.kind, e.ref]), order.map((d, i) => [i + 1, 'backfill', d.id]));
  for (const e of f.edge_log_tail) {
    const d = f.deals[e.ref];
    assert.deepEqual([e.edge, e.delta, e.total_after, e.timestamp, e.signature, e.at],
      [`${d.credit_note.issuer_pubkey}>${d.credit_note.recipient_pubkey}`, d.agreement.terms.price.amount, d.credit_note.tracker_note.amount_collected,
        d.credit_note.tracker_note.timestamp, d.credit_note.tracker_note.signature, d.credit_note.recorded_at], `backfill entry for ${d.id}`);
    assert.equal(d.journal_seq, e.seq);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(f.edges).map(([k, e]) => [k, e.expected_total])), Object.fromEntries(v15), 'the backfill equals v15\'s sums');
  for (const [k, e] of Object.entries(f.edges)) {
    assert.deepEqual([e.issued_PC, e.setoff_PC, e.transferred_in_PC, e.transferred_out_PC, e.novated], [v15.get(k), 0, 0, 0, false]);
    assert.deepEqual(e.last, s.edges[k].last, `${k}: the same last state as the live journal`);
  }
  const ledger = await fresh.ledger();
  assert.deepEqual(await fresh.reconcile(ledger), await pilot.reconcile(ledger), 'reconciliation from the backfilled journal = from the live one');
  assert.deepEqual(await fresh.reconcile(ledger), led.reconciliation, '... = what GET /ledger shows');
  const lines = fs.readFileSync(path.join(dir, 'pilot-edge-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, f.edge_log_tail, 'the backfill is in pilot-edge-log.jsonl');
  // twice: nothing changes, in memory or after a restart
  const once = structuredClone(f), file1 = fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8');
  fresh.migrate();
  assert.deepEqual(fresh.s, once, 'migrate() again: the same state');
  assert.equal(fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8'), file1, 'and nothing written');
  assert.deepEqual(new Pilot({store: new PilotStore(dir), basis}).s, once, 'a restart: the same state');
  assert.equal(fs.readFileSync(path.join(dir, 'pilot-edge-log.jsonl'), 'utf8').trim().split('\n').length, issued.length, 'no entry written twice');
  // a deal a release without the journal issued later (a rollback) is journaled at the next start; nothing else is
  const extra = structuredClone(order.at(-1));
  extra.id = 'vd_' + 'e'.repeat(16); delete extra.journal_seq; extra.credit_note.recorded_at = new Date(Date.now() + 1000).toISOString();
  const later = JSON.parse(fs.readFileSync(path.join(dir, 'pilot-state.json'), 'utf8'));
  later.deals[extra.id] = extra;
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify(later));
  const caught = new Pilot({store: new PilotStore(dir), basis}).s;
  assert.equal(caught.counters.edge_seq, issued.length + 1);
  assert.deepEqual([caught.edge_log_tail.at(-1).kind, caught.edge_log_tail.at(-1).ref], ['backfill', extra.id]);
  const k = `${extra.credit_note.issuer_pubkey}>${extra.credit_note.recipient_pubkey}`;
  assert.equal(caught.edges[k].expected_total, v15.get(k) + extra.agreement.terms.price.amount);
});

test('state from the first pilot version (no keys on the deal) migrates as before; its deal is not journaled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-identity-legacy-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify({version: 1, participants: {}, approvals: {}, invites: {},
    deals: {vd_1: {id: 'vd_1', status: 'paid', versions: [{v: 1, by: 'vp_aaaaaaaaaaaa', state: 'accepted', created_at: '2026-11-01T00:00:00.000Z', terms: {price: {amount: 5, unit: 'PC'}}}],
      agreement: {terms: {price: {amount: 5, unit: 'PC'}}}, payment: {state: 'recorded', prior_total: 0}}}}));
  const pl = new Pilot({store: new PilotStore(dir), basis: {}});
  assert.equal(pl.s.deals.vd_1.status, 'note_issued');
  assert.deepEqual(pl.s.edges, {}); assert.equal(pl.s.counters.edge_seq, 0); assert.equal(pl.s.counters.journal_backfilled, true);
  const again = structuredClone(pl.s); pl.migrate(); assert.deepEqual(pl.s, again);
});

// =================================================================================================================
// The effective mode (lib/pilot/caps.mjs): fail closed, with the reason in the log
// =================================================================================================================
// What tracker v3.2 answers (spec 18.2; bound notes version 3 with their maximum age, decision D-1 item 1, and transfers
// version 4, both with the prior acknowledgment basis/prior-ack/1, design v3.2 section 3); `commit` is informative.
const V3_CAPS = Object.freeze({tracker: 'basis', build: 'valun-circulating-credit/4', commit: '43704183e1ba372e1b1788c414dfe4c8b0bc3f2a', pure_credit: true,
  reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000,
    transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 0, novations_disabled_reason: null});
const PIN = 'ab'.repeat(32);
const caps = (f = c => c) => { const c = structuredClone(V3_CAPS); f(c); return c; };
const NFT = '0'.repeat(64), KEY = () => '02' + rnd(32), SIG = () => '02' + rnd(64);
// A Pilot over a throwaway store and a stub tracker (no tracker, no signer): `notes` are the tracker's notes.
// `trackerCaps` may be given as undefined (not read yet); left out, it is V3_CAPS.
function stub(opts = {}) {
  const {circulation = 'off', sha256 = PIN, pins = [PIN], notes = [], openSandbox = false} = opts;
  const trackerCaps = Object.hasOwn(opts, 'trackerCaps') ? opts.trackerCaps : V3_CAPS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-identity-stub-')); dirs.push(dir);
  const logs = [];
  const basis = {nft: NFT, denomination: PILOT_DENOMINATION, allNotes: async () => notes, capabilities: async () => trackerCaps,
    note: async (i, r) => notes.find(n => n.issuer_pubkey === i && n.recipient_pubkey === r) ?? null,
    noteMessage: async ({total, timestamp}) => ({message_hex: `${total}:${timestamp}`}), verify: async () => true};
  const pilot = new Pilot({store: new PilotStore(dir), basis, circulation, trackerCaps, trackerSha256: sha256, trackerPins: pins, openSandbox, log: m => logs.push(m)});
  return {pilot, logs, dir, notes};
}
async function enrolled(pl, handle) {
  const inv = pl.createInvite({note: handle});
  const j = await pl.join({invite: inv.code, handle, operator: 'identity test'});
  const pubkey = KEY(), e = await pl.enroll({participant_id: j.participant_id, code: j.enrollment_code, pubkey, signature: SIG()});
  return {p: pl.s.participants[j.participant_id], id: j.participant_id, handle, pubkey, agent: e.agent_token, owner: j.owner_token};
}
const trackerNote = (issuer, recipient, total, timestamp, signature = SIG()) => ({issuer_pubkey: issuer, recipient_pubkey: recipient, amount_collected: total, amount_redeemed: 0,
  timestamp, signature, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, confirmation: {status: 'local_only'}});

test('the effective mode is off unless the capabilities have exactly the v3.2 values and the binary is pinned; any differing field turns it off and the log names it, once', () => {
  assert.deepEqual(validateCaps(V3_CAPS), {ok: true, reason: null});
  assert.deepEqual(TRACKER_SHA256_PINS, ['e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5',
    '6e410ab45a1a4a91efaa76ffd9d72acfc5c440ae4a4a553aad32ba1926a6849e', 'd13541944f0bffa2e4d78acea0ca4f7e351e28a4adb95fedc186f0e2b927bb77',
    'b3e1a9b8cf72f77a3505f5073e680759539eeefd24e93b4f689798e6d9f03850', '9a114a1c3e3450add249701929c3445d19e68ae3992ad3d55ab6d3d3a59e1fb9',
    'e417c4b8d9c82f32cd4454e827c36358c666f6bf49df522716ac750d29de5dc5'],
    'the basis_server sha256 of tracker v3.2, v4, v4.1, v4.2, v4.3 and v4.4 (v3.1 is not pinned)');
  for (const mode of ['bound', 'sandbox', 'on']) {
    const {pilot: pl, logs} = stub({circulation: mode});
    assert.equal(pl.mode, mode); assert.equal(pl.circulating, mode !== 'bound'); assert.deepEqual(logs, []);
  }
  // every required field, changed, removed or of another type
  const variants = [
    ['build', c => { c.build = 'valun-circulating-credit/2'; }], ['build', c => { delete c.build; }],
    ['pure_credit', c => { c.pure_credit = false; }], ['pure_credit', c => { c.pure_credit = 'true'; }],
    ['reserved_ms', c => { c.reserved_ms = [995, 996, 997, 998]; }], ['reserved_ms', c => { c.reserved_ms = [999, 998, 997, 996, 995]; }], ['reserved_ms', c => { c.reserved_ms = [995, 996, '997', 998, 999]; }],
    ['build', c => { c.build = 'valun-circulating-credit/3'; }],
    ['bound_notes.ms', c => { c.bound_notes.ms = 996; }], ['bound_notes.version', c => { c.bound_notes.version = 1; }], ['bound_notes.version', c => { c.bound_notes.version = 2; }],
    ['bound_notes.version', c => { c.bound_notes.version = 4; }], ['bound_notes.version', c => { c.bound_notes.version = '3'; }],
    ['bound_notes.ms', c => { c.bound_notes = null; }],
    ['bound_notes.max_age_ms', c => { delete c.bound_notes.max_age_ms; }], ['bound_notes.max_age_ms', c => { c.bound_notes.max_age_ms = 7200000; }],
    ['bound_notes.prior_ack', c => { delete c.bound_notes.prior_ack; }], ['bound_notes.prior_ack', c => { c.bound_notes.prior_ack = 'basis/prior-ack/2'; }],
    ['bound_only_edges', c => { c.bound_only_edges = false; }],
    ['novation.max_age_ms', c => { c.novation.max_age_ms = 7200000; }], ['novation.max_age_ms', c => { delete c.novation; }],
    ['novation.transfer.ms', c => { c.novation.transfer.ms = 998; }], ['novation.transfer.version', c => { c.novation.transfer.version = 2; }],
    ['novation.transfer.version', c => { c.novation.transfer.version = 3; }],
    ['novation.transfer.prior_ack', c => { delete c.novation.transfer.prior_ack; }], ['novation.transfer.prior_ack', c => { c.novation.transfer.prior_ack = null; }],
    ['novation.transfer.signatures', c => { c.novation.transfer.signatures.pop(); }], ['novation.transfer.signatures', c => { c.novation.transfer.signatures.reverse(); }],
    ['novation.transfer.signatures', c => { c.novation.transfer.signatures = c.novation.transfer.signatures.filter(x => !x.endsWith('_prior')); }],
    ['novation.setoff.ms', c => { c.novation.setoff.ms = 999; }], ['novation.setoff.version', c => { c.novation.setoff.version = 2; }],
    ['novation.setoff.signatures_per_edge', c => { c.novation.setoff.signatures_per_edge = ['issuer']; }],
    ['onchain_edges', c => { c.onchain_edges = 1; }], ['onchain_edges', c => { delete c.onchain_edges; }],
    ['novations_disabled_reason', c => { c.novations_disabled_reason = 'confirmations failed to load'; }], ['novations_disabled_reason', c => { delete c.novations_disabled_reason; }],
  ];
  for (const [field, change] of variants) {
    const bad = caps(change), v = validateCaps(bad);
    assert.equal(v.ok, false, field); assert.match(v.reason, new RegExp(`^tracker capabilities: ${field.replace(/\./g, '\\.')} is `), `${field}: ${v.reason}`);
    for (const mode of ['bound', 'sandbox', 'on']) {
      const {pilot: pl, logs} = stub({circulation: mode, trackerCaps: bad});
      assert.equal(pl.mode, 'off', `${field} -> off (${mode})`); assert.equal(pl.mode, 'off');
      assert.equal(logs.length, 1, `${field}: logged once, ${JSON.stringify(logs)}`);
      assert.ok(logs[0].includes(field) && logs[0].includes(`"${mode}"`) && logs[0].includes('fail closed'), logs[0]);
    }
  }
  // informative fields may differ
  for (const change of [c => { c.commit = 'unknown'; }, c => { c.novation.setoff.max_edges = 32; }, c => { c.novation.setoff.per_edge_timestamps = false; }, c => { c.extra = 1; }])
    assert.equal(stub({circulation: 'on', trackerCaps: caps(change)}).pilot.mode, 'on');
  // Tracker v3.1 as it answers (its prior acknowledgments bind only the total, audit VS-1): off, fail closed, and the
  // reason says why, even with its binary's hash pinned.
  const V31 = caps(c => {
    c.build = 'valun-circulating-credit/3'; c.commit = '24675ec1c0f374f29101812caf2fc87ab48468c9';
    c.bound_notes = {ms: 997, version: 2, max_age_ms: 3600000}; c.novation.transfer.version = 3; delete c.novation.transfer.prior_ack;
  });
  const v31 = validateCaps(V31);
  assert.equal(v31.ok, false);
  assert.equal(v31.reason, 'tracker capabilities: build is "valun-circulating-credit/3", expected "valun-circulating-credit/4" (a tracker v3 or v3.1: its prior acknowledgments bind only the prior total, not the prior state, audit VS-1; circulating credit needs tracker v3.2, basis/prior-ack/1)');
  for (const mode of ['bound', 'sandbox', 'on']) {
    const {pilot: pl, logs} = stub({circulation: mode, trackerCaps: V31, sha256: 'cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8',
      pins: ['cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8']});
    assert.equal(pl.mode, 'off', `tracker v3.1 -> off (${mode})`);
    assert.equal(logs.length, 1); assert.ok(logs[0].includes('audit VS-1') && logs[0].includes('fail closed'), logs[0]);
    assert.match(pl.circulationStatus().reason, /tracker v3\.2/);
  }
  // no capabilities, the binary, the requested value
  const cases = [
    [{trackerCaps: null}, /no capabilities/], [{trackerCaps: 'yes'}, /not an object/], [{trackerCaps: []}, /not an object/],
    [{sha256: null}, /PILOT_TRACKER_SHA256 is not set/], [{sha256: 'cd'.repeat(32)}, /is not pinned/], [{pins: []}, /is not pinned/],
    [{circulation: 'yes'}, /PILOT_CIRCULATION is "yes"/], [{circulation: 'ON'}, /must be one of off, bound, sandbox, on/],
  ];
  for (const [opts, reason] of cases) {
    const {pilot: pl, logs} = stub({circulation: 'sandbox', ...opts});
    assert.equal(pl.mode, 'off', JSON.stringify(opts)); assert.equal(logs.length, 1, JSON.stringify(logs)); assert.match(logs[0], reason);
    assert.match(pl.circulationStatus().reason, reason);
  }
  assert.equal(stub({circulation: 'on', sha256: ` ${PIN.toUpperCase()}\n`}).pilot.mode, 'on', 'the hash as a launcher prints it');
  // not read yet (a server that is starting): off, and nothing logged until they are
  const {pilot: starting, logs} = stub({circulation: 'bound', trackerCaps: undefined});
  assert.equal(starting.mode, 'off'); assert.deepEqual(logs, []); assert.equal(starting.circulationStatus().pending, true);
  starting.trackerCaps = caps(c => { c.pure_credit = false; });
  assert.equal(starting.mode, 'off'); assert.equal(logs.length, 1); assert.match(logs[0], /pure_credit/);
  starting.trackerCaps = V3_CAPS;
  assert.equal(starting.mode, 'bound', 'set once the capabilities are read');
  // off was asked for: nothing to say
  const {pilot: off, logs: quiet} = stub({circulation: 'off', trackerCaps: null, sha256: null});
  assert.equal(off.mode, 'off'); assert.deepEqual(quiet, []);
  assert.deepEqual(effectiveMode({requested: 'off', caps: V3_CAPS, sha256: PIN, pins: [PIN]}), {requested: 'off', mode: 'off', reason: null, pending: false});
});

test('/info: in mode off exactly v15\'s; from mode bound up it adds features, novation and circulation_statements; the pay statement is not in `statements`', async () => {
  const pay = circulationStatements.pay('vd_0123456789abcdef', 'f'.repeat(64));
  assert.equal(pay, `valun-pilot/pay/1\nvd_0123456789abcdef\n${'f'.repeat(64)}`); assert.equal(Buffer.byteLength(pay), 102);
  for (const [mode, features] of [['off', null], ['bound', ['bound_notes/1']], ['sandbox', ['bound_notes/1', 'circulation/1']], ['on', ['bound_notes/1', 'circulation/1']]]) {
    const {pilot: pl} = stub({circulation: mode});
    const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot: pl, cfg: {pilotRateLimitPerMinute: 100000}})}));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const info = ok(await call('GET', '/info', null, null, {}, `http://127.0.0.1:${srv.address().port}`));
      assert.deepEqual(info.statements, STATEMENT_SOURCES, mode);
      if (!features) { assert.deepEqual(keys(info), INFO_KEYS); continue; }
      assert.deepEqual(keys(info), [...INFO_KEYS, 'features', 'novation', 'circulation_statements'], mode);
      assert.deepEqual(info.features, features);
      // Since tracker v3.2 also the contract the 0.4 clients require before they sign a prior acknowledgment (valun-open
      // novation CONTRACT: these values with these JSON types), in mode bound too.
      assert.deepEqual(info.novation, {transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000,
        transfer_ttl_ms: 1200000, setoff_ttl_ms: 1800000, fallback_margin_ms: 60000,
        tracker_build: 'valun-circulating-credit/4', transfer_version: 4, bound_note_version: 3, prior_ack: 'basis/prior-ack/1'}, mode);
      assert.deepEqual(info.novation, JSON.parse(JSON.stringify(NOVATION_INFO)));
      assert.deepEqual(info.circulation_statements, {pay: '(dealId, quoteDigest) => `valun-pilot/pay/1\\n${dealId}\\n${quoteDigest}`'});
    } finally { srv.closeAllConnections?.(); srv.close(); }
  }
});

// =================================================================================================================
// Modes sandbox and on: the credit-policy mandate fields
// =================================================================================================================
test('credit-policy mandate fields: filled with LEGACY values by migrate(), set by join() and joinSandbox(), validated and compared by setMandate(), only in mode sandbox or on', async () => {
  const {pilot: pl} = stub({circulation: 'off', openSandbox: true});
  const old = await enrolled(pl, 'cp-old');
  assertMandate(old.p.mandate, 'mode off');
  pl.circulation = 'bound';
  assertMandate(old.p.mandate, 'mode bound');
  const v0 = old.p.mandate_version, before = structuredClone(pl.s);
  pl.circulation = 'sandbox';                                    // switching the mode runs migrate()
  assert.deepEqual(CIRCULATION_FIELDS.map(f => old.p.mandate[f]), [false, false, false, [], [], 'never'], 'LEGACY values for who joined before');
  assert.deepEqual(keys(old.p.mandate), [...MANDATE_KEYS, ...CIRCULATION_FIELDS]); assert.equal(old.p.mandate_version, v0, 'no new mandate version');
  const once = structuredClone(pl.s); pl.migrate(); assert.deepEqual(pl.s, once, 'idempotent');
  assert.notDeepEqual(before.participants, once.participants);
  const inv = await enrolled(pl, 'cp-new');
  assert.deepEqual(CIRCULATION_FIELDS.map(f => inv.p.mandate[f]), [true, true, false, [], [], 'when_asked'], 'an invited joiner');
  pl.sandboxIds = new Set([old.id, inv.id]);
  const sb = await pl.joinSandbox({handle: 'cp-sandbox'}), sp = pl.s.participants[sb.participant_id];
  assert.deepEqual(CIRCULATION_FIELDS.map(f => sp.mandate[f]), [true, true, true, [old.id, inv.id], [], 'when_asked'], 'a sandbox joiner');
  assert.equal(sp.mandate_version, 2, 'one change, as before: the sandbox mandate');
  // validation
  const bad = [[{auto_clear: 'yes'}, /auto_clear must be true or false/], [{novate_own_debt: 1}, /novate_own_debt/], [{accept_transfers: null}, /accept_transfers/],
    [{accept_notes_from: 'all'}, /accept_notes_from must be "any" or a list/], [{accept_notes_from: ['vp_000000000000']}, /accept_notes_from/], [{accept_notes_from: [old.id, 7]}, /accept_notes_from/],
    [{refuse_notes_from: 'any'}, /refuse_notes_from must be a list/], [{pay_with_held_notes: 'always'}, /pay_with_held_notes must be never, when_asked, prefer/]];
  for (const [m, msg] of bad) assert.throws(() => pl.setMandate(inv.p, m), e => e.code === 'invalid_field' && msg.test(e.message), JSON.stringify(m));
  let r = pl.setMandate(inv.p, {accept_transfers: true, accept_notes_from: [old.id, sp.id, old.id], refuse_notes_from: [sp.id], pay_with_held_notes: 'prefer', auto_clear: false});
  assert.equal(r.changed, true);
  assert.deepEqual(CIRCULATION_FIELDS.map(f => inv.p.mandate[f]), [false, true, true, [old.id, sp.id], [sp.id], 'prefer'], 'stored (lists without repeats)');
  r = pl.setMandate(inv.p, {accept_notes_from: [sp.id, old.id], refuse_notes_from: [sp.id]});
  assert.equal(r.changed, false, 'the same lists in another order are no change');
  assert.equal(pl.setMandate(inv.p, {accept_notes_from: 'any'}).mandate.accept_notes_from, 'any');
  assert.equal(pl.setMandate(inv.p, {accept_notes_from: []}).mandate.accept_notes_from.length, 0, '[] = nobody');
  // a sandbox participant's box: accept_notes_from stays a subset of the sandbox agents
  assert.throws(() => pl.setMandate(sp, {accept_notes_from: 'any'}), e => e.code === 'sandbox_only' && /accept notes issued by the sandbox agents/.test(e.message));
  assert.throws(() => pl.setMandate(sp, {accept_notes_from: [old.id, sp.id]}), e => e.code === 'sandbox_only');
  assert.equal(pl.setMandate(sp, {accept_notes_from: [inv.id]}).changed, true, 'narrowing is allowed');
  assert.equal(pl.setMandate(sp, {accept_notes_from: [old.id, inv.id]}, {by: 'operator'}).changed, true, 'the operator may widen it');
  // back to mode bound: the fields stay as they are and are ignored
  pl.circulation = 'bound';
  const m0 = structuredClone(inv.p.mandate);
  assert.equal(pl.setMandate(inv.p, {accept_transfers: false, pay_with_held_notes: 'never'}).changed, false);
  assert.deepEqual(inv.p.mandate, m0);
  const later = await enrolled(pl, 'cp-later');
  assertMandate(later.p.mandate, 'a joiner in mode bound');
});

// =================================================================================================================
// The edge journal, reconciliation v2, positions and GET /edges (stub tracker)
// =================================================================================================================
test('edge journal: entries, edge totals, the last state, the 500-entry tail, pilot-edge-log.jsonl after the save, and paging', async () => {
  const {pilot: pl, dir} = stub({circulation: 'on'});
  const a = await enrolled(pl, 'j-a'), b = await enrolled(pl, 'j-b'), c = await enrolled(pl, 'j-c');
  const ab = `${a.pubkey}>${b.pubkey}`, ac = `${a.pubkey}>${c.pubkey}`;
  const w = appendEntries(pl, [{kind: 'issue', ref: 'vd_1', issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta: 5, total_after: 5, timestamp: 1000, signature: 'sig1'},
    {kind: 'transfer_out', ref: 'vt_1', issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta: -2, total_after: 3, timestamp: 2999, signature: 'sig2'},
    {kind: 'transfer_in', ref: 'vt_1', issuer_pubkey: a.pubkey, recipient_pubkey: c.pubkey, delta: 2, total_after: 2, timestamp: 2999, signature: 'sig3'},
    {kind: 'setoff', ref: 'vs_1', issuer_pubkey: a.pubkey, recipient_pubkey: c.pubkey, delta: -1, total_after: 1, timestamp: 3998, signature: 'sig4'}]);
  assert.deepEqual(w.map(e => [e.seq, e.kind, e.edge]), [[1, 'issue', ab], [2, 'transfer_out', ab], [3, 'transfer_in', ac], [4, 'setoff', ac]]);
  assert.deepEqual(keys(w[0]), ['seq', 'at', 'kind', 'ref', 'edge', 'issuer_pubkey', 'recipient_pubkey', 'delta', 'total_after', 'timestamp', 'signature']);
  assert.deepEqual(pl.s.edges[ab], {issuer: a.id, recipient: b.id, expected_total: 3, issued_PC: 5, setoff_PC: 0, transferred_in_PC: 0, transferred_out_PC: 2, novated: true,
    last: {total: 3, timestamp: 2999, signature: 'sig2'}, last_seq: 2});
  assert.deepEqual(pl.s.edges[ac], {issuer: a.id, recipient: c.id, expected_total: 1, issued_PC: 0, setoff_PC: 1, transferred_in_PC: 2, transferred_out_PC: 0, novated: true,
    last: {total: 1, timestamp: 3998, signature: 'sig4'}, last_seq: 4});
  // an entry older than the edge's last state (a late backfill) does not replace it
  appendEntries(pl, [{kind: 'backfill', ref: 'vd_0', issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta: 1, total_after: 1, timestamp: 500, signature: 'old'}]);
  assert.deepEqual(pl.s.edges[ab].last, {total: 3, timestamp: 2999, signature: 'sig2'}); assert.equal(pl.s.edges[ab].expected_total, 4); assert.equal(pl.s.edges[ab].last_seq, 5);
  for (const bad of [{kind: 'gift'}, {kind: 'issue', delta: -1}, {kind: 'setoff', delta: 1}, {kind: 'transfer_out', delta: 0}, {kind: 'issue', delta: 1.5}, {kind: 'issue', delta: 1, issuer_pubkey: 'x'}])
    assert.throws(() => appendEntries(pl, [{issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, ...bad}]), TypeError, JSON.stringify(bad));
  // the log file is written after the save that holds the entries
  const log = () => { try { return fs.readFileSync(path.join(dir, 'pilot-edge-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const before = log().length;
  appendEntries(pl, [{kind: 'issue', ref: 'vd_2', issuer_pubkey: b.pubkey, recipient_pubkey: c.pubkey, delta: 3, total_after: 3, timestamp: 4000, signature: 'sig5'}]);
  assert.equal(log().length, before, 'not before the save');
  pl.save();
  assert.deepEqual(log().map(e => e.seq), [...Array(6).keys()].map(i => i + 1), 'every entry, once, in order');
  // the tail keeps the last 500; journalFor pages through everything, the file filling in what the tail dropped
  for (let i = 0; i < 520; i++) appendEntries(pl, [{kind: 'issue', ref: `vd_x${i}`, issuer_pubkey: c.pubkey, recipient_pubkey: a.pubkey, delta: 1, total_after: i + 1, timestamp: 5000 + i, signature: `s${i}`}]);
  pl.save();
  assert.equal(pl.s.edge_log_tail.length, EDGE_LOG_TAIL); assert.equal(pl.s.edge_log_tail[0].seq, 527 - EDGE_LOG_TAIL); assert.equal(pl.s.counters.edge_seq, 526);
  const seen = [];
  for (let since = 0, guard = 0; guard < 10; guard++) {
    const {entries, next_seq} = journalFor(pl, new Set([a.pubkey]), {since});
    seen.push(...entries.map(e => e.seq));
    if (next_seq === pl.s.counters.edge_seq && entries.length < 200) break;
    assert.ok(entries.length === 200 && next_seq === entries.at(-1).seq, 'a full page ends at its last seq');
    since = next_seq;
  }
  const aEntries = log().filter(e => e.issuer_pubkey === a.pubkey || e.recipient_pubkey === a.pubkey).map(e => e.seq);
  assert.deepEqual(seen, aEntries, "every one of a's entries, in order, none twice");
  assert.deepEqual(journalFor(pl, new Set([b.pubkey]), {since: 5}).entries.map(e => e.seq), [6]);
  assert.deepEqual(journalFor(pl, new Set([b.pubkey]), {since: 6}), {entries: [], next_seq: 526});
});

test('edge journal: at startup, entries a crash kept out of pilot-edge-log.jsonl are appended to it (after a line cut short), once', async () => {
  const {pilot: pl, dir} = stub({circulation: 'on'});
  const a = await enrolled(pl, 'jr-a'), b = await enrolled(pl, 'jr-b');
  const file = path.join(dir, 'pilot-edge-log.jsonl'), lines = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const parsed = () => lines().flatMap(l => { try { return [JSON.parse(l).seq]; } catch { return []; } });
  const entry = (ref, delta, total, ts) => ({kind: 'issue', ref, issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta, total_after: total, timestamp: ts, signature: `sig-${ref}`});
  appendEntries(pl, [entry('vd_1', 2, 2, 1000)]);
  pl.save();                                                           // entry 1: in the state and in the log
  appendEntries(pl, [entry('vd_2', 3, 5, 2000), entry('vd_3', 1, 6, 3000)]);
  pl.store.save();                                                     // the state is saved, then the process stops...
  fs.appendFileSync(file, '{"seq":2,"at":"20');                        // ...in the middle of the log append
  assert.deepEqual(parsed(), [1]);
  const restart = () => new Pilot({store: new PilotStore(dir), basis: pl.basis, circulation: 'on', trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const again = restart();
  assert.deepEqual(parsed(), [1, 2, 3], 'the two entries the state holds are in the log now, after the cut line');
  assert.equal(lines().length, 4, 'the cut line stays on a line of its own');
  assert.deepEqual(again.s.edge_log_tail.map(e => e.seq), [1, 2, 3]);
  restart();
  assert.deepEqual(parsed(), [1, 2, 3], 'nothing is appended twice');
  const audit = fs.readFileSync(path.join(dir, 'pilot-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(audit.filter(x => x.type === 'journal.log_repaired').map(x => x.entries), [2]);
});

test('reconciliation v2, positions and GET /edges with circulation on; in mode off the same journal gives v15\'s rows', async () => {
  const notes = [];
  const {pilot: pl} = stub({circulation: 'on', notes});
  const a = await enrolled(pl, 'r-a'), b = await enrolled(pl, 'r-b'), c = await enrolled(pl, 'r-c');
  const sig = {ab: SIG(), ac: SIG(), ca: SIG()};
  // A>B: issued 5, 2 transferred to C; A>C: 2 transferred in; C>A: issued 3, then a note around Valun raised it to 4
  appendEntries(pl, [{kind: 'issue', ref: 'vd_1', issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta: 5, total_after: 5, timestamp: 1000, signature: SIG()},
    {kind: 'transfer_out', ref: 'vt_1', issuer_pubkey: a.pubkey, recipient_pubkey: b.pubkey, delta: -2, total_after: 3, timestamp: 2999, signature: sig.ab},
    {kind: 'transfer_in', ref: 'vt_1', issuer_pubkey: a.pubkey, recipient_pubkey: c.pubkey, delta: 2, total_after: 2, timestamp: 2999, signature: sig.ac},
    {kind: 'issue', ref: 'vd_2', issuer_pubkey: c.pubkey, recipient_pubkey: a.pubkey, delta: 3, total_after: 3, timestamp: 1500, signature: SIG()},
    {kind: 'issue', ref: 'vd_3', issuer_pubkey: b.pubkey, recipient_pubkey: c.pubkey, delta: 1, total_after: 1, timestamp: 1600, signature: SIG()}]);
  notes.push(trackerNote(a.pubkey, b.pubkey, 3, 2999, sig.ab), trackerNote(a.pubkey, c.pubkey, 2, 2999, sig.ac), trackerNote(c.pubkey, a.pubkey, 4, 2500, sig.ca),
    {...trackerNote(a.pubkey, b.pubkey, 99, 1), denomination: 'erg'});             // another denomination: not the pilot's
  const ledger = await pl.ledger();
  assert.equal(ledger.length, 3, 'the ledger keeps only the pilot denomination');
  const rows = await pl.reconcile(ledger);
  const CIRC_RECON_KEYS = [...RECON_KEYS, 'expected_total', 'set_off', 'transferred_in', 'transferred_out', 'exact'];
  for (const r of rows) assert.deepEqual(keys(r), CIRC_RECON_KEYS);
  const row = (i, r) => rows.find(x => x.issuer === i.handle && x.recipient === r.handle);
  assert.deepEqual(row(a, b), {issuer: a.handle, recipient: b.handle, tracker_total: 3, issued_via_valun: 5, status: 'match', expected_total: 3, set_off: 0, transferred_in: 0, transferred_out: 2, exact: true});
  assert.deepEqual(row(a, c), {issuer: a.handle, recipient: c.handle, tracker_total: 2, issued_via_valun: 0, status: 'match', expected_total: 2, set_off: 0, transferred_in: 2, transferred_out: 0, exact: true});
  assert.deepEqual(row(c, a), {issuer: c.handle, recipient: a.handle, tracker_total: 4, issued_via_valun: 3, status: 'tracker-has-debt-not-agreed-in-valun', expected_total: 3, set_off: 0, transferred_in: 0, transferred_out: 0, exact: false});
  assert.deepEqual(row(b, c), {issuer: b.handle, recipient: c.handle, tracker_total: 0, issued_via_valun: 1, status: 'valun-records-exceed-tracker', expected_total: 1, set_off: 0, transferred_in: 0, transferred_out: 0, exact: false},
    'an edge only Valun records has the tracker-row shape');
  // positions: what moved, ids and keys on the rows
  const pos = await pl.position(a.p, ledger);
  assert.deepEqual(keys(pos), ['participant_id', 'unit', 'claims_held', 'owes', 'net', 'gross', 'cleared_by_setoff', 'transferred_in', 'transferred_out', 'novated_as_issuer', 'frozen_claims',
    'claims', 'debts', 'deals', 'settled', 'settled_how', 'backing', 'meaning']);
  assert.deepEqual([pos.claims_held, pos.owes, pos.net, pos.gross, pos.cleared_by_setoff, pos.transferred_in, pos.transferred_out, pos.novated_as_issuer, pos.frozen_claims, pos.settled],
    [4, 5, -1, 9, 0, 0, 0, 2, 0, 0]);
  assert.deepEqual(pos.claims, [{from: c.handle, amount: 4, issuer_id: c.id, issuer_pubkey: c.pubkey, recipient_pubkey: a.pubkey}]);
  assert.deepEqual(pos.debts.map(x => keys(x)), [['to', 'amount', 'recipient_id', 'recipient_pubkey', 'issuer_pubkey'], ['to', 'amount', 'recipient_id', 'recipient_pubkey', 'issuer_pubkey']]);
  assert.deepEqual(keys(pos.deals), [...POSITION_DEAL_KEYS, 'paid_by_transfer', 'payment_due']);
  assert.equal(pos.settled_how, 'by set-off only; nothing is redeemed'); assert.equal(pos.backing, BACKING);
  assert.equal(pos.meaning, 'claims and debts are outstanding obligations recorded by the pilot Basis tracker (cumulative per pair). Some may have moved between creditors (transfer) or been cancelled in cycles (set-off); settled counts only set-off. Nothing is redeemed; there is no reserve.');
  const posC = await pl.position(c.p, ledger);
  assert.deepEqual([posC.transferred_in, posC.transferred_out, posC.novated_as_issuer], [2, 0, 0]);
  assert.deepEqual([(await pl.position(b.p, ledger)).transferred_out], [2]);
  // a claim under a past key is frozen
  const cp = pl.s.participants[c.id];
  cp.past_pubkeys = [...(cp.past_pubkeys || []), {pubkey: c.pubkey, registered_at: null, revoked_at: new Date().toISOString()}];
  cp.pubkey = KEY();
  assert.equal((await pl.position(a.p, ledger)).frozen_claims, 4);
  // GET /edges
  const e = await pl.edges(a.p);
  assert.deepEqual(keys(e), ['incoming', 'outgoing', 'journal', 'next_seq']);
  assert.deepEqual(e.outgoing.map(x => x.edge), [`${a.pubkey}>${b.pubkey}`, `${a.pubkey}>${c.pubkey}`]);
  assert.deepEqual(keys(e.outgoing[0]), ['edge', 'issuer', 'recipient', 'issuer_pubkey', 'recipient_pubkey', 'total', 'timestamp', 'signature', 'exact', 'bound_only', 'reserved', 'frozen']);
  assert.deepEqual(e.outgoing[0], {edge: `${a.pubkey}>${b.pubkey}`, issuer: {id: a.id, handle: a.handle}, recipient: {id: b.id, handle: b.handle}, issuer_pubkey: a.pubkey,
    recipient_pubkey: b.pubkey, total: 3, timestamp: 2999, signature: sig.ab, exact: true, bound_only: true, reserved: 0, frozen: false});
  assert.deepEqual(e.incoming.map(x => [x.edge, x.exact, x.bound_only, x.frozen]), [[`${c.pubkey}>${a.pubkey}`, false, false, true]]);
  assert.deepEqual(e.journal.map(x => x.seq), [1, 2, 3, 4], "a's entries"); assert.equal(e.next_seq, 5);
  assert.deepEqual((await pl.edges(a.p, {since: 3})).journal.map(x => x.seq), [4]);
  await assert.rejects(pl.edges(a.p, {since: -1}), x => x.code === 'invalid_field');
  // mode off, the same journal: v15's rows, the expected totals of the journal
  pl.circulation = 'off';
  const offRows = await pl.reconcile(ledger);
  for (const r of offRows) assert.deepEqual(keys(r), r.pair ? RECON_VALUN_ONLY_KEYS : RECON_KEYS);
  assert.deepEqual(offRows.find(r => r.issuer === a.handle && r.recipient === b.handle), {issuer: a.handle, recipient: b.handle, tracker_total: 3, issued_via_valun: 3, status: 'match'});
  assertPosition(await pl.position(a.p, ledger), 'mode off');
});

test('GET /edges over HTTP: agent and owner from mode bound up, `since` checked, 404 in mode off', async () => {
  const notes = [];
  const {pilot: pl} = stub({circulation: 'bound', notes});
  const a = await enrolled(pl, 'h-a'), b = await enrolled(pl, 'h-b');
  notes.push(trackerNote(a.pubkey, b.pubkey, 2, 1000));
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: '.', pilotRoutes: createPilotRoutes({pilot: pl, cfg: {pilotRateLimitPerMinute: 100000}})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${srv.address().port}`;
  try {
    for (const tok of [a.agent, a.owner]) {
      const e = ok(await call('GET', '/edges', null, tok, {}, at));
      assert.deepEqual([e.outgoing.length, e.incoming.length, e.outgoing[0].total, e.outgoing[0].exact, e.next_seq], [1, 0, 2, false, 0]);
    }
    assert.equal(ok(await call('GET', '/edges', null, b.agent, {}, at)).incoming.length, 1);
    for (const q of ['?since=-1', '?since=abc', '?since=1.5']) refused(await call('GET', `/edges${q}`, null, a.agent, {}, at), 400, 'invalid_field', q);
    ok(await call('GET', '/edges?since=0', null, a.agent, {}, at));
    refused(await call('GET', '/edges', null, null, {}, at), 401, 'unauthorized');
    pl.circulation = 'off';
    refused(await call('GET', '/edges', null, a.agent, {}, at), 404, 'not_found', 'mode off');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});
