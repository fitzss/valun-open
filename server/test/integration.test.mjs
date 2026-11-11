// Integration tests against the REAL Basis tracker and Basis's own signing code. Synthetic keys only.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Basis, makeSignerRunner} from '../lib/basis.mjs';
import {Store} from '../lib/store.mjs';
import {Valun, UserError} from '../lib/valun.mjs';
import {startTracker, runner, signerPath} from './tracker-harness.mjs';

let tracker, valun, basis, store, A, B, C;
const ERG = 1_000_000_000n;

before(async () => {
  tracker = await startTracker(3049);
  store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'valun-it-')));
  basis = new Basis({trackerUrl: tracker.url, trackerNftId: tracker.nft, runSigner: makeSignerRunner({mode: runner, signerPath})});
  valun = new Valun({store, basis});
  A = await valun.createParticipant({name: 'Ana', kind: 'agent'});
  B = await valun.createParticipant({name: 'Ben', kind: 'agent'});
  C = await valun.createParticipant({name: 'Cy', kind: 'operator'});
});
after(async () => { await tracker?.stop(); });

test('offer -> accept -> issued: tracker records exactly the signed note, Valun re-verifies it', async () => {
  const o = await valun.createOffer({issuerId: A.id, recipientId: B.id, amount: (2n * ERG).toString(), purpose: 'compute'});
  assert.equal(o.status, 'offered');
  assert.equal(await basis.note(A.pubkey, B.pubkey), null, 'nothing reaches the tracker before acceptance');
  const v = await valun.inspectOffer(o.id);
  assert.equal(v.stale, false);
  assert.equal(v.basisNoteSignatureValid, true);
  const done = await valun.decide(o.id, {actorId: B.id, decision: 'accept'});
  assert.equal(done.status, 'issued');
  assert.equal(done.issuance.readBackMatches, true);
  assert.equal(done.issuance.signatureVerifiedByValun, true);
  assert.equal(done.issuance.trackerNote.confirmation.status, 'local_only');
  assert.match(done.issuance.proof.tracker_state_digest, /^[0-9a-f]{66}$/);
  const n = await basis.note(A.pubkey, B.pubkey);
  assert.equal(String(n.amount_collected), (2n * ERG).toString());
  // consent signature is a real Schnorr signature by the recipient over the terms hash
  assert.equal(await basis.verify(B.pubkey, Buffer.from(done.decision.message).toString('hex'), done.decision.signature), true);
});

test('cumulative: a second obligation raises the pair total; positions come from the tracker', async () => {
  const o = await valun.createOffer({issuerId: A.id, recipientId: B.id, amount: (1n * ERG).toString()});
  assert.equal(o.terms.priorTotal, (2n * ERG).toString());
  assert.equal((await valun.decide(o.id, {actorId: B.id, decision: 'accept'})).status, 'issued');
  const pa = await valun.position(A.id), pb = await valun.position(B.id);
  assert.equal(pa.owes, (3n * ERG).toString());
  assert.equal(pb.claimsHeld, (3n * ERG).toString());
});

test('only the recipient can decide; decisions are final', async () => {
  const o = await valun.createOffer({issuerId: A.id, recipientId: C.id, amount: '1000'});
  await assert.rejects(valun.decide(o.id, {actorId: A.id, decision: 'accept'}), e => e instanceof UserError && e.code === 403);
  const d = await valun.decide(o.id, {actorId: C.id, decision: 'decline', reason: 'no'});
  assert.equal(d.status, 'declined');
  assert.equal(await basis.note(A.pubkey, C.pubkey), null, 'a declined note never reaches the tracker');
  await assert.rejects(valun.decide(o.id, {actorId: C.id, decision: 'accept'}), e => e.code === 409);
});

test('stale terms: if the pair total moved after the offer, consent is refused', async () => {
  const o1 = await valun.createOffer({issuerId: B.id, recipientId: C.id, amount: '100'});
  const o2 = await valun.createOffer({issuerId: B.id, recipientId: C.id, amount: '200'});
  assert.equal((await valun.decide(o2.id, {actorId: C.id, decision: 'accept'})).status, 'issued');
  await assert.rejects(valun.decide(o1.id, {actorId: C.id, decision: 'accept'}), e => e.code === 409 && /stale/.test(e.message));
  assert.equal(valun.offer(o1.id).status, 'stale');
  assert.equal(String((await basis.note(B.pubkey, C.pubkey)).amount_collected), '200');
});

test('tampered note: the real tracker refuses a signature that does not match', async () => {
  const o = await valun.createOffer({issuerId: C.id, recipientId: A.id, amount: '5000'});
  const sig = o.terms.basisNote.signature;
  o.terms.basisNote.signature = sig.slice(0, 100) + (sig[100] === '0' ? '1' : '0') + sig.slice(101);
  const r = await valun.decide(o.id, {actorId: A.id, decision: 'accept'});
  assert.equal(r.status, 'issue_failed');
  assert.match(r.issuance.trackerError, /signature/i);
  assert.equal(await basis.note(C.pubkey, A.pubkey), null);
});

test('acceptance policy: recipient-signed, evaluated by the tracker, shown before the decision', async () => {
  await valun.setPolicy(C.id, {mode: 'whitelist', trustedIds: [A.id], maxDebt: (1n * ERG).toString()});
  const ok = await valun.createOffer({issuerId: A.id, recipientId: C.id, amount: (ERG / 2n).toString()});
  assert.equal((await valun.inspectOffer(ok.id)).policyCheck.acceptable, true);
  const over = await valun.createOffer({issuerId: A.id, recipientId: C.id, amount: (5n * ERG).toString()});
  assert.equal((await valun.inspectOffer(over.id)).policyCheck.acceptable, false);
  const stranger = await valun.createOffer({issuerId: B.id, recipientId: C.id, amount: '1'});
  assert.equal((await valun.inspectOffer(stranger.id)).policyCheck.acceptable, false);
});

test('reconciliation flags tracker debt that no recipient accepted through Valun', async () => {
  // The tracker accepts any validly signed note, with no recipient consent. Simulate an out-of-band note.
  const r = await basis.issueNote({issuer: B.pubkey, recipient: A.pubkey, total: 777, secretHex: store.getSecret(B.id)});
  assert.equal(r.response.status, 201, 'tracker records a note the recipient never saw');
  const rows = await valun.reconcile();
  const row = rows.find(x => x.issuer === 'Ben' && x.recipient === 'Ana');
  assert.equal(row.status, 'tracker-has-debt-not-issued-through-valun');
  assert.ok(rows.filter(x => x !== row).every(x => x.status === 'match'));
});

test('crash after consent, before the tracker got the note: recover() submits it', async () => {
  const P = await valun.createParticipant({name: 'Pia', kind: 'agent'}), Q = await valun.createParticipant({name: 'Quin', kind: 'agent'});
  const o = await valun.createOffer({issuerId: P.id, recipientId: Q.id, amount: '4242'});
  const orig = basis.api;
  basis.api = async (m, p, b) => { if (m === 'POST' && p === '/notes') { basis.api = orig; throw new Error('simulated crash'); } return orig.call(basis, m, p, b); };
  await assert.rejects(valun.decide(o.id, {actorId: Q.id, decision: 'accept'}), /simulated crash/);
  assert.equal(valun.offer(o.id).status, 'submitting', 'consent was saved before the tracker call');
  assert.equal(await basis.note(P.pubkey, Q.pubkey), null);
  const [r] = await valun.recover();
  assert.deepEqual(r, {id: o.id, status: 'issued'});
  assert.equal(valun.offer(o.id).issuance.recovered, true);
  assert.equal(String((await basis.note(P.pubkey, Q.pubkey)).amount_collected), '4242');
});

test('crash after the tracker recorded the note, before Valun saved: recover() adopts it without resubmitting', async () => {
  const P = valun.byPubkey((await valun.createParticipant({name: 'Ray', kind: 'agent'})).pubkey), Q = valun.byPubkey(B.pubkey);
  const o = await valun.createOffer({issuerId: P.id, recipientId: Q.id, amount: '999'});
  const orig = basis.api;
  // the tracker receives the note, then the process "dies" before Valun records the result
  basis.api = async (m, p, b) => { const r = await orig.call(basis, m, p, b); if (m === 'POST' && p === '/notes') { basis.api = orig; throw new Error('simulated crash'); } return r; };
  await assert.rejects(valun.decide(o.id, {actorId: Q.id, decision: 'accept'}), /simulated crash/);
  assert.equal(valun.offer(o.id).status, 'submitting');
  assert.equal(String((await basis.note(P.pubkey, Q.pubkey)).amount_collected), '999', 'tracker already holds it');
  await valun.recover();
  const done = valun.offer(o.id);
  assert.equal(done.status, 'issued');
  assert.equal(done.issuance.trackerStatus, 'already held (recovered)');
  assert.equal(done.issuance.signatureVerifiedByValun, true);
  assert.ok((await valun.reconcile()).filter(x => x.issuer === 'Ray').every(x => x.status === 'match'));
});

test('the tracker refuses to lower a cumulative debt', async () => {
  const cur = await basis.note(A.pubkey, B.pubkey);
  const r = await basis.issueNote({issuer: A.pubkey, recipient: B.pubkey, total: Number(cur.amount_collected) - 1, secretHex: store.getSecret(A.id)});
  assert.equal(r.response.status, 400);
  assert.match(r.response.error, /cannot decrease/);
});
