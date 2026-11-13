// The pilot owner console (public/pilot.js) with circulating credit (server release v16), run on a minimal DOM
// (test/console-dom.mjs) against a fake pilot API. No tracker, no browser.
//   - every deal status the server knows (lib/pilot/status.mjs STATUS_CLASS) has a console label, and the three
//     circulation statuses have the texts of the task; every deal history event the server records (lib/pilot/core.mjs)
//     has a title and a short form; every approval kind the server decides has a name;
//   - with circulation on: a pay_by_transfer approval shows the transfer (never "new proposal"), the position card shows
//     Hold, Owe, Net, Cleared and Spendable, the clearing panel shows the consents read-only and their receipts, the
//     mandate form has the circulation fields and sends only what changed, and the payer's owner resolves an attempt of
//     unknown outcome from the deal view (POST /owner/deals/{vd}/attempts/{vt}/resolve);
//   - a payment by transfer is approved only with its transfer shown, and a 409 stale_payment reloads the console and
//     says why; the payee's owner sees an attempt of unknown outcome but cannot resolve it, and it is not counted as
//     waiting for them; a participant directory that cannot be read never changes a participant list of the mandate;
//   - a payment by transfer that ended without effect: the card's text follows the deal's status (payment_due, or back
//     to delivered); an approval of a kind the page does not know offers neither Approve nor Reject;
//   - the network tab: with circulation on, the Features row and the clearing figures (GET /clearing);
//   - with circulation off: none of that appears (no GET /clearing; no circulation field even when the owner view carries
//     credit_policy).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {STATUS_CLASS} from '../lib/pilot/status.mjs';
import {termsHash} from '../lib/pilot/core.mjs';
import {installPage, settle, text, findByText} from './console-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(root, 'public', 'pilot.js'), 'utf8');
const CORE = fs.readFileSync(path.join(root, 'lib', 'pilot', 'core.mjs'), 'utf8');

// An object literal `const NAME = {...};` of pilot.js: its own keys (a key at the start of a line, or after `{` or `,`).
function literalBlock(name) {
  const start = SRC.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `pilot.js defines ${name}`);
  let depth = 0, i = SRC.indexOf('{', start);
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return SRC.slice(SRC.indexOf('{', start), i + 1);
}
const topKeys = block => {
  const keys = new Set(); let depth = 0, tok = '';
  for (let i = 1; i < block.length - 1; i++) {
    const ch = block[i];
    if ('{[('.includes(ch)) depth++; else if ('}])'.includes(ch)) depth--;
    if (depth === 0 && ch === ':' ) { const m = /([A-Za-z_][\w]*)\s*$/.exec(tok); if (m) keys.add(m[1]); tok = ''; }
    else if (depth === 0 && ch === ',') tok = ''; else if (depth === 0) tok += ch;
  }
  return keys;
};

test('every deal status the server knows has a console label; the circulation statuses have the task\'s texts', () => {
  const DEAL_STATUS = new Function(`return ${literalBlock('DEAL_STATUS')}`)();
  for (const s of Object.keys(STATUS_CLASS)) assert.ok(Array.isArray(DEAL_STATUS[s]) && DEAL_STATUS[s][0], `console label for status ${s}`);
  assert.equal(DEAL_STATUS.paying_by_transfer[0], 'paying by transfer (waiting for signatures)');
  assert.equal(DEAL_STATUS.paid_by_transfer[0], 'paid by transfer');
  assert.equal(DEAL_STATUS.payment_due[0], 'payment due (accepted, unpaid)');
});

test('every deal history event lib/pilot/core.mjs records has a console title and a short form, and so do the spec draft\'s transfer events', () => {
  // The event argument of every this.event(d, by, event, ...) call: each quoted name in it (a call may choose between
  // two: endTransfer's `unresolved ? 'payment_outcome_unknown' : 'payment_due'`).
  const emitted = new Set();
  for (let i = CORE.indexOf('this.event('); i >= 0; i = CORE.indexOf('this.event(', i + 1)) {
    let depth = 0, arg = 0, j = i + 'this.event('.length, third = '';
    for (; j < CORE.length; j++) {
      const ch = CORE[j];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) { arg++; continue; }
      if (arg === 2) third += ch;
    }
    for (const m of third.matchAll(/'([a-z_]+)'/g)) emitted.add(m[1]);
    // `owner_${a.state}` (decideApproval): approved or rejected.
    if (/^\s*`owner_\$\{a\.state\}`\s*$/.test(third)) { emitted.add('owner_approved'); emitted.add('owner_rejected'); }
  }
  for (const e of ['payment_by_transfer', 'payment_due', 'payment_outcome_unknown', 'paid_by_transfer', 'payment_attempt_resolved', 'owner_approved', 'credit_note_recorded'])
    assert.ok(emitted.has(e), `core.mjs records ${e}`);
  const titles = topKeys(literalBlock('EVENT_TITLE')), shorts = topKeys(literalBlock('EVENT_SHORT'));
  for (const e of [...emitted, 'transfer_created', 'transfer_applied', 'transfer_failed', 'transfer_expired', 'setoff_applied']) {
    assert.ok(titles.has(e), `EVENT_TITLE has ${e}`);
    assert.ok(shorts.has(e), `EVENT_SHORT has ${e}`);
  }
});

test('every approval kind the server decides has a console name; an unknown kind is never shown as a proposal', () => {
  const kinds = JSON.parse(/const APPROVAL_KINDS = Object\.freeze\((\[[^\]]+\])\)/.exec(CORE)[1].replace(/'/g, '"'));
  assert.deepEqual(kinds, ['issue_note', 'pay_by_transfer', 'propose', 'accept', 'confirm_offer', 'guarantee_offer']);
  const kindName = new Function(`return ${/const kindName = (a => [^;]+);/.exec(SRC)[1]}`)();
  const names = Object.fromEntries(kinds.map(k => [k, kindName({kind: k, version: 1})]));
  assert.deepEqual(names, {issue_note: 'credit note', pay_by_transfer: 'payment by transfer', propose: 'proposal', accept: 'acceptance', confirm_offer: 'accepted offer',
    guarantee_offer: 'guarantee offer'});
  assert.equal(kindName({kind: 'propose', version: 2}), 'counter-offer');
  assert.equal(kindName({kind: 'some_future_kind', version: 1}), 'approval of kind some_future_kind');
  assert.match(SRC, /const APPROVAL_KINDS = \['issue_note', 'pay_by_transfer', 'propose', 'accept', 'confirm_offer', 'guarantee_offer'\];/, 'the console names the same kinds');
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures in the server's shapes (lib/pilot/core.mjs view, approvalView, paymentView, consentItem, transferView,
// position; lib/pilot/clearing.mjs metrics).
const K = c => `02${c.repeat(64)}`, SIG = c => c.repeat(130), H = c => c.repeat(64);
const ME = {id: 'vp_aaaaaaaaaaaa', handle: 'olivia', display_name: 'Olivia', operator: 'Olivia Ops', about: '', services: '', pubkey: K('a'), status: 'active', joined_at: '2026-11-01T00:00:00.000Z', agent_last_seen: null};
const ISS = {id: 'vp_bbbbbbbbbbbb', handle: 'sandbox-exact', display_name: 'sandbox-exact', operator: 'Valun operator', about: '', services: '', pubkey: K('b'), status: 'active', joined_at: '2026-11-01T00:00:00.000Z', agent_last_seen: null, operator_run: true};
const PAYEE = {id: 'vp_cccccccccccc', handle: 'carol', display_name: 'Carol', operator: 'Carol Ops', about: '', services: '', pubkey: K('c'), status: 'active', joined_at: '2026-11-01T00:00:00.000Z', agent_last_seen: null};
const FUTURE = '2030-01-01T00:00:00.000Z', PAST = '2026-11-08T10:00:00.000Z';
const terms = id => ({protocol: 'valun-deal/1', network: 'valun-pilot-1', tracker_nft_id: H('d'), denomination: `token:${H('e')}`, deal_id: id, version: 1, prior_terms_hash: null,
  nonce: '0'.repeat(32), proposer: ME.id, payer: {id: ME.id, pubkey: ME.pubkey}, payee: {id: PAYEE.id, pubkey: PAYEE.pubkey},
  service: {title: `Job ${id.slice(-4)}`, description: 'synthetic', deliverable: 'text'}, price: {amount: 3, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
  deliver_by: FUTURE, offer_expires_at: FUTURE});
const edgeState = (total, ts, c) => ({total, timestamp: ts, signature: SIG(c)});
const tEdge = (which, before, nt) => ({edge: `${ISS.pubkey}>${which === 'from' ? ME.pubkey : PAYEE.pubkey}`, issuer: {id: ISS.id, handle: ISS.handle, pubkey: ISS.pubkey},
  recipient: which === 'from' ? {id: ME.id, handle: ME.handle, pubkey: ME.pubkey} : {id: PAYEE.id, handle: PAYEE.handle, pubkey: PAYEE.pubkey},
  before, new_total: nt, change: nt - (before?.total ?? 0)});
const labels = {signed_by_parties: 's', owner_approvals: 'o', basis: 'no credit note for this deal is in the Basis tracker', settlement: 'not settled: circulating', work: 'w'};
// `role`: this participant's (olivia's) role in the deal; as payee, carol pays olivia.
function dealView(id, status, {payment = null, history = [], next_actions = [], circulation = true, role = 'payer'} = {}) {
  const t = terms(id), [payer, payee] = role === 'payer' ? [ME, PAYEE] : [PAYEE, ME];
  if (role === 'payee') Object.assign(t, {payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}});
  return {id, status, overdue: false, you: ME.id, your_role: role, counterparty: PAYEE, next_actions,
    current: {version: 1, by: ME.id, state: 'agreed', terms: t, terms_hash: H('1'), signature: SIG('1'), offered_at: PAST}, pending_counter: null,
    versions: [{version: 1, by: ME.id, state: 'agreed', terms_hash: H('1'), price: t.price, signature: SIG('1'), created_at: PAST, offered_at: PAST}],
    acceptance: {version: 1, by: PAYEE.id, state: 'final', at: PAST, signature: SIG('2'), held_for: []},
    agreement: {version: 1, terms_hash: H('1'), formed_at: PAST, proposer_signature: SIG('1'), acceptor_signature: SIG('2')}, delivery_grace_ends_at: null, decline: null,
    delivery: {by: payee.id, title: 'done', content: 'the work', sha256: H('3'), bytes: 8, signature: SIG('3'), at: PAST, late: false},
    completion: {by: payer.id, signature: SIG('4'), at: PAST, deliverable_sha256: H('3')}, dispute: null, credit_note: null,
    ...(circulation ? {payment} : {}), cancellation: null, approvals: [], history, labels};
}
const VD_HELD = 'vd_1111111111111111', VD_UNKNOWN = 'vd_2222222222222222', VD_PAID = 'vd_3333333333333333', VD_DUE = 'vd_4444444444444444';
const VT_HELD = 'vt_aaaaaaaaaaaaaaaa', VT_UNKNOWN = 'vt_bbbbbbbbbbbbbbbb', VT_PAID = 'vt_cccccccccccccccc', VT_DUE = 'vt_dddddddddddddddd';
const pay = (vt, state, extra = {}) => ({method: 'transfer', state, transfer_id: vt, issuer: {id: ISS.id, handle: ISS.handle}, amount: 3, expires_at: FUTURE,
  fallback_after: null, signatures_withheld: state === 'applied' ? null : 'withheld until the Basis tracker records the transfer; then each party sees the signatures on its own edges', ...extra});
const T = 1762600000999;
function payApproval() {
  const d = dealView(VD_HELD, 'completion_awaiting_owner', {payment: pay(VT_HELD, 'awaiting_owner'), next_actions: ['wait_for_owner_approval']});
  const who = p => ({id: p.id, handle: p.handle, pubkey: p.pubkey});
  return {id: 'va_aaaaaaaaaaaa', participant: ME.id, deal_id: VD_HELD, kind: 'pay_by_transfer', version: 1, terms_hash: H('1'), created_at: PAST, state: 'pending',
    subject: {what: 'payment_by_transfer', version: 1, terms: d.current.terms, terms_hash: H('1'), signer: ME.id, signer_pubkey: ME.pubkey,
      statement: `valun-pilot/pay/1\n${VD_HELD}\n${H('9')}`, signature: SIG('5'), signed_at: PAST, mandate_check: null,
      delivery: {by: PAYEE.id, title: 'done', content: 'the work', sha256: H('3'), bytes: 8, at: PAST, late: false},
      transfer: {id: VT_HELD, state: 'awaiting_owner', issuer: who(ISS), payer: who(ME), payee: who(PAYEE), amount: 3,
        from_edge: tEdge('from', edgeState(5, T - 7000, '6'), 2), to_edge: tEdge('to', edgeState(1, T - 9000, '7'), 4), timestamp: T, quote_digest: H('9'), expires_at: FUTURE},
      completion: {statement: `valun-pilot/complete/1\n${H('1')}\n${H('3')}`, signature: SIG('4')}},
    mandate_check: null,
    effect: {if_approved: 'The transfer is submitted once sandbox-exact and carol sign.', if_rejected: 'Nothing moves.', checks_on_approve: 'When you approve, the server first checks again.'},
    deal: d};
}
const MANDATE = {objective: '', may_issue_credit: true, may_accept_credit: true, max_issue_per_deal: 25, max_issue_outstanding: 50, max_accept_per_deal: 25, max_accept_per_issuer: 50,
  min_price_as_payee: 0, min_payer_coverage_pct: 0, counterparties: 'any', approve_above: 0, review_deliveries: true, expires_at: null};
const CIRC = {auto_clear: true, novate_own_debt: true, accept_transfers: false, accept_notes_from: [], refuse_notes_from: [], pay_with_held_notes: 'when_asked'};
function ownerView({circulation}) {
  const deals = circulation ? [payApproval().deal,
    dealView(VD_UNKNOWN, 'payment_due', {payment: pay(VT_UNKNOWN, 'outcome_unknown'), history: [{at: PAST, by: 'valun', event: 'payment_outcome_unknown', transfer_id: VT_UNKNOWN, reason: 'attempt_outcome_unknown'}]}),
    dealView(VD_PAID, 'paid_by_transfer', {payment: pay(VT_PAID, 'applied', {applied_at: PAST}), history: [{at: PAST, by: 'basis-tracker', event: 'paid_by_transfer', transfer_id: VT_PAID, amount: 3}]}),
    dealView(VD_DUE, 'payment_due', {payment: pay(VT_DUE, 'expired', {fallback_after: FUTURE}), next_actions: ['wait_for_transfer_window', 'pay_by_transfer'],
      history: [{at: PAST, by: 'valun', event: 'payment_due', transfer_id: VT_DUE, reason: 'expired', fallback_after: FUTURE}]})]
    : [dealView(VD_DUE, 'delivered', {circulation: false, next_actions: ['complete', 'dispute']})];
  const position = circulation ? {participant_id: ME.id, unit: 'PC', claims_held: 5, owes: 2, net: 3, gross: 7, cleared_by_setoff: 1, transferred_in: 0, transferred_out: 3, novated_as_issuer: 0,
    spendable_notes: [{issuer_id: ISS.id, issuer_handle: ISS.handle, issuer_pubkey: ISS.pubkey, outstanding: 5, reserved: 3, spendable: 2, issuer_consents: 'immediate'}],
    frozen_claims: 0, pending: {paying_by_transfer: 1, consents_waiting_for_you: 1, consents_waiting_for_others: 0},
    claims: [{from: ISS.handle, amount: 5, issuer_id: ISS.id, issuer_pubkey: ISS.pubkey, recipient_pubkey: ME.pubkey, operator_run: true, label: 'issued with keys the operator holds'}],
    debts: [{to: PAYEE.handle, amount: 2, recipient_id: PAYEE.id, recipient_pubkey: PAYEE.pubkey, issuer_pubkey: ME.pubkey}],
    deals: {credit_notes_issued: 0, open: 0, agreed_note_not_issued: 3, disputed: 0, declined: 0, expired_or_withdrawn: 0, paid_by_transfer: 1, payment_due: 2},
    settled: 1, settled_how: 'by set-off only; nothing is redeemed', backing: 'none', meaning: 'moved or cleared'}
    : {participant_id: ME.id, unit: 'PC', claims_held: 5, owes: 2, net: 3, claims: [{from: ISS.handle, amount: 5}], debts: [{to: PAYEE.handle, amount: 2}],
      deals: {credit_notes_issued: 0, open: 0, agreed_note_not_issued: 1, disputed: 0, declined: 0, expired_or_withdrawn: 0}, settled: 0, backing: 'none', meaning: 'outstanding'};
  return {participant: ME, mandate: {...MANDATE, ...(circulation ? CIRC : {})}, mandate_version: 3, mandate_changed_by: 'owner', mandate_changed_at: PAST,
    agent_limits: {}, agent_limits_recorded_by: {}, effective_limits: {...MANDATE}, owner_token_rotated_at: null, owner_token_rotated_by: null,
    agent: {enrolled: true, pubkey: ME.pubkey, last_seen: PAST, enrollment_pending: false, enrollment_expires_at: null, enrollment_issued_by: null, key_registered_at: PAST},
    past_keys: [], approvals: circulation ? [payApproval()] : [], deals,
    inbox: {respond: [], deliver: [], review_delivery: [], awaiting_your_owner: [], waiting_on_others: [], recent_closed: [],
      ...(circulation ? {consents_waiting_for_your_client: 1, payments_in_progress: [{deal_id: VD_HELD}]} : {})},
    position,
    ...(circulation ? {credit_policy: {...CIRC}, features: {server: ['bound_notes/1', 'circulation/1'], consent_roles: ['setoff', 'issuer'], server_run: false, consents_declared_at: PAST, consents_count_until: FUTURE}} : {})};
}
const consents = {consents: [{kind: 'setoff', id: 'vs_eeeeeeeeeeeeeeee', state: 'collecting', your_roles: ['member'], created_at: PAST, expires_at: FUTURE, network: 'valun-pilot-1',
  tracker_nft_id: H('d'), denomination: `token:${H('e')}`, edges: [{edge: `${ME.pubkey}>${PAYEE.pubkey}`, issuer: {id: ME.id, handle: ME.handle}, recipient: {id: PAYEE.id, handle: PAYEE.handle},
    your_role: 'issuer', before: edgeState(2, T - 5000, '8'), change: -1, new_total: 1, timestamp: T - 1, revision: 1, slots: ['new'], signed_by_you: []}],
  context: {amount: 1}, summary: {your_net_change_PC: 0, your_total_owed_change_PC: -1}}],
  recently_resolved: [{kind: 'transfer', id: VT_PAID, state: 'applied', at: PAST}]};
const transferViewPaid = {id: VT_PAID, kind: 'transfer', state: 'applied', your_roles: ['payer'], attempt: 1, regenerated_from: null, regenerated_as: null, created_at: PAST, expires_at: FUTURE,
  updated_at: PAST, timestamp: T, amount: 3, issuer: {id: ISS.id, handle: ISS.handle}, payer: {id: ME.id, handle: ME.handle}, payee: {id: PAYEE.id, handle: PAYEE.handle},
  edges: [tEdge('from', edgeState(5, T - 7000, '6'), 2), tEdge('to', edgeState(1, T - 9000, '7'), 4)], deal: {deal_id: VD_PAID, terms_hash: H('1'), price: 3, quote_digest: H('9')},
  result: {code: 'applied', at: PAST, tracker_status: 200}, fallback_after: null,
  signatures: {issuer_from: SIG('a'), from_recipient_prior: SIG('b'), from_recipient: SIG('c'), from_recipient_to: SIG('d')}, tracker_after: {from: edgeState(2, T, 'a')}};
const info = circulation => ({network: 'valun-pilot-1', protocol: 'valun-deal/1', unit: 'PC', denomination: `token:${H('e')}`, tracker_nft_id: H('d'), tracker_on_chain: false, experimental: true,
  description: 'Valun pilot network', statements: {propose: 'h => `valun-pilot/propose/1\\n${h}`'}, participants: 3,
  ...(circulation ? {features: ['bound_notes/1', 'circulation/1'], novation: {transfer_ms: 999, setoff_ms: 998, bound_note_ms: 997, reserved_ms: [995, 996, 997, 998, 999], max_age_ms: 3600000,
    transfer_ttl_ms: 1200000, setoff_ttl_ms: 1800000, fallback_margin_ms: 60000}, circulation_statements: {pay: '(dealId, quoteDigest) => `valun-pilot/pay/1\\n${dealId}\\n${quoteDigest}`'}} : {})});
const clearing = {as_of: PAST, unit: 'PC', tier: 'pure_credit', engine: {enabled: true, interval_ms: 600000, limits: {}, last_run: {at: PAST, reason: 'interval', eligible_edges: 3, excluded: {}}},
  graph_now: {participants_with_positions: 3, edges: 3, gross_PC: 7, net_floor_PC: 3, clearable_mtcs_PC: 2, clearable_within_limits_PC: 2, bound_gap: 1},
  totals: {setoffs_applied: 1, cleared_PC: 2, edges_closed: 1, transfers_applied: 1, transferred_PC: 3}, last_7_days: {issued_PC: 9, cleared_PC: 2, liquidity_saving_pct: 22.2, capacity_restored_PC: 2},
  proposals: {collecting: 1, applied: 1, stale: 0, expired: 0, refused: 0, failed: 0, completion_rate_pct: 100, median_ms_to_apply: 900}, cycles_by_length: {2: 1}, sandbox: {dormant_PC: 0}};

// One page with circulation on or off; `extra(method, path, body)` answers first. `change(owner)` adjusts the owner view
// first; routes.owner is that view (GET /owner and GET /deals/{vd} answer from it, as it is at each call).
function serve({circulation, extra = () => undefined, change = null}) {
  const owner = ownerView({circulation});
  change?.(owner);
  const routes = (method, p, body) => extra(method, p, body) ?? (
    method === 'GET' && p === '/info' ? {status: 200, body: info(circulation)}
      : method === 'GET' && p === '/participants' ? {status: 200, body: [ME, ISS, PAYEE]}
      : method === 'GET' && p === '/ledger' ? {status: 200, body: {unit: 'PC', notes: [], reconciliation: []}}
      : method === 'GET' && p === '/clearing' && circulation ? {status: 200, body: clearing}
      : method === 'GET' && p === '/owner' ? {status: 200, body: owner}
      : method === 'GET' && p === '/consents' && circulation ? {status: 200, body: consents}
      : method === 'GET' && p.startsWith('/deals/') ? {status: 200, body: owner.deals.find(d => d.id === p.slice(7))}
      : method === 'GET' && p === `/transfers/${VT_PAID}` && circulation ? {status: 200, body: transferViewPaid}
      : undefined);
  routes.owner = owner;
  return routes;
}
let instance = 0;
async function openConsole(routes, {hash = '#owner'} = {}) {
  const page = installPage({routes, token: 'vpo_test-owner-token', hash});
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({unref() {}});
  try { await import(`${pathToFileURL(path.join(root, 'public', 'pilot.js')).href}?instance=${++instance}`); }
  finally { globalThis.setInterval = realInterval; }
  await settle();
  return page;
}

test('circulation on: approvals, unresolved attempts, position, clearing panel and mandate form in the owner console', async () => {
  let put = null;
  const page = await openConsole(serve({circulation: true, extra: (m, p, b) => {
    if (m === 'PUT' && p === '/owner/mandate') { put = b; return {status: 200, body: {mandate: {}, mandate_version: 4, changed_by: 'owner', changed: true}}; }
  }}));
  const con = page.doc.querySelector('#owner-console'), all = text(con);
  // The pay_by_transfer approval: its own label and the transfer, never "new proposal".
  const appr = con.querySelector('article.appr[data-kind=pay_by_transfer]');
  assert.ok(appr, 'the pending pay_by_transfer approval is shown');
  assert.match(text(appr), /payment by transfer: delivery accepted, paid with sandbox-exact's note/);
  assert.doesNotMatch(text(appr), /new proposal/);
  assert.match(text(appr), /you pay with sandbox-exact's note/);
  assert.match(text(appr), new RegExp(VT_HELD));
  assert.match(text(appr), /valun-pilot\/pay\/1/, 'the pay statement the agent signed');
  assert.match(text(appr), /valun-pilot\/complete\/1/, 'and the completion it signed with it');
  assert.match(text(appr), /sandbox-exact → olivia/, 'the payer\'s edge');
  assert.match(text(appr), /sandbox-exact → carol/, 'the payee\'s edge');
  assert.ok(!findByText(appr, 'Mandate check').length, 'no credit-note mandate check for a payment by transfer');
  // The attempt of unknown outcome, listed for the owner, with a link to its deal.
  const unresolved = con.querySelector('#unresolved-card');
  assert.ok(unresolved, 'payment attempts only the owner can resolve');
  assert.ok(unresolved.querySelector(`a[href=#owner/deal/${VD_UNKNOWN}]`));
  assert.equal(page.doc.querySelector('#pending-badge').textContent, '2 pending', 'one approval and one attempt to resolve');
  // Position: Hold, Owe, Net, Cleared and Spendable.
  for (const s of ['Hold', 'Owe', 'Net', 'Cleared', 'Spendable']) assert.ok(findByText(con, s).some(e => e.className === 'l' && e.textContent === s), `position stat ${s}`);
  assert.match(all, /Spendable2 PC/);
  assert.match(all, /issued with keys the operator holds/);
  assert.match(all, /payment due \(accepted, unpaid\)2/);
  // Clearing panel: consents read-only, receipts.
  const clr = con.querySelector('#clearing-card');
  assert.ok(clr, 'the clearing panel');
  assert.match(text(clr), /you can read them here, not sign them/);
  assert.match(text(clr), /Set-off vs_eeeeeeeeeeeeeeee/);
  assert.match(text(clr), /to sign \(new\)/);
  assert.ok(!clr.querySelectorAll('button').some(b => /^(Sign|Refuse)/.test(b.textContent)), 'nothing to sign or refuse here');
  const show = clr.querySelectorAll('button').find(b => b.textContent === 'Show');
  show.click(); await settle();
  assert.match(text(clr), /Your receipt: the signatures on your edges/);
  assert.ok(page.calls.some(c => c.path === `/transfers/${VT_PAID}` && c.auth === 'Bearer vpo_test-owner-token'));
  // Deals: the circulation statuses.
  assert.match(text(con.querySelector('#deals-card')), /delivery accepted – payment by transfer awaiting owner approval/);
  assert.match(text(con.querySelector('#deals-card')), /paid by transfer/);
  // The consents were read with the owner token, and the info once.
  assert.ok(page.calls.some(c => c.path === '/consents' && c.auth === 'Bearer vpo_test-owner-token'));
  // Mandate form: the circulation fields, and only changed fields are sent.
  const form = con.querySelector('#mandate-form');
  for (const n of ['c_auto_clear', 'c_novate_own_debt', 'c_accept_transfers', 'c_accept_operator_issuers', 'c_pay_with_held_notes', 'c_max_claims_total', 'c_max_issuer_net_debt'])
    assert.ok(form.querySelector(`[name=${n}]`), `mandate field ${n}`);
  assert.ok(form.querySelector('[name=anf_mode]') && form.querySelector('[name=rnf]'), 'accept_notes_from and refuse_notes_from');
  form.querySelector('[name=c_accept_transfers]').click();
  form.querySelector(`[name=anf][value=${ISS.id}]`).click();
  form.querySelector('[name=c_max_claims_total]').value = '30';
  form.dispatch('submit');
  await settle();
  assert.ok(put, 'the mandate was saved');
  assert.equal(put.accept_transfers, true);
  assert.deepEqual(put.accept_notes_from, [ISS.id]);
  assert.equal(put.max_claims_total, 30);
  for (const k of ['auto_clear', 'novate_own_debt', 'refuse_notes_from', 'pay_with_held_notes', 'max_issuer_net_debt', 'accept_operator_issuers']) assert.ok(!(k in put), `${k} unchanged, not sent`);
});

test('circulation on: the deal view shows the payment by transfer, and the payer\'s owner resolves an attempt of unknown outcome', async () => {
  let resolved = null;
  const routes = serve({circulation: true, extra: (m, p, b) => {
    if (m === 'POST' && p === `/owner/deals/${VD_UNKNOWN}/attempts/${VT_UNKNOWN}/resolve`) {
      resolved = b;
      return {status: 200, body: {resolution: {attempt_id: VT_UNKNOWN, outcome: b.outcome, previous_state: 'outcome_unknown', at: PAST, note: b.note},
        attempt: {id: VT_UNKNOWN, kind: 'transfer', timestamp: T}, deal: dealView(VD_UNKNOWN, 'payment_due'), transfer: {...transferViewPaid, id: VT_UNKNOWN, state: 'resolved_not_applied', fallback_after: FUTURE}}};
    }
  }});
  const page = await openConsole(routes, {hash: `#owner/deal/${VD_UNKNOWN}`});
  const view = page.doc.querySelector('#deal-view');
  assert.match(text(view), /payment due \(accepted, unpaid\)/);
  assert.match(text(view), /cannot be told from the tracker/);
  const card = view.querySelector('#transfer-card'), box = view.querySelector('#resolve-box');
  assert.ok(card && box, 'the payment card and the resolve action');
  assert.match(text(card), /outcome unknown/);
  const go = box.querySelectorAll('button').find(b => b.textContent === 'Resolve');
  assert.equal(go.disabled, true, 'nothing chosen yet');
  box.querySelector('input[value=not_applied]').click();
  assert.equal(go.disabled, true, 'not confirmed with the payee yet');
  box.querySelectorAll('input[type=checkbox]')[0].click();
  assert.equal(go.disabled, false);
  box.querySelector('.resolve-note').value = 'carol says no';
  go.click(); await settle();
  assert.deepEqual(resolved, {outcome: 'not_applied', note: 'carol says no'});
  assert.ok(page.calls.some(c => c.method === 'POST' && c.auth === 'Bearer vpo_test-owner-token' && c.path.endsWith('/resolve')));
  assert.match(text(page.doc.querySelector('#deal-view')), /Resolved as not applied/);
  // A paid deal: its summary and the history event.
  page.store.set('valun-pilot-owner-token', 'vpo_test-owner-token');
  globalThis.location.hash = `#owner/deal/${VD_PAID}`; page.hashchange(); await settle();
  const paid = text(page.doc.querySelector('#deal-view'));
  assert.match(paid, /Paid by transfer, not settled: sandbox-exact now owes carol/);
  assert.match(paid, /Paid by transfer: the Basis tracker applied it/);
  assert.ok(!page.doc.querySelector('#resolve-box'), 'nothing to resolve on a paid deal');
});

test('circulation off: no circulation panel, field, card or label in the owner console', async () => {
  const page = await openConsole(serve({circulation: false}));
  const con = page.doc.querySelector('#owner-console'), all = text(con);
  assert.ok(con.querySelector('#mandate-form'), 'the console rendered');
  for (const sel of ['#clearing-card', '#unresolved-card', '[name=c_auto_clear]', '[name=anf_mode]', '#transfer-card']) assert.equal(con.querySelector(sel), null, `no ${sel}`);
  assert.ok(!page.calls.some(c => c.path === '/consents' || c.path === '/clearing'), 'no circulation route is read');
  assert.match(all, /Claims held/);
  assert.doesNotMatch(all, /Spendable|Cleared|payment by transfer/i);
  assert.match(all, /When your agent accepts a delivery, the credit note it signs waits for your approval before it goes to the tracker\./, 'the v15 text');
});

// ---------------------------------------------------------------------------------------------------------------
// Approve is on only when the terms shown hash to the terms hash being approved (checked in the page): these fixtures
// carry the real hash of their terms.
const realHash = o => { for (const a of o.approvals) a.terms_hash = termsHash(a.subject.terms); };
const button = (root, label) => root.querySelectorAll('button').find(b => b.textContent === label);

test('circulation on: approving a payment by transfer that went stale (409 stale_payment) reloads the console and says why', async () => {
  const STALE = "sandbox-exact's note to you or to carol changed on the tracker (its total, timestamp or signature) since your agent signed this payment";
  const routes = serve({circulation: true, change: realHash, extra: (m, p, b) => {
    if (m === 'POST' && p === '/owner/approvals/va_aaaaaaaaaaaa') {
      // The server voids the approval and the transfer, and answers why.
      Object.assign(routes.owner.approvals[0], {state: 'void_stale', decided_at: PAST});
      return {status: 409, body: {error: 'stale_payment', message: STALE, reason: 'edge_changed', transfer_id: VT_HELD, deal_status: 'delivered'}};
    }
  }});
  const page = await openConsole(routes);
  const approve = button(page.doc.querySelector('article.appr[data-kind=pay_by_transfer]'), 'Approve');
  assert.equal(approve.disabled, false, 'the terms hash checks out and the transfer is shown');
  const from = page.calls.length;
  approve.click(); await settle();
  const calls = page.calls.slice(from), post = calls.findIndex(c => c.method === 'POST' && c.path === '/owner/approvals/va_aaaaaaaaaaaa');
  assert.ok(post >= 0, 'the decision was sent');
  assert.deepEqual(calls[post].body, {decision: 'approve', note: ''});
  assert.ok(calls.slice(post + 1).some(c => c.method === 'GET' && c.path === '/owner'), 'then the console reloads the owner view');
  const flash = page.doc.querySelector('#approvals .flash');
  assert.ok(flash, 'a message above the approvals');
  assert.equal(text(flash), `Your decision on va_aaaaaaaaaaaa was not applied: ${STALE} (HTTP 409, stale_payment). The console below shows the server's current state.`);
  assert.equal(page.doc.querySelector('article.appr[data-kind=pay_by_transfer]'), null, 'the void approval is no longer shown as pending');
  assert.match(text(page.doc.querySelector('#owner-console')), /Decided and void approvals \(1\)/);
});

test('circulation on: a payment by transfer whose transfer the server did not return cannot be approved, only rejected', async () => {
  const page = await openConsole(serve({circulation: true, change: o => { realHash(o); delete o.approvals[0].subject.transfer; }}));
  const appr = page.doc.querySelector('article.appr[data-kind=pay_by_transfer]');
  assert.equal(button(appr, 'Approve').disabled, true, 'Approve stays off');
  assert.equal(button(appr, 'Reject').disabled, false, 'Reject stays available');
  const gate = appr.querySelector('.gate-msg');
  assert.equal(gate.hidden, false);
  assert.equal(text(gate), 'Approve is off: this page cannot show the transfer you would be approving.');
  assert.match(text(appr), /The server did not return the transfer\./);
  assert.match(text(appr), /payment by transfer: delivery accepted, paid with another participant's note/);
  assert.doesNotMatch(text(appr), /new proposal/);
  // The same approval with its transfer: Approve is on.
  const ok = await openConsole(serve({circulation: true, change: realHash}));
  assert.equal(button(ok.doc.querySelector('article.appr[data-kind=pay_by_transfer]'), 'Approve').disabled, false);
});

test('circulation on: the payee\'s owner sees an attempt of unknown outcome but cannot resolve it, and it is not counted as waiting for them', async () => {
  const VD_IN = 'vd_5555555555555555', VT_IN = 'vt_eeeeeeeeeeeeeeee';
  const routes = serve({circulation: true, change: o => {
    o.deals.push(dealView(VD_IN, 'payment_due', {role: 'payee', payment: pay(VT_IN, 'inconsistent'),
      history: [{at: PAST, by: 'valun', event: 'payment_outcome_unknown', transfer_id: VT_IN, reason: 'inconsistent'}]}));
  }});
  const page = await openConsole(routes);
  // As payer of VD_UNKNOWN this owner resolves; as payee of VD_IN carol's owner does.
  assert.equal(page.doc.querySelector('#pending-badge').textContent, '2 pending', 'one approval and the one attempt this owner resolves');
  const card = page.doc.querySelector('#unresolved-card');
  assert.ok(card.querySelector(`a[href=#owner/deal/${VD_UNKNOWN}]`));
  assert.equal(card.querySelector(`a[href=#owner/deal/${VD_IN}]`), null, 'not the deal where this participant is paid');
  assert.match(text(card), /Payment attempts only you can resolve 1/);
  page.store.set('valun-pilot-owner-token', 'vpo_test-owner-token');
  globalThis.location.hash = `#owner/deal/${VD_IN}`; page.hashchange(); await settle();
  const view = page.doc.querySelector('#deal-view');
  assert.ok(view.querySelector('#transfer-card'), 'the payment by transfer is shown');
  assert.match(text(view.querySelector('#transfer-card')), /No other payment of this deal starts until the payer's owner resolves it/);
  assert.equal(view.querySelector('#resolve-box'), null, 'no resolve action for the payee\'s owner');
  assert.match(text(view), /Waiting for the payer's owner to resolve the earlier payment attempt\./);
});

test('circulation on: a participant directory that cannot be read never changes a participant list of the mandate', async () => {
  let put = null;
  const routes = serve({circulation: true, change: o => {
    Object.assign(o.mandate, {counterparties: [PAYEE.id, ISS.id], accept_notes_from: [ISS.id], refuse_notes_from: [PAYEE.id]});
    Object.assign(o.credit_policy, {accept_notes_from: [ISS.id], refuse_notes_from: [PAYEE.id]});
  }, extra: (m, p, b) => {
    if (m === 'GET' && p === '/participants') return {status: 503, body: {error: 'unavailable', message: 'the directory cannot be read just now'}};
    if (m === 'PUT' && p === '/owner/mandate') { put = b; return {status: 200, body: {mandate: {}, mandate_version: 4, changed_by: 'owner', changed: true}}; }
  }});
  const page = await openConsole(routes);
  assert.ok(page.calls.some(c => c.path === '/participants'), 'the directory was asked for');
  let form = page.doc.querySelector('#mandate-form');
  for (const [name, id] of [['cp', PAYEE.id], ['cp', ISS.id], ['anf', ISS.id], ['rnf', PAYEE.id]])
    assert.equal(form.querySelector(`[name=${name}][value=${id}]`)?.checked, true, `${name}: ${id} is shown, ticked, without the directory`);
  assert.match(text(form), /not in the participant directory just now/);
  // An unrelated change: every list is kept as it is.
  form.querySelector('[name=approve_above]').value = '7';
  form.dispatch('submit'); await settle();
  assert.ok(put, 'saved');
  assert.equal(put.approve_above, 7);
  assert.deepEqual(put.counterparties, [PAYEE.id, ISS.id], 'counterparties as they were');
  for (const k of ['accept_notes_from', 'refuse_notes_from']) assert.ok(!(k in put), `${k} unchanged, not sent`);
  // Unticking a participant is the owner's own change: sent.
  put = null; form = page.doc.querySelector('#mandate-form');
  form.querySelector(`[name=rnf][value=${PAYEE.id}]`).click();
  form.dispatch('submit'); await settle();
  assert.deepEqual(put.refuse_notes_from, [], 'the refusal the owner removed');
  assert.ok(!('accept_notes_from' in put));
  assert.deepEqual(put.counterparties, [PAYEE.id, ISS.id]);
  // With no list and no directory, the form says why there is nothing to tick.
  const empty = await openConsole(serve({circulation: true, extra: (m, p) => (m === 'GET' && p === '/participants' ? {status: 503, body: {error: 'unavailable', message: 'x'}} : undefined)}));
  assert.match(text(empty.doc.querySelector('#mandate-form')), /The participant directory could not be read just now: refresh to choose participants here\./);
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 3 (FX3-SV).
test('circulation on: a payment by transfer that ended without effect: the card says what that means by the deal\'s status (payment_due: the delivery stays accepted; delivered, after the payer\'s owner rejected it or it went stale, expired or lost a key while waiting for that owner: back to delivered, not accepted, still disputable; any other status: nothing more)', async () => {
  const STAYS = 'It ended without effect: nothing moved. The delivery stays accepted, so the payment is due again (in any way, the same note included, after the time below).';
  const BACK = 'It ended without effect: nothing moved. The deal is back to delivered: the delivery is not accepted yet. The payer\'s agent may accept it again (paying in any way, the same note included, after the time below) or dispute it.';
  const cases = [['5', 'delivered', 'void_rejected', BACK], ['6', 'delivered', 'void_stale', BACK], ['7', 'delivered', 'expired', BACK], ['8', 'delivered', 'void_key_revoked', BACK],
    ['9', 'note_issued', 'expired', 'It ended without effect: nothing moved.']];
  const extraDeals = o => {
    for (const [c, status, state] of cases) {
      const d = dealView(`vd_${c.repeat(16)}`, status, {payment: pay(`vt_${c.repeat(16)}`, state, {fallback_after: FUTURE}), next_actions: status === 'delivered' ? ['complete', 'dispute'] : []});
      if (status === 'delivered') d.completion = null;          // a completion held for the owner and undone (releaseAcceptance)
      o.deals.push(d);
    }
  };
  for (const [c, status, state, want] of [...cases, ['4', 'payment_due', 'expired', STAYS]]) {
    const page = await openConsole(serve({circulation: true, change: extraDeals}), {hash: `#owner/deal/vd_${c.repeat(16)}`});
    const view = page.doc.querySelector('#deal-view'), card = view.querySelector('#transfer-card');
    assert.ok(card, `${status}/${state}: the payment card`);
    const p = card.querySelectorAll('p')[0];
    assert.equal(text(p), want, `${status}, transfer ${state}`);
    if (status === 'delivered') {
      assert.doesNotMatch(text(card), /stays accepted/, `${state}: never "the delivery stays accepted" on a delivered deal`);
      assert.match(text(view), /delivered/i, `${state}: the deal is shown as delivered`);
    }
  }
});

test('the network tab: with circulation off it reads no GET /clearing and shows no Features row or clearing figures; with circulation on it shows the features and the clearing figures (GET /clearing, read once)', async () => {
  const off = await openConsole(serve({circulation: false}), {hash: '#network'});
  const infoOff = text(off.doc.querySelector('#info'));
  assert.match(infoOff, /Network\s*valun-pilot-1/, 'mode off: the network facts are shown');
  assert.ok(off.calls.some(c => c.method === 'GET' && c.path === '/info'), '/info was read');
  assert.ok(!off.calls.some(c => c.path === '/clearing'), 'mode off: no GET /clearing');
  assert.doesNotMatch(infoOff, /Features|circulation\/1|Clearing:|Debt outstanding now/, 'mode off: no features, no clearing figures');
  const on = await openConsole(serve({circulation: true}), {hash: '#network'});
  assert.equal(on.calls.filter(c => c.method === 'GET' && c.path === '/clearing').length, 1, 'mode on: GET /clearing once');
  const infoOn = text(on.doc.querySelector('#info'));
  assert.match(infoOn, /Features\s*bound_notes\/1, circulation\/1\s*Circulating credit is on: a payer may pay with a note it holds \(debt transfer\)/);
  assert.match(infoOn, /Clearing: what set-offs and transfers did/);
  assert.match(infoOn, /Debt outstanding now\s*7 PC gross over 3 notes; net floor 3 PC \(what no clearing can remove\)/);
  assert.match(infoOn, /Clearable now\s*2 PC in theory; 2 PC within the engine's limits/);
  assert.match(infoOn, /Applied so far\s*1 set-offs clearing 2 PC \(summed over every edge they decreased; 1 notes closed\); 1 transfers moving 3 PC/);
  assert.match(infoOn, /Last 7 days\s*9 PC issued, 2 PC cleared \(22\.2%\)/);
  assert.match(infoOn, /Set-off proposals\s*1 collecting; last 7 days: 1 applied, 0 superseded, 0 expired, 0 refused, 0 failed/);
  assert.match(infoOn, /Engine\s*running/);
});

test('an approval of a kind this page does not know offers neither Approve nor Reject (the server decides none: 409 unknown_approval_kind), and says why, even with its terms shown and their hash checked', async () => {
  const page = await openConsole(serve({circulation: true, change: o => { realHash(o); o.approvals[0].kind = 'some_future_kind'; }}));
  const appr = page.doc.querySelector('article.appr[data-kind=some_future_kind]');
  assert.ok(appr, 'shown');
  assert.match(text(appr), /approval of kind some_future_kind, which this page does not know/);
  assert.doesNotMatch(text(appr), /new proposal/);
  assert.equal(button(appr, 'Approve').disabled, true, 'no Approve');
  assert.equal(button(appr, 'Reject').disabled, true, 'no Reject');
  const gate = appr.querySelector('.gate-msg');
  assert.equal(gate.hidden, false);
  assert.equal(text(gate), 'This page does not know this kind of approval, and the server decides only the kinds it knows: nothing can be decided here.');
  // The same approval as the kind the server sent it as: Approve is on (only the kind gates it here).
  const known = await openConsole(serve({circulation: true, change: realHash}));
  assert.equal(button(known.doc.querySelector('article.appr[data-kind=pay_by_transfer]'), 'Approve').disabled, false);
});

test('circulation off (/info lists no circulation/1): the mandate form shows no circulation field, even when the owner view carries credit_policy and the mandate has the circulation fields', async () => {
  const page = await openConsole(serve({circulation: false, change: o => { Object.assign(o.mandate, CIRC); o.credit_policy = {...CIRC}; }}));
  const con = page.doc.querySelector('#owner-console'), form = con.querySelector('#mandate-form');
  assert.ok(form, 'the mandate form rendered');
  for (const sel of ['[name=c_auto_clear]', '[name=anf_mode]', '[name=max_claims_total]', '[name=max_issuer_net_debt]']) assert.equal(form.querySelector(sel), null, `no ${sel}`);
  assert.match(text(form), /When your agent accepts a delivery, the credit note it signs waits for your approval before it goes to the tracker\./, 'the v15 text');
  // With circulation/1 listed the same view has them.
  const on = await openConsole(serve({circulation: true}));
  assert.ok(on.doc.querySelector('#mandate-form [name=c_auto_clear]'), 'mode on: the circulation fields');
});

test('a guarantee offer held for the owner (fix inbox #18, approval kind guarantee_offer, no deal) shows its exact terms; Approve is on only while they hash to the terms hash; approving says it is offered', async () => {
  const t = {protocol: 'valun-guarantee/1', network: 'valun-pilot-1', tracker_nft_id: H('d'), denomination: `token:${H('e')}`, guarantee_id: 'vg_aaaaaaaaaaaaaaaa', nonce: H('1').slice(0, 32),
    backer: {id: ME.id, pubkey: ME.pubkey}, issuer: {id: PAYEE.id, pubkey: PAYEE.pubkey}, creditor: {id: ISS.id, pubkey: ISS.pubkey}, cap: {amount: 5, unit: 'PC'},
    covers: 'issuer_debt_to_creditor', due_at: FUTURE, expires_at: FUTURE, honor_within_hours: 24, offer_expires_at: FUTURE, note: 'backs carol for sandbox-exact'};
  const ga = h => ({id: 'va_bbbbbbbbbbbb', participant: ME.id, deal_id: null, guarantee_id: t.guarantee_id, kind: 'guarantee_offer', version: 1, terms_hash: h, created_at: PAST, state: 'pending',
    subject: {terms: t, terms_hash: h, mandate_check: {checks: [], mandate_version: 3}, issuer: PAYEE.id, creditor: ISS.id}, mandate_check: {checks: [], mandate_version: 3},
    effect: 'approving offers sandbox-exact this guarantee', deal: null,
    guarantee: {guarantee_id: t.guarantee_id, state: 'awaiting_owner', covers: 'What the issuer owes the creditor on the tracker when the creditor calls', offer: {signature: SIG('c')},
      creditor: {id: ISS.id, handle: ISS.handle}, offer_expires_at: FUTURE}});
  let posted = null;
  const routes = serve({circulation: true, change: o => { o.approvals = [ga(termsHash(t))]; }, extra: (m, p, b) => {
    if (m === 'POST' && p === '/owner/approvals/va_bbbbbbbbbbbb') { posted = b; Object.assign(routes.owner.approvals[0], {state: 'approved'}); return {status: 200, body: {approval: {...routes.owner.approvals[0]}, guarantee: {...routes.owner.approvals[0].guarantee, state: 'offered'}}}; }
  }});
  const page = await openConsole(routes);
  const appr = page.doc.querySelector('article.appr[data-kind=guarantee_offer]');
  assert.ok(appr, 'the pending guarantee approval is shown, with no deal');
  assert.match(text(appr), /guarantee offer/);
  assert.match(text(appr), /Back what carol owes sandbox-exact/);
  assert.match(text(appr), /up to 5 PC/);
  assert.match(text(appr), /backs carol for sandbox-exact/);
  assert.match(text(appr), /valun-pilot\/guarantee-offer\/1/, 'the statement the agent signed');
  assert.doesNotMatch(text(appr), /new proposal/);
  assert.equal(button(appr, 'Approve').disabled, false);
  button(appr, 'Approve').click();
  await settle();
  assert.deepEqual(posted, {decision: 'approve', note: ''});
  assert.match(text(page.doc.querySelector('#owner-console')), /Guarantee vg_aaaaaaaaaaaaaaaa is offered to sandbox-exact/);
  // Terms that do not hash to the terms hash: Approve stays off.
  const bad = await openConsole(serve({circulation: true, change: o => { o.approvals = [ga(H('7'))]; }}));
  assert.equal(button(bad.doc.querySelector('article.appr[data-kind=guarantee_offer]'), 'Approve').disabled, true);
});
