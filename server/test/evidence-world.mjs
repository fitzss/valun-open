// A Pilot over a stub tracker, with the exchanges the evidence (lib/pilot/evidence.mjs) is read from, stored as the server
// stores them: deals with their statuses, the edge journal (issue, transfer_out/transfer_in, setoff), the tracker's
// notes and applied set-offs and transfers. Used by test/evidence.unit.test.mjs and scripts/evidence-attacks.mjs (which
// builds the states that staged records and honest ones leave). No tracker binary, no signing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION, DEFAULT_MANDATE} from '../lib/pilot/core.mjs';
import {appendEntries} from '../lib/pilot/journal.mjs';

const hex = n => crypto.randomBytes(n).toString('hex');
const iso = t => new Date(t).toISOString();
const DAY = 864e5;
export const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/4', pure_credit: true, reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 3, max_age_ms: 3600000, prior_ack: 'basis/prior-ack/1'},
  bound_only_edges: true, novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 4, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient'], prior_ack: 'basis/prior-ack/1'},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}}, onchain_edges: 0, novations_disabled_reason: null};
const POLICY = {auto_clear: true, novate_own_debt: true, accept_transfers: true, accept_notes_from: 'any', refuse_notes_from: [], pay_with_held_notes: 'when_asked'};

export function evidenceWorld({mode = 'on'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-evidence-'));
  const notes = new Map(), clock = {t: Date.parse('2026-11-13T12:00:00.000Z')}, operator = new Set();
  const basis = {nft: '0'.repeat(64), denomination: PILOT_DENOMINATION, note: async (i, r) => notes.get(`${i}>${r}`) ?? null, allNotes: async () => [...notes.values()],
    capabilities: async () => V3_CAPS};
  const pilot = new Pilot({store: new PilotStore(dir), basis, now: () => clock.t, circulation: mode, trackerCaps: V3_CAPS, trackerSha256: 'cd'.repeat(32), trackerPins: ['cd'.repeat(32)], log: () => {}});
  pilot.serverSigner = {has: id => operator.has(id), signFor: async () => { throw new Error('no signing here'); }};
  let ts = 1_800_000_000_000;
  const total = (I, R) => Number(notes.get(`${I.pubkey}>${R.pubkey}`)?.amount_collected ?? 0);
  const setTotal = (I, R, t) => {
    const k = `${I.pubkey}>${R.pubkey}`;
    notes.set(k, {issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, amount_collected: String(t), amount_redeemed: '0', timestamp: (ts += 1000), signature: '02' + hex(64), denomination: PILOT_DENOMINATION});
  };
  const entry = (kind, I, R, delta) => appendEntries(pilot, [{kind, ref: 'vd_' + hex(8), issuer_pubkey: I.pubkey, recipient_pubkey: R.pubkey, delta, total_after: total(I, R), timestamp: ts, signature: '02' + hex(64)}]);

  // kind: 'invited' (an invitation the operator issued), 'self_serve' (join-sandbox: anyone), 'operator' (the operator holds its keys).
  const person = (handle, kind = 'self_serve', {operatorName = 'op-' + handle} = {}) => {
    const p = {id: 'vp_' + hex(6), handle, display_name: handle, operator: operatorName, about: '', services: '', pubkey: '02' + hex(32), status: 'active', created_at: iso(clock.t),
      owner_token_hash: hex(32), agent_token_hash: hex(32), enrollment: null, mandate: {...DEFAULT_MANDATE, max_accept_per_issuer: 1000, max_accept_per_deal: 100, ...POLICY},
      mandate_version: 1, past_pubkeys: [], last_seen_agent: null, last_seen_owner: null,
      ...(kind === 'self_serve' ? {sandbox_only: true, sandbox_expires_at: iso(clock.t + 7 * DAY)} : {})};
    pilot.s.participants[p.id] = p;
    if (kind === 'operator') operator.add(p.id);
    return p;
  };
  const deal = (payer, payee, status, price) => {
    const id = 'vd_' + hex(8);
    const terms = {deal_id: id, version: 1, payer: {id: payer.id, pubkey: payer.pubkey}, payee: {id: payee.id, pubkey: payee.pubkey}, service: {title: 'job', description: 'synthetic', deliverable: 'text'},
      price: {amount: price, unit: 'PC'}, offer_expires_at: iso(clock.t + DAY), deliver_by: iso(clock.t + 2 * DAY)};
    const v = {v: 1, by: payer.id, terms, terms_hash: hex(32), signature: '02' + hex(64), created_at: iso(clock.t), state: 'accepted', offered_at: iso(clock.t)};
    pilot.s.deals[id] = {id, payer: payer.id, payee: payee.id, created_at: iso(clock.t), status, versions: [v], history: [],
      agreement: {version: 1, terms, terms_hash: v.terms_hash, formed_at: iso(clock.t)}};
    return pilot.s.deals[id];
  };
  // payee did a job for payer, who accepted it and paid with its own IOU (its note issued).
  const job = (payer, payee, price) => {
    setTotal(payer, payee, total(payer, payee) + price);
    entry('issue', payer, payee, price);
    return deal(payer, payee, 'note_issued', price);
  };
  // holder pays `to` for a job with `amount` of issuer's IOU it holds (a payment by transfer, applied).
  const pass = (holder, issuer, to, amount) => {
    if (total(issuer, holder) < amount) throw new Error(`${holder.handle} holds ${total(issuer, holder)} of ${issuer.handle}'s IOU, not ${amount}`);
    const d = deal(holder, to, 'paid_by_transfer', amount);
    setTotal(issuer, holder, total(issuer, holder) - amount); entry('transfer_out', issuer, holder, -amount);
    setTotal(issuer, to, total(issuer, to) + amount); entry('transfer_in', issuer, to, amount);
    const id = 'vt_' + hex(8);
    pilot.s.transfers[id] = {id, kind: 'transfer', deal_id: d.id, state: 'applied', amount, created_at: iso(clock.t), updated_at: iso(clock.t),
      issuer: {id: issuer.id, pubkey: issuer.pubkey}, payer: {id: holder.id, pubkey: holder.pubkey}, payee: {id: to.id, pubkey: to.pubkey}};
    d.payment = {method: 'transfer', transfer_id: id, state: 'applied'};
    return d;
  };
  // A loop cancelled: each member's IOU to the next falls by `each` (a set-off, applied).
  const loop = (members, each) => {
    for (let i = 0; i < members.length; i++) {
      const a = members[i], b = members[(i + 1) % members.length];
      if (total(a, b) < each) throw new Error(`${a.handle} owes ${b.handle} ${total(a, b)}, not ${each}`);
      setTotal(a, b, total(a, b) - each); entry('setoff', a, b, -each);
    }
    const id = 'vs_' + hex(8);
    pilot.s.setoffs[id] = {id, kind: 'setoff', state: 'applied', applied_at: iso(clock.t), created_at: iso(clock.t), members: members.map(m => m.id), amount: each * members.length,
      edges: members.map((a, i) => ({edge: `${a.pubkey}>${members[(i + 1) % members.length].pubkey}`, issuer: {id: a.id}, recipient: {id: members[(i + 1) % members.length].id}, decrease: each}))};
    return id;
  };
  const unpaid = (payer, payee, price) => deal(payer, payee, 'payment_due', price);
  const undelivered = (payer, payee, price) => deal(payer, payee, 'expired_undelivered', price);
  const disputed = (payer, payee, price) => deal(payer, payee, 'disputed', price);
  const cleanup = () => fs.rmSync(dir, {recursive: true, force: true});
  pilot.s.setoffs ??= {}; pilot.s.transfers ??= {};
  return {pilot, notes, clock, operator, person, job, pass, loop, unpaid, undelivered, disputed, total, cleanup};
}

// The evidence of participant p, as GET /participants/{id} publishes it.
export async function evidence(w, p) { return (await w.pilot.publicPosition(p)).evidence; }
