// Valun domain: identities, credit offers, recipient decisions, issuance through the real Basis tracker,
// positions and reconciliation. Everything that is Valun-only (purpose, due date, consent) is labelled as such;
// cumulative debt always comes from the tracker.
import crypto from 'node:crypto';
import {ordinaryTimestamp} from './basis.mjs';

export const SOURCE = {
  VALUN: 'valun-record',        // Valun's own record (not in Basis)
  LOCAL_BASIS: 'local-basis',   // in the real Basis tracker running beside this app; no chain
  SIMULATED: 'simulated',       // illustrative only
};

const PUBKEY = /^0[23][0-9a-f]{64}$/;
const MAX_U63 = 2n ** 63n - 1n;

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const hexOf = s => Buffer.from(s, 'utf8').toString('hex');
export const offerMessage = h => `valun-offer/1\n${h}`;
export const acceptMessage = h => `valun-accept/1\n${h}`;
export const declineMessage = h => `valun-decline/1\n${h}`;

export class UserError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

// "1.5" ERG -> "1500000000" nanoERG, exactly (no floating point).
export function ergToNano(s) {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,9}))?\s*$/.exec(String(s ?? ''));
  if (!m) throw new UserError('amount must be an ERG figure like 1.5 (up to 9 decimals)');
  return (BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] || '').padEnd(9, '0'))).toString();
}

function cleanText(s, max, field) {
  if (s == null) return '';
  if (typeof s !== 'string') throw new UserError(`${field} must be text`);
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (t.length > max) throw new UserError(`${field} is longer than ${max} characters`);
  return t;
}

export class Valun {
  constructor({store, basis, limits = {}, now = () => Date.now()}) {
    this.store = store; this.basis = basis; this.now = now;
    this.limits = {participants: 40, offers: 500, maxIncrement: 1000n * 1_000_000_000n, ...limits};
    this.lock = Promise.resolve();
  }
  get s() { return this.store.state; }
  serial(fn) { const run = this.lock.then(fn, fn); this.lock = run.catch(() => {}); return run; }

  participant(id) {
    const p = this.s.participants[id];
    if (!p) throw new UserError(`unknown participant ${id}`, 404);
    return p;
  }
  byPubkey(pk) { return Object.values(this.s.participants).find(p => p.pubkey === pk) || null; }

  // ---------- identities ----------
  createParticipant({name, kind = 'agent', about = ''}) {
    return this.serial(async () => {
      name = cleanText(name, 40, 'name');
      if (!name) throw new UserError('name is required');
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) throw new UserError("name may use letters, digits, spaces and . _ ' -");
      if (!['agent', 'operator'].includes(kind)) throw new UserError('kind must be agent or operator');
      if (Object.keys(this.s.participants).length >= this.limits.participants) throw new UserError('participant limit reached for this demo');
      if (Object.values(this.s.participants).some(p => p.name.toLowerCase() === name.toLowerCase())) throw new UserError('name already used');
      const {secret_hex, pubkey_hex} = await this.basis.keygen();
      const id = this.store.nextId('p');
      this.store.putSecret(id, secret_hex);
      const p = {id, name, kind, about: cleanText(about, 200, 'about'), pubkey: pubkey_hex, createdAt: new Date(this.now()).toISOString(),
        custody: 'demo-server', source: SOURCE.VALUN};
      this.s.participants[id] = p; this.store.save();
      this.store.audit({type: 'participant.created', id, name, kind, pubkey: pubkey_hex});
      return p;
    });
  }

  // ---------- offers: an issuer-signed Basis note plus Valun terms ----------
  createOffer({issuerId, recipientId, amount, purpose = '', dueAt = null}) {
    return this.serial(async () => {
      const issuer = this.participant(issuerId), recipient = this.participant(recipientId);
      if (issuer.id === recipient.id) throw new UserError('issuer and recipient must differ');
      let inc;
      try { inc = BigInt(amount); } catch { throw new UserError('amount must be a whole number of nanoERG'); }
      if (inc <= 0n || inc > this.limits.maxIncrement) throw new UserError('amount out of range for this demo');
      if (Object.keys(this.s.offers).length >= this.limits.offers) throw new UserError('offer limit reached for this demo');
      purpose = cleanText(purpose, 200, 'purpose');
      if (dueAt) { const d = new Date(dueAt); if (isNaN(d)) throw new UserError('dueAt must be a date'); dueAt = d.toISOString(); } else dueAt = null;

      const current = await this.basis.note(issuer.pubkey, recipient.pubkey);
      const priorTotal = BigInt(current?.amount_collected ?? 0);
      const newTotal = priorTotal + inc;
      if (newTotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new UserError('cumulative total too large for this demo');
      // Sign slightly in the past: the tracker rejects timestamps ahead of its own clock. Never a timestamp ending in
      // 995-999 ms, which tracker v3 reserves for other operations (ordinaryTimestamp; at most 5 ms later).
      const timestamp = ordinaryTimestamp(Math.max(this.now() - 1500, Number(current?.timestamp ?? 0) + 1));
      const {message_hex, debt_key_hex} = await this.basis.noteMessage({issuer: issuer.pubkey, recipient: recipient.pubkey, total: newTotal, timestamp});
      const issuerSecret = this.store.getSecret(issuer.id);
      const noteSignature = await this.basis.signHex(issuer.pubkey, message_hex, issuerSecret);

      const terms = {
        v: 'valun-offer/1', issuer: issuer.pubkey, recipient: recipient.pubkey, denomination: 'erg',
        increment: inc.toString(), priorTotal: priorTotal.toString(), newTotal: newTotal.toString(),
        purpose, dueAt, trackerNftId: this.basis.nft,
        basisNote: {total: newTotal.toString(), timestamp, message_hex, signature: noteSignature},
      };
      const termsHash = sha256(canonical(terms));
      const offerSignature = await this.basis.signHex(issuer.pubkey, hexOf(offerMessage(termsHash)), issuerSecret);
      const id = this.store.nextId('o');
      const o = {id, issuerId, recipientId, terms, termsHash, debtKey: debt_key_hex, status: 'offered',
        createdAt: new Date(this.now()).toISOString(), issuerTermsSignature: offerSignature, history: [{at: new Date(this.now()).toISOString(), status: 'offered', by: issuerId}]};
      this.s.offers[id] = o; this.store.save();
      this.store.audit({type: 'offer.created', id, issuerId, recipientId, increment: terms.increment, newTotal: terms.newTotal, termsHash});
      return o;
    });
  }

  offer(id) { const o = this.s.offers[id]; if (!o) throw new UserError(`unknown offer ${id}`, 404); return o; }

  // What the recipient needs to decide: terms, staleness against the tracker, the recipient's Basis policy check,
  // and the issuer's position (what they already owe and hold).
  async inspectOffer(id) {
    const o = this.offer(id), issuer = this.participant(o.issuerId), recipient = this.participant(o.recipientId);
    const current = await this.basis.note(issuer.pubkey, recipient.pubkey);
    const currentTotal = BigInt(current?.amount_collected ?? 0).toString();
    const stale = o.status === 'offered' && currentTotal !== o.terms.priorTotal;
    let policyCheck = null, policy = null;
    try {
      policy = await this.basis.policy(recipient.pubkey);
      policyCheck = await this.basis.acceptanceCheck({issuer: issuer.pubkey, recipient: recipient.pubkey, totalDebt: Number(o.terms.newTotal)});
    } catch (e) { policyCheck = {error: e.message}; }
    const issuerOk = await this.basis.verify(issuer.pubkey, o.terms.basisNote.message_hex, o.terms.basisNote.signature);
    return {
      offer: o, currentTotal, stale,
      basisNoteSignatureValid: issuerOk,
      recipientPolicy: policy ? {present: true, policy_json: policy.policy_json, uploaded_at: policy.uploaded_at} : {present: false},
      policyCheck,
      issuerPosition: await this.position(issuer.id),
    };
  }

  decide(id, {actorId, decision, reason = ''}) {
    return this.serial(async () => {
      const o = this.offer(id);
      if (actorId !== o.recipientId) throw new UserError('only the recipient can decide on this offer', 403);
      if (o.status !== 'offered') throw new UserError(`offer is ${o.status}, not open`, 409);
      if (!['accept', 'decline'].includes(decision)) throw new UserError('decision must be accept or decline');
      reason = cleanText(reason, 200, 'reason');
      const issuer = this.participant(o.issuerId), recipient = this.participant(o.recipientId);
      const at = new Date(this.now()).toISOString();
      const rSecret = this.store.getSecret(recipient.id);

      if (decision === 'decline') {
        const sig = await this.basis.signHex(recipient.pubkey, hexOf(declineMessage(o.termsHash)), rSecret);
        o.status = 'declined'; o.decision = {decision, by: recipient.id, at, reason, signature: sig, message: declineMessage(o.termsHash)};
        o.history.push({at, status: 'declined', by: recipient.id});
        this.store.save(); this.store.audit({type: 'offer.declined', id});
        return o;
      }

      // Stale check: the signed note commits to priorTotal + increment. If the pair's total moved, consent would be
      // to a different cumulative debt than the one shown, so the offer must be re-made.
      const current = await this.basis.note(issuer.pubkey, recipient.pubkey);
      const currentTotal = BigInt(current?.amount_collected ?? 0).toString();
      if (currentTotal !== o.terms.priorTotal) {
        o.status = 'stale'; o.history.push({at, status: 'stale', by: 'valun', detail: `tracker total is ${currentTotal}, offer assumed ${o.terms.priorTotal}`});
        this.store.save(); this.store.audit({type: 'offer.stale', id, currentTotal});
        throw new UserError(`terms are stale: the tracker total for this pair is now ${currentTotal}, the offer assumed ${o.terms.priorTotal}. Ask the issuer for a new offer.`, 409);
      }
      let policyCheck = null;
      try { policyCheck = await this.basis.acceptanceCheck({issuer: issuer.pubkey, recipient: recipient.pubkey, totalDebt: Number(o.terms.newTotal)}); } catch (e) { policyCheck = {error: e.message}; }
      const consentSig = await this.basis.signHex(recipient.pubkey, hexOf(acceptMessage(o.termsHash)), rSecret);
      o.decision = {decision, by: recipient.id, at, reason, signature: consentSig, message: acceptMessage(o.termsHash), policyCheckAtDecision: policyCheck};
      o.history.push({at, status: 'accepted', by: recipient.id});
      // Write-ahead: the consent is durable BEFORE the tracker is contacted, so a crash or machine stop in between
      // leaves a 'submitting' offer that recover() completes, instead of a tracker note Valun has no record of.
      o.status = 'submitting';
      this.store.save(); this.store.audit({type: 'offer.accepted', id});
      return this.submit(o);
    });
  }

  // Release the issuer-signed note to the tracker, then decide from what the tracker actually holds (read-back),
  // not from the HTTP answer alone: after a retry the tracker may already hold this exact note.
  async submit(o, {recovering = false} = {}) {
    const issuer = this.participant(o.issuerId), recipient = this.participant(o.recipientId), n = o.terms.basisNote;
    const request = {issuer_pubkey: issuer.pubkey, recipient_pubkey: recipient.pubkey, amount: Number(n.total), timestamp: n.timestamp,
      signature: n.signature, tracker_nft_id: this.basis.nft, denomination: this.basis.denomination};
    let r = null;
    const before = recovering ? await this.basis.note(issuer.pubkey, recipient.pubkey) : null;
    if (before?.signature !== n.signature) r = await this.basis.api('POST', '/notes', request);
    const submittedAt = new Date(this.now()).toISOString();
    const readBack = await this.basis.note(issuer.pubkey, recipient.pubkey);
    const held = !!readBack && readBack.signature === n.signature && String(readBack.amount_collected) === n.total && readBack.timestamp === n.timestamp;
    if (!held) {
      o.status = 'issue_failed';
      o.issuance = {submittedAt, trackerStatus: r?.status ?? null, trackerError: r?.json?.error ?? r?.text?.slice(0, 300) ?? 'tracker does not hold the note'};
      o.history.push({at: submittedAt, status: 'issue_failed', by: 'basis-tracker', detail: o.issuance.trackerError});
      this.store.save(); this.store.audit({type: 'offer.issue_failed', id: o.id, trackerStatus: r?.status ?? null});
      return o;
    }
    const proof = await this.basis.proof(issuer.pubkey, recipient.pubkey);
    const valunVerified = await this.basis.verify(issuer.pubkey, n.message_hex, readBack.signature);
    o.status = 'issued';
    o.issuance = {
      submittedAt, trackerStatus: r ? r.status : 'already held (recovered)', recovered: recovering || undefined,
      trackerNote: {amount_collected: readBack.amount_collected, amount_redeemed: readBack.amount_redeemed, timestamp: readBack.timestamp, signature: readBack.signature, confirmation: readBack.confirmation},
      readBackMatches: true,
      signatureVerifiedByValun: valunVerified,
      proof: proof && {key: proof.key, value: proof.value, proof: proof.proof, total_debt: proof.total_debt, tracker_state_digest: proof.tracker_state_digest},
    };
    o.history.push({at: submittedAt, status: 'issued', by: 'basis-tracker',
      detail: `tracker holds cumulative ${n.total}; confirmation ${readBack.confirmation?.status}${recovering ? '; completed by recovery after a restart' : ''}`});
    this.store.save(); this.store.audit({type: 'offer.issued', id: o.id, total: n.total, digest: proof?.tracker_state_digest, recovered: recovering || undefined});
    return o;
  }

  // Run at startup: finish every offer whose consent was recorded but whose tracker submission was interrupted.
  recover() {
    return this.serial(async () => {
      const done = [];
      for (const o of Object.values(this.s.offers)) if (o.status === 'submitting') done.push(await this.submit(o, {recovering: true}));
      return done.map(o => ({id: o.id, status: o.status}));
    });
  }

  withdraw(id, {actorId}) {
    return this.serial(async () => {
      const o = this.offer(id);
      if (actorId !== o.issuerId) throw new UserError('only the issuer can withdraw', 403);
      if (o.status !== 'offered') throw new UserError(`offer is ${o.status}, not open`, 409);
      const at = new Date(this.now()).toISOString();
      o.status = 'withdrawn'; o.history.push({at, status: 'withdrawn', by: actorId});
      this.store.save(); this.store.audit({type: 'offer.withdrawn', id});
      return o;
    });
  }

  // ---------- acceptance policy (real Basis, signed by the recipient) ----------
  setPolicy(participantId, {mode, trustedIds = [], maxDebt = null}) {
    return this.serial(async () => {
      const p = this.participant(participantId);
      let config;
      if (mode === 'accept-any') config = {default: 'accept', predicates: []};
      else if (mode === 'whitelist') {
        const holders = [...new Set(trustedIds)].map(id => this.participant(id).pubkey);
        if (!holders.length) throw new UserError('choose at least one trusted issuer');
        const pred = {type: 'whitelist', name: 'trusted_issuers', holders};
        if (maxDebt != null && maxDebt !== '') {
          let m; try { m = BigInt(maxDebt); } catch { throw new UserError('maxDebt must be a whole number of nanoERG'); }
          if (m <= 0n || m > MAX_U63) throw new UserError('maxDebt out of range');
          pred.max_debt = Number(m);
        }
        config = {default: 'reject', root: 'trusted_issuers', predicates: [pred]};
      } else throw new UserError('mode must be accept-any or whitelist');
      const policyJson = JSON.stringify(config);
      const r = await this.basis.uploadPolicy({recipient: p.pubkey, policyJson, secretHex: this.store.getSecret(p.id)});
      if (!r.success) throw new UserError(`tracker refused the policy: ${r.error || r.status}`, 502);
      p.policy = {mode, trustedIds, maxDebt: maxDebt === '' ? null : maxDebt, policyJson, uploadedAt: new Date(this.now()).toISOString(), policyHash: r.data?.policy_hash, signature: r.signature};
      this.store.save(); this.store.audit({type: 'policy.uploaded', participantId, mode, policyHash: r.data?.policy_hash});
      return p.policy;
    });
  }

  // ---------- positions and reconciliation (tracker is the authority) ----------
  async ledger() {
    const notes = await this.basis.allNotes();
    const name = pk => this.byPubkey(pk)?.name ?? null;
    return notes.map(n => ({
      issuer: n.issuer_pubkey, issuerName: name(n.issuer_pubkey), recipient: n.recipient_pubkey, recipientName: name(n.recipient_pubkey),
      total: String(n.amount_collected), redeemed: String(n.amount_redeemed),
      outstanding: (BigInt(n.amount_collected) - BigInt(n.amount_redeemed)).toString(),
      timestamp: n.timestamp, age_seconds: n.age_seconds, confirmation: n.confirmation?.status ?? 'unknown', denomination: n.denomination,
      source: SOURCE.LOCAL_BASIS,
    }));
  }

  async position(participantId, ledger = null) {
    const p = this.participant(participantId);
    ledger ??= await this.ledger();
    const held = ledger.filter(l => l.recipient === p.pubkey), owed = ledger.filter(l => l.issuer === p.pubkey);
    const sum = xs => xs.reduce((a, l) => a + BigInt(l.outstanding), 0n);
    return {
      participantId, claimsHeld: sum(held).toString(), owes: sum(owed).toString(), net: (sum(held) - sum(owed)).toString(),
      claims: held.map(l => ({from: l.issuerName ?? l.issuer, amount: l.outstanding})),
      debts: owed.map(l => ({to: l.recipientName ?? l.recipient, amount: l.outstanding})),
      backing: 'none (local Basis has no chain, so no reserve backs these notes)',
    };
  }

  async reconcile(ledger = null) {
    ledger ??= await this.ledger();
    const issuedByPair = new Map();
    for (const o of Object.values(this.s.offers)) if (o.status === 'issued') {
      const k = `${o.terms.issuer}>${o.terms.recipient}`;
      issuedByPair.set(k, (issuedByPair.get(k) ?? 0n) + BigInt(o.terms.increment));
    }
    const rows = [], seen = new Set();
    for (const l of ledger) {
      const k = `${l.issuer}>${l.recipient}`; seen.add(k);
      const viaValun = issuedByPair.get(k) ?? 0n, total = BigInt(l.total);
      rows.push({issuer: l.issuerName ?? l.issuer, recipient: l.recipientName ?? l.recipient, trackerTotal: total.toString(), issuedViaValun: viaValun.toString(),
        status: total === viaValun ? 'match' : total > viaValun ? 'tracker-has-debt-not-issued-through-valun' : 'valun-records-exceed-tracker'});
    }
    for (const [k, v] of issuedByPair) if (!seen.has(k)) rows.push({pair: k, trackerTotal: '0', issuedViaValun: v.toString(), status: 'valun-records-exceed-tracker'});
    return rows;
  }

  // Valun-only obligation status layered over the tracker.
  obligationView(o) {
    const overdue = o.status === 'issued' && o.terms.dueAt && Date.parse(o.terms.dueAt) < this.now();
    return {...o, overdue: !!overdue,
      dueNote: o.terms.dueAt ? 'Due date is a Valun term only: Basis notes carry no due date and the tracker does not enforce it.' : null};
  }
}
