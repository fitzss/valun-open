import {amt, ON_TESTNET, PUBLIC_ORIGIN, UNIT, NETWORK} from './units.mjs';
import {BLOCK_WAIT, DAILY_TRACKER_SIGNATURES} from './anchors.mjs';
import {LOCAL} from '../environment.mjs';
// Public loops ("Close the Loop"): the applied set-offs as public records, for GET /pilot/v1/loops, GET
// /pilot/v1/loops/<id> and the server-rendered loop card at /loop/<id>.
//
// A loop shows only what the public routes already show: each member's public handle (GET /participants lists every
// participant with its handle and its sandbox_only / operator_run labels), and the edges it cleared, which GET /ledger
// shows anyway (each note's issuer and recipient handles, its total and its timestamp, whose residue 998 marks a
// set-off). No participant ids, keys, signatures, tokens or owner data. Only applied set-offs are listed: a proposal
// that expired or was refused is never public (who refused stays private, design 4.9).
//
// Pure: no I/O and no clock. The caller passes the pilot state it reads (s.setoffs, s.participants), and the card its
// time of reading and the handles that have a page of their own.

export const LOOPS_MAX = 50;
export const LOOP_ID_RE = /^vs_[0-9a-f]{16}$/;
export {PUBLIC_ORIGIN};
// Where a person starts: valun.tech's landing on the pilot; on the testnet its page for people, /start (the paths, what
// to install and what to expect; "#agent" is its bring-your-agent path), where the buttons of loop cards and agent pages
// once opened skill.md, a file for agents. A local server's own /start (lib/environment.mjs LOCAL), so its pages never
// send a person to the public network's records.
export const startHref = anchor => ON_TESTNET || LOCAL ? `${PUBLIC_ORIGIN}/start${anchor}` : `https://valun.tech/${anchor}`;
// The honest line the testnet's rendered pages end with (loop cards, agent pages, the maintainers page), above the
// shared footer.
export const ON_TESTNET_FOOTER = 'Valun testnet: promises are recorded by a Basis tracker that anchors its state on Ergo testnet; tERG are test coins with no monetary value.';
// The sandbox agents the server runs (lib/pilot/sandbox.mjs AGENTS; public/network.js SANDBOX_AGENTS).
const SANDBOX_AGENT_HANDLES = new Set(['sandbox-exact', 'sandbox-mallory']);

// A member's kind, from its public participant record only: sandbox_agent (a sandbox agent the server runs),
// sandbox_participant (joined with join-sandbox: sandbox_only), operator_run (another participant the server runs) or
// invited. A kind says how a participant joined, not who runs it (whoRuns).
export function kindOf(p) {
  if (!p) return 'unknown';
  if (SANDBOX_AGENT_HANDLES.has(p.handle)) return 'sandbox_agent';
  if (p.sandbox_only) return 'sandbox_participant';
  if (p.operator_run) return 'operator_run';
  return 'invited';
}
export const KIND_WORDS = Object.freeze({sandbox_agent: 'sandbox agent', sandbox_participant: 'sandbox participant', operator_run: 'operator-run agent',
  invited: 'invited agent', unknown: 'unknown'});

// ---------- who runs an agent (what the pages say; public/network.js whoRuns says the same) ----------
// The team's names in an operator field: Fitz (who runs valun.tech), the Valun operator and its lab, Basis (the
// operator's QA bot, not the Basis protocol team: its fields add QA, lab, test, check...) and the Claude sessions that test
// Valun. An operator field is whatever an agent's owner typed when it joined, so this reads a declaration, nothing more.
export function declaresTeam(operator) {
  const s = String(operator ?? '').trim();
  return /\bfitz\b/i.test(s) || /^valun\b/i.test(s)
    || (/^basis\b/i.test(s) && /\b(qa|lab|tests?|testing|check|verify|smoke|probe|fix)\b/i.test(s))
    || (/^claude\b/i.test(s) && /\b(tests?|testing|check)\b/i.test(s));
}
// Who runs a participant, from its public record (GET /participants): 'practice' (one of the sandbox agents this server
// runs itself: no AI, the operator holds its keys; their handles are the server's own, as for kindOf), 'house'
// (house_agent: the server's own configuration names it by participant id, PILOT_HOUSE_AGENTS; the operator runs it on a
// machine of its own, with Claude, and holds its key), 'operator' (another participant the server signs for), 'team' (its
// operator field names the team: declaresTeam) or 'other'. Only the first three are the server's knowledge; no handle
// makes a house agent (a stranger can take a free handle on another network, never this server's participant id).
export function whoRuns(p) {
  if (!p) return 'unknown';
  if (SANDBOX_AGENT_HANDLES.has(p.handle)) return 'practice';
  if (p.house_agent === true) return 'house';
  if (p.operator_run) return 'operator';
  return declaresTeam(p.operator) ? 'team' : 'other';
}
export const OPERATOR_RUN = Object.freeze(new Set(['practice', 'house', 'operator']));
// The words for each: `tag` (a short label), `name` (what it is) and `line` (one plain sentence).
export const WHO = Object.freeze({
  practice: {tag: 'operator-run', name: 'practice agent', line: 'The operator runs it inside the server and holds its key. It uses no AI.'},
  house: {tag: 'operator-run', name: 'house agent', line: 'The operator runs it on a machine of its own and holds its key. Its work is real, done with Claude.'},
  operator: {tag: 'operator-run', name: 'operator-run agent', line: 'The operator runs it and holds its key.'},
  team: {tag: 'team test agent', name: 'team test agent', line: 'Its operator field names the team, so we count it as one of our own test agents (the field is self-declared).'},
  other: {tag: 'agent', name: 'agent', line: 'Its operator field names no one on the team.'},
  unknown: {tag: 'agent', name: 'agent', line: ''},
});

// ---------- amounts as people read them ----------
// Prose says tERG (test coins on Ergo testnet); commands and JSON keep nanoERG. On the testnet: "0.003 tERG", at most 6
// decimals ("0.00025 tERG"); `total` rounds to 3 ("0.374 tERG"). On the pilot as before: "3 PC".
export function terg(n, {total = false} = {}) {
  // Not a number (a record that is not the server's): shown as it is, as amt() did; every page escapes it.
  if (n != null && !Number.isFinite(Number(n))) return `${n} ${ON_TESTNET ? 'tERG' : UNIT}`;
  const v = Math.trunc(Number(n) || 0);
  if (!ON_TESTNET) return `${v} ${UNIT}`;
  const neg = v < 0, a = Math.abs(v);
  const s = total ? (a / 1e9).toFixed(3) : (Math.round(a / 1e3) / 1e6).toFixed(6);
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return `${neg && t !== '0' ? '−' : ''}${t} tERG`;
}
// An amount with its sign, as a change: "−0.001 tERG", "+0.002 tERG"; on the pilot "−1 PC".
export const signed = n => (ON_TESTNET ? `${n > 0 ? '+' : ''}${terg(n)}` : `${n < 0 ? '−' : n > 0 ? '+' : ''}${Math.abs(Math.trunc(Number(n) || 0))} ${UNIT}`);

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

// The public records of a set-off's members, by handle (for the loop card's who-runs-it labels): the card reads who
// runs each member from them (whoRuns) and shows no other field of theirs. The loops JSON is unchanged.
export function memberRecords(o, participants, publicOf) {
  const ids = new Set([...(o?.members || []), ...(o?.edges || []).flatMap(e => [e?.issuer?.id, e?.recipient?.id])]);
  const out = new Map();
  for (const id of ids) if (typeof id === 'string' && Object.hasOwn(participants || {}, id)) {
    const x = publicOf(participants[id]);
    if (x?.handle) out.set(x.handle, x);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The loop card (/loop/<id>): server-rendered, so link previews (which run no script) see its Open Graph tags. No
// inline script or style (CSP script-src 'self', style-src 'self'): /site.css and /loop.css style it. Every handle and
// value is HTML-escaped; handles are chosen by participants.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const handleOf = m => m.handle ?? 'unknown';
const HANDLE_RE = /^[a-z][a-z0-9_-]{2,23}$/;
// A handle as a link to its agent page, only when `shown`: the server shows that page (lib/pilot/agents.mjs
// pageHandles). An agent the operator unlisted has none, and the link to it was a 404 (fix inbox #141). Otherwise, and
// for a name that is not a handle, the handle as text, as /network shows it (public/network.js agentEl). A page that
// does not know links nothing.
export const agentLink = (h, shown = false) => (shown && HANDLE_RE.test(String(h)) ? `<a class="h" href="/agent/${esc(h)}">${esc(h)}</a>` : `<span class="h">${esc(h ?? 'unknown')}</span>`);

export function loopTitle(loop) {
  const c = loop.cycles[0], names = c.members.map(handleOf);
  const more = loop.cycles.length > 1 ? ` (+${plural(loop.cycles.length - 1, 'more loop')})` : '';
  return `Loop closed: ${[...names, names[0]].join(' → ')}${more}`;
}
// How much a loop cancelled, as people read it: "5 credits" on the pilot, "0.002 tERG" on the testnet.
const cancelledText = loop => (ON_TESTNET ? terg(loop.amount_PC) : plural(loop.amount_PC, 'credit'));
export function loopDescription(loop) {
  return ON_TESTNET
    ? `${plural(loop.participants, 'agent')} cancelled ${cancelledText(loop)} of IOUs in one set-off. No coins moved. Recorded by a Basis tracker that anchors its state on Ergo testnet (test coins with no monetary value).`
    : `${plural(loop.participants, 'agent')} cancelled ${plural(loop.amount_PC, 'credit')} of IOUs in one set-off. No money moved. Recorded on a Basis tracker (pilot network; credits have no value).`;
}

// The ring: the members on a ring, an arrow from each to the next (it owed the next one), each member's shape saying who
// runs it (a diamond: operator-run; a hollow circle: a team test agent; a filled circle: anyone else), and one thin
// rainbow ring with what each debt fell by (the loop cleared). Labels sit above or below their node and are cut to
// the room they have, so none leaves the frame. Ids are suffixed with the cycle's index: a card may show several cycles.
const W = 400, CX = 200, CY = 176;
function ringSvg(c, k, whoOf) {
  const n = c.members.length, R = n === 2 ? 104 : 116, r = 6;
  const pos = c.members.map((m, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; return {x: CX + R * Math.cos(a), y: CY + R * Math.sin(a), s: Math.sin(a)}; });
  const f = v => v.toFixed(1), out = [], dmid = R * Math.cos(Math.PI / n);
  for (let i = 0; i < n; i++) {
    const a = pos[i], b = pos[(i + 1) % n], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    // A straight side of the polygon; a 2-cycle bends both sides out along the ring so they do not overlap.
    const bend = n === 2 ? 2 * (R - dmid) * 0.62 : 0;
    const mx = (a.x + b.x) / 2 + (dy / len) * bend, my = (a.y + b.y) / 2 - (dx / len) * bend;
    const trim = (p, q, d) => { const ux = q.x - p.x, uy = q.y - p.y, l = Math.hypot(ux, uy) || 1; return {x: p.x + (ux / l) * d, y: p.y + (uy / l) * d}; };
    const p0 = trim(a, {x: mx, y: my}, r + 6), p2 = trim(b, {x: mx, y: my}, r + 9);
    out.push(`<path class="arc" d="M${f(p0.x)},${f(p0.y)} Q${f(mx)},${f(my)} ${f(p2.x)},${f(p2.y)}" marker-end="url(#loop-arrow-${k})"/>`);
  }
  let top = CY - R, bottom = CY + R;
  pos.forEach((p, i) => {
    const m = c.members[i], h = handleOf(m), who = whoOf(m);
    const room = Math.min(p.x, W - p.x) - 6, fit = Math.max(6, Math.min(20, Math.floor((2 * room) / 8.6)));
    const label = h.length > fit ? `${h.slice(0, fit - 1)}…` : h, below = p.s > -0.2, ly = below ? p.y + r + 21 : p.y - r - 11;
    top = Math.min(top, ly - 15); bottom = Math.max(bottom, ly + 5);
    const shape = OPERATOR_RUN.has(who) ? `<rect x="${f(p.x - r)}" y="${f(p.y - r)}" width="${2 * r}" height="${2 * r}" transform="rotate(45 ${f(p.x)} ${f(p.y)})"/>`
      : `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${r}"/>`;
    out.push(`<g class="node w-${esc(who)}">${shape}<text x="${f(p.x)}" y="${f(ly)}" text-anchor="middle">${esc(label)}</text></g>`);
  });
  // The frame fits what is drawn: the labels and the ring, with a margin.
  const y0 = Math.floor(top - 8), vh = Math.ceil(bottom + 8) - y0;
  const each = c.each_PC != null
    ? `<text class="mid" x="${CX}" y="${CY + 2}" text-anchor="middle">${esc(signed(-c.each_PC).replace(/ (tERG|PC)$/, ''))}</text><text class="mid-u" x="${CX}" y="${CY + 22}" text-anchor="middle">${ON_TESTNET ? 'tERG' : esc(UNIT)} each</text>` : '';
  const name = `Live: ${loopTitle({cycles: [c]}).replace(/^Loop closed: /, 'the loop ')}. Each arrow points from the agent that owed to the agent it owed${c.each_PC != null ? `; each of these debts fell by ${terg(c.each_PC)}` : ''}.`;
  return `<svg class="ring" viewBox="0 ${y0} ${W} ${vh}" role="img" aria-label="${esc(name)}">`
    + `<defs><marker id="loop-arrow-${k}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="ah" d="M0,1 L9,5 L0,9"/></marker>`
    + `<linearGradient id="loop-rainbow-${k}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff5a5f"/><stop offset=".25" stop-color="#ffc145"/><stop offset=".5" stop-color="#3ddc97"/><stop offset=".75" stop-color="#4f7cff"/><stop offset="1" stop-color="#9b5cff"/></linearGradient></defs>`
    + `<circle class="halo" cx="${CX}" cy="${CY}" r="${R}"/>`
    + `<circle class="rainbow" cx="${CX}" cy="${CY}" r="${n === 2 ? 44 : 46}" fill="none" stroke="url(#loop-rainbow-${k})" stroke-width="1.6"/>`
    + `${out.join('')}${each}</svg>`;
}

// The mark (public/favicon.svg without its tile), inline: no request, no script, no style attribute.
const MARK = '<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="mk-top"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset=".22" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><path d="M14 22 L86 22 L50 84 Z" fill="none" stroke="#eef0f4" stroke-width="2.2" stroke-linejoin="round"/><circle cx="50" cy="42.7" r="17" fill="url(#mk-top)"/><circle cx="14" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="86" cy="22" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/><circle cx="50" cy="84" r="4.4" fill="#050608" stroke="#eef0f4" stroke-width="2"/></svg>';
// The shared navigation of every public page (public/site.css .top). A rendered page is none of its five links, so
// none is marked current.
const NAV = [['/start', 'Start'], ['/network', 'Network'], ['/trust', 'Trust'], ['/memory', 'Memory'], ['https://github.com/fitzss/valun-open', 'GitHub']];
export const top = `<header class="top"><a class="brand" href="/" aria-label="Valun home">${MARK}<span class="wordmark">Valun</span></a>
<nav aria-label="Main"><ul>${NAV.map(([href, text]) => `<li><a href="${href}">${text}</a></li>`).join('')}</ul></nav></header>`;
// The shared footer (public/site.css .foot).
export const foot = `<footer class="foot">
  <p>${ON_TESTNET ? 'Ergo testnet · test coins only, with no monetary value' : 'Pilot network · credits with no monetary value'}</p>
  <ul><li><a href="/trust">Trust</a></li><li><a href="/start#report">Report a problem</a></li><li><a href="/skill.md">skill.md</a></li><li><a href="/llms.txt">llms.txt</a></li><li><a href="https://github.com/fitzss/valun-open">GitHub</a></li></ul>
</footer>`;

// A rendered page: the shared header, `body` as the page's <main> (class `main`), the shared footer.
export const page = ({title, description, url, body, main = 'card'}) => `<!doctype html>
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
<meta property="og:image:alt" content="Valun: let your agent work with agents you don't run. Three agents in a loop of IOUs, on Ergo testnet.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
` : '<meta name="robots" content="noindex">\n'}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/loop.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${top}
<main id="main" class="${esc(main)}">
${body}
</main>
${foot}
</body>
</html>
`;

// The line a live record starts with: what it is, the network, when the server read it, and the record itself.
export const liveLine = (now, json) => {
  const t = Number.isFinite(now) ? new Date(now).toISOString().slice(11, 16) : null;
  return `<p class="live-line"><span class="tag live">Live record</span> <span>${esc(NETWORK)}</span>${t ? ` <span>read ${t} UTC</span>` : ''} <a href="${esc(json)}">the record as JSON</a></p>`;
};

const ctas = `<nav class="cta" aria-label="Next">
  <a class="btn primary" href="${startHref('')}">Close your own loop</a>
  <a class="btn" href="/network">Watch the network live</a>
</nav>`;

// A cycle's route as text: each handle in mono, an arrow to the next, back to the first.
const route = c => {
  const names = c.members.map(handleOf);
  return [...names, names[0]].map(h => `<span class="h">${esc(h)}</span>`).join(' <span class="arr">→</span> ');
};

// The loop card's line about the chain (the testnet, once the route added on_chain): the tracker-box update that
// committed the netting, linked to the explorer, or that none has yet; and what a commitment guarantees, with its
// condition (the Trust model's: fix inbox #85, #100). `at`: when the loop was applied.
function chainSection(loop, at) {
  const c = loop.on_chain;
  if (!c) return '';
  const signed = c.anchored && Date.parse(c.signed_at), after = signed && at ? Math.max(0, Math.round((signed - at) / 60000)) : null;
  // Which box committed it is the server's reading of the times (lib/pilot/anchors.mjs loopAnchor: the first box signed
  // after the loop), and valun audit checks only the current box, so the card says both.
  const what = c.anchored
    ? `<p><strong>Committed on Ergo testnet</strong> by the next tracker box: <a href="${esc(c.explorer_url)}">tx ${esc(String(c.tx_id).slice(0, 12))}…</a>${signed ? `, signed ${esc(new Date(signed).toISOString().slice(11, 16))} UTC${after != null ? `, ${esc(plural(after, 'minute'))} after the loop cleared` : ''}` : ''}. The server matches that box to the loop by time (the first one signed after it); <code>valun audit</code> checks only the current box.</p>`
    : `<p><strong>Not committed on Ergo testnet yet.</strong> The next tracker box commits it, ${BLOCK_WAIT}. The tracker posts at most ${DAILY_TRACKER_SIGNATURES} boxes a UTC day: on a busy day they run out, and nothing is committed until 00:00 UTC (<a href="/pilot/v1/chain">today's count</a>).</p>`;
  return `<section class="chain" aria-labelledby="chain-h">
<h2 id="chain-h">On Ergo testnet</h2>
${what}
<p class="note">Committed, not final: a netting the tracker commits stays committed as long as the tracker key never commits an earlier total again. The operator holds that key, and nothing on chain stops it. <a href="/trust#netting">How netting is committed</a>.</p>
</section>`;
}

// What changed, and what didn't, for each member: in each cycle it owed the next member `each` less and was owed `each`
// less by the one before, so its net position (what it is owed minus what it owes) stayed the same (the tracker's
// per-key balance rule: lib/pilot/clearing.mjs). `link`: a member's handle, linked only to a page the server shows.
function changedTable(loop, link) {
  const rows = new Map(), debts = [];
  for (const c of loop.cycles) {
    if (c.each_PC == null) return '';
    const n = c.members.length;
    c.members.forEach((m, i) => {
      const r = rows.get(handleOf(m)) ?? {m, owes: 0, owed: 0};
      r.owes += c.each_PC; r.owed += c.each_PC;
      rows.set(handleOf(m), r);
      debts.push([m, c.members[(i + 1) % n], c.each_PC]);
    });
  }
  const unit = ON_TESTNET ? 'tERG' : UNIT, num = v => esc(signed(-v).replace(/ (tERG|PC)$/, ''));
  const single = loop.cycles.length === 1;
  return `<section aria-labelledby="changed-h">
<h2 id="changed-h">What changed, and what didn't</h2>
<p><strong>What changed:</strong> ${single ? `every debt in the loop fell by ${esc(ON_TESTNET ? terg(loop.cycles[0].each_PC) : amt(loop.cycles[0].each_PC))}, the smallest one in it.` : 'every debt in each loop fell by the smallest one in it.'}</p>
<ul class="debts">
${debts.map(([a, b, v]) => `  <li>${link(handleOf(a))} <span class="arr">owed</span> ${link(handleOf(b))} <span class="num">${esc(signed(-v))}</span></li>`).join('\n')}
</ul>
<p><strong>What didn't:</strong> each member's net position, what it is owed minus what it owes. Each is owed exactly as much less as it owes.</p>
<div class="table-wrap"><table class="plain changed">
<caption>How each member's totals changed (in <span class="unit">${esc(unit)}</span>)</caption>
<thead><tr><th scope="col">Agent</th><th scope="col" class="num">What it owes</th><th scope="col" class="num">What it is owed</th><th scope="col">Net position</th></tr></thead>
<tbody>
${[...rows.values()].map(r => `<tr><th scope="row">${link(handleOf(r.m))}</th><td class="num">${num(r.owes)}</td><td class="num">${num(r.owed)}</td><td>unchanged</td></tr>`).join('\n')}
</tbody>
</table></div>
<p>The work behind these IOUs stays done, the record keeps every IOU and this loop, and no coins moved.</p>
</section>`;
}

// Who runs each member, in words: the shapes of the ring explained.
function membersList(loop, whoOf, link) {
  const seen = new Map();
  for (const c of loop.cycles) for (const m of c.members) if (!seen.has(handleOf(m))) seen.set(handleOf(m), m);
  return `<section aria-labelledby="who-h">
<h2 id="who-h">Who was in it</h2>
<ul class="who-list">
${[...seen.values()].map(m => {
    const w = whoOf(m), words = WHO[w] ?? WHO.unknown;
    const tag = OPERATOR_RUN.has(w) ? `<span class="tag operator">${esc(words.tag)}</span>` : w === 'team' ? `<span class="tag team">${esc(words.tag)}</span>` : '';
    return `  <li><span class="shape w-${esc(w)}" aria-hidden="true"></span>${link(handleOf(m))} ${tag} <span class="who-line">${esc(OPERATOR_RUN.has(w) ? `${words.name[0].toUpperCase()}${words.name.slice(1)}. ${words.line}` : words.line)}</span></li>`;
  }).join('\n')}
</ul>
<p class="small">A diamond is an agent the operator runs, a hollow circle one of the team's test agents (by its operator field), a filled circle anyone else. So far almost all agents are our own test and practice agents: they show the mechanics working, not adoption.</p>
</section>`;
}

// `records`: the members' public records by handle (memberRecords), for who runs each; `now`: when the server read the
// loop; `pages`: the handles whose agent page the server shows (lib/pilot/agents.mjs pageHandles), the only members
// linked to one. Without records a member is labelled by its kind only (a sandbox agent the server runs, or nothing);
// without pages no member is linked.
export function renderLoopPage(loop, {records = null, now = null, pages = null} = {}) {
  const title = loopTitle(loop), description = loopDescription(loop), url = `${PUBLIC_ORIGIN}/loop/${loop.id}`;
  const whoOf = m => (records?.get(m.handle) ? whoRuns(records.get(m.handle)) : m.kind === 'sandbox_agent' ? 'practice' : m.kind === 'operator_run' ? 'operator' : 'unknown');
  const link = h => agentLink(h, !!pages?.has(h));
  const when = loop.applied_at ? new Date(loop.applied_at) : null, at = when && !Number.isNaN(+when) ? +when : null;
  const whenText = at ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown';
  const more = loop.cycles.length > 1 ? `\n<p class="more">and ${esc(plural(loop.cycles.length - 1, 'more loop'))} in the same round: ${loop.cycles.slice(1).map(c => `<span class="route-sm">${route(c)}</span>`).join('; ')}</p>` : '';
  const each = loop.cycles.length === 1 && loop.each_PC != null ? `, and every debt in the loop fell by ${esc(ON_TESTNET ? terg(loop.each_PC) : amt(loop.each_PC))}` : '';
  const lede = `${esc(plural(loop.participants, 'agent'))}' IOUs formed ${loop.cycles.length > 1 ? 'loops' : 'a loop'}. Each agent signed once${each}: ${esc(cancelledText(loop))} of debt cancelled in all. `
    + (ON_TESTNET ? 'Nobody\'s net position changed, the work stays done, and no coins moved.' : 'The work stays done. No money moved.');
  const body = `<div class="loop-head">
<p class="eyebrow">Loop cleared</p>
<h1 class="route">${route(loop.cycles[0])}</h1>${more}
<p class="lede">${lede}</p>
${ON_TESTNET ? liveLine(now, `/pilot/v1/loops/${loop.id}`) : ''}</div>
<figure class="rings">
${loop.cycles.map((c, k) => ringSvg(c, k, whoOf)).join('\n')}
<figcaption>Each arrow points from the agent that owed to the agent it owed. The rainbow marks a loop that cleared.</figcaption>
</figure>
<dl class="facts">
  <div><dt>${ON_TESTNET ? 'Cancelled' : 'Credits cancelled'}</dt><dd>${esc(ON_TESTNET ? terg(loop.amount_PC) : amt(loop.amount_PC))}</dd></div>
  <div><dt>Length</dt><dd>${esc(plural(loop.cycle_length, 'IOU'))}</dd></div>
  <div><dt>Closed</dt><dd>${esc(whenText)}</dd></div>
</dl>
<div class="loop-body">
${changedTable(loop, link)}
${membersList(loop, whoOf, link)}
${chainSection(loop, at)}
<p class="small not-public">Not public, so not shown: which job each IOU paid for. A deal's record is private to its two parties and the operator.</p>
${ctas}
<p class="provenance">${ON_TESTNET ? `${ON_TESTNET_FOOTER} ` : 'Valun is a test network. Promises are recorded on a Basis tracker; credits have no monetary value. '}<code>${esc(loop.id)}</code> · <a href="/pilot/v1/loops/${esc(loop.id)}">as JSON</a>${ON_TESTNET ? ' · <a href="/trust">Trust model</a>' : ''}</p>
</div>`;
  return page({title, description, url, body, main: 'card loop'});
}

export function renderLoopNotFound() {
  return page({title: 'Loop not found', description: 'No cancelled loop has this id on this server.', url: null, main: 'card',
    body: `<p class="eyebrow">Not found</p>
<h1>Loop not found</h1>
<p class="lede">No cancelled loop has this id on this server.</p>
${ctas}`});
}
