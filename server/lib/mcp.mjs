// Valun MCP server (Model Context Protocol, JSON-RPC 2.0). Transport-independent: lib/http.mjs serves it as
// Streamable HTTP at POST /mcp (stateless, JSON responses); scripts/valun-mcp-stdio.mjs bridges stdio clients to it.
// Tools call the same service layer as the web UI. Write tools need the deployment's passphrase when one is set.
import {UserError} from './valun.mjs';
import {nanoToErg, CUSTODY} from './service.mjs';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = {name: 'valun', title: 'Valun credit desk', version: '0.2.0'};

const INSTRUCTIONS = `Valun lets agents and operators offer each other credit and decide whether to accept it.
Credit is recorded by a real Basis tracker (one cumulative IOU note per issuer->recipient pair; the recipient holds the claim).
This deployment is a SYNTHETIC demo: fake identities, unbacked credit denominated in ERG, no blockchain, no real funds.
${CUSTODY}
Typical flow: list_participants -> offer_credit (as issuer) -> inspect_offer (as recipient: signature, stale terms, the recipient's
Basis acceptance policy, the issuer's position) -> decide_offer (accept or decline) -> get_position / get_ledger.
Basis notes cannot be transferred: to pay a third party, a claim holder issues its own note (offer_credit).
Due dates are Valun-only terms; Basis does not enforce them. Settlement (redemption) needs an on-chain reserve and is not available here.`;

const S = (props, required = []) => ({type: 'object', properties: props, required, additionalProperties: false});
const pid = {type: 'string', pattern: '^p-\\d{4}$', description: 'Participant id, e.g. p-0001 (see list_participants)'};
const oid = {type: 'string', pattern: '^o-\\d{4}$', description: 'Offer id, e.g. o-0005'};
const erg = desc => ({type: 'string', pattern: '^\\d{1,7}(\\.\\d{1,9})?$', description: desc});
const RO = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
const RW = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};

// ---------- compact agent views ----------
const name = (svcState, id) => svcState.participants[id]?.name ?? id;
function offerView(o, st) {
  const iss = o.issuance;
  return {
    id: o.id, status: o.status, overdue: !!o.overdue,
    issuer: {id: o.issuerId, name: name(st, o.issuerId)}, recipient: {id: o.recipientId, name: name(st, o.recipientId)},
    creditErg: nanoToErg(o.terms.increment), cumulativeBeforeErg: nanoToErg(o.terms.priorTotal), cumulativeAfterErg: nanoToErg(o.terms.newTotal),
    purpose: o.terms.purpose || null, dueAt: o.terms.dueAt, offeredAt: o.createdAt, termsHash: o.termsHash,
    decision: o.decision ? {decision: o.decision.decision, by: name(st, o.decision.by), at: o.decision.at, reason: o.decision.reason || null, consentSignature: o.decision.signature} : null,
    issuance: iss ? {trackerStatus: iss.trackerStatus, trackerError: iss.trackerError ?? null, confirmation: iss.trackerNote?.confirmation?.status ?? null,
      readBackMatches: iss.readBackMatches ?? null, signatureVerifiedByValun: iss.signatureVerifiedByValun ?? null,
      trackerStateDigest: iss.proof?.tracker_state_digest ?? null, recovered: iss.recovered ?? false} : null,
    notes: [o.dueNote, o.status === 'issued' ? 'local Basis only: no on-chain commitment, not redeemable' : null].filter(Boolean),
  };
}
const positionView = p => ({participantId: p.participantId, claimsHeldErg: nanoToErg(p.claimsHeld), owesErg: nanoToErg(p.owes), netErg: nanoToErg(p.net),
  claims: p.claims.map(c => ({from: c.from, erg: nanoToErg(c.amount)})), debts: p.debts.map(d => ({to: d.to, erg: nanoToErg(d.amount)})), backing: p.backing});

// ---------- tools ----------
export function createMcp({service, store}) {
  const st = () => store.state;
  const tools = [
    {name: 'valun_overview', title: 'What Valun is and what is real here', write: false, annotations: RO,
      description: 'Explains this deployment: what is real (Basis tracker), what is Valun-only, what is not available, custody, and whether changes need a passphrase. Call this first.',
      inputSchema: S({}), run: async () => ({...(await service.status()), workflow: INSTRUCTIONS})},
    {name: 'list_participants', title: 'List participants', write: false, annotations: RO,
      description: 'All identities (agents and operators) with public key, acceptance policy and current position from the tracker.',
      inputSchema: S({}), run: async () => (await service.participants()).map(p => ({id: p.id, name: p.name, kind: p.kind, about: p.about, pubkey: p.pubkey,
        policy: p.policy, position: p.position && positionView(p.position)}))},
    {name: 'get_position', title: 'Position of one participant', write: false, annotations: RO,
      description: 'What a participant holds in claims, owes, and net, computed from the Basis tracker. No reserve backs any of it.',
      inputSchema: S({participantId: pid}, ['participantId']), run: async a => positionView(await service.position(a.participantId))},
    {name: 'create_participant', title: 'Create a participant', write: true, annotations: RW,
      description: 'Creates a new synthetic identity with a fresh secp256k1 key from Basis key generation. The server holds the key (demo custody).',
      inputSchema: S({name: {type: 'string', maxLength: 40}, kind: {type: 'string', enum: ['agent', 'operator']}, about: {type: 'string', maxLength: 200}}, ['name']),
      run: async a => service.createParticipant(a)},
    {name: 'offer_credit', title: 'Offer credit (as the issuer)', write: true, annotations: RW,
      description: 'The issuer signs a Basis note raising its cumulative debt to the recipient by amountErg, plus Valun terms. Nothing reaches the tracker until the recipient accepts. Unbacked credit.',
      inputSchema: S({issuerId: pid, recipientId: pid, amountErg: erg('Credit to offer, in ERG units, e.g. "0.5"'),
        purpose: {type: 'string', maxLength: 200}, dueDate: {type: 'string', description: 'Optional ISO date. Valun-only term; Basis does not enforce it.'}}, ['issuerId', 'recipientId', 'amountErg']),
      run: async a => offerView(await service.createOffer(a), st())},
    {name: 'list_offers', title: 'List offers and obligations', write: false, annotations: RO,
      description: 'Offers and obligations, newest first. Filter by participant, role (issuer/recipient) and status (offered, issued, declined, withdrawn, stale, issue_failed, submitting).',
      inputSchema: S({participantId: pid, role: {type: 'string', enum: ['issuer', 'recipient', 'any']}, status: {type: 'string'}}),
      run: async a => service.offers(a).map(o => offerView(o, st()))},
    {name: 'inspect_offer', title: 'Inspect an offer before deciding', write: false, annotations: RO,
      description: 'Everything a recipient needs: whether the issuer\'s Basis signature verifies, whether the terms are stale against the tracker, the recipient\'s Basis acceptance-policy result, and the issuer\'s position.',
      inputSchema: S({offerId: oid}, ['offerId']), run: async a => {
        const v = await service.inspectOffer(a.offerId);
        return {offer: offerView(v.offer, st()), checks: {issuerSignatureValid: v.basisNoteSignatureValid, stale: v.stale, currentTrackerTotalErg: nanoToErg(v.currentTotal),
          recipientHasPolicy: v.recipientPolicy.present, policyCheck: v.policyCheck}, issuerPosition: positionView(v.issuerPosition),
          note: 'The tracker would record this note even without consent and even if the policy says no; Valun only submits it after the recipient accepts.'};
      }},
    {name: 'decide_offer', title: 'Accept or decline an offer (as the recipient)', write: true, annotations: {...RW, destructiveHint: true},
      description: 'The recipient signs accept or decline. Accept submits the issuer-signed note to the Basis tracker and returns the tracker evidence. Final: cannot be undone.',
      inputSchema: S({offerId: oid, actorId: {...pid, description: 'The recipient\'s participant id'}, decision: {type: 'string', enum: ['accept', 'decline']}, reason: {type: 'string', maxLength: 200}}, ['offerId', 'actorId', 'decision']),
      run: async a => offerView(await service.decide(a.offerId, a), st())},
    {name: 'withdraw_offer', title: 'Withdraw an open offer (as the issuer)', write: true, annotations: RW,
      description: 'The issuer withdraws an offer that has not been decided. Valun will never submit its note.',
      inputSchema: S({offerId: oid, actorId: {...pid, description: 'The issuer\'s participant id'}}, ['offerId', 'actorId']),
      run: async a => offerView(await service.withdraw(a.offerId, a), st())},
    {name: 'set_acceptance_policy', title: 'Set a Basis acceptance policy (as the recipient)', write: true, annotations: RW,
      description: 'Signed by the participant and uploaded to the Basis tracker. whitelist: only trusted issuers, optionally up to maxDebtErg cumulative each; accept-any: any issuer. Advisory: shown before decisions, not enforced by the tracker.',
      inputSchema: S({participantId: pid, mode: {type: 'string', enum: ['whitelist', 'accept-any']}, trustedIds: {type: 'array', items: pid}, maxDebtErg: erg('Optional cumulative limit per trusted issuer')}, ['participantId', 'mode']),
      run: async a => { const p = await service.setPolicy(a.participantId, a); return {mode: p.mode, trustedIds: p.trustedIds, maxDebtErg: nanoToErg(p.maxDebt), policyHash: p.policyHash, uploadedAt: p.uploadedAt}; }},
    {name: 'get_ledger', title: 'Basis tracker ledger and reconciliation', write: false, annotations: RO,
      description: 'Every note in the tracker (who owes whom, cumulative totals, confirmation status) and whether each total is explained by offers the recipient accepted in Valun.',
      inputSchema: S({}), run: async () => {
        const l = await service.ledger();
        return {source: l.source, trackerLocalDigest: l.trackerState.local_digest, confirmedOnChain: l.trackerState.confirmed_digest,
          notes: l.notes.map(n => ({issuer: n.issuerName ?? n.issuer, recipient: n.recipientName ?? n.recipient, cumulativeErg: nanoToErg(n.total), redeemedErg: nanoToErg(n.redeemed), confirmation: n.confirmation})),
          reconciliation: l.reconciliation};
      }},
    {name: 'get_testnet_evidence', title: 'The funded Basis note on Ergo testnet', write: false, annotations: {...RO, openWorldHint: true},
      description: 'The one real funded note -> reserve -> redemption on Ergo testnet (2026-10-31/11-01), what was verified and what was not. live=true re-reads the boxes from the public testnet explorer.',
      inputSchema: S({live: {type: 'boolean'}}), run: async a => {
        const t = await service.testnet(!!a.live);
        return {steps: t.recorded.steps, verified: t.recorded.verified, notEstablished: t.recorded.notEstablished, explorer: t.explorer,
          live: t.live && {source: t.live.source, at: t.live.at, allMatch: t.live.allMatch, chainHeight: t.live.network?.height,
            boxes: t.live.boxes.map(b => ({role: b.role, box: b.box, value: b.value, spentBy: b.spentBy, matchesRecord: b.ok})), redemptionConfirmations: t.live.redemption?.confirmations}};
      }},
  ];
  const byName = new Map(tools.map(t => [t.name, t]));
  const listed = tools.map(({run, write, ...t}) => ({...t, description: t.description + (write ? ' Requires the demo passphrase on this deployment if one is set.' : '')}));

  async function callTool(params, ctx) {
    const t = byName.get(params?.name);
    if (!t) return {error: {code: -32602, message: `unknown tool: ${params?.name}`}};
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) return {error: {code: -32602, message: 'arguments must be an object'}};
    const fail = text => ({result: {content: [{type: 'text', text}], isError: true}});
    if (t.write) {
      if (!ctx.writeAllowed) return fail('This deployment requires the demo passphrase for changes. Configure your MCP client to send the header "x-valun-token: <passphrase>" (or "Authorization: Bearer <passphrase>"). Read-only tools work without it.');
      if (ctx.rateLimited?.()) return fail('Too many changes from this address; try again in a few minutes.');
    }
    for (const k of Object.keys(args)) if (!(k in t.inputSchema.properties)) return fail(`unknown argument "${k}" for ${t.name}`);
    for (const k of t.inputSchema.required) if (args[k] == null || args[k] === '') return fail(`missing required argument "${k}"`);
    try {
      const out = await t.run(args);
      const structured = Array.isArray(out) ? {items: out} : out;
      return {result: {content: [{type: 'text', text: JSON.stringify(structured, null, 1)}], structuredContent: structured, isError: false}};
    } catch (e) {
      if (e instanceof UserError) return fail(e.message);
      if (e.name === 'BasisError') { console.error(`[mcp] ${t.name}: ${e.message}`); return fail(e.publicMessage); }   // details only in the log (OQ-35)
      console.error(`[mcp] ${t.name}: ${e.message}`);
      return fail('internal error');
    }
  }

  // Handle one JSON-RPC message. Returns a response object, or null for notifications.
  async function handle(msg, ctx = {}) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && (msg.result !== undefined || msg.error !== undefined)) return null; // a client response; nothing to do
      return {jsonrpc: '2.0', id: msg?.id ?? null, error: {code: -32600, message: 'invalid JSON-RPC request'}};
    }
    const isNotification = !('id' in msg);
    let out;
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params?.protocolVersion;
        out = {result: {protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
          capabilities: {tools: {listChanged: false}}, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS}};
        break;
      }
      case 'ping': out = {result: {}}; break;
      case 'tools/list': out = {result: {tools: listed}}; break;
      case 'tools/call': out = await callTool(msg.params, ctx); break;
      default:
        if (msg.method.startsWith('notifications/')) return null;
        out = {error: {code: -32601, message: `method not found: ${msg.method}`}};
    }
    return isNotification ? null : {jsonrpc: '2.0', id: msg.id, ...out};
  }
  return {handle, tools: listed};
}
