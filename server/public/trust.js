// The trust model for people (public/trust.html, served at /trust). Two things, both optional: the page is complete
// without this script.
//   1. Its command blocks: each command shown whole, wrapped only at its spaces, and a Copy button that copies the block
//      exactly as written (the same wrapCommand as public/start.js and public/home.js). The result is said in a status
//      line too, for a screen reader, and each button is described by the line that introduces its block.
//   2. "What the server reports about the chain": one read of GET /pilot/v1/chain and one of GET /pilot/v1/reserves
//      (public, same origin, no token), shown as text with the time they were read and whose word they are: the
//      operator's server, not the chain. No polling, no storage, never markup.
// The pure parts are exported for test/trust-page.test.mjs; the page starts only in a browser.

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

// An amount in nanoERG as tERG for people: three decimals, as the site rounds totals ("0.115 tERG").
export const tERG = n => `${(Math.round(Number(n) / 1e6) / 1e3).toFixed(3)} tERG`;
const whole = n => Number.isSafeInteger(n) && n >= 0;
const hhmm = iso => (typeof iso === 'string' && /T\d\d:\d\d/.test(iso) ? `${iso.slice(11, 16)} UTC` : null);

// What anchoring.state says, in words (the states GET /pilot/v1/chain names; skill.md section 7 lists them).
export const STATE_WORDS = {
  anchored: 'anchored: it commits every IOU recorded so far',
  waiting_for_next_update: 'the ledger is ahead of the box; a new IOU is usually committed 5 to 15 minutes after it is recorded, up to about 30 when Ergo testnet blocks are slow',
  update_in_flight: 'a new box is on its way to the chain',
  daily_cap_reached: "the day's boxes are used up; the next one follows soon after 00:00 UTC",
  overdue: 'the next box is later than it should be: a fault',
};

// The readings, as [label, parts] rows, a part being text or {text, href} (a link to the explorer), from the two reads
// (either may be null: what it did not give is left out).
export function readings(chain, reserves) {
  const rows = [];
  const a = chain?.anchoring;
  if (a && typeof a === 'object') {
    if (typeof a.state === 'string') rows.push(['State', [STATE_WORDS[a.state] ?? a.state]]);
    const box = [];
    if (whole(a.confirmed_height)) box.push(`height ${a.confirmed_height}${whole(a.box_age_blocks) ? `, ${a.box_age_blocks} block${a.box_age_blocks === 1 ? '' : 's'} old` : ''}`);
    const last = a.last_update;
    if (last && typeof last.tx_id === 'string' && /^[0-9a-f]{64}$/.test(last.tx_id)) {
      const tx = `tx ${last.tx_id.slice(0, 10)}…`;
      const href = typeof last.explorer_url === 'string' && /^https:\/\/[^\s"<>]+$/.test(last.explorer_url) ? last.explorer_url : null;
      box.push(...(box.length ? ['; '] : []), href ? {text: tx, href} : tx, hhmm(last.signed_at) ? `, signed ${hhmm(last.signed_at)}` : '');
    }
    if (box.length) rows.push(['Tracker box', box.filter(p => p !== '')]);
    const cap = a.daily_cap;
    if (cap && whole(cap.limit) && whole(cap.signed_today))
      rows.push(['Boxes today', [`${cap.signed_today} of ${cap.limit}${hhmm(cap.resets_at) ? `; the count starts again at ${hhmm(cap.resets_at)}` : ''}`]]);
  }
  const list = Array.isArray(reserves?.reserves) ? reserves.reserves : null;
  if (list) {
    const backing = list.filter(r => whole(r?.total_debt_nanoerg) && r.total_debt_nanoerg > 0);
    const debt = backing.reduce((s, r) => s + r.total_debt_nanoerg, 0);
    rows.push(['Reserves', [`${list.length} posted; ${backing.length} back${backing.length === 1 ? 's' : ''} any debt${backing.length ? ` (${tERG(debt)} of IOUs)` : ''}`]]);
  }
  return rows;
}

async function getJson(path) {
  const r = await fetch(path, {headers: {accept: 'application/json'}, cache: 'no-store'});
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Whose server answered, for the live line: this page's own host (the reads are same-origin), else "the server".
const serverOf = doc => {
  const host = doc?.location?.host;
  return typeof host === 'string' && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/i.test(host) ? `${host}'s server` : 'the server';
};

// The panel: the readings under a "Live" line that says what was read, from whom, and when: the operator's server
// reports the chain here; it is not a read of Ergo testnet. While the reads are out it says so; on a failed read the
// static text stays as it is, with one line saying the live view could not be read.
export async function readChain(doc = document, now = () => new Date()) {
  const panel = doc.getElementById('now');
  if (!panel) return;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const box = doc.getElementById('now-read') ?? panel;
  if (box !== panel) box.replaceChildren(el('p', 'now-wait', 'Reading the chain view…'));
  const [chain, reserves] = await Promise.all([getJson('/pilot/v1/chain').catch(() => null), getJson('/pilot/v1/reserves').catch(() => null)]);
  const rows = readings(chain, reserves);
  const put = (...nodes) => (box === panel ? panel.append(...nodes) : box.replaceChildren(...nodes));
  if (!rows.length) { put(el('p', 'now-fail', 'The live reading could not be made just now. Both reads below are public: open them to see the chain as the server reports it.')); return; }
  const at = now().toISOString().slice(11, 16);
  const net = typeof chain?.network === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(chain.network) ? chain.network : 'valun-testnet-1';
  const live = el('p', 'now-live');
  live.append(el('span', 'tag live', 'Live'), ` ${net}, as ${serverOf(doc)} reports it (GET /pilot/v1/chain and GET /pilot/v1/reserves), read at ${at} UTC`);
  const dl = el('dl', 'now-dl');
  for (const [label, parts] of rows) {
    const row = el('div'), dd = el('dd');
    for (const p of parts) {
      if (typeof p === 'string') { dd.append(p); continue; }
      const a = el('a', '', p.text);
      a.setAttribute('href', p.href);
      dd.append(a);
    }
    row.append(el('dt', '', label), dd);
    dl.append(row);
  }
  put(live, dl);
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  // One status line for every Copy: a screen reader hears what the button's changed text says.
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  (document.querySelector('main') ?? document.body).append(status);
  let n = 0;
  for (const block of document.querySelectorAll('.doc .cmd')) {
    const code = block.querySelector('pre > code');
    if (!code) continue;
    // A block of commands wraps at its spaces; a script whose lines are indented keeps its lines (it scrolls instead).
    const text = /^[ \t]/m.test(code.textContent) ? code.textContent : wrapCommand(code);
    const b = document.createElement('button');
    b.setAttribute('type', 'button');
    b.className = 'copy';
    b.textContent = 'Copy';
    // The line that introduces the block says what this Copy copies ("Copy, button: That reserves use upstream's ...").
    const say = block.previousElementSibling;
    if (say && say.tagName === 'P') { say.id ||= `cmd-say-${++n}`; b.setAttribute('aria-describedby', say.id); }
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; status.textContent = 'Copied.'; }
      catch { b.textContent = 'Select and copy'; status.textContent = 'Copy failed: select the text and copy it.'; }
      setTimeout(() => { b.textContent = 'Copy'; status.textContent = ''; }, 2000);
    });
    block.append(b);
  }
  readChain();
}
