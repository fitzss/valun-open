// A local server (fix inbox #143): VALUN_ENVIRONMENT=local, a copy of Valun someone runs on their own machine with no
// chain (Dockerfile.local, scripts/local-entrypoint.sh). It runs only the network with no chain (valun-pilot-1), says
// "local: no chain" in GET /pilot/v1/info (environment, environment_note) and at the top of every HTML page (a banner
// naming the server and the public network), serves its landing at /, names itself in its links (PUBLIC_ORIGIN: by
// default http://127.0.0.1:<PORT>), and begins skill.md, agents.md and llms.txt with how to point a client at it.
// Everything else is the pilot network's, byte for byte. The settings are read once, at start, so each runs in a child
// process (test/fixtures/staging-pages.mjs, as the staging banner's test does). Then the image's definition: what
// Dockerfile.local copies and admits, and scripts/local-entrypoint.sh over a fake image (fake tracker and app, as
// test/entrypoint.test.mjs does). No tracker; the image's own copy of the app skips what it does not hold.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://127.0.0.1:8080';
// The banner, word for word, as a server on port 8080 shows it: fixed text, its origin and the link to the network.
const BANNER = '<link rel="stylesheet" href="/local.css"><p class="valun-local">Local: no chain. A copy of Valun running on this '
  + 'machine, not the public network: nothing here is anchored on a chain or redeemable, and its credits have no monetary '
  + 'value. The text of these pages describes the public network at <a href="https://valun.tech">https://valun.tech</a>; to '
  + `use this server, point your client at it: <code>valun config server ${ORIGIN}</code></p>`;
const NOTE = 'local: no chain. A copy of Valun running on the machine you reach it on, not the public network: its Basis '
  + 'tracker has no blockchain connection, so nothing here is anchored on a chain, redeemed or backed by a reserve, and its '
  + 'credits have no monetary value. Its participants, notes and loops exist only on this server. The public network is at '
  + 'https://valun.tech.';
const bytes = b64 => Buffer.from(b64, 'base64'), text = b64 => bytes(b64).toString('utf8');
const named = p => `${p.host ?? ''}${p.route} (${p.pilot ? 'with' : 'without'} a pilot)`;
// bash (Git for Windows on Windows, /bin/bash elsewhere) for the scripts; paths as bash takes them.
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const posix = p => p.replace(/\\/g, '/');
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k) && k !== 'PORT'));

// The pages fixture in a process of its own, on the pilot network, with VALUN_ENVIRONMENT set to `value` (undefined:
// unset) and PORT 8080, as the image runs.
function serve(value) {
  const env = {...clean(), PORT: '8080', ...(value !== undefined ? {VALUN_ENVIRONMENT: value} : {})};
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'staging-pages.mjs')], {cwd: root, env});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`staging-pages.mjs exited ${code}: ${err}`))));
  });
}
// What importing lib/pilot/units.mjs gives with `env` (on top of a clean environment): {ok, origin} or {ok: false, error}.
function units(env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "try { const u = await import('./lib/pilot/units.mjs'); console.log(JSON.stringify({ok: true, network: u.NETWORK, origin: u.PUBLIC_ORIGIN})); } "
    + 'catch (e) { console.log(JSON.stringify({ok: false, error: e.message})); }'], {cwd: root, env: {...clean(), ...env}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
// As in test/operations.test.mjs: a missing file skips the test in the image's copy (VALUN_APP_COPY=image), else fails it.
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}

let runs;
before(async () => {
  const [local, pilot] = await Promise.all([serve('local'), serve(undefined)]);
  runs = {local, pilot};
});

test('VALUN_ENVIRONMENT: the exact value "local" makes a local server; its banner and note, word for word', async () => {
  const saved = process.env.VALUN_ENVIRONMENT;
  const load = (v, tag) => {
    if (v === undefined) delete process.env.VALUN_ENVIRONMENT; else process.env.VALUN_ENVIRONMENT = v;
    return import(`../lib/environment.mjs?local-${tag}`);
  };
  try {
    const on = await load('local', 'on');
    assert.deepEqual([on.ENVIRONMENT, on.LOCAL, on.STAGING], ['local', true, false]);
    assert.equal(on.localBanner(ORIGIN), BANNER);
    assert.equal(on.LOCAL_NOTE, NOTE);
    assert.ok(!BANNER.includes('\n'), 'one line');
    assert.doesNotMatch(BANNER, /<style\b|<script\b|\sstyle=|\son[a-z]+=|javascript:/i, 'no inline style or script (the CSP allows none)');
    assert.match(on.localBanner('http://x"<y>&'), /valun config server http:\/\/x&quot;&lt;y&gt;&amp;<\/code>/, 'the origin is escaped');
    for (const [i, v] of [undefined, '', 'Local', 'LOCAL', ' local', 'local ', 'local\n', 'localhost', 'locale'].entries()) {
      const off = await load(v, `off-${i}`);
      assert.deepEqual([off.ENVIRONMENT, off.LOCAL], [null, false], JSON.stringify(v));
    }
    // withBanner puts a banner right after <body>; with none, or no <body>, the page comes back as it was.
    const page = '<!doctype html><html><head></head><body class="x"><main>ok</main></body></html>';
    assert.equal(on.withBanner(page, BANNER), page.replace('<body class="x">', `<body class="x">\n${BANNER}`));
    const buf = Buffer.from(page);
    assert.equal(on.withBanner(buf, null), buf);
    assert.equal(on.withBanner('<p>no body', BANNER), '<p>no body');
    assert.equal(on.withStagingBanner(page), page, 'the staging banner only on staging');
  } finally {
    if (saved === undefined) delete process.env.VALUN_ENVIRONMENT; else process.env.VALUN_ENVIRONMENT = saved;
  }
});

test('a local server runs only the network with no chain, and its links name itself (http on loopback allowed there only)', () => {
  assert.deepEqual(units({VALUN_ENVIRONMENT: 'local', PORT: '8080'}), {ok: true, network: 'valun-pilot-1', origin: ORIGIN});
  assert.deepEqual(units({VALUN_ENVIRONMENT: 'local'}), {ok: true, network: 'valun-pilot-1', origin: 'http://127.0.0.1:4320'}, 'the server\'s default port');
  assert.deepEqual(units({VALUN_ENVIRONMENT: 'local', PILOT_NETWORK: 'valun-pilot-1', PORT: 'abc'}).origin, 'http://127.0.0.1:4320');
  const testnet = units({VALUN_ENVIRONMENT: 'local', PILOT_NETWORK: 'valun-testnet-1'});
  assert.equal(testnet.ok, false);
  assert.equal(testnet.error, 'VALUN_ENVIRONMENT=local runs a network with no chain (valun-pilot-1), not valun-testnet-1, which needs its tracker on ergo-testnet');
  for (const o of ['http://localhost:9000', 'http://[::1]:9000', 'http://127.0.0.1:9000', 'http://127.0.0.1', 'https://valun.example'])
    assert.deepEqual(units({VALUN_ENVIRONMENT: 'local', PORT: '8080', VALUN_PUBLIC_ORIGIN: o}), {ok: true, network: 'valun-pilot-1', origin: o}, o);
  for (const o of ['http://192.168.1.5:8080', 'http://127.0.0.1:8080/', 'http://127.0.0.1:8080/x', 'http://localhost.evil:80', 'ftp://127.0.0.1:21', 'http://127.0.0.1:123456']) {
    const r = units({VALUN_ENVIRONMENT: 'local', VALUN_PUBLIC_ORIGIN: o});
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.match(r.error, /^VALUN_PUBLIC_ORIGIN must be an https origin with no path, or http:\/\/127\.0\.0\.1, http:\/\/localhost or http:\/\/\[::1\] with a port, not /);
  }
  // Elsewhere nothing changes: https only, and the network's own origin by default.
  assert.deepEqual(units({PORT: '8080'}), {ok: true, network: 'valun-pilot-1', origin: 'https://valun.tech'});
  assert.deepEqual(units({PILOT_NETWORK: 'valun-testnet-1', VALUN_ENVIRONMENT: 'staging'}).origin, 'https://valun-testnet.fly.dev');
  const http = units({VALUN_PUBLIC_ORIGIN: ORIGIN});
  assert.equal(http.ok, false);
  assert.equal(http.error, `VALUN_PUBLIC_ORIGIN must be an https origin with no path, not '${ORIGIN}'`);
});

test('local: GET /pilot/v1/info says environment "local" and what it means, after the network; nothing else in it changes', () => {
  const {environment, info} = runs.local;
  assert.equal(environment, 'local');
  assert.deepEqual(Object.keys(info).slice(0, 3), ['network', 'environment', 'environment_note']);
  assert.deepEqual([info.network, info.environment, info.environment_note, info.tracker_on_chain], ['valun-pilot-1', 'local', NOTE, false]);
  assert.ok(!Object.hasOwn(info, 'chain'), 'no chain');
  const {environment: _, environment_note: __, ...rest} = info;
  assert.deepEqual(rest, runs.pilot.info, 'the pilot network\'s /info');
  assert.equal(runs.pilot.environment, null);
  assert.ok(!Object.hasOwn(runs.pilot.info, 'environment') && !Object.hasOwn(runs.pilot.info, 'environment_note'), 'unset: neither');
});

test('local: every HTML page opens with the banner; / is the landing; the rendered pages\' links name this server; nothing else changes', () => {
  const {pages} = runs.local;
  assert.equal(pages.length, runs.pilot.pages.length);
  pages.forEach((p, i) => {
    const q = runs.pilot.pages[i];
    assert.match(p.type, /^text\/html/, named(p));
    assert.deepEqual([p.status, p.type, p.csp], [q.status, q.type, q.csp], `${named(p)}: the pilot's status and headers`);
    const page = text(p.page), open = /<body\b[^>]*>/i.exec(page);
    assert.ok(open, `${named(p)}: has a <body> tag`);
    const at = open.index + open[0].length;
    assert.equal(text(p.body), `${page.slice(0, at)}\n${BANNER}${page.slice(at)}`, `${named(p)}: the page with the banner right after <body>`);
    // Unset, the page itself: the same bytes, no banner.
    assert.ok(bytes(q.body).equals(bytes(q.page)), `${named(q)}: unset, the page itself`);
    assert.doesNotMatch(text(q.body), /valun-local|\/local\.css/, `${named(q)}: unset, no banner`);
  });
  // No desk here: / is the landing (public/home.html), as on valun.tech; unset, the desk console.
  const home = fs.readFileSync(path.join(root, 'public', 'home.html'));
  assert.ok(bytes(pages.find(p => p.route === '/' && !p.host).page).equals(home));
  assert.equal(runs.pilot.pages.find(p => p.route === '/' && !p.host).file, 'index.html');
  // The loop card and the agent page send a person to this server's /start, never to the public network's landing.
  for (const route of ['/loop/vs_00000000000000aa', '/agent/open-poet']) {
    const body = text(pages.find(p => p.route === route && p.pilot).body), unset = text(runs.pilot.pages.find(p => p.route === route && p.pilot).body);
    assert.ok(body.includes(`href="${ORIGIN}/start`), `${route}: links this server's /start`);
    assert.doesNotMatch(body, /href="https:\/\/valun\.tech\/#/, `${route}: not the public landing`);
    assert.ok(unset.includes('href="https://valun.tech/'), `${route}: unset, the pilot's links as before`);
  }
  // The banner's stylesheet, from 'self' as the CSP wants, on a local server only; never staging's there.
  const css = fs.readFileSync(path.join(root, 'public', 'local.css'));
  assert.deepEqual([runs.local.localCss.status, runs.local.localCss.type], [200, 'text/css; charset=utf-8']);
  assert.ok(bytes(runs.local.localCss.body).equals(css));
  assert.doesNotMatch(css.toString('utf8'), /position\s*:\s*(fixed|absolute|sticky)|url\(|@import/i);
  assert.equal(runs.local.css.status, 404, 'no /staging.css on a local server');
  assert.equal(runs.pilot.localCss.status, 404, 'no /local.css elsewhere');
});

test('local: skill.md and agents.md (after their front matter) and llms.txt (after its title) begin with how to point a client at this server', () => {
  const preface = `> **A local Valun server, with no chain.** This file is served by a copy of Valun running at ${ORIGIN}, not by the `
    + 'public network: its tracker has no blockchain connection, so nothing here is anchored on a chain or redeemable, and '
    + `its credits have no monetary value.\n> Point your Valun client at this server before anything below: \`valun config server ${ORIGIN}\` `
    + `(or add \`--server ${ORIGIN}\` to \`valun join\`). Without that, the commands below reach the public network at `
    + 'https://valun.tech, which the links below name too.\n';
  const file = f => fs.readFileSync(path.join(root, 'public', f), 'utf8');
  const of = (run, route) => run.files.find(f => f.route === route);
  for (const route of ['/skill.md', '/agents.md']) {
    const skill = file('skill.md'), front = /^---\n[\s\S]*?\n---\n/.exec(skill)[0];
    const got = of(runs.local, route);
    assert.deepEqual([got.status, got.type], [200, 'text/markdown; charset=utf-8'], route);
    assert.equal(text(got.body), `${front}\n${preface}${skill.slice(front.length)}`, `${route}: the front matter first, then the note`);
    assert.equal(text(of(runs.pilot, route).body), skill, `${route}: unset, the file as it is`);
  }
  const llms = file('llms.txt'), title = llms.slice(0, llms.indexOf('\n') + 1);
  assert.equal(title, '# Valun\n');
  assert.equal(text(of(runs.local, '/llms.txt').body), `${title}\n${preface}${llms.slice(title.length)}`);
  assert.equal(text(of(runs.pilot, '/llms.txt').body), llms);
});

test('local: the chain reads (GET /chain, /reserves, /ledger/committed) answer 404 no_chain with what that means; elsewhere on the pilot network they are not routes', () => {
  for (const route of ['/pilot/v1/chain', '/pilot/v1/reserves', '/pilot/v1/ledger/committed']) {
    const got = runs.local.files.find(f => f.route === route);
    assert.equal(got.status, 404, route);
    assert.deepEqual(JSON.parse(text(got.body)), {error: 'no_chain', message: `${NOTE} There is no chain view, no reserve and no committed ledger here.`}, route);
    // Unset, they fall through to the authenticated routes as before (the fixture's pilot authenticates nobody).
    const unset = runs.pilot.files.find(f => f.route === route);
    assert.notEqual(JSON.parse(text(unset.body)).error, 'no_chain', `${route}: unset, not this answer`);
  }
});

// ---------- the image's definition ----------
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('Dockerfile.local: node 24 on Debian trixie; the tracker binaries per platform; the app\'s files; local settings; a non-root user; data in a volume', t => {
  if (!needs(t, 'Dockerfile.local', 'Dockerfile.local.dockerignore', 'scripts/local-entrypoint.sh')) return;
  const docker = read('Dockerfile.local').replace(/\\\r?\n/g, ' ');
  const lines = docker.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(lines[0], 'FROM node:24-trixie-slim');
  assert.ok(lines.includes('ARG TARGETARCH'), 'buildx names the platform');
  // COPY sources and destinations.
  const copies = lines.filter(l => l.startsWith('COPY ')).map(l => l.split(/\s+/).slice(1).filter(w => !w.startsWith('--')));
  const sources = copies.flatMap(c => c.slice(0, -1));
  assert.deepEqual(copies.map(c => c.at(-1)), ['/opt/valun/bin/', '/opt/valun/', '/opt/valun/app/', '/opt/valun/app/lib', '/opt/valun/app/public', '/opt/valun/app/scripts/']);
  assert.deepEqual(sources, ['dist/local-bins/${TARGETARCH}/basis_server', 'dist/local-bins/${TARGETARCH}/valun_signer', 'basis/run-tracker.sh',
    'scripts/local-entrypoint.sh', 'package.json', 'server.mjs', 'lib', 'public', 'scripts/pilot-admin.mjs']);
  for (const f of sources.filter(s => !s.startsWith('dist/'))) assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
  assert.doesNotMatch(lines.join('\n'), /docker-entrypoint|run-tracker-testnet|ergo\/|COPY test|wallet-shim/, 'no chain pieces, no tests, not the hosted entrypoint');
  assert.match(lines.find(l => l.startsWith('COPY ') && l.includes('basis_server')), /^COPY --chmod=0755 /);
  assert.match(lines.find(l => l.startsWith('COPY ') && l.includes('local-entrypoint.sh')), /^COPY --chmod=0755 /);
  // The settings: the local mode on the network with no chain, self-serve joins, the open network and circulation.
  const envLine = lines.find(l => l.startsWith('ENV '));
  const env = Object.fromEntries(envLine.slice(4).trim().split(/\s+/).map(kv => kv.split('=')));
  for (const [k, v] of Object.entries({NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '8080', VALUN_ENVIRONMENT: 'local', PILOT_NETWORK: 'valun-pilot-1',
    PILOT_OPEN_SANDBOX: '1', PILOT_OPEN_NETWORK: '1', PILOT_CIRCULATION: 'on', PILOT_DATA_DIR: '/data/pilot'})) assert.equal(env[k], v, k);
  assert.ok(!Object.hasOwn(env, 'PILOT_TRACKER_SHA256'), 'the sha256 is computed at start, never set in the image');
  // Non-root: the user made with uid and gid 10001, which owns /data; the data in a volume; the app's port; the entrypoint.
  assert.match(docker, /groupadd --system --gid 10001 valun/);
  assert.match(docker, /useradd --system --uid 10001 --gid valun /);
  assert.match(docker, /chown valun:valun \/data/);
  assert.ok(lines.includes('USER 10001:10001'));
  assert.ok(lines.indexOf('USER 10001:10001') > lines.findLastIndex(l => l.startsWith('RUN ')), 'no RUN after USER');
  assert.ok(lines.includes('VOLUME /data'));
  assert.ok(lines.includes('EXPOSE 8080'));
  assert.equal(lines.at(-1), 'ENTRYPOINT ["/opt/valun/local-entrypoint.sh"]');
  assert.match(docker, /HEALTHCHECK [^\n]*\/pilot\/v1\/health/);
  // The build context admits exactly what the Dockerfile copies (both platforms' binaries) and the Dockerfile.
  const admitted = read('Dockerfile.local.dockerignore').split(/\r?\n/).filter(l => l.trim());
  assert.equal(admitted[0], '*', 'everything else is left out');
  const want = ['Dockerfile.local', ...sources.filter(s => !s.startsWith('dist/')).map(s => (['lib', 'public'].includes(s) ? `${s}/**` : s)),
    ...['amd64', 'arm64'].flatMap(a => [`dist/local-bins/${a}/basis_server`, `dist/local-bins/${a}/valun_signer`])];
  assert.deepEqual(admitted.slice(1).map(l => l.replace(/^!/, '')).sort(), want.sort());
});

test('scripts/local-acceptance.sh: the released client, a fresh home, the issue\'s steps, the set-off read from the API, no secret printed', t => {
  if (!needs(t, 'scripts/local-acceptance.sh')) return;
  const s = read('scripts/local-acceptance.sh');
  assert.match(s, /^#!\/bin\/bash\n/);
  assert.match(s, /CLIENT=\$\{VALUN_CLIENT:-valun==0\.7\.1\}/);
  assert.match(s, /URL=\$\{1:-\$\{VALUN_URL:-http:\/\/127\.0\.0\.1:8080\}\}/);
  assert.match(s, /VALUN_HOME=\$\(mktemp -d\)/);
  assert.match(s, /uvx --from "\$CLIENT" valun config server "\$URL"/);
  assert.match(s, /uvx --from "\$CLIENT" valun join --sandbox --handle "\$HANDLE" --operator "local acceptance" --owner-token-file "\$VALUN_HOME\/owner-token\.txt"/);
  assert.match(s, /timeout "\$TOUR_S" uvx --from "\$CLIENT" valun sandbox tour --yes/);
  assert.match(s, /curl -fsS -m 10 "\$URL\/pilot\/v1\/loops"/);
  assert.match(s, /j\.get\("environment"\) == "local" and j\.get\("network"\) == "valun-pilot-1"/);
  assert.match(s, /"circulation\/1" in/);
  assert.doesNotMatch(s, /cat [^\n]*owner-token|owner_token/, 'the owner token is never printed');
  if (process.platform !== 'win32' || fs.existsSync(BASH)) {
    const r = spawnSync(BASH, ['-n', posix(path.join(root, 'scripts', 'local-acceptance.sh'))], {encoding: 'utf8'});
    assert.equal(r.status, 0, `bash -n: ${r.stderr}`);
  }
});

// ---------- scripts/local-entrypoint.sh over a fake image ----------
const made = [], children = [], cleanups = [];
after(() => {
  for (const f of cleanups) { try { f(); } catch { /* best effort */ } }
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
  for (const d of made) fs.rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'valun-local-entry-')); made.push(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out after ${ms} ms: ${what}`);
    await sleep(100);
  }
}
function canRun(t) {
  if (!needs(t, 'scripts/local-entrypoint.sh')) return false;
  if (!fs.existsSync(BASH)) { t.skip(`needs ${BASH}`); return false; }
  if (process.getuid?.() === 0) { t.skip('run as root, the entrypoint switches to the image\'s valun user, which this machine does not have'); return false; }
  return true;
}
// A fake tracker, called as basis/run-tracker.sh is (RUN_DIR BINARY): it records its arguments and BASIS_ settings, writes
// its id (c's) unless RUN_DIR/no-id exists, when it exits at once (4); then it runs until RUN_DIR/die exists (3), at most 60 s.
const FAKE_TRACKER = `#!/bin/bash
RUN=$1
printf '%s\\n' "$@" > "$RUN/tracker.args"
env | grep -E '^BASIS_' | sort > "$RUN/tracker.env"
[ -e "$RUN/no-id" ] && { echo "fake tracker: refusing to start"; exit 4; }
[ -s "$RUN/tracker-nft-id" ] || printf 'c%.0s' $(seq 1 64) > "$RUN/tracker-nft-id"
for i in $(seq 1 600); do [ -e "$RUN/die" ] && exit 3; sleep 0.1; done
exit 9
`;
// A fake app: it records the settings the entrypoint gave it, then runs until FAKE_OUT/app-die exists (5), at most 60 s.
const APP_KEYS = ['PILOT_NETWORK', 'VALUN_ENVIRONMENT', 'VALUN_DEPLOYMENT', 'HOST', 'PORT', 'PILOT_TRACKER_URL', 'PILOT_TRACKER_NFT_ID', 'PILOT_TRACKER_SHA256',
  'PILOT_DATA_DIR', 'VALUN_DATA_DIR', 'BASIS_SIGNER', 'BASIS_RUNNER', 'BASIS_TRACKER_NFT_ID', 'BASIS_TRACKER_URL', 'PILOT_OPEN_SANDBOX', 'PILOT_OPEN_NETWORK',
  'PILOT_CIRCULATION', 'VALUN_PUBLIC_ORIGIN'];
const FAKE_APP = `import fs from 'node:fs';
const out = process.env.FAKE_OUT;
const env = Object.fromEntries(${JSON.stringify(APP_KEYS)}.map(k => [k, process.env[k] ?? null]));
fs.writeFileSync(out + '/app.json', JSON.stringify({pid: process.pid, env}));
setInterval(() => { if (fs.existsSync(out + '/app-die')) process.exit(5); }, 100);
setTimeout(() => process.exit(9), 60000);
`;
const BINARY = 'a placeholder basis_server: the fake tracker never runs it\n';
function fakeImage() {
  const opt = tmp(), data = tmp(), out = tmp();
  fs.mkdirSync(path.join(opt, 'bin')); fs.mkdirSync(path.join(opt, 'app'));
  fs.writeFileSync(path.join(opt, 'bin', 'basis_server'), BINARY);
  fs.writeFileSync(path.join(opt, 'run-tracker.sh'), FAKE_TRACKER, {mode: 0o755});
  fs.writeFileSync(path.join(opt, 'app', 'server.mjs'), FAKE_APP);
  const tracker = path.join(data, 'pilot', 'tracker');
  cleanups.push(() => { fs.mkdirSync(tracker, {recursive: true}); for (const f of [path.join(tracker, 'die'), path.join(out, 'app-die')]) fs.writeFileSync(f, ''); });
  const appInfo = () => fs.existsSync(path.join(out, 'app.json')) && JSON.parse(fs.readFileSync(path.join(out, 'app.json'), 'utf8'));
  // The image's ENV, then `extra`; never this process's PILOT_, BASIS_, VALUN_ or ERGO_ settings. PILOT_TRACKER_SHA256 and
  // BASIS_TRACKER_NFT_ID are set to show that the entrypoint never passes them on as given.
  const start = (extra = {}) => {
    const env = {...clean(), HOST: '0.0.0.0', PORT: '8080', VALUN_ENVIRONMENT: 'local', PILOT_NETWORK: 'valun-pilot-1', PILOT_OPEN_SANDBOX: '1',
      PILOT_OPEN_NETWORK: '1', PILOT_CIRCULATION: 'on', PILOT_TRACKER_SHA256: 'f'.repeat(64), BASIS_TRACKER_NFT_ID: 'd'.repeat(64), BASIS_PURE_CREDIT: '0',
      ...extra, VALUN_ROOT: posix(opt), VALUN_DATA: posix(data), FAKE_OUT: out, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`};
    const c = spawn(BASH, [posix(path.join(root, 'scripts', 'local-entrypoint.sh'))], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env});
    children.push(c);
    const e = {child: c, log: '', code: null};
    c.stderr.on('data', d => { e.log += d; }); c.stdout.on('data', d => { e.log += d; });
    e.exited = new Promise(r => c.on('exit', code => { e.code = code; r(code); }));
    return e;
  };
  return {opt, data, out, tracker, start, appInfo};
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('local-entrypoint.sh: one pure-credit tracker on loopback with the pilot unit, then the app in local mode with the sha256 it computed; it stops when the tracker exits', async t => {
  if (!canRun(t)) return;
  const {opt, data, tracker, start, appInfo} = fakeImage();
  const e = start();
  const app = await until(`the app started (entrypoint: ${e.log.slice(-400)})`, appInfo);
  const sha = crypto.createHash('sha256').update(BINARY).digest('hex');
  assert.deepEqual(app.env, {PILOT_NETWORK: 'valun-pilot-1', VALUN_ENVIRONMENT: 'local', VALUN_DEPLOYMENT: 'local', HOST: '0.0.0.0', PORT: '8080',
    PILOT_TRACKER_URL: 'http://127.0.0.1:3058', PILOT_TRACKER_NFT_ID: 'c'.repeat(64), PILOT_TRACKER_SHA256: sha,
    PILOT_DATA_DIR: `${posix(data)}/pilot`, VALUN_DATA_DIR: `${posix(data)}/valun`, BASIS_SIGNER: `${posix(opt)}/bin/valun_signer`, BASIS_RUNNER: 'direct',
    BASIS_TRACKER_NFT_ID: null, BASIS_TRACKER_URL: null, PILOT_OPEN_SANDBOX: '1', PILOT_OPEN_NETWORK: '1', PILOT_CIRCULATION: 'on', VALUN_PUBLIC_ORIGIN: null});
  assert.match(e.log, new RegExp(`basis_server sha256 ${sha}; network valun-pilot-1, local: no chain`));
  // The tracker: basis/run-tracker.sh's arguments (its data in the volume, the image's binary) and settings (pure credit
  // always, the pilot credit's token id, on 3058).
  assert.deepEqual(fs.readFileSync(path.join(tracker, 'tracker.args'), 'utf8').trim().split('\n'), [posix(tracker), `${posix(opt)}/bin/basis_server`]);
  const tenv = Object.fromEntries(fs.readFileSync(path.join(tracker, 'tracker.env'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.deepEqual(tenv, {BASIS_CONFIG_LAYOUT: 'auto', BASIS_PURE_CREDIT: '1', BASIS_PORT: '3058', BASIS_SERVED_TOKEN_ID:
    crypto.createHash('sha256').update('valun-pilot-credit/1').digest('hex'), BASIS_SERVED_TOKEN_SYMBOL: 'PC'});
  await sleep(500);
  assert.equal(e.code, null, `still running: ${e.log}`);
  fs.writeFileSync(path.join(tracker, 'die'), '');
  assert.equal(await e.exited, 1, e.log);
  assert.match(e.log, /a process exited; stopping/);
  await until('the app was stopped', () => !alive(app.pid), 10_000);
});

test('local-entrypoint.sh: the settings it leaves to docker run -e (circulation, the open network, the port, the origin); it stops when the app exits', async t => {
  if (!canRun(t)) return;
  const {out, start, appInfo} = fakeImage();
  const e = start({PILOT_CIRCULATION: 'off', PILOT_OPEN_NETWORK: '0', PORT: '9000', VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000', PILOT_BASIS_PORT: '3999'});
  const app = await until(`the app started (entrypoint: ${e.log.slice(-400)})`, appInfo);
  assert.deepEqual([app.env.PILOT_CIRCULATION, app.env.PILOT_OPEN_NETWORK, app.env.PORT, app.env.VALUN_PUBLIC_ORIGIN, app.env.PILOT_TRACKER_URL],
    ['off', '0', '9000', 'http://127.0.0.1:9000', 'http://127.0.0.1:3999']);
  fs.writeFileSync(path.join(out, 'app-die'), '');
  assert.equal(await e.exited, 1, e.log);
  assert.match(e.log, /a process exited; stopping/);
});

test('local-entrypoint.sh refuses a network with a chain, and says why when its tracker does not start', async t => {
  if (!canRun(t)) return;
  const a = fakeImage(), refused = a.start({PILOT_NETWORK: 'valun-testnet-1'});
  assert.equal(await refused.exited, 2, refused.log);
  assert.match(refused.log, /PILOT_NETWORK=valun-testnet-1: this image has no chain and runs only valun-pilot-1/);
  assert.ok(!fs.existsSync(path.join(a.tracker, 'tracker.args')), 'no tracker was started');
  assert.equal(a.appInfo(), false, 'nor the app');
  const b = fakeImage();
  fs.mkdirSync(b.tracker, {recursive: true});
  fs.writeFileSync(path.join(b.tracker, 'no-id'), '');
  const failed = b.start();
  assert.equal(await failed.exited, 1, failed.log);
  assert.match(failed.log, /the tracker did not start/);
  assert.match(failed.log, /fake tracker: refusing to start/, 'with the tail of what it printed');
  assert.equal(b.appInfo(), false, 'the app never started');
});

test('local-entrypoint.sh: a data folder this user cannot write is refused with what to mount; the platform\'s stop (SIGTERM) exits 0', async t => {
  if (!canRun(t)) return;
  if (process.platform === 'win32') { t.skip('on Windows a folder\'s mode does not stop its owner writing, and a child cannot be sent a signal bash can trap'); return; }
  const a = fakeImage();
  fs.mkdirSync(path.join(a.data, 'pilot'), {recursive: true});
  fs.chmodSync(path.join(a.data, 'pilot'), 0o555);
  cleanups.unshift(() => fs.chmodSync(path.join(a.data, 'pilot'), 0o755));
  const refused = a.start();
  assert.equal(await refused.exited, 2, refused.log);
  assert.match(refused.log, /is not a folder uid \d+ can write: mount a named volume \(-v valun-local:\/data\)/);
  const b = fakeImage(), e = b.start();
  const app = await until(`the app started (entrypoint: ${e.log.slice(-400)})`, b.appInfo);
  e.child.kill('SIGTERM');
  assert.equal(await e.exited, 0, e.log);
  assert.doesNotMatch(e.log, /a process exited; stopping/, 'stopped by the trap, not by an exit');
  assert.ok(!alive(app.pid), 'the app was stopped before the entrypoint exited');
});
