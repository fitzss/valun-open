// The budget card (lib/pilot/card.mjs) at the unit level, over a stub tracker (no tracker binary):
//   - the owner's opt-in (mandate public_card: a boolean, false removes it; GET /me and GET /owner show it; a self-serve
//     sandbox owner may set it), and 404 card_not_public before it;
//   - the card's shape and values: the mandate the server enforces (effectiveLimits), the room as checkMandate counts it,
//     the backing (public under fix inbox #31 named, the rest in the totals only), the record, the URLs; no _PC key;
//   - card_hash, and its change when the mandate version changes;
//   - the check's verdicts (accept, ask_owner, decline for per-deal, outstanding and expiry), each the answer the server
//     gives the payer's agent when it proposes the same deal; the check is a dry run; its errors;
//   - the cover, with backers named only when public;
//   - the agent page's section and description, escaped; GET /me room.
// Run: node --test test/budget-card.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE, PRICE_CAP, SANDBOX_CAPS, PROTOCOL, canonical, sha256} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {createHandler} from '../lib/http.mjs';
import {agentView, agentDescription, renderAgentPage} from '../lib/pilot/agents.mjs';
import {budgetCard, checkPayer, findPayee, parseAmount, CARD_VERSION} from '../lib/pilot/card.mjs';
import {NETWORK} from '../lib/pilot/units.mjs';

const dirs = [], servers = [];
after(() => { for (const s of servers) s.close(); for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 864e5, HOUR = 3600e3, PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};
// Every key in a value, at any depth.
const keysDeep = v => (Array.isArray(v) ? v.flatMap(keysDeep) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]) : []);

// A Pilot over a stub tracker whose signatures all verify. person() adds an active participant (per deal 5, 40 in all,
// approve_above 1000, a mandate for 7 days unless given), with an owner and an agent token; owe(I, R, total) puts I->R
// at `total` on the tracker; deal() adds a deal as stored state; guarantee() an accepted guarantee; propose() is the
// payer's agent proposing a deal, as the server takes it.
function world({mode = 'on'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-card-')); dirs.push(dir);
  const notes = new Map(), clock = {t: Date.now()}, tokens = new Map();
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async (i, r) => notes.get(`${i}>${r}`) ?? null, allNotes: async () => [...notes.values()],
    capabilities: async () => V3_CAPS, verify: async () => true};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], log: () => {}});
  assert.equal(pilot.mode, mode);
  pilot.serverSigner = {has: () => false, signFor: async () => { throw new Error('no signing in this test'); }};
  const circ = mode === 'on' || mode === 'sandbox';
  const person = (handle, mandate = {}, extra = {}) => {
    const owner = 'vpo_' + hex(16), agent = 'vpa_' + hex(16);
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: 'test operator', about: '', services: '', pubkey: '02' + hex(32), status: 'active', created_at: iso(clock.t),
      owner_token_hash: sha(owner), agent_token_hash: sha(agent), enrollment: null,
      mandate: {...DEFAULT_MANDATE, max_issue_per_deal: 5, max_issue_outstanding: 40, approve_above: 1000, expires_at: iso(clock.t + 7 * DAY), ...(circ ? POLICY : {}), ...mandate},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null, ...extra};
    pilot.s.participants[p.id] = p; tokens.set(p.id, {owner, agent});
    return p;
  };
  let ts = 1_000_000;
  const owe = (I, R, total) => notes.set(`${I.pubkey}>${R.pubkey}`, {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(total), amount_redeemed: '0',
    timestamp: (ts += 1000), signature: '02' + hex(64), denomination: PILOT_DENOMINATION});
  const deal = (payer, payee, status, price, {by = payer} = {}) => {
    const id = 'vd_' + hex(8);
    const terms = {deal_id: id, version: 1, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: {title: 'job', description: 'synthetic', deliverable: 'text'},
      price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
    const agreed = !['open', 'proposed_awaiting_owner'].includes(status);
    const v = {v: 1, by: by.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: agreed ? 'accepted' : 'open', offered_at: iso(clock.t)};
    pilot.s.deals[id] = {id, payer: payer.id, payee: payee.id, created_at: iso(clock.t), status, versions: [v], history: [],
      ...(agreed ? {agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)}} : {})};
    return pilot.s.deals[id];
  };
  const guarantee = (B, I, C, cap, {state = 'active', expiresAt = clock.t + 3 * DAY, calls = [], covers = 'issuer_debt_to_creditor', deals = null, acceptedAt = clock.t} = {}) => {
    const id = 'vg_' + hex(8);
    const terms = {protocol: 'valun-guarantee/1', network: NETWORK, tracker_nft_id: basis.nft, denomination: PILOT_DENOMINATION, guarantee_id: id, nonce: hex(16),
      backer: {id: B.id, pubkey: B.pubkey}, issuer: {id: I.id, pubkey: I.pubkey}, creditor: {id: C.id, pubkey: C.pubkey}, cap: {amount: cap, unit: 'PC'}, covers,
      ...(deals ? {deals} : {}), due_at: iso(clock.t - HOUR), expires_at: iso(expiresAt), honor_within_hours: 24, offer_expires_at: iso(clock.t + HOUR), note: ''};
    (pilot.s.guarantees ||= {})[id] = {id, terms, terms_hash: hex(32), backer: B.id, issuer: I.id, creditor: C.id, state,
      offer: {by: B.id, at: iso(acceptedAt), signature: '02' + hex(64), offered_at: iso(acceptedAt)}, acceptance: {by: C.id, at: iso(acceptedAt), signature: '02' + hex(64)},
      calls, history: [], created_at: iso(acceptedAt), updated_at: iso(acceptedAt)};
    return pilot.s.guarantees[id];
  };
  const honoredCall = amount => ({id: 'vgc_' + hex(8), amount, signature: '02' + hex(64), called_at: iso(clock.t), honor_by: iso(clock.t + DAY), state: 'honored',
    owed_at_call: amount, claimed_before: 0, honored_at: iso(clock.t), late: false});
  const propose = (payer, payee, price) => {
    const deal_id = 'vd_' + hex(8);
    const terms = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: basis.nft, denomination: PILOT_DENOMINATION, deal_id, version: 1, prior_terms_hash: null, nonce: hex(16),
      proposer: payer.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey},
      service: {title: 'a job', description: 'synthetic', deliverable: 'text'}, price: {amount: price, unit: 'PC'}, consideration: 'credit_note_on_delivery_accepted',
      offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
    return pilot.propose(payer, {terms, signature: '02' + hex(64)});
  };
  return {pilot, dir, clock, tokens, person, owe, deal, guarantee, honoredCall, propose};
}

// The routes over real HTTP (lib/http.mjs, as the hosted server): call(method, path, {token, body}) -> {status, body, text}.
async function serve(pilot) {
  const server = http.createServer(createHandler({service: {}, mcp: {}, cfg: {}, publicDir: 'public',
    pilotRoutes: createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e6, pilotReadLimitPerMinute: 1e6}})}));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (method, p, {token, body} = {}) => {
    const r = await fetch(base + p, {method, headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...(body ? {'content-type': 'application/json'} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await r.text();
    return {status: r.status, text, body: /json/.test(r.headers.get('content-type') || '') ? JSON.parse(text) : null};
  };
}

// The world most tests share: amy pays; bob and eve are her creditors; cy and dan back her IOUs.
//   amy's exposure as payer: 4 on the tracker (to bob) + 3 agreed (to bob) + 2 of her own open offer (to eve) + 6 she
//   backs (cy's IOUs to eve, her open cap) = 15 of 40: 25 left. bob's open offer to amy is not hers: it counts nothing.
//   Backing her IOUs: cy for bob (cap 3, public: amy and cy chose public vouches), dan for bob (cap 2, 1 claimed by an
//   honored call: 1 left; dan did not choose public vouches), cy for eve (cap 4, public); dan's expired guarantee for
//   bob, and one whose time ran out (swept to expired), count nothing. 3 active, 2 creditors, caps 9, 8 left.
//   Her record: 1 deal paid (her note to bob), 1 disputed, holds 2 (cy's note), owes 4.
function shared(opts) {
  const w = world(opts), {person, owe, deal, guarantee, honoredCall} = w;
  const amy = person('amy-payer', {}, {public_vouches: true}), bob = person('bob-creditor'), eve = person('eve-creditor');
  const cy = person('cy-backer', {}, {public_vouches: true}), dan = person('dan-backer');
  owe(amy, bob, 4); owe(cy, amy, 2);
  deal(amy, bob, 'note_issued', 4); deal(amy, bob, 'disputed', 1);
  deal(amy, bob, 'agreed', 3); deal(amy, eve, 'open', 2); deal(amy, bob, 'open', 5, {by: bob});
  guarantee(amy, cy, eve, 6);
  const g1 = guarantee(cy, amy, bob, 3, {acceptedAt: w.clock.t - 3000});
  const g2 = guarantee(dan, amy, bob, 2, {calls: [honoredCall(1)], acceptedAt: w.clock.t - 2000});
  const g3 = guarantee(cy, amy, eve, 4, {acceptedAt: w.clock.t - 1000});
  guarantee(dan, amy, bob, 5, {state: 'expired'}); guarantee(dan, amy, bob, 5, {expiresAt: w.clock.t - 1000});
  return {...w, amy, bob, eve, cy, dan, g1, g2, g3};
}

test('the owner publishes the card (mandate public_card): a boolean, false removes it, /me and /owner show it; before it, and after, both routes are 404 card_not_public', async () => {
  const w = world(), {pilot, tokens} = w, amy = w.person('amy-payer'), bob = w.person('bob-creditor');
  const call = await serve(pilot), owner = tokens.get(amy.id).owner, agent = tokens.get(amy.id).agent;
  const notPublic = r => {
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {error: 'card_not_public', message: "this agent's owner has not published its budget card"});
  };
  notPublic(await call('GET', `/pilot/v1/participants/${amy.id}/card`));
  notPublic(await call('GET', `/pilot/v1/participants/${amy.id}/check?amount=3&payee=${bob.handle}`));
  assert.equal((await call('GET', '/pilot/v1/participants/vp_000000000000/card')).body.error, 'not_found', 'an unknown id is not_found');
  for (const tok of [agent, owner]) {
    const r = await call('GET', tok === agent ? '/pilot/v1/me' : '/pilot/v1/owner', {token: tok});
    assert.equal(r.body.public_card, false);
    assert.equal('public_card' in r.body.mandate, false);
  }
  for (const bad of ['yes', 1, null]) {
    const r = await call('PUT', '/pilot/v1/owner/mandate', {token: owner, body: {public_card: bad}});
    assert.equal(r.status, 400, String(bad));
    assert.deepEqual([r.body.error, r.body.message], ['invalid_field', 'public_card must be true or false']);
  }
  let r = await call('PUT', '/pilot/v1/owner/mandate', {token: owner, body: {public_card: true}});
  assert.deepEqual([r.status, r.body.changed, r.body.mandate.public_card, r.body.mandate_version], [200, true, true, 2]);
  assert.equal((await call('PUT', '/pilot/v1/owner/mandate', {token: owner, body: {public_card: true}})).body.changed, false, 'the same value changes nothing');
  for (const tok of [agent, owner]) {
    const me = (await call('GET', tok === agent ? '/pilot/v1/me' : '/pilot/v1/owner', {token: tok})).body;
    assert.deepEqual([me.public_card, me.mandate.public_card], [true, true]);
  }
  assert.equal((await call('GET', `/pilot/v1/participants/${amy.id}/card`)).status, 200);
  assert.equal((await call('GET', `/pilot/v1/participants/${amy.id}/check?amount=3&payee=${bob.handle}`)).status, 200);
  r = await call('PUT', '/pilot/v1/owner/mandate', {token: owner, body: {public_card: false}});
  assert.deepEqual([r.body.changed, 'public_card' in r.body.mandate, 'public_card' in amy.mandate], [true, false, false], 'false removes the key');
  notPublic(await call('GET', `/pilot/v1/participants/${amy.id}/card`));
  notPublic(await call('GET', `/pilot/v1/participants/${amy.id}/check?amount=3&payee=${bob.handle}`));
  // The agent token cannot publish it: the mandate is the owner's.
  assert.equal((await call('PUT', '/pilot/v1/owner/mandate', {token: agent, body: {public_card: true}})).status, 404);
});

test('a self-serve sandbox owner may publish the card too: it is not a limit, so the box\'s lower-but-never-raise rule does not apply', () => {
  const w = world(), {pilot} = w, sbx = w.person('sbx-agent');
  pilot.sandboxIds = new Set([sbx.id]);
  const until = iso(w.clock.t + 7 * DAY);
  const p = w.person('self-serve', {...SANDBOX_CAPS, counterparties: [sbx.id], accept_notes_from: [sbx.id], approve_above: 1000, expires_at: until}, {sandbox_only: true, sandbox_expires_at: until});
  assert.throws(() => pilot.setMandate(p, {max_issue_per_deal: SANDBOX_CAPS.max_issue_per_deal + 1}), e => e.code === 'sandbox_only', 'precondition: the box holds');
  const r = pilot.setMandate(p, {public_card: true});
  assert.deepEqual([r.changed, p.mandate.public_card], [true, true]);
  pilot.setMandate(p, {public_card: false});
  assert.equal('public_card' in p.mandate, false);
});

test('the card: its shape, the mandate the server enforces, the room as checkMandate counts it, the backing (public ones named, never the creditor), the record and the URLs; no _PC key', async () => {
  const w = shared(), {pilot, amy, bob, eve, cy, g1, g3} = w;
  amy.mandate.objective = 'a'.repeat(299) + '\u{1D11E}\u{1D11E}';          // 301 code points: cut to 300, no character split
  pilot.setMandate(amy, {public_card: true});
  pilot.setAgentLimits(amy, {max_issue_per_deal: 4});                      // stricter than the owner's 5: the card shows what applies
  const call = await serve(pilot), r = await call('GET', `/pilot/v1/participants/${amy.id}/card`);
  assert.equal(r.status, 200);
  const card = r.body;
  assert.deepEqual(Object.keys(card), ['card', 'network', 'unit', 'agent', 'mandate', 'room', 'backing', 'record', 'card_hash', 'check', 'page']);
  assert.deepEqual([card.card, card.network, card.unit], [CARD_VERSION, NETWORK, 'PC']);
  assert.deepEqual(card.agent, {id: amy.id, handle: 'amy-payer', display_name: 'amy-payer', operator: 'test operator'});
  assert.deepEqual(card.mandate, {version: 2, expires_at: amy.mandate.expires_at, may_issue_credit: true, per_deal: 4, outstanding_cap: 40, approve_above: 1000,
    counterparties: 'any', objective: 'a'.repeat(299) + '\u{1D11E}'});
  assert.equal(Array.from(card.mandate.objective).length, 300);
  // 4 on the tracker + 3 agreed + 2 own open offer + 6 backed = 15: exactly what checkMandate counts.
  assert.deepEqual([card.room.outstanding, card.room.room_left], [15, 25]);
  assert.ok(Math.abs(Date.parse(card.room.as_of) - w.clock.t) < 1000);
  const chk = await pilot.checkMandate(amy, 'payer', bob.id, 1);
  const counted = chk.checks.find(c => c.rule === 'max_issue_outstanding');
  assert.equal(counted.owed_on_tracker + counted.committed + counted.reserved + (counted.guaranteed ?? 0), card.room.outstanding);
  assert.deepEqual(card.backing, {active: 3, creditors: 2, total_cap: 9, remaining: 8, public: [
    {guarantee_id: g3.id, backer: {id: cy.id, handle: 'cy-backer'}, creditor: null, cap: 4, remaining: 4, expires_at: g3.terms.expires_at},
    {guarantee_id: g1.id, backer: {id: cy.id, handle: 'cy-backer'}, creditor: null, cap: 3, remaining: 3, expires_at: g1.terms.expires_at}]});
  assert.ok(!r.text.includes(bob.id) && !r.text.includes(eve.id) && !r.text.includes('bob-creditor') && !r.text.includes('eve-creditor'), 'no creditor is named');
  assert.ok(!r.text.includes('dan-backer'), 'a backer who did not choose public vouches is not named');
  assert.deepEqual(card.record, {completed: 1, disputed: 1, holds: 2, owes: 4, cleared: 0});
  assert.equal(card.check, `https://valun.tech/pilot/v1/participants/${amy.id}/check?amount={amount}&payee={payee}`);
  assert.equal(card.page, 'https://valun.tech/agent/amy-payer');
  assert.deepEqual(keysDeep(card).filter(k => /_PC$|^PC$/.test(k)), [], 'unit-neutral names only (fix inbox #32)');
  // Counterparties as a count; an unlisted agent has no page.
  pilot.setMandate(amy, {counterparties: [bob.id, eve.id]});
  pilot.setListed(amy, false);
  const again = await budgetCard(pilot, amy);
  assert.deepEqual([again.mandate.counterparties, again.page], [{listed: 2}, null]);
});

test('card_hash is sha256 of the canonical {card, network, agent, mandate}; it changes with the mandate version, not with a PUT that changes nothing', async () => {
  const w = shared(), {pilot, amy} = w;
  pilot.setMandate(amy, {public_card: true});
  const c1 = await budgetCard(pilot, amy);
  assert.equal(c1.card_hash, sha256(canonical({card: 1, network: NETWORK, agent: amy.id, mandate: c1.mandate})));
  assert.match(c1.card_hash, /^[0-9a-f]{64}$/);
  pilot.setMandate(amy, {max_issue_per_deal: 5});                          // the same value: no new version
  assert.equal((await budgetCard(pilot, amy)).card_hash, c1.card_hash);
  w.owe(amy, w.bob, 6);                                                     // the room changes; the mandate does not
  assert.equal((await budgetCard(pilot, amy)).card_hash, c1.card_hash, 'the hash covers the mandate, not the room');
  pilot.setMandate(amy, {max_issue_outstanding: 30});
  const c2 = await budgetCard(pilot, amy);
  assert.deepEqual([c2.mandate.version, c2.mandate.outstanding_cap], [c1.mandate.version + 1, 30]);
  assert.notEqual(c2.card_hash, c1.card_hash);
  assert.equal(c2.card_hash, sha256(canonical({card: 1, network: NETWORK, agent: amy.id, mandate: c2.mandate})));
});

test('the verdicts, each the answer the server gives when the payer\'s agent proposes the same deal: accept, ask_owner, and decline for per-deal, outstanding and expiry', async () => {
  const w = world(), {pilot, person, owe, clock} = w, bob = person('bob-payee');
  const call = await serve(pilot);
  const check = async (payer, amount, payee = bob) => {
    const r = await call('GET', `/pilot/v1/participants/${payer.id}/check?amount=${amount}&payee=${payee.handle}`);
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  const published = (handle, mandate = {}) => { const p = person(handle, mandate); pilot.setMandate(p, {public_card: true}); return p; };
  // What the server does with the same deal, proposed by the payer's agent: open, held for its owner, or refused.
  const server = async (payer, amount) => {
    try { return (await w.propose(payer, bob, amount)).status; } catch (e) { assert.equal(e.code, 'mandate_exceeded'); return `refused:${e.extra.rule}`; }
  };

  // accept: within the budget, below approve_above.
  const ann = published('ann-payer');
  owe(ann, bob, 9);
  let c = await check(ann, 5);
  assert.deepEqual(Object.keys(c), ['verdict', 'reasons', 'rule', 'payer', 'payee', 'amount', 'mandate', 'room_left', 'approval_needed', 'cover', 'record', 'card_hash', 'checked_at', 'took_ms']);
  assert.deepEqual([c.verdict, c.rule, c.approval_needed, c.amount, c.room_left], ['accept', null, false, 5, 31]);
  assert.deepEqual(c.reasons, ['Within its budget: up to 5 PC a deal, 31 PC of 40 PC left.']);
  assert.deepEqual([c.payer, c.payee], [{id: ann.id, handle: 'ann-payer'}, {id: bob.id, handle: 'bob-payee'}]);
  assert.deepEqual(c.mandate, {version: 2, expires_at: ann.mandate.expires_at});
  assert.deepEqual(c.cover, {covered: null, guarantees: []}, 'no token: the payee\'s cover is not shown');
  assert.deepEqual(c.record, {completed: 0, disputed: 0, holds: 0, owes: 9, cleared: 0});
  assert.equal(c.card_hash, (await budgetCard(pilot, ann)).card_hash);
  assert.ok(Math.abs(Date.parse(c.checked_at) - clock.t) < 1000 && Number.isInteger(c.took_ms) && c.took_ms >= 0);
  assert.equal(await server(ann, 5), 'open');

  // ask_owner: above approve_above; with approve_above 0 (the default mandate) every commitment waits for the owner.
  const ben = published('ben-payer', {approve_above: 2});
  c = await check(ben, 3);
  assert.deepEqual([c.verdict, c.rule, c.approval_needed], ['ask_owner', 'approve_above', true]);
  assert.deepEqual(c.reasons, ['Within its budget: up to 5 PC a deal, 40 PC of 40 PC left.', 'Its owner approves each commitment above 2 PC: this one waits for the owner before it binds.']);
  assert.equal((await check(ben, 2)).verdict, 'accept', 'at approve_above itself nothing waits');
  assert.equal(await server(ben, 3), 'proposed_awaiting_owner');
  const cal = published('cal-payer', {approve_above: 0});
  c = await check(cal, 1);
  assert.deepEqual([c.verdict, c.rule, c.reasons[1]], ['ask_owner', 'approve_above', 'Its owner approves every commitment itself: this one waits for the owner before it binds.']);
  assert.equal(await server(cal, 1), 'proposed_awaiting_owner');

  // decline: over the per-deal limit (the stricter agent limit counts).
  const dee = published('dee-payer');
  c = await check(dee, 6);
  assert.deepEqual([c.verdict, c.rule, c.approval_needed, c.reasons], ['decline', 'max_issue_per_deal', false, ['Over its limit per deal: 6 PC is more than the 5 PC a deal its owner allows.']]);
  assert.equal(await server(dee, 6), 'refused:max_issue_per_deal');
  pilot.setAgentLimits(dee, {max_issue_per_deal: 3});
  assert.deepEqual([(await check(dee, 4)).verdict, (await check(dee, 4)).rule], ['decline', 'max_issue_per_deal']);
  assert.equal(await server(dee, 4), 'refused:max_issue_per_deal');

  // decline: over what is left of the outstanding cap.
  const eli = published('eli-payer');
  owe(eli, bob, 37);
  c = await check(eli, 4);
  assert.deepEqual([c.verdict, c.rule, c.room_left, c.reasons], ['decline', 'max_issue_outstanding', 3, ['Over its budget: it has 3 PC of 40 PC left, less than 4 PC.']]);
  assert.equal(await server(eli, 4), 'refused:max_issue_outstanding');
  assert.equal((await check(eli, 3)).verdict, 'accept');

  // decline: the mandate has expired.
  const fay = published('fay-payer', {expires_at: iso(clock.t - 60e3)});
  c = await check(fay, 1);
  assert.deepEqual([c.verdict, c.rule, c.reasons], ['decline', 'expires_at', [`Its owner's mandate ended at ${fay.mandate.expires_at}: it cannot commit to anything until its owner renews it.`]]);
  assert.equal(await server(fay, 1), 'refused:expires_at');

  // decline: the payee is not on the owner's counterparty list.
  const gus = published('gus-payer', {counterparties: [ann.id]});
  c = await check(gus, 1);
  assert.deepEqual([c.verdict, c.rule, c.reasons], ['decline', 'counterparties', ['Its owner has not listed bob-payee among the agents it may deal with.']]);
  assert.equal(await server(gus, 1), 'refused:counterparties');
});

test('the check is a dry run: the state, the audit log and the cache generation are as they were', async () => {
  const w = shared(), {pilot, amy, bob, dir} = w;
  pilot.setMandate(amy, {public_card: true});
  await budgetCard(pilot, amy);                                             // the reads' own sweep happens here, once
  const files = () => fs.readdirSync(dir).sort().map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const before = {state: JSON.stringify(pilot.s), files: files(), generation: pilot.generation};
  for (const amount of [1, 6, 30]) await checkPayer(pilot, amy, {amount, payee: bob});
  assert.equal(JSON.stringify(pilot.s), before.state);
  assert.deepEqual(files(), before.files);
  assert.equal(pilot.generation, before.generation);
});

test('the cover, as the payee sees it: the active guarantees of the payer\'s IOUs to this payee, their remaining caps; a backer is named only when the guarantee is public (fix inbox #31)', async () => {
  const w = shared(), {pilot, amy, bob, eve, cy, dan, g1, g2, g3} = w;
  pilot.setMandate(amy, {public_card: true});
  let c = await checkPayer(pilot, amy, {amount: 2, payee: bob, showCover: true});
  assert.equal(c.verdict, 'accept');
  assert.deepEqual(c.cover, {covered: 4, guarantees: [{guarantee_id: g1.id, backer: {id: cy.id, handle: 'cy-backer'}, remaining: 3}, {guarantee_id: g2.id, backer: null, remaining: 1}]});
  assert.equal(c.reasons[1], 'Backed for you up to 4 PC by @cy-backer and a backer not named here.');
  c = await checkPayer(pilot, amy, {amount: 2, payee: eve, showCover: true});
  assert.deepEqual(c.cover, {covered: 4, guarantees: [{guarantee_id: g3.id, backer: {id: cy.id, handle: 'cy-backer'}, remaining: 4}]});
  assert.equal(c.reasons[1], 'Backed for you up to 4 PC by @cy-backer.');
  // Public needs both sides: without the issuer's choice the backer is not named.
  pilot.setProfile(amy, {public_vouches: false});
  c = await checkPayer(pilot, amy, {amount: 2, payee: bob, showCover: true});
  assert.deepEqual(c.cover.guarantees.map(g => g.backer), [null, null]);
  assert.equal(c.reasons[1], 'Backed for you up to 4 PC by 2 backers not named here.');
  assert.deepEqual((await budgetCard(pilot, amy)).backing.public, [], 'nor listed on the card');
  // Nobody backs her IOUs to dan: no cover, no backing reason.
  c = await checkPayer(pilot, amy, {amount: 2, payee: dan, showCover: true});
  assert.deepEqual([c.cover, c.reasons.length], [{covered: 0, guarantees: []}, 1]);
  // A guarantee in the deal mode backs only the deals it names: counted, and the reason says how much.
  const d = w.deal(amy, dan, 'agreed', 2);
  w.guarantee(cy, amy, dan, 2, {covers: 'issuer_payment_for_deals', deals: [d.id]});
  c = await checkPayer(pilot, amy, {amount: 1, payee: dan, showCover: true});
  assert.equal(c.cover.covered, 2);
  assert.equal(c.reasons[1], 'Backed for you up to 2 PC by a backer not named here (2 PC of it backs only particular deals).');
});

test('the cover is the payee\'s own business: shown only to a check sent with the payee\'s token (agent or owner), never cached for anyone else', async () => {
  const w = shared(), {pilot, amy, bob, eve, tokens} = w;
  pilot.setMandate(amy, {public_card: true});
  const call = await serve(pilot), url = `/pilot/v1/participants/${amy.id}/check?amount=2&payee=${bob.handle}`;
  const anon = (await call('GET', url)).body;
  assert.deepEqual(anon.cover, {covered: null, guarantees: []});
  assert.equal(anon.reasons.some(r => /Backed for you/.test(r)), false);
  for (const tok of [tokens.get(bob.id).agent, tokens.get(bob.id).owner]) {
    const mine = (await call('GET', url, {token: tok})).body;
    assert.equal(mine.cover.covered, 4, 'the payee sees its cover');
    assert.match(mine.reasons[1], /^Backed for you up to 4 PC by @cy-backer/);
  }
  // Another participant's token is no better than none, and the payee's answer did not reach the cache.
  assert.deepEqual((await call('GET', url, {token: tokens.get(eve.id).agent})).body.cover, {covered: null, guarantees: []});
  assert.deepEqual((await call('GET', url)).body.cover, {covered: null, guarantees: []});
});

test('two refusals come before the mandate, as the server gives them to a proposal: no active agent key (no_agent), and above the network\'s per-deal limit (network_limit)', async () => {
  const w = world(), {pilot, person} = w, bob = person('bob-payee');
  const keyless = person('kay-payer', {}, {status: 'awaiting_agent', pubkey: null});
  pilot.setMandate(keyless, {public_card: true});
  let c = await checkPayer(pilot, keyless, {amount: 1, payee: bob});
  assert.deepEqual([c.verdict, c.rule, c.approval_needed], ['decline', 'no_agent', false]);
  assert.deepEqual(c.reasons, ['It has no active agent key: it cannot commit to anything until its owner connects an agent.']);
  const big = person('big-payer', {max_issue_per_deal: PRICE_CAP + 10, max_issue_outstanding: 2 * PRICE_CAP});
  pilot.setMandate(big, {public_card: true});
  c = await checkPayer(pilot, big, {amount: PRICE_CAP + 1, payee: bob});
  assert.deepEqual([c.verdict, c.rule], ['decline', 'network_limit']);
  assert.match(c.reasons[0], /^Over the network's limit: a deal is at most /);
  assert.equal((await checkPayer(pilot, big, {amount: PRICE_CAP, payee: bob})).verdict, 'accept', 'at the limit itself it passes');
});

test('the check\'s errors: a missing or bad amount, a missing payee and the payer itself are 400 invalid_field; an unknown payee is 404 not_found; the payee by id or handle', async () => {
  const w = world(), {pilot, person} = w, amy = person('amy-payer'), bob = person('bob-payee');
  pilot.setMandate(amy, {public_card: true});
  const call = await serve(pilot), base = `/pilot/v1/participants/${amy.id}/check`;
  for (const q of ['?payee=bob-payee', '?amount=&payee=bob-payee', '?amount=0&payee=bob-payee', '?amount=-1&payee=bob-payee', '?amount=1.5&payee=bob-payee',
    '?amount=abc&payee=bob-payee', '?amount=1e3&payee=bob-payee', '?amount=%201&payee=bob-payee', '?amount=007&payee=bob-payee', '?amount=9007199254740993&payee=bob-payee',
    '?amount=3', '?amount=3&payee=', `?amount=3&payee=${amy.id}`, '?amount=3&payee=amy-payer']) {
    const r = await call('GET', base + q);
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_field'], q);
  }
  for (const q of ['?amount=3&payee=nobody-here', '?amount=3&payee=vp_000000000000', '?amount=3&payee=%3Cscript%3E']) {
    const r = await call('GET', base + q);
    assert.deepEqual([r.status, r.body.error], [404, 'not_found'], q);
  }
  for (const payee of [bob.id, 'bob-payee', 'Bob-Payee']) assert.equal((await call('GET', `${base}?amount=3&payee=${payee}`)).body.payee.id, bob.id, payee);
  assert.equal(parseAmount('9007199254740991', 'PC'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => findPayee(pilot, bob.handle, bob), e => e.code === 'invalid_field');
});

test('the agent page: a "Budget card" section and the budget line in its description once the owner published the card; nothing before; everything escaped', async () => {
  const w = shared(), {pilot, amy} = w;
  const call = await serve(pilot);
  let r = await call('GET', '/agent/amy-payer');
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /Budget card/);
  pilot.setMandate(amy, {public_card: true, approve_above: 2});
  r = await call('GET', '/agent/amy-payer');
  assert.ok(r.text.includes('<p class="eyebrow">Budget card</p>'));
  assert.ok(r.text.includes(`<p>Can commit up to 5 PC a deal and 40 PC in all for its owner · 25 PC left · backed for 2 creditors, up to 8 PC · its owner approves each commitment above 2 PC · check before you accept: <code>https://valun.tech/pilot/v1/participants/${amy.id}/check?amount={amount}&amp;payee={payee}</code></p>`));
  assert.ok(r.text.includes(`<a href="/pilot/v1/participants/${amy.id}/card">The card as JSON</a>`));
  assert.match(r.text, /<meta name="description" content="amy-payer is an AI agent on Valun, where agents work for each other and pay with signed promises\. Budget card: can commit up to 5 PC a deal and 40 PC in all for its owner; 25 PC left\.">/);
  // The page's own parts, pure: every value is escaped, the line says when the owner has not allowed IOUs or the mandate ended.
  const now = w.clock.t, pub = {id: 'vp_1', handle: 'x-agent', joined_at: iso(now), agent_last_seen: null};
  const hostile = {agent: {id: '"><img src=x onerror=alert(1)>'}, check: 'https://valun.tech/c?amount=1&payee=<script>alert(1)</script>',
    mandate: {per_deal: '<b>5</b>', outstanding_cap: 40, approve_above: 1000, may_issue_credit: true, expires_at: null}, room: {room_left: 3, as_of: iso(now)}, backing: {active: 0}};
  const html = renderAgentPage(agentView(pub, null, [], {now, card: hostile}));
  assert.doesNotMatch(html, /<script>|<img|<b>5/);
  assert.ok(html.includes('Can commit up to &lt;b&gt;5&lt;/b&gt; PC a deal'));
  assert.ok(html.includes('payee=&lt;script&gt;alert(1)&lt;/script&gt;</code>'));
  assert.ok(html.includes('href="/pilot/v1/participants/&quot;&gt;&lt;img src=x onerror=alert(1)&gt;/card"'));
  const ended = agentView(pub, null, [], {now, card: {...hostile, mandate: {...hostile.mandate, per_deal: 5, expires_at: iso(now - DAY)}}});
  assert.match(ended.budget.line, /^Its owner's mandate ended on \d{4}-\d{2}-\d{2}: it cannot commit to anything until its owner renews it$/);
  const noCredit = agentView(pub, null, [], {now, card: {...hostile, mandate: {...hostile.mandate, may_issue_credit: false}}});
  assert.equal(noCredit.budget.line, 'Its owner has not allowed it to pay with IOUs');
  assert.match(agentDescription(noCredit), /Budget card: its owner has not allowed it to pay with IOUs\.$/);
  assert.equal(agentView(pub, null, [], {now}).budget, null);
});

test('GET /me room (fix inbox #54 item 7): what counts against max_issue_outstanding and what is left, the card\'s room, with or without a public card', async () => {
  const w = shared(), {pilot, amy, tokens} = w;
  const call = await serve(pilot);
  let me = (await call('GET', '/pilot/v1/me', {token: tokens.get(amy.id).agent})).body;
  assert.deepEqual(me.room, {outstanding: 15, room_left: 25});
  assert.deepEqual(Object.keys(me).slice(-2), ['credit_policy', 'features'], 'the circulation keys stay last');
  pilot.setMandate(amy, {public_card: true, max_issue_outstanding: 12});
  me = (await call('GET', '/pilot/v1/me', {token: tokens.get(amy.id).owner})).body;
  assert.deepEqual(me.room, {outstanding: 15, room_left: 0}, 'never below 0');
  const card = await budgetCard(pilot, amy);
  assert.deepEqual([card.room.outstanding, card.room.room_left], [me.room.outstanding, me.room.room_left]);
});

test('with circulation off the card and the check work the same (no guarantees there): what the testnet shows before netting is on', async () => {
  const w = world({mode: 'off'}), {pilot, person, owe} = w, amy = person('amy-payer'), bob = person('bob-payee');
  owe(amy, bob, 7);
  assert.deepEqual(pilot.setMandate(amy, {public_card: true}).changed, true);
  const card = await budgetCard(pilot, amy);
  assert.deepEqual([card.room.outstanding, card.room.room_left, card.backing], [7, 33, {active: 0, creditors: 0, total_cap: 0, remaining: 0, public: []}]);
  const c = await checkPayer(pilot, amy, {amount: 5, payee: bob});
  assert.deepEqual([c.verdict, c.reasons], ['accept', ['Within its budget: up to 5 PC a deal, 33 PC of 40 PC left.']]);
});
