// Valun credit desk UI. Plain DOM; every value is inserted as text, never as HTML.
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
};
const S = {participants: [], offers: [], status: null, acting: null, selected: null};
const store = {get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }};

async function api(method, path, body) {
  const headers = {'content-type': 'application/json'};
  const tok = store.get('valun-token'); if (tok) headers['x-valun-token'] = tok;
  const r = await fetch(path, {method, headers, body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
  if (r.status === 401 && S.status?.writeTokenRequired) {
    const t = prompt('This deployment needs the demo write token:');
    if (t) { store.set('valun-token', t.trim()); return api(method, path, body); }
  }
  if (!r.ok) throw Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------- formatting ----------
const erg = n => { if (n == null) return '–'; const b = BigInt(n), neg = b < 0n, a = neg ? -b : b; const w = a / 1_000_000_000n, f = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, ''); return `${neg ? '−' : ''}${w}${f ? '.' + f : ''} ERG`; };
const short = h => h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '–';
const when = iso => iso ? new Date(iso).toLocaleString() : '–';
const pName = id => S.participants.find(p => p.id === id)?.name ?? id;
const tag = (kind, text) => el('span', {class: `tag ${kind}`}, text);
const SRC = {basis: () => tag('basis', 'local Basis'), valun: () => tag('valun', 'Valun record'), none: () => tag('none', 'not available'), sim: () => tag('sim', 'simulated')};
const STATUS_LABEL = {offered: 'offered – awaiting recipient', accepted: 'accepted', issued: 'issued in tracker', declined: 'declined', withdrawn: 'withdrawn', stale: 'stale – terms out of date', issue_failed: 'tracker refused', submitting: 'accepted – submitting to tracker'};
const statusChip = o => el('span', {class: `status s-${o.status}${o.overdue ? ' overdue' : ''}`}, STATUS_LABEL[o.status] || o.status, o.overdue ? ' · overdue' : '');
const copyable = (v, cls = 'mono') => el('code', {class: cls, title: 'click to copy', onclick: () => navigator.clipboard?.writeText(v)}, v);
const policyText = pc => pc.error ? `check failed: ${pc.error}`
  : /No acceptance policy configured/.test(pc.reason || '') ? 'no policy uploaded (the tracker\'s default answer is "reject"); decided by hand'
  : pc.acceptable ? 'acceptable' : `not acceptable (${pc.reason})`;
function msg(target, text, ok = false) { const m = $(target); m.textContent = text; m.className = `msg ${ok ? 'ok' : 'err'}`; }

// ---------- data ----------
async function load() {
  [S.status, S.participants, S.offers] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/participants'), api('GET', '/api/offers')]);
  if (!S.acting || !S.participants.some(p => p.id === S.acting)) {
    const saved = store.get('valun-acting'), waiting = S.offers.find(o => o.status === 'offered')?.recipientId;
    S.acting = S.participants.some(p => p.id === saved) ? saved : waiting ?? S.participants[0]?.id;
  }
  render();
}

function render() {
  const st = S.status;
  $('#deployment').textContent = st.deployment === 'local' ? 'running locally' : 'hosted demo';
  $('#custody').textContent = st.custody;
  $('#status-line').textContent = `Basis tracker ${st.basis.trackerReachable ? 'reachable' : 'NOT reachable'} · ${st.basis.pin} · local digest ${short(st.basis.localDigest)} · no mainnet, no real funds`;
  const sel = $('#actas'); sel.replaceChildren(...S.participants.map(p => el('option', {value: p.id, selected: p.id === S.acting}, `${p.name} (${p.kind})`)));
  document.querySelectorAll('.who').forEach(w => { w.textContent = pName(S.acting); });
  renderDesk(); renderOfferList(); renderParticipants();
  if (S.selected) showOffer(S.selected, false);
}

// ---------- desk ----------
function renderDesk() {
  const me = S.acting;
  const rec = $('#offer-form [name=recipientId]');
  rec.replaceChildren(...S.participants.filter(p => p.id !== me).map(p => el('option', {value: p.id}, p.name)));
  const inbox = S.offers.filter(o => o.recipientId === me && o.status === 'offered');
  $('#inbox').replaceChildren(inbox.length ? el('div', {}, ...inbox.map(decisionCard)) : el('p', {class: 'hint'}, 'Nothing waiting. Switch "Acting as" to see another participant\'s inbox.'));
  $('#positions').replaceChildren(...S.participants.map(p => {
    const pos = p.position;
    return el('div', {class: `pos ${p.id === me ? 'me' : ''}`},
      el('div', {class: 'pname'}, p.name, ' ', el('span', {class: 'kind'}, p.kind)),
      el('div', {class: 'prow'}, el('span', {}, 'holds claims'), el('b', {}, erg(pos?.claimsHeld))),
      el('div', {class: 'prow'}, el('span', {}, 'owes'), el('b', {}, erg(pos?.owes))),
      el('div', {class: 'prow net'}, el('span', {}, 'net'), el('b', {}, erg(pos?.net))),
      el('div', {class: 'tiny'}, 'backing: none'));
  }));
  const mine = S.offers.filter(o => o.issuerId === me || o.recipientId === me).slice(0, 8);
  $('#mine').replaceChildren(mine.length ? offerTable(mine) : el('p', {class: 'hint'}, 'No obligations yet.'));
}

function decisionCard(o) {
  const box = el('div', {class: 'decision'},
    el('div', {class: 'dhead'}, el('b', {}, pName(o.issuerId)), ' offers ', el('b', {}, erg(o.terms.increment)), ' of credit',
      o.terms.purpose ? el('span', {class: 'purpose'}, ` for “${o.terms.purpose}”`) : ''),
    el('div', {class: 'tiny'}, `${o.id} · offered ${when(o.createdAt)}${o.terms.dueAt ? ` · due ${new Date(o.terms.dueAt).toLocaleDateString()}` : ''}`),
    el('div', {class: 'insp'}, 'Checking terms against the tracker…'));
  api('GET', `/api/offers/${o.id}`).then(v => box.querySelector('.insp').replaceWith(inspection(v, true))).catch(e => { box.querySelector('.insp').textContent = e.message; });
  return box;
}

function inspection(v, withActions) {
  const o = v.offer, pc = v.policyCheck;
  const policyLine = !v.recipientPolicy.present
    ? el('li', {class: 'warn'}, 'You have no Basis acceptance policy. The tracker\'s default answer is "reject"; you decide by hand.')
    : pc?.error ? el('li', {class: 'warn'}, `Policy check failed: ${pc.error}`)
    : el('li', {class: pc.acceptable ? 'good' : 'bad'}, `Your Basis policy says: ${pc.acceptable ? 'acceptable' : 'not acceptable'}${pc.reason ? ` (${pc.reason})` : ''}.`);
  const ip = v.issuerPosition;
  const list = el('ul', {class: 'checks'},
    el('li', {class: v.basisNoteSignatureValid ? 'good' : 'bad'}, v.basisNoteSignatureValid ? 'Issuer\'s Basis note signature verifies (basis_core).' : 'Issuer signature does NOT verify.'),
    el('li', {class: v.stale ? 'bad' : 'good'}, v.stale ? `Stale: the tracker total is now ${erg(v.currentTotal)}, the offer assumed ${erg(o.terms.priorTotal)}.` : `Cumulative debt ${pName(o.issuerId)} → you goes from ${erg(o.terms.priorTotal)} to ${erg(o.terms.newTotal)}.`),
    policyLine,
    el('li', {}, `${pName(o.issuerId)} currently holds ${erg(ip.claimsHeld)} in claims on others and owes ${erg(ip.owes)}. No reserve backs this note.`));
  const wrap = el('div', {}, list);
  if (withActions && o.status === 'offered' && S.acting === o.recipientId) {
    const reason = el('input', {placeholder: 'Reason (optional, Valun record)', maxlength: 200});
    const out = el('div', {class: 'msg'});
    const act = d => async () => {
      out.textContent = d === 'accept' ? 'Signing consent and releasing the note to the tracker…' : 'Signing decline…'; out.className = 'msg';
      try { const r = await api('POST', `/api/offers/${o.id}/decision`, {actorId: S.acting, decision: d, reason: reason.value});
        out.textContent = r.status === 'issued' ? 'Issued: the tracker recorded the note.' : `Result: ${STATUS_LABEL[r.status] || r.status}${r.issuance?.trackerError ? ` – ${r.issuance.trackerError}` : ''}`; out.className = 'msg ok';
        S.selected = o.id; await load();
      } catch (e) { out.textContent = e.message; out.className = 'msg err'; await load(); }
    };
    wrap.append(el('div', {class: 'actions'}, reason, el('button', {onclick: act('accept'), disabled: v.stale}, 'Accept'), el('button', {class: 'secondary', onclick: act('decline')}, 'Decline')), out);
  }
  return wrap;
}

// ---------- obligations ----------
function offerTable(list) {
  return el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, ...['id', 'issuer → recipient', 'credit', 'cumulative after', 'status', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...list.map(o => el('tr', {class: S.selected === o.id ? 'sel' : ''},
      el('td', {class: 'mono'}, o.id), el('td', {}, `${pName(o.issuerId)} → ${pName(o.recipientId)}`), el('td', {}, erg(o.terms.increment)),
      el('td', {}, erg(o.terms.newTotal)), el('td', {}, statusChip(o)),
      el('td', {}, el('a', {href: `#obligations/${o.id}`}, 'follow'))))));
}
function renderOfferList() { $('#offer-list').replaceChildren(S.offers.length ? offerTable(S.offers) : el('p', {class: 'hint'}, 'No offers yet.')); }

async function showOffer(id, scroll = true) {
  const d = $('#offer-detail'); d.replaceChildren(el('p', {class: 'hint'}, 'Loading…'));
  let v; try { v = await api('GET', `/api/offers/${id}`); } catch (e) { d.replaceChildren(el('p', {class: 'msg err'}, e.message)); return; }
  const o = v.offer, n = o.terms.basisNote, iss = o.issuance;
  const step = (state, title, src, ...body) => el('li', {class: `step ${state}`}, el('div', {class: 'stitle'}, title, ' ', src), ...body);
  const kv = rows => el('dl', {class: 'kv'}, ...rows.filter(Boolean).flatMap(([k, val]) => [el('dt', {}, k), el('dd', {}, val)]));
  const msgParts = n.message_hex.match(/^(.{64})(.{16})(.{16})(.{64})$/);
  const decided = o.decision, issued = o.status === 'issued';
  d.replaceChildren(...[
    el('div', {class: 'dtitle'}, el('h2', {}, `${o.id}: ${pName(o.issuerId)} owes ${pName(o.recipientId)}`), statusChip(o)),
    el('p', {class: 'who-owes'}, issued
      ? `${pName(o.issuerId)} owes ${pName(o.recipientId)} ${erg(o.terms.newTotal)} cumulatively (this obligation: ${erg(o.terms.increment)}). ${pName(o.recipientId)} holds the claim.`
      : `If accepted, ${pName(o.issuerId)} would owe ${pName(o.recipientId)} ${erg(o.terms.newTotal)} cumulatively. Nothing is owed under this offer yet.`),
    el('ol', {class: 'timeline'},
      step('done', '1 · Offered: issuer signed a Basis note and Valun terms', SRC.valun(),
        kv([['Issuer', `${pName(o.issuerId)} ${short(o.terms.issuer)}`], ['Recipient', `${pName(o.recipientId)} ${short(o.terms.recipient)}`],
          ['Credit', erg(o.terms.increment)], ['Cumulative', `${erg(o.terms.priorTotal)} → ${erg(o.terms.newTotal)}`],
          ['Purpose', o.terms.purpose || '–'], ['Due', o.terms.dueAt ? `${when(o.terms.dueAt)} (Valun term only)` : 'none'],
          ['Terms hash', copyable(o.termsHash)], ['Offered', when(o.createdAt)]]),
        el('details', {}, el('summary', {}, 'Basis note signed by the issuer (basis_core)'),
          kv([['Signed message (80 bytes)', el('span', {class: 'msgparts'}, el('span', {title: 'debt key = blake2b256(issuer‖recipient)'}, msgParts[1]), el('span', {title: 'total debt, 8 bytes BE'}, msgParts[2]), el('span', {title: 'timestamp ms, 8 bytes BE'}, msgParts[3]), el('span', {title: 'tracker NFT id'}, msgParts[4]))],
            ['Parts', 'debt key ‖ cumulative total ‖ timestamp ‖ tracker NFT id'], ['Signature', copyable(n.signature)],
            ['Verifies now', v.basisNoteSignatureValid ? 'yes (Valun re-checked with basis_core)' : 'NO']]))),
      step(decided ? 'done' : o.status === 'withdrawn' ? 'skipped' : 'pending', decided ? `2 · ${decided.decision === 'accept' ? 'Accepted' : 'Declined'} by ${pName(decided.by)}` : o.status === 'withdrawn' ? '2 · Withdrawn by the issuer' : `2 · Waiting for ${pName(o.recipientId)} to decide`, SRC.valun(),
        decided ? kv([['When', when(decided.at)], ['Reason', decided.reason || '–'], ['Consent signature', copyable(decided.signature)],
          ['Signed text', el('code', {class: 'mono'}, decided.message.replace('\n', ' · '))],
          decided.policyCheckAtDecision && ['Basis policy at decision', policyText(decided.policyCheckAtDecision)]])
          : o.status === 'offered' ? inspection(v, true) : el('p', {class: 'hint'}, o.status === 'stale' ? 'The tracker total for this pair changed after the offer, so consent to these terms is no longer possible. The issuer must make a new offer.' : '')),
      step(issued ? 'done' : o.status === 'issue_failed' ? 'failed' : 'pending', issued ? '3 · Issued: the Basis tracker recorded the note' : o.status === 'issue_failed' ? '3 · The tracker refused the note' : '3 · Issued in the Basis tracker', SRC.basis(),
        iss ? kv([['Submitted', when(iss.submittedAt)], ['Tracker answer', `${typeof iss.trackerStatus === 'number' ? `HTTP ${iss.trackerStatus}` : iss.trackerStatus ?? '–'}${iss.trackerError ? ` – ${iss.trackerError}` : ''}${iss.recovered ? ' (completed by recovery after a restart)' : ''}`],
          iss.trackerNote && ['Tracker now records', `${erg(iss.trackerNote.amount_collected)} cumulative, ${erg(iss.trackerNote.amount_redeemed)} redeemed`],
          iss.trackerNote && ['Confirmation', `${iss.trackerNote.confirmation?.status} – no on-chain commitment; redeemable: ${iss.trackerNote.confirmation?.redeemable ? 'yes' : 'no'}`],
          ['Read back matches signed note', iss.readBackMatches ? 'yes' : 'no'], ['Signature verified by Valun', iss.signatureVerifiedByValun ? 'yes (basis_core)' : 'no'],
          iss.proof && ['AVL tree key', copyable(iss.proof.key)], iss.proof && ['Tracker state digest', copyable(iss.proof.tracker_state_digest)],
          iss.proof && ['Membership proof', el('details', {}, el('summary', {}, `${iss.proof.proof.length / 2} bytes`), copyable(iss.proof.proof, 'mono wrap'))]]) : null),
      step(o.overdue ? 'failed' : 'na', o.overdue ? `Overdue since ${when(o.terms.dueAt)}` : 'Due date', SRC.valun(),
        el('p', {class: 'hint'}, o.terms.dueAt ? `${o.dueNote} ${o.overdue ? 'The claim is still outstanding in the tracker. With no reserve, there is no on-chain remedy: the holder keeps an unbacked claim.' : ''}` : 'No due date was set.')),
      step('na', 'On-chain commitment', SRC.none(), el('p', {class: 'hint'}, 'Needs a tracker box on Ergo. This tracker has a random NFT id and no chain connection, so notes stay local_only. See "Testnet evidence" for the one time this was done for real.')),
      step('na', 'Redemption / settlement', SRC.none(), el('p', {class: 'hint'}, 'Basis settles by redeeming a committed note against the issuer\'s on-chain reserve. Not possible here (no reserve, no chain). Basis also refuses to lower a cumulative debt through a new note.')),
      step('na', 'Transfer to a third party', SRC.none(), el('p', {class: 'hint'}, `Basis notes are bound to one issuer→recipient pair and cannot be transferred. ${pName(o.recipientId)} can pay others only by issuing their own note (credit by re-issuance), which Valun supports.`))),
    o.status === 'offered' && S.acting === o.issuerId ? el('button', {class: 'secondary', onclick: async () => { try { await api('POST', `/api/offers/${o.id}/withdraw`, {actorId: S.acting}); await load(); } catch (e) { alert(e.message); } }}, 'Withdraw this offer') : null].filter(Boolean));
  if (scroll) d.scrollIntoView({behavior: 'smooth', block: 'start'});
  renderOfferList();
}

// ---------- participants ----------
function renderParticipants() {
  $('#participant-list').replaceChildren(el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, ...['name', 'kind', 'public key', 'policy'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...S.participants.map(p => el('tr', {},
      el('td', {}, p.name, el('div', {class: 'tiny'}, p.about)), el('td', {}, p.kind), el('td', {}, copyable(p.pubkey, 'mono small')),
      el('td', {}, p.policy ? (p.policy.mode === 'accept-any' ? 'accept any' : `trusts ${p.policy.trustedIds.map(pName).join(', ')}${p.policy.maxDebt ? ` up to ${erg(p.policy.maxDebt)}` : ''}`) : el('span', {class: 'hint'}, 'none')))))));
  const fs = $('#policy-trusted'); const mine = S.participants.find(p => p.id === S.acting);
  fs.replaceChildren(el('legend', {}, 'Trusted issuers'), ...S.participants.filter(p => p.id !== S.acting).map(p => el('label', {class: 'check'},
    el('input', {type: 'checkbox', value: p.id, checked: mine?.policy?.trustedIds?.includes(p.id)}), p.name)));
}

// ---------- ledger ----------
async function renderLedger() {
  const [l, audit] = await Promise.all([api('GET', '/api/ledger'), api('GET', '/api/audit')]);
  const nm = (n, pk) => n ?? `${short(pk)} (outside Valun)`;
  $('#ledger-notes').replaceChildren(l.notes.length ? el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, ...['issuer (owes)', 'recipient (holds claim)', 'cumulative', 'redeemed', 'outstanding', 'confirmation'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...l.notes.map(n => el('tr', {}, el('td', {}, nm(n.issuerName, n.issuer)), el('td', {}, nm(n.recipientName, n.recipient)), el('td', {}, erg(n.total)), el('td', {}, erg(n.redeemed)), el('td', {}, erg(n.outstanding)), el('td', {}, el('code', {}, n.confirmation))))))
    : el('p', {class: 'hint'}, 'The tracker holds no notes yet.'));
  $('#tracker-state').replaceChildren(el('div', {}, 'local digest: ', l.trackerState.local_digest), el('div', {}, 'confirmed (on-chain) digest: ', String(l.trackerState.confirmed_digest), ' · tracker box: ', String(l.trackerState.tracker_box_id)));
  $('#reconcile').replaceChildren(el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, ...['pair', 'tracker total', 'accepted via Valun', 'result'].map(h => el('th', {}, h)))),
    el('tbody', {}, ...l.reconciliation.map(r => el('tr', {}, el('td', {}, r.pair ?? `${r.issuer} → ${r.recipient}`), el('td', {}, erg(r.trackerTotal)), el('td', {}, erg(r.issuedViaValun)),
      el('td', {class: r.status === 'match' ? 'good' : 'bad'}, r.status.replace(/-/g, ' ')))))));
  $('#audit').replaceChildren(...audit.slice().reverse().slice(0, 60).map(a => el('div', {}, `${a.at}  ${a.type}  ${a.id ?? a.participantId ?? ''} ${a.increment ? erg(a.increment) : ''}${a.total ? ` total ${erg(a.total)}` : ''}`)));
}

// ---------- testnet ----------
let testnet = null;
async function renderTestnet() {
  testnet ??= await api('GET', '/api/testnet');
  const R = testnet.recorded, X = testnet.explorer;
  const link = (kind, id) => el('a', {href: `${X}/${kind}/${id}`, target: '_blank', rel: 'noopener'}, short(id));
  $('#testnet-recorded').replaceChildren(
    el('p', {}, `Issuer ${short(R.parties.issuer.pubkey)} issued a ${R.note.amount.toLocaleString()} nanoERG note to ${short(R.parties.recipient.pubkey)}, backed by an on-chain reserve, committed by a tracker, then redeemed.`),
    el('ol', {class: 'timeline'}, ...R.steps.map(s => el('li', {class: 'step done'}, el('div', {class: 'stitle'}, s.title, ' ', tag('testnet', 'testnet · recorded')), el('div', {class: 'tiny'}, 'tx ', link('transactions', s.tx), ` · height ${s.height}`, s.box ? [' · box ', link('boxes', s.box)] : '')))),
    el('h3', {}, 'What the recorded checks established'), el('ul', {}, ...R.verified.map(t => el('li', {}, t))),
    el('h3', {}, 'What they did not establish'), el('ul', {class: 'warnlist'}, ...R.notEstablished.map(t => el('li', {}, t))));
}
async function liveTestnet() {
  const out = $('#testnet-live'); out.replaceChildren(el('p', {class: 'hint'}, 'Reading the public explorer…'));
  try {
    const t = await api('GET', '/api/testnet?live=1'), L = t.live;
    if (L.error) { out.replaceChildren(el('p', {class: 'msg err'}, `Explorer read failed: ${L.error}`)); return; }
    out.replaceChildren(el('h3', {}, 'Live read ', tag('live', 'testnet · live read'), ' ', el('span', {class: 'tiny'}, `${when(L.at)}${L.cached ? ' (cached)' : ''} · chain height ${L.network?.height}`)),
      el('p', {class: L.allMatch ? 'good' : 'bad'}, L.allMatch ? 'Every recorded box matches the chain as the public explorer sees it now.' : 'At least one box differs from the record – see below.'),
      el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, ...['box', 'role', 'value', 'spent by', 'matches record'].map(h => el('th', {}, h)))),
        el('tbody', {}, ...L.boxes.map(b => el('tr', {}, el('td', {class: 'mono'}, short(b.box)), el('td', {}, b.role), el('td', {}, b.value != null ? `${b.value.toLocaleString()} nanoERG` : '–'),
          el('td', {class: 'mono'}, b.spentBy ? short(b.spentBy) : 'unspent'), el('td', {class: b.ok ? 'good' : 'bad'}, b.ok ? 'yes' : (b.error || Object.entries(b.checks || {}).filter(([, v]) => !v).map(([k]) => k).join(', '))))))),
      L.redemption && el('p', {}, `Redemption tx ${short(L.redemption.tx)}: included at ${L.redemption.inclusionHeight}, ${L.redemption.confirmations.toLocaleString()} confirmations now; outputs ${L.redemption.outputs.map(o => o.value.toLocaleString()).join(' + ')} nanoERG.`),
      el('p', {class: 'hint'}, `${L.source}. This is a second, independent view of the chain – still a single third-party service, not a consensus check.`));
  } catch (e) { out.replaceChildren(el('p', {class: 'msg err'}, e.message)); }
}

// ---------- about ----------
function renderAbout() {
  const rows = [
    ['Participant identities (secp256k1 keys)', 'implemented', 'Keys come from Basis\'s own key generation. Demo custody: the server holds them.'],
    ['Issuer signs a credit offer', 'implemented', 'A real Basis note signature (basis_core Schnorr over the 80-byte message) plus a Valun terms signature.'],
    ['Recipient inspects and decides', 'implemented', 'Stale-terms check against the tracker, signature re-verification, the recipient\'s own Basis acceptance policy. Consent is signed.'],
    ['Issuance in Basis', 'implemented', 'The real basis_server verifies and records the note; Valun reads it back, re-verifies it and stores the tracker\'s AVL membership proof.'],
    ['Who owes whom, who holds the claim', 'implemented', 'Positions and the ledger are computed from the tracker, not from Valun\'s records. Reconciliation flags tracker debt nobody accepted here.'],
    ['Paying onward (circulation)', 'implemented as re-issuance', 'A claim holder pays a third party by issuing their own note. The original claim does not move: Basis notes are not transferable.'],
    ['Acceptance policies', 'implemented (Basis)', 'Recipient-signed whitelist and limit, evaluated by the tracker. The tracker does not enforce them when a note is created.'],
    ['Due dates and overdue', 'Valun-only', 'Basis has no due dates. Overdue is Valun\'s view; the claim stays outstanding.'],
    ['On-chain commitment, reserves, redemption', 'not in this app', 'Done once on Ergo testnet (see Testnet evidence). The hosted demo has no chain, keys or funds.'],
    ['Third-party backing / endorsement', 'not built', 'Basis offers reserves owned by the issuer only; there is no endorsement primitive.'],
    ['Default remedies, credit markets, decentralization', 'not built / not claimed', 'Nothing here shows market value, adoption or decentralization.'],
  ];
  $('#about').replaceChildren(
    el('h2', {}, 'What is real here'),
    el('table', {class: 'tbl'}, el('thead', {}, el('tr', {}, el('th', {}, 'capability'), el('th', {}, 'status'), el('th', {}, 'what that means'))),
      el('tbody', {}, ...rows.map(r => el('tr', {}, el('td', {}, r[0]), el('td', {}, el('b', {}, r[1])), el('td', {}, r[2]))))),
    el('h2', {}, 'Labels'), el('ul', {}, ...Object.entries(S.status.modes).map(([k, v]) => el('li', {}, el('b', {}, k), ': ', v))),
    el('h2', {}, 'API for agents'),
    el('p', {}, 'Every action in this page is a JSON call an agent can make:'),
    el('pre', {class: 'mono small'}, ['GET  /api/status', 'GET  /api/participants', 'POST /api/participants            {name, kind, about}', 'POST /api/offers                  {issuerId, recipientId, amountErg, purpose, dueAt}', 'GET  /api/offers/:id              (terms, staleness, policy check, issuer position)', 'POST /api/offers/:id/decision     {actorId, decision: accept|decline, reason}', 'POST /api/offers/:id/withdraw     {actorId}', 'POST /api/participants/:id/policy {mode: whitelist|accept-any, trustedIds, maxDebtErg}', 'GET  /api/ledger                  (tracker notes + reconciliation)', 'GET  /api/testnet?live=1'].join('\n')),
    el('h2', {}, 'Connect an agent (MCP)'),
    el('p', {}, 'Agents on any machine can use Valun as MCP tools over HTTPS. Reading needs nothing; making changes needs the demo passphrase as a header.'),
    el('pre', {class: 'mono small'}, [`Endpoint (Streamable HTTP): ${location.origin}/mcp`, 'Header for changes:        x-valun-token: <passphrase>   (or Authorization: Bearer <passphrase>)', '',
      'Claude Code:', `  claude mcp add --transport http valun ${location.origin}/mcp --header "x-valun-token: <passphrase>"`, '',
      'stdio-only clients: run scripts/valun-mcp-stdio.mjs (zero dependencies) with', `  VALUN_MCP_URL=${location.origin}/mcp  VALUN_TOKEN=<passphrase>`, '',
      'Tools: valun_overview, list_participants, get_position, create_participant, offer_credit, list_offers,',
      '       inspect_offer, decide_offer, withdraw_offer, set_acceptance_policy, get_ledger, get_testnet_evidence'].join('\n')),
    el('p', {class: 'hint'}, S.status.custody));
}

// ---------- tabs & forms ----------
function showTab() {
  const [t, sub] = (location.hash || '#desk').slice(1).split('/');
  const name = ['desk', 'obligations', 'participants', 'ledger', 'testnet', 'about'].includes(t) ? t : 'desk';
  if (name === 'obligations' && /^o-\d{4}$/.test(sub || '') && S.selected !== sub) { S.selected = sub; showOffer(sub, false); }
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === name));
  if (name === 'ledger') renderLedger().catch(e => { $('#ledger-notes').textContent = e.message; });
  if (name === 'testnet') renderTestnet().then(() => { if (sub === 'live') liveTestnet(); }).catch(e => { $('#testnet-recorded').textContent = e.message; });
  if (name === 'about') renderAbout();
}
window.addEventListener('hashchange', showTab);
$('#actas').addEventListener('change', e => { S.acting = e.target.value; store.set('valun-acting', S.acting); render(); });
$('#offer-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target);
  msg('#offer-msg', 'Signing…', true);
  try {
    const o = await api('POST', '/api/offers', {issuerId: S.acting, recipientId: f.get('recipientId'), amountErg: f.get('amountErg'), purpose: f.get('purpose'), dueAt: f.get('dueAt') || null});
    msg('#offer-msg', `Offer ${o.id} sent to ${pName(o.recipientId)}. Switch "Acting as" to ${pName(o.recipientId)} to decide.`, true); e.target.reset(); await load();
  } catch (err) { msg('#offer-msg', err.message); }
});
$('#participant-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target);
  try { const p = await api('POST', '/api/participants', {name: f.get('name'), kind: f.get('kind'), about: f.get('about')}); msg('#participant-msg', `Created ${p.name} with key ${short(p.pubkey)}.`, true); e.target.reset(); await load(); }
  catch (err) { msg('#participant-msg', err.message); }
});
$('#policy-form').addEventListener('submit', async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const trustedIds = [...document.querySelectorAll('#policy-trusted input:checked')].map(i => i.value);
  try { await api('POST', `/api/participants/${S.acting}/policy`, {mode: f.get('mode'), trustedIds, maxDebtErg: f.get('maxDebtErg')}); msg('#policy-msg', 'Policy signed and uploaded to the tracker.', true); await load(); }
  catch (err) { msg('#policy-msg', err.message); }
});
$('#testnet-live-btn').addEventListener('click', liveTestnet);

load().then(showTab).catch(e => { document.body.prepend(el('p', {class: 'msg err'}, `Could not load: ${e.message}`)); });
