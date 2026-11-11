// The clearing engine (design §5.7, §9.1; spec 18.7, 18.14): which edges may be cleared, the bounded search for cycles
// of debt, the greedy choice of what to propose, packaging into set-off proposals, the MTCS measure and the public
// metrics of GET /clearing; and the Clearing class, which runs the triggers (after an increase, on a consent poll, a
// periodic batch, on admin request) within the limits, cooldowns and presence rules.
//
// Everything above the class is pure: no I/O and no clock (callers pass the time and the state they read). The Pilot
// (lib/pilot/core.mjs) builds the snapshot these functions read (Pilot.clearingSnapshot), creates and applies the
// proposals (Pilot.createSetoff, Pilot.applySetoff) and decides every outcome by reading the tracker back; the engine
// only chooses what to propose. Its choices are not normative: a client checks each proposal on its own edges (15.3),
// never how it was chosen.
//
// Notation: a node is a participant's current public key; an edge 'I>R' (I owes R) has `available` PC that may be
// cleared (outstanding less what live novations reserve). A cycle I1>I2, I2>I3, ..., Ik>I1 lowered by its smallest
// available amount d changes no node's net position; its score is d x k, the gross debt it removes.
import crypto from 'node:crypto';
import {SETOFF_TTL_MS} from './caps.mjs';

export const MAX_CYCLE_LENGTH = 6;                 // cycles of 2..6 edges
export const MAX_EXPANSIONS = 200000;              // DFS steps per batch search
export const MAX_CYCLES = 2000;                    // cycles kept per batch search
export const MAX_PACKAGE_EDGES = 16, MAX_PACKAGE_PARTIES = 8;
export const MTCS_MAX_EDGES = 5000;                // the MTCS measure is skipped (null) above this
export const INCREMENTAL_MAX_PROPOSALS = 2;        // afterChange: at most this many proposals per increase
export const PRESENCE_POLL_MS = 30e3;              // proposeFor: at most once per 30 s per participant
export const COOLDOWN_FAILED_MS = 6 * 3600e3;      // an edge set after an expiry or a failure
export const COOLDOWN_REFUSED_MS = 24 * 3600e3;    // a member and edge set after a refusal
export const EXPIRIES_TO_EXCLUDE = 3, EXCLUSION_MS = 24 * 3600e3;   // three expiries in a row exclude a participant for 24 h
export const METRICS_CACHE_MS = 10e3;              // GET /clearing is computed at most once per 10 s
export const TICK_MS = 60e3;                       // the engine's housekeeping cadence (expiry, pruning, deferred applies)
export const DEFAULT_INTERVAL_MS = 600e3;          // the batch search: every 10 minutes while awake
const WEEK_MS = 7 * 864e5;

// The limits the engine works within (GET /clearing engine.limits; per Clearing instance the caps may differ).
// SV-DOS-1: a member the server does not run that has not signed a set-off since its last expiry left unsigned (one
// that never signed included: Pilot.clearingPlanState unproven) is in at most max_collecting_per_unproven collecting
// set-offs, and set-offs with such a member are at most max_collecting_unproven (4/5 of max_collecting_total), so
// members that never sign cannot hold the whole cap and the rest stays for members that sign.
export const UNPROVEN_SHARE = 0.8;
export const LIMITS = Object.freeze({max_cycle_length: MAX_CYCLE_LENGTH, max_expansions: MAX_EXPANSIONS, max_cycles: MAX_CYCLES,
  max_package_edges: MAX_PACKAGE_EDGES, max_package_parties: MAX_PACKAGE_PARTIES, max_collecting_per_participant: 3, max_collecting_total: 50,
  max_collecting_per_unproven: 1, max_collecting_unproven: Math.ceil(50 * UNPROVEN_SHARE),
  incremental_max_proposals: INCREMENTAL_MAX_PROPOSALS, presence_poll_ms: PRESENCE_POLL_MS, setoff_ttl_ms: SETOFF_TTL_MS,
  cooldown_after_expiry_or_failure_ms: COOLDOWN_FAILED_MS, cooldown_after_refusal_ms: COOLDOWN_REFUSED_MS, expiries_to_exclude: EXPIRIES_TO_EXCLUDE,
  exclusion_ms: EXCLUSION_MS, mtcs_max_edges: MTCS_MAX_EDGES, min_amount_PC: 1});

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const iso = t => new Date(t).toISOString();
export const edgeKeyOf = (issuer, recipient) => `${issuer}>${recipient}`;
// An edge set's id (cooldowns): the sha256 of its sorted edge keys, 32 hex. The same set has the same id in every run.
export const edgeSetId = keys => sha256([...keys].sort().join('\n')).slice(0, 32);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------
// (a) The eligible graph. `snapshot` (Pilot.clearingSnapshot):
//   {mode, participants: {id: {id, pubkey (current key, or null), member (passes the clearing member check), sandbox,
//    server_run, present}}, edges: [{edge, issuer_pubkey, recipient_pubkey, total, outstanding, timestamp, signature,
//    reconciled (its reconciliation row is match and exact), reserved (PC reserved by live set-offs), exclusive (held by a
//    live transfer, or by a live set-off with a client signer), busy (a deal on the pair is issuing_note or
//    completion_awaiting_owner, a set-off on it is being applied, or an earlier payment attempt of a deal not yet paid
//    would change it: Pilot.paymentAttemptHolds, decision D-1)}]}
// An edge is eligible when both keys are current keys, both participants are clearing members, its reconciliation row
// is match and exact, it is not held exclusively or busy, and available = outstanding - reserved >= 1; in mode sandbox
// both participants are sandbox participants. Returns {nodes: Map key -> {key, id, server_run, present}, edges: Map
// edge -> {key, from, to, available, total, timestamp, signature, server_only}, out: Map key -> [edge keys],
// eligible_edges, excluded: {reason: count}} (counts only; edges with nothing outstanding are not counted).
export const EXCLUSION_REASONS = Object.freeze(['not_current_key', 'not_member', 'sandbox_only', 'not_reconciled', 'busy', 'reserved']);
export function eligibleGraph(snapshot) {
  const byKey = new Map();
  for (const p of Object.values(snapshot?.participants ?? {})) if (p?.pubkey) byKey.set(p.pubkey, p);
  const excluded = Object.fromEntries(EXCLUSION_REASONS.map(r => [r, 0])), nodes = new Map(), edges = new Map(), out = new Map();
  const node = p => { if (!nodes.has(p.pubkey)) nodes.set(p.pubkey, {key: p.pubkey, id: p.id, server_run: !!p.server_run, present: !!p.server_run || !!p.present}); return nodes.get(p.pubkey); };
  for (const e of snapshot?.edges ?? []) {
    if (!(Number(e?.outstanding) > 0)) continue;
    const a = byKey.get(e.issuer_pubkey), b = byKey.get(e.recipient_pubkey);
    const why = !a || !b || a === b ? 'not_current_key' : !a.member || !b.member ? 'not_member'
      : snapshot.mode === 'sandbox' && !(a.sandbox && b.sandbox) ? 'sandbox_only' : !e.reconciled ? 'not_reconciled' : e.busy ? 'busy'
        : e.exclusive || e.outstanding - (e.reserved ?? 0) < 1 ? 'reserved' : null;
    if (why) { excluded[why] += 1; continue; }
    const k = e.edge ?? edgeKeyOf(e.issuer_pubkey, e.recipient_pubkey), from = node(a), to = node(b);
    edges.set(k, {key: k, from: from.key, to: to.key, available: e.outstanding - (e.reserved ?? 0), total: e.total, timestamp: e.timestamp ?? 0,
      signature: e.signature ?? null, server_only: from.server_run && to.server_run});
    if (!out.has(from.key)) out.set(from.key, []);
    out.get(from.key).push(k);
  }
  for (const list of out.values()) list.sort((x, y) => cmpStr(edges.get(x).to, edges.get(y).to));
  return {nodes, edges, out, eligible_edges: edges.size, excluded};
}

// The part of a graph whose cycles can be proposed now: the nodes that are present (seen within 10 minutes; a node the
// server runs always is) and the edges between them. The triggers search it, so that a wide cycle through an absent
// member never hides one that can be proposed.
export function presentGraph(graph) {
  const nodes = new Map([...graph.nodes].filter(([, n]) => n.present || n.server_run));
  const edges = new Map([...graph.edges].filter(([, e]) => nodes.has(e.from) && nodes.has(e.to)));
  const out = new Map();
  for (const [k, list] of graph.out) if (nodes.has(k)) out.set(k, list.filter(ek => edges.has(ek)));
  return {...graph, nodes, edges, out};
}

// The cycle record every search returns: {edges (keys, in cycle order), nodes (keys; nodes[i] is edges[i]'s issuer),
// length, amount (the smallest available amount), min_timestamp (the oldest edge note), client_members (members not
// run by the server), set (the sorted edge keys, for ties), set_id (edgeSetId)}.
function cycleOf(graph, keys) {
  const es = keys.map(k => graph.edges.get(k));
  const nodes = es.map(e => e.from);
  return {edges: [...keys], nodes, length: keys.length, amount: Math.min(...es.map(e => e.available)), min_timestamp: Math.min(...es.map(e => e.timestamp ?? 0)),
    client_members: nodes.filter(n => !graph.nodes.get(n)?.server_run).length, set: [...keys].sort().join(','), set_id: edgeSetId(keys)};
}

// The node order of a run: sorted by sha256(run_id + key), so the bounded search starts from other nodes in every run
// and no participant always comes first. Deterministic for a run id.
export function runOrder(runId, keys) {
  return [...keys].map(k => [sha256(`${runId}${k}`), k]).sort((a, b) => cmpStr(a[0], b[0]) || cmpStr(a[1], b[1])).map(([, k]) => k);
}

// (b) The cycle through edge `key` with the widest bottleneck: a bounded widest path from the edge's recipient back to
// its issuer (at most maxLen - 1 more edges), then the edge itself. Among equally wide paths the shortest wins, then
// the smaller edge key at each step. null when there is none. The search is a max-min dynamic programme over walks of
// exactly k edges (k = 1..maxLen-1); a walk that repeats a node is cut back to a simple path, which is never narrower
// and is shorter, so the result is a simple cycle of the widest possible bottleneck.
export function cycleThrough(graph, key, {maxLen = MAX_CYCLE_LENGTH} = {}) {
  const e0 = graph.edges.get(key);
  if (!e0 || maxLen < 2) return null;
  // Widths start at the edge's own available amount: a cycle is never wider than it, so a shorter path that is as wide
  // as the edge allows wins over a longer, wider one.
  const I = e0.from, R = e0.to, layers = [new Map([[R, {width: e0.available, via: null}]])];
  let best = null;
  for (let k = 1; k <= maxLen - 1; k++) {
    const next = new Map();
    for (const [u, st] of layers[k - 1]) {
      if (u === I) continue;                                   // a walk that reached the issuer ends there
      for (const ek of graph.out.get(u) ?? []) {
        if (ek === key) continue;
        const e = graph.edges.get(ek), w = Math.min(st.width, e.available), cur = next.get(e.to);
        if (!cur || w > cur.width || (w === cur.width && ek < cur.via)) next.set(e.to, {width: w, via: ek});
      }
    }
    layers.push(next);
    const at = next.get(I);
    if (at && (!best || at.width > best.width)) best = {k, width: at.width};
  }
  if (!best) return null;
  const walk = [];
  for (let k = best.k, n = I; k >= 1; k--) { const st = layers[k].get(n); walk.unshift(st.via); n = graph.edges.get(st.via).from; }
  // Cut loops: keep the walk R -> ... -> I simple (a node seen again drops everything since its first visit).
  const path = [], seenAt = new Map([[R, 0]]);
  for (const ek of walk) {
    const v = graph.edges.get(ek).to;
    if (seenAt.has(v)) { path.length = seenAt.get(v); for (const [n, i] of [...seenAt]) if (i > path.length) seenAt.delete(n); }
    else { path.push(ek); seenAt.set(v, path.length); }
    if (v === I) break;
  }
  return cycleOf(graph, [key, ...path]);
}

// (c) Simple cycles of 2..maxLen edges, each found once in canonical rotation: a DFS from every node in `order`
// (default: sorted keys) that visits only nodes later in the order, so a cycle is found from its first node. With
// `through`, only the cycles through that node, each once (rooted at it). At most maxExpansions edge steps and
// maxCycles cycles: {cycles, expansions, truncated}.
export function boundedCycles(graph, {maxLen = MAX_CYCLE_LENGTH, maxExpansions = MAX_EXPANSIONS, maxCycles = MAX_CYCLES, order = null, through = null} = {}) {
  const keys = order ?? [...graph.nodes.keys()].sort(cmpStr), rank = new Map(keys.map((k, i) => [k, i]));
  const outOf = u => [...(graph.out.get(u) ?? [])].filter(ek => rank.has(graph.edges.get(ek).to))
    .sort((x, y) => rank.get(graph.edges.get(x).to) - rank.get(graph.edges.get(y).to) || cmpStr(x, y));
  const cycles = [];
  let expansions = 0, truncated = false;
  const starts = through ? (rank.has(through) ? [through] : []) : keys;
  search: for (const s of starts) {
    const rs = rank.get(s), pathEdges = [], onPath = new Set([s]), stack = [{list: outOf(s), i: 0}];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i >= f.list.length) {
        stack.pop();
        if (pathEdges.length) onPath.delete(graph.edges.get(pathEdges.pop()).to);
        continue;
      }
      if (expansions >= maxExpansions || cycles.length >= maxCycles) { truncated = true; break search; }
      const ek = f.list[f.i++], v = graph.edges.get(ek).to;
      expansions += 1;
      if (v === s) { if (pathEdges.length >= 1) cycles.push(cycleOf(graph, [...pathEdges, ek])); continue; }
      if (onPath.has(v) || (!through && rank.get(v) < rs) || pathEdges.length + 2 > maxLen) continue;
      pathEdges.push(ek); onPath.add(v);
      stack.push({list: outOf(v), i: 0});
    }
  }
  return {cycles, expansions, truncated};
}

// (d) The ranking: score = amount x length (the gross debt a cycle removes); ties go to the shorter cycle (fewer
// consents), then the one with fewer members the server does not run, then the older smallest edge timestamp (older
// obligations clear first), then the sorted edge keys. A negative result ranks `a` first.
export const cycleScore = c => c.amount * c.length;
export function compareCycles(a, b) {
  return cycleScore(b) - cycleScore(a) || a.length - b.length || a.client_members - b.client_members || a.min_timestamp - b.min_timestamp || cmpStr(a.set, b.set);
}

// (e) Greedy selection with residual subtraction: repeatedly take the best-ranked cycle at its residual amount (the
// smallest residual on its edges), subtract that amount from each of its edges, and go on; a cycle whose residual fell
// is ranked again at its new amount (lazy re-evaluation: residuals only fall). `residual`: Map edge -> PC (default:
// the graph's available amounts; it is changed). Returns the chosen cycles with their amounts, best first.
export function selectCycles(graph, cycles, {residual = null, limit = Infinity} = {}) {
  const res = residual ?? new Map([...graph.edges].map(([k, e]) => [k, e.available]));
  const amountOf = c => Math.min(...c.edges.map(k => res.get(k) ?? 0));
  const queue = cycles.map(c => ({...c, amount: amountOf(c)})).filter(c => c.amount >= 1).sort(compareCycles);
  const insert = c => {
    let lo = 0, hi = queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (compareCycles(queue[mid], c) <= 0) lo = mid + 1; else hi = mid; }
    queue.splice(lo, 0, c);
  };
  const out = [];
  while (queue.length && out.length < limit) {
    const c = queue.shift(), amt = amountOf(c);
    if (amt < 1) continue;
    if (amt < c.amount) { insert({...c, amount: amt}); continue; }
    out.push(c);
    for (const k of c.edges) res.set(k, res.get(k) - amt);
  }
  return out;
}

// (f) Packaging: chosen cycles that share an edge become one proposal, with the decreases on a shared edge added up, so
// the proposal stays balanced for every key by construction; a package stays within maxEdges edges and maxParties
// parties (a cycle that would make it larger is left out of this run). Packages are edge-disjoint. Each package:
// {edges: [{edge, from, to, decrease, state {total, timestamp, signature}}] (in the order the cycles list them),
// members (keys), cycles: [{edges, length, amount}], amount (the sum of the decreases: what it clears), set_id}.
export function packageCycles(graph, selected, {maxEdges = MAX_PACKAGE_EDGES, maxParties = MAX_PACKAGE_PARTIES} = {}) {
  let packages = [];
  const owner = new Map();                                     // edge key -> the package holding it
  for (const c of selected) {
    const touching = [...new Set(c.edges.map(k => owner.get(k)).filter(Boolean))];
    const edges = new Map(), members = [], cyc = [];
    const addMember = n => { if (!members.includes(n)) members.push(n); };
    for (const p of touching) { for (const [k, e] of p.edges) edges.set(k, {...e}); p.members.forEach(addMember); cyc.push(...p.cycles); }
    for (const k of c.edges) {
      const g = graph.edges.get(k), e = edges.get(k) ?? {edge: k, from: g.from, to: g.to, decrease: 0, state: {total: g.total, timestamp: g.timestamp, signature: g.signature}};
      e.decrease += c.amount; edges.set(k, e);
    }
    c.nodes.forEach(addMember); cyc.push({edges: [...c.edges], length: c.length, amount: c.amount});
    if (edges.size > maxEdges || members.length > maxParties) continue;
    const merged = {edges, members, cycles: cyc};
    packages = [...packages.filter(p => !touching.includes(p)), merged];
    for (const k of edges.keys()) owner.set(k, merged);
  }
  return packages.map(p => {
    const edges = [...p.edges.values()];
    return {edges, members: p.members, cycles: p.cycles, amount: edges.reduce((a, e) => a + e.decrease, 0), set_id: edgeSetId(edges.map(e => e.edge))};
  });
}

// Whether a list of edges {from, to, decrease} (or {issuer_pubkey, recipient_pubkey, decrease}) is balanced: for every
// key, the decreases where it is the creditor add up to those where it is the issuer (the tracker's per-key rule).
export function balanced(edges) {
  const net = new Map();
  for (const e of edges) {
    const f = e.from ?? e.issuer?.pubkey ?? e.issuer_pubkey, t = e.to ?? e.recipient?.pubkey ?? e.recipient_pubkey, d = e.decrease;
    if (!Number.isSafeInteger(d) || d < 1 || !f || !t || f === t) return false;
    net.set(f, (net.get(f) ?? 0) + d); net.set(t, (net.get(t) ?? 0) - d);
  }
  return [...net.values()].every(v => v === 0);
}

// Proposals for one trigger, from candidate cycles: cycles in a cooldown are left out (the edge set after an expiry or
// a failure; a member and the edge set after its refusal); with `requirePresence`, so is every cycle with a member the
// server does not run that is not present (seen within 10 minutes). The rest are selected (e) and packaged (f); then
// the caps: at most max_collecting_per_participant collecting proposals per participant the server does not run
// (`collecting`: Map id -> how many it is in now) and max_collecting_total in all (`collectingTotal`), and at most
// `max` proposals. `cooldowns`: {key: {until (ms)}} with keys 'set:<set_id>' and 'refusal:<participant id>:<set_id>'.
// SV-DOS-1: `unproven` (a Set of participant ids: members that have not signed) are in at most
// max_collecting_per_unproven each, and proposals with one at most max_collecting_unproven in all (`collectingUnproven`
// now).
export function planProposals(graph, cycles, {now, cooldowns = {}, collecting = new Map(), collectingTotal = 0, limits = LIMITS,
  requirePresence = true, max = Infinity, residual = null, unproven = null, collectingUnproven = 0} = {}) {
  const active = k => Number(cooldowns?.[k]?.until) > now;
  const idOf = n => graph.nodes.get(n)?.id;
  // A cycle with a client member already at its cap is left out before the selection (SV-DOS-1), so that it never takes
  // the edges of a cycle that could be proposed: a package with such a member would be dropped below anyway.
  const capped = id => (collecting.get(id) ?? 0) >= limits.max_collecting_per_participant || (!!unproven?.has(id)
    && ((collecting.get(id) ?? 0) >= (limits.max_collecting_per_unproven ?? Infinity) || collectingUnproven >= (limits.max_collecting_unproven ?? Infinity)));
  const candidates = cycles.filter(c => c.length >= 2 && c.length <= limits.max_cycle_length && !active(`set:${c.set_id}`)
    && !c.nodes.some(n => active(`refusal:${idOf(n)}:${c.set_id}`))
    && !(requirePresence && c.nodes.some(n => { const x = graph.nodes.get(n); return !x || (!x.server_run && !x.present); }))
    && !c.nodes.some(n => { const x = graph.nodes.get(n); return !!x && !x.server_run && capped(x.id); }));
  const packages = packageCycles(graph, selectCycles(graph, candidates, {residual}), {maxEdges: limits.max_package_edges, maxParties: limits.max_package_parties});
  const per = new Map(collecting);
  let total = collectingTotal, weakTotal = collectingUnproven;
  const out = [];
  for (const p of packages) {
    if (out.length >= max || total >= limits.max_collecting_total) break;
    const clients = p.members.map(n => graph.nodes.get(n)).filter(x => x && !x.server_run).map(x => x.id);
    if (clients.some(id => (per.get(id) ?? 0) >= limits.max_collecting_per_participant)) continue;
    const weak = unproven ? clients.filter(id => unproven.has(id)) : [];
    if (weak.length && (weakTotal >= (limits.max_collecting_unproven ?? Infinity) || weak.some(id => (per.get(id) ?? 0) >= (limits.max_collecting_per_unproven ?? Infinity)))) continue;
    out.push(p); total += 1;
    if (weak.length) weakTotal += 1;
    for (const id of clients) per.set(id, (per.get(id) ?? 0) + 1);
  }
  return out;
}

// (g) The maximum circulation (MTCS, the Fleischman-Dini formulation): the most gross debt any set of balanced
// decreases could remove from `edges` ([{from, to, capacity | available}]), computed as a min-cost flow: the debt that
// must remain, y with 0 <= y <= capacity and every node's net position unchanged (each node sends its net debt
// owes - claims to the net creditors), at cost 1 per PC per edge, minimised by successive shortest paths (SPFA, so the
// reverse edges' negative costs are handled); the maximum circulation is gross - min cost. null above maxEdges edges.
// Returns {gross, net_floor (the sum of the net debts), residual (the min cost), clearable}.
export function mtcs(edges, {maxEdges = MTCS_MAX_EDGES} = {}) {
  const list = [...(edges instanceof Map ? edges.values() : edges)].map(e => ({from: e.from, to: e.to, c: e.capacity ?? e.available}))
    .filter(e => e.from !== e.to && Number.isSafeInteger(e.c) && e.c > 0);
  if (list.length > maxEdges) return null;
  const idx = new Map(), id = k => { if (!idx.has(k)) idx.set(k, idx.size); return idx.get(k); };
  for (const e of list) { id(e.from); id(e.to); }
  const n = idx.size, S = n, T = n + 1, N = n + 2;
  const head = new Array(N).fill(-1), next = [], to = [], cap = [], cost = [];
  const add = (u, v, c, w) => {
    to.push(v); cap.push(c); cost.push(w); next.push(head[u]); head[u] = to.length - 1;
    to.push(u); cap.push(0); cost.push(-w); next.push(head[v]); head[v] = to.length - 1;
  };
  const b = new Array(n).fill(0);
  let gross = 0;
  for (const e of list) { const u = id(e.from), v = id(e.to); add(u, v, e.c, 1); b[u] += e.c; b[v] -= e.c; gross += e.c; }
  let supply = 0;
  for (let v = 0; v < n; v++) { if (b[v] > 0) { add(S, v, b[v], 0); supply += b[v]; } else if (b[v] < 0) add(v, T, -b[v], 0); }
  let flow = 0, residual = 0;
  const dist = new Array(N), prev = new Array(N), inQueue = new Uint8Array(N);
  while (flow < supply) {
    dist.fill(Infinity); prev.fill(-1); dist[S] = 0;
    const q = [S];
    inQueue[S] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const u = q[qi]; inQueue[u] = 0;
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (cap[e] > 0 && dist[u] + cost[e] < dist[to[e]]) {
          dist[to[e]] = dist[u] + cost[e]; prev[to[e]] = e;
          if (!inQueue[to[e]]) { inQueue[to[e]] = 1; q.push(to[e]); }
        }
      }
    }
    if (dist[T] === Infinity) break;
    let f = Infinity;
    for (let v = T; v !== S; v = to[prev[v] ^ 1]) f = Math.min(f, cap[prev[v]]);
    for (let v = T; v !== S; v = to[prev[v] ^ 1]) { cap[prev[v]] -= f; cap[prev[v] ^ 1] += f; }
    flow += f; residual += f * dist[T];
  }
  return {gross, net_floor: supply, residual, clearable: gross - residual};
}

// What the bounded engine could clear on `graph` now, within its limits (no presence, caps or cooldowns): the
// cycles of a full bounded search, selected and packaged. Its sum is clearable_within_limits_PC.
export function clearableWithinLimits(graph, {limits = LIMITS, order = null} = {}) {
  const {cycles, truncated} = boundedCycles(graph, {maxLen: limits.max_cycle_length, maxExpansions: limits.max_expansions, maxCycles: limits.max_cycles, order});
  const packages = packageCycles(graph, selectCycles(graph, cycles), {maxEdges: limits.max_package_edges, maxParties: limits.max_package_parties});
  return {clearable: packages.reduce((a, p) => a + p.amount, 0), packages, truncated};
}

// ---------------------------------------------------------------------------------------------------------------
// Set-off records (pure helpers for lib/pilot/core.mjs).
// The tracker request (POST /notes/setoff, version 3; its fields only, since the tracker refuses unknown ones) for a
// set-off whose edges are all signed: each edge's issuer and creditor signatures over M(I,R,P-d,ts_e). With per-edge
// timestamps each edge carries its own timestamp (the request's `timestamp` is then only a default, the latest);
// without them every edge has the same one, sent once. Throws TypeError for a missing signature or timestamp.
export function trackerSetoffBody(o, {perEdgeTimestamps = true} = {}) {
  const sig = (e, role) => {
    const s = e.slots?.[role]?.signature;
    if (typeof s !== 'string' || !/^0[23][0-9a-f]{128}$/.test(s)) throw new TypeError(`set-off: the ${role} slot of ${e.edge} is not signed`);
    return s;
  };
  const ts = o.edges.map(e => e.timestamp);
  if (!ts.every(t => Number.isSafeInteger(t) && t >= 0)) throw new TypeError('set-off: every edge needs its timestamp');
  if (!perEdgeTimestamps && new Set(ts).size !== 1) throw new TypeError('set-off: without per-edge timestamps every edge has the same timestamp');
  return {denomination: o.denomination, timestamp: Math.max(...ts), edges: o.edges.map(e => ({issuer_pubkey: e.issuer.pubkey, recipient_pubkey: e.recipient.pubkey,
    decrease: e.decrease, ...(perEdgeTimestamps ? {timestamp: e.timestamp} : {}), issuer_signature: sig(e, 'issuer'), recipient_signature: sig(e, 'recipient')}))};
}
// A set-off's outcome from its edges' classes (classifyEdge in lib/pilot/novation.mjs, one per edge): 'applied' (every
// edge at, or moved past at, its new state); 'unknown' (an edge in a state that may follow an application); 'inconsistent'
// (some edges applied and others not, which one tracker batch cannot produce: an alarm); 'prior' (every edge untouched:
// not applied, it may still be submitted); 'not_applied' (an edge changed or moved past without it: it did not apply).
export function setoffOutcome(classes) {
  const done = c => c === 'new' || c === 'applied_moved';
  if (classes.length && classes.every(done)) return 'applied';
  if (classes.some(c => c === 'unknown')) return 'unknown';
  if (classes.some(done)) return 'inconsistent';
  if (classes.every(c => c === 'prior')) return 'prior';
  return 'not_applied';
}

// ---------------------------------------------------------------------------------------------------------------
// (h) The public metrics of GET /clearing (design §5.7, spec 18.14): aggregates only, no participant ids, handles or
// keys. Inputs: `snapshot` (as eligibleGraph reads it; its edges are every tracker edge in the pilot denomination, with
// `issuer` and `recipient` participant ids, used here only to count positions), `graph` (eligibleGraph(snapshot)),
// `setoffs` and `transfers` (the records), `issued` ([{at (ms), amount}]: credit notes recorded), `dormant` (ids of
// sandbox participants whose sandbox time has ended), `engine` ({enabled, interval_ms, limits, last_run}).
//   graph_now: participants_with_positions, edges, gross_PC and net_floor_PC (sum of max(0, owes - claims) per
//     participant) over every outstanding edge; clearable_mtcs_PC (the maximum circulation of the eligible graph, null
//     above 5000 edges), clearable_within_limits_PC (what the bounded engine could clear there now) and bound_gap
//     (clearable_within_limits_PC / clearable_mtcs_PC, 3 decimals; null when the measure is null or 0).
//   totals: every applied set-off and transfer the server keeps (edges_closed: set-off edges brought to 0).
//   last_7_days: issued_PC (credit notes recorded), cleared_PC, liquidity_saving_pct (cleared / issued, 1 decimal),
//     capacity_restored_PC (the sum of the reductions in what participants owe through set-offs).
//   proposals: collecting (now, applying included); the others over proposals created in the last 7 days: applied,
//     stale (superseded), expired, refused, failed (failed, void_key_revoked, inconsistent); completion_rate_pct
//     (applied / ended, 1 decimal) and median_ms_to_apply.
//   cycles_by_length: the cycles in applied set-offs, by length.
//   sandbox.dormant_PC: what is owed to sandbox participants whose sandbox time has ended.
export function metrics({now, unit = 'PC', engine = null, snapshot = {edges: []}, graph = null, setoffs = [], transfers = [], issued = [], dormant = [], limits = LIMITS}) {
  const open = (snapshot.edges ?? []).filter(e => Number(e.outstanding) > 0);
  const net = new Map();
  for (const e of open) {
    const i = e.issuer ?? `key:${e.issuer_pubkey}`, r = e.recipient ?? `key:${e.recipient_pubkey}`;
    net.set(i, (net.get(i) ?? 0) + e.outstanding); net.set(r, (net.get(r) ?? 0) - e.outstanding);
  }
  const m = graph ? mtcs(graph.edges, {maxEdges: limits.mtcs_max_edges}) : null;
  const within = graph ? clearableWithinLimits(graph, {limits}).clearable : 0;
  const week = now - WEEK_MS, applied = setoffs.filter(o => o.state === 'applied'), recent = setoffs.filter(o => Date.parse(o.created_at) >= week);
  const appliedAt = o => Date.parse(o.applied_at);
  const cleared = xs => xs.reduce((a, o) => a + o.amount, 0);
  const lastWeek = applied.filter(o => appliedAt(o) >= week), issuedPC = issued.filter(x => x.at >= week).reduce((a, x) => a + x.amount, 0);
  const count = (...states) => recent.filter(o => states.includes(o.state)).length;
  const done = {applied: count('applied'), stale: count('superseded'), expired: count('expired'), refused: count('refused'), failed: count('failed', 'void_key_revoked', 'inconsistent')};
  const ended = Object.values(done).reduce((a, x) => a + x, 0);
  const times = recent.filter(o => o.state === 'applied').map(o => appliedAt(o) - Date.parse(o.created_at)).sort((a, b) => a - b);
  const median = times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : Math.round((times[times.length / 2 - 1] + times[times.length / 2]) / 2)) : null;
  const byLength = {};
  for (const o of applied) for (const c of o.cycles ?? []) byLength[String(c.length)] = (byLength[String(c.length)] ?? 0) + 1;
  const dormantIds = new Set(dormant);
  const pct = (x, y) => (y > 0 ? Math.round((x * 1000) / y) / 10 : null);
  const appliedTransfers = transfers.filter(t => t.state === 'applied');
  return {
    as_of: iso(now), unit, tier: 'pure_credit',
    engine: {enabled: !!engine?.enabled, interval_ms: engine?.interval_ms ?? null, limits: engine?.limits ?? limits, last_run: engine?.last_run ?? null},
    graph_now: {participants_with_positions: net.size, edges: open.length, gross_PC: open.reduce((a, e) => a + e.outstanding, 0),
      net_floor_PC: [...net.values()].reduce((a, v) => a + Math.max(0, v), 0), clearable_mtcs_PC: m ? m.clearable : null,
      clearable_within_limits_PC: within, bound_gap: m && m.clearable > 0 ? Math.round((within * 1000) / m.clearable) / 1000 : null},
    totals: {setoffs_applied: applied.length, cleared_PC: cleared(applied), edges_closed: applied.reduce((a, o) => a + o.edges.filter(e => e.new_total === 0).length, 0),
      transfers_applied: appliedTransfers.length, transferred_PC: appliedTransfers.reduce((a, t) => a + t.amount, 0)},
    last_7_days: {issued_PC: issuedPC, cleared_PC: cleared(lastWeek), liquidity_saving_pct: pct(cleared(lastWeek), issuedPC),
      capacity_restored_PC: lastWeek.reduce((a, o) => a + o.edges.reduce((x, e) => x + e.decrease, 0), 0)},
    proposals: {collecting: setoffs.filter(o => o.state === 'collecting' || o.state === 'applying').length, ...done,
      completion_rate_pct: pct(done.applied, ended), median_ms_to_apply: median},
    cycles_by_length: byLength,
    sandbox: {dormant_PC: open.filter(e => dormantIds.has(e.recipient)).reduce((a, e) => a + e.outstanding, 0)},
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The engine. `pilot` provides: circulating, now(), serial(fn), clearingSnapshot(), clearingPlanState() ({cooldowns,
// collecting, collectingTotal}), createSetoff(pkg, {source, runId, limits}) (with the lock held), recordClearingRun(run),
// setoffHousekeeping() and applyReadySetoffs() (with the lock held), applyReadySetoff(id). Triggers:
//   afterChange(keys)  every journal increase (a credit note, an incoming transfer), with the caller's lock held: the
//                      widest cycle through each raised edge (cycleThrough); at most 2 proposals, only of cycles whose
//                      members the server runs or are present;
//   proposeFor(p)      a consent poll (GET /consents) by p's agent, at most once per 30 s per participant: the cycles
//                      through p whose other members are server-run or present; takes the lock;
//   tick()             housekeeping (expiry, pruning, applying complete proposals that had to wait), and the batch
//                      search when it is due (every intervalMs; at startup; POST /admin/clearing/run).
// Every trigger searches the present part of the eligible graph (presentGraph): only cycles whose members are all
// present or server-run are proposed. The batch takes its snapshot outside the lock and creates each proposal under it
// (createSetoff re-reads every edge and checks everything again). Every timer is unref'd and stop() clears them;
// failures are logged, never thrown into the caller of afterChange or proposeFor.
export class Clearing {
  constructor({pilot, intervalMs = DEFAULT_INTERVAL_MS, maxCollectingPerParticipant = 3, maxCollectingTotal = 50, now = null, log = () => {}} = {}) {
    this.pilot = pilot; this.intervalMs = intervalMs; this.log = log;
    this.now = now ?? (() => pilot.now());
    this.limits = Object.freeze({...LIMITS, max_collecting_per_participant: maxCollectingPerParticipant, max_collecting_total: maxCollectingTotal,
      max_collecting_per_unproven: Math.min(LIMITS.max_collecting_per_unproven, maxCollectingPerParticipant), max_collecting_unproven: Math.ceil(maxCollectingTotal * UNPROVEN_SHARE)});
    this.timers = new Set(); this.polled = new Map(); this.retrying = new Set();
    this.started = false; this.interval = null; this.lastRun = null; this.lastBatchAt = null; this.running = null; this.ticking = null;
  }
  get enabled() { return this.started && !!this.pilot.circulating; }
  // What GET /clearing says about the engine (no identities).
  engineInfo() {
    const r = this.lastRun ?? this.pilot.s?.clearing?.runs?.at(-1) ?? null;
    return {enabled: this.enabled, interval_ms: this.intervalMs, limits: this.limits,
      last_run: r && {at: r.at, reason: r.reason, eligible_edges: r.eligible_edges, excluded: r.excluded}};
  }
  // fn after ms (unref'd; cleared by stop()); its failure is logged.
  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); Promise.resolve().then(fn).catch(e => this.log(`clearing: ${e?.message ?? e}`)); }, Math.max(0, ms));
    t.unref?.();
    this.timers.add(t);
    return t;
  }
  // A complete proposal that waits (for a timestamp ending in 998 ms on a server-only edge): applied after `ms`.
  defer(id, ms) { this.later(() => this.pilot.serial(() => this.pilot.applyReadySetoff(id)), ms + 20); }

  noteRun(r) { this.lastRun = r; return r; }
  plan(graph, cycles, {max = Infinity} = {}) {
    const st = this.pilot.clearingPlanState();
    return planProposals(graph, cycles, {now: this.now(), cooldowns: st.cooldowns, collecting: st.collecting, collectingTotal: st.collectingTotal,
      unproven: st.unproven ?? null, collectingUnproven: st.collectingUnproven ?? 0, limits: this.limits, requirePresence: true, max});
  }
  async propose(packages, {source, runId}) {
    const out = [];
    for (const pkg of packages) out.push(await this.pilot.createSetoff(pkg, {source, runId, limits: this.limits}));
    return out;
  }
  static runId() { return 'rn_' + crypto.randomBytes(8).toString('hex'); }

  // With the caller's lock held (Pilot: after the journal recorded an increase). Never throws.
  async afterChange(keys, {retry = false} = {}) {
    const pilot = this.pilot, list = [...new Set(keys ?? [])];
    if (!pilot.circulating || !list.length) return [];
    try {
      const g = eligibleGraph(await pilot.clearingSnapshot()), pg = presentGraph(g), seen = new Set(), cycles = [];
      for (const k of list) {
        const c = cycleThrough(pg, k, {maxLen: this.limits.max_cycle_length});
        if (c && !seen.has(c.set)) { seen.add(c.set); cycles.push(c); }
      }
      const runId = Clearing.runId();
      this.noteRun({id: runId, at: iso(this.now()), reason: 'incremental', eligible_edges: g.eligible_edges, excluded: g.excluded, cycles_found: cycles.length});
      if (!cycles.length) return [];
      const made = await this.propose(this.plan(pg, cycles, {max: this.limits.incremental_max_proposals}), {source: 'incremental', runId});
      // A cycle whose newest edge has no timestamp ending in 998 ms at least 1.5 s back yet: tried once more then.
      const wait = Math.max(0, ...made.filter(x => x?.skipped === 'timestamp_ahead').map(x => x.retry_after_ms ?? 0));
      const key = list.join(',');
      if (wait > 0 && !retry && !this.retrying.has(key)) {
        this.retrying.add(key);
        this.later(() => pilot.serial(() => this.afterChange(list, {retry: true})).finally(() => this.retrying.delete(key)), wait + 20);
      }
      return made;
    } catch (e) { this.log(`clearing: after a change: ${e?.message ?? e}`); return []; }
  }

  // GET /consents by p's agent: proposals through p, at most once per PRESENCE_POLL_MS per participant. Takes the lock.
  // Never throws.
  async proposeFor(p) {
    const pilot = this.pilot, now = this.now();
    if (!pilot.circulating || !p?.id || !p.pubkey) return [];
    if (now - (this.polled.get(p.id) ?? -Infinity) < this.limits.presence_poll_ms) return [];
    this.polled.set(p.id, now);
    if (this.polled.size > 10000) for (const [id, at] of this.polled) if (now - at >= this.limits.presence_poll_ms) this.polled.delete(id);
    if (pilot.clearingParticipantCheck(p)) return [];
    // SV-ROB-2: no lock and no tracker read for a member with no edge from it and none to it (no cycle can pass it).
    if (typeof pilot.clearingMayCycle === 'function' && !pilot.clearingMayCycle(p)) return [];
    return pilot.serial(async () => {
      const g = eligibleGraph(await pilot.clearingSnapshot()), pg = presentGraph(g);
      if (!pg.nodes.has(p.pubkey)) return [];
      const runId = Clearing.runId(), {cycles, expansions, truncated} = boundedCycles(pg, {through: p.pubkey, maxLen: this.limits.max_cycle_length,
        maxExpansions: this.limits.max_expansions, maxCycles: this.limits.max_cycles});
      this.noteRun({id: runId, at: iso(this.now()), reason: 'presence', eligible_edges: g.eligible_edges, excluded: g.excluded, cycles_found: cycles.length, expansions, truncated});
      return cycles.length ? this.propose(this.plan(pg, cycles), {source: 'presence', runId}) : [];
    }).catch(e => { this.log(`clearing: proposing for ${p.id}: ${e?.message ?? e}`); return []; });
  }

  // The batch search: a full bounded search over the eligible graph, in this run's node order. One at a time.
  // `reason`: startup, interval or admin. Returns the run record (kept in s.clearing.runs, the last 20).
  run(reason = 'interval') {
    if (this.running) return this.running;
    this.running = (async () => {
      const pilot = this.pilot;
      if (!pilot.circulating) return null;
      const runId = Clearing.runId(), at = this.now();
      await pilot.serial(() => pilot.setoffHousekeeping());
      const g = eligibleGraph(await pilot.clearingSnapshot()), pg = presentGraph(g);
      const found = boundedCycles(pg, {order: runOrder(runId, [...pg.nodes.keys()]), maxLen: this.limits.max_cycle_length,
        maxExpansions: this.limits.max_expansions, maxCycles: this.limits.max_cycles});
      const made = [];
      for (const pkg of this.plan(pg, found.cycles)) {
        made.push(await pilot.serial(() => pilot.createSetoff(pkg, {source: reason === 'admin' ? 'admin' : 'batch', runId, limits: this.limits})));
      }
      const created = made.filter(x => x && typeof x.id === 'string');
      const rec = {id: runId, at: iso(at), reason, eligible_edges: g.eligible_edges, excluded: g.excluded, cycles_found: found.cycles.length,
        expansions: found.expansions, truncated: found.truncated, proposed: created.length, applied_now: created.filter(o => o.state === 'applied').length,
        skipped: made.filter(x => x?.skipped).map(x => x.skipped), setoffs: created.map(o => o.id)};
      await pilot.serial(() => pilot.recordClearingRun(rec));
      this.lastBatchAt = at;
      return this.noteRun(rec);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  // Housekeeping, complete proposals that had to wait, and the batch when it is due (or for `reason` startup/admin).
  tick({reason = 'interval'} = {}) {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const pilot = this.pilot;
      if (!pilot.circulating) return null;
      await pilot.serial(() => pilot.setoffHousekeeping());
      await pilot.serial(() => pilot.applyReadySetoffs());
      const due = this.lastBatchAt === null || this.now() - this.lastBatchAt >= this.intervalMs;
      return reason !== 'interval' || due ? this.run(reason) : null;
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  start() {
    if (this.started) return this;
    this.started = true;
    this.later(() => this.tick({reason: 'startup'}), 0);
    this.interval = setInterval(() => this.tick().catch(e => this.log(`clearing: tick failed: ${e?.message ?? e}`)), Math.min(TICK_MS, this.intervalMs));
    this.interval.unref?.();
    return this;
  }
  stop() {
    this.started = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
