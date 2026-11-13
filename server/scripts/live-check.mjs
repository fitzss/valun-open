// The daily check of a running Valun server (runbook section M, step 8 item 4), as one read-only command.
//
// Public reads (anyone can make them): GET /api/status, /pilot/v1/info, /pilot/v1/ledger and /pilot/v1/clearing. With
// --fly APP it also reads, through `fly ssh console` and `fly logs --no-tail` (your flyctl login; read-only, but `fly
// ssh` starts a stopped machine): the memory of the app and its two trackers, the sizes of the pilot's growing files,
// and the recent log lines that mean trouble. Nothing is written anywhere, and no token is used or printed.
//
// Each check prints one line, OK, WARN or FAIL, with the evidence. Exit 0 when nothing FAILs (WARNs allowed), 1 when
// anything FAILs, 2 when the server cannot be read at all. --json prints the report as JSON instead.
//
// Usage: node scripts/live-check.mjs [BASE_URL] [--fly APP] [--expect-mode off|bound|sandbox|on] [--json]
//        BASE_URL defaults to https://valun-desk.fly.dev, APP to none (public reads only).
//
// The limits are the runbook's (step 5 "Go"): the app's VmRSS plus both trackers at most 170 MiB, MemAvailable at least
// 40 MiB, no ALARM, no "fail closed", no OOM. WARN thresholds sit before them. Importing this file runs nothing
// (test/live-check.test.mjs calls evaluate() with recorded snapshots).
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const CONTRACT = Object.freeze({tracker_build: 'valun-circulating-credit/4', transfer_version: 4, bound_note_version: 3,
  prior_ack: 'basis/prior-ack/1'});
export const LIMITS = Object.freeze({rssFailMiB: 170, rssWarnMiB: 150, availFailMiB: 40, availWarnMiB: 60,
  edgeLogWarnMiB: 50, stateWarnMiB: 20});
const FEATURES = Object.freeze({off: [], bound: ['bound_notes/1'], sandbox: ['bound_notes/1', 'circulation/1', 'guarantees/1'],
  on: ['bound_notes/1', 'circulation/1', 'guarantees/1']});
// Log lines worth a FAIL (ALARM: a tracker without capabilities on a volume where circulation ran, readiness R-18;
// fail closed: circulation asked for but not taken; OOM) and a WARN (an exception the server logged and survived).
const LOG_FAIL = /ALARM|fail closed|Out of memory|oom-kill|Killed process/i;
// Case-sensitive on purpose: Fly's own init lines say "an unhandled error occurred" for harmless things (checksum
// offload); what the app and the trackers print for a real exception is "Error:", "panicked at" or "Uncaught".
const LOG_WARN = /\bError:|panicked at|\bUncaught\b|uncaughtException/;
const MiB = kb => kb / 1024;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The verdicts for one snapshot: [{level: 'ok'|'warn'|'fail', name, detail}]. A snapshot is what gather() reads:
// {status, info, ledger, clearingCode, fly?: {mem?, logs?}} (any part may be missing or an {error}).
export function evaluate(snap, {expectMode = null, limits = LIMITS} = {}) {
  const out = [], add = (level, name, detail = '') => out.push({level, name, detail});
  const {status, info, ledger, clearingCode} = snap;
  if (!status || status.error) add('fail', 'GET /api/status', status?.error ?? 'no answer');
  if (!info || info.error) add('fail', 'GET /pilot/v1/info', info?.error ?? 'no answer');
  if (out.length) return out;

  // MIG-1 (release v16.1): a server whose pilot tracker reports no valid tracker v3.2 capabilities while the state holds
  // circulating-credit history refuses every pilot write and says so in GET /pilot/v1/info (writes_refused).
  if (info.writes_refused) add('fail', 'pilot writes are not refused (MIG-1)', `${info.writes_refused.code ?? '?'} since ${info.writes_refused.since ?? '?'}: ${info.writes_refused.reason ?? ''}; fix: ${info.writes_refused.fix ?? ''}`.slice(0, 400));
  const features = Array.isArray(info.features) ? info.features : [];
  const mode = features.includes('circulation/1') ? 'sandbox_or_on' : features.includes('bound_notes/1') ? 'bound' : 'off';
  if (expectMode) {
    const want = FEATURES[expectMode];
    if (!want) add('fail', 'expected mode', `unknown mode ${expectMode}`);
    else add(same(features, want) ? 'ok' : 'fail', `features for mode ${expectMode}`, JSON.stringify(features));
  } else add('ok', 'features', JSON.stringify(features));

  const pin = status.basis?.pin ?? '';
  if (/\(binary not pinned\)\s*$/.test(pin)) add(mode === 'off' ? 'warn' : 'fail', 'tracker binary pinned', pin);
  // The tracker each network runs: the pilot's is tracker v3.2; the testnet's (valun-testnet-1) is tracker v4 with
  // anchored netting (TR-15), which keeps the same contract (checked below).
  else if (mode !== 'off' && !(info.network === 'valun-testnet-1' ? /^Basis tracker v4(\.\d+)? \(anchored netting\): / : /^Basis tracker v3\.2: /).test(pin)) {
    add('fail', `tracker pin names ${info.network === 'valun-testnet-1' ? 'tracker v4 (anchored netting)' : 'tracker v3.2'}`, pin || 'no pin');
  }
  else add('ok', 'tracker pin', pin || 'none');

  if (mode !== 'off') {
    const n = info.novation;
    const got = n && Object.fromEntries(Object.keys(CONTRACT).map(k => [k, n[k]]));
    add(n && same(got, CONTRACT) ? 'ok' : 'fail', 'the tracker v3.2 contract in GET /pilot/v1/info', JSON.stringify(got ?? null));
  } else if (info.novation != null) add('warn', 'no novation object in mode off', 'GET /pilot/v1/info has one');

  if (!ledger || ledger.error) add('fail', 'GET /pilot/v1/ledger', ledger?.error ?? 'no answer');
  else {
    const rows = Array.isArray(ledger.reconciliation) ? ledger.reconciliation : [];
    const bad = rows.filter(r => r.status !== 'match');
    add(bad.length ? 'fail' : 'ok', 'every public reconciliation row is match',
      `${rows.length} rows, ${(ledger.notes || []).length} notes` + (bad.length ? `; not match: ${bad.map(r => `${r.issuer}>${r.recipient} ${r.status}`).join(', ')}` : ''));
  }
  if (features.includes('circulation/1')) add(clearingCode === 200 ? 'ok' : 'fail', 'GET /pilot/v1/clearing answers', `HTTP ${clearingCode}`);

  const fly = snap.fly;
  if (!fly) return out;
  const mem = fly.mem;
  if (!mem || mem.error) add('fail', 'machine memory (fly ssh)', mem?.error ?? 'no answer');
  else {
    const rssKb = (mem.app_kb ?? 0) + (mem.trackers_kb ?? []).reduce((a, b) => a + b, 0);
    const rss = MiB(rssKb), avail = MiB(mem.mem_available_kb ?? 0);
    const trackers = (mem.trackers_kb ?? []).length;
    add(trackers === 2 && mem.app_kb ? 'ok' : 'fail', 'the app and both trackers are running', `app ${mem.app_kb ? 'yes' : 'no'}, trackers ${trackers}`);
    add(rss > limits.rssFailMiB ? 'fail' : rss > limits.rssWarnMiB ? 'warn' : 'ok', `app + trackers VmRSS at most ${limits.rssFailMiB} MiB`,
      `${rss.toFixed(1)} MiB (app ${MiB(mem.app_kb ?? 0).toFixed(1)})`);
    add(avail < limits.availFailMiB ? 'fail' : avail < limits.availWarnMiB ? 'warn' : 'ok', `MemAvailable at least ${limits.availFailMiB} MiB`,
      `${avail.toFixed(1)} MiB; swap free ${MiB(mem.swap_free_kb ?? 0).toFixed(0)} MiB`);
    const sizes = mem.files ?? {};
    const edge = MiB((sizes['pilot-edge-log.jsonl'] ?? 0) / 1024), state = MiB((sizes['pilot-state.json'] ?? 0) / 1024);
    add(edge > limits.edgeLogWarnMiB ? 'warn' : 'ok', 'pilot-edge-log.jsonl size (readiness R-19: compacted from 16 MiB, at most daily, entries older than 31 days)', `${edge.toFixed(2)} MiB`);
    add(state > limits.stateWarnMiB ? 'warn' : 'ok', 'pilot-state.json size (readiness R-6)', `${state.toFixed(2)} MiB`);
  }
  if (!fly.logs || fly.logs.error) add('warn', 'recent logs (fly logs)', fly.logs?.error ?? 'no answer');
  else {
    const lines = fly.logs.lines ?? [];
    const bad = lines.filter(l => LOG_FAIL.test(l)), meh = lines.filter(l => !LOG_FAIL.test(l) && LOG_WARN.test(l));
    add(bad.length ? 'fail' : 'ok', 'no ALARM, fail closed or OOM in the recent logs', `${lines.length} lines read` + (bad.length ? `; e.g. ${bad[0].slice(0, 160)}` : ''));
    if (meh.length) add('warn', 'errors in the recent logs', `${meh.length}; e.g. ${meh[0].slice(0, 160)}`);
  }
  return out;
}

// What runs on the machine (fly ssh): one JSON line, prefixed so it can be found among flyctl's own output.
const REMOTE = `node -e '
const fs = require("fs"), out = {files: {}, trackers_kb: []};
for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\\n")) {
  const m = /^(MemAvailable|SwapFree):\\s+(\\d+)/.exec(l); if (m) out[m[1] === "MemAvailable" ? "mem_available_kb" : "swap_free_kb"] = +m[2];
}
for (const d of fs.readdirSync("/proc").filter(x => /^\\d+$/.test(x) && x !== String(process.pid))) {
  let argv = []; try { argv = fs.readFileSync("/proc/" + d + "/cmdline", "utf8").split("\\0").filter(Boolean); } catch { continue; }
  let rss = 0; try { rss = +(/^VmRSS:\\s+(\\d+)/m.exec(fs.readFileSync("/proc/" + d + "/status", "utf8")) || [0, 0])[1]; } catch {}
  const exe = argv[0] || "";
  if (/(^|\\/)node$/.test(exe) && argv.some(a => /(^|\\/)server\\.mjs$/.test(a))) out.app_kb = (out.app_kb || 0) + rss;
  else if (/(^|\\/)basis_server$/.test(exe)) out.trackers_kb.push(rss);
}
for (const f of ["pilot-state.json", "pilot-edge-log.jsonl", "pilot-audit.jsonl"]) { try { out.files[f] = fs.statSync("/data/pilot/" + f).size; } catch {} }
console.log("LIVECHECK " + JSON.stringify(out));'`;

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, {encoding: 'utf8', timeout: 180000, windowsHide: true});
  if (r.error) return {error: `${cmd}: ${r.error.message}`};
  return {code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}`};
};

async function getJson(base, p) {
  try {
    const r = await fetch(base + p, {signal: AbortSignal.timeout(60000)});
    const t = await r.text();
    if (!r.ok) return {error: `HTTP ${r.status}`, code: r.status};
    try { return JSON.parse(t); } catch { return {error: 'not JSON'}; }
  } catch (e) { return {error: e.message}; }
}

export async function gather(base, {flyApp = null} = {}) {
  const status = await getJson(base, '/api/status');      // also wakes a stopped machine (auto_stop)
  const [info, ledger] = await Promise.all([getJson(base, '/pilot/v1/info'), getJson(base, '/pilot/v1/ledger')]);
  let clearingCode = null;
  try { clearingCode = (await fetch(base + '/pilot/v1/clearing', {signal: AbortSignal.timeout(60000)})).status; } catch { clearingCode = 0; }
  const snap = {status, info, ledger, clearingCode};
  if (flyApp) {
    const b64 = Buffer.from(REMOTE).toString('base64');
    const ssh = run('fly', ['ssh', 'console', '-a', flyApp, '-C', `sh -c 'echo ${b64} | base64 -d | sh'`]);
    const line = ssh.error ? null : (ssh.out + ssh.err).split(/\r?\n/).find(l => l.startsWith('LIVECHECK '));
    let mem;
    try { mem = line ? JSON.parse(line.slice(10)) : {error: ssh.error ?? `fly ssh gave no report (exit ${ssh.code})`}; } catch { mem = {error: 'unreadable report'}; }
    const logs = run('fly', ['logs', '-a', flyApp, '--no-tail']);
    snap.fly = {mem, logs: logs.error ? {error: logs.error} : {lines: (logs.out || '').split(/\r?\n/).filter(Boolean)}};
  }
  return snap;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const base = (args.find(a => /^https?:\/\//.test(a)) ?? 'https://valun-desk.fly.dev').replace(/\/$/, '');
  const snap = await gather(base, {flyApp: opt('--fly')});
  const report = evaluate(snap, {expectMode: opt('--expect-mode')});
  const fails = report.filter(r => r.level === 'fail').length, warns = report.filter(r => r.level === 'warn').length;
  if (args.includes('--json')) console.log(JSON.stringify({base, at: new Date().toISOString(), report, fails, warns}, null, 1));
  else {
    console.log(`live check of ${base} at ${new Date().toISOString()}`);
    for (const r of report) console.log(`${r.level.toUpperCase().padEnd(4)}  ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
    console.log(fails ? `${fails} FAIL, ${warns} WARN` : `all clear${warns ? ` (${warns} WARN)` : ''}`);
  }
  process.exit(snap.status?.error && snap.info?.error ? 2 : fails ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
