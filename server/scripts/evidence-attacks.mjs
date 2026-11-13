// What staged records look like in the evidence (lib/pilot/evidence.mjs), and what they would win under candidate owner
// policies and under "earned" credit limits. Builds each scenario's state as the server stores it (test/evidence-world.mjs:
// deals, the edge journal, set-offs, transfers, the tracker's notes; no tracker, no signing), reads the evidence through
// Pilot.publicPosition, and scores it. The policies and the earned limits are candidates under study: none is built.
// Writes docs/EVIDENCE-ATTACKS.md and public/evidence-attacks.json (the /memory page shows it).
// Usage: node scripts/evidence-attacks.mjs [--check]   (--check: fail if the committed outputs differ from a fresh run)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {evidenceWorld, evidence} from '../test/evidence-world.mjs';
import {SANDBOX_CAPS, SANDBOX_DAYS} from '../lib/pilot/core.mjs';
import {SANDBOX_JOINS_PER_HOUR_PER_ADDRESS} from '../lib/pilot/http.mjs';
import {LIMITS as CLEARING_LIMITS} from '../lib/pilot/clearing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOX = SANDBOX_CAPS;
// The house agents' paid feedback (valun-open examples/ai-seller: house-scribe's x-feedback want): 2 credits, at most one a
// day per person and ten a day in all per house agent, each checked by its model.
const HOUSE = {feedback_PC: 2, feedback_per_person_per_day: 1, feedback_per_agent_per_day: 10};
const ENGINE_RUNS_PER_HOUR = Math.round(3600e3 / (CLEARING_LIMITS?.interval_ms ?? 600e3));

const settledOf = e => e.repayment.settled.by_setoff_PC + (e.repayment.settled.by_redemption_PC ?? 0);
const noUnpaid = e => e.repayment.unpaid_accepted_work.count === 0;
const anchoredCreditor = e => ['invited', 'operator_run', 'sandbox_agent'].some(k => e.repayment.settled.creditors_by_kind[k]);
// Candidate owner policies: what a holder might require before taking an issuer's IOU, and how much it would then take.
// Every one is capped by the self-serve box (a sandbox participant takes at most max_accept_per_issuer of one issuer).
const POLICIES = [
  {id: 'box', name: 'The box only', rule: `take any issuer's IOU, within the self-serve caps (${BOX.max_accept_per_deal} a deal, ${BOX.max_accept_per_issuer} per issuer)`,
    accepts: () => true, exposure: () => BOX.max_accept_per_issuer},
  {id: 'settled', name: 'Settled before', rule: 'the issuer has settled at least 2 credits and has no accepted work unpaid',
    accepts: e => settledOf(e) >= 2 && noUnpaid(e), exposure: () => BOX.max_accept_per_issuer},
  {id: 'open_circle', name: 'Settled, not in a closed group', rule: 'as "settled before", and its circle is not closed',
    accepts: e => settledOf(e) >= 2 && noUnpaid(e) && !e.circle.closed, exposure: () => BOX.max_accept_per_issuer},
  {id: 'anchored_creditor', name: 'Settled with an invited creditor', rule: 'as "settled before", and one creditor it settled with joined by invitation or is run by the operator',
    accepts: e => settledOf(e) >= 2 && noUnpaid(e) && anchoredCreditor(e), exposure: () => BOX.max_accept_per_issuer},
  {id: 'scaled', name: 'Scaled to what it settled', rule: 'take up to twice what the issuer has settled, within the caps',
    accepts: e => settledOf(e) > 0 && noUnpaid(e), exposure: e => Math.min(BOX.max_accept_per_issuer, 2 * settledOf(e))},
];

// A house agent as on the live network: it sells to anyone, so it has customers outside every scenario's group.
function house(w) { const h = w.person('house-scribe', 'invited'), other = w.person('other-customer'); w.job(other, h, 2); return h; }
// The scenarios. Each returns {subject, cost, ...}; `subject` is the participant whose evidence a holder would read.
const SCENARIOS = [
  {id: 'honest_trio', title: 'Three independent operators', kind: 'honest',
    story: 'ana, bo and cy run their own agents. ana hires bo; bo pays cy with ana\'s IOU; cy hires ana, and the loop with ana cancels. Each also buys a tl;dr from the house scribe and pays it back with feedback it accepts.',
    build(w) {
      const h = house(w), [a, b, c] = ['ana', 'bo', 'cy'].map(x => w.person(x));
      w.job(a, b, 2); w.pass(b, a, c, 2); w.job(c, a, 2); w.loop([a, c], 2);
      for (const x of [a, b, c]) { w.job(x, h, 2); w.job(h, x, 2); w.loop([x, h], 2); }
      return {subject: a, cost: {identities: 3, operators: 3, real_jobs: 3, feedback_checked: 3, outsiders: 1, days: 1}};
    }},
  {id: 'honest_newcomer', title: 'A real newcomer', kind: 'honest',
    story: 'nell joins today and has dealt with nobody yet.',
    build(w) { return {subject: w.person('nell'), cost: {identities: 1, operators: 1, real_jobs: 0, feedback_checked: 0, outsiders: 0, days: 0}}; }},
  {id: 'staged_circle', title: 'A staged circle', kind: 'attack',
    story: 'One operator runs s1, s2 and s3. Each "hires" the next for pretend work, accepts the pretend delivery, and the circle cancels. Every signature is valid.',
    build(w) {
      const s = ['s1', 's2', 's3'].map(x => w.person(x, 'self_serve', {operatorName: 'one-operator'}));
      w.job(s[0], s[1], 2); w.job(s[1], s[2], 2); w.job(s[2], s[0], 2); w.loop(s, 2);
      return {subject: s[0], cost: {identities: 3, operators: 1, real_jobs: 0, feedback_checked: 0, outsiders: 0, days: 0, minutes: Math.ceil(60 / ENGINE_RUNS_PER_HOUR)}};
    }},
  {id: 'staged_circle_opened', title: 'A staged circle that buys from a house agent', kind: 'attack',
    story: 'The same circle, and each identity also buys a tl;dr from the house scribe and pays it back with feedback the scribe\'s model accepts (feedback can itself be written by a model).',
    build(w) {
      const h = house(w), s = ['s1', 's2', 's3'].map(x => w.person(x, 'self_serve', {operatorName: 'one-operator'}));
      w.job(s[0], s[1], 2); w.job(s[1], s[2], 2); w.job(s[2], s[0], 2); w.loop(s, 2);
      for (const x of s) { w.job(x, h, 2); w.job(h, x, 2); w.loop([x, h], 2); }
      return {subject: s[0], cost: {identities: 3, operators: 1, real_jobs: 0, feedback_checked: 3, outsiders: 1, days: 1}};
    }},
  {id: 'identity_reset', title: 'An identity reset', kind: 'attack',
    story: 'd takes a 5-credit job from vic, pays with its IOU, never settles, lets the identity lapse and joins again as d2.',
    build(w) {
      const d = w.person('d'), vic = w.person('vic');
      w.job(d, vic, BOX.max_issue_per_deal);
      return {subject: w.person('d2'), before: d, cost: {identities: 2, operators: 1, real_jobs: 0, feedback_checked: 0, outsiders: 0, days: 0, lost_by_victims_PC: BOX.max_issue_per_deal}};
    }},
  {id: 'slow_burn', title: 'Good on small jobs, then a default', kind: 'attack',
    story: 'f settles small jobs honestly with three partners and once with the house scribe, then takes as much work on credit as holders will give it, and walks away.',
    build(w) {
      const h = house(w), f = w.person('f'), partners = ['p1', 'p2', 'p3'].map(x => w.person(x));
      for (let i = 0; i < 5; i++) { const p = partners[i % 3]; w.job(f, p, 1); w.job(p, f, 1); w.loop([f, p], 1); }
      w.job(f, h, 2); w.job(h, f, 2); w.loop([f, h], 2);
      return {subject: f, cost: {identities: 1, operators: 1, real_jobs: 5, feedback_checked: 1, outsiders: 4, days: 2}, victims: 8};
    }},
];

function summary(e) {
  return {delivered: {accepted: e.delivery.accepted.count, buyers: e.delivery.accepted.buyers, buyers_by_kind: e.delivery.accepted.buyers_by_kind},
    settled: {PC: settledOf(e), owed_ever_PC: e.repayment.owed_ever_PC, creditors: e.repayment.settled.creditors, creditors_by_kind: e.repayment.settled.creditors_by_kind,
      unpaid_accepted_work: e.repayment.unpaid_accepted_work.count},
    accepted_by: {holders_ever: e.acceptance.holders_ever, taken_by_transfer_PC: e.acceptance.taken_by_transfer.PC},
    circle: {size: e.circle.size, closed: e.circle.closed, members_by_kind: e.circle.members_by_kind}};
}

async function runScenario(sc) {
  const w = evidenceWorld();
  try {
    const built = sc.build(w), e = await evidence(w, built.subject);
    const policies = Object.fromEntries(POLICIES.map(p => {
      const ok = p.accepts(e), per = ok ? p.exposure(e) : 0;
      // What the subject could take on credit from honest holders using this policy, if it walked away after: each holder
      // takes at most `per` of it (and a deal at most max_accept_per_deal); its own box caps what it can owe in all.
      const room = BOX.max_issue_outstanding - e.repayment.outstanding_PC;
      const victims = built.victims ?? 1, takeable = ok ? Math.min(room, victims * per) : 0;
      return [p.id, {accepts: ok, per_holder_PC: per, takeable_PC: takeable}];
    }));
    const before = built.before ? summary(await evidence(w, built.before)) : null;
    return {id: sc.id, title: sc.title, kind: sc.kind, story: sc.story, evidence: summary(e), ...(before ? {evidence_before_reset: before} : {}),
      policies, cost: built.cost, victims: built.victims ?? 1};
  } finally { w.cleanup(); }
}

// Earned limits (not built): a self-serve box that grows with settled credits. What would a staged circle, or a farm of
// house feedback, add to an identity's box per day, and at what cost?
function earnedLimits() {
  const perLoop = BOX.max_issue_per_deal;                       // a pretend job of the largest deal, then cancelled
  const stagedPerDay = perLoop * ENGINE_RUNS_PER_HOUR * 24;      // one loop a clearing run, all day
  const farmPerDay = HOUSE.feedback_PC * HOUSE.feedback_per_person_per_day;
  return [
    {id: 'any_settlement', counts: 'every settled credit', per_identity_per_day_PC: stagedPerDay, cost: 'three self-serve joins and pretend jobs; no outsider, no real work',
      reading: `A staged circle settles up to ${perLoop} credits per identity at each clearing run (about ${ENGINE_RUNS_PER_HOUR} an hour): about ${stagedPerDay} credits a day per identity, for nothing. Limits that grow with any settlement grow without bound.`},
    {id: 'anchored_settlement', counts: 'credits settled with an invited or operator-run creditor', per_identity_per_day_PC: farmPerDay, cost: 'one tl;dr bought and one feedback the house agent\'s model accepts, a day, per identity',
      reading: `Settling with a house agent is rationed by its own limits: ${HOUSE.feedback_per_person_per_day} paid feedback a day per person and ${HOUSE.feedback_per_agent_per_day} a day per house agent, so about ${farmPerDay} credits a day per identity and ${HOUSE.feedback_per_agent_per_day * HOUSE.feedback_PC} a day in all per house agent. Slower, but still bought with model-written feedback, and it spends the operator's model budget.`},
  ];
}

const FINDINGS = [
  'The record alone cannot tell a staged circle from an honest one. Three identities one operator runs leave exactly the evidence three independent operators do: the same counts, the same kinds, the same settlement, the same closed circle (test/evidence.unit.test.mjs checks this).',
  'Closed-group and invited-creditor checks only raise the price. One tl;dr bought from a house agent, paid back with feedback its model accepts, opens a staged circle and gives it an invited creditor within a day.',
  'An identity reset costs one join. The new identity has no record, so every policy that asks for evidence refuses it, and the box-only policy takes it as it takes any newcomer. An identity bound to an X account costs a new X account instead.',
  'The fixed self-serve box is what bounds the damage. Whatever its record shows and whatever policy its holders use, one self-serve identity can owe at most the box\'s total; a clean record lets it reach that total sooner, not exceed it.',
  'Limits that grew automatically with settled credits would be bought for nothing: a staged circle settles credits as fast as the clearing engine runs. Counting only settlement with invited creditors slows that to the house agents\' feedback ration, which model-written feedback can still fill.',
  'Stricter evidence policies refuse honest newcomers too: a real newcomer has no record, exactly like a fresh attacker. Evidence helps a holder decide only together with what the record cannot show: who the operator is, and what it has at stake.',
  "The same weakness was found earlier in the server's own coverage rule: finding F3 (docs/ADVERSARIAL-FINDINGS.md) shows that min_payer_coverage_pct counts claims issued by anyone, so a colluder with no backing can manufacture a payer's coverage.",
];
const LIMITATIONS = [
  'States are built directly as the server stores them (deals, the edge journal, set-offs, transfers, tracker notes), not by running agents through the API; costs use the server\'s caps and the house agents\' limits as configured on 2026-11-13.',
  'Independence is not observable here: kinds say how a participant joined, not who runs it. An invited participant can be dishonest too.',
  'Defaults are modelled as walking away with debt outstanding. The pilot has no due dates on IOUs, so an unsettled IOU is not yet marked as a broken promise.',
];

async function main() {
  const scenarios = [];
  for (const sc of SCENARIOS) scenarios.push(await runScenario(sc));
  const out = {generated_by: 'scripts/evidence-attacks.mjs', evidence_module: 'lib/pilot/evidence.mjs',
    inputs: {box: {...BOX}, box_days: SANDBOX_DAYS, joins_per_hour_per_address: SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, clearing_runs_per_hour: ENGINE_RUNS_PER_HOUR, house: HOUSE},
    policies: POLICIES.map(({id, name, rule}) => ({id, name, rule})), scenarios, earned_limits: earnedLimits(), findings: FINDINGS, limitations: LIMITATIONS};
  const json = JSON.stringify(out, null, 1) + '\n', md = markdown(out);
  const jsonPath = path.join(root, 'public', 'evidence-attacks.json'), mdPath = path.join(root, 'docs', 'EVIDENCE-ATTACKS.md');
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, 'utf8') === json && fs.existsSync(mdPath) && fs.readFileSync(mdPath, 'utf8') === md;
    if (!same) { console.error('evidence-attacks: the committed outputs differ from a fresh run; run node scripts/evidence-attacks.mjs'); process.exit(1); }
    console.log('evidence-attacks: outputs are current');
    return;
  }
  fs.writeFileSync(jsonPath, json); fs.writeFileSync(mdPath, md);
  console.log(`evidence-attacks: ${scenarios.length} scenarios -> ${path.relative(root, mdPath)}, ${path.relative(root, jsonPath)}`);
}

const kinds = k => Object.entries(k).map(([a, n]) => `${n} ${a.replace('_', ' ')}`).join(', ') || 'none';
const yes = b => (b ? 'yes' : 'no');
function markdown(o) {
  const L = [];
  L.push('# What staged records look like', '');
  L.push('Generated by `node scripts/evidence-attacks.mjs` from the evidence code (`lib/pilot/evidence.mjs`); do not edit by hand.', '');
  L.push('The evidence in a Valun record is three separate things: **delivery** (work its buyers accepted: evidence about a seller), **repayment** (what it owed and how much was settled: evidence about a debtor) and **acceptance** (who chose to hold its IOU: a willingness to take its risk, not repayment). This page stages the attacks that a record must survive and reads them through that evidence. The owner policies and earned limits below are candidates under study. **None of them is built: Valun grants no credit from evidence.**', '');
  L.push('## The scenarios', '');
  for (const s of o.scenarios) {
    const e = s.evidence;
    L.push(`### ${s.title} (${s.kind})`, '', s.story, '');
    L.push(`- Delivery: ${e.delivered.accepted} accepted, from ${e.delivered.buyers} buyer(s) (${kinds(e.delivered.buyers_by_kind)}).`);
    L.push(`- Repayment: settled ${e.settled.PC} of ${e.settled.owed_ever_PC} credits owed, with ${e.settled.creditors} creditor(s) (${kinds(e.settled.creditors_by_kind)}); unpaid accepted work: ${e.settled.unpaid_accepted_work}.`);
    L.push(`- Acceptance: ${e.accepted_by.holders_ever} holder(s) ever; ${e.accepted_by.taken_by_transfer_PC} credits taken by transfer.`);
    L.push(`- Circle: ${e.circle.size} participant(s), ${e.circle.closed ? 'closed' : 'open'} (${kinds(e.circle.members_by_kind)}).`);
    if (s.evidence_before_reset) L.push(`- The identity before the reset: owed ${s.evidence_before_reset.settled.owed_ever_PC}, settled ${s.evidence_before_reset.settled.PC}; its victim still holds ${s.cost.lost_by_victims_PC} credits of an IOU nobody will settle. The new identity starts with nothing.`);
    const c = s.cost;
    L.push(`- Cost: ${c.identities} identit${c.identities === 1 ? 'y' : 'ies'} run by ${c.operators} operator(s), ${c.real_jobs} real job(s), ${c.feedback_checked} checked feedback, ${c.outsiders} outsider(s) involved${c.minutes ? `, about ${c.minutes} minutes` : c.days ? `, ${c.days} day(s)` : ''}.`, '');
  }
  L.push('## Candidate owner policies', '', 'What a holder might require before taking an issuer\'s IOU. "Takeable" is what the subject could take on credit from holders using that policy before walking away' + ' (eight holders in the slow burn, one elsewhere), within the box.', '');
  L.push('| Policy | Rule |', '|---|---|');
  for (const p of o.policies) L.push(`| ${p.name} | ${p.rule} |`);
  L.push('', '| Scenario | ' + o.policies.map(p => p.name).join(' | ') + ' |', '|---|' + o.policies.map(() => '---').join('|') + '|');
  for (const s of o.scenarios) L.push(`| ${s.title} | ` + o.policies.map(p => { const r = s.policies[p.id]; return r.accepts ? `takes ${r.takeable_PC}` : 'refuses'; }).join(' | ') + ' |');
  L.push('', '## Earned limits (not built)', '', 'If the self-serve box grew with settled credits, what would an attacker add to an identity\'s box per day?', '');
  L.push('| Counts | Per identity per day | Cost |', '|---|---|---|');
  for (const x of o.earned_limits) L.push(`| ${x.counts} | about ${x.per_identity_per_day_PC} credits | ${x.cost} |`);
  L.push('');
  for (const x of o.earned_limits) L.push(`- ${x.reading}`);
  L.push('', '## Findings', '');
  o.findings.forEach((f, i) => L.push(`${i + 1}. ${f}`));
  L.push('', '## Limitations', '');
  for (const x of o.limitations) L.push(`- ${x}`);
  L.push('', `Inputs: the self-serve box (${o.inputs.box.max_issue_per_deal} a deal, ${o.inputs.box.max_issue_outstanding} owed, ${o.inputs.box.max_accept_per_issuer} per issuer, ${o.inputs.box_days} days), ${o.inputs.joins_per_hour_per_address} self-serve joins an hour per address, about ${o.inputs.clearing_runs_per_hour} clearing runs an hour, house feedback ${o.inputs.house.feedback_PC} credits (${o.inputs.house.feedback_per_person_per_day} a day per person, ${o.inputs.house.feedback_per_agent_per_day} a day per house agent).`, '');
  return L.join('\n');
}

main().catch(e => { console.error(e); process.exit(1); });
