// Rehearse the container start in WSL valun-ic1 (Linux, BASIS_RUNNER=direct), without Docker:
// stages the same files the Dockerfile copies into /home/valun/valun-app-ctest-<UTC>/opt (= /opt/valun) and
// .../data (= /data), runs the Linux test suite there, then starts the entrypoint on PORT (default 8090).
// At the end the staging folder is removed (after the tests with --tests-only, else once the entrypoint exits);
// --keep keeps it. With --tests-only the exit code is the test run's (0: every test passed or skipped).
// Usage: node scripts/rehearse-container.mjs [--tests-only] [--keep]
// The entrypoint also gets PILOT_CIRCULATION, PILOT_OPEN_SANDBOX and NODE_OPTIONS when they are set here (PASS_ENV).
// Importing this file starts nothing (test/operations.test.mjs reads its lists).
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WSL = 'C:/Windows/System32/wsl.exe', D = ['-d', 'valun-ic1', '-u', 'valun'];
const NODE_DIR = '/opt/valun-ic1/node-v24.21.0-linux-x64/bin';

// The app files the Dockerfile copies into /opt/valun/app (test/operations.test.mjs checks this list against the
// Dockerfile's COPY lines), plus scripts/run-tests.mjs: the test list that npm test runs too (the rehearsal runs the
// tests; the image does not need it). They go to WSL as a tar stream (WSL has no access to C:).
export const APP_FILES = Object.freeze(['package.json', 'server.mjs', 'lib', 'public', 'test', 'basis/run-tracker.sh',
  'scripts/check-persistence.mjs', 'scripts/check-exposure.mjs', 'scripts/valun-mcp-stdio.mjs', 'scripts/pilot-admin.mjs',
  'scripts/pilot-downgrade-check.mjs', 'scripts/run-tests.mjs']);
// The files the Dockerfile copies outside the app folder, at the image's places: [source, path under /opt/valun, mode].
export const IMAGE_FILES = Object.freeze([['dist/bin/basis_server', 'bin/basis_server', 755], ['dist/bin/valun_signer', 'bin/valun_signer', 755],
  ['basis/run-tracker.sh', 'run-tracker.sh', 755], ['scripts/docker-entrypoint.sh', 'docker-entrypoint.sh', 755]]);
// The image's marker (the Dockerfile's ENV): this app folder holds only the image's files, so a test that needs another
// file of the repository is skipped there (test/operations.test.mjs needs()); anywhere else such a file is required.
export const APP_COPY_MARKER = 'VALUN_APP_COPY=image';
// Staging folders are only ever /home/valun/valun-app-ctest-<UTC time>.
export const STAGING_RE = /^\/home\/valun\/valun-app-ctest-\d{8}T\d{6}Z$/;

export const parseArgs = argv => ({testsOnly: argv.includes('--tests-only'), keep: argv.includes('--keep')});

// Settings the entrypoint gets from this script's environment, each only when it is set there (none is by default, so a
// plain rehearsal starts the app as before): the circulating-credit mode, the self-serve sandbox switch and NODE_OPTIONS
// (fly.toml's [env] sets PILOT_OPEN_SANDBOX=1 and NODE_OPTIONS=--max-old-space-size=128), so the sandbox tour can run
// against the rehearsal and its memory can be measured under the image's heap limit. PILOT_TRACKER_SHA256 is never
// passed: the entrypoint computes it from the staged binary.
export const PASS_ENV = Object.freeze(['PILOT_CIRCULATION', 'PILOT_OPEN_SANDBOX', 'NODE_OPTIONS']);
export const passEnv = env => PASS_ENV.filter(k => typeof env[k] === 'string' && env[k] !== '').map(k => `${k}=${env[k]}`);

// The end of a rehearsal: removes the staging folder T (only a folder STAGING_RE names), unless `keep`. `sh(cmd)` runs a
// bash command in WSL with T as $1 and returns spawnSync's result. Returns what it did, for the log line.
export function finish(T, {keep, sh}) {
  if (keep) return `kept ${T}`;
  if (!STAGING_RE.test(T)) throw Error(`refusing to remove ${T}: not a staging folder of this script`);
  const r = sh('rm -rf -- "$1"');
  if (r.status !== 0) return `could not remove ${T} (remove it by hand): ${String(r.stderr || '').trim()}`;
  return `removed ${T}`;
}

function main() {
  const {testsOnly, keep} = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const T = `/home/valun/valun-app-ctest-${stamp}`, OPT = `${T}/opt`, DATA = `${T}/data`;
  const port = process.env.PORT || '8090';
  const sh = (cmd, input) => spawnSync(WSL, [...D, '--exec', '/bin/bash', '-c', cmd, 'bash', T, OPT, DATA], {input, maxBuffer: 1 << 28});
  const end = code => { console.log(finish(T, {keep, sh})); process.exit(code); };
  try {
    const tar = spawnSync('tar', ['-cf', '-', ...APP_FILES], {cwd: root, maxBuffer: 1 << 28});
    if (tar.status !== 0) throw Error(`tar failed: ${String(tar.stderr || '').trim()}`);
    let r = sh('mkdir -p "$2/app" "$2/bin" "$3" && tar -xf - -C "$2/app"', tar.stdout);
    if (r.status !== 0) throw Error(`stage app: ${r.stderr}`);
    for (const [src, dst, mode] of IMAGE_FILES) {
      r = sh(`cat > "$2/${dst}" && chmod ${mode} "$2/${dst}"`, fs.readFileSync(path.join(root, src)));
      if (r.status !== 0) throw Error(`stage ${src}: ${r.stderr}`);
    }
    console.log(`staged ${T}`);

    const env = `PATH=${NODE_DIR}:/usr/bin:/bin HOME=${T} TMPDIR=${T} BASIS_RUNNER=direct VALUN_BINS=${OPT}/bin ${APP_COPY_MARKER}`;
    const filter = process.env.FULL ? 'cat' : "grep -E '^(✔|✖|ℹ (pass|fail))'";
    r = spawnSync(WSL, [...D, '--cd', `${OPT}/app`, '--exec', '/bin/bash', '-c',
      `env -i ${env} node scripts/run-tests.mjs --test-concurrency=1 2>&1 | ${filter}; exit "\${PIPESTATUS[0]}"`], {encoding: 'utf8', maxBuffer: 1 << 28});
    console.log(r.stdout);
    if (testsOnly) { console.log(`test run exit code ${r.status}`); end(r.status ?? 1); return; }
  } catch (e) {
    console.error(`rehearsal failed: ${e.message}`);
    end(1); return;
  }

  const app = spawn(WSL, [...D, '--exec', '/usr/bin/env', '-i', `PATH=${NODE_DIR}:/usr/bin:/bin`, `HOME=${T}`, 'HOST=127.0.0.1', `PORT=${port}`,
    'BASIS_TRACKER_URL=http://127.0.0.1:3050', 'VALUN_DEPLOYMENT=hosted', 'BASIS_PORT=3050', 'PILOT_BASIS_PORT=3060', `VALUN_ROOT=${OPT}`, `VALUN_DATA=${DATA}`, APP_COPY_MARKER,
    ...(process.env.VALUN_WRITE_TOKEN ? [`VALUN_WRITE_TOKEN=${process.env.VALUN_WRITE_TOKEN}`] : []), ...passEnv(process.env),
    `${OPT}/docker-entrypoint.sh`], {stdio: 'inherit'});
  app.on('exit', c => end(c ?? 1));
  process.on('SIGINT', () => app.kill());
}

// node 24.2 and later set import.meta.main; before that, the entry point is the file node was given.
if (import.meta.main ?? (!!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) main();
