// Runs valun-app's scripts/ops/anchor-audit.mjs (imported read-only by path) on scripted reads: a JSON list of scenarios
// {name, server, explorer, nft, responses: {url: [[status, body_or_text], ...]}} as scenarios.py writes them, or the
// packed file pack.mjs writes (../xtool.json, whose bodies are indexes into its `bodies`; fix inbox #66). Each url's
// answers are given in turn, the last repeating; any other URL is a 404. Prints one JSON line per scenario: {name,
// verdict, exit, reason, calls}; with the packed file, whose scenarios carry the exit code both auditors must give
// (docs/PILOT-API.md, "Verdicts"), a last line counting those that differ, and exit 1 if any does.
// Usage: node run_server_tool.mjs <anchor-audit.mjs> <scenarios.json | ../xtool.json>
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const [script, file] = process.argv.slice(2);
const A = await import(pathToFileURL(script).href);
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const scenarios = Array.isArray(doc) ? doc
  : doc.scenarios.map(s => ({...s, responses: Object.fromEntries(Object.entries(s.responses).map(([u, list]) => [u, list.map(([st, i]) => [st, doc.bodies[i]])]))}));
let differ = 0;
for (const s of scenarios) {
  const queues = Object.fromEntries(Object.entries(s.responses).map(([u, list]) => [u, list.map(x => x.slice())]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    const q = queues[url];
    let status = 404, body = {error: 'not_found'};
    if (q && q.length) [status, body] = q.length > 1 ? q.shift() : q[0];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
  };
  let r;
  try {
    r = await A.audit({server: s.server, explorer: s.explorer, cover: false, trackerNft: s.nft, fetchImpl, settleMs: 0,
      sleep: async () => {}, now: () => Date.parse('2026-11-14T23:00:00Z')});
  } catch (e) {
    r = {verdict: 'ERROR', exit: 2, reason: String(e?.stack || e)};
  }
  if (s.exit !== undefined && r.exit !== s.exit) differ++;
  console.log(JSON.stringify({name: s.name, verdict: r.verdict, exit: r.exit, reason: String(r.reason ?? '').slice(0, 260), calls: calls.length}));
}
if (!Array.isArray(doc)) {
  console.log(JSON.stringify({scenarios: scenarios.length, exit_differs_from_the_table: differ}));
  process.exitCode = differ ? 1 : 0;
}
