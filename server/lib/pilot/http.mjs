// Pilot HTTP routes (/pilot/v1/*). Per-participant bearer tokens; no global passphrase. See docs/PILOT-API.md.
import {PilotError, NETWORK, PROTOCOL, statements, circulationStatements, sha256} from './core.mjs';
import {ON_TESTNET} from './units.mjs';
import {toErgoJson} from '../ergo-json.mjs';
import {featuresFor, NOVATION_INFO} from './caps.mjs';
import {METRICS_CACHE_MS} from './clearing.mjs';
import {loopsOf, loopOf, LOOP_ID_RE, renderLoopPage, renderLoopNotFound} from './loops.mjs';
import {AGENT_HANDLE_RE, agentView, renderAgentPage, renderAgentNotFound} from './agents.mjs';

// The source text of each statement template, as /info publishes it (OQ-18).
const sources = o => Object.fromEntries(Object.entries(o).map(([k, f]) => [k, f.toString().replace(/\s+/g, ' ')]));

// GET /info `description`. Modes off and bound: v15's text, word for word (nothing moves or clears a note there).
// Modes sandbox and on (OQ-49): set-offs do clear obligations and notes move between creditors, so the text ends with
// the wording of the deal's settlement label with circulating credit on (core.mjs CIRCULATION_SETTLEMENT, spec 16.1),
// and in mode sandbox it also says whom circulating credit is on for.
const INFO_PREFIX = ON_TESTNET
  ? 'Valun testnet network: independently controlled agents propose, negotiate and accept service-for-credit deals. Amounts are nanoERG on Ergo TESTNET: test coins with no monetary value. When a payer accepts a delivery it issues a credit note: a payer-signed Basis note recorded by a Basis tracker that anchors its state on Ergo testnet.'
  : 'Valun pilot network: independently controlled agents propose, negotiate and accept service-for-credit deals. PC (pilot credits) are simulated units with no monetary value. When a payer accepts a delivery it issues a credit note: a payer-signed Basis note recorded by a real Basis tracker that has no blockchain connection.';
const INFO_SETTLEMENT = ON_TESTNET
  ? 'an outstanding obligation. With circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes), also on an edge whose total the tracker box on Ergo testnet commits: never below a total the tracker signed for a redemption, and only while that tracker box is fresh. A change is final once the next tracker box on Ergo testnet commits it. A creditor can redeem a note on Ergo testnet against its issuer\'s tERG reserve, if the issuer posted one; tERG have no monetary value.'
  : 'not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, there is no reserve, and PC have no value.';
export const INFO_DESCRIPTIONS = Object.freeze({
  off: ON_TESTNET ? `${INFO_PREFIX} An issued note is an outstanding obligation. A creditor can redeem it on Ergo testnet against its issuer's tERG reserve, if the issuer posted one; tERG have no monetary value. Debt transfers and set-offs (netting) are not on for this network yet: they come once netting is anchored on chain.` : `${INFO_PREFIX} An issued note is an outstanding obligation; nothing in the pilot is settled (no redemption, reserve or clearing).`,
  on: `${INFO_PREFIX} An issued note is ${INFO_SETTLEMENT}`,
  sandbox: `${INFO_PREFIX} An issued note is ${INFO_SETTLEMENT} On this server circulating credit is on for sandbox participants only: the sandbox agents and those who joined with join-sandbox.`,
});
// Self-serve sandbox joins per client address per hour (guests at one venue share an address); the server-wide daily
// cap is SANDBOX_JOINS_PER_DAY in core.mjs.
export const SANDBOX_JOINS_PER_HOUR_PER_ADDRESS = 12;
// Settlement on Ergo testnet: the smallest redemption (the miner fee the tracker pays for it) and the redemption builds
// one agent may ask for in 24 hours (in memory; a restart forgets them).
export const REDEMPTION_MIN_NANOERG = 1_000_000, REDEMPTION_BUILDS_PER_DAY = 6;
export const IP_READS_PER_MINUTE = 1800;           // per client address (venue Wi-Fi); each token keeps its own reads-per-minute limit
// Burst protection: the public reads (GET /info, /participants, /participants/<id>, /ledger, /loops, /loops/<id> and the
// loop card) are computed at most once per PUBLIC_CACHE_MS while the pilot state is unchanged (Pilot.generation, bumped
// by every save), so many viewers do not multiply tracker reads. Nothing authenticated or per-caller is cached. The
// hosted server turns it on (server.mjs: PILOT_PUBLIC_CACHE_MS, default PUBLIC_CACHE_MS); off unless cfg.publicCacheMs
// is set, so a read right after a change made around the pilot (a test writing to the tracker) is never stale.
export const PUBLIC_CACHE_MS = 3000;
const PUBLIC_CACHE_MAX = 500;
const HTML = 'text/html; charset=utf-8';

const infoDescription = mode => INFO_DESCRIPTIONS[mode === 'sandbox' || mode === 'on' ? mode : 'off'];
// GET /info `writes_refused` (MIG-1, release v16.1): {code: 'tracker_downgraded', since, reason, fix} while the server
// refuses every pilot write because its tracker reports no valid tracker v3.2 capabilities and the state holds
// circulating-credit history; nothing (the key absent) otherwise.
export const WRITES_REFUSED_FIX = 'put the tracker v3.2 binary back (docs/DEPLOY-0.4-RUNBOOK.md step 4); or, before going back to release v15, run the downgrade check in maintenance mode (runbook R3). The server reads the tracker\'s capabilities again every 60 s and resumes writes once they are tracker v3.2\'s.';
const writesRefused = pilot => {
  const r = pilot.writeRefusal?.() ?? null;
  return r ? {writes_refused: {code: r.code, since: r.since, reason: r.reason, fix: WRITES_REFUSED_FIX}} : {};
};

export function createPilotRoutes({pilot, cfg, adminTokenHash = null}) {
  const hits = new Map(), perMinute = cfg.pilotRateLimitPerMinute ?? 90, readsPerMinute = cfg.pilotReadLimitPerMinute ?? perMinute * 4;
  const redemptionBuilds = new Map();             // agent id -> times of its redemption builds in the last 24 hours
  // Built redemptions by transaction id, for their submit (30 minutes, the tracker's own expiry): what the tracker's
  // POST /redemption/submit still takes besides the transactions (issuer, recipient, amounts; the tracker reads them
  // from its own build entry and ignores these, but its request shape requires them).
  const builtRedemptions = new Map();
  // Several agents and viewers may share one address (a venue Wi-Fi): public reads are served from the burst cache, so the
  // per-address read budget is larger than one token's (each token keeps readsPerMinute).
  const ipReadsPerMinute = cfg.pilotIpReadLimitPerMinute
    ?? (cfg.pilotReadLimitPerMinute != null || cfg.pilotRateLimitPerMinute != null ? readsPerMinute : Math.max(readsPerMinute, IP_READS_PER_MINUTE));
  let calls = 0;
  const sandboxJoins = new Map();
  // GET /clearing is computed at most once per 10 s (METRICS_CACHE_MS: it reads the tracker and runs the engine's measures).
  let clearingCache = null;
  // The public read cache: key -> {at, gen, value: Promise<{status, body}>} (body a string, sent as it is). Single-flight:
  // requests that arrive while an entry is being computed share it; one that fails is dropped. Off unless
  // cfg.publicCacheMs > 0.
  const publicCache = new Map(), publicCacheMs = Number(cfg.publicCacheMs) > 0 ? Number(cfg.publicCacheMs) : 0;
  let cacheReads = 0;
  function cachedRead(key, fn) {
    const t = Date.now(), gen = pilot.generation ?? 0, hit = publicCache.get(key);
    if (publicCacheMs > 0 && hit && hit.gen === gen && t >= hit.at && t - hit.at < publicCacheMs) return hit.value;
    cacheReads += 1;
    const entry = {at: t, gen, value: Promise.resolve().then(fn)};
    if (publicCacheMs <= 0) return entry.value;
    entry.value.catch(() => { if (publicCache.get(key) === entry) publicCache.delete(key); });
    publicCache.set(key, entry);
    if (publicCache.size > PUBLIC_CACHE_MAX) for (const [k, v] of publicCache) if (v !== entry && (v.gen !== gen || t - v.at >= publicCacheMs)) publicCache.delete(k);
    return entry.value;
  }
  const json = v => JSON.stringify(v, null, 1);
  // Cached, the body is kept as the JSON text send() would write (serialized once); uncached, it is passed on as before.
  const sendCached = async (res, send, key, fn) => {
    if (publicCacheMs <= 0) return send(res, 200, await fn());
    const r = await cachedRead(key, async () => ({status: 200, body: json(await fn())}));
    return send(res, r.status, r.body);
  };
  const publicOf = x => pilot.publicParticipant(x);
  const limited = (key, max = perMinute) => {
    const now = Date.now(), w = (hits.get(key) || []).filter(t => now - t < 60_000);
    w.push(now); hits.set(key, w);
    if (++calls % 1000 === 0) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= 60_000) hits.delete(k);   // prune idle keys
    return w.length > max;
  };
  const bearer = req => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1] || null;

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 65_536) throw new PilotError('too_large', 'request body too large', 413); chunks.push(c); }
    if (!chunks.length) return {};
    let v;
    try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PilotError('bad_json', 'body must be JSON'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new PilotError('bad_json', 'body must be a JSON object');
    return v;
  }

  async function handle(req, res, url, send, clientIp) {
    const p = url.pathname.slice('/pilot/v1'.length) || '/';
    const G = req.method === 'GET', P = req.method === 'POST', U = req.method === 'PUT';
    let m;
    const ip = clientIp(req);
    if (!G && limited(`ip:${ip}`)) throw new PilotError('rate_limited', 'too many requests; slow down', 429);
    // Every read counts against a per-IP read budget, whatever Authorization header it carries: public routes are
    // served before authentication, so a made-up bearer token must not skip it (F2, OQ-30).
    if (G && limited(`ipr:${ip}`, ipReadsPerMinute)) throw new PilotError('rate_limited', 'too many requests; slow down', 429);

    // ---------- admin: loopback only (e.g. `fly ssh console`), never via the proxy, with the volume-held admin token ----------
    if (p.startsWith('/admin/')) {
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const proxied = req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.headers['fly-forwarded-port'];
      const tok = req.headers['x-valun-admin'] ? sha256(String(req.headers['x-valun-admin'])) : null;
      if (!adminTokenHash || !loopback || proxied || tok !== adminTokenHash) throw new PilotError('not_found', 'not found', 404);
      if (P && p === '/admin/invites') { const b = await readJson(req); return send(res, 201, pilot.createInvite({note: b.note, maxUses: b.max_uses ?? 1, ttlDays: b.ttl_days ?? 14})); }
      if (G && p === '/admin/invites') return send(res, 200, Object.values(pilot.s.invites).map(({code_hash, ...i}) => i));
      // Operator actions on a participant, at that participant owner's request (recorded as by: 'operator' and shown to
      // the owner): issue an enrollment code while no agent key is registered; change the owner's mandate.
      if (P && (m = /^\/admin\/participants\/(vp_[0-9a-f]{12})\/owner-token$/.exec(p)))   // recovery, at the verified owner's request
        return send(res, 200, await pilot.rotateOwnerToken(pilot.participant(m[1]), {by: 'operator'}));
      if (P && (m = /^\/admin\/participants\/(vp_[0-9a-f]{12})\/enrollment-code$/.exec(p))) {
        const x = pilot.participant(m[1]);
        if (x.pubkey) throw new PilotError('already_enrolled', 'an agent key is registered; the owner must revoke it first', 409);
        return send(res, 200, pilot.newEnrollmentCode(x, {by: 'operator'}));
      }
      if (U && (m = /^\/admin\/participants\/(vp_[0-9a-f]{12})\/mandate$/.exec(p))) return send(res, 200, pilot.setMandate(pilot.participant(m[1]), await readJson(req), {by: 'operator'}));
      // List or unlist a participant in the directory (operator test and demo agents that are not running).
      if (U && (m = /^\/admin\/participants\/(vp_[0-9a-f]{12})\/listing$/.exec(p))) return send(res, 200, pilot.setListed(pilot.participant(m[1]), (await readJson(req)).listed));
      // The clearing engine (circulation modes sandbox and on; otherwise these routes do not exist): a batch run now, and
      // its diagnostics (ids included: operator only).
      if (pilot.circulating && P && p === '/admin/clearing/run') {
        await readJson(req);
        if (!pilot.clearing) throw new PilotError('clearing_not_running', 'the clearing engine is not running on this server', 409);
        return send(res, 200, await pilot.clearing.run('admin'));
      }
      if (pilot.circulating && G && p === '/admin/clearing') return send(res, 200, pilot.clearingDiagnostics());
      throw new PilotError('not_found', 'not found', 404);
    }

    // ---------- public ----------
    // With circulating credit effectively on (mode bound and above; lib/pilot/caps.mjs) /info also lists the features,
    // the novation constants and the circulation statements. In mode off it is exactly as before.
    if (G && p === '/info') return sendCached(res, send, 'info', () => {
      const mode = pilot.mode;
      return {
        network: NETWORK, protocol: PROTOCOL, unit: pilot.unit, denomination: pilot.basis.denomination, tracker_nft_id: pilot.basis.nft,
        tracker_on_chain: !!pilot.chain?.on_chain, experimental: true,
        ...(pilot.chain ? {chain: pilot.chain} : {}),
        description: infoDescription(mode),
        statements: sources(statements),
        participants: Object.values(pilot.s.participants).filter(x => x.status === 'active').length,
        ...(mode !== 'off' ? {features: featuresFor(mode), novation: NOVATION_INFO, circulation_statements: sources(circulationStatements)} : {}),
        ...(pilot.selfServe?.() ? {self_serve: pilot.selfServe()} : {}),
        // MIG-1 (release v16.1): only while pilot writes are refused (Pilot.writeRefusal), so that the operator's live
        // check sees it; absent otherwise (a v15 state in mode off answers exactly as before).
        ...writesRefused(pilot),
      };
    });
    // ---------- Ergo testnet (valun-testnet-1, once on chain): the chain view and the reserves, public ----------
    // GET /chain: the tracker's anchoring (its local digest, the digest its tracker box commits on testnet, that box and
    // height, an update in flight) and where to look on the explorer. GET /reserves: every Basis reserve the tracker
    // scans for this tracker's NFT, each with its owner's handle when the owner is a participant.
    if (ON_TESTNET && G && (p === '/chain' || p === '/reserves')) {
      if (!pilot.chain?.on_chain) throw new PilotError('testnet_bootstrapping', 'the Valun testnet tracker is not on chain yet', 503);
      if (p === '/chain') return sendCached(res, send, 'chain', async () => {
        const st = await pilot.basis.trackerState().catch(() => null);
        const ex = pilot.chain.explorer;
        return {network: NETWORK, ...pilot.chain, anchoring: st && {local_digest: st.local_digest, confirmed_digest: st.confirmed_digest ?? null,
          confirmed_box_id: st.confirmed_box_id ?? null, confirmed_height: st.confirmed_height ?? null, pending_tx_id: st.pending_tx_id ?? null,
          anchored: !!st.confirmed_digest && st.confirmed_digest === st.local_digest},
          links: {tracker_nft: `${ex}/en/token/${pilot.chain.tracker_nft_id}`, tracker_address: pilot.chain.tracker_address && `${ex}/en/addresses/${pilot.chain.tracker_address}`}};
      });
      return sendCached(res, send, 'reserves', async () => {
        const list = await pilot.basis.reserves();
        const rows = (Array.isArray(list) ? list : []).map(r => {
          const owner = typeof r.owner_pubkey === 'string' ? r.owner_pubkey : null, who = owner ? pilot.byPubkey(owner) : null;
          return {box_id: r.box_id ?? null, owner_pubkey: owner, handle: who?.handle ?? null, collateral_nanoerg: Number(r.collateral_amount ?? 0),
            total_debt_nanoerg: Number(r.total_debt ?? 0), collateralization_ratio: r.collateralization_ratio ?? null,
            last_updated_height: r.last_updated_height ?? null, refund_initiation_height: r.refund_initiation_height ?? null,
            reserve_token_id: r.reserve_token_id ?? null};
        });
        return {network: NETWORK, unit: pilot.unit, reserve_contract: pilot.chain.reserve_contract, reserves: rows};
      });
    }
    // The directory leaves out participants the operator unlisted (test or demo agents that are not running); ?all=1 lists
    // every participant (the network view draws every edge), each unlisted one with unlisted: true.
    if (G && p === '/participants') {
      const all = url.searchParams.get('all') === '1';
      return sendCached(res, send, all ? 'participants:all' : 'participants', () => Object.values(pilot.s.participants).filter(x => all || !x.unlisted).map(x => pilot.directoryRecord(x)));
    }
    if (G && (m = /^\/participants\/(vp_[0-9a-f]{12})$/.exec(p))) {
      const x = pilot.participant(m[1]);
      return sendCached(res, send, `participant:${x.id}`, async () => ({...pilot.directoryRecord(x), public_position: await pilot.publicPosition(x)}));
    }
    // The reconciliation rows are v15's in every mode (SV-PRIV-1, owner decision 9): no per-edge journal columns here.
    if (G && p === '/ledger') return sendCached(res, send, 'ledger', async () => { const l = await pilot.ledger(); return {unit: pilot.unit, notes: l, reconciliation: await pilot.reconcile(l, {public: true})}; });
    // Closed loops (applied set-offs; lib/pilot/loops.mjs): public handles and amounts only, newest first. In every mode
    // (with circulation off there are none).
    if (G && p === '/loops') return sendCached(res, send, 'loops', () => ({unit: pilot.unit, network: NETWORK, loops: loopsOf(pilot.s.setoffs, pilot.s.participants, publicOf)}));
    if (G && (m = /^\/loops\/([^/]+)$/.exec(p))) {
      const o = LOOP_ID_RE.test(m[1]) ? pilot.setoff(m[1]) : null;
      if (!o || o.state !== 'applied') throw new PilotError('not_found', 'unknown loop', 404);
      return sendCached(res, send, `loop:${o.id}`, () => loopOf(o, pilot.s.participants, publicOf));
    }
    // The clearing engine's public aggregates (circulation modes sandbox and on; no participant ids, handles or keys).
    // In other modes the route does not exist (it falls through, as any unknown route does).
    // Single-flight: requests that arrive while the aggregates are being computed share that computation (the cache holds
    // its promise); one that fails is dropped, so the next request computes them again.
    if (G && p === '/clearing' && pilot.circulating) {
      const t = Date.now();
      if (!clearingCache || t - clearingCache.at >= METRICS_CACHE_MS || t < clearingCache.at) {
        const entry = {at: t, value: Promise.resolve().then(() => pilot.publicClearing())};
        entry.value.catch(() => { if (clearingCache === entry) clearingCache = null; });
        clearingCache = entry;
      }
      return send(res, 200, await clearingCache.value);
    }
    // The testnet network before its tracker is on chain (the bootstrap has not minted the tracker NFT yet): nothing that
    // would sign or record a deal is taken, so no note is ever signed for a placeholder tracker id.
    if (ON_TESTNET && !pilot.chain?.on_chain && req.method !== 'GET' && req.method !== 'HEAD' && !p.startsWith('/admin/'))
      throw new PilotError('testnet_bootstrapping', 'the Valun testnet tracker is not on chain yet; try again once its tracker NFT is minted (GET /pilot/v1/info: tracker_on_chain)', 503);
    if (P && p === '/join') return send(res, 201, await pilot.join(await readJson(req)));
    if (P && p === '/join-sandbox') {        // no invite: sandbox-only participants (off unless enabled); 12 per address per hour
      const now = Date.now(), w = (sandboxJoins.get(ip) || []).filter(t => now - t < 3600e3);
      if (pilot.openSandbox && w.length >= SANDBOX_JOINS_PER_HOUR_PER_ADDRESS) throw new PilotError('rate_limited', `at most ${SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} sandbox joins per hour from one address`, 429);
      const r = await pilot.joinSandbox(await readJson(req));
      w.push(now); sandboxJoins.set(ip, w);
      return send(res, 201, r);
    }
    if (P && p === '/enroll') return send(res, 201, await pilot.enroll(await readJson(req)));

    // ---------- authenticated ----------
    // X-Valun-Features: the consent roles an agent's client signs by itself (kept only with circulation on).
    const who = pilot.authenticate(bearer(req), {features: req.headers['x-valun-features']});
    if (!who) throw new PilotError('unauthorized', 'missing or invalid token (Authorization: Bearer vpa_… for an agent, vpo_… for an owner)', 401);
    // Writes and reads have separate budgets per token: polling an inbox must not use up the budget for acting.
    if (limited(`tok:${who.p.id}:${who.role}:${G ? 'r' : 'w'}`, G ? readsPerMinute : perMinute)) throw new PilotError('rate_limited', 'too many requests; slow down', 429);
    const me = who.p;

    // Limits recorded from the owner's instructions (agent or owner); always within the owner's mandate.
    if (U && p === '/limits') return send(res, 200, pilot.setAgentLimits(me, await readJson(req), {by: who.role}));
    // ---------- Ergo testnet: settlement for this agent (its own key signs its own Ergo transactions) ----------
    // POST /reserves/create {erg_amount, nft_id}: the payment request for a reserve owned by this agent's key (the tracker
    // builds it: the Basis ERG reserve contract, R4 the agent's key, R5 the empty redemption tree, R6 this tracker's NFT;
    // nft_id = the id of the first box the agent's transaction spends, which mints the reserve NFT). The agent's client
    // builds, signs and broadcasts the transaction.
    // POST /redemption/build {issuer, amount}: a redemption of `amount` nanoERG of the issuer's note to this agent
    // against the issuer's reserve: the tracker builds it, fee-signed by the tracker, with the tracker's signature and the
    // proofs; this agent's client signs its input (the receiver's proof) and posts it to /redemption/submit.
    if (ON_TESTNET && P && (p === '/reserves/create' || p === '/redemption/build' || p === '/redemption/submit')) {
      if (who.role !== 'agent') throw new PilotError('agent_only', 'settlement is signed by the agent\'s own key', 403);
      if (!pilot.chain?.on_chain) throw new PilotError('testnet_bootstrapping', 'the Valun testnet tracker is not on chain yet', 503);
      const body = await readJson(req);
      const relay = async f => {
        try { return await f(); }
        catch (e) { if (e?.name === 'BasisError') throw new PilotError('tracker_refused', String(e.message).replace(/^tracker \w+ \S+: /, '').slice(0, 300), 409); throw e; }
      };
      if (p === '/reserves/create') {
        const erg = body?.erg_amount, nft = body?.nft_id;
        if (!Number.isSafeInteger(erg) || erg < 10_000_000 || erg > 2_000_000_000) throw new PilotError('invalid_field', 'erg_amount: whole nanoERG, 10000000 (0.01 tERG) to 2000000000 (2 tERG)');
        if (typeof nft !== 'string' || !/^[0-9a-f]{64}$/.test(nft)) throw new PilotError('invalid_field', 'nft_id: the id of the first box your transaction spends (64 hex)');
        return send(res, 200, await relay(() => pilot.basis.reserveCreate({nftId: nft, ownerPubkey: me.pubkey, ergAmount: erg})));
      }
      if (p === '/redemption/build') {
        const amount = body?.amount, X = typeof body?.issuer === 'string' ? (pilot.s.participants[body.issuer] || Object.values(pilot.s.participants).find(q => q.handle === body.issuer)) : null;
        if (!X || !X.pubkey) throw new PilotError('not_found', 'issuer: the participant id or handle of the agent whose note you hold', 404);
        // The tracker pays each redemption's miner fee (0.001 tERG) from its own capped funds: a redemption redeems at
        // least that much, and an agent builds at most REDEMPTION_BUILDS_PER_DAY a day.
        if (!Number.isSafeInteger(amount) || amount < REDEMPTION_MIN_NANOERG) throw new PilotError('invalid_field', `amount: whole nanoERG to redeem, at least ${REDEMPTION_MIN_NANOERG} (the miner fee the tracker pays)`);
        const now = Date.now(), builds = (redemptionBuilds.get(me.id) || []).filter(t => now - t < 864e5);
        if (builds.length >= REDEMPTION_BUILDS_PER_DAY) throw new PilotError('rate_limited', `at most ${REDEMPTION_BUILDS_PER_DAY} redemption builds a day per agent`, 429);
        builds.push(now); redemptionBuilds.set(me.id, builds);
        const note = await relay(() => pilot.basis.note(X.pubkey, me.pubkey));
        if (!note) throw new PilotError('no_note', `you hold no note of ${X.handle}`, 409);
        const outstanding = Number(note.amount_collected) - Number(note.amount_redeemed || 0);
        if (amount > outstanding) throw new PilotError('insufficient_claim', `you can redeem at most ${outstanding} nanoERG of ${X.handle}'s note`, 409);
        const built = await relay(() => pilot.basis.redemptionBuild({issuer_pubkey: X.pubkey, recipient_pubkey: me.pubkey, amount,
          timestamp: Number(note.timestamp), issuer_signature: note.signature, denomination: 'erg'}));
        pilot.store.audit({type: 'redemption.built', issuer: X.id, recipient: me.id, amount});
        for (const [k, v] of builtRedemptions) if (now - v.at > 30 * 60e3) builtRedemptions.delete(k);
        if (typeof built?.partial_tx?.id === 'string') builtRedemptions.set(built.partial_tx.id, {at: now, recipient: me.id,
          issuer_pubkey: X.pubkey, redeemed_amount: amount, new_already_redeemed: Number(built.new_already_redeemed ?? 0)});
        // Written with toErgoJson: the transactions' context extensions in the tracker's (Scala's) order, which the
        // client signs over and echoes back to /redemption/submit.
        return send(res, 200, toErgoJson({issuer: {id: X.id, handle: X.handle, pubkey: X.pubkey}, amount, ...built}));
      }
      const rec = typeof body?.signed_tx?.id === 'string' ? builtRedemptions.get(body.signed_tx.id) : undefined;
      if (rec && rec.recipient !== me.id) throw new PilotError('not_found', 'no redemption of yours was built with this transaction', 404);
      const out = await relay(() => pilot.basis.redemptionSubmit({signed_tx: body?.signed_tx, unsigned_tx: body?.unsigned_tx,
        issuer_pubkey: rec?.issuer_pubkey ?? '', recipient_pubkey: me.pubkey, redeemed_amount: rec?.redeemed_amount ?? 0,
        new_already_redeemed: rec?.new_already_redeemed ?? 0}));
      if (rec) builtRedemptions.delete(body.signed_tx.id);
      pilot.store.audit({type: 'redemption.submitted', recipient: me.id, tx_id: out?.tx_id ?? null});
      return send(res, 200, {...out, explorer: out?.tx_id ? `${pilot.chain.explorer}/en/transactions/${out.tx_id}` : null});
    }
    // The public profile (display_name, about, services, wants), by the agent or the owner.
    if (U && p === '/profile') return send(res, 200, pilot.setProfile(me, await readJson(req), {by: who.role}));
    // With circulating credit on (modes sandbox and on) /me and /owner also give the owner's credit policy and the
    // features (the server's, and the consent roles counted for the agent's client); in other modes they are as before.
    const circulationKeys = () => (pilot.circulating ? {credit_policy: pilot.creditPolicy(me), features: pilot.featuresOf(me)} : {});
    if (G && p === '/me') return send(res, 200, {role: who.role, participant: pilot.publicParticipant(me), mandate: me.mandate, mandate_version: me.mandate_version,
      agent_limits: me.agent_limits || {}, agent_limits_recorded_by: me.agent_limits_recorded_by || {}, effective_limits: pilot.effectiveLimits(me), mandate_changed_by: me.mandate_changed_by || 'owner',
      position: await pilot.position(me, null, {own: true}), network: NETWORK, unit: pilot.unit,
      authority: who.role === 'agent'
        ? 'agent token: may read this participant\'s deals and act within the owner\'s mandate; commitments above approve_above wait for the owner'
        : 'owner token: may change the mandate, decide approvals, revoke the agent and rotate this owner token',
      ...circulationKeys()});
    if (G && p === '/inbox') return send(res, 200, pilot.inbox(me));
    // Deal views as the server answers them (dealView: next_actions judged as the payment routes judge them).
    if (G && p === '/deals') return send(res, 200, (await Promise.all(pilot.dealsFor(me).map(d => pilot.dealView(d, me)))).reverse());
    if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})$/.exec(p))) return send(res, 200, await pilot.dealView(pilot.partyDeal(m[1], me), me));
    if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})\/credit-note-template$/.exec(p))) {
      if (who.role !== 'agent') throw new PilotError('agent_only', 'credit notes are signed by the agent\'s key', 403);
      // Opt-in: ?prior=1 adds the pair's tracker note (any mode); ?bound=1 asks for a bound note (mode bound and above).
      const q = url.searchParams;
      return send(res, 200, await pilot.noteTemplate(me, m[1], {prior: q.get('prior') === '1', bound: q.get('bound') === '1'}));
    }
    // The caller's edges and its edge-journal entries (agent and owner); with circulation off this route does not exist.
    if (G && p === '/edges' && pilot.mode !== 'off') {
      const since = url.searchParams.get('since');
      return send(res, 200, await pilot.edges(me, {since: since === null || since === '' ? 0 : /^\d{1,15}$/.test(since) ? Number(since) : NaN}));
    }
    // Payment by debt transfer and consents (circulation modes sandbox and on; in mode sandbox only for sandbox
    // participants). Otherwise these routes do not exist: they end in the same 404 as any unknown route, below.
    if (pilot.circulationFor(me)) {
      const agentOnly = () => { if (who.role !== 'agent') throw new PilotError('agent_only', 'payments are made and signed by the agent\'s key', 403); };
      if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})\/payment-options$/.exec(p))) { agentOnly(); return send(res, 200, await pilot.paymentOptions(me, m[1])); }
      if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})\/transfer-template$/.exec(p))) { agentOnly(); return send(res, 200, await pilot.transferTemplate(me, m[1], url.searchParams.get('issuer'))); }
      // GET /consents (the owner token reads them too): an agent's poll first lets the clearing engine propose set-offs
      // through it (at most once per 30 s; Clearing.proposeFor never throws).
      if (G && p === '/consents') {
        if (who.role === 'agent' && pilot.clearing) await pilot.clearing.proposeFor(me);
        return send(res, 200, pilot.consentsFor(me));
      }
      if (G && (m = /^\/transfers\/(vt_[0-9a-f]{16})$/.exec(p))) return send(res, 200, pilot.transferFor(me, m[1]));
      if (G && (m = /^\/setoffs\/(vs_[0-9a-f]{16})$/.exec(p))) return send(res, 200, pilot.setoffFor(me, m[1]));
      if (P && who.role === 'agent') {
        if ((m = /^\/deals\/(vd_[0-9a-f]{16})\/pay-by-transfer$/.exec(p))) return send(res, 200, await pilot.payByTransfer(me, m[1], await readJson(req)));
        if ((m = /^\/deals\/(vd_[0-9a-f]{16})\/cancel-transfer$/.exec(p))) { await readJson(req); return send(res, 200, await pilot.cancelTransfer(me, m[1])); }
        // A consent to a transfer (vt_) or a set-off (vs_).
        if ((m = /^\/consents\/(v[st]_[0-9a-f]{16})$/.exec(p))) return send(res, 200, await pilot.submitConsent(me, m[1], await readJson(req)));
        if ((m = /^\/consents\/(v[st]_[0-9a-f]{16})\/refuse$/.exec(p))) return send(res, 200, await pilot.refuseConsent(me, m[1], await readJson(req)));
      }
    }

    if (who.role === 'agent') {
      if (P && p === '/deals') return send(res, 201, await pilot.propose(me, await readJson(req)));
      if (P && (m = /^\/deals\/(vd_[0-9a-f]{16})\/(counter|accept|decline|withdraw|deliver|complete|dispute)$/.exec(p))) {
        const body = await readJson(req), id = m[1];
        const out = await ({counter: () => pilot.counter(me, id, body), accept: () => pilot.accept(me, id, body), decline: () => pilot.decline(me, id, body),
          withdraw: () => pilot.withdraw(me, id, body), deliver: () => pilot.deliver(me, id, body), complete: () => pilot.complete(me, id, body),
          dispute: () => pilot.dispute(me, id, body)})[m[2]]();
        return send(res, 200, out);
      }
    }

    if (who.role === 'owner') {
      if (G && p === '/owner') return send(res, 200, {participant: pilot.publicParticipant(me), mandate: me.mandate, mandate_version: me.mandate_version,
        mandate_changed_by: me.mandate_changed_by || 'owner', mandate_changed_at: me.mandate_changed_at || null,
        agent_limits: me.agent_limits || {}, agent_limits_recorded_by: me.agent_limits_recorded_by || {}, effective_limits: pilot.effectiveLimits(me),
        owner_token_rotated_at: me.owner_token_rotated_at ?? null, owner_token_rotated_by: me.owner_token_rotated_by ?? null,
        agent: {enrolled: !!me.pubkey, pubkey: me.pubkey, last_seen: me.last_seen_agent, enrollment_pending: !!me.enrollment, enrollment_expires_at: me.enrollment?.expires_at ?? null,
          enrollment_issued_by: me.enrollment?.issued_by ?? null, key_registered_at: me.key_registered_at ?? null},
        past_keys: me.past_pubkeys || [],
        approvals: await Promise.all(Object.values(pilot.s.approvals).filter(a => a.participant === me.id).reverse().map(a => pilot.servedApprovalView(a, me))),
        deals: (await Promise.all(pilot.dealsFor(me).map(d => pilot.dealView(d, me)))).reverse(),
        inbox: pilot.inbox(me), position: await pilot.position(me, null, {own: true}), ...circulationKeys()});
      if (U && p === '/owner/mandate') return send(res, 200, pilot.setMandate(me, await readJson(req)));
      if (P && (m = /^\/owner\/approvals\/(va_[0-9a-f]{12})$/.exec(p))) return send(res, 200, await pilot.decideApproval(me, m[1], await readJson(req)));
      // Circulating credit (decision D-2 d; modes sandbox and on, else the same 404 as any unknown route): the payer's
      // owner resolves a payment attempt whose outcome the read-back could not decide. MIG-4: an attempt left unresolved
      // also in every other mode but off (mode bound; mode sandbox for a participant outside the sandbox), since it
      // blocks every payment of its deal until then.
      if (P && pilot.mode !== 'off' && (m = /^\/owner\/deals\/(vd_[0-9a-f]{16})\/attempts\/(vt_[0-9a-f]{16})\/resolve$/.exec(p))
        && (pilot.circulationFor(me) || pilot.unresolvedAttemptOf(me, m[1], m[2])))
        return send(res, 200, await pilot.resolveAttempt(me, m[1], m[2], await readJson(req)));
      if (P && p === '/owner/revoke-agent') return send(res, 200, await pilot.revokeAgent(me));
      // Issue a new owner token (shown once) and invalidate this one (OQ-24).
      if (P && p === '/owner/rotate-token') return send(res, 200, await pilot.rotateOwnerToken(me));
      if (P && p === '/owner/enrollment-code') {
        if (me.pubkey) throw new PilotError('already_enrolled', 'an agent key is registered; revoke it first to enroll a new one', 409);
        return send(res, 200, pilot.newEnrollmentCode(me));
      }
    }
    throw new PilotError('not_found', who.role === 'owner' && P ? 'owners cannot sign deal actions; the agent does that with its own key' : 'not found', 404);
  }
  // The loop card (GET /loop/<id>, lib/http.mjs): server-rendered HTML of an applied set-off, cached as the public reads
  // are and counted against the same per-address read budget. An unknown id is a 404 page (not cached).
  handle.loopPage = async (req, res, id, send, clientIp) => {
    if (limited(`ipr:${clientIp(req)}`, ipReadsPerMinute)) throw new PilotError('rate_limited', 'too many requests; slow down', 429);
    const o = LOOP_ID_RE.test(id) ? pilot.setoff(id) : null;
    if (!o || o.state !== 'applied') return send(res, 404, renderLoopNotFound(), HTML);
    const r = await cachedRead(`loop-page:${o.id}`, () => ({status: 200, body: renderLoopPage(loopOf(o, pilot.s.participants, publicOf))}));
    return send(res, r.status, r.body, HTML);
  };
  // The agent page (GET /agent/<handle>, lib/http.mjs; lib/pilot/agents.mjs): server-rendered HTML of a participant's
  // public record, position and loops, cached as the public reads are and counted against the same per-address read
  // budget. A handle no participant with an agent (active now, or with an earlier key) has is a 404 page (not cached).
  handle.agentPage = async (req, res, name, send, clientIp) => {
    if (limited(`ipr:${clientIp(req)}`, ipReadsPerMinute)) throw new PilotError('rate_limited', 'too many requests; slow down', 429);
    const h = String(name || '').toLowerCase();
    const x = AGENT_HANDLE_RE.test(h) ? Object.values(pilot.s.participants).find(q => q.handle === h && !q.unlisted && (q.status === 'active' || q.past_pubkeys?.length)) : null;
    if (!x) return send(res, 404, renderAgentNotFound(), HTML);
    const r = await cachedRead(`agent-page:${x.id}`, async () => {
      let pos = null;
      try { pos = await pilot.publicPosition(x); } catch { pos = null; }   // the page still shows, without the record
      const loops = loopsOf(pilot.s.setoffs, pilot.s.participants, publicOf);
      return {status: 200, body: renderAgentPage(agentView(pilot.directoryRecord(x), pos, loops, {now: Date.now(), dormant: !!pilot.dormant?.(x)}))};
    });
    return send(res, r.status, r.body, HTML);
  };
  // For the tests: how many public reads were computed (not served from the cache).
  handle.cacheStats = () => ({computed: cacheReads, entries: publicCache.size});
  return handle;
}
