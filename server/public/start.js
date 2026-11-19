// Try Valun (public/start.html, served at /start). The page is complete without this script, which adds three things:
// - Its command blocks. Each command is shown whole, wrapped only at its spaces (never inside a flag, a path or a URL),
//   with the lines after its first indented; the Copy button copies the block's text exactly as written, and says so
//   in a status line that screen readers announce. Without this script the blocks scroll sideways, as written.
//   public/home.js does the same for the landing's blocks.
// - The path chooser. The four paths become tabs (the WAI-ARIA tabs pattern: arrow keys, Home and End move between
//   them; a click, Enter or Space opens one), and only the chosen path shows. A link to a path (/start#tour), to
//   anything inside one (/start#no-prompt), or to a closed reference section (/start#credentials) opens it first.
//   Without this script every path shows, one after another, and the chooser's links are plain anchors.
// - The inspect path's live line: what GET /pilot/v1/chain says about anchoring right now, read once that path is
//   shown and again when its button is pressed. It sends no token and keeps nothing: no storage, no cookies.

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

// The paths, in the chooser's order (the first is shown when the address names none), and the anchors that name a path
// by an older name: #look, the old "look first" path, is now part of inspecting the network.
export const PATHS = ['agent', 'tour', 'ergo', 'build'];
export const ALIASES = {look: 'ergo'};

const two = n => String(n).padStart(2, '0');
const whole = n => Number.isSafeInteger(n) && n >= 0;

// GET /pilot/v1/chain's anchoring in words (lib/pilot/anchors.mjs AnchorWatch.state names the states): `chain` is its
// JSON, or null when it could not be read. What the server wrote is shown only as text, cut short.
export function anchoringNow(chain, now = new Date()) {
  const a = chain && typeof chain === 'object' && chain.anchoring && typeof chain.anchoring === 'object' ? chain.anchoring : null;
  const read = `Read at ${two(now.getUTCHours())}:${two(now.getUTCMinutes())} UTC from /pilot/v1/chain`;
  if (!a) return {state: null, network: null, read,
    lines: ['The anchoring could not be read just now. Try again in a minute, or open /pilot/v1/chain.']};
  const cap = a.daily_cap && typeof a.daily_cap === 'object' ? a.daily_cap : null;
  const limit = cap && whole(cap.limit) ? cap.limit : null;
  const said = {
    anchored: 'Anchored: the latest tracker box commits every note recorded so far, so an audit run now can say MATCH.',
    waiting_for_next_update: 'Waiting for the next tracker box: the newest notes are not committed yet, so an audit says '
      + 'UNKNOWN until that box is confirmed. A new note is usually committed 5 to 15 minutes after it is recorded, up to '
      + 'about 30 when Ergo testnet blocks are slow.',
    update_in_flight: 'A new tracker box is on its way: once a block includes it, usually within minutes, up to about '
      + '30 when Ergo testnet blocks are slow, the notes recorded before it are committed.',
    daily_cap_reached: `Today's ${limit ?? 50} tracker boxes are used up, so nothing more is committed on chain until `
      + '00:00 UTC. Until then an audit says UNKNOWN, and notes recorded since the last box cannot be redeemed.',
    overdue: 'No new tracker box for longer than it should take: a fault of the tracker, not of any note. Please tell us.',
  };
  const state = typeof a.state === 'string' ? a.state.slice(0, 40) : null;
  const lines = [Object.hasOwn(said, state ?? '') ? said[state] : `The tracker reports its anchoring as "${state ?? 'unknown'}".`];
  if (limit !== null && whole(cap.signed_today)) {
    lines.push(`Tracker boxes today: ${cap.signed_today} of ${limit}. The count starts again at 00:00 UTC.`);
  }
  return {state, network: typeof chain.network === 'string' ? chain.network.slice(0, 40) : null, lines, read};
}

// The live line in #anchoring-now: its static text says where to read the state; once shown, it reads it.
function liveLine(doc) {
  const box = doc.getElementById('anchoring-now');
  const out = box?.querySelector('.live-out'), again = box?.querySelector('button.reread');
  if (!box || !out) return {show() {}};
  let shown = false, busy = false, announced = false;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  function render(now) {
    const head = el('p', 'live-head');
    if (now.network) head.append(el('span', 'tag live', 'Live'), ` ${now.network}: anchoring right now`);
    else head.append('Anchoring right now');
    out.replaceChildren(head, ...now.lines.map(l => el('p', null, l)), el('p', 'live-when', now.read));
    // Announced from the second reading on (a reading the person asked for), never on page load.
    if (!announced) { announced = true; out.setAttribute('aria-live', 'polite'); }
  }
  async function read() {
    if (busy || typeof fetch !== 'function') return;
    busy = true;
    if (again) again.disabled = true;
    let chain = null;
    try {
      const r = await fetch('/pilot/v1/chain', {credentials: 'omit', cache: 'no-store', headers: {accept: 'application/json'}});
      if (r.ok) chain = JSON.parse(await r.text());
    } catch { chain = null; }
    render(anchoringNow(chain, new Date()));
    busy = false;
    if (again) again.disabled = false;
  }
  if (again) again.addEventListener('click', () => { read(); });
  return {show() { if (shown) return; shown = true; if (again) again.hidden = false; read(); }};
}

// The chooser as tabs, on `doc` (the page's document) in `win` (its window, or null). Returns {select, open} or null.
export function enhance(doc, win = null) {
  const list = doc.getElementById('paths');
  if (!list) return null;
  const tabs = [...list.querySelectorAll('a')];
  const names = tabs.map(t => (t.getAttribute('href') || '').replace(/^#/, ''));
  const panels = names.map(n => doc.getElementById(n));
  if (!tabs.length || panels.some(p => !p)) return null;
  const reduce = Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const scrollTo = (el, instant = false) => el?.scrollIntoView?.({block: 'start', behavior: instant || reduce ? 'auto' : 'smooth'});
  const live = liveLine(doc);
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-labelledby', 'paths-h');
  list.setAttribute('aria-orientation', 'vertical');
  tabs.forEach((t, i) => {
    t.parentNode?.setAttribute?.('role', 'presentation');
    t.setAttribute('role', 'tab');
    t.id = `tab-${names[i]}`;
    t.setAttribute('aria-controls', names[i]);
    const title = t.querySelector('.t'), what = t.querySelector('.d');
    if (title?.id) t.setAttribute('aria-labelledby', title.id);
    if (what?.id) t.setAttribute('aria-describedby', what.id);
    panels[i].setAttribute('role', 'tabpanel');
    panels[i].setAttribute('tabindex', '0');
  });

  let current = null;
  // Shows path `name` and hides the others; false when it was shown already (or is not a path).
  function select(name) {
    const i = names.indexOf(name);
    if (i < 0 || name === current) return false;
    current = name;
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', j === i ? 'true' : 'false');
      t.setAttribute('tabindex', j === i ? '0' : '-1');
      panels[j].hidden = j !== i;
    });
    if (name === 'ergo') live.show();
    return true;
  }

  // An address's fragment: the path it names, or the one holding its target, is shown; a closed disclosure around the
  // target (and the folded table of a section it names) is opened; then the target is scrolled to, when something
  // moved or on the page's first load.
  function open(hash, initial = false) {
    let id = '';
    try { id = decodeURIComponent(String(hash || '').replace(/^#/, '')); } catch { id = ''; }
    const target = id ? doc.getElementById(id) : null;
    let name = names.includes(id) ? id : (Object.hasOwn(ALIASES, id) ? ALIASES[id] : null);
    if (!name && target) {
      for (let x = target; x && x !== doc.body; x = x.parentNode) if (panels.includes(x)) { name = x.id; break; }
    }
    if (!name && initial) name = names[0];
    const moved = name ? select(name) : false;
    const disclosures = [];
    const folded = target && target.tagName !== 'DETAILS' ? target.querySelector?.('details.fold') : null;
    if (folded) disclosures.push(folded);
    for (let x = target; x && x !== doc.body; x = x.parentNode) if (x.tagName === 'DETAILS') disclosures.push(x);
    let opened = false;
    for (const d of disclosures) if (!d.open) { d.open = true; opened = true; }
    if (target && (initial || moved || opened)) scrollTo(target, initial);
  }

  tabs.forEach((t, i) => {
    t.addEventListener('click', ev => {
      ev.preventDefault();
      select(names[i]);
      win?.history?.replaceState?.(null, '', `#${names[i]}`);
      // Bring the path into view when its start is out of sight (on a phone it begins below the chooser). Opened from
      // the keyboard (Enter or Space: a click with no pointer, detail 0), the focus moves to the path as well, so it
      // is not left on a tab scrolled out of sight; a pointer's click leaves the focus where it is.
      const top = panels[i].getBoundingClientRect?.().top;
      const height = win?.innerHeight ?? 0;
      if (typeof top === 'number' && height && (top < 0 || top > height - 160)) {
        scrollTo(panels[i]);
        if (!(ev.detail > 0)) panels[i].focus?.({preventScroll: true});
      }
    });
    t.addEventListener('keydown', ev => {
      const n = tabs.length;
      const to = {ArrowDown: (i + 1) % n, ArrowRight: (i + 1) % n, ArrowUp: (i - 1 + n) % n, ArrowLeft: (i - 1 + n) % n,
        Home: 0, End: n - 1}[ev.key];
      if (ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); t.click(); return; }
      if (to === undefined) return;
      ev.preventDefault();
      tabs[to].focus();
    });
  });
  // A long table that is open on a wide screen starts folded on a narrow one (a link to its section opens it again).
  if (win?.matchMedia?.('(max-width: 719px)')?.matches) for (const d of doc.querySelectorAll('details.fold')) d.open = false;
  win?.addEventListener?.('hashchange', () => open(win.location?.hash));
  open(win?.location?.hash ?? '', true);
  if (!current) select(names[0]);
  return {select, open};
}

if (typeof document !== 'undefined') {
  const texts = new Map();
  for (const code of document.querySelectorAll('.cmd pre > code')) texts.set(code.id, wrapCommand(code));
  // What Copy did is also written to one status line that screen readers announce (a button's own text changing is
  // not announced), and each Copy button is described by the command it copies, so a list of buttons says which is
  // which.
  const status = document.createElement('p');
  status.className = 'vh';
  status.setAttribute('role', 'status');
  document.getElementById('main')?.append(status);
  for (const b of document.querySelectorAll('button.copy')) {
    if (b.dataset.copy && document.getElementById(b.dataset.copy)) b.setAttribute('aria-describedby', b.dataset.copy);
    b.addEventListener('click', async () => {
      const text = texts.get(b.dataset.copy) ?? document.getElementById(b.dataset.copy)?.textContent ?? '';
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; status.textContent = 'Copied.'; }
      catch { b.textContent = 'Select and copy'; status.textContent = 'Copy failed: select the text and copy it.'; }
      setTimeout(() => { b.textContent = 'Copy'; status.textContent = ''; }, 2000);
    });
  }
  enhance(document, typeof window !== 'undefined' ? window : null);
}
