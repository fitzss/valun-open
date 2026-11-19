// The server's half of the newcomer fixes (the fresh-join run of Nov 18 on the testnet, and the read-only check of its
// findings): what an agent reads at join, in its inbox, in the directory and when its first IOU is issued. On the
// testnet's network (PILOT_NETWORK=valun-testnet-1, its 5-minute tracker cycle and public origin, as fly.testnet.toml
// sets them), in its own process, over a stub tracker: no tracker binary (CI's no-tracker list).
//   - finding 3 (an inaccurate owner text): an issued IOU's labels.basis said the note was "held by the testnet tracker
//     (its state anchored on Ergo testnet)" while its confirmation read local_only. It says how far the pair's note got,
//     from that confirmation, read live;
//   - finding 12 (no plain ending): labels.summary, with circulating credit, for the payer and the payee: who owes whom,
//     when the tracker recorded it, how far it got on Ergo testnet and what commits it, how to check it, and how it is
//     paid back (a loop, passing it on, redemption only against the issuer's reserve, which it says when there is none);
//     in mode off the view keeps v15's labels (I-DARK);
//   - finding 9 (the inbox lacked what you would accept): the inbox's offers to answer and work to deliver carry the
//     terms_hash an acceptance signs and the service's description and deliverable, cut, in every mode but off;
//   - finding 5 (sandbox_only read as boxed in): self_serve and open_network beside sandbox_only in the join's answer
//     and in the public record;
//   - finding 6 (the directory's order was insertion order): GET /participants lists the agents the server runs first,
//     then the house agents, then the rest in join order.
// Run: node --test test/newcomer-ending.unit.test.mjs
process.env.PILOT_NETWORK = 'valun-testnet-1';
process.env.VALUN_PUBLIC_ORIGIN = 'https://valun.tech';
process.env.BASIS_TRACKER_UPDATE_INTERVAL_SECONDS = '300';
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const {Pilot, PilotStore, DEFAULT_MANDATE, INBOX_TEXT_CHARS, sha256} = await import('../lib/pilot/core.mjs');
const {createPilotRoutes} = await import('../lib/pilot/http.mjs');
const {createHandler} = await import('../lib/http.mjs');
const {BasisError} = await import('../lib/basis.mjs');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-newcomer-')); dirs.push(d); return d; };
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const DAY = 864e5, PIN = 'cd'.repeat(32), T0 = Date.parse('2026-11-18T19:00:00.000Z');
// The testnet tracker's capabilities (tracker v4.4.1: circulation with anchored netting), as test/testnet-network.test.mjs.
const CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: 'x', pure_credit: false, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to',
    'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 0, novations_disabled_reason: null,
  anchored_netting: {version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720, observation_max_age_ms: 7200000}};
// The stub signer (as test/unfinished-join.unit.test.mjs): a "signature" is 02 + sha256(pubkey + message) twice.
const sign = (pubkey, msgHex) => '02' + sha256(pubkey + msgHex).repeat(2);

// A testnet Pilot over a stub tracker. `notes`: what basis.note() reads, by "issuer>recipient" (null: the tracker cannot
// be read, as a BasisError); `reserves`: what basis.reserves() answers (null: it throws). mode 'on' (the testnet's) or 'off'.
function world({mode = 'on', onChain = true, openNetwork = true} = {}) {
  const dir = tmp(), clock = {t: T0}, notes = new Map(), stub = {reserves: [], unreadable: false};
  const basis = {nft: '0'.repeat(64), denomination: 'erg', capabilities: async () => CAPS, allNotes: async () => [...notes.values()],
    note: async (i, r) => { if (stub.unreadable) throw new BasisError('tracker down', {code: 'unreachable'}); return notes.get(`${i}>${r}`) ?? null; },
    reserves: async () => { if (stub.reserves === null) throw new Error('reserves unreadable'); return stub.reserves; },
    proof: async () => null, verify: async (pubkey, msgHex, sig) => sig === sign(pubkey, msgHex)};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, log: () => {}, openSandbox: true, openNetwork,
    ...(mode === 'off' ? {} : {circulation: mode, trackerCaps: CAPS, trackerSha256: PIN, trackerPins: [PIN]})});
  assert.equal(pilot.mode, mode);
  if (onChain) pilot.chain = {name: 'ergo-testnet', on_chain: true, tracker_nft_id: '0'.repeat(64), spend_ledger: path.join(dir, 'spend-ledger.jsonl')};
  const person = (handle, extra = {}) => {
    const x = {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test', about: '', services: '', pubkey: '02' + hex(32), status: 'active',
      created_at: iso(clock.t), owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null,
      mandate: {...DEFAULT_MANDATE, ...(mode === 'off' ? {} : {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'})},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null, ...extra};
    pilot.s.participants[x.id] = x;
    return x;
  };
  return {pilot, clock, notes, stub, person, dir};
}
const terms = (P, Q, {price = 3_000_000, by = P, title = 'word stats', description = 'Count the words.', deliverable = 'plain text'} = {}) => ({
  deal_id: 'vd_' + hex(8), version: 1, proposer: by.id, payer: {id: P.id, pubkey: P.pubkey}, payee: {id: Q.id, pubkey: Q.pubkey},
  service: {title, description, deliverable}, price: {amount: price, unit: 'nanoERG'}, offer_expires_at: iso(T0 + DAY), deliver_by: iso(T0 + 2 * DAY)});
// A deal in `status` with one version by `by`; note_issued: the tracker recorded P's IOU to Q for the price at T0, the pair's
// total then `total` (as Pilot.submitNote leaves it).
function deal(w, P, Q, status, {by = P, total, confirmation = 'local_only', ...more} = {}) {
  const t = terms(P, Q, {by, ...more}), price = t.price.amount, h = hex(32);
  const v = {v: 1, by: by.id, terms: t, terms_hash: h, signature: '02' + hex(64), created_at: iso(T0), state: status === 'open' ? 'open' : 'accepted', offered_at: iso(T0)};
  const d = {id: t.deal_id, payer: P.id, payee: Q.id, created_at: iso(T0), status, versions: [v], history: []};
  if (status !== 'open') d.agreement = {version: 1, terms: t, terms_hash: h, formed_at: iso(T0), proposer_signature: v.signature, acceptor_signature: '02' + hex(64), proposer: by.id, acceptor: (by === P ? Q : P).id};
  if (status === 'note_issued') {
    const after = total ?? price;
    d.delivery = {by: Q.id, sha256: hex(32), content: 'the work', bytes: 8, at: iso(T0), late: false};
    d.completion = {by: P.id, signature: '02' + hex(64), at: iso(T0), deliverable_sha256: d.delivery.sha256};
    d.credit_note = {state: 'recorded', issuer_pubkey: P.pubkey, recipient_pubkey: Q.pubkey, amount: price, prior_total: after - price, outstanding: true, settled: false,
      note: {total: after, timestamp: T0 - 997, signature: '02' + hex(64)}, tracker_status: 201, recorded_at: iso(T0),
      tracker_note: {amount_collected: after, amount_redeemed: 0, timestamp: T0 - 997, signature: '02' + hex(64), confirmation}};
    w.notes.set(`${P.pubkey}>${Q.pubkey}`, {amount_collected: String(after), amount_redeemed: '0', timestamp: T0 - 997, signature: d.credit_note.note.signature, confirmation: {status: confirmation}});
  }
  w.pilot.s.deals[d.id] = d;
  return d;
}
const setConfirmation = (w, P, Q, status, more = {}) => { const n = w.notes.get(`${P.pubkey}>${Q.pubkey}`); n.confirmation = {status}; Object.assign(n, more); };

// ---------- finding 3: where the IOU stands, not "anchored" beside local_only ----------
test('finding 3: an issued IOU\'s labels.basis says how far the pair\'s note got on Ergo testnet, read live, never "anchored" beside local_only', async () => {
  const w = world(), {pilot, person} = w, carl = person('carl'), dana = person('dana');
  const d = deal(w, carl, dana, 'note_issued');
  const label = async who => (await pilot.dealView(d, who)).labels.basis;
  const lead = 'credit note issued: the payer-signed Basis note is held by the testnet tracker; ', tail = '; carl owes dana 3000000 nanoERG (0.003 tERG) more';
  assert.equal(await label(carl), `${lead}no tracker box on Ergo testnet commits the pair's current total yet (local_only)${tail}`);
  assert.equal(await label(dana), `${lead}no tracker box on Ergo testnet commits the pair's current total yet (local_only)${tail}`, 'the same for the payee');
  setConfirmation(w, carl, dana, 'pending');
  assert.equal(await label(carl), `${lead}a tracker box that carries the pair's current total waits for an Ergo testnet block (pending)${tail}`);
  setConfirmation(w, carl, dana, 'confirmed');
  const v = await pilot.dealView(d, carl);
  assert.equal(v.labels.basis, `${lead}a confirmed tracker box on Ergo testnet commits the pair's current total (confirmed)${tail}`);
  assert.equal(v.credit_note.confirmation, 'confirmed', 'the label and the note\'s confirmation agree');
  w.stub.unreadable = true;
  assert.equal(await label(carl), `${lead}whether a tracker box on Ergo testnet commits the pair's current total could not be read just now${tail}`);
  // A view made without reading the tracker (Pilot.view) says what the tracker said when it recorded the note.
  assert.equal(pilot.view(d, carl).labels.basis, `${lead}when the tracker recorded it, no tracker box on Ergo testnet committed the pair's total yet (local_only)${tail}`);
  for (const s of [await label(carl), pilot.view(d, carl).labels.basis]) assert.doesNotMatch(s, /anchored/);
});

// ---------- finding 12: the plain ending ----------
test('finding 12: at note_issued labels.summary tells the payee and the payer, from live state, who owes whom, when it was recorded and committed, how to check it and how it is paid back', async () => {
  const w = world(), {pilot, person} = w, carl = person('carl'), dana = person('dana');
  const d = deal(w, carl, dana, 'note_issued');
  const summary = async who => (await pilot.dealView(d, who)).labels.summary;
  const commit = 'No tracker box on Ergo testnet commits the pair\'s current total yet (local_only). The tracker checks for changes every 5 minutes and posts one tracker box at a time, at most 50 a UTC day: the row reads pending while a box that carries it waits for a block, then confirmed (usually within 15 minutes of a change, as measured on this network).';
  const check = 'Check it: GET https://valun.tech/pilot/v1/ledger, the row with issuer_handle carl and recipient_handle dana (its total and confirmation).';
  assert.equal(await summary(dana), 'For this deal carl issued you an IOU (credit note) of 3000000 nanoERG (0.003 tERG), which the testnet tracker recorded at 2026-11-18T19:00:00.000Z. '
    + 'What carl owes you on the pair\'s row (from carl to dana) is now 3000000 nanoERG (0.003 tERG). '
    + `${commit} ${check} `
    + 'How it is paid back or used: a loop of IOUs through this pair lowers it by the loop\'s smallest debt (a set-off); you can pass it on to another agent that accepts carl\'s IOUs (carl then owes that agent instead); '
    + 'you can redeem it for tERG only against a reserve carl posted on Ergo testnet, once a tracker box commits it: carl has none now. Until then it stays carl\'s promise to pay, not a payment.');
  assert.equal(await summary(carl), 'For this deal you issued dana an IOU (credit note) of 3000000 nanoERG (0.003 tERG), which the testnet tracker recorded at 2026-11-18T19:00:00.000Z. '
    + 'What you owe dana on the pair\'s row (from carl to dana) is now 3000000 nanoERG (0.003 tERG). '
    + `${commit} ${check} `
    + 'How it is paid back or used: a loop of IOUs through this pair lowers it by the loop\'s smallest debt (a set-off); dana can pass it on to another agent that accepts your IOUs (you then owe that agent instead); '
    + 'dana can redeem it for tERG only against a reserve you posted on Ergo testnet, once a tracker box commits it: you have none now. Until then it stays your promise to pay, not a payment.');
  // A reserve of the IOU's own key counts, with collateral and no refund under way (as GET /reserves and reservesById);
  // another key's reserve, a refunding one or a token reserve does not back it.
  w.stub.reserves = [{owner_pubkey: '02' + hex(32), collateral_amount: 9_000_000}, {owner_pubkey: carl.pubkey, collateral_amount: 50_000_000, refund_initiation_height: 0},
    {owner_pubkey: carl.pubkey, collateral_amount: 5_000_000, reserve_token_id: 'ab'.repeat(32)}];
  assert.match(await summary(dana), /: carl has one now, holding 50000000 nanoERG \(0\.05 tERG\) \(GET https:\/\/valun\.tech\/pilot\/v1\/reserves\)\. Until then/);
  w.stub.reserves = [{owner_pubkey: carl.pubkey, collateral_amount: 50_000_000, refund_initiation_height: 651000}];
  assert.match(await summary(dana), /: carl's reserve is being refunded, and its owner may take it all once the waiting period ends\. Until then/);
  w.stub.reserves = null;
  assert.match(await summary(carl), /: whether you have one could not be read just now \(GET https:\/\/valun\.tech\/pilot\/v1\/reserves\)\. Until then/);
  w.stub.reserves = [];
  // A later IOU on the pair: the row stands at the new total; pending, then confirmed (the timing is left out once confirmed).
  setConfirmation(w, carl, dana, 'pending', {amount_collected: '5000000'});
  let s = await summary(dana);
  assert.match(s, /is now 5000000 nanoERG \(0\.005 tERG\)\. A tracker box that carries the pair's current total waits for an Ergo testnet block \(pending\)\. The tracker checks/);
  setConfirmation(w, carl, dana, 'confirmed');
  s = await summary(dana);
  assert.match(s, /\(0\.005 tERG\)\. A confirmed tracker box on Ergo testnet commits the pair's current total \(confirmed\)\. Check it:/);
  // A loop (set-off) emptied the row since: the summary counts the changes and says nothing is owed on it, with no way to
  // pay back what is no longer owed (Pilot.pairChangesSince reads the edge journal; stubbed here, as a run on a local
  // testnet copy showed it once a two-agent loop with sandbox-exact cleared).
  setConfirmation(w, carl, dana, 'local_only', {amount_collected: '0'});
  pilot.pairChangesSince = () => [{kind: 'setoff', ref: 'vs_' + hex(8), delta: -3_000_000}];
  s = await summary(carl);
  assert.match(s, /What you owe dana on the pair's row \(from carl to dana\) is now 0 nanoERG \(0 tERG\)\. Since then, set-offs \(loops\) changed that row once \(credit_note\.pair_changes_since\)\. No tracker box on Ergo testnet commits the pair's current total yet \(local_only\)\./);
  assert.match(s, /\(its total and confirmation\)\. Nothing is owed on that row now\.$/);
  pilot.pairChangesSince = () => [{kind: 'setoff', ref: null, delta: -1, count: 2, through_seq: 9}, {kind: 'setoff', ref: 'vs_' + hex(8), delta: -1}, {kind: 'transfer_out', ref: 'vt_' + hex(8), delta: -1}];
  setConfirmation(w, carl, dana, 'local_only', {amount_collected: '1000000'});
  s = await summary(dana);
  assert.match(s, /Since then, set-offs \(loops\) changed that row 2 times and transfers changed it once \(credit_note\.pair_changes_since\)\./);
  assert.match(s, /How it is paid back or used:/, 'what is still owed can still be paid back');
  delete pilot.pairChangesSince;
  // Today's tracker boxes used up (the wallet adapter's spend ledger): the summary says until when.
  setConfirmation(w, carl, dana, 'local_only', {amount_collected: '3000000'});
  fs.writeFileSync(pilot.chain.spend_ledger, Array.from({length: 50}, (_, i) => JSON.stringify({kind: 'tracker_box', tx_id: (i + 16).toString(16).padStart(64, '0'), t: iso(T0 - 60e3 * (i + 1)), inputs: []})).join('\n') + '\n');
  assert.match(await summary(dana), /\(usually within 15 minutes of a change, as measured on this network\)\. Today's 50 boxes are used up, so the next comes after 2026-11-19T00:00:00\.000Z\. Check it:/);
  // Redeemed in full (liveNote: the pair's redemptions settle its total from the first unit on): nothing is outstanding.
  setConfirmation(w, carl, dana, 'confirmed', {amount_redeemed: '3000000'});
  s = await summary(dana);
  assert.match(s, /is now 0 nanoERG \(0 tERG\)\./);
  assert.match(s, /It was redeemed on Ergo testnet against carl's reserve: nothing of it is outstanding\.$/);
  // The tracker unreadable: the row as recorded, and said so.
  w.stub.unreadable = true;
  s = await summary(dana);
  assert.doesNotMatch(s, /Nothing is owed|It was redeemed/, 'nothing said that was not read');
  assert.match(s, /How it is paid back or used:/);
  assert.match(s, /What carl owes you on the pair's row \(from carl to dana\) was 3000000 nanoERG \(0\.003 tERG\) when the tracker recorded it \(the tracker could not be read just now\)\. Whether a tracker box on Ergo testnet commits the pair's current total could not be read just now\. The tracker checks/);
});

test('finding 12: the summary is only at note_issued and only with circulating credit; in mode off the deal view keeps v15\'s labels', async () => {
  const w = world(), {pilot, person} = w, carl = person('carl'), dana = person('dana');
  const open = deal(w, carl, dana, 'open'), agreed = deal(w, carl, dana, 'agreed');
  for (const d of [open, agreed]) assert.deepEqual(Object.keys((await pilot.dealView(d, carl)).labels), ['signed_by_parties', 'owner_approvals', 'basis', 'settlement', 'work']);
  const off = world({mode: 'off'}), a = off.person('carl'), b = off.person('dana'), issued = deal(off, a, b, 'note_issued');
  const v = await off.pilot.dealView(issued, a);
  assert.deepEqual(Object.keys(v.labels), ['signed_by_parties', 'owner_approvals', 'basis', 'settlement', 'work'], 'I-DARK: no summary in mode off');
  assert.match(v.labels.basis, /held by the testnet tracker; no tracker box on Ergo testnet commits/);
});

// ---------- finding 9: the inbox says what you would accept ----------
test('finding 9: the inbox\'s offers to answer and agreed work to deliver carry terms_hash and the service\'s description and deliverable, cut; mode off keeps v15\'s keys', async () => {
  const w = world(), {pilot, person} = w, me = person('newbie'), exact = person('sandbox-exact'), buyer = person('buyer');
  const long = 'Count the words. '.repeat(40), longDeliverable = 'plain text: '.repeat(30);
  const offer = deal(w, exact, me, 'open', {by: exact, title: 'Welcome job: text-stats', description: 'Compute the text-stats.', deliverable: 'the exact text-stats result as JSON'});
  const job = deal(w, buyer, me, 'agreed', {by: buyer, description: long, deliverable: longDeliverable});
  const mine = deal(w, me, buyer, 'open', {by: me});
  const box = pilot.inbox(me);
  const brief = ['deal_id', 'status', 'counterparty', 'your_role', 'title', 'price', 'version', 'offer_expires_at', 'deliver_by'];
  assert.deepEqual(box.respond.map(i => i.deal_id), [offer.id]);
  assert.deepEqual(Object.keys(box.respond[0]), [...brief, 'terms_hash', 'description', 'deliverable']);
  assert.deepEqual([box.respond[0].terms_hash, box.respond[0].description, box.respond[0].deliverable],
    [offer.versions[0].terms_hash, 'Compute the text-stats.', 'the exact text-stats result as JSON']);
  assert.deepEqual(box.deliver.map(i => i.deal_id), [job.id]);
  const item = box.deliver[0];
  assert.deepEqual(Object.keys(item), [...brief, 'terms_hash', 'description', 'deliverable', 'truncated']);
  assert.equal(item.terms_hash, job.agreement.terms_hash, 'the agreed terms\' hash');
  assert.equal(item.description.length, INBOX_TEXT_CHARS.description);
  assert.equal(item.description, `${long.slice(0, INBOX_TEXT_CHARS.description - 1)}…`);
  assert.equal(item.deliverable, `${longDeliverable.slice(0, INBOX_TEXT_CHARS.deliverable - 1)}…`);
  assert.equal(item.truncated, true);
  assert.deepEqual(INBOX_TEXT_CHARS, {description: 400, deliverable: 200});
  // An offer of my own waits on the other side, as before, with nothing added.
  assert.deepEqual(box.waiting_on_others.map(i => [i.deal_id, Object.keys(i).join()]), [[mine.id, brief.join()]]);
  // Never through a surrogate pair.
  const emoji = deal(w, buyer, me, 'agreed', {by: buyer, description: `${'x'.repeat(INBOX_TEXT_CHARS.description - 2)}\u{1F600}tail`});
  assert.equal(pilot.inbox(me).deliver.find(i => i.deal_id === emoji.id).description, `${'x'.repeat(INBOX_TEXT_CHARS.description - 2)}…`);
  const off = world({mode: 'off'}), a = off.person('newbie'), b = off.person('sandbox-exact');
  deal(off, b, a, 'open', {by: b});
  assert.deepEqual(Object.keys(off.pilot.inbox(a).respond[0]), brief, 'I-DARK: v15\'s keys in mode off');
});

// ---------- finding 5: self_serve and open_network beside sandbox_only ----------
test('finding 5: a self-serve join answers self_serve: true and open_network beside sandbox_only, and the public record carries them', async () => {
  for (const openNetwork of [true, false]) {
    const w = world({openNetwork}), {pilot, person} = w, exact = person('sandbox-exact');
    pilot.sandboxIds = new Set([exact.id]);
    const j = await pilot.joinSandbox({handle: `nc-${openNetwork ? 'open' : 'boxed'}`, operator: 'Ada'});
    assert.deepEqual([j.self_serve, j.open_network, j.sandbox_only, typeof j.sandbox_expires_at], [true, openNetwork, true, 'string'], `open network ${openNetwork}`);
    assert.deepEqual(j.counterparties, openNetwork ? 'any' : [exact.id]);
    const rec = pilot.publicParticipant(pilot.s.participants[j.participant_id]);
    const keys = Object.keys(rec);
    assert.deepEqual(keys.slice(keys.indexOf('self_serve'), keys.indexOf('self_serve') + 4), ['self_serve', 'open_network', 'sandbox_only', 'sandbox_expires_at']);
    assert.deepEqual([rec.self_serve, rec.open_network, rec.sandbox_only], [true, openNetwork, true]);
    assert.ok(!('self_serve' in pilot.publicParticipant(exact)), 'an invited or server-run participant has none of them');
  }
});

// ---------- finding 6: the directory's order ----------
test('finding 6: GET /participants lists the agents the server runs first, then the house agents, then the rest in join order (?all=1 too)', async () => {
  const w = world({onChain: false}), {pilot, person} = w;
  // Joined in this order, so the insertion order the directory used to follow puts them last.
  person('ann'); person('basis-bob', {unlisted: true});
  const scribe = person('house-scribe'), exact = person('sandbox-exact'),
    mallory = (person('carl'), person('sandbox-mallory')), reviewer = person('house-reviewer');
  pilot.sandboxIds = new Set([exact.id, mallory.id]);
  pilot.serverSigner = {has: id => id === exact.id || id === mallory.id};
  pilot.houseIds = new Set([scribe.id, reviewer.id]);
  const srv = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'), pilotRoutes: createPilotRoutes({pilot, cfg: {}})}));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const get = async q => (await (await fetch(`http://127.0.0.1:${srv.address().port}/pilot/v1/participants${q}`)).json()).map(x => x.handle);
    assert.deepEqual(await get(''), ['sandbox-exact', 'sandbox-mallory', 'house-scribe', 'house-reviewer', 'ann', 'carl']);
    assert.deepEqual(await get('?all=1'), ['sandbox-exact', 'sandbox-mallory', 'house-scribe', 'house-reviewer', 'ann', 'basis-bob', 'carl']);
    assert.deepEqual(Object.values(pilot.s.participants).map(x => x.handle), ['ann', 'basis-bob', 'house-scribe', 'sandbox-exact', 'carl', 'sandbox-mallory', 'house-reviewer'],
      'the state keeps its order: only the answer is sorted');
  } finally { await new Promise(r => srv.close(r)); }
});

// ---------- the docs half: skill.md (public/skill-testnet.md), /start and llms.txt ----------
const pub = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
const SKILL = pub('skill-testnet.md'), START = pub('start.html'), flat = s => s.replace(/\s+/g, ' ');
// The runnable lines of the fenced block that follows `heading` in skill.md.
const blockAfter = heading => {
  const at = SKILL.indexOf(heading);
  assert.ok(at >= 0, heading);
  return /```\n([\s\S]*?)\n```/.exec(SKILL.slice(at))[1].split('\n');
};
const LEDGER = 'curl -s https://valun.tech/pilot/v1/ledger';
// The words of the quickstart, and of section 2's "Try both sides" (its paragraph, its block and the paragraph after).
const quickWords = () => flat(SKILL.slice(SKILL.indexOf('## Quickstart'), SKILL.indexOf('## 0. Ask your human first')));
const bothWords = () => flat(SKILL.slice(SKILL.indexOf('**Try both sides.**'), SKILL.indexOf('## 3. Find agents')));
// valun 0.7.1's required arguments (its schemas.py), for the tools the docs run with `valun call`.
const REQUIRED_071 = {valun_status: [], valun_inbox: [], valun_deal: ['deal_id'], valun_propose: ['counterparty', 'role', 'title', 'description', 'deliverable', 'price'],
  valun_respond: ['deal_id', 'action'], valun_deliver: ['deal_id'], valun_review_delivery: ['deal_id', 'decision']};
const toolOf = line => {
  const m = /valun(?: --profile \S+)? call (\S+)(?: '(.*)')?$/.exec(line);
  assert.ok(m, line);
  const args = m[2] === undefined ? {} : JSON.parse(m[2]);
  for (const k of REQUIRED_071[m[1]] ?? ['an unknown tool']) assert.ok(k in args, `${m[1]} needs ${k}: ${line}`);
  return [m[1], args];
};

test('findings 1 and 13: skill.md opens with a quickstart whose first command is within its first 40 lines (join, status, inbox, an offer to sandbox-exact, respond, deliver, review, the ledger), then why it matters; section 0 asks as before; /start points to it and does not grow', () => {
  const lines = SKILL.split('\n'), first = lines.findIndex(l => /^(uvx|curl|hermes|claude) /.test(l)) + 1;
  assert.ok(first > 0 && first <= 40, `the first runnable command is on line ${first}`);
  assert.ok(SKILL.indexOf('## Quickstart') < SKILL.indexOf('## 0. Ask your human first'));
  const q = blockAfter('## Quickstart'), ledger = q.indexOf(LEDGER);
  assert.match(q[0], /^uvx --from valun==0\.7\.2 valun join --sandbox --handle YOUR-HANDLE --operator "YOUR HUMAN" .* --owner-token-file "\$HOME\/valun-owner-token-YOUR-HANDLE\.txt" --approvals console$/);
  const calls = q.slice(1, ledger).map(toolOf);
  assert.deepEqual(calls.map(c => c[0]), ['valun_status', 'valun_inbox', 'valun_propose', 'valun_respond', 'valun_deliver', 'valun_review_delivery']);
  assert.deepEqual(calls[2][1], {counterparty: 'sandbox-exact', role: 'payer', title: 'text-stats', description: 'The text-stats of the text below.\nTEXT: Hello Valun, hello world.',
    deliverable: 'the exact text-stats result as JSON', price: 3_000_000}, 'a job sandbox-exact takes as it is (run with 0.7.1 on a local testnet copy)');
  assert.deepEqual([calls[3][1].action, calls[4][1].exact_result, calls[5][1].decision], ['accept', true, 'accept']);
  assert.ok(ledger > 0, 'then the ledger');
  const quick = quickWords();
  for (const s of ['Write `--approvals none` instead only if your human said you may act alone.', 'With console, your offer, your acceptance and your IOU each wait for your human first.',
    '**Why it matters.** The work and the IOUs go on a public record', 'Valun grants no credit itself. A newcomer\'s IOU has nothing behind it until another agent backs it (section 6) or you post a reserve (section 7).'])
    assert.ok(quick.includes(s), s);
  // Section 0's approval question stays as it was (decision 1 waits on the owner: fix inbox #164).
  assert.ok(flat(SKILL).includes('2. **Approvals**: console approvals are the first tester\'s default: you sign, and your offers, acceptances, guarantee offers and the IOU at each delivery wait for your human in the owner console (`console`; what they approve: below). Or may you act on your own within the limits above (approvals `none`), or do they want to approve in your app\'s own approval prompt (`ask`)? If your app can\'t show approval prompts (run headless, such as `claude -p`), your human should choose console, not ask.'));
  assert.ok(flat(START).includes('skill.md opens with a quickstart, from the join to a first IOU; its section 2 has one agent of yours hire another.'));
  // /start is not to grow while it waits to be slimmed (139,770 bytes on Nov 18).
  assert.ok(Buffer.byteLength(START) <= 139_770, `${Buffer.byteLength(START)} bytes`);
});

test('finding 8: section 2\'s "Try both sides": two profiles, each with its own handle and token file; the buyer hires the seller; the placeholders are refused as they are', async () => {
  const {PLACEHOLDER_HANDLES} = await import('../lib/pilot/core.mjs');
  const section = SKILL.slice(SKILL.indexOf('## 2. See it work'), SKILL.indexOf('## 3. Find agents'));
  assert.ok(section.includes('**Try both sides.**'));
  const r = blockAfter('**Try both sides.**'), ledger = r.indexOf(LEDGER);
  assert.match(r[0], /^uvx --from valun==0\.7\.2 valun --profile buyer join --sandbox --handle BUYER-HANDLE .*--owner-token-file "\$HOME\/valun-owner-token-BUYER-HANDLE\.txt" --approvals none$/);
  assert.match(r[1], /^uvx --from valun==0\.7\.2 valun --profile seller join --sandbox --handle SELLER-HANDLE .*--owner-token-file "\$HOME\/valun-owner-token-SELLER-HANDLE\.txt" --approvals none$/);
  const steps = r.slice(2, ledger).map(l => [/--profile (\S+)/.exec(l)[1], ...toolOf(l)]);
  assert.deepEqual(steps.map(s => `${s[0]} ${s[1]}`), ['buyer valun_propose', 'seller valun_inbox', 'seller valun_respond', 'seller valun_deliver', 'buyer valun_deal', 'buyer valun_review_delivery']);
  assert.deepEqual([steps[0][2].counterparty, steps[0][2].role, steps[0][2].price], ['SELLER-HANDLE', 'payer', 2_000_000]);
  assert.ok(ledger > 0, 'then the ledger');
  for (const h of ['BUYER-HANDLE', 'SELLER-HANDLE']) assert.equal(PLACEHOLDER_HANDLES.get(h.toLowerCase().replace(/[^a-z0-9]/g, '')), h, `${h} is refused at join`);
  const words = flat(section);
  for (const s of ['with console approvals each side\'s offers, acceptances and IOUs wait for an owner', 'the two show as a closed circle (`circle.closed`'])
    assert.ok(words.includes(s), s);
});

// The replay of Nov 18 on staging with valun 0.7.1: its review answer is its own text (2 of 4 parts of an ending), the
// seller is shown nothing, and the server's plain ending (labels.summary, which 0.7.1's valun_deal passes on) came only
// from a valun_deal that neither recipe ran after accepting. valun 0.7.2's valun_deal at note_issued opens with
// `summary`, the server's own when the deal view carries one (labels.summary), for both sides (its CHANGELOG, finding 12).
test('the plain ending with valun 0.7.2: the quickstart and "Try both sides" end with a valun_deal on each side, after the review and the ledger, and say it opens with that summary, which the server gives the payee and the payer of an issued IOU', async () => {
  // The quickstart: you answer and deliver the welcome job (its payee) and review your own offer's work (its payer);
  // then one valun_deal on each deal.
  const q = blockAfter('## Quickstart'), qLedger = q.indexOf(LEDGER), quick = q.slice(1, qLedger).map(toolOf);
  const idOf = tool => quick.find(c => c[0] === tool)[1].deal_id;
  assert.equal(idOf('valun_respond'), idOf('valun_deliver'), 'the welcome job: answered and delivered');
  assert.notEqual(idOf('valun_review_delivery'), idOf('valun_deliver'), 'your own offer is another deal');
  assert.deepEqual(q.slice(qLedger + 1).map(toolOf), [['valun_deal', {deal_id: idOf('valun_deliver')}], ['valun_deal', {deal_id: idOf('valun_review_delivery')}]],
    'the last lines: valun_deal on the deal you were paid for, then on the one you paid for');
  // Try both sides: after the buyer accepts and the ledger, the seller's valun_deal, then the buyer's.
  const r = blockAfter('**Try both sides.**'), rLedger = r.indexOf(LEDGER), side = l => [/--profile (\S+)/.exec(l)[1], ...toolOf(l)];
  assert.equal(side(r[rLedger - 1])[1], 'valun_review_delivery');
  assert.deepEqual(r.slice(rLedger + 1).map(side), [['seller', 'valun_deal', {deal_id: 'DEAL-ID'}], ['buyer', 'valun_deal', {deal_id: 'DEAL-ID'}]]);
  // What they say it is, and where the quickstart sends you next.
  for (const s of ['The last two calls show how each deal ended once it says `note_issued`, for you as its payee and as its payer: `valun_deal` then opens with that plain ending as `summary` (what was issued, the pair\'s row now, whether a tracker box on Ergo testnet commits it yet, how to check it, how it is paid back).',
    'To see one deal from both ends, with two agents of your own: **Try both sides**, in section 2.'])
    assert.ok(quickWords().includes(s), s);
  assert.ok(bothWords().includes('The last two calls give each side its plain ending, written for the seller and for the buyer (`summary`, at the top of `valun_deal`).'));
  // The server gives both sides that paragraph in labels (finding 12 above has its words), with each part the quickstart
  // names: what was issued, the row now, whether a box commits it, how to check it, how it is paid back.
  const w = world(), carl = w.person('carl'), dana = w.person('dana'), d = deal(w, carl, dana, 'note_issued');
  for (const who of [carl, dana]) {
    const s = (await w.pilot.dealView(d, who)).labels.summary;
    for (const part of [/^For this deal (you|carl) issued (dana|you) an IOU/, /on the pair's row \(from carl to dana\) is now /, /tracker box on Ergo testnet commits the pair's current total/,
      /Check it: GET https:\/\/valun\.tech\/pilot\/v1\/ledger, the row/, /How it is paid back or used: /]) assert.match(s, part, who.handle);
  }
  // Before note_issued (an IOU that waits for its owner, say), there is no summary yet: "once it says note_issued".
  const agreed = deal(w, carl, dana, 'agreed');
  for (const who of [carl, dana]) {
    const {labels} = await w.pilot.dealView(agreed, who);
    assert.ok(labels && !('summary' in labels), who.handle);
  }
});

// The two fixes of 0.7.2 its users meet where they act (the replay of Nov 18, findings 4 and 10): 0.7.1 joined and
// printed the owner token on stdout when the token file existed (cli.py _hand_over), where 0.7.2 refuses the file before
// anything is sent (cli.py _token_file_refusal: "Nothing was sent", exit 2); and 0.7.1's valun_deal advised a dispute
// whenever a job's words named text-stats or notary, where 0.7.2 checks a delivery exactly only in a built-in job
// (sandbox.built_in_job: sandbox-exact or sandbox-mallory, a text-stats or notary title, the ```json block), and says
// checked: false for any other.
test('valun 0.7.2, where its users act: the quickstart\'s join is followed by "a new token file for each join", and its review by "checks a delivery exactly only in a built-in job"', async () => {
  const {AGENTS} = await import('../lib/pilot/sandbox.mjs');
  // The quickstart's first paragraph after its block of commands (blockAfter: the join is its first line).
  const open = SKILL.indexOf('\n```\n', SKILL.indexOf('## Quickstart')), close = SKILL.indexOf('\n```\n', open + 4);
  assert.ok(blockAfter('## Quickstart')[0].includes(' join --sandbox '));
  const after = flat(SKILL.slice(close + 5, SKILL.indexOf('**Why it matters.**'))).trim();
  assert.ok(after.startsWith('Write `--approvals none` instead only if your human said you may act alone. Name a token file that doesn\'t exist yet, a new one for each join: if it exists, join says "Nothing was sent" and exits 2, so join again with a new file name.'),
    'the line right after the join');
  const review = 'read the work with `valun_deal`, then accept it, which issues your IOU. ';
  const advice = `valun checks a delivery exactly only in a built-in job (with ${Object.keys(AGENTS).join(' or ')}, or titled text-stats or notary): for any other job it says \`checked_exactly_by_your_client.checked: false\`, and you judge the work yourself.`;
  assert.deepEqual(Object.keys(AGENTS), ['sandbox-exact', 'sandbox-mallory'], 'the practice agents the server runs');
  assert.ok(after.includes(review + advice), 'the line right after the review');
});

test('finding 7, the docs: "After you join" names the welcome job as sandbox-exact makes it, and says leaving it costs nothing', async () => {
  const {WELCOME} = await import('../lib/pilot/sandbox.mjs');
  const join = flat(SKILL.slice(SKILL.indexOf('## 1. Join: pick your setup'), SKILL.indexOf('## 2. See it work')));
  assert.deepEqual([WELCOME.title, WELCOME.price, WELCOME.offer_hours], ['Welcome job: text-stats', 3_000_000, 24]);
  assert.ok(join.includes(`**After you join.** Usually within seconds, sandbox-exact offers you a welcome job: it is in \`valun_inbox\` under \`respond\`, titled "${WELCOME.title}", for 3,000,000 nanoERG (0.003 tERG), with its \`terms_hash\`, description and deliverable.`));
  assert.ok(join.includes('Or leave it: the offer lapses 24 hours after it was made, and leaving it costs nothing. With console approvals, your acceptance waits for your human first.'));
});

test('findings 3 and 5, the docs: one default per mode, console needs someone approving (Hermes runs too), and self_serve explained beside sandbox_only', () => {
  const s = flat(SKILL);
  assert.doesNotMatch(s, /`ask`, the default:|need `--approvals none` or `console`/);
  assert.ok(s.includes('- `ask`, what an invited join uses when it has no `--approvals` (a `--sandbox` join uses console then; write the mode in the join either way):'));
  assert.ok(s.includes('without a terminal it refuses (`approval_unavailable`)'));
  assert.ok(s.includes('It needs a person: until your human signs in there and approves, each of these waits (and ends when its time runs out).'));
  assert.ok(s.includes('With `console` the agent signs, but its offers, acceptances and IOUs then wait until your human approves them at https://valun.tech/pilot#owner, so it needs your human approving there; with `none` nothing waits.'));
  assert.ok(s.includes('This needs the join\'s `--approvals none`, or `console` with your human approving (see Approvals above).'));
  assert.ok(s.includes('Your record says `self_serve: true` (and `sandbox_only: true`, its older name): you joined without an invite and have these limits. On valun.tech it does not limit whom you deal with (`open_network: true`).'));
  assert.ok(pub('llms-testnet.txt').includes('the first tester\'s default, where your agent\'s offers, acceptances and IOUs wait until you approve them in the owner console (console is also what a --sandbox join of valun 0.7.2 uses without --approvals; ask signs nothing from a shell with nobody at the terminal)'));
});
