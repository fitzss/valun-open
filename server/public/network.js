// Valun live network (public/network.html, served at /network): a public, read-only view of the pilot network for a
// big screen. Same origin only (CSP connect-src 'self'), no tokens, no libraries. It polls three public routes every
// 10 s (GET /pilot/v1/participants, /pilot/v1/ledger, /pilot/v1/clearing), reads /pilot/v1/info and /api/status at
// start and every 5 minutes (on the testnet network also /pilot/v1/chain and /pilot/v1/reserves, for the "On Ergo
// testnet" strip), reads /pilot/v1/loops at start and after a set-off (to link it to its loop card), pauses
// while the tab is hidden and doubles its interval (up to 60 s) after any error or 429:
// every viewer behind one address shares the server's per-address read budget with the agents there.
//
// What changed between two polls is read from the tracker's notes (one per issuer -> recipient pair, cumulative): an
// updated note has a new timestamp, and the timestamp's residue mod 1000 says how it was updated (GET /info novation:
// 999 a debt transfer, whose two edges share the timestamp; 998 a set-off). explain() turns the changes into events:
// debt transfers (an issuer's edge down, another edge of the same issuer up by as much), set-offs (a cycle of edges
// down together), new credit notes (an edge up) and other decreases. The pure parts are exported for the tests
// (test/network-page.test.mjs); the page starts only in a browser.

export const POLL_MS = 10_000, MAX_POLL_MS = 60_000;
const META_MS = 300_000, FRESH_MS = 180_000, FEED_MAX = 60, HL_MS = 8_000, GHOST_MS = 9_000;
export const SANDBOX_AGENTS = Object.freeze(['sandbox-exact', 'sandbox-mallory']);
const RES = {transfer: 999, setoff: 998};
const KIND_WORDS = {agent: 'sandbox agent', sandbox: 'self-serve sandbox', invited: 'invited', operator: 'operator-run', unknown: 'unknown key'};

// ---------- pure parts ----------

export function kindOf(p) {
  if (p.placeholder) return 'unknown';
  if (p.unlisted) return 'test';          // an operator test or demo agent, not running: dimmed, no page
  if (SANDBOX_AGENTS.includes(p.handle)) return 'agent';
  if (p.sandbox_only) return 'sandbox';
  if (p.operator_run) return 'operator';
  return 'invited';
}

// The ledger's notes as edges between participants: one edge per (issuer, recipient) pair of participants (a
// participant whose agent key changed can have several notes per pair), its amount the outstanding PC, with each
// note's amount and timestamp. A note whose key no participant has is shown under the key (key:<pubkey>).
export function edgesOf(notes) {
  const m = new Map();
  for (const n of notes || []) {
    const from = n.issuer ?? `key:${n.issuer_pubkey}`, to = n.recipient ?? `key:${n.recipient_pubkey}`, key = `${from}>${to}`;
    let e = m.get(key);
    if (!e) m.set(key, e = {key, from, to, amount: 0, notes: new Map()});
    const amount = Number(n.outstanding ?? n.total) || 0;
    e.amount += amount;
    e.notes.set(`${n.issuer_pubkey}>${n.recipient_pubkey}`, {amount, ts: Number(n.timestamp) || 0});
  }
  return m;
}

// The edges that changed between two polls: {key, from, to, before, after, d, ts, kind}. ts is the newest timestamp
// among the pair's changed notes and kind its update: 'transfer' (residue 999), 'setoff' (998) or 'note' (any other:
// an issued or bound credit note).
export function diffEdges(prev, cur, residues = RES) {
  const out = [];
  for (const key of new Set([...prev.keys(), ...cur.keys()])) {
    const a = prev.get(key), b = cur.get(key), before = a?.amount ?? 0, after = b?.amount ?? 0;
    let ts = -1;
    if (b) for (const [nk, n] of b.notes) { const o = a?.notes.get(nk); if (!o || o.ts !== n.ts || o.amount !== n.amount) ts = Math.max(ts, n.ts); }
    if (before === after && ts < 0) continue;
    const r = ts >= 0 ? ts % 1000 : -1, e = b ?? a;
    out.push({key, from: e.from, to: e.to, before, after, d: after - before, ts,
      kind: r === residues.transfer ? 'transfer' : r === residues.setoff ? 'setoff' : 'note'});
  }
  return out;
}

// Simple directed cycles (2 to 8 edges) among the given changed edges, shortest first; each found once.
function cyclesAmong(changes) {
  const out = new Map();
  for (const c of changes) { if (!out.has(c.from)) out.set(c.from, []); out.get(c.from).push(c); }
  const cycles = [], seen = new Set();
  for (const start of [...out.keys()].sort()) {
    const path = [];
    const walk = depth => {
      const at = path.length ? path[path.length - 1].to : start;
      for (const c of out.get(at) || []) {
        if (c.to === start) {
          const cyc = [...path, c], sig = cyc.map(x => x.key).sort().join('|');
          if (!seen.has(sig)) { seen.add(sig); cycles.push(cyc); }
          continue;
        }
        if (depth >= 7 || c.to < start || path.some(x => x.from === c.to)) continue;
        path.push(c); walk(depth + 1); path.pop();
      }
    };
    walk(0);
  }
  return cycles.sort((a, b) => a.length - b.length);
}

// The events that explain a poll's changes, in the order they happen (payments with new notes, debt transfers,
// set-offs): {type: 'note', from, to, amount, first} | {type: 'transfer', issuer, from, to, amount} (the issuer's debt
// moved from creditor `from` to creditor `to`) | {type: 'setoff', cycle: [participant ids], each, amount} (each edge of
// the cycle went down by `each`; amount = the sum of the decreases, what the server's GET /clearing cleared_PC counts)
// | {type: 'cleared' | 'reduced', from, to, amount} (a decrease no cycle or transfer explains).
// Each event has `edges`, the keys of the edges it moved.
export function explain(changes) {
  const left = new Map(changes.map(c => [c, c.d])), ev = [];
  const L = c => left.get(c), add = (c, v) => left.set(c, L(c) + v);
  // 1. Debt transfers: both edges carry the transfer's timestamp.
  const groups = new Map();
  for (const c of changes) if (c.kind === 'transfer') { if (!groups.has(c.ts)) groups.set(c.ts, []); groups.get(c.ts).push(c); }
  for (const g of groups.values()) for (const o of g) {
    if (L(o) >= 0) continue;
    const i = g.find(x => x !== o && x.from === o.from && x.to !== o.to && L(x) > 0);
    if (!i) continue;
    const a = Math.min(-L(o), L(i)); add(o, a); add(i, -a);
    ev.push({type: 'transfer', issuer: o.from, from: o.to, to: i.to, amount: a, edges: [o.key, i.key]});
  }
  // 1b. A transfer-stamped decrease whose partner was updated again before this poll (typically by a set-off): its
  // partner is a changed edge of the same issuer, whatever its net change; the transfer's amount moves onto it, so a
  // set-off that then took it down shows as a decrease in step 2.
  for (const o of changes) {
    if (o.kind !== 'transfer' || L(o) >= 0) continue;
    const a = -L(o), cands = changes.filter(x => x !== o && x.from === o.from && x.to !== o.to);
    const i = cands.find(x => L(x) >= a) ?? cands.find(x => x.kind === 'setoff') ?? cands[0];
    if (!i) continue;
    add(o, a); add(i, -a);
    ev.push({type: 'transfer', issuer: o.from, from: o.to, to: i.to, amount: a, edges: [o.key, i.key]});
  }
  // 2. Set-offs: cycles of edges whose last update was a set-off. An edge of the cycle that went up had a new note
  // before the set-off (what is left of it after the set-off's amount is that note).
  for (const cyc of cyclesAmong(changes.filter(c => c.kind === 'setoff'))) {
    const neg = cyc.filter(c => L(c) < 0);
    if (!neg.length) continue;
    const s = Math.min(...neg.map(c => -L(c)));
    for (const c of cyc) add(c, s);
    ev.push({type: 'setoff', cycle: cyc.map(c => c.from), amount: s * cyc.length, each: s, edges: cyc.map(c => c.key)});
  }
  // 3. A decrease whose own edge got a new note after a transfer (so its last update is not the transfer): an issuer's
  // edge down and another of its edges up by as much.
  for (const o of changes) {
    if (L(o) >= 0 || o.kind === 'setoff') continue;
    const i = changes.find(x => x !== o && x.from === o.from && x.to !== o.to && L(x) === -L(o));
    if (!i) continue;
    const a = Math.min(-L(o), L(i)); add(o, a); add(i, -a);
    ev.push({type: 'transfer', issuer: o.from, from: o.to, to: i.to, amount: a, edges: [o.key, i.key]});
  }
  // 4. The rest: new credit notes, and decreases nothing above explains.
  for (const c of changes) {
    const v = L(c);
    if (v > 0) ev.push({type: 'note', from: c.from, to: c.to, amount: v, first: c.before === 0, edges: [c.key]});
    else if (v < 0) ev.push({type: c.kind === 'setoff' ? 'cleared' : 'reduced', from: c.from, to: c.to, amount: -v, edges: [c.key]});
  }
  const order = {note: 0, transfer: 1, reduced: 2, cleared: 2, setoff: 3};
  return ev.map((e, i) => [e, i]).sort((a, b) => order[a[0].type] - order[b[0].type] || a[1] - b[1]).map(x => x[0]);
}

// An amount as people read it, in the network's unit (GET /pilot/v1/info unit): "3 PC" on the pilot; on the testnet
// (nanoERG of Ergo testnet) in tERG, "0.003 tERG" (exact: whole nanoERG to tERG by integer arithmetic).
export function tergText(n) {
  const v = BigInt(Math.trunc(Number(n) || 0)), neg = v < 0n, a = neg ? -v : v;
  const frac = String(a % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / 1000000000n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
export function moneyText(n, unit = 'PC') {
  return unit === 'nanoERG' ? `${tergText(n)} tERG` : `${Number(n || 0).toLocaleString('en-US')} PC`;
}

// The "On Ergo testnet" strip from GET /pilot/v1/chain and GET /pilot/v1/reserves (the testnet network, once on chain):
// plain values for the page to draw, or null. Ids must be 64 hex; a link is kept only when it is the explorer's.
export function chainPanel(chain, reserves) {
  const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const explorer = u => (typeof u === 'string' && /^https:\/\/testnet\.ergoplatform\.com\/[A-Za-z0-9/._-]+$/.test(u) ? u : null);
  const a = chain && typeof chain.anchoring === 'object' ? chain.anchoring : null;
  if (!chain?.on_chain || !a) return null;
  return {
    anchored: a.anchored === true, height: Number.isInteger(a.confirmed_height) ? a.confirmed_height : null,
    pending: hex(a.pending_tx_id),
    links: {nft: explorer(chain.links?.tracker_nft), address: explorer(chain.links?.tracker_address)},
    reserves: (Array.isArray(reserves?.reserves) ? reserves.reserves : []).filter(r => hex(r?.box_id))
      .map(r => ({handle: typeof r.handle === 'string' ? r.handle : null, nanoerg: Number.isInteger(r.collateral_nanoerg) ? r.collateral_nanoerg : 0})),
  };
}

// The server's mode line from GET /pilot/v1/info and GET /api/status.
export function modeLine(info, status) {
  const parts = [];
  if (info) {
    const f = Array.isArray(info.features) ? info.features : [];
    parts.push(f.includes('circulation/1')
      ? (/sandbox participants only/.test(info.description || '') ? 'circulating credit: sandbox only' : 'circulating credit: on')
      : f.includes('bound_notes/1') ? 'circulating credit: bound notes only' : 'circulating credit: off');
  }
  const pin = status?.basis?.pin;
  if (typeof pin === 'string' && pin) {
    const m = /Basis tracker v[\d.]+/.exec(pin);
    parts.push(m ? m[0] : `Basis ${(pin.replace(/^Basis\s+/, '').split(/[\s:(]/)[0] || '').slice(0, 8)}`);
  }
  if (info?.network) parts.push(info.network);
  return parts.join(' · ');
}

// The closed loop (GET /pilot/v1/loops) a set-off event shows: the newest loop not linked yet whose members are the
// event's members (by handle, in any order). null when none matches.
export function matchLoop(handles, loops, linked = new Set()) {
  const want = [...handles].sort().join('\n');
  return (Array.isArray(loops) ? loops : []).find(l => typeof l?.id === 'string' && !linked.has(l.id)
    && [...new Set((l.members || []).map(m => m?.handle))].sort().join('\n') === want) ?? null;
}

// ---------- the page ----------

const SVGNS = 'http://www.w3.org/2000/svg';
const RINGS = [{rx: 0.57, ry: 0.55, cap: 12, phase: 0}, {rx: 0.94, ry: 0.87, cap: 22, phase: 0.5}, {rx: 0.76, ry: 0.72, cap: 16, phase: 0.5}];
const RING_ORDER = {sandbox: [0, 2, 1], other: [1, 2, 0]};

function fillOrder(K) {      // slot indices 0..K-1 in van der Corput order: the first ones spread around the ring
  const out = [], used = new Set();
  for (let i = 0; out.length < K; i++) {
    let f = 0, b = 0.5, n = i;
    while (n) { if (n & 1) f += b; n >>= 1; b /= 2; }
    let s = Math.round(f * K) % K;
    while (used.has(s)) s = (s + 1) % K;
    used.add(s); out.push(s);
  }
  return out;
}

function start() {
  const $ = id => document.getElementById(id);
  const S = (tag, attrs, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    if (parent) parent.appendChild(el);
    return el;
  };
  const H = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const fmt = n => Number(n || 0).toLocaleString('en-US');
  // Amounts in the network's unit (st.unit, from GET /pilot/v1/info): "3 PC" on the pilot, "0.003 tERG" on the testnet.
  const money = n => moneyText(n, st.unit), num = n => (st.unit === 'nanoERG' ? tergText(n) : fmt(n));
  const clock = t => new Date(t).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit'});

  const st = {
    participants: new Map(), edges: new Map(), slots: new Map(), ringUsed: RINGS.map(() => new Set()), orders: RINGS.map(r => fillOrder(r.cap)),
    ready: false, fresh: new Map(), residues: {...RES},
    clearing: null, clearingBase: null, clearingOk: true, detected: {setoffs: 0, setoffPC: 0, transfers: 0, transferPC: 0},
    pendingCatchUp: null, recon: {streak: new Map(), warned: new Set(), bad: 0, rows: 0},
    loops: {pending: [], linked: new Set(), timer: null, tries: 0},
    interval: POLL_MS, timer: null, inflight: false, lastOk: 0, lastMeta: 0, lastError: null, nextAt: 0, unit: 'PC',
  };
  const view = {W: 1250, H: 800, nodes: new Map(), edges: new Map(), hl: new Map(), ghost: new Map(), flashNode: new Map()};
  const svg = $('graph'), gRings = $('g-rings'), gEdges = $('g-edges'), gLabels = $('g-labels'), gNodes = $('g-nodes'), gFx = $('g-fx');

  // ----- data -----
  async function getJson(path) {
    const r = await fetch(path, {cache: 'no-store', credentials: 'omit', headers: {accept: 'application/json'}});
    if (!r.ok) { const e = new Error(`${path}: HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  async function refreshMeta() {
    st.lastMeta = Date.now();
    const [info, status] = await Promise.all([getJson('/pilot/v1/info').catch(() => null), getJson('/api/status').catch(() => null)]);
    if (info?.novation) {
      if (Number.isInteger(info.novation.transfer_ms)) st.residues.transfer = info.novation.transfer_ms;
      if (Number.isInteger(info.novation.setoff_ms)) st.residues.setoff = info.novation.setoff_ms;
    }
    if (info && Array.isArray(info.features) && info.features.includes('circulation/1')) st.clearingOk = true;
    const line = modeLine(info, status);
    if (line) $('meta').textContent = line;
    if (info && typeof info.unit === 'string' && info.unit !== st.unit) { st.unit = info.unit; unitLabels(); }
    if (info?.network === 'valun-testnet-1' && info.tracker_on_chain) await refreshChain();
  }

  // The testnet network (the one network since 2026-11-13): its unit in the labels, and how to join it.
  function unitLabels() {
    if (st.unit !== 'nanoERG') return;
    for (const u of document.querySelectorAll('.stats .u')) u.textContent = 'tERG';
    $('graph').setAttribute('aria-label', 'Agents as points; an arrow from A to B means A owes B, in tERG (Ergo testnet coins)');
    const li = document.querySelector('.legend .explain li');
    if (li) li.replaceChildren(H('b', null, 'tERG'), ' are Ergo testnet coins with no money value: a note can be redeemed on '
      + 'Ergo testnet against its issuer\'s reserve.');
    const code = document.querySelector('.legend .join code');
    if (code) code.textContent = 'uvx valun join --sandbox';
  }

  // The "On Ergo testnet" strip: the anchoring and the reserves (GET /chain, GET /reserves), every 5 minutes with /info.
  async function refreshChain() {
    const [chain, res] = await Promise.all([getJson('/pilot/v1/chain').catch(() => null), getJson('/pilot/v1/reserves').catch(() => null)]);
    const c = chainPanel(chain, res), el = $('chain');
    if (!el || !c) return;
    const total = c.reserves.reduce((s, r) => s + r.nanoerg, 0);
    el.replaceChildren(H('span', 'k', 'On Ergo testnet'),
      H('span', c.anchored ? 'v ok' : 'v wait', c.anchored ? `anchored at height ${fmt(c.height)}` : c.pending ? 'anchoring now' : 'not anchored yet'),
      H('span', 'v', `${c.reserves.length} reserve${c.reserves.length === 1 ? '' : 's'} backing notes: ${moneyText(total, 'nanoERG')}`),
      ...c.reserves.map(r => H('span', 'r', `${r.handle || 'an agent'} ${moneyText(r.nanoerg, 'nanoERG')}`)));
    for (const [href, text] of [[c.links.nft, 'tracker NFT'], [c.links.address, 'tracker on the explorer']]) {
      if (!href) continue;
      const a = H('a', 'x', text); a.href = href; a.rel = 'noopener noreferrer'; el.append(a);
    }
    el.hidden = false;
  }

  async function poll() {
    if (st.inflight) return;
    st.inflight = true; clearTimeout(st.timer);
    try {
      const [ps, ledger, clearing] = await Promise.all([
        getJson('/pilot/v1/participants?all=1'), getJson('/pilot/v1/ledger'),
        st.clearingOk ? getJson('/pilot/v1/clearing').catch(e => { if (e.status === 404) { st.clearingOk = false; return null; } throw e; }) : null]);
      apply(Array.isArray(ps) ? ps : [], ledger && typeof ledger === 'object' ? ledger : {}, clearing);
      st.lastOk = Date.now(); st.interval = POLL_MS; st.lastError = null;
    } catch (e) {
      st.interval = Math.min(MAX_POLL_MS, st.interval * 2);
      st.lastError = e.status === 429 ? 'the server asks us to slow down' : 'cannot reach the server';
    } finally { st.inflight = false; }
    if (Date.now() - st.lastMeta >= META_MS) refreshMeta();
    schedule(); tick();
  }
  function schedule() {
    clearTimeout(st.timer);
    if (document.hidden) return;
    st.nextAt = Date.now() + st.interval;
    st.timer = setTimeout(poll, st.interval);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(st.timer); tick(); return; }
    if (Date.now() - st.lastOk >= st.interval) poll(); else schedule();
  });

  // ----- applying a poll -----
  function slotFor(id, kind, handle) {
    if (st.slots.has(id)) return;
    if (kind === 'agent') { st.slots.set(id, {center: handle === 'sandbox-mallory' ? 1 : -1}); return; }
    for (const ri of RING_ORDER[kind === 'sandbox' ? 'sandbox' : 'other']) {
      const s = st.orders[ri].find(x => !st.ringUsed[ri].has(x));
      if (s !== undefined) { st.ringUsed[ri].add(s); st.slots.set(id, {ring: ri, slot: s}); return; }
    }
    const n = st.slots.size;                 // every ring full: share the outer ring's slots
    st.slots.set(id, {ring: 1, slot: n % RINGS[1].cap, extra: 1 + Math.floor(n / RINGS[1].cap)});
  }

  // At the first poll: the outer ring's participants in an order that puts those that trade with each other side by
  // side (each next one a neighbour of the last placed, else of the most placed, else the best connected), spread
  // evenly. Later arrivals take free slots (slotFor); nobody moves once placed.
  function initialSlots(next, edges) {
    const ring = 1, cap = RINGS[ring].cap;
    const ids = [...next.values()].filter(p => p.kind !== 'agent' && p.kind !== 'sandbox').map(p => p.id);
    if (!ids.length || ids.length > cap) return;
    const set = new Set(ids), nb = new Map(ids.map(id => [id, new Set()]));
    for (const e of edges.values()) if (set.has(e.from) && set.has(e.to) && e.from !== e.to) { nb.get(e.from).add(e.to); nb.get(e.to).add(e.from); }
    const order = [], left = new Set(ids);
    while (left.size) {
      let best = null, score = -1;
      const lastId = order[order.length - 1];
      for (const id of left) {
        const s = (lastId && nb.get(lastId).has(id) ? 1000 : 0) + order.filter(o => nb.get(o).has(id)).length * 10 + nb.get(id).size;
        if (s > score) { score = s; best = id; }
      }
      order.push(best); left.delete(best);
    }
    order.forEach((id, i) => { const s = Math.round(i * cap / order.length) % cap; st.ringUsed[ring].add(s); st.slots.set(id, {ring, slot: s}); });
  }

  function apply(ps, ledger, clearing) {
    const now = Date.now(), events = [];
    const next = new Map();
    for (const p of [...ps].sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)))) {
      if (!p || typeof p.id !== 'string') continue;
      const kind = kindOf(p), dormant = !!p.sandbox_only && Date.parse(p.sandbox_expires_at) < now;
      next.set(p.id, {...p, kind, inactive: p.status !== 'active' || dormant});
      if (st.ready && !st.participants.has(p.id)) {
        st.fresh.set(p.id, now + FRESH_MS);
        events.push({type: 'join', id: p.id});
      } else if (!st.ready && now - Date.parse(p.joined_at) < FRESH_MS) st.fresh.set(p.id, Date.parse(p.joined_at) + FRESH_MS);
    }
    const edges = edgesOf(ledger.notes);
    for (const e of edges.values()) for (const id of [e.from, e.to]) if (!next.has(id))
      next.set(id, {id, handle: `key ${id.slice(4, 12)}…`, placeholder: true, kind: 'unknown', inactive: false, joined_at: ''});
    if (!st.ready) initialSlots(next, edges);
    for (const [id, p] of next) slotFor(id, p.kind, p.handle);
    const prevEdges = st.edges;
    st.participants = next; st.edges = edges;

    if (st.ready) {
      for (const e of explain(diffEdges(prevEdges, edges, st.residues))) events.push(e);
      for (const e of events) if (e.type === 'transfer') { st.detected.transfers++; st.detected.transferPC += e.amount; }
        else if (e.type === 'setoff') { st.detected.setoffs++; st.detected.setoffPC += e.amount; }
    }
    if (clearing?.totals) {
      st.clearing = clearing;
      if (!st.clearingBase) st.clearingBase = {...clearing.totals};
      else catchUp(clearing.totals, events);
    }
    reconcile(ledger.reconciliation, events);

    if (!st.ready) {
      st.ready = true;
      const recent = [...next.values()].filter(p => !p.placeholder && now - Date.parse(p.joined_at) < 12 * 3600e3).slice(-6);
      for (const p of recent) addFeed({type: 'join', id: p.id}, Date.parse(p.joined_at), true);
      const out = [...edges.values()].reduce((a, e) => a + e.amount, 0), live = [...edges.values()].filter(e => e.amount > 0).length;
      addFeed({type: 'info', text: `Watching the network: ${next.size} agents, ${live} credit notes, ${money(out)} outstanding.`}, now, true);
      $('since').textContent = `since ${clock(now).slice(0, 5)}`;
      recentLoops();
    }
    for (const e of events) {
      const li = addFeed(e, now);
      highlight(e, now, prevEdges);
      if (e.type === 'setoff') st.loops.pending.push({li, handles: new Set(e.cycle.map(id => who(id).handle)), at: now});
    }
    if (st.loops.pending.length) linkLoopsSoon(1500);
    render(now);
  }

  // ----- loop cards -----
  // Each set-off event in the feed gets a link to its loop card (/loop/<id>) once GET /pilot/v1/loops lists it: read
  // shortly after the event, and once more 8 s later for any still unmatched. At start the three newest loops are
  // shown in the feed, muted.
  function linkLoopsSoon(ms) {
    if (st.loops.timer) return;
    st.loops.timer = setTimeout(async () => {
      st.loops.timer = null;
      const list = await getJson('/pilot/v1/loops').then(r => r?.loops, () => null);
      if (!Array.isArray(list)) return;
      st.loops.pending = st.loops.pending.filter(x => {
        const l = matchLoop(x.handles, list, st.loops.linked);
        if (l) { st.loops.linked.add(l.id); cardLink(x.li, l.id); }
        return !l && Date.now() - x.at < 20_000;
      });
      if (st.loops.pending.length) linkLoopsSoon(8000);
    }, ms);
  }
  function cardLink(li, id) {
    if (!li || !/^vs_[0-9a-f]{16}$/.test(id)) return;
    const a = H('a', 'card-link', 'loop card →');
    a.href = `/loop/${id}`;
    li.querySelector('.ev-top')?.append(a);
  }
  async function recentLoops() {
    const list = await getJson('/pilot/v1/loops').then(r => r?.loops, () => null);
    if (!Array.isArray(list)) return;
    for (const l of list.slice(0, 3).reverse()) {
      if (typeof l?.id !== 'string' || st.loops.linked.has(l.id)) continue;
      st.loops.linked.add(l.id);
      const names = (l.members || []).map(m => m?.handle ?? '?');
      const li = addFeed({type: 'loop', amount: l.amount_PC, text: `Loop closed: ${[...names, names[0]].join(' → ')}`}, Date.parse(l.applied_at) || Date.now(), true);
      cardLink(li, l.id);
    }
  }

  // A debt transfer or set-off the server counted (GET /clearing totals) that the ledger's changes did not show (for
  // example one whose edges were updated again before the next poll). The aggregates are cached for up to 10 s, so a
  // difference is reported only once it has lasted two polls.
  function catchUp(totals, events) {
    const seenT = st.detected.transfers, seenS = st.detected.setoffs;
    const srvT = (totals.transfers_applied ?? 0) - (st.clearingBase.transfers_applied ?? 0), srvS = (totals.setoffs_applied ?? 0) - (st.clearingBase.setoffs_applied ?? 0);
    const gap = {t: srvT - seenT, s: srvS - seenS};
    const prev = st.pendingCatchUp;
    st.pendingCatchUp = gap.t > 0 || gap.s > 0 ? gap : null;
    if (!prev) return;
    if (gap.t > 0 && prev.t > 0) {
      const n = Math.min(gap.t, prev.t), pc = Math.max(0, (totals.transferred_PC - st.clearingBase.transferred_PC) - st.detected.transferPC);
      events.push({type: 'info', text: `${n} more debt transfer${n > 1 ? 's' : ''} applied${pc ? ` (${money(pc)})` : ''}.`, cls: 'transfer'});
      st.detected.transfers += n; st.detected.transferPC += pc;
    }
    if (gap.s > 0 && prev.s > 0) {
      const n = Math.min(gap.s, prev.s), pc = Math.max(0, (totals.cleared_PC - st.clearingBase.cleared_PC) - st.detected.setoffPC);
      events.push({type: 'info', text: `${n} more set-off${n > 1 ? 's' : ''} applied${pc ? ` (${money(pc)} cleared)` : ''}.`, cls: 'setoff'});
      st.detected.setoffs += n; st.detected.setoffPC += pc;
    }
    if (!(gap.t > 0 && prev.t > 0) && !(gap.s > 0 && prev.s > 0)) return;
    st.pendingCatchUp = null;
  }

  // Reconciliation rows that are not `match`: shown once each, after they appear in two polls in a row (a row can
  // differ for a moment while a novation is being recorded).
  function reconcile(rows, events) {
    const bad = new Map();
    for (const r of Array.isArray(rows) ? rows : []) if (r && r.status !== 'match') {
      const k = `${r.issuer ?? r.pair}>${r.recipient ?? ''}|${r.status}|${r.tracker_total}|${r.issued_via_valun}`;
      bad.set(k, r);
    }
    const streak = new Map();
    for (const [k, r] of bad) {
      const n = (st.recon.streak.get(k) ?? 0) + 1;
      streak.set(k, n);
      if (n >= 2 && !st.recon.warned.has(k)) { st.recon.warned.add(k); events.push({type: 'warning', row: r}); }
    }
    st.recon.streak = streak;
    st.recon.rows = Array.isArray(rows) ? rows.length : 0;
    st.recon.bad = [...streak.values()].filter(n => n >= 2).length;
  }

  // ----- feed -----
  const who = id => st.participants.get(id) ?? {handle: String(id).slice(0, 14), kind: 'unknown'};
  // An agent's name links to its public page (/agent/<handle>); a placeholder or unknown participant stays plain text.
  const name = id => {
    const p = who(id);
    if (p.placeholder || p.kind === 'unknown' || p.kind === 'test' || !/^[a-z][a-z0-9_-]{2,23}$/.test(String(p.handle))) return H('b', `h k-${p.kind}`, p.handle);
    const a = H('a', `h k-${p.kind}`, p.handle);
    a.href = `/agent/${p.handle}`;
    return a;
  };
  function addFeed(e, at, muted = false) {
    const li = H('li', `ev ev-${e.cls ?? e.type}${muted ? ' muted' : ''}`);
    const top = H('div', 'ev-top');
    top.append(H('span', 'tag', {join: 'joined', note: 'payment', transfer: 'debt transfer', setoff: 'set-off', cleared: 'set-off',
      reduced: 'debt reduced', warning: 'ledger check', loop: 'loop closed', info: muted ? 'watching' : 'network'}[e.type]), H('time', '', clock(at)));
    if (e.amount) top.append(H('span', 'amt', `${e.type === 'note' ? '+' : ''}${money(e.amount)}`));
    const txt = H('div', 'ev-txt');
    const put = (...xs) => { for (const x of xs) txt.append(typeof x === 'string' ? document.createTextNode(x) : x); };
    switch (e.type) {
      case 'join': put(name(e.id), ` joined · ${KIND_WORDS[who(e.id).kind]}`); break;
      case 'note': put(name(e.from), ' paid ', name(e.to), e.first ? ' with its first credit note' : ' with a new credit note'); break;
      case 'transfer': put(name(e.issuer), '’s debt moved from ', name(e.from), ' to ', name(e.to), ` (${who(e.from).handle} paid with a note it held)`); break;
      case 'setoff': put('A cycle of debts cancelled: ', ...e.cycle.flatMap(id => [name(id), ' → ']), name(e.cycle[0]), ` (${money(e.each)} off each debt)`); break;
      case 'cleared': put(name(e.from), '’s debt to ', name(e.to), ' cleared by a set-off'); break;
      case 'reduced': put(name(e.from), '’s debt to ', name(e.to), ' went down'); break;
      case 'warning': put('Tracker and Valun differ on ', e.row.pair ? e.row.pair.slice(0, 20) : `${e.row.issuer} → ${e.row.recipient}`,
        `: tracker ${money(e.row.tracker_total)}, Valun ${money(e.row.issued_via_valun)} (${e.row.status}).`); break;
      default: put(e.text || '');
    }
    li.append(top, txt);
    const list = $('feed');
    list.prepend(li);
    while (list.children.length > FEED_MAX) list.lastElementChild.remove();
    return li;
  }

  // ----- highlights -----
  function hl(key, cls, now) { view.hl.set(key, {cls, until: now + HL_MS}); }
  function flash(id, cls, now) { view.flashNode.set(id, {cls, until: now + HL_MS}); }
  function highlight(e, now, prevEdges) {
    const ghost = (k, word) => { if (!(st.edges.get(k)?.amount > 0)) view.ghost.set(k, {until: now + GHOST_MS, word, from: (st.edges.get(k) ?? prevEdges.get(k))}); };
    if (e.type === 'note') { hl(e.edges[0], 'note', now); delta(e.edges[0], `+${money(e.amount)}`, 'note'); flash(e.from, 'note', now); flash(e.to, 'note', now); }
    if (e.type === 'transfer') {
      for (const k of e.edges) hl(k, 'transfer', now);
      ghost(e.edges[0], 'moved');
      delta(e.edges[0], `−${e.amount}`, 'transfer'); delta(e.edges[1], `+${e.amount}`, 'transfer');
      for (const id of [e.issuer, e.from, e.to]) flash(id, 'transfer', now);
      token(e.from, e.to, money(e.amount));
    }
    if (e.type === 'setoff' || e.type === 'cleared') {
      for (const k of e.edges) { hl(k, 'setoff', now); ghost(k, 'cleared'); delta(k, `−${e.each ?? e.amount}`, 'setoff'); }
      for (const id of e.cycle ?? [e.from, e.to]) flash(id, 'setoff', now);
    }
    if (e.type === 'reduced') { hl(e.edges[0], 'transfer', now); ghost(e.edges[0], 'reduced'); }
    if (e.type === 'join') flash(e.id, 'join', now);
    // the big-screen line at the bottom of the graph
    if (e.type === 'join') toast('join', 'joined', [name(e.id), ` · ${KIND_WORDS[who(e.id).kind]}`]);
    if (e.type === 'note') toast('note', 'payment', [name(e.from), ' paid ', name(e.to), ` ${money(e.amount)} with a credit note`]);
    if (e.type === 'transfer') toast('transfer', 'debt transfer', [name(e.issuer), '’s debt moved ', name(e.from), ' → ', name(e.to), ` · ${money(e.amount)}`]);
    if (e.type === 'setoff') toast('setoff', 'set-off', ['cycle cleared ', ...e.cycle.flatMap(id => [name(id), ' → ']), name(e.cycle[0]), ` · ${money(e.amount)}`]);
  }
  // At most two lines, newest on top; each stays 8 s.
  function toast(cls, tag, parts) {
    const box = $('toasts'), el = H('div', `toast t-${cls}`);
    el.append(H('span', 'tag', tag));
    for (const x of parts) el.append(typeof x === 'string' ? document.createTextNode(x) : x);
    box.prepend(el);
    while (box.children.length > 2) box.lastElementChild.remove();
    setTimeout(() => el.remove(), 8000);
  }

  // ----- layout -----
  function posOf(id) {
    const s = st.slots.get(id), cx = view.W / 2, cy = view.H / 2;
    if (!s) return {x: cx, y: cy};
    if (s.center !== undefined) return {x: cx + s.center * Math.min(view.W * 0.1, 150), y: cy};
    const r = RINGS[s.ring], a = -Math.PI / 2 + 2 * Math.PI * (s.slot + r.phase + (s.extra ? 0.5 * s.extra / (s.extra + 1) : 0)) / r.cap;
    const grow = s.extra ? 1 + 0.04 * s.extra : 1;
    return {x: cx + Math.cos(a) * r.rx * grow * (view.W / 2 - 60), y: cy + Math.sin(a) * r.ry * grow * (view.H / 2 - 50)};
  }
  function radiusOf(id) {
    const p = st.participants.get(id);
    if (p?.kind === 'agent') return 30;
    let g = 0;
    for (const e of st.edges.values()) if (e.from === id || e.to === id) g += e.amount;
    return 14 + Math.min(9, Math.sqrt(g) * 1.4);
  }
  function edgeGeom(e) {
    const a = posOf(e.from), b = posOf(e.to), dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const k = 0.16, c = {x: (a.x + b.x) / 2 - dy * k, y: (a.y + b.y) / 2 + dx * k};
    const trim = (p, q, r) => { const ux = q.x - p.x, uy = q.y - p.y, l = Math.hypot(ux, uy) || 1; return {x: p.x + ux / l * r, y: p.y + uy / l * r}; };
    const p0 = trim(a, c, radiusOf(e.from) + 3), p2 = trim(b, c, radiusOf(e.to) + 5);
    const at = t => ({x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y});
    return {d: `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`, mid: at(0.5), at, len};
  }
  // Where an edge's amount label goes: the first point along the curve (from the middle outwards) clear of every node,
  // node label and amount label already placed; else the point with the fewest overlaps.
  function labelSpot(g, placed, boxes) {
    const hits = p => boxes.filter(b => Math.abs(p.x - b.x) < b.hw && Math.abs(p.y - b.y) < b.hh).length
      + placed.filter(q => Math.abs(p.x - q.x) < 62 && Math.abs(p.y - q.y) < 28).length;
    let best = null, fewest = Infinity;
    for (const t of [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73, 0.2, 0.8]) {
      const p = g.at(t), n = hits(p);
      if (n === 0) return p;
      if (n < fewest) { fewest = n; best = p; }
    }
    return best ?? g.mid;
  }
  function nodeBoxes() {
    const out = [];
    for (const [id, p] of st.participants) {
      const {x, y} = posOf(id), r = radiusOf(id), n = Math.min(20, String(p.handle ?? id).length);
      out.push({x, y, hw: r + 34, hh: r + 16}, {x, y: y + r + 16, hw: n * 5.6 + 32, hh: 24});
    }
    return out;
  }
  function resize() {
    const r = svg.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    view.H = 800; view.W = Math.round(Math.max(900, Math.min(2200, 800 * r.width / r.height)));
    svg.setAttribute('viewBox', `0 0 ${view.W} ${view.H}`);
    gRings.replaceChildren();
    for (const ri of [0, 1]) {
      const rr = RINGS[ri];
      S('ellipse', {class: 'ring', cx: view.W / 2, cy: view.H / 2, rx: rr.rx * (view.W / 2 - 60), ry: rr.ry * (view.H / 2 - 50)}, gRings);
    }
    render(Date.now());
  }

  // ----- rendering -----
  function render(now) {
    if (!st.ready) return;
    // nodes
    for (const [id, p] of st.participants) {
      let v = view.nodes.get(id);
      if (!v) {
        const outer = S('g', {}, gNodes), inner = S('g', {class: 'node-in'}, outer);
        v = {outer, inner, halo: S('circle', {class: 'halo', r: 10}, inner), dot: S('circle', {class: 'dot'}, inner),
          label: S('text', {class: 'label', 'text-anchor': 'middle'}, inner), badge: S('text', {class: 'badge', 'text-anchor': 'middle'}, inner)};
        if (view.nodes.size && st.fresh.has(id)) inner.classList.add('entering');
        view.nodes.set(id, v);
      }
      const {x, y} = posOf(id), r = radiusOf(id), fresh = (st.fresh.get(id) ?? 0) > now, fl = view.flashNode.get(id);
      v.outer.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
      v.outer.setAttribute('class', `node k-${p.kind}${p.inactive ? ' inactive' : ''}${fresh ? ' fresh' : ''}${fl && fl.until > now ? ` fl-${fl.cls}` : ''}`);
      v.dot.setAttribute('r', r.toFixed(1)); v.halo.setAttribute('r', (r + 8).toFixed(1));
      v.label.setAttribute('y', (r + 22).toFixed(1));
      const h = String(p.handle ?? id);
      v.label.textContent = h.length > 20 ? `${h.slice(0, 19)}…` : h;
      v.badge.setAttribute('y', (-r - 12).toFixed(1));
      v.badge.textContent = fresh ? 'joined just now' : p.kind === 'agent' ? 'sandbox agent' : '';
    }
    for (const [id, v] of view.nodes) if (!st.participants.has(id)) { v.outer.remove(); view.nodes.delete(id); }

    // edges: every edge with PC outstanding, and for a few seconds those a transfer or set-off just closed
    const shown = new Map();
    for (const e of st.edges.values()) if (e.amount > 0) shown.set(e.key, {e, ghost: null});
    for (const [k, g] of view.ghost) {
      if (g.until <= now) { view.ghost.delete(k); continue; }
      if (!shown.has(k) && g.from) shown.set(k, {e: g.from, ghost: g.word});
    }
    const boxes = nodeBoxes(), placed = [];
    for (const [k, {e, ghost}] of shown) {
      if (!st.participants.has(e.from) || !st.participants.has(e.to)) continue;
      let v = view.edges.get(k);
      if (!v) {
        const path = S('path', {class: 'edge'}, gEdges), lg = S('g', {class: 'elabel'}, gLabels);
        v = {path, lg, rect: S('rect', {rx: 9, ry: 9}, lg), text: S('text', {'text-anchor': 'middle', 'dominant-baseline': 'central'}, lg)};
        view.edges.set(k, v);
      }
      const g = edgeGeom(e), h = view.hl.get(k), cls = h && h.until > now ? h.cls : null;
      const w = ghost ? 2 : Math.min(10, 2 + 1.6 * Math.log2(1 + e.amount));
      v.path.setAttribute('d', g.d);
      v.path.setAttribute('stroke-width', w.toFixed(1));
      v.path.setAttribute('class', `edge${cls ? ` hl-${cls}` : ''}${ghost ? ' ghost' : ''}`);
      v.path.setAttribute('marker-end', `url(#arrow${cls ? `-${cls}` : ghost ? '-ghost' : ''})`);
      const label = ghost ? ghost : money(e.amount), fs = 17, tw = label.length * fs * 0.6 + 16;
      const m = labelSpot(g, placed, boxes);
      placed.push(m); v.mid = m;
      v.text.textContent = label;
      v.text.setAttribute('x', m.x.toFixed(1)); v.text.setAttribute('y', m.y.toFixed(1));
      v.rect.setAttribute('x', (m.x - tw / 2).toFixed(1)); v.rect.setAttribute('y', (m.y - 13).toFixed(1));
      v.rect.setAttribute('width', tw.toFixed(1)); v.rect.setAttribute('height', 26);
      v.lg.setAttribute('class', `elabel${cls ? ` hl-${cls}` : ''}${ghost ? ' ghost' : ''}`);
    }
    for (const [k, v] of view.edges) if (!shown.has(k)) { v.path.remove(); v.lg.remove(); view.edges.delete(k); }
    for (const [k, h] of view.hl) if (h.until <= now) view.hl.delete(k);
    for (const [k, h] of view.flashNode) if (h.until <= now) view.flashNode.delete(k);
    for (const [k, t] of st.fresh) if (t <= now) st.fresh.delete(k);

    $('empty').hidden = st.participants.size > 0;
    stats();
  }

  // ----- effects (temporary, in #g-fx) -----
  function delta(key, text, cls) {
    const e = st.edges.get(key) ?? view.ghost.get(key)?.from;
    if (!e || !st.participants.has(e.from) || !st.participants.has(e.to)) return;
    const mid = view.edges.get(key)?.mid ?? edgeGeom(e).mid, t = S('text',{class: `delta d-${cls}`, x: mid.x.toFixed(1), y: (mid.y - 22).toFixed(1), 'text-anchor': 'middle'}, gFx);
    t.textContent = text;
    setTimeout(() => t.remove(), 3200);
  }
  function token(fromId, toId, text) {
    const a = posOf(fromId), b = posOf(toId), g = S('g', {class: 'token'}, gFx);
    S('circle', {r: 11}, g);
    const t = S('text', {y: -18, 'text-anchor': 'middle'}, g); t.textContent = text;
    const t0 = performance.now(), dur = 1800, laps = 2;
    const step = ts => {
      const k = (ts - t0) / dur;
      if (k >= laps || !g.isConnected) { g.remove(); return; }
      const f = k % 1, ease = f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f);
      g.setAttribute('transform', `translate(${(a.x + (b.x - a.x) * ease).toFixed(1)},${(a.y + (b.y - a.y) * ease).toFixed(1)})`);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    setTimeout(() => g.remove(), dur * laps + 500);
  }

  // ----- headline counters -----
  const last = {};
  function set(id, value, sub) {
    const el = $(id);
    if (last[id] !== undefined && last[id] !== value) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    last[id] = value; el.textContent = value;
    if (sub !== undefined) $(`${id}-sub`).textContent = sub;
  }
  function stats() {
    const ps = [...st.participants.values()].filter(p => !p.placeholder);
    const active = ps.filter(p => p.status === 'active');
    const count = k => active.filter(p => p.kind === k).length;
    const parts = [[count('sandbox'), 'self-serve'], [count('invited'), 'invited'], [count('agent') + count('operator'), 'operator-run']].filter(x => x[0]);
    set('st-agents', fmt(active.length), parts.map(([n, w]) => `${n} ${w}`).join(' · ') || ' ');
    const edges = [...st.edges.values()].filter(e => e.amount > 0), out = edges.reduce((a, e) => a + e.amount, 0);
    set('st-out', num(out), `on ${edges.length} credit note${edges.length === 1 ? '' : 's'}`);
    const t = st.clearing?.totals;
    if (t) {
      set('st-clear', num(t.cleared_PC ?? 0), `in ${fmt(t.setoffs_applied ?? 0)} set-off${t.setoffs_applied === 1 ? '' : 's'}`);
      set('st-move', num(t.transferred_PC ?? 0), `in ${fmt(t.transfers_applied ?? 0)} transfer${t.transfers_applied === 1 ? '' : 's'}`);
    } else {
      const d = st.detected;
      set('st-clear', num(d.setoffPC), `${d.setoffs} set-off${d.setoffs === 1 ? '' : 's'} seen since this page opened`);
      set('st-move', num(d.transferPC), `${d.transfers} transfer${d.transfers === 1 ? '' : 's'} seen since this page opened`);
    }
    const c = $('st-check').closest('.stat');
    c.classList.toggle('bad', st.recon.bad > 0);
    set('st-check', st.recon.bad ? `${st.recon.bad} differ` : 'all match',
      st.recon.bad ? 'tracker and Valun records differ' : `${st.recon.rows} edge${st.recon.rows === 1 ? '' : 's'}: Basis tracker = Valun records`);
  }

  // ----- connection line -----
  function tick() {
    const now = Date.now(), live = $('live'), text = $('live-text');
    let s, cls;
    if (document.hidden) { s = 'paused'; cls = 'paused'; }
    else if (st.lastError) { s = `${st.lastError} · retrying in ${Math.max(0, Math.ceil((st.nextAt - now) / 1000))} s`; cls = 'err'; }
    else if (!st.lastOk) { s = 'connecting…'; cls = 'wait'; }
    else { const ago = Math.round((now - st.lastOk) / 1000); s = `live · updated ${ago < 2 ? 'just now' : `${ago} s ago`}`; cls = 'ok'; }
    text.textContent = s; live.className = `live ${cls}`;
    if (st.ready && (view.hl.size || view.ghost.size || view.flashNode.size || st.fresh.size)) render(now);
  }

  new ResizeObserver(() => resize()).observe(svg);
  resize();
  setInterval(tick, 1000);
  refreshMeta();
  poll();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') start();
