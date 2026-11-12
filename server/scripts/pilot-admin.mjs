// Pilot admin from inside the host (loopback only). On Fly:
//   fly ssh console -a valun-desk -C "node /opt/valun/app/scripts/pilot-admin.mjs invite --note 'for Alice' --uses 1"
// Locally: node scripts/pilot-admin.mjs invite --data data/pilot --port 4320
// The admin token never leaves the data volume; the route answers 404 to anything that is not loopback + token.
// Circulating credit (release v16, modes sandbox and on only): `clearing run` starts a batch search of the clearing
// engine now and prints its run record; `clearing status` prints the engine's diagnostics (set-off ids, members, edges
// and which slots are signed; never a signature). `--json` prints the server's answer as it is.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dataDir = opt('data', process.env.PILOT_DATA_DIR || '/data/pilot');
const port = opt('port', process.env.PORT || '8080');
const json = args.includes('--json');
const token = fs.readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
// What a refusal of the clearing routes means (they exist only while the engine can run).
const HINTS = {clearing: 'the clearing routes exist only while circulating credit runs in mode sandbox or on (PILOT_CIRCULATION, on a pinned tracker v3.2)'};
const call = async (method, p, body, hint = null) => {
  const r = await fetch(`http://127.0.0.1:${port}/pilot/v1/admin${p}`, {method, headers: {'content-type': 'application/json', 'x-valun-admin': token}, body: body && JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`HTTP ${r.status}: ${j.message || j.error || ''}${hint && r.status === 404 ? ` (${hint})` : ''}`); process.exit(1); }
  return j;
};
const counts = o => Object.entries(o || {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const setoffLine = o => `${o.id}  ${o.state}  ${o.amount} PC  ${o.members.length} members  ${o.edges.length} edges` +
  `  signed ${o.edges.reduce((a, e) => a + Number(e.signed.issuer) + Number(e.signed.recipient), 0)}/${o.edges.length * 2}` +
  `  ${o.source}${o.result ? `  result ${o.result.code}` : ''}  updated ${o.updated_at}`;

if (cmd === 'invite') {
  const r = await call('POST', '/invites', {note: opt('note', ''), max_uses: Number(opt('uses', 1)), ttl_days: Number(opt('days', 14))});
  console.log(`invite ${r.id}: ${r.code}  (expires ${r.expires_at})`);
} else if ((cmd === 'unlist' || cmd === 'list') && /^vp_[0-9a-f]{12}$/.test(args[1] || '')) {
  // Hide a participant from the directory (a test or demo agent that is not running), or show it again.
  const r = await call('PUT', `/participants/${args[1]}/listing`, {listed: cmd === 'list'});
  console.log(`${r.participant.handle}: ${r.listed ? 'listed' : 'unlisted'}${r.changed ? '' : ' (unchanged)'}`);
} else if (cmd === 'invites') {
  for (const i of await call('GET', '/invites')) console.log(`${i.id}  uses ${i.uses}/${i.max_uses}  expires ${i.expires_at}  ${i.note}`);
} else if (cmd === 'enrollment-code' && /^vp_[0-9a-f]{12}$/.test(args[1] || '')) {
  // At the owner's request only. Prints ONLY the code, so it can be piped straight into `hermes valun enroll --code-from-stdin`.
  const r = await call('POST', `/participants/${args[1]}/enrollment-code`);
  process.stdout.write(r.enrollment_code + '\n');
} else if (cmd === 'owner-token' && /^vp_[0-9a-f]{12}$/.test(args[1] || '')) {
  // Recovery of a lost or stolen owner token, ONLY after confirming the owner out of band. The old token stops working.
  // Prints ONLY the new token (hand it to the owner privately); the owner sees in the console that the operator replaced it.
  const r = await call('POST', `/participants/${args[1]}/owner-token`);
  process.stdout.write(r.owner_token + '\n');
} else if (cmd === 'mandate' && /^vp_[0-9a-f]{12}$/.test(args[1] || '') && args[2]) {
  // At the owner's request only; recorded as changed by the operator and shown to the owner.
  const r = await call('PUT', `/participants/${args[1]}/mandate`, JSON.parse(args[2]));
  console.log(`mandate version ${r.mandate_version} (changed by ${r.changed_by}): ${JSON.stringify(r.mandate)}`);
} else if (cmd === 'clearing' && args[1] === 'run') {
  // A batch search now (POST /admin/clearing/run): proposals for the cycles it finds; server-only ones apply at once.
  const r = await call('POST', '/clearing/run', {}, HINTS.clearing);
  if (json) console.log(JSON.stringify(r, null, 1));
  else if (!r) console.log('clearing run: nothing ran (circulating credit is off)');
  else {
    console.log(`clearing run ${r.id} at ${r.at} (${r.reason}): ${r.eligible_edges} eligible edges, ${r.cycles_found} cycles found` +
      ` (${r.expansions} expansions${r.truncated ? ', search truncated' : ''}), ${r.proposed} set-offs proposed, ${r.applied_now} applied at once`);
    console.log(`  excluded edges: ${counts(r.excluded)}`);
    if (r.setoffs?.length) console.log(`  set-offs: ${r.setoffs.join(', ')}`);
    if (r.skipped?.length) console.log(`  not proposed: ${r.skipped.map(s => (typeof s === 'string' ? s : JSON.stringify(s))).join(', ')}`);
  }
} else if (cmd === 'clearing' && args[1] === 'status') {
  // The engine's diagnostics (GET /admin/clearing): its runs, live and recent set-offs, cooldowns and refusals.
  const r = await call('GET', '/clearing', undefined, HINTS.clearing);
  if (json) console.log(JSON.stringify(r, null, 1));
  else {
    const e = r.engine;
    console.log(`mode ${r.mode}; engine ${e ? `${e.enabled ? 'enabled' : 'not enabled'}, batch every ${Math.round((e.interval_ms ?? 0) / 1000)} s, last batch ${e.last_batch_at ?? 'never'}` : 'not running'}`);
    const last = r.runs?.at(-1);
    if (last) console.log(`last run ${last.id} at ${last.at} (${last.reason}): ${last.eligible_edges} eligible edges, ${last.cycles_found} cycles, ${last.proposed} proposed, ${last.applied_now} applied at once; excluded: ${counts(last.excluded)}`);
    console.log(`live set-offs (${r.live.length}):`); for (const o of r.live) console.log(`  ${setoffLine(o)}`);
    console.log(`recently ended (${r.recent.length}, newest first):`); for (const o of r.recent) console.log(`  ${setoffLine(o)}`);
    const cd = Object.entries(r.cooldowns || {});
    console.log(`cooldowns (${cd.length}):`); for (const [k, v] of cd) console.log(`  ${k}  until ${v.until}  (${v.reason}${v.setoff ? `, ${v.setoff}` : ''})`);
    const streaks = Object.entries(r.expiry_streaks || {});
    if (streaks.length) console.log(`expiries in a row: ${streaks.map(([id, n]) => `${id} ${n}`).join(', ')}`);
    console.log(`refusals kept: ${r.refusals?.length ?? 0} (the last 20 are in --json)`);
  }
} else {
  console.log('usage: pilot-admin.mjs invite [--note text] [--uses n] [--days n] | invites | enrollment-code <vp_id> | owner-token <vp_id> | mandate <vp_id> <json> | clearing run|status [--json]   [--data dir] [--port n]');
}
