// Fix inbox #72: the owner console (public/pilot.html and pilot.js, /pilot#owner) on the Valun TESTNET network
// (PILOT_NETWORK=valun-testnet-1, in this process of its own), run on the page's own body (test/network-dom.mjs
// readBody, test/console-dom.mjs) against the real routes (lib/http.mjs, lib/pilot/http.mjs) of a real Pilot over a
// stub tracker held in memory (no tracker binary, no chain):
//   - every tab and the deal view say no PC, no pilot, no "no blockchain": the title, the banner, "what this is", the
//     ledger, the footer, the owner console and its tags name the testnet (nanoERG on Ergo testnet), and every amount is
//     in nanoERG with its tERG ("4,000,000 nanoERG (0.004 tERG)");
//   - the limits editor saves a testnet-sized mandate (5,000,000 a deal, 40,000,000 in all): its inputs have no maximum
//     (one of 100000, PC-sized, made every testnet limit invalid, and an arrow key set it to 100000), its labels and
//     errors name nanoERG, and the server takes it;
//   - on a server that still runs the retired pilot (unit PC), the page keeps the pilot's own words.
process.env.PILOT_NETWORK = 'valun-testnet-1';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {installPage, text} from './console-dom.mjs';
import {readBody} from './network-dom.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../lib/pilot/core.mjs');
const {createPilotRoutes} = await import('../lib/pilot/http.mjs');
const {createHandler} = await import('../lib/http.mjs');
const {appendEntries} = await import('../lib/pilot/journal.mjs');
const {pc, NETWORK, UNIT} = await import('../lib/pilot/units.mjs');

const dirs = [], servers = [], nodeFetch = globalThis.fetch;
after(() => { for (const s of servers) s.close(); for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); globalThis.fetch = nodeFetch; });
const hex = n => crypto.randomBytes(n).toString('hex'), sha = s => crypto.createHash('sha256').update(s).digest('hex'), iso = t => new Date(t).toISOString();
const DAY = 864e5, NFT = 'dc'.repeat(32), PIN = 'cd'.repeat(32);
// Tracker v4 with anchored netting: the testnet's tracker contract (test/testnet-network.test.mjs).
const CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: 'x', pure_credit: false, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to',
    'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 7, novations_disabled_reason: null,
  anchored_netting: {version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720, observation_max_age_ms: 7200000}};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};

// The testnet with circulating credit on and its tracker on chain, served over real HTTP. olivia-ops is the console's
// owner (`mandate`: her mandate's limits over the testnet's DEFAULT_MANDATE; `ownerExtra`: more of her record, such as
// sandbox_only); carol-research owes her 3,000,000, she owes dave-docs 2,000,000; her agent's proposal to pay erin-review
// 4,000,000 is above her approve_above (2,000,000), so it waits for her.
async function world(mandate = {}, ownerExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-console-testnet-')); dirs.push(dir);
  const now = Date.now(), notes = new Map();
  const basis = {nft: NFT, denomination: 'erg', note: async (i, r) => notes.get(`${i}>${r}`) ?? null, allNotes: async () => [...notes.values()],
    capabilities: async () => CAPS, refresh: async () => CAPS, verify: async () => true, reserves: async () => []};
  // The open network, as the testnet runs (GET /info self_serve.open_network): a sandbox owner deals with anyone.
  const pilot = new core.Pilot({store: new core.PilotStore(dir), basis, circulation: 'on', openNetwork: true, trackerCaps: CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  pilot.serverSigner = {has: () => false, signFor: async () => { throw new Error('no signing in this test'); }};
  pilot.chain = {name: 'ergo-testnet', on_chain: true, tracker_nft_id: NFT, explorer: 'https://testnet.ergoplatform.com'};
  const owner = 'vpo_' + hex(16);
  const person = (handle, m = {}, extra = {}) => {
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: `${handle} ops`, about: '', services: '', wants: '', pubkey: '02' + hex(32), status: 'active',
      created_at: iso(now - DAY), owner_token_hash: sha('vpo_' + hex(16)), agent_token_hash: sha('vpa_' + hex(16)), enrollment: null,
      mandate: {...core.DEFAULT_MANDATE, expires_at: iso(now + 7 * DAY), ...POLICY, ...m}, mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null, ...extra};
    pilot.s.participants[p.id] = p;
    return p;
  };
  const olivia = person('olivia-ops', {approve_above: pc(2), review_deliveries: true, ...mandate}, {owner_token_hash: sha(owner), ...ownerExtra});
  const carol = person('carol-research'), dave = person('dave-docs'), erin = person('erin-review');
  let ts = Math.floor(now / 1000) * 1000 - 3600e3;
  for (const [I, R, total] of [[carol, olivia, pc(3)], [olivia, dave, pc(2)]]) {
    const n = {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(total), amount_redeemed: '0', timestamp: (ts += 7000), signature: '02' + hex(64),
      denomination: 'erg', confirmation: {status: 'confirmed'}};
    notes.set(`${I.pubkey}>${R.pubkey}`, n);
    appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total, total_after: total, timestamp: n.timestamp, signature: n.signature}]);
  }
  pilot.save();
  const deal = 'vd_' + hex(8);
  await pilot.propose(olivia, {signature: '02' + hex(64), terms: {protocol: core.PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: 'erg', deal_id: deal, version: 1,
    prior_terms_hash: null, nonce: hex(16), proposer: olivia.id, payer: {id: olivia.id, pubkey: olivia.pubkey}, payee: {id: erin.id, pubkey: erin.pubkey},
    service: {title: 'Review the budget card docs', description: 'List what is unclear.', deliverable: 'text'}, price: {amount: pc(4), unit: UNIT},
    consideration: 'credit_note_on_delivery_accepted', offer_expires_at: iso(now + DAY), deliver_by: iso(now + 2 * DAY)}});
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'),
    pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  return {pilot, notes, olivia, carol, dave, erin, owner, deal, base: `http://127.0.0.1:${server.address().port}`};
}
// A deal whose credit note (from `payer` to `payee`, `price`) the tracker recorded an hour ago, as the server's state holds
// one (lib/pilot/core.mjs submitNote), and the tracker's note on that key pair now: `redeemed` of it redeemed on Ergo
// testnet, its confirmation `status` (local_only until a tracker box on Ergo testnet commits it). The server reads the
// tracker live for the deal's view (liveNote). Returns the deal id.
async function recordedDeal(w, payer, payee, price, {redeemed = 0, status = 'confirmed'} = {}) {
  const now = Date.now(), at = s => iso(now - s * 1000), sig = () => '02' + hex(64), id = 'vd_' + hex(8);
  await w.pilot.propose(payer, {signature: sig(), terms: {protocol: core.PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: 'erg', deal_id: id, version: 1,
    prior_terms_hash: null, nonce: hex(16), proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
    service: {title: `A job for ${price}`, description: 'synthetic', deliverable: 'text'}, price: {amount: price, unit: UNIT},
    consideration: 'credit_note_on_delivery_accepted', offer_expires_at: iso(now + DAY), deliver_by: iso(now + 2 * DAY)}});
  const d = w.pilot.s.deals[id], v = d.versions[0];
  for (const a of Object.values(w.pilot.s.approvals)) if (a.deal_id === id) Object.assign(a, {state: 'approved', decided_at: at(3700)});
  Object.assign(v, {state: 'accepted', offered_at: at(3700)});
  d.acceptance = {version: 1, by: payee.id, terms_hash: v.terms_hash, signature: sig(), at: at(3600), mandate_check: null, state: 'final'};
  d.agreement = {version: 1, terms: v.terms, terms_hash: v.terms_hash, proposer_signature: v.signature, acceptor_signature: d.acceptance.signature, proposer: payer.id,
    acceptor: payee.id, formed_at: at(3600)};
  d.delivery = {by: payee.id, title: 'done', content: 'the work', sha256: sha('the work'), bytes: 8, signature: sig(), at: at(3000), late: false};
  d.completion = {by: payer.id, signature: sig(), at: at(2900), deliverable_sha256: sha('the work')};
  const ts = Math.floor((now - 2900e3) / 1000) * 1000 + 123, s = sig();
  d.credit_note = {amount: price, prior_total: 0, issuer_pubkey: payer.pubkey, recipient_pubkey: payee.pubkey, note: {total: price, timestamp: ts, signature: s},
    message_hex: '00'.repeat(80), signed_at: at(2900), state: 'recorded', outstanding: true, settled: false, tracker_status: 200, recorded_at: at(2800),
    tracker_note: {amount_collected: price, amount_redeemed: 0, timestamp: ts, signature: s, confirmation: 'local_only'}, verified_by_valun: true, proof: null};
  d.status = 'note_issued';
  w.notes.set(`${payer.pubkey}>${payee.pubkey}`, {issuer_pubkey: payer.pubkey, recipient_pubkey: payee.pubkey, amount_collected: String(price), amount_redeemed: String(redeemed),
    timestamp: ts, signature: s, denomination: 'erg', confirmation: {status}});
  const [entry] = appendEntries(w.pilot, [{kind: 'issue', ref: id, issuer_pubkey: payer.pubkey, recipient_pubkey: payee.pubkey, delta: price, total_after: price, timestamp: ts, signature: s}]);
  d.journal_seq = entry.seq;
  w.pilot.save();
  return id;
}

// public/pilot.js on public/pilot.html's own body, its reads and writes sent to `base` (the real routes) and logged.
// Each page's module draws into the global document of its time, so a page that is still reading when the next one
// takes the globals over would draw its late answer into the next page: each page waits for the one before to be quiet.
let instance = 0, previous = null;
async function openPage({base, token = null, hash, routes = null}) {
  await previous?.quiet();
  const page = installPage({routes: routes ?? (() => undefined), token, hash, body: readBody(fs.readFileSync(path.join(root, 'public', 'pilot.html'), 'utf8'))});
  let reading = 0;
  page.quiet = async () => { for (let calm = 0; calm < 5; await new Promise(r => setTimeout(r, 10))) calm = reading ? 0 : calm + 1; };
  if (!routes) {
    page.sent = [];
    globalThis.fetch = async (u, o = {}) => {
      page.sent.push({method: o.method || 'GET', path: String(u), body: o.body ? JSON.parse(o.body) : undefined});
      reading++;
      try { const r = await nodeFetch(new URL(u, base), o), text = await r.text(); return {ok: r.ok, status: r.status, text: async () => text}; } finally { reading--; }
    };
  }
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({unref() {}});
  try { await import(`${pathToFileURL(path.join(root, 'public', 'pilot.js')).href}?testnet=${++instance}`); } finally { globalThis.setInterval = realInterval; }
  previous = page;
  return page;
}
// Waits (real time: the reads cross HTTP) until `cond()` holds.
async function until(cond, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 10))) if (cond()) return;
  assert.fail(`timed out waiting for ${what}`);
}
// What the page says: its text (every tab, shown or not), the title attributes (tooltips) and the document's title,
// without the protocol's own statement names (valun-pilot/propose/1, ...) and the API's paths, which name no network.
const said = page => [text(page.doc.body), ...page.doc.body.all('*').map(e => e.getAttribute('title')).filter(Boolean), page.doc.title].join('\n')
  .replace(/valun-pilot\/[a-z-]+\/\d/g, '').replace(/\/pilot\/v1\b/g, '');
// The pilot's words. local_only alone is a real status on the testnet too (a note no tracker box has committed yet): what
// is checked is what the page says it means.
const PILOT_WORDS = /\bPC\b|\bpilot\b|no blockchain|no chain|any chain|no reserve|not redeemable|nothing is redeemed|stays? local_only|local_only means|simulated/i;
const offending = page => said(page).split('\n').flatMap(l => l.split(/(?<=[.:;])\s+/)).filter(s => PILOT_WORDS.test(s));

test('the testnet: every tab and the deal view name the testnet and its unit; nothing says PC, pilot or "no blockchain" (fix inbox #72)', async () => {
  const w = await world({max_issue_per_deal: pc(5), max_issue_outstanding: pc(40), max_accept_per_deal: pc(5), max_accept_per_issuer: pc(40)});
  const page = await openPage({base: w.base, token: w.owner, hash: '#network'});
  const $ = s => page.doc.querySelector(s);
  await until(() => text($('#info')).includes('Debt outstanding now') && $('#ledger table'), 'the network tab, with the clearing figures (GET /clearing comes after GET /info)');
  assert.equal(page.doc.title, 'Valun owner console');
  assert.equal(text($('.netline .netname')), 'Valun testnet network', 'the console head names the network');
  assert.equal(text($('.banner')), 'Valun testnet network (experimental). Agents agree jobs and pay each other with signed IOUs (credit notes, in this console), which a Basis tracker records. '
    + 'Amounts are nanoERG of Ergo testnet (1 tERG = 1,000,000,000 nanoERG): test coins with no monetary value. Its Basis tracker anchors its state on Ergo testnet.');
  assert.equal(text($('#net-what')), 'What the Valun testnet network is');
  const facts = text($('.facts-list'));
  assert.match(facts, /^Experimental\. A test network, valun-testnet-1, where AI agents make service-for-credit deals with each other\./);
  assert.match(facts, /Amounts are nanoERG of Ergo testnet\. 1 tERG = 1,000,000,000 nanoERG\. tERG are test coins with no monetary value\. A creditor can redeem a credit note on Ergo testnet against its issuer's tERG reserve, if the issuer posted one\./);
  assert.match(facts, /A Basis tracker records the note and anchors its state on Ergo testnet\. An issued note is an outstanding obligation until its creditor redeems it; with circulating credit it can also move/);
  assert.match(facts, /Payment is a credit note: a debt the payer owes\./);
  assert.match(facts, /or be lowered by a set-off when debts form a loop \(every debt in the loop falls by the same amount\)\./);
  assert.match(text($('#deal-end')), /^It then stays outstanding until its creditor redeems it on Ergo testnet/);
  assert.match(text($('#info')), /UnitnanoERG: the smallest unit of tERG, Ergo testnet's coin \(1 tERG = 1,000,000,000 nanoERG\); test coins with no monetary value/);
  assert.match(text($('#info')), /Tracker on a blockchainyes: Ergo testnet; the tracker anchors its state there/);
  assert.match(text($('#info')), /Debt outstanding now5,000,000 nanoERG \(0\.005 tERG\) gross over 2 notes/, 'the clearing figures, by their unit-neutral names');
  assert.deepEqual(page.doc.body.querySelectorAll('[data-tracker-tag]').map(t => [t.textContent, t.getAttribute('title')]),
    Array(2).fill(['Basis tracker (on Ergo testnet)', "Read from the network's Basis tracker, which anchors its state on Ergo testnet (GET /pilot/v1/chain says when it last did)."]));
  assert.match(text($('#ledger')), /carol-research\s*olivia-ops\s*3,000,000 nanoERG \(0\.003 tERG\)/);
  assert.equal(text($('footer p')), 'Ergo testnet · test coins only, with no monetary value', 'the footer every public page shows');
  assert.deepEqual($('footer').querySelectorAll('a').map(a => [text(a), a.getAttribute('href')]), [['Trust', '/trust'], ['Report a problem', '/start#report'],
    ['skill.md', '/skill.md'], ['llms.txt', '/llms.txt'], ['GitHub', 'https://github.com/fitzss/valun-open']]);
  assert.deepEqual(offending(page), [], 'the network tab, and the join tab\'s text, say nothing of the pilot');

  // The owner console.
  globalThis.location.hash = '#owner'; page.hashchange();
  await until(() => $('#mandate-form'), 'the owner console');
  const con = $('#owner-console'), appr = con.querySelector('article.appr');
  assert.equal(page.doc.title, '(1) Valun owner console');
  assert.match(text(appr), /offer\s*Review the budget card docs\s*4,000,000 nanoERG \(0\.004 tERG\) – you pay, with your agent's IOU/);
  // What the agent asks, and with whom, in nanoERG with its tERG; what is already signed and held; the deadline (the
  // console's approval texts of 2026-11-18, from the server's approvalEffect).
  assert.match(text(appr), /Your agent asks to hire erin-review for this job at 4,000,000 nanoERG \(0\.004 tERG\), paid with your agent's own IOU once it accepts the work\./);
  assert.match(text(appr), /Already signed and heldYour agent signed this offer with its key, and Valun's server holds it: erin-review can't see it, and nothing is on the tracker\./);
  assert.match(text(appr), /Decide by .* \(in 24 hours\)\./);
  assert.match(text(appr), /max_issue_outstanding: on the tracker 2,000,000 nanoERG \(0\.002 tERG\) \+ committed 0 nanoERG \(0 tERG\) \+ offered 0 nanoERG \(0 tERG\) \+ this deal 4,000,000 nanoERG \(0\.004 tERG\) = 6,000,000 nanoERG \(0\.006 tERG\) of 40,000,000 nanoERG \(0\.04 tERG\)/,
    "the server's mandate check, in nanoERG");
  assert.match(text(appr), /price 4,000,000 nanoERG \(0\.004 tERG\) within max_issue_per_deal 5,000,000 nanoERG \(0\.005 tERG\)/, 'the check computed in the page');
  assert.match(text(con), /Hold3,000,000 nanoERG \(0\.003 tERG\)others owe you/);
  assert.match(text(con), /Cleared0 nanoERG \(0 tERG\)by set-off(?!;)/, 'cleared by set-off, without "nothing is redeemed"');
  // The real server's position: cleared and redeemed as two rows; its `settled` sum, `settled_how` and `meaning` (which
  // says "settled counts both") are not shown.
  const position = con.querySelectorAll('.card').find(c => /^Position/.test(text(c.querySelector('h2'))));
  assert.match(text(position), /Cleared by set-off0 nanoERG \(0 tERG\) of your debts cleared in loops, and as much of your claims \(each set-off is committed by the next tracker box on Ergo testnet, and is not final\)/);
  assert.match(text(position), /Redeemed on Ergo testnet0 nanoERG \(0 tERG\) of your claims, which you redeemed; 0 nanoERG \(0 tERG\) of your debts, redeemed from your reserve/);
  assert.doesNotMatch(text(position), /settled/i);
  // The testnet's default acceptance where "Accept notes from" is, and what payer coverage counts there.
  const form = text(con.querySelector('#mandate-form'));
  // Each client signs only for its own key (D3b, the redesign's round 2).
  assert.match(form, /On the testnet a new self-serve agent accepts any issuer's IOUs as payment by transfer, up to 0\.04 tERG per issuer\. Its client signs that acceptance by itself in every approval mode, and the issuer's client signs the issuer's consent the same way\. You can narrow whose IOUs your agent accepts here, with “only those ticked here”\./);
  assert.doesNotMatch(form, /signs that consent, and the issuer's/);
  assert.match(form, /Your agent may accept a credit note only from a payer whose own tERG reserve, claims and guarantees of its debt to you cover at least this percentage of everything it would owe, this deal included\. A claim or a guarantee counts only as far as a reserve on Ergo testnet, or an issuer you list under Accept notes from, stands behind it; a payer you list there counts as covered\./);
  assert.deepEqual(offending(page), [], 'the owner console says nothing of the pilot');

  // The deal view of the proposal waiting for her.
  globalThis.location.hash = `#owner/deal/${w.deal}`; page.hashchange();
  await until(() => $('#history-card'), 'the deal view');
  assert.match(text($('#deal-view')), /Version 1 by olivia-ops \(you\) · awaiting owner .*Price4,000,000 nanoERG \(0\.004 tERG\)/);
  assert.deepEqual(offending(page), [], 'the deal view says nothing of the pilot');
});

// The site redesign's review: the agent learns of its owner's decision only when it next checks, so after an approval the console
// tells the owner to tell it. Since the approval texts of 2026-11-18 a rejection says what it did and what Valun keeps,
// and that the agent isn't told either.
test('the testnet: approving what waits says what it did, then "Tell your agent: it carries on when it next checks."; rejecting says what it did and what Valun keeps, and that the agent isn\'t told', async () => {
  for (const decision of ['Approve', 'Reject']) {
    const w = await world();
    const page = await openPage({base: w.base, token: w.owner, hash: '#owner'});
    await until(() => page.doc.querySelector('article.appr'), `${decision}: the proposal waiting for its owner`);
    const button = page.doc.querySelector('article.appr').querySelectorAll('button').find(b => b.textContent === decision);
    assert.equal(button.disabled, false, `${decision} is on`);
    button.click();
    await until(() => page.doc.querySelector('#approvals .flash'), `${decision}: the outcome`);
    const said = text(page.doc.querySelector('#approvals .flash')), [a] = Object.values(w.pilot.s.approvals).filter(x => x.deal_id === w.deal);
    if (decision === 'Approve') {
      assert.equal(said, `Approved (${a.id}). Deal ${w.deal} is open: erin-review can now accept, counter or decline. Tell your agent: it carries on when it next checks.`);
      assert.equal(w.pilot.s.deals[w.deal].status, 'open', 'the server offered it');
    } else {
      assert.equal(said, `Rejected (${a.id}). The offer was never shown to erin-review, and deal ${w.deal} ended. Valun keeps your agent's signed offer on record; it binds nobody. Your agent isn't told: tell it.`);
      assert.equal(w.pilot.s.deals[w.deal].status, 'rejected_by_owner');
    }
  }
});

test('the testnet: the limits editor saves 5,000,000 a deal and 40,000,000 in all; no maximum on its inputs; labels and errors name nanoERG (fix inbox #72)', async () => {
  const w = await world();            // the testnet's DEFAULT_MANDATE: 25,000,000 a deal, 50,000,000 in all
  assert.deepEqual([w.olivia.mandate.max_issue_per_deal, w.olivia.mandate.max_issue_outstanding], [25_000_000, 50_000_000]);
  const page = await openPage({base: w.base, token: w.owner, hash: '#owner'});
  await until(() => page.doc.querySelector('#mandate-form'), 'the limits editor');
  let form = page.doc.querySelector('#mandate-form');
  const AMOUNTS = ['max_issue_per_deal', 'max_issue_outstanding', 'max_accept_per_deal', 'max_accept_per_issuer', 'min_price_as_payee', 'approve_above', 'c_max_claims_total', 'c_max_issuer_net_debt'];
  for (const name of [...AMOUNTS, 'min_payer_coverage_pct']) {
    const input = form.querySelector(`input[name=${name}]`);
    assert.ok(input, name);
    assert.deepEqual([input.getAttribute('type'), input.getAttribute('min'), input.getAttribute('step'), input.getAttribute('max')], ['number', '0', '1', null], `${name}: a whole number, 0 or more, no maximum`);
  }
  const label = name => form.querySelector(`input[name=${name}]`).closest('label').childNodes[0].textContent;
  assert.deepEqual(['max_issue_per_deal', 'max_issue_outstanding', 'approve_above', 'c_max_claims_total', 'min_payer_coverage_pct'].map(label),
    ['Max credit note per deal (as payer), nanoERG', 'Max you may owe in total, nanoERG', 'Ask me above (approve_above), nanoERG', 'Max claims on all payers together (max_claims_total), nanoERG',
      'Min payer coverage (min_payer_coverage_pct), %']);
  const terg = name => text(form.querySelector(`.amount-terg[data-for=${name}]`));
  assert.deepEqual([terg('max_issue_per_deal'), terg('max_issue_outstanding')], ['= 0.025 tERG', '= 0.05 tERG'], 'each amount shown in tERG beside it');
  assert.equal(form.querySelector('.amount-terg[data-for=min_payer_coverage_pct]'), null, 'not a percentage');
  assert.doesNotMatch(text(form), /\bPC\b/);

  // A testnet-sized mandate: typed, shown in tERG, sent as typed, and taken by the server.
  const set = (name, v) => { const i = form.querySelector(`input[name=${name}]`); i.value = v; i.dispatch('input'); };
  set('max_issue_per_deal', '5000000'); set('max_issue_outstanding', '40000000');
  assert.deepEqual([terg('max_issue_per_deal'), terg('max_issue_outstanding')], ['= 0.005 tERG', '= 0.04 tERG']);
  form.dispatch('submit');
  await until(() => /^Saved: mandate version 2\./.test(text(page.doc.querySelector('#mandate-msg'))), 'the save');
  const put = page.sent.filter(c => c.method === 'PUT');
  assert.equal(put.length, 1);
  assert.equal(put[0].path, '/pilot/v1/owner/mandate');
  assert.deepEqual([put[0].body.max_issue_per_deal, put[0].body.max_issue_outstanding], [5_000_000, 40_000_000]);
  assert.equal(w.olivia.mandate_version, 2, 'the server took it');
  assert.deepEqual([w.olivia.mandate.max_issue_per_deal, w.olivia.mandate.max_issue_outstanding], [5_000_000, 40_000_000]);
  form = page.doc.querySelector('#mandate-form');
  assert.deepEqual(['max_issue_per_deal', 'max_issue_outstanding'].map(n => form.querySelector(`input[name=${n}]`).value), ['5000000', '40000000'], 'the editor shows what the server holds');
  assert.match(text(page.doc.querySelector('#mandate-card h2')), /^Mandate \(version 2\)/);

  // What is not a whole number is refused before anything is sent, in the field's unit.
  for (const [name, v, want] of [['max_issue_per_deal', '5,000,000', 'max_issue_per_deal: enter a whole number of nanoERG (0 or more).'],
    ['min_payer_coverage_pct', '12.5', 'min_payer_coverage_pct: enter a whole percentage (0 or more).'],
    ['c_max_claims_total', '4e7', 'max_claims_total: enter a whole number of nanoERG (0 or more), or leave it empty for no limit.']]) {
    form = page.doc.querySelector('#mandate-form');
    set(name, v);
    form.dispatch('submit');
    assert.equal(text(page.doc.querySelector('#mandate-msg')), want, name);
    set(name, name === 'c_max_claims_total' ? '' : name === 'min_payer_coverage_pct' ? '0' : '5000000');
  }
  assert.equal(page.sent.filter(c => c.method === 'PUT').length, 1, 'nothing more was sent');
  // Above the network's bound the server says so (the page has no maximum of its own).
  form = page.doc.querySelector('#mandate-form');
  set('max_issue_outstanding', String(pc(100000) + 1));
  form.dispatch('submit');
  await until(() => /invalid_field/.test(text(page.doc.querySelector('#mandate-msg'))), "the server's answer");
  assert.match(text(page.doc.querySelector('#mandate-msg')), /max_issue_outstanding must be a whole number 0\.\.100000000000/);
  assert.equal(w.olivia.mandate.max_issue_outstanding, 40_000_000, 'unchanged');
});

// A review of ab3581e (fix inbox #72): a recorded note's view on the testnet said the payer still owed the full price
// after a partial redemption, and explained local_only as the pilot did ("no reserve behind it, not redeemable"),
// though on the testnet it only means no tracker box on Ergo testnet has committed the note yet.
test('the testnet: a recorded credit note as the tracker holds it now: what is left after a partial redemption, and what local_only means there (fix inbox #72)', async () => {
  const w = await world({max_issue_per_deal: pc(5), max_issue_outstanding: pc(40)});
  // olivia-ops paid erin-review 4,000,000 with a credit note, of which erin redeemed 1,000,000 on Ergo testnet; dave-docs
  // paid her 2,000,000 with one that no tracker box has committed yet.
  const partly = await recordedDeal(w, w.olivia, w.erin, pc(4), {redeemed: pc(1)});
  const fresh = await recordedDeal(w, w.dave, w.olivia, pc(2), {status: 'local_only'});
  const page = await openPage({base: w.base, token: w.owner, hash: `#owner/deal/${partly}`});
  const $ = s => page.doc.querySelector(s);
  await until(() => $('#payment-card'), 'the deal view');
  let view = text($('#deal-view')), card = text($('#payment-card'));
  assert.match(view, /Credit note issued, partly redeemed: olivia-ops \(you\) still owes erin-review 3,000,000 nanoERG \(0\.003 tERG\) of the 4,000,000 nanoERG \(0\.004 tERG\) under this deal; 1,000,000 nanoERG \(0\.001 tERG\) of it was redeemed on Ergo testnet\. The rest is an outstanding obligation: its creditor can redeem it on Ergo testnet against the issuer's tERG reserve, if the issuer posted one\./);
  assert.match(view, /credit note issued \(partly redeemed, the rest outstanding\)/, 'the status shown');
  assert.match(card, /Outstandingyes: the payer still owes 3,000,000 nanoERG \(0\.003 tERG\) of 4,000,000 nanoERG \(0\.004 tERG\) \(1,000,000 nanoERG \(0\.001 tERG\) redeemed\)/);
  assert.match(card, /Settledno: partly redeemed on Ergo testnet/, "the server's own words");
  assert.match(card, /Tracker holds now4,000,000 nanoERG \(0\.004 tERG\) in total for this key pair, 1,000,000 nanoERG \(0\.001 tERG\) redeemed, 3,000,000 nanoERG \(0\.003 tERG\) outstanding/);
  assert.match(view, /Nothing further happens to this deal: the rest of the credit note, 3,000,000 nanoERG \(0\.003 tERG\), stays outstanding until its creditor redeems it on Ergo testnet/);
  assert.doesNotMatch(view, /owes erin-review 4,000,000|the payer owes this amount/, 'nothing says the full price is still owed');
  assert.deepEqual(offending(page), []);
  // The owner console's list of deals says the same.
  globalThis.location.hash = '#owner'; page.hashchange();
  await until(() => $('#deals-card') && !$('#owner-console').hidden, 'the owner console');
  assert.match(text($('#deals-card')), /credit note issued \(partly redeemed, the rest outstanding\)/);
  // A note no tracker box has committed yet: redeemable once the next one is confirmed; nothing about a reserve.
  globalThis.location.hash = `#owner/deal/${fresh}`; page.hashchange();
  await until(() => $('#payment-card') && text($('#deal-view')).includes('A job for 2000000'), 'the second deal');
  card = text($('#payment-card'));
  assert.match(card, /Confirmationlocal_only: recorded by the tracker, not yet committed by its tracker box on Ergo testnet; it can be redeemed once the next tracker box is confirmed \(GET \/pilot\/v1\/chain says when\)/);
  assert.doesNotMatch(card, /no reserve|not redeemable|any chain/);
  assert.match(card, /Outstandingyes: the payer owes this amount/);
  assert.deepEqual(offending(page), [], 'the local_only note says nothing of the pilot');
});

// A review of ab3581e (fix inbox #72): the box of limits the agent recorded said "your mandate: no limit" for a sandbox
// owner's max_claims_total, which the server enforces at the box's 40,000,000 (and the editor beside it showed).
test('the testnet: the limits your agent recorded name your mandate as the server enforces it, a sandbox owner\'s max_claims_total included (fix inbox #72)', async () => {
  for (const [who, extra, mine] of [['a sandbox owner', {sandbox_only: true, sandbox_expires_at: iso(Date.now() + 7 * DAY)}, '40,000,000 nanoERG (0.04 tERG)'],
    ['an invited owner', {}, 'no limit']]) {
    const w = await world({}, extra);
    assert.equal('max_claims_total' in w.olivia.mandate, false, `${who}: the mandate holds no max_claims_total`);
    w.pilot.setAgentLimits(w.olivia, {max_claims_total: pc(30)}, {by: 'agent'});
    const page = await openPage({base: w.base, token: w.owner, hash: '#owner'});
    await until(() => page.doc.querySelector('#mandate-form'), `${who}: the owner console`);
    const box = page.doc.body.all('*').find(e => e.classList.contains('open-offers') && e.textContent.startsWith('Limits your agent recorded'));
    assert.match(text(box), new RegExp(`Max claims on all payers together30,000,000 nanoERG \\(0\\.03 tERG\\) \\(your mandate: ${mine.replace(/[().]/g, c => `\\${c}`)}; in force: 30,000,000 nanoERG \\(0\\.03 tERG\\)\\)`), who);
    assert.equal(page.doc.querySelector('#mandate-form [name=c_max_claims_total]').value, who === 'a sandbox owner' ? '40000000' : '', `${who}: the editor beside it says the same`);
  }
});

test('on a server that still runs the retired pilot (unit PC, no chain) the page keeps the pilot\'s words (fix inbox #72)', async () => {
  const info = {network: 'valun-pilot-1', protocol: 'valun-deal/1', unit: 'PC', denomination: `token:${'e'.repeat(64)}`, tracker_nft_id: 'd'.repeat(64), tracker_on_chain: false,
    experimental: true, description: 'Valun pilot network', statements: {}, participants: 0};
  const routes = (m, p) => (m !== 'GET' ? undefined : p === '/info' ? {status: 200, body: info} : p === '/participants' ? {status: 200, body: []}
    : p === '/ledger' ? {status: 200, body: {unit: 'PC', notes: [], reconciliation: []}} : undefined);
  const page = await openPage({hash: '#network', routes});
  const $ = s => page.doc.querySelector(s);
  await until(() => text($('#info')).includes('valun-pilot-1'), 'the network tab');
  assert.equal(page.doc.title, 'Valun owner console');
  assert.equal(text($('.netline .netname')), 'Valun pilot network');
  assert.match(text($('.banner')), /^Valun pilot network \(experimental\)\. .* PC are simulated pilot credits with no monetary value\. No blockchain is connected\.$/);
  assert.match(text($('.facts-list')), /PC = pilot credits\. Simulated units with no monetary value\./);
  assert.match(text($('.facts-list')), /The tracker has no blockchain connection, so every note stays local_only\./);
  assert.match(text($('#info')), /UnitPC: simulated pilot credits, no monetary value/);
  assert.equal($('[data-tracker-tag]').textContent, 'Basis tracker (local, no chain)');
  assert.equal(text($('footer p')), 'Valun pilot network valun-pilot-1 · experimental · PC have no monetary value · no blockchain connected');
});

// The one exception: the footer's line, the same on every public page of valun.tech, names Ergo testnet (the one network
// it serves); on another network pilot.js writes that network's own.
test('before the server answers, the page says only what is true of every network: no unit, no chain, no pilot (fix inbox #72)', () => {
  const body = readBody(fs.readFileSync(path.join(root, 'public', 'pilot.html'), 'utf8'));
  const html = fs.readFileSync(path.join(root, 'public', 'pilot.html'), 'utf8');
  assert.equal(/<title>([^<]*)<\/title>/.exec(html)[1], 'Valun owner console');
  assert.equal(text(body.querySelector('#net-footer-facts')), 'Ergo testnet · test coins only, with no monetary value');
  const all = text(body);
  for (const re of [/\bPC\b/, /\bpilot\b/i, /blockchain/i, /no chain/i, /local_only/, /valun-pilot-1/, /demo credit desk/i]) assert.doesNotMatch(all, re);
  for (const id of ['net-name', 'net-banner-title', 'net-banner-unit', 'net-what', 'fact-network', 'fact-unit', 'fact-payment', 'deal-end', 'ledger-hint', 'net-footer-facts'])
    assert.ok(body.all('*').some(e => e.id === id), `#${id}, which pilot.js fills in from GET /info`);
});
