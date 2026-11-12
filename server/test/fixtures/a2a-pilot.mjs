// A small in-memory pilot for the A2A front door (test/a2a.test.mjs, scripts/a2a-sdk-check.py's server): public participant
// records (one dormant, one not enrolled) and one applied set-off. Only what lib/a2a.mjs reads.
export function fakePilot() {
  const now = Date.now(), iso = t => new Date(t).toISOString();
  const P = (id, handle, extra) => ({id, handle, display_name: handle, operator: 'op', about: '', services: '', pubkey: '02' + 'ab'.repeat(32), status: 'active',
    created_at: iso(now - 864e5), last_seen_agent: iso(now - 60e3), ...extra});
  const participants = {
    vp_000000000001: P('vp_000000000001', 'sandbox-exact', {about: 'Always-right sandbox agent', services: 'text-stats (3 PC), notary (2 PC)'}),
    vp_000000000002: P('vp_000000000002', 'open-poet', {about: 'A poet agent', services: 'haiku-on-demand (3 PC)', sandbox_only: true, sandbox_expires_at: iso(now + 6 * 864e5)}),
    vp_000000000003: P('vp_000000000003', 'brief-bot', {about: 'Summaries of research papers', last_seen_agent: iso(now - 5e3)}),
    vp_000000000004: P('vp_000000000004', 'gone-agent', {about: 'haiku too', sandbox_only: true, sandbox_expires_at: iso(now - 1e3)}),   // dormant: not listed
    vp_000000000005: P('vp_000000000005', 'not-enrolled', {status: 'awaiting_agent', about: 'haiku'}),                                 // not active: not listed
    vp_000000000006: P('vp_000000000006', 'hidden-test', {about: 'haiku test agent', unlisted: true}),                                  // unlisted by the operator
  };
  const e = (a, b, k) => ({issuer: {id: a, pubkey: 'k' + a}, recipient: {id: b, pubkey: 'k' + b}, decrease: 2});
  const setoffs = {vs_00000000000000aa: {id: 'vs_00000000000000aa', state: 'applied', applied_at: iso(now - 3600e3), amount: 6,
    edges: [e('vp_000000000001', 'vp_000000000002'), e('vp_000000000002', 'vp_000000000003'), e('vp_000000000003', 'vp_000000000001')]}};
  return {s: {participants, setoffs}, dormant: p => !!p.sandbox_only && Date.parse(p.sandbox_expires_at) < Date.now(),
    publicParticipant: p => ({id: p.id, handle: p.handle, display_name: p.display_name, operator: p.operator, about: p.about, services: p.services, pubkey: p.pubkey,
      status: p.status, joined_at: p.created_at, agent_last_seen: p.last_seen_agent, ...(p.sandbox_only ? {sandbox_only: true, sandbox_expires_at: p.sandbox_expires_at} : {})}),
    directoryRecord(p) { return {...this.publicParticipant(p), ...(p.unlisted ? {unlisted: true} : {})}; },
    selfServe: () => ({join: '/pilot/v1/join-sandbox', open_network: true, days: 7, limits: {max_issue_per_deal: 5}})};
}
