import {amt, ON_TESTNET, PUBLIC_ORIGIN} from './units.mjs';
// Public loops ("Close the Loop"): the applied set-offs as public records, for GET /pilot/v1/loops, GET
// /pilot/v1/loops/<id> and the server-rendered loop card at /loop/<id>.
//
// A loop shows only what the public routes already show: each member's public handle (GET /participants lists every
// participant with its handle and its sandbox_only / operator_run labels), and the edges it cleared, which GET /ledger
// shows anyway (each note's issuer and recipient handles, its total and its timestamp, whose residue 998 marks a
// set-off). No participant ids, keys, signatures, tokens or owner data. Only applied set-offs are listed: a proposal
// that expired or was refused is never public (who refused stays private, design 4.9).
//
// Pure: no I/O and no clock. The caller passes the pilot state it reads (s.setoffs, s.participants).

export const LOOPS_MAX = 50;
export const LOOP_ID_RE = /^vs_[0-9a-f]{16}$/;
export {PUBLIC_ORIGIN};
// Where a person starts: valun.tech's landing on the pilot; on the testnet its own skill.md (the pilot's landing
// onboards to the other network).
export const startHref = anchor => ON_TESTNET ? `${PUBLIC_ORIGIN}/skill.md` : `https://valun.tech/${anchor}`;
// The sandbox agents the server runs (lib/pilot/sandbox.mjs AGENTS; public/network.js SANDBOX_AGENTS).
const SANDBOX_AGENT_HANDLES = new Set(['sandbox-exact', 'sandbox-mallory']);

// A member's kind, from its public participant record only: sandbox_agent (a sandbox agent the server runs),
// sandbox_participant (joined with join-sandbox: sandbox_only), operator_run (another participant the server runs) or
// invited.
export function kindOf(p) {
  if (!p) return 'unknown';
  if (SANDBOX_AGENT_HANDLES.has(p.handle)) return 'sandbox_agent';
  if (p.sandbox_only) return 'sandbox_participant';
  if (p.operator_run) return 'operator_run';
  return 'invited';
}
export const KIND_WORDS = Object.freeze({sandbox_agent: 'sandbox agent', sandbox_participant: 'sandbox participant', operator_run: 'operator-run agent',
  invited: 'invited agent', unknown: 'unknown'});

// The members of one cycle in cycle order, as participant ids: cycle edge keys '<issuer key>><recipient key>' (in the
// order the engine found them, each edge's recipient the next edge's issuer) mapped to ids through the set-off's own
// edges. null if a key is not one of the set-off's edges or the edges do not chain.
function cycleIds(o, edgeKeys) {
  const idOf = new Map();
  for (const e of o.edges || []) { idOf.set(e.issuer?.pubkey, e.issuer?.id); idOf.set(e.recipient?.pubkey, e.recipient?.id); }
  const ids = [];
  for (let i = 0; i < edgeKeys.length; i++) {
    const [ik, rk] = String(edgeKeys[i]).split('>'), next = String(edgeKeys[(i + 1) % edgeKeys.length]).split('>')[0];
    if (!idOf.get(ik) || !idOf.get(rk) || rk !== next) return null;
    ids.push(idOf.get(ik));
  }
  return ids;
}
// Without the engine's cycle list (a record made some other way): follow the set-off's edges from the first one.
function chainIds(o) {
  const edges = o.edges || [], ids = [];
  if (!edges.length) return null;
  let at = edges[0];
  const used = new Set();
  while (at && !used.has(at)) {
    used.add(at); ids.push(at.issuer?.id);
    const to = at.recipient?.id;
    if (to === ids[0]) return used.size === edges.length ? ids : null;
    at = edges.find(e => !used.has(e) && e.issuer?.id === to);
  }
  return null;
}

// One applied set-off as a public loop, or null when it is not applied. `participants`: s.participants; `publicOf`:
// the public record of a participant (Pilot.publicParticipant), from which the handle and the kind are read.
export function loopOf(o, participants, publicOf) {
  if (!o || o.state !== 'applied' || !LOOP_ID_RE.test(String(o.id))) return null;
  const member = id => {
    const x = typeof id === 'string' && Object.hasOwn(participants || {}, id) ? publicOf(participants[id]) : null;
    return {handle: x?.handle ?? null, kind: kindOf(x)};
  };
  let cycles = (Array.isArray(o.cycles) ? o.cycles : []).map(c => {
    const ids = Array.isArray(c?.edges) ? cycleIds(o, c.edges) : null;
    return ids && {length: ids.length, each_PC: Number(c.amount) || 0, members: ids.map(member)};
  }).filter(Boolean);
  if (!cycles.length) {
    const ids = chainIds(o), each = (o.edges || []).map(e => e.decrease);
    cycles = ids ? [{length: ids.length, each_PC: new Set(each).size === 1 ? each[0] : null, members: ids.map(member)}]
      : [{length: (o.members || []).length, each_PC: null, members: (o.members || []).map(member)}];
  }
  const all = new Set(cycles.flatMap(c => c.members.map(m => m.handle)));
  return {id: o.id, applied_at: o.applied_at ?? o.updated_at ?? null, cycle_length: cycles[0].length, amount_PC: Number(o.amount) || 0,
    each_PC: cycles[0].each_PC, members: cycles[0].members, participants: all.size, cycles, card_url: `${PUBLIC_ORIGIN}/loop/${o.id}`};
}

// The most recent `max` applied set-offs as loops, newest first.
export function loopsOf(setoffs, participants, publicOf, max = LOOPS_MAX) {
  return Object.values(setoffs || {}).filter(o => o?.state === 'applied' && LOOP_ID_RE.test(String(o.id)))
    .sort((a, b) => String(b.applied_at ?? '').localeCompare(String(a.applied_at ?? '')) || (a.id < b.id ? -1 : 1))
    .slice(0, max).map(o => loopOf(o, participants, publicOf));
}

// ---------------------------------------------------------------------------------------------------------------
// The loop card (/loop/<id>): server-rendered, so link previews (which run no script) see its Open Graph tags. No
// inline script or style (CSP script-src 'self', style-src 'self'): /loop.css styles it. Every handle and value is
// HTML-escaped; handles are chosen by participants.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const handleOf = m => m.handle ?? 'unknown';

export function loopTitle(loop) {
  const c = loop.cycles[0], names = c.members.map(handleOf);
  const more = loop.cycles.length > 1 ? ` (+${plural(loop.cycles.length - 1, 'more loop')})` : '';
  return `Loop closed: ${[...names, names[0]].join(' → ')}${more}`;
}
// How much a loop cancelled, as people read it: "5 credits" on the pilot, "2000000 nanoERG (0.002 tERG)" on the testnet.
const cancelledText = loop => (ON_TESTNET ? amt(loop.amount_PC) : plural(loop.amount_PC, 'credit'));
export function loopDescription(loop) {
  return ON_TESTNET
    ? `${plural(loop.participants, 'agent')} cancelled ${cancelledText(loop)} of IOUs in one set-off. No money moved. Recorded by a Basis tracker that anchors its state on Ergo testnet (test coins with no monetary value).`
    : `${plural(loop.participants, 'agent')} cancelled ${plural(loop.amount_PC, 'credit')} of IOUs in one set-off. No money moved. Recorded on a Basis tracker (pilot network; credits have no value).`;
}
// The loop card's line about the chain (the testnet, once the route added on_chain): the tracker-box update that made the
// netting final, linked to the explorer; or that it is not final on chain yet.
function onChainFact(loop) {
  const c = loop.on_chain;
  if (!c) return '';
  return c.anchored
    ? `\n  <div><dt>Final on Ergo testnet</dt><dd><a href="${esc(c.explorer_url)}">tx ${esc(String(c.tx_id).slice(0, 12))}…</a></dd></div>`
    : `\n  <div><dt>On Ergo testnet</dt><dd>not final yet: the next tracker box commits it</dd></div>`;
}

// The ring: the members on a ring, a thin line from each to the next (it owed the next one), a glow at the centre and
// one rainbow ring (the loop cancelled). Ids are suffixed with the cycle's index: a card may show several cycles.
function ringSvg(c, k = 0) {
  const n = c.members.length, R = 120, cx = 240, cy = 190, r = 6;
  const pos = c.members.map((m, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return {x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), s: Math.sin(a)}; });
  const f = v => v.toFixed(1), out = [], dmid = R * Math.cos(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const a = pos[i], b = pos[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    // A straight side of the polygon; a 2-cycle bends both sides out along the ring so they do not overlap.
    const bend = n === 2 ? 2 * (R - dmid) * 0.55 : 0;
    const mx = (a.x + b.x) / 2 + (dy / len) * bend, my = (a.y + b.y) / 2 - (dx / len) * bend;
    const trim = (p, q, d) => { const ux = q.x - p.x, uy = q.y - p.y, l = Math.hypot(ux, uy) || 1; return {x: p.x + (ux / l) * d, y: p.y + (uy / l) * d}; };
    const p0 = trim(a, {x: mx, y: my}, r + 5), p2 = trim(b, {x: mx, y: my}, r + 7);
    out.push(`<path class="arc" d="M${f(p0.x)},${f(p0.y)} Q${f(mx)},${f(my)} ${f(p2.x)},${f(p2.y)}" marker-end="url(#loop-arrow-${k})"/>`);
  }
  pos.forEach((p, i) => {
    const m = c.members[i], h = handleOf(m), label = h.length > 16 ? `${h.slice(0, 15)}…` : h, ly = p.s > 0.2 ? p.y + r + 22 : p.y - r - 14;
    out.push(`<g class="node k-${esc(m.kind)}"><circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r}"/>`
      + `<text x="${f(p.x)}" y="${f(ly)}" text-anchor="middle">${esc(label)}</text></g>`);
  });
  const each = c.each_PC != null ? `<text class="mid" x="${cx}" y="${cy + 5}" text-anchor="middle">−${esc(c.each_PC)}</text>` : '';
  return `<svg class="ring" viewBox="0 0 480 380" role="img" aria-label="${esc(`${loopTitle({cycles: [c]})}: each line is a promise, from the one who owed to the one owed`)}">`
    + `<defs><marker id="loop-arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="ah" d="M0,1 L9,5 L0,9"/></marker>`
    + `<radialGradient id="loop-glow-${k}"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".22" stop-color="#fff" stop-opacity=".4"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<linearGradient id="loop-rainbow-${k}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5a5f"/><stop offset=".25" stop-color="#ffc145"/><stop offset=".5" stop-color="#3ddc97"/><stop offset=".75" stop-color="#4f7cff"/><stop offset="1" stop-color="#9b5cff"/></linearGradient></defs>`
    + `<circle class="halo" cx="${cx}" cy="${cy}" r="${R}"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${Math.round(R * 0.62)}" fill="url(#loop-glow-${k})"/>`
    + `<circle class="rainbow" cx="${cx}" cy="${cy}" r="${Math.round(R * 0.3)}" fill="none" stroke="url(#loop-rainbow-${k})" stroke-width="1.4"/>`
    + `${out.join('')}${each}</svg>`;
}

// The mark (public/favicon.svg without its tile), inline: no request, no script, no style attribute.
const MARK = '<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="mk-top"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset=".22" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><path d="M14 22 L86 22 L50 84 Z" fill="none" stroke="#eef0f4" stroke-width="2.2" stroke-linejoin="round"/><circle cx="50" cy="42.7" r="17" fill="url(#mk-top)"/><circle cx="14" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="86" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="50" cy="84" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/></svg>';
export const top = `<header class="top"><a class="brand" href="/" aria-label="Valun home">${MARK}<span class="wordmark">Valun</span></a></header>`;

export const page = ({title, description, url, body}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#050608">
<title>${esc(title)} · Valun</title>
<meta name="description" content="${esc(description)}">
${url ? `<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Valun">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="https://valun.tech/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Valun: credit for machines. Debts that cancel out.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
` : '<meta name="robots" content="noindex">\n'}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/loop.css">
</head>
<body>
${body}
</body>
</html>
`;

const ctas = `<nav class="cta">
  <a class="btn primary" href="${startHref('')}">Close your own loop</a>
  <a class="btn" href="/network">Watch the network live</a>
</nav>`;

// A cycle's route as text: each handle in mono, an arrow to the next, back to the first.
const route = c => {
  const names = c.members.map(handleOf);
  return [...names, names[0]].map(h => `<span class="h">${esc(h)}</span>`).join(' <span class="arr">→</span> ');
};

export function renderLoopPage(loop) {
  const title = loopTitle(loop), description = loopDescription(loop), url = `${PUBLIC_ORIGIN}/loop/${loop.id}`;
  const when = loop.applied_at ? new Date(loop.applied_at) : null;
  const whenText = when && !Number.isNaN(+when) ? `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown';
  const more = loop.cycles.length > 1 ? `\n<p class="more">and ${esc(plural(loop.cycles.length - 1, 'more loop'))} in the same round: ${loop.cycles.slice(1).map(c => `<span class="route-sm">${route(c)}</span>`).join('; ')}</p>` : '';
  const body = `<main class="card">
${top}
<p class="eyebrow">Loop cancelled</p>
<h1 class="route">${route(loop.cycles[0])}</h1>${more}
<section class="rings">${loop.cycles.map(ringSvg).join('\n')}</section>
<p class="lede">${esc(plural(loop.participants, 'agent'))} cancelled ${esc(cancelledText(loop))} of promises in one round of signatures. The work stays done. No money moved.</p>
<div class="bar" aria-hidden="true"></div>
<dl class="facts">
  <div><dt>${ON_TESTNET ? 'Cancelled' : 'Credits cancelled'}</dt><dd>${esc(amt(loop.amount_PC))}</dd></div>
  <div><dt>Length</dt><dd>${esc(plural(loop.cycle_length, 'promise'))}</dd></div>
  <div><dt>Closed</dt><dd>${esc(whenText)}</dd></div>${onChainFact(loop)}
</dl>
${ctas}
<footer class="honest">
  <p>${ON_TESTNET ? 'Valun testnet: promises are recorded by a Basis tracker that anchors its state on Ergo testnet; tERG are test coins with no monetary value.'
    : 'Valun is a test network. Promises are recorded on a Basis tracker; credits have no monetary value.'}</p>
  <p><code>${esc(loop.id)}</code> · <a href="/pilot/v1/loops/${esc(loop.id)}">as JSON</a> · <a href="https://github.com/fitzss/valun-open">valun-open</a></p>
</footer>
</main>`;
  return page({title, description, url, body});
}

export function renderLoopNotFound() {
  return page({title: 'Loop not found', description: 'No cancelled loop has this id on this server.', url: null,
    body: `<main class="card">
${top}
<p class="eyebrow">Not found</p>
<h1>Loop not found</h1>
<p class="lede">No cancelled loop has this id on this server.</p>
${ctas}
</main>`});
}
