// The owner console's approval cards, one of each kind, on the testnet (nanoERG with its tERG): public/pilot.js on
// public/pilot.html's own body (test/network-dom.mjs readBody, test/console-dom.mjs), against the real routes of a real
// Pilot over a stub tracker (test/approval-fixtures.mjs: no tracker binary, no chain). Fitz's decisions of 2026-11-18:
// console is the first tester's default, and every approval text says what actually happens (the approval semantics
// of 2026-11-17: what waits is already signed by the agent's key and held by Valun's server; approving signs nothing
// new; rejecting unsigns nothing). Each card says, in plain words:
//   - what the agent asks to do, and with whom (an agent the operator runs named as one of its test agents);
//   - the amount, in nanoERG with tERG beside;
//   - what is already signed and held, and what approving and rejecting do, what stays on record after a rejection
//     included (the server's approvalEffect);
//   - the deadline, and once it has passed, that the approval expired (Approve and Reject off);
//   - for a guarantee offer, that a later call is paid by the agent's own IOU without asking the owner again.
// Then: a held IOU approved after its deadline is refused cleanly (409 not_pending, void_expired: the approval probe's
// D3), and the console says why; rejecting an IOU says what Valun keeps and when a payment by transfer may follow.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {installPage, text} from './console-dom.mjs';
import {readBody} from './network-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {approvalsWorld} = await import('./approval-fixtures.mjs');
const {HELD_NOTE_SEND_MARGIN_MS} = await import('../lib/pilot/core.mjs');
const {MAX_AGE_MS, fallbackAfter} = await import('../lib/pilot/novation.mjs');
const {appendEntries} = await import('../lib/pilot/journal.mjs');
const worlds = [], nodeFetch = globalThis.fetch;
after(() => { for (const w of worlds) w.close(); globalThis.fetch = nodeFetch; });
const MIN = 60e3;
const world = async opts => { const w = await approvalsWorld(opts); worlds.push(w); return w; };

// public/pilot.js on public/pilot.html's own body, its reads and writes sent to `base` (the real routes). Each page waits
// for the one before to be quiet (as test/console-testnet.test.mjs).
let instance = 0, previous = null;
async function openPage({base, token = null, hash = '#owner'}) {
  await previous?.quiet();
  const page = installPage({routes: () => undefined, token, hash, body: readBody(fs.readFileSync(path.join(root, 'public', 'pilot.html'), 'utf8'))});
  let reading = 0;
  page.quiet = async () => { for (let calm = 0; calm < 5; await new Promise(r => setTimeout(r, 10))) calm = reading ? 0 : calm + 1; };
  page.sent = [];
  globalThis.fetch = async (u, o = {}) => {
    page.sent.push({method: o.method || 'GET', path: String(u), body: o.body ? JSON.parse(o.body) : undefined});
    reading++;
    try { const r = await nodeFetch(new URL(u, base), o), body = await r.text(); return {ok: r.ok, status: r.status, text: async () => body}; } finally { reading--; }
  };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({unref() {}});
  try { await import(`${pathToFileURL(path.join(root, 'public', 'pilot.js')).href}?cards=${++instance}`); } finally { globalThis.setInterval = realInterval; }
  previous = page;
  page.$ = s => page.doc.querySelector(s);
  return page;
}
async function until(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = cond(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); }
}
const button = (card, label) => card.querySelectorAll('button').find(b => b.textContent === label);
// A card's rows of the server's words: {label: text}.
const rows = card => { const dl = card.querySelector('.effect dl'), dt = dl.querySelectorAll('dt'), dd = dl.querySelectorAll('dd'); return Object.fromEntries(dt.map((t, i) => [text(t), text(dd[i])])); };
const cardOf = (page, w, key) => page.doc.querySelectorAll('article.appr').find(c => (key === 'guarantee' ? c.dataset.guarantee === w.ids.guarantee : c.dataset.deal === w.ids[key]));
const NANO = n => `${n.toLocaleString('en-US')} nanoERG (${n / 1e9} tERG)`;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// valun 0.7.1 is never told of a rejected, expired or void bound IOU and keeps it as a payment attempt that may still
// apply (the approval probe's D2): the IOU card's words for it, as the console shows them (its commands as code). Only
// what holds in every case (the review of PR #9: each list of 0.7.1's conditions left a case it got wrong): it usually
// signs a new IOU for the deal at once, and it may refuse once something else changed the pair first or a key changed.
// Then what to do for each answer: transfer_window_open, pay again once the IOU's timestamp + 1 h + 2 min has passed
// (retry_after_ms); attempt_outcome_unknown, resolve it, then pay again once that time has passed.
// scripts/client-071-attempts.py checks both ways out in every case it runs (way_out); docs/PILOT-API.md has the
// conditions.
// The page's local time (public/pilot.js when): the server's ISO times are shown this way.
const when = ms => new Date(ms).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
// The held IOU's timestamp (it moves to rejected_notes or void_notes once it is rejected or expires), and when valun
// 0.7.1 pays the deal again after its owner resolved it as not applied: that timestamp + 1 h + 2 min.
const iouTs = w => { const d = w.pilot.s.deals[w.ids.iou]; return (d.credit_note ?? d.rejected_notes?.[0] ?? d.void_notes?.[0]).note.timestamp; };
const payableAt = w => when(iouTs(w) + 3600e3 + 120e3);
const refusalsText = w => `If it answers transfer_window_open, have your agent pay again once ${payableAt(w)} has passed, an hour and 2 minutes after this IOU's timestamp (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, run valun attempts resolve ${w.ids.iou} '#n' --not-applied in a terminal (#n from valun attempts list; in Hermes, hermes -p valun valun attempts ...): Valun never sent this IOU. Then have your agent pay again once ${payableAt(w)} has passed.`;
const trapText = w => `valun 0.7.1 isn't told either, and keeps counting this IOU as a payment that may still apply. It usually signs a new IOU for this deal at once. If anything else changed this pair's IOU first, or an agent's key changed, it may refuse. ${refusalsText(w)}`;
// The console's own words for it, after an expiry or a rejection it saw (pilot.js iouTrap). After a void IOU (409
// stale_note: its pair or a key changed since the agent signed it) not "usually at once": 0.7.1 then waits for the IOU's
// window or refuses until it is resolved, and signs at once only after a later IOU of its own (client-071-attempts.py
// cases 6, 6b, 5 and 2; the review of PR #9, final round).
const STALE_0_7_1 = "As the IOU between the two agents, or an agent's key, changed since your agent signed it, it may refuse to pay the deal.";
const USUAL_0_7_1 = "It usually signs a new IOU for the deal at once. If anything else changed the IOU between the two agents first, or an agent's key changed, it may refuse.";
const consoleTrap = (w, it = 'this IOU', at = payableAt(w), stale = false) => `valun 0.7.1 keeps counting ${it} as a payment that may still apply. ${stale ? STALE_0_7_1 : USUAL_0_7_1} If it answers transfer_window_open, have your agent pay again once ${at} has passed (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, run valun attempts resolve ${w.ids.iou} '#n' --not-applied in a terminal (#n from valun attempts list): Valun never sent it. Then have your agent pay again once ${at} has passed.`;
// The same for a rejected, expired or void payment by transfer (the review of PR #8, missed item): 0.7.1 keeps it as an
// attempt on the IOU it paid through (carol-research's to mira-research). It usually pays the deal again through that
// IOU at once while it is unchanged, and may refuse any other way or once that IOU has changed; then what to do for each
// answer (resolving it in the client's records only: the server ended the transfer).
const payTs = w => Object.values(w.pilot.s.transfers)[0].timestamp;
const paidAt = w => when(payTs(w) + 3600e3 + 120e3);
const payResolveText = (w, hermes = true) => `run valun attempts resolve ${w.ids.transfer} '#n' --not-applied in a terminal (#n from valun attempts list${hermes ? '; in Hermes, hermes -p valun valun attempts ...' : ''}) and answer yes to both of its questions, the second to record your decision in your client's records only`;
const payRefusalsText = w => `If it answers transfer_window_open, have your agent pay again once ${paidAt(w)} has passed, an hour and 2 minutes after the payment's timestamp (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, ${payResolveText(w)}: Valun never applied this payment. Then have your agent pay again once ${paidAt(w)} has passed.`;
const payTrapText = w => `valun 0.7.1 isn't told either, and keeps counting this payment as one that may still apply. It usually pays this deal again through carol-research's IOU at once while that IOU is as this payment found it; any other way, or once that IOU has changed, it may refuse. ${payRefusalsText(w)}`;
const consolePayTrap = (w, it = 'this payment') => `valun 0.7.1 keeps counting ${it} as one that may still apply. It usually pays this deal again through carol-research's IOU at once while that IOU is unchanged; any other way, or once that IOU has changed, it may refuse. If it answers transfer_window_open, have your agent pay again once ${paidAt(w)} has passed (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, ${payResolveText(w, false)}: Valun never applied it. Then have your agent pay again once ${paidAt(w)} has passed.`;

test('every kind of approval card says what the agent asks and with whom, the amount in nanoERG and tERG, what is already signed and held, what approving and rejecting do, and the deadline', async () => {
  const w = await world({confirm: true}), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => page.doc.querySelectorAll('article.appr').length === 7, 'seven cards');
  const pending = page.$('#approvals');
  assert.equal(text(pending.querySelector('h2')), 'Pending approvals 7');
  // Above the cards: what is true of everything that waits, and the payment by transfer's two exceptions (the review of
  // console/first-use): approved, it is signed by the other two parties, Valun signing for the agents it runs
  // (decidePayByTransfer serverSignatures); rejected, its three signatures are deleted (endTransfer purgeTransfer).
  assert.deepEqual(pending.querySelector('.pending-hint').querySelectorAll('p').map(text), [
    "Your agent has already signed each item below with its own key, and Valun's server holds what it signed. None of it binds anyone or reaches the tracker until you approve. While it waits, it already counts against your agent's limits, and for an acceptance, an IOU or a payment by transfer, the other side can see that it waits for you.",
    "Approving signs nothing with your agent's key: the server checks again, records your decision under your owner token (not signed with a key), then releases exactly what your agent signed (a payment by transfer then needs the other two parties' signatures: their clients sign, and Valun signs for the agents it runs). Rejecting stops it from taking effect, but it doesn't unsign what your agent signed: Valun keeps it on record, except a payment by transfer, whose three transfer signatures Valun deletes, keeping only their hashes. Each card says what your agent may do next. Your agent isn't told either way: tell it."]);
  // An agent the operator runs, named as such (pilot.js nameOf): the house agents as /start names them, the practice
  // agents (and the lab's) as its test agents.
  const HOUSE = "(one of the operator's house agents)", OP = "(one of the operator's test agents)";
  const TRAP = () => esc(trapText(w));
  const expect = {
    offer: {kind: 'propose', ask: `Your agent asks to hire house-scribe ${HOUSE} for this job at ${NANO(2e6)}, paid with your agent's own IOU once it accepts the work.`,
      held: /^Your agent signed this offer with its key, and Valun's server holds it: house-scribe can't see it, and nothing is on the tracker\. While it waits, it counts against your agent's limits, and as one of its open offers \(at most 10\), and your agent may still withdraw it\.$/,
      approve: /^Nothing new is signed\. house-scribe sees this offer, signed by your agent, and can accept, counter or decline it until .*\. If house-scribe accepts it, you aren't asked again, though house-scribe's own owner may have to approve its acceptance first\. The deal is then binding on both sides: house-scribe delivers by .*, and when your agent accepts the delivery, it signs an IOU to house-scribe for 2,000,000 nanoERG \(0\.002 tERG\), which waits for you here again \(Review deliveries\)\. Nothing reaches the tracker before that\.$/,
      reject: /^The offer is never shown to house-scribe, and the deal ends\. Valun keeps your agent's signed offer on record; it binds nobody and is not an IOU\./,
      deadline: /^Decide by .*, when the offer expires: the deal then ends, and an approval after that is refused\.$/},
    counter: {kind: 'propose', ask: `Your agent asks to answer the offer from dave-docs (${NANO(3e6)}) with this counter-offer at ${NANO(4e6)}, doing the job.`,
      held: /^Your agent signed this counter-offer \(version 2\) with its key, and Valun's server holds it: dave-docs can't see it, and dave-docs's offer \(version 1\) stays open meanwhile\. While it waits, it counts against your agent's limits, and your agent can't accept dave-docs's offer or counter it again; it may withdraw this counter-offer, or decline the offer\.$/,
      approve: /^Nothing new is signed\. This counter-offer replaces dave-docs's offer, .* The deal is then binding on both sides: your agent delivers by .*, and when dave-docs accepts the delivery, it owes you 4,000,000 nanoERG \(0\.004 tERG\): its IOU, a promise to pay, not a payment\. If your agent doesn't deliver within 7 days after that, the deal ends and nothing is owed\. Nothing reaches the tracker before that\.$/,
      reject: /^dave-docs never sees this counter-offer\. Its offer \(version 1\) stays open until .*: your agent may accept it, counter it again or decline it\. Valun keeps the signed counter-offer on record; it binds nobody\.$/,
      deadline: /^Decide by .*, when this counter-offer expires: an approval after that is refused, and dave-docs's offer stays open until it expires itself\.$/},
    accept: {kind: 'accept', ask: `Your agent asks to take a job from sandbox-exact ${OP}: your agent does the work, and sandbox-exact pays ${NANO(3e6)} with its IOU once it accepts it.`,
      held: /^Your agent signed its acceptance of sandbox-exact's job offer, and Valun's server holds it\. sandbox-exact already sees that your agent accepted and that this waits for you, but not the acceptance's signature, and it may still withdraw its offer\. Nothing is on the tracker\. The deal already counts against your agent's limits\.$/,
      approve: /^Nothing new is signed\. The deal is agreed and binding on both sides: your agent delivers by .*, and when sandbox-exact accepts the delivery, it owes you 3,000,000 nanoERG \(0\.003 tERG\): its IOU, a promise to pay, not a payment\./,
      reject: /^Your agent's acceptance doesn't take effect, and the offer is open again until .*: your agent may accept it again, which waits for you again\. sandbox-exact sees that the acceptance wasn't approved, never your note\. Valun keeps the signed acceptance on record; sandbox-exact never sees its signature\.$/,
      deadline: /^Decide by .*, when the offer expires: your agent's acceptance expires with it, and an approval after that is refused\.$/},
    confirm: {kind: 'confirm_offer', ask: `carol-research accepted the offer your agent made at ${NANO(1e6)} (your agent pays), and it binds only once you confirm it.`,
      held: /^Your agent signed this offer when its price was within your Ask me above; you have lowered that since, and carol-research has now accepted it\. carol-research's agent signed its acceptance, and Valun's server holds it: you see its signature once the deal is agreed\./,
      approve: /^Nothing new is signed\. The deal is agreed and binding on both sides: carol-research delivers by/,
      reject: /^Your agent's offer is withdrawn on your behalf, and carol-research's acceptance is void: nothing is agreed, and nothing is owed\. Both sides see that the offer was withdrawn by its owner, never your note\. Valun keeps both signatures on record\.$/,
      deadline: /^Decide by .*, when the offer expires: carol-research's acceptance expires with it/},
    iou: {kind: 'issue_note', ask: `Your agent accepted the delivery from house-scribe ${HOUSE} and asks to pay it: its own IOU to house-scribe for ${NANO(2e6)}.`,
      held: /^Your agent accepted house-scribe's delivery and signed two things with its key: its acceptance of the delivery, which house-scribe already sees, and an IOU to house-scribe for 2,000,000 nanoERG \(0\.002 tERG\): a complete Basis note with its prior acknowledgment that raises what you owe house-scribe from 0 nanoERG \(0 tERG\) to 2,000,000 nanoERG \(0\.002 tERG\)\. Valun's server holds the IOU: it is not on the tracker, and house-scribe sees its amount but not its signature\. Only Valun's server can submit it to the testnet tracker, and it does so only when you approve: that is the operator's word, not the chain's\. While it waits, the deal counts against your limits, no set-off touches this pair, and house-scribe's public record already counts the delivery as accepted\.$/,
      // The tracker box that commits it: the tracker's interval (BASIS_TRACKER_UPDATE_INTERVAL_SECONDS: 5 minutes on the
      // testnet, 30 by default) and the daily cap (DAILY_TRACKER_SIGNATURES) after which nothing is committed until 00:00 UTC.
      approve: /^Nothing new is signed\. The signed IOU goes to the Basis tracker: you then owe house-scribe 2,000,000 nanoERG \(0\.002 tERG\) more, .* The tracker records it at once, and a later tracker box commits it on Ergo testnet: the tracker checks every \d+ minutes, and posts at most 50 tracker boxes a UTC day; once they are used, the IOU is committed on chain only after 00:00 UTC\. It is a promise to pay: nothing is settled\. From then on the delivery stays accepted and can no longer be disputed, with one exception: if the tracker refuses the IOU, your agent must pay again, and a later IOU or payment by transfer of this deal that waits for you and isn't sent \(you reject it, it expires, or it becomes void: its checks fail when you approve it, or a party's agent key is revoked\) sends the deal back to delivered, where your agent may dispute the delivery, unless the deal was payment due before that \(it then stays payment due\)\. It is a bound note:/,
      // What stays blocked after a rejection (paymentAttemptHolds: no set-off on the pair until the deal is paid or
      // disputed), Valun's own wait for a payment by transfer, exactly (the first change of this key pair after the IOU's
      // timestamp, from the total it acknowledged: the review of PR #9, item 8), and that valun 0.7.1 is not told of a
      // rejection or an expiry (the approval probe's D2): what it usually does, that it may refuse, and what the owner
      // does for each answer.
      reject: new RegExp(`^Valun doesn't send the IOU, and the deal goes back to delivered: your agent may accept the delivery again, signing a new IOU \\(which waits for you again\\), or dispute it\\. house-scribe sees that you rejected it, never your note\\. Rejecting doesn't unsign the IOU: Valun keeps it on record, with its signatures, and never sends it\\. If it were sent, the tracker could still record it until .*, so paying this deal by transfer waits until .*, unless the first change to this key pair's IOU signed after this one moves it from 0 nanoERG \\(0 tERG\\), the total this one acknowledged, as a later IOU of your agent's to house-scribe on this key pair does when nothing else changed the pair first: Valun then doesn't wait for this one\\. Until your agent pays this deal or disputes the delivery, no set-off touches this pair: no loop that includes what you owe house-scribe clears\\. Your agent isn't told: tell it\\. ${TRAP()}$`),
      deadline: new RegExp(`^Approve or reject by .*\\. The tracker records this bound IOU only until .*, one hour after its timestamp, and Valun keeps the last minute for sending it\\. At .* this approval expires: Valun never sends the IOU, and the deal goes back to delivered, as after a rejection, so your agent may accept the delivery again\\. Your agent isn't told: tell it\\. ${esc(`As after a rejection, no set-off touches this pair until your agent pays this deal or disputes the delivery, and valun 0.7.1 keeps counting this IOU as a payment that may still apply. ${refusalsText(w)}`)}$`)},
    transfer: {kind: 'pay_by_transfer', ask: `Your agent accepted the delivery from dave-docs and asks to pay it with an IOU that carol-research issued: ${NANO(1e6)} of what carol-research owes you would move to dave-docs.`,
      held: /^Your agent accepted dave-docs's delivery and signed a payment by transfer: its acceptance of the delivery \(which dave-docs already sees\), its pay statement, and its three signatures of the transfer\. Your claim on carol-research would fall from 3,000,000 nanoERG \(0\.003 tERG\) to 2,000,000 nanoERG \(0\.002 tERG\), and carol-research's debt to dave-docs would rise from 0 nanoERG \(0 tERG\) to 1,000,000 nanoERG \(0\.001 tERG\)\. Valun's server holds them: nobody else has signed, nothing is listed for carol-research or dave-docs to sign, no signature has left Valun, and nothing is on the tracker\./,
      approve: /^Nothing new is signed by your agent\. If the checks below pass, carol-research and dave-docs sign within 20 minutes: their clients do it by themselves, and Valun signs for the agents it runs\. .* From your approval on, the delivery stays accepted: if the transfer then fails or expires, the deal is payment due, your agent must pay again, and the delivery can no longer be disputed\.$/,
      // A rejected payment stays an attempt of the deal: no set-off on the payer's claim on the issuer until it is paid.
      // Valun's rule (the same-prior exemption; any other way after fallback_after, or once its journal proves the
      // payment dead), the per-deal cap and which of the deal's payments this is (the review of PR #9, final round),
      // then what valun 0.7.1, which isn't told, does (payTrapText).
      reject: new RegExp(`^Nothing moves, and nothing reaches the tracker\\. Valun deletes your agent's three transfer signatures, keeping only their hashes\\. The deal goes back to delivered: your agent may pay again, or dispute the delivery\\. Valun lets it pay through carol-research's IOU at once, while that IOU is exactly as this payment found it \\(the tracker applies at most one of the two\\), and with its own IOU or any other IOU after .*, or sooner once either IOU this payment would have changed has changed since\\. Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became of them, and this is this deal's first\\. dave-docs sees that you rejected the payment, never your note\\. Until your agent pays this deal or disputes the delivery, no set-off touches your claim on carol-research: no loop that includes what carol-research owes you clears\\. Your agent isn't told: tell it\\. ${esc(payTrapText(w))}$`),
      deadline: new RegExp(`^Approve or reject by .*, 20 minutes after your agent signed it\\. The payment then ends as after a rejection: nothing moves, Valun deletes the signatures, and the deal goes back to delivered\\. Your agent isn't told: tell it\\. ${esc(`As after a rejection, valun 0.7.1 keeps counting this payment as one that may still apply. ${payRefusalsText(w)}`)}$`)},
    guarantee: {kind: 'guarantee_offer', ask: `Your agent asks to back what carol-research owes sandbox-exact ${OP}: if sandbox-exact calls this guarantee, your agent pays it, up to ${NANO(2e6)} in all, with its own IOU: with console approvals, nobody asks you again.`,
      held: /^Your agent signed this guarantee offer with its key, and Valun's server holds it: sandbox-exact and carol-research can't see it, and nothing is on the tracker\. Its cap of 2,000,000 nanoERG \(0\.002 tERG\) already counts against your agent's total-owed limit \(max_issue_outstanding\) while it waits\.$/,
      approve: /^Nothing new is signed\. sandbox-exact sees the offer and can accept it until .*; accepting needs no approval from its owner\. This is your last decision on it\. If sandbox-exact calls it between .* and .*, for what carol-research owes sandbox-exact, your agent has promised to pay each call within 24 hours with its own IOU to sandbox-exact, up to 2,000,000 nanoERG \(0\.002 tERG\) in all\. That IOU is never held for you: with console approvals your agent's client signs it without asking you, and the server records it at once\./,
      reject: /^The offer is never shown to sandbox-exact or carol-research, and it ends; its cap stops counting\. Valun keeps your agent's signed offer on record\. Nothing reaches the tracker\.$/,
      deadline: /^Decide by .*, when the offer expires: it then ends, and an approval after that is refused\.$/},
  };
  for (const [key, e] of Object.entries(expect)) {
    const card = cardOf(page, w, key);
    assert.ok(card, `${key}: its card`);
    assert.equal(card.dataset.kind, e.kind, key);
    assert.equal(text(card.querySelector('.appr-ask')), e.ask, `${key}: what the agent asks, with whom, and the amount`);
    const r = rows(card);
    assert.deepEqual(Object.keys(r), ['Already signed and held', 'If you approve', 'If you reject', 'Deadline', 'Checked again when you approve'], `${key}: the server's words`);
    assert.match(r['Already signed and held'], e.held, `${key}: held now`);
    assert.match(r['If you approve'], e.approve, `${key}: if approved`);
    assert.match(r['If you reject'], e.reject, `${key}: if rejected`);
    assert.match(r.Deadline, e.deadline, `${key}: the deadline`);
    assert.match(r['Checked again when you approve'], /checks? .*again|first checks/, `${key}: checked again`);
    assert.doesNotMatch(text(card), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${key}: every time in local time, no raw ISO time`);
    const line = card.querySelector('.appr-deadline');
    assert.match(text(line), /^Decide by .* \(in \d+ (minutes|hours?|days?)\)\.$/, `${key}: the deadline line`);
    assert.ok(!line.classList.contains('expired'));
    await until(() => !button(card, 'Approve').disabled, `${key}: Approve on once the terms hash checks out`);
    assert.equal(button(card, 'Reject').disabled, false, `${key}: Reject on`);
  }
  // What a failed check does, kind by kind (the review of console/first-use): an offer or an acceptance that fails one
  // stays pending (decideApproval throws before anything changes); an expired offer is not a failed check, since the
  // sweep has ended its approval by then (the Deadline row says so). An IOU or a payment whose state moved becomes void.
  for (const key of ['offer', 'counter', 'accept']) assert.equal(rows(cardOf(page, w, key))['Checked again when you approve'],
    `When you approve, the server first checks again: your mandate's hard limits (with your other commitments), and that both parties still have the keys named in the terms.${key === 'accept' ? ` The offer must also still be within sandbox-exact's mandate.` : ''} If a check fails, nothing changes and this stays pending.`, key);
  // Void, the IOU or payment is never sent, and the deal goes back to delivered, where the delivery can be disputed
  // (decideApproval void_stale; decidePayByTransfer endTransfer, releaseAcceptance: the review of PR #9, item 10); as
  // after a rejection, nothing tells the agent or valun 0.7.1 (code 2-1).
  assert.match(rows(cardOf(page, w, 'iou'))['Checked again when you approve'], /if not, the approval becomes void, Valun doesn't send the IOU, and the deal goes back to delivered: your agent may pay again, or dispute the delivery\. As after a rejection, your agent isn't told, and valun 0\.7\.1 keeps counting this IOU as a payment that may still apply\.$/);
  assert.match(rows(cardOf(page, w, 'transfer'))['Checked again when you approve'], /if not, the approval becomes void, nothing moves, and the deal goes back to delivered: your agent may pay again, or dispute the delivery\. As after a rejection, your agent isn't told, and valun 0\.7\.1 keeps counting this payment as one that may still apply\.$/);
  // The commands of the IOU card's and the payment card's words are shown as code: in the reject row, then in the
  // deadline row.
  const resolveCmd = `valun attempts resolve ${w.ids.iou} '#n' --not-applied`, hermesCmd = 'hermes -p valun valun attempts ...';
  assert.deepEqual(cardOf(page, w, 'iou').querySelectorAll('.effect code').map(text),
    [resolveCmd, 'valun attempts list', hermesCmd, resolveCmd, 'valun attempts list', hermesCmd]);
  const payCmd = `valun attempts resolve ${w.ids.transfer} '#n' --not-applied`;
  assert.deepEqual(cardOf(page, w, 'transfer').querySelectorAll('.effect code').map(text), [payCmd, 'valun attempts list', hermesCmd, payCmd, 'valun attempts list', hermesCmd]);
  // The limits box: clearing a limit is never held for the owner, and only the clients ask first (core.mjs
  // setAgentLimits; valun 0.7.1 agent.py loosens, ask mode; the Hermes plugin's confirm_commitments; client-prompt).
  assert.ok(text(page.$('#owner-console')).includes("It can also clear any of these limits, one you recorded included, which puts that limit back to your mandate's value at once. Valun doesn't hold that for you in any approval mode: only valun's ask mode, Hermes asking you in the conversation, and an app that confirms each tool call (client-prompt) ask you first."));
  assert.doesNotMatch(text(page.$('#owner-console')), /at once, without asking you/);
  // The deadlines themselves, as the server gives them (decide_by): the held IOU's an hour after its timestamp, less a
  // minute; the held payment's 20 minutes after the agent posted it.
  const iou = w.approvalOf('iou'), note = w.pilot.s.deals[w.ids.iou].credit_note;
  const served = (await (await nodeFetch(`${w.base}/pilot/v1/owner`, {headers: {authorization: `Bearer ${w.ownerToken}`}})).json()).approvals;
  assert.equal(served.find(a => a.id === iou.id).decide_by, new Date(note.note.timestamp + MAX_AGE_MS - HELD_NOTE_SEND_MARGIN_MS).toISOString());
  const tr = Object.values(w.pilot.s.transfers)[0];
  assert.equal(served.find(a => a.id === w.approvalOf('transfer').id).decide_by, tr.expires_at);
  assert.equal(served.find(a => a.kind === 'guarantee_offer').decide_by, w.pilot.s.guarantees[w.ids.guarantee].terms.offer_expires_at);
  // The payment by transfer's own details: while it waits for the owner, its deadline is the owner's, not a collection window.
  const tcard = cardOf(page, w, 'transfer');
  assert.match(text(tcard), /Approve or reject by.*\(in 1\d minutes\)/);
  assert.doesNotMatch(text(tcard), /Collects signatures until/);
  assert.match(text(tcard), /It waits for your approval first: until then nobody else can sign it, and nothing is listed for carol-research or dave-docs to sign\./);
});

test('a card whose deadline has passed while the page shows it says the approval expired, with Approve and Reject off; the server has ended it by its next read', async () => {
  // The server's clock 70 minutes behind this page's: the held IOU's deadline (its timestamp + 59 minutes) and the held
  // payment's (posted + 20 minutes) have passed for the page, not yet for the server.
  const w = await world({clock: {t: Date.now() - 70 * MIN}}), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => page.doc.querySelectorAll('article.appr').length === 6, 'six cards');
  for (const key of ['iou', 'transfer']) {
    const card = cardOf(page, w, key), line = card.querySelector('.appr-deadline');
    assert.ok(line.classList.contains('expired'), `${key}: said as expired`);
    assert.equal(line.getAttribute('role'), 'alert');
    assert.match(text(line), key === 'iou'
      ? new RegExp(`^This approval expired at .*\\. Valun never sends this IOU now\\. The deal went back to your agent, which may accept the delivery again \\(a new IOU, which waits for you again\\)\\. Tell your agent\\. ${esc(consoleTrap(w))} Approve and Reject are off\\. Refresh to see the deal as it is now\\.$`)
      : new RegExp(`^This approval expired at .*\\. Nothing moved, and Valun deleted your agent's transfer signatures: the deal went back to your agent, which may pay again\\. Tell your agent\\. ${esc(consolePayTrap(w))} Approve and Reject are off\\.`));
    assert.deepEqual(line.querySelectorAll('code').map(text), [`valun attempts resolve ${w.ids[key]} '#n' --not-applied`, 'valun attempts list'], `${key}: the commands as code`);
    await new Promise(r => setTimeout(r, 30));                  // the terms hash check, which must not turn Approve on
    assert.deepEqual([button(card, 'Approve').disabled, button(card, 'Reject').disabled], [true, true], `${key}: nothing to decide`);
    assert.equal(text(card.querySelector('.gate-msg')), "Approve and Reject are off: this approval's deadline has passed, and the server has ended it.");
    // The card's own deadline and state no longer read as live (staging's first-use round of 2026-11-18), and what was
    // written while it waited is greyed (pilot.css .appr.ended).
    assert.ok(card.classList.contains('ended'), `${key}: the card is ended`);
    assert.equal(card.querySelectorAll('.while-open').length, 0, `${key}: nothing of it still reads as live`);
    assert.doesNotMatch(text(card.querySelector('.mcheck')), /Approve or reject by|waiting for the payer's owner to approve|Valun ends this approval a minute before that/, key);
  }
  // A details row: the text of the <dd> after the <dt> that says `label` (null when there is none).
  const detail = (card, label) => {
    for (const dl of card.querySelectorAll('.mcheck dl')) {
      const i = dl.querySelectorAll('dt').findIndex(t => text(t) === label);
      if (i >= 0) return text(dl.querySelectorAll('dd')[i]);
    }
    return null;
  };
  const tcard = cardOf(page, w, 'transfer'), tr = Object.values(w.pilot.s.transfers)[0];
  assert.equal(detail(tcard, 'Transfer'), `${tr.id} · ended at its deadline: nothing moved, and Valun deletes your agent's three transfer signatures`);
  assert.equal(detail(tcard, 'Approve or reject by'), null);
  assert.equal(detail(tcard, 'Ended'), `${when(Date.parse(tr.expires_at))}: its deadline passed before you decided`);
  const n = w.pilot.s.deals[w.ids.iou].credit_note.note;
  assert.equal(detail(cardOf(page, w, 'iou'), 'Bound note'), `the tracker would have recorded it only until ${when(n.timestamp + MAX_AGE_MS)}; Valun ended this approval a minute before that and never sends this IOU`);
  assert.ok(!cardOf(page, w, 'offer').querySelector('.appr-deadline').classList.contains('expired'), 'an offer valid for a day has not expired');
  assert.ok(!cardOf(page, w, 'offer').classList.contains('ended'));
  // The server's clock catches up: its next read ends both (void_expired), and the console lists them as decided and void,
  // each at the time it ended, its deadline (decide_by: the sweep records no decided_at), never at the time it was asked.
  w.clock.t = Date.now();
  button(page.$('#owner-console .idbar'), 'Refresh').click();
  await until(() => page.doc.querySelectorAll('article.appr').length === 4, 'four cards left');
  assert.equal(w.approvalOf('iou').state, 'void_expired');
  assert.equal(w.pilot.s.deals[w.ids.iou].status, 'delivered', 'the deal back to delivered, as after a rejection');
  assert.match(text(page.$('#owner-console')), /Decided and void approvals \(2\)/);
  const rowsOf = page.$('#owner-console').querySelectorAll('tr').filter(r => /void expired/.test(text(r)));
  assert.equal(rowsOf.length, 2);
  for (const [key, by] of [['iou', n.timestamp + MAX_AGE_MS - HELD_NOTE_SEND_MARGIN_MS], ['transfer', Date.parse(tr.expires_at)]]) {
    const row = rowsOf.find(r => text(r).includes(w.approvalOf(key).id));
    assert.equal(text(row.querySelectorAll('td')[3]), `ended ${when(by)}`, `${key}: when it ended`);
  }
});

// The review of PR #8, code F4: on an offer, counter-offer, acceptance or guarantee card, the offer's expiry is the
// card's deadline (decide_by), so once that has passed the row says so, as the card's own deadline line does, instead of
// keeping "(in N seconds)" until the next read. The server's clock two days behind this page's: every card has ended for
// the page, none yet for the server.
test('an offer, counter-offer, acceptance or guarantee card that has ended says its offer expired in the row that gave the expiry; an expiry that is not the deadline stays as it was', async () => {
  const w = await world({clock: {t: Date.now() - 2 * 24 * 3600e3 - 3600e3}}), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => page.doc.querySelectorAll('article.appr').length === 6, 'six cards');
  // A terms row: the text of the <dd> after the <dt> `label`, outside the server's words and the details below.
  const row = (card, label, within = card) => {
    for (const dl of within.querySelectorAll('dl')) {
      if (dl.closest?.('.effect') || dl.closest?.('.mcheck')) continue;
      const i = dl.querySelectorAll('dt').findIndex(t => text(t) === label);
      if (i >= 0) return dl.querySelectorAll('dd')[i];
    }
    return null;
  };
  // The card's deadline as the server gives it (decide_by): the offer's expiry, a counter-offer's own here.
  const decideBy = key => w.pilot.approvalView(w.approvalOf(key), w.mira).decide_by;
  for (const key of ['offer', 'counter', 'accept']) {
    const card = cardOf(page, w, key), dd = row(card, 'Offer expires at');
    assert.ok(card.classList.contains('ended'), key);
    assert.equal(decideBy(key), w.pilot.approvalView(w.approvalOf(key), w.mira).subject.terms.offer_expires_at, `${key}: the card's own offer's expiry`);
    assert.equal(text(dd), `${when(Date.parse(decideBy(key)))}: the offer expired before you decided`, key);
    assert.ok(dd.querySelector('.ended-now'), `${key}: said in the ended colour`);
  }
  const g = cardOf(page, w, 'guarantee'), gd = row(g, 'Offer open until');
  assert.equal(text(gd), `${when(Date.parse(w.pilot.s.guarantees[w.ids.guarantee].terms.offer_expires_at))}: the offer expired before you decided`);
  for (const card of page.doc.querySelectorAll('article.appr')) assert.equal(card.querySelectorAll('.while-open').length, 0, card.dataset.kind);
  // The offer a counter-offer answers expires after the counter-offer's own deadline here: its row stays a time.
  const countered = cardOf(page, w, 'counter').querySelector('details');
  const answered = text(row(cardOf(page, w, 'counter'), 'Offer expires at', countered));
  assert.equal(answered.replace(/ \([^)]+\)$/, ''), when(Date.parse(w.pilot.s.deals[w.ids.counter].versions[0].terms.offer_expires_at)), answered);
  // An agreed deal's terms (an IOU's, a payment's) give their offer's old expiry, which is no deadline of the card.
  assert.doesNotMatch(text(row(cardOf(page, w, 'iou'), 'Offer expires at')), /expired before you decided/);
});

// The review of PR #8, code F3: an ended card is greyed with a colour, never with opacity, which would also dim the
// rows inside it that say what became of it; both colours pass WCAG AA (4.5:1) on the card's background.
test('an ended card is greyed with the secondary text colour, not opacity, and its ended rows keep the caution colour, both above 4.5:1 on the card', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'pilot.css'), 'utf8'), site = fs.readFileSync(path.join(root, 'public', 'site.css'), 'utf8');
  const ended = css.split('\n').filter(l => l.startsWith('.appr.ended'));
  assert.deepEqual(ended, ['.appr.ended :is(.effect, .mcheck, .appr-ask), .appr.ended :is(.effect, .mcheck, .appr-ask) :not(.ended-now) { color: var(--dust); }',
    '.appr.ended .ended-now { color: var(--caution); }']);
  assert.doesNotMatch(css, /\.ended[^{]*\{[^}]*opacity/, 'no opacity on an ended card');
  const token = n => new RegExp(`--${n}: (#[0-9a-f]{6});`).exec(site)[1];
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.match(css, /\.appr \{[^}]*background: var\(--panel\)/, 'the card is on --panel');
  for (const n of ['dust', 'caution']) assert.ok(contrast(token(n), token('panel')) >= 4.5, `--${n} on --panel: ${contrast(token(n), token('panel')).toFixed(2)}:1`);
});

test('approving a held IOU after its deadline is refused cleanly (409 not_pending, void_expired: the approval probe\'s D3), the console says why, and the deal is back to delivered, never note_failed', async () => {
  const w = await world(), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'iou'), 'the IOU card');
  const card = cardOf(page, w, 'iou');
  await until(() => !button(card, 'Approve').disabled, 'Approve on');
  // The deadline passes (on the server's clock) while the owner reads the card.
  w.clock.t += 60 * MIN;
  button(card, 'Approve').click();
  await until(() => page.$('#approvals .flash'), 'the outcome');
  const iou = w.approvalOf('iou');
  assert.equal(text(page.$('#approvals .flash')), `Your decision on ${iou.id} was not applied: its deadline had passed, so the server had ended it (approval is void_expired; HTTP 409, not_pending). Valun never sends this IOU now. The deal went back to your agent, which may accept the delivery again (a new IOU, which waits for you again). Tell your agent. ${consoleTrap(w)} The console below shows the server's current state.`);
  assert.equal(iou.state, 'void_expired');
  const d = w.pilot.s.deals[w.ids.iou];
  assert.deepEqual([d.status, d.credit_note, d.void_notes.map(n => n.state)], ['delivered', null, ['expired']]);
  assert.ok(!page.doc.querySelectorAll('article.appr').some(c => c.dataset.deal === w.ids.iou), 'its card is gone');
  // The deal's history says what happened, for the owner and for the payee.
  globalThis.location.hash = `#owner/deal/${w.ids.iou}`; page.hashchange();
  await until(() => page.$('#history-card'), 'the deal view');
  assert.match(text(page.$('#history-card')), /The payer's owner did not decide on the credit note \(IOU\) by .*, its deadline: Valun never sent it, and the deal went back to delivered: the payer's agent may accept the delivery again/);
});

test('rejecting a held IOU says what Valun keeps and when a payment by transfer may follow, then that the agent isn\'t told', async () => {
  const w = await world(), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'iou'), 'the IOU card');
  const card = cardOf(page, w, 'iou'), note = w.pilot.s.deals[w.ids.iou].credit_note.note;
  button(card, 'Reject').click();
  await until(() => page.$('#approvals .flash'), 'the outcome');
  const said = text(page.$('#approvals .flash')), iou = w.approvalOf('iou');
  assert.match(said, new RegExp(`^Rejected \\(${iou.id}\\)\\. Valun didn't send the IOU, and keeps it on record, unsent; deal ${w.ids.iou} is back to: delivered – awaiting the payer, so your agent may accept the delivery again \\(a new IOU, which waits for you again\\) or dispute it\\. Paying this deal by transfer waits until .*, as the tracker could still record that IOU until an hour after it was signed, unless the first change to that key pair's IOU signed after it moves it from 0 nanoERG \\(0 tERG\\), the total it acknowledged, as a later IOU of your agent's to house-scribe on that key pair does when nothing else changed the pair first: Valun then doesn't wait for it\\. Until your agent pays this deal or disputes the delivery, no loop that includes what you owe house-scribe clears\\. Your agent isn't told: tell it\\. ${esc(consoleTrap(w, 'that IOU'))}$`));
  assert.equal(iou.state, 'rejected');
  assert.ok(w.pilot.s.deals[w.ids.iou].rejected_notes[0].note.signature === note.signature, 'kept, with its signature');
  // The server keeps every set-off off the pair meanwhile (paymentAttemptHolds), as the flash says.
  const pair = `${w.mira.pubkey}>${w.scribe.pubkey}`;
  assert.equal(w.pilot.paymentAttemptHolds().get(pair), note.timestamp);
});

// A rejected payment by transfer: the flash says the payer's claim on the issuer is held for set-offs until the deal is
// paid (or disputed), as the server holds it (paymentAttemptHolds: the transfer's from-edge).
test('rejecting a held payment by transfer says what the agent may do next and that no loop through its claim on the issuer clears meanwhile', async () => {
  const w = await world(), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'transfer'), 'the transfer card');
  button(cardOf(page, w, 'transfer'), 'Reject').click();
  await until(() => page.$('#approvals .flash'), 'the outcome');
  const a = w.approvalOf('transfer'), tr = Object.values(w.pilot.s.transfers)[0];
  assert.match(text(page.$('#approvals .flash')), new RegExp(`^Rejected \\(${a.id}\\)\\. Nothing moved, and Valun deleted your agent's transfer signatures, keeping only their hashes; deal ${w.ids.transfer} is back to: .*\\. Valun lets your agent pay again through carol-research's IOU at once, while it is unchanged, and any other way after .*, or sooner once either IOU that payment would have changed has changed since\\. Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became of them\\. Until your agent pays this deal or disputes the delivery, no loop that includes what carol-research owes you clears\\. Your agent isn't told: tell it\\. ${esc(consolePayTrap(w, 'that payment'))}$`));
  assert.equal(w.pilot.paymentAttemptHolds().get(tr.from_edge.edge), tr.timestamp, "the payer's claim on the issuer is held for set-offs");
  // and the issuer's debt to the payee until the payment's fallback_after (PILOT-API.md says both: the review of PR #8).
  assert.equal(w.pilot.paymentAttemptHolds().get(tr.to_edge.edge), tr.timestamp, "the issuer's debt to the payee, until fallback_after");
  w.clock.t = fallbackAfter(tr.timestamp) + 1;
  assert.equal(w.pilot.paymentAttemptHolds().has(tr.to_edge.edge), false, 'not after it');
  assert.equal(w.pilot.paymentAttemptHolds().get(tr.from_edge.edge), tr.timestamp, "the payer's claim on the issuer still");
  w.clock.t = Date.now();
  // Valun's rule after the rejection, as the card and the flash give it: a payment through the same IOU in the state
  // this one acknowledged starts at once (the same-prior exemption); any other waits until fallback_after, or until
  // Valun's journal proves this one dead: here carol-research pays mira-research with a new IOU after its timestamp.
  const d = w.pilot.s.deals[w.ids.transfer], from = tr.from_edge.before;
  assert.equal(await w.pilot.paymentBlock(d, {route: 'transfer', fromEdge: tr.from_edge.edge, fromPrior: from.total, fromPriorTimestamp: from.timestamp}), null, 'through the same IOU, unchanged: at once');
  const own = await w.pilot.paymentBlock(d, {route: 'note'});
  assert.equal(own?.code, 'transfer_window_open', JSON.stringify(own));
  assert.ok(Math.abs(own.retry_after_ms - (fallbackAfter(tr.timestamp) - w.clock.t)) <= 2, 'with its own IOU: after fallback_after');
  appendEntries(w.pilot, [{kind: 'issue', ref: 'vd_00000000000000ff', issuer_pubkey: w.carol.pubkey, recipient_pubkey: w.mira.pubkey, delta: 500_000,
    total_after: from.total + 500_000, timestamp: tr.timestamp + 60e3, signature: '02' + 'ab'.repeat(64)}]);
  assert.equal(await w.pilot.paymentBlock(d, {route: 'note'}), null, 'sooner, once an IOU it would have changed has changed since');
});

// After a lost answer the agent reads its inbox before it sends a commitment again (skill.md section 5): each item that
// waits for its owner names whom it is with, by handle, as the inbox's other sections do (staging's first-use round of
// 2026-11-18: a held offer named only its title and price). valun 0.7.1's valun_inbox passes the server's answer on as it
// is (agent.py inbox: client.inbox(), GET /pilot/v1/inbox; agent.call adds only unit-neutral amount names).
test('valun_inbox: every item awaiting the owner names its counterparty, as the other sections do', async () => {
  const w = await world({confirm: true});
  const res = await nodeFetch(`${w.base}/pilot/v1/owner`, {headers: {authorization: `Bearer ${w.ownerToken}`}});
  const box = (await res.json()).inbox;
  const by = Object.fromEntries(box.awaiting_your_owner.map(x => [x.kind === 'guarantee_offer' ? 'guarantee' : Object.keys(w.ids).find(k => w.ids[k] === x.deal_id), x]));
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, x]) => [k, [x.kind, x.counterparty]])), {
    offer: ['propose', 'house-scribe'], counter: ['propose', 'dave-docs'], accept: ['accept', 'sandbox-exact'], confirm: ['confirm_offer', 'carol-research'],
    iou: ['issue_note', 'house-scribe'], transfer: ['pay_by_transfer', 'dave-docs'], guarantee: ['guarantee_offer', 'sandbox-exact']});
  // The same shape as the other sections' items name it (Pilot.inbox brief), and the agent's own inbox is the same.
  for (const x of box.awaiting_your_owner) assert.deepEqual(Object.keys(x).slice(-3), ['title', 'price', 'counterparty'], x.kind);
  assert.deepEqual(w.pilot.inbox(w.mira).awaiting_your_owner, box.awaiting_your_owner);
  assert.ok(box.waiting_on_others.every(x => typeof x.counterparty === 'string'));
});

// The review of console/first-use: the operator's lab agents (lab-*) are its test agents too. The server names them by
// participant id (PILOT_OPERATOR_TEST_AGENTS: operator_test_agent in their public records), never by handle: a stranger
// can register a handle like lab-probe-7.
test('an agent of the operator\'s lab is named as one of the operator\'s test agents, from the server\'s configuration, never from a handle that looks like one', async () => {
  const w = await world({lab: true}), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'lab') && cardOf(page, w, 'labx'), 'both cards');
  assert.equal(text(cardOf(page, w, 'lab').querySelector('.appr-ask')),
    `Your agent asks to take a job from lab-first-mile-desk (one of the operator's test agents): your agent does the work, and lab-first-mile-desk pays ${NANO(1e6)} with its IOU once it accepts it.`);
  assert.equal(text(cardOf(page, w, 'labx').querySelector('.appr-ask')),
    `Your agent asks to take a job from lab-probe-7: your agent does the work, and lab-probe-7 pays ${NANO(1e6)} with its IOU once it accepts it.`);
  // The label is the server's: the public record says so, and only for the id its configuration names.
  const dir = await (await nodeFetch(`${w.base}/pilot/v1/participants`)).json(), list = Array.isArray(dir) ? dir : dir.participants;
  const rec = h => list.find(p => p.handle === h);
  assert.equal(rec('lab-first-mile-desk').operator_test_agent, true);
  assert.equal(rec('lab-probe-7').operator_test_agent, undefined);
  assert.equal(rec('house-scribe').operator_test_agent, undefined, 'a house agent keeps its own label');
});

// The review of console/first-use: a card's deadline is kept true while the page shows it, also when no refresh comes
// (the 30-s refresh waits while a note is being typed): at decide_by the card says the approval expired and turns
// Approve and Reject off.
test('a card whose deadline passes while the owner reads it turns to expired by itself, with Approve and Reject off, and no refresh', async () => {
  // The held IOU signed 59 minutes less 8 seconds ago: its deadline (its timestamp, 1.5 to 2.5 s before that, + 59
  // minutes) is about 6 seconds away.
  const w = await world({heldAgo: 59 * MIN - 8000}), page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'iou'), 'the IOU card');
  const card = cardOf(page, w, 'iou');
  assert.ok(!card.querySelector('.appr-deadline').classList.contains('expired'), 'not yet expired when it is shown');
  assert.ok(!card.classList.contains('ended'));
  assert.match(text(card.querySelector('.while-open')), /^the tracker records it only while the pair's total is still 0 nanoERG \(0 tERG\), and only until .* \(in [^)]+\); Valun ends this approval a minute before that$/, 'live while it waits');
  await until(() => !button(card, 'Approve').disabled, 'Approve on');
  const reads = page.sent.length;
  await until(() => card.querySelector('.appr-deadline.expired'), 'the card turns to expired', 12000);
  assert.ok(page.doc.body.contains(card), 'the same card, not a new rendering');
  assert.equal(page.sent.length, reads, 'nothing was read again');
  assert.match(text(card.querySelector('.appr-deadline')), /^This approval expired at .*\. Valun never sends this IOU now\. The deal went back to your agent/);
  assert.deepEqual([button(card, 'Approve').disabled, button(card, 'Reject').disabled], [true, true]);
  assert.equal(text(card.querySelector('.gate-msg')), "Approve and Reject are off: this approval's deadline has passed, and the server has ended it.");
  // Its own rows switch with it: nothing reads as live any more, and the rest is greyed (endCard).
  assert.ok(card.classList.contains('ended'));
  assert.equal(card.querySelectorAll('.while-open').length, 0);
  assert.match(text(card.querySelector('.ended-now')), /^the tracker would have recorded it only until .*; Valun ended this approval a minute before that and never sends this IOU$/);
});

// The review of console/first-use: a deal that was payment due already (an earlier payment by transfer of it failed)
// stays payment due after a rejection or an expiry, as the server releases it (releaseAcceptance): the delivery stays
// accepted, and the payer's agent must still pay it; it can't dispute it any more.
test('the held IOU of a deal that was already payment due: its card, its expiry and its rejection say it stays payment due', async () => {
  const w = await world({clock: {t: Date.now() - 70 * MIN}}), d = w.pilot.s.deals[w.ids.iou];
  d.payment_due_since = new Date(w.clock.t - 30 * MIN).toISOString();
  d.history.splice(d.history.length - 2, 0, {at: d.payment_due_since, by: 'valun', event: 'payment_due', transfer_id: 'vt_0000000000000000', reason: 'edge_changed'});
  w.pilot.save();
  const page = await openPage({base: w.base, token: w.ownerToken});
  await until(() => cardOf(page, w, 'iou'), 'the IOU card');
  const card = cardOf(page, w, 'iou'), r = rows(card);
  assert.match(r['If you reject'], /^Valun doesn't send the IOU\. The delivery stays accepted, and your agent must still pay it, with a new IOU or by transfer\./);
  assert.match(r.Deadline, /this approval expires: Valun never sends the IOU, and the deal stays payment due, as after a rejection: your agent must still pay it\./);
  assert.match(text(card.querySelector('.appr-deadline')), new RegExp(`^This approval expired at .*\\. Valun never sends this IOU now\\. The deal stays payment due: the delivery stays accepted, and your agent must still pay it\\. Tell your agent\\. ${esc(consoleTrap(w))} Approve and Reject are off\\.`));
  // The server's clock catches up: the deal stays payment due, with its completion.
  w.clock.t = Date.now();
  button(page.$('#owner-console .idbar'), 'Refresh').click();
  await until(() => !cardOf(page, w, 'iou'), 'the IOU card gone');
  assert.equal(w.approvalOf('iou').state, 'void_expired');
  assert.equal(w.pilot.s.deals[w.ids.iou].status, 'payment_due');
  assert.ok(w.pilot.s.deals[w.ids.iou].completion, 'the delivery stays accepted');
});

// The review of console/first-use: GuaranteeBook.approvalView sweeps the guarantee before it copies the approval, so
// the first read after offer_expires_at already says void_expired (it said pending, and the badge counted it).
test('a guarantee offer whose offer expired is void_expired from the first read on, never pending', async () => {
  const w = await world(), g = w.pilot.s.guarantees[w.ids.guarantee], a = w.approvalOf('guarantee');
  w.clock.t = Date.parse(g.terms.offer_expires_at) + MIN;
  const v = w.pilot.guarantees.approvalView(a, w.mira);
  assert.deepEqual([v.state, v.guarantee.state], ['void_expired', 'offer_expired']);
  const served = (await (await nodeFetch(`${w.base}/pilot/v1/owner`, {headers: {authorization: `Bearer ${w.ownerToken}`}})).json()).approvals;
  assert.equal(served.find(x => x.id === a.id).state, 'void_expired');
});

// The review of PR #9 (item 10; code 2 and 3): an approved IOU the tracker then refuses leaves the deal note_failed and
// sets no payment_due_since (core.mjs submitNote). The delivery stays accepted, and the payer can dispute it again only once a
// later payment of the deal that waits for the payer's owner isn't sent: rejected or expired (releaseAcceptance), or void
// when its checks fail on approval (void_stale) or a party's agent key is revoked (void_key_revoked); not once the deal was
// payment due (a payment by transfer that went out and did not apply: endTransfer). The flash after the approval and the
// deal view say so; the deal view names whoever decides as its reader sees it ("you" for the payer's own owner).
const refuseNotes = w => { w.pilot.basis.api = async () => ({status: 409, json: {code: 'novation_expired', error: 'refused'}, text: '{}'}); };
const unsent = (what, owner) => {
  const you = owner === 'you';
  return `${what} waits for ${owner} and isn't sent (${you ? 'you reject' : `${owner} rejects`} it, it expires, or it becomes void: its checks fail when ${owner} ${you ? 'approve' : 'approves'} it, or a party's agent key is revoked), which sends the deal back to delivered, unless it was payment due before that`;
};
const paymentDueBefore = w => {
  const d = w.pilot.s.deals[w.ids.iou];
  d.payment_due_since = new Date(w.clock.t - 30 * MIN).toISOString();
  d.history.splice(d.history.length - 2, 0, {at: d.payment_due_since, by: 'valun', event: 'payment_due', transfer_id: 'vt_0000000000000000', reason: 'edge_changed'});
  w.pilot.save();
};
test('approving a held IOU the tracker then refuses: the flash says the delivery stays accepted, and when the agent may dispute it again; a deal that was payment due, that it can\'t', async () => {
  for (const due of [false, true]) {
    const w = await world();
    if (due) paymentDueBefore(w);
    refuseNotes(w);
    const page = await openPage({base: w.base, token: w.ownerToken});
    await until(() => cardOf(page, w, 'iou'), 'the IOU card');
    const card = cardOf(page, w, 'iou');
    await until(() => !button(card, 'Approve').disabled, 'Approve on');
    button(card, 'Approve').click();
    await until(() => page.$('#approvals .flash'), 'the outcome');
    const iou = w.approvalOf('iou'), d = w.pilot.s.deals[w.ids.iou];
    assert.deepEqual([iou.state, d.status, !!d.payment_due_since], ['approved', 'note_failed', due], `due ${due}: approved, sent and refused`);
    assert.equal(text(page.$('#approvals .flash')), `Approved (${iou.id}), but the tracker did not record the IOU (novation_expired): deal ${w.ids.iou} is now: credit note failed. The delivery stays accepted: your agent must pay again, and ${due
      ? 'can no longer dispute it.' : `can't dispute it unless ${unsent('a later IOU or payment by transfer of it', 'you')}.`} Tell your agent: it carries on when it next checks.`, `due ${due}`);
  }
});

test('the deal view of a note_failed deal: who decides, as its reader sees it (you, for the payer\'s owner; the payer\'s owner, for the payee\'s), and never "your owner"', async () => {
  for (const due of [false, true]) {
    const w = await world();
    if (due) paymentDueBefore(w);
    refuseNotes(w);
    await w.pilot.decideApproval(w.mira, w.approvalOf('iou').id, {decision: 'approve'});
    const d = w.pilot.s.deals[w.ids.iou];
    assert.equal(d.status, 'note_failed');
    // house-scribe's owner signs in too: the payee's side of the same deal.
    const scribeToken = `vpo_${'5c'.repeat(16)}`;
    w.scribe.owner_token_hash = crypto.createHash('sha256').update(scribeToken).digest('hex');
    w.pilot.save();
    for (const [side, token, whose, owner] of [['payer', w.ownerToken, 'your', 'you'], ['payee', scribeToken, "mira-research's", "mira-research's owner"]]) {
      const page = await openPage({base: w.base, token, hash: `#owner/deal/${d.id}`});
      const p = await until(() => page.$('p.who-owes'), `the ${side}'s deal summary`);
      assert.equal(text(p), `The tracker did not record the credit note, so nothing is owed in Basis for this deal yet. The delivery stays accepted: ${whose} agent must pay it again, with a new credit note or by transfer, and ${due
        ? "can't dispute it any more." : `can't dispute it unless ${unsent('a later payment of it', owner)}.`}`, `${side}, due ${due}`);
      // ("Your owner approvals on this deal" is this reader's own list.)
      assert.doesNotMatch(text(page.$('#deal-view')), /your owner (rejects|resolves|approves|never)|by your owner/, `${side}, due ${due}`);
    }
  }
});

// The same for the deal view's other sentences that name an owner's decision (pilot.js summaryText, renderDeal): a
// payment by transfer whose outcome is unknown, which only the payer's owner resolves (endTransfer outcome_unknown), and
// a proposal its owner rejected, never offered.
test('the deal view says "you" to the owner whose agent it concerns: a payment by transfer only that owner resolves, a proposal that owner rejected', async () => {
  const w = await world();
  const t = Object.values(w.pilot.s.transfers)[0], dPay = w.pilot.s.deals[w.ids.transfer];
  w.approvalOf('transfer').state = 'approved'; t.state = 'collecting'; dPay.status = 'paying_by_transfer';
  w.pilot.endTransfer(t, 'outcome_unknown', 'attempt_outcome_unknown');
  assert.equal(dPay.status, 'payment_due');
  await w.pilot.decideApproval(w.mira, w.approvalOf('offer').id, {decision: 'reject'});
  assert.equal(w.pilot.s.deals[w.ids.offer].status, 'rejected_by_owner');
  const page = await openPage({base: w.base, token: w.ownerToken, hash: `#owner/deal/${w.ids.transfer}`});
  assert.equal(text(await until(() => page.$('p.who-owes'), 'the payment\'s deal summary')),
    'mira-research (you) accepted the delivery, but whether its payment by transfer applied cannot be told from the tracker. No other payment starts until you resolve it (after confirming with dave-docs). No dispute is possible any more.');
  globalThis.location.hash = `#owner/deal/${w.ids.offer}`; page.hashchange();
  await until(() => page.$('p.who-owes') && /proposal/.test(text(page.$('p.who-owes'))), 'the offer\'s deal summary');
  assert.equal(text(page.$('p.who-owes')), 'This proposal by mira-research (you) was rejected by you, so it was never offered. Nothing is owed under it.');
  assert.ok(text(page.$('#deal-view')).includes('mira-research (you) signed this proposal, but you never approved it, so it was never open for acceptance. The other side never saw it.'));
  assert.doesNotMatch(text(page.$('#deal-view')), /your owner (rejects|resolves|approves|never)|by your owner/);
});

// A deal of the fixture made payment due before its held payment (an earlier payment by transfer of it failed): its
// payment_due_since, and the event the console reads it by (pilot.js dueOf).
const dueBeforeFor = (w, key) => {
  const d = w.pilot.s.deals[w.ids[key]];
  d.payment_due_since = new Date(w.clock.t - 30 * MIN).toISOString();
  d.history.splice(d.history.length - 2, 0, {at: d.payment_due_since, by: 'valun', event: 'payment_due', transfer_id: 'vt_0000000000000000', reason: 'edge_changed'});
  w.pilot.save();
};
// The review of PR #9, code 2-1: an IOU or a payment by transfer whose checks fail when its owner approves it is void,
// as after a rejection (decideApproval void_stale; decidePayByTransfer endTransfer, releaseAcceptance). The server's 409
// says where that left the deal, as the card's "Checked again when you approve" row does: delivered, where the agent may
// pay again or dispute the delivery, or still payment due (it said "the agent must sign a new one" and "must pay it
// again" in both cases). Since the final round it also says until when a payment may have to wait, as the routes judge
// it (the console shows that time in local time): the void IOU waits until its fallback_after (the pair's change is
// timestamped before it), and so does every payment after the void payment (carol-research's IOU changed outside
// Valun's journal: the routes read the tracker, so the same IOU is not "as the payment found it"). Nothing tells the
// agent, or valun 0.7.1, which keeps what it signed as an attempt: the flash says what it does then (iouTrap, as a
// stale one; payTrap).
test('approving an IOU or a payment by transfer whose IOU moved since the agent signed: void, and the flash says where that left the deal (delivered, where it can be disputed, or payment due) and what valun 0.7.1 does then', async () => {
  for (const [key, due] of [['iou', false], ['iou', true], ['transfer', false], ['transfer', true]]) {
    const w = await world(), d = w.pilot.s.deals[w.ids[key]], what = `${key}, due ${due}`;
    if (due) dueBeforeFor(w, key);
    // The IOU the server checks again moved on the tracker: for the IOU, the pair (mira-research's IOU to house-scribe,
    // none when the agent signed) now holds a note; for the payment, carol-research's IOU to mira-research changed.
    if (key === 'iou') {
      w.notes.set(`${w.mira.pubkey}>${w.scribe.pubkey}`, {issuer_pubkey: w.mira.pubkey, recipient_pubkey: w.scribe.pubkey, amount_collected: '1000000', amount_redeemed: '0',
        timestamp: Math.floor((w.clock.t - 10 * MIN) / 1000) * 1000 + 997, signature: `02${'ab'.repeat(64)}`, denomination: 'erg', confirmation: {status: 'confirmed'}});
    } else {
      const k = `${w.carol.pubkey}>${w.mira.pubkey}`, n = w.notes.get(k);
      w.notes.set(k, {...n, amount_collected: String(Number(n.amount_collected) + 500_000), timestamp: n.timestamp + 1000, signature: `02${'cd'.repeat(64)}`});
    }
    const page = await openPage({base: w.base, token: w.ownerToken});
    const card = await until(() => cardOf(page, w, key), `${what}: its card`);
    await until(() => !button(card, 'Approve').disabled, `${what}: Approve on`);
    button(card, 'Approve').click();
    await until(() => page.$('#approvals .flash'), `${what}: the outcome`);
    const a = w.approvalOf(key);
    assert.deepEqual([a.state, d.status], ['void_stale', due ? 'payment_due' : 'delivered'], what);
    assert.equal(w.pilot.view(d, w.mira).next_actions.includes('dispute'), !due, `${what}: a dispute only once delivered`);
    const where = key === 'iou'
      ? (due ? 'the deal stays payment due, and your agent must still pay it, with a new IOU or by transfer' : 'the deal is delivered again, and your agent may accept the delivery again with a new IOU (or pay by transfer), or dispute it')
      : (due ? 'the deal stays payment due, and your agent must still pay it' : 'the deal is delivered again, and your agent may pay again or dispute the delivery');
    // Until when, by the routes' own rule (the void IOU's fallback_after; the void payment's, for both ways of paying).
    const fb = key === 'iou' ? fallbackAfter(iouTs(w)) : Object.values(w.pilot.s.transfers)[0].fallback_after;
    const wait = key === 'iou' ? `a payment by transfer may have to wait until ${when(fb)}` : `a payment may have to wait until ${when(fb)}`;
    const said = key === 'iou' ? `the pair's tracker total changed since your agent signed this credit note; the approval is void, and Valun never sent the IOU: ${where}; ${wait} (HTTP 409, stale_note)`
      : `carol-research's note to you or to dave-docs changed on the tracker (its total, timestamp or signature) since your agent signed this payment; nothing moved, and the approval is void: ${where}; ${wait} (HTTP 409, stale_payment)`;
    assert.equal(text(page.$('#approvals .flash')), `Your decision on ${a.id} was not applied: ${said}. Your agent isn't told: tell it. ${key === 'iou' ? consoleTrap(w, 'that IOU', payableAt(w), true) : consolePayTrap(w, 'that payment')} The console below shows the server's current state.`, what);
    assert.doesNotMatch(text(page.$('#approvals .flash')), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${what}: the server's time in local time`);
    // The routes agree: the void IOU's deal waits for a payment by transfer; the void payment's for every payment.
    const block = await w.pilot.paymentBlock(d, {route: 'transfer', fromEdge: `${w.carol.pubkey}>${w.mira.pubkey}`, fromPrior: Number(w.notes.get(`${w.carol.pubkey}>${w.mira.pubkey}`).amount_collected),
      fromPriorTimestamp: w.notes.get(`${w.carol.pubkey}>${w.mira.pubkey}`).timestamp});
    assert.deepEqual([block?.code, w.pilot.now() + block?.retry_after_ms - 1], ['transfer_window_open', fb], `${what}: a payment by transfer waits until then`);
    assert.deepEqual(page.$('#approvals .flash').querySelectorAll('code').map(text), [`valun attempts resolve ${w.ids[key]} '#n' --not-applied`, 'valun attempts list'], `${what}: the commands as code`);
  }
});

// The review of PR #9, code 2-2: a counter-offer's deadline is the earlier of its own expiry and that of the offer it
// answers (Pilot.approvalDecideBy). Where the answered offer expires first, the card's row of that offer gives the
// deadline (termsKv's endsAt), so once it has passed for the page that row says the offer expired, while the card's own
// expiry stays a time. The server's clock two days behind this page's.
test('a counter-offer whose answered offer expires first: that offer\'s row is the deadline and says it expired once it has passed, and the card\'s own expiry stays a time', async () => {
  const w = await world({answeredH: 6, clock: {t: Date.now() - 2 * 24 * 3600e3 - 3600e3}}), page = await openPage({base: w.base, token: w.ownerToken});
  const card = await until(() => cardOf(page, w, 'counter'), 'the counter-offer card');
  const v = w.pilot.approvalView(w.approvalOf('counter'), w.mira), answered = w.pilot.s.deals[w.ids.counter].versions[0].terms.offer_expires_at;
  assert.equal(v.decide_by, new Date(answered).toISOString(), "its deadline is the answered offer's expiry");
  assert.ok(Date.parse(v.subject.terms.offer_expires_at) > Date.parse(answered), 'which comes before its own');
  assert.match(v.effect.deadline, /^Decide by .*, when dave-docs's offer expires: the deal then ends, this counter-offer with it, and an approval after that is refused\.$/);
  await until(() => card.classList.contains('ended'), 'the card ended for the page');
  // A terms row: the <dd> after the <dt> `label`, outside the server's words and the details below.
  const row = (label, within) => {
    for (const dl of within.querySelectorAll('dl')) {
      if (dl.closest?.('.effect') || dl.closest?.('.mcheck')) continue;
      const i = dl.querySelectorAll('dt').findIndex(t => text(t) === label);
      if (i >= 0) return dl.querySelectorAll('dd')[i];
    }
    return null;
  };
  const theirs = row('Offer expires at', card.querySelector('details'));
  assert.equal(text(theirs), `${when(Date.parse(answered))}: the offer expired before you decided`);
  assert.ok(theirs.querySelector('.ended-now'), 'said in the ended colour');
  const own = row('Offer expires at', card);
  assert.notEqual(own, theirs);
  assert.equal(text(own).replace(/ \([^)]+\)$/, ''), when(Date.parse(v.subject.terms.offer_expires_at)), 'the card\'s own expiry stays a time');
  assert.equal(own.querySelector('.ended-now'), null);
});

// The review of PR #9, code 2-3: a deal whose only due marker is payment_outcome_unknown. A payment by transfer whose
// outcome the read-back could not decide makes the deal payment due (endTransfer: payment_due_since, the event
// payment_outcome_unknown), and resolving it as not applied records only payment_attempt_resolved: no payment_due event
// is ever written. The console still reads the deal as payment due (pilot.js dueOf): a held IOU of it that expires leaves
// it payment due, and once the tracker refuses an approved one, the delivery can't be disputed any more.
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;
async function unknownThenResolved(w, signAt) {
  const t = Object.values(w.pilot.s.transfers)[0], d = w.pilot.s.deals[w.ids.transfer];
  w.approvalOf('transfer').state = 'approved'; t.state = 'collecting'; d.status = 'paying_by_transfer';
  w.pilot.endTransfer(t, 'outcome_unknown', 'attempt_outcome_unknown');
  await w.pilot.resolveAttempt(w.mira, d.id, t.id, {outcome: 'not_applied'});
  assert.deepEqual([d.status, !!d.payment_due_since, d.history.some(h => h.event === 'payment_outcome_unknown'), d.history.some(h => h.event === 'payment_due')],
    ['payment_due', true, true, false], 'payment due, with no payment_due event');
  // The payer's agent pays it again with a bound IOU once that payment's fallback_after has passed: held for its owner.
  assert.ok(signAt > t.fallback_after, "after the resolved payment's fallback_after");
  w.clock.t = signAt;
  const sig = () => `02${crypto.randomBytes(64).toString('hex')}`;
  await w.pilot.complete(w.mira, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: sig(),
    credit_note: {total: d.agreement.terms.price.amount, timestamp: ending(w.clock.t - 1500, 997), signature: sig(), prior_signature: sig(), prior_total: 0, prior_timestamp: 0}});
  assert.equal(d.status, 'completion_awaiting_owner');
  return d;
}
const iouCardOf = (page, d) => page.doc.querySelectorAll('article.appr').find(c => c.dataset.deal === d.id && c.dataset.kind === 'issue_note');
test('a deal made payment due by a payment by transfer whose outcome was unknown, then resolved as not applied: the console reads it as payment due (a held IOU of it that expires, one the tracker refuses)', async () => {
  {
    // The new IOU's deadline passes for the page (the server's clock is 70 minutes behind it when the IOU is signed).
    const w = await world({clock: {t: Date.now() - 3 * 3600e3}}), d = await unknownThenResolved(w, Date.now() - 70 * MIN);
    const page = await openPage({base: w.base, token: w.ownerToken}), card = await until(() => iouCardOf(page, d), 'the new IOU card');
    const at = when(d.credit_note.note.timestamp + 3600e3 + 120e3);
    assert.equal(text(card.querySelector('.appr-deadline')).replace(/^This approval expired at [^.]*\. /, ''),
      `Valun never sends this IOU now. The deal stays payment due: the delivery stays accepted, and your agent must still pay it. Tell your agent. ${consoleTrap({...w, ids: {...w.ids, iou: d.id}}, 'this IOU', at)} Approve and Reject are off. Refresh to see the deal as it is now.`);
  }
  {
    // The tracker refuses the new IOU once its owner approves it.
    const w = await world({clock: {t: Date.now() - 2 * 3600e3}}), d = await unknownThenResolved(w, Date.now());
    refuseNotes(w);
    const page = await openPage({base: w.base, token: w.ownerToken}), card = await until(() => iouCardOf(page, d), 'the new IOU card');
    await until(() => !button(card, 'Approve').disabled, 'Approve on');
    button(card, 'Approve').click();
    await until(() => page.$('#approvals .flash'), 'the outcome');
    const a = Object.values(w.pilot.s.approvals).find(x => x.deal_id === d.id && x.kind === 'issue_note');
    assert.deepEqual([a.state, d.status], ['approved', 'note_failed']);
    assert.equal(text(page.$('#approvals .flash')), `Approved (${a.id}), but the tracker did not record the IOU (novation_expired): deal ${d.id} is now: credit note failed. The delivery stays accepted: your agent must pay again, and can no longer dispute it. Tell your agent: it carries on when it next checks.`);
    globalThis.location.hash = `#owner/deal/${d.id}`; page.hashchange();
    const p = await until(() => page.$('p.who-owes') && /credit note/.test(text(page.$('p.who-owes'))) && page.$('p.who-owes'), 'the deal summary');
    assert.equal(text(p), "The tracker did not record the credit note, so nothing is owed in Basis for this deal yet. The delivery stays accepted: your agent must pay it again, with a new credit note or by transfer, and can't dispute it any more.");
  }
});

// The review of PR #9, final round: Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became
// of them (core.mjs spendingPayerCheck, MAX_ATTEMPTS_PER_DAY): rejected, expired and voided ones count. Every rejected
// card said "Valun lets it pay through carol-research's IOU at once", the third's too, after which every payment by
// transfer of the deal is refused (403 payment_not_accepted, max_attempts_per_deal) until 24 hours after the first,
// through that same unchanged IOU too. Now each card names the cap and which of the deal's payments it is; the third's
// says until when another is refused and that only the agent's own IOU remains (valun 0.7.1 fetches the template before
// it signs, so it gets the 403 and signs nothing); so do the console's words after rejecting it, after its void (409
// stale_payment) and after its deadline; the 403 names the time; a held IOU of the deal after them says it too; and at
// that time a template through the same IOU is given again. The payments are made through the real routes (the
// fixture's stub tracker accepts any signature), each through carol-research's IOU as the first found it.
async function payAgainByTransfer(w, d) {
  const {pilot, mira, carol, dave, clock} = w, sig = () => `02${crypto.randomBytes(64).toString('hex')}`;
  clock.t += 5000;
  for (const x of [carol, dave]) x.client_features = {consents: true, roles: ['issuer', 'creditor', 'setoff'], at: new Date(clock.t).toISOString()};
  const tpl = await pilot.transferTemplate(mira, d.id, carol.id, {wait: false}), fe = tpl.from_edge.edge, te = tpl.to_edge.edge;
  await pilot.payByTransfer(mira, d.id, {issuer_id: carol.id, terms_hash: tpl.terms_hash, deliverable_sha256: tpl.deliverable_sha256,
    from_prior_total: tpl.from_edge.before.total, to_prior_total: tpl.to_edge.before?.total ?? 0, from_prior_timestamp: tpl.from_edge.prior_timestamp, to_prior_timestamp: tpl.to_edge.prior_timestamp,
    timestamp: tpl.timestamp, quote_digest: tpl.quote_digest, completion_signature: sig(), pay_signature: sig(), signatures: {[`${fe}:prior`]: sig(), [`${fe}:new`]: sig(), [`${te}:new`]: sig()}});
  return Object.values(pilot.s.approvals).find(x => x.deal_id === d.id && x.kind === 'pay_by_transfer' && x.state === 'pending');
}
const transferCardOf = (page, d) => page.doc.querySelectorAll('article.appr').find(c => c.dataset.deal === d.id && c.dataset.kind === 'pay_by_transfer');
test('the third payment by transfer of a deal in 24 hours: its card, the console after rejecting it, after its void and after its deadline, and the refusal that follows say until when another is refused; its own IOU remains', async () => {
  for (const how of ['reject', 'stale', 'expired']) {
    // 'expired': the server's clock 70 minutes behind the page's, so the third payment's deadline has passed for the page.
    const w = await world(how === 'expired' ? {clock: {t: Date.now() - 70 * MIN}} : {}), {pilot, mira, carol} = w, d = pilot.s.deals[w.ids.transfer];
    const first = Object.values(pilot.s.transfers)[0], cap = Date.parse(first.created_at) + 24 * 3600e3;
    const ordinal = a => pilot.approvalView(a, mira).effect.if_rejected.match(/Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became of them, and this is this deal's (\w+)\./)?.[1];
    assert.equal(ordinal(w.approvalOf('transfer')), 'first', how);
    await pilot.decideApproval(mira, w.approvalOf('transfer').id, {decision: 'reject'});
    const second = await payAgainByTransfer(w, d);
    assert.deepEqual([ordinal(second), pilot.approvalView(second, mira).transfers_refused_until], ['second', null], `${how}: the second, and another may start after it`);
    await pilot.decideApproval(mira, second.id, {decision: 'reject'});
    const third = await payAgainByTransfer(w, d), t3 = Object.values(pilot.s.transfers).find(t => t.approval_id === third.id);
    const v3 = pilot.approvalView(third, mira), fb = fallbackAfter(t3.timestamp), clientAt = t3.timestamp + 3600e3 + 120e3, iso = ms => new Date(ms).toISOString();
    assert.equal(v3.transfers_refused_until, iso(cap), `${how}: 24 hours after the first`);
    const RESOLVE = `run \`valun attempts resolve ${d.id} '#n' --not-applied\` in a terminal (#n from \`valun attempts list\`; in Hermes, \`hermes -p valun valun attempts ...\`) and answer yes to both of its questions, the second to record your decision in your client's records only: Valun never applied this payment`;
    assert.equal(v3.effect.if_rejected, `Nothing moves, and nothing reaches the tracker. Valun deletes your agent's three transfer signatures, keeping only their hashes. The deal goes back to delivered: your agent may pay again, or dispute the delivery. This deal has had 3 payments by transfer in 24 hours, this one included, the most Valun allows, whatever became of them: Valun refuses another one until ${iso(cap)}, through carol-research's IOU too. With its own IOU, your agent may pay after ${iso(fb)}, or sooner once either IOU this payment would have changed has changed since. dave-docs sees that you rejected the payment, never your note. Until your agent pays this deal or disputes the delivery, no set-off touches your claim on carol-research: no loop that includes what carol-research owes you clears. Your agent isn't told: tell it. valun 0.7.1 isn't told either, and keeps counting this payment as one that may still apply. Until ${iso(cap)}, as Valun refuses another payment by transfer of this deal, your agent can pay it only with its own IOU, and 0.7.1 may refuse that. If it answers transfer_window_open, have your agent pay again once ${iso(clientAt)} has passed, an hour and 2 minutes after the payment's timestamp (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, ${RESOLVE}. Then have your agent pay again once ${iso(clientAt)} has passed.`, how);
    // The console's own words for 0.7.1 then (pilot.js payTrap with the cap), its times in local time.
    const capTrap = it => `valun 0.7.1 keeps counting ${it} as one that may still apply. Until ${when(cap)}, as Valun refuses another payment by transfer of this deal, your agent can pay it only with its own IOU, and 0.7.1 may refuse that. If it answers transfer_window_open, have your agent pay again once ${when(clientAt)} has passed (its retry_after_ms says how long to wait). If it answers attempt_outcome_unknown, run valun attempts resolve ${d.id} '#n' --not-applied in a terminal (#n from valun attempts list) and answer yes to both of its questions, the second to record your decision in your client's records only: Valun never applied it. Then have your agent pay again once ${when(clientAt)} has passed.`;
    if (how === 'stale') {
      // carol-research's IOU to mira-research changes on the tracker (outside Valun's journal) while the owner decides.
      const k = `${carol.pubkey}>${mira.pubkey}`, n = w.notes.get(k);
      w.notes.set(k, {...n, amount_collected: String(Number(n.amount_collected) + 500_000), timestamp: n.timestamp + 1000, signature: `02${'cd'.repeat(64)}`});
    }
    const page = await openPage({base: w.base, token: w.ownerToken}), card = await until(() => transferCardOf(page, d), `${how}: the third payment's card`);
    if (how === 'expired') {
      const line = await until(() => card.querySelector('.appr-deadline.expired'), 'the card says it expired');
      assert.match(text(line), new RegExp(`^This approval expired at .*\\. Nothing moved, and Valun deleted your agent's transfer signatures: the deal went back to your agent, which may pay again\\. Tell your agent\\. ${esc(capTrap('this payment'))} Approve and Reject are off\\.`));
      continue;
    }
    await until(() => !button(card, how === 'reject' ? 'Reject' : 'Approve').disabled && !button(card, 'Approve').disabled, `${how}: the buttons on`);
    button(card, how === 'reject' ? 'Reject' : 'Approve').click();
    await until(() => page.$('#approvals .flash'), `${how}: the outcome`);
    const flash = text(page.$('#approvals .flash'));
    if (how === 'reject') {
      assert.equal(third.state, 'rejected');
      assert.match(flash, new RegExp(`^Rejected \\(${third.id}\\)\\. Nothing moved, and Valun deleted your agent's transfer signatures, keeping only their hashes; deal ${d.id} is back to: [^.]*\\. ${esc(`That was this deal's third payment by transfer in 24 hours, the most Valun allows, whatever became of them: Valun refuses another one until ${when(cap)}, through carol-research's IOU too. With its own IOU, your agent may pay after ${when(fb)}, or sooner once either IOU that payment would have changed has changed since. Until your agent pays this deal or disputes the delivery, no loop that includes what carol-research owes you clears. Your agent isn't told: tell it. ${capTrap('that payment')}`)}$`));
    } else {
      assert.equal(third.state, 'void_stale');
      assert.equal(flash, `Your decision on ${third.id} was not applied: carol-research's note to you or to dave-docs changed on the tracker (its total, timestamp or signature) since your agent signed this payment; nothing moved, and the approval is void: the deal is delivered again, and your agent may pay again or dispute the delivery; a payment with its own IOU may have to wait until ${when(fb)}, and one by transfer until ${when(cap)} (HTTP 409, stale_payment). Your agent isn't told: tell it. ${capTrap('that payment')} The console below shows the server's current state.`);
    }
    // The routes say the same: the next template through carol-research's IOU is refused until that time, and names it;
    // with its own IOU, the agent may pay after the third's fallback_after (decision D-1).
    await assert.rejects(pilot.transferTemplate(mira, d.id, carol.id, {wait: false}), e => e.code === 'payment_not_accepted' && e.extra?.rule === 'max_attempts_per_deal' && e.extra?.by === 'payer'
      && e.message === `this agent cannot pay by transfer now: at most 3 attempts to pay one deal by transfer in 24 hours, whatever became of them; this deal's next can start at ${iso(cap)} at the earliest`, how);
    w.clock.t = fb + 2000;
    assert.equal(await pilot.paymentBlock(d, {route: 'note'}), null, `${how}: its own IOU after fallback_after`);
    if (how === 'reject') {
      // The agent pays it with its own bound IOU, held for its owner: the IOU card, and the console after rejecting it,
      // say that a payment by transfer of this deal is still refused until that time.
      const sig = () => `02${crypto.randomBytes(64).toString('hex')}`;
      await pilot.complete(mira, d.id, {terms_hash: d.agreement.terms_hash, deliverable_sha256: d.delivery.sha256, signature: sig(),
        credit_note: {total: d.agreement.terms.price.amount, timestamp: ending(w.clock.t - 1500, 997), signature: sig(), prior_signature: sig(), prior_total: 0, prior_timestamp: 0}});
      assert.equal(d.status, 'completion_awaiting_owner');
      const iou = Object.values(pilot.s.approvals).find(x => x.deal_id === d.id && x.kind === 'issue_note' && x.state === 'pending'), vi = pilot.approvalView(iou, mira);
      assert.equal(vi.transfers_refused_until, iso(cap));
      assert.ok(vi.effect.if_rejected.includes(`: Valun then doesn't wait for this one. Valun also refuses any payment by transfer of this deal until ${iso(cap)}: it allows at most 3 in 24 hours, whatever became of them, and this deal has had 3. Until your agent pays this deal`), vi.effect.if_rejected);
      const p2 = await openPage({base: w.base, token: w.ownerToken}), ic = await until(() => iouCardOf(p2, d), 'the IOU card');
      await until(() => !button(ic, 'Reject').disabled, 'Reject on');
      button(ic, 'Reject').click();
      await until(() => p2.$('#approvals .flash'), 'the IOU outcome');
      assert.ok(text(p2.$('#approvals .flash')).includes(`: Valun then doesn't wait for it. Valun also refuses any payment by transfer of this deal until ${when(cap)}: it allows at most 3 in 24 hours, whatever became of them, and this deal has had 3. Until your agent pays this deal`), text(p2.$('#approvals .flash')));
    }
    // At that time the cap lets a template through the same IOU be given again (after the void, carol-research's IOU moved
    // outside Valun's journal, which refuses it on its own: insufficient_claim, never the cap).
    w.clock.t = cap - 1;
    for (const x of [carol, w.dave]) x.client_features.at = new Date(w.clock.t).toISOString();
    await assert.rejects(pilot.transferTemplate(mira, d.id, carol.id, {wait: false}), e => e.extra?.rule === 'max_attempts_per_deal', `${how}: a millisecond before`);
    w.clock.t = cap;
    if (how === 'reject') assert.equal((await pilot.transferTemplate(mira, d.id, carol.id, {wait: false})).deal_id, d.id, `${how}: at that time`);
    else await assert.rejects(pilot.transferTemplate(mira, d.id, carol.id, {wait: false}), e => e.code === 'insufficient_claim', `${how}: at that time, not the cap`);
  }
});
