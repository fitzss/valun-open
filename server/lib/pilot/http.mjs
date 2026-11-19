// Pilot HTTP routes (/pilot/v1/*). Per-participant bearer tokens; no global passphrase. See docs/PILOT-API.md.
import {PilotError, NETWORK, PROTOCOL, statements, circulationStatements, guaranteeStatements, sha256, SETTLED_HOW_TESTNET, settledHowTestnet} from './core.mjs';
import {GUARANTEE_INFO} from './guarantees.mjs';
import {ON_TESTNET, PUBLIC_ORIGIN} from './units.mjs';
import {ipKey} from '../ipkey.mjs';
import {toErgoJson} from '../ergo-json.mjs';
import {featuresFor, NOVATION_INFO} from './caps.mjs';
import {METRICS_CACHE_MS} from './clearing.mjs';
import {loopsOf, loopsBefore, loopOf, memberRecords, LOOP_ID_RE, renderLoopPage, renderLoopNotFound} from './loops.mjs';
import {AnchorWatch, BLOCK_WAIT, CHECK_INTERVAL_S, DAILY_TRACKER_SIGNATURES, boxWindows, confirmedUpdates, creatingTx, dailyCap, loopAnchor, nodeHeight, trackerBoxUpdates} from './anchors.mjs';
import {AGENT_HANDLE_RE, agentPageShown, agentView, pageHandles, renderAgentPage, renderAgentNotFound} from './agents.mjs';
import {assertCardPublic, budgetCard, cardPublic, checkPayer, dealUnderReview, findPayee, parseAmount, parseDeliverBy, parsePath, roomOf} from './card.mjs';
import {withUnitNeutralNames as unitNeutral} from './amount-names.mjs';
import {ENVIRONMENT, LOCAL, LOCAL_NOTE} from '../environment.mjs';
import {trackerPin, trackerProbe} from '../basis.mjs';
import {TRACKER_SHA256_TR20} from './pins.mjs';
import {slidingWindow} from '../rate-window.mjs';
import {A2A_PER_MINUTE, BODY_MAX_BYTES, IP_READS_PER_MINUTE, LIMIT_SETTINGS, WRITES_PER_MINUTE, limitSetting} from './limits.mjs';

// The source text of each statement template, as /info publishes it (OQ-18).
const sources = o => Object.fromEntries(Object.entries(o).map(([k, f]) => [k, f.toString().replace(/\s+/g, ' ')]));

// GET /info `description`. Modes off and bound: v15's text, word for word (nothing moves or clears a note there).
// Modes sandbox and on (OQ-49): set-offs do clear obligations and notes move between creditors, so the text ends with
// the wording of the deal's settlement label with circulating credit on (core.mjs CIRCULATION_SETTLEMENT, spec 16.1),
// and in mode sandbox it also says whom circulating credit is on for. The testnet's says who the agents are so far (the
// redesign's live check, 2026-11-17: it called them "independently controlled", which /start lists as a known issue of
// valun 0.7.1's MCP server), and calls a credit note a note, as the site does (fix inbox #173); the retired pilot's stays
// v15's.
const INFO_PREFIX = ON_TESTNET
  ? 'Valun testnet network: agents, each holding its own key, propose, negotiate and accept deals paid with notes: signed promises to pay that the testnet tracker records. So far almost every agent is the team\'s or the operator\'s. Amounts are nanoERG on Ergo TESTNET: test coins with no monetary value. When a payer accepts a delivery it issues a note: a payer-signed promise to pay, recorded by a Basis tracker whose tracker boxes commit its state on Ergo testnet.'
  : 'Valun pilot network: independently controlled agents propose, negotiate and accept service-for-credit deals. PC (pilot credits) are simulated units with no monetary value. When a payer accepts a delivery it issues a credit note: a payer-signed Basis note recorded by a real Basis tracker that has no blockchain connection.';
const INFO_SETTLEMENT = ON_TESTNET
  ? 'a promise to pay that stays outstanding. With circulating credit it can move to a new holder (a transfer, signed by its issuer and both holders) or be cleared in a loop of notes (set-off, signed by every party; no net position changes), also on an edge whose total the tracker box on Ergo testnet commits: never below a total the tracker signed for a redemption, and only while that tracker box is fresh. A change is committed once the next tracker box on Ergo testnet commits it, and stays committed only as long as the tracker key never commits an earlier total again. A holder can redeem a note on Ergo testnet against a tERG reserve locked under the key that signed it, if one was posted; tERG have no monetary value.'
  : 'not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, there is no reserve, and PC have no value.';
export const INFO_DESCRIPTIONS = Object.freeze({
  off: ON_TESTNET ? `${INFO_PREFIX} An issued note is a promise to pay that stays outstanding. A holder can redeem it on Ergo testnet against a tERG reserve locked under the key that signed it, if one was posted; tERG have no monetary value. Transfers and set-offs (netting) are not on for this network yet: they come once netting is anchored on chain.` : `${INFO_PREFIX} An issued note is an outstanding obligation; nothing in the pilot is settled (no redemption, reserve or clearing).`,
  on: `${INFO_PREFIX} An issued note is ${INFO_SETTLEMENT}`,
  sandbox: `${INFO_PREFIX} An issued note is ${INFO_SETTLEMENT} On this server circulating credit is on for sandbox participants only: the sandbox agents and those who joined with join-sandbox.`,
});
// Self-serve sandbox joins per client address per hour (guests at one venue share an address; an IPv6 client counts by
// its /48, lib/ipkey.mjs), and per hour from all addresses together (one host can rotate across many /48s): counted in
// the state by Pilot.joinSandbox (fix inbox #21), so a restart does not reset them. The server-wide daily cap is
// SANDBOX_JOINS_PER_DAY in core.mjs.
export {SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, SANDBOX_JOINS_PER_HOUR_TOTAL} from './core.mjs';
// Settlement on Ergo testnet: the smallest redemption (the miner fee the tracker pays for it) and the redemption builds
// one agent may ask for in 24 hours (in memory; a restart forgets them).
export const REDEMPTION_MIN_NANOERG = 1_000_000, REDEMPTION_BUILDS_PER_DAY = 6, REDEMPTION_ATTEMPTS_PER_DAY = 30;
// One redemption against an issuer's reserve at a time (every redemption spends that reserve's one box): held from the
// build until the holder submits (RESERVE_BUILD_HOLD_MS), then until the spend is about confirmed and the tracker follows
// the reserve's new box (RESERVE_SPEND_HOLD_MS). Another build meanwhile: 409 reserve_busy {retry_after_ms, spending_tx}.
export const RESERVE_BUILD_HOLD_MS = 120e3, RESERVE_SPEND_HOLD_MS = 180e3;
// The reads per client address (venue Wi-Fi), 1800 a minute; each token keeps its own reads-per-minute limit
// (lib/pilot/limits.mjs, with the other budgets).
export {IP_READS_PER_MINUTE};
// Burst protection: the public reads (GET /info, /participants, /participants/<id>, /ledger, /ledger/committed, /loops,
// /loops/<id> and the loop card) are computed at most once per PUBLIC_CACHE_MS while the pilot state is unchanged
// (Pilot.generation, bumped by every save), so many viewers do not multiply tracker reads. Nothing authenticated or
// per-caller is cached. The hosted server turns it on (server.mjs: PILOT_PUBLIC_CACHE_MS, default PUBLIC_CACHE_MS); off
// unless cfg.publicCacheMs is set, so a read right after a change made around the pilot (a test writing to the tracker)
// is never stale.
export const PUBLIC_CACHE_MS = 3000;
// GET /ledger/committed (fix inbox #62): a committed snapshot is read once per confirmed tracker box and kept while the
// tracker's state names that box and digest, for at most this long (then read again, so the server's check follows
// any repair the tracker makes to its records of the same box).
export const COMMITTED_KEEP_MS = 60_000;
// The commit this server runs (GET /info `build`), as its deploy sets VALUN_BUILD_SHA (scripts/ops, the CI deploys):
// staging and the testnet say which code they run, so a promotion can check it moves what staging tested. Absent
// unless set to a full commit id.
export const BUILD_SHA = /^[0-9a-f]{40}$/.test(process.env.VALUN_BUILD_SHA || '') ? process.env.VALUN_BUILD_SHA : null;
// GET /health (fix inbox #64): the pilot tracker is read at most once per HEALTH_PROBE_MS, however often the route is
// asked, and an answer that takes longer than HEALTH_TIMEOUT_MS counts as none (so a caller that waits 5 s gets one).
export const HEALTH_PROBE_MS = 2000, HEALTH_TIMEOUT_MS = 3000;
const PUBLIC_CACHE_MAX = 500;
const HTML = 'text/html; charset=utf-8';

const infoDescription = mode => INFO_DESCRIPTIONS[mode === 'sandbox' || mode === 'on' ? mode : 'off'];
// GET /info `circulation` on a local server: the mode in effect (off, bound, sandbox or on), the one PILOT_CIRCULATION
// asks for, and why they differ when they do (Pilot.circulationStatus: an unpinned tracker binary, say).
const circulationOf = pilot => {
  const mode = pilot.mode, st = typeof pilot.circulationStatus === 'function' ? pilot.circulationStatus() : null;
  return {mode, requested: st?.requested ?? mode, ...(st && st.requested !== mode && st.reason ? {reason: st.reason} : {})};
};
// The chain as the public answers show it (GET /info `chain`, GET /chain; fix inbox #88): never the server's own files
// (spend_ledger, the wallet adapter's ledger: a path on its volume), and the node it reads named for what it is. Clients
// read `node` as a URL (valun-open's client takes it as its default node; valun audit and anchor-audit warn when it is
// their chain source), so it stays one, with `node_note` beside it.
export const NODE_NOTE = 'The Ergo testnet node this server reads the chain from, named so you know where its chain reads come from, not as a node to trust: to check what this server says, read the chain from your own node or an explorer.';
export const publicChain = chain => Object.fromEntries(Object.entries(chain).filter(([k]) => k !== 'spend_ledger')
  .flatMap(([k, v]) => (k === 'node' && v ? [[k, v], ['node_note', NODE_NOTE]] : [[k, v]])));
// GET /info `writes_refused` (MIG-1, release v16.1): {code: 'tracker_downgraded', since, reason, fix} while the server
// refuses every pilot write because its tracker reports no valid tracker v3.2 capabilities and the state holds
// circulating-credit history; nothing (the key absent) otherwise.
export const WRITES_REFUSED_FIX = 'put the tracker v3.2 binary back (docs/DEPLOY-0.4-RUNBOOK.md step 4); or, before going back to release v15, run the downgrade check in maintenance mode (runbook R3). The server reads the tracker\'s capabilities again every 60 s and resumes writes once they are tracker v3.2\'s.';
const writesRefused = pilot => {
  const r = pilot.writeRefusal?.() ?? null;
  return r ? {writes_refused: {code: r.code, since: r.since, reason: r.reason, fix: WRITES_REFUSED_FIX}} : {};
};

// The directory's order (GET /participants, with ?all=1 too): first sandbox-exact, the first job to try (no AI, so no
// budget to run out: fix inbox #173), then the other agents the server runs (the sandbox agents, operator_run), then the
// house agents (house_agent), then everyone else, each group in the order the participants joined. The always-on agents
// a newcomer can hire first came first only by insertion order (the newcomer run of Nov 18, finding 6), and on ?all=1
// five unlisted test agents sat ahead of the house agents. A stable sort, so the rest stay in join order as before.
// valun 0.7.2's valun_directory sorts again (operator_run, house_agent, then the newest agent_last_seen, then the
// handle): the listing gives every agent the server runs one agent_last_seen (directoryRecord's `now`), so there too
// sandbox-exact comes before sandbox-mallory.
export function directoryOrder(pilot, list) {
  const run = x => pilot.serverRun?.(x) || pilot.sandboxIds?.has(x.id);
  const rank = x => (run(x) ? (x.handle === 'sandbox-exact' ? 0 : 1) : pilot.houseIds?.has(x.id) ? 2 : 3);
  return list.map((x, i) => [rank(x), i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(e => e[2]);
}

// GET /reserves (fix inbox #83). The tracker's own total_debt is a placeholder it never maintains (0 for every reserve;
// its ratio is then infinite, which it writes as null), so the rows read as owing nothing. The figures are read from the
// tracker's notes instead (Pilot.ledger, the rows of GET /ledger), for what THIS reserve backs: its contract pays only
// notes signed with its own key (it checks the note's issuer key against the owner key in R4). total_debt_nanoerg is the
// outstanding amount of those notes, total - redeemed, at least 0 a note (the tracker's outstanding_debt;
// scripts/ops/anchor-audit.mjs's "owed" per issuer key), and the ratio is collateral / that, rounded down to 4 decimals
// as the anchor audit's cover. What the owner owes under its other keys (keys of the same participant, before or after
// this one) is debt_under_other_keys_nanoerg, present when not 0 and not in the ratio: the owner's public_position.owes
// counts every key, so it is the sum of the two. A figure that cannot be computed is null with why_null, never 0. A
// token reserve (reserve_token_id) holds its collateral in that token's units and backs notes in that token, which this
// network's notes are not: no figure in nanoERG. `ledger` is null when the tracker's notes could not be read;
// participantOf(pubkey) is the participant holding a key (Pilot.byPubkey).
export const RESERVES_MEANING = 'total_debt_nanoerg is what this reserve backs: the outstanding amount of the notes signed with its own key (total minus redeemed, at least 0 a note; the tracker\'s own counters as GET /ledger shows them, notes not yet anchored on chain included), the only notes its contract pays. collateralization_ratio is collateral_nanoerg / total_debt_nanoerg, rounded down to 4 decimals: the reserve box\'s value over that amount, not what holders could take (the tracker leaves 1000000 nanoERG in a reserve; a pending refund lets the owner take it all). debt_under_other_keys_nanoerg, when present, is what the owner owes under its other keys, which this reserve cannot pay: it is not counted in the ratio. The owner\'s public_position.owes counts every key it has had, so it is total_debt_nanoerg plus debt_under_other_keys_nanoerg (the same as total_debt_nanoerg for an owner with one key). A figure that cannot be computed, and the ratio when nothing is owed, is null, never 0: why_null says why. No amount redeemed from the reserve is given: its box holds only the digest of its redemption tree; what was redeemed shows as the value its box lost along the lineage of its NFT on chain, and per note as redeemed on GET /ledger.';
const wholeOf = v => ((typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
// The outstanding amount of ledger rows, at least 0 a note; null when a row has no whole total or redeemed amount, or the
// sum is above what a JavaScript number counts exactly.
const outstandingOf = rows => {
  if (rows.some(l => wholeOf(l.total) === null || wholeOf(l.redeemed) === null)) return null;
  const s = rows.reduce((a, l) => a + Math.max(0, l.total - l.redeemed), 0);
  return Number.isSafeInteger(s) ? s : null;
};
export function reserveRows(list, ledger, participantOf) {
  return list.map(r => {
    const owner = typeof r?.owner_pubkey === 'string' && r.owner_pubkey ? r.owner_pubkey : null, who = owner ? participantOf(owner) : null;
    const name = who?.handle ?? 'the owner', token = typeof r?.reserve_token_id === 'string' && r.reserve_token_id !== '' ? r.reserve_token_id : null;
    const amount = wholeOf(r?.collateral_amount), collateral = token ? null : amount;
    // The owner's other keys: the participant's current and earlier keys but this reserve's own.
    const otherKeys = who ? [who.pubkey, ...(who.past_pubkeys || []).map(k => k?.pubkey)].filter(k => typeof k === 'string' && k && k !== owner) : [];
    let debt = null, other = 0, debtWhy = null, otherWhy = null;
    if (token) debtWhy = 'a token reserve (reserve_token_id): its collateral is in units of that token, not nanoERG, and it backs notes in that token, which this network\'s notes are not, so no figure in nanoERG is computed for it';
    else if (!owner) debtWhy = 'the tracker names no owner key for this reserve, so whose notes it backs is unknown';
    else if (!ledger) { debtWhy = 'the tracker\'s notes could not be read just now, so what this reserve backs is unknown (not 0); try again'; if (otherKeys.length) other = null; }
    else {
      debt = outstandingOf(ledger.filter(l => l.issuer_pubkey === owner));
      if (debt === null) debtWhy = 'a note signed with this reserve\'s key has no whole total or redeemed amount on the tracker (or they add up past 2^53 - 1), so what the reserve backs is unknown';
      if (who) {
        other = outstandingOf(ledger.filter(l => l.issuer === who.id && l.issuer_pubkey !== owner));
        if (other === null) otherWhy = `a note ${name} issued under another key has no whole total or redeemed amount on the tracker (or they add up past 2^53 - 1), so what it owes under its other keys is unknown`;
      }
    }
    const ratio = collateral !== null && debt > 0 ? Number(BigInt(collateral) * 10000n / BigInt(debt)) / 10000 : null;
    const why = token ? debtWhy : [collateral === null ? 'the tracker gives no whole collateral amount for this reserve' : null, debtWhy,
      debt === 0 ? `nothing is owed on the notes signed with this reserve's key (${name} has none outstanding on this tracker), so there is no collateralization ratio` : null,
      otherWhy].filter(Boolean).join('; ');
    return {box_id: r?.box_id ?? null, owner_pubkey: owner, handle: who?.handle ?? null, collateral_nanoerg: collateral, ...(token && amount !== null ? {collateral_token_units: amount} : {}),
      total_debt_nanoerg: debt, collateralization_ratio: ratio, ...(other !== 0 ? {debt_under_other_keys_nanoerg: other} : {}), ...(why ? {why_null: why} : {}),
      last_updated_height: r?.last_updated_height ?? null, refund_initiation_height: r?.refund_initiation_height ?? null, reserve_token_id: r?.reserve_token_id ?? null};
  });
}

// A refusal by one of the per-minute budgets: 429 rate_limited with retry_after_ms, how long until the budget takes a
// request again (lib/rate-window.mjs; the local-readiness audit of Nov 18, MR-4: it said only "slow down", while the
// join caps' refusals said how long). The same everywhere since then. A local server's message also says which budget
// refused ({kind: 'writes' | 'reads', per: 'address' | 'token', max}) and how whoever runs it changes that budget
// (lib/pilot/limits.mjs): every client on the machine shares one address there. Elsewhere the message is as it was.
const RATE_LIMITED = 'too many requests; slow down';
const localBudgetMessage = ({kind, per, max}) => `too many ${kind} ${per === 'address' ? 'from this address' : 'with this token'}: at most ${max} a minute `
  + (per === 'address' ? 'from one address, which every agent and client behind it shares (through a port Docker publishes, every client on this machine comes from one address)' : 'per token')
  + `. Wait retry_after_ms before sending again (refused requests count too), or start this server with a higher ${limitSetting(`${kind}_per_minute`, `per_${per}`)} (docs/LOCAL.md, "Many agents")`;
export const rateLimited = (ms, budget = null) => new PilotError('rate_limited', LOCAL && budget ? localBudgetMessage(budget) : RATE_LIMITED, 429, {retry_after_ms: ms});
// A per-day count of an agent's requests (the redemption builds and attempts): 0 while `times` (in order, the last 24
// hours) holds fewer than `max`, else how long until enough of them have left the 24 hours (at least 1000 ms).
const dayWait = (times, max, now) => (times.length < max ? 0 : Math.max(1000, times[times.length - max] + 864e5 - now));

// A local server takes a write (any request but GET and HEAD) only from its own clients (the local-readiness audit of Nov
// 18, IMG-13). Publishing on 127.0.0.1 keeps out other machines, not the web pages a browser on this one opens: /pilot/v1
// read any Content-Type and checked no Host, so a page of any site could send a simple text/plain POST to
// http://127.0.0.1:8080/pilot/v1/join-sandbox (no preflight) and make participants, using up the machine's joins, and a
// page that a DNS name rebound to this server could act on its answers too. So a local server refuses, before anything
// else (no budget is spent, no body is read), a write:
//   - whose Host is not its own origin's (PUBLIC_ORIGIN) or a loopback name, 127.0.0.1, localhost or [::1], with any
//     port (a rebound name): 403 host_not_allowed;
//   - with an Origin that is not one of those (a page of another site; 'null' too): 403 cross_origin. Its own pages send
//     theirs, and valun, the JS client and scripts send none;
//   - with a body that is not sent as application/json, which a page of another site cannot send without a preflight this
//     server never grants: 415 json_required. Every client sends its bodies so (valun 0.7.1's client.py and the Hermes
//     plugin always, the JS client and the owner console with every body), and a write with no body needs none.
// Elsewhere writes are taken as before.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostOf = s => { try { const u = new URL(s); return u.username || u.password ? null : u; } catch { return null; } };
const OWN = hostOf(PUBLIC_ORIGIN);
const ownHost = h => { const u = typeof h === 'string' && h.length <= 300 ? hostOf(`http://${h}`) : null; return !!u && u.pathname === '/' && !u.search && !u.hash && (LOOPBACK_HOSTS.has(u.hostname) || u.host === OWN?.host); };
const ownOrigin = o => { const u = typeof o === 'string' && o.length <= 300 ? hostOf(o) : null; return !!u && /^https?:$/.test(u.protocol) && (LOOPBACK_HOSTS.has(u.hostname) || u.origin === OWN?.origin); };
const shown = v => JSON.stringify(String(v).slice(0, 100));
export function localWriteRefusal(req) {
  const host = req.headers.host, origin = req.headers.origin;
  if (!ownHost(host)) return new PilotError('host_not_allowed', `this local server takes writes only for its own origin, ${PUBLIC_ORIGIN}, or a loopback name (127.0.0.1, localhost `
    + `or [::1], any port), and this one was sent for ${host === undefined ? 'no host' : shown(host)}. From this machine, use one of those; from another container, run it in `
    + 'this server\'s network namespace (docker run --network container:CONTAINER ...), where 127.0.0.1 is this server. Nothing was done.', 403);
  if (origin !== undefined && !ownOrigin(origin)) return new PilotError('cross_origin', `a page of another site (Origin ${shown(origin)}) cannot write to this local server: `
    + `only its own pages, at ${PUBLIC_ORIGIN} or a loopback name, and clients that send no Origin (valun, scripts) can. Nothing was done.`, 403);
  const body = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (body && type !== 'application/json') return new PilotError('json_required', 'a write to this local server sends its body as JSON, with Content-Type: '
    + `application/json; this one was sent as ${type ? shown(type) : 'no type'}. Nothing was done.`, 415);
  return null;
}

// A local server's refusals of an admin call (IMG-6): how admin runs there, with scripts/pilot-admin.mjs inside the
// container, which reads the admin token from the data folder and calls this server on its own loopback.
const ADMIN_EXEC = 'docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 25 --code-only (or invites, clearing status --json, clearing run; '
  + 'CONTAINER is the name docker ps shows, or the one docker run --name gave it)';
export const LOCAL_ADMIN_LOOPBACK = 'Admin routes answer only on this server\'s own loopback, inside its container, with the admin token in its data '
  + `folder (/data/pilot/admin-token in the local image), never through the published port. Run them with docker exec: ${ADMIN_EXEC}. Nothing was done.`;
export const LOCAL_ADMIN_TOKEN = 'Admin routes need the admin token from this server\'s data folder (/data/pilot/admin-token in the local image) in the '
  + `X-Valun-Admin header. scripts/pilot-admin.mjs reads it and sends it: ${ADMIN_EXEC}. Nothing was done.`;

// GET /info `limits` on a local server: the limits it runs with, which its settings may have changed (lib/pilot/limits.mjs),
// and what they mean there. The hosted servers run the defaults, in docs/PILOT-API.md, and their /info is as it was.
export const LOCAL_LIMITS_NOTE = 'The limits this server runs with. sandbox_joins: self-serve joins (join-sandbox) per hour from one address, '
  + 'per hour from all addresses and in any 24 hours (an invited join counts in none). writes_per_minute and reads_per_minute: requests per '
  + 'minute from one client address, whatever token they carry, and per token. Every client that reaches this server through a port Docker '
  + 'publishes on this machine comes from one address, so all of its agents share the per-address budgets. Over a limit: 429 rate_limited '
  + '(sandbox_full for the 24 hours) with retry_after_ms, how long until it takes a request again; refused requests count too. Whoever runs '
  + `this server sets them with ${LIMIT_SETTINGS.map(s => s[0]).join(', ')} (docs/LOCAL.md, "Many agents"). A self-serve agent's own limits `
  + 'per deal and owed are self_serve.limits.';

export function createPilotRoutes({pilot, cfg, adminTokenHash = null}) {
  const perMinute = cfg.pilotRateLimitPerMinute ?? WRITES_PER_MINUTE, readsPerMinute = cfg.pilotReadLimitPerMinute ?? perMinute * 4;
  const redemptionBuilds = new Map();             // agent id -> times of its redemption builds in the last 24 hours
  const redemptionAttempts = new Map();           // agent id -> times of its build requests (refused ones too)
  // The tracker's anchoring (lib/pilot/anchors.mjs): since when its state has gone unanchored with no update in flight,
  // observed once a minute on the testnet (and on every GET /chain), so GET /chain can tell a normal wait from a fault.
  const anchorWatch = new AnchorWatch();
  // Whether the pilot tracker answers GET / now, for GET /health (trackerProbe, lib/basis.mjs).
  const trackerAnswers = trackerProbe(pilot.basis, {cacheMs: HEALTH_PROBE_MS, timeoutMs: HEALTH_TIMEOUT_MS});
  if (ON_TESTNET && pilot.chain?.on_chain && typeof pilot.basis?.trackerState === 'function') {
    const poll = setInterval(() => { pilot.basis.trackerState().then(st => anchorWatch.observe(st), () => {}); }, 60_000);
    poll.unref?.();
  }
  // What the loop views need to say where a netting was committed: the tracker's state, the tracker-box updates the
  // wallet adapter signed, and which of them are confirmed (the node names the transaction of the confirmed box).
  const anchoring = async () => {
    const st = await pilot.basis.trackerState().catch(() => null);
    const rows = trackerBoxUpdates(pilot.chain?.spend_ledger);
    const tx = st && rows.length ? await creatingTx(pilot.chain?.node, st.confirmed_box_id) : null;
    return {st, confirmed: confirmedUpdates(rows, st, tx)};
  };
  const explorerTx = id => `${pilot.chain.explorer}/en/transactions/${id}`;
  // Which update committed a loop is the server's reading of the times (loopAnchor: the first one signed after the
  // set-off), and valun audit checks only the current box: the loop card (lib/pilot/loops.mjs chainSection) says both,
  // and so does this text.
  const loopOnChain = (loop, a) => {
    const u = loopAnchor(loop.applied_at, a.confirmed, a.st);
    return u ? {anchored: true, tx_id: u.tx_id, explorer_url: explorerTx(u.tx_id), signed_at: new Date(u.t).toISOString(),
      what_this_means: 'Committed on Ergo testnet by the first tracker-box update signed after the set-off (matched by time; valun audit checks only the current box). It stays committed only as long as the tracker key never commits an earlier total again: see skill.md, Trust model.'}
      : {anchored: false, what_this_means: `Not committed on chain yet: the next tracker box commits it, ${BLOCK_WAIT}, and once the day's ${DAILY_TRACKER_SIGNATURES} boxes are used up, not before 00:00 UTC (the tracker checks every ${CHECK_INTERVAL_S} seconds; GET /pilot/v1/chain shows its anchoring).`};
  };
  const onChain = () => ON_TESTNET && !!pilot.chain?.on_chain;
  // How many of a participant's nettings are committed yet, each read as its loop card reads it (loopAnchor, as
  // loopOnChain does, on one anchoring read): {loops, behind}, loops the applied set-offs it was in, behind how many of
  // them no confirmed tracker box commits yet, null when that is not known (off chain, no netting, the tracker's state
  // unread). The loops a box has not committed are the newest: a box that commits a loop commits every earlier one (it
  // was signed after both; boxes are minutes apart, LOOP_GUARD_MS 15 s), so the count goes from the newest down to the
  // first committed one. The agent page and the position's settled_how say it so (the readiness assessment of Nov 18:
  // they said "committed" while the loop card said "Not committed on Ergo testnet yet"; the review of gap/first-use: a
  // tour's two loops both wait for the next box). It never fails a read.
  const nettingOf = async p => {
    const unknown = {loops: 0, behind: null};
    if (!onChain() || !p || typeof pilot.basis?.trackerState !== 'function') return unknown;
    try {
      const at = o => o.applied_at ?? o.updated_at ?? null;
      const mine = Object.values(pilot.s.setoffs || {}).filter(o => o?.state === 'applied' && LOOP_ID_RE.test(String(o.id))
        && ((o.members || []).includes(p.id) || (o.edges || []).some(e => e?.issuer?.id === p.id || e?.recipient?.id === p.id))
        && Number.isFinite(Date.parse(at(o)))).sort((x, y) => Date.parse(at(y)) - Date.parse(at(x)));
      if (!mine.length) return unknown;
      const a = await anchoring();
      if (!a.st) return {...unknown, loops: mine.length};
      let behind = 0;
      while (behind < mine.length && !loopAnchor(at(mine[behind]), a.confirmed, a.st)) behind++;
      return {loops: mine.length, behind};
    } catch { return unknown; }
  };
  // A position as the routes serve it: its settled_how says "committed" only of the nettings a box has committed
  // (nettingOf, settledHowTestnet).
  const settledNow = async (p, pos) => {
    if (pos?.settled_how !== SETTLED_HOW_TESTNET.committed) return pos;
    const n = await nettingOf(p);
    return n.behind > 0 ? {...pos, settled_how: settledHowTestnet(n)} : pos;
  };
  // GET /ledger/committed: the committed snapshot of the box the tracker's state names now (Pilot.committedSnapshot).
  // Every request reads GET /tracker/state; the snapshot kept for that box and digest is served while younger than
  // COMMITTED_KEEP_MS, else it is read again (requests that see the same box meanwhile share one read). A failed read is
  // not kept. Reads only: never the lock (serial).
  // Whether GET /ledger/committed is served (fix inbox #65): only on a tracker build with TR-20, unless cfg says.
  const committedPublic = () => typeof cfg.committedRoute === 'boolean' ? cfg.committedRoute : TRACKER_SHA256_TR20.includes(pilot.trackerSha256);
  let committedKept = null, committedReading = null;
  const committedNow = async () => {
    const st = await pilot.basis.trackerState(), t = Date.now();
    const box = st?.confirmed_box_id ?? null, digest = st?.confirmed_digest ?? null;
    const same = e => !!e && box !== null && e.box_id === box && e.digest === digest;
    if (same(committedKept) && t >= committedKept.at && t - committedKept.at < COMMITTED_KEEP_MS) return committedKept.snapshot;
    if (!same(committedReading)) {
      const entry = {box_id: box, digest, value: pilot.committedSnapshot()};
      committedReading = entry;
      entry.value.then(s => { committedKept = {box_id: s.box_id, digest: s.digest, at: Date.now(), snapshot: s}; }, () => {})
        .finally(() => { if (committedReading === entry) committedReading = null; });
    }
    return committedReading.value;
  };
  // Built redemptions by transaction id, for their submit (30 minutes, the tracker's own expiry): what the tracker's
  // POST /redemption/submit still takes besides the transactions (issuer, recipient, amounts; the tracker reads them
  // from its own build entry and ignores these, but its request shape requires them).
  const builtRedemptions = new Map();
  // issuer pubkey -> {until, tx_id, building}: the redemption in flight against that issuer's reserve (in memory).
  const reserveHolds = new Map();
  const reserveBusy = (X, hold, now) => new PilotError('reserve_busy', `a redemption against ${X.handle}'s reserve is ${hold.tx_id ? `being confirmed (tx ${hold.tx_id})` : 'being built or signed'}; each redemption spends the reserve's one box, so the next waits until the tracker follows its new box. Try again in ${Math.ceil(Math.max(1000, hold.until - now) / 1000)} s.`, 409,
    {retry_after_ms: Math.max(1000, hold.until - now), ...(hold.tx_id ? {spending_tx: hold.tx_id} : {})});
  // Several agents and viewers may share one address (a venue Wi-Fi): public reads are served from the burst cache, so the
  // per-address read budget is larger than one token's (each token keeps readsPerMinute).
  const ipReadsPerMinute = cfg.pilotIpReadLimitPerMinute
    ?? (cfg.pilotReadLimitPerMinute != null || cfg.pilotRateLimitPerMinute != null ? readsPerMinute : Math.max(readsPerMinute, IP_READS_PER_MINUTE));
  // The writes per client address: as many as one token's unless cfg says (a local server's settings; tests).
  const ipWritesPerMinute = cfg.pilotIpWriteLimitPerMinute ?? perMinute;
  // Every budget's requests in the last minute, by key: ip:<address> (writes), ipr:<address> (reads), tok:<id>:<role>:w|r.
  // A request over its budget: limited(key, max) gives how long until the key takes one again (0 within it).
  const budgets = slidingWindow();
  const limited = (key, max = perMinute) => budgets(key, max);
  // GET /info `limits` on a local server: these budgets and the Pilot's join caps as they are in force, shaped as
  // lib/pilot/limits.mjs DEFAULT_LIMITS, with the A2A front door's and the body cap, which no setting changes.
  const localLimits = () => ({sandbox_joins: {...pilot.joinLimits}, writes_per_minute: {per_address: ipWritesPerMinute, per_token: perMinute},
    reads_per_minute: {per_address: ipReadsPerMinute, per_token: readsPerMinute}, a2a_requests_per_minute: {per_address: A2A_PER_MINUTE},
    request_body_max_bytes: BODY_MAX_BYTES, note: LOCAL_LIMITS_NOTE});
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
  const bearer = req => (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1] || null;
  // A HEAD sent with a token where the token would be checked (fix inbox #142): 405, never authenticated. `allow`: the
  // methods that take the token there. A HEAD gets no body, so the status and Allow say it; the body says it too.
  const HEAD_REFUSED = 'HEAD is answered only on the public reads, as GET: a request with a token is authenticated, which a HEAD never is. Send it as GET, or with the method its route takes.';
  const headRefused = (res, send, allow) => send(res, 405, {error: 'method_not_allowed', message: HEAD_REFUSED}, undefined, {Allow: allow});

  async function readJson(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > BODY_MAX_BYTES) throw new PilotError('too_large', 'request body too large', 413); chunks.push(c); }
    if (!chunks.length) return {};
    let v;
    try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PilotError('bad_json', 'body must be JSON'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new PilotError('bad_json', 'body must be a JSON object');
    return v;
  }

  async function handle(req, res, url, send, clientIp) {
    const p = url.pathname.slice('/pilot/v1'.length) || '/';
    const G = req.method === 'GET', P = req.method === 'POST', U = req.method === 'PUT';
    // HEAD (fix inbox #142): the public reads below answer it as GET (R: a read), with the GET's status and headers and
    // no body (Node sends none to a HEAD; lib/http.mjs). Nowhere else: a HEAD is never authenticated, since
    // authenticate writes (it records the agent as seen and renews a self-serve agent's sandbox time). A HEAD with a
    // token where one would be authenticated is refused (headRefused); one without a token gets what a GET without one
    // gets (authenticate(null) changes nothing: 401).
    const H = req.method === 'HEAD', R = G || H;
    let m, wait;
    // A local server's writes come from its own clients (localWriteRefusal), checked before any budget is spent.
    const refused = LOCAL && !R ? localWriteRefusal(req) : null;
    if (refused) throw refused;
    const ip = clientIp(req);
    if (!R && (wait = limited(`ip:${ip}`, ipWritesPerMinute))) throw rateLimited(wait, {kind: 'writes', per: 'address', max: ipWritesPerMinute});
    // Every read counts against a per-IP read budget, whatever Authorization header it carries: public routes are
    // served before authentication, so a made-up bearer token must not skip it (F2, OQ-30). A HEAD counts as the read
    // it is answered as.
    if (R && (wait = limited(`ipr:${ip}`, ipReadsPerMinute))) throw rateLimited(wait, {kind: 'reads', per: 'address', max: ipReadsPerMinute});

    // ---------- admin: loopback only (e.g. `fly ssh console`), never via the proxy, with the volume-held admin token ----------
    if (p.startsWith('/admin/')) {
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const proxied = req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.headers['fly-forwarded-port'];
      const tok = req.headers['x-valun-admin'] ? sha256(String(req.headers['x-valun-admin'])) : null;
      // A local server (the local-readiness audit of Nov 18, IMG-6): from anywhere but its own loopback (a harness on the
      // host reaches it through the published port, from the bridge's address), or through a proxy, and without the
      // admin token, a 403 that says how admin runs there: docker exec, inside the container. It said 404 not_found, as
      // an unknown route does. Elsewhere such a call is 404 as before: a hosted server names no admin route.
      if (LOCAL && adminTokenHash && (!loopback || proxied)) throw new PilotError('admin_loopback_only', LOCAL_ADMIN_LOOPBACK, 403);
      if (LOCAL && adminTokenHash && tok !== adminTokenHash) throw new PilotError('admin_token_required', LOCAL_ADMIN_TOKEN, 403);
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

    // ---------- public (GET, and HEAD as GET: R) ----------
    // With circulating credit effectively on (mode bound and above; lib/pilot/caps.mjs) /info also lists the features,
    // the novation constants and the circulation statements. In mode off it is exactly as before.
    if (R && p === '/info') return sendCached(res, send, 'info', () => {
      const mode = pilot.mode;
      return {
        network: NETWORK,
        // Staging says so (fix inbox #41; lib/environment.mjs), next to the network it copies; absent anywhere else. So
        // does a local server (fix inbox #143), with what that means: no chain.
        ...(ENVIRONMENT ? {environment: ENVIRONMENT} : {}),
        ...(LOCAL ? {environment_note: LOCAL_NOTE} : {}),
        protocol: PROTOCOL, unit: pilot.unit, denomination: pilot.basis.denomination, tracker_nft_id: pilot.basis.nft,
        tracker_on_chain: !!pilot.chain?.on_chain, experimental: true,
        ...(pilot.chain ? {chain: publicChain(pilot.chain)} : {}),
        ...(BUILD_SHA ? {build: BUILD_SHA} : {}),
        description: infoDescription(mode),
        statements: sources(statements),
        participants: Object.values(pilot.s.participants).filter(x => x.status === 'active').length,
        ...(mode !== 'off' ? {features: featuresFor(mode), novation: NOVATION_INFO, circulation_statements: sources(circulationStatements)} : {}),
        // Guarantees (fix inbox #18; modes sandbox and on): the protocol, its bounds and the statements each party signs.
        ...(mode === 'sandbox' || mode === 'on' ? {guarantees: GUARANTEE_INFO, guarantee_statements: sources(guaranteeStatements)} : {}),
        // MIG-1 (release v16.1): only while pilot writes are refused (Pilot.writeRefusal), so that the operator's live
        // check sees it; absent otherwise (a v15 state in mode off answers exactly as before). Cached like the rest of
        // /info, so it shows at most PUBLIC_CACHE_MS after the refusal starts or ends.
        ...writesRefused(pilot),
        ...(pilot.selfServe?.() ? {self_serve: pilot.selfServe()} : {}),
        // A local server (fix inbox #145; the local-readiness audit of Nov 18, IMG-2, MR-12): the limits it runs with
        // (localLimits) and the circulation mode in effect, which no other field names (modes sandbox and on differ
        // only in the description), with the one asked for when the server runs another, and why. Elsewhere absent.
        ...(LOCAL ? {limits: localLimits(), circulation: circulationOf(pilot)} : {}),
      };
    });
    // The network's own health (fix inbox #64), for the live check (scripts/live-check.mjs, at every deploy and
    // promotion) and operators; the platform's check is GET /info, which reads no tracker (fly.testnet.toml). 200 {ok:
    // true} while the pilot tracker answers, 503 {ok: false} while it does not. It never asks the legacy desk (/api,
    // /mcp), which is optional beside the network. tracker.pin names the network's tracker as /api/status names the
    // desk's (trackerPin: the build and commit its capabilities report, ' (binary not pinned)' unless the running
    // binary's sha256 is pinned; null without capabilities). Not in the public read cache: the tracker read has its own
    // (HEALTH_PROBE_MS). Writes refused by MIG-1 do not make it 503: such a server still serves, and GET /info says why
    // (writes_refused).
    // On the network with no chain (a local server's), a pure-credit tracker is named as running pure credit, not by
    // its build's anchored netting (fix inbox #146; lib/basis.mjs trackerPin).
    if (R && p === '/health') {
      const reachable = await trackerAnswers();
      const pin = trackerPin(pilot.trackerCaps, null, {pinned: (pilot.trackerPins ?? []).includes(pilot.trackerSha256), pureCreditNamed: !ON_TESTNET});
      return send(res, reachable ? 200 : 503, {ok: reachable, network: NETWORK, tracker: {reachable, pin}});
    }
    // A local server (fix inbox #143) has no chain: its chain reads say so, instead of falling through to a 401.
    if (LOCAL && R && (p === '/chain' || p === '/reserves' || p === '/ledger/committed'))
      throw new PilotError('no_chain', `${LOCAL_NOTE} There is no chain view, no reserve and no committed ledger here.`, 404);
    // ---------- Ergo testnet (valun-testnet-1, once on chain): the chain view and the reserves, public ----------
    // GET /chain: the tracker's anchoring (its local digest, the digest its tracker box commits on testnet, that box and
    // height, an update in flight) and where to look on the explorer. GET /reserves: every Basis reserve the tracker
    // scans for this tracker's NFT, each with its owner's handle when the owner is a participant.
    if (ON_TESTNET && R && (p === '/chain' || p === '/reserves')) {
      if (!pilot.chain?.on_chain) throw new PilotError('testnet_bootstrapping', 'the Valun testnet tracker is not on chain yet', 503);
      if (p === '/chain') return sendCached(res, send, 'chain', async () => {
        const st = await pilot.basis.trackerState().catch(() => null);
        const ex = pilot.chain.explorer, chain = publicChain(pilot.chain);
        // fix inbox #14: the anchoring's state (anchored, waiting for the next update, an update in flight, overdue) and
        // what it means for redeeming, the updater's interval, and the last tracker-box update the server knows of.
        const last = st ? confirmedUpdates(trackerBoxUpdates(pilot.chain.spend_ledger), st).at(-1) : null;
        // The owner's daily cap on tracker boxes: once used up, the state says so (daily_cap_reached), not "overdue".
        const cap = pilot.chain.spend_ledger ? dailyCap(pilot.chain.spend_ledger) : null;
        // fix inbox #62: the confirmed box's age (the node's height, read only when the box's height is known) and the
        // heights from which the tracker refuses novations on edges with an on-chain total and the reserve contract
        // takes a redemption without the tracker's signature (lib/pilot/anchors.mjs boxWindows).
        const h = st?.confirmed_height, age = st ? boxWindows(h, Number.isSafeInteger(h) && h > 0 ? await nodeHeight(pilot.chain.node) : null) : null;
        return {network: NETWORK, ...chain, anchoring: st && {local_digest: st.local_digest, confirmed_digest: st.confirmed_digest ?? null,
          confirmed_box_id: st.confirmed_box_id ?? null, confirmed_height: st.confirmed_height ?? null, ...age, pending_tx_id: st.pending_tx_id ?? null,
          anchored: !!st.confirmed_digest && st.confirmed_digest === st.local_digest, check_interval_seconds: CHECK_INTERVAL_S,
          ...(cap ? {daily_cap: {limit: cap.limit, signed_today: cap.signed_today, resets_at: cap.resets_at}} : {}),
          ...anchorWatch.state(st, cap, last?.t ?? null),
          ...(last ? {last_update: {tx_id: last.tx_id, signed_at: new Date(last.t).toISOString(), explorer_url: explorerTx(last.tx_id)}} : {})},
          links: {tracker_nft: `${ex}/en/token/${pilot.chain.tracker_nft_id}`, tracker_address: pilot.chain.tracker_address && `${ex}/en/addresses/${pilot.chain.tracker_address}`}};
      });
      // Each reserve's debt and ratio from the tracker's notes, never the tracker's own total_debt placeholder (reserveRows,
      // fix inbox #83); a notes read that fails leaves them null with why_null.
      return sendCached(res, send, 'reserves', async () => {
        const list = await pilot.basis.reserves(), ledger = await pilot.ledger().catch(() => null);
        return {network: NETWORK, unit: pilot.unit, reserve_contract: pilot.chain.reserve_contract, meaning: RESERVES_MEANING,
          reserves: reserveRows(Array.isArray(list) ? list : [], ledger, pk => pilot.byPubkey(pk))};
      });
    }
    // GET /ledger/committed (fix inbox #62): what the tracker's confirmed box on Ergo testnet commits, every note at the
    // total that box commits (lib/pilot/committed.mjs), with the server's own check of them against the box's digest
    // (consistent; a false is served). Public, on the testnet once its tracker is on chain. The current box only: it takes
    // no parameters (any is 400 invalid_field), so it never serves an earlier box or a filtered view, and the server
    // keeps no earlier snapshot (no per-anchor history: owner decision 9, SV-PRIV-1). Burst-cached as the other public
    // reads, on top of committedNow's one read per box. Served only while the tracker binary has TR-20 (pins.mjs
    // TRACKER_SHA256_TR20; cfg.committedRoute true or false overrides it, for tests): on tracker v4.4.1 the route is
    // left out, and answers as any unknown route does, so `valun audit` checks GET /ledger against the box instead.
    if (ON_TESTNET && R && p === '/ledger/committed' && committedPublic()) {
      if (!pilot.chain?.on_chain) throw new PilotError('testnet_bootstrapping', 'the Valun testnet tracker is not on chain yet', 503);
      if (url.search) throw new PilotError('invalid_field', 'GET /ledger/committed takes no parameters: it serves the snapshot of the current tracker box only, never an earlier box');
      return sendCached(res, send, 'ledger-committed', committedNow);
    }
    // The directory leaves out participants the operator unlisted (test or demo agents that are not running); ?all=1 lists
    // every participant (the network view draws every edge), each unlisted one with unlisted: true. ?q=NAME (fix inbox
    // #131) lists only those a join with that handle would meet (Pilot.holdersOf: the handle or display name, compared as
    // join compares names), unlisted ones included: how a newcomer whose join answer was lost sees what that join made.
    if (R && p === '/participants' && url.searchParams.has('q')) {
      const q = url.searchParams.get('q');
      if (q.length > 64) throw new PilotError('invalid_field', 'q: a handle or display name, at most 64 characters');
      return send(res, 200, pilot.holdersOf(q).map(x => pilot.directoryRecord(x)));
    }
    if (R && p === '/participants') {
      const all = url.searchParams.get('all') === '1';
      return sendCached(res, send, all ? 'participants:all' : 'participants', () => {
        const now = typeof pilot.now === 'function' ? pilot.now() : undefined;
        return directoryOrder(pilot, Object.values(pilot.s.participants).filter(x => all || !x.unlisted)).map(x => pilot.directoryRecord(x, now));
      });
    }
    if (R && (m = /^\/participants\/(vp_[0-9a-f]{12})$/.exec(p))) {
      const x = pilot.participant(m[1]);
      return sendCached(res, send, `participant:${x.id}`, async () => ({...pilot.directoryRecord(x), public_position: unitNeutral(await settledNow(x, await pilot.publicPosition(x)))}));
    }
    // The budget card and its check (lib/pilot/card.mjs), once the agent's owner published it (mandate public_card);
    // otherwise 404 card_not_public. Cached as the other public reads are: a check is keyed by its payee, amount and path,
    // which are checked first (400 invalid_field, 404 not_found). Fix inbox #87: the payee's own check (its token) is
    // answered for a payer whose card is not published too, for the payee's own side of the step (its payer side is
    // unknown); any other check of such a payer is 404 card_not_public, a request with no token before anything else.
    if (R && (m = /^\/participants\/(vp_[0-9a-f]{12})\/(card|check)$/.exec(p))) {
      const x = pilot.participant(m[1]);
      if (m[2] === 'card' || !bearer(req)) assertCardPublic(x);
      if (m[2] === 'card') return sendCached(res, send, `card:${x.id}`, () => budgetCard(pilot, x));
      const amount = parseAmount(url.searchParams.get('amount'), pilot.unit), payee = findPayee(pilot, url.searchParams.get('payee'), x);
      // path=payer_proposes|payee_proposes: who would propose the new deal (the payer when not given); the payer's open-offer
      // limit binds only when it proposes.
      const path = parsePath(url.searchParams.get('path'));
      // The payee's cover and its own side of the step (payee_side) are its own business: shown only to a check sent with
      // the payee's token (agent or owner), and such an answer is never cached; everyone else gets the cached public
      // answer, with cover.covered null and no payee_side. A check sent with the payee's agent token is a request of its
      // agent: authenticate renews a self-serve agent on the open network first, as on every route, and the check
      // answers on that state. So a HEAD sent with a token is refused here, never authenticated.
      if (H && bearer(req)) return headRefused(res, send, 'GET');
      const asker = bearer(req) ? pilot.authenticate(bearer(req)) : null, ownCheck = asker?.p?.id === payee.id;
      if (!ownCheck) assertCardPublic(x);
      // Fix inbox #60: deal=vd_... names the offer the payee is deciding on, so the check counts it once, as accepting it
      // does. It is the payee's business: answered only to a check sent with the payee's token, never cached. So is
      // deliver_by=, the delivery time of a new deal the payee's own side counts guarantees for.
      const dealRaw = url.searchParams.get('deal'), deliverRaw = url.searchParams.get('deliver_by');
      if (dealRaw !== null) {
        if (!ownCheck) throw new PilotError('not_payee', 'deal= is answered only to the payee: send the check with the payee\'s agent or owner token', 403);
        if (path !== null || deliverRaw !== null) throw new PilotError('invalid_field', 'path and deliver_by are for a new deal: the deal named with deal= has its own proposer and deliver_by');
        const deal = dealUnderReview(pilot, dealRaw, {payer: x, payee, amount});
        return send(res, 200, await checkPayer(pilot, x, {amount, payee, showCover: true, deal}));
      }
      if (deliverRaw !== null && !ownCheck) throw new PilotError('not_payee', 'deliver_by= is answered only to the payee: send the check with the payee\'s agent or owner token', 403);
      if (ownCheck) return send(res, 200, await checkPayer(pilot, x, {amount, payee, showCover: true, path, deliverBy: parseDeliverBy(pilot, deliverRaw)}));
      return sendCached(res, send, `check:${x.id}:${payee.id}:${amount}:${path ?? ''}`, () => checkPayer(pilot, x, {amount, payee, path}));
    }
    // The reconciliation rows are v15's in every mode (SV-PRIV-1, owner decision 9): no per-edge journal columns here.
    if (R && p === '/ledger') return sendCached(res, send, 'ledger', async () => { const l = await pilot.ledger(); return {unit: pilot.unit, notes: l, reconciliation: await pilot.reconcile(l, {public: true})}; });
    // Closed loops (applied set-offs; lib/pilot/loops.mjs): public handles and amounts only, newest first. In every mode
    // (with circulation off there are none).
    // On the testnet each loop also says where its netting was committed on chain (on_chain: the tracker-box update and
    // its explorer link, or that it is not committed yet).
    // Paged (the local-readiness audit, MR-12: past the newest LOOPS_MAX a run's set-offs could be read only one by one,
    // by id): ?before=<a loop's id> lists the ones after it, as many, with `before` and next_before (the id of the next
    // page, null after the oldest). Without it, the answer is as it was.
    if (R && p === '/loops' && url.searchParams.has('before')) {
      const before = url.searchParams.get('before');
      if (!LOOP_ID_RE.test(before)) throw new PilotError('invalid_field', 'before: the id of a loop (vs_ and 16 hex digits), the last one of the page before');
      if (!loopsBefore(pilot.s.setoffs, pilot.s.participants, publicOf, before)) throw new PilotError('not_found', 'unknown loop', 404);
      return sendCached(res, send, `loops:before:${before}`, async () => {
        const {loops, next_before} = loopsBefore(pilot.s.setoffs, pilot.s.participants, publicOf, before);
        const a = onChain() ? await anchoring() : null;
        return unitNeutral({unit: pilot.unit, network: NETWORK, loops: a ? loops.map(l => ({...l, on_chain: loopOnChain(l, a)})) : loops, before, next_before});
      });
    }
    if (R && p === '/loops') return sendCached(res, send, 'loops', async () => {
      const loops = loopsOf(pilot.s.setoffs, pilot.s.participants, publicOf);
      if (!onChain()) return unitNeutral({unit: pilot.unit, network: NETWORK, loops});
      const a = await anchoring();
      return unitNeutral({unit: pilot.unit, network: NETWORK, loops: loops.map(l => ({...l, on_chain: loopOnChain(l, a)}))});
    });
    if (R && (m = /^\/loops\/([^/]+)$/.exec(p))) {
      const o = LOOP_ID_RE.test(m[1]) ? pilot.setoff(m[1]) : null;
      if (!o || o.state !== 'applied') throw new PilotError('not_found', 'unknown loop', 404);
      return sendCached(res, send, `loop:${o.id}`, async () => {
        const loop = loopOf(o, pilot.s.participants, publicOf);
        return unitNeutral(onChain() ? {...loop, on_chain: loopOnChain(loop, await anchoring())} : loop);
      });
    }
    // The record's evidence, as network totals (lib/pilot/evidence.mjs): delivery, repayment and acceptance kept apart, and
    // the groups participants form by completed exchanges. Aggregates only (no ids, handles or keys); circulation modes
    // sandbox and on (in other modes the route does not exist).
    if (R && p === '/evidence' && pilot.circulating) return sendCached(res, send, 'evidence', async () => unitNeutral(await pilot.publicEvidence()));
    // The clearing engine's public aggregates (circulation modes sandbox and on; no participant ids, handles or keys).
    // In other modes the route does not exist (it falls through, as any unknown route does).
    // Single-flight: requests that arrive while the aggregates are being computed share that computation (the cache holds
    // its promise); one that fails is dropped, so the next request computes them again.
    if (R && p === '/clearing' && pilot.circulating) {
      const t = Date.now();
      if (!clearingCache || t - clearingCache.at >= METRICS_CACHE_MS || t < clearingCache.at) {
        const entry = {at: t, value: Promise.resolve().then(() => pilot.publicClearing()).then(unitNeutral)};
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
    // No invite: sandbox-only participants (off unless enabled); at most 12 an hour from one address, which for an IPv6
    // client is its /48 (fix inbox #21: one host left from a new address on every join), and 40 an hour from all
    // addresses (one host's egress rotated across about 10 /48s).
    if (P && p === '/join-sandbox') return send(res, 201, await pilot.joinSandbox(await readJson(req), {addressKey: ipKey(ip, 48)}));
    if (P && p === '/enroll') return send(res, 201, await pilot.enroll(await readJson(req)));

    // ---------- authenticated ----------
    // A HEAD is never authenticated (authenticate writes): with a token it is refused here, before anything reads the
    // token; without one it gets the 401 a GET without one gets.
    if (H && bearer(req)) return headRefused(res, send, 'GET, POST, PUT');
    // X-Valun-Features: the consent roles an agent's client signs by itself (kept only with circulation on).
    const who = H ? null : pilot.authenticate(bearer(req), {features: req.headers['x-valun-features']});
    if (!who) throw new PilotError('unauthorized', 'missing or invalid token (Authorization: Bearer vpa_… for an agent, vpo_… for an owner)', 401);
    // Writes and reads have separate budgets per token: polling an inbox must not use up the budget for acting.
    if ((wait = limited(`tok:${who.p.id}:${who.role}:${G ? 'r' : 'w'}`, G ? readsPerMinute : perMinute)))
      throw rateLimited(wait, {kind: G ? 'reads' : 'writes', per: 'token', max: G ? readsPerMinute : perMinute});
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
        // least that much, and an agent builds at most REDEMPTION_BUILDS_PER_DAY a day. Only a built redemption counts
        // (only it can cost the tracker a fee): one the tracker refuses, as for a note its box does not commit yet, counts
        // only towards REDEMPTION_ATTEMPTS_PER_DAY.
        if (!Number.isSafeInteger(amount) || amount < REDEMPTION_MIN_NANOERG) throw new PilotError('invalid_field', `amount: whole nanoERG to redeem, at least ${REDEMPTION_MIN_NANOERG} (the miner fee the tracker pays)`);
        // Over either, retry_after_ms says when the next one is taken (dayWait), as every rate_limited answer does.
        const now = Date.now(), builds = (redemptionBuilds.get(me.id) || []).filter(t => now - t < 864e5);
        if ((wait = dayWait(builds, REDEMPTION_BUILDS_PER_DAY, now))) throw new PilotError('rate_limited', `at most ${REDEMPTION_BUILDS_PER_DAY} redemption builds a day per agent`, 429, {retry_after_ms: wait});
        const tries = (redemptionAttempts.get(me.id) || []).filter(t => now - t < 864e5);
        if ((wait = dayWait(tries, REDEMPTION_ATTEMPTS_PER_DAY, now))) throw new PilotError('rate_limited', `at most ${REDEMPTION_ATTEMPTS_PER_DAY} redemption requests a day per agent`, 429, {retry_after_ms: wait});
        tries.push(now); redemptionAttempts.set(me.id, tries);
        // The reserve's hold is taken before anything is awaited, so two requests at once cannot both build.
        // A holder may build again to replace its own build not yet submitted (its client lost it); nobody else may.
        const held = reserveHolds.get(X.pubkey), mine = held && !held.building && !held.tx_id && held.holder === me.id;
        if (held && !mine && (held.building || held.until > now)) throw reserveBusy(X, held.building ? {until: now + 5000} : held, now);
        const hold = {building: true, until: now + RESERVE_BUILD_HOLD_MS, tx_id: null, holder: me.id};
        reserveHolds.set(X.pubkey, hold);
        let built;
        try {
          const note = await relay(() => pilot.basis.note(X.pubkey, me.pubkey));
          if (!note) throw new PilotError('no_note', `you hold no note of ${X.handle}`, 409);
          // Less what backers paid you for X's debt (fix inbox #107): that much is held for them, not yours to redeem.
          const held = typeof pilot.heldForBackers === 'function' ? pilot.heldForBackers(X.id, me.id) : 0;
          const outstanding = Math.max(0, Number(note.amount_collected) - Number(note.amount_redeemed || 0) - held);
          if (amount > outstanding) throw new PilotError('insufficient_claim', `you can redeem at most ${outstanding} nanoERG of ${X.handle}'s note${held ? `: ${held} nanoERG of it is held: backers already paid you that much for what ${X.handle} owes you (guarantee calls they honored), so you are not paid twice` : ''}`, 409);
          built = await relay(() => pilot.basis.redemptionBuild({issuer_pubkey: X.pubkey, recipient_pubkey: me.pubkey, amount,
            timestamp: Number(note.timestamp), issuer_signature: note.signature, denomination: 'erg'})).catch(e => {
            // A note recorded after the tracker's last box (fix inbox #14): say how long that normally lasts and where to look.
            if (e?.code === 'tracker_refused' && /not committed on-?chain/i.test(e.message)) {
              throw new PilotError('tracker_refused', `${e.message}. The tracker checks every ${CHECK_INTERVAL_S} seconds and posts a new tracker box when its state changed; GET /pilot/v1/chain shows its anchoring (anchoring.state). Try again once it is anchored.`, 409);
            }
            // Just after a spend the tracker still looks for the reserve's old box (fix inbox #26): busy, not refused.
            if (e?.code === 'tracker_refused' && /no unspent reserve/i.test(e.message)) {
              const last = [...builtRedemptions.values()].filter(v => v.issuer_pubkey === X.pubkey && v.tx_id).sort((a, b) => b.at - a.at)[0];
              throw reserveBusy(X, {until: Date.now() + 60e3, tx_id: last?.tx_id ?? null}, Date.now());
            }
            throw e;
          });
        } catch (e) {
          if (reserveHolds.get(X.pubkey) === hold) reserveHolds.delete(X.pubkey);
          throw e;
        }
        hold.building = false; hold.until = Date.now() + RESERVE_BUILD_HOLD_MS;
        builds.push(now); redemptionBuilds.set(me.id, builds);
        pilot.store.audit({type: 'redemption.built', issuer: X.id, recipient: me.id, amount});
        for (const [k, v] of builtRedemptions) if (now - v.at > 30 * 60e3) builtRedemptions.delete(k);
        if (typeof built?.partial_tx?.id === 'string') {
          builtRedemptions.set(built.partial_tx.id, {at: now, recipient: me.id,
            issuer_pubkey: X.pubkey, redeemed_amount: amount, new_already_redeemed: Number(built.new_already_redeemed ?? 0)});
          // Fix inbox #107: an honor of a guarantee of this debt waits while this build may still be spent (it reads the
          // tracker box confirmed now; read after the build, so a newer box only makes the wait longer).
          if (typeof pilot.noteRedemptionBuild === 'function') {
            const box = await pilot.basis.trackerState().then(s => s?.confirmed_box_id ?? null, () => null);
            pilot.noteRedemptionBuild({tx_id: built.partial_tx.id, issuer_id: X.id, creditor_id: me.id, tracker_box_id: box});
          }
        }
        // Written with toErgoJson: the transactions' context extensions in the tracker's (Scala's) order, which the
        // client signs over and echoes back to /redemption/submit.
        return send(res, 200, toErgoJson({issuer: {id: X.id, handle: X.handle, pubkey: X.pubkey}, amount, ...built}));
      }
      const rec = typeof body?.signed_tx?.id === 'string' ? builtRedemptions.get(body.signed_tx.id) : undefined;
      if (rec && rec.recipient !== me.id) throw new PilotError('not_found', 'no redemption of yours was built with this transaction', 404);
      // Fix inbox #107: a redemption built before a backer paid you for this debt is checked again: it may not take what
      // is now held for the backers.
      if (rec && typeof pilot.heldForBackers === 'function') {
        const X = typeof pilot.byPubkey === 'function' ? pilot.byPubkey(rec.issuer_pubkey) : null, held = X ? pilot.heldForBackers(X.id, me.id) : 0;
        if (held) {
          const n = await relay(() => pilot.basis.note(rec.issuer_pubkey, me.pubkey));
          const room = Math.max(0, Number(n?.amount_collected ?? 0) - Number(n?.amount_redeemed ?? 0) - held);
          if (rec.redeemed_amount > room) {
            builtRedemptions.delete(body.signed_tx.id);
            throw new PilotError('insufficient_claim', `this redemption takes ${rec.redeemed_amount} nanoERG of ${X.handle}'s note, but you can redeem at most ${room} now: ${held} nanoERG of it is held: backers already paid you that much for what ${X.handle} owes you since it was built (guarantee calls they honored). Nothing was submitted.`, 409);
          }
        }
      }
      const out = await relay(() => pilot.basis.redemptionSubmit({signed_tx: body?.signed_tx, unsigned_tx: body?.unsigned_tx,
        issuer_pubkey: rec?.issuer_pubkey ?? '', recipient_pubkey: me.pubkey, redeemed_amount: rec?.redeemed_amount ?? 0,
        new_already_redeemed: rec?.new_already_redeemed ?? 0})).catch(e => {
        // A box the redemption spends moved between its build and its broadcast (a tracker box update or another
        // redemption on the reserve), and the node refused the transaction as a double spend (fix inbox #123): nothing
        // was spent. Busy, as just after a spend (#26), with how long until the tracker follows the new box; the build
        // is dropped, and its holder may build again.
        if (e?.code === 'tracker_refused' && /double spend/i.test(e.message)) {
          if (rec) builtRedemptions.delete(body.signed_tx.id);
          throw new PilotError('reserve_busy', `a box this redemption spends (the reserve's or the tracker's) changed between its build and its broadcast, and the Ergo node refused it as a double spend: nothing was spent. Build the redemption again once the tracker follows the new box, ${BLOCK_WAIT} (GET /pilot/v1/chain shows its anchoring)`, 409,
            {retry_after_ms: RESERVE_SPEND_HOLD_MS, cause: 'box_moved'});
        }
        throw e;
      });
      if (rec) {
        builtRedemptions.delete(body.signed_tx.id);
        if (typeof pilot.redemptionSubmitted === 'function') pilot.redemptionSubmitted(body.signed_tx.id);
        // Submitted: the reserve stays held until the spend is about confirmed and the tracker follows its new box.
        if (rec.issuer_pubkey) {
          reserveHolds.set(rec.issuer_pubkey, {building: false, until: Date.now() + RESERVE_SPEND_HOLD_MS, tx_id: out?.tx_id ?? null, holder: me.id});
          builtRedemptions.set(`spent:${out?.tx_id ?? body.signed_tx.id}`, {at: Date.now(), issuer_pubkey: rec.issuer_pubkey, tx_id: out?.tx_id ?? null});
        }
      }
      pilot.store.audit({type: 'redemption.submitted', recipient: me.id, tx_id: out?.tx_id ?? null});
      return send(res, 200, {...out, explorer: out?.tx_id ? `${pilot.chain.explorer}/en/transactions/${out.tx_id}` : null});
    }
    // The public profile (display_name, about, services, wants), by the agent or the owner.
    if (U && p === '/profile') return send(res, 200, pilot.setProfile(me, await readJson(req), {by: who.role}));
    // With circulating credit on (modes sandbox and on) /me and /owner also give the owner's credit policy and the
    // features (the server's, and the consent roles counted for the agent's client); in other modes they are as before.
    const circulationKeys = () => (pilot.circulating ? {credit_policy: pilot.creditPolicy(me), features: pilot.featuresOf(me)} : {});
    // public_card: whether the owner published the budget card (lib/pilot/card.mjs). room (fix inbox #54 item 7): what the
    // agent owes and has committed as a payer, and what is left under max_issue_outstanding, counted as checkMandate
    // counts it (the card's room).
    if (G && p === '/me') {
      const ledger = await pilot.ledger();
      return send(res, 200, {role: who.role, participant: pilot.publicParticipant(me), mandate: me.mandate, mandate_version: me.mandate_version, public_card: cardPublic(me),
        agent_limits: me.agent_limits || {}, agent_limits_recorded_by: me.agent_limits_recorded_by || {}, effective_limits: pilot.effectiveLimits(me), mandate_changed_by: me.mandate_changed_by || 'owner',
        position: unitNeutral(await settledNow(me, await pilot.position(me, ledger, {own: true}))), room: roomOf(pilot, me, ledger), network: NETWORK, unit: pilot.unit,
        authority: who.role === 'agent'
          ? 'agent token: may read this participant\'s deals and act within the owner\'s mandate; commitments above approve_above wait for the owner'
          : 'owner token: may change the mandate, decide approvals, revoke the agent and rotate this owner token',
        ...circulationKeys()});
    }
    if (G && p === '/inbox') return send(res, 200, pilot.inbox(me));
    // Deal views as the server answers them (dealView: next_actions judged as the payment routes judge them).
    if (G && p === '/deals') return send(res, 200, (await Promise.all(pilot.dealsFor(me).map(d => pilot.dealView(d, me)))).reverse());
    if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})$/.exec(p))) return send(res, 200, await pilot.dealView(pilot.partyDeal(m[1], me), me));
    if (G && (m = /^\/deals\/(vd_[0-9a-f]{16})\/credit-note-template$/.exec(p))) {
      if (who.role !== 'agent') throw new PilotError('agent_only', 'notes are signed by the agent\'s key', 403);
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

    // Guarantees (fix inbox #18, lib/pilot/guarantees.mjs; circulation modes sandbox and on, for participants circulating
    // credit is on for; otherwise these routes do not exist). Reads: agent and owner; actions: the agent's key.
    if (pilot.guarantees.available(me)) {
      if (G && p === '/guarantees') return send(res, 200, await pilot.guarantees.viewsFor(me));
      if (G && (m = /^\/guarantees\/(vg_[0-9a-f]{16})$/.exec(p))) return send(res, 200, await pilot.guarantees.viewFor(me, m[1]));
      if (G && (m = /^\/guarantees\/(vg_[0-9a-f]{16})\/calls\/(vgc_[0-9a-f]{16})\/note-template$/.exec(p))) {
        if (who.role !== 'agent') throw new PilotError('agent_only', 'notes are signed by the agent\'s key', 403);
        const q = url.searchParams;
        return send(res, 200, await pilot.guarantees.noteTemplate(me, m[1], m[2], {prior: q.get('prior') === '1', bound: q.get('bound') === '1'}));
      }
      if (P && who.role === 'agent') {
        if (p === '/guarantees') return send(res, 201, await pilot.guarantees.offer(me, await readJson(req)));
        if ((m = /^\/guarantees\/(vg_[0-9a-f]{16})\/(accept|decline|withdraw|release|calls)$/.exec(p))) {
          const body = await readJson(req), id = m[1], b = pilot.guarantees;
          const out = await ({accept: () => b.accept(me, id, body), decline: () => b.decline(me, id, body), withdraw: () => b.withdraw(me, id, body),
            release: () => b.release(me, id, body), calls: () => b.call(me, id, body)})[m[2]]();
          return send(res, m[2] === 'calls' ? 201 : 200, out);
        }
        if ((m = /^\/guarantees\/(vg_[0-9a-f]{16})\/calls\/(vgc_[0-9a-f]{16})\/honor$/.exec(p))) return send(res, 200, await pilot.guarantees.honor(me, m[1], m[2], await readJson(req)));
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
      if (G && p === '/owner') return send(res, 200, {participant: pilot.publicParticipant(me), mandate: me.mandate, mandate_version: me.mandate_version, public_card: cardPublic(me),
        mandate_changed_by: me.mandate_changed_by || 'owner', mandate_changed_at: me.mandate_changed_at || null,
        agent_limits: me.agent_limits || {}, agent_limits_recorded_by: me.agent_limits_recorded_by || {}, effective_limits: pilot.effectiveLimits(me),
        owner_token_rotated_at: me.owner_token_rotated_at ?? null, owner_token_rotated_by: me.owner_token_rotated_by ?? null,
        agent: {enrolled: !!me.pubkey, pubkey: me.pubkey, last_seen: me.last_seen_agent, enrollment_pending: !!me.enrollment, enrollment_expires_at: me.enrollment?.expires_at ?? null,
          enrollment_issued_by: me.enrollment?.issued_by ?? null, key_registered_at: me.key_registered_at ?? null},
        past_keys: me.past_pubkeys || [],
        approvals: await Promise.all(Object.values(pilot.s.approvals).filter(a => a.participant === me.id).reverse().map(a => pilot.servedApprovalView(a, me))),
        deals: (await Promise.all(pilot.dealsFor(me).map(d => pilot.dealView(d, me)))).reverse(),
        inbox: pilot.inbox(me), position: unitNeutral(await settledNow(me, await pilot.position(me, null, {own: true}))), ...circulationKeys()});
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
    const wait = limited(`ipr:${clientIp(req)}`, ipReadsPerMinute);
    if (wait) throw rateLimited(wait, {kind: 'reads', per: 'address', max: ipReadsPerMinute});
    const o = LOOP_ID_RE.test(id) ? pilot.setoff(id) : null;
    if (!o || o.state !== 'applied') return send(res, 404, renderLoopNotFound(), HTML);
    const r = await cachedRead(`loop-page:${o.id}`, async () => {
      const loop = loopOf(o, pilot.s.participants, publicOf);
      // The card says who runs each member (memberRecords: their public records) and when it was read, and links a
      // member only to a page this server shows (pageHandles: not an unlisted one's; fix inbox #141).
      const view = {records: memberRecords(o, pilot.s.participants, publicOf), now: Date.now(), pages: pageHandles(pilot.s.participants)};
      return {status: 200, body: renderLoopPage(onChain() ? {...loop, on_chain: loopOnChain(loop, await anchoring())} : loop, view)};
    });
    return send(res, r.status, r.body, HTML);
  };
  // The agent page (GET /agent/<handle>, lib/http.mjs; lib/pilot/agents.mjs): server-rendered HTML of a participant's
  // public record, position and loops, and its budget card once its owner published it (lib/pilot/card.mjs), cached as
  // the public reads are and counted against the same per-address read budget. A handle no participant with an agent
  // (active now, or with an earlier key) has is a 404 page (not cached).
  handle.agentPage = async (req, res, name, send, clientIp) => {
    const wait = limited(`ipr:${clientIp(req)}`, ipReadsPerMinute);
    if (wait) throw rateLimited(wait, {kind: 'reads', per: 'address', max: ipReadsPerMinute});
    const h = String(name || '').toLowerCase();
    const x = AGENT_HANDLE_RE.test(h) ? Object.values(pilot.s.participants).find(q => q.handle === h && agentPageShown(q)) : null;
    if (!x) return send(res, 404, renderAgentNotFound(), HTML);
    const r = await cachedRead(`agent-page:${x.id}`, async () => {
      let pos = null, card = null;
      try { pos = await pilot.publicPosition(x); } catch { pos = null; }   // the page still shows, without the record
      if (cardPublic(x)) { try { card = await budgetCard(pilot, x); } catch { card = null; } }   // and without the card
      const loops = loopsOf(pilot.s.setoffs, pilot.s.participants, publicOf);
      // A counterparty or a vouch is linked only to a page this server shows (pageHandles; fix inbox #141). Its loops
      // are cleared, and committed once a tracker box commits them, as their cards say (nettingOf).
      return {status: 200, body: renderAgentPage(agentView(pilot.directoryRecord(x), pos, loops, {now: Date.now(), dormant: !!pilot.dormant?.(x), card,
        pages: pageHandles(pilot.s.participants), netting: await nettingOf(x)}))};
    });
    return send(res, r.status, r.body, HTML);
  };
  // For the tests: how many public reads were computed (not served from the cache).
  handle.cacheStats = () => ({computed: cacheReads, entries: publicCache.size});
  return handle;
}
