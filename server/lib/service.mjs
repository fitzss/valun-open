// One service layer behind both the web API and the MCP tools, so agents and the browser get identical behaviour.
import {SOURCE, ergToNano, UserError} from './valun.mjs';
import {RECORDED, EXPLORER_UI} from './testnet.mjs';

export const nanoToErg = n => {
  if (n == null) return null;
  const b = BigInt(n), neg = b < 0n, a = neg ? -b : b, w = a / 1_000_000_000n, f = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${w}${f ? '.' + f : ''}`;
};

export const MODES = {
  [SOURCE.LOCAL_BASIS]: 'Real Basis tracker (basis_server) running beside this app, pure-credit mode: no Ergo node, no reserves, synthetic tracker identity. Notes are signed with Basis\'s own basis_core Schnorr code.',
  [SOURCE.VALUN]: 'Valun\'s own record (offers, purposes, due dates, consent signatures). Not stored in Basis.',
  'testnet-recorded': 'Ergo testnet results recorded on 2026-10-31/11-01 from the funded demo (one trusted node).',
  'testnet-live': 'Re-read now from the public Ergo testnet explorer (third party).',
};
export const CUSTODY = 'Demo custody: this server generates and holds the synthetic participants\' keys. Anyone using this demo can act as any participant. Real users would sign in their own wallets.';

const publicParticipant = p => ({id: p.id, name: p.name, kind: p.kind, about: p.about, pubkey: p.pubkey, createdAt: p.createdAt, custody: p.custody,
  policy: p.policy ? {mode: p.policy.mode, trustedIds: p.policy.trustedIds, maxDebt: p.policy.maxDebt, uploadedAt: p.policy.uploadedAt, policyHash: p.policy.policyHash} : null});

export function createService({valun, basis, store, cfg, testnetLive}) {
  return {
    async status() {
      let health = false, state = null;
      try { health = await basis.health(); state = await basis.trackerState(); } catch { /* reported as unreachable */ }
      return {
        deployment: cfg.deployment, writeTokenRequired: !!cfg.writeToken, modes: MODES,
        basis: {pin: cfg.basisPin, trackerReachable: health, trackerNftId: basis.nft, trackerNftOnChain: false,
          localDigest: state?.local_digest ?? null, confirmedDigest: state?.confirmed_digest ?? null,
          note: 'The tracker NFT id here is random: no tracker box exists on any chain, so every note stays local_only and nothing is redeemable.'},
        custody: CUSTODY, noMainnet: true, realFunds: false,
      };
    },
    async participants() {
      const ledger = await valun.ledger().catch(() => null);
      return Promise.all(Object.values(store.state.participants).map(async x => ({...publicParticipant(x), position: ledger ? await valun.position(x.id, ledger) : null})));
    },
    async position(participantId) { return valun.position(participantId); },
    async createParticipant(b) { return publicParticipant(await valun.createParticipant(b)); },
    async setPolicy(participantId, b) {
      const maxDebt = b.maxDebtErg != null && b.maxDebtErg !== '' ? ergToNano(b.maxDebtErg) : null;
      return valun.setPolicy(participantId, {mode: b.mode, trustedIds: b.trustedIds || [], maxDebt});
    },
    offers({participantId, role = 'any', status} = {}) {
      return Object.values(store.state.offers).map(o => valun.obligationView(o)).reverse().filter(o =>
        (!status || o.status === status) &&
        (!participantId || (role !== 'recipient' && o.issuerId === participantId) || (role !== 'issuer' && o.recipientId === participantId)));
    },
    async createOffer(b) {
      if (b.amountErg == null && b.amount == null) throw new UserError('amountErg is required');
      const amount = b.amountErg != null ? ergToNano(b.amountErg) : b.amount;
      return valun.createOffer({issuerId: b.issuerId, recipientId: b.recipientId, amount, purpose: b.purpose, dueAt: b.dueAt || b.dueDate || null});
    },
    async inspectOffer(id) { const v = await valun.inspectOffer(id); return {...v, offer: valun.obligationView(v.offer)}; },
    async decide(id, b) { return valun.obligationView(await valun.decide(id, b)); },
    async withdraw(id, b) { return valun.withdraw(id, b); },
    async ledger() {
      const ledger = await valun.ledger();
      return {source: SOURCE.LOCAL_BASIS, notes: ledger, reconciliation: await valun.reconcile(ledger), trackerState: await basis.trackerState()};
    },
    async testnet(live = false) { return {recorded: RECORDED, explorer: EXPLORER_UI, live: live ? await testnetLive() : null}; },
    audit() { return store.auditTail(200); },
  };
}
