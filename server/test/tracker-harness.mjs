// Starts a throwaway real Basis tracker for integration tests (own run folder, own port), and stops it afterwards.
// BASIS_RUNNER=wsl  -> the Windows dev machine: binaries in WSL valun-ic1 (/home/valun only)
// BASIS_RUNNER=direct -> container/Linux: binaries on PATH-less absolute paths (VALUN_BINS)
// VALUN_BINS names a staged release folder (for example the v3 tracker's); VALUN_TRACKER_BIN (basis_server) and
// VALUN_SIGNER (valun_signer) override one binary each. basis/run-tracker.sh writes the config layout the tracker binary
// needs (BASIS_CONFIG_LAYOUT, default auto; BASIS_PURE_CREDIT and RUST_LOG are passed on too).
// A tracker that exits, or never answers, fails startTracker at once, with the tail of what it printed.
import {spawn, spawnSync, execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capabilitiesFrom} from '../lib/basis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WSL = 'C:/Windows/System32/wsl.exe', D = ['-d', 'valun-ic1', '-u', 'valun'];
export const runner = process.env.BASIS_RUNNER || (process.platform === 'win32' ? 'wsl' : 'direct');
export const bins = process.env.VALUN_BINS || (runner === 'wsl' ? '/home/valun/valun-app-bins-20261105T024815Z/t/release' : '/opt/valun/bin');
export const trackerBin = process.env.VALUN_TRACKER_BIN || `${bins}/basis_server`;
export const signerPath = process.env.VALUN_SIGNER || (runner === 'wsl' ? `${bins}/examples/valun_signer` : `${bins}/valun_signer`);
const PASS_ON = ['BASIS_CONFIG_LAYOUT', 'BASIS_PURE_CREDIT', 'RUST_LOG'];   // launcher settings, forwarded into WSL as well
const TAIL_LINES = 50, NFT_WAIT_MS = 20000, HEALTH_WAIT_MS = 15000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const grace = ms => new Promise(r => setTimeout(r, ms).unref());   // a bounded wait that never holds the process open
const within = (p, ms) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(r, ms); })]).finally(() => clearTimeout(t)); };

// Keeps the last TAIL_LINES lines a stream printed (colour codes and NULs removed: wsl.exe prints its own errors in
// UTF-16) and calls onLine with each complete line.
function lineTail(stream, onLine = () => {}) {
  const kept = [];
  let part = '';
  const clean = l => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\0/g, '');
  stream.setEncoding('utf8');
  stream.on('data', d => {
    const lines = (part + d).split(/\r?\n/);
    part = lines.pop();
    if (part.length > 4096) { lines.push(part); part = ''; }
    for (const l of lines) { kept.push(clean(l)); if (kept.length > TAIL_LINES) kept.shift(); onLine(l); }
  });
  return () => (part ? [...kept, clean(part)] : kept).slice(-TAIL_LINES);
}

// GET / as Basis.health() reads it: {ok} or {ok: false, why}.
async function health(url) {
  try {
    const r = await fetch(url + '/', {signal: AbortSignal.timeout(2000)});
    const text = await r.text();
    return r.status === 200 && /Basis Tracker/.test(text) ? {ok: true} : {ok: false, why: `HTTP ${r.status}`};
  } catch (e) { return {ok: false, why: e.cause?.code || e.name}; }
}

// Whatever already answers HTTP on url ('HTTP <status>'), or null when nothing does.
async function occupant(url) {
  try { const r = await fetch(url + '/', {signal: AbortSignal.timeout(1500)}); await r.arrayBuffer().catch(() => {}); return `HTTP ${r.status}`; }
  catch { return null; }
}

export async function startTracker(port = 3049, {servedTokenId = null, servedTokenSymbol = 'PC'} = {}) {
  const url = `http://127.0.0.1:${port}`;
  // Never test against a process this harness did not start: a tracker left on the port would answer in place of the
  // new one (which would then fail to bind). The harness never stops processes it did not start.
  const other = await occupant(url);
  if (other) throw Error(`something already answers on ${url} (${other}); a test tracker needs this port to itself. Stop that process first.`);
  // The run folder is unique per call (a random suffix): two trackers started by one process in the same second must
  // never share a data folder or a tracker id, and one's stop() must never remove the other's folder.
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z', suffix = crypto.randomBytes(4).toString('hex');
  const script = fs.readFileSync(path.join(root, 'basis', 'run-tracker.sh'));
  const env = {BASIS_PORT: String(port), ...(servedTokenId ? {BASIS_SERVED_TOKEN_ID: servedTokenId, BASIS_SERVED_TOKEN_SYMBOL: servedTokenSymbol} : {})};
  let run, child;
  if (runner === 'wsl') {
    run = `/home/valun/valun-app-test-${stamp}-${process.pid}-${suffix}`;
    const put = spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', 'mkdir -p "$1" && cat > "$1/run-tracker.sh" && chmod 700 "$1/run-tracker.sh"', 'sh', run], {input: script});
    if (put.status !== 0) throw Error(`cannot stage tracker script in WSL (exit ${put.status}: ${String(put.stderr ?? '').replace(/\0/g, '').trim()})`);
    const passed = Object.fromEntries(PASS_ON.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
    child = spawn(WSL, [...D, '--exec', '/usr/bin/env', ...Object.entries({...passed, ...env}).map(([k, v]) => `${k}=${v}`), `${run}/run-tracker.sh`, run, trackerBin], {stdio: ['ignore', 'pipe', 'pipe']});
  } else {
    run = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'valun-test-tracker-'));
    fs.writeFileSync(path.join(run, 'run-tracker.sh'), script, {mode: 0o700});
    child = spawn('/bin/bash', [path.join(run, 'run-tracker.sh'), run, trackerBin], {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
  }
  let exit = null, nftSeen;
  const exited = new Promise(r => {
    const done = info => { if (!exit) { exit = info; r(info); } };
    child.once('exit', (code, signal) => done({code, signal}));
    child.on('error', e => done({error: e.code || e.message}));   // kept for the child's lifetime: an 'error' never goes unhandled
  });
  const closed = new Promise(r => child.once('close', r));
  const nftPrinted = new Promise(r => { nftSeen = r; });
  const stdoutTail = lineTail(child.stdout, l => { const m = /TRACKER_NFT_ID=([0-9a-f]{64})/.exec(l); if (m) nftSeen(m[1]); });
  const stderrTail = lineTail(child.stderr);

  // Stops the tracker and removes only the throwaway folder this harness created.
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // The pid file is used only while the tracker runs (an exited tracker's pid could belong to another process by now).
    if (runner === 'wsl' && !exit) spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', '[ -s "$1/tracker.pid" ] && kill "$(cat "$1/tracker.pid")"', 'sh', run]);
    child.kill();
    await within(exited, 5000);
    if (runner === 'wsl' && /^\/home\/valun\/valun-app-test-\d{8}T\d{6}Z-\d+(-[0-9a-f]{8})?$/.test(run)) {
      await sleep(300);
      spawnSync(WSL, [...D, '--exec', '/bin/rm', '-rf', '--one-file-system', run]);
    } else if (runner !== 'wsl') {
      // The tracker may still be flushing files while it exits; cleanup must never fail the test file.
      try { fs.rmSync(run, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}); }
      catch (e) { console.warn(`could not remove ${run}: ${e.code}`); }
    }
  };
  const exitText = () => exit.error ? `could not be started (${exit.error})` : exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`;
  // Stops what is left of the tracker, then the error: what went wrong, the binary, and the tail of its output.
  const failure = async what => {
    await stop();
    await Promise.race([closed, grace(1000)]);   // the last output arrives before 'close'
    const err = stderrTail(), out = stdoutTail();
    // Git Bash rewrites /home/... in environment variables for Windows programs (VALUN_BINS=/home/valun/... becomes
    // C:/Program Files/Git/home/valun/...), which the WSL runner cannot use.
    const hint = runner === 'wsl' && /^[A-Za-z]:[\\/]/.test(trackerBin)
      ? ['hint: with BASIS_RUNNER=wsl the binaries are WSL paths; from Git Bash, set MSYS2_ENV_CONV_EXCL=VALUN_ so /home/... is passed unchanged'] : [];
    return Error([what, `tracker ${trackerBin} (runner ${runner}, run folder ${run}, now removed)`, ...hint,
      `tracker stderr, last ${err.length} line(s):`, ...(err.length ? err.map(l => `  ${l}`) : ['  (nothing)']),
      ...(out.length ? [`tracker stdout, last ${out.length} line(s):`, ...out.map(l => `  ${l}`)] : [])].join('\n'));
  };

  // 'exit' can come before the last output: after an exit, the NFT line still counts until the streams close.
  const nft = await within(Promise.race([nftPrinted, exited.then(() => Promise.race([closed, grace(1000)])).then(() => null)]), NFT_WAIT_MS);
  if (nft === null) throw await failure(`the tracker ${exitText()} before printing its NFT id`);
  if (!nft) throw await failure(`the tracker printed no NFT id within ${NFT_WAIT_MS / 1000} s`);
  const deadline = Date.now() + HEALTH_WAIT_MS;
  for (;;) {
    if (exit) throw await failure(`the tracker ${exitText()} before answering on ${url}`);
    const h = await health(url);
    if (h.ok && !exit) break;
    if (Date.now() >= deadline) throw await failure(`the tracker did not answer GET ${url}/ within ${HEALTH_WAIT_MS / 1000} s (last: ${h.why ?? 'answered, then exited'})`);
    await sleep(250);
  }
  return {url, nft, run, bin: trackerBin, stop};
}

// The tracker's GET /capabilities data (tracker v3), or null for any answer but a 200 with success (404 before v3).
// Read exactly as Basis.capabilities() reads it. Throws when the tracker is unreachable.
export async function capabilities(url) {
  const r = await fetch(url.replace(/\/$/, '') + '/capabilities', {signal: AbortSignal.timeout(10000)});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return capabilitiesFrom(r.status, json);
}

// sha256 (hex) of the tracker binary these tests run (VALUN_TRACKER_BIN, else VALUN_BINS), or of `bin`: through
// sha256sum in WSL (BASIS_RUNNER=wsl, the binaries live there) or by reading the file (direct). Computed once per path.
const sha256s = new Map();
export async function trackerSha256(bin = trackerBin) {
  if (!sha256s.has(bin)) {
    const p = runner === 'wsl'
      ? new Promise((resolve, reject) => execFile(WSL, [...D, '--exec', '/usr/bin/sha256sum', '--', bin], {encoding: 'utf8', timeout: 60000, windowsHide: true}, (e, out, err) => {
        const m = /^([0-9a-f]{64})\s/.exec(out ?? '');
        if (e || !m) reject(Error(`sha256sum ${bin} in WSL failed: ${String(err || e?.message || out).replace(/\0/g, '').trim()}`)); else resolve(m[1]);
      }))
      : new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(bin).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
      });
    sha256s.set(bin, p);
    p.catch(() => sha256s.delete(bin));
  }
  return sha256s.get(bin);
}
