// Valun landing (public/home.html): the live constellation, its stats line and the recent loops, from four public
// same-origin reads (GET /pilot/v1/participants, /pilot/v1/ledger, /pilot/v1/loops, /pilot/v1/clearing). No tokens, no
// libraries, text nodes only. It reads once at start and then every 30 s while the tab is visible (many visitors may
// share one address, and so one read budget; the server's burst cache serves them together).
//
// The constellation: every participant is a point on a sphere, placed by a stable hash of its handle; the sphere turns
// once in about 90 s. Open promises (notes with outstanding > 0) are thin lines from issuer to recipient; the latest
// loops that cancelled are faint polygons with a glow at their centre, the newest with one rainbow ring. Reduced
// motion: one still frame. Off-screen or hidden: no animation. No data: the mark, drawn large.
// The pure parts are exported for the tests (test/close-the-loop.test.mjs); the page starts only in a browser.

export const REFRESH_MS = 30_000;
export const TURN_MS = 90_000;
const LOOPS_SHOWN = 6;
const TILT = 0.36, PERSP = 3.4;
const SANDBOX_AGENTS = new Set(['sandbox-exact', 'sandbox-mallory']);
const RAINBOW = ['#ff5a5f', '#ffc145', '#3ddc97', '#4f7cff', '#9b5cff'];

// A loop's path as text: 'ana → bo → cyd → ana'.
export const loopPath = loop => {
  const names = (loop?.members || []).map(m => m?.handle ?? 'unknown');
  return names.length ? [...names, names[0]].join(' → ') : '';
};
// How long ago, in words.
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
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
// The open promises of the ledger: notes with outstanding > 0, issuer -> recipient, by handle.
export function openPromises(ledger) {
  const notes = Array.isArray(ledger?.notes) ? ledger.notes : [];
  return notes.filter(n => Number(n?.outstanding) > 0 && typeof n.issuer_handle === 'string' && typeof n.recipient_handle === 'string' && n.issuer_handle !== n.recipient_handle)
    .map(n => ({from: n.issuer_handle, to: n.recipient_handle, amount: Number(n.outstanding)}));
}
// The stats line's four numbers (null where a read failed).
export function stats({participants, ledger, loops, clearing} = {}) {
  const list = participantList(participants);
  return {agents: list ? list.length : null, open: ledger ? openPromises(ledger).length : null,
    loops: clearing?.totals?.setoffs_applied ?? (Array.isArray(loops?.loops) ? loops.loops.length : null), cleared: clearing?.totals?.cleared_PC ?? null};
}
const fmt = n => (n == null ? '–' : Number(n).toLocaleString('en-US'));
export const statsLine = s => `${fmt(s.agents)} agents · ${fmt(s.open)} open promises · ${fmt(s.loops)} loops cancelled · ${fmt(s.cleared)} credits cancelled`;

// What the constellation draws: the points, the open promises between them, the latest loops (newest first).
export function constellation({participants, ledger, loops} = {}) {
  const nodes = new Map();
  const add = (handle, kind = 'agent') => {
    if (typeof handle !== 'string' || !handle || nodes.has(handle)) return;
    nodes.set(handle, {handle, sandbox: SANDBOX_AGENTS.has(handle), kind, p: spherePoint(handle)});
  };
  for (const p of participantList(participants) || []) add(p?.handle, p?.sandbox_only ? 'sandbox' : p?.operator_run ? 'operator' : 'invited');
  const edges = openPromises(ledger).filter(e => nodes.has(e.from) && nodes.has(e.to)).map(e => {
    const a = nodes.get(e.from).p, b = nodes.get(e.to).p, sx = a.x + b.x, sy = a.y + b.y, sz = a.z + b.z, l = Math.hypot(sx, sy, sz);
    // The curve's control point, so that it passes through the surface point halfway along the shortest way round the sphere.
    const c = l > 0.2 ? {x: 2 * sx / l - sx / 2, y: 2 * sy / l - sy / 2, z: 2 * sz / l - sz / 2} : {x: sx / 2, y: sy / 2, z: sz / 2};
    return {...e, a, b, c, phase: hash32(`${e.from}>${e.to}`) / 4294967296};
  });
  const rings = (Array.isArray(loops?.loops) ? loops.loops : []).slice(0, LOOPS_SHOWN).map(l => {
    const pts = (l?.members || []).map(m => nodes.get(m?.handle)?.p).filter(Boolean);
    if (pts.length < 2) return null;
    const n = pts.length, centre = {x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n, z: pts.reduce((s, p) => s + p.z, 0) / n};
    return {id: l.id, pts, centre};
  }).filter(Boolean);
  return {nodes: [...nodes.values()], edges, rings};
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

// The mark (public/favicon.svg), large and centred: the picture when there is nothing live to draw.
function drawMark(ctx, w, h) {
  const size = Math.min(w, h) * 0.7, ox = (w - size) / 2, oy = (h - size) / 2 + size * 0.04, X = v => ox + (v / 100) * size, Y = v => oy + (v / 100) * size;
  drawGlow(ctx, X(50), Y(42.7), (17 / 100) * size * 1.4, 0.9);
  ctx.strokeStyle = white(1); ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(X(14), Y(22)); ctx.lineTo(X(86), Y(22)); ctx.lineTo(X(50), Y(84)); ctx.closePath(); ctx.stroke();
  for (const [vx, vy] of [[14, 22], [86, 22], [50, 84]]) {
    ctx.fillStyle = '#050608'; ctx.beginPath(); ctx.arc(X(vx), Y(vy), Math.max(4, size * 0.03), 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }
}

function drawSky(ctx, w, h, m, angle, now, {motion, hover}) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.4;
  ctx.strokeStyle = white(0.07); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R * PERSP / Math.sqrt(PERSP * PERSP - 1), 0, 2 * Math.PI); ctx.stroke();
  const P = new Map(m.nodes.map(n => [n.handle, project(n.p, angle, cx, cy, R)]));
  // open promises
  for (const e of m.edges) {
    const a = project(e.a, angle, cx, cy, R), b = project(e.b, angle, cx, cy, R), c = project(e.c, angle, cx, cy, R);
    const depth = 0.3 + 0.7 * ((a.z + b.z) / 2 + 1) / 2, alpha = Math.min(0.5, 0.1 + 0.05 * Math.sqrt(e.amount)) * depth;
    ctx.strokeStyle = white(alpha); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
    if (motion) {
      const s = (now / 7000 + e.phase) % 1, u = 1 - s;
      const x = u * u * a.x + 2 * u * s * c.x + s * s * b.x, y = u * u * a.y + 2 * u * s * c.y + s * s * b.y;
      drawGlow(ctx, x, y, 3.2, Math.min(0.9, alpha * 2.2));
    }
  }
  // the latest loops, oldest first so the newest is on top
  for (let i = m.rings.length - 1; i >= 0; i--) {
    const c = m.rings[i], pts = c.pts.map(p => project(p, angle, cx, cy, R)), k = project(c.centre, angle, cx, cy, R), newest = i === 0;
    ctx.strokeStyle = white(newest ? 0.3 : 0.12 + 0.03 * (m.rings.length - i)); ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
    drawGlow(ctx, k.x, k.y, R * (newest ? 0.16 : 0.11) * k.s, newest ? 0.55 : 0.28);
    if (newest) {
      const pulse = motion ? Math.sin(now / 1200) : 0, rr = R * 0.075 * k.s * (1 + 0.08 * pulse);
      ctx.globalAlpha = 0.8 + 0.2 * pulse; ctx.strokeStyle = rainbowStroke(ctx, k.x, k.y, rr); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(k.x, k.y, rr, 0, 2 * Math.PI); ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // the points, back to front
  const order = m.nodes.map(n => ({n, q: P.get(n.handle)})).sort((x, y) => x.q.z - y.q.z);
  for (const {n, q} of order) {
    const depth = (q.z + 1) / 2;
    ctx.fillStyle = white(0.28 + 0.72 * depth);
    ctx.beginPath(); ctx.arc(q.x, q.y, (n.sandbox ? 2.6 : 1.7) * q.s, 0, 2 * Math.PI); ctx.fill();
  }
  if (hover && P.has(hover)) {
    const q = P.get(hover);
    ctx.strokeStyle = white(0.9); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI); ctx.stroke();
    ctx.font = '400 12px "JetBrains Mono", ui-monospace, Consolas, monospace'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(hover).width, tx = Math.min(Math.max(8, q.x + 12), w - tw - 16), ty = q.y < 24 ? q.y + 20 : q.y - 18;
    ctx.fillStyle = 'rgba(5, 6, 8, 0.86)'; ctx.fillRect(tx - 6, ty - 10, tw + 12, 20);
    ctx.strokeStyle = 'rgba(27, 30, 38, 1)'; ctx.strokeRect(tx - 6 + 0.5, ty - 10 + 0.5, tw + 11, 19);
    ctx.fillStyle = white(1); ctx.fillText(hover, tx, ty);
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
  const canvas = $('sky'), ctx = canvas?.getContext('2d');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let m = null, angle = 0.7, last = 0, raf = 0, onScreen = true, hover = null, hoverTimer = 0, positions = new Map(), timer = null;
  let w = 0, h = 0;
  const motion = () => !(reduced?.matches);

  function draw(now = performance.now()) {
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (m && m.nodes.length) positions = drawSky(ctx, w, h, m, angle, now, {motion: motion(), hover});
    else { positions = new Map(); drawMark(ctx, w, h); }
  }
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min(100, now - last) : 0;
    last = now;
    if (motion()) angle += (dt / TURN_MS) * 2 * Math.PI;
    draw(now);
    if (animating()) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  const animating = () => motion() && onScreen && !document.hidden && !!(m && m.nodes.length);
  const kick = () => { if (!raf && animating()) raf = requestAnimationFrame(frame); else if (!animating()) draw(); };

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), box = canvas.getBoundingClientRect();
    w = Math.max(1, box.width); h = Math.max(1, box.height);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    draw();
  }
  if (canvas) {
    resize();   // a complete first frame at once: the mark until the network answers
    if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas); else window.addEventListener('resize', resize);
    if (typeof IntersectionObserver === 'function') new IntersectionObserver(es => { onScreen = es.some(e => e.isIntersecting); kick(); }).observe(canvas);
    reduced?.addEventListener?.('change', kick);
    const pick = ev => {
      const box = canvas.getBoundingClientRect(), x = ev.clientX - box.left, y = ev.clientY - box.top;
      let best = null, bd = 16 * 16;
      for (const [handle, q] of positions) { const d = (q.x - x) ** 2 + (q.y - y) ** 2; if (d < bd && q.z > -0.6) { bd = d; best = handle; } }
      if (best !== hover) { hover = best; if (!raf) draw(); }
    };
    canvas.addEventListener('pointermove', pick);
    canvas.addEventListener('pointerdown', ev => { pick(ev); clearTimeout(hoverTimer); if (ev.pointerType !== 'mouse') hoverTimer = setTimeout(() => { hover = null; if (!raf) draw(); }, 2500); });
    canvas.addEventListener('pointerleave', () => { hover = null; if (!raf) draw(); });
    document.fonts?.ready?.then(() => { if (!raf) draw(); });
  }

  function renderLoops(list) {
    const ol = $('loops');
    ol.replaceChildren();
    const loops = Array.isArray(list) ? list.slice(0, 8) : [];
    if (!loops.length) {
      const li = document.createElement('li');
      li.className = 'empty'; li.textContent = 'No loop cancelled yet. Be the first: try it in two minutes above.';
      ol.append(li); return;
    }
    for (const l of loops) {
      if (typeof l?.id !== 'string' || !/^vs_[0-9a-f]{16}$/.test(l.id)) continue;
      const li = document.createElement('li'), a = document.createElement('a'), path = document.createElement('span'), meta = document.createElement('span'), n = document.createElement('span');
      a.href = `/loop/${l.id}`;
      path.className = 'path'; path.textContent = loopPath(l);
      n.className = 'n'; n.textContent = fmt(l.amount_PC);
      meta.className = 'meta'; meta.append(n, ` credit${l.amount_PC === 1 ? '' : 's'} cancelled · ${ago(l.applied_at)}`);
      a.append(path, meta); li.append(a); ol.append(li);
    }
  }

  async function refresh() {
    clearTimeout(timer);
    const [participants, ledger, loops, clearing] = await Promise.all([getJson('/pilot/v1/participants?all=1').catch(() => null), getJson('/pilot/v1/ledger').catch(() => null),
      getJson('/pilot/v1/loops').catch(() => null), getJson('/pilot/v1/clearing').catch(() => null)]);
    const data = {participants, ledger, loops, clearing}, ok = !!(participants || ledger || loops || clearing);
    $('stats').textContent = ok ? statsLine(stats(data)) : 'The network cannot be read right now; retrying.';
    if (participants) { m = constellation(data); kick(); }
    if (loops) renderLoops(loops.loops);
    else if (!$('loops').querySelector('a')) {
      const li = document.createElement('li');
      li.className = 'empty'; li.textContent = 'The recent loops cannot be read right now.';
      $('loops').replaceChildren(li);
    }
    if (!document.hidden) timer = setTimeout(refresh, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); kick(); } else clearTimeout(timer); });

  for (const b of document.querySelectorAll('button.copy')) {
    b.addEventListener('click', async () => {
      const text = $(b.dataset.copy)?.textContent ?? '';
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 2000);
    });
  }
  refresh();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') start();
