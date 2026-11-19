// The owner console's page (public/pilot.html, pilot.css and pilot.js; /pilot#owner, the address the clients print):
//   - it is a valun.tech page: the shared header (skip link, mark, main navigation) and footer, one h1 naming the owner
//     console, the site's stylesheet and its own, under the CSP (nothing inline);
//   - at the top of the owner view, a guide says what the console is for, where the owner token came from, what
//     approving does, who sees what, and never to share the token (a bearer token);
//   - its states are plain: signed out (the guide open beside the form), signing in (an agent token or anything that is
//     not an owner token is refused before anything is sent), loading, the errors (the server's error, no answer, a
//     token the server refuses), empty (what would wait here, by the owner's own mandate), and signed in (the guide
//     folded, one click from open);
//   - /pilot with no hash, or a hash that names no view, opens the owner console; the skip link moves focus without
//     changing the view; the connection status speaks only when it changes;
//   - the budget card's state is shown (published or not, and what it shows anyone), not changed, here.
// Run on the page's own body (test/network-dom.mjs readBody) with pilot.js against a fake API (test/console-dom.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Element, installPage, settle, text} from './console-dom.mjs';
import {readBody, cssRules} from './network-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const HTML = pub('pilot.html'), JS = pub('pilot.js'), CSS = pub('pilot.css');
const {createHandler} = await import('../lib/http.mjs');
const nodeFetch = globalThis.fetch;          // the pages below replace globalThis.fetch with their fake API

// ------------------------------------------------------------------------------------------------ a fake testnet API
const PAST = '2026-11-15T10:00:00.000Z', TOKEN = 'vpo_test-owner-token';
const ME = {id: 'vp_aaaaaaaaaaaa', handle: 'olivia', display_name: 'Olivia', operator: 'Olivia Ops', about: '', services: '', pubkey: `02${'a'.repeat(64)}`, status: 'active',
  joined_at: '2026-11-01T00:00:00.000Z', agent_last_seen: null};
const INFO = {network: 'valun-testnet-1', protocol: 'valun-deal/1', unit: 'nanoERG', denomination: 'erg', tracker_nft_id: 'd'.repeat(64), tracker_on_chain: true, experimental: true,
  chain: {name: 'ergo-testnet', on_chain: true}, description: 'Valun testnet network', statements: {}, participants: 3, features: ['bound_notes/1']};
const MANDATE = {objective: '', may_issue_credit: true, may_accept_credit: true, max_issue_per_deal: 5e6, max_issue_outstanding: 4e7, max_accept_per_deal: 5e6,
  max_accept_per_issuer: 4e7, min_price_as_payee: 0, min_payer_coverage_pct: 0, counterparties: 'any', approve_above: 5e6, review_deliveries: false, expires_at: null};
// An owner view in the server's shape (lib/pilot/http.mjs GET /owner) with nothing waiting and no deal; `extra` replaces
// fields (mandate: merged into the mandate).
function ownerView({mandate = {}, ...extra} = {}) {
  return {participant: ME, mandate: {...MANDATE, ...mandate}, mandate_version: 2, mandate_changed_by: 'owner', mandate_changed_at: PAST, public_card: false,
    agent_limits: {}, agent_limits_recorded_by: {}, effective_limits: {...MANDATE, ...mandate}, owner_token_rotated_at: null, owner_token_rotated_by: null,
    agent: {enrolled: true, pubkey: ME.pubkey, last_seen: PAST, enrollment_pending: false, enrollment_expires_at: null, enrollment_issued_by: null, key_registered_at: PAST},
    past_keys: [], approvals: [], deals: [], inbox: {respond: [], deliver: [], review_delivery: [], awaiting_your_owner: [], waiting_on_others: [], recent_closed: []},
    position: {participant_id: ME.id, unit: 'nanoERG', claims_held: 0, owes: 0, net: 0, claims: [], debts: [],
      deals: {credit_notes_issued: 0, open: 0, agreed_note_not_issued: 0, disputed: 0, declined: 0, expired_or_withdrawn: 0}, settled: 0, backing: 'none', meaning: 'outstanding'},
    ...extra};
}
// GET /info, /participants and /ledger; GET /owner answers `owner` (a view, or {status, body}) to the owner token, 401 to
// any other. `extra(method, path)` answers first.
const api = ({owner = ownerView(), extra = () => undefined} = {}) => (method, p, body, headers) => extra(method, p, headers) ?? (
  method === 'GET' && p === '/info' ? {status: 200, body: INFO}
    : method === 'GET' && p === '/participants' ? {status: 200, body: [ME]}
    : method === 'GET' && p === '/ledger' ? {status: 200, body: {unit: 'nanoERG', notes: [], reconciliation: []}}
    : method === 'GET' && p === '/owner' ? (headers.authorization !== `Bearer ${TOKEN}` ? {status: 401, body: {error: 'unauthorized', message: 'invalid token'}}
      : owner.status ? owner : {status: 200, body: owner})
    : undefined);

// pilot.js started on pilot.html's own body; `token`: kept in this tab's sessionStorage before the page loads.
let instance = 0;
async function open({routes = api(), token = null, hash = '', fetch = null} = {}) {
  const page = installPage({routes, token, hash, body: readBody(HTML)});
  if (fetch) { const base = globalThis.fetch; globalThis.fetch = (u, o) => fetch(u, o, base); }
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({unref() {}});
  try { await import(`${pathToFileURL(path.join(root, 'public', 'pilot.js')).href}?page=${++instance}`); } finally { globalThis.setInterval = realInterval; }
  await settle();
  page.$ = s => page.doc.querySelector(s);
  return page;
}
const button = (rootEl, label) => rootEl.querySelectorAll('button').find(b => text(b) === label);
const signIn = async (page, value) => {
  page.$('#owner-token').value = value;
  page.$('#login-form').dispatch('submit');
  await settle();
};

// ------------------------------------------------------------------------------------------------ the page itself
test('the page: a valun.tech page under the CSP, with the shared header and footer, one h1 naming the owner console, and the site\'s stylesheet and its own', () => {
  assert.equal(/<title>([^<]*)<\/title>/.exec(HTML)[1], 'Valun owner console');
  assert.deepEqual([...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1]), ['/site.css', '/pilot.css']);
  assert.deepEqual([...HTML.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script type="module" src="/pilot.js">']);
  assert.doesNotMatch(HTML, /<style\b|\sstyle=|\son[a-z]+=|="\s*javascript:/i, 'no inline style, script or event handler');
  assert.match(HTML, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.doesNotMatch(CSS, /@import|url\(/i, 'no outside font or image');
  const body = readBody(HTML), all = sel => body.querySelectorAll(sel);
  // The header: the skip link first, the mark home, the main navigation (none of its pages is this one).
  assert.equal(body.children[0].className, 'skip');
  assert.equal(body.children[0].getAttribute('href'), '#main');
  assert.equal(body.querySelector('header.top a.brand').getAttribute('href'), '/');
  assert.equal(body.querySelector('header.top a.brand').getAttribute('aria-label'), 'Valun home');
  const nav = body.querySelector('header.top nav');
  assert.equal(nav.getAttribute('aria-label'), 'Main');
  assert.deepEqual(nav.querySelectorAll('a').map(a => [text(a), a.getAttribute('href')]),
    [['Start', '/start'], ['Network', '/network'], ['Trust', '/trust'], ['Memory', '/memory'], ['GitHub', 'https://github.com/fitzss/valun-open']]);
  assert.equal(nav.querySelectorAll('a').filter(a => a.hasAttribute('aria-current')).length, 0);
  // One h1; each view is a direct child of <main id="main"> (pilot.js shows them one at a time) and has its headings.
  assert.deepEqual(all('h1').map(text), ['Owner console']);
  const main = body.querySelector('main');
  assert.equal(main.id, 'main');
  assert.deepEqual(main.children.filter(e => e.classList.contains('tab')).map(e => e.id), ['tab-owner', 'tab-network', 'tab-join']);
  for (const id of ['tab-owner', 'tab-network', 'tab-join']) assert.ok(body.querySelector(`#${id} h2`), `#${id} has a heading`);
  assert.deepEqual(body.querySelectorAll('#tab-owner h2').map(text), ['How the owner console works', 'Sign in']);
  assert.equal(body.querySelector('#tabs').getAttribute('aria-label'), 'Owner console views');
  assert.deepEqual(body.querySelectorAll('#tabs a').map(a => [a.getAttribute('href'), a.dataset.tab]), [['#owner', 'owner'], ['#network', 'network'], ['#join', 'join']]);
  // The footer every public page has.
  assert.equal(text(body.querySelector('footer.foot p')), 'Ergo testnet · test coins only, with no monetary value');
  assert.deepEqual(body.querySelectorAll('footer.foot a').map(a => [text(a), a.getAttribute('href')]), [['Trust', '/trust'], ['Report a problem', '/start#report'],
    ['skill.md', '/skill.md'], ['llms.txt', '/llms.txt'], ['GitHub', 'https://github.com/fitzss/valun-open']]);
  // Every element pilot.js looks up by id is in the page.
  const ids = new Set([...JS.matchAll(/\$\('#([a-z-]+)'\)/g), ...JS.matchAll(/put\('#([a-z-]+)'/g)].map(m => m[1]));
  for (const id of ids) assert.ok(body.all('*').some(e => e.id === id), `#${id}, which pilot.js looks up, is in public/pilot.html`);
  for (const id of ['owner-login', 'login-form', 'owner-token', 'login-msg', 'owner-console', 'deal-view', 'owner-guide', 'guide-body', 'guide-toggle', 'to-signin']) assert.ok(ids.has(id) || body.querySelector(`#${id}`), id);
});

test('the page is served at /pilot under the CSP, with both its stylesheets (the /pilot.css route is in lib/http.mjs)', async () => {
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public')}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const get = p => nodeFetch(`http://127.0.0.1:${server.address().port}${p}`).then(async r => ({status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), text: await r.text()}));
    const page = await get('/pilot');
    assert.equal(page.status, 200);
    assert.match(page.csp, /default-src 'self'.*style-src 'self'; script-src 'self'/);
    assert.equal(page.text, HTML);
    for (const [p, file] of [['/site.css', 'site.css'], ['/pilot.css', 'pilot.css'], ['/pilot.js', 'pilot.js']]) {
      const r = await get(p);
      assert.equal(r.status, 200, `${p} is served (lib/http.mjs STATIC)`);
      assert.equal(r.text, pub(file), p);
    }
  } finally { server.close(); }
});

test('without the script the page shows the guide and says why the console cannot open; with it, one view at a time', () => {
  const rules = cssRules(CSS), hides = sel => rules.some(r => r.selector === sel && r.decls.display === 'none');
  for (const sel of ['body:not(.js) .tabs', 'body:not(.js) #tab-network', 'body:not(.js) #tab-join', 'body:not(.js) .conn', 'body.js .tab:not(.active)']) assert.ok(hides(sel), sel);
  assert.ok(!rules.some(r => /#tab-owner|#owner-guide|\.guide/.test(r.selector) && r.decls.display === 'none'), 'nothing hides the guide');
  const body = readBody(HTML);
  assert.equal(body.querySelector('#owner-login').hidden, true, 'the sign-in form waits for the script (a form without it would put the token in the address)');
  assert.match(HTML, /<noscript><p class="note">The console needs JavaScript: this page talks to the Valun server for you, with your\s+owner token\./);
  assert.match(JS, /document\.body\.classList\.add\('js'\);\r?\nroute\(\);/, 'the class is set just before the first view is shown');
});

// What a token the server holds no record of gets (pilot.js loadOwner, and showDeal for a deal view): it is removed, and
// the form says what a 401 proves (no participant here holds that token), then its causes: a replaced token
// (rotateOwnerToken: New owner token, or the operator's reset), a released join (core.mjs releaseEnded removes the
// record of a self-serve join whose agent never enrolled a key, unless another participant's list names it), or a token
// this server never issued. The review of PR #8, promotion's missed item; of PR #9, item 12 and code 4.
const REFUSED_TOKEN = "That owner token is not valid on this server (HTTP 401): no participant here holds it. It has been removed from this tab. It was replaced (with New owner token, or by the operator), the join it was issued for was released, or this server never issued it (another Valun server's token, say). A self-serve join whose agent never enrolled a key is released when its hold ends, unless another participant's list names it; its handle was free again from then on, unless someone has joined with it since.";

test('the guide at the top of the owner view: what it is for, where the owner token came from, what approving does, who sees what, and never to share the token', () => {
  const body = readBody(HTML), guide = body.querySelector('#owner-guide');
  assert.equal(body.querySelector('#tab-owner').children[0], guide, 'the first thing in the owner view');
  const part = id => text(guide.querySelector(`#${id}`));
  // With console approvals, what waits (the approval semantics of 2026-11-17: never "all of them": honors, guarantee acts,
  // deliveries and consents never wait).
  assert.match(part('guide-for'), /^What it’s for Your agent signs its own deals with its own key\. Here you set the limits it works within, decide on what those limits hold for you \(with console approvals: its offers, counter-offers, acceptances and guarantee offers, and the note or payment by transfer at each delivery it accepts\), and see its deals and what it holds and owes\. Nothing can be signed here\.$/);
  const signin = part('guide-signin');
  // Where the token is: the file join wrote, the documented path named.
  assert.match(signin, /Use your owner token, which starts with vpo_\. You got it once, when you joined: valun join \(or the Hermes plugin’s join\) wrote it to the file you named with --owner-token-file \(with the commands on Start, \$HOME\/valun-owner-token-YOUR-HANDLE\.txt\), or showed it in the terminal\. Paste what that file holds\./);
  assert.match(signin, /Your client keeps no other copy, and the server keeps only a hash, so nobody can show it to you again\. An agent token \(vpa_…\) doesn’t work here\./);
  // What approving and rejecting do, as the server does it: approving signs nothing new and may not finish the item;
  // rejecting unsigns nothing.
  const approve = part('guide-approve');
  assert.match(approve, /Each item that waits shows the exact terms your agent signed, and the server’s own words for it: what is already signed and held, what approving and rejecting do, and its deadline\. Your agent has already signed it with its key, and Valun’s server holds it\./);
  // The review of console/first-use: an approved payment by transfer is then signed by the other two parties (Valun
  // signing for the agents it runs); what a failed check does depends on the kind; a rejected payment by transfer is
  // deleted, not kept; the transfer wait after a rejected IOU runs from its signature; valun 0.7.1 is not told.
  assert.match(approve, /Approving signs nothing with your agent’s key: the server checks again, then releases what your agent signed\. An offer goes out; an acceptance makes the deal binding, once the other side’s owner has approved too if theirs must; a note goes to the tracker, and you owe it; a payment by transfer then collects the other two signatures \(their clients sign, and Valun signs for the agents it runs\)\. If the note between the agents or a key has changed since your agent signed \(for a payment, also anything else it relied on\), a note or a payment becomes void, and your agent signs again; an offer, acceptance or guarantee offer that fails a check stays pending\. Once Valun sends a note or a payment you approved, the delivery stays accepted, with one exception: after the tracker refuses that note, a later note or payment of the deal that waits for you and isn’t sent \(you reject it, it expires, or it becomes void: its checks fail when you approve it, or a party’s agent key is revoked\) sends the deal back to delivered, unless the deal was payment due before that\./);
  // What stays blocked after a rejected IOU (paymentAttemptHolds), Valun's own wait exactly (on the rejected IOU's own key
  // pair, from the first change signed after it: the review of PR #9, item 8), and what valun 0.7.1 does: only what
  // holds in every case (each list of its conditions left a case it got wrong), what it usually does, that it may
  // refuse, and what to do for each answer, for a rejected IOU and a rejected payment by transfer
  // (scripts/client-071-attempts.py checks both ways out in every case it runs).
  assert.match(approve, /Rejecting unsigns nothing: Valun keeps what your agent signed on record, and never sends it, except a payment by transfer, whose three transfer signatures Valun deletes, keeping only their hashes\. A rejected acceptance leaves the offer open\. After a rejected note \(a bound one, which valun 0\.7\.1 signs on the testnet\), paying that deal by transfer waits until an hour and a minute after your agent signed it, unless the first change signed after it to the note between the two keys it names moves that note from the total it acknowledged, as a later note of your agent’s to that agent with the same keys does when nothing else changed that note first: Valun then doesn’t wait for it\. After an ordinary note, it waits until the note between the two agents on the tracker moves past it\. Until your agent pays that deal or disputes the delivery, no loop that includes what your agent owes that agent clears\. Valun allows at most 3 payments by transfer of one deal in 24 hours, whatever became of them: after the third, it refuses another until 24 hours after the first of the three \(the card says until when\)\./);
  assert.match(approve, /valun 0\.7\.1 isn’t told of a rejection, and keeps counting what your agent signed as a payment that may still apply\. After a rejected note it usually signs a new note for that deal at once; if anything else changed the note between the two agents first, or an agent’s key changed, it may refuse\. After a rejected payment by transfer it usually pays that deal again through the same note at once while that note is unchanged, unless Valun refuses another payment by transfer of it \(after the third in 24 hours\); any other way, or once that note has changed, it may refuse\. If it answers transfer_window_open, have your agent pay again once an hour and 2 minutes have passed since it signed what you rejected \(its retry_after_ms says how long to wait\)\. If it answers attempt_outcome_unknown, run valun attempts resolve DEAL '#n' --not-applied in a terminal, since Valun never sent what you rejected \(for a payment by transfer, answer yes to both of its questions, the second to record your decision in your client’s records only\), then have your agent pay again once those 62 minutes have passed\./);
  assert.doesNotMatch(approve, /\), something else changed/, 'a refusal does not prove what moved the note: usually, not always (the review of PR #8, F2)');
  assert.doesNotMatch(approve, /7 days|signed nothing else|on the conditions below/, 'no list of 0.7.1\'s conditions (the review of PR #9)');
  assert.doesNotMatch(approve, /another deal with/);
  assert.doesNotMatch(approve, /signs nothing new|waits about an hour|A check that fails can still void it/);
  assert.match(approve, /Approve stays off when this page can’t show you exactly what you would approve\. The server records your decision; it isn’t signed with a key\./);
  assert.doesNotMatch(text(guide), /Reject, and it doesn’t|with console approvals, all of them/);
  const who = guide.querySelector('#guide-who dl');
  assert.deepEqual(who.querySelectorAll('dt').map(text), ['Anyone', 'The other side of a deal', 'Valun’s operator (Fitz Doud, who runs valun.tech)']);
  const [anyone, other, operator] = who.querySelectorAll('dd').map(text);
  assert.equal(anyone, 'Your agent’s profile and public key, what it holds and owes, and whose notes it accepts or refuses. If you publish its budget card, also how much it may commit you to, and your objective.');
  // Not the whole deal (core.mjs view and noteView): nothing of what waits for its owner or was rejected before it was
  // offered, no acceptance signature before it is final, no held note's signatures.
  assert.equal(other, 'The deal, but not what waits for you: never an offer, counter-offer or guarantee offer of your agent’s while it waits for you or after you rejected it, never your agent’s acceptance signature before the acceptance is final, and never the signatures of a note or payment that waits for you. It does see that an acceptance, a note or a payment waits for you, your agent’s signed acceptance of its delivery, and your decisions on those. Never your comments.');
  // What the operator can do (the site redesign's review: the owner token and the admin mandate route): any part of the
  // mandate, beyond the self-serve box, shown only as the last change; and a new owner token for any agent, which with
  // the agent's revocation puts another key on the handle. Never "give you a new owner token", which reads as recovery.
  assert.match(operator, /^Everything the server stores: every deal, and everything you set or decide here\. /);
  assert.match(operator, / It can change any part of your agent’s mandate, including what waits for you \(approve_above\) and whose notes it accepts, beyond the self-serve limits\. This console shows the last change as the operator’s\. Routine renewals of the expiry are shown the same way, and no history is kept\. /);
  // A key swap (D5b, the redesign's round 2): the public record keeps only the current key (core.mjs publicParticipant),
  // the owner view keeps the past ones (GET /owner past_keys; this console's Earlier keys).
  assert.match(operator, / It can also issue a new owner token for any agent \(recorded as by: operator; the old token stops working\), and an owner token can revoke the agent’s key and enroll another\. So the operator could put a key of its own on your handle and record\. It can’t use your key: notes your key signed and your reserve stay bound to it\. The public record shows only an agent’s current key, so a swap shows only to someone who noted the old one; your owner view lists past keys\. Who runs what$/);
  assert.doesNotMatch(text(guide), /a new key shows as a different public key/);
  assert.match(JS, /\['Earlier keys', /, 'the owner view does list them');
  assert.doesNotMatch(text(guide), /give (you|an owner) a new owner token|change your agent’s limits \(you would see that here\)/);
  assert.equal(who.querySelector('a').getAttribute('href'), '/trust#who-runs-what');
  // With console approvals: what the owner does, step by step, and what nothing does for them.
  const steps = guide.querySelectorAll('#guide-console ol li').map(text);
  assert.equal(text(guide.querySelector('#guide-console h3')), 'With console approvals');
  // The redesign's round 2: what a late approval does (core.mjs: a bound note past the tracker's age fails, note_failed,
  // and the payer signs again); a hire of this owner's agent waits too (core.mjs checkMandate needsOwner for the payee);
  // never type the token into a command (D12b); Hermes's own switch (plugin 720a5d3: confirm_commitments, and
  // approve_above at the per-deal limit outside console).
  assert.deepEqual(steps, ['Your agent signs and tells you something waits.',
    'Sign in here. Pending approvals shows the exact terms. This page re-reads every 30 s while it is open and in view; nothing notifies you otherwise.',
    // The deadlines (core.mjs approvalDecideBy; a held bound IOU's approval ends at its timestamp + 1 h - 60 s since
    // 2026-11-18, the approval probe's D3). valun 0.7.1 is told of neither expiry (the review of PR #8).
    'Approve or reject by the deadline its card shows. An offer, counter-offer, acceptance or guarantee offer ends when the offer expires. A payment by transfer ends 20 minutes after your agent signed it, as after a rejection. A bound note, which valun 0.7.1 signs on the testnet, can reach the tracker only within an hour of your agent signing it, so its approval ends a minute before that: Valun never sends it then, and the deal goes back to your agent, as after a rejection (a deal that was already payment due stays payment due). Tell your agent to accept the work again, which then waits for you once more. As after a rejection, valun 0.7.1 isn’t told of either, and may then need valun attempts resolve.',
    // The tour under console waited exactly 8 times on staging (2026-11-18), as /start and skill.md say it.
    'Tell your agent you decided: it carries on only when it next checks. A hire waits for you twice: the offer, then the note once your agent accepts the work. When another agent hires yours, taking the job waits for you too. The tour through your agent waits about 8 times, plus once each time sandbox-mallory’s work is wrong and the tour buys again.',
    'To stop holding commitments, change the mode on your agent’s machine (with the valun client, valun config approvals ask or none, adding --owner-token-file and the file join wrote) and untick review deliveries here. Don’t type the token into a command: it stays in your shell history. Keep the file join wrote, move it into your password manager, and paste the token only into the console’s sign-in. In Hermes, which has no such command: set Ask me above to your per-deal limit and untick Review deliveries here, then set the plugin’s confirm_commitments back to true to be asked in Hermes (not yet verified in a real Hermes).']);
  assert.doesNotMatch(text(guide), /put the token in a new file|paste it into a new file/, 'no file typed by hand');
  // What does not wait, even with console approvals: the testnet's default acceptance and its consents (lib/pilot/core.mjs
  // joinSandbox; valun 0.7.1 SANDBOX_CONSENT_POLICY: each client signs for its own key only, D3b).
  // And what never waits, even with console (the approval semantics of 2026-11-17).
  assert.deepEqual(guide.querySelectorAll('#guide-console p.guide-after').map(text), [
    'Not everything waits, even with console approvals. Your agent’s client signs these by itself, and the server records them at once: honoring a guarantee call (your agent’s own note to the creditor); accepting, calling and releasing guarantees; deliveries, declines, withdrawals and disputes; clearing a limit recorded from your conversation, which puts it back to your mandate; and the consents: set-offs, moves of notes your agent issued, and payments to it by transfer.',
    'On the testnet a new self-serve agent accepts any issuer’s notes as payment by transfer, up to 0.04 tERG per issuer. Its client signs that acceptance by itself in every approval mode, and the issuer’s client signs the issuer’s consent the same way. You can narrow whose notes it accepts under “Accept notes from” in your mandate here.']);
  assert.deepEqual(body.querySelectorAll('#guide-body > *').map(e => e.id), ['guide-for', 'guide-signin', 'guide-approve', 'guide-who', 'guide-console', 'guide-token']);
  const never = guide.querySelector('#guide-token');
  assert.ok(never.classList.contains('caution'), 'a caution note');
  assert.match(text(never), /^Never share your owner token It is a bearer token: whoever holds it is treated as you\. They could approve what waits for you, loosen your agent’s limits, revoke your agent and connect their own key, or replace the token and lock you out\./);
  assert.match(text(never), /Keep it in a password manager\. Never paste it into a chat, or give it to your agent\./);
  // The owner token and console mode.
  // The file join wrote, whatever its name: every join names one per handle now (D12b).
  assert.match(text(never), /Console approvals protect you only while your agent can’t read your owner token\. Once you have set console, move the token file join wrote into your password manager and delete it, and paste the token in when you sign in to the console\./);
  assert.match(text(never), /If it may have leaked, sign in and choose New owner token: the old one stops working at once\./);
  // Beside the field itself: where the token is, and never to share it.
  const form = body.querySelector('#login-form');
  assert.equal(body.querySelector('#owner-token').getAttribute('aria-describedby'), 'token-where token-never');
  assert.equal(text(form.querySelector('#token-never')), 'Never share it: whoever holds it can act as you here.');
  // Where the token is (the file join wrote, at the documented path), and that a pasted file's contents work.
  // valun console is the RC's (unreleased), and it prints the file only when the profile recorded it, which a join with
  // valun 0.7.1 never does (the review of console/first-use).
  assert.equal(text(form.querySelector('#token-where')), 'It is in the file your join wrote: with the commands on Start, $HOME/valun-owner-token-YOUR-HANDLE.txt, named for your agent’s handle. Open it and paste what it holds: it starts with vpo_, and the line break after it is ignored. The next client release (unreleased) is planned to add valun console, which prints where that file is if the profile recorded it (a join with valun 0.7.1 doesn’t). If join showed the token in the terminal instead, that was its only copy.');
  // What the console is for and what will appear in it, in two sentences, above the form.
  const what = body.querySelector('#signin-what');
  assert.equal(what.parentNode.id, 'owner-login');
  assert.equal(text(what).split(/(?<=\.)\s/).length, 2, 'two sentences');
  assert.equal(text(what), 'Here you decide on what your agent has signed and Valun’s server holds for you, and you set the limits your agent works within. Once you sign in, you see first what waits for your approval (with console approvals: your agent’s offers, acceptances and guarantee offers, and the note or payment at each delivery it accepts), then your agent, what it holds and owes, its limits and every deal it makes.');
  assert.equal(body.querySelector('#owner-token').getAttribute('type'), 'password');
  // The copy rules: none of these words anywhere on the page.
  assert.doesNotMatch(text(body), /trustless|fully decentralized|revolutioni[sz]e|limitless|the agent economy|guaranteed|risk-free|seamless|final settlement|adoption|\bcredits\b/i);
});

test('the network and invite views say what a note is and whom the invite form is for (the review\'s findings on "Payment =" and the invite tab)', () => {
  const body = readBody(HTML);
  // An IOU is a debt the payer owes, not a completed payment.
  assert.match(text(body.querySelector('#fact-payment')), /^Payment is a note: a signed promise to pay, which the payer owes\. When a payer accepts a delivery/);
  assert.doesNotMatch(HTML + JS, /Payment = a credit note/);
  // The invite form is a side door, from the operator: its tab says so, and "How joining works" says which default
  // applies to whom (lib/pilot/core.mjs join: approve_above 0, 14 days; joinSandbox: the self-serve box, 7 days).
  assert.equal(text(body.querySelectorAll('#tabs a').find(a => a.dataset.tab === 'join')), 'Invite codes');
  assert.match(text(body.querySelector('#tab-join .join-note')), /^You don’t need an invite to join Valun: .* This form is for an invite code from Valun’s operator:/);
  assert.equal(text(body.querySelectorAll('#tab-join .card').find(c => text(c.querySelector('h2')) === 'How joining works').querySelector('p.hint')),
    'Joining here, with an invite code, your mandate starts by sending every offer, counter-offer, acceptance and guarantee offer to you for approval (approve_above 0), and it expires after 14 days. An agent that joins by itself (valun join --sandbox) starts with the self-serve limits instead, for 7 days, renewed while it is active, and nothing waits for you here unless it uses console approvals.');
});

test('no text in the console is drawn below 12 px (0.75rem), the site\'s floor for small labels (the review\'s finding on page stylesheets)', () => {
  const small = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const [, selector, decls] = m;
    for (const d of decls.matchAll(/(?:^|;)\s*font(-size)?\s*:\s*([^;]+)/g)) {
      const size = /(\d*\.?\d+)rem/.exec(d[2]);           // the shorthand's size is its first length
      if (size && Number(size[1]) > 0 && Number(size[1]) < 0.75) small.push(`${selector.trim()}: ${d[2].trim()}`);
    }
  }
  assert.deepEqual(small, []);
  // Code in the small text (site.css draws it at 0.86em) is floored at 12 px too.
  for (const sel of ['.console .tiny code:not(.signed-text):not(.small)', '.console .explain code'])
    assert.ok(cssRules(CSS).some(r => r.selector === sel && r.decls['font-size'] === 'max(0.75rem, 0.86em)'), sel);
});

test('on a phone the signed-in console is one column: the agent\'s card above its position, not two narrow columns side by side', () => {
  const rules = cssRules(CSS), cols = (sel, media) => rules.filter(r => r.selector === sel && r.media === media).map(r => r.decls['grid-template-columns']);
  assert.deepEqual(cols('#owner-console .grid2', null), ['minmax(0, 5fr) minmax(0, 7fr)'], 'wide screens: the agent | its position');
  // An id outranks .grid2, so the narrow-screen rule names the console's split itself.
  assert.deepEqual(cols('#owner-console .grid2', '(max-width: 960px)'), ['minmax(0, 1fr)']);
});

// ------------------------------------------------------------------------------------------------ its states
test('signed out: /pilot opens the owner console with the guide open beside the sign-in form; it reads only the network\'s info', async () => {
  for (const hash of ['', '#owner', '#main', '#no-such-view']) {
    const page = await open({hash});
    const {$} = page;
    assert.equal($('#tab-owner').classList.contains('active'), true, `${hash || 'no hash'}: the owner view`);
    assert.equal($('#tab-network').classList.contains('active'), false);
    assert.equal(page.doc.querySelectorAll('#tabs a').find(a => a.dataset.tab === 'owner').getAttribute('aria-current'), 'page');
    assert.equal($('#owner-login').hidden, false, 'the sign-in form');
    assert.equal($('#owner-console').hidden, true);
    assert.equal($('#guide-body').hidden, false, 'the guide is open');
    assert.equal($('#guide-toggle').hidden, true, 'nothing to fold while signed out');
    assert.equal($('#to-signin').hidden, false, 'the step down to the form (shown on narrow screens)');
    assert.ok($('#tab-owner').classList.contains('signed-out'));
    assert.equal(page.doc.title, 'Valun owner console');
    assert.ok(page.doc.body.classList.contains('js'));
    assert.deepEqual(page.calls.map(c => `${c.method} ${c.path}`), ['GET /info'], 'no owner view without a token, and no directory or ledger');
    assert.equal(text($('#net-name')), 'testnet network');
  }
});

test('signing in: an agent token, or anything that is not an owner token, is refused before anything is sent; an owner token opens the console and folds the guide', async () => {
  const page = await open();
  const {$} = page, before = page.calls.length;
  await signIn(page, 'vpa_agent-token');
  assert.equal(text($('#login-msg')), 'That is an agent token (vpa_…). The owner console needs the owner token (vpo_…) you received when you joined. Keep the two apart.');
  await signIn(page, 'not-a-token');
  assert.equal(text($('#login-msg')), 'Owner tokens start with vpo_.');
  assert.equal(page.calls.length, before, 'nothing was sent');
  assert.equal(page.store.size, 0, 'nothing was kept');
  await signIn(page, ` ${TOKEN} `);
  assert.ok(page.calls.some(c => c.method === 'GET' && c.path === '/owner' && c.auth === `Bearer ${TOKEN}`), 'the owner view, read with the token');
  assert.equal(page.store.get('valun-pilot-owner-token'), TOKEN, 'kept for this tab (the box is ticked by default)');
  assert.equal($('#owner-login').hidden, true);
  assert.equal($('#owner-console').hidden, false);
  assert.equal(text($('#owner-console .idbar h2')), 'Olivia');
  assert.equal(text($('#owner-console .idbar .idmain .tiny')), 'olivia · vp_aaaaaaaaaaaa · operated by Olivia Ops');
  assert.match(text($('#owner-console .idbar')), /Your owner token is kept for this tab's session \(sessionStorage\)\. Your browser may also save it on disk and restore it with the tab, even after the browser closes: click Forget token when you finish, above all on a shared computer\./);
  // The guide folds to its heading, one click from open.
  const toggle = $('#guide-toggle');
  assert.ok($('#tab-owner').classList.contains('signed-in'));
  assert.deepEqual([$('#guide-body').hidden, toggle.hidden, toggle.getAttribute('aria-expanded'), text(toggle)], [true, false, 'false', 'Show the guide']);
  assert.equal($('#to-signin').hidden, true);
  toggle.dispatch('click');
  assert.deepEqual([$('#guide-body').hidden, toggle.getAttribute('aria-expanded'), text(toggle)], [false, 'true', 'Hide the guide']);
  toggle.dispatch('click');
  assert.deepEqual([$('#guide-body').hidden, toggle.getAttribute('aria-expanded')], [true, 'false']);
  // Forget token: back to the form, the guide open again, nothing kept.
  button($('#owner-console'), 'Forget token').click();
  await settle();
  assert.equal($('#owner-login').hidden, false);
  assert.equal($('#guide-body').hidden, false);
  assert.equal(page.store.size, 0);
});

// The console decisions of 2026-11-18: the owner pastes what the file join wrote ($HOME/valun-owner-token-YOUR-HANDLE.txt:
// the token and a line break; Windows editors may add a byte-order mark or \r\n, and a browser may turn a pasted line
// break into a space in a one-line field). Every whitespace character is dropped (a token holds none), and the token
// goes only in the Authorization header: never in the address, never in localStorage.
test('signing in with a pasted token file: the line break, spaces and a byte-order mark around it are dropped; the token never goes into the address', async () => {
  for (const pasted of [`${TOKEN}\n`, `\uFEFF${TOKEN}\r\n`, `  ${TOKEN}  \n\n`, `${TOKEN} `]) {
    const page = await open();
    await signIn(page, pasted);
    const read = page.calls.find(c => c.method === 'GET' && c.path === '/owner');
    assert.equal(read?.auth, `Bearer ${TOKEN}`, JSON.stringify(pasted));
    assert.equal(page.store.get('valun-pilot-owner-token'), TOKEN, 'kept for this tab as the token itself');
    assert.ok(!page.calls.some(c => c.path.includes(TOKEN)), 'never in a path or query');
    assert.ok(!String(globalThis.location.hash).includes('vpo_'), 'never in the address');
    assert.equal(page.$('#owner-console').hidden, false, 'the console opened');
  }
  // An agent token pasted from its file is still refused before anything is sent.
  const page = await open(), before = page.calls.length;
  await signIn(page, '\uFEFFvpa_agent-token\r\n');
  assert.equal(text(page.$('#login-msg')), 'That is an agent token (vpa_…). The owner console needs the owner token (vpo_…) you received when you joined. Keep the two apart.');
  assert.equal(page.calls.length, before);
  assert.match(JS, /localStorage/, 'pilot.js names localStorage only to say it is not used');
  assert.doesNotMatch(JS.replace(/\/\/.*$/gm, ''), /localStorage\.(setItem|getItem)/, 'no localStorage read or write');
});

test('loading: while the owner view is being read, the console says so (a status)', async () => {
  const page = await open({token: TOKEN, fetch: (u, o, base) => (new URL(u, 'http://x').pathname === '/pilot/v1/owner' ? new Promise(() => {}) : base(u, o))});
  const box = page.$('#owner-console .loading');
  assert.ok(box, 'the loading state');
  assert.equal(box.getAttribute('role'), 'status');
  assert.equal(text(box), 'Loading your console…');
  assert.equal(page.$('#owner-login').hidden, true);
});

test('errors: the server\'s error says what failed, with Try again and Use another token; no answer says so too; a token the server refuses is removed and the form says why', async () => {
  // The server's error.
  let answer = {status: 503, body: {error: 'unavailable', message: 'the owner view cannot be read just now', retry_after_ms: 5000}};
  const page = await open({token: TOKEN, routes: api({owner: {get status() { return answer.status; }, get body() { return answer.body; }}})});
  const con = page.$('#owner-console');
  assert.equal(text(con.querySelector('h2')), 'Your console could not be loaded');
  assert.match(text(con), /The Valun server answered with an error\. Nothing was changed\./);
  const err = con.querySelector('.msg.err');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.match(text(err), /unavailable – the owner view cannot be read just now \(HTTP 503\)/);
  assert.match(text(err), /retry_after_ms5000/);
  assert.equal(con.querySelector('a[href=/start#report]')?.textContent, 'report a problem');
  answer = {status: 200, body: ownerView()};
  button(con, 'Try again').click(); await settle();
  assert.ok(page.$('#owner-console .idbar'), 'Try again reads the owner view again');
  // Use another token: the form, and the kept token removed.
  const again = await open({token: TOKEN, routes: api({owner: {status: 503, body: {error: 'unavailable', message: 'x'}}})});
  button(again.$('#owner-console'), 'Use another token').click(); await settle();
  assert.equal(again.$('#owner-login').hidden, false);
  assert.equal(again.store.size, 0);

  // No answer at all: the server cannot be reached.
  const silent = await open({token: TOKEN, fetch: () => Promise.reject(new TypeError('fetch failed'))});
  assert.equal(text(silent.$('#owner-console h2')), 'Your console could not be loaded');
  assert.match(text(silent.$('#owner-console')), /The Valun server did not answer\. Nothing was changed\./);
  assert.equal(silent.$('#offline').hidden, false, 'the banner says the server cannot be reached');
  assert.equal(silent.$('#conn').textContent, 'server unreachable');

  // A token the server refuses (401): removed from this tab, and the form says why.
  const refused = await open({token: 'vpo_revoked-or-replaced'});
  assert.equal(refused.$('#owner-login').hidden, false);
  assert.equal(text(refused.$('#login-msg')), REFUSED_TOKEN);
  assert.equal(refused.store.size, 0);
  assert.equal(refused.$('#guide-body').hidden, false, 'the guide is open again');
});

// The review of PR #9, code 3: the deal view's own 401 (pilot.js showDeal: GET /deals/{id} refused, as after the token
// was replaced in another tab) says what the sign-in's does, from the same text, and removes the token from this tab.
test('a deal view whose read the server refuses (401): the token is removed from this tab, and the form says what a 401 proves and what can cause it', async () => {
  const VD = 'vd_2222222222222222';
  const page = await open({token: TOKEN, hash: `#owner/deal/${VD}`,
    routes: api({extra: (m, p) => (m === 'GET' && p === `/deals/${VD}` ? {status: 401, body: {error: 'unauthorized', message: 'missing or invalid token'}} : undefined)})});
  assert.ok(page.calls.some(c => c.method === 'GET' && c.path === `/deals/${VD}` && c.auth === `Bearer ${TOKEN}`), 'the deal was read with the token');
  assert.equal(page.$('#owner-login').hidden, false, 'the sign-in form');
  assert.equal(text(page.$('#login-msg')), REFUSED_TOKEN);
  assert.equal(page.store.size, 0, 'removed from this tab');
  // What a 401 proves, and nothing more: never that a join was released, as if that were the only cause.
  assert.match(REFUSED_TOKEN, /^That owner token is not valid on this server \(HTTP 401\): no participant here holds it\. /);
  assert.doesNotMatch(REFUSED_TOKEN, /that join was released|is free to join again/);
});

// The redesign's round 2 (accessibility): reading the owner view hides the form that holds focus and folds the guide, so
// the page grows shorter. A refused token then left focus on <body> and, on a phone, the form and its message about
// 3,100 px below the screen.
test('a refused token: focus back in the token field, which says why, and the page back where it was; a good one: focus on the console\'s first heading', async () => {
  const page = await open();
  const {$} = page, field = $('#owner-token'), scrolled = [];
  // Not an owner token: refused before anything is sent; the field keeps focus and says why until it is typed in again.
  await signIn(page, 'vpa_agent-token');
  assert.deepEqual([page.doc.activeElement, field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')], [field, 'true', 'login-msg token-where token-never']);
  field.dispatch('input');
  assert.deepEqual([field.hasAttribute('aria-invalid'), field.getAttribute('aria-describedby')], [false, 'token-where token-never']);
  // The server refuses it (401): the form again, the field focused and described by the reason, the page where it was.
  Object.assign(globalThis.window, {scrollY: 3140, scrollTo: o => scrolled.push(o)});
  await signIn(page, 'vpo_replaced-token');
  assert.equal(text($('#login-msg')), REFUSED_TOKEN);
  assert.deepEqual([$('#owner-login').hidden, $('#guide-body').hidden], [false, false]);
  assert.equal(page.doc.activeElement, field);
  assert.deepEqual([field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')], ['true', 'login-msg token-where token-never']);
  assert.deepEqual(scrolled, [{top: 3140, behavior: 'instant'}]);
  // A good token: the console, with focus on its first heading (the agent's name), which only a script focuses.
  await signIn(page, TOKEN);
  const h = $('#owner-console h2');
  assert.equal(page.doc.activeElement, h);
  assert.deepEqual([text(h), h.getAttribute('tabindex')], ['Olivia', '-1']);
  assert.equal(field.hasAttribute('aria-invalid'), false);
  assert.equal(scrolled.length, 1, 'nothing to go back to after a good one');
  // A token kept in this tab, refused when the page opens: nobody just signed in, so the form is brought into view.
  const intoView = [];
  Element.prototype.scrollIntoView = function (o) { intoView.push([this.id, o]); };
  try {
    const kept = await open({token: 'vpo_revoked-or-replaced'});
    assert.equal(kept.doc.activeElement, kept.$('#owner-token'));
    assert.equal(kept.$('#owner-token').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(intoView, [['owner-login', {block: 'start'}]]);
  } finally { delete Element.prototype.scrollIntoView; }
});

test('forced colours: only the current console tab keeps an underline, in Highlight, and the tabs keep a visible focus ring', () => {
  const forced = cssRules(CSS).filter(r => r.media === '(forced-colors: active)'), rule = sel => forced.find(r => r.selector === sel)?.decls ?? {};
  assert.deepEqual([rule('.tabs a')['forced-color-adjust'], rule('.tabs a').color, rule('.tabs a')['border-bottom-color']], ['none', 'LinkText', 'transparent']);
  assert.deepEqual([rule('.tabs a[aria-current="page"]').color, rule('.tabs a[aria-current="page"]')['border-bottom-color']], ['CanvasText', 'Highlight']);
  assert.equal(rule('.tabs a:hover').color, 'LinkText', 'not the page\'s own hover colour');
  assert.equal(rule('.tabs a:focus-visible')['outline-color'], 'CanvasText');
  assert.equal(rule('.tabs a .badge')['forced-color-adjust'], 'auto');
});

test('empty: nothing waiting says what would wait here, by the owner\'s own mandate; no deals points to a first one', async () => {
  // What waits, and what never does (the approval semantics of 2026-11-17): with circulating credit on (the testnet's
  // owner view has credit_policy), guarantee offers and payments by transfer too; never an honor of a call, the guarantee
  // acts, deliveries, declines, withdrawals, disputes or the consents.
  const waits = async (mandate, extra = {}) => text((await open({token: TOKEN, routes: api({owner: ownerView({mandate, ...extra})})})).$('#approvals p.empty'));
  const circ = {credit_policy: {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'}};
  const never = 'These never wait here: honoring a guarantee call (your agent\'s own note, recorded at once), accepting, calling and releasing guarantees, deliveries, declines, withdrawals and disputes, and the consents its client signs by itself.';
  assert.equal(await waits({approve_above: 5e6, review_deliveries: false}, circ),
    `Nothing is waiting for you. An offer, counter-offer, acceptance (taking a job included) or guarantee offer your agent signs for more than 5,000,000 nanoERG (0.005 tERG) (Ask me above) waits here before it takes effect. ${never}`);
  assert.equal(await waits({approve_above: 0, review_deliveries: true}, circ),
    `Nothing is waiting for you. With Ask me above at 0, every offer, counter-offer, acceptance (taking a job included) and guarantee offer your agent signs waits here before it takes effect, and so does the note or payment by transfer it signs when it accepts a delivery (Review deliveries). ${never}`);
  // Circulating credit off: no guarantees, payments by transfer or consents to name.
  assert.equal(await waits({approve_above: 0, review_deliveries: true}),
    'Nothing is waiting for you. With Ask me above at 0, every offer, counter-offer and acceptance (taking a job included) your agent signs waits here before it takes effect, and so does the note it signs when it accepts a delivery (Review deliveries). Deliveries, declines, withdrawals and disputes never wait here.');
  const page = await open({token: TOKEN});
  const deals = page.$('#deals-card p.empty');
  assert.equal(text(deals), 'No deals yet. Your agent proposes and answers deals with its own key, and each one appears here. For a first one, see Start.');
  assert.equal(deals.querySelector('a').getAttribute('href'), '/start#agent');
  assert.equal(page.$('#approvals .count').textContent, '0');
  assert.equal(page.$('#pending-badge').hidden, true);
});

test('the skip link moves focus to <main> without changing the view; "Sign in" goes down to the form without changing the address', async () => {
  const page = await open({hash: '#network'});
  const ev = page.$('.skip').dispatch('click');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(page.doc.activeElement, page.$('#main'));
  assert.equal(globalThis.location.hash, '#network', 'the address keeps its view');
  assert.equal(page.$('#tab-network').classList.contains('active'), true);
  const out = await open();
  const jump = out.$('#to-signin').dispatch('click');
  assert.equal(jump.defaultPrevented, true);
  assert.equal(out.doc.activeElement, out.$('#owner-token'));
  assert.equal(globalThis.location.hash, '');
});

test('the connection status (a live region) speaks when the state changes, not at every read', async () => {
  const page = await open({token: TOKEN});
  const conn = page.$('#conn');
  assert.equal(conn.getAttribute('role'), 'status');
  assert.equal(conn.textContent, 'server connected');
  const said = conn.childNodes[0];
  button(page.$('#owner-console .idbar'), 'Refresh').click(); await settle();
  assert.ok(page.calls.filter(c => c.path === '/owner').length >= 2, 'read again');
  assert.equal(conn.childNodes[0], said, 'the same words, not written again');
});

test('the budget card\'s state: published or not, what it shows anyone, and the client command that changes it; nothing when the server has no budget cards', async () => {
  const box = async (extra, view = ownerView(extra)) => (await open({token: TOKEN, routes: api({owner: view})})).$('#budget-card');
  const off = await box({public_card: false});
  assert.equal(text(off.querySelector('.stitle')), 'Budget card: not public Valun server record');
  // The command reads the token from the file join wrote, as every command on the site does (the redesign, round 2: the
  // token is never typed into a command, and pasted only into the console's sign-in).
  assert.equal(text(off.querySelector('p')), "Your agent's limits per deal and in all are not public. Publishing the card lets other agents check your agent before they take its note: it shows your agent's limits per deal and in all, the room it has left, the objective below, the guarantees it has and its record. To publish it, run valun card publish with --owner-token-file and the file that holds your owner token (the one join wrote).");
  assert.deepEqual(off.querySelectorAll('code').map(text), ['valun card publish', '--owner-token-file'], 'each kept whole on a line (pilot.css .budget-box code)');
  assert.equal(off.querySelectorAll('button').length, 0, 'shown, not changed, here');
  const on = await box({public_card: true});
  assert.match(text(on), /^Budget card: public .*Anyone can read it on your agent's page and check a payer against it: your agent's limits per deal and in all, the room it has left, the objective below, the guarantees it has and its record\. To hide it, run valun card unpublish with --owner-token-file and the file that holds your owner token \(the one join wrote\)\.$/);
  assert.ok(cssRules(CSS).some(r => r.selector === '.budget-box code' && r.decls['white-space'] === 'nowrap'));
  assert.equal(on.querySelector('a').getAttribute('href'), '/agent/olivia');
  const page = await open({token: TOKEN, routes: api({owner: ownerView({public_card: true})})});
  assert.match(text(page.$('#mandate-form')), /What the agent is for, in your words\. Your agent can read it; the server does not enforce it\. Your budget card is public, so anyone can read it there\./);
  const none = ownerView(); delete none.public_card;
  assert.equal(await box({}, none), null, 'a server without budget cards: no box');
});

test('what the operator did is said as it is: a mandate the operator changed, an owner token it replaced; a proposal waiting for the owner says so', async () => {
  const page = await open({token: TOKEN, routes: api({owner: ownerView({mandate_changed_by: 'operator', owner_token_rotated_at: PAST, owner_token_rotated_by: 'operator'})})});
  const head = text(page.$('#mandate-card .dtitle'));
  assert.match(head, /last changed by the network operator, .*; enforced by the server/);
  assert.doesNotMatch(head, /at your request/, 'the server renews a sandbox mandate by itself, recorded as the operator\'s');
  // The server's own routine changes are recorded as the operator's too, and only the last change is kept (the review's
  // finding on the admin mandate route; lib/pilot/core.mjs joinSandbox and renewSandbox).
  assert.equal(text(page.$('#mandate-by-operator')), '“The network operator” here also covers routine changes the server makes: the limits a self-serve join starts with, and each renewal of the expiry while your agent is active. It keeps only the last change, not a history of what changed, so check the values below.');
  assert.match(text(page.$('#owner-console .idbar')), /Owner token last replaced .* by the operator\./);
  assert.equal((await open({token: TOKEN})).$('#mandate-by-operator'), null, 'a mandate its owner set last: no such note');
  // The deal view: the guide stays out; a proposal of this owner's agent waits for this owner's approval.
  const VD = 'vd_1111111111111111', terms = {protocol: 'valun-deal/1', network: 'valun-testnet-1', tracker_nft_id: 'd'.repeat(64), denomination: 'erg', deal_id: VD, version: 1,
    prior_terms_hash: null, nonce: '0'.repeat(32), proposer: ME.id, payer: {id: ME.id, pubkey: ME.pubkey}, payee: {id: 'vp_bbbbbbbbbbbb', pubkey: `02${'b'.repeat(64)}`},
    service: {title: 'A job', description: 'd', deliverable: 'text'}, price: {amount: 4e6, unit: 'nanoERG'}, consideration: 'credit_note_on_delivery_accepted', deliver_by: PAST, offer_expires_at: PAST};
  const deal = {id: VD, status: 'proposed_awaiting_owner', overdue: false, you: ME.id, your_role: 'payer', counterparty: {id: 'vp_bbbbbbbbbbbb', handle: 'erin', operator: 'Erin'},
    next_actions: ['wait_for_owner_approval'], current: {version: 1, by: ME.id, state: 'awaiting_owner', terms, terms_hash: 'e'.repeat(64), signature: 'f'.repeat(130)}, pending_counter: null,
    versions: [{version: 1, by: ME.id, state: 'awaiting_owner', terms_hash: 'e'.repeat(64), price: terms.price, signature: 'f'.repeat(130), created_at: PAST}],
    acceptance: null, agreement: null, decline: null, delivery: null, completion: null, dispute: null, credit_note: null, cancellation: null, approvals: [], history: [], labels: {}};
  const viewer = await open({token: TOKEN, hash: `#owner/deal/${VD}`, routes: api({extra: (m, p) => (m === 'GET' && p === `/deals/${VD}` ? {status: 200, body: deal} : undefined)})});
  assert.ok(viewer.$('#history-card'), 'the deal view');
  assert.equal(viewer.$('#owner-guide').hidden, true, 'no guide above a deal');
  assert.match(text(viewer.$('#deal-view')), /Proposal \(version 1\) – waiting for your approval, not offered yet/);
});
