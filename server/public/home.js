// Valun home (public/home.html): the live view in the hero, and the Copy button of the one command on the page.
//
// The live view reads four public same-origin routes, with no token and credentials omitted: GET
// /pilot/v1/participants?all=1, /pilot/v1/ledger, /pilot/v1/loops and /pilot/v1/clearing. It reads once at start, then
// at most once a minute, and only while the tab is visible, the view is on screen and nobody has paused it; the
// directory (participants, the heaviest read) at most once in 5 minutes. After failed reads it waits longer, up to 5
// minutes. Many visitors may share one address, and so one read budget; the server's burst cache serves them together.
//
// What it draws: every agent as a point on a sphere (placed by a stable hash of its handle), every open IOU as a line
// from issuer to holder (brighter for more, in tERG), the operator's four agents ringed in amber, the latest loops as
// faint outlines and the newest one with the rainbow ring (left out where it would hide the spotlight's arrow). One real
// IOU at a time is the spotlight: an arrow from issuer to holder, both named on the sphere and in words beneath it ("X
// holds Y's IOU for 0.003 tERG"), with who runs each; the sphere turns to face it, and every 8 s the spotlight moves to
// the next of the latest IOUs. The bar says so: "Testnet records, one real IOU at a time, read 01:12 UTC", with a Live tag
// only while that is true (Paused, Offline). "Show as a list" says the same in text. Pause stops the motion, the
// spotlight and the reads; Next steps the spotlight and says the new one in a status line. Reduced motion: no turning
// and no automatic spotlight (Next steps it). Off screen or hidden: nothing moves and nothing is read. No data: the mark.
// The pure parts are exported for the tests (test/close-the-loop.test.mjs); the page starts only in a browser.

import {whoRuns, groupOf} from './who.js';

export const REFRESH_MS = 60_000;          // the live reads, at most once a minute
export const REFRESH_MAX_MS = 300_000;     // after failed reads, at most 5 minutes apart
export const PEOPLE_MS = 300_000;          // the directory, at most once in 5 minutes
export const SPOT_MS = 8_000;              // the spotlight moves on
export const DRIFT_MS = 240_000;           // between spotlights the sphere drifts, one turn in 4 minutes
export const LATEST_SHOWN = 12;            // the IOUs the spotlight and the list go through, newest first
const LOOPS_SHOWN = 6;
export const KIND_WORDS = Object.freeze({operator: 'operator-run', team: 'team test'});
// How an IOU last changed, from its timestamp's last three digits (ms mod 1000, GET /pilot/v1/info novation): 997 a new
// IOU (a payment), 998 a set-off (a loop cleared part of it), 999 a debt transfer (it was passed on).
export const HOW = Object.freeze({997: 'New IOU', 998: 'A loop cleared part of it', 999: 'Passed on'});
// A line's brightness reads its amount in these steps, as public/network.js sizes its arrows (fix inbox #72): in raw
// nanoERG every line sat at the brightest.
const SIZE_SCALE = Object.freeze({nanoERG: 1_000_000});
const TILT = 0.36, PERSP = 3.4;
const RAINBOW = ['#ff5a5f', '#ffc145', '#3ddc97', '#4f7cff', '#9b5cff'];

// A loop's path as text: 'ana → bo → cyd → ana'.
export const loopPath = loop => {
  const names = (loop?.members || []).map(m => m?.handle ?? 'unknown');
  return names.length ? [...names, names[0]].join(' → ') : '';
};
// How long ago, in words: an ISO time or epoch milliseconds.
export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - (typeof t === 'number' ? t : Date.parse(t))) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
// A time of day in UTC: '01:12 UTC'.
export function utcTime(ms) {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return Number.isFinite(d.getTime()) ? `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC` : '';
}

// A 32-bit hash of a string (FNV-1a with a final mix), stable across browsers and visits.
export function hash32(s, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
// A handle's point on the unit sphere (y is the vertical axis), spread evenly by area: the same handle, the same point.
export function spherePoint(handle) {
  const u = hash32(handle) / 4294967296, v = (hash32(handle, 0x9e3779b9) + 0.5) / 4294967296;
  const y = 1 - 2 * v, r = Math.sqrt(Math.max(0, 1 - y * y)), th = 2 * Math.PI * u;
  return {x: r * Math.cos(th), y, z: r * Math.sin(th)};
}
const participantList = p => (Array.isArray(p) ? p : Array.isArray(p?.participants) ? p.participants : null);
const HANDLE_RE = /^[a-z][a-z0-9_-]{2,23}$/;

// The handles the live list links to their agent pages (/agent/<handle>): those the directory lists, but the ones the
// operator unlisted, which have no page (lib/pilot/agents.mjs agentPageShown: a link to one was a 404).
// A handle the last directory read did not name is not linked either, as on /network (public/network.js agentEl). Every
// handle the list shows is in the ledger, so it has had a key: for those, listed is the server's whole rule.
export function pageHandles(participants) {
  return new Set((participantList(participants) || []).filter(p => p && !p.unlisted && typeof p.handle === 'string' && HANDLE_RE.test(p.handle)).map(p => p.handle));
}

// Who runs an agent, as far as the public record says: 'operator' (the operator's four, or flagged operator_run),
// 'team' (one of our own test agents, by its name, or unlisted), or null (no label: almost all of those are ours too, but
// a newcomer's agent is among them).
export function kindOf(handle, p = null) {
  if (typeof handle !== 'string' || !handle) return null;
  const group = groupOf(whoRuns({...(p || {}), handle}));      // public/who.js: the rule /network and the server's pages use
  return group === 'operator' ? 'operator' : group === 'team' ? 'team' : null;
}

// The open IOUs of the ledger, one per issuer -> holder pair (a pair whose issuer changed keys can have several notes:
// added up), each with what is still owed, when it last changed and how.
export function openIOUs(ledger) {
  const m = new Map();
  for (const n of Array.isArray(ledger?.notes) ? ledger.notes : []) {
    const issuer = n?.issuer_handle, holder = n?.recipient_handle, amount = Number(n?.outstanding);
    if (typeof issuer !== 'string' || typeof holder !== 'string' || issuer === holder || !(amount > 0)) continue;
    const key = `${issuer}>${holder}`, ts = Number(n.timestamp) || 0;
    const e = m.get(key) ?? {key, issuer, holder, amount: 0, ts: -1, how: null};
    e.amount += amount;
    if (ts > e.ts) { e.ts = ts; e.how = HOW[ts % 1000] ?? null; }
    m.set(key, e);
  }
  return [...m.values()];
}
// The latest of them, newest first (the spotlight's and the list's order).
export const latestIOUs = (ious, n = LATEST_SHOWN) => [...ious].sort((a, b) => b.ts - a.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, n);

const fmt = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const count = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
// Whole nanoERG as tERG, exact, by integer arithmetic: 121475000 -> "0.121475" (public/network.js tergText, the same).
export function tergText(n) {
  const v = BigInt(Math.trunc(Number(n) || 0)), neg = v < 0n, a = neg ? -v : v;
  const frac = String(a % 1000000000n).padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / 1000000000n).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
// Whole nanoERG as tERG rounded to `digits` decimals (half up, by integer arithmetic), as people read a total:
// 373823000 -> "0.374" (3), 1500000 -> "0.0015" (4). Above zero but too small to show: "<0.001".
export function tergRounded(n, digits = 3) {
  const v = BigInt(Math.trunc(Number(n) || 0)), neg = v < 0n, a = neg ? -v : v, q = 10n ** BigInt(9 - digits), units = (a + q / 2n) / q;
  if (units === 0n && a > 0n) return `${neg ? '-' : ''}<0.${'0'.repeat(digits - 1)}1`;
  const s = units.toString().padStart(digits + 1, '0'), frac = s.slice(-digits).replace(/0+$/, '');
  return `${neg ? '-' : ''}${BigInt(s.slice(0, -digits)).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
// An amount as people read it: nanoERG of Ergo testnet in tERG, rounded. An amount whose unit no read named as nanoERG
// shows no number: in the wrong unit it would be read 1,000,000 times too large (the stats line once said "104,475,000
// credits cancelled" for 0.104475 tERG).
export function money(n, unit, digits = 3) {
  const known = n != null && Number.isFinite(Number(n)) && unit === 'nanoERG';
  return {n: known ? tergRounded(n, digits) : '–', u: 'tERG'};
}
// An open IOU's line brightness before depth: 0.15 for 0.001 tERG, 0.33 for 0.021 (at most 0.5); a neutral 0.18 when the
// unit is not known.
export function lineAlpha(amount, unit) {
  if (!(unit in SIZE_SCALE)) return 0.18;
  return Math.min(0.5, 0.1 + 0.05 * Math.sqrt(Math.max(0, Number(amount) || 0) / SIZE_SCALE[unit]));
}

// The counts under the picture (null where a read failed), and the unit the amount is in: each read names its own
// (`unit`: nanoERG on the testnet). The amount is the unit-neutral `cleared` (fix inbox #32); `cleared_PC` is its
// deprecated alias, read only when the neutral name is missing.
export function stats({participants, ledger, loops, clearing} = {}) {
  const list = participantList(participants);
  return {agents: list ? list.length : null, open: ledger ? openIOUs(ledger).length : null,
    loops: clearing?.totals?.setoffs_applied ?? (Array.isArray(loops?.loops) ? loops.loops.length : null),
    cleared: clearing?.totals?.cleared ?? clearing?.totals?.cleared_PC ?? null, unit: clearing?.unit ?? loops?.unit ?? ledger?.unit ?? null};
}
export function statsLine(s) {
  const m = money(s.cleared, s.unit);
  return `${count(s.agents, 'agent')} and ${count(s.open, 'open IOU')} now. ${count(s.loops, 'loop')} cleared so far${m.n === '–' ? '.' : `, cutting ${m.n} ${m.u} of IOUs in all.`}`;
}
// The spotlight's words for one open IOU: "sandbox-exact holds basis-x-t33f's IOU for 0.003 tERG."
export function spotWords(r, unit) {
  const m = money(r.amount, unit, 4);
  return {holder: r.holder, issuer: r.issuer, amount: `${m.n} ${m.u}`, text: `${r.holder} holds ${r.issuer}'s IOU for ${m.n} ${m.u}.`};
}
// The newest loop that cleared (the one with the rainbow ring), in words.
export function newestLoop(loops, now = Date.now()) {
  const l = (Array.isArray(loops?.loops) ? loops.loops : []).find(x => typeof x?.id === 'string' && /^vs_[0-9a-f]{16}$/.test(x.id));
  if (!l) return null;
  const m = money(l.each ?? l.each_PC, loops.unit, 4);
  return {id: l.id, path: loopPath(l), each: `${m.n} ${m.u}`, when: ago(l.applied_at, now)};
}

// What the sphere draws: the points, the open IOUs between them, the latest loops (newest first).
export function constellation({participants, ledger, loops} = {}) {
  const nodes = new Map();
  const add = (handle, p = null) => {
    if (typeof handle !== 'string' || !handle || nodes.has(handle)) return;
    nodes.set(handle, {handle, kind: kindOf(handle, p), p: spherePoint(handle)});
  };
  for (const p of participantList(participants) || []) add(p?.handle, p);
  const ious = openIOUs(ledger), unit = ledger?.unit ?? null;
  for (const e of ious) { add(e.issuer); add(e.holder); }   // an agent newer than the last directory read
  const edges = ious.map(e => {
    const a = nodes.get(e.issuer).p, b = nodes.get(e.holder).p, sx = a.x + b.x, sy = a.y + b.y, sz = a.z + b.z, l = Math.hypot(sx, sy, sz);
    // The curve's control point, so that it passes through the surface point halfway along the shortest way round the sphere.
    const c = l > 0.2 ? {x: 2 * sx / l - sx / 2, y: 2 * sy / l - sy / 2, z: 2 * sz / l - sz / 2} : {x: sx / 2, y: sy / 2, z: sz / 2};
    return {...e, a, b, c, alpha: lineAlpha(e.amount, unit)};
  });
  const rings = (Array.isArray(loops?.loops) ? loops.loops : []).slice(0, LOOPS_SHOWN).map(l => {
    const pts = (l?.members || []).map(m => nodes.get(m?.handle)?.p).filter(Boolean);
    if (pts.length < 2) return null;
    const n = pts.length, centre = {x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n, z: pts.reduce((s, p) => s + p.z, 0) / n};
    return {id: l.id, pts, centre};
  }).filter(Boolean);
  return {nodes: [...nodes.values()], edges, rings};
}
// The turn about the vertical axis that brings an IOU's middle to face the viewer (the projection below).
export function spotAngle(e) {
  const x = e.a.x + e.b.x, z = e.a.z + e.b.z;
  return Math.hypot(x, z) > 1e-6 ? Math.atan2(-x, z) : Math.atan2(-e.a.x, e.a.z);
}
// The shortest signed turn from angle a to angle b, in (-π, π].
export function turn(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
// The middle of the spotlight's curve on the picture (a quadratic from a through control point c to b, at its half), and
// whether a point is clear of it by more than r px: the newest loop's glow and ring are left out where they would hide
// the spotlight's arrow (most IOUs are between the two practice agents, whose points can sit close together).
export const curveMiddle = (a, c, b) => ({x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4});
export const clearOf = (k, mid, r) => !mid || Math.hypot(k.x - mid.x, k.y - mid.y) > r;
// What a screen reader hears after Next (the spotlight's words are not a live region: the spotlight moves by itself).
export const nextSaid = (r, i, n, unit) => (r ? `IOU ${i + 1} of ${n}: ${spotWords(r, unit).text}` : 'No open IOUs right now.');
// The live view's label: what it reads and when ("Testnet records, one real IOU at a time, read 01:12 UTC"), and its tag:
// Live only while what is shown came from a read that answered and nothing holds it; Paused; Offline while the reads
// fail after one answered; none before any read answered. The tag alone says Paused (a screen reader read the label's
// own "Paused" right after it: "Paused Paused; testnet records").
export function readLabel({readAt = 0, paused = false, failures = 0} = {}) {
  if (!readAt) return {text: failures ? 'Testnet records: cannot be read right now' : 'Testnet records: reading…', tag: null};
  return {lead: 'Testnet records, one real IOU at a time, ', read: `read ${utcTime(readAt)}`,
    tail: failures ? ' (retrying)' : '', tag: paused ? 'Paused' : failures ? 'Offline' : 'Live'};
}
// When the next read is due, in ms, or null for none: none while paused, hidden or off screen (each of those ends with a
// read when the last is older than REFRESH_MS); after failed reads, doubling, up to REFRESH_MAX_MS.
export function nextReadIn({paused = false, hidden = false, onScreen = true, failures = 0} = {}) {
  if (paused || hidden || !onScreen) return null;
  return Math.min(REFRESH_MAX_MS, REFRESH_MS * 2 ** Math.min(Math.max(0, failures), 3));
}

// ---------------------------------------------------------------------------------------------------------------
// Drawing (browser only).
function project(p, angle, cx, cy, R) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const x = p.x * ca + p.z * sa, z = -p.x * sa + p.z * ca;
  const ct = Math.cos(TILT), st = Math.sin(TILT), y = p.y * ct - z * st, z2 = p.y * st + z * ct;
  const s = PERSP / (PERSP - z2);
  return {x: cx + R * x * s, y: cy - R * y * s, z: z2, s};
}
const white = a => `rgba(238, 240, 244, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const amber = a => `rgba(242, 180, 90, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

function drawGlow(ctx, x, y, r, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255, 255, 255, ${a})`); g.addColorStop(0.22, `rgba(255, 255, 255, ${a * 0.45})`); g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
}
function rainbowStroke(ctx, x, y, r) {
  let g;
  if (typeof ctx.createConicGradient === 'function') {
    g = ctx.createConicGradient(-Math.PI / 2, x, y);
    RAINBOW.forEach((c, i) => g.addColorStop(i / RAINBOW.length, c)); g.addColorStop(1, RAINBOW[0]);
  } else {
    g = ctx.createLinearGradient(x - r, y, x + r, y);
    RAINBOW.forEach((c, i) => g.addColorStop(i / (RAINBOW.length - 1), c));
  }
  return g;
}
const LABEL_FONT = '400 12px "JetBrains Mono", ui-monospace, Consolas, monospace';
// A handle on the sphere, in a dark box, kept inside the picture: [x, y] of its box's left and middle.
function placeLabel(ctx, text, q, w, h, below) {
  const tw = ctx.measureText(text).width, x = Math.min(Math.max(6, q.x - tw / 2), w - tw - 12);
  const y = Math.min(Math.max(14, below ? q.y + 20 : q.y - 18), h - 14);
  return {x, y, tw};
}
function drawLabel(ctx, text, {x, y, tw}) {
  ctx.fillStyle = 'rgba(5, 6, 8, 0.88)'; ctx.fillRect(x - 6, y - 10, tw + 12, 20);
  ctx.strokeStyle = 'rgba(94, 101, 115, 1)'; ctx.lineWidth = 1; ctx.strokeRect(x - 5.5, y - 9.5, tw + 11, 19);
  ctx.fillStyle = white(1); ctx.fillText(text, x, y);
}

function drawSky(ctx, w, h, m, angle, now, {spot, hover, fresh, motion}) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4, P = new Map();
  for (const n of m.nodes) P.set(n.handle, project(n.p, angle, cx, cy, R));
  const spotted = spot && P.has(spot.issuer) && P.has(spot.holder);
  const mid = spotted ? curveMiddle(P.get(spot.issuer), project(spot.c, angle, cx, cy, R), P.get(spot.holder)) : null;
  ctx.strokeStyle = white(0.08); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R * PERSP / Math.sqrt(PERSP * PERSP - 1), 0, 2 * Math.PI); ctx.stroke();
  // the open IOUs; one that changed since the last read glows for a while (motion only for real changes)
  for (const e of m.edges) {
    if (spot && e.key === spot.key) continue;
    const a = P.get(e.issuer), b = P.get(e.holder), c = project(e.c, angle, cx, cy, R);
    const depth = 0.3 + 0.7 * ((a.z + b.z) / 2 + 1) / 2, since = fresh.get(e.key);
    const lit = motion && since != null && now - since < 12_000 ? 0.6 * (1 - (now - since) / 12_000) : 0;
    ctx.strokeStyle = white((e.alpha + lit) * depth); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
  }
  // the latest loops, oldest first so the newest is on top; the newest with its glow and the rainbow ring
  for (let i = m.rings.length - 1; i >= 0; i--) {
    const r = m.rings[i], pts = r.pts.map(p => project(p, angle, cx, cy, R)), newest = i === 0;
    ctx.strokeStyle = white(newest ? 0.32 : 0.1 + 0.025 * (m.rings.length - i)); ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    if (newest) {
      const k = project(r.centre, angle, cx, cy, R), rr = R * 0.075 * k.s, gr = R * 0.15 * k.s;
      if (clearOf(k, mid, Math.max(24, gr))) {   // not over the spotlight's arrow
        drawGlow(ctx, k.x, k.y, gr, 0.5);
        ctx.strokeStyle = rainbowStroke(ctx, k.x, k.y, rr); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(k.x, k.y, rr, 0, 2 * Math.PI); ctx.stroke();
      }
    }
  }
  // the points, back to front; the operator's agents ringed in amber
  const order = m.nodes.map(n => ({n, q: P.get(n.handle)})).sort((x, y) => x.q.z - y.q.z);
  for (const {n, q} of order) {
    const depth = (q.z + 1) / 2;
    ctx.fillStyle = white(0.28 + 0.72 * depth);
    ctx.beginPath(); ctx.arc(q.x, q.y, (n.kind === 'operator' ? 2.4 : 1.6) * q.s, 0, 2 * Math.PI); ctx.fill();
    if (n.kind === 'operator') {
      ctx.strokeStyle = amber(0.35 + 0.65 * depth); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(q.x, q.y, 5 * q.s, 0, 2 * Math.PI); ctx.stroke();
    }
  }
  ctx.font = LABEL_FONT; ctx.textBaseline = 'middle';
  // the spotlight: an arrow from issuer to holder, both named
  if (spotted) {
    const a = P.get(spot.issuer), b = P.get(spot.holder), c = project(spot.c, angle, cx, cy, R);
    ctx.strokeStyle = white(0.95); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
    const dx = b.x - c.x, dy = b.y - c.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, tx = b.x - ux * 6.5, ty = b.y - uy * 6.5;
    ctx.beginPath(); ctx.moveTo(tx - ux * 9 - uy * 4.5, ty - uy * 9 + ux * 4.5); ctx.lineTo(tx, ty); ctx.lineTo(tx - ux * 9 + uy * 4.5, ty - uy * 9 - ux * 4.5); ctx.stroke();
    for (const q of [a, b]) { ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(q.x, q.y, 5.5, 0, 2 * Math.PI); ctx.stroke(); }
    // the two names: the upper one above its point, the lower one below, so they part
    const aBelow = a.y > b.y || (a.y === b.y && a.x > b.x), la = placeLabel(ctx, spot.issuer, a, w, h, aBelow), lb = placeLabel(ctx, spot.holder, b, w, h, !aBelow);
    drawLabel(ctx, spot.issuer, la); drawLabel(ctx, spot.holder, lb);
  }
  if (hover && P.has(hover) && hover !== spot?.issuer && hover !== spot?.holder) {
    const q = P.get(hover);
    ctx.strokeStyle = white(0.9); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI); ctx.stroke();
    drawLabel(ctx, hover, placeLabel(ctx, hover, q, w, h, q.y < 30));
  }
  return P;
}

function start() {
  const $ = id => document.getElementById(id);
  const getJson = async path => {
    const r = await fetch(path, {cache: 'no-store', credentials: 'omit', headers: {accept: 'application/json'}});
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const canvas = $('sky'), box = $('sky-box'), fig = $('live'), ctx = canvas?.getContext?.('2d') ?? null;
  // The controls and the Live tag are hidden in the HTML (without the script nothing there is live); the script shows
  // them once a read has answered (renderRead).
  const pause = $('sky-pause'), next = $('sky-next'), ctl = $('sky-ctl'), tag = $('sky-tag');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motion = () => !reduced?.matches;
  // st: what was read and what is shown. kinds: handle -> 'operator' | 'team' | null; pages: the handles linked to their
  // agent pages (pageHandles of the last directory read).
  const st = {data: {}, people: null, peopleAt: 0, pages: new Set(), m: null, kinds: new Map(), latest: [], spot: 0, unit: null, readAt: 0, failures: 0,
    paused: false, held: false, onScreen: true, hover: null, fresh: new Map(), seen: null};
  let angle = 0.7, target = 0.7, last = 0, raf = 0, w = 0, h = 0, positions = new Map(), readTimer = 0, spotTimer = 0, reading = false;

  const spotEdge = () => { const r = st.latest[st.spot]; return r ? st.m?.edges.find(e => e.key === r.key) ?? null : null; };
  function draw(now = performance.now()) {
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (st.m?.nodes.length) positions = drawSky(ctx, w, h, st.m, angle, now, {spot: spotEdge(), hover: st.hover, fresh: st.fresh, motion: motion() && !st.paused});
    else positions = new Map();
  }
  const moving = () => motion() && !st.paused;
  const animating = () => moving() && st.onScreen && !document.hidden && !!st.m?.nodes.length;
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    if (moving()) { target += (dt / DRIFT_MS) * 2 * Math.PI; angle += turn(angle, target) * (1 - Math.exp(-dt / 900)); }
    draw(now);
    if (animating()) raf = requestAnimationFrame(frame); else last = 0;
  }
  const kick = () => { if (animating()) { if (!raf) raf = requestAnimationFrame(frame); } else draw(); };
  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    draw();
  }

  // ---- the words under the picture ----
  const tagFor = kind => el('span', `tag ${kind}`, KIND_WORDS[kind]);
  const kindOfHandle = handle => (st.kinds.has(handle) ? st.kinds.get(handle) : kindOf(handle));
  // A handle, linked to its agent page only when the server shows one (st.pages); otherwise named as text.
  function agentLink(handle) {
    if (!st.pages.has(handle)) return el('span', 'h', handle);
    const a = el('a', null, handle); a.href = `/agent/${encodeURIComponent(handle)}`; return a;
  }
  function renderRead() {
    // The time of the last read that answered; after it, a failed read says so (what is shown is that read's).
    const t = $('sky-read'), l = readLabel(st);
    if (tag) {
      tag.hidden = !l.tag;
      if (l.tag) { tag.textContent = l.tag; tag.classList.toggle('live', l.tag === 'Live'); }
    }
    if (ctl && st.readAt) ctl.hidden = false;
    if (!t) return;
    if (st.readAt) t.replaceChildren(l.lead, el('span', 'nw', l.read), l.tail);
    else t.textContent = l.text;
  }
  function renderSpot() {
    const spot = $('spot'), meta = $('spot-meta'), r = st.latest[st.spot];
    if (!spot || !meta) return;
    if (!r) {
      spot.textContent = st.readAt ? 'No open IOUs right now.' : st.failures ? 'The network cannot be read right now. Trying again soon.' : 'Reading the network…';
      meta.replaceChildren();
      return;
    }
    const words = spotWords(r, st.unit);
    spot.replaceChildren(el('span', 'h', words.holder), ' holds ', el('span', 'h', words.issuer), "'s IOU for ", el('span', 'amt', words.amount), '.');
    const parts = [];
    for (const [role, handle] of [['holder', r.holder], ['issuer', r.issuer]]) {
      const kind = kindOfHandle(handle);
      if (kind) parts.push(el('span', 'role', role), tagFor(kind));
    }
    parts.push(el('span', 'when', `${r.how ?? 'Changed'}, ${ago(r.ts)}`));
    meta.replaceChildren(...parts.flatMap((x, i) => (i ? [' ', x] : [x])));   // spaced, so they are read apart
  }
  function renderList() {
    const ol = $('latest');
    if (!ol) return;
    ol.replaceChildren();
    if (!st.latest.length) {
      const li = el('li'); li.append(el('span', 'none', st.readAt ? 'No open IOUs right now.' : st.failures ? 'The ledger cannot be read right now.' : 'Reading the ledger…')); ol.append(li);
      return;
    }
    const labelled = handle => { const k = kindOfHandle(handle); return k ? [el('span', `k ${k}`, ` ${KIND_WORDS[k]}`)] : []; };
    for (const r of st.latest) {
      const li = el('li'), pair = el('span', 'pair'), arw = el('span', 'arw', ' → ');
      arw.setAttribute('aria-hidden', 'true');
      pair.append(agentLink(r.issuer), ...labelled(r.issuer), arw, el('span', 'vh', ' owes '), agentLink(r.holder), ...labelled(r.holder));
      li.append(pair, ' ', el('span', 'amt', spotWords(r, st.unit).amount), ' ', el('span', 'how', `${r.how ?? 'Changed'}, ${ago(r.ts)}`));
      ol.append(li);
    }
  }
  function renderCounts() {
    const s = $('stats'), l = $('sky-loop');
    if (s) s.textContent = st.readAt ? statsLine(stats(st.data)) : st.failures ? 'The network cannot be read right now; the page tries again soon.' : 'Reading the network…';
    if (!l) return;
    const n = newestLoop(st.data.loops);
    if (!n) { l.replaceChildren(); return; }
    const a = el('a', null, 'its loop card');
    a.href = `/loop/${n.id}`;
    l.replaceChildren(`The newest loop that cleared, with the rainbow ring: ${n.path}, ${n.each} off each IOU in it, ${n.when} (`, a, ').');
  }
  const renderAll = () => { renderRead(); renderSpot(); renderList(); renderCounts(); };
  const legend = $('sky-legend');
  if (legend) legend.hidden = false;

  // ---- the spotlight ----
  function setSpot(i) {
    st.spot = st.latest.length ? ((i % st.latest.length) + st.latest.length) % st.latest.length : 0;
    renderSpot();
    const e = spotEdge();
    if (e) { target = spotAngle(e); if (!moving()) angle = target; }
    kick();
  }
  function scheduleSpot() {
    clearTimeout(spotTimer); spotTimer = 0;
    if (moving() && !st.held && st.onScreen && !document.hidden && st.latest.length > 1)
      spotTimer = setTimeout(() => { spotTimer = 0; setSpot(st.spot + 1); scheduleSpot(); }, SPOT_MS);
  }

  // ---- the reads ----
  function scheduleRead() {
    clearTimeout(readTimer); readTimer = 0;
    const d = nextReadIn({paused: st.paused, hidden: document.hidden, onScreen: st.onScreen, failures: st.failures});
    if (d != null) readTimer = setTimeout(refresh, d);
  }
  const stale = () => !st.readAt || Date.now() - st.readAt >= REFRESH_MS;
  // The IOUs that changed since the last read (their newest timestamp moved): they glow for a while.
  function markFresh(ious) {
    const now = performance.now(), seen = new Map(ious.map(e => [e.key, e.ts]));
    if (st.seen) for (const [k, ts] of seen) if (st.seen.get(k) !== ts) st.fresh.set(k, now);
    for (const [k, t] of st.fresh) if (now - t > 60_000) st.fresh.delete(k);
    st.seen = seen;
  }
  async function refresh() {
    clearTimeout(readTimer); readTimer = 0;
    if (reading) return;
    reading = true;
    try {
      const people = !st.people || Date.now() - st.peopleAt >= PEOPLE_MS;
      const [participants, ledger, loops, clearing] = await Promise.all([people ? getJson('/pilot/v1/participants?all=1').catch(() => null) : null,
        getJson('/pilot/v1/ledger').catch(() => null), getJson('/pilot/v1/loops').catch(() => null), getJson('/pilot/v1/clearing').catch(() => null)]);
      if (participants) { st.people = participants; st.peopleAt = Date.now(); st.pages = pageHandles(participants); }
      if (participants || ledger || loops || clearing) { st.failures = 0; st.readAt = Date.now(); } else st.failures += 1;
      st.data = {participants: st.people, ledger: ledger ?? st.data.ledger ?? null, loops: loops ?? st.data.loops ?? null, clearing: clearing ?? st.data.clearing ?? null};
      st.unit = st.data.ledger?.unit ?? st.data.loops?.unit ?? st.data.clearing?.unit ?? null;
      if (st.data.participants || st.data.ledger) {
        const before = st.latest[st.spot]?.key;
        st.m = constellation(st.data);
        st.kinds = new Map(st.m.nodes.map(n => [n.handle, n.kind]));
        const ious = openIOUs(st.data.ledger);
        if (ledger) markFresh(ious);
        st.latest = latestIOUs(ious);
        const keep = st.latest.findIndex(r => r.key === before);
        if (st.m.nodes.length && ctx) box?.classList.add('drawn');   // the mark stays where nothing can be drawn
        renderAll();
        setSpot(keep >= 0 ? keep : 0);
      } else renderAll();
    } finally {
      reading = false;
      scheduleRead(); scheduleSpot();
    }
  }

  // ---- the controls, shown once a read has answered ----
  pause?.addEventListener('click', () => {
    st.paused = !st.paused;
    pause.textContent = st.paused ? 'Resume' : 'Pause';
    renderRead();
    if (st.paused) { if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf); raf = 0; last = 0; clearTimeout(readTimer); readTimer = 0; clearTimeout(spotTimer); spotTimer = 0; draw(); }
    else { if (stale()) refresh(); else { scheduleRead(); scheduleSpot(); } kick(); }
  });
  // Next: the new spotlight is said once, in a status line (focus stays on Next, and while focus is in the view nothing
  // moves by itself, so nothing else is said).
  const said = $('sky-said');
  next?.addEventListener('click', () => {
    setSpot(st.spot + 1); scheduleSpot();
    if (said) said.textContent = nextSaid(st.latest[st.spot], st.spot, st.latest.length, st.unit);
  });
  // Hovering over the view, or moving the keyboard focus into it, holds the spotlight where it is.
  const hold = on => { st.held = on; scheduleSpot(); };
  fig?.addEventListener('pointerenter', () => hold(true));
  fig?.addEventListener('pointerleave', () => hold(false));
  fig?.addEventListener('focusin', () => hold(true));
  fig?.addEventListener('focusout', () => hold(false));

  if (canvas) {
    resize();
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas); else window.addEventListener?.('resize', resize);
    // On screen: any part of the view, the sphere or its words (on a phone the words are below the sphere).
    if (typeof IntersectionObserver === 'function') new IntersectionObserver(es => {
      const was = st.onScreen;
      st.onScreen = es.some(e => e.isIntersecting);
      if (st.onScreen && !was && !st.paused && stale()) refresh(); else scheduleRead();
      scheduleSpot(); kick();
    }).observe(fig ?? canvas);
    // Reduced motion turned on while the sphere was turning: it stops facing the spotlight.
    reduced?.addEventListener?.('change', () => { if (!motion()) angle = target; scheduleSpot(); kick(); });
    const pick = ev => {
      const r = canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
      let best = null, bd = 16 * 16;
      for (const [handle, q] of positions) { const d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd && q.z > -0.6) { bd = d; best = handle; } }
      if (best !== st.hover) { st.hover = best; if (!raf) draw(); }
    };
    let hoverTimer = 0;
    canvas.addEventListener('pointermove', pick);
    canvas.addEventListener('pointerdown', ev => { pick(ev); clearTimeout(hoverTimer); if (ev.pointerType !== 'mouse') hoverTimer = setTimeout(() => { st.hover = null; if (!raf) draw(); }, 2500); });
    canvas.addEventListener('pointerleave', () => { st.hover = null; if (!raf) draw(); });
    document.fonts?.ready?.then(() => { if (!raf) draw(); });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(readTimer); readTimer = 0; clearTimeout(spotTimer); spotTimer = 0; return; }
    if (!st.paused && stale()) refresh(); else scheduleRead();
    scheduleSpot(); kick();
  });

  // The command block: the command shown whole (wrapCommand); Copy copies it exactly as written, and says so in the
  // page's status line too (a button's new text alone is not announced).
  const texts = new Map(), copySaid = $('copy-said');
  for (const code of document.querySelectorAll('.cmd pre > code')) texts.set(code.id, wrapCommand(code));
  for (const b of document.querySelectorAll('button.copy')) {
    b.addEventListener('click', async () => {
      const text = texts.get(b.dataset.copy) ?? $(b.dataset.copy)?.textContent ?? '';
      let ok = true;
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { ok = false; b.textContent = 'Select and copy'; }
      if (copySaid) copySaid.textContent = ok ? 'Copied.' : 'Copy failed: select the text and copy it.';
      setTimeout(() => { b.textContent = 'Copy'; if (copySaid) copySaid.textContent = ''; }, 2000);
    });
  }
  renderAll();
  refresh();
}

// A command block's text, shown whole: one line per command, wrapped only at its spaces (never inside a flag, a path or
// a URL) and the lines after its first indented (site.css .cmd code.wrapped). Returns the text as written, which Copy
// copies. public/start.js has the same function for /start (this file imports nothing: its tests run it as a script).
export function wrapCommand(code, doc = document) {
  const text = code.textContent;
  code.replaceChildren(...text.split('\n').map(line => {
    const ln = doc.createElement('span');
    ln.className = 'ln';
    line.split(' ').forEach((word, i) => {
      if (i) ln.append(' ');
      const w = doc.createElement('span');
      w.className = 'w';
      w.textContent = word;
      ln.append(w);
    });
    return ln;
  }));
  code.classList.add('wrapped');
  return text;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') start();
