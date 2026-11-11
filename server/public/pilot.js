// Valun pilot network UI (/pilot). A separate page from the demo credit desk at /.
// Plain DOM. Every dynamic value is inserted as text (text nodes / textContent), never as HTML.
// It talks only to /pilot/v1/* on this origin. The owner token is kept in memory, or (the owner's choice, on by default)
// in sessionStorage for this tab. Never in localStorage, never in the address bar. sessionStorage is NOT simply "cleared
// when the tab closes": Chromium writes it into the profile on disk so it can restore tabs; "Forget token" removes it.

const $ = s => document.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== '') e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

// ---------------------------------------------------------------- formatting
const NF = new Intl.NumberFormat('en-US');
const pc = (n, unit = 'PC') => (n == null || Number.isNaN(Number(n))) ? '–' : `${NF.format(Number(n))} ${unit}`;
const short = (h, a = 10, b = 8) => { if (!h) return '–'; const s = String(h); return s.length <= a + b + 1 ? s : `${s.slice(0, a)}…${s.slice(-b)}`; };
const when = iso => { if (!iso) return '–'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}); };
const RTF = new Intl.RelativeTimeFormat('en', {numeric: 'auto'});
function rel(iso) {
  const t = Date.parse(iso); if (Number.isNaN(t)) return '';
  const s = (t - Date.now()) / 1000, a = Math.abs(s);
  const [v, u] = a < 60 ? [s, 'second'] : a < 3600 ? [s / 60, 'minute'] : a < 86400 ? [s / 3600, 'hour'] : [s / 86400, 'day'];
  return RTF.format(Math.round(v), u);
}
const whenRel = iso => iso ? `${when(iso)} (${rel(iso)})` : '–';
const count = (n, one, many) => `${NF.format(Number(n) || 0)} ${Number(n) === 1 ? one : many}`;
const msIso = ms => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const tag = (kind, text, title) => el('span', {class: `tag ${kind}`, title}, text);
const code = (v, cls = '') => el('code', {class: `mono wrap ${cls}`.trim()}, v == null || v === '' ? '–' : String(v));
const copyable = (value, shown = value) => el('code', {class: 'mono copyable', title: `${value}  (click to copy)`, onclick: () => navigator.clipboard?.writeText(value).catch(() => {})}, shown);
const keyFp = pk => pk ? copyable(pk, short(pk, 10, 8)) : el('span', {class: 'hint'}, 'no key registered');
const signedText = text => el('code', {class: 'mono signed-text'}, text);
const kv = rows => el('dl', {class: 'kv'}, ...rows.filter(Boolean).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
const thead = cols => el('thead', {}, el('tr', {}, ...cols.map(c => el('th', {}, c))));
const tableWrap = t => el('div', {class: 'tblwrap'}, t);
function copyBtn(value, label = 'Copy') {
  const b = el('button', {type: 'button', class: 'secondary btn-small'}, label);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); b.textContent = 'Copied'; } catch { b.textContent = 'Copy failed: select the text instead'; }
    setTimeout(() => { b.textContent = label; }, 2500);
  });
  return b;
}

// Where each piece of information comes from. Every block on this page carries one of these.
const SRC = {
  key: h => tag('signed', `signed by ${h}'s key`, 'A Basis Schnorr signature by this participant\'s own key. The Valun server verified it before recording the act; it never holds the key.'),
  valun: () => tag('valun', 'Valun server record', 'Written by the Valun server. Not signed by any participant key.'),
  owner: () => tag('owner', 'owner approval (server-attested, not key-signed)', 'Recorded by the Valun server under the owner token. Not signed with a key.'),
  basis: () => tag('basis', 'Basis tracker (local, no chain)', 'Read from the pilot\'s Basis tracker. It has no blockchain connection: notes stay local_only.'),
  none: () => tag('none', 'not in Basis', 'The Basis tracker holds nothing for this.'),
  browser: (t = 'checked in this browser') => tag('browser', t, 'Computed by this page in your browser, independently of the server.'),
  self: () => tag('self', 'self-declared, not verified by Valun', 'Typed in by the participant when joining. Valun checks only that it is present and not too long.'),
};

// ---------------------------------------------------------------- independent checks in the browser
// Same canonical JSON as the server (lib/pilot/core.mjs): sorted keys, no whitespace.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// onResult(true | false | null): null = could not be checked here.
function hashCheck(text, expected, what, onResult = null) {
  const out = el('span', {class: 'hcheck tiny'}, `${what}: checking…`);
  sha256Hex(text).then(h => {
    if (h == null) { out.textContent = `${what}: not checked (this browser offers no Web Crypto on this page)`; out.className = 'hcheck tiny warn'; onResult?.(null); return; }
    const ok = h === expected;
    out.textContent = ok ? `${what} recomputed in this browser: matches` : `${what} recomputed in this browser: ${short(h)} – DOES NOT MATCH`;
    out.className = `hcheck tiny ${ok ? 'good' : 'bad'}`;
    onResult?.(ok);
  }).catch(() => { out.textContent = `${what}: not checked`; onResult?.(null); });
  return el('span', {class: 'hcheck-wrap'}, out, ' ', SRC.browser());
}
// A signed statement whose last line is sha256(reason) (decline, dispute): shows the real line, computed here from the
// stored reason, which is the exact text the server verified the signature over.
function reasonStatement(prefix, reason) {
  const node = signedText(`${prefix}\n…`), label = el('span', {class: 'tiny'});
  sha256Hex(String(reason ?? '')).then(h => {
    if (h == null) { node.textContent = `${prefix}\nsha256(reason)`; label.textContent = ' template: this browser cannot compute sha256 on this page'; return; }
    node.textContent = `${prefix}\n${h}`; label.replaceChildren(' ', SRC.browser('last line = sha256 of the reason, computed in this browser'));
  }).catch(() => { node.textContent = `${prefix}\nsha256(reason)`; label.textContent = ' template'; });
  return el('span', {}, node, label);
}

// ---------------------------------------------------------------- API and connection state
class ApiError extends Error {
  constructor(status, body, kind = 'api') {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status; this.body = body || {}; this.kind = kind; this.code = this.body.error || null;
  }
}
const CONN = {ok: null, since: null};
function setConn(ok, detail = '') {
  if (CONN.ok !== ok) CONN.since = new Date();
  CONN.ok = ok;
  const pill = $('#conn');
  pill.className = `conn ${ok ? 'ok' : 'bad'}`;
  pill.textContent = ok ? 'server connected' : 'server unreachable';
  pill.title = ok ? `last answer at ${new Date().toLocaleTimeString()}` : detail;
  const off = $('#offline');
  if (ok) { off.hidden = true; off.replaceChildren(); return; }
  off.hidden = false;
  off.replaceChildren(el('strong', {}, 'The Valun server cannot be reached'), ` (${detail}, since ${CONN.since.toLocaleTimeString()}). `,
    'What this page shows was loaded earlier and may be out of date. Actions will fail until the connection returns. This page retries every 20 seconds. ',
    el('button', {type: 'button', class: 'btn-small', onclick: () => pollInfo()}, 'Retry now'));
}
async function api(method, path, {body, token} = {}) {
  const headers = {accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let r, text;
  try {
    r = await fetch(`/pilot/v1${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20000)});
    text = await r.text();
  } catch (e) {
    const detail = e && e.name === 'TimeoutError' ? 'no answer within 20 seconds' : 'network error';
    setConn(false, detail);
    throw new ApiError(0, {error: 'unreachable', message: `The Valun server could not be reached (${detail}).`}, 'network');
  }
  let j;
  try { j = text ? JSON.parse(text) : {}; } catch {
    setConn(false, `HTTP ${r.status} without a JSON answer`);
    throw new ApiError(r.status, {error: 'bad_response', message: `HTTP ${r.status}: the answer was not JSON from the Valun pilot API (a proxy or gateway in between may be failing).`}, 'network');
  }
  setConn(true);
  if (!r.ok) throw new ApiError(r.status, j && typeof j === 'object' ? j : {error: String(j)});
  return j;
}
// API errors ({error, message, rule, ...}) shown plainly, with every extra field the server sent.
function errorView(e, {write = false} = {}) {
  if (!(e instanceof ApiError)) return el('div', {class: 'apierr'}, el('b', {}, 'error'), ' – ', String(e?.message || e));
  const b = e.body || {};
  const box = el('div', {class: 'apierr'}, el('div', {}, el('b', {}, b.error || 'error'), ' – ', e.message, e.status ? el('span', {class: 'tiny'}, ` (HTTP ${e.status})`) : ''));
  const extra = Object.entries(b).filter(([k]) => k !== 'error' && k !== 'message');
  if (extra.length) box.append(kv(extra.map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])));
  if (e.kind === 'network' && write) box.append(el('div', {class: 'tiny'}, 'It is not known whether the server recorded this action. Refresh and check before trying again.'));
  return box;
}
function showMsg(target, content, kind = '') { target.className = `msg ${kind}`.trim(); target.replaceChildren(...(content instanceof Node ? [content] : content ? [document.createTextNode(String(content))] : [])); }
const showErr = (target, e, opts) => showMsg(target, errorView(e, opts), 'err');

// ---------------------------------------------------------------- state
const S = {info: null, dir: [], dirLoaded: false, ledger: null, token: null, owner: null, ownerAt: null, mandateDirty: false, flash: null, mandateFlash: null, busy: false, loadedNet: false, oneTime: null};
const TOKEN_KEY = 'valun-pilot-owner-token';
// sessionStorage only: per tab. The browser may also write it into its profile on disk (to restore tabs), so "Forget
// token" (sess.clear) is what removes it; closing the tab is not enough.
const sess = {
  get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); return true; } catch { return false; } },
  clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } },
};
S.token = sess.get();
const PEOPLE = new Map();
const remember = p => { if (p && p.id) PEOPLE.set(p.id, p); };
const handleOf = id => !id ? '–' : PEOPLE.get(id)?.handle ?? id;
function setDir(list) { S.dir = Array.isArray(list) ? list : []; S.dirLoaded = S.dirLoaded || Array.isArray(list); S.dir.forEach(remember); }
// One-time enrollment code (S.oneTime): survives console refreshes; cleared when leaving the tab, when the owner hides it,
// and as soon as the server says it can no longer be used (agent enrolled, code replaced, or expired).
const ONE_TIME = el('div', {id: 'one-time'});

// Statuses of both API generations: payment (paid / paying / payment_failed) and credit note (note_issued / ...).
// Either way the deal ends with a payer-signed Basis note held by the tracker: an outstanding obligation, never settled here.
// With circulating credit (server release v16, modes sandbox and on) a payer can also pay with a note it holds (a debt
// transfer): paying_by_transfer, paid_by_transfer, and payment_due when the delivery was accepted but no payment applied.
const DEAL_STATUS = {
  proposed_awaiting_owner: ['proposed – awaiting owner approval', 'owner'],
  open: ['open offer', 'open'],
  accepted_awaiting_owner: ['accepted – awaiting owner approval', 'owner'],
  agreed: ['agreed – awaiting delivery', 'open'],
  delivered: ['delivered – awaiting the payer', 'open'],
  completion_awaiting_owner: ['delivery accepted – credit note awaiting owner approval', 'owner'],
  paying: ['credit note being recorded', 'open'],
  issuing_note: ['credit note being recorded', 'open'],
  paid: ['credit note issued (outstanding)', 'paid'],
  note_issued: ['credit note issued (outstanding)', 'paid'],
  payment_failed: ['credit note failed', 'bad'],
  note_failed: ['credit note failed', 'bad'],
  disputed: ['disputed', 'bad'],
  declined: ['declined', 'ended'],
  withdrawn: ['withdrawn', 'ended'],
  expired: ['expired', 'ended'],
  rejected_by_owner: ['rejected by owner', 'ended'],
  cancelled: ['cancelled – an agent key was revoked', 'ended'],
  expired_undelivered: ['ended – not delivered in time', 'ended'],
  paying_by_transfer: ['paying by transfer (waiting for signatures)', 'open'],
  paid_by_transfer: ['paid by transfer', 'paid'],
  payment_due: ['payment due (accepted, unpaid)', 'bad'],
};
const statusLabel = s => (DEAL_STATUS[s] || [s])[0];
// A deal's status as shown: a delivery accepted with a payment by transfer that waits for the payer's owner is not a
// credit note waiting for it.
const dealStatusLabel = d => d.status === 'completion_awaiting_owner' && d.payment?.method === 'transfer' && d.payment.state === 'awaiting_owner'
  ? 'delivery accepted – payment by transfer awaiting owner approval' : statusLabel(d.status);
const ISSUED = ['paid', 'note_issued'], RECORDING = ['paying', 'issuing_note'], NOTE_FAILED = ['payment_failed', 'note_failed'];
// The deal's credit note. The first servers called it "payment"; since release v16 `payment` is the payment by transfer
// ({method: 'transfer', ...}), which is not a credit note.
const noteOf = d => d.credit_note ?? (d.payment && typeof d.payment === 'object' && d.payment.method === undefined ? d.payment : null);
const transferOf = d => (d.payment?.method === 'transfer' ? d.payment : null);
// Transfer states (GET /transfers/{vt}): live ones hold both edges; unresolved ones wait for the payer's owner.
const TRANSFER_STATE = {
  awaiting_owner: "waiting for the payer's owner to approve", collecting: 'collecting the issuer\'s and the payee\'s signatures', applying: 'being applied: the server decides by reading the tracker back',
  applied: 'applied by the Basis tracker', failed: 'failed: nothing moved', expired: 'expired before every party signed: nothing moved', cancelled: 'cancelled by the payer: nothing moved',
  refused: 'refused by a party: nothing moved', void_key_revoked: 'void: an agent key was revoked; nothing moved', void_rejected: "rejected by the payer's owner: nothing moved",
  void_stale: "void: it changed before the payer's owner approved; nothing moved",
  outcome_unknown: "outcome unknown: the tracker's read-back cannot tell whether it applied", inconsistent: 'inconsistent: one edge reads as applied and the other not',
  resolved_not_applied: "resolved by the payer's owner: not applied"};
const UNRESOLVED = ['outcome_unknown', 'inconsistent'];
const SETOFF_STATE = {collecting: 'collecting the members\' signatures', applying: 'being applied', applied: 'applied by the Basis tracker', failed: 'failed: nothing moved',
  expired: 'expired before every member signed: nothing moved', refused: 'refused by a member: nothing moved', superseded: 'superseded: nothing moved',
  void_key_revoked: 'void: an agent key was revoked; nothing moved', inconsistent: 'inconsistent: an alarm for the operator'};
// Approval kinds the server decides (release v16: issue_note, pay_by_transfer, propose, accept, confirm_offer).
const kindName = a => a.kind === 'accept' ? 'acceptance' : a.kind === 'issue_note' ? 'credit note' : a.kind === 'pay_by_transfer' ? 'payment by transfer'
  : a.kind === 'confirm_offer' ? 'accepted offer' : a.kind === 'propose' || a.kind === undefined ? (a.version > 1 ? 'counter-offer' : 'proposal') : `approval of kind ${a.kind}`;
const dealChip = d => el('span', {class: `status ps-${(DEAL_STATUS[d.status] || [0, 'ended'])[1]}`}, dealStatusLabel(d));
// Circulating credit is listed in /info (server release v16, modes sandbox and on).
const circulationOn = () => !!S.info?.features?.includes?.('circulation/1');
const overdueChip = d => d.overdue ? el('span', {class: 'status ps-bad'}, 'overdue') : null;
const P_STATUS = {active: ['active – agent key registered', 'paid'], awaiting_agent: ['awaiting agent – no key yet', 'owner']};
const pStatusChip = s => el('span', {class: `status ps-${(P_STATUS[s] || [0, 'ended'])[1]}`}, (P_STATUS[s] || [s])[0]);

// ================================================================= public landing
async function loadNetwork() {
  const [info, dir, led] = await Promise.allSettled([api('GET', '/info'), api('GET', '/participants'), api('GET', '/ledger')]);
  const fail = (sel, e) => {
    if (e.kind === 'network' && S.loadedNet) return;            // keep what was shown; the banner says it is stale
    $(sel).replaceChildren(el('div', {class: 'msg err'}, e.status === 404 ? 'The pilot network is not enabled on this server (the pilot API answered 404).' : errorView(e)));
  };
  if (info.status === 'fulfilled') { S.info = info.value; renderInfo(); } else fail('#info', info.reason);
  if (dir.status === 'fulfilled') { setDir(dir.value); renderDirectory(); } else fail('#directory', dir.reason);
  if (led.status === 'fulfilled') { S.ledger = led.value; renderLedger(); } else { fail('#ledger', led.reason); }
  // The clearing engine's public aggregates (circulating credit; GET /clearing exists only then).
  if (circulationOn()) { try { S.clearing = await api('GET', '/clearing'); } catch (e) { S.clearing = {error: e}; } renderInfo(); } else S.clearing = null;
  const anyOk = [info, dir, led].some(x => x.status === 'fulfilled');
  if (anyOk) { S.loadedNet = true; S.netAt = new Date(); }
  $('#net-updated').textContent = S.netAt ? `updated ${S.netAt.toLocaleTimeString()}${anyOk ? '' : ' · the last refresh failed'}` : 'not loaded';
}

function renderInfo() {
  const i = S.info, offChain = i.tracker_on_chain === false;
  const note = text => offChain ? el('div', {class: 'tiny'}, text) : null;
  $('#info').replaceChildren(
    kv([
      ['Network', code(i.network)],
      ['Protocol', code(i.protocol)],
      ['Unit', `${i.unit}: simulated pilot credits, no monetary value`],
      ['Experimental', i.experimental ? 'yes' : 'no'],
      ['Tracker on a blockchain', i.tracker_on_chain ? 'yes' : 'no: notes stay local_only; nothing is committed on a chain and no reserve backs them'],
      ['Tracker NFT id', [code(i.tracker_nft_id), note('A random id chosen when the pilot tracker was set up. It names no NFT on any chain: the tracker has no chain connection.')]],
      ['Denomination', [code(i.denomination), note('A synthetic token id the pilot tracker serves to label PC. It exists on no chain.')]],
      ['Participants with an agent key', String(i.participants)],
      Array.isArray(i.features) && ['Features', [el('code', {class: 'mono'}, i.features.join(', ')), el('div', {class: 'tiny'}, i.features.includes('circulation/1')
        ? 'Circulating credit is on: a payer may pay with a note it holds (debt transfer), and cycles of debt are cancelled by set-off. Every party signs what changes its own notes.'
        : 'Bound notes: each credit note is signed together with the pair\'s current total, so the tracker records it only while that total is unchanged.')]],
    ]),
    el('p', {class: 'quote'}, i.description),
    el('details', {}, el('summary', {}, 'The exact text each act signs (as the server publishes it)'),
      kv(Object.entries(i.statements || {}).map(([k, v]) => [k, code(v)])),
      i.circulation_statements ? kv(Object.entries(i.circulation_statements).map(([k, v]) => [`${k} (circulating credit)`, code(v)])) : null),
    i.novation ? el('details', {}, el('summary', {}, 'Circulating-credit timing (milliseconds, as the server publishes it)'),
      kv([['Timestamp endings (ms mod 1000)', `${i.novation.bound_note_ms} bound note, ${i.novation.setoff_ms} set-off, ${i.novation.transfer_ms} transfer; reserved ${(i.novation.reserved_ms || []).join(', ')}; ordinary notes use the others`],
        ['Maximum age at the tracker', `${NF.format(i.novation.max_age_ms)} (one hour): a signature older than that can no longer be used`],
        ['Collection windows', `transfer ${NF.format(i.novation.transfer_ttl_ms)}, set-off ${NF.format(i.novation.setoff_ttl_ms)}`],
        ['Any new payment after a failed attempt', `its timestamp + the maximum age + ${NF.format(i.novation.fallback_margin_ms)} (a transfer through the same note on the same prior state: at once)`]])) : null,
    clearingFacts(S.clearing));
}
// GET /clearing (public, aggregates only: no participant ids, handles or keys).
function clearingFacts(c) {
  if (!c) return null;
  if (c.error) return el('div', {class: 'tiny warn'}, `Clearing figures could not be read: ${c.error.message}`);
  const g = c.graph_now || {}, t = c.totals || {}, w = c.last_7_days || {}, p = c.proposals || {}, u = c.unit || 'PC';
  return el('div', {class: 'mcheck'}, el('div', {class: 'stitle'}, 'Clearing: what set-offs and transfers did ', SRC.valun(), ' ', SRC.basis()),
    kv([
      ['Debt outstanding now', `${pc(g.gross_PC, u)} gross over ${g.edges ?? 0} notes; net floor ${pc(g.net_floor_PC, u)} (what no clearing can remove)`],
      ['Clearable now', `${g.clearable_mtcs_PC == null ? 'not measured' : pc(g.clearable_mtcs_PC, u)} in theory; ${pc(g.clearable_within_limits_PC, u)} within the engine's limits`],
      ['Applied so far', `${t.setoffs_applied ?? 0} set-offs clearing ${pc(t.cleared_PC, u)} (summed over every edge they decreased; ${t.edges_closed ?? 0} notes closed); ${t.transfers_applied ?? 0} transfers moving ${pc(t.transferred_PC, u)}`],
      ['Last 7 days', `${pc(w.issued_PC, u)} issued, ${pc(w.cleared_PC, u)} cleared${w.liquidity_saving_pct == null ? '' : ` (${w.liquidity_saving_pct}%)`}`],
      ['Set-off proposals', `${p.collecting ?? 0} collecting; last 7 days: ${p.applied ?? 0} applied, ${p.stale ?? 0} superseded, ${p.expired ?? 0} expired, ${p.refused ?? 0} refused, ${p.failed ?? 0} failed`],
      ['Engine', `${c.engine?.enabled ? 'running' : 'not running'}${c.engine?.last_run ? `; last batch ${whenRel(c.engine.last_run.at)}` : ''}`],
    ]),
    el('p', {class: 'tiny'}, `As of ${when(c.as_of)}. A set-off cancels a cycle of debt: every member's net position stays the same. Nothing is redeemed and PC have no value.`));
}

function renderDirectory() {
  const box = $('#directory');
  if (!S.dir.length) { box.replaceChildren(el('p', {class: 'hint'}, 'Nobody has joined yet.')); return; }
  box.replaceChildren(el('div', {class: 'pcards'}, ...S.dir.map(p => el('article', {class: 'pcard'},
    el('div', {class: 'pcard-head'}, el('span', {class: 'phandle'}, p.handle),
      p.display_name && p.display_name !== p.handle ? el('span', {class: 'pdisplay'}, p.display_name) : null, pStatusChip(p.status)),
    el('div', {class: 'pcap'}, SRC.self()),
    kv([
      ['Operator', p.operator || '–'],
      ['About', p.about || '–'],
      ['Services', p.services || '–'],
    ]),
    el('div', {class: 'pcap'}, SRC.valun()),
    kv([
      ['Key fingerprint', keyFp(p.pubkey)],
      [el('span', {title: LAST_SEEN_WHY}, 'Agent last seen'), p.agent_last_seen ? whenRel(p.agent_last_seen) : 'never'],
      ['Joined', when(p.joined_at)],
      ['Id', code(p.id)],
    ])))));
}
// "Last seen" belongs to the current agent key: the server resets it when the owner revokes the agent and when a new key enrolls.
const LAST_SEEN_WHY = 'The last call made with the current agent token. Reset when the owner revokes the agent and when a new key enrolls.';

const RECON = {
  'match': ['match', 'good', 'the tracker total equals the credit notes Valun recorded for its deals'],
  'tracker-has-debt-not-agreed-in-valun': ['tracker has more', 'bad', 'the tracker holds more than Valun\'s deals explain (a note signed outside Valun)'],
  'valun-records-exceed-tracker': ['Valun has more', 'bad', 'Valun recorded credit notes the tracker does not hold'],
};
function renderLedger() {
  const L = S.ledger, nm = (h, pk) => h ?? `outside the directory (${short(pk)})`;
  $('#ledger').replaceChildren(L.notes.length ? tableWrap(el('table', {class: 'tbl'},
    thead(['payer (owes)', 'payee (holds the claim)', 'outstanding', 'note total', 'redeemed', 'confirmation', 'last note']),
    el('tbody', {}, ...L.notes.map(n => el('tr', {},
      el('td', {}, nm(n.issuer_handle, n.issuer_pubkey)), el('td', {}, nm(n.recipient_handle, n.recipient_pubkey)),
      el('td', {}, el('b', {}, pc(n.outstanding, L.unit))), el('td', {}, pc(n.total, L.unit)), el('td', {}, pc(n.redeemed, L.unit)),
      el('td', {}, el('code', {class: 'mono'}, n.confirmation)), el('td', {class: 'tiny'}, when(msIso(n.timestamp))))))))
    : el('p', {class: 'hint'}, 'The pilot tracker holds no notes yet.'));
  const R = L.reconciliation || [];
  // With circulating credit on, rows carry the edge journal's columns: what Valun expects is the issued notes plus what
  // transfers and set-offs did, and `exact` says whether the tracker's note is the very one Valun's last event left.
  const journal = R.some(r => 'expected_total' in r);
  const why = (r, w) => (journal && r.status === 'match' ? "the tracker total equals Valun's edge journal (notes issued, transfers in and out, set-offs)" : w);
  $('#reconcile').replaceChildren(R.length ? tableWrap(el('table', {class: 'tbl'}, thead(['payer → payee', 'tracker total', journal ? 'issued via Valun' : 'credit notes issued via Valun',
    ...(journal ? ['transfers in / out', 'set off', 'Valun expects', 'exact'] : []), 'result']),
    el('tbody', {}, ...R.map(r => { const [t, cls, w] = RECON[r.status] || [r.status, 'bad', '']; return el('tr', {},
      el('td', {}, r.pair ?? `${r.issuer} → ${r.recipient}`), el('td', {}, pc(r.tracker_total, L.unit)), el('td', {}, pc(r.issued_via_valun ?? r.paid_via_valun, L.unit)),
      ...(journal ? [el('td', {}, `${pc(r.transferred_in, L.unit)} / ${pc(r.transferred_out, L.unit)}`), el('td', {}, pc(r.set_off, L.unit)), el('td', {}, pc(r.expected_total, L.unit)),
        el('td', {title: 'the tracker\'s note (total, timestamp and signature) is the one Valun\'s last event on this edge left'}, r.exact ? 'yes' : el('span', {class: 'warn'}, 'no'))] : []),
      el('td', {}, el('b', {class: cls}, t), el('div', {class: 'tiny'}, why(r, w)))); }))))
    : el('p', {class: 'hint'}, 'Nothing to reconcile yet.'));
}

// ================================================================= join
function renderJoinResult(r) {
  const keep = el('input', {type: 'checkbox', checked: true});
  const exp = r.enrollment_expires_at;
  const forPlugin = `server: ${location.origin}\nparticipant_id: ${r.participant_id}\nenrollment_code: ${r.enrollment_code}`;
  $('#join-result').replaceChildren(el('div', {class: 'card once'},
    el('h2', {}, `Joined: ${r.handle} (${r.participant_id})`),
    el('p', {class: 'warnline'}, 'Shown once. The server keeps only hashes of these values and cannot show them again. Store them now.'),
    el('div', {class: 'grid2'},
      el('section', {class: 'secret'},
        el('h3', {}, 'Owner token – for you, the human operator'),
        el('div', {class: 'secret-value'}, el('code', {class: 'mono', id: 'join-owner-token'}, r.owner_token)),
        el('div', {class: 'actions'}, copyBtn(r.owner_token, 'Copy owner token')),
        el('ul', {},
          el('li', {}, 'Keep it private, like a password. It opens the owner console: mandate, approvals, agent revocation.'),
          el('li', {}, el('b', {}, 'Do not give it to the agent.'), ' The agent receives its own agent token when it enrolls, and can act only within your mandate.'),
          el('li', {}, 'There is no recovery route for a lost owner token in this pilot.')),
        el('label', {class: 'check'}, keep, "Keep it for this tab's session (sessionStorage). Your browser may also save it in its profile and bring it back with the tab: click Forget token in the owner console when you finish."),
        el('div', {class: 'actions'}, el('button', {type: 'button', id: 'join-open-console', onclick: () => { useToken(r.owner_token, keep.checked); location.hash = '#owner'; }}, 'Open the owner console'))),
      el('section', {class: 'secret'},
        el('h3', {}, "For your agent's plugin"),
        kv([['Participant id', el('code', {class: 'mono wrap', id: 'join-participant-id'}, r.participant_id)],
          ['Enrollment code', el('code', {class: 'mono wrap', id: 'join-enrollment-code'}, r.enrollment_code)],
          ['Expires', `${whenRel(exp)}: 30 minutes, single use`]]),
        el('div', {class: 'actions'}, copyBtn(forPlugin, 'Copy both for the plugin')),
        el('ul', {},
          el('li', {}, "Give the participant id and the enrollment code (and this server's address) to the agent's plugin. The plugin generates the agent's own key, signs a proof that it holds it, and receives its own agent token."),
          el('li', {}, 'If the code expires first, open the owner console and issue a new one.')),
        el('details', {}, el('summary', {}, 'With the reference Python client'),
          el('pre', {class: 'mono small'}, `from valun_client import Client\nClient('agent-state.json', '${location.origin}').enroll('${r.participant_id}', '<enrollment code>')`)))),
    el('div', {class: 'actions'}, el('button', {type: 'button', class: 'secondary', onclick: clearJoinResult}, 'Done – I have stored both'))));
  $('#join-result').hidden = false; $('#join-grid').hidden = true;
  window.scrollTo(0, 0);
}
function clearJoinResult() { $('#join-result').replaceChildren(); $('#join-result').hidden = true; $('#join-grid').hidden = false; }
function useToken(tok, keep) { S.token = tok; S.owner = null; if (keep) sess.set(tok); else sess.clear(); }
function forgetToken() { sess.clear(); S.token = null; S.owner = null; S.mandateDirty = false; S.newOwnerToken = null; S.consents = null; S.consentsUnavailable = false; clearOneTime(); updateBadge(); }

$('#join-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.target, f = new FormData(form), out = $('#join-msg'), btn = form.querySelector('button[type=submit]');
  const body = Object.fromEntries(['invite', 'handle', 'display_name', 'operator', 'about', 'services'].map(k => [k, String(f.get(k) || '').trim()]));
  btn.disabled = true; showMsg(out, 'Joining…');
  try {
    const r = await api('POST', '/join', {body});
    form.reset(); showMsg(out, '');
    renderJoinResult(r);
  } catch (e) { showErr(out, e, {write: true}); } finally { btn.disabled = false; }
});

// ================================================================= owner console
function showLogin(message = '') {
  $('#owner-console').hidden = true; $('#deal-view').hidden = true; $('#owner-login').hidden = false;
  if (message) showMsg($('#login-msg'), message, 'err');
}
$('#login-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const f = new FormData(ev.target), tok = String(f.get('token') || '').trim(), out = $('#login-msg');
  if (/^vpa_/.test(tok)) { showMsg(out, 'That is an agent token (vpa_…). The owner console needs the owner token (vpo_…) you received when you joined. Keep the two apart.', 'err'); return; }
  if (!/^vpo_/.test(tok)) { showMsg(out, 'Owner tokens start with vpo_.', 'err'); return; }
  useToken(tok, f.get('keep') === 'on');
  ev.target.reset(); showMsg(out, '');
  route();
});

async function showConsole() {
  $('#deal-view').hidden = true;
  if (!S.token) { showLogin(); return; }
  $('#owner-login').hidden = true; $('#owner-console').hidden = false;
  if (S.owner) renderConsole(); else $('#owner-console').replaceChildren(el('div', {class: 'card'}, el('p', {class: 'hint'}, 'Loading the owner console…')));
  await loadOwner();
}
async function loadOwner({quiet = false} = {}) {
  if (!S.token) return;
  try {
    const [o, dir] = await Promise.all([api('GET', '/owner', {token: S.token}), api('GET', '/participants').catch(() => null),
      S.info ? null : pollInfo()]);
    if (dir) setDir(dir);
    S.owner = o; S.ownerAt = new Date(); remember(o.participant); (o.deals || []).forEach(d => remember(d.counterparty));
    // Circulating credit: this participant's consents, read-only for its owner (GET /consents; 404 when circulation is
    // not on for it, as in mode sandbox for a participant outside the sandbox: not asked again until Refresh).
    if (o.credit_policy && !S.consentsUnavailable) {
      try { S.consents = await api('GET', '/consents', {token: S.token}); }
      catch (e) { if (e.status === 404) { S.consentsUnavailable = true; S.consents = null; } else if (e.status === 401) throw e; else S.consents = {error: e}; }
    } else if (!o.credit_policy) S.consents = null;
    // A shown enrollment code is useless once an agent has enrolled, a newer code replaced it, or it expired: drop it.
    const ag = o.agent || {}, ot = S.oneTime;
    if (ot && (ag.enrolled || !ag.enrollment_pending || ag.enrollment_expires_at !== ot.expires_at || !(Date.parse(ot.expires_at) > Date.now()))) clearOneTime();
    updateBadge();
    if (currentView() === 'console') renderConsole();
  } catch (e) {
    if (e.status === 401) { forgetToken(); if (currentRoute().tab === 'owner') showLogin('That owner token is not valid on this server (HTTP 401). It has been removed from this tab.'); return; }
    if (e.kind === 'network' && S.owner) return;               // keep the last data; the banner says it may be stale
    if (!quiet && currentView() === 'console') $('#owner-console').replaceChildren(el('div', {class: 'card'}, el('h2', {}, 'Owner console'), el('div', {class: 'msg err'}, errorView(e)),
      el('div', {class: 'actions'}, el('button', {type: 'button', class: 'secondary', onclick: () => loadOwner()}, 'Try again'), el('button', {type: 'button', class: 'secondary', onclick: signOut}, 'Use another token'))));
  }
}
function signOut() { forgetToken(); route(); }
// Payments by transfer of this participant's deals whose outcome only its owner can resolve (outcome_unknown or
// inconsistent): every other payment of the deal waits for that decision.
const unresolvedPayments = o => (o?.deals || []).filter(d => d.your_role === 'payer' && UNRESOLVED.includes(transferOf(d)?.state));
function updateBadge() {
  const n = S.owner ? S.owner.approvals.filter(a => a.state === 'pending').length + unresolvedPayments(S.owner).length : 0, b = $('#pending-badge');
  b.textContent = n ? `${n} pending` : ''; b.hidden = !n;
  document.title = `${n ? `(${n}) ` : ''}Valun · pilot network (experimental)`;
}
function ownerBusy() {
  if (S.busy) return true;
  const a = document.activeElement;
  if (a && $('#tab-owner').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  return [...document.querySelectorAll('.appr-note')].some(i => i.value.trim());
}

function renderConsole() {
  const o = S.owner, root = $('#owner-console');
  const pending = o.approvals.filter(a => a.state === 'pending'), decided = o.approvals.filter(a => a.state !== 'pending');
  const keptMandate = S.mandateDirty ? root.querySelector('#mandate-card') : null;   // never throw away unsaved edits
  if (keptMandate) keptMandate.querySelector('.open-offers')?.replaceWith(openOffersBox(o));   // but keep its offer list current
  // Nor what the owner typed or ticked in a pending approval: carried over by approval id (and the caret, if typing).
  const keptAppr = {};
  for (const x of root.querySelectorAll('article.appr[data-approval]')) keptAppr[x.dataset.approval] = {note: x.querySelector('.appr-note')?.value ?? ''};
  const act = document.activeElement, typing = act && act.classList?.contains('appr-note') && root.contains(act) ? act.closest('article.appr')?.dataset.approval : null;
  const caret = typing ? [act.selectionStart, act.selectionEnd] : null;
  renderOneTime();
  root.replaceChildren(...[identityBar(o), approvalsCard(pending, keptAppr), unresolvedCard(o), ONE_TIME,
    el('div', {class: 'grid2'}, agentCard(o), positionCard(o.position, o)),
    clearingCard(o), keptMandate || mandateCard(o), dealsCard(o.deals), decidedCard(decided)].filter(Boolean));
  if (typing) {
    const n = [...root.querySelectorAll('article.appr[data-approval]')].find(x => x.dataset.approval === typing)?.querySelector('.appr-note');
    if (n) { n.focus(); try { n.setSelectionRange(...caret); } catch { /* not a text input */ } }
  }
}

function identityBar(o) {
  const me = o.participant, kept = sess.get() === S.token, out = el('div', {class: 'msg', role: 'status'});
  const yes = el('button', {type: 'button', class: 'danger'}, 'Yes, replace my owner token');
  const confirm = el('div', {class: 'confirm', hidden: true},
    el('p', {}, el('b', {}, 'Replace your owner token? '), 'The server issues a new owner token and shows it once. The current one stops working at once, here and wherever else you use it. Your agent is not affected.'),
    el('div', {class: 'actions'}, yes, el('button', {type: 'button', class: 'secondary', onclick: () => { confirm.hidden = true; }}, 'Cancel')));
  yes.addEventListener('click', () => rotateOwnerToken(yes, out));
  const nt = S.newOwnerToken;
  return el('div', {class: 'card idbar'},
    el('div', {class: 'idmain'}, el('h2', {}, me.display_name || me.handle),
      el('div', {class: 'tiny'}, `${me.handle} · ${me.id} · operated by ${me.operator}`)),
    el('div', {class: 'actions'}, el('span', {class: 'tiny'}, `updated ${S.ownerAt.toLocaleTimeString()}`),
      el('button', {type: 'button', class: 'secondary btn-small', onclick: () => { S.consentsUnavailable = false; loadOwner(); }}, 'Refresh'),
      el('button', {type: 'button', class: 'secondary btn-small', onclick: () => { confirm.hidden = false; }}, 'New owner token…'),
      el('button', {type: 'button', class: 'secondary btn-small', onclick: signOut}, 'Forget token')),
    el('p', {class: 'hint'}, 'You set what your agent may do and decide the commitments it brings to you. You cannot sign deal acts here: your agent signs them with its own key. ',
      kept ? "Owner token kept for this tab's session (sessionStorage). Your browser may also save it in its profile on disk and bring it back if the tab is restored, even after the browser closes: click Forget token when you finish, especially on a shared computer."
        : 'Owner token kept in memory only (gone on reload).',
      o.owner_token_rotated_at ? ` Owner token last replaced ${whenRel(o.owner_token_rotated_at)}.` : ''),
    confirm, out,
    nt ? el('div', {class: 'card once'}, el('h2', {}, 'Your new owner token'),
      el('p', {class: 'warnline'}, 'Shown once: the server keeps only a hash. Store it now; the previous owner token no longer works.'),
      kv([['Owner token', el('code', {class: 'mono wrap', id: 'new-owner-token'}, nt.token)], ['Replaced', whenRel(nt.at)]]),
      el('div', {class: 'actions'}, copyBtn(nt.token, 'Copy the token'),
        el('button', {type: 'button', class: 'secondary btn-small', onclick: () => { S.newOwnerToken = null; renderConsole(); }}, 'Done – hide this'))) : null);
}
// OQ-24: the server issues a new owner token and invalidates this one. This tab switches to the new token (kept in
// sessionStorage only if the old one was).
async function rotateOwnerToken(btn, out) {
  btn.disabled = true; showMsg(out, 'Replacing the owner token…');
  try {
    const kept = sess.get() === S.token, r = await api('POST', '/owner/rotate-token', {token: S.token});
    S.token = r.owner_token; if (kept) sess.set(r.owner_token);
    S.newOwnerToken = {token: r.owner_token, at: r.rotated_at};
    showMsg(out, ''); await loadOwner();
  } catch (e) { showErr(out, e, {write: true}); btn.disabled = false; }
}

// ---------------------------------------------------------------- pending approvals
function approvalsCard(pending, kept = {}) {
  const flash = S.flash; S.flash = null;
  return el('div', {class: `card approvals${pending.length ? ' has-pending' : ''}`, id: 'approvals'},
    el('h2', {}, 'Pending approvals ', el('span', {class: `count${pending.length ? ' on' : ''}`}, String(pending.length))),
    flash ? el('div', {class: `msg ${flash.ok ? 'ok' : 'err'} flash`, role: 'status'}, flash.text) : null,
    pending.length
      ? el('p', {class: 'hint'}, `Your agent signed these, but your mandate says they need you (${'review_deliveries' in S.owner.mandate ? `a price above approve_above, or review_deliveries for credit notes${S.owner.credit_policy ? ' and payments by transfer' : ''}` : 'the price is above approve_above'}). None of them takes effect until you decide. Check the exact terms.`)
      : el('p', {class: 'hint'}, `Nothing is waiting for you. Commitments priced above ${pc(S.owner.mandate.approve_above)} (approve_above) will appear here first.`),
    ...pending.map(a => approvalItem(a, kept[a.id] || {})));
}

// What exactly is being approved. The server returns it with each approval: `subject` (the exact terms or credit note,
// the agent's signature, the text it signed, the server's mandate check) and `effect` (what approving and rejecting do).
// The kinds this console shows; the server decides exactly these (release v16), and refuses any other with
// 409 unknown_approval_kind before anything changes.
const APPROVAL_KINDS = ['issue_note', 'pay_by_transfer', 'propose', 'accept', 'confirm_offer'];
function approvalSubject(a) {
  const s = a.subject || null, tr = a.kind === 'pay_by_transfer' ? s?.transfer ?? null : null;
  const kindLabel = a.kind === 'issue_note' ? 'credit note: delivery accepted'
    : a.kind === 'pay_by_transfer' ? `payment by transfer: delivery accepted, paid with ${tr ? (tr.issuer?.handle ?? handleOf(tr.issuer?.id)) : "another participant"}'s note`
    : a.kind === 'accept' ? `acceptance of version ${a.version}`
    : a.kind === 'confirm_offer' ? `your agent's offer (version ${a.version}), accepted by ${handleOf(s?.accepted_by)}`
    : a.kind === 'propose' ? (a.version === 1 ? 'new proposal' : `counter-offer, version ${a.version}`)
    : `approval of kind ${a.kind}, which this page does not know`;
  return {kindLabel, s, terms: s?.terms ?? null, issue: a.kind === 'issue_note', transfer: tr, pay: a.kind === 'pay_by_transfer', known: APPROVAL_KINDS.includes(a.kind),
    signature: s?.signature ?? null, statement: s?.statement ?? null,
    countered: s?.countered ?? null, effect: a.effect || null,
    missing: a.kind === 'pay_by_transfer' && s && !tr ? 'The server did not return the transfer this payment is, so this page cannot show it. Approve stays off; reject it, or refresh.'
      : 'The server did not return what this approval is for, so this page cannot show it. Approve stays off; reject it, or refresh.'};
}
function effectBox(e) {
  if (!e) return null;
  const loc = t => String(t).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, iso => when(iso));   // server times in local time
  return el('div', {class: 'effect'}, kv([['If you approve', loc(e.if_approved)], ['If you reject', loc(e.if_rejected)], e.checks_on_approve && ['Checked again when you approve', loc(e.checks_on_approve)]]),
    el('p', {class: 'tiny'}, SRC.valun(), ' What these decisions do, as the server will apply them.'));
}

function termsKv(t, meId, extra = []) {
  const party = x => [`${handleOf(x.id)}${x.id === meId ? ' (you)' : ''} `, keyFp(x.pubkey)];
  return kv([
    ['Title', el('b', {}, t.service.title)],
    ['Description', el('div', {class: 'pre-wrap'}, t.service.description)],
    ['Deliverable', el('div', {class: 'pre-wrap'}, t.service.deliverable)],
    ['Price', el('b', {}, pc(t.price.amount, t.price.unit))],
    ['Payer (issues the credit note, owes it)', party(t.payer)],
    ['Payee (does the work, holds the claim)', party(t.payee)],
    ['Consideration', t.consideration === 'credit_note_on_delivery_accepted' ? 'a credit note from the payer when it accepts the delivery: an outstanding obligation, not a settlement (consideration: credit_note_on_delivery_accepted)'
      : t.payment === 'on_delivery_accepted' ? 'a credit note (Basis note) from the payer when it accepts the delivery (payment: on_delivery_accepted)'
      : String(t.consideration ?? t.payment ?? '–')],
    ['Deliver by', whenRel(t.deliver_by)],
    ['Offer expires at', whenRel(t.offer_expires_at)],
    ['Deal, version', `${t.deal_id} · version ${t.version}${t.prior_terms_hash ? ` · replaces ${short(t.prior_terms_hash)}` : ''}`],
    ['Bound to', `${t.network} · tracker ${short(t.tracker_nft_id)} · ${t.protocol} · nonce ${short(t.nonce, 6, 4)}`],
    ...extra,
  ]);
}

function mandateCheck(a, t) {
  const m = S.owner.mandate, pos = S.owner.position, meId = S.owner.participant.id;
  const box = el('div', {class: 'mcheck'}, el('div', {class: 'stitle'}, 'Mandate check'));
  const server = a.mandate_check || null;   // the server's own check numbers from when the agent acted
  if (server && Array.isArray(server.checks)) {
    box.append(el('ul', {class: 'checks'}, ...server.checks.map(c => {
      if (c.rule === 'min_payer_coverage_pct') return el('li', {class: c.coverage_pct >= c.limit ? 'good' : 'bad'},
        `min_payer_coverage_pct: the payer's claims on the tracker ${pc(c.payer_claims_on_tracker)} cover ${c.coverage_pct}% of what it would owe (on the tracker ${pc(c.payer_owes_on_tracker)} + agreed ${pc(c.payer_committed)} + this deal ${pc(c.this_deal)}); your minimum is ${c.limit}%`);
      // Circulating credit (release v16): the credit rules on the payer, as the issuer of the claim you would hold.
      if (c.rule === 'refuse_notes_from') return el('li', {class: c.issuer_listed ? 'bad' : 'good'}, `refuse_notes_from: the payer is ${c.issuer_listed ? '' : 'not '}on your list of issuers you refuse`);
      if (c.rule === 'accept_notes_from') return el('li', {class: 'good'}, `accept_notes_from: ${c.any ? 'notes of any issuer are accepted' : 'the issuer is on your list'}`);
      if (c.rule === 'accept_operator_issuers') return el('li', {class: c.issuer_operator_run && !c.limit ? 'bad' : 'good'},
        `accept_operator_issuers is off: the payer's notes are ${c.issuer_operator_run ? '' : 'not '}issued with keys the operator holds`);
      if (c.rule === 'max_claims_total') {
        const sum = (c.claims_on_tracker || 0) + (c.committed || 0) + (c.pending_in || 0) + (c.this_deal || 0);
        return el('li', {class: sum <= c.limit ? 'good' : 'bad'}, `max_claims_total: your claims on the tracker ${pc(c.claims_on_tracker)} + agreed deals as payee ${pc(c.committed)} + being paid to you by transfer ${pc(c.pending_in)} + this deal ${pc(c.this_deal)} = ${pc(sum)} of ${pc(c.limit)}`);
      }
      if (c.rule === 'max_issuer_net_debt') return el('li', {class: c.issuer_net_debt <= c.limit ? 'good' : 'bad'},
        `max_issuer_net_debt: the payer owes ${pc(c.issuer_owes_on_tracker)} on the tracker + agreed ${pc(c.issuer_committed)} + this deal ${pc(c.this_deal)}, less its own claims after a one-level haircut ${pc(c.issuer_adjusted_claims)}: net debt ${pc(c.issuer_net_debt)} of ${pc(c.limit)}`);
      const base = c.owed_on_tracker ?? c.claim_on_tracker ?? 0, sum = base + (c.committed || 0) + (c.reserved || 0) + (c.pending_in || 0) + (c.this_deal || 0);
      return el('li', {class: sum <= c.limit ? 'good' : 'bad'}, `${c.rule}: on the tracker ${pc(base)} + committed ${pc(c.committed)} + offered ${pc(c.reserved)}${c.pending_in ? ` + being paid by transfer ${pc(c.pending_in)}` : ''} + this deal ${pc(c.this_deal)} = ${pc(sum)} of ${pc(c.limit)}${c.dormant_PC ? ` (not counting ${pc(c.dormant_PC)} owed to sandbox participants whose sandbox time ended)` : ''}`);
    })), el('p', {class: 'tiny'}, SRC.valun(), ` Numbers from the server's check when your agent acted (mandate version ${server.mandate_version ?? '?'}).`));
  }
  if (!t) { box.append(el('p', {class: 'hint'}, 'Not computed here: the terms are not available.')); return box; }
  const role = t.payer.id === meId ? 'payer' : 'payee', price = t.price.amount, otherId = role === 'payer' ? t.payee.id : t.payer.id, otherH = handleOf(otherId);
  const li = (ok, text) => el('li', {class: ok == null ? '' : ok ? 'good' : 'bad'}, text);
  const expOk = !m.expires_at || Date.parse(m.expires_at) > Date.now();
  const cpOk = m.counterparties === 'any' || (Array.isArray(m.counterparties) && m.counterparties.includes(otherId));
  const items = [
    li(expOk, m.expires_at ? `mandate ${expOk ? 'valid until' : 'EXPIRED at'} ${when(m.expires_at)}` : 'mandate has no expiry'),
    li(cpOk, m.counterparties === 'any' ? `counterparty ${otherH}: any participant is allowed` : `counterparty ${otherH}: ${cpOk ? 'on your list' : 'NOT on your list'}`),
  ];
  if (role === 'payer') {
    items.push(li(m.may_issue_credit, `you issue the credit note in this deal: may_issue_credit is ${m.may_issue_credit ? 'on' : 'OFF'}`),
      li(price <= m.max_issue_per_deal, `price ${pc(price)} ${price <= m.max_issue_per_deal ? 'within' : 'ABOVE'} max_issue_per_deal ${pc(m.max_issue_per_deal)}`),
      li(pos.owes + price > m.max_issue_outstanding ? false : null, `max_issue_outstanding ${pc(m.max_issue_outstanding)}: you owe ${pc(pos.owes)} on the tracker now, ${pc(pos.owes + price)} with this deal, before agreed deals without a credit note yet and open offers are added`));
  } else {
    const claim = (pos.claims || []).filter(c => c.from === otherH).reduce((s, c) => s + c.amount, 0);
    const min = m.min_price_as_payee || 0;
    items.push(li(m.may_accept_credit, `you do the work for a credit note in this deal: may_accept_credit is ${m.may_accept_credit ? 'on' : 'OFF'}`),
      'min_price_as_payee' in m ? li(price >= min, `price ${pc(price)} ${price >= min ? 'at or above' : 'BELOW'} min_price_as_payee ${pc(min)}`) : null,
      m.min_payer_coverage_pct > 0 ? li(null, `min_payer_coverage_pct ${m.min_payer_coverage_pct}%: the server checks that ${otherH}'s claims on the tracker cover at least that share of what it would owe`) : null,
      li(price <= m.max_accept_per_deal, `price ${pc(price)} ${price <= m.max_accept_per_deal ? 'within' : 'ABOVE'} max_accept_per_deal ${pc(m.max_accept_per_deal)}`),
      li(claim + price > m.max_accept_per_issuer ? false : null, `max_accept_per_issuer ${pc(m.max_accept_per_issuer)}: ${otherH} owes you ${pc(claim)} on the tracker now, ${pc(claim + price)} with this deal, before agreed deals without a credit note yet and open offers are added`));
  }
  items.push(li(null, price > m.approve_above ? `approve_above ${pc(m.approve_above)}: the price is above it, so it waits for you` : `approve_above is now ${pc(m.approve_above)}, at or above this price, but this request was made under an earlier setting`));
  box.append(el('ul', {class: 'checks'}, ...items), el('p', {class: 'tiny'}, SRC.browser('computed in this page'),
    ` From your mandate (version ${S.owner.mandate_version}) and your tracker position.${server ? '' : " This server version does not return its own check numbers for an approval."} When you approve, the server checks the hard limits again (including agreed deals without a credit note yet, and open offers) and refuses with mandate_exceeded if they would be exceeded.`));
  return box;
}

function approvalItem(a, kept = {}) {
  const d = a.deal, me = S.owner.participant, x = approvalSubject(a), t = x.terms;
  const note = el('input', {type: 'text', maxlength: 300, class: 'appr-note', placeholder: 'Note (optional). Only you and your agent can read it.', 'aria-label': 'Note for this decision'});
  if (kept.note) note.value = kept.note;
  const out = el('div', {class: 'msg', role: 'status'});
  const approve = el('button', {type: 'button', class: 'approve'}, 'Approve');
  const reject = el('button', {type: 'button', class: 'secondary reject'}, 'Reject');
  // Approve only what this page shows: off while the terms are missing (for a payment by transfer: also the transfer),
  // and off if the terms shown do not hash to the terms hash being approved. Reject always stays available, except for
  // a kind this page does not know: the server decides none of those (409 unknown_approval_kind).
  const gate = {terms: !!t && (!x.pay || !!x.transfer), hashOk: true, known: x.known};
  const gateMsg = el('p', {class: 'tiny warn gate-msg', hidden: true});
  const sync = () => {
    const ok = gate.hashOk && gate.terms && gate.known;
    approve.disabled = !ok; gateMsg.hidden = ok;
    if (!gate.known) reject.disabled = true;
    gateMsg.textContent = !gate.known ? 'This page does not know this kind of approval, and the server decides only the kinds it knows: nothing can be decided here.'
      : !gate.hashOk ? 'Approve is off: the terms shown here do not hash to the terms hash you would be approving.'
      : x.pay && t ? 'Approve is off: this page cannot show the transfer you would be approving.' : 'Approve is off: this page cannot show the terms you would be approving.';
  };
  const ack = null;
  const reenable = () => { reject.disabled = false; sync(); };
  approve.addEventListener('click', () => decide(a, 'approve', note, out, [approve, reject], reenable));
  reject.addEventListener('click', () => decide(a, 'reject', note, out, [approve, reject], reenable));
  sync();
  const comp = x.pay ? x.s?.completion ?? null : null;
  const proofRows = [
    ['Terms hash', [code(a.terms_hash), t ? el('div', {}, hashCheck(canonical(t), a.terms_hash, 'terms hash', ok => { if (ok === false) { gate.hashOk = false; sync(); } })) : null]],
    x.pay && ["Your agent's acceptance of the delivery", comp?.signature
      ? [code(comp.signature), el('div', {class: 'tiny'}, 'over the text ', signedText(comp.statement), ' ', SRC.key(me.handle))]
      : el('span', {class: 'warn'}, 'not returned by the server for this approval')],
    [x.issue ? "Your agent's acceptance of the delivery" : x.pay ? "Your agent's payment statement (it pays this deal by exactly this transfer)" : "Your agent's signature", x.signature
      ? [code(x.signature), el('div', {class: 'tiny'}, 'over the text ', signedText(x.statement), ' with key ', keyFp(x.s?.signer_pubkey), ' ', SRC.key(me.handle))]
      : el('span', {class: 'warn'}, 'not returned by the server for this approval')],
    a.kind === 'accept' && x.s?.offer_signature && [`${handleOf(x.s.offered_by)}'s offer signature`,
      [code(x.s.offer_signature), el('div', {class: 'tiny'}, 'over the text ', signedText(`valun-pilot/propose/1\n${x.s.terms_hash}`), ' ', SRC.key(handleOf(x.s.offered_by)))]],
    a.kind === 'confirm_offer' && x.s && ['Accepted by', [`${handleOf(x.s.accepted_by)}, ${whenRel(x.s.accepted_at)}`,
      el('div', {class: 'tiny'}, `${x.s.why ? `${cap1(x.s.why)}. ` : ''}Its acceptance signature is shown once the deal is agreed.`)]],
  ];
  const agreed = x.issue || x.pay;
  return el('article', {class: 'appr', 'data-approval': a.id, 'data-deal': d.id, 'data-kind': a.kind},
    el('div', {class: 'appr-head'}, tag('owner', x.kindLabel), el('b', {class: 'appr-title'}, t ? t.service.title : 'terms not returned by the server'),
      t ? el('span', {class: 'appr-price'}, pc(t.price.amount, t.price.unit), x.pay ? ` – you pay with ${x.transfer ? (x.transfer.issuer?.handle ?? handleOf(x.transfer.issuer?.id)) : 'another participant'}'s note`
        : t.payer.id === me.id ? ' – you issue the credit note' : ' – you do the work') : null),
    el('div', {class: 'tiny'}, `asked ${whenRel(a.created_at)} · deal `, el('a', {href: `#owner/deal/${d.id}`}, d.id), ` · approval ${a.id}`),
    effectBox(x.effect),
    t ? el('div', {}, el('div', {class: 'stitle'}, agreed ? 'Agreed terms ' : 'Exact terms ',
      agreed ? [SRC.key(handleOf(t.payer.id)), ' ', SRC.key(handleOf(t.payee.id))] : SRC.key(handleOf(a.kind === 'accept' ? x.s.offered_by : me.id))), termsKv(t, me.id, proofRows))
      : [el('p', {class: 'warn'}, x.missing), kv(proofRows)],
    x.countered ? el('details', {}, el('summary', {}, `The offer this counters (version ${x.countered.version}, by ${handleOf(x.countered.by)}). These are not the terms you are approving.`), termsKv(x.countered.terms, me.id)) : null,
    x.issue ? issueNoteDetails(x.s) : x.pay ? payByTransferDetails(x.s) : x.known ? mandateCheck(a, t) : null,
    ack,
    el('div', {class: 'actions'}, note, approve, reject),
    gateMsg,
    out,
    el('p', {class: 'tiny'}, SRC.owner(), ' Your decision is recorded by the Valun server under your owner token. It is not signed with a key.'));
}

// For an issue_note approval: the delivery the agent accepted and the credit note it signed (held by Valun, not in Basis yet).
function issueNoteDetails(s) {
  const dl = s?.delivery, n = s?.credit_note;
  return el('div', {class: 'mcheck'},
    dl ? [el('div', {class: 'stitle'}, 'The delivery your agent accepted ', SRC.key(handleOf(dl.by))),
      kv([['Title', dl.title || '–'], ['Delivered', `${whenRel(dl.at)}${dl.late ? ', after deliver_by (late)' : ''}`],
        ['sha256', [code(dl.sha256), el('div', {}, hashCheck(dl.content, dl.sha256, 'sha256 of the text below'))]]]),
      el('pre', {class: 'deliverable', tabindex: 0}, dl.content)]
      : el('p', {class: 'warn'}, 'The server did not return the delivery.'),
    el('div', {class: 'stitle'}, 'The credit note your agent signed ', SRC.key(S.owner.participant.handle), ' ', SRC.none()),
    n ? kv([['Amount for this deal', el('b', {}, pc(n.amount))], ['Running total for this key pair', `${pc(n.prior_total)} → ${pc(n.total)}`],
      ['Issuer key (your agent)', keyFp(n.issuer_pubkey)], ['Recipient key (the payee)', keyFp(n.recipient_pubkey)],
      n.keys_as_agreed === false && ['Keys', el('span', {class: 'warn'}, 'An agent key changed after the deal was agreed, so the note is between the current keys.')],
      ['Signed note message (80 bytes)', el('details', {}, el('summary', {}, 'debt key ‖ running total ‖ timestamp ‖ tracker NFT id'), code(n.message_hex, 'small'))],
      ['Note signature', code(n.signature)], n.signed_at && ['Signed', whenRel(n.signed_at)],
      // A bound note (mode bound and above): signed with the pair's current total, so the tracker records it only
      // while that total is unchanged, and only until one hour after its timestamp.
      n.bound && ['Bound note', `the tracker records it only while the pair's total is still ${pc(n.prior_total)}, and only until ${whenRel(n.expires_at)}`],
      n.bound && ['Prior acknowledgment signature', code(n.prior_signature)]])
      : el('p', {class: 'warn'}, 'The server did not return the credit note.'),
    el('p', {class: 'tiny'}, "Valun holds the signed note until you decide: it is not in the Basis tracker, and the payee cannot see its signature yet. Approving issues it: you then owe that amount, as an outstanding obligation; nothing is settled."));
}

// One edge of a transfer or set-off: issuer -> recipient, its note on the tracker before (an EdgeState: total, timestamp
// and the issuer's signature), the new total the operation signs, and the change.
const edgeName = e => `${e.issuer?.handle ?? handleOf(e.issuer?.id)} → ${e.recipient?.handle ?? handleOf(e.recipient?.id)}`;
function edgeRows(edges, unit = 'PC') {
  return tableWrap(el('table', {class: 'tbl'}, thead(['edge (issuer owes recipient)', 'before', 'after', 'change', 'note on the tracker before']),
    el('tbody', {}, ...(edges || []).map(e => el('tr', {},
      el('td', {}, edgeName(e), e.your_role ? el('div', {class: 'tiny'}, `you: ${e.your_role}`) : null),
      el('td', {}, pc(e.before?.total ?? 0, unit)), el('td', {}, el('b', {}, pc(e.new_total, unit))), el('td', {}, `${e.change > 0 ? '+' : ''}${NF.format(e.change ?? 0)}`),
      el('td', {class: 'tiny'}, e.before ? [`timestamp ${e.before.timestamp} · signature `, code(short(e.before.signature, 8, 6))] : 'no note yet on this edge'))))));
}
// For a pay_by_transfer approval: the delivery the agent accepted and the transfer it signed (held by Valun: nobody else
// has signed it yet, and the tracker holds nothing of it).
function payByTransferDetails(s) {
  const dl = s?.delivery, tr = s?.transfer;
  return el('div', {class: 'mcheck'},
    dl ? [el('div', {class: 'stitle'}, 'The delivery your agent accepted ', SRC.key(handleOf(dl.by))),
      kv([['Title', dl.title || '–'], ['Delivered', `${whenRel(dl.at)}${dl.late ? ', after deliver_by (late)' : ''}`],
        ['sha256', [code(dl.sha256), el('div', {}, hashCheck(dl.content, dl.sha256, 'sha256 of the text below'))]]]),
      el('pre', {class: 'deliverable', tabindex: 0}, dl.content)]
      : el('p', {class: 'warn'}, 'The server did not return the delivery.'),
    el('div', {class: 'stitle'}, 'The payment by transfer your agent signed ', SRC.key(S.owner.participant.handle), ' ', SRC.none()),
    tr ? [kv([
      ['Pays with', `${pc(tr.amount)} of what ${tr.issuer?.handle ?? handleOf(tr.issuer?.id)} owes you, moved to ${tr.payee?.handle ?? handleOf(tr.payee?.id)}`],
      ['Transfer', `${tr.id} · ${TRANSFER_STATE[tr.state] ?? tr.state}`],
      ['Timestamp', `${tr.timestamp} (it ends in 999 ms: only a debt transfer can use it)`],
      ['Collects signatures until', whenRel(tr.expires_at)],
      ['Quote digest', code(tr.quote_digest)],
      ['Keys', [`issuer `, keyFp(tr.issuer?.pubkey), ` · you `, keyFp(tr.payer?.pubkey), ` · payee `, keyFp(tr.payee?.pubkey)]]]),
      edgeRows([{...tr.from_edge, your_role: 'creditor (your claim falls)'}, {...tr.to_edge, your_role: 'payer (the payee\'s claim rises)'}])]
      : el('p', {class: 'warn'}, 'The server did not return the transfer.'),
    el('p', {class: 'tiny'}, `Your agent signed your edge's current total, its new total and the payee's new total, at that timestamp. The tracker applies the transfer only when ${tr?.issuer?.handle ?? 'the issuer'} and ${tr?.payee?.handle ?? 'the payee'} have signed too, and only while both notes are exactly as shown; nobody but the signer sees a signature until then. What ${tr?.issuer?.handle ?? 'the issuer'} owes in total does not change.`));
}

async function decide(a, decision, noteInput, out, buttons, reenable) {
  buttons.forEach(b => { b.disabled = true; });
  showMsg(out, decision === 'approve' ? 'Recording your approval…' : 'Recording your rejection…');
  S.busy = true;
  try {
    const r = await api('POST', `/owner/approvals/${a.id}`, {token: S.token, body: {decision, note: noteInput.value.trim()}});
    S.flash = {ok: true, text: outcomeText(r)};
    showMsg(out, S.flash.text, 'ok');                // visible even if the reload below fails
    S.busy = false;
    await loadOwner();
  } catch (e) {
    S.busy = false;
    showErr(out, e, {write: true});                  // visible even if the reload below fails
    // 409 not_pending / stale_note / stale_payment: the server's state moved on (already decided or void; for a credit
    // note, void because the pair's tracker total changed; for a payment by transfer, void because the transfer changed
    // since the agent signed it: `reason` says what). unknown_approval_kind: the server decides no such kind. Reload, so
    // the console shows that state instead of a card that cannot be decided.
    if (e.status === 409 && ['not_pending', 'stale_note', 'stale_payment', 'unknown_approval_kind'].includes(e.code)) {
      S.flash = {ok: false, text: `Your decision on ${a.id} was not applied: ${e.message} (HTTP 409, ${e.code}). The console below shows the server's current state.`};
      await loadOwner();
      return;
    }
    reenable();
  }
}
function outcomeText(r) {
  const a = r.approval, d = r.deal, other = d.counterparty?.handle ?? 'the counterparty', t = d.current?.terms;
  if (a.kind === 'pay_by_transfer') {
    // The answer is 200 {approval, deal, transfer} also when the tracker refused the transfer right after the approval:
    // transfer.state and transfer.result say what happened.
    const tr = r.transfer, A = tr?.issuer?.handle ?? 'the issuer', C = tr?.payee?.handle ?? other;
    if (a.state !== 'approved') return `Rejected (${a.id}). Nothing moved; deal ${d.id} is back to: ${statusLabel(d.status)}.`;
    if (tr?.state === 'applied') return `Approved (${a.id}). The tracker applied the transfer: ${A} now owes ${C} ${pc(tr.amount)} more and you ${pc(tr.amount)} less; you issued no credit note. Outstanding, not settled.`;
    if (tr?.state === 'collecting') return `Approved (${a.id}). The payment now waits for ${A}'s and ${C}'s signatures (until ${when(tr.expires_at)})${tr.regenerated_from ? '; it was made again after an edge changed' : ''}. Nothing has moved yet.`;
    if (tr?.state === 'applying') return `Approved (${a.id}). The transfer is being applied; the server decides its outcome by reading the tracker back.`;
    return `Approved (${a.id}), but the transfer did not apply (${tr?.result?.code ?? tr?.state ?? 'unknown'}): nothing moved, and deal ${d.id} is now: ${statusLabel(d.status)}.`;
  }
  if (a.kind === 'issue_note') {
    if (a.state !== 'approved') return `Rejected (${a.id}). No credit note reached the tracker; deal ${d.id} is back to: ${statusLabel(d.status)}.`;
    if (ISSUED.includes(d.status) && t) return `Approved (${a.id}). The tracker recorded the credit note: ${handleOf(t.payer.id)} owes ${handleOf(t.payee.id)} ${pc(t.price.amount)} more (outstanding, not settled).`;
    return `Approved (${a.id}). Deal ${d.id} is now: ${statusLabel(d.status)}.`;
  }
  if (a.state !== 'approved') return `Rejected (${a.id}). Deal ${d.id} is now: ${statusLabel(d.status)}.`;
  if (d.status === 'agreed' && t) return `Approved (${a.id}). Deal ${d.id} is agreed: ${handleOf(t.payee.id)} delivers by ${when(t.deliver_by)}; on accepting the delivery, ${handleOf(t.payer.id)} issues a credit note for ${pc(t.price.amount)}.`;
  if (d.status === 'open') return `Approved (${a.id}). Deal ${d.id} is open: ${other} can now accept, counter or decline.`;
  return `Approved (${a.id}). Deal ${d.id} is now: ${statusLabel(d.status)}.`;
}

// ---------------------------------------------------------------- agent connection
function agentCard(o) {
  const ag = o.agent, out = el('div', {class: 'msg'});
  const live = ag.enrollment_pending && Date.parse(ag.enrollment_expires_at) > Date.now();
  const ib = o.inbox || {}, n = k => (ib[k] || []).length;
  const actions = el('div', {class: 'actions'});
  let confirm = null;
  if (!ag.enrolled) {
    actions.append(el('button', {type: 'button', id: 'issue-code', onclick: ev => issueCode(ev.currentTarget, out)}, ag.enrollment_pending ? 'Issue a new enrollment code (replaces the old one)' : 'Issue an enrollment code'));
  } else {
    const yes = el('button', {type: 'button', class: 'danger'}, 'Yes, revoke the agent');
    confirm = el('div', {class: 'confirm', hidden: true},
      el('p', {}, el('b', {}, 'Revoke the agent now? '), 'Its key and its agent token stop working at once. A new enrollment code is shown once, so that an agent can enroll a new key.'),
      el('p', {}, el('b', {}, 'Revoking cancels everything not yet agreed: '), 'the offers your agent made (listed below), offers made to it, and acceptances waiting for an owner. A credit note your agent signed that waits for your approval is voided; that deal returns to "delivered".'),
      el('p', {}, el('b', {}, 'Agreed deals stay. '), 'They bind you, not the key: your next agent key delivers, accepts the delivery or issues the credit note for them. Credit notes already issued under this key stay on the tracker and still count as yours.'),
      openOffersBox(o),
      el('div', {class: 'actions'}, yes, el('button', {type: 'button', class: 'secondary', onclick: () => { confirm.hidden = true; }}, 'Cancel')));
    yes.addEventListener('click', () => revokeAgent(yes, out));
    actions.append(el('button', {type: 'button', class: 'danger-outline', onclick: () => { confirm.hidden = false; }}, 'Revoke agent…'));
  }
  return el('div', {class: 'card', id: 'agent-card'}, el('h2', {}, 'Agent connection ', SRC.valun()),
    kv([
      ['Status', ag.enrolled ? el('b', {class: 'good'}, 'enrolled: an agent key is registered') : el('b', {class: 'warn'}, 'not enrolled: no agent key registered')],
      ag.enrolled && ['Key fingerprint', keyFp(ag.pubkey)],
      [el('span', {title: LAST_SEEN_WHY}, 'Agent last seen'), ag.last_seen ? whenRel(ag.last_seen) : 'never'],
      o.past_keys?.length && ['Earlier keys', el('div', {}, ...o.past_keys.map(k => el('div', {}, keyFp(k.pubkey),
        el('span', {class: 'tiny'}, k.revoked_at ? ` revoked ${when(k.revoked_at)}` : k.recovered_from ? ' (linked from signed deal terms)' : ''))),
        el('div', {class: 'tiny'}, 'Tracker notes under these keys still count as yours.'))],
      !ag.enrolled && ['Enrollment code', !ag.enrollment_pending ? 'none issued' : live ? `issued, valid until ${whenRel(ag.enrollment_expires_at)}` : `expired ${whenRel(ag.enrollment_expires_at)}`],
      !ag.enrolled && ag.enrollment_issued_by === 'operator' && ['Code issued by', 'the network operator, at your request'],
      ag.enrolled && ag.key_registered_at && ['Key registered', whenRel(ag.key_registered_at)],
      ag.enrolled && ["Agent's inbox", `${n('respond')} to answer · ${n('deliver')} to deliver · ${n('review_delivery')} deliveries to review · ${n('awaiting_your_owner')} waiting for you` +
        (Array.isArray(ib.payments_in_progress) ? ` · ${count(n('payments_in_progress'), 'payment by transfer', 'payments by transfer')} in progress · ${count(ib.consents_waiting_for_your_client ?? 0, 'consent', 'consents')} for its client to sign` : '')],
      o.features && ['Consents its client signs', o.features.server_run ? 'every kind: the server signs for this participant (the operator holds its keys)'
        : o.features.consent_roles?.length ? [`${o.features.consent_roles.join(', ')} (as its client declared ${whenRel(o.features.consents_declared_at)}; counted until ${when(o.features.consents_count_until)})`]
          : 'none declared: its client does not sign consents by itself, so payments by transfer and set-offs that need its signature are not proposed to it'],
    ]),
    el('p', {class: 'hint'}, ag.enrolled
      ? "The agent signs with its own key; by the pilot's design only its plugin holds it, and the server never receives it. Revoking stops that key and the agent token at once and cancels everything not yet agreed."
      : "Give a valid enrollment code and the participant id to your agent's plugin. It generates its own key and enrolls, sending only the public key and a signed proof."),
    actions, confirm, out);
}
async function issueCode(btn, out) {
  btn.disabled = true; showMsg(out, 'Issuing a code…');
  try { const r = await api('POST', '/owner/enrollment-code', {token: S.token}); showOneTime(r, 'New enrollment code'); showMsg(out, ''); await loadOwner(); }
  catch (e) { showErr(out, e, {write: true}); btn.disabled = false; }
}
async function revokeAgent(btn, out) {
  btn.disabled = true; showMsg(out, 'Revoking…');
  try { const r = await api('POST', '/owner/revoke-agent', {token: S.token}); showOneTime(r, 'Agent revoked. New enrollment code'); showMsg(out, ''); await loadOwner(); }
  catch (e) { showErr(out, e, {write: true}); btn.disabled = false; }
}
function showOneTime(r, title) {
  S.oneTime = {title, pid: S.owner.participant.id, code: r.enrollment_code, expires_at: r.enrollment_expires_at};
  renderOneTime();
}
function clearOneTime() { S.oneTime = null; ONE_TIME.replaceChildren(); }
function renderOneTime() {
  const ot = S.oneTime;
  if (!ot) { ONE_TIME.replaceChildren(); return; }
  ONE_TIME.replaceChildren(el('div', {class: 'card once'},
    el('h2', {}, ot.title),
    el('p', {class: 'warnline'}, 'Shown once: the server keeps only a hash of the code.'),
    kv([['Participant id', code(ot.pid)], ['Enrollment code', el('code', {class: 'mono wrap', id: 'one-time-code'}, ot.code)], ['Expires', `${whenRel(ot.expires_at)}, single use`]]),
    el('p', {class: 'hint'}, "Give both to your agent's plugin. It generates its own key and enrolls, sending only the public key and a signed proof. This card disappears once the code has been used, replaced or has expired."),
    el('div', {class: 'actions'}, copyBtn(`server: ${location.origin}\nparticipant_id: ${ot.pid}\nenrollment_code: ${ot.code}`, 'Copy both for the plugin'),
      el('button', {type: 'button', class: 'secondary btn-small', onclick: clearOneTime}, 'Done – hide this'))));
}

// ---------------------------------------------------------------- open offers, earlier keys
// Offers this participant's agent made that the other side can still turn into an agreed deal without this agent (or its
// owner) acting again: open offers, and offers the other side accepted whose acceptance waits for the other side's owner.
// At acceptance the server checks this participant's mandate again as it is then (lib/pilot/core.mjs accept()), and
// revoking the agent cancels them.
function agentOpenOffers(o) {
  const me = o.participant.id;
  return (o.deals || []).filter(d => d.current && d.current.by === me && ['open', 'accepted_awaiting_owner'].includes(d.status));
}
function openOffersBox(o) {
  const list = agentOpenOffers(o);
  return el('div', {class: 'open-offers'},
    el('div', {class: 'stitle'}, `Offers your agent made that the other side can still accept (${list.length}) `, SRC.valun()),
    list.length ? el('ul', {class: 'offer-list'}, ...list.map(d => {
      const t = d.current.terms, who = d.counterparty?.handle ?? 'the other side';
      return el('li', {}, el('a', {href: `#owner/deal/${d.id}`}, t.service.title), ` · ${who} · ${pc(t.price.amount, t.price.unit)}, you ${d.your_role === 'payer' ? 'issue the credit note' : 'do the work'} · `,
        d.status === 'open' ? `open until ${whenRel(t.offer_expires_at)}`
          : `${who} accepted it; the deal is agreed if ${who}'s owner approves before ${whenRel(t.offer_expires_at)}`);
    })) : el('p', {class: 'tiny'}, 'None right now.'));
}

// ---------------------------------------------------------------- position, deals, decided approvals
function positionCard(pos, o = null) {
  const stat = (label, n, sub) => el('div', {class: 'stat'}, el('div', {class: 'l'}, label), el('div', {class: 'n'}, pc(n, pos.unit)), el('div', {class: 'l'}, sub));
  const COUNT_LABEL = {credit_notes_issued: 'credit notes issued', paid: 'credit notes issued', open: 'open or awaiting an owner',
    agreed_note_not_issued: 'agreed, credit note not issued yet', agreed_unpaid: 'agreed, credit note not issued yet', disputed: 'disputed', declined: 'declined',
    expired_or_withdrawn: 'expired, withdrawn or rejected', paid_by_transfer: 'paid by transfer', payment_due: 'payment due (accepted, unpaid)'};
  // Circulating credit (server release v16, modes sandbox and on): the position also says what moved (transfers), what
  // set-offs cleared, which held notes could pay a deal now, and what is under way.
  const circ = pos.gross !== undefined;
  const spendable = (pos.spendable_notes || []).reduce((a, n) => a + (n.spendable || 0), 0);
  const opRun = c => (c.operator_run ? el('span', {class: 'tiny'}, ` (${c.label || 'issued with keys the operator holds'})`) : null);
  const SPEED = {immediate: 'at once (the server signs for it)', auto: 'by itself, now (its client signs and was seen in the last 10 minutes)',
    when_online: 'by itself, when its agent is next online', unavailable: 'not: its client does not sign issuer consents'};
  return el('div', {class: 'card'}, el('h2', {}, 'Position ', SRC.basis()),
    circ ? [el('div', {class: 'posgrid'}, stat('Hold', pos.claims_held, 'others owe you'), stat('Owe', pos.owes, 'you owe others'), stat('Net', pos.net, 'hold minus owe')),
      el('div', {class: 'posgrid'}, stat('Cleared', pos.cleared_by_setoff, 'by set-off only; nothing is redeemed'),
        stat('Spendable', spendable, 'of the notes you hold, now'), stat('Gross', pos.gross, 'hold plus owe'))]
      : el('div', {class: 'posgrid'}, stat('Claims held', pos.claims_held, 'others owe you'), stat('You owe', pos.owes, 'notes your agent signed'), stat('Net', pos.net, 'claims minus owes')),
    pos.claims?.length ? kv(pos.claims.map(c => [`${c.from ?? 'unknown'} owes you`, [pc(c.amount, pos.unit), opRun(c)]])) : null,
    pos.debts?.length ? kv(pos.debts.map(c => [`you owe ${c.to ?? 'unknown'}`, [pc(c.amount, pos.unit), opRun(c)]])) : null,
    el('p', {class: 'tiny'}, pos.meaning || 'These are outstanding credit notes, as the tracker records them. Nothing in the pilot is settled: there is no redemption, reserve or clearing.'),
    pos.settled != null ? kv([['Settled', [pc(pos.settled, pos.unit), pos.settled_how ? el('span', {class: 'tiny'}, ` (${pos.settled_how})`) : null]]]) : null,
    circ ? kv([
      ['Moved by transfer', `${pc(pos.transferred_in, pos.unit)} to you, ${pc(pos.transferred_out, pos.unit)} from you (your claims spent); ${pc(pos.novated_as_issuer, pos.unit)} of your own debt moved to another creditor`],
      pos.frozen_claims ? ['Under earlier keys', `${pc(pos.frozen_claims, pos.unit)}: frozen (they still count; they cannot be spent or cleared)`] : null,
      pos.pending && ['Under way', `${count(pos.pending.paying_by_transfer, 'payment by transfer', 'payments by transfer')} you make; ${count(pos.pending.consents_waiting_for_you, 'consent', 'consents')} waiting for your agent's client; ${pos.pending.consents_waiting_for_others} waiting for others`],
    ]) : null,
    pos.spendable_notes?.length ? [el('div', {class: 'stitle'}, 'Notes you hold that could pay a deal ', SRC.basis(), ' ', SRC.valun()),
      tableWrap(el('table', {class: 'tbl'}, thead(['issuer (owes you)', 'outstanding', 'held by a payment', 'spendable now', 'the issuer signs']),
        el('tbody', {}, ...pos.spendable_notes.map(n => el('tr', {}, el('td', {}, n.issuer_handle ?? handleOf(n.issuer_id), el('div', {class: 'tiny'}, keyFp(n.issuer_pubkey))),
          el('td', {}, pc(n.outstanding, pos.unit)), el('td', {}, pc(n.reserved, pos.unit)), el('td', {}, el('b', {}, pc(n.spendable, pos.unit))),
          el('td', {class: 'tiny'}, SPEED[n.issuer_consents] ?? n.issuer_consents)))))),
      el('p', {class: 'tiny'}, 'Spendable: the part of a note that reconciles exactly with Valun\'s edge journal, under both parties\' current keys, and that no payment holds. Paying with it needs your owner\'s pay_with_held_notes and the payee\'s acceptance of that issuer.')] : null,
    el('div', {class: 'stitle'}, 'Deal counts ', SRC.valun()),
    kv(Object.entries(pos.deals || {}).map(([k, v]) => [COUNT_LABEL[k] ?? k.replace(/_/g, ' '), String(v ?? 0)])),
    el('p', {class: 'tiny'}, `Backing: ${pos.backing}`));
}

// ---------------------------------------------------------------- circulating credit (server release v16)
// Payments by transfer whose outcome only this owner can resolve: the deal view holds the resolve action.
function unresolvedCard(o) {
  const list = unresolvedPayments(o);
  if (!list.length) return null;
  return el('div', {class: 'card approvals has-pending', id: 'unresolved-card'},
    el('h2', {}, 'Payment attempts only you can resolve ', el('span', {class: 'count on'}, String(list.length))),
    el('p', {class: 'hint'}, "Reading the tracker back could not tell whether these payments by transfer applied. No other payment of the deal starts until you resolve it, after confirming with the payee whether it was paid. Open the deal to resolve it."),
    el('ul', {class: 'offer-list'}, ...list.map(d => { const p = transferOf(d); return el('li', {}, el('a', {href: `#owner/deal/${d.id}`}, d.current?.terms?.service?.title ?? d.id),
      ` · ${pc(p.amount)} to ${d.counterparty?.handle ?? 'the payee'} with ${p.issuer?.handle ?? handleOf(p.issuer?.id)}'s note · ${TRANSFER_STATE[p.state] ?? p.state}`); })));
}
// A consent item (GET /consents): what the participant's client would sign, on its own edges only.
function consentItemView(c) {
  const ctx = c.context || {}, sum = c.summary || {};
  return el('article', {class: 'ver'},
    el('div', {class: 'stitle'}, `${c.kind === 'setoff' ? 'Set-off' : 'Payment by transfer'} ${c.id} · your role: ${(c.your_roles || []).join(', ')} · until ${whenRel(c.expires_at)}`),
    kv([c.kind === 'transfer' && ['Payment', `${pc(ctx.amount)}: ${ctx.payer?.handle ?? '?'} pays ${ctx.payee?.handle ?? '?'} with ${ctx.issuer?.handle ?? '?'}'s debt${ctx.deal ? ` (deal ${ctx.deal.deal_id})` : ''}`],
      c.kind === 'setoff' && ['Clears', `${pc(ctx.amount)} of your claims, and as much of your debts`],
      ['Your net position changes by', pc(sum.your_net_change_PC)], ['What you owe changes by', pc(sum.your_total_owed_change_PC)]]),
    edgeRows((c.edges || []).map(e => ({...e, your_role: `${e.your_role}${e.signed_by_you?.length ? `, signed (${e.signed_by_you.join(', ')})` : `, to sign (${(e.slots || []).join(', ')})`}`}))));
}
const SLOT_LABEL = {issuer_from: "issuer, the payer's edge's new total", issuer_to: "issuer, the payee's edge's new total", from_recipient_prior: "payer, its edge's total before",
  from_recipient: "payer, its edge's new total", from_recipient_to: "payer, the payee's edge's new total", to_recipient_prior: "payee, its edge's total before", to_recipient: "payee, its edge's new total"};
// GET /transfers/{vt}: what this party sees (its own edges; signatures only once the tracker recorded the transfer).
function transferDetails(v) {
  const sig = Object.entries(v.signatures || {}), sha = Object.entries(v.signature_sha256 || {}), after = Object.entries(v.tracker_after || {});
  return el('div', {class: 'mcheck'},
    kv([['Transfer', `${v.id} · attempt ${v.attempt}${v.regenerated_from ? ` (made again, replacing ${v.regenerated_from})` : ''}${v.regenerated_as ? ` (made again as ${v.regenerated_as})` : ''}`],
      ['State', TRANSFER_STATE[v.state] ?? v.state], ['Your role', (v.your_roles || []).join(', ')],
      ['Parties', `${v.issuer?.handle} (issuer) · ${v.payer?.handle} (payer) · ${v.payee?.handle} (payee)`], ['Amount', pc(v.amount)],
      ['Timestamp', `${v.timestamp} (${when(msIso(v.timestamp))})`], ['Created', whenRel(v.created_at)], ['Collects until', whenRel(v.expires_at)],
      v.deal && ['Deal', `${v.deal.deal_id} · price ${pc(v.deal.price)} · quote ${short(v.deal.quote_digest)}`],
      v.result && ['Result', `${v.result.code}${v.result.tracker_status ? ` (tracker HTTP ${v.result.tracker_status})` : ''}${v.result.rule ? `, rule ${v.result.rule}` : ''}${v.result.by ? ` of the ${v.result.by}` : ''} · ${whenRel(v.result.at)}`],
      v.fallback_after && ['Any new payment from', whenRel(v.fallback_after)],
      v.resolution && ['Resolved by the payer\'s owner', `${v.resolution.outcome === 'applied' ? 'applied' : 'not applied'}, ${whenRel(v.resolution.at)}`],
      v.signatures_withheld && ['Signatures', el('span', {class: 'hint'}, v.signatures_withheld)]]),
    edgeRows(v.edges),
    sig.length ? [el('div', {class: 'stitle'}, 'Your receipt: the signatures on your edges ', SRC.basis()), kv(sig.map(([k, s]) => [SLOT_LABEL[k] ?? k, code(s)]))] : null,
    after.length ? kv(after.map(([w, s]) => [`${w === 'from' ? "payer's" : "payee's"} edge as read back`, s ? `${pc(s.total)} at ${s.timestamp}${s.signature ? ` · ${short(s.signature, 8, 6)}` : s.signature_sha256 ? ` · signature sha256 ${short(s.signature_sha256)}` : ''}` : '–'])) : null,
    sha.length ? el('details', {}, el('summary', {}, 'sha256 of the signatures purged from the record'), kv(sha.map(([k, h]) => [SLOT_LABEL[k] ?? k, code(h)]))) : null);
}
// GET /setoffs/{vs}: the member's own edges; signatures once the tracker recorded the set-off.
function setoffDetails(v) {
  const sig = Object.entries(v.signatures || {}), after = Object.entries(v.tracker_after || {}), sha = Object.entries(v.signature_sha256 || {});
  return el('div', {class: 'mcheck'},
    kv([['Set-off', v.id], ['State', SETOFF_STATE[v.state] ?? v.state], ['Created', whenRel(v.created_at)], v.applied_at && ['Applied', whenRel(v.applied_at)],
      ['Your net position changed by', pc(v.summary?.your_net_change_PC)], ['What you owe changed by', pc(v.summary?.your_total_owed_change_PC)],
      v.result && ['Result', `${v.result.code}${v.result.tracker_status ? ` (tracker HTTP ${v.result.tracker_status})` : ''} · ${whenRel(v.result.at)}`],
      v.signatures_withheld && ['Signatures', el('span', {class: 'hint'}, v.signatures_withheld)]]),
    edgeRows(v.edges),
    sig.length ? [el('div', {class: 'stitle'}, 'Your receipt: the signatures on your edges ', SRC.basis()),
      kv(sig.map(([edge, s]) => [`${short(edge, 8, 8)}`, el('div', {}, el('div', {}, 'issuer ', code(s.issuer)), el('div', {}, 'creditor ', code(s.recipient)))]))] : null,
    after.length ? kv(after.map(([edge, s]) => [`${short(edge, 8, 8)} as read back`, s ? `${pc(s.total)} at ${s.timestamp}` : '–'])) : null,
    sha.length ? el('details', {}, el('summary', {}, 'sha256 of the signatures purged from the record'), kv(sha.map(([edge, h]) => [short(edge, 8, 8), `issuer ${short(h.issuer)} · creditor ${short(h.recipient)}`]))) : null);
}
// A receipt line: a transfer or set-off that ended in the last 24 hours, with its view on request.
function receiptLine(r) {
  const box = el('div', {}), out = el('div', {class: 'msg', role: 'status'});
  const btn = el('button', {type: 'button', class: 'secondary btn-small'}, 'Show');
  btn.addEventListener('click', async () => {
    btn.disabled = true; showMsg(out, 'Loading…');
    try { const v = await api('GET', `/${r.kind === 'setoff' ? 'setoffs' : 'transfers'}/${r.id}`, {token: S.token}); box.replaceChildren(r.kind === 'setoff' ? setoffDetails(v) : transferDetails(v)); showMsg(out, ''); }
    catch (e) { showErr(out, e); } finally { btn.disabled = false; }
  });
  return el('li', {}, `${r.kind === 'setoff' ? 'Set-off' : 'Payment by transfer'} ${r.id}: ${(r.kind === 'setoff' ? SETOFF_STATE : TRANSFER_STATE)[r.state] ?? r.state}, ${rel(r.at)} `, btn, out, box);
}
// The participant's edges on the tracker and its edge-journal entries (GET /edges, pages of 200 from the oldest; read on
// request: at most 10 pages, the newest 30 entries shown).
function edgesBox() {
  const box = el('div', {}), out = el('div', {class: 'msg', role: 'status'});
  const btn = el('button', {type: 'button', class: 'secondary btn-small'}, 'Show your edges and their journal');
  btn.addEventListener('click', async () => {
    btn.disabled = true; showMsg(out, 'Loading…');
    try {
      let since = 0, page = null, entries = [];
      for (let i = 0; i < 10; i++) {
        page = await api('GET', `/edges?since=${since}`, {token: S.token});
        entries = entries.concat(page.journal || []);
        if ((page.journal?.length ?? 0) < 200 || page.next_seq <= since) break;      // a short page is the last one
        since = page.next_seq;
      }
      const row = (e, dir) => el('tr', {}, el('td', {}, dir === 'in' ? `${e.issuer?.handle ?? short(e.issuer_pubkey)} owes you` : `you owe ${e.recipient?.handle ?? short(e.recipient_pubkey)}`),
        el('td', {}, pc(e.total)), el('td', {}, e.exact ? 'yes' : el('span', {class: 'warn'}, 'no')), el('td', {}, e.bound_only ? 'yes' : 'no'), el('td', {}, pc(e.reserved)), el('td', {}, e.frozen ? 'frozen (earlier key)' : '–'));
      box.replaceChildren(tableWrap(el('table', {class: 'tbl'}, thead(['edge', 'total on the tracker', 'exact', 'bound notes only', 'held by a payment or set-off', 'key']),
        el('tbody', {}, ...(page?.incoming || []).map(e => row(e, 'in')), ...(page?.outgoing || []).map(e => row(e, 'out'))))),
        entries.length ? tableWrap(el('table', {class: 'tbl'}, thead(['journal seq', 'what', 'change', 'total after', 'when']),
          el('tbody', {}, ...entries.slice(-30).reverse().map(e => el('tr', {}, el('td', {class: 'mono'}, String(e.seq)),
            el('td', {}, `${e.kind}${e.ref ? ` · ${e.ref}` : ''}`), el('td', {}, `${e.delta > 0 ? '+' : ''}${NF.format(e.delta)}`), el('td', {}, pc(e.total_after)), el('td', {class: 'tiny'}, when(e.at))))))) : el('p', {class: 'tiny'}, 'No journal entries yet.'),
        el('p', {class: 'tiny'}, "Exact: the tracker's note on the edge (total, timestamp and signature) is the one Valun's last event there left. Bound notes only: a transfer or set-off changed the edge, so the tracker takes only bound credit notes on it now."));
      showMsg(out, '');
    } catch (e) { showErr(out, e); } finally { btn.disabled = false; }
  });
  return el('div', {}, el('div', {class: 'actions'}, btn), out, box);
}
// Clearing and consents: this participant's consents (read-only for the owner) and what ended in the last 24 hours.
function clearingCard(o) {
  if (!o.credit_policy) return null;      // circulating credit is off on this server: /owner has no credit_policy
  const head = el('h2', {}, 'Clearing and consents ', SRC.valun());
  if (S.consentsUnavailable) return el('div', {class: 'card', id: 'clearing-card'}, head,
    el('p', {class: 'hint'}, 'On this server circulating credit is on for sandbox participants only, and this participant is not one: it takes part in no payment by transfer or set-off.'));
  const c = S.consents, items = c?.consents || [], recent = c?.recently_resolved || [];
  return el('div', {class: 'card', id: 'clearing-card'}, head,
    el('p', {class: 'hint'}, "Your agent's client signs these by itself, within your policy (auto_clear, novate_own_debt, accept_transfers and the lists below), or refuses them; you can read them here, not sign them. A set-off never changes anyone's net position, and nobody sees a signature before the tracker records it."),
    c?.error ? el('div', {class: 'msg err'}, errorView(c.error)) : null,
    el('div', {class: 'stitle'}, `Waiting for signatures (${items.length})`),
    items.length ? el('div', {}, ...items.map(consentItemView)) : el('p', {class: 'tiny'}, 'None right now.'),
    el('div', {class: 'stitle'}, `Ended in the last 24 hours (${recent.length}): receipts`),
    recent.length ? el('ul', {class: 'offer-list'}, ...recent.map(receiptLine)) : el('p', {class: 'tiny'}, 'None.'),
    edgesBox());
}

const EVENT_SHORT = {proposed: 'proposed', countered: 'counter-offer', accepted: 'accepted', owner_approved: 'owner approved', owner_rejected: 'owner rejected', agreed: 'agreed',
  delivered: 'delivered', delivery_accepted: 'delivery accepted', payment_recorded: 'credit note recorded', credit_note_recorded: 'credit note recorded',
  payment_failed: 'credit note failed', credit_note_failed: 'credit note failed', credit_note_awaiting_owner: 'credit note awaiting owner',
  owner_approval_void_stale: 'owner approval void', disputed: 'disputed', declined: 'declined', withdrawn: 'withdrawn', expired: 'expired', expired_before_owner_approval: 'expired',
  cancelled: 'cancelled', credit_note_void: 'credit note voided', counter_expired_before_owner_approval: 'counter-offer expired',
  expired_undelivered: 'ended: not delivered', held_for_proposer_owner: "held for the proposer's owner",
  // Circulating credit (release v16): payment by debt transfer. The server records these events; the spec draft's names
  // (transfer_* and setoff_applied) are listed too.
  payment_by_transfer: 'paying by transfer', payment_awaiting_owner: 'payment awaiting owner', paid_by_transfer: 'paid by transfer',
  payment_due: 'payment due', payment_void: 'payment void', payment_outcome_unknown: 'payment outcome unknown',
  payment_by_transfer_regenerated: 'payment made again', payment_attempt_resolved: 'payment attempt resolved',
  transfer_created: 'transfer created', transfer_applied: 'transfer applied', transfer_failed: 'transfer failed', transfer_expired: 'transfer expired',
  setoff_applied: 'set-off applied'};
function dealsCard(deals) {
  return el('div', {class: 'card', id: 'deals-card'}, el('h2', {}, `All deals (${deals.length}) `, SRC.valun()),
    deals.length ? tableWrap(el('table', {class: 'tbl'}, thead(['deal', 'counterparty', 'you are', 'price', 'status', 'last activity']),
      el('tbody', {}, ...deals.map(d => {
        const t = d.current?.terms, price = t?.price?.amount ?? d.versions.at(-1)?.price?.amount, last = displayHistory(d.history).at(-1);
        return el('tr', {},
          el('td', {}, el('a', {href: `#owner/deal/${d.id}`}, t?.service?.title ?? 'terms not visible to you yet'), el('div', {class: 'tiny mono'}, d.id)),
          el('td', {}, d.counterparty?.handle ?? '–'), el('td', {}, d.your_role), el('td', {}, price != null ? pc(price) : '–'),
          el('td', {}, dealChip(d), ' ', overdueChip(d)), el('td', {class: 'tiny'}, last ? `${EVENT_SHORT[last.event] || last.event}, ${rel(last.at)}` : '–'));
      }))))
      : el('p', {class: 'hint'}, 'No deals yet. Your agent proposes and answers deals with its own key; they appear here.'));
}
function decidedCard(decided) {
  if (!decided.length) return null;
  return el('div', {class: 'card'}, el('details', {}, el('summary', {}, `Decided and void approvals (${decided.length})`),
    tableWrap(el('table', {class: 'tbl'}, thead(['approval', 'what', 'decision', 'when', 'note']),
      el('tbody', {}, ...decided.map(a => el('tr', {},
        el('td', {class: 'mono'}, a.id), el('td', {}, `${kindName(a)} v${a.version} · `, el('a', {href: `#owner/deal/${a.deal_id}`}, a.deal_id)),
        el('td', {}, a.state.replace(/_/g, ' ')), el('td', {class: 'tiny'}, when(a.decided_at || a.created_at)), el('td', {}, a.note || '–')))))),
    el('p', {class: 'tiny'}, SRC.owner())));
}

// ---------------------------------------------------------------- mandate editor
const NUM_FIELDS = [   // [name, label, explanation, optional: shown only when the server's mandate has the field]
  ['max_issue_per_deal', 'Max credit note per deal (as payer)', 'The largest price your agent may agree to owe in one deal.'],
  ['max_issue_outstanding', 'Max you may owe in total', 'Cap on what you could owe: PC owed on the tracker + agreed deals whose credit note is not issued yet + your agent\'s open offers + the new deal.'],
  ['max_accept_per_deal', 'Max credit note per deal (as payee)', 'The largest price your agent may accept as a credit note for doing work in one deal.'],
  ['max_accept_per_issuer', 'Max claim on any one payer', 'Cap on what one payer could owe you: their notes to you on the tracker + agreed deals whose credit note is not issued yet + open offers + the new deal.'],
  ['min_price_as_payee', 'Min price to work for (min_price_as_payee)', 'Your agent may not commit you to do work in one deal for less than this. 0 = no minimum.', true],
  ['min_payer_coverage_pct', 'Min payer coverage (min_payer_coverage_pct)', "Your agent may accept a credit note only from a payer whose own claims on the tracker cover at least this percentage of everything it would owe, this deal included. It is still the payer's own promise: nothing it holds is transferred to you. 0 = no check; 100 = fully covered.", true, '%'],
  ['approve_above', 'Ask me above (approve_above)', 'A commitment (a proposal, counter-offer or acceptance) priced above this waits for your approval. 0 = every commitment waits for you.'],
];
const numFields = m => NUM_FIELDS.filter(([name, , , optional]) => !optional || name in m);
const toLocalInput = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// Circulating credit (server release v16, modes sandbox and on): the owner's credit policy, part of the mandate. The
// server keeps these fields only in those modes; a phase-2 field the mandate does not hold has its default (null, null,
// true; max_claims_total 40 for a sandbox participant). Only fields the owner changes are sent.
const CIRC_FIELDS = ['auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from', 'refuse_notes_from', 'pay_with_held_notes'];
const CIRC_BOOL = [
  ['auto_clear', 'Clear by set-off (auto_clear)', "Your agent's client may sign set-offs by itself: a cycle of debts is cancelled at once, and nobody's net position changes."],
  ['novate_own_debt', 'Let your debt move (novate_own_debt)', "Your agent's client may sign, as issuer, a payment by transfer that moves part of your debt from one creditor to another: what you owe in total does not change."],
  ['accept_transfers', 'Accept payment by transfer (accept_transfers)', "You may be paid with another participant's debt (its note moves to you), only from the issuers allowed below and within your limits."],
  ['accept_operator_issuers', 'Accept notes issued with operator-held keys (accept_operator_issuers)', 'Off: you take no claim on a participant the server runs (the sandbox agents), as payee of a deal or by transfer.'],
];
const CIRC_NUM = [
  ['max_claims_total', 'Max claims on all payers together (max_claims_total), PC', 'Cap on what you could hold and be owed in total: your claims on the tracker + agreed deals as payee + payments by transfer to you under way + the new one. Empty: no limit.'],
  ['max_issuer_net_debt', 'Max net debt of a payer or issuer (max_issuer_net_debt), PC', "Refuses a claim on a participant whose debts, after counting its own claims at no more than their issuers' coverage, would exceed this. Empty: no check."],
];
const PAY_WITH = [['never', 'never'], ['when_asked', 'when your agent is told to (pay_with)'], ['prefer', 'whenever a held note can pay']];
function circulationPolicy(o) {
  const m = o.mandate;
  if (!circulationOn() || !o.credit_policy || !CIRC_FIELDS.every(k => k in m)) return null;
  return {...Object.fromEntries(CIRC_FIELDS.map(k => [k, m[k]])),
    max_claims_total: m.max_claims_total !== undefined ? m.max_claims_total : o.participant.sandbox_only ? 40 : null,
    max_issuer_net_debt: m.max_issuer_net_debt !== undefined ? m.max_issuer_net_debt : null,
    accept_operator_issuers: m.accept_operator_issuers !== undefined ? m.accept_operator_issuers : true};
}
function circulationFields(cp, others) {
  // Every id the owner's lists hold stays shown and ticked (participantBoxes), so an unchanged list is never sent.
  const listed = (name, chosen) => participantBoxes(name, others, chosen, p => p.operator_run ? el('span', {class: 'tiny'}, ' – operator-run') : null);
  return [el('h3', {}, 'Circulating credit ', SRC.valun()),
    el('p', {class: 'hint'}, "What your agent's client may sign by itself, and whose notes you accept as payment. Every party signs what changes its own notes; a set-off never changes a net position."),
    el('div', {class: 'mandate-grid'},
      ...CIRC_BOOL.map(([k, label, explain]) => el('div', {class: 'field'}, el('label', {class: 'check'}, el('input', {type: 'checkbox', name: `c_${k}`, checked: !!cp[k]}), label), el('span', {class: 'explain'}, explain))),
      el('label', {}, 'Pay with notes you hold (pay_with_held_notes)', el('select', {name: 'c_pay_with_held_notes'},
        ...PAY_WITH.map(([v, l]) => el('option', {value: v, selected: cp.pay_with_held_notes === v}, l))),
        el('span', {class: 'explain'}, 'Whether your agent may pay a deal with part of a note it holds (a debt transfer), instead of issuing its own credit note.')),
      el('div', {}),
      ...CIRC_NUM.map(([k, label, explain]) => el('label', {}, label, el('input', {type: 'number', name: `c_${k}`, min: 0, max: 100000, step: 1, inputmode: 'numeric', placeholder: 'no limit', value: cp[k] ?? ''}),
        el('span', {class: 'explain'}, explain)))),
    el('fieldset', {class: 'cps'}, el('legend', {}, 'Accept notes from (accept_notes_from)'),
      el('label', {class: 'check'}, el('input', {type: 'radio', name: 'anf_mode', value: 'any', checked: cp.accept_notes_from === 'any'}), 'any issuer'),
      el('label', {class: 'check'}, el('input', {type: 'radio', name: 'anf_mode', value: 'list', checked: cp.accept_notes_from !== 'any'}), 'only those ticked here:'),
      el('div', {class: 'cplist'}, listed('anf', cp.accept_notes_from)),
      el('span', {class: 'explain'}, 'Whose debt you may be paid with by transfer. Your counterparties list does not imply it: ticking none accepts no transfer.')),
    el('fieldset', {class: 'cps'}, el('legend', {}, 'Refuse notes from (refuse_notes_from)'),
      el('div', {class: 'cplist'}, listed('rnf', cp.refuse_notes_from)),
      el('span', {class: 'explain'}, 'You take no claim on these participants at all: not as payee of a deal with them, not by transfer.'))];
}
const sameIds = (a, b) => (a === 'any' || b === 'any') ? a === b : Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join() === [...b].sort().join();
function readCirculation(form, cp, body) {
  const f = new FormData(form), E = form.elements;
  for (const [k] of CIRC_BOOL) if (E[`c_${k}`] && E[`c_${k}`].checked !== cp[k]) body[k] = E[`c_${k}`].checked;
  const pay = String(f.get('c_pay_with_held_notes') ?? cp.pay_with_held_notes);
  if (pay !== cp.pay_with_held_notes) body.pay_with_held_notes = pay;
  for (const [k] of CIRC_NUM) {
    const raw = String(f.get(`c_${k}`) ?? '').trim();
    if (raw !== '' && !/^\d+$/.test(raw)) throw new Error(`${k}: enter a whole number of PC (0 or more), or leave it empty for no limit.`);
    const v = raw === '' ? null : Number(raw);
    if (v !== cp[k]) body[k] = v;
  }
  const anf = f.get('anf_mode') === 'any' ? 'any' : f.getAll('anf').map(String);
  if (!sameIds(anf, cp.accept_notes_from)) body.accept_notes_from = anf;
  const rnf = f.getAll('rnf').map(String);
  if (!sameIds(rnf, cp.refuse_notes_from)) body.refuse_notes_from = rnf;
}

function mandateCard(o) {
  const m = o.mandate, me = o.participant, others = S.dir.filter(p => p.id !== me.id), cp = circulationPolicy(o);
  const chosen = Array.isArray(m.counterparties) ? m.counterparties : [];
  const out = el('div', {class: 'msg', id: 'mandate-msg', role: 'status'});
  const dirty = el('span', {class: 'dirty', hidden: true}, 'unsaved changes');
  const origExp = m.expires_at ? toLocalInput(m.expires_at) : '';
  const field = (input, label, explain) => el('label', {}, label, input, el('span', {class: 'explain'}, explain));
  const checkField = (name, label, explain) => el('div', {class: 'field'}, el('label', {class: 'check'}, el('input', {type: 'checkbox', name, checked: !!m[name]}), label), el('span', {class: 'explain'}, explain));
  const form = el('form', {class: 'form', id: 'mandate-form', novalidate: true, autocomplete: 'off'},
    field(el('textarea', {name: 'objective', maxlength: 1000, rows: 3}, m.objective || ''), 'Objective', 'What the agent is for, in your words. Your agent can read it; the server does not enforce it.'),
    el('div', {class: 'mandate-grid'},
      checkField('may_issue_credit', 'May issue credit notes (may_issue_credit)', 'Your agent may commit you as payer: once you accept a delivery you owe PC (outstanding, not settled).'),
      checkField('may_accept_credit', 'May work for credit (may_accept_credit)', 'Your agent may commit you as payee: you do the work and hold a claim in PC.'),
      'review_deliveries' in m ? checkField('review_deliveries', 'Review deliveries (review_deliveries)', cp ? 'When your agent accepts a delivery, the credit note or payment by transfer it signs waits for your approval before it goes to the tracker.'
        : 'When your agent accepts a delivery, the credit note it signs waits for your approval before it goes to the tracker.') : null,
      'review_deliveries' in m ? el('div', {}) : null,
      ...numFields(m).map(([name, label, explain, , unit = 'PC']) => field(el('input', {type: 'number', name, min: 0, max: 100000, step: 1, inputmode: 'numeric', value: m[name]}), `${label}, ${unit}`, explain))),
    el('fieldset', {class: 'cps'}, el('legend', {}, 'Counterparties'),
      el('label', {class: 'check'}, el('input', {type: 'radio', name: 'cp_mode', value: 'any', checked: m.counterparties === 'any'}), 'any participant'),
      el('label', {class: 'check'}, el('input', {type: 'radio', name: 'cp_mode', value: 'list', checked: m.counterparties !== 'any'}), 'only those ticked here:'),
      el('div', {class: 'cplist'}, participantBoxes('cp', others, chosen, p => p.status !== 'active' ? el('span', {class: 'tiny'}, ' – no agent key yet') : null)),
      el('span', {class: 'explain'}, 'Your agent can propose, counter and accept only with these participants. Ticking none stops every new commitment by your agent. Its open offers to a participant you untick can no longer be accepted (the server checks your mandate again at acceptance).')),
    cp ? circulationFields(cp, others) : null,
    el('div', {class: 'mandate-grid'},
      field(el('input', {type: 'datetime-local', name: 'expires_at', value: origExp, step: 60}), 'Mandate expires at (your local time)', 'After this moment your agent can make no new commitments, and the other side can no longer accept its open offers, until you renew the mandate. Agreed deals continue.'),
      el('div', {class: 'field'}, el('label', {class: 'check'}, el('input', {type: 'checkbox', name: 'no_expiry', checked: !m.expires_at}), 'No expiry'), el('span', {class: 'explain'}, 'The mandate stays valid until you change it.'))),
    el('div', {class: 'actions'}, el('button', {type: 'submit'}, 'Save mandate'),
      el('button', {type: 'button', class: 'secondary', onclick: () => { S.mandateDirty = false; renderConsole(); }}, 'Discard changes'), dirty),
    out);
  const markDirty = () => { S.mandateDirty = true; dirty.hidden = false; };
  form.addEventListener('input', markDirty); form.addEventListener('change', markDirty);
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    let body;
    try { body = readMandate(form, m, origExp); if (cp) readCirculation(form, cp, body); } catch (e) { showMsg(out, e.message, 'err'); return; }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true; showMsg(out, 'Saving…');
    try {
      const r = await api('PUT', '/owner/mandate', {token: S.token, body});
      S.mandateDirty = false;
      S.mandateFlash = r.changed === false ? `No change: the mandate is the same as before (version ${r.mandate_version}).`
        : `Saved: mandate version ${r.mandate_version}. The server enforces it from now on, at every agent action.`;
      await loadOwner();
    } catch (e) { showErr(out, e, {write: true}); btn.disabled = false; }
  });
  if (S.mandateFlash) { showMsg(out, S.mandateFlash, 'ok'); S.mandateFlash = null; }
  return el('div', {class: 'card', id: 'mandate-card'},
    el('div', {class: 'dtitle'}, el('h2', {}, `Mandate (version ${o.mandate_version}) `, SRC.valun()), el('span', {class: 'tiny'},
      o.mandate_changed_by === 'operator' ? `last changed by the network operator at your request${o.mandate_changed_at ? `, ${when(o.mandate_changed_at)}` : ''}; enforced by the server` : 'set by you, enforced by the server')),
    el('p', {class: 'hint'}, 'What your agent may do without asking you. The limits are hard: the server refuses an agent action that would break them, and nothing is recorded. They are checked again when you approve.'),
    el('p', {class: 'hint'}, el('b', {}, 'Changes apply at once. '),
      "Offers your agent already made stay open until they expire or your agent withdraws them, but when the other side accepts one, the server checks your mandate again as it is then: an offer that no longer fits is refused, and one priced above your approve_above waits for you here. Revoking your agent cancels them."),
    openOffersBox(o),
    agentLimitsBox(o),
    form);
}
// Limits the agent recorded from what the owner told it (conversation): server-enforced, only ever stricter than the mandate.
const LIMIT_LABEL = {max_issue_per_deal: 'Max credit note per deal (as payer)', max_issue_outstanding: 'Max you may owe in total',
  max_accept_per_deal: 'Max credit note per deal (as payee)', max_accept_per_issuer: 'Max claim on any one payer',
  min_price_as_payee: 'Min price to work for', min_payer_coverage_pct: 'Min payer coverage',
  // Circulating credit (modes sandbox and on): the credit policy can be recorded too, only ever stricter.
  max_claims_total: 'Max claims on all payers together', max_issuer_net_debt: 'Max net debt of a payer or issuer',
  accept_operator_issuers: 'Accept notes issued with operator-held keys', auto_clear: 'Clear by set-off', novate_own_debt: 'Let your debt move',
  accept_transfers: 'Accept payment by transfer', pay_with_held_notes: 'Pay with notes you hold', accept_notes_from: 'Accept notes from', refuse_notes_from: 'Refuse notes from'};
const CIRC_LIMITS = new Set(['max_claims_total', 'max_issuer_net_debt', 'accept_operator_issuers', 'auto_clear', 'novate_own_debt', 'accept_transfers', 'pay_with_held_notes',
  'accept_notes_from', 'refuse_notes_from']);
// A limit's value as text: PC, a percentage, on/off, a list of participants, or no limit.
function limitText(k, v) {
  if (v === undefined) v = k === 'accept_operator_issuers' ? true : null;
  if (v === null) return 'no limit';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (v === 'any') return 'any participant';
  if (Array.isArray(v)) return v.length ? v.map(handleOf).join(', ') : 'nobody';
  if (k === 'min_payer_coverage_pct') return `${v}%`;
  return typeof v === 'number' ? pc(v) : String(v);
}
function agentLimitsBox(o) {
  const a = o.agent_limits || {}, keys = Object.keys(LIMIT_LABEL).filter(k => a[k] != null), by = o.agent_limits_recorded_by || {};
  const val = (k, v) => `${limitText(k, v)}${by[k] === 'owner' ? ', recorded by you' : ''}`;
  const head = el('div', {class: 'stitle'}, 'Limits your agent recorded from your conversation ', SRC.valun());
  if (!keys.length && !a.notes) return el('div', {class: 'open-offers'}, head,
    el('p', {class: 'tiny'}, 'None yet. When you tell your agent your goals and limits in a conversation, it records them here. The server enforces them, and they can only be stricter than this mandate.'));
  return el('div', {class: 'open-offers'}, head,
    keys.length ? kv(keys.map(k => [LIMIT_LABEL[k], `${val(k, a[k])} (your mandate: ${limitText(k, o.mandate[k])}${CIRC_LIMITS.has(k) && o.effective_limits && k in o.effective_limits ? `; in force: ${limitText(k, o.effective_limits[k])}` : ''})`])) : null,
    a.notes ? kv([['Your goals, as your agent recorded them', el('div', {class: 'pre-wrap'}, a.notes)]]) : null,
    el('p', {class: 'tiny'}, `Recorded ${a.set_at ? whenRel(a.set_at) : ''}. The server enforces the stricter of these and your mandate at every action. Your agent can only make limits stricter than your mandate, never looser.`));
}
// Checkboxes for a participant list of the mandate form (`name`: the input name; `chosen`: the ids the mandate's list
// holds): one per participant in the directory, and one, ticked, for every id the list holds that the directory does not
// show (it could not be read just now, or does not list that participant). So a save keeps the list exactly as it is
// unless the owner ticks or unticks a box: a directory that failed to load never empties a list. `note(p)`: a remark
// for a participant in the directory.
function participantBoxes(name, others, chosen, note = () => null) {
  const ids = Array.isArray(chosen) ? [...new Set(chosen.filter(id => typeof id === 'string'))] : [], shown = new Set(others.map(p => p.id));
  const box = (id, label, remark) => el('label', {class: 'check'}, el('input', {type: 'checkbox', name, value: id, checked: ids.includes(id)}), label, remark);
  const boxes = [...others.map(p => box(p.id, `${p.handle} (${p.operator})`, note(p))),
    ...ids.filter(id => !shown.has(id)).map(id => id === S.owner?.participant?.id ? box(id, `${handleOf(id)} (you)`, null)
      : box(id, handleOf(id), el('span', {class: 'tiny'}, ' – not in the participant directory just now')))];
  return boxes.length ? boxes : [el('span', {class: 'hint'}, S.dirLoaded ? 'No other participants yet.' : 'The participant directory could not be read just now: refresh to choose participants here.')];
}
function readMandate(form, m, origExp) {
  const f = new FormData(form), E = form.elements, body = {objective: String(f.get('objective') || '')};
  body.may_issue_credit = E.may_issue_credit.checked; body.may_accept_credit = E.may_accept_credit.checked;
  if (E.review_deliveries) body.review_deliveries = E.review_deliveries.checked;   // only on servers whose mandate has it
  for (const [k] of numFields(m)) {
    const raw = String(f.get(k) ?? '').trim();
    if (!/^\d+$/.test(raw)) throw new Error(`${k}: enter a whole number of PC (0 or more).`);
    body[k] = Number(raw);
  }
  body.counterparties = f.get('cp_mode') === 'any' ? 'any' : f.getAll('cp').map(String);
  const rawExp = String(f.get('expires_at') || '');
  if (E.no_expiry.checked) { if (m.expires_at !== null) body.expires_at = null; }
  else if (!rawExp) throw new Error('expires_at: pick a date and time, or tick "No expiry".');
  else if (rawExp !== origExp || !m.expires_at) {
    const t = new Date(rawExp);
    if (Number.isNaN(t.getTime())) throw new Error('expires_at: not a valid date and time.');
    body.expires_at = t.toISOString();
  }
  return body;
}

// ================================================================= deal view (owner)
async function showDeal(id) {
  if (!S.token) { showLogin(); return; }
  $('#owner-login').hidden = true; $('#owner-console').hidden = true;
  const box = $('#deal-view'); box.hidden = false;
  box.replaceChildren(backLink(), el('div', {class: 'card'}, el('p', {class: 'hint'}, 'Loading the deal…')));
  try {
    if (!S.owner) await loadOwner({quiet: true});
    if (!S.token) return;
    const d = await api('GET', `/deals/${id}`, {token: S.token});
    remember(d.counterparty);
    if (currentRoute().id === id) renderDeal(d);
  } catch (e) {
    if (e.status === 401) { forgetToken(); showLogin('That owner token is not valid on this server (HTTP 401). It has been removed from this tab.'); return; }
    box.replaceChildren(backLink(), el('div', {class: 'card'}, el('h2', {}, `Deal ${id}`), el('div', {class: 'msg err'}, errorView(e))));
  }
}
const backLink = () => el('a', {class: 'backlink', href: '#owner'}, '← Back to the owner console');

function dealParties(d) {
  const t = d.current?.terms;
  const payer = t?.payer.id ?? (d.your_role === 'payer' ? d.you : d.counterparty.id);
  const payee = t?.payee.id ?? (d.your_role === 'payee' ? d.you : d.counterparty.id);
  return {t, payer, payee, H: id => `${handleOf(id)}${id === d.you ? ' (you)' : ''}`,
    P: id => id === d.you ? 'your' : `${handleOf(id)}'s`,                                   // possessive
    APPROVAL: id => id === d.you ? 'your approval' : `approval by ${handleOf(id)}'s owner`,
    waitOwner: (id, what) => id === d.you ? `Waiting for your approval of the ${what}.` : `Waiting for ${handleOf(id)}'s owner to approve the ${what}.`};
}
const cap1 = s => s ? `${s[0].toUpperCase()}${s.slice(1)}` : s;
function summaryText(d) {
  const {t, payer, payee, H, P, APPROVAL} = dealParties(d), price = t ? pc(t.price.amount, t.price.unit) : 'the price';
  const tr = transferOf(d), A = tr ? (tr.issuer?.handle ?? handleOf(tr.issuer?.id)) : 'the issuer';
  switch (d.status) {
    case 'paid': case 'note_issued': return `Credit note issued, not settled: ${H(payer)} owes ${H(payee)} ${price} under this deal. The payer-signed Basis note is held by the pilot tracker (local only, no chain, no reserve). It is an outstanding obligation; nothing in the pilot is settled.`;
    case 'paying_by_transfer': return `Paying by transfer: ${H(payer)} pays ${H(payee)} ${price} with ${A}'s debt to it: ${A} would owe ${H(payee)} ${price} more and ${H(payer)} ${price} less. It applies only once ${A} and ${H(payee)} have signed, and only while both notes on the tracker are exactly as signed. Nothing has moved yet.`;
    case 'paid_by_transfer': return `Paid by transfer, not settled: ${A} now owes ${H(payee)} ${price} that it owed ${H(payer)} before; ${H(payer)} issued no credit note for this deal. It is an outstanding obligation (nothing is redeemed); it may later move again or be cleared by set-off.`;
    case 'payment_due': return UNRESOLVED.includes(tr?.state)
      ? `${H(payer)} accepted the delivery, but whether its payment by transfer applied cannot be told from the tracker. No other payment starts until ${P(payer)} owner resolves it (after confirming with ${H(payee)}). No dispute is possible any more.`
      : `${H(payer)} accepted the delivery, but its payment did not apply, so the payment is due: no dispute is possible any more, and ${P(payer)} agent pays it again, with its own credit note or by transfer.`;
    case 'completion_awaiting_owner': if (tr?.state === 'awaiting_owner') return `${cap1(P(payer))} agent accepted the delivery and signed a payment by transfer for ${price} with ${A}'s note; it goes ahead only after ${APPROVAL(payer)}. Nothing has moved yet.`;
      return `${cap1(P(payer))} agent accepted the delivery and signed a credit note for ${price}; it goes to the tracker only after ${APPROVAL(payer)}. Nothing is owed yet.`;
    case 'disputed': return `${H(payer)} disputed the delivery. No credit note for this deal is in the Basis tracker, and Valun does not judge the work.`;
    case 'agreed': return `Agreed: ${H(payee)} delivers by ${when(t?.deliver_by)}; on accepting the delivery, ${H(payer)} issues a credit note for ${price}. Nothing is owed yet.`;
    case 'delivered': return 'payment' in d
      ? `Delivered: waiting for ${H(payer)} to accept the delivery, paying ${price} with its own credit note or with a note it holds (a payment by transfer), or to dispute it. Nothing is owed yet.`
      : `Delivered: waiting for ${H(payer)} to accept the delivery, which issues a credit note for ${price}, or to dispute it. Nothing is owed yet.`;
    case 'paying': case 'issuing_note': return 'The payer accepted the delivery and signed the credit note; the server is recording it in the tracker (a restart finishes this).';
    case 'payment_failed': case 'note_failed': return `The tracker did not record the credit note, so nothing is owed in Basis yet. ${cap1(P(payer))} agent can sign it again.`;
    case 'open': return `Open offer (version ${d.current?.version}) by ${H(d.current?.by)}: ${price}. Nothing is agreed yet.`;
    case 'proposed_awaiting_owner': return d.current ? `This proposal waits for ${APPROVAL(d.current.by)}. The other side cannot see it until then.` : "The other side's proposal waits for their owner's approval; you cannot see its terms yet.";
    case 'rejected_by_owner': return d.current ? `This proposal by ${H(d.current.by)} was rejected by ${P(d.current.by)} owner, so it was never offered. Nothing is owed under it.` : `This deal ended: ${statusLabel(d.status)}. Nothing is owed under it.`;
    case 'accepted_awaiting_owner': return `${H(d.acceptance?.by)} accepted version ${d.acceptance?.version}; the acceptance waits for ${APPROVAL(d.acceptance?.by)}. Not agreed yet.`;
    case 'cancelled': return `Cancelled before it was agreed: ${H(d.cancellation?.participant)}'s owner revoked the agent key these terms name. Nothing is owed under it.`;
    case 'expired_undelivered': return `Ended without a delivery: ${H(payee)} did not deliver by ${when(t?.deliver_by)} or in the 7 days after it. Nothing is owed under it.`;
    default: return `This deal ended: ${statusLabel(d.status)}. Nothing is owed under it.`;
  }
}
function waitingText(d) {
  const {t, payer, payee, H, P, waitOwner} = dealParties(d), tr = transferOf(d), circ = 'payment' in d;
  const A = tr ? (tr.issuer?.handle ?? handleOf(tr.issuer?.id)) : 'the issuer';
  if (d.status === 'open' && d.current) { const other = d.current.by === payer ? payee : payer; return `Waiting for ${H(other)} to accept, counter or decline. The offer expires ${whenRel(t?.offer_expires_at)}.`; }
  if (d.status === 'proposed_awaiting_owner') return d.current ? waitOwner(d.current.by, 'proposal') : "Waiting for the other side's owner to approve their proposal.";
  if (d.status === 'accepted_awaiting_owner') return waitOwner(d.acceptance?.by, 'acceptance');
  if (d.status === 'agreed') return `Waiting for ${H(payee)} to deliver, by ${whenRel(t?.deliver_by)}${d.overdue ? ' – overdue' : ''}.`;
  if (d.status === 'delivered') return circ ? `Waiting for ${H(payer)} to accept the delivery (paying with its own credit note or by transfer) or dispute it.` : `Waiting for ${H(payer)} to accept the delivery (issuing the credit note) or dispute it.`;
  if (d.status === 'completion_awaiting_owner') return waitOwner(payer, tr?.state === 'awaiting_owner' ? 'payment by transfer' : 'credit note');
  if (d.status === 'paying_by_transfer') return tr?.state === 'applying' ? 'The transfer is being applied; the server decides its outcome by reading the tracker back.'
    : `Waiting for ${A}'s and ${H(payee)}'s signatures (their clients sign by themselves, within their owners' policies), until ${whenRel(tr?.expires_at)}.`;
  if (d.status === 'payment_due') {
    if (UNRESOLVED.includes(tr?.state)) return d.your_role === 'payer' ? 'Waiting for you: resolve the earlier payment attempt below, after confirming with the payee.' : "Waiting for the payer's owner to resolve the earlier payment attempt.";
    const wait = (d.next_actions || []).includes('wait_for_transfer_window') && tr?.fallback_after ? ` (another payment, the same note's included, from ${whenRel(tr.fallback_after)})` : '';
    return `Waiting for ${P(payer)} agent to pay again: with its own credit note or by transfer${wait}.`;
  }
  if (RECORDING.includes(d.status)) return 'The credit note is being recorded in the tracker.';
  if (NOTE_FAILED.includes(d.status)) return circ ? `Waiting for ${P(payer)} agent to sign the credit note again, or to pay by transfer.` : `Waiting for ${P(payer)} agent to sign the credit note again.`;
  if (ISSUED.includes(d.status)) return circ ? 'Nothing further happens to this deal: the credit note stays outstanding. With circulating credit the claim can move to another creditor or be cleared by set-off; nothing is redeemed.'
    : 'Nothing further happens in the pilot: the credit note stays outstanding (no redemption, reserve or clearing).';
  if (d.status === 'paid_by_transfer') return 'Nothing further happens to this deal: the debt stays outstanding with its new creditor (nothing is redeemed).';
  return null;
}

const EVENT_TITLE = {
  proposed: h => `Proposed version ${h.version}${h.awaiting_owner ? ', held for the proposer\'s owner' : ''}`,
  countered: h => `Counter-offer, version ${h.version}${h.awaiting_owner ? ', held for the owner' : ''}`,
  accepted: h => `Accepted version ${h.version}${h.awaiting_owner ? ', held for the acceptor\'s owner' : ''}`,
  owner_approved: h => h.kind === 'issue_note' ? 'Owner approved issuing the credit note' : h.kind === 'pay_by_transfer' ? 'Owner approved the payment by transfer; it now collects the issuer\'s and the payee\'s signatures'
    : `Owner approved the ${kindName(h)} (version ${h.version})${h.offered ? '; it is now offered' : ''}`,
  owner_rejected: h => h.kind === 'issue_note' ? 'Owner rejected issuing the credit note; nothing reached the tracker' : h.kind === 'pay_by_transfer' ? 'Owner rejected the payment by transfer; nothing moved'
    : `Owner rejected the ${kindName(h)} (version ${h.version})`,
  owner_approval_void_stale: h => h.kind === 'pay_by_transfer' ? `Owner's approval void: the payment changed after the agent signed it (${h.reason ?? 'stale'}); nothing moved`
    : "Owner's approval void: the pair's tracker total changed after the agent signed the credit note",
  agreed: h => `Agreed on version ${h.version}: both signatures in place`,
  delivered: h => `Delivered${h.late ? ', after deliver_by (late)' : ''}`,
  delivery_accepted: () => 'Delivery accepted; the payer signed the credit note (a Basis note)',
  credit_note_awaiting_owner: h => `Credit note for ${pc(h.amount)} held for the payer's owner to approve`,
  payment_recorded: h => `Credit note issued: recorded by the Basis tracker; the running total for this key pair is now ${pc(h.total)} (${h.confirmation}). Outstanding, not settled${h.recovered ? '; finished by recovery after a restart' : ''}`,
  credit_note_recorded: h => `Credit note issued: ${pc(h.amount)} recorded by the Basis tracker; the running total for this key pair is now ${pc(h.cumulative_total)} (${h.confirmation}). Outstanding, not settled${h.recovered ? '; finished by recovery after a restart' : ''}`,
  payment_failed: () => 'Credit note not recorded: the tracker does not hold it',
  credit_note_failed: () => 'Credit note not recorded: the tracker does not hold it',
  disputed: () => 'Delivery disputed by the payer',
  declined: h => `Declined version ${h.version}`,
  withdrawn: h => `Withdrawn version ${h.version}${h.by_owner ? " (the proposer's owner did not confirm it)" : ''}${h.acceptance_voided ? '; the acceptance waiting for an owner is void' : ''}`,
  held_for_proposer_owner: h => `Acceptance held for ${handleOf(h.proposer)}'s owner: the offer is above that owner's current approve_above`,
  expired_undelivered: h => `Ended: not delivered by ${when(h.deliver_by)} or within ${h.grace_days} days after it`,
  expired: h => `Offer expired (version ${h.version})`,
  expired_before_owner_approval: h => `Expired before the owner approved (version ${h.version})`,
  counter_expired_before_owner_approval: h => `Counter-offer (version ${h.version}) expired before the owner decided`,
  cancelled: h => `Cancelled: ${handleOf(h.participant)}'s owner revoked the agent key these terms name`,
  credit_note_void: h => `Signed credit note voided before it reached the tracker: ${handleOf(h.participant)}'s agent key was revoked`,
  // Circulating credit: payment by debt transfer (the issuer's debt to the payer moves to the payee).
  payment_by_transfer: h => `Delivery accepted; the payer's agent signed a payment by transfer: ${pc(h.amount)} of what ${handleOf(h.issuer)} owes the payer, moved to the payee`,
  payment_awaiting_owner: () => "Payment by transfer held for the payer's owner to approve; nobody else has signed it",
  paid_by_transfer: h => `Paid by transfer: the Basis tracker applied it; ${pc(h.amount)} that the issuer owed the payer it now owes the payee. Outstanding, not settled${h.resolved_by_owner ? "; recorded as applied by the payer's owner" : ''}`,
  payment_due: h => `The payment by transfer did not apply (${h.reason ?? 'not applied'}): nothing moved; the delivery stays accepted and the payment is due${h.fallback_after ? `; any new payment of the deal from ${when(h.fallback_after)}` : ''}`,
  payment_void: h => `Payment by transfer void before anyone else signed (${h.reason ?? 'void'}): nothing moved`,
  payment_outcome_unknown: h => `Reading the tracker back cannot tell whether the payment by transfer applied (${h.reason ?? 'unknown'}): no other payment starts until the payer's owner resolves it`,
  payment_by_transfer_regenerated: h => `An edge changed before the transfer applied; it was made again with the edges as they are now (${h.transfer_id}, replacing ${h.regenerated_from})`,
  payment_attempt_resolved: h => `The payer's owner resolved payment attempt ${h.transfer_id}: ${h.outcome === 'applied' ? 'applied' : 'not applied'}${h.fallback_after ? `; any new payment of the deal from ${when(h.fallback_after)}` : ''}`,
  transfer_created: () => 'Payment by transfer created', transfer_applied: () => 'Payment by transfer applied by the Basis tracker',
  transfer_failed: () => 'Payment by transfer failed: nothing moved', transfer_expired: () => 'Payment by transfer expired: nothing moved',
  setoff_applied: () => 'Set-off applied by the Basis tracker: a cycle of debt cancelled; no net position changed',
};
// Deals recorded before 2026-11-05 logged "agreed" just before the event that caused it (the acceptance, or the owner's
// approval of an acceptance), at the same moment. Show the cause first. Nothing else is reordered.
function displayHistory(hist) {
  const h = [...(hist || [])];
  for (let i = 0; i + 1 < h.length; i++) {
    const a = h[i], b = h[i + 1];
    const cause = b.event === 'accepted' || (b.event === 'owner_approved' && b.kind === 'accept');
    if (a.event === 'agreed' && cause && Math.abs(Date.parse(b.at) - Date.parse(a.at)) < 2000) { h[i] = b; h[i + 1] = a; i++; }
  }
  return h;
}
const STEP_CLASS = {payment_failed: 'failed', credit_note_failed: 'failed', disputed: 'failed', owner_rejected: 'failed', declined: 'failed',
  withdrawn: 'na', expired: 'na', expired_before_owner_approval: 'na', owner_approval_void_stale: 'na', credit_note_awaiting_owner: 'pending',
  cancelled: 'na', credit_note_void: 'na', counter_expired_before_owner_approval: 'na', expired_undelivered: 'na', held_for_proposer_owner: 'pending',
  payment_awaiting_owner: 'pending', payment_due: 'failed', payment_void: 'na', payment_outcome_unknown: 'failed', transfer_failed: 'failed', transfer_expired: 'na'};
function historyStep(h) {
  const by = String(h.by || '');
  let src, who = '';
  if (by === 'valun') src = SRC.valun();
  else if (by === 'basis-tracker') src = /failed$/.test(h.event) ? [SRC.basis(), ' ', SRC.none()] : SRC.basis();
  else if (by.startsWith('owner:')) { who = `by ${handleOf(by.slice(6))}'s owner`; src = SRC.owner(); }
  else { who = `by ${handleOf(by)}`; src = SRC.key(handleOf(by)); }
  const det = [
    h.terms_hash && ['Terms hash', code(h.terms_hash)],
    h.sha256 && ['Deliverable sha256', code(h.sha256)],
    h.reason && ['Reason', h.reason],
    h.transfer_id && ['Transfer', code(h.transfer_id)],
    h.fallback_after && ['Any new payment from', whenRel(h.fallback_after)],
    h.note && ['Owner note', h.note],
    h.error && ['Tracker said', h.error],
  ];
  return el('li', {class: `step ${STEP_CLASS[h.event] || 'done'}`},
    el('div', {class: 'stitle'}, (EVENT_TITLE[h.event] || (() => h.event))(h), ' ', src),
    el('div', {class: 'tiny'}, `${whenRel(h.at)}${who ? ` · ${who}` : ''}`),
    det.some(Boolean) ? kv(det) : null);
}

// A version that never left its owner's approval: rejected by the owner, still waiting, or ended (withdrawn, expired)
// while it was held. It was never open for the other side to accept.
function neverOffered(d, v) {
  if (!v) return false;
  if (v.state === 'rejected_by_owner' || v.state === 'awaiting_owner') return true;
  const h = d.history || [];
  return h.some(e => ['proposed', 'countered'].includes(e.event) && e.version === v.version && e.awaiting_owner)
    && !h.some(e => e.event === 'owner_approved' && e.kind === 'propose' && e.version === v.version);
}
const ENDED = ['declined', 'withdrawn', 'expired', 'rejected_by_owner', 'cancelled'];
function termsTitle(d, cur, P) {
  if (d.agreement) return `Agreed terms (version ${d.agreement.version}) `;
  if (!cur) return 'Terms ';
  if (cur.state === 'awaiting_owner') return `Proposal (version ${cur.version}) – waiting for ${P(cur.by)} owner, not offered yet `;
  if (ENDED.includes(d.status)) return neverOffered(d, cur) ? `Proposal never offered (version ${cur.version}) – ${statusLabel(d.status)} ` : `Last offer (version ${cur.version}) – ${statusLabel(d.status)} `;
  return `Current offer (version ${cur.version}) `;
}

function renderDeal(d) {
  const {t, payer, payee, H, P} = dealParties(d), cur = d.current;
  const verOf = n => d.versions.find(v => v.version === n);
  const flash = S.dealFlash?.id === d.id ? S.dealFlash.text : null; S.dealFlash = null;
  const header = el('div', {class: 'card'},
    flash ? el('div', {class: 'msg ok flash', role: 'status'}, flash) : null,
    el('div', {class: 'dtitle'}, el('h2', {}, t ? t.service.title : `Deal ${d.id}`, ' ', SRC.valun()), el('div', {class: 'actions'}, dealChip(d), overdueChip(d))),
    el('p', {class: 'who-owes'}, summaryText(d)),
    kv([['Deal id', code(d.id)], ['You are', d.your_role === 'payer' ? 'the payer: you issue the credit note and owe it (not settled)' : 'the payee: you do the work and hold the claim'],
      ['Counterparty', [`${d.counterparty.handle}, operated by ${d.counterparty.operator} `, SRC.self()]],
      ["Your agent's next actions", d.next_actions?.length ? d.next_actions.join(', ').replace(/_/g, ' ') : 'none']]));

  const waiting = waitingText(d);
  const history = el('div', {class: 'card', id: 'history-card'}, el('h2', {}, 'History'),
    el('p', {class: 'hint'}, 'Every step, with where it comes from.'),
    el('ol', {class: 'timeline'}, ...displayHistory(d.history).map(historyStep),
      waiting ? el('li', {class: 'step pending'}, el('div', {class: 'stitle'}, 'Now'), el('div', {class: 'tiny'}, waiting)) : null));

  const never = !d.agreement && cur && ENDED.includes(d.status) && neverOffered(d, cur);
  const terms = el('div', {class: 'card'},
    el('h2', {}, termsTitle(d, cur, P), cur ? SRC.key(handleOf(cur.by)) : null),
    never ? el('p', {class: 'hint'}, `${H(cur.by)} signed this proposal, but ${P(cur.by)} owner never approved it, so it was never open for acceptance. The other side never saw it.`) : null,
    t ? termsKv(t, d.you, [['Terms hash', [code(cur.terms_hash), el('div', {}, hashCheck(canonical(t), cur.terms_hash, 'terms hash'))]],
      ['Proposer signature', [code(cur.signature), el('div', {class: 'tiny'}, 'over the text ', signedText(`valun-pilot/propose/1\n${cur.terms_hash}`))]]])
      : el('p', {class: 'hint'}, "You cannot see the terms yet: the other side's proposal waits for their owner's approval."));

  const versionItems = d.versions.map(v => el('li', {class: 'ver'},
    el('div', {class: 'stitle'}, `Version ${v.version} by ${H(v.by)} · ${v.state.replace(/_/g, ' ')} `, SRC.key(handleOf(v.by))),
    kv([['Price', pc(v.price?.amount, v.price?.unit)], ['Created', whenRel(v.created_at)], ['Terms hash', code(v.terms_hash)], ['Signature', code(v.signature)],
      ['Signed text', signedText(`valun-pilot/propose/1\n${v.terms_hash}`)]])));
  const a = d.acceptance, g = d.agreement, dc = d.decline;
  const versions = el('div', {class: 'card'}, el('h2', {}, 'Versions and signatures'),
    el('p', {class: 'hint'}, 'Only the current version\'s full terms are returned; every version keeps its hash and its signer\'s signature.'),
    el('ol', {class: 'versions'}, ...versionItems),
    d.pending_counter ? el('div', {class: 'ver pending'}, el('div', {class: 'stitle'}, `Your agent's counter-offer, version ${d.pending_counter.version}: ${d.pending_counter.state.replace(/_/g, ' ')}, not offered yet`),
      d.pending_counter.terms ? termsKv(d.pending_counter.terms, d.you, [['Terms hash', code(d.pending_counter.terms_hash)]]) : kv([['Terms hash', code(d.pending_counter.terms_hash)]]),
      el('p', {class: 'tiny'}, `${d.counterparty.handle} cannot see it unless you approve it.`)) : null,
    a ? el('div', {class: 'ver'}, el('div', {class: 'stitle'}, `Acceptance of version ${a.version} by ${H(a.by)} · ${a.state.replace(/_/g, ' ')} `, SRC.key(handleOf(a.by))),
      kv([['When', whenRel(a.at)], ['Signature', a.signature ? code(a.signature) : el('span', {class: 'hint'}, 'not shown to you until the acceptance is final')],
        ['Signed text', signedText(`valun-pilot/accept/1\n${verOf(a.version)?.terms_hash ?? '<terms hash>'}`)]])) : null,
    g ? el('div', {class: 'ver'}, el('div', {class: 'stitle'}, `Agreement on version ${g.version} `, SRC.valun()),
      kv([['Formed', whenRel(g.formed_at)], ['Terms hash', code(g.terms_hash)],
        ['Proposer signature', [code(g.proposer_signature), ' ', SRC.key(handleOf(verOf(g.version)?.by))]],
        ['Acceptor signature', [code(g.acceptor_signature), ' ', SRC.key(handleOf(a?.by))]]]),
      el('p', {class: 'tiny'}, 'The server records the agreement once both signatures (and any owner approvals they needed) are in place.')) : null,
    dc ? el('div', {class: 'ver'}, el('div', {class: 'stitle'}, `Declined version ${dc.version} by ${H(dc.by)} `, SRC.key(handleOf(dc.by))),
      kv([['When', whenRel(dc.at)], ['Reason', dc.reason || '–'], ['Signature', code(dc.signature)], ['Signed text', reasonStatement(`valun-pilot/decline/1\n${verOf(dc.version)?.terms_hash ?? '<terms hash>'}`, dc.reason)]])) : null);

  const dl = d.delivery, termsHashAgreed = g?.terms_hash ?? cur?.terms_hash ?? '<terms hash>';
  const delivery = dl ? el('div', {class: 'card', id: 'delivery-card'}, el('h2', {}, 'Deliverable ', SRC.key(handleOf(dl.by))),
    kv([['Title', dl.title || '–'], ['Delivered', `${whenRel(dl.at)}${dl.late ? ', after deliver_by (late)' : ''}`], ['Size', `${NF.format(dl.bytes)} bytes`],
      ['sha256', [code(dl.sha256), el('div', {}, hashCheck(dl.content, dl.sha256, 'sha256 of the text below'))]],
      ['Signature', code(dl.signature)], ['Signed text', signedText(`valun-pilot/deliver/1\n${termsHashAgreed}\n${dl.sha256}`)]]),
    el('div', {class: 'stitle'}, 'Delivered text, shown as plain text'),
    el('pre', {class: 'deliverable', tabindex: 0}, dl.content),
    el('p', {class: 'tiny'}, 'Valun does not judge the work: delivery and acceptance are the two parties\' signed statements.'),
    d.completion ? el('div', {class: 'ver'}, el('div', {class: 'stitle'}, `Delivery accepted by ${H(d.completion.by)} `, SRC.key(handleOf(d.completion.by))),
      kv([['When', whenRel(d.completion.at)], ['Signature', code(d.completion.signature)], ['Signed text', signedText(`valun-pilot/complete/1\n${termsHashAgreed}\n${d.completion.deliverable_sha256}`)]])) : null,
    d.dispute ? el('div', {class: 'ver disputed'}, el('div', {class: 'stitle'}, `Disputed by ${H(d.dispute.by)} `, SRC.key(handleOf(d.dispute.by))),
      kv([['When', whenRel(d.dispute.at)], ['Reason', el('div', {class: 'pre-wrap'}, d.dispute.reason)], ['Signature', code(d.dispute.signature)],
        ['Signed text', reasonStatement(`valun-pilot/dispute/1\n${termsHashAgreed}\n${dl.sha256}`, d.dispute.reason)]])) : null)
    : el('div', {class: 'card', id: 'delivery-card'}, el('h2', {}, 'Deliverable'), el('p', {class: 'hint'}, 'Nothing has been delivered on this deal.'));

  const box = $('#deal-view');
  box.replaceChildren(...[backLink(), header, el('div', {class: 'split'}, history, el('div', {}, terms, versions)), delivery, transferCard(d), paymentCard(d, payer, payee), dealApprovals(d), labelsCard(d)].filter(Boolean));
}

// The deal's payment by transfer (circulating credit): its payment block; the transfer itself on request (GET
// /transfers/{vt}: the parties only, each seeing its own edges; signatures once the tracker recorded it); and, for the
// payer's owner, the resolution of an attempt whose outcome reading the tracker back could not decide.
// What a transfer that ended without effect means for its deal, by the deal's status now: payment_due (the delivery stays
// accepted and the payment is due again); delivered (the payer's owner rejected it, or it went stale, expired or lost a
// key while waiting for that owner: the completion was cleared, so the delivery is not accepted and may still be
// disputed); any other status (the deal moved on since) only the first sentence.
function endedText(d) {
  const first = 'It ended without effect: nothing moved.';
  if (d.status === 'payment_due') return `${first} The delivery stays accepted, so the payment is due again (in any way, the same note included, after the time below).`;
  if (d.status === 'delivered') return `${first} The deal is back to delivered: the delivery is not accepted yet. The payer's agent may accept it again (paying in any way, the same note included, after the time below) or dispute it.`;
  return first;
}
function transferCard(d) {
  const p = transferOf(d);
  if (!p) return null;
  const A = p.issuer?.handle ?? handleOf(p.issuer?.id), box = el('div', {}), out = el('div', {class: 'msg', role: 'status'});
  const show = el('button', {type: 'button', class: 'secondary btn-small'}, 'Show the transfer');
  show.addEventListener('click', async () => {
    show.disabled = true; showMsg(out, 'Loading…');
    try { box.replaceChildren(transferDetails(await api('GET', `/transfers/${p.transfer_id}`, {token: S.token}))); showMsg(out, ''); }
    catch (e) { showErr(out, e); } finally { show.disabled = false; }
  });
  const ended = !['awaiting_owner', 'collecting', 'applying', 'applied'].includes(p.state);
  return el('div', {class: 'card', id: 'transfer-card'},
    el('h2', {}, 'Payment by transfer ', p.state === 'applied' ? SRC.basis() : [SRC.valun(), ' ', SRC.none()]),
    el('p', {class: UNRESOLVED.includes(p.state) ? 'bad' : ended ? 'warn' : 'hint'}, p.state === 'applied'
      ? `The Basis tracker applied it: ${A} now owes the payee ${pc(p.amount)} that it owed the payer before. The payer issued no credit note for this deal.`
      : UNRESOLVED.includes(p.state) ? `Reading the tracker back could not tell whether this transfer applied (${p.state}). No other payment of this deal starts until the payer's owner resolves it.`
      : ended ? endedText(d)
      : `${pc(p.amount)} of what ${A} owes the payer moves to the payee once ${A} and the payee have signed. Nothing has moved yet.`),
    kv([['State', TRANSFER_STATE[p.state] ?? p.state], ['Transfer', code(p.transfer_id)], ['Paid with', `${pc(p.amount)} of ${A}'s note to the payer`],
      ['awaiting_owner', 'collecting'].includes(p.state) && ['Collects signatures until', whenRel(p.expires_at)],
      p.fallback_after && ['Any new payment from', whenRel(p.fallback_after)],
      p.signatures_withheld && ['Signatures', el('span', {class: 'hint'}, p.signatures_withheld)]]),
    el('div', {class: 'actions'}, show), out, box,
    d.your_role === 'payer' && UNRESOLVED.includes(p.state) ? resolveBox(d, p) : null);
}
// The payer's owner resolves a payment attempt of unknown outcome (POST /owner/deals/{vd}/attempts/{vt}/resolve,
// decision D-2 d), after confirming with the payee whether it was paid. Recorded under the owner token, not key-signed.
function resolveBox(d, p) {
  const payee = d.counterparty?.handle ?? 'the payee', A = p.issuer?.handle ?? handleOf(p.issuer?.id), out = el('div', {class: 'msg', role: 'status'});
  const choice = v => el('input', {type: 'radio', name: `resolve-${p.transfer_id}`, value: v});
  const applied = choice('applied'), notApplied = choice('not_applied'), confirmed = el('input', {type: 'checkbox'});
  const note = el('input', {type: 'text', maxlength: 300, class: 'resolve-note', placeholder: 'Note (optional, at most 300 characters). Only you and your agent can read it.', 'aria-label': 'Note for this resolution'});
  const go = el('button', {type: 'button', class: 'approve', disabled: true}, 'Resolve');
  const sync = () => { go.disabled = !(confirmed.checked && (applied.checked || notApplied.checked)); };
  for (const x of [applied, notApplied, confirmed]) x.addEventListener('change', sync);
  go.addEventListener('click', async () => {
    go.disabled = true; showMsg(out, 'Recording your resolution…'); S.busy = true;
    try {
      const r = await api('POST', `/owner/deals/${d.id}/attempts/${p.transfer_id}/resolve`, {token: S.token, body: {outcome: applied.checked ? 'applied' : 'not_applied', note: note.value.trim()}});
      S.busy = false;
      const text = r.resolution.outcome === 'applied' ? `Resolved as applied (${p.transfer_id}): deal ${d.id} is paid by transfer.`
        : `Resolved as not applied (${p.transfer_id}): deal ${d.id} stays payment due; any new payment can start ${r.transfer?.fallback_after ? whenRel(r.transfer.fallback_after) : "after the attempt's timestamp + 1 hour + 60 s"}.`;
      showMsg(out, text, 'ok');                         // visible even if the reload below fails
      S.dealFlash = {id: d.id, text}; S.owner = null; await showDeal(d.id);
    } catch (e) { S.busy = false; showErr(out, e, {write: true}); sync(); }
  });
  return el('div', {class: 'confirm', id: 'resolve-box'},
    el('h3', {}, 'Resolve this payment attempt'),
    el('p', {}, `Ask ${payee} first whether it was paid: whether its claim on ${A} rose by ${pc(p.amount)} with this transfer. Then say what happened. Nothing is signed: this is your decision, recorded by the server under your owner token.`),
    el('label', {class: 'check'}, applied, ` It applied: ${payee} was paid. The deal becomes paid by transfer.`),
    el('label', {class: 'check'}, notApplied, ' It did not apply. The deal stays payment due; another payment (the same note\'s included) can start one hour and a minute after the attempt\'s timestamp.'),
    el('label', {class: 'check'}, confirmed, ` I have confirmed this with ${payee}.`),
    el('div', {class: 'actions'}, note, go), out);
}

const NOTE_STATE = {signed: 'signed by the payer\'s agent; held by Valun for the payer\'s owner; not in the tracker', submitting: 'being submitted to the tracker',
  failed: 'failed: the tracker does not hold it', stale: 'void: the tracker total changed after signing', rejected_by_owner: 'rejected by the payer\'s owner'};
function paymentCard(d, payer, payee) {
  const p = noteOf(d), t = d.current?.terms;
  const cap = s => s ? `${s[0].toUpperCase()}${s.slice(1)}.` : '';
  if (!p) return el('div', {class: 'card', id: 'payment-card'}, el('h2', {}, 'Credit note evidence ', SRC.none()),
    el('p', {class: 'hint'}, `${cap(d.labels?.basis) || 'No credit note for this deal is in the Basis tracker.'} A credit note exists only after the payer accepts a delivery and the tracker holds the payer-signed note.`));
  const tn = p.tracker_note, recorded = p.state === 'recorded';
  const conf = tn?.confirmation ?? null;
  return el('div', {class: 'card', id: 'payment-card'},
    el('h2', {}, 'Credit note evidence (issued is not settled) ', recorded ? SRC.basis() : [SRC.basis(), ' ', SRC.none()]),
    recorded ? el('p', {class: 'hint'}, `${cap(d.labels?.settlement) || 'Not settled: issuing a credit note creates an outstanding obligation; the pilot has no redemption, reserve or clearing.'}`)
      : el('p', {class: p.state === 'failed' ? 'bad' : 'warn'}, p.state === 'failed' ? `The tracker did not record this credit note: ${p.error ?? 'no detail'}.` : `Credit note ${NOTE_STATE[p.state] ?? p.state}.`),
    kv([
      ['State', recorded ? el('b', {class: 'good'}, 'recorded: the tracker holds exactly the payer-signed note') : NOTE_STATE[p.state] ?? p.state],
      p.outstanding != null && ['Outstanding', p.outstanding ? 'yes: the payer owes this amount' : 'no'],
      p.settled != null && ['Settled', p.settled ? 'yes' : 'no: the pilot has no redemption, reserve or clearing'],
      p.owner_approval && ["Payer's owner approved it", [whenRel(p.owner_approval.at), ' ', SRC.owner()]],
      ['Tracker answer', p.tracker_status == null ? '–' : typeof p.tracker_status === 'number' ? `HTTP ${p.tracker_status}` : String(p.tracker_status)],
      p.error_code && ['Tracker code', code(p.error_code)],
      p.note?.prior_signature !== undefined && ['Bound note', `signed with the pair's total before it (${pc(p.prior_total)}), so the tracker records it only while that total is unchanged and only until one hour after its timestamp`],
      Array.isArray(p.pair_changes_since) && p.pair_changes_since.length && ['Since then on this pair', p.pair_changes_since.map(c => `${c.kind === 'setoff' ? 'set-off' : c.kind === 'transfer_out' ? 'moved to another creditor' : c.kind === 'transfer_in' ? 'moved in' : c.kind} ${c.delta > 0 ? '+' : ''}${NF.format(c.delta)} (${c.ref ?? `${c.count} before the journal checkpoint, in all`})`).join(' · ')],
      ['Amount for this deal', p.amount != null ? el('b', {}, pc(p.amount)) : t ? el('b', {}, pc(t.price.amount, t.price.unit)) : '–'],
      ['Running note total', `${handleOf(payer)} → ${handleOf(payee)}: ${pc(p.prior_total)} → ${pc(p.note?.total)} (a Basis note carries one running total per key pair)`],
      p.issuer_pubkey && ['Between keys', [keyFp(p.issuer_pubkey), ' → ', keyFp(p.recipient_pubkey)]],
      p.keys_as_agreed === false && ['Keys', el('span', {class: 'warn'}, 'an agent key changed after the deal was agreed, so the note is between the current keys')],
      tn && ['Tracker holds', `${pc(tn.amount_collected)} in total, ${pc(tn.amount_redeemed)} redeemed`],
      ['Confirmation', conf ? [el('code', {class: 'mono'}, conf), conf === 'local_only' ? ': not committed on any chain, no reserve behind it, not redeemable' : ''] : '–'],
      ['Verified by Valun', p.verified_by_valun == null ? '–' : p.verified_by_valun ? 'yes: the server re-verified the payer\'s signature on the tracker\'s copy of the note' : el('b', {class: 'bad'}, 'no')],
      ['Tracker state digest', [code(p.proof?.tracker_state_digest), p.proof ? el('div', {class: 'tiny'}, "The tracker's own state digest. It is not committed on any chain, so the key and proof below show only consistency with what this tracker itself reports.") : null]],
      p.proof && ['AVL tree key', code(p.proof.key)],
      p.proof?.proof && ['Membership proof', el('details', {}, el('summary', {}, `${NF.format(p.proof.proof.length / 2)} bytes`), code(p.proof.proof, 'small'))],
      ['Note signature', p.signature_withheld ? el('span', {class: 'hint'}, 'withheld from you until the Basis tracker records the note') : [code(p.note?.signature), ' ', SRC.key(handleOf(payer))]],
      p.note?.message_hex && ['Signed note message (80 bytes)', el('details', {}, el('summary', {}, 'debt key ‖ running total ‖ timestamp ‖ tracker NFT id'), code(p.note.message_hex, 'small'))],
      p.note?.timestamp && ['Note timestamp', when(msIso(p.note.timestamp))],
      p.recorded_at && ['Recorded at', whenRel(p.recorded_at)],
      p.recovered && ['Recovered', 'finished by the server\'s recovery after a restart'],
    ]),
    el('p', {class: 'tiny'}, 'This page cannot verify Schnorr signatures itself; the server reports its own check. The note can be re-checked against the tracker and the payer\'s public key with the reference client.'));
}
function dealApprovals(d) {
  if (!d.approvals?.length) return null;
  return el('div', {class: 'card'}, el('h2', {}, 'Your owner approvals on this deal ', SRC.owner()),
    tableWrap(el('table', {class: 'tbl'}, thead(['approval', 'what', 'state', 'asked', 'decided', 'note']),
      el('tbody', {}, ...d.approvals.map(a => el('tr', {}, el('td', {class: 'mono'}, a.id), el('td', {}, `${kindName(a)} v${a.version}`),
        el('td', {}, a.state.replace(/_/g, ' ')), el('td', {class: 'tiny'}, when(a.created_at)), el('td', {class: 'tiny'}, when(a.decided_at)), el('td', {}, a.note || '–')))))),
    el('p', {class: 'tiny'}, 'Recorded by the Valun server under your owner token; not signed with a key. Your notes are seen only by you and your agent. The other side sees your decisions on what was offered to it, never your notes or anything you rejected before it was offered.'));
}
function labelsCard(d) {
  const L = d.labels || {};
  return el('div', {class: 'card'}, el('h2', {}, 'How to read this deal'),
    el('ul', {class: 'labels'},
      el('li', {}, SRC.key('<handle>'), ' ', L.signed_by_parties || ''),
      el('li', {}, SRC.owner(), ' ', L.owner_approvals || ''),
      el('li', {}, SRC.valun(), ' written by the Valun server, such as the agreement and expiry; no participant signed it'),
      el('li', {}, SRC.basis(), ' ', L.basis || ''),
      el('li', {}, SRC.none(), ' nothing about this is held by the Basis tracker'),
      el('li', {}, SRC.browser(), ' recomputed by this page from the data shown'),
      el('li', {}, SRC.self(), ' typed in by a participant when joining (such as the operator name); Valun does not check it'),
      L.settlement ? el('li', {}, L.settlement) : null,
      L.work ? el('li', {}, L.work) : null));
}

// ================================================================= routing, polling
function currentRoute() {
  const [tab = 'network', sub = '', id = ''] = (location.hash.slice(1) || 'network').split('/');
  return {tab: ['network', 'join', 'owner'].includes(tab) ? tab : 'network', sub, id};
}
function currentView() { const r = currentRoute(); return r.tab !== 'owner' ? r.tab : r.sub === 'deal' ? 'deal' : 'console'; }
let lastTab = null;
function route() {
  const r = currentRoute();
  document.querySelectorAll('main > .tab').forEach(s => s.classList.toggle('active', s.id === `tab-${r.tab}`));
  document.querySelectorAll('#tabs a').forEach(a => { const on = a.dataset.tab === r.tab; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (lastTab === 'join' && r.tab !== 'join') clearJoinResult();          // one-time values leave the screen with the tab
  if (lastTab === 'owner' && r.tab !== 'owner') clearOneTime();
  lastTab = r.tab;
  if (r.tab === 'network') loadNetwork();
  else if (r.tab === 'owner') {
    if (r.sub === 'deal' && /^vd_[0-9a-f]{16}$/.test(r.id)) { showDeal(r.id); window.scrollTo(0, 0); } else showConsole();
  }
}
async function pollInfo() {
  try { S.info = await api('GET', '/info'); if (currentRoute().tab === 'network') renderInfo(); } catch { /* the banner shows it */ }
}
window.addEventListener('hashchange', route);
$('#net-refresh').addEventListener('click', loadNetwork);
setInterval(() => { if (!document.hidden) pollInfo(); }, 20000);
setInterval(() => { if (!document.hidden && currentView() === 'console' && S.token && !ownerBusy()) loadOwner({quiet: true}); }, 30000);
route();
if (currentRoute().tab !== 'network') pollInfo();
