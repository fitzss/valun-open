// One owner's console with an approval of every kind waiting for it, as the real server makes them (not a test file:
// test/console-cards.test.mjs reads it, and so does the screenshot server for the console's approval cards). A real
// Pilot in circulation mode on, over a stub tracker held in memory, served by the real routes (lib/http.mjs,
// lib/pilot/http.mjs) on a local port: no tracker binary, no chain, nothing leaves this machine.
//
// Set PILOT_NETWORK before importing it (lib/pilot/units.mjs reads it once): the testnet's (valun-testnet-1) shows every
// amount in nanoERG with its tERG.
//
// mira-research is the owner's agent, with console approvals (Ask me above 0, Review deliveries on). Waiting for its
// owner:
//   offer       its offer to hire house-scribe (one of the operator's house agents) for a summary, 2,000,000;
//   counter     its counter-offer at 4,000,000 to dave-docs's offer of a job at 3,000,000 (mira-research does the work);
//   accept      its acceptance of sandbox-exact's welcome job, 3,000,000 (taking a job: sandbox-exact pays);
//   confirm     (with `confirm: true`) its earlier offer to carol-research, accepted after its owner lowered Ask me above;
//   iou         the bound IOU it signed for house-scribe's delivered summary, 2,000,000, held for review;
//   transfer    its payment of dave-docs's delivered job, 1,000,000, with carol-research's IOU (carol-research owes it
//               3,000,000), held for review;
//   guarantee   its offer to back carol-research's IOUs to sandbox-exact, up to 2,000,000.
//   lab, labx   (with `lab: true`) its acceptances of a job from lab-first-mile-desk, one of the operator's lab agents
//               (this server's configuration names it: operatorTestIds), and of one from lab-probe-7, a stranger whose
//               handle only looks like one: 1,000,000 each.
// `clock`: the server's clock ({t}; real time by default), so a test can move it past a deadline. `heldAgo`: how long
// ago the IOU and the payment by transfer were signed (ms). `answeredH`: for how many hours dave-docs's offer, the one
// the counter-offer answers, is open (20: it expires after the counter-offer, valid 12 hours; 6: before it, so it is the
// counter-offer's deadline, Pilot.approvalDecideBy).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import('../lib/pilot/core.mjs');
const {createPilotRoutes} = await import('../lib/pilot/http.mjs');
const {createHandler} = await import('../lib/http.mjs');
const {appendEntries} = await import('../lib/pilot/journal.mjs');
const {pc, NETWORK, UNIT} = await import('../lib/pilot/units.mjs');
const {GUARANTEE_PROTOCOL, COVERS} = await import('../lib/pilot/guarantees.mjs');

const hex = n => crypto.randomBytes(n).toString('hex'), sha = s => crypto.createHash('sha256').update(s).digest('hex'), iso = t => new Date(t).toISOString();
const sig = () => '02' + hex(64), MIN = 60e3, HOUR = 3600e3, DAY = 24 * HOUR, NFT = 'dc'.repeat(32), PIN = 'cd'.repeat(32);
const ending = (t, ms) => t - (t % 1000) - 1000 + ms;
// Tracker v4 with anchored netting: the testnet's tracker contract (as test/console-testnet.test.mjs).
const CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', commit: 'x', pure_credit: false, reserved_ms: [995, 996, 997, 998, 999],
  bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to',
    'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'}, setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 7, novations_disabled_reason: null,
  anchored_netting: {version: 1, authorization_floor: true, fresh_blocks: 1440, keepalive_blocks: 720, observation_max_age_ms: 7200000}};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};

export async function approvalsWorld({clock = {t: Date.now()}, heldAgo = 3 * MIN, confirm = false, lab = false, answeredH = 20, ownerToken = `vpo_${hex(16)}`} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-approvals-'));
  const notes = new Map(), now = () => clock.t, t0 = clock.t;
  const basis = {nft: NFT, denomination: 'erg', note: async (i, r) => notes.get(`${i}>${r}`) ?? null, allNotes: async () => [...notes.values()],
    capabilities: async () => CAPS, refresh: async () => CAPS, verify: async () => true, reserves: async () => [],
    noteMessage: async () => ({message_hex: '00'.repeat(80)}), priorAckMessage: async () => ({message_hex: '00'.repeat(80)})};
  const pilot = new core.Pilot({store: new core.PilotStore(dir), basis, now, circulation: 'on', openNetwork: true, trackerCaps: CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  const person = (handle, operator, m = {}, extra = {}) => {
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator, about: '', services: '', wants: '', pubkey: '02' + hex(32), status: 'active',
      created_at: iso(t0 - 2 * DAY), owner_token_hash: sha('vpo_' + hex(16)), agent_token_hash: sha('vpa_' + hex(16)), enrollment: null,
      mandate: {...core.DEFAULT_MANDATE, expires_at: iso(t0 + 7 * DAY), ...POLICY, approve_above: pc(25), ...m}, mandate_version: 1, past_pubkeys: [],
      last_seen_agent: iso(t0 - MIN), last_seen_owner: null, key_registered_at: iso(t0 - 2 * DAY), ...extra};
    pilot.s.participants[p.id] = p;
    return p;
  };
  // The owner's agent: a self-serve agent (the sandbox box: 5,000,000 a deal, 40,000,000 owed) with console approvals.
  const mira = person('mira-research', 'Mira Okafor', {max_issue_per_deal: pc(5), max_issue_outstanding: pc(40), max_accept_per_deal: pc(5), max_accept_per_issuer: pc(40),
    approve_above: 0, review_deliveries: true}, {owner_token_hash: sha(ownerToken), display_name: 'Mira', sandbox_only: true, sandbox_expires_at: iso(t0 + 7 * DAY)});
  const scribe = person('house-scribe', 'Valun operator (house agent)'), exact = person('sandbox-exact', 'Valun operator (practice agent)');
  const carol = person('carol-research', 'Carol Diaz'), dave = person('dave-docs', 'Dave Lin');
  pilot.houseIds = new Set([scribe.id]);
  pilot.serverSigner = {has: id => id === exact.id, signFor: async () => sig()};
  pilot.chain = {name: 'ergo-testnet', on_chain: true, tracker_nft_id: NFT, explorer: 'https://testnet.ergoplatform.com'};
  // carol-research owes mira-research 3,000,000 (an earlier job), on the tracker and in Valun's journal.
  let ts = Math.floor((t0 - 2 * HOUR) / 1000) * 1000 + 123;
  const owe = (I, R, total) => {
    const n = {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(total), amount_redeemed: '0', timestamp: (ts += 7000), signature: sig(),
      denomination: 'erg', confirmation: {status: 'confirmed'}};
    notes.set(`${I.pubkey}>${R.pubkey}`, n);
    appendEntries(pilot, [{kind: 'issue', ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta: total, total_after: total, timestamp: n.timestamp, signature: n.signature}]);
    return n;
  };
  const carolNote = owe(carol, mira, pc(3));
  pilot.save();
  const terms = (P, payer, payee, price, title, description, {validH = 24, deliverH = 48, version = 1, prior = null, id = 'vd_' + hex(8)} = {}) => ({protocol: core.PROTOCOL,
    network: NETWORK, tracker_nft_id: NFT, denomination: 'erg', deal_id: id, version, prior_terms_hash: prior, nonce: hex(16), proposer: P.id,
    payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: {title, description, deliverable: 'markdown'},
    price: {amount: price, unit: UNIT}, consideration: 'credit_note_on_delivery_accepted', offer_expires_at: iso(clock.t + validH * HOUR), deliver_by: iso(clock.t + deliverH * HOUR)});
  const ago = ms => { clock.t = t0 - ms; };
  const ids = {};
  // An offer, as the agent's join makes it wait (approve_above 0): mira-research hires house-scribe.
  ago(2 * MIN);
  ids.offer = (await pilot.propose(mira, {signature: sig(), terms: terms(mira, mira, scribe, pc(2), 'Summary of the Basis tracker paper',
    'Summarize the text below in 5 bullet points.', {validH: 24, deliverH: 48})})).id;
  // A counter-offer: dave-docs offered a job at 3,000,000; mira-research answers with 4,000,000.
  ago(30 * MIN);
  const daveOffer = await pilot.propose(dave, {signature: sig(), terms: terms(dave, dave, mira, pc(3), 'Edit the onboarding guide', 'Tighten the guide in the text below; keep every command.',
    {validH: answeredH, deliverH: 30})});
  ago(5 * MIN);
  const cur = pilot.s.deals[daveOffer.id].versions[0];
  await pilot.counter(mira, daveOffer.id, {signature: sig(), terms: terms(mira, dave, mira, pc(4), 'Edit the onboarding guide', 'Tighten the guide in the text below; keep every command.',
    {validH: 12, deliverH: 30, version: 2, prior: cur.terms_hash, id: daveOffer.id})});
  ids.counter = daveOffer.id;
  // Taking a job: sandbox-exact's welcome job, accepted by mira-research's agent; the acceptance waits for its owner.
  ago(4 * MIN);
  const welcome = await pilot.propose(exact, {signature: sig(), terms: terms(exact, exact, mira, pc(3), 'Welcome job: text stats', 'Count the words and lines of the text below.',
    {validH: 24, deliverH: 48})});
  ago(3 * MIN);
  await pilot.accept(mira, welcome.id, {terms_hash: pilot.s.deals[welcome.id].versions[0].terms_hash, signature: sig()});
  ids.accept = welcome.id;
  if (confirm) {
    // mira-research offered carol-research a job while Ask me above was 5,000,000; its owner lowered it to 0 since, and
    // carol-research accepted: the offer waits for mira-research's owner to confirm it.
    mira.mandate.approve_above = pc(5);
    ago(50 * MIN);
    const old = await pilot.propose(mira, {signature: sig(), terms: terms(mira, mira, carol, pc(1), 'Check three citations', 'Check the citations in the text below.', {validH: 6, deliverH: 24})});
    mira.mandate.approve_above = 0;
    ago(6 * MIN);
    await pilot.accept(carol, old.id, {terms_hash: pilot.s.deals[old.id].versions[0].terms_hash, signature: sig()});
    ids.confirm = old.id;
  }
  if (lab) {
    // Two jobs mira-research's agent took, each acceptance waiting for its owner: one from the operator's lab agent, named
    // by id in this server's configuration (as fly.testnet.toml's PILOT_OPERATOR_TEST_AGENTS), one from a stranger
    // whose handle looks like a lab agent's.
    const labAgent = person('lab-first-mile-desk', 'Valun lab (first-mile desk, test network)'), stranger = person('lab-probe-7', 'Lab probe');
    pilot.operatorTestIds = new Set([labAgent.id]);
    for (const [key, P, title] of [['lab', labAgent, 'First-mile check'], ['labx', stranger, 'A probe job']]) {
      ago(3 * MIN);
      const job = await pilot.propose(P, {signature: sig(), terms: terms(P, P, mira, pc(1), title, 'Check the text below.', {validH: 24, deliverH: 48})});
      ago(2 * MIN);
      await pilot.accept(mira, job.id, {terms_hash: pilot.s.deals[job.id].versions[0].terms_hash, signature: sig()});
      ids[key] = job.id;
    }
  }
  // An agreed deal, delivered (agreed `agreedAgo` ago, delivered `deliveredAgo` ago).
  const delivered = (payer, payee, price, title, content, agreedAgo, deliveredAgo) => {
    const id = 'vd_' + hex(8);
    clock.t = t0 - agreedAgo;
    const tm = terms(payer, payer, payee, price, title, 'Synthetic, for the console.', {id}), h = core.termsHash(tm);
    const v = {v: 1, by: payer.id, terms: tm, terms_hash: h, signature: sig(), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t), mandate_check: null};
    const d = {id, payer: payer.id, payee: payee.id, created_at: iso(clock.t), status: 'delivered', versions: [v], history: [{at: iso(clock.t), by: payer.id, event: 'proposed', version: 1, terms_hash: h}]};
    d.acceptance = {version: 1, by: payee.id, terms_hash: h, signature: sig(), at: iso(clock.t), mandate_check: null, state: 'final'};
    d.agreement = {version: 1, terms: tm, terms_hash: h, proposer_signature: v.signature, acceptor_signature: d.acceptance.signature, proposer: payer.id, acceptor: payee.id, formed_at: iso(clock.t)};
    d.history.push({at: iso(clock.t), by: payee.id, event: 'accepted', version: 1, terms_hash: h}, {at: iso(clock.t), by: 'valun', event: 'agreed', version: 1, terms_hash: h});
    clock.t = t0 - deliveredAgo;
    d.delivery = {by: payee.id, title, content, sha256: sha(content), bytes: Buffer.byteLength(content), signature: sig(), at: iso(clock.t), late: false};
    d.history.push({at: iso(clock.t), by: payee.id, event: 'delivered', sha256: d.delivery.sha256});
    pilot.s.deals[id] = d;
    return d;
  };
  // The IOU for house-scribe's summary: a bound note, signed `heldAgo` ago, held for review.
  const summary = '- The tracker keeps one running total per pair of keys.\n- Each IOU raises that total.\n- A tracker box on chain commits every total.\n- Redemption pays from the issuer\'s reserve.\n- Set-offs lower every debt in a loop.';
  const dIou = delivered(mira, scribe, pc(2), 'Summary of a Basis note', summary, 2 * HOUR, heldAgo + 2 * MIN);
  clock.t = t0 - heldAgo;
  const T = ending(clock.t - 1500, 997);
  dIou.completion = {by: mira.id, signature: sig(), at: iso(clock.t), deliverable_sha256: dIou.delivery.sha256};
  dIou.credit_note = {state: 'signed', issuer_pubkey: mira.pubkey, recipient_pubkey: scribe.pubkey, keys_as_agreed: true,
    note: {total: pc(2), timestamp: T, signature: sig(), message_hex: '00'.repeat(80), prior_signature: sig()}, prior_total: 0, amount: pc(2), signed_at: iso(clock.t),
    completion: {signature: dIou.completion.signature, deliverable_sha256: dIou.delivery.sha256}};
  dIou.note_prior = {total: 0, timestamp: null, signature: null};
  const aIou = pilot.approval(mira, dIou, 'issue_note', {v: 1, terms_hash: dIou.agreement.terms_hash});
  dIou.credit_note.approval_id = aIou.id; dIou.status = 'completion_awaiting_owner';
  dIou.history.push({at: iso(clock.t), by: mira.id, event: 'delivery_accepted', sha256: dIou.delivery.sha256}, {at: iso(clock.t), by: 'valun', event: 'credit_note_awaiting_owner', amount: pc(2)});
  ids.iou = dIou.id;
  // The payment by transfer: dave-docs's delivered job, paid with 1,000,000 of carol-research's IOU, signed `heldAgo` ago.
  const dPay = delivered(mira, dave, pc(1), 'Proofread the release notes', 'The release notes, proofread: 14 fixes, listed below.', 3 * HOUR, heldAgo + 3 * MIN);
  clock.t = t0 - heldAgo;
  const TT = ending(clock.t - 1500, 999), from = {total: pc(3), timestamp: carolNote.timestamp, signature: carolNote.signature};
  const tr = {id: 'vt_' + hex(8), kind: 'transfer', deal_id: dPay.id, state: 'awaiting_owner', attempt: 1, regenerated_from: null,
    created_at: iso(clock.t), expires_at: iso(clock.t + 20 * MIN), updated_at: iso(clock.t), network: NETWORK, tracker_nft_id: NFT, denomination: 'erg',
    timestamp: TT, amount: pc(1), quote_digest: hex(32), issuer: {id: carol.id, pubkey: carol.pubkey}, payer: {id: mira.id, pubkey: mira.pubkey}, payee: {id: dave.id, pubkey: dave.pubkey},
    from_edge: {edge: `${carol.pubkey}>${mira.pubkey}`, before: from, new_total: from.total - pc(1), revision: 1},
    to_edge: {edge: `${carol.pubkey}>${dave.pubkey}`, before: null, new_total: pc(1), revision: 1},
    slots: Object.fromEntries(['from_recipient_prior', 'from_recipient', 'from_recipient_to'].map(k => [k, {signature: sig(), by: mira.id, at: iso(clock.t)}])),
    messages: {}, completion_signature: sig(), pay_signature: sig(), approval_id: null, result: null, fallback_after: null, history: []};
  (pilot.s.transfers ??= {})[tr.id] = tr;
  dPay.transfer_ids = [tr.id];
  dPay.completion = {by: mira.id, signature: tr.completion_signature, at: iso(clock.t), deliverable_sha256: dPay.delivery.sha256};
  dPay.payment = {method: 'transfer', transfer_id: tr.id};
  const aPay = pilot.approval(mira, dPay, 'pay_by_transfer', {v: 1, terms_hash: dPay.agreement.terms_hash});
  tr.approval_id = aPay.id; dPay.status = 'completion_awaiting_owner';
  dPay.history.push({at: iso(clock.t), by: mira.id, event: 'delivery_accepted', sha256: dPay.delivery.sha256},
    {at: iso(clock.t), by: mira.id, event: 'payment_by_transfer', transfer_id: tr.id, issuer: carol.id, amount: pc(1)}, {at: iso(clock.t), by: 'valun', event: 'payment_awaiting_owner', transfer_id: tr.id});
  ids.transfer = dPay.id;
  // A guarantee offer: mira-research backs carol-research's IOUs to sandbox-exact, up to 2,000,000.
  ago(MIN);
  const gid = 'vg_' + hex(8);
  await pilot.guarantees.offer(mira, {signature: sig(), terms: {protocol: GUARANTEE_PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: 'erg', guarantee_id: gid, nonce: hex(16),
    backer: {id: mira.id, pubkey: mira.pubkey}, issuer: {id: carol.id, pubkey: carol.pubkey}, creditor: {id: exact.id, pubkey: exact.pubkey}, cap: {amount: pc(2), unit: UNIT},
    covers: COVERS, due_at: iso(clock.t + 2 * DAY), expires_at: iso(clock.t + 5 * DAY), honor_within_hours: 24, offer_expires_at: iso(clock.t + 2 * DAY), note: ''}});
  ids.guarantee = gid;
  clock.t = t0;
  pilot.save();
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: path.join(root, 'public'),
    pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const approvalOf = (key, kind = null) => Object.values(pilot.s.approvals).find(a => (key === 'guarantee' ? a.guarantee_id === ids.guarantee : a.deal_id === ids[key]) && (!kind || a.kind === kind));
  return {pilot, clock, notes, dir, server, base: `http://127.0.0.1:${server.address().port}`, ownerToken, ids, approvalOf, mira, scribe, exact, carol, dave,
    close: () => { server.close(); fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
}
