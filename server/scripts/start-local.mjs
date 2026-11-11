// Local development on the Windows dev machine: the Basis binaries are Linux builds, so the trackers and the signer run in
// the WSL distro valun-ic1 (as user valun, in /home/valun only); the Valun web app runs on Windows.
// Two trackers, both on WSL loopback (reachable from Windows loopback through WSL's localhost forwarding):
//   demo  127.0.0.1:3048  /home/valun/valun-app-local          (public demo, ERG-denominated, synthetic)
//   pilot 127.0.0.1:3058  /home/valun/valun-pilot-local         (valun-pilot-1, PC token, synthetic)
// Usage: node scripts/start-local.mjs   (Ctrl+C stops everything)
//   VALUN_BINS=<WSL folder with basis_server and examples/valun_signer> picks the binaries (default: the Basis 3df7ed93
//   build); PILOT_CIRCULATION=off|bound|sandbox|on asks for circulating credit, which takes effect only on a tracker whose
//   binary's sha256 is pinned (lib/pilot/pins.mjs): this script computes that sha256 in WSL and passes it to the app as
//   PILOT_TRACKER_SHA256, as the container entrypoint does. From Git Bash, set MSYS2_ENV_CONV_EXCL=VALUN_ so that a
//   VALUN_BINS of /home/... reaches this script unchanged.
// Importing this file starts nothing: it exports the pure parts (trackerSha256, trackerArgv, appEnv) for
// test/operations.test.mjs, and runs only as the entry point (node scripts/start-local.mjs).
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WSL = 'C:/Windows/System32/wsl.exe', D = ['-d', 'valun-ic1', '-u', 'valun'];

// The sha256 that `sha256sum <binary>` printed: '' when it failed or printed no hash, so that circulation stays off.
export function trackerSha256(result) {
  return result?.status === 0 ? (/^([0-9a-f]{64})\s/.exec(result.stdout || '') || [])[1] ?? '' : '';
}
// The wsl.exe arguments that start one tracker: basis/run-tracker.sh with the config layout the binary needs
// (BASIS_CONFIG_LAYOUT=auto picks node for 3df7ed93, scanner for tracker v3) and the tracker's own variables.
export const trackerArgv = (run, bins, env) => [...D, '--exec', '/usr/bin/env', 'BASIS_CONFIG_LAYOUT=auto', ...env, `${run}/run-tracker.sh`, run, `${bins}/basis_server`];
// The app's environment: this process's, under the launcher's own values. PILOT_TRACKER_SHA256 is always the hash this
// script computed (trackerSha256), never one from the environment: circulating credit takes effect only when it is pinned.
export function appEnv(env, {ports, bins, nfts, dataDir, pilotDir, sha256}) {
  return {...env,
    PORT: ports.app, BASIS_RUNNER: 'wsl', BASIS_SIGNER: `${bins}/examples/valun_signer`, BASIS_TRACKER_URL: `http://127.0.0.1:${ports.demo}`,
    BASIS_TRACKER_NFT_ID: nfts.demo, VALUN_DATA_DIR: dataDir, VALUN_DEPLOYMENT: 'local',
    PILOT_TRACKER_URL: `http://127.0.0.1:${ports.pilot}`, PILOT_TRACKER_NFT_ID: nfts.pilot, PILOT_DATA_DIR: pilotDir, PILOT_TRACKER_SHA256: sha256};
}

function main() {
  const BINS = process.env.VALUN_BINS || '/home/valun/valun-app-bins-20261105T024815Z/t/release';
  // Several local stacks can run side by side: VALUN_LOCAL_SUFFIX names separate folders, the *_PORT variables separate ports.
  const SUFFIX = process.env.VALUN_LOCAL_SUFFIX ? `-${process.env.VALUN_LOCAL_SUFFIX}` : '';
  const PORTS = {app: process.env.PORT || '4320', demo: process.env.VALUN_DEMO_TRACKER_PORT || '3048', pilot: process.env.VALUN_PILOT_TRACKER_PORT || '3058'};
  const RUNS = {demo: `/home/valun/valun-app-local${SUFFIX}`, pilot: `/home/valun/valun-pilot-local${SUFFIX}`};
  const PILOT_TOKEN_ID = crypto.createHash('sha256').update('valun-pilot-credit/1').digest('hex');
  const dataDir = path.join(root, `data${SUFFIX}`), pilotDir = path.join(root, `data-pilot${SUFFIX}`);
  fs.mkdirSync(dataDir, {recursive: true}); fs.mkdirSync(pilotDir, {recursive: true});

  // Copy the launcher script into WSL (automount is off, so WSL cannot read C:).
  const script = fs.readFileSync(path.join(root, 'basis', 'run-tracker.sh'));
  for (const run of Object.values(RUNS)) {
    const put = spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', 'mkdir -p "$1" && cat > "$1/run-tracker.sh" && chmod 700 "$1/run-tracker.sh"', 'sh', run], {input: script});
    if (put.status !== 0) { console.error(`could not stage run-tracker.sh in ${run}`); process.exit(1); }
  }

  // The sha256 of the tracker binary both trackers run, computed in WSL (where the binary is), never taken from the
  // environment: circulating credit takes effect only when it is pinned. Unknown: empty (circulation stays off).
  const hashed = spawnSync(WSL, [...D, '--exec', '/usr/bin/sha256sum', `${BINS}/basis_server`], {encoding: 'utf8'});
  const TRACKER_SHA256 = trackerSha256(hashed);
  console.log(`[start-local] ${BINS}/basis_server sha256 ${TRACKER_SHA256 || `unknown (${(hashed.stderr || hashed.error?.message || '').trim().slice(0, 200)})`}`);

  const nfts = {}, trackers = {};
  let app, stopping = false;
  function startTracker(name, env) {
    const t = spawn(WSL, trackerArgv(RUNS[name], BINS, env), {stdio: ['ignore', 'pipe', 'inherit']});
    t.stdout.on('data', d => {
      const s = d.toString(); process.stdout.write(`[${name} tracker] ${s}`);
      const m = /TRACKER_NFT_ID=([0-9a-f]{64})/.exec(s);
      if (m && !nfts[name]) { nfts[name] = m[1]; if (nfts.demo && nfts.pilot) startApp(); }
    });
    t.on('exit', c => { console.log(`[${name} tracker] exited ${c}`); stop(); process.exit(c ?? 1); });
    trackers[name] = t;
  }
  function startApp() {
    fs.writeFileSync(path.join(dataDir, 'tracker-nft-id'), nfts.demo);
    app = spawn(process.execPath, [path.join(root, 'server.mjs')], {stdio: 'inherit',
      env: appEnv(process.env, {ports: PORTS, bins: BINS, nfts, dataDir, pilotDir, sha256: TRACKER_SHA256})});
    app.on('exit', c => { console.log(`[app] exited ${c}`); stop(); });
  }
  function stop() {
    if (stopping) return; stopping = true;
    app?.kill();
    for (const run of Object.values(RUNS)) spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', '[ -s "$1/tracker.pid" ] && kill "$(cat "$1/tracker.pid")" 2>/dev/null; rm -f "$1/tracker.pid"', 'sh', run]);
    for (const t of Object.values(trackers)) t.kill();
  }
  startTracker('demo', [`BASIS_PORT=${PORTS.demo}`]);
  startTracker('pilot', [`BASIS_PORT=${PORTS.pilot}`, `BASIS_SERVED_TOKEN_ID=${PILOT_TOKEN_ID}`, 'BASIS_SERVED_TOKEN_SYMBOL=PC']);
  process.on('SIGINT', () => { stop(); process.exit(0); }); process.on('SIGTERM', () => { stop(); process.exit(0); });
}
// node 24.2 and later set import.meta.main; before that, the entry point is the file node was given.
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) main();
