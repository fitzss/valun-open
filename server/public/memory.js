// The memory page (public/memory.html): the record's evidence as network totals (GET /pilot/v1/evidence), and the attacks
// we ran on it (/evidence-attacks.json, written by scripts/evidence-attacks.mjs). Same-origin public reads only; every
// value is placed as text, never as markup.
const $ = id => document.getElementById(id);
const text = (el, s) => { if (el) el.textContent = s; };
const el = (tag, cls, s) => { const e = document.createElement(tag); if (cls) e.className = cls; if (s !== undefined) e.textContent = s; return e; };
const int = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '–');
// The network's unit, as the evidence read says it. The page is the testnet's, so until that read answers (or when it
// fails) amounts are tERG, never bare numbers a reader could take for tERG.
let UNIT = 'nanoERG';
// An amount in the network's unit: credits on the pilot, tERG (from nanoERG) on the testnet, rounded to 3 decimals as
// the site rounds totals ("0.451 tERG").
function amount(n, {bare = false} = {}) {
  if (!Number.isFinite(n)) return '–';
  if (UNIT === 'nanoERG') { const t = (n / 1e9).toFixed(3).replace(/\.?0+$/, ''); return bare ? t : `${t} tERG`; }
  return bare ? int(n) : `${int(n)} credit${n === 1 ? '' : 's'}`;
}
// The attacks report counts in credits (PC), the pilot's unit; on the testnet one credit is 1,000,000 nanoERG.
const reportAmount = pc => (UNIT === 'nanoERG' ? amount(pc * 1e6) : int(pc));

async function getJson(path) {
  const r = await fetch(path, {headers: {accept: 'application/json'}, cache: 'no-store'});
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function renderEvidence(e) {
  UNIT = e.unit || UNIT;
  const d = e.delivery, r = e.repayment, a = e.acceptance, g = e.groups;
  text($('del-n'), int(d.accepted.count));
  text($('del-d'), `${amount(d.accepted.PC)} · ${int(d.disputed)} disputed · ${int(d.not_delivered)} not delivered`);
  // A set-off is cleared, a redemption redeemed: the record sums them in settled_pct, and the card shows them apart.
  const cleared = r.settled?.by_setoff_PC || 0, redeemed = r.settled?.by_redemption_PC;
  text($('rep-pct'), r.settled_pct === null || r.settled_pct === undefined ? '–' : `${r.settled_pct}%`);
  text($('rep-d'), `${amount(cleared)} cleared in loops (committed, not final)${redeemed === undefined ? '' : `, ${amount(redeemed)} redeemed`}, `
    + `of ${amount(r.owed_ever_PC)} owed · ${amount(r.outstanding_PC)} outstanding · ${int(r.unpaid_accepted_work.count)} accepted and unpaid`);
  text($('acc-n'), amount(a.taken_by_transfer.PC, {bare: true}));
  text(document.querySelector('.c-acc .card-u'), `${UNIT === 'nanoERG' ? 'tERG' : 'credits'} of notes taken by transfer`);
  text($('acc-d'), `${int(a.taken_by_transfer.count)} time${a.taken_by_transfer.count === 1 ? '' : 's'}, someone took a note from a party it never dealt with`);
  const lone = g.self_serve_only;
  text($('groups'), `${int(e.participants_with_exchanges)} participants with exchanges, in ${int(g.count)} group${g.count === 1 ? '' : 's'} (the largest has ${int(g.largest)}). `
    + (lone ? `${int(lone)} group${lone === 1 ? ' has' : 's have'} no invited or operator-run member: what a staged circle looks like, and also what an honest new group looks like before it deals with anyone else.`
      : 'Every group has an invited or operator-run member.'));
  const live = $('live');
  if (live) { live.textContent = 'Live'; live.classList.add('on'); }
  text($('live-at'), `, read at ${new Date().toISOString().slice(11, 16)} UTC`);
}

function renderAttacks(x) {
  const head = $('atk-head'), body = $('atk-body');
  if (!head || !body) return;
  const hr = el('tr');
  hr.append(el('th', '', 'Scenario'));
  for (const p of x.policies) { const th = el('th', '', p.name); th.scope = 'col'; th.title = p.rule; hr.append(th); }
  head.replaceChildren(hr);
  const rows = x.scenarios.map(s => {
    const tr = el('tr', s.kind), th = el('th');
    th.scope = 'row';
    th.append(document.createTextNode(s.title), el('span', `kind ${s.kind}`, s.kind === 'attack' ? 'attack' : 'honest'));
    th.title = s.story;
    tr.append(th);
    for (const p of x.policies) {
      const r = s.policies[p.id];
      tr.append(el('td', r.accepts ? 'takes' : 'refuses', r.accepts ? `takes ${reportAmount(r.takeable_PC)}` : 'refuses'));
    }
    return tr;
  });
  body.replaceChildren(...rows);
  if (UNIT === 'nanoERG') text($('atk-cap'), 'What the subject could take on credit from holders using each rule, before walking away, in tERG.');
  const staged = (x.earned_limits || []).find(z => z.id === 'any_settlement');
  if (staged) {
    const c = $('earned');
    c.replaceChildren('If credit limits grew automatically with every note cleared or redeemed, a staged circle could add about ',
      el('span', 'n', reportAmount(staged.per_identity_per_day_PC)), `${UNIT === 'nanoERG' ? '' : ' credits'} a day to each identity's limit, for nothing. So Valun grants no credit from evidence: each holder decides whose note it takes, within the limits its owner sets.`);
  }
  const f = $('findings');
  if (f) f.replaceChildren(...(x.findings || []).slice(0, 5).map(s => el('li', '', s)));
}

async function evidenceOnce() {
  try { renderEvidence(await getJson('/pilot/v1/evidence')); } catch { const l = $('live'); if (l) { l.textContent = 'Not reachable just now'; l.classList.remove('on'); } }
}
async function main() {
  // Both reads start at once; the table waits for the evidence, which says the network's unit.
  const attacks = getJson('/evidence-attacks.json');
  attacks.catch(() => {});
  await evidenceOnce();
  attacks.then(renderAttacks).catch(() => text($('atk-body')?.firstElementChild?.firstElementChild, 'The report could not be loaded.'));
  setInterval(evidenceOnce, 60_000);
}
main();
