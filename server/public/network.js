// Valun live network (public/network.html, served at /network): a public, read-only view of the testnet for people. Same
// origin only (CSP connect-src 'self'), no tokens, no libraries, no inline style. What it reads:
//   every 30 s   GET /pilot/v1/ledger (each pair's IOU, cumulative) and GET /pilot/v1/clearing (the network's totals);
//   every 5 min  GET /pilot/v1/participants?all=1 (who is here: sooner when the ledger names someone it does not know),
//                GET /pilot/v1/info (the unit, the timestamp codes), GET /pilot/v1/chain and /pilot/v1/reserves;
//   and GET /pilot/v1/loops at start and when the totals count a new set-off.
// It stops while the tab is hidden or while the visitor pauses it, and waits longer after an error or a 429 (up to 5
// minutes): every viewer behind one address shares the server's per-address read budget with the agents there.
//
// What it shows: who is here, by who runs them (lib/pilot/loops.mjs whoRuns says the same, and a test holds them
// equal); a picture of recent activity: the agents in the latest changes to the ledger beside the operator's own,
// every label placed where it overlaps nothing and stays in the frame, the rest counted; the loops cleared; and the
// same facts as tables. Motion marks only a real change and never runs under prefers-reduced-motion; a screen reader
// hears only a loop that cleared, at most once a minute (the status line is not a live region).
//
// What changed between two polls is read from the tracker's notes (one per issuer -> recipient pair, cumulative): an
// updated note has a new timestamp, and the timestamp's residue mod 1000 says how (GET /info novation: 999 a debt
// transfer, whose two edges share the timestamp; 998 a set-off; 997 a deal's note). explain() turns the changes into
// events. The pure parts are exported for the tests (test/network-page.test.mjs); the page starts only in a browser.

import {SANDBOX_AGENTS, declaresTeam, whoRuns, groupOf, WHO_WORDS} from './who.js';

export const POLL_MS = 30_000, MAX_POLL_MS = 300_000, SLOW_MS = 300_000;
const ANNOUNCE_GAP_MS = 60_000, HOT_MS = 60_000, CHANGES_SHOWN = 15, LOOPS_SHOWN = 5, PEOPLE_GAP_MS = 60_000;
const RES = {transfer: 999, setoff: 998};
const HANDLE_RE = /^[a-z][a-z0-9_-]{2,23}$/;

// ---------- pure parts ----------

// How a participant joined (lib/pilot/loops.mjs kindOf), kept for the record: the page says who runs it (whoRuns).
export function kindOf(p) {
  if (p.placeholder) return 'unknown';
  if (p.unlisted) return 'test';          // an operator test or demo agent, not running: no page
  if (SANDBOX_AGENTS.includes(p.handle)) return 'agent';
  if (p.sandbox_only) return 'sandbox';
  if (p.operator_run) return 'operator';
  return 'invited';
}

// Who runs a participant: public/who.js (the same rule as lib/pilot/loops.mjs; a test holds them equal).
export {SANDBOX_AGENTS, declaresTeam, whoRuns, groupOf, WHO_WORDS};

// Who is here, by who runs them: every participant GET /participants?all=1 lists.
export function classCounts(ps) {
  const c = {all: 0, operator: 0, team: 0, other: 0};
  for (const p of ps || []) {
    if (!p || p.placeholder || typeof p.id !== 'string') continue;
    c.all += 1; c[groupOf(p.who ?? whoRuns(p))] += 1;
  }
  return c;
}

// The ledger's notes as edges between participants: one edge per (issuer, recipient) pair of participants (a
// participant whose agent key changed can have several notes per pair), its amount what is outstanding, in the
// network's unit, with each note's amount and timestamp. A note whose key no participant has is shown under the key
// (key:<pubkey>).
export function edgesOf(notes) {
  const m = new Map();
  for (const n of notes || []) {
    const from = n.issuer ?? `key:${n.issuer_pubkey}`, to = n.recipient ?? `key:${n.recipient_pubkey}`, key = `${from}>${to}`;
    let e = m.get(key);
    if (!e) m.set(key, e = {key, from, to, amount: 0, notes: new Map(), ts: 0, from_handle: n.issuer_handle ?? null, to_handle: n.recipient_handle ?? null});
    const amount = Number(n.outstanding ?? n.total) || 0, ts = Number(n.timestamp) || 0;
    e.amount += amount;
    e.ts = Math.max(e.ts, ts);
    e.notes.set(`${n.issuer_pubkey}>${n.recipient_pubkey}`, {amount, ts});
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
// the cycle went down by `each`; amount = the sum of the decreases, what the server's GET /clearing `cleared` counts)
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

// An amount exactly, in the network's unit (GET /pilot/v1/info unit): "3 PC" on the pilot; on the testnet (nanoERG of
// Ergo testnet) in tERG, "0.003 tERG" (exact: whole nanoERG to tERG by integer arithmetic).
export function tergText(n) {
  const v = BigInt(Math.trunc(Number(n) || 0)), neg = v < 0n, a = neg ? -v : v;
  const frac = String(a % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / 1000000000n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
export function moneyText(n, unit = 'PC') {
  return unit === 'nanoERG' ? `${tergText(n)} tERG` : `${Number(n || 0).toLocaleString('en-US')} PC`;
}
// An amount as people read it (lib/pilot/loops.mjs terg on the testnet): tERG with at most 6 decimals, a total rounded
// to 3 ("0.444 tERG": the exact figure is in the JSON); a true minus sign. On the pilot "3 PC".
export function terg(n, {total = false, unit = 'nanoERG'} = {}) {
  const v = Math.trunc(Number(n) || 0);
  if (unit !== 'nanoERG') return `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US')} PC`;
  const a = Math.abs(v), s = (total ? (a / 1e9).toFixed(3) : (Math.round(a / 1e3) / 1e6).toFixed(6)).replace(/0+$/, '').replace(/\.$/, '');
  return `${v < 0 && s !== '0' ? '−' : ''}${s} tERG`;
}

// The "On Ergo testnet" facts from GET /pilot/v1/chain and GET /pilot/v1/reserves (the testnet network, once on chain):
// plain values for the page to draw, or null. Ids must be 64 hex; a link is kept only when it is the explorer's. A
// reserve backs only its own issuer's notes: `backs` is what it backs now, the smaller of its collateral and its
// issuer's outstanding debt (GET /reserves total_debt_nanoerg).
export function chainPanel(chain, reserves) {
  const hex = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const explorer = u => (typeof u === 'string' && /^https:\/\/testnet\.ergoplatform\.com\/[A-Za-z0-9/._-]+$/.test(u) ? u : null);
  const a = chain && typeof chain.anchoring === 'object' ? chain.anchoring : null;
  if (!chain?.on_chain || !a) return null;
  const cap = a.daily_cap && Number.isInteger(a.daily_cap.limit) ? {limit: a.daily_cap.limit, today: Number(a.daily_cap.signed_today) || 0, used_up: a.daily_cap.used_up === true
    || (Number(a.daily_cap.signed_today) || 0) >= a.daily_cap.limit} : null;
  return {
    anchored: a.anchored === true, height: Number.isInteger(a.confirmed_height) ? a.confirmed_height : null,
    pending: hex(a.pending_tx_id), cap,
    links: {nft: explorer(chain.links?.tracker_nft), address: explorer(chain.links?.tracker_address)},
    reserves: (Array.isArray(reserves?.reserves) ? reserves.reserves : []).filter(r => hex(r?.box_id))
      .map(r => {
        const nanoerg = Number.isInteger(r.collateral_nanoerg) ? r.collateral_nanoerg : 0, debt = Number.isInteger(r.total_debt_nanoerg) ? r.total_debt_nanoerg : 0;
        return {handle: typeof r.handle === 'string' ? r.handle : null, nanoerg, backs: Math.max(0, Math.min(nanoerg, debt))};
      }),
  };
}

// The closed loop (GET /pilot/v1/loops) a set-off event shows: the newest loop not linked yet whose members are the
// event's members (by handle, in any order). null when none matches.
export function matchLoop(handles, loops, linked = new Set()) {
  const want = [...handles].sort().join('\n');
  return (Array.isArray(loops) ? loops : []).find(l => typeof l?.id === 'string' && !linked.has(l.id)
    && [...new Set((l.members || []).map(m => m?.handle))].sort().join('\n') === want) ?? null;
}

// The latest changes to the ledger: one row per pair (its newest note's timestamp, what it owes now), newest first, and
// what the change was by the timestamp's residue: 'transfer' (an IOU passed on), 'setoff' (a loop cut it) or 'note'
// (an IOU for a job).
export function latestChanges(edges, residues = RES, n = CHANGES_SHOWN) {
  return [...edges.values()].filter(e => e.ts > 0).sort((a, b) => b.ts - a.ts || (a.key < b.key ? -1 : 1)).slice(0, n)
    .map(e => ({key: e.key, from: e.from, to: e.to, ts: e.ts, owed: e.amount,
      kind: e.ts % 1000 === residues.transfer ? 'transfer' : e.ts % 1000 === residues.setoff ? 'setoff' : 'note'}));
}

// Which agents the picture draws: the ones the operator runs (always), then the members of the newest loop, then the
// agents in the latest changes, newest first, up to `max`; everyone else is counted by who runs them. `people`: Map id ->
// {id, handle, who, placeholder}; `changes`: latestChanges(..., many); `loops`: GET /loops, newest first.
export function pickView(people, changes, loops, max) {
  const core = [...people.values()].filter(p => !p.placeholder && groupOf(p.who) === 'operator')
    .sort((a, b) => String(a.handle).localeCompare(String(b.handle))).map(p => p.id);
  const seen = new Set(core), ring = [], byHandle = new Map([...people.values()].map(p => [p.handle, p.id]));
  const add = id => { if (ring.length < max && id && !seen.has(id) && people.has(id) && !people.get(id).placeholder) { seen.add(id); ring.push(id); return true; } return false; };
  for (const m of loops?.[0]?.members || []) add(byHandle.get(m?.handle));
  let since = null;   // the oldest change that put an agent in the picture
  for (const c of changes || []) { const a = add(c.from), b = add(c.to); if (a || b) since = c.ts; }
  const hidden = {operator: 0, team: 0, other: 0};
  for (const p of people.values()) if (!p.placeholder && !seen.has(p.id)) hidden[groupOf(p.who)] += 1;
  return {core, ring, hidden, since};
}

// When the picture's window starts (pickView's since), as people read it: '20:10 UTC' on the reader's UTC day, and with
// the date on any other ('Nov 16, 20:10 UTC'; 'Dec 31, 2025, 23:50 UTC' in another year). The time alone read as later
// today once it was the day before's (the redesign's live check, at 14:54 UTC: "since 20:10 UTC"). '' for no time.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function sinceText(t, now = Date.now()) {
  const d = new Date(t), n = new Date(now);
  if (!Number.isFinite(d.getTime())) return '';
  const hm = `${d.toISOString().slice(11, 16)} UTC`;
  if (Number.isFinite(n.getTime()) && d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10)) return hm;
  const year = Number.isFinite(n.getTime()) && d.getUTCFullYear() === n.getUTCFullYear() ? '' : `, ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year}, ${hm}`;
}

// How many agents the picture can name in a frame of height H: two fans, each label a line of its own.
export function ringCapacity(H, font) { return Math.max(2, 2 * Math.floor((H - 52) / (font + 10))); }

// The ring's agents on two fans, left and right: agents that dealt with each other stay together (a component of the
// pairs among them, largest first, each to the emptier side), and the sides are evened out.
function splitSides(ids, edges) {
  const set = new Set(ids), nb = new Map(ids.map(id => [id, new Set()])), rank = new Map(ids.map((id, i) => [id, i]));
  for (const e of edges.values()) if (set.has(e.from) && set.has(e.to) && e.from !== e.to) { nb.get(e.from).add(e.to); nb.get(e.to).add(e.from); }
  const comps = [], seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp = [], q = [id];
    seen.add(id);
    while (q.length) {
      const x = q.shift(); comp.push(x);
      for (const y of [...nb.get(x)].sort((a, b) => rank.get(a) - rank.get(b))) if (!seen.has(y)) { seen.add(y); q.push(y); }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => b.length - a.length || rank.get(a[0]) - rank.get(b[0]));
  const left = [], right = [];
  for (const c of comps) (left.length <= right.length ? left : right).push(...c);
  while (left.length - right.length > 1) right.push(left.pop());
  while (right.length - left.length > 1) left.push(right.pop());
  return [left, right];
}

// A handle cut to `n` characters ("basis-lab-mc-…"); a core agent's label may take two lines, split at a hyphen.
const fit = (h, n) => (h.length <= n ? h : `${h.slice(0, Math.max(1, n - 1))}…`);
function twoLines(h, n) {
  if (h.length <= n) return [h];
  let best = -1;
  for (let i = 1; i < h.length - 1; i++) if (h[i] === '-' && Math.max(i + 1, h.length - i - 1) <= n && (best < 0 || Math.abs(h.length / 2 - i) < Math.abs(h.length / 2 - best))) best = i;
  return best < 0 ? [fit(h, n)] : [h.slice(0, best + 1), h.slice(best + 1)];
}

// Where everything goes in a W x H frame: the operator's agents in a column at the centre, labelled below; the ring's
// agents on two fans, labelled outwards, one line each, cut to the room they have. Each label's box is returned
// ({x0, y0, x1, y1}) so a test can check that none overlaps another and that all stay inside the frame.
export function layoutView(view, people, edges, {W, H, font = 12}) {
  const cw = font * 0.6, m = 10, cx = W / 2, cy = H / 2, lh = font + 2;
  const labelRoom = Math.max(84, Math.min(190, W * 0.22));
  const yTop = m + font + 6, yBot = H - m - font - 2, span = Math.max(40, yBot - yTop);
  const phi = (64 * Math.PI) / 180, ry = span / 2 / Math.sin(phi), rx = Math.max(52, cx - labelRoom - m - 12);
  const nodes = [], handle = id => String(people.get(id)?.handle ?? id);
  const [left, right] = splitSides(view.ring, edges);
  for (const [ids, s] of [[left, -1], [right, 1]]) ids.forEach((id, i) => {
    const y = yTop + ((i + 0.5) * span) / ids.length, t = Math.max(-1, Math.min(1, (y - cy) / ry));
    const x = cx + s * rx * Math.sqrt(1 - t * t), lx = x + s * 11, room = s < 0 ? lx - m : W - m - lx;
    const text = fit(handle(id), Math.max(4, Math.floor(room / cw)));
    const w = text.length * cw;
    nodes.push({id, x, y, side: s, anchor: s < 0 ? 'end' : 'start', lines: [{text, x: lx, y: y + font * 0.36}],
      box: {x0: s < 0 ? lx - w : lx, y0: y - lh / 2, x1: s < 0 ? lx : lx + w, y1: y + lh / 2}});
  });
  const kc = view.core.length, gap = Math.max(font * 3.6, Math.min(92, span / (kc + 1.2)));
  const half = Math.max(30, rx * 0.72 - 12), n = Math.max(6, Math.floor((2 * half) / cw));
  view.core.forEach((id, j) => {
    const y = cy + (j - (kc - 1) / 2) * gap, lines = twoLines(handle(id), n);
    const w = Math.max(...lines.map(l => l.length)) * cw, top = y + 10;
    nodes.push({id, x: cx, y, side: 0, core: true, anchor: 'middle', lines: lines.map((text, k) => ({text, x: cx, y: top + font * 0.8 + k * lh})),
      box: {x0: cx - w / 2, y0: top, x1: cx + w / 2, y1: top + lines.length * lh}});
  });
  return {W, H, nodes, at: new Map(nodes.map(n => [n.id, n])), geom: {cx, cy, rx, ry, yTop, yBot}};
}

// An edge's path from a to b (quadratic): bowed towards the centre within a fan, through the middle across, to the side
// in the centre column; `bend` sets a second edge of the same pair apart (the other way round).
export function edgePath(a, b, {W, bend = 0, ra = 6, rb = 9}) {
  const cx = W / 2, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  let qx = mx, qy = my;
  if (a.side === 0 && b.side === 0) qx = cx + (Math.abs(dy) * 0.35 + 18) * (bend >= 0 ? 1 : -1);
  else if (a.side === b.side) qx = mx + (cx - mx) * Math.min(0.6, 0.15 + Math.abs(dy) / (2.5 * W));
  qx += (-dy / len) * bend; qy += (dx / len) * bend;
  const trim = (p, q, d) => { const ux = q.x - p.x, uy = q.y - p.y, l = Math.hypot(ux, uy) || 1; return {x: p.x + (ux / l) * d, y: p.y + (uy / l) * d}; };
  const c = {x: qx, y: qy}, p0 = trim(a, c, ra), p2 = trim(b, c, rb), f = v => v.toFixed(1);
  return `M${f(p0.x)},${f(p0.y)} Q${f(qx)},${f(qy)} ${f(p2.x)},${f(p2.y)}`;
}
// An edge's stroke for what it carries: 1 to 2.6 (a PC-sized amount is 1,000,000 nanoERG: lib/pilot/units.mjs).
export function edgeWidth(amount, unit = 'nanoERG') { const v = (Number(amount) || 0) / (unit === 'nanoERG' ? 1_000_000 : 1); return Math.min(2.6, 1 + 0.4 * Math.log2(1 + Math.max(0, v))); }

// ---------- the page ----------

const SVGNS = 'http://www.w3.org/2000/svg';

function start() {
  const $ = id => document.getElementById(id);
  const S = (tag, attrs, parent) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    if (parent) parent.appendChild(el);
    return el;
  };
  const H = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
  const fmt = n => Number(n || 0).toLocaleString('en-US'), many = (n, w) => `${fmt(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
  const reduce = () => typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const utc = t => `${new Date(t).toISOString().slice(11, 16)} UTC`;
  const ago = t => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };

  const st = {
    unit: 'nanoERG', network: 'valun-testnet-1', residues: {...RES}, people: new Map(), byHandle: new Map(), edges: new Map(), loops: [], clearing: null, chain: null,
    recon: {streak: new Map(), bad: 0, rows: 0, ok: 0}, hot: new Map(), lastLoopId: null, lastAnnounce: 0, peopleAt: 0, slowAt: 0, loopsAt: 0,
    interval: POLL_MS, timer: null, inflight: false, paused: false, lastOk: 0, error: null, ready: false, focus: null, sig: '',
  };
  const svg = $('graph'), box = $('graph-box');
  const amount = (n, o) => terg(n, {...o, unit: st.unit});

  // ----- data -----
  async function getJson(path) {
    const r = await fetch(path, {cache: 'no-store', credentials: 'omit', headers: {accept: 'application/json'}});
    if (!r.ok) { const e = new Error(`${path}: HTTP ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }
  // Who is here: every participant, with who runs it (whoRuns). A note whose key no participant has is shown under its
  // key until the next read names it.
  function setPeople(ps) {
    const next = new Map();
    for (const p of Array.isArray(ps) ? ps : []) if (p && typeof p.id === 'string') next.set(p.id, {...p, who: whoRuns(p)});
    st.people = next; st.peopleAt = Date.now();
    st.byHandle = new Map([...next.values()].map(p => [p.handle, p.id]));
  }
  async function readSlow() {
    st.slowAt = Date.now();
    const [info, chain, res] = await Promise.all([getJson('/pilot/v1/info').catch(() => null), getJson('/pilot/v1/chain').catch(() => null), getJson('/pilot/v1/reserves').catch(() => null)]);
    if (info?.novation) {
      if (Number.isInteger(info.novation.transfer_ms)) st.residues.transfer = info.novation.transfer_ms;
      if (Number.isInteger(info.novation.setoff_ms)) st.residues.setoff = info.novation.setoff_ms;
    }
    if (typeof info?.unit === 'string' && info.unit) st.unit = info.unit;
    if (typeof info?.network === 'string' && info.network) st.network = info.network;
    st.chain = chainPanel(chain, res);
    drawChain();
  }
  async function readLoops() {
    st.loopsAt = Date.now();
    const list = await getJson('/pilot/v1/loops').then(r => (Array.isArray(r?.loops) ? r.loops : null), () => null);
    if (!list) return;
    const newest = list[0]?.id ?? null;
    if (st.ready && newest && newest !== st.lastLoopId) announceLoop(list[0]);
    st.lastLoopId = newest; st.loops = list;
  }

  async function poll() {
    if (st.inflight || st.paused || document.hidden) return;
    st.inflight = true; clearTimeout(st.timer);
    try {
      const needPeople = !st.ready || Date.now() - st.peopleAt >= SLOW_MS;
      const [ps, ledger, clearing] = await Promise.all([needPeople ? getJson('/pilot/v1/participants?all=1') : null, getJson('/pilot/v1/ledger'),
        getJson('/pilot/v1/clearing').catch(e => { if (e.status === 404) return null; throw e; })]);
      if (ps) setPeople(ps);
      if (typeof ledger?.unit === 'string' && ledger.unit) st.unit = ledger.unit;
      const edges = edgesOf(ledger?.notes);
      // Someone new in the ledger: read who is here again (at most once a minute).
      if (!ps && [...edges.values()].some(e => !st.people.has(e.from) || !st.people.has(e.to)) && Date.now() - st.peopleAt >= PEOPLE_GAP_MS)
        setPeople(await getJson('/pilot/v1/participants?all=1'));
      const setoffs = Number(clearing?.totals?.setoffs_applied), before = Number(st.clearing?.totals?.setoffs_applied);
      if (!st.ready || (Number.isFinite(setoffs) && setoffs !== before) || Date.now() - st.loopsAt >= SLOW_MS) await readLoops();
      if (st.ready) for (const e of explain(diffEdges(st.edges, edges, st.residues))) for (const k of e.edges) st.hot.set(k, {type: e.type, until: Date.now() + HOT_MS});
      st.edges = edges; st.clearing = clearing ?? st.clearing;
      reconcile(ledger?.reconciliation);
      st.lastOk = Date.now(); st.interval = POLL_MS; st.error = null; st.ready = true;
    } catch (e) {
      st.interval = Math.min(MAX_POLL_MS, st.interval * 2);
      st.error = e.status === 429 ? 'The server asked us to slow down' : 'Can\'t reach the server';
    } finally { st.inflight = false; }
    if (st.ready && Date.now() - st.slowAt >= SLOW_MS) readSlow();
    draw(); schedule();
  }
  function schedule() {
    clearTimeout(st.timer);
    if (st.paused || document.hidden) return;
    st.timer = setTimeout(poll, st.interval);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(st.timer); status(); return; }
    if (!st.paused) { if (Date.now() - st.lastOk >= st.interval) poll(); else schedule(); }
    status();
  });
  // One pattern on both live views (the home's too): the label says what the button does next; no aria-pressed, which
  // with a changing label would be announced as a double state.
  const pause = $('pause');
  pause.hidden = false;
  pause.addEventListener('click', () => {
    st.paused = !st.paused;
    pause.textContent = st.paused ? 'Resume updates' : 'Pause updates';
    if (st.paused) clearTimeout(st.timer); else poll();
    status();
  });

  // Rows of the ledger check that are not `match`: counted once they appear in two polls in a row (a row can differ for
  // a moment while a change is being recorded).
  function reconcile(rows) {
    const streak = new Map();
    for (const r of Array.isArray(rows) ? rows : []) if (r && r.status !== 'match') {
      const k = `${r.issuer ?? r.pair}>${r.recipient ?? ''}|${r.status}`;
      streak.set(k, (st.recon.streak.get(k) ?? 0) + 1);
    }
    st.recon.streak = streak;
    st.recon.rows = Array.isArray(rows) ? rows.length : 0;
    st.recon.bad = [...streak.values()].filter(n => n >= 2).length;
  }

  // ----- the screen reader hears a loop that cleared, at most once a minute; nothing else -----
  function announceLoop(l) {
    if (st.paused || Date.now() - st.lastAnnounce < ANNOUNCE_GAP_MS) return;
    st.lastAnnounce = Date.now();
    const names = (l.members || []).map(m => m?.handle ?? 'unknown');
    $('announce').textContent = `A loop cleared: ${[...names, names[0]].join(' to ')}, ${amount(l.each ?? 0)} off each note.`;
  }

  // ----- the status line: what it reads and when (not a live region) -----
  function status() {
    const el = $('state'), text = $('state-text');
    let cls, s;
    if (st.paused) { cls = 'paused'; s = `Paused · ${st.network}${st.lastOk ? ` · last read ${utc(st.lastOk)}` : ''}`; }
    else if (st.error) { cls = 'err'; s = `${st.error} · trying again in ${Math.round(st.interval / 1000)} s`; }
    else if (!st.lastOk) { cls = 'wait'; s = `Reading ${st.network}…`; }
    else if (document.hidden) { cls = 'paused'; s = `Paused while the tab is hidden · ${st.network}`; }
    else { cls = 'ok'; s = `Live · ${st.network} · read ${utc(st.lastOk)} · every ${Math.round(POLL_MS / 1000)} s`; }
    el.className = `state ${cls}`; text.textContent = s;
    // The picture says Live only while it is: drawn from a read that succeeded, and reading on.
    $('graph-live').hidden = cls !== 'ok' || !st.ready;
  }

  // ----- drawing -----
  const nameOf = id => st.people.get(id)?.handle ?? (String(id).startsWith('key:') ? `key ${String(id).slice(4, 12)}…` : String(id));
  const whoOf = id => st.people.get(id)?.who ?? 'unknown';
  const shape = who => H('span', `shape w-${groupOf(who) === 'operator' ? 'operator' : who === 'team' ? 'team' : who === 'unknown' ? 'unknown' : 'other'}`);
  const agentEl = id => {
    const h = nameOf(id), p = st.people.get(id);
    if (!p || p.unlisted || !HANDLE_RE.test(h)) return H('span', 'h', h);
    const a = H('a', 'h', h); a.href = `/agent/${h}`; return a;
  };

  function draw() {
    status();
    if (!st.ready) {
      // Nothing read yet, and the read failed: the tables say so, not "Reading the ledger…" forever.
      if (st.error) {
        const msg = `The ledger can't be read right now; this page tries again in ${Math.round(st.interval / 1000)} s.`;
        const tr = H('tr'), td = H('td', null, msg); td.setAttribute('colspan', '4'); tr.append(td);
        $('changes-body').replaceChildren(tr);
        $('loops').replaceChildren(H('li', 'small', msg));
      }
      return;
    }
    counts(); graph(); loopsList(); changes(); openList(); totals(); drawChain();
  }

  function counts() {
    const c = classCounts([...st.people.values()]);
    $('n-all').textContent = fmt(c.all); $('n-operator').textContent = fmt(c.operator); $('n-team').textContent = fmt(c.team); $('n-other').textContent = fmt(c.other);
  }

  // The picture: rebuilt when what it shows changes, or the frame's size.
  function graph() {
    const r = box.getBoundingClientRect(), W = Math.max(280, Math.round(r.width)), Hh = Math.max(300, Math.round(r.height));
    const font = W < 520 ? 11 : 12, max = Math.min(W < 520 ? 12 : W < 760 ? 18 : 24, ringCapacity(Hh, font));
    const all = latestChanges(st.edges, st.residues, 400);
    const people = new Map(st.people);
    for (const e of st.edges.values()) for (const id of [e.from, e.to]) if (!people.has(id)) people.set(id, {id, handle: nameOf(id), who: 'unknown', placeholder: true});
    const view = pickView(people, all, st.loops, max);
    const now = Date.now();
    for (const [k, h] of st.hot) if (h.until <= now) st.hot.delete(k);
    // The subtitle's "since" is in the signature: past 00:00 UTC it gains its date, with nothing else changed.
    const since = view.since ? sinceText(view.since, now) : '';
    const sig = JSON.stringify([W, Hh, view, since, [...st.edges.values()].map(e => [e.key, e.amount]), st.loops[0]?.id, [...st.hot.keys()]]);
    if (sig === st.sig) return;
    st.sig = sig;
    const keep = st.focus && svg.contains(document.activeElement) ? st.focus : null;
    svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
    const L = layoutView(view, people, st.edges, {W, H: Hh, font});
    const gG = $('g-guides'), gE = $('g-edges'), gL = $('g-loops'), gN = $('g-nodes');
    for (const g of [gG, gE, gL, gN]) g.replaceChildren();
    $('graph-empty').hidden = L.nodes.length > 0;
    // guides: the column of the operator's agents and the two fans, as a scope's faint marks
    const G = L.geom, f1 = v => v.toFixed(1);
    S('line', {class: 'guide', x1: f1(G.cx), y1: f1(G.yTop - 4), x2: f1(G.cx), y2: f1(G.yBot + 4)}, gG);
    for (const s of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 24; k++) {
        const y = G.yTop + ((G.yBot - G.yTop) * k) / 24, t = Math.max(-1, Math.min(1, (y - G.cy) / G.ry));
        pts.push(`${f1(G.cx + s * G.rx * Math.sqrt(1 - t * t))},${f1(y)}`);
      }
      S('polyline', {class: 'guide', points: pts.join(' ')}, gG);
    }
    // edges: what is owed now between the agents drawn, from the one who owes to the one it owes
    const drawn = [...st.edges.values()].filter(e => e.amount > 0 && L.at.has(e.from) && L.at.has(e.to) && e.from !== e.to);
    const pair = new Set(drawn.map(e => e.key));
    for (const e of drawn) {
      const a = L.at.get(e.from), b = L.at.get(e.to), back = pair.has(`${e.to}>${e.from}`), hot = st.hot.get(e.key);
      const p = S('path', {class: `edge${hot ? ` hot ${reduce() ? '' : 'flash'}` : ''}`, d: edgePath(a, b, {W, bend: back ? 9 : 0, ra: a.core ? 8 : 6, rb: b.core ? 11 : 9}),
        'stroke-width': edgeWidth(e.amount, st.unit).toFixed(2), 'marker-end': `url(#${hot ? 'ah-hot' : 'ah'})`, 'data-from': e.from, 'data-to': e.to}, gE);
      p.setAttribute('aria-hidden', 'true');
    }
    // the newest loop that cleared, through its members in order, in the rainbow (only a cleared loop has it); the older
    // ones are in "Loops cleared" (almost every loop runs through the practice agents at the centre, so drawing many of
    // them buried the arrows). In a narrow frame it is drawn fainter.
    const newest = st.loops[0], ids = (newest?.members || []).map(m => st.byHandle.get(m?.handle));
    if (ids.length >= 2 && ids.every(id => L.at.has(id))) {
      const g = S('g', {class: `loop newest${W < 520 ? ' narrow' : ''}`, 'aria-hidden': 'true'}, gL);
      ids.forEach((id, i) => {
        const a = L.at.get(id), b = L.at.get(ids[(i + 1) % ids.length]);
        S('path', {class: 'loop-arc', d: edgePath(a, b, {W, bend: -14, ra: 10, rb: 13}), 'marker-end': 'url(#ah-loop)'}, g);
      });
    }
    // nodes: one tab stop for the picture; the arrow keys move from agent to agent (focus()), Enter opens its page
    const order = [...L.nodes].sort((a, b) => (a.side - b.side) || (a.y - b.y));
    const focusId = st.focus && L.at.has(st.focus) ? st.focus : order[0]?.id;
    for (const n of order) {
      const p = people.get(n.id), who = p?.who ?? 'unknown', h = nameOf(n.id), link = p && !p.placeholder && !p.unlisted && HANDLE_RE.test(h);
      const g = S(link ? 'a' : 'g', {class: `node w-${groupOf(who) === 'operator' ? 'operator' : who}${n.core ? ' core' : ''}`, 'data-id': n.id}, gN);
      if (link) {
        g.setAttribute('href', `/agent/${h}`);
        g.setAttribute('tabindex', n.id === focusId ? '0' : '-1');
        g.setAttribute('aria-label', `${h}, ${WHO_WORDS[who] ?? 'agent'}: ${tieText(n.id)}`);
      } else g.setAttribute('aria-hidden', 'true');
      S('circle', {class: 'hit', cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: 13}, g);
      if (groupOf(who) === 'operator') S('rect', {class: 'glyph', x: (n.x - 6).toFixed(1), y: (n.y - 6).toFixed(1), width: 12, height: 12, transform: `rotate(45 ${n.x.toFixed(1)} ${n.y.toFixed(1)})`}, g);
      else S('circle', {class: 'glyph', cx: n.x.toFixed(1), cy: n.y.toFixed(1), r: who === 'other' ? 5 : 4.5}, g);
      const t = S('text', {class: 'label', 'text-anchor': n.anchor, 'aria-hidden': 'true', 'font-size': font}, g);
      n.lines.forEach(l => { const ts = S('tspan', {x: l.x.toFixed(1), y: l.y.toFixed(1)}, t); ts.textContent = l.text; });
    }
    const sub = $('map-sub');
    sub.textContent = `The ${fmt(view.ring.length)} agents in the latest changes to the ledger${since ? ` (since ${since})` : ''}, and the ${fmt(view.core.length)} the operator runs. Read from GET /pilot/v1/ledger.`;
    const hid = view.hidden, parts = [[hid.team, 'team test agent'], [hid.other, 'other agent'], [hid.operator, 'operator-run agent']].filter(([k]) => k > 0);
    $('quiet').textContent = parts.length ? `Not drawn: ${parts.map(([k, w]) => `${fmt(k)} ${w}${k === 1 ? '' : 's'}`).join(', ')} with no recent change. Every open note is in the tables below.` : '';
    if (keep) gN.querySelector(`[data-id="${keep}"]`)?.focus({preventScroll: true});
    if (st.focus) show(st.focus);
  }
  // What a node owes and is owed, across the whole ledger (not only what is drawn).
  function tieText(id) {
    let owes = 0, no = 0, owed = 0, nb = 0;
    for (const e of st.edges.values()) if (e.amount > 0) { if (e.from === id) { owes += e.amount; no += 1; } if (e.to === id) { owed += e.amount; nb += 1; } }
    const one = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return `${owes ? `owes ${amount(owes)} to ${one(no, 'agent')}` : 'owes nothing'}; ${owed ? `is owed ${amount(owed)} by ${one(nb, 'agent')}` : 'is owed nothing'}`;
  }
  // The detail line under the picture (for sight; the node's own name says the same to a screen reader). On a phone a
  // tap follows the agent's link, so the hint says so (network.html carries the same words before the script runs).
  const HINT = 'Hover over an agent, or tab to the picture and use the arrow keys, to see what it owes and is owed; tap one to open its page.';
  function show(id) {
    const el = $('detail');
    if (!id || !st.people.has(id) && !String(id).startsWith('key:')) { el.replaceChildren(H('p', 'hint', HINT)); return; }
    const who = whoOf(id), p = H('p', 'detail-line');
    p.append(shape(who), H('span', 'h', nameOf(id)), H('span', 'who-words', WHO_WORDS[who] ?? 'agent'), H('span', 'ties', tieText(id)));
    el.replaceChildren(p);
    svg.classList.add('focusing');
    for (const n of svg.querySelectorAll('.node')) n.classList.toggle('on', n.getAttribute('data-id') === id);
    for (const e of svg.querySelectorAll('.edge')) e.classList.toggle('on', e.getAttribute('data-from') === id || e.getAttribute('data-to') === id);
  }
  function clear() {
    svg.classList.remove('focusing');
    for (const n of svg.querySelectorAll('.node')) n.classList.remove('on');
    for (const e of svg.querySelectorAll('.edge')) e.classList.remove('on');
    show(null);
  }
  const nodeOf = t => (t && typeof t.closest === 'function' ? t.closest('.node') : null);
  svg.addEventListener('pointerover', ev => { const n = nodeOf(ev.target); if (n) show(n.getAttribute('data-id')); });
  svg.addEventListener('pointerleave', () => { if (!st.focus) clear(); else show(st.focus); });
  svg.addEventListener('focusin', ev => { const n = nodeOf(ev.target); if (n) { st.focus = n.getAttribute('data-id'); show(st.focus); } });
  svg.addEventListener('focusout', () => { st.focus = null; clear(); });
  svg.addEventListener('keydown', ev => {
    const links = svg.querySelectorAll('a.node'), i = links.indexOf ? links.indexOf(document.activeElement) : [...links].indexOf(document.activeElement);
    if (i < 0) return;
    const to = {ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: links.length - 1}[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    const next = links[(to + links.length) % links.length];
    for (const l of links) l.setAttribute('tabindex', l === next ? '0' : '-1');
    next.focus();
  });

  function loopsList() {
    const ol = $('loops'), rows = st.loops.slice(0, LOOPS_SHOWN);
    ol.replaceChildren(...rows.map(l => {
      const li = H('li'), names = (l.members || []).map(m => m?.handle ?? 'unknown'), route = H('p', 'loop-route');
      names.forEach((h, i) => {
        const id = st.byHandle.get(h);
        route.append(shape(id ? whoOf(id) : 'unknown'), H('span', 'h', h));
        route.append(H('span', 'arr', i === names.length - 1 ? ` → ${names[0]}` : ' → '));
      });
      const groups = new Map();
      for (const h of new Set(names)) { const id = st.byHandle.get(h), g = id ? groupOf(whoOf(id)) : 'other'; groups.set(g, (groups.get(g) ?? 0) + 1); }
      const words = {operator: ['operator-run agent', 'operator-run agents'], team: ['team test agent', 'team test agents'], other: ['other agent', 'other agents']};
      const who = [...groups].map(([g, n]) => `${n} ${words[g][n === 1 ? 0 : 1]}`).join(', ');
      const t = Date.parse(l.applied_at), chain = l.on_chain ? (l.on_chain.anchored ? 'committed' : 'not committed yet') : '';
      const meta = H('p', 'loop-meta', [`${amount(-(l.each ?? 0))} each`, Number.isFinite(t) ? ago(t) : '', chain].filter(Boolean).join(' · '));
      const a = H('a', 'loop-card', 'Loop card'); a.href = `/loop/${l.id}`; a.setAttribute('aria-label', `Loop card: ${[...names, names[0]].join(' → ')}`);
      const foot = H('p', 'loop-who'); foot.append(H('span', null, who), a);
      li.append(route, meta, foot);
      return li;
    }));
    if (!rows.length) ol.replaceChildren(H('li', 'small', 'No loop has cleared yet.'));
  }

  const WHAT = {note: 'new note for a job', transfer: 'note passed on', setoff: 'cut by a loop'};
  function changes() {
    const body = $('changes-body'), rows = latestChanges(st.edges, st.residues, CHANGES_SHOWN);
    body.replaceChildren(...rows.map(c => {
      const tr = H('tr'), when = H('time', null, ago(c.ts)), who = H('td', 'pair');
      when.setAttribute('datetime', new Date(c.ts).toISOString()); when.setAttribute('title', `${new Date(c.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      const td = H('td'); td.append(when);
      who.append(shape(whoOf(c.from)), agentEl(c.from), H('span', 'arr', c.owed > 0 ? ' owes ' : ' owed '), shape(whoOf(c.to)), agentEl(c.to),
        H('span', 'meta-sm', `${ago(c.ts)} · ${WHAT[c.kind]}`));   // on a phone, where the When and What columns are not shown
      td.className = 'when';
      tr.append(td, who, H('td', 'what', WHAT[c.kind]), H('td', 'num', amount(c.owed)));
      return tr;
    }));
    if (!rows.length) { const tr = H('tr'), td = H('td', null, 'No note on the ledger yet.'); td.setAttribute('colspan', '4'); tr.append(td); body.replaceChildren(tr); }
  }
  // Every open IOU, largest first: drawn when the visitor opens the list.
  const all = $('all-open');
  all.addEventListener('toggle', () => openList());
  function openList() {
    const open = [...st.edges.values()].filter(e => e.amount > 0).sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
    $('open-count').textContent = fmt(open.length);
    if (!all.open) return;
    $('open-body').replaceChildren(...open.map(e => {
      const tr = H('tr'), who = H('td', 'pair');
      who.append(shape(whoOf(e.from)), agentEl(e.from), H('span', 'arr', ' owes '), shape(whoOf(e.to)), agentEl(e.to));
      tr.append(who, H('td', 'num', amount(e.amount)));
      return tr;
    }));
  }

  function totals() {
    const open = [...st.edges.values()].filter(e => e.amount > 0), owed = open.reduce((s, e) => s + e.amount, 0);
    const agents = new Set(open.flatMap(e => [e.from, e.to])).size, t = st.clearing?.totals;
    $('t-out').textContent = amount(owed, {total: true}); $('t-out-sub').textContent = `${many(open.length, 'note')} between ${many(agents, 'agent')}`;
    if (t) {
      $('t-clear').textContent = amount(t.cleared ?? 0, {total: true}); $('t-clear-sub').textContent = `in ${many(t.setoffs_applied ?? 0, 'loop')}`;
      $('t-move').textContent = amount(t.transferred ?? 0, {total: true}); $('t-move-sub').textContent = `in ${many(t.transfers_applied ?? 0, 'transfer')}`;
    }
    const c = $('t-check');
    c.textContent = st.recon.bad ? `${fmt(st.recon.bad)} differ` : `${fmt(st.recon.rows)} of ${fmt(st.recon.rows)} match`;
    c.closest('div').classList.toggle('bad', st.recon.bad > 0);
    $('t-check-sub').textContent = st.recon.bad ? 'the server\'s records and its tracker differ on these pairs' : 'pairs: the server\'s records agree with its tracker';
  }

  function drawChain() {
    const c = st.chain, sec = $('chain'), ul = $('chain-list');
    if (!c) return;
    const items = [];
    items.push(c.anchored ? `Anchored: the tracker box on chain commits the ledger as of block ${fmt(c.height)}.`
      : c.pending ? 'Anchoring now: a tracker box is on its way to a block.'
        : 'Not anchored yet: the next tracker box commits the latest changes, usually within 5 to 15 minutes; up to about 30 when Ergo testnet blocks are slow (as since Nov 16).');
    if (c.cap) items.push(c.cap.used_up ? `Today's ${fmt(c.cap.limit)} tracker boxes are used up: nothing new is committed until 00:00 UTC.`
      : `Today: ${fmt(c.cap.today)} of ${fmt(c.cap.limit)} tracker boxes. The cap resets at 00:00 UTC.`);
    const held = c.reserves.reduce((s, r) => s + r.nanoerg, 0), backs = c.reserves.filter(r => r.backs > 0), backed = backs.reduce((s, r) => s + r.backs, 0);
    const owed = [...st.edges.values()].reduce((s, e) => s + Math.max(0, e.amount), 0);
    items.push(`${many(c.reserves.length, 'reserve')} ${c.reserves.length === 1 ? 'holds' : 'hold'} ${terg(held, {total: true})}. ${backs.length === 1 ? 'One backs' : backs.length ? `${fmt(backs.length)} back` : 'None backs'} notes owed now: ${terg(backed, {total: true})} of the ${terg(owed, {total: true})} owed. A note can be redeemed only against a reserve locked under the key that signed it.`);
    ul.replaceChildren(...items.map(t => H('li', null, t)));
    const links = H('li', 'links');
    for (const [href, text] of [[c.links.nft, 'The tracker NFT'], [c.links.address, 'The tracker on the explorer']]) {
      if (!href) continue;
      const a = H('a', null, text); a.href = href; a.rel = 'noopener noreferrer'; links.append(a);
    }
    if (links.children.length) ul.append(links);
    sec.hidden = false;
  }

  // Copy for the join command, as on /start and the home: the command exactly as written (its spans and its break point
  // add nothing to the text), described by the command, and what happened said in the page's status line, which screen
  // readers announce (a button's own text changing is not).
  const copy = document.querySelector('.join button.copy');
  if (copy && $('join-cmd')) {
    copy.setAttribute('aria-describedby', 'join-cmd');
    copy.addEventListener('click', async () => {
      const say = $('announce');
      try { await navigator.clipboard.writeText($('join-cmd').textContent); copy.textContent = 'Copied'; say.textContent = 'Copied.'; }
      catch { copy.textContent = 'Select and copy'; say.textContent = 'Copy failed: select the text and copy it.'; }
      const said = say.textContent;     // cleared after, so the next Copy is announced again; a loop said meanwhile stays
      setTimeout(() => { copy.textContent = 'Copy'; if (say.textContent === said) say.textContent = ''; }, 2000);
    });
  }

  new ResizeObserver(() => { if (st.ready) graph(); }).observe(box);
  status();
  readSlow();
  poll();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') start();
