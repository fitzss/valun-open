// Local development on the Windows dev machine: the Basis binaries are Linux builds, so the trackers and the signer run in
// the WSL distro valun-ic1 (as user valun, in /home/valun only); the Valun app runs on Windows, as two processes.
// Two trackers, both on WSL loopback (reachable from Windows loopback through WSL's localhost forwarding):
//   demo  127.0.0.1:3048  /home/valun/valun-app-local          (public demo, ERG-denominated, synthetic)
//   pilot 127.0.0.1:3058  /home/valun/valun-pilot-local         (valun-pilot-1, PC token, synthetic)
// and two apps (server.mjs), both on 127.0.0.1:
//   the network  :4320 (PORT): valun-pilot-1 on the pilot tracker, as a local server (VALUN_ENVIRONMENT=local, as the
//                local image runs it): its pages, /skill.md, /llms.txt and A2A answer name only http://127.0.0.1:4320, and
//                every command there runs in the client profile local and names it. A local server builds no desk, so
//                its /api and /mcp answer 404. Before (fix inbox #155: the local-readiness audit, FB-4), one app ran
//                both, not as a local server: its docs were the public network's, and their joins reached valun.tech;
//   the desk     :4321 (VALUN_DESK_PORT; PORT + 1 by default): the legacy synthetic desk alone on the demo tracker
//                (/ is its console, /api, /mcp). Its pages and agent docs are the public network's, and it says so at
//                start (lib/environment.mjs publicDocsWarning). It runs no network.
// Usage: node scripts/start-local.mjs   (npm run local; Ctrl+C stops everything, and so does either app's exit)
//   VALUN_BINS=<WSL folder with basis_server and examples/valun_signer> picks the binaries (default: the Basis 3df7ed93
//   build); PILOT_CIRCULATION=off|bound|sandbox|on asks for circulating credit, which takes effect only on a tracker whose
//   binary's sha256 is pinned (lib/pilot/pins.mjs): this script computes that sha256 in WSL and passes it to the apps as
//   PILOT_TRACKER_SHA256, as the container entrypoint does. The network's other settings (PILOT_OPEN_SANDBOX and the
//   rest) come from this environment; the desk gets none of them. From Git Bash, set MSYS2_ENV_CONV_EXCL=VALUN_ so that
//   a VALUN_BINS of /home/... reaches this script unchanged.
// Importing this file starts nothing: it exports the pure parts (trackerSha256, trackerArgv, localPorts, appEnv,
// deskEnv) for test/operations.test.mjs and test/start-local-env.unit.test.mjs, and runs only as the entry point (node
// scripts/start-local.mjs).
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
// The ports: the network's app (PORT, 4320 by default), the desk's (VALUN_DESK_PORT, by default the one after it) and
// the two trackers'. Several local stacks can run side by side with ports of their own.
export function localPorts(env) {
  const app = env.PORT || '4320';
  return {app, desk: env.VALUN_DESK_PORT || String(Number(app) + 1), demo: env.VALUN_DEMO_TRACKER_PORT || '3048', pilot: env.VALUN_PILOT_TRACKER_PORT || '3058'};
}
const without = (env, drop) => Object.fromEntries(Object.entries(env).filter(([k]) => !drop(k)));
// The network's environment: this process's, under the launcher's own values, as a local server (VALUN_ENVIRONMENT=local:
// fix inbox #155, FB-4), and without the demo tracker's settings (a local server builds no desk). PILOT_TRACKER_SHA256 is
// always the hash this script computed (trackerSha256), never one from the environment: circulating credit takes effect
// only when it is pinned.
export function appEnv(env, {ports, bins, nfts, dataDir, pilotDir, sha256}) {
  return {...without(env, k => k === 'BASIS_TRACKER_URL' || k === 'BASIS_TRACKER_NFT_ID'),
    PORT: ports.app, BASIS_RUNNER: 'wsl', BASIS_SIGNER: `${bins}/examples/valun_signer`, VALUN_DATA_DIR: dataDir, VALUN_DEPLOYMENT: 'local',
    VALUN_ENVIRONMENT: 'local',
    PILOT_TRACKER_URL: `http://127.0.0.1:${ports.pilot}`, PILOT_TRACKER_NFT_ID: nfts.pilot, PILOT_DATA_DIR: pilotDir, PILOT_TRACKER_SHA256: sha256};
}
// The legacy desk's environment: this process's without the network's settings (no PILOT_ setting, so it runs no
// network on the pilot tracker beside the other app, and neither VALUN_ENVIRONMENT, which would refuse a desk, nor
// VALUN_PUBLIC_ORIGIN, which may be the network's local origin), under the launcher's own values: the desk alone on the
// demo tracker. Its /api/status names that tracker's binary by the same computed sha256, as before: both trackers run
// the same binary.
export function deskEnv(env, {ports, bins, nfts, dataDir, sha256}) {
  return {...without(env, k => k.startsWith('PILOT_') || k === 'VALUN_ENVIRONMENT' || k === 'VALUN_PUBLIC_ORIGIN'),
    PORT: ports.desk, BASIS_RUNNER: 'wsl', BASIS_SIGNER: `${bins}/examples/valun_signer`, BASIS_TRACKER_URL: `http://127.0.0.1:${ports.demo}`,
    BASIS_TRACKER_NFT_ID: nfts.demo, VALUN_DATA_DIR: dataDir, VALUN_DEPLOYMENT: 'local', PILOT_TRACKER_SHA256: sha256};
}

function main() {
  const BINS = process.env.VALUN_BINS || '/home/valun/valun-app-bins-20261105T024815Z/t/release';
  // Several local stacks can run side by side: VALUN_LOCAL_SUFFIX names separate folders, the *_PORT variables separate ports.
  const SUFFIX = process.env.VALUN_LOCAL_SUFFIX ? `-${process.env.VALUN_LOCAL_SUFFIX}` : '';
  const PORTS = localPorts(process.env);
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

  const nfts = {}, trackers = {}, apps = {};
  let stopping = false;
  function startTracker(name, env) {
    const t = spawn(WSL, trackerArgv(RUNS[name], BINS, env), {stdio: ['ignore', 'pipe', 'inherit']});
    t.stdout.on('data', d => {
      const s = d.toString(); process.stdout.write(`[${name} tracker] ${s}`);
      const m = /TRACKER_NFT_ID=([0-9a-f]{64})/.exec(s);
      if (m && !nfts[name]) { nfts[name] = m[1]; if (nfts.demo && nfts.pilot) startApps(); }
    });
    t.on('exit', c => { console.log(`[${name} tracker] exited ${c}`); stop(); process.exit(c ?? 1); });
    trackers[name] = t;
  }
  // The two apps, once both trackers have their ids: the network as a local server, and the legacy desk alone. When
  // either exits, everything stops.
  function startApps() {
    fs.writeFileSync(path.join(dataDir, 'tracker-nft-id'), nfts.demo);
    const opts = {ports: PORTS, bins: BINS, nfts, dataDir, pilotDir, sha256: TRACKER_SHA256};
    console.log(`[start-local] the network, valun-pilot-1 as a local server (VALUN_ENVIRONMENT=local), on port ${PORTS.app}: agents start at its /skill.md; `
      + `the legacy demo desk alone on port ${PORTS.desk}: its pages and agent docs are the public network's`);
    for (const [name, env] of [['network', appEnv(process.env, opts)], ['desk', deskEnv(process.env, opts)]]) {
      apps[name] = spawn(process.execPath, [path.join(root, 'server.mjs')], {stdio: 'inherit', env});
      apps[name].on('exit', c => { console.log(`[${name}] exited ${c}`); stop(); });
    }
  }
  function stop() {
    if (stopping) return; stopping = true;
    for (const a of Object.values(apps)) a.kill();
    for (const run of Object.values(RUNS)) spawnSync(WSL, [...D, '--exec', '/bin/sh', '-c', '[ -s "$1/tracker.pid" ] && kill "$(cat "$1/tracker.pid")" 2>/dev/null; rm -f "$1/tracker.pid"', 'sh', run]);
    for (const t of Object.values(trackers)) t.kill();
  }
  startTracker('demo', [`BASIS_PORT=${PORTS.demo}`]);
  startTracker('pilot', [`BASIS_PORT=${PORTS.pilot}`, `BASIS_SERVED_TOKEN_ID=${PILOT_TOKEN_ID}`, 'BASIS_SERVED_TOKEN_SYMBOL=PC']);
  process.on('SIGINT', () => { stop(); process.exit(0); }); process.on('SIGTERM', () => { stop(); process.exit(0); });
}
// node 24.2 and later set import.meta.main; before that, the entry point is the file node was given.
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) main();
