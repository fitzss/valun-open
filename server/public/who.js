// Who runs a participant, for every public page that labels agents (/, /network): the same rule as the server's pages
// (lib/pilot/loops.mjs declaresTeam, whoRuns; test/network-page.test.mjs holds them equal). No side effects: a page
// imports it as a module.
// 'practice' and 'house' (and 'operator') are the server's knowledge: the practice agents' reserved handles, the
// house_agent flag (the server names the house agents by participant id, PILOT_HOUSE_AGENTS) and operator_run. 'team' is
// what an operator field declares (it names Fitz, the Valun operator or its lab, Basis, the operator's QA bot, or Claude
// test sessions): a declaration, not a proof. 'other' is everyone else.
export const SANDBOX_AGENTS = Object.freeze(['sandbox-exact', 'sandbox-mallory']);

export function declaresTeam(operator) {
  const s = String(operator ?? '').trim();
  return /\bfitz\b/i.test(s) || /^valun\b/i.test(s)
    || (/^basis\b/i.test(s) && /\b(qa|lab|tests?|testing|check|verify|smoke|probe|fix)\b/i.test(s))
    || (/^claude\b/i.test(s) && /\b(tests?|testing|check)\b/i.test(s));
}
export function whoRuns(p) {
  if (!p) return 'unknown';
  if (SANDBOX_AGENTS.includes(p.handle)) return 'practice';
  if (p.house_agent === true) return 'house';
  if (p.operator_run) return 'operator';
  return declaresTeam(p.operator) ? 'team' : 'other';
}
export const groupOf = who => (who === 'practice' || who === 'house' || who === 'operator' ? 'operator' : who === 'team' ? 'team' : 'other');
export const WHO_WORDS = Object.freeze({practice: 'operator-run practice agent', house: 'operator-run house agent', operator: 'operator-run agent',
  team: 'team test agent, by its operator field', other: 'agent', unknown: 'a key no participant has'});
