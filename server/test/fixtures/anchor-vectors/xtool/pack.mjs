// Packs the scripted reads scenarios.py wrote, with the verdicts both auditors gave on them, into ../xtool.json (fix
// inbox #66): each distinct answer body once (`bodies`), each scenario's answers as [status, index into bodies], and
// each scenario's exit code, which both auditors must give (docs/PILOT-API.md, "Verdicts"), with the client's verdict
// and reason as it gave them. It refuses when the two auditors' exit codes differ on a scenario, or their lists do not
// name the same scenarios in the same order: the table is what both give.
// Usage: node pack.mjs <scenarios.json> <client.jsonl> <server.jsonl> <client commit> > ../xtool.json
import fs from 'node:fs';

const [file, clientFile, serverFile, commit] = process.argv.slice(2);
const lines = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.name !== undefined);
const scenarios = JSON.parse(fs.readFileSync(file, 'utf8')), client = lines(clientFile), server = lines(serverFile);
if (!/^[0-9a-f]{7,40}$/.test(String(commit))) throw new Error('name the valun-open commit the client ran at');
if (client.length !== scenarios.length || server.length !== scenarios.length) throw new Error('one verdict per scenario, from each auditor');
const bodies = [], index = new Map();
const at = text => { if (!index.has(text)) { index.set(text, bodies.length); bodies.push(text); } return index.get(text); };
const out = scenarios.map((s, i) => {
  const c = client[i], v = server[i];
  if (c.name !== s.name || v.name !== s.name) throw new Error(`scenario ${i}: the lists do not name ${s.name}`);
  if (c.exit !== v.exit) throw new Error(`${s.name}: the client gives exit ${c.exit}, anchor-audit.mjs ${v.exit}`);
  return {name: s.name, server: s.server, explorer: s.explorer, nft: s.nft,
    responses: Object.fromEntries(Object.entries(s.responses).map(([u, list]) => [u, list.map(([st, body]) => [st, at(body)])])),
    exit: c.exit, client: {verdict: c.verdict, reason: c.reason}};
});
process.stdout.write(`${JSON.stringify({
  what: 'Scripted reads of a Valun server and an Ergo explorer, the same bytes for both anchor auditors (scripts/ops/anchor-audit.mjs and valun audit), and the exit code each must give on them (docs/PILOT-API.md, "Verdicts"; fix inbox #66). Each url\'s answers are given in turn, the last repeating; any other url is a 404.',
  made_by: `test/fixtures/anchor-vectors/xtool: scenarios.py on the test World of valun-open ${commit} python/tests/test_audit.py (synthetic keys and boxes), verdicts by run_client.py at ${commit} and run_server_tool.mjs, packed by pack.mjs`,
  bodies, scenarios: out}, null, 1)}\n`);
