// The budget card's check equals enforcement (C8): an oracle over worlds built as JSON. For each case, the check's answer
// (GET /participants/{payer}/check through its route: payer_side for the payer, payee_side for the payee, and since fix
// inbox #87 the step's one {verdict, rule} from both) is compared with what the server's real actions do at the decision
// point, run on twins of the world:
//   - a new deal the payer proposes (path payer_proposes, the default): Pilot.propose by the payer, then the payee's
//     Pilot.accept, then every owner decision the deal waits for (Pilot.decideApproval, approve), until it is agreed or a
//     step is refused;
//   - a new deal the payee proposes (path payee_proposes): the payee's propose, then the payer's accept, then the owners;
//   - an offer under review (deal=): its next steps from where it stands: accept by the side whose turn it is, or the
//     decision of the owner it waits for.
// The answer predicts the first refusal, in the order the action checks the two sides (the side and its rule), or the
// agreement and whose owners were asked. Three twins per case: the world as it is, and one per side with the other side's
// limits lifted, so that each side's own verdict is compared whatever the other side would say. The step's verdict is
// compared with the world as it is: decline with the first refusal's rule, ask_owner when it is agreed once owners
// approve, accept when it is agreed with no owner asked (fix inbox #87). Every case is asked again of the same world with
// the payer's card not published: the payee's own check gives the same payee_side verdict and rule, in words with no
// figure of the payer's (nor its card, room, cover or record), the payer's side unknown, and the step declined exactly
// when the payee's side declines; anyone else's check is 404 card_not_public.
// Every step on a twin is preceded by its request's authentication, as the routes do it (Pilot.authenticate with the
// actor's agent token, or its owner's token for an owner's decision): an agent's own request renews a self-serve
// participant on the open network first. The twins start from the state the check answered on (the live pilot's after
// the check's own requests: a check sent with the payee's agent token is such a request too). A dormancy family of worlds
// (world(seed, {dormancy: true})) has self-serve parties in each renewal state and house sandbox agent payers, whose debt
// to dormant participants does not count against their limit until those participants' agents act.
// Privacy: the payer's counter-offer that only the payer sees changes nothing in the payee's answer on the offer under
// review but the one bit the check documents (an accept whose figures say the deal does not fit).
// A twin is a fresh Pilot over a JSON clone of the world, never Object.create of the live one: a store that writes
// nothing, a closed tracker (the pinned notes; any other member throws speculative_write), a fixed clock, and no
// listeners, clearing or server signer. Only a twin's stub verify accepts every signature (SIG, assumed); the live pilot
// that answers the checks verifies none.
// Named regressions: the four live divergences that design C8's prototype (a shadow pilot running the unchanged actions)
// reproduced at 68f09c0: the offer under review counted twice (fix inbox #60), ask_owner for an offer its owner approved,
// accept for a self-serve payer that cannot propose (429), and accept for a payee with no key (400). Then the review of
// the first C8 commit: the payer's private counter-offer priced by the payee's answer, counter_pending's words, dormant
// self-serve payees and payers checked as they are where their agent's request renews them, and a house sandbox agent's
// debt to a dormant payee left out where the payee's agent acts.
// Fix inbox #79: the coverage rule counts a deal's own guarantees as the check's cover does (their share of its price).
// Every case with guarantees compares the rule's figures at its step with the check's cover; worlds stack guarantees on
// the offer under review, and its payee's step is driven again under the rule as it was before, so the oracle reaches
// payees whose bar sits between the two figures (the check and the real steps agree there: mostly they refuse an offer
// the rule before took).
// ORACLE_WORLDS=n worlds per seed (12 seeds; 75 by default, about 200 cases a seed).
// Run: node --test test/check-oracle.unit.test.mjs
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {Pilot, PilotStore, PilotError, PILOT_DENOMINATION, DEFAULT_MANDATE, PROTOCOL, OPEN_NETWORK_MAX_OPEN_OFFERS, NETWORK, statements, termsHash} from '../lib/pilot/core.mjs';
import {createPilotRoutes} from '../lib/pilot/http.mjs';
import {PAYEE_NOT_CHECKED, PAYER_NOT_PUBLISHED} from '../lib/pilot/card.mjs';
import {UNIT} from '../lib/pilot/units.mjs';
import {statusClass} from '../lib/pilot/status.mjs';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); });
const T = Date.parse('2026-11-16T14:00:00.000Z'), HOUR = 3600e3, DAY = 24 * HOUR, BIG = 1e12;
const NFT = '0'.repeat(64), PIN = 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};
// What every twin action is signed with: assumed, never checked (only a twin's stub verify accepts it).
const SIG = '02' + 'a5'.repeat(64);
// The refusals that come before anything else: no terms can name these parties at this price, so nothing is proposed.
const PRE = new Set(['no_agent', 'payee_no_key', 'network_limit']);
const iso = t => new Date(t).toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));

// mulberry32: the same worlds on every run and every machine.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: xs => xs[Math.floor(next() * xs.length)], chance: p => next() < p,
    hex: n => Array.from({length: n}, () => Math.floor(next() * 256).toString(16).padStart(2, '0')).join('')};
}

// ---------- worlds as JSON ----------
// A builder for one world's state, the way the server stores it (participants, deals and their versions, approvals,
// guarantees, the journal's edges) and the tracker's notes. Nothing here runs a server action: every object is written
// as the actions would have left it. `done(payer, payee, review)` returns the world W = {t, mode, openNetwork,
// sandboxIds, state, notes, tokens, payer, payee, review}.
function builder({seed = 1, mode = 'on', openNetwork = false} = {}) {
  const r = rng(seed), t = T, circ = mode === 'on';
  const s = {version: 1, network: NETWORK, createdAt: iso(t - 30 * DAY), participants: {}, deals: {}, approvals: {}, invites: {}};
  const notes = [], edges = {}, tokens = {}, sandboxIds = [];
  let ts = t - 10 * DAY;
  const at = (dt = -HOUR) => iso(t + dt);
  const b = {r, t, mode, circ, openNetwork, s, sandboxIds,
    // An active participant with an agent key; `mandate` over permissive defaults (approve_above high: nothing waits).
    person(handle, mandate = {}, extra = {}) {
      const id = 'vp_' + r.hex(6), agent = `vpa_${handle}_${r.hex(8)}`, owner = `vpo_${handle}_${r.hex(8)}`;
      tokens[id] = {agent, owner};
      const p = {id, handle, display_name: handle, operator: 'oracle', about: '', services: '', pubkey: '02' + r.hex(32), status: 'active', created_at: at(-20 * DAY),
        owner_token_hash: sha(owner), agent_token_hash: sha(agent), enrollment: null,
        mandate: {...DEFAULT_MANDATE, max_issue_per_deal: 20, max_issue_outstanding: 100, max_accept_per_deal: 20, max_accept_per_issuer: 100, approve_above: 1e9,
          expires_at: at(6 * DAY), ...(circ ? POLICY : {}), ...mandate},
        mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null, ...extra};
      s.participants[id] = p;
      return p;
    },
    // Its owner joined, but no agent key is registered yet (awaiting_agent): it never had a deal or a note.
    keyless(p) { Object.assign(p, {status: 'awaiting_agent', pubkey: null, agent_token_hash: null}); return p; },
    // A self-serve participant (sandbox_only) whose sandbox time runs 7 more days (so no read renews it).
    boxed(p) { Object.assign(p, {sandbox_only: true, sandbox_expires_at: at(7 * DAY)}); return p; },
    // A self-serve participant as its agent's next request (Pilot.authenticate, renewSandbox) finds it: 'renewing' (2
    // days of sandbox time left, its mandate ending with it: both renewed), 'dormant' (its time and its mandate ended a
    // day ago: both renewed, it wakes), 'owner_earlier' (2 days left, and its owner ended the mandate an hour ago: the
    // time is renewed, the mandate stays ended), 'dormant_owner_earlier' (its time ended a day ago, the mandate two days
    // ago: it wakes, the mandate stays ended).
    selfServe(p, state) {
      const [box, until] = {renewing: [2 * DAY, 2 * DAY], dormant: [-DAY, -DAY], owner_earlier: [2 * DAY, -HOUR], dormant_owner_earlier: [-DAY, -2 * DAY]}[state];
      Object.assign(p, {sandbox_only: true, sandbox_expires_at: at(box)});
      p.mandate.expires_at = at(until);
      return p;
    },
    // I owes R `total` on the tracker; most edges reconcile with the journal, so the claims on them count (grounding).
    owe(I, R, total, {reconciled = r.chance(0.75)} = {}) {
      if (!(total > 0) || !I.pubkey || !R.pubkey) return;
      const redeemed = r.chance(0.15) ? r.int(0, total - 1) : 0;
      notes.push({issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(total), amount_redeemed: String(redeemed), timestamp: (ts += 1000),
        signature: '02' + r.hex(64), denomination: PILOT_DENOMINATION});
      if (reconciled) edges[`${I.pubkey}>${R.pubkey}`] = {issuer: I.id, recipient: R.id, expected_total: total, issued_PC: total, setoff_PC: 0, transferred_in_PC: 0,
        transferred_out_PC: 0, novated: false, last: null, last_seq: 0};
    },
    approval(who, d, kind, v, state = 'pending') {
      const a = {id: 'va_' + r.hex(6), participant: who.id, deal_id: d.id, kind, version: v.v, terms_hash: v.terms_hash, created_at: at(-HOUR), state,
        ...(state === 'pending' ? {} : {decided_at: at(-HOUR / 2)})};
      s.approvals[a.id] = a;
      return a;
    },
    // A deal payer -> payee whose first version `by` proposed, at `price`, in `status`: open, proposed_awaiting_owner
    // (its approval pending), agreed or delivered (committed).
    deal(payer, payee, by, price, status, {exp = t + r.int(2, 96) * HOUR, due = null} = {}) {
      const id = 'vd_' + r.hex(8), deliverBy = due ?? Math.min(exp + r.int(1, 10) * DAY, t + 29 * DAY);
      const terms = {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: id, version: 1, prior_terms_hash: null, nonce: r.hex(16),
        proposer: by.id, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: {title: 'a job', description: 'synthetic', deliverable: 'text'},
        price: {amount: price, unit: UNIT}, consideration: 'credit_note_on_delivery_accepted', offer_expires_at: iso(exp), deliver_by: iso(deliverBy)};
      const formed = status === 'agreed' || status === 'delivered';
      const v = {v: 1, by: by.id, terms, terms_hash: termsHash(terms), signature: '02' + r.hex(64), created_at: at(-2 * HOUR),
        state: formed ? 'accepted' : status === 'proposed_awaiting_owner' ? 'awaiting_owner' : 'open', mandate_check: {checks: [], mandate_version: 1},
        offered_at: status === 'proposed_awaiting_owner' ? null : at(-2 * HOUR)};
      const d = {id, payer: payer.id, payee: payee.id, created_at: at(-2 * HOUR), status, versions: [v], history: []};
      s.deals[id] = d;
      if (status === 'proposed_awaiting_owner') v.approval_id = b.approval(by, d, 'propose', v).id;
      if (formed) {
        const other = by.id === payer.id ? payee : payer;
        d.acceptance = {version: 1, by: other.id, terms_hash: v.terms_hash, signature: '02' + r.hex(64), at: at(-HOUR), mandate_check: {checks: []}, state: 'final'};
        d.agreement = {version: 1, terms, terms_hash: v.terms_hash, proposer_signature: v.signature, acceptor_signature: d.acceptance.signature, proposer: by.id, acceptor: other.id, formed_at: at(-HOUR)};
        if (status === 'delivered') d.delivery = {by: payee.id, title: '', content: 'done', sha256: sha('done'), bytes: 4, signature: '02' + r.hex(64), at: at(-HOUR / 2), late: false};
      }
      return d;
    },
    // `by` countered d's current version: its version is current and open (Pilot.counter without its owner).
    countered(d, by, price) {
      const cur = d.versions.at(-1), v = b.version(d, by, price, 'open');
      cur.state = 'countered'; d.versions.push(v);
      return v;
    },
    // `by`'s counter-offer to d's current version, waiting for its owner (Pilot.counter with needsOwner): counted in its
    // own exposure (reserved), never seen by the other side.
    counter(d, by, price) {
      const v = b.version(d, by, price, 'awaiting_owner');
      v.approval_id = b.approval(by, d, 'propose', v).id;
      d.pending_counter = v;
      return v;
    },
    version(d, by, price, state) {
      const cur = d.versions.at(-1);
      const terms = {...clone(cur.terms), version: cur.v + 1, prior_terms_hash: cur.terms_hash, nonce: r.hex(16), proposer: by.id, price: {amount: price, unit: UNIT}};
      return {v: cur.v + 1, by: by.id, terms, terms_hash: termsHash(terms), signature: '02' + r.hex(64), created_at: at(-HOUR), state, mandate_check: {checks: []},
        offered_at: state === 'open' ? at(-HOUR) : null};
    },
    // The proposer's owner approved version v before it was offered (it was above approve_above then).
    ownerApproved(d, X, v) {
      const a = b.approval(X, d, 'propose', v, 'approved');
      Object.assign(v, {approval_id: a.id, owner_approval: {approval_id: a.id, at: a.decided_at}, offered_at: a.decided_at});
    },
    // d's current version, accepted by the other side and waiting for an owner (accepted_awaiting_owner): the acceptor's
    // owner (accHold: its approval pending; accApproved: given already) and/or the proposer's owner (propHold: the
    // confirmation it was asked for). The acceptor's approval comes first, as Pilot.accept makes them.
    held(d, {accHold, accApproved = false, propHold}) {
      const v = d.versions.at(-1), acceptor = s.participants[v.by === d.payer ? d.payee : d.payer], proposer = s.participants[v.by];
      d.status = 'accepted_awaiting_owner';
      d.acceptance = {version: v.v, by: acceptor.id, terms_hash: v.terms_hash, signature: '02' + r.hex(64), at: at(-HOUR / 2), mandate_check: {checks: []}, state: 'awaiting_owner'};
      if (accHold || accApproved) {
        const a = b.approval(acceptor, d, 'accept', v, accHold ? 'pending' : 'approved');
        d.acceptance.approval_id = a.id;
        if (!accHold) d.acceptance.owner_approval = {approval_id: a.id, at: a.decided_at};
      }
      if (propHold) d.acceptance.proposer_approval_id = b.approval(proposer, d, 'confirm_offer', v).id;
    },
    // An accepted guarantee (backer backs issuer's debt to creditor up to `cap`), `claimed` of it by an honored call.
    guarantee(backer, issuer, creditor, cap, {expires = t + 5 * DAY, covers = 'issuer_debt_to_creditor', deals = null, claimed = 0, state = 'active'} = {}) {
      const id = 'vg_' + r.hex(8);
      const terms = {protocol: 'valun-guarantee/1', network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, guarantee_id: id, nonce: r.hex(16),
        backer: {id: backer.id, pubkey: backer.pubkey}, issuer: {id: issuer.id, pubkey: issuer.pubkey}, creditor: {id: creditor.id, pubkey: creditor.pubkey},
        cap: {amount: cap, unit: UNIT}, covers, ...(deals ? {deals} : {}), due_at: at(-2 * HOUR), expires_at: iso(expires), honor_within_hours: 24, offer_expires_at: at(HOUR), note: ''};
      const calls = claimed ? [{id: 'vgc_' + r.hex(8), amount: Math.min(claimed, cap), signature: '02' + r.hex(64), called_at: at(-HOUR), honor_by: at(DAY), state: 'honored',
        owed_at_call: claimed, claimed_before: 0, honored_at: at(-HOUR / 2), late: false}] : [];
      (s.guarantees ??= {})[id] = {id, terms, terms_hash: termsHash(terms), backer: backer.id, issuer: issuer.id, creditor: creditor.id, state,
        offer: {by: backer.id, at: at(-DAY), signature: '02' + r.hex(64), offered_at: at(-DAY)}, acceptance: {by: creditor.id, at: at(-DAY), signature: '02' + r.hex(64)},
        calls, history: [], created_at: at(-DAY), updated_at: at(-DAY)};
      return s.guarantees[id];
    },
    done(payer, payee, review = null) {
      s.edges = edges;
      payer.mandate.public_card = true;
      return {t, mode, openNetwork, sandboxIds: [...sandboxIds], state: s, notes, tokens, payer: payer.id, payee: payee.id, review: review?.id ?? null};
    }};
  return b;
}

// A random world: the payer B and the payee C (the pair every check asks about), D and E (other parties), the backers G
// and H, and S (a sandbox agent). Its caps, approve_above (0 or large, sometimes small), counterparty lists, coverage
// rule, phase-2 rules, self-serve boxes on the open network or not, debts, committed deals, open offers (at the
// open-offer limit sometimes), counters waiting for an owner, owner approvals and guarantees are drawn; so is the offer
// under review between B and C: B's open offer (E1), C's open offer or counter (E2), C's offer waiting for its owner
// (E3), an acceptance waiting for an owner (E4), or a deal that is agreed or has expired (deal= refuses those).
// The dormancy family (`dormancy`, always the open network): B is a house sandbox agent (the server runs it: in
// sandboxIds, never renewed, and with circulating credit what it owes dormant participants does not count against its
// limit) or self-serve in one of selfServe's states, C is self-serve in one of them, and D is sometimes dormant (its agent
// never acts at the step, so what a house B owes it stays left out). A dormant C never has many offers of its own open (a
// lifted twin keeps its dormancy, lift). Without `dormancy` every draw is as it was.
function world(seed, {dormancy = false} = {}) {
  const r0 = rng(seed), mode = r0.chance(0.85) ? 'on' : 'off', openNetwork = r0.chance(0.5) || dormancy;
  const w = builder({seed: seed * 7919 + 1, mode, openNetwork}), {r, t, circ} = w;
  const D = w.person('d-other'), E = w.person('e-other'), G = w.person('g-backer'), H = w.person('h-backer'), S = w.person('s-sandbox');
  const B = w.person('b-payer'), C = w.person('c-payee');
  w.sandboxIds.push(S.id, ...(!openNetwork && r.chance(0.25) ? [C.id] : []));
  const bState = dormancy ? r.pick(['house', 'house', 'house', 'dormant', 'dormant', 'renewing', 'owner_earlier', 'dormant_owner_earlier', 'plain']) : null;
  const cState = dormancy ? r.pick(['dormant', 'dormant', 'dormant', 'renewing', 'owner_earlier', 'dormant_owner_earlier', 'plain']) : null;
  if (bState === 'house') w.sandboxIds.push(B.id);
  if (dormancy && r.chance(0.4)) w.selfServe(D, 'dormant');
  // A calm world (about 40%): both sides deal with anyone, their mandates run, their per-deal limits are wide, so most of
  // its cases get past every refusal to the owners and the agreement.
  const calm = r.chance(0.4), bBox0 = r.chance(0.3), cBox0 = r.chance(0.25);
  const bBox = dormancy ? !['house', 'plain'].includes(bState) : bBox0, cBox = dormancy ? cState !== 'plain' : cBox0;
  Object.assign(B.mandate, {may_issue_credit: calm || r.chance(0.95), max_issue_per_deal: bBox ? r.pick([3, 5]) : calm ? 20 : r.pick([3, 5, 8, 20]),
    max_issue_outstanding: bBox ? r.pick([10, 20, 40]) : calm ? 100 : r.pick([6, 10, 20, 40, 100]), approve_above: r.pick([0, 0, 1e9, 1e9, 2, 4]),
    counterparties: bBox ? (openNetwork ? 'any' : [...w.sandboxIds]) : calm || r.chance(0.75) ? 'any' : r.pick([[C.id, D.id], [D.id, E.id]]),
    expires_at: iso(calm || r.chance(0.94) ? t + 6 * DAY : t - HOUR)});
  if (bBox) (dormancy ? w.selfServe(B, bState) : w.boxed(B));
  if (r.chance(0.15)) B.agent_limits = {max_issue_per_deal: r.pick([1, 2, 3])};
  Object.assign(C.mandate, {may_accept_credit: calm || r.chance(0.95), max_accept_per_deal: calm ? 20 : r.pick([3, 5, 8, 20]),
    max_accept_per_issuer: calm ? 100 : r.pick([6, 10, 20, 40, 100]), min_price_as_payee: calm ? 0 : r.pick([0, 0, 0, 2]),
    min_payer_coverage_pct: calm ? r.pick([0, 0, 0, 30]) : r.pick([0, 0, 30, 50, 100]), approve_above: r.pick([0, 0, 1e9, 1e9, 2, 4]),
    counterparties: cBox ? (openNetwork ? 'any' : [...w.sandboxIds]) : calm || r.chance(0.8) ? 'any' : r.pick([[B.id, D.id], [D.id]]),
    expires_at: iso(calm || r.chance(0.95) ? t + 6 * DAY : t - HOUR),
    ...(circ ? {accept_notes_from: r.pick(['any', [G.id], [G.id, D.id], [B.id], []]), refuse_notes_from: !calm && r.chance(0.05) ? [B.id] : [],
      ...(!calm && r.chance(0.3) ? {max_claims_total: r.pick([10, 30])} : {}), ...(!calm && r.chance(0.3) ? {max_issuer_net_debt: r.pick([3, 10, 30])} : {})} : {})});
  if (cBox) (dormancy ? w.selfServe(C, cState) : w.boxed(C));
  if (r.chance(0.15)) C.agent_limits = r.chance(0.5) ? {max_accept_per_deal: r.pick([2, 4])} : {min_payer_coverage_pct: r.pick([40, 80])};
  if (r.chance(0.04)) w.keyless(B);
  if (r.chance(0.05)) w.keyless(C);
  const keyed = x => !!x.pubkey, others = [D, E, G, H, S, ...(keyed(C) ? [C] : [])];
  // The tracker: what B owes and holds, what the backers hold and owe (their grounded worth), what C holds.
  w.owe(B, D, r.int(0, 14)); w.owe(B, C, r.int(0, 8)); w.owe(D, B, r.int(0, 10)); w.owe(E, B, r.int(0, 6)); w.owe(B, E, r.int(0, 4));
  w.owe(G, D, r.int(0, 10)); w.owe(D, G, r.int(0, 12)); w.owe(E, H, r.int(0, 10)); w.owe(H, E, r.int(0, 6)); w.owe(D, C, r.int(0, 8)); w.owe(C, D, r.int(0, 5));
  if (keyed(B)) {
    for (let i = r.int(0, 2); i > 0; i--) w.deal(B, r.pick(others), B, r.int(1, 4), r.pick(['agreed', 'agreed', 'delivered']));     // committed
    const own = bBox && openNetwork && r.chance(0.5) ? r.int(OPEN_NETWORK_MAX_OPEN_OFFERS - 2, OPEN_NETWORK_MAX_OPEN_OFFERS + 1) : r.int(0, 2);
    for (let i = 0; i < own; i++) w.deal(B, r.pick(others), B, r.int(1, 3), r.chance(0.85) ? 'open' : 'proposed_awaiting_owner');   // its own offers: reserved
    if (r.chance(0.3)) w.deal(B, D, D, r.int(1, 4), 'open');                                         // D's offer to B: not B's to count
    if (r.chance(0.15)) w.counter(w.deal(B, E, E, r.int(1, 4), 'open'), B, r.int(1, 4));            // B's counter, waiting for its owner
    if (r.chance(0.1)) w.deal(B, D, B, r.int(1, 3), 'open', {exp: t - HOUR});                         // expired: swept, counts nothing
  }
  if (keyed(C)) {
    if (r.chance(0.4)) w.deal(D, C, D, r.int(1, 5), 'agreed');                                       // C's claims (max_claims_total)
    if (cBox && openNetwork && r.chance(0.5) && !/^dormant/.test(cState ?? ''))                      // C's own offers (C proposing)
      for (let i = r.int(OPEN_NETWORK_MAX_OPEN_OFFERS - 2, OPEN_NETWORK_MAX_OPEN_OFFERS + 1); i > 0; i--) w.deal(r.pick([D, E, G]), C, C, r.int(1, 3), 'open');
  }
  let review = null;
  if (keyed(B) && keyed(C) && r.chance(0.75)) {
    const kind = r.pick(['E1', 'E1', 'E2', 'E2', 'E3', 'E4', 'E4', 'E4', 'agreed', 'expired']), price = r.int(1, 10);
    if (kind === 'E1') {
      review = w.deal(B, C, B, price, 'open');
      if (r.chance(0.5)) w.ownerApproved(review, B, review.versions[0]);
      if (r.chance(0.12)) w.counter(review, C, r.int(1, 10));
    } else if (kind === 'E2') {
      if (r.chance(0.5)) review = w.deal(B, C, C, price, 'open');
      else { review = w.deal(B, C, B, r.int(1, 10), 'open'); w.countered(review, C, price); }
      if (r.chance(0.5)) w.ownerApproved(review, C, review.versions.at(-1));
      if (r.chance(0.12)) w.counter(review, B, r.int(1, 10));
    } else if (kind === 'E3') review = w.deal(B, C, C, price, 'proposed_awaiting_owner');
    else if (kind === 'E4') {
      const X = r.chance(0.5) ? B : C, accHold = r.chance(0.7), propHold = !accHold || r.chance(0.4);
      review = w.deal(B, C, X, price, 'open');
      if (!propHold && r.chance(0.5)) w.ownerApproved(review, X, review.versions[0]);
      w.held(review, {accHold, accApproved: !accHold && r.chance(0.5), propHold});
    } else if (kind === 'agreed') review = w.deal(B, C, r.pick([B, C]), price, 'agreed');
    else review = w.deal(B, C, B, price, 'open', {exp: t - HOUR});
  }
  if (circ) {
    if (keyed(B) && keyed(C)) for (let i = r.int(0, 2); i > 0; i--) {
      const dealMode = review && r.chance(0.3);
      w.guarantee(r.pick([G, H, D]), B, C, r.int(1, 10), {expires: t + r.pick([2 * HOUR, DAY, 5 * DAY, 20 * DAY, 40 * DAY]), claimed: r.chance(0.2) ? r.int(1, 3) : 0,
        ...(dealMode ? {covers: 'issuer_payment_for_deals', deals: [review.id]} : {}), state: r.chance(0.9) ? 'active' : 'expired'});
    }
    if (keyed(B) && r.chance(0.3)) w.guarantee(B, E, D, r.int(1, 8));          // B backs E's debt to D: its open cap counts against B's outstanding
    if (keyed(B) && keyed(C) && r.chance(0.2)) w.guarantee(B, D, C, r.int(1, 6));   // B backs D's debt to C: what C may come to hold on B
  }
  // Fix inbox #79 (drawn last, so every other world is as it was): two or three guarantees naming the offer under
  // review, caps from its price up, most callable past its deliver_by; more debt on the pair (agreed deals between B
  // and C); C's bar drawn again, its owner mostly trusting their backers. What they count for the offer (its price
  // once, oldest first) and what the coverage rule counted before (each open cap, held only by B's whole debt to C) are
  // far apart, so C's bar often sits between the two (runCase drives C's step under both rules).
  const offer = review && statusClass(review.status)?.offer_phase && Date.parse(review.versions.at(-1).terms.offer_expires_at) > t ? review : null;
  if (circ && offer && r.chance(0.5)) {
    const v = offer.versions.at(-1), price = v.terms.price.amount, due = Date.parse(v.terms.deliver_by), backers = [];
    for (let i = r.int(1, 2); i > 0; i--) w.deal(B, C, r.pick([B, C]), r.int(2, 5), 'agreed');
    for (let i = r.int(2, 3); i > 0; i--) {
      const K = r.pick([G, G, H, D]);
      backers.push(K.id);
      w.guarantee(K, B, C, r.int(price, 2 * price + 2), {covers: 'issuer_payment_for_deals', deals: [offer.id], expires: due + (r.chance(0.85) ? r.pick([2 * HOUR, DAY, 5 * DAY]) : 0)});
    }
    if (r.chance(0.75)) C.mandate.accept_notes_from = [...new Set(backers)];
    C.mandate.min_payer_coverage_pct = r.pick([10, 15, 20, 25, 30, 40]);
  }
  return {...w.done(B, C, review), states: {payer: bState, payee: cState}};
}

// ---------- the live pilot, and twins ----------
// A store that writes nothing: audit entries are kept in memory (the twins' refusals are read from them).
const memStore = state => ({state, dir: null, audits: [], save() {}, audit(e) { this.audits.push(e); },
  appendEdgeLog() { throw new Error('this store keeps no edge log'); }, secret() { throw new Error('this store keeps no secret'); }});
const pilotOver = (W, store, basis) => {
  const p = new Pilot({store, basis, now: () => W.t, circulation: W.mode, trackerCaps: V3_CAPS, trackerSha256: PIN, trackerPins: [PIN], openNetwork: W.openNetwork, log: () => {}});
  p.sandboxIds = new Set(W.sandboxIds);
  return p;
};
// The pilot the checks ask: its tracker's notes are the world's, and its stub verifies no signature at all.
function livePilot(W, store = memStore(clone(W.state))) {
  return pilotOver(W, store, {nft: NFT, denomination: PILOT_DENOMINATION, allNotes: async () => W.notes, capabilities: async () => V3_CAPS,
    note: async (i, r) => W.notes.find(n => n.issuer_pubkey === i && n.recipient_pubkey === r) ?? null, verify: async () => false});
}
// A twin's tracker: the world's notes, pinned (its own copy), read only. Any member the decision paths do not read (api,
// issueNote, transfer, setoff, proof, refresh, noteMessage, ...) throws speculative_write, so nothing a twin does can
// reach a tracker. Only here does verify accept every signature.
function closedBasis(notes) {
  const pinned = clone(notes);
  const allowed = Object.freeze({nft: NFT, denomination: PILOT_DENOMINATION, allNotes: async () => pinned, reserves: async () => [], capabilities: async () => V3_CAPS,
    note: async (i, r) => pinned.find(n => n.issuer_pubkey === i && n.recipient_pubkey === r) ?? null, verify: async () => true});
  return new Proxy(allowed, {get(target, k) {
    if (typeof k === 'symbol' || Object.hasOwn(target, k)) return target[k];
    throw new PilotError('speculative_write', `a twin sends nothing to a tracker (basis.${String(k)})`, 409);
  }});
}
// One side's limits lifted (its mandate allows everything and never waits for its owner; it is no self-serve
// participant, so no box and no open-offer limit; its own counter-offer waiting for its owner is gone), its key kept.
// `keepDormancy` (the payee, lifted for the payer's side): a dormant self-serve payee stays one (sandbox_only and its
// ended sandbox time kept, on the open network only, where no box applies; world() gives it no run of open offers of its
// own), so what a house sandbox agent payer owes it is left out until its agent acts, as in the world it lifts.
function lift(state, id, {keepDormancy = false} = {}) {
  const p = state.participants[id];
  Object.assign(p.mandate, {may_issue_credit: true, may_accept_credit: true, max_issue_per_deal: BIG, max_issue_outstanding: BIG, max_accept_per_deal: BIG, max_accept_per_issuer: BIG,
    min_price_as_payee: 0, min_payer_coverage_pct: 0, counterparties: 'any', approve_above: BIG, expires_at: iso(T + 20 * DAY), refuse_notes_from: [], accept_operator_issuers: true,
    max_claims_total: null, max_issuer_net_debt: null});
  delete p.agent_limits;
  if (!(keepDormancy && p.sandbox_only && Date.parse(p.sandbox_expires_at) < T)) { delete p.sandbox_only; delete p.sandbox_expires_at; }
  for (const d of Object.values(state.deals)) if (d.pending_counter?.by === id) { state.approvals[d.pending_counter.approval_id].state = 'void_withdrawn'; d.pending_counter = null; }
}
// A fresh Pilot over a JSON clone of `base` (the world's state, or the live pilot's after the check's own requests;
// `lifted`: the participant whose limits are lifted), no listeners, no clearing, no server signer.
function twin(W, lifted = null, base = W.state) {
  const state = clone(base);
  if (lifted) lift(state, lifted, {keepDormancy: W.openNetwork && lifted === W.payee});
  const store = memStore(state), pilot = pilotOver(W, store, closedBasis(W.notes));
  assert.equal(Object.getPrototypeOf(pilot), Pilot.prototype);
  assert.ok(pilot.changeListeners.size === 0 && pilot.clearing === undefined && pilot.serverSigner === undefined);
  return {pilot, store};
}
// Fix inbox #79: a twin whose coverage rule counts as it did before: every active guarantee that backs the deal and
// can still be called an hour after its deliver_by counted its whole open cap (its cap less what its own calls
// claimed), the deal-mode ones of the deal included, and only the debt with the deal held their sum. All else is the
// server's own.
function ruleBefore79(tw) {
  const book = tw.pilot.guarantees;
  book.stepCover = (gs, {dealId = null, debtFrom = null} = {}) => new Map(gs.map(g => [g.id,
    g.state === 'active' && book.backsDeal(g, dealId) && book.lasts(g, debtFrom) ? Math.max(0, g.terms.cap.amount - book.claimed(g)) : 0]));
  return tw;
}
// Fix inbox #79: the coverage rule's entry (min_payer_coverage_pct: the guarantees it counts, backing_for_you) for the
// step a case is about, with that step's deal id and deliver_by, on a twin of the state the check answered on whose
// payee's limits are lifted but for a bar of 1%, so that the rule runs and shows its figures; null when even that
// refuses (the payer is covered 0%).
async function coverageAtStep(W, S, c) {
  const {pilot} = twin(W, W.payee, S), C = pilot.s.participants[W.payee], d = c.kind === 'deal' ? pilot.s.deals[c.id] : null;
  C.mandate.min_payer_coverage_pct = 1;
  const at = d ? {excludeDealId: d.id, dealId: d.id, debtFrom: Date.parse(pilot.current(d).terms.deliver_by)} : {dealId: c.dealId, debtFrom: c.due};
  try { return (await pilot.checkMandate(C, 'payee', W.payer, c.amount, at)).checks.find(x => x.rule === 'min_payer_coverage_pct'); }
  catch (e) { if (e instanceof PilotError && e.code === 'mandate_exceeded' && e.extra.rule === 'min_payer_coverage_pct') return null; throw e; }
}

// The check, through its route as a client sends it (the payee's token, or none).
async function ask(routes, W, query, token = null) {
  const req = {method: 'GET', headers: token ? {authorization: `Bearer ${token}`} : {}, socket: {remoteAddress: '127.0.0.1'}};
  let out = null;
  const send = (_res, status, body) => { out = {status, body: typeof body === 'string' ? JSON.parse(body) : body}; };
  try { await routes(req, {}, new URL(`http://oracle/pilot/v1/participants/${W.payer}/check?${query}`), send, () => '127.0.0.1'); }
  catch (e) { if (!(e instanceof PilotError)) throw e; out = {status: e.status, body: {error: e.code, message: e.message, ...(e.extra?.rule ? {rule: e.extra.rule} : {})}}; }
  return out;
}
const routesFor = pilot => createPilotRoutes({pilot, cfg: {pilotRateLimitPerMinute: 1e9, pilotReadLimitPerMinute: 1e9}});

// The terms of the new deal a case is about (each twin its own copy).
const newTerms = (W, c, proposer) => {
  const B = W.state.participants[W.payer], C = W.state.participants[W.payee];
  return {protocol: PROTOCOL, network: NETWORK, tracker_nft_id: NFT, denomination: PILOT_DENOMINATION, deal_id: c.dealId, version: 1, prior_terms_hash: null, nonce: c.nonce,
    proposer, payer: {id: B.id, pubkey: B.pubkey}, payee: {id: C.id, pubkey: C.pubkey}, service: {title: 'a job', description: 'synthetic', deliverable: 'text'},
    price: {amount: c.amount, unit: UNIT}, consideration: 'credit_note_on_delivery_accepted', offer_expires_at: iso(c.exp), deliver_by: iso(c.due)};
};

// The real steps on a twin, each one approved, until the deal is agreed or a step is refused: the proposal (a new deal),
// a withdrawal first when asked (`withdraw`: that party withdraws its own counter-offer), then accept by the side whose
// turn it is, or the decision of the owner the deal waits for (its first pending approval). Each step is authenticated
// first, as its route does it: the actor's agent token for a proposal, withdrawal or acceptance (a self-serve participant
// on the open network is renewed then), its owner's token for a decision. Returns {outcome: 'agreed', asked: the sides
// whose owner decided} or {outcome: 'refused', side, rule} (side 'terms': no terms can be made), the rule of a
// counterparty's refusal read from the twin's audit entry, which the server keeps from the actor. `proposeOnly`: stop
// after the proposal ({outcome: 'proposed'} when it was taken).
async function drive({pilot, store}, W, start, {proposeOnly = false} = {}) {
  const P = id => pilot.s.participants[id], side = id => (id === W.payer ? 'payer' : id === W.payee ? 'payee' : id);
  const agent = id => { pilot.authenticate(W.tokens[id].agent); return P(id); }, owner = id => { pilot.authenticate(W.tokens[id].owner); return P(id); };
  const asked = new Set(), id = start.deal ?? start.terms.deal_id;
  let actor = start.by ?? start.withdraw ?? null;
  try {
    if (start.withdraw) await pilot.withdraw(agent(actor), id, {terms_hash: pilot.s.deals[id].pending_counter.terms_hash, signature: SIG});
    if (start.terms) await pilot.propose(agent(actor), {terms: start.terms, signature: SIG});
    if (proposeOnly) return {outcome: 'proposed'};
    for (let step = 0; step < 6; step++) {
      const d = pilot.sweep(pilot.s.deals[id]), v = pilot.current(d);
      if (d.status === 'agreed') return {outcome: 'agreed', asked: [...asked].sort()};
      if (d.status === 'open') {
        actor = v.by === W.payer ? W.payee : W.payer;
        await pilot.accept(agent(actor), id, {terms_hash: v.terms_hash, signature: SIG});
        continue;
      }
      const a = Object.values(pilot.s.approvals).find(x => x.deal_id === id && x.state === 'pending'
        && (d.status === 'proposed_awaiting_owner' ? x.kind === 'propose' : x.kind === 'accept' || x.kind === 'confirm_offer'));
      if (!a) return {outcome: 'error', status: d.status};
      actor = a.participant; asked.add(side(actor));
      await pilot.decideApproval(owner(actor), a.id, {decision: 'approve'});
    }
    return {outcome: 'error', why: 'the steps did not end'};
  } catch (e) {
    if (!(e instanceof PilotError)) throw e;
    const audited = type => store.audits.findLast(x => x.type === type);
    switch (e.code) {
      case 'mandate_exceeded': return {outcome: 'refused', side: side(actor), rule: e.extra.rule};
      case 'too_many_open_offers': case 'counter_pending': return {outcome: 'refused', side: side(actor), rule: e.code};
      case 'offer_not_authorized': { const x = audited('deal.accept_refused_proposer_mandate'); return {outcome: 'refused', side: side(x.proposer), rule: x.rule}; }
      case 'acceptance_not_authorized': { const x = audited('deal.confirm_refused_acceptor_mandate'); return {outcome: 'refused', side: side(x.acceptor), rule: x.rule}; }
      case 'invalid_terms': return {outcome: 'refused', side: 'terms', rule: /^payer must be an active/.test(e.message) ? 'no_agent'
        : /^payee must be an active/.test(e.message) ? 'payee_no_key' : /^price must be/.test(e.message) ? 'network_limit' : `invalid_terms: ${e.message}`};
      default: return {outcome: 'error', code: e.code, message: e.message};
    }
  }
}

// The order in which the first steps check the two sides: a proposal checks its proposer only, and the other side's
// acceptance then checks the acceptor before it re-checks the proposer; an owner's decision checks its own side before
// the other (the first pending approval decides first). `S`: the state the check answered on.
function orderOf(W, c, S) {
  if (c.kind === 'new') return c.path === 'payer_proposes' ? ['payer', 'payee'] : ['payee', 'payer'];
  const d = S.deals[c.id], v = d.versions.at(-1);
  if (d.status === 'open') return v.by === W.payer ? ['payee', 'payer'] : ['payer', 'payee'];
  if (d.status === 'proposed_awaiting_owner') return ['payee', 'payer'];
  const first = Object.values(S.approvals).find(a => a.deal_id === d.id && a.state === 'pending' && (a.kind === 'accept' || a.kind === 'confirm_offer'));
  return first.participant === W.payer ? ['payer', 'payee'] : ['payee', 'payer'];
}
// What the answer says the real steps do: the first refusal in that order (a side's decline and its rule), or the
// agreement with the owners its ask_owner verdicts name. P: the payer's {verdict, rule}; Q: payee_side.
function expected(order, P, Q) {
  if (PRE.has(P.rule)) return {outcome: 'refused', side: 'terms', rule: P.rule};
  for (const s of order) { const x = s === 'payer' ? P : Q; if (x.verdict === 'decline') return {outcome: 'refused', side: s, rule: x.rule}; }
  return {outcome: 'agreed', asked: [...(Q.verdict === 'ask_owner' ? ['payee'] : []), ...(P.verdict === 'ask_owner' ? ['payer'] : [])]};
}
// The same for one side, the other side's limits lifted (it never refuses; its owner, when asked, is not counted).
const expectedSide = (X, s, P) => (PRE.has(P.rule) ? {outcome: 'refused', side: 'terms', rule: P.rule}
  : X.verdict === 'decline' ? {outcome: 'refused', side: s, rule: X.rule} : {outcome: 'agreed', asked: X.verdict === 'ask_owner' ? [s] : []});
const sideOnly = (res, s) => (res.outcome === 'agreed' ? {...res, asked: res.asked.filter(x => x === s)} : res);
// Fix inbox #87: the step's one verdict, as the real steps give it: refused is decline with its rule; agreed is ask_owner
// when an owner was asked, else accept.
const stepVerdict = res => (res.outcome === 'refused' ? {verdict: 'decline', rule: res.rule}
  : res.outcome === 'agreed' ? (res.asked.length ? {verdict: 'ask_owner', rule: 'approve_above'} : {verdict: 'accept', rule: null}) : {verdict: null, rule: res});

// The payer's counter-offer on the payee's offer, waiting for the payer's owner, is the payer's alone (Pilot.view): the
// payee's answer on that offer (A, asked with `token` on state S) must be what it is in a world where the same amount is
// reserved elsewhere instead (an open offer of the payer's to a third participant at the counter's price, which the
// card counts the same way), but for one bit: the verdict leaves the counter out (the answer is for the deal once the
// payer withdraws it), so it may accept where that world declines over the budget. Returns 'same' or 'one bit'.
async function counterPrivate(W, S, c, token, A) {
  const S2 = clone(S), v = S2.deals[c.id].pending_counter;
  S2.approvals[v.approval_id].state = 'void_withdrawn'; S2.deals[c.id].pending_counter = null;
  const other = Object.values(S2.participants).find(x => x.id !== W.payer && x.id !== W.payee && x.pubkey);
  const id = 'vd_' + sha(c.id).slice(0, 16), terms = {...clone(v.terms), deal_id: id, version: 1, prior_terms_hash: null, proposer: W.payer, payee: {id: other.id, pubkey: other.pubkey}};
  S2.deals[id] = {id, payer: W.payer, payee: other.id, created_at: v.created_at, status: 'open', history: [],
    versions: [{v: 1, by: W.payer, terms, terms_hash: termsHash(terms), signature: v.signature, created_at: v.created_at, state: 'open', mandate_check: {checks: []}, offered_at: v.created_at}]};
  const W2 = {...W, state: S2}, A2 = (await ask(routesFor(livePilot(W2)), W2, `amount=${c.amount}&payee=${W.payee}&deal=${c.id}`, token)).body;
  const seen = x => ({verdict: x.verdict, rule: x.rule, reasons: x.reasons, room_left: x.room_left, approval_needed: x.approval_needed, mandate: x.mandate, cover: x.cover,
    record: x.record, card_hash: x.card_hash, payer_side: x.payer_side, payee_side: x.payee_side, deal_id: x.deal_id});
  const where = `the payer's private counter: ${JSON.stringify(c)} ${JSON.stringify(A)} vs the same amount reserved elsewhere ${JSON.stringify(A2)}`;
  if (A2.payer_side.verdict === A.payer_side.verdict) { assert.deepEqual(seen(A), seen(A2), where); return 'same'; }
  assert.deepEqual([A.payer_side.verdict !== 'decline', A2.payer_side.verdict, A2.payer_side.rule], [true, 'decline', 'max_issue_outstanding'], where);
  return 'one bit';
}

// One case on one world: the payee's own check, the public check (a new deal), and the three twins, which start from
// the state the check answered on (the live pilot's after those requests). Returns what it saw (for the tallies and the
// named regressions); every comparison is asserted here.
async function runCase(W, live, c) {
  const routes = routesFor(live), C = W.state.participants[W.payee], token = C.agent_token_hash && !c.ownerToken ? W.tokens[W.payee].agent : W.tokens[W.payee].owner;
  const q = c.kind === 'deal' ? `amount=${c.amount}&payee=${W.payee}&deal=${c.id}` : `amount=${c.amount}&payee=${W.payee}${c.explicit ? `&path=${c.path}` : ''}`;
  const mine = await ask(routes, W, c.kind === 'new' ? `${q}&deliver_by=${encodeURIComponent(iso(c.due))}` : q, token);
  const where = `case ${JSON.stringify(c)} answer ${JSON.stringify(mine.body)}`;
  const S = live.s;
  if (c.kind === 'deal' && mine.status === 409) {
    // deal= answers only for an offer still in its offer phase; the twin agrees that this one has ended or is agreed.
    assert.equal(mine.body.error, 'wrong_state', where);
    const {pilot} = twin(W, null, S);
    assert.equal(statusClass(pilot.sweep(pilot.s.deals[c.id]).status).offer_phase, false, where);
    return {answer: null};
  }
  assert.equal(mine.status, 200, where);
  const A = mine.body, P = A.payer_side, Q = A.payee_side;
  for (const X of [P, Q]) assert.ok(X && ['accept', 'ask_owner', 'decline'].includes(X.verdict) && Array.isArray(X.reasons) && X.reasons.length > 0, where);
  assert.equal(A.approval_needed, A.verdict === 'ask_owner', where);
  assert.equal('path' in A, c.kind === 'new' && !!c.explicit, where);
  // The step's reasons: both sides in a few words, then the payer's side's own; the payee's own stay in payee_side.
  assert.deepEqual(A.reasons.slice(1, 1 + P.reasons.length), P.reasons, where);
  assert.ok(!A.reasons.some(x => Q.reasons.includes(x)), where);
  if (c.kind === 'new') {
    // The public answer: the payer's side, the same for everyone, saying the payee's own limits were not checked; the
    // payee's side and cover are not in it.
    const pub = await ask(routes, W, q);
    assert.equal(pub.status, 200, where);
    assert.deepEqual([pub.body.verdict, pub.body.rule, pub.body.payer_side, pub.body.reasons], [P.verdict, P.rule, P, [...P.reasons, PAYEE_NOT_CHECKED]], where);
    assert.ok(!('payee_side' in pub.body) && !('counted_offers' in pub.body) && pub.body.cover.covered === null && pub.body.cover.for_other_deals === null, where);
  }
  const start = () => (c.kind === 'deal' ? {deal: c.id} : {by: c.path === 'payer_proposes' ? W.payer : W.payee, terms: newTerms(W, c, c.path === 'payer_proposes' ? W.payer : W.payee)});
  let order = orderOf(W, c, S);
  // When both sides decline a deal the payer proposes, whose refusal comes first depends on where the payer's comes: at
  // its proposal, or only at its re-check once the payee's agent accepts (what a house sandbox agent owes a dormant payee
  // counts from then on). The proposal alone, on a twin, says which; the full twin then shows the refusal it predicts.
  if (c.kind === 'new' && c.path === 'payer_proposes' && P.verdict === 'decline' && Q.verdict === 'decline' && !PRE.has(P.rule)
    && (await drive(twin(W, null, S), W, start(), {proposeOnly: true})).outcome === 'proposed') order = ['payee', 'payer'];
  const full = await drive(twin(W, null, S), W, start());
  const payerSide = await drive(twin(W, W.payee, S), W, start()), payeeSide = await drive(twin(W, W.payer, S), W, start());
  // The payer's own counter-offer on the payee's offer, still waiting for the payer's owner, is private to the payer:
  // the check answers as if it were withdrawn (the payer's agent must withdraw it before it accepts), and accepting
  // before that is refused (counter_pending). The twins show both, and the answer gives away no more than one bit of it.
  const payerCounter = c.kind === 'deal' && S.deals[c.id].pending_counter?.by === W.payer;
  let privacy = null;
  // The step the answer is for: the world as it is, or, with the payer's own counter-offer pending, once its agent
  // withdraws it (as it must before it accepts).
  let step = full;
  if (payerCounter) {
    assert.deepEqual(full, {outcome: 'refused', side: 'payer', rule: 'counter_pending'}, `the world as it is: ${where}`);
    assert.deepEqual(payerSide, {outcome: 'refused', side: 'payer', rule: 'counter_pending'}, `the payer's side: ${where}`);
    step = await drive(twin(W, null, S), W, {deal: c.id, withdraw: W.payer});
    assert.deepEqual(step, expected(order, P, Q), `withdrawn first: ${where}`);
    privacy = await counterPrivate(W, S, c, token, A);
  } else {
    assert.deepEqual(full, expected(order, P, Q), `the world as it is: ${where}`);
    assert.deepEqual(sideOnly(payerSide, 'payer'), expectedSide(P, 'payer', P), `the payer's side, the payee's limits lifted: ${where}`);
  }
  assert.deepEqual(sideOnly(payeeSide, 'payee'), expectedSide(Q, 'payee', P), `the payee's side, the payer's limits lifted: ${where}`);
  // Fix inbox #79: the coverage rule at the step counts the guarantees the check's cover counts, each as the cover
  // does: the same ones (for_this_deal above 0), and no more in all than covered (it counts them at their backers'
  // grounded worth, and no more than the debt with the deal).
  let coverage = null;
  if (A.cover.guarantees.length) {
    const rule = await coverageAtStep(W, S, c);
    coverage = rule ? 'compared' : 'refused at 1%';
    if (rule) assert.deepEqual([rule.guarantees ?? [], (rule.backing_for_you ?? 0) <= A.cover.covered], [A.cover.guarantees.filter(g => g.for_this_deal > 0).map(g => g.guarantee_id), true],
      `fix inbox #79, the coverage rule at the step ${JSON.stringify(rule)}: ${where}`);
  }
  // Fix inbox #79: for an offer that guarantees name, the payee's step again under the rule as it was before. Where the
  // two differ, the payee's bar sits between the two figures, and only the payee's coverage verdict differs: one of
  // the two refuses for it, the other does not. Mostly the rule now refuses where the rule before took the offer (it
  // counted those guarantees' open caps). The other way: where the debt with the deal held the sum, the rule before
  // scaled it by the worth of every open cap, those that add nothing for the offer included, so a worthless backer's
  // cap could dilute a sound backer's share; the rule now counts that share at its own backer's worth.
  let before79 = null;
  if (c.kind === 'deal' && Object.values(S.guarantees ?? {}).some(g => g.issuer === W.payer && g.creditor === W.payee && (g.terms.deals ?? []).includes(c.id))) {
    before79 = await drive(ruleBefore79(twin(W, W.payer, S)), W, start());
    const coverageRefusal = x => x.outcome === 'refused' && x.side === 'payee' && x.rule === 'min_payer_coverage_pct';
    if (!isDeepStrictEqual(before79, payeeSide))
      assert.deepEqual([coverageRefusal(payeeSide), coverageRefusal(before79)].sort(), [false, true], `fix inbox #79, the rule before: ${JSON.stringify(before79)}: ${where}`);
  }
  // Fix inbox #87: the step's one verdict is what the real steps do, both sides together.
  assert.deepEqual({verdict: A.verdict, rule: A.rule}, stepVerdict(step), `the step's verdict: ${where}`);
  // Fix inbox #87: the same world, its payer's card not published. The payee's own check answers for its own side (the
  // same as above), the payer's side unknown, and the step declined exactly when the payee's side declines (the real step
  // is then refused); anyone else's check is 404 card_not_public.
  const W0 = {...W, state: clone(W.state)};
  W0.state.participants[W.payer].mandate.public_card = false;
  const routes0 = routesFor(livePilot(W0)), unpub = await ask(routes0, W0, c.kind === 'new' ? `${q}&deliver_by=${encodeURIComponent(iso(c.due))}` : q, token);
  const where0 = `the card not published: ${JSON.stringify(unpub.body)} ${where}`, U = unpub.body;
  assert.equal(unpub.status, 200, where0);
  assert.deepEqual([U.payee_side.verdict, U.payee_side.rule, U.payee_side.reasons.length], [Q.verdict, Q.rule, 1], where0);
  assert.deepEqual([U.verdict, U.rule, U.approval_needed], Q.verdict === 'decline' ? ['decline', Q.rule, false] : ['unknown', null, false], where0);
  assert.equal(U.reasons.at(-1), PAYER_NOT_PUBLISHED, where0);
  // None of the payer's figures (the review of #87): nothing of its card or room, no cover or record, and words with no
  // number but the payee's own coverage bar and the open-offer limit.
  assert.deepEqual([U.payer_side, U.mandate, U.room_left, U.card_hash, U.record, U.cover, 'counted_offers' in U, U.deal_id],
    [null, null, null, null, null, {covered: null, for_other_deals: null, guarantees: []}, false, A.deal_id], where0);
  assert.doesNotMatch([...U.reasons, ...U.payee_side.reasons].join(' ').replace(/\(min_payer_coverage_pct, \d+%\)/, '').replace(`(${OPEN_NETWORK_MAX_OPEN_OFFERS})`, ''), /\d/, where0);
  if (U.verdict === 'decline') assert.equal(full.outcome, 'refused', where0);
  if (c.kind === 'new') for (const t of [null, W.tokens[W.payer].agent]) assert.deepEqual([(await ask(routes0, W0, q, t)).body.error], ['card_not_public'], where0);
  return {answer: A, full, payerSide, payeeSide, payerCounter, privacy, order, unpublished: U, coverage, before79};
}

// The cases of a world: a new deal on each path (the default path asked as such or by name), at a drawn amount, deliver_by
// and offer expiry; and the offer under review, when the world has one.
function casesOf(W, seed) {
  const r = rng(seed ^ 0x5bd1e995), out = [];
  for (const path of ['payer_proposes', 'payee_proposes']) {
    const due = W.t + r.int(2, 30 * 24 - 1) * HOUR, exp = Math.min(due, W.t + r.int(1, 7 * 24) * HOUR);
    out.push({kind: 'new', path, explicit: path === 'payee_proposes' || r.chance(0.3), amount: r.chance(0.03) ? 1001 : r.pick([1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 12]), due, exp,
      dealId: 'vd_' + r.hex(8), nonce: r.hex(16), ownerToken: r.chance(0.3)});
  }
  if (W.review) out.push({kind: 'deal', id: W.review, amount: W.state.deals[W.review].versions.at(-1).terms.price.amount, ownerToken: r.chance(0.3)});
  return out;
}

const SEEDS = Array.from({length: 12}, (_, i) => 1000 + i * 101);
const WORLDS = Number(process.env.ORACLE_WORLDS) > 0 ? Number(process.env.ORACLE_WORLDS) : 75;
// The dormancy family's seeds (world(seed, {dormancy: true})), as many worlds a seed.
const DORMANCY_SEEDS = Array.from({length: 6}, (_, i) => 5000 + i * 113);

// Every case of every world of `seeds` through runCase, each on a fresh live pilot over the world (a check sent with the
// payee's agent token renews it, as any request of its agent does); `tally(W, c, got, count)` adds what a family counts.
async function oracle(seeds, {dormancy = false, tally = () => {}} = {}) {
  const seen = new Map(), count = k => seen.set(k, (seen.get(k) ?? 0) + 1);
  let cases = 0;
  for (const s of seeds) for (let i = 0; i < WORLDS; i++) {
    const seed = s * 1000 + i, W = world(seed, {dormancy});
    for (const c of casesOf(W, seed)) {
      const got = await runCase(W, livePilot(W), c);
      cases += 1;
      if (!got.answer) { count('deal: refused (ended or agreed)'); continue; }
      const kind = c.kind === 'deal' ? `deal ${W.state.deals[c.id].status}` : c.path;
      count(`${kind}: payer ${got.answer.payer_side.verdict}${got.answer.payer_side.rule ? ` ${got.answer.payer_side.rule}` : ''}`);
      count(`${kind}: payee ${got.answer.payee_side.verdict}${got.answer.payee_side.rule ? ` ${got.answer.payee_side.rule}` : ''}`);
      count(`${kind}: step ${got.answer.verdict}`);
      count(`step ${got.answer.verdict}`);
      count(`no card: step ${got.unpublished.verdict}`);
      // Where the payee's own side changes the answer from the payer's (the top-level verdict before fix inbox #87).
      if (got.answer.verdict !== got.answer.payer_side.verdict) count(`payer side ${got.answer.payer_side.verdict}, step ${got.answer.verdict}`);
      count(`outcome ${got.full.outcome}${got.full.side ? ` ${got.full.side} ${got.full.rule}` : ` asked [${got.full.asked}]`}`);
      if (got.payerCounter) count(`deal: the payer's own counter pending (${got.privacy})`);
      if (got.coverage) count(`#79 coverage rule at the step: ${got.coverage}`);
      if (got.before79) count(`#79 ${isDeepStrictEqual(got.before79, got.payeeSide) ? 'the same under the rule before'
        : got.payeeSide.outcome === 'refused' ? 'between the figures, refused: the rule before took it' : 'between the figures, taken: the rule before refused it'}: ${kind}`);
      tally(W, c, got, count);
    }
  }
  if (process.env.ORACLE_TALLY) console.log(JSON.stringify({dormancy, cases, seen: Object.fromEntries([...seen].sort())}, null, 1));
  return {seen, cases, has: k => [...seen.keys()].some(x => x.includes(k))};
}

test(`the oracle: on ${SEEDS.length} seeds x ${WORLDS} random worlds, the check's answer is what the real propose, accept and owner decisions do, for the payer and for the payee`, async () => {
  const {seen, cases, has} = await oracle(SEEDS);
  // The worlds reach what the check must answer (a generator that stopped covering a branch would fail here).
  for (const k of ['payer_proposes: payer decline max_issue_outstanding', 'payer_proposes: payer decline max_issue_per_deal', 'payer_proposes: payer decline counterparties',
    'payer_proposes: payer decline too_many_open_offers', 'payer_proposes: payer decline payee_no_key', 'payer_proposes: payer decline no_agent', 'payer decline expires_at',
    'payer decline network_limit', 'payer_proposes: payer ask_owner approve_above', 'payee_proposes: payer ask_owner approve_above', 'payee_proposes: payee decline too_many_open_offers',
    'payee decline min_payer_coverage_pct', 'payee decline max_accept_per_issuer', 'payee decline max_claims_total', 'payee decline counter_pending', 'payee ask_owner approve_above',
    'deal open: payer accept', 'deal open: payer ask_owner', 'deal open: payer decline', 'deal proposed_awaiting_owner: payee ask_owner',
    'deal accepted_awaiting_owner: payer ask_owner', 'deal accepted_awaiting_owner: payer accept', 'deal accepted_awaiting_owner: payee accept',
    'deal: refused (ended or agreed)', 'deal: the payer\'s own counter pending', 'outcome agreed asked [payee,payer]', 'outcome agreed asked []',
    'outcome refused payer', 'outcome refused payee', 'outcome refused terms payee_no_key', 'outcome refused terms network_limit',
    'payer_proposes: step ask_owner', 'payee_proposes: step decline', 'deal open: step accept', 'deal accepted_awaiting_owner: step ask_owner',
    'step accept', 'step ask_owner', 'step decline', 'no card: step unknown', 'no card: step decline',
    '#79 coverage rule at the step: compared', '#79 the same under the rule before', '#79 between the figures, refused: the rule before took it'])
    assert.ok(has(k), `no case reached "${k}" (saw ${JSON.stringify(Object.fromEntries([...seen].sort()))})`);
  assert.ok(cases >= SEEDS.length * WORLDS * 2, `${cases} cases`);
});

// The dormancy family: each side checked as the step finds it. A self-serve side whose own agent acts at the step is
// renewed first (its ended mandate renewed too, unless its owner ended it earlier); one whose agent does not act (the
// proposer of an offer under review, or anyone while only owners decide) is checked as it is. What a house sandbox agent
// payer owes a dormant payee counts once the payee's agent acts (the payer's re-check at the payee's acceptance, or its
// acceptance of the payee's proposal), and stays left out otherwise, as it does for a dormant participant that never acts.
test(`the oracle's dormancy family: on ${DORMANCY_SEEDS.length} seeds x ${WORLDS} worlds on the open network, self-serve sides in every renewal state and house sandbox agent payers, the check is what the real steps do`, async () => {
  const tally = (W, c, got, count) => {
    const A = got.answer, P = A.payer_side, Q = A.payee_side, B = W.state.participants[W.payer], C = W.state.participants[W.payee], {payer: bs, payee: cs} = W.states;
    count(`B ${bs}: payer ${P.verdict}${P.rule ? ` ${P.rule}` : ''}`);
    count(`C ${cs}: payee ${Q.verdict}${Q.rule ? ` ${Q.rule}` : ''}`);
    if (P.reasons.some(x => / counts here, though its card leaves it out: /.test(x))) count(`woken: payer ${P.verdict}${P.rule ? ` ${P.rule}` : ''}`);
    const owed = W.notes.filter(n => n.issuer_pubkey === B.pubkey && n.recipient_pubkey === C.pubkey).reduce((a, n) => a + Number(n.amount_collected) - Number(n.amount_redeemed), 0);
    if (bs === 'house' && /^dormant/.test(cs) && owed > 0 && W.mode === 'on') {
      const acts = c.kind === 'new' || (W.state.deals[c.id].status !== 'accepted_awaiting_owner' && W.state.deals[c.id].versions.at(-1).by !== C.id);
      count(`house B owes a dormant C${acts ? '' : ' that does not act'}: outcome ${got.full.outcome}${got.full.side ? ` ${got.full.side} ${got.full.rule}` : ''}`);
    }
  };
  const {seen, cases, has} = await oracle(DORMANCY_SEEDS, {dormancy: true, tally});
  // (Both sides declining a deal the payer proposes, the payer only at its re-check, is too rare here: the named test of
  // a house sandbox agent payer below has it.)
  for (const k of ['B dormant: payer accept', 'B dormant: payer decline expires_at', 'B dormant_owner_earlier: payer decline expires_at', 'B owner_earlier: payer decline expires_at',
    'B renewing: payer accept', 'B house: payer decline max_issue_outstanding', 'C dormant: payee accept', 'C dormant: payee decline expires_at',
    'C dormant_owner_earlier: payee decline expires_at', 'C owner_earlier: payee decline expires_at', 'C renewing: payee accept', 'woken: payer decline max_issue_outstanding',
    'woken: payer accept', 'house B owes a dormant C: outcome refused payer max_issue_outstanding', 'house B owes a dormant C: outcome agreed',
    'house B owes a dormant C that does not act: outcome', 'outcome refused payee expires_at', 'outcome refused payer expires_at', 'deal: the payer\'s own counter pending'])
    assert.ok(has(k), `no case reached "${k}" (saw ${JSON.stringify(Object.fromEntries([...seen].sort()))})`);
  assert.ok(cases >= DORMANCY_SEEDS.length * WORLDS * 2, `${cases} cases`);
});

// ---------- the four live divergences at 68f09c0, as regressions ----------
// Each world is built as JSON with the same builder; the check is asked through its route, and the real action runs on a
// twin.
const fixed = (opts, build) => { const w = builder(opts), W = build(w); return {W, live: livePilot(W)}; };
const askAs = async (W, live, query, as = 'agent') => (await ask(routesFor(live), W, query, as ? W.tokens[W.payee][as] : null)).body;

test('regression 1 (fix inbox #60): the payee checks an offer the payer\'s outstanding already counts; at 68f09c0 the check declined it, and accepting it agrees', async () => {
  let offer;
  const {W, live} = fixed({}, w => {
    const B = w.person('b-payer', {max_issue_per_deal: 5, max_issue_outstanding: 40}), C = w.person('c-payee'), D = w.person('d-other');
    w.owe(B, D, 34, {reconciled: true});                                      // 34 on the tracker
    offer = w.deal(B, C, B, 4, 'open');                                         // + 4 of its own offer to C = 38 of 40
    return w.done(B, C, offer);
  });
  // A new deal of 4 on top would be refused: without deal= the check says so, as it did, and the real proposal agrees.
  const onTop = await askAs(W, live, `amount=4&payee=${W.payee}`);
  assert.deepEqual([onTop.verdict, onTop.rule, onTop.counted_offers], ['decline', 'max_issue_outstanding', [{deal_id: offer.id, amount: 4}]]);
  const c = {kind: 'new', path: 'payer_proposes', amount: 4, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '1'.repeat(16), nonce: 'ab'.repeat(16)};
  assert.deepEqual(await drive(twin(W), W, {by: W.payer, terms: newTerms(W, c, W.payer)}), {outcome: 'refused', side: 'payer', rule: 'max_issue_outstanding'});
  // The offer itself, named with deal=: counted once, accept; the real acceptance agrees (at 68f09c0: decline).
  const got = await runCase(W, live, {kind: 'deal', id: offer.id, amount: 4});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.verdict, got.answer.payee_side.verdict], ['accept', null, 'accept', 'accept']);
  assert.deepEqual(got.full, {outcome: 'agreed', asked: []});
});

test('regression 2: an offer its owner already approved does not ask the owner again; at 68f09c0 (and with deal= on fix-60) the check said ask_owner', async () => {
  const make = approved => fixed({}, w => {
    const B = w.person('b-payer', {approve_above: 2}), C = w.person('c-payee');
    const d = w.deal(B, C, B, 4, 'open');
    if (approved) w.ownerApproved(d, B, d.versions[0]);                      // above approve_above: its owner approved it before it was offered
    return w.done(B, C, d);
  });
  {
    const {W, live} = make(true);
    // A new deal of 4 would wait for the owner (the check and the real proposal agree) ...
    assert.deepEqual([(await askAs(W, live, `amount=4&payee=${W.payee}`)).verdict], ['ask_owner']);
    const c = {kind: 'new', path: 'payer_proposes', amount: 4, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '2'.repeat(16), nonce: 'cd'.repeat(16)};
    const tw = twin(W);
    assert.equal((await tw.pilot.propose(tw.pilot.s.participants[W.payer], {terms: newTerms(W, c, W.payer), signature: SIG})).status, 'proposed_awaiting_owner');
    // ... but this one was approved: accepting it agrees at once, and the check says accept.
    const got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
    assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.approval_needed], ['accept', null, false]);
    assert.ok(got.answer.reasons.includes('Its owner approved this offer already: nothing waits for the owner.'), JSON.stringify(got.answer.reasons));
    assert.deepEqual(got.full, {outcome: 'agreed', asked: []});
  }
  {
    // Not approved (the owner lowered approve_above to 2 after its agent offered 4): accepting waits for the payer's owner
    // to confirm it (Pilot.proposerMustConfirm), and the check says ask_owner.
    const {W, live} = make(false);
    const got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
    assert.deepEqual([got.answer.verdict, got.answer.rule], ['ask_owner', 'approve_above']);
    assert.ok(got.answer.reasons.includes('Its owner approves each commitment above 2 PC, and has not approved this offer: it waits for the owner before it binds.'), JSON.stringify(got.answer.reasons));
    assert.deepEqual(got.full, {outcome: 'agreed', asked: ['payer']});
  }
});

test('regression 3: a self-serve payer with as many offers open as it may (open network) cannot propose (429), but may accept the payee\'s offer; at 68f09c0 the check said accept for both', async () => {
  const {W, live} = fixed({openNetwork: true}, w => {
    const B = w.boxed(w.person('b-payer', {max_issue_per_deal: 5, max_issue_outstanding: 40, max_accept_per_deal: 5, max_accept_per_issuer: 40}));
    const C = w.person('c-payee');
    for (let i = 0; i < OPEN_NETWORK_MAX_OPEN_OFFERS; i++) w.deal(B, w.person('x' + i), B, 1, 'open');
    return w.done(B, C);
  });
  const proposes = await runCase(W, live, {kind: 'new', path: 'payer_proposes', amount: 1, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '3'.repeat(16), nonce: 'ef'.repeat(16)});
  assert.deepEqual([proposes.answer.verdict, proposes.answer.rule], ['decline', 'too_many_open_offers']);
  assert.match(proposes.answer.payer_side.reasons[0], /^It is a self-serve agent with as many offers of its own open as it may have at once \(10\): it cannot propose a new deal until one of them is answered, withdrawn or expires\. It may still accept an offer you make it \(path=payee_proposes\)\.$/);
  assert.deepEqual(proposes.full, {outcome: 'refused', side: 'payer', rule: 'too_many_open_offers'});
  const tw = twin(W);
  await assert.rejects(tw.pilot.propose(tw.pilot.s.participants[W.payer], {terms: newTerms(W, {amount: 1, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '4'.repeat(16), nonce: 'ef'.repeat(16)}, W.payer), signature: SIG}),
    e => e.code === 'too_many_open_offers' && e.status === 429);
  const accepts = await runCase(W, live, {kind: 'new', path: 'payee_proposes', explicit: true, amount: 1, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '5'.repeat(16), nonce: 'ef'.repeat(16)});
  assert.deepEqual([accepts.answer.verdict, accepts.answer.rule, accepts.answer.path], ['accept', null, 'payee_proposes']);
  assert.deepEqual(accepts.full, {outcome: 'agreed', asked: []});
});

test('regression 4: a payee with no active agent key: no terms can name it, so the check declines (payee_no_key); at 68f09c0 it said accept', async () => {
  const {W, live} = fixed({}, w => {
    const B = w.person('b-payer'), C = w.keyless(w.person('c-payee'));
    return w.done(B, C);
  });
  const got = await runCase(W, live, {kind: 'new', path: 'payer_proposes', amount: 2, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '6'.repeat(16), nonce: '01'.repeat(16)});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.reasons], ['decline', 'payee_no_key', ['c-payee has no active agent key: no deal can name it until its owner connects an agent.']]);
  assert.equal(got.answer.reasons[0], "No deal can be made (payee_no_key): the server refuses its terms before it checks either side's limits.");
  assert.deepEqual([got.answer.payee_side.verdict, got.answer.payee_side.rule], ['decline', 'no_agent']);
  assert.deepEqual(got.full, {outcome: 'refused', side: 'terms', rule: 'payee_no_key'});
  const tw = twin(W);
  await assert.rejects(tw.pilot.propose(tw.pilot.s.participants[W.payer], {terms: newTerms(W, {amount: 2, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + '7'.repeat(16), nonce: '01'.repeat(16)}, W.payer), signature: SIG}),
    e => e.code === 'invalid_terms' && e.status === 400 && /^payee must be an active participant with its registered key$/.test(e.message));
});

test('an offer under review says whose owner it waits for, in each state: an acceptance held for an owner, a confirmation pending, an offer waiting for its proposer\'s owner', async () => {
  const states = [
    // [who proposed, the holds, the payer's verdict and owner reason, the payee's verdict and owner reason, whose owners the real steps ask]
    ['payer', {accHold: true, propHold: false}, ['accept', null], ['ask_owner', 'Your acceptance waits for your owner\'s approval: the deal binds once your owner approves.'], ['payee']],
    ['payer', {accHold: false, propHold: true}, ['ask_owner', 'Its owner is still to confirm this offer: the deal binds once the owner approves.'], ['accept', null], ['payer']],
    ['payee', {accHold: true, propHold: true}, ['ask_owner', 'Its acceptance waits for the owner\'s approval: the deal binds once the owner approves.'],
      ['ask_owner', 'Your owner is still to confirm your offer: the deal binds once your owner approves.'], ['payee', 'payer']],
    ['payee', 'proposed_awaiting_owner', ['ask_owner', 'Its owner approves each commitment above 2 PC: this one waits for the owner before it binds.'],
      ['ask_owner', 'Your offer waits for your owner\'s approval before it is made.'], ['payee', 'payer']],
  ];
  for (const [by, holds, [pv, pr], [qv, qr], asked] of states) {
    const {W, live} = fixed({}, w => {
      const B = w.person('b-payer', {approve_above: 2}), C = w.person('c-payee', {approve_above: 2});
      const d = holds === 'proposed_awaiting_owner' ? w.deal(B, C, C, 4, 'proposed_awaiting_owner') : w.deal(B, C, by === 'payer' ? B : C, 4, 'open');
      if (holds !== 'proposed_awaiting_owner') {
        if (!holds.propHold) w.ownerApproved(d, by === 'payer' ? B : C, d.versions[0]);   // the proposer's owner approved it before it was offered
        w.held(d, {...holds, accApproved: !holds.accHold});
      }
      return w.done(B, C, d);
    });
    const got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
    const label = `${by} proposed, ${JSON.stringify(holds)}`;
    assert.deepEqual([got.answer.payer_side.verdict, got.answer.payee_side.verdict, got.answer.verdict], [pv, qv, 'ask_owner'], label);
    if (pr) assert.ok(got.answer.payer_side.reasons.includes(pr), `${label}: ${JSON.stringify(got.answer.payer_side.reasons)}`);
    else assert.ok(!got.answer.payer_side.reasons.some(x => /waits for/.test(x) && !/nothing waits for/.test(x)), `${label}: ${JSON.stringify(got.answer.payer_side.reasons)}`);
    if (qr) assert.ok(got.answer.payee_side.reasons.includes(qr), `${label}: ${JSON.stringify(got.answer.payee_side.reasons)}`);
    assert.deepEqual(got.full, {outcome: 'agreed', asked}, label);
  }
});

test('the payee\'s own side counts a guarantee as accepting a deal with that deliver_by does: deliver_by= gives the exact answer, and without it a reason says when it could differ', async () => {
  let g;
  const {W, live} = fixed({}, w => {
    const B = w.person('b-payer'), G = w.person('g-backer'), D = w.person('d-other');
    const C = w.person('c-payee', {min_payer_coverage_pct: 50, accept_notes_from: [G.id]});   // C's owner trusts G: G's IOU counts at face value
    w.owe(B, D, 10, {reconciled: true});
    g = w.guarantee(G, B, C, 40, {expires: T + 3 * DAY});                      // callable for three days
    return w.done(B, C);
  });
  const routes = routesFor(live), base = `amount=20&payee=${W.payee}`;
  // Without deliver_by every active guarantee counts (as the cover shows it), with a reason saying it may not.
  const loose = (await ask(routes, W, base, W.tokens[W.payee].agent)).body.payee_side;
  assert.equal(loose.verdict, 'accept');
  assert.ok(loose.reasons.at(-1) === `A guarantee counts here only if it can still be called an hour after the deal's deliver_by, and one this counts ends ${g.terms.expires_at}: give deliver_by= (the deal's) for the exact answer, or check the offer with deal= once you have it.`, JSON.stringify(loose.reasons));
  for (const [due, verdict] of [[T + 2 * DAY, 'accept'], [T + 3 * DAY - HOUR, 'accept'], [T + 3 * DAY - HOUR + 1, 'decline'], [T + 10 * DAY, 'decline']]) {
    const c = {kind: 'new', path: 'payer_proposes', amount: 20, due, exp: Math.min(due, T + DAY), dealId: 'vd_' + crypto.randomBytes(8).toString('hex'), nonce: 'ab'.repeat(16)};
    const got = await runCase(W, live, c);
    assert.deepEqual([got.answer.payee_side.verdict, got.answer.payee_side.rule], [verdict, verdict === 'decline' ? 'min_payer_coverage_pct' : null], iso(due));
    assert.ok(!got.answer.payee_side.reasons.some(x => /^A guarantee counts here only/.test(x)), 'with deliver_by the answer is exact: no such reason');
  }
  // deliver_by is the payee's business, and a real deal's: 403 without the payee's token, 400 outside a deal's bounds.
  assert.deepEqual([(await ask(routes, W, `${base}&deliver_by=${iso(T + DAY)}`)).body.error], ['not_payee']);
  for (const bad of ['tomorrow', iso(T - 1000), iso(T + 31 * DAY), '2026-11-17T10:00:00+01:00'])
    assert.deepEqual([(await ask(routes, W, `${base}&deliver_by=${encodeURIComponent(bad)}`, W.tokens[W.payee].agent)).body.error], ['invalid_field'], bad);
});

// ---------- the review of the C8 branch, as regressions ----------
// The payer's counter-offer on the payee's offer, waiting for the payer's owner, is the payer's alone (Pilot.view shows a
// pending counter only to its maker). At 25c7ee3 the decline reason, and at the first C8 commit every accept reason too,
// gave its exact price away: they printed the room with the deal left out by excludeDealId, which leaves the counter out
// as well, beside room_left, which counts it (that figure + the price - room_left was the counter's price).
test('review: the payee\'s answer on its own offer shows nothing of the payer\'s private counter-offer but one bit; its figures count the counter as the card does', async () => {
  // C offers B `price`; B owes D 10 and may commit 20 a deal and `cap` in all; B's agent countered at `counter`, which waits
  // for B's owner.
  const make = (cap, price, counter) => fixed({}, w => {
    const B = w.person('b-payer', {max_issue_per_deal: 20, max_issue_outstanding: cap}), C = w.person('c-payee'), D = w.person('d-other');
    w.owe(B, D, 10, {reconciled: true});
    const d = w.deal(B, C, C, price, 'open');
    if (counter) w.counter(d, B, counter);
    return w.done(B, C, d);
  });
  for (const counter of [null, 7, 2]) {
    // It fits (cap 100): what is left with the deal is the card's room_left less the price, whatever the counter is.
    let {W, live} = make(100, 4, counter);
    let got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
    const left = 90 - (counter ?? 0);
    assert.deepEqual([got.answer.payer_side.verdict, got.answer.room_left, got.answer.payer_side.reasons[0]],
      ['accept', left, `Within its budget: up to 20 PC a deal; deal ${W.review} is counted once, and ${left - 4} PC of 100 PC is left with it.`]);
    // ... and the whole answer is the one where the same amount is reserved elsewhere (runCase, counterPrivate).
    assert.equal(got.privacy, counter ? 'same' : null);
    // It does not (cap 20, price 12): the room with the deal left out is the card's room_left, whatever the counter is.
    ({W, live} = make(20, 12, counter));
    got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 12});
    assert.deepEqual([got.answer.payer_side.verdict, got.answer.payer_side.rule, got.answer.payer_side.reasons[0]],
      ['decline', 'max_issue_outstanding', `Over its budget: leaving this deal out it has ${10 - (counter ?? 0)} PC of 20 PC left, less than 12 PC.`]);
    assert.equal(got.privacy, counter ? 'same' : null);
  }
  // The one bit: the counter takes the room the deal needs (cap 20, B owes 10, the counter is 8, the offer 4). The verdict
  // is for the deal once the counter is withdrawn, which fits; every figure counts the counter, as the card does.
  const {W, live} = make(20, 4, 8);
  const got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
  assert.deepEqual([got.answer.payer_side.verdict, got.answer.room_left, got.answer.payer_side.reasons[0]],
    ['accept', 2, `Within its budget: up to 20 PC a deal; deal ${W.review} is counted once, and 0 PC of 20 PC is left with it.`]);
  assert.equal(got.privacy, 'one bit');
  assert.deepEqual(got.full, {outcome: 'refused', side: 'payer', rule: 'counter_pending'});   // B's agent must withdraw it first (runCase: then it agrees)
});

// A counter-offer of the payee's own on the payer's offer, waiting for the payee's owner: accepting the offer is refused
// while it waits (counter_pending), and only its withdrawal or the owner's rejection lifts that. Approved, the
// counter-offer replaces the offer, which can then never be accepted. The first C8 commit said the owner's decision lifts it.
test('review: counter_pending says what lifts it, a withdrawal or the owner\'s rejection; approved, the counter-offer replaces the offer', async () => {
  const {W, live} = fixed({}, w => {
    const B = w.person('b-payer'), C = w.person('c-payee'), d = w.deal(B, C, B, 4, 'open');
    w.counter(d, C, 6);
    return w.done(B, C, d);
  });
  const got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4});
  assert.deepEqual(got.answer.payee_side, {verdict: 'decline', rule: 'counter_pending', reasons: ['Your own counter-offer on this deal waits for your owner: you cannot accept this offer while it does. Withdraw it, or wait for your owner to reject it; if your owner approves it, your counter-offer replaces this offer.']});
  assert.deepEqual(got.full, {outcome: 'refused', side: 'payee', rule: 'counter_pending'});
  const decided = async decision => {
    const {pilot} = twin(W), d = pilot.s.deals[W.review], C = pilot.s.participants[W.payee];
    await pilot.decideApproval(C, d.pending_counter.approval_id, {decision});
    return pilot.accept(C, W.review, {terms_hash: d.versions[0].terms_hash, signature: SIG}).then(x => x.status, e => e.code);
  };
  assert.equal(await decided('approve'), 'own_offer');      // the counter-offer is the current version now: C's own
  assert.equal(await decided('reject'), 'agreed');          // the offer stands, and C accepts it
});

// A self-serve payee on the open network whose sandbox time and mandate ended a day ago (dormant). Its agent's own request
// renews it before anything else (Pilot.authenticate), so where its agent acts at the step (it accepts a new deal) its
// side is checked renewed; where it does not (its own offer, which the payer's agent accepts), as it is. The first C8
// commit checked it as it is everywhere: with its owner's token, decline expires_at for a deal its agent's acceptance
// agrees; with its agent's token (which renews it) accept: two answers for one world.
test('review: a dormant self-serve payee: its side as its agent\'s request finds it; the owner\'s token, the agent\'s token and the real steps agree', async () => {
  const build = () => fixed({openNetwork: true}, w => {
    const B = w.person('b-payer'), C = w.selfServe(w.person('c-payee', {max_accept_per_deal: 5, max_accept_per_issuer: 40}), 'dormant');
    return w.done(B, C, w.deal(B, C, C, 3, 'open'));       // C's own offer, made before its time ended
  });
  const c = {kind: 'new', path: 'payer_proposes', amount: 4, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + 'a'.repeat(16), nonce: 'ab'.repeat(16)};
  for (const ownerToken of [true, false]) {
    const {W, live} = build(), C = live.s.participants[W.payee];
    const got = await runCase(W, live, {...c, ownerToken});
    assert.deepEqual([got.answer.verdict, got.answer.payee_side.verdict, got.full], ['accept', 'accept', {outcome: 'agreed', asked: []}], `owner token: ${ownerToken}`);
    // The owner's token renews nothing; the agent's token is a request of its agent, which renews it, as any request does.
    assert.deepEqual([C.mandate_version, Date.parse(C.sandbox_expires_at) > T], ownerToken ? [1, false] : [2, true]);
    if (ownerToken) assert.ok(got.answer.payee_side.reasons.includes(`Your mandate ended at ${iso(T - DAY)} with your sandbox time, and your agent's own request at this step renews both.`), JSON.stringify(got.answer.payee_side.reasons));
  }
  // C's own offer: the payer's agent accepts it, and C's side is re-checked as it is, so refused until C's agent is seen.
  const {W, live} = build();
  let got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 3, ownerToken: true});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.verdict, got.answer.payee_side.verdict, got.full], ['decline', 'expires_at', 'accept', 'decline', {outcome: 'refused', side: 'payee', rule: 'expires_at'}]);
  assert.equal(got.answer.payee_side.reasons[0], `Your own limits refuse it (expires_at): your mandate ended at ${iso(T - DAY)} with your sandbox time, and your agent does not act at this step. You are a self-serve agent: any request your agent sends renews both (a check sent with your agent's token does too).`);
  // A request of C's agent renews it (here the check itself, sent with C's agent token): then the payer's acceptance agrees.
  got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 3});
  assert.deepEqual([got.answer.verdict, got.answer.payee_side.verdict, got.full], ['accept', 'accept', {outcome: 'agreed', asked: []}]);
});

// A house sandbox agent (the server runs it: in sandboxIds) does not count what it owes participants whose sandbox time has
// ended (dormant) against its limit (Pilot.issueExposure), until they come back: a dormant payee's own agent acting at the
// step (accepting the house agent's offer, or proposing to it) renews it first, and the house agent's check from then on
// counts the debt. At 25c7ee3 and the first C8 commit, the public check and the payee's owner-token check left that debt
// out and said accept, and the payee's acceptance was refused (offer_not_authorized, max_issue_outstanding).
test('review: a house sandbox agent payer owing a dormant payee: the check counts that debt where the payee\'s agent acts, as the server then does, and not where it does not', async () => {
  const build = (cMandate = {}) => fixed({openNetwork: true}, w => {
    const S = w.person('s-house', {max_issue_per_deal: 20, max_issue_outstanding: 20});
    w.sandboxIds.push(S.id);
    const C = w.selfServe(w.person('c-payee', cMandate), 'dormant'), D = w.selfServe(w.person('d-gone'), 'dormant');
    w.owe(S, C, 15, {reconciled: true}); w.owe(S, D, 12, {reconciled: true});   // neither counts while C and D are dormant
    return w.done(S, C, w.deal(S, C, C, 4, 'open'));       // C's own offer to S, made before its time ended
  });
  const c = {kind: 'new', path: 'payer_proposes', amount: 10, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + 'b'.repeat(16), nonce: 'cd'.repeat(16)};
  const woken = 'What it owes c-payee on the tracker (15 PC) counts here, though its card leaves it out: c-payee\'s sandbox time has ended (a sandbox agent\'s debt to a participant whose time has ended does not count against its limit), and c-payee\'s own agent acts at this step, which renews it.';
  for (const path of ['payer_proposes', 'payee_proposes']) {
    // The payee's owner token, and the public answer (runCase): C's 15 counts, D's 12 does not; the real steps agree.
    let {W, live} = build();
    let got = await runCase(W, live, {...c, path, explicit: path !== 'payer_proposes', ownerToken: true});
    assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.room_left, got.answer.payer_side.reasons], ['decline', 'max_issue_outstanding', 20, ['Over its budget: it has 5 PC of 20 PC left, less than 10 PC.', woken]], path);
    assert.deepEqual(got.full, {outcome: 'refused', side: 'payer', rule: 'max_issue_outstanding'}, path);
    // The agent's token renews C before the check (a request of its agent): the card counts the 15 then, and so does the check.
    ({W, live} = build());
    got = await runCase(W, live, {...c, path, explicit: path !== 'payer_proposes'});
    assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.room_left, got.answer.payer_side.reasons], ['decline', 'max_issue_outstanding', 5, ['Over its budget: it has 5 PC of 20 PC left, less than 10 PC.']], path);
    assert.deepEqual(got.full, {outcome: 'refused', side: 'payer', rule: 'max_issue_outstanding'}, path);
  }
  // Both sides refuse a deal S proposes (C takes at most 5 a deal): S's proposal passes, so C's refusal comes first.
  let {W, live} = build({max_accept_per_deal: 5});
  let got = await runCase(W, live, {...c, ownerToken: true});
  assert.deepEqual([got.answer.verdict, got.answer.payee_side.rule, got.order, got.full], ['decline', 'max_accept_per_deal', ['payee', 'payer'], {outcome: 'refused', side: 'payee', rule: 'max_accept_per_deal'}]);
  // The step's rule is the payee's, the first refusal (fix inbox #87); the payer's own refusal is in payer_side.
  assert.deepEqual([got.answer.rule, got.answer.payer_side.rule, got.answer.reasons[0]], ['max_accept_per_deal', 'max_issue_outstanding', 'Both sides refuse it: its side (max_issue_outstanding) and yours (max_accept_per_deal).']);
  // C's own offer, which S's agent accepts: C's agent does not act, so the debt stays left out, and C's side is refused as it is.
  ({W, live} = build());
  got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 4, ownerToken: true});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.verdict, got.answer.payer_side.reasons[0], got.answer.payee_side.rule], ['decline', 'expires_at', 'accept', `Within its budget: up to 20 PC a deal; deal ${W.review} is counted once, and 16 PC of 20 PC is left with it.`, 'expires_at']);
  assert.deepEqual(got.full, {outcome: 'refused', side: 'payee', rule: 'expires_at'});
});

// Only the open network renews a self-serve participant (Pilot.authenticate): without it, a dormant self-serve payee's
// agent acting at the step changes nothing, its ended mandate refuses, and what a house sandbox agent owes it stays left
// out. (Amount 4 fits S's room with the 15 counted or not, so the payer's side twin, where C is no self-serve
// participant, agrees either way.)
test('review: off the open network a dormant self-serve payee is not renewed by its agent\'s request: its side declines expires_at, as its acceptance is refused', async () => {
  const {W, live} = fixed({openNetwork: false}, w => {
    const S = w.person('s-house', {max_issue_per_deal: 20, max_issue_outstanding: 20});
    w.sandboxIds.push(S.id);
    const C = w.selfServe(w.person('c-payee', {counterparties: [S.id]}), 'dormant');
    w.owe(S, C, 15, {reconciled: true});
    return w.done(S, C);
  });
  for (const ownerToken of [true, false]) {
    const got = await runCase(W, live, {kind: 'new', path: 'payer_proposes', amount: 4, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + 'd'.repeat(16), nonce: 'ab'.repeat(16), ownerToken});
    assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.verdict, got.answer.payer_side.reasons[0], got.answer.payee_side.rule], ['decline', 'expires_at', 'accept', 'Within its budget: up to 20 PC a deal, 20 PC of 20 PC left.', 'expires_at']);
    assert.equal(got.answer.payee_side.reasons[0], `Your own limits refuse it (expires_at): the mandate expired at ${iso(T - DAY)}; the owner must renew it.`);
    assert.deepEqual(got.full, {outcome: 'refused', side: 'payee', rule: 'expires_at'});
  }
});

// A self-serve payer on the open network whose sandbox time and mandate ended a day ago: its agent's own proposal renews it
// first, so the check says accept where the first C8 commit said decline expires_at ("until its owner renews it", which its
// owner cannot: a self-serve mandate ends at the sandbox end at the latest). Its offer made before, which the payee would
// accept, is re-checked as it is: refused until its agent is seen, as the check now says.
test('review: a dormant self-serve payer: accept where its agent acts (it proposes, renewed first); its open offer is refused until its agent is seen', async () => {
  const {W, live} = fixed({openNetwork: true}, w => {
    const B = w.selfServe(w.person('b-payer', {max_issue_per_deal: 5, max_issue_outstanding: 40}), 'dormant'), C = w.person('c-payee');
    return w.done(B, C, w.deal(B, C, B, 3, 'open'));       // B's offer, made before its time ended
  });
  let got = await runCase(W, live, {kind: 'new', path: 'payer_proposes', amount: 2, due: T + 2 * DAY, exp: T + DAY, dealId: 'vd_' + 'c'.repeat(16), nonce: 'ef'.repeat(16)});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.full], ['accept', null, {outcome: 'agreed', asked: []}]);
  assert.ok(got.answer.payer_side.reasons.includes(`Its mandate ended at ${iso(T - DAY)} with its sandbox time: it is a self-serve agent, and its agent's own request at this step renews both.`), JSON.stringify(got.answer.payer_side.reasons));
  got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 3});
  assert.deepEqual([got.answer.verdict, got.answer.rule, got.answer.payer_side.reasons[0]], ['decline', 'expires_at',
    `Its mandate ended at ${iso(T - DAY)} with its sandbox time: it is a self-serve agent, and the next request its agent sends renews both; until then it cannot commit to anything.`]);
  assert.deepEqual(got.full, {outcome: 'refused', side: 'payer', rule: 'expires_at'});
  // B's agent sends any request (Pilot.authenticate, as every route does): it is renewed, and the check and the acceptance agree.
  live.authenticate(W.tokens[W.payer].agent);
  got = await runCase(W, live, {kind: 'deal', id: W.review, amount: 3});
  assert.deepEqual([got.answer.verdict, got.full], ['accept', {outcome: 'agreed', asked: []}]);
});

// ---------- fix inbox #79 ----------
// #79's shape as the oracle runs it: B owes C 10 already and offers it 1 (or C offers B 1: `by`), and guarantees that
// name only that offer back it, by backers C's owner trusts (face value); C's bar is 15%. Two guarantees of 1, or one
// of 3, cover 9% of the 11 B would owe (the offer's price once, by the first in order), so the check and the real
// steps refuse it: at C's acceptance of B's offer, and at B's acceptance of C's own (C's side checked again). The rule
// before counted 2 (18%) or 3 (27%) and took it. One guarantee at the price is refused under both rules (the control);
// a floating guarantee of 3 counts as it did (27%); with two of the offer's on top it is 4 (36%) under a bar of 40,
// where the rule before counted 5 (45%). The other way: an offer of 5 backed by a trusted backer's guarantee of 5 and,
// after it, an untrusted one of 20 whose backer has nothing behind it (worth 0). The trusted one pays the offer: 5 of
// the 15 B would owe, 33%. The rule before scaled the 15 its debt cap allowed by the worth of both caps (5 of 25): 3,
// 20%.
test('fix inbox #79: guarantees stacked on an offer, or one above its price, count its price once: the check and the real steps refuse it at 15% where the rule before took it; the control and a floating guarantee as before', async () => {
  const make = ({caps = [], floating = 0, bar = 15, by = 'payer', price = 1, trustH = true}) => fixed({}, w => {
    const B = w.person('b-payer'), G = w.person('g-backer'), H = w.person('h-backer'), K = w.person('k-backer');
    const C = w.person('c-payee', {min_payer_coverage_pct: bar, accept_notes_from: trustH ? [G.id, H.id, K.id] : [G.id, K.id]});
    w.owe(B, C, 10, {reconciled: true});
    const d = w.deal(B, C, by === 'payer' ? B : C, price, 'open', {exp: T + DAY, due: T + 2 * DAY});
    caps.forEach((cap, i) => { w.guarantee([G, H][i], B, C, cap, {covers: 'issuer_payment_for_deals', deals: [d.id]}).created_at = iso(T - DAY - (2 - i) * 1000); });   // G's first
    if (floating) w.guarantee(K, B, C, floating);
    const W = w.done(B, C, d);
    for (const n of W.notes) n.amount_redeemed = '0';                        // B owes C all 10
    return W;
  });
  const refused = {outcome: 'refused', side: 'payee', rule: 'min_payer_coverage_pct'}, agreed = {outcome: 'agreed', asked: []};
  for (const [label, opts, pct, now, before] of [
    ['two guarantees of 1', {caps: [1, 1]}, 9, refused, agreed],
    ['one guarantee of 3', {caps: [3]}, 9, refused, agreed],
    ['two guarantees of 1, on C\'s own offer', {caps: [1, 1], by: 'payee'}, 9, refused, agreed],
    ['one guarantee of 1, the price (the control)', {caps: [1]}, 9, refused, refused],
    ['a floating guarantee of 3', {floating: 3}, 27, agreed, agreed],
    ['a floating guarantee of 3 and two of the offer\'s, under a bar of 40', {caps: [1, 1], floating: 3, bar: 40}, 36, refused, agreed],
    ['a trusted guarantee of the price (5), then a worthless one of 20, under a bar of 30', {caps: [5, 20], price: 5, bar: 30, trustH: false}, 33, agreed, refused]]) {
    const price = opts.price ?? 1, {W, live} = make(opts), got = await runCase(W, live, {kind: 'deal', id: W.review, amount: price});
    const A = got.answer, words = A.payee_side.reasons.join(' ');
    assert.deepEqual([A.payee_side.verdict, A.payee_side.rule, A.verdict, got.full, got.payeeSide], now === refused
      ? ['decline', 'min_payer_coverage_pct', 'decline', refused, refused] : ['accept', null, 'accept', agreed, agreed], label);
    assert.ok(now === refused ? words.includes(`cover ${pct}% of what it would owe with this deal (${10 + price} PC)`) : words.includes(`would be covered ${pct}%`), `${label}: ${words}`);
    assert.equal(A.cover.covered, (opts.caps ? price : 0) + (opts.floating ?? 0), label);
    assert.deepEqual([got.coverage, got.before79], ['compared', opts.caps ? before : null], label);
  }
});

test('isolation: 1,000 twin runs and their checks leave the live pilot as it was (state sha256, files, listeners); the live pilot verifies no assumed signature; a twin reaches no tracker', async () => {
  // A world whose offer under review is the payer's open offer, which the payee could accept now.
  let W = null;
  for (let s = 1; !W; s++) {
    const x = world(77_000 + s), d = x.review && x.state.deals[x.review];
    if (d && d.status === 'open' && d.versions.at(-1).by === x.payer && !d.pending_counter && Date.parse(d.versions.at(-1).terms.offer_expires_at) > x.t) W = x;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-oracle-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'pilot-state.json'), JSON.stringify(W.state));
  const live = livePilot(W, new PilotStore(dir)), routes = routesFor(live);
  let events = 0;
  live.changeListeners.add(() => { events += 1; });
  const cases = casesOf(W, 1);
  for (const c of cases) await ask(routes, W, c.kind === 'deal' ? `amount=${c.amount}&payee=${W.payee}&deal=${c.id}` : `amount=${c.amount}&payee=${W.payee}`, W.tokens[W.payee].agent);   // the reads' own sweep, once
  const files = () => fs.readdirSync(dir).sort().map(f => [f, fs.statSync(path.join(dir, f)).size, sha(fs.readFileSync(path.join(dir, f)))]);
  const before = {state: sha(JSON.stringify(live.s)), files: files(), listeners: live.changeListeners.size, generation: live.generation};
  for (let i = 0; i < 1000; i++) {
    const c = cases[i % cases.length];
    if (i % 10 === 0) await runCase(W, live, c);                             // the checks too: a dry run
    else await drive(twin(W, [null, W.payer, W.payee][i % 3]), W, c.kind === 'deal' ? {deal: c.id} : {by: W.payer, terms: newTerms(W, c, W.payer)});
  }
  assert.equal(sha(JSON.stringify(live.s)), before.state, 'the live state is unchanged');
  assert.deepEqual(files(), before.files, 'pilot-state.json, pilot-audit.jsonl and pilot-edge-log.jsonl are unchanged');
  assert.deepEqual([live.changeListeners.size, events, live.generation], [before.listeners, 0, before.generation], 'no listener was called, and nothing was saved');
  // The live pilot never takes the assumed signature (its stub verifies nothing), whatever the statement.
  const C = live.s.participants[W.payee];
  await assert.rejects(live.verifySig(C, statements.accept('ab'.repeat(32)), SIG, 'acceptance'), e => e.code === 'bad_signature');
  await assert.rejects(live.accept(C, W.review, {terms_hash: live.current(live.s.deals[W.review]).terms_hash, signature: SIG}), e => e.code === 'bad_signature');
  assert.equal(sha(JSON.stringify(live.s)), before.state, 'a refused action changed nothing');
  // A twin is its own Pilot over its own state, and its tracker is closed.
  const tw = twin(W);
  assert.notEqual(tw.pilot.s, live.s);
  assert.notEqual(tw.pilot.s.participants[W.payer], live.s.participants[W.payer]);
  assert.equal(tw.pilot.guarantees.pilot, tw.pilot);
  for (const k of ['api', 'issueNote', 'transfer', 'setoff', 'proof', 'refresh', 'noteMessage', 'priorAckMessage', 'trackerState', 'signHex'])
    assert.throws(() => tw.pilot.basis[k], e => e.code === 'speculative_write', k);
});
