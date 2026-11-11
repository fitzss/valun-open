// E2E-1: a smoke run of the JavaScript client @fitzdoud/valun 0.4.0 (the local checkout VALUN_OPEN/js/src, not an
// installed package) against a local v16 server whose circulation mode is sandbox or on. No AI model: this script plays
// the agent through valunTools() (every commitment goes through its approve hook, which approves and records the text)
// and the owner (it keeps the owner token in a file of the temp folder). Steps:
//   1. Client.joinSandbox + enroll; the owner token is written to its file right after the join answer (decision D-3 c);
//   2. valun_status (circulation fields, sandbox_next_steps);
//   3. the welcome job from sandbox-exact: valun_respond accept, valun_deliver exact_result, paid with its credit note;
//   4. buy notary from sandbox-mallory and pay with pay_with=sandbox-exact: paid_by_transfer;
//   5. buy notary from sandbox-exact with an own bound note: the 2-cycle with sandbox-exact waits for this client's
//      set-off consent (the agent's processConsents is off, so nothing signs it by itself);
//   6. set-off regeneration: before signing, sell text-stats to sandbox-exact, which pays with a new note on the edge the
//      set-off reduces; then Client.processConsents() signs, the server makes the moved edge again (its revision goes
//      up and the earlier signature is withheld), and the next processConsents() signs the new revision: applied.
// Usage: node scripts/e2e-js-smoke.mjs --base URL --tmp DIR --out RESULT.json [--handle H] [--open VALUN_OPEN]
// Exit 0 when every check passes, 1 otherwise. Loopback only; the keys and tokens are throwaway ones.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = opt('--base'), TMP = opt('--tmp'), OUT = opt('--out');
const OPEN = opt('--open', process.env.VALUN_OPEN || '..');   // valun-open's root: this server/ folder's parent
const HANDLE = opt('--handle', `e2e-js-${crypto.randomBytes(3).toString('hex')}`);
if (!BASE || !TMP || !OUT || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) { console.error('usage: --base http://127.0.0.1:PORT --tmp DIR --out FILE'); process.exit(2); }
const V = await import(pathToFileURL(path.join(OPEN, 'js', 'src', 'index.js')).href);
const pkg = JSON.parse(fs.readFileSync(path.join(OPEN, 'js', 'package.json'), 'utf8'));
const X = 'sandbox-exact', M = 'sandbox-mallory';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}] js:`, ...a);
const failures = [], asked = [];
const check = (ok, what, detail) => {
  if (ok) { say(`ok    ${what}`); return true; }
  failures.push({what, detail}); say(`FAIL  ${what} ${detail === undefined ? '' : JSON.stringify(detail).slice(0, 1500)}`); return false;
};
class Abort extends Error {}
const must = (ok, what, detail) => { if (!check(ok, what, detail)) throw new Abort(what); };
const result = {ok: false, version: pkg.version, handle: HANDLE, failures, asked};

async function publicJson(p) {
  const r = await fetch(`${BASE}/pilot/v1${p}`, {signal: AbortSignal.timeout(30000)});
  return r.json();
}
async function totals(me) {
  const notes = (await publicJson('/ledger')).notes || [];
  const name = {[me]: 'S', [X]: 'X', [M]: 'M'}, out = {'S>X': 0, 'S>M': 0, 'X>S': 0, 'X>M': 0, 'M>S': 0, 'M>X': 0};
  for (const n of notes) { const k = `${name[n.issuer_handle] ?? '?'}>${name[n.recipient_handle] ?? '?'}`; if (k in out) out[k] = n.total; }
  return out;
}

try {
  must(pkg.name === '@fitzdoud/valun' && pkg.version === '0.4.0', 'the JS checkout is @fitzdoud/valun 0.4.0', `${pkg.name} ${pkg.version}`);
  const store = new V.MemoryStore({state: {consent_policy: {...V.SANDBOX_CONSENT_POLICY}}});
  const client = new V.Client({store, server: BASE});
  // 1. join and enroll; the owner token goes to its file before anything else that can fail (D-3 c).
  const j = await client.joinSandbox({handle: HANDLE, operator: 'E2E-1 js smoke'});
  const ownerFile = path.join(TMP, `owner-token-js-${HANDLE}.txt`);
  if (typeof j?.owner_token === 'string') fs.writeFileSync(ownerFile, j.owner_token + '\n', {flag: 'wx', mode: 0o600});
  must(typeof j?.owner_token === 'string' && /^vp_/.test(j.participant_id ?? '') && typeof j.enrollment_code === 'string',
    'Client.joinSandbox: a participant, an enrollment code and the owner token (written to its file at once)', Object.keys(j || {}));
  await client.enroll(j.participant_id, j.enrollment_code);
  must(client.connected === true, 'Client.enroll: the key is generated locally and enrolled');
  const agent = new V.ValunAgent(client, {processConsents: false, declareRoles: true});
  const tools = V.valunTools(agent, {approve: async (text, name) => { asked.push({name, first_line: String(text).split('\n')[0].slice(0, 160)}); return true; }});
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));
  must(tools.length === 9 && JSON.stringify(tools.map(t => t.name)) === JSON.stringify(V.TOOL_NAMES), 'valunTools: the nine tools', tools.map(t => t.name));
  const call = async (name, args = {}) => {
    for (let i = 1; ; i++) {
      const r = await byName[name].execute(args);
      if (r?.error === 'rate_limited' && i < 8) { say(`(429 on ${name}; again in 15 s)`); await sleep(15000); continue; }
      return r;
    }
  };
  // 2. valun_status
  const st = await call('valun_status');
  check(st && !st.error && st.sandbox_next_steps?.tour_step === 1 && 'money_view' in st && 'notes_you_can_spend' in st && 'consent_policy_in_force' in st,
    'valun_status: circulation fields and sandbox_next_steps (tour step 1)', st?.error ? st : Object.keys(st || {}));
  check(JSON.stringify(st?.clearing?.your_client_signs ?? null) !== 'null', 'valun_status clearing.your_client_signs is listed', st?.clearing);
  const dealUntil = async (id, statuses, ms = 120000) => {
    const end = Date.now() + ms;
    for (;;) {
      const d = await call('valun_deal', {deal_id: id});
      if (d && statuses.includes(d.status)) return d;
      if (Date.now() > end) return {...(d || {}), timed_out: true};
      await sleep(1500);
    }
  };
  // 3. the welcome job
  let welcome = null;
  for (let i = 0; i < 60 && !welcome; i++) {
    welcome = ((await call('valun_inbox')).respond || []).find(x => x.counterparty === X && x.your_role === 'payee');
    if (!welcome) await sleep(1000);
  }
  must(welcome, 'the welcome job from sandbox-exact is in valun_inbox');
  const acc = await call('valun_respond', {deal_id: welcome.deal_id, action: 'accept'});
  must(acc?.status === 'agreed', 'valun_respond accept (approved through the approve hook)', acc);
  const dl = await call('valun_deliver', {deal_id: welcome.deal_id, exact_result: true});
  must(dl?.status === 'delivered', 'valun_deliver exact_result=true', dl);
  must((await dealUntil(welcome.deal_id, ['note_issued', 'disputed'])).status === 'note_issued', 'sandbox-exact pays the welcome job with its credit note');
  let t = await totals(HANDLE);
  check(t['X>S'] === 3, 'after the welcome job: X>S 3', t);
  const job = (service, text) => ({title: `${service} job`, description: `${service} for this text:\n\`\`\`\n${text}\n\`\`\``,
    deliverable: `The exact ${service} result as JSON.`, deliver_within_hours: 24, offer_valid_hours: 1});
  async function buy(seller, service, price, payWith, text) {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const p = await call('valun_propose', {counterparty: seller, role: 'payer', ...job(service, `${text} (try ${attempt})`), price});
      must(p?.deal_id, `valun_propose ${service} to ${seller}`, p);
      const d = await dealUntil(p.deal_id, ['delivered', 'declined', 'expired', 'withdrawn']);
      must(d.status === 'delivered', `${seller} delivers deal ${p.deal_id}`, d.status);
      const exact = d.delivery?.checked_exactly_by_your_client;
      must(exact?.checked === true, 'the JS client checks the delivery exactly', exact);
      if (!exact.exact_result_matches) {
        const r = await call('valun_review_delivery', {deal_id: d.id, decision: 'dispute', reason: 'the result differs from the exact one'});
        must(r?.status === 'disputed', 'a wrong delivery is disputed', r);
        continue;
      }
      const r = await call('valun_review_delivery', {deal_id: d.id, decision: 'accept', pay_with: payWith, expected_deliverable_sha256: d.delivery.sha256});
      return {deal: d, answer: r};
    }
    throw new Abort(`${seller} delivered no right result in 12 purchases`);
  }
  // 4. pay_with=sandbox-exact
  const b1 = await buy(M, 'notary', 2, X, 'E2E-1 js: paid with a note I hold.');
  check(b1.answer?.status === 'paid_by_transfer' && b1.answer.payment?.issuer?.handle === X && b1.answer.payment?.state === 'applied',
    'valun_review_delivery accept pay_with=sandbox-exact: paid_by_transfer (the transfer applied)', b1.answer);
  check(asked.some(a => a.name === 'valun_review_delivery' && /^Valun - PAY /.test(a.first_line)), 'the approve hook got the computed PAY line for pay_with', asked.map(a => a.first_line));
  result.paid_deal = b1.deal.id;
  result.paid_status = (await call('valun_deal', {deal_id: b1.deal.id})).status;
  check(result.paid_status === 'paid_by_transfer', 'valun_deal: the deal stays paid_by_transfer', result.paid_status);
  t = await totals(HANDLE);
  check(t['X>S'] === 1 && t['S>X'] === 0, 'after pay_with: X>S 1', t);
  // 5. an own bound note to sandbox-exact: the 2-cycle S>X 2 / X>S 1 waits for this client
  const b2 = await buy(X, 'notary', 2, 'own_note', 'E2E-1 js: paid with my own note.');
  must(b2.answer?.status === 'note_issued', 'valun_review_delivery accept own_note: note_issued (a bound note)', b2.answer);
  let item = null;
  for (let i = 0; i < 30 && !item; i++) {
    item = ((await client.request('GET', '/pilot/v1/consents')).consents || []).find(x => x.kind === 'setoff' && x.state === 'collecting');
    if (!item) await sleep(1000);
  }
  must(item, 'GET /consents: a set-off waits for this client (processConsents off in the agent)');
  const rev0 = Object.fromEntries((item.edges || []).map(e => [e.edge, e.revision]));
  // 6. regeneration: a new note of sandbox-exact on an edge of the waiting set-off
  const sale = await call('valun_propose', {counterparty: X, role: 'payee', ...job('text-stats', 'E2E-1 js: a job I sell while a set-off waits.'), price: 3});
  must(sale?.deal_id, 'valun_propose: sell text-stats to sandbox-exact', sale);
  must((await dealUntil(sale.deal_id, ['agreed', 'declined', 'expired'])).status === 'agreed', 'sandbox-exact accepts the sale');
  const sd = await call('valun_deliver', {deal_id: sale.deal_id, exact_result: true});
  must(sd?.status === 'delivered', 'valun_deliver exact_result for the sale', sd);
  must((await dealUntil(sale.deal_id, ['note_issued', 'disputed'])).status === 'note_issued', 'sandbox-exact pays the sale with a new note');
  t = await totals(HANDLE);
  check(t['X>S'] === 4 && t['S>X'] === 2, 'before the consent: S>X 2 and X>S 4 (the set-off\'s X>S edge moved from 1 to 4)', t);
  const r1 = await client.processConsents();
  result.consents_run_1 = {signed: r1.signed.map(e => ({id: e.id, kind: e.kind, role: e.role, state: e.state})), waiting: r1.waiting.length, refused: r1.refused.length};
  check(r1.signed.some(e => e.id === item.id && e.kind === 'setoff' && e.role === 'member'), 'Client.processConsents signs the set-off as member', result.consents_run_1);
  let view = await client.request('GET', `/pilot/v1/setoffs/${item.id}`);
  const rev1 = Object.fromEntries((view.edges || []).map(e => [e.edge, e.revision]));
  const moved = Object.keys(rev1).filter(k => rev1[k] > (rev0[k] ?? 0));
  check(view.state === 'collecting' && moved.length === 1 && !!view.signature_sha256,
    'GET /setoffs/{id}: the moved edge was made again (its revision went up; the earlier signature withheld, its sha256 kept)', {state: view.state, rev0, rev1});
  const r2 = await client.processConsents();
  result.consents_run_2 = {signed: r2.signed.map(e => ({id: e.id, kind: e.kind, role: e.role, state: e.state}))};
  check(r2.signed.some(e => e.id === item.id), 'the next Client.processConsents signs the new revision', result.consents_run_2);
  view = await client.request('GET', `/pilot/v1/setoffs/${item.id}`);
  check(view.state === 'applied', 'the regenerated set-off applied', {state: view.state, result: view.result});
  t = await totals(HANDLE);
  check(t['S>X'] === 1 && t['X>S'] === 3, 'after the regenerated set-off: S>X 1, X>S 3 (1 PC cleared on each edge)', t);
  // 7. Decision D-2 c: a note held for the owner on a pair supersedes the set-off collecting there (held_note), and no
  // set-off is proposed on that pair while the note is held; once the owner releases it, one is proposed again.
  const waitSetoff = async (not, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = ((await client.request('GET', '/pilot/v1/consents')).consents || []).find(x => x.kind === 'setoff' && x.state === 'collecting' && !not.includes(x.id));
      if (s || Date.now() > end) return s || null;
      await sleep(1000);
    }
  };
  const s2 = await waitSetoff([item.id]);
  must(s2, 'the clearing engine proposes the remaining cycle (S>X 1 / X>S 3) as a new set-off, which waits for this client');
  const owner = fs.readFileSync(ownerFile, 'utf8').trim();
  const ownerReq = async (method, p, body) => {
    const r = await fetch(`${BASE}/pilot/v1${p}`, {method, headers: {'content-type': 'application/json', authorization: `Bearer ${owner}`},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)});
    return {status: r.status, body: await r.json().catch(() => null)};
  };
  const mset = await ownerReq('PUT', '/owner/mandate', {review_deliveries: true});
  must(mset.status === 200, 'the owner turns on review_deliveries (PUT /owner/mandate)', mset);
  const b3 = await buy(X, 'notary', 2, 'own_note', 'E2E-1 js: held for my owner.');
  must(b3.answer?.status === 'completion_awaiting_owner', 'with review_deliveries the own note waits for the owner (completion_awaiting_owner)', b3.answer);
  view = await client.request('GET', `/pilot/v1/setoffs/${s2.id}`);
  check(view.state === 'superseded' && view.result?.code === 'held_note', 'D-2 c: the collecting set-off on the pair ended superseded, code held_note', {state: view.state, result: view.result});
  await sleep(4000);
  const during = ((await client.request('GET', '/pilot/v1/consents')).consents || []).filter(x => x.kind === 'setoff' && x.state === 'collecting');
  check(during.length === 0, 'D-2 c: while the note is held no set-off is proposed on its pair (GET /consents, 4 s later)', during.map(x => x.id));
  const ov = await ownerReq('GET', '/owner');
  const ap = (ov.body?.approvals || []).find(a => a.deal_id === b3.deal.id && a.state === 'pending');
  must(ap, 'the held note is a pending owner approval', (ov.body?.approvals || []).map(a => ({id: a.id, kind: a.kind, state: a.state, deal_id: a.deal_id})));
  const rel = await ownerReq('POST', `/owner/approvals/${ap.id}`, {decision: 'approve'});
  must(rel.status === 200, 'the owner releases the held note (POST /owner/approvals/:id approve)', rel);
  must((await dealUntil(b3.deal.id, ['note_issued', 'note_failed'])).status === 'note_issued', 'the released note is issued');
  t = await totals(HANDLE);
  check(t['S>X'] === 3 && t['X>S'] === 3, 'after the release: S>X 3, X>S 3', t);
  const s3 = await waitSetoff([item.id, s2.id]);
  must(s3, 'with the note released, a set-off is proposed on the pair again');
  const r3 = await client.processConsents();
  check(r3.signed.some(e => e.id === s3.id), 'Client.processConsents signs it', r3.signed.map(e => e.id));
  t = await totals(HANDLE);
  check(t['S>X'] === 0 && t['X>S'] === 0, 'after that set-off: S>X 0, X>S 0', t);
  result.final_totals = t;
} catch (e) {
  if (!(e instanceof Abort)) check(false, 'no unexpected error', e?.stack || String(e));
}
result.ok = failures.length === 0;
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
say(result.ok ? 'PASS' : `FAIL (${failures.length})`);
process.exit(result.ok ? 0 : 1);
