// The clearing engine (lib/pilot/clearing.mjs; design §5.7, §9.1; spec 18.7, 18.14) on seeded graphs, with no tracker:
// the eligible graph, the bounded cycle search (checked against a brute-force enumeration), the widest cycle through an
// edge, the ranking, greedy selection and packaging (every proposal balanced, packages edge-disjoint, decreases never
// above what is available), the MTCS measure (checked against a brute-force maximum circulation on graphs of at most 6
// nodes with capacities up to 3), the caps, cooldowns and presence filter, determinism for a run id, the tracker body and
// the outcome rule, the Clearing triggers on a stub pilot, and the public metrics (documented keys, no identities).
// Run: node --test test/clearing-engine.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {eligibleGraph, cycleThrough, boundedCycles, selectCycles, packageCycles, planProposals, mtcs, metrics, runOrder, compareCycles, cycleScore,
  balanced, edgeSetId, setoffOutcome, trackerSetoffBody, clearableWithinLimits, presentGraph, Clearing, LIMITS, EXCLUSION_REASONS, PRESENCE_POLL_MS} from '../lib/pilot/clearing.mjs';

const T0 = Date.parse('2026-11-08T12:00:00.000Z');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const key = i => '02' + sha(`node ${i}`);                    // a node's (fake) public key
const sig = s => '02' + sha(`sig ${s}`) + sha(`sig2 ${s}`);    // a well-formed (fake) signature
// A small deterministic PRNG (mulberry32), so every seeded graph is the same on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// A snapshot (as Pilot.clearingSnapshot gives it) of n participants (all members, present, run by clients unless
// `server` says otherwise) and edges [[i, j, outstanding, extra]].
function snapshotOf(n, edges, {mode = 'on', server = [], absent = [], notMember = [], sandbox = null} = {}) {
  const participants = {};
  for (let i = 0; i < n; i++) participants[`vp_${String(i).padStart(12, '0')}`] = {id: `vp_${String(i).padStart(12, '0')}`, pubkey: key(i), member: !notMember.includes(i),
    sandbox: sandbox ? sandbox.includes(i) : false, server_run: server.includes(i), present: !absent.includes(i), dormant: false};
  return {mode, now: T0, participants, edges: edges.map(([i, j, o, x = {}], k) => ({edge: `${key(i)}>${key(j)}`, issuer_pubkey: key(i), recipient_pubkey: key(j),
    issuer: `vp_${String(i).padStart(12, '0')}`, recipient: `vp_${String(j).padStart(12, '0')}`, total: o, outstanding: o, timestamp: T0 - 1000 * (k + 1), signature: sig(`${i}>${j}`),
    reconciled: true, reserved: 0, exclusive: false, busy: false, ...x}))};
}
// A random graph: n nodes, each ordered pair an edge with probability p, outstanding 1..maxAmount.
function randomEdges(r, n, p, maxAmount) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r() < p) out.push([i, j, int(r, 1, maxAmount)]);
  return out;
}
// Every simple cycle of 2..maxLen edges, by brute force (each as its edge keys from its lowest-ranked node).
function bruteCycles(graph, maxLen, rankOf) {
  const nodes = [...graph.nodes.keys()], has = (u, v) => graph.edges.has(`${u}>${v}`), out = new Set();
  const walk = path => {
    const k = path.length;
    if (k >= 2 && has(path[k - 1], path[0])) {
      const start = path.reduce((m, v, i) => (rankOf(v) < rankOf(path[m]) ? i : m), 0), rot = [...path.slice(start), ...path.slice(0, start)];
      out.add(rot.map((v, i) => `${v}>${rot[(i + 1) % rot.length]}`).join(' '));
    }
    if (k === maxLen) return;
    for (const v of nodes) if (!path.includes(v) && has(path[k - 1], v)) walk([...path, v]);
  };
  for (const s of nodes) walk([s]);
  return out;
}
// The largest sum of x_e over integer circulations 0 <= x_e <= capacity_e (every node: in = out), by enumeration.
function bruteMaxCirculation(edges) {
  const bal = new Map(), last = new Map();
  edges.forEach((e, i) => { bal.set(e.from, 0); bal.set(e.to, 0); last.set(e.from, i); last.set(e.to, i); });
  const closing = edges.map(() => []);
  for (const [v, i] of last) closing[i].push(v);
  let best = 0;
  const rec = (i, sum) => {
    if (i === edges.length) { best = Math.max(best, sum); return; }
    const e = edges[i];
    for (let x = 0; x <= e.capacity; x++) {
      bal.set(e.from, bal.get(e.from) + x); bal.set(e.to, bal.get(e.to) - x);
      if (closing[i].every(v => bal.get(v) === 0)) rec(i + 1, sum + x);
      bal.set(e.from, bal.get(e.from) - x); bal.set(e.to, bal.get(e.to) + x);
    }
  };
  rec(0, 0);
  return best;
}
// The full pipeline of a batch run (without caps or cooldowns): ordered search, selection, packages.
function pipeline(graph, runId) {
  const found = boundedCycles(graph, {order: runOrder(runId, [...graph.nodes.keys()])});
  const selected = selectCycles(graph, found.cycles);
  return {found, selected, packages: packageCycles(graph, selected)};
}
// Each package: balanced for every key, within the limits, its decreases summing to its amount.
function assertPackages(graph, packages, what) {
  const used = new Map();
  for (const p of packages) {
    assert.ok(balanced(p.edges), `${what}: every package balances for every key`);
    assert.ok(p.edges.length >= 2 && p.edges.length <= LIMITS.max_package_edges && p.members.length <= LIMITS.max_package_parties, `${what}: within 16 edges and 8 parties`);
    assert.equal(p.amount, p.edges.reduce((a, e) => a + e.decrease, 0), `${what}: amount = sum of decreases`);
    assert.equal(p.set_id, edgeSetId(p.edges.map(e => e.edge)));
    for (const e of p.edges) {
      assert.ok(!used.has(e.edge), `${what}: packages are edge-disjoint (${e.edge})`);
      used.set(e.edge, e.decrease);
      assert.ok(Number.isSafeInteger(e.decrease) && e.decrease >= 1, `${what}: positive whole decreases`);
      assert.ok(e.decrease <= graph.edges.get(e.edge).available, `${what}: a decrease never exceeds what the edge has available`);
      assert.deepEqual(e.state, {total: graph.edges.get(e.edge).total, timestamp: graph.edges.get(e.edge).timestamp, signature: graph.edges.get(e.edge).signature});
    }
    const sum = p.cycles.reduce((a, c) => a + c.amount * c.length, 0);
    assert.equal(sum, p.amount, `${what}: a package is the sum of its cycles`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
test('eligibleGraph keeps an edge only when both keys are current, both parties are members, it reconciles exactly, it is neither held nor busy, and at least 1 PC is available; mode sandbox keeps sandbox participants; the reasons are counts only', () => {
  const snap = snapshotOf(7, [[0, 1, 3], [0, 4, 2], [5, 0, 2], [0, 2, 4, {reconciled: false}], [1, 2, 2, {busy: true}], [2, 3, 5, {exclusive: true}],
    [3, 0, 2, {reserved: 2}], [3, 1, 5, {reserved: 2}], [1, 0, 0], [6, 0, 1]], {notMember: [4]});
  snap.participants.vp_000000000005.pubkey = null;            // 5's key was revoked: its edge is under a past key
  delete snap.participants.vp_000000000006;                    // 6 is unknown: its key is nobody's current key
  const g = eligibleGraph(snap);
  assert.deepEqual([...g.edges.keys()].sort(), [`${key(0)}>${key(1)}`, `${key(3)}>${key(1)}`].sort());
  assert.equal(g.edges.get(`${key(3)}>${key(1)}`).available, 3, 'available = outstanding - reserved');
  assert.deepEqual(g.excluded, {not_current_key: 2, not_member: 1, sandbox_only: 0, not_reconciled: 1, busy: 1, reserved: 2}, 'edges with nothing outstanding are not counted');
  assert.deepEqual(Object.keys(g.excluded), [...EXCLUSION_REASONS]);
  assert.equal(g.eligible_edges, 2);
  assert.ok(Object.values(g.excluded).every(Number.isSafeInteger), 'counts only');
  // mode sandbox: only edges between sandbox participants
  const sb = eligibleGraph(snapshotOf(4, [[0, 1, 2], [1, 0, 2], [1, 2, 3], [2, 3, 1]], {mode: 'sandbox', sandbox: [0, 1, 3]}));
  assert.deepEqual([...sb.edges.keys()].sort(), [`${key(0)}>${key(1)}`, `${key(1)}>${key(0)}`].sort());
  assert.equal(sb.excluded.sandbox_only, 2);
  // server-only: both parties run by the server
  const so = eligibleGraph(snapshotOf(3, [[0, 1, 2], [1, 2, 2]], {server: [0, 1]}));
  assert.deepEqual([so.edges.get(`${key(0)}>${key(1)}`).server_only, so.edges.get(`${key(1)}>${key(2)}`).server_only], [true, false]);
  assert.deepEqual([so.nodes.get(key(0)).present, so.nodes.get(key(2)).present], [true, true]);
});

test('boundedCycles finds every simple cycle of 2..maxLen edges exactly once, in canonical rotation, and nothing else; `through` gives exactly the cycles through a node', () => {
  const r = rng(1);
  let total = 0;
  for (let round = 0; round < 60; round++) {
    const n = int(r, 2, 7), g = eligibleGraph(snapshotOf(n, randomEdges(r, n, 0.2 + r() * 0.6, 3)));
    for (const maxLen of [2, 3, 6]) {
      const order = runOrder(`run ${round}`, [...g.nodes.keys()]), rank = new Map(order.map((k, i) => [k, i]));
      const {cycles, truncated} = boundedCycles(g, {order, maxLen});
      assert.equal(truncated, false);
      const got = cycles.map(c => c.edges.join(' '));
      assert.equal(new Set(got).size, got.length, 'each cycle once');
      assert.deepEqual(new Set(got), bruteCycles(g, maxLen, k => rank.get(k)), `round ${round}, maxLen ${maxLen}`);
      for (const c of cycles) {
        assert.ok(c.length >= 2 && c.length <= maxLen && c.edges.length === c.length && c.nodes.length === c.length);
        assert.equal(c.amount, Math.min(...c.edges.map(k => g.edges.get(k).available)));
        assert.equal(c.nodes[0], c.nodes.reduce((m, v) => (rank.get(v) < rank.get(m) ? v : m)), 'canonical rotation: from its first node in the order');
      }
      total += cycles.length;
      const node = order[int(r, 0, order.length - 1)];
      if (!node) continue;
      const through = boundedCycles(g, {order, maxLen, through: node}).cycles;
      assert.ok(through.every(c => c.nodes[0] === node), 'rooted at the node');
      assert.deepEqual(new Set(through.map(c => [...c.edges].sort().join(','))), new Set(cycles.filter(c => c.nodes.includes(node)).map(c => [...c.edges].sort().join(','))));
    }
  }
  assert.ok(total > 300, `the seeded graphs have cycles to find (${total})`);
});

test('boundedCycles stops after maxExpansions steps or maxCycles cycles (truncated)', () => {
  const n = 8, edges = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) edges.push([i, j, 2]);
  const g = eligibleGraph(snapshotOf(n, edges));
  const full = boundedCycles(g, {maxLen: 4});
  assert.equal(full.truncated, false);
  const byCycles = boundedCycles(g, {maxLen: 4, maxCycles: 10});
  assert.deepEqual([byCycles.cycles.length, byCycles.truncated], [10, true]);
  const bySteps = boundedCycles(g, {maxLen: 4, maxExpansions: 50});
  assert.ok(bySteps.truncated && bySteps.expansions === 50 && bySteps.cycles.length < full.cycles.length);
  assert.ok(full.expansions <= LIMITS.max_expansions);
});

test('cycleThrough gives a widest cycle through the edge (brute force over every simple cycle through it), the shortest among the widest', () => {
  const r = rng(2);
  let checked = 0;
  for (let round = 0; round < 80; round++) {
    const n = int(r, 2, 7), g = eligibleGraph(snapshotOf(n, randomEdges(r, n, 0.3 + r() * 0.5, 6)));
    const all = boundedCycles(g, {maxLen: 6}).cycles;
    for (const k of g.edges.keys()) {
      for (const maxLen of [2, 4, 6]) {
        const options = all.filter(c => c.edges.includes(k) && c.length <= maxLen);
        const c = cycleThrough(g, k, {maxLen});
        if (!options.length) { assert.equal(c, null, `no cycle through ${k}`); continue; }
        const width = Math.max(...options.map(x => x.amount)), shortest = Math.min(...options.filter(x => x.amount === width).map(x => x.length));
        assert.ok(c, `a cycle through ${k}`);
        assert.equal(c.edges[0], k, 'starts with the edge');
        assert.deepEqual([c.amount, c.length], [width, shortest], `round ${round}: widest, then shortest`);
        assert.ok(c.length <= maxLen && new Set(c.nodes).size === c.length, 'simple and bounded');
        c.edges.forEach((ek, i) => assert.equal(g.edges.get(ek).to, g.edges.get(c.edges[(i + 1) % c.length]).from, 'consecutive edges'));
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `checked ${checked}`);
  assert.equal(cycleThrough(eligibleGraph(snapshotOf(2, [[0, 1, 1]])), `${key(0)}>${key(1)}`), null);
  assert.equal(cycleThrough(eligibleGraph(snapshotOf(2, [[0, 1, 1]])), 'no>such'), null);
});

test('the ranking: amount x length first, then the shorter cycle, fewer client members, the older smallest timestamp, the edge keys', () => {
  const c = (amount, length, client_members, min_timestamp, set) => ({amount, length, client_members, min_timestamp, set});
  assert.equal(cycleScore(c(3, 2, 0, 0, 'a')), 6);
  const sorted = [c(1, 2, 0, 0, 'z'), c(2, 3, 0, 0, 'y'), c(3, 2, 2, 5, 'b'), c(3, 2, 1, 9, 'c'), c(3, 2, 1, 7, 'd'), c(2, 3, 0, 1, 'x'), c(3, 2, 1, 7, 'a')].sort(compareCycles);
  assert.deepEqual(sorted.map(x => x.set), ['a', 'd', 'c', 'b', 'y', 'x', 'z']);
});

test('greedy selection with residual subtraction, and packaging: every proposal balanced, packages edge-disjoint and within 16 edges and 8 parties, decreases never above what is available (seeded graphs)', () => {
  const r = rng(3);
  let packages = 0, merged = 0;
  for (let round = 0; round < 250; round++) {
    const n = int(r, 2, 12), g = eligibleGraph(snapshotOf(n, randomEdges(r, n, 0.1 + r() * 0.7, int(r, 1, 9))));
    const {selected, packages: pk} = pipeline(g, `run ${round}`);
    const used = new Map();
    for (const c of selected) for (const k of c.edges) used.set(k, (used.get(k) ?? 0) + c.amount);
    for (const [k, v] of used) assert.ok(v <= g.edges.get(k).available, 'the chosen cycles never take more than an edge has');
    assertPackages(g, pk, `round ${round}`);
    packages += pk.length; merged += pk.filter(p => p.cycles.length > 1).length;
    // the plan (caps, presence, cooldowns aside) keeps the same properties
    assertPackages(g, planProposals(g, boundedCycles(g).cycles, {now: T0, limits: {...LIMITS, max_collecting_total: 1000, max_collecting_per_participant: 1000}}), `plan ${round}`);
  }
  assert.ok(packages > 200 && merged > 10, JSON.stringify({packages, merged}));
  // A hand-made case: two cycles share A>B (3 = 2 + 1): one package, A>B lowered by 3.
  const g = eligibleGraph(snapshotOf(3, [[0, 1, 3], [1, 2, 2], [2, 0, 4], [1, 0, 1]]));
  const [p] = pipeline(g, 'x').packages;
  assert.deepEqual(Object.fromEntries(p.edges.map(e => [e.edge, e.decrease])), {[`${key(0)}>${key(1)}`]: 3, [`${key(1)}>${key(2)}`]: 2, [`${key(2)}>${key(0)}`]: 2, [`${key(1)}>${key(0)}`]: 1});
  assert.deepEqual([p.amount, p.cycles.map(c => c.length).sort()], [8, [2, 3]]);
  // A package that would pass 8 parties keeps the cycle out (edge-disjoint all the same).
  const ring = [];
  for (let i = 0; i < 9; i++) ring.push([i, (i + 1) % 9, 1]);
  const big = eligibleGraph(snapshotOf(9, [...ring, [0, 4, 1], [4, 0, 1]]));
  for (const pk2 of packageCycles(big, selectCycles(big, boundedCycles(big, {maxLen: 6}).cycles))) assert.ok(pk2.members.length <= 8);
});

test('deterministic for a run id: the same graph and run id give the same order, cycles, choice and packages; other run ids rotate the order', () => {
  const r = rng(4), g = eligibleGraph(snapshotOf(10, randomEdges(r, 10, 0.5, 5)));
  const a = pipeline(g, 'rn_0001'), b = pipeline(g, 'rn_0001');
  assert.deepEqual(b, a);
  assert.deepEqual(runOrder('rn_0001', [...g.nodes.keys()]), runOrder('rn_0001', [...g.nodes.keys()].reverse()), 'the order does not depend on the input order');
  const firsts = new Set(['rn_0001', 'rn_0002', 'rn_0003', 'rn_0004', 'rn_0005', 'rn_0006'].map(id => runOrder(id, [...g.nodes.keys()])[0]));
  assert.ok(firsts.size >= 3, 'no node always comes first');
  // truncated searches differ by run id, but each is deterministic
  const t1 = boundedCycles(g, {order: runOrder('rn_a', [...g.nodes.keys()]), maxCycles: 5}), t2 = boundedCycles(g, {order: runOrder('rn_a', [...g.nodes.keys()]), maxCycles: 5});
  assert.deepEqual(t1, t2);
  assert.deepEqual(planProposals(g, a.found.cycles, {now: T0}), planProposals(g, a.found.cycles, {now: T0}));
});

test('mtcs equals a brute-force maximum circulation on graphs of at most 6 nodes with capacities up to 3', () => {
  const r = rng(5);
  let checked = 0, nonzero = 0;
  for (let round = 0; round < 220; round++) {
    const n = int(r, 2, 6), list = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && r() < 0.45) list.push({from: key(i), to: key(j), capacity: int(r, 1, 3)});
    if (list.length > 9) list.length = 9;
    const want = bruteMaxCirculation(list), got = mtcs(list);
    assert.equal(got.clearable, want, `round ${round}: ${JSON.stringify(list.map(e => [e.from.slice(-2), e.to.slice(-2), e.capacity]))}`);
    assert.equal(got.gross, list.reduce((a, e) => a + e.capacity, 0));
    assert.ok(got.gross - got.clearable >= got.net_floor, 'what remains is at least the net floor');
    checked++; if (want > 0) nonzero++;
  }
  assert.ok(checked === 220 && nonzero > 60, JSON.stringify({checked, nonzero}));
  // The bounded engine never clears more than the optimum.
  for (let round = 0; round < 60; round++) {
    const n = int(r, 2, 8), g = eligibleGraph(snapshotOf(n, randomEdges(r, n, 0.5, 3)));
    assert.ok(clearableWithinLimits(g).clearable <= mtcs(g.edges).clearable);
  }
});

test('mtcs on hand-made graphs (gross, net floor, clearable) and null above 5000 edges', () => {
  assert.deepEqual(mtcs([]), {gross: 0, net_floor: 0, residual: 0, clearable: 0});
  assert.deepEqual(mtcs([{from: 'a', to: 'b', capacity: 3}, {from: 'b', to: 'a', capacity: 2}]), {gross: 5, net_floor: 1, residual: 1, clearable: 4});
  // a 3-cycle with a chord: everything but the net floor clears
  assert.equal(mtcs([{from: 'a', to: 'b', capacity: 3}, {from: 'b', to: 'c', capacity: 2}, {from: 'c', to: 'a', capacity: 4}, {from: 'b', to: 'a', capacity: 1}]).clearable, 8);
  // a chain clears nothing
  assert.equal(mtcs([{from: 'a', to: 'b', capacity: 3}, {from: 'b', to: 'c', capacity: 3}]).clearable, 0);
  // the min-cost flow reroutes: a long cycle beats the short one through the shared edge only when that clears more
  assert.equal(mtcs([{from: 'a', to: 'b', capacity: 1}, {from: 'b', to: 'a', capacity: 1}, {from: 'b', to: 'c', capacity: 1}, {from: 'c', to: 'a', capacity: 1}]).clearable, 3);
  const many = [];
  for (let i = 0; i < 5001; i++) many.push({from: `n${i}`, to: `n${i + 1}`, capacity: 1});
  assert.equal(mtcs(many), null);
  assert.notEqual(mtcs(many.slice(0, 5000)), null);
});

test('planProposals: cooldowns (an edge set after an expiry or a failure, a member and edge set after its refusal), the presence filter (server-run members always pass), the caps (per client participant and in all) and max', () => {
  // two disjoint 2-cycles (0<->1 and 2<->3) and a 3-cycle 4>5>6>4
  const snap = snapshotOf(7, [[0, 1, 2], [1, 0, 2], [2, 3, 2], [3, 2, 2], [4, 5, 1], [5, 6, 1], [6, 4, 1]], {server: [4, 5, 6]});
  const g = eligibleGraph(snap), cycles = boundedCycles(g).cycles;
  const id = i => `vp_${String(i).padStart(12, '0')}`, setOf = (...ij) => edgeSetId(ij.map(([i, j]) => `${key(i)}>${key(j)}`));
  const names = ps => ps.map(p => p.members.map(m => [...g.nodes.values()].find(x => x.key === m).id).sort().join(',')).sort();
  const all = planProposals(g, cycles, {now: T0});
  assert.deepEqual(names(all), [[id(0), id(1)].join(), [id(2), id(3)].join(), [id(4), id(5), id(6)].join()].sort());
  // cooldowns: by edge set; a refusal by its member; an ended cooldown no longer counts
  const s01 = setOf([0, 1], [1, 0]), s23 = setOf([2, 3], [3, 2]);
  assert.deepEqual(names(planProposals(g, cycles, {now: T0, cooldowns: {[`set:${s01}`]: {until: T0 + 1}}})), [[id(2), id(3)].join(), [id(4), id(5), id(6)].join()].sort());
  assert.deepEqual(names(planProposals(g, cycles, {now: T0, cooldowns: {[`refusal:${id(3)}:${s23}`]: {until: T0 + 1}}})), [[id(0), id(1)].join(), [id(4), id(5), id(6)].join()].sort());
  assert.equal(planProposals(g, cycles, {now: T0, cooldowns: {[`set:${s01}`]: {until: T0}, [`refusal:${id(0)}:${s01}`]: {until: T0 - 1}}}).length, 3, 'ended cooldowns do not count');
  assert.equal(planProposals(g, cycles, {now: T0, cooldowns: {[`refusal:${id(4)}:${s01}`]: {until: T0 + 1}}}).length, 3, 'a refusal holds only for its own member and edge set');
  // presence: an absent client member keeps its cycle out; server-run members are always present
  const away = eligibleGraph(snapshotOf(7, snap.edges.map((e, k) => [[0, 1], [1, 0], [2, 3], [3, 2], [4, 5], [5, 6], [6, 4]][k].concat([e.outstanding])), {server: [4, 5, 6], absent: [1, 4]}));
  assert.deepEqual(names(planProposals(away, boundedCycles(away).cycles, {now: T0})), [[id(2), id(3)].join(), [id(4), id(5), id(6)].join()].sort());
  assert.equal(planProposals(away, boundedCycles(away).cycles, {now: T0, requirePresence: false}).length, 3);
  // caps: 3 collecting per client participant (server-run members are not capped), 50 in all, and max
  assert.deepEqual(names(planProposals(g, cycles, {now: T0, collecting: new Map([[id(0), 3], [id(4), 99]])})), [[id(2), id(3)].join(), [id(4), id(5), id(6)].join()].sort());
  assert.equal(planProposals(g, cycles, {now: T0, collecting: new Map([[id(0), 2]])}).length, 3, 'below the cap');
  assert.equal(planProposals(g, cycles, {now: T0, collectingTotal: 49}).length, 1, 'one more brings it to 50');
  assert.equal(planProposals(g, cycles, {now: T0, collectingTotal: 50}).length, 0);
  assert.equal(planProposals(g, cycles, {now: T0, max: 2}).length, 2);
  assert.equal(planProposals(g, cycles, {now: T0, limits: {...LIMITS, max_cycle_length: 2}}).length, 2, 'longer cycles are left out');
});

test('setoffOutcome decides from the edges\' classes, and trackerSetoffBody sends exactly the tracker\'s fields', () => {
  assert.equal(setoffOutcome(['new', 'new', 'applied_moved']), 'applied');
  assert.equal(setoffOutcome(['prior', 'prior']), 'prior');
  assert.equal(setoffOutcome(['prior', 'changed']), 'not_applied');
  assert.equal(setoffOutcome(['moved_past', 'prior']), 'not_applied');
  assert.equal(setoffOutcome(['new', 'prior']), 'inconsistent');
  assert.equal(setoffOutcome(['unknown', 'prior']), 'unknown');
  assert.equal(setoffOutcome(['new', 'unknown']), 'unknown');
  assert.equal(setoffOutcome([]), 'prior');
  const o = {denomination: 'token:' + 'a'.repeat(64), edges: [
    {edge: 'x', issuer: {pubkey: key(0)}, recipient: {pubkey: key(1)}, decrease: 2, timestamp: 5998, slots: {issuer: {signature: sig(1)}, recipient: {signature: sig(2)}}},
    {edge: 'y', issuer: {pubkey: key(1)}, recipient: {pubkey: key(0)}, decrease: 2, timestamp: 7998, slots: {issuer: {signature: sig(3)}, recipient: {signature: sig(4)}}}]};
  assert.deepEqual(trackerSetoffBody(o), {denomination: o.denomination, timestamp: 7998, edges: [
    {issuer_pubkey: key(0), recipient_pubkey: key(1), decrease: 2, timestamp: 5998, issuer_signature: sig(1), recipient_signature: sig(2)},
    {issuer_pubkey: key(1), recipient_pubkey: key(0), decrease: 2, timestamp: 7998, issuer_signature: sig(3), recipient_signature: sig(4)}]});
  assert.throws(() => trackerSetoffBody(o, {perEdgeTimestamps: false}), /same timestamp/);
  o.edges[1].timestamp = 5998;
  assert.deepEqual(trackerSetoffBody(o, {perEdgeTimestamps: false}).edges.map(e => Object.keys(e)), [['issuer_pubkey', 'recipient_pubkey', 'decrease', 'issuer_signature', 'recipient_signature'],
    ['issuer_pubkey', 'recipient_pubkey', 'decrease', 'issuer_signature', 'recipient_signature']]);
  delete o.edges[0].slots.recipient.signature;
  assert.throws(() => trackerSetoffBody(o), /not signed/);
  assert.equal(balanced([{from: 'a', to: 'b', decrease: 1}, {from: 'b', to: 'a', decrease: 1}]), true);
  assert.equal(balanced([{from: 'a', to: 'b', decrease: 2}, {from: 'b', to: 'a', decrease: 1}]), false);
  assert.equal(balanced([{from: 'a', to: 'a', decrease: 1}]), false);
  assert.equal(balanced([{from: 'a', to: 'b', decrease: 0}, {from: 'b', to: 'a', decrease: 0}]), false);
});

// A stub pilot for the Clearing class: a fixed snapshot, createSetoff recorded (it counts the proposal's client members
// as collecting, as the real one does), serial calls counted.
function stubPilot(snapshot, {clock = {t: T0}} = {}) {
  const created = [], serials = [];
  const ids = pkg => pkg.members.map(m => Object.values(snapshot.participants).find(p => p.pubkey === m));
  const pilot = {
    circulating: true, s: {clearing: {runs: [], cooldowns: {}, refusals: []}}, collecting: new Map(), collectingTotal: 0,
    now: () => clock.t,
    serial(fn) { serials.push(fn); return Promise.resolve().then(fn); },
    async clearingSnapshot() { return snapshot; },
    clearingPlanState() { return {cooldowns: this.s.clearing.cooldowns, collecting: this.collecting, collectingTotal: this.collectingTotal}; },
    clearingParticipantCheck(p) { return Object.values(snapshot.participants).find(x => x.id === p.id)?.member ? null : 'auto_clear'; },
    async createSetoff(pkg, {source, runId, limits}) {
      created.push({pkg, source, runId, limits});
      for (const x of ids(pkg)) if (!x.server_run) this.collecting.set(x.id, (this.collecting.get(x.id) ?? 0) + 1);
      this.collectingTotal += 1;
      return {id: `vs_${String(created.length).padStart(16, '0')}`, state: 'collecting'};
    },
    recordClearingRun(r) { this.s.clearing.runs.push(r); },
    setoffHousekeeping() {}, async applyReadySetoffs() { return []; }, async applyReadySetoff() { return null; },
  };
  return {pilot, created, serials};
}

test('Clearing.afterChange (in the caller\'s lock: it never takes the lock itself) proposes at most 2 cycles through the raised edges, only those whose client members are present or run by the server', async () => {
  // 0>1 closes three cycles: 0>1>0 (2), 0>1>2>0 (2) and the widest, 0>1>3>0 (5), whose member 3 is absent: the widest
  // cycle that can be proposed is found instead (the two through 0>1 share it: one package).
  const snap = snapshotOf(4, [[0, 1, 9], [1, 0, 2], [1, 2, 2], [2, 0, 2], [1, 3, 5], [3, 0, 5]], {absent: [3]});
  const {pilot, created, serials} = stubPilot(snap), c = new Clearing({pilot});
  const made = await c.afterChange([`${key(0)}>${key(1)}`, `${key(1)}>${key(2)}`, `${key(0)}>${key(1)}`]);
  assert.equal(serials.length, 0, 'no serial(): it runs inside the caller\'s lock');
  assert.equal(made.length, 1);
  assert.ok(created.every(x => x.source === 'incremental' && /^rn_[0-9a-f]{16}$/.test(x.runId)));
  const [{pkg}] = created;
  assert.ok(!pkg.members.includes(key(3)), 'the absent member\'s cycle is not proposed');
  assert.ok(balanced(pkg.edges));
  assert.deepEqual(Object.fromEntries(pkg.edges.map(e => [e.edge, e.decrease])), {[`${key(0)}>${key(1)}`]: 4, [`${key(1)}>${key(2)}`]: 2, [`${key(2)}>${key(0)}`]: 2, [`${key(1)}>${key(0)}`]: 2});
  assert.equal(c.lastRun.reason, 'incremental');
  // nothing when circulation is off, and never a throw
  pilot.circulating = false;
  assert.deepEqual(await c.afterChange([`${key(0)}>${key(1)}`]), []);
  pilot.circulating = true;
  pilot.clearingSnapshot = async () => { throw new Error('tracker down'); };
  const logs = [], c2 = new Clearing({pilot, log: m => logs.push(m)});
  assert.deepEqual(await c2.afterChange([`${key(0)}>${key(1)}`]), []);
  assert.match(logs[0], /tracker down/);
  // server-run members always pass the presence filter; at most 2 proposals per change (three disjoint cycles raised)
  const many = snapshotOf(6, [[0, 1, 2], [1, 0, 1], [2, 3, 2], [3, 2, 1], [4, 5, 2], [5, 4, 1]], {server: [0, 1, 2, 3, 4, 5], absent: [0, 1, 2, 3, 4, 5]});
  const s3 = stubPilot(many), c3 = new Clearing({pilot: s3.pilot});
  await c3.afterChange([`${key(0)}>${key(1)}`, `${key(2)}>${key(3)}`, `${key(4)}>${key(5)}`]);
  assert.equal(s3.created.length, 2, 'at most 2 proposals per change');
  assert.ok(s3.created.every(x => x.pkg.edges.length === 2 && x.pkg.amount === 2));
});

test('Clearing.proposeFor takes the lock, runs at most once per 30 s per participant, and proposes only cycles through it; run() records the batch, with the caps holding across runs; stop() clears the timers', async () => {
  const clock = {t: T0};
  // participant 0 is in four 2-cycles with 1, 2, 3, 4 (all clients, present), and 5>6>5 does not involve it
  const snap = snapshotOf(7, [[0, 1, 2], [1, 0, 2], [0, 2, 2], [2, 0, 2], [0, 3, 2], [3, 0, 2], [0, 4, 2], [4, 0, 2], [5, 6, 1], [6, 5, 1]]);
  const {pilot, created, serials} = stubPilot(snap, {clock}), c = new Clearing({pilot, intervalMs: 600000});
  const p0 = {id: 'vp_000000000000', pubkey: key(0)};
  await c.proposeFor(p0);
  assert.equal(serials.length, 1, 'it takes the lock');
  assert.equal(created.length, 3, 'four 2-cycles through 0 (no shared edge: four packages), and 0 may be in 3 collecting proposals at most');
  assert.ok(created.every(x => x.source === 'presence' && x.pkg.members.includes(key(0)) && x.pkg.edges.length === 2));
  assert.equal(pilot.collecting.get(p0.id), 3);
  clock.t += PRESENCE_POLL_MS;
  assert.deepEqual(await c.proposeFor(p0), [], 'capped: nothing more for 0');
  assert.equal(serials.length, 2, 'it searched');
  pilot.collecting.set(p0.id, 1);
  assert.deepEqual(await c.proposeFor(p0), [], 'within 30 s of the last poll: not even searched');
  assert.equal(serials.length, 2);
  clock.t += PRESENCE_POLL_MS;
  const before = created.length;
  await c.proposeFor(p0);
  assert.equal(created.length - before, 2, 'up to the cap of 3 again');
  assert.ok(created.every(x => x.pkg.members.includes(key(0))), 'only cycles through 0');
  // a participant that is not a member gets nothing (and no lock)
  snap.participants.vp_000000000005.member = false;
  clock.t += PRESENCE_POLL_MS;
  const n = serials.length;
  assert.deepEqual(await c.proposeFor({id: 'vp_000000000005', pubkey: key(5)}), []);
  assert.equal(serials.length, n);
  snap.participants.vp_000000000005.member = true;
  // the batch: recorded, deterministic in its order for its run id, within the caps
  const rec = await c.run('admin');
  assert.deepEqual(Object.keys(rec), ['id', 'at', 'reason', 'eligible_edges', 'excluded', 'cycles_found', 'expansions', 'truncated', 'proposed', 'applied_now', 'skipped', 'setoffs']);
  assert.deepEqual([rec.reason, rec.eligible_edges, rec.cycles_found], ['admin', 10, 5]);
  assert.equal(pilot.s.clearing.runs.at(-1), rec);
  assert.ok(created.filter(x => x.source === 'admin').length >= 1, 'the 5<->6 cycle at least');
  assert.ok([...pilot.collecting.entries()].every(([, k]) => k <= 3), JSON.stringify([...pilot.collecting]));
  assert.deepEqual(c.engineInfo().last_run, {at: rec.at, reason: 'admin', eligible_edges: 10, excluded: rec.excluded});
  // tick: the batch only when due
  const runs = pilot.s.clearing.runs.length;
  await c.tick();
  assert.equal(pilot.s.clearing.runs.length, runs, 'not due yet');
  clock.t += 600000;
  await c.tick();
  assert.equal(pilot.s.clearing.runs.length, runs + 1, 'due');
  c.start();
  assert.ok(c.started && c.enabled && c.timers.size >= 1);
  c.stop();
  assert.ok(!c.started && c.timers.size === 0 && !c.enabled);
});

test('metrics: the documented keys, no participant ids, handles or keys, and the figures on a known graph', () => {
  const now = T0;
  // eligible: 0>1 3, 1>2 2, 2>0 4, 1>0 1 (gross 10, optimum 8); not eligible: 3>0 5 (3 is no member), 0>4 2 (4 is dormant)
  const snap = snapshotOf(5, [[0, 1, 3], [1, 2, 2], [2, 0, 4], [1, 0, 1], [3, 0, 5], [0, 4, 2]], {notMember: [3, 4]});
  const g = eligibleGraph(snap);
  const iso = t => new Date(t).toISOString();
  const so = (state, amount, created, extra = {}) => ({state, amount, created_at: iso(created), edges: [], cycles: [], ...extra});
  const setoffs = [
    so('applied', 6, now - 3600e3, {applied_at: iso(now - 3000e3), edges: [{new_total: 0, decrease: 3}, {new_total: 1, decrease: 3}], cycles: [{length: 2}]}),
    so('applied', 3, now - 9 * 864e5, {applied_at: iso(now - 9 * 864e5 + 1000), edges: [{new_total: 0, decrease: 1}, {new_total: 0, decrease: 1}, {new_total: 2, decrease: 1}], cycles: [{length: 3}]}),
    so('expired', 2, now - 864e5), so('refused', 2, now - 864e5), so('superseded', 2, now - 864e5), so('failed', 2, now - 864e5), so('void_key_revoked', 2, now - 864e5),
    so('collecting', 2, now - 1000), so('applying', 2, now - 1000)];
  const transfers = [{state: 'applied', amount: 4}, {state: 'failed', amount: 9}];
  const issued = [{at: now - 864e5, amount: 10}, {at: now - 8 * 864e5, amount: 100}];
  const m = metrics({now, snapshot: snap, graph: g, setoffs, transfers, issued, dormant: ['vp_000000000004'],
    engine: {enabled: true, interval_ms: 600000, limits: LIMITS, last_run: {at: iso(now - 5000), reason: 'interval', eligible_edges: 4, excluded: g.excluded}}});
  assert.deepEqual(Object.keys(m), ['as_of', 'unit', 'tier', 'engine', 'graph_now', 'totals', 'last_7_days', 'proposals', 'cycles_by_length', 'sandbox']);
  assert.deepEqual([m.as_of, m.unit, m.tier], [iso(now), 'PC', 'pure_credit']);
  assert.deepEqual(Object.keys(m.engine), ['enabled', 'interval_ms', 'limits', 'last_run']);
  assert.deepEqual(Object.keys(m.engine.last_run), ['at', 'reason', 'eligible_edges', 'excluded']);
  // owes - claims: 0: 5 - 10; 1: 3 - 3; 2: 4 - 2 = 2; 3: 5; 4: -2 -> net floor 7
  assert.deepEqual(m.graph_now, {participants_with_positions: 5, edges: 6, gross_PC: 17, net_floor_PC: 7, clearable_mtcs_PC: 8, clearable_within_limits_PC: 8, bound_gap: 1});
  assert.deepEqual(m.totals, {setoffs_applied: 2, cleared_PC: 9, edges_closed: 3, transfers_applied: 1, transferred_PC: 4});
  assert.deepEqual(m.last_7_days, {issued_PC: 10, cleared_PC: 6, liquidity_saving_pct: 60, capacity_restored_PC: 6});
  assert.deepEqual(m.proposals, {collecting: 2, applied: 1, stale: 1, expired: 1, refused: 1, failed: 2, completion_rate_pct: 16.7, median_ms_to_apply: 600e3});
  assert.deepEqual(m.cycles_by_length, {2: 1, 3: 1});
  assert.deepEqual(m.sandbox, {dormant_PC: 2});
  const text = JSON.stringify(m);
  for (const p of Object.values(snap.participants)) assert.ok(!text.includes(p.id) && !text.includes(p.pubkey), 'no participant ids or keys');
  assert.ok(!/vp_|vs_|vt_|0[23][0-9a-f]{64}/.test(text), 'no ids or keys of any kind');
  // empty: nulls where a ratio has nothing to divide by
  const e = metrics({now, snapshot: {edges: []}, graph: eligibleGraph({participants: {}, edges: []})});
  assert.deepEqual([e.graph_now.clearable_mtcs_PC, e.graph_now.bound_gap, e.last_7_days.liquidity_saving_pct, e.proposals.completion_rate_pct, e.proposals.median_ms_to_apply, e.engine.enabled],
    [0, null, null, null, null, false]);
});
