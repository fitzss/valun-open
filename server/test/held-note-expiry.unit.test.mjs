// A credit note held for the payer's owner (review_deliveries, console approvals) and its deadline, at the unit level: a
// Pilot in circulation mode on over a stub tracker and a throwaway store, so these run with no tracker binary (CI's
// no-tracker list). The approval probe's D3 (staging, 2026-11-18): an owner approved a held bound IOU after the tracker's
// maximum age (its timestamp + 1 hour); the server sent it, the tracker refused it (novation_expired), and the deal was
// left note_failed with the delivery accepted and no longer disputable, which is worse for the payer than a rejection.
//   - a bound held note's approval ends at its timestamp + 1 hour - 60 s (decide_by, heldNoteDecideBy): at that time
//     the approval is void_expired and the deal returns as after a rejection (delivered with the completion cleared, or
//     payment_due when the acceptance already stood), so the payer's agent may accept the delivery again; the note is
//     kept (void_notes, state expired), never sent, and still counts for decision D-1's transfer window;
//   - an approval or a rejection after the deadline is refused cleanly (409 not_pending, "approval is void_expired"),
//     with nothing sent; so is an approval whose deadline passes while the server reads the tracker;
//   - before the deadline an approval sends the note as before; an ordinary note has no deadline;
//   - the approval view gives decide_by and the effect's held_now and deadline texts in mode on, and keeps v15's keys
//     in mode off (I-DARK).
// The same rule against a real tracker: test/transfer.test.mjs ("D-1 item 4").
// Run: node --test test/held-note-expiry.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, HELD_NOTE_SEND_MARGIN_MS, CLIENT_ATTEMPT_WINDOW_MS, heldNoteDecideBy} from '../lib/pilot/core.mjs';
import {fallbackAfter, MAX_AGE_MS} from '../lib/pilot/novation.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const H = 3600e3, DAY = 24 * H, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;

// A Pilot over a stub tracker: `edges` is what basis.note() reads; POST /notes records the note it is sent there (and in
// `posted`), as the tracker would. `onNoteRead` runs at each basis.note() read (a test moves the clock there).
function world({mode = 'on'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-held-')); dirs.push(dir);
  const clock = {t: Date.parse('2026-11-18T00:00:00.000Z')}, edges = new Map(), posted = [], hooks = {onNoteRead: null};
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, capabilities: async () => V3_CAPS,
    note: async (i, r) => { hooks.onNoteRead?.(); return edges.get(`${i}>${r}`) ?? null; },
    async api(method, p, body) {
      posted.push({method, p, body});
      edges.set(`${body.issuer_pubkey}>${body.recipient_pubkey}`, {amount_collected: String(body.amount), amount_redeemed: '0', timestamp: body.timestamp, signature: body.signature,
        confirmation: {status: 'local_only'}});
      return {status: 201, json: {success: true}, text: '{}'};
    },
    proof: async () => null, verify: async () => true};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, ...(mode === 'off' ? {} : {circulation: mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN]}), log: () => {}});
  assert.equal(pilot.mode, mode);
  const person = (handle, mandate = {}) => ({id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32),
    status: 'active', created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
    mandate: {...DEFAULT_MANDATE, ...(mode === 'off' ? {} : {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'}),
      approve_above: 0, review_deliveries: true, ...mandate},
    mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null});
  const P = person('held-payer'), Q = person('held-payee');
  for (const x of [P, Q]) pilot.s.participants[x.id] = x;
  return {pilot, clock, edges, posted, hooks, P, Q};
}
// A delivered deal whose payer's agent accepted the delivery and signed a note for 3 at timestamp T, held for the payer's
// owner (completion_awaiting_owner, approval issue_note pending), as Pilot.complete leaves it. `bound`: a bound note
// (it carries its prior acknowledgment); `due`: the acceptance already stood (payment_due, circulating credit).
function heldNote(w, {bound = true, due = false} = {}) {
  const {pilot, P, Q, clock} = w, id = 'vd_' + hex(8), T = ending(clock.t - 5000, bound ? 997 : 500);
  const terms = {deal_id: id, version: 1, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey}, service: {title: 'held job', description: 'synthetic', deliverable: 'text'},
    price: {amount: 3, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
  const v = {v: 1, by: P.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
  const completion = {by: P.id, signature: '02' + hex(64), at: iso(clock.t), deliverable_sha256: hex(32)};
  const d = {id, payer: P.id, payee: Q.id, created_at: iso(clock.t), status: 'completion_awaiting_owner', versions: [v], history: [],
    agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t), proposer_signature: v.signature, acceptor_signature: '02' + hex(64), proposer: P.id, acceptor: Q.id},
    delivery: {by: Q.id, sha256: completion.deliverable_sha256, content: 'the work', bytes: 8, at: iso(clock.t), late: false}, completion,
    credit_note: {state: 'signed', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, keys_as_agreed: true,
      note: {total: 3, timestamp: T, signature: '02' + hex(64), message_hex: 'ab'.repeat(80), ...(bound ? {prior_signature: '02' + hex(64)} : {})},
      prior_total: 0, amount: 3, signed_at: iso(clock.t), completion: {signature: completion.signature, deliverable_sha256: completion.deliverable_sha256}},
    note_prior: {total: 0, timestamp: null, signature: null}, ...(due ? {payment_due_since: iso(clock.t - H)} : {})};
  pilot.s.deals[id] = d;
  const a = pilot.approval(P, d, 'issue_note', {v: 1, terms_hash: d.agreement.terms_hash});
  d.credit_note.approval_id = a.id;
  return {d, a, T, by: T + MAX_AGE_MS - HELD_NOTE_SEND_MARGIN_MS};
}
const refusedWith = async (p, code, message) => {
  await assert.rejects(p, e => e instanceof PilotError && e.code === code && e.status === 409 && (message === undefined || e.message === message), `${code}${message ? `: ${message}` : ''}`);
};

test('a bound held note: the approval says until when (decide_by: its timestamp + 1 hour - 60 s) and what is already signed and held', () => {
  const w = world(), {pilot, P} = w, {d, a, T, by} = heldNote(w);
  assert.equal(heldNoteDecideBy(d.credit_note), by);
  assert.equal(HELD_NOTE_SEND_MARGIN_MS, 60e3);
  const v = pilot.approvalView(a, P);
  assert.equal(v.decide_by, iso(by));
  assert.deepEqual(Object.keys(v.effect), ['held_now', 'if_approved', 'if_rejected', 'deadline', 'checks_on_approve']);
  assert.match(v.effect.held_now, /^Your agent accepted held-payee's delivery and signed two things with its key: its acceptance of the delivery, which held-payee already sees, and a note to held-payee for 3 PC, complete in the tracker's signed format, with its prior acknowledgment, that raises the total of your note to held-payee from 0 PC to 3 PC\. Valun's server holds the note: it is not on the tracker, and held-payee sees its amount but not its signature\./);
  // valun 0.7.1 is never told of an expiry or a rejection and keeps the IOU as a payment attempt that may still apply
  // (the approval probe's D2). The card says only what holds in every case (the review of PR #9: each list of 0.7.1's
  // conditions left a case it got wrong): it usually signs a new IOU for the deal at once, and may refuse once something
  // else changed the pair first or a key changed; then what to do for each answer: transfer_window_open, pay again once
  // the IOU's timestamp + 1 h + 2 min has passed (retry_after_ms); attempt_outcome_unknown, resolve it, then pay again
  // once that time has passed. scripts/client-071-attempts.py checks both in every case it runs; PILOT-API.md has the
  // exact conditions.
  const at = iso(T + MAX_AGE_MS + 120e3);
  assert.equal(CLIENT_ATTEMPT_WINDOW_MS, MAX_AGE_MS + 120e3, 'valun 0.7.1 novation.py: MAX_AGE_MS + FALLBACK_MARGIN_MS');
  const refusals = `If it answers transfer_window_open, have your agent pay again once ${at} has passed, an hour and 2 minutes after this note's timestamp (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, run \`valun attempts resolve ${d.id} '#n' --not-applied\` in a terminal (#n from \`valun attempts list\`; in Hermes, \`hermes -p valun valun attempts ...\`): Valun never sent this note. Then have your agent pay again once ${at} has passed.`;
  const trap = ` valun 0.7.1 isn't told either, and keeps counting this note as a payment that may still apply. It usually signs a new note for this deal at once. If anything else changed this pair's note first, or an agent's key changed, it may refuse. ${refusals}`;
  assert.equal(v.effect.deadline, `Approve or reject by ${iso(by)}. The tracker records this bound note only until ${iso(T + MAX_AGE_MS)}, one hour after its timestamp, and Valun keeps the last minute for sending it. At ${iso(by)} this approval expires: Valun never sends the note, and the deal goes back to delivered, as after a rejection, so your agent may accept the delivery again. Your agent isn't told: tell it. As after a rejection, no set-off touches this pair until your agent pays this deal or disputes the delivery, and valun 0.7.1 keeps counting this note as a payment that may still apply. ${refusals}`);
  assert.ok(v.effect.if_rejected.endsWith(`Until your agent pays this deal or disputes the delivery, no set-off touches this pair: no loop that includes what you owe held-payee clears. Your agent isn't told: tell it.${trap}`), v.effect.if_rejected);
  assert.doesNotMatch(`${v.effect.if_rejected} ${v.effect.deadline}`, /another deal with/, 'never the example that does not make 0.7.1 refuse');
  // Once sent, the delivery stays accepted, but for the one way back (the review of PR #8, F8; of PR #9, item 10): after
  // the tracker refused the note (note_failed, no payment_due_since), a later payment of the deal held for the owner and
  // never sent (rejected, expired or void) releases the deal, unless it was payment due by then.
  assert.match(v.effect.if_approved, new RegExp(`From then on the delivery stays accepted and can no longer be disputed, with one exception: if the tracker refuses the note, your agent must pay again, and a later note or payment by transfer of this deal that waits for you and isn't sent \\(you reject it, it expires, or it becomes void: its checks fail when you approve it, or a party's agent key is revoked\\) sends the deal back to delivered, where your agent may dispute the delivery, unless the deal was payment due before that \\(it then stays payment due\\)\\. It is a bound note: the tracker records it only while the pair's note is still the one it acknowledges \\(total 0 PC, the state it was signed on\\), and only until ${iso(T + MAX_AGE_MS).replace(/\./g, '\\.')}, one hour after its timestamp, so this approval ends at ${iso(by).replace(/\./g, '\\.')}\\.$`));
  // Checked again on approval: if not, void, never sent, and the deal back to delivered, where it can be disputed; as
  // after a rejection, nothing tells the agent or 0.7.1 (the review of PR #9, code 2-1).
  assert.equal(v.effect.checks_on_approve, "When you approve, the server first checks that the pair's last note on the tracker (its total, timestamp and signature) and both parties' keys are unchanged since your agent signed; if not, the approval becomes void, Valun doesn't send the note, and the deal goes back to delivered: your agent may pay again, or dispute the delivery. As after a rejection, your agent isn't told, and valun 0.7.1 keeps counting this note as a payment that may still apply.");
  // The payment by transfer's wait, Valun's own rule exactly (paymentBlockAt, attemptDeadByJournal): until
  // fallback_after, unless the first change of this key pair after the IOU's timestamp moves it from the total it
  // acknowledged (the review of PR #8, F4 and F7; of PR #9, item 8: on this key pair only). 0.7.1's own wait is the
  // trap's (transfer_window_open).
  assert.ok(v.effect.if_rejected.includes(`Rejecting doesn't unsign the note: Valun keeps it on record, with its signatures, and never sends it. If it were sent, the tracker could still record it until ${iso(T + MAX_AGE_MS)}, so paying this deal by transfer waits until ${iso(fallbackAfter(T))}, unless the first change to this key pair's note signed after this one moves it from 0 PC, the total this one acknowledged, as a later note of your agent's to held-payee on this key pair does when nothing else changed the pair first: Valun then doesn't wait for this one.`), v.effect.if_rejected);
});

// The review of PR #8, F4 and F7: after a rejected bound IOU, a payment by transfer of the deal waits until its timestamp
// + 1 h + 60 s unless Valun's journal proves the IOU dead first: the pair's first change after the IOU's timestamp left
// the total it acknowledged, as a later IOU of the payer's to the payee, signed after it, does once recorded. One
// signed before it and recorded after it is an earlier change on the tracker's clock, which proves nothing.
test('after a rejected bound note, a payment by transfer waits for it unless a later note of the payer\'s, signed after it, applied; one signed before it does not end the wait', async () => {
  for (const order of ['after', 'before']) {
    const w = world(), {pilot, P, clock} = w;
    const first = heldNote(w);                          // signed at T1
    clock.t += 5 * 60e3;
    const second = heldNote(w);                         // signed 5 minutes later, from the same prior state
    // 'after': the first one is rejected, the later one approved; 'before': the later one rejected, the first approved.
    const [rejected, approved] = order === 'after' ? [first, second] : [second, first];
    await pilot.decideApproval(P, rejected.a.id, {decision: 'reject'});
    const r = await pilot.decideApproval(P, approved.a.id, {decision: 'approve'});
    assert.equal(r.deal.status, 'note_issued', `${order}: the other note recorded`);
    const b = await pilot.paymentBlock(rejected.d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5});
    if (order === 'after') assert.equal(b, null, 'a later note, signed after the rejected one, ends the wait');
    else {
      assert.equal(b?.code, 'transfer_window_open', `a note signed before the rejected one does not: ${JSON.stringify(b)}`);
      assert.ok(Math.abs(b.retry_after_ms - (fallbackAfter(rejected.T) - clock.t)) <= 2);
    }
  }
});

// The review of PR #9, item 8: the journal's proof is on the rejected IOU's own key pair. After the payee's key changed, a
// later IOU of the payer's to it is on a new pair: the old pair's journal has no entry after the rejected IOU's
// timestamp, so a payment by transfer still waits until its fallback_after (the card says "this key pair's IOU").
test('after a rejected bound note and a key change of the payee, a later note to its new key does not end the wait: a payment by transfer waits until fallback_after', async () => {
  const w = world(), {pilot, P, Q, clock} = w;
  const rejected = heldNote(w), oldKey = Q.pubkey;
  await pilot.decideApproval(P, rejected.a.id, {decision: 'reject'});
  clock.t += 5 * 60e3;
  // The payee's owner revokes its agent's key and enrolls another (revokeAgent keeps the old one in past_pubkeys).
  Q.past_pubkeys = [...(Q.past_pubkeys || []), oldKey]; Q.pubkey = '02' + hex(32);
  const later = heldNote(w);
  assert.equal(later.d.credit_note.recipient_pubkey, Q.pubkey, 'the later note is to the new key');
  assert.equal((await pilot.decideApproval(P, later.a.id, {decision: 'approve'})).deal.status, 'note_issued', 'recorded, on the new pair');
  const b = await pilot.paymentBlock(rejected.d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5});
  assert.equal(b?.code, 'transfer_window_open', JSON.stringify(b));
  assert.ok(Math.abs(b.retry_after_ms - (fallbackAfter(rejected.T) - clock.t)) <= 2, 'until its fallback_after');
  assert.equal(pilot.attemptDeadByJournal(`${P.pubkey}>${oldKey}`, 0, rejected.T), false, 'nothing on the old pair proves it dead');
  assert.equal(pilot.attemptDeadByJournal(`${P.pubkey}>${Q.pubkey}`, 0, rejected.T), true, 'the new pair has the later note, after it, from 0');
  clock.t = fallbackAfter(rejected.T) + 1;
  assert.equal(await pilot.paymentBlock(rejected.d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5}), null, 'not after it');
});

// The review of PR #8, F8: a note the tracker refuses leaves the deal note_failed and sets no payment_due_since (one the
// deal had, as payment_due, stays: the review of PR #9, v2), so a later payment of it held for the owner and then
// rejected (or expired) releases the deal to delivered (releaseAcceptance), where the payer may dispute it; a deal that
// was payment_due before stays so. The IOU card's if_approved says both.
test('after the tracker refuses an approved note, rejecting the next held note sends the deal back to delivered, where it can be disputed; a payment_due deal stays payment_due', async () => {
  for (const due of [false, true]) {
    const w = world(), {pilot, P, clock, edges} = w, {d, a} = heldNote(w, {due});
    // The tracker refuses the note: its POST records nothing. (The messages a new note is checked against: any bytes,
    // since the stub's verify accepts every signature.)
    pilot.basis.api = async () => ({status: 409, json: {code: 'novation_expired', error: 'refused'}, text: '{}'});
    pilot.basis.noteMessage = async () => ({message_hex: 'ab'.repeat(40)});
    pilot.basis.priorAckMessage = async () => ({message_hex: 'cd'.repeat(40)});
    const r = await pilot.decideApproval(P, a.id, {decision: 'approve'});
    assert.equal(r.deal.status, 'note_failed', `due ${due}: refused by the tracker`);
    assert.equal(!!d.payment_due_since, due, `due ${due}: note_failed sets no payment_due_since`);
    assert.ok(!pilot.view(d, P).next_actions.includes('dispute'), `due ${due}: no dispute after the refusal`);
    // The payer's agent signs a new bound IOU; it is held again, and the owner rejects it.
    clock.t += 60e3;
    const T2 = ending(clock.t - 1500, 997);
    await pilot.complete(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: '02' + hex(64),
      credit_note: {total: 3, timestamp: T2, signature: '02' + hex(64), prior_signature: '02' + hex(64), prior_total: 0, prior_timestamp: 0}});
    assert.equal(d.status, 'completion_awaiting_owner', `due ${due}: the new note waits for the owner`);
    await pilot.decideApproval(P, d.credit_note.approval_id, {decision: 'reject'});
    assert.equal(d.status, due ? 'payment_due' : 'delivered', `due ${due}: where the rejection leaves it`);
    assert.equal(pilot.view(d, P).next_actions.includes('dispute'), !due, `due ${due}: a dispute is possible only once delivered`);
    assert.equal(edges.size, 0, 'nothing reached the tracker');
  }
  // What the card says of it, beside a deal that was payment due.
  const w = world(), {d, a} = heldNote(w), v = w.pilot.approvalView(a, w.P);
  assert.ok(v.effect.if_approved.includes("if the tracker refuses the note, your agent must pay again, and a later note or payment by transfer of this deal that waits for you and isn't sent (you reject it, it expires, or it becomes void: its checks fail when you approve it, or a party's agent key is revoked) sends the deal back to delivered, where your agent may dispute the delivery, unless the deal was payment due before that (it then stays payment due)."), d.id);
  const w2 = world(), due = heldNote(w2, {due: true}), v2 = w2.pilot.approvalView(due.a, w2.P);
  assert.ok(v2.effect.if_approved.includes('From then on the delivery stays accepted: if the tracker refuses the note, your agent must pay again, and the delivery can no longer be disputed.'));
  assert.ok(v2.effect.checks_on_approve.endsWith("if not, the approval becomes void, Valun doesn't send the note, and the deal stays payment due: your agent must still pay it. As after a rejection, your agent isn't told, and valun 0.7.1 keeps counting this note as a payment that may still apply."));
});

// The review of PR #9, code 2-1: the 409 stale_note says where the void left the deal, as the card does, for each check
// that failed: a party's key (the new IOU must then be signed with the current keys), the pair's whole last note at the
// same total, its total. Delivered, the payer may accept the delivery again or dispute it; payment due, it must still pay.
// Then (the review of PR #9, final round) until when a payment by transfer may have to wait: the void IOU is an earlier
// payment attempt, and nothing in Valun's journal after its timestamp proves it dead (here the pair's change is
// timestamped before it, or is on its old key pair), so until its fallback_after, as the routes and next_actions say.
test('a held note whose checks fail on approval: the 409 says why, that it is void and never sent, and where the deal is now (delivered, where it can be disputed, or payment due)', async () => {
  for (const [why, due] of [['key', false], ['key', true], ['note', false], ['total', true]]) {
    const w = world(), {pilot, P, Q, edges} = w, {d, a, T} = heldNote(w, {due});
    if (why === 'key') { Q.past_pubkeys = [Q.pubkey]; Q.pubkey = '02' + hex(32); }
    // The pair holds a note at the total the IOU acknowledged (0) but another one: the whole last note changed.
    if (why === 'note') edges.set(`${P.pubkey}>${Q.pubkey}`, {amount_collected: '0', amount_redeemed: '0', timestamp: T - 2000, signature: '02' + hex(64), confirmation: {status: 'local_only'}});
    if (why === 'total') edges.set(`${P.pubkey}>${Q.pubkey}`, {amount_collected: '2', amount_redeemed: '0', timestamp: T - 2000, signature: '02' + hex(64), confirmation: {status: 'local_only'}});
    const cause = {key: "a party's agent key changed since your agent signed this note",
      note: "the pair's last note on the tracker changed since your agent signed this note (the total is the same, the signed note is not)",
      total: "the pair's tracker total changed since your agent signed this note"}[why];
    const fresh = why === 'key' ? 'a new note signed with the current keys' : 'a new note';
    await refusedWith(pilot.decideApproval(P, a.id, {decision: 'approve'}), 'stale_note', `${cause}; the approval is void, and Valun never sent the note: ${due
      ? `the deal stays payment due, and your agent must still pay it, with ${fresh} or by transfer` : `the deal is delivered again, and your agent may accept the delivery again with ${fresh} (or pay by transfer), or dispute it`}; a payment by transfer may have to wait until ${iso(fallbackAfter(T))}`);
    assert.deepEqual([a.state, d.status], ['void_stale', due ? 'payment_due' : 'delivered'], `${why}, due ${due}`);
    assert.equal(pilot.view(d, P).next_actions.includes('dispute'), !due, `${why}, due ${due}: a dispute only once delivered`);
    const b = await pilot.paymentBlock(d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5});
    assert.deepEqual([b?.code, pilot.now() + b?.retry_after_ms - 1], ['transfer_window_open', fallbackAfter(T)], `${why}, due ${due}: the route waits until then`);
    assert.ok(pilot.view(d, P).next_actions.includes('wait_for_transfer_window'), `${why}, due ${due}: so do next_actions`);
  }
});

// The review of PR #9, final round (the verifier's probe-stale): two held IOUs of one pair, signed 5 minutes apart from
// the same state. Approved in the order they were signed, the later one is void (stale_note) and a payment by transfer
// waits until its fallback_after: the pair's change is the earlier IOU's, timestamped before it, which proves nothing
// (attemptDeadByJournal). Approved the other way round, the journal proves the earlier one dead and nothing waits. The
// 409 says which, as next_actions do; and it names no payment by transfer where none can start (the mandate pays with
// held notes never).
test('a held note made stale by another held note of its pair: the 409 says until when a payment by transfer may have to wait, as the route and next_actions judge it', async () => {
  for (const [order, due] of [['signed', false], ['signed', true], ['reverse', false], ['reverse', true]]) {
    const w = world(), {pilot, P, clock} = w, what = `${order}, due ${due}`;
    const first = heldNote(w, {due});
    clock.t += 5 * 60e3;
    const second = heldNote(w, {due});
    const [ok, stale] = order === 'signed' ? [first, second] : [second, first];
    assert.equal((await pilot.decideApproval(P, ok.a.id, {decision: 'approve'})).deal.status, 'note_issued', what);
    const where = due ? 'the deal stays payment due, and your agent must still pay it, with a new note or by transfer'
      : 'the deal is delivered again, and your agent may accept the delivery again with a new note (or pay by transfer), or dispute it';
    await refusedWith(pilot.decideApproval(P, stale.a.id, {decision: 'approve'}), 'stale_note',
      `the pair's tracker total changed since your agent signed this note; the approval is void, and Valun never sent the note: ${where}${order === 'signed' ? `; a payment by transfer may have to wait until ${iso(fallbackAfter(stale.T))}` : ''}`);
    const b = await pilot.paymentBlock(stale.d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5}), next = pilot.view(stale.d, P).next_actions;
    if (order === 'signed') {
      assert.equal(b?.code, 'transfer_window_open', what);
      assert.deepEqual([next.includes('wait_for_transfer_window'), next.includes('pay_by_transfer')], [true, false], `${what}: ${next}`);
    } else {
      assert.equal(b, null, `${what}: the journal proves the earlier note dead`);
      assert.deepEqual([next.includes('wait_for_transfer_window'), next.includes('pay_by_transfer')], [false, true], `${what}: ${next}`);
    }
  }
  // A mandate that never pays with held notes: no payment by transfer is named, and no wait for one.
  const w = world(), {pilot, P, clock} = w, first = heldNote(w);
  clock.t += 5 * 60e3;
  const second = heldNote(w);
  P.mandate.pay_with_held_notes = 'never';
  await pilot.decideApproval(P, first.a.id, {decision: 'approve'});
  await refusedWith(pilot.decideApproval(P, second.a.id, {decision: 'approve'}), 'stale_note',
    "the pair's tracker total changed since your agent signed this note; the approval is void, and Valun never sent the note: the deal is delivered again, and your agent may accept the delivery again with a new note, or dispute it");
});

// The review of PR #9, item 10: a rejection or an expiry is not the only way back. After the tracker refused an approved
// note (note_failed, no payment_due_since), the next held note can also become void: its checks fail when the owner
// approves it (void_stale: here the pair moved since the agent signed it), or a key of either party is revoked
// (revokeAgent: void_key_revoked). Either sends the deal back to delivered, where the payer disputes it; a deal that was
// payment_due stays payment_due. The card names the void cases beside reject and expire.
test('after the tracker refuses an approved note, the next held note becoming void (stale on approval, or a key revoked) sends the deal back to delivered, where it can be disputed; a payment_due deal stays payment_due', async () => {
  for (const [how, due] of [['stale', false], ['stale', true], ['revoked', false], ['revoked', true]]) {
    const w = world(), {pilot, P, Q, clock, edges} = w, {d, a} = heldNote(w, {due});
    pilot.basis.api = async () => ({status: 409, json: {code: 'novation_expired', error: 'refused'}, text: '{}'});
    pilot.basis.noteMessage = async () => ({message_hex: 'ab'.repeat(40)});
    pilot.basis.priorAckMessage = async () => ({message_hex: 'cd'.repeat(40)});
    assert.equal((await pilot.decideApproval(P, a.id, {decision: 'approve'})).deal.status, 'note_failed', `${how}, due ${due}`);
    clock.t += 60e3;
    const T2 = ending(clock.t - 1500, 997);
    await pilot.complete(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: '02' + hex(64),
      credit_note: {total: 3, timestamp: T2, signature: '02' + hex(64), prior_signature: '02' + hex(64), prior_total: 0, prior_timestamp: 0}});
    assert.equal(d.status, 'completion_awaiting_owner', `${how}, due ${due}: the next note waits for the owner`);
    const next = d.credit_note.approval_id;
    if (how === 'stale') {
      // The pair moved on the tracker since the agent signed it (an earlier note of the payer's to the payee, recorded).
      // The 409 says where that left the deal, as the card's "Checked again when you approve" does (the review of PR #9,
      // code 2-1): delivered, where the payer may pay again or dispute it, or payment due; and that a payment by transfer
      // may have to wait for the void IOU (the later of the deal's two IOUs, so its fallback_after: final round).
      edges.set(`${P.pubkey}>${Q.pubkey}`, {amount_collected: '1', amount_redeemed: '0', timestamp: T2 - 2000, signature: '02' + hex(64), confirmation: {status: 'local_only'}});
      await refusedWith(pilot.decideApproval(P, next, {decision: 'approve'}), 'stale_note', `the pair's tracker total changed since your agent signed this note; the approval is void, and Valun never sent the note: ${due
        ? 'the deal stays payment due, and your agent must still pay it, with a new note or by transfer' : 'the deal is delivered again, and your agent may accept the delivery again with a new note (or pay by transfer), or dispute it'}; a payment by transfer may have to wait until ${iso(fallbackAfter(T2))}`);
      assert.equal(pilot.s.approvals[next].state, 'void_stale', `${how}, due ${due}`);
    } else {
      await pilot.revokeAgent(Q);                       // the payee's owner revokes its agent's key
      assert.equal(pilot.s.approvals[next].state, 'void_key_revoked', `${how}, due ${due}`);
    }
    assert.equal(d.status, due ? 'payment_due' : 'delivered', `${how}, due ${due}: where the void leaves it`);
    assert.equal(pilot.view(d, P).next_actions.includes('dispute'), !due, `${how}, due ${due}: a dispute is possible only once delivered`);
    if (!due) {
      const r = await pilot.dispute(P, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: '02' + hex(64), reason: 'not what was agreed'});
      assert.equal(r.status, 'disputed', `${how}: the payer disputes the delivery`);
    }
  }
});

test('at its deadline a bound held note\'s approval is void_expired and the deal returns to delivered as after a rejection; a later approval or rejection is refused cleanly and nothing is sent', async () => {
  const w = world(), {pilot, P, Q, clock, posted} = w, {d, a, T, by} = heldNote(w);
  clock.t = by - 1;
  pilot.sweep(d);
  assert.deepEqual([a.state, d.status], ['pending', 'completion_awaiting_owner'], 'a millisecond before: still pending');
  clock.t = by;
  pilot.sweep(d);
  assert.equal(a.state, 'void_expired');
  assert.equal(a.decided_at, undefined, 'nobody decided it');
  assert.deepEqual([d.status, d.completion, d.credit_note], ['delivered', null, null], 'back to delivered, the completion cleared');
  assert.equal(d.void_notes.length, 1);
  assert.deepEqual([d.void_notes[0].state, d.void_notes[0].approval_id, d.void_notes[0].note.timestamp, !!d.void_notes[0].note.signature, !!d.void_notes[0].note.prior_signature],
    ['expired', a.id, T, true, true], 'the signed note is kept, signatures included');
  const ev = d.history.at(-1);
  assert.deepEqual([ev.event, ev.by, ev.amount, ev.decide_by, ev.tracker_until, ev.status, ev.only], ['credit_note_expired', 'valun', 3, iso(by), iso(T + MAX_AGE_MS), 'delivered', undefined]);
  // Both sides see it, and the payer's agent may accept the delivery again (or dispute it).
  assert.ok(pilot.view(d, Q).history.some(e => e.event === 'credit_note_expired'), 'the payee sees that it expired');
  const next = pilot.view(d, P).next_actions;
  assert.ok(next.includes('complete') && next.includes('dispute'), `the payer's agent may accept it again, or dispute it (not accepted any more): ${next}`);
  // Deciding it now: 409 not_pending, nothing sent, nothing changed.
  await refusedWith(pilot.decideApproval(P, a.id, {decision: 'approve'}), 'not_pending', 'approval is void_expired');
  await refusedWith(pilot.decideApproval(P, a.id, {decision: 'reject'}), 'not_pending', 'approval is void_expired');
  assert.deepEqual(posted, [], 'nothing was sent to the tracker');
  assert.deepEqual([a.state, d.status], ['void_expired', 'delivered']);
  // The approval view of the expired approval still shows what was held, and when it ended.
  const v = pilot.approvalView(a, P);
  assert.deepEqual([v.state, v.decide_by, v.subject.credit_note.timestamp], ['void_expired', iso(by), T]);
  // The audit says so.
  const audit = fs.readFileSync(path.join(pilot.store.dir, 'pilot-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.type === 'approval.void_expired');
  assert.deepEqual(audit.map(l => [l.id, l.deal, l.kind, l.decide_by]), [[a.id, d.id, 'issue_note', iso(by)]]);
});

test('an approval sent after the deadline, with nothing having swept the deal before: the decision\'s own sweep refuses it (D3 is now a clean 409)', async () => {
  const w = world(), {pilot, P, clock, posted} = w, {d, a, by} = heldNote(w);
  clock.t = by + 60e3;                                       // the tracker's own deadline itself has passed: D3's case
  await refusedWith(pilot.decideApproval(P, a.id, {decision: 'approve'}), 'not_pending', 'approval is void_expired');
  assert.deepEqual(posted, []);
  assert.deepEqual([a.state, d.status, d.credit_note, d.void_notes?.[0]?.state], ['void_expired', 'delivered', null, 'expired']);
  assert.notEqual(d.status, 'note_failed');
});

test('the deadline passes while the server reads the tracker for an approval: nothing is sent, and the approval is void_expired, not decided', async () => {
  const w = world(), {pilot, P, clock, posted, hooks} = w, {d, a, by} = heldNote(w);
  clock.t = by - 500;
  hooks.onNoteRead = () => { clock.t = by + 1; };
  await refusedWith(pilot.decideApproval(P, a.id, {decision: 'approve', note: 'just in time?'}), 'not_pending', 'approval is void_expired');
  assert.deepEqual(posted, [], 'nothing was sent');
  assert.deepEqual([a.state, a.decided_at, a.note, d.status], ['void_expired', undefined, undefined, 'delivered']);
});

test('a deal whose acceptance already stood (payment_due) stays payment_due when its held note expires, the completion kept', async () => {
  const w = world(), {pilot, P, clock} = w, {d, a, by} = heldNote(w, {due: true});
  const completion = d.completion;
  clock.t = by;
  pilot.sweep(d);
  assert.deepEqual([a.state, d.status, d.completion], ['void_expired', 'payment_due', completion]);
  assert.equal(d.history.at(-1).status, 'payment_due');
  const v = pilot.approvalView(a, P);
  // A payment_due deal can no longer be disputed (dispute() takes a delivered deal only): only paying it frees the pair.
  assert.match(v.effect.deadline, /the deal stays payment due, as after a rejection: your agent must still pay it\. Your agent isn't told: tell it\. As after a rejection, no set-off touches this pair until your agent pays this deal, and valun 0\.7\.1 keeps counting this note as a payment that may still apply\. If it answers transfer_window_open, /);
  assert.match(v.effect.if_rejected, / Until your agent pays this deal, no set-off touches this pair: no loop that includes what you owe held-payee clears\. /);
});

// The review of PR #9: the IOU card no longer lists what makes valun 0.7.1 refuse (each list left a case it got wrong:
// a key change, an honor signed before its client read a later IOU, credit notes in between), so it gives no example
// of one either, and says the same whoever the payee is (it said a practice agent never passes the IOU on, beside the
// example). The exact conditions are in docs/PILOT-API.md, and scripts/client-071-attempts.py runs them.
test('the note card gives what holds in every case of valun 0.7.1, no list of its conditions, and the same words whoever the payee is', () => {
  const w = world(), {pilot, P, Q} = w, {a} = heldNote(w);
  const words = () => { const e = pilot.approvalView(a, P).effect; return `${e.if_rejected} ${e.deadline}`; };
  const before = words();
  assert.doesNotMatch(before, /7 days|signed nothing else|valun_status|passed your agent's note on|guarantee call|did not apply|practice agents|was the first to change|back at the total/);
  pilot.serverSigner = {has: id => id === Q.id, signFor: async () => null};
  assert.equal(words(), before, 'a practice agent as the payee changes nothing');
});

// What stays blocked after a rejected or expired held IOU, and what does not (staging's first-use round of 2026-11-18:
// a loop on the pair waited 7 minutes and cleared 28 s after the new IOU was approved). The note stays an earlier payment
// attempt of the deal (ownNoteAttempts), so the clearing engine keeps every set-off off the pair (paymentAttemptHolds),
// past the note's hour too, until the deal is paid or disputed. A payment by transfer through the pair is not held
// (assertTransferEdgeFree holds a pair only while a note on it is held or being issued): that is what can move the
// pair, and so make valun 0.7.1 refuse to pay the deal (the IOU card says so).
test('after a rejected or expired held note, no set-off touches its pair until the deal is paid or disputed, at any age; a payment by transfer through the pair is not held', async () => {
  for (const how of ['rejected', 'expired']) {
    const w = world(), {pilot, P, Q, clock} = w, {d, a, T, by} = heldNote(w), pair = `${P.pubkey}>${Q.pubkey}`;
    assert.throws(() => pilot.assertTransferEdgeFree(pair), e => e.code === 'edge_busy', `${how}: while held, a transfer through the pair waits`);
    assert.equal(pilot.setoffPaymentBlock({edges: [{edge: pair}]}), 'held_note', `${how}: while held, no set-off (held_note)`);
    if (how === 'rejected') await pilot.decideApproval(P, a.id, {decision: 'reject'});
    else { clock.t = by; pilot.sweep(d); }
    assert.deepEqual([a.state, d.status], [how === 'rejected' ? 'rejected' : 'void_expired', 'delivered'], how);
    for (const later of [0, 2 * H, 30 * DAY]) {
      clock.t = Math.max(clock.t, T + later);
      assert.equal(pilot.paymentAttemptHolds().get(pair), T, `${how}, +${later / H} h: the pair is held for set-offs, from the note's timestamp`);
      assert.equal(pilot.setoffPaymentBlock({edges: [{edge: pair}]}), 'payment_attempt', `${how}, +${later / H} h: no set-off applies on it`);
      assert.doesNotThrow(() => pilot.assertTransferEdgeFree(pair), `${how}, +${later / H} h: a payment by transfer through the pair is not held`);
    }
    // The deal ends: disputed (a delivered deal), or paid with a new IOU. Either frees the pair.
    if (how === 'rejected') { d.status = 'disputed'; d.dispute = {by: P.id, reason: 'wrong', at: iso(clock.t)}; }
    else d.status = 'note_issued';
    assert.equal(pilot.paymentAttemptHolds().has(pair), false, `${how}: once the deal is ${d.status}, the pair is free`);
    assert.equal(pilot.setoffPaymentBlock({edges: [{edge: pair}]}), null, `${how}: a set-off may apply on it again`);
  }
});

test('decision D-1 still applies to an expired held note: a payment by transfer waits until its timestamp + 1 h + 60 s', async () => {
  const w = world(), {pilot, clock} = w, {d, T, by} = heldNote(w);
  clock.t = by;
  pilot.sweep(d);
  const b = await pilot.paymentBlock(d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5});
  assert.equal(b?.code, 'transfer_window_open', JSON.stringify(b));
  assert.ok(Math.abs(b.retry_after_ms - (fallbackAfter(T) - clock.t)) <= 2);
  clock.t = fallbackAfter(T) + 1;
  assert.equal(await pilot.paymentBlock(d, {route: 'transfer', fromEdge: 'some>edge', fromPrior: 5}), null, 'after its window: dead by age');
});

test('before the deadline an approval sends the held note as before (note_issued)', async () => {
  const w = world(), {pilot, P, clock, posted} = w, {d, a, T, by} = heldNote(w);
  clock.t = by - 1000;
  const r = await pilot.decideApproval(P, a.id, {decision: 'approve', note: 'fine'});
  assert.deepEqual([r.approval.state, r.approval.note, r.deal.status], ['approved', 'fine', 'note_issued']);
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].p, posted[0].body.timestamp, posted[0].body.amount, !!posted[0].body.prior_signature], ['/notes', T, 3, true]);
  assert.equal(d.credit_note.state, 'recorded');
  clock.t = by + H;
  pilot.sweep(d);
  assert.equal(d.status, 'note_issued', 'a recorded note never expires');
});

test('an ordinary held note has no deadline: it waits for its owner however long, decide_by null', () => {
  const w = world(), {pilot, P, clock} = w, {d, a} = heldNote(w, {bound: false});
  assert.equal(heldNoteDecideBy(d.credit_note), null);
  clock.t += 10 * H;
  pilot.sweep(d);
  assert.deepEqual([a.state, d.status], ['pending', 'completion_awaiting_owner']);
  const v = pilot.approvalView(a, P);
  assert.equal(v.decide_by, null);
  assert.equal(v.effect.deadline, 'No deadline: an ordinary note has no maximum age at the tracker, so it waits here until you decide.');
  assert.match(v.effect.if_rejected, /An ordinary note has no time limit at the tracker, so paying this deal by transfer is refused until this pair's note on the tracker moves past it\./);
  assert.doesNotMatch(v.effect.if_rejected, /attempts resolve/, 'valun 0.7.1\'s attempt records are said for a bound note only, as the probes saw them');
});

test('mode off (I-DARK): the approval view keeps v15\'s keys, no decide_by and no new effect keys, with the new texts', () => {
  const w = world({mode: 'off'}), {pilot, P} = w, {a} = heldNote(w, {bound: false});
  const v = pilot.approvalView(a, P);
  assert.ok(!('decide_by' in v));
  assert.deepEqual(Object.keys(v.effect), ['if_approved', 'if_rejected', 'checks_on_approve']);
  assert.match(v.effect.if_rejected, /^Valun doesn't send the note, and the deal goes back to delivered/);
  assert.doesNotMatch(v.effect.if_rejected, /by transfer/, 'no payment by transfer with circulation off');
});
