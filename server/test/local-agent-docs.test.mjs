// The agent docs of a LOCAL Valun server (fix inbox #150): public/skill-local.md (served at /skill.md and /agents.md) and
// public/llms-local.txt (/llms.txt), rendered by scripts/build-local-docs.mjs from scripts/local-docs/ and the shared
// blocks of public/skill-testnet.md. A local server runs valun-pilot-1, in PC, with no chain, so its docs must name the
// pinned client, run every command in a client profile of its own with this server named (the client's default server is
// the public network), name no origin but this server's, have none of the retired pilot's or the testnet's wording, make
// console the first tester's approval mode, say to read before retrying a commitment, and give recovery advice that
// matches the server and the client release. lib/http.mjs serves them with the server's origin in place of {origin}
// (test/local-mode.unit.test.mjs checks that, over HTTP). No tracker.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {CLIENT, LOCAL_CLIENT} from '../lib/a2a.mjs';
import {SANDBOX_CAPS, OPEN_NETWORK_MAX_OPEN_OFFERS, SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, DEFAULT_MANDATE, INVITE_MANDATE_DAYS} from '../lib/pilot/core.mjs';
import {SERVICES, WELCOME} from '../lib/pilot/sandbox.mjs';
import {EXPIRIES_TO_EXCLUDE, EXCLUSION_MS} from '../lib/pilot/clearing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// scripts/build-local-docs.mjs and its sources (scripts/local-docs/) are not in the hosted image's copy of the app
// (VALUN_APP_COPY=image: its Dockerfile copies lib/, public/ and test/ and a few scripts): there the tests that use them are
// skipped, with the reason, as test/operations.test.mjs skips one; anywhere else a missing file fails them (needs). So the
// script is loaded only where it is, never as a static import, which would fail this whole file there.
const BUILD_FILES = ['scripts/build-local-docs.mjs', 'scripts/local-docs/skill.md', 'scripts/local-docs/llms.txt', 'scripts/local-docs/start.html'];
const BUILD = path.join(root, 'scripts', 'build-local-docs.mjs');
const B = fs.existsSync(BUILD) ? await import(pathToFileURL(BUILD).href) : null;
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const skill = read('public/skill-local.md'), llms = read('public/llms-local.txt');
// A local server's /start for people (fix inbox #155, FB-2), rendered from the same facts; test/local-pages.unit.test.mjs
// checks it as served.
const start = read('public/start-local.html');
const VERSION = LOCAL_CLIENT.replace(/^valun==/, '');
// What a local server writes in place of {origin}: its default, and one published on another port (VALUN_PUBLIC_ORIGIN).
const ORIGINS = ['http://127.0.0.1:8080', 'http://127.0.0.1:9000', 'http://localhost:8080'];
const served = (t, origin) => t.replaceAll('{origin}', origin);

test('public/skill-local.md, public/llms-local.txt and public/start-local.html are what scripts/build-local-docs.mjs renders today (--check)', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const docs = B.build();
  assert.deepEqual(docs.map(d => d.out), ['public/skill-local.md', 'public/llms-local.txt', 'public/start-local.html']);
  assert.equal(docs[0].text, skill, 'stale: run node scripts/build-local-docs.mjs');
  assert.equal(docs[1].text, llms, 'stale: run node scripts/build-local-docs.mjs');
  assert.equal(docs[2].text, start, 'stale: run node scripts/build-local-docs.mjs');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-local-docs.mjs'), '--check'], {cwd: root, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /current/);
});

test('the shared blocks come from skill-testnet.md: a change there changes the local skill, so --check fails until it is rendered again', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const testnet = read(B.TESTNET_SKILL), source = read('scripts/local-docs/skill.md');
  const shared = [...source.matchAll(/^<!-- shared: (.+?) \| (.+?) -->$/gm)];
  assert.ok(shared.length >= 5, 'the directory, deal and rules blocks are shared');
  // The install and Windows blocks are the source's own: the testnet's name its own client release (valun 0.7.2's
  // --json-file), which a local server's docs do not pin (LOCAL_CLIENT).
  for (const start of ['**Installing:**', '**On Windows:**']) {
    assert.ok(!shared.some(m => m[2] === start), `${start}: written in the source, not shared`);
    assert.ok(source.split('\n').some(l => l.startsWith(start)), `${start}: in the source`);
  }
  for (const [, heading, start] of shared) {
    const block = B.sharedBlock(testnet, heading, start);
    assert.ok(skill.includes(B.localize(block)), `${start}: in the local skill, made local`);
    // One word changed in the testnet's block (its last long word, so that the block still begins as the source says)
    // reaches the local skill.
    const changed = testnet.replace(block, block.replace(/(\w{4,})(?![\s\S]*\w{4,})/, '$1x'));
    assert.notEqual(changed, testnet);
    assert.notEqual(B.render(source, changed), skill, `${start}: a change in skill-testnet.md changes the local skill`);
  }
  // A shared block that comes to name the testnet's chain, coin or origin stops the build instead of reaching a local server.
  const directory = B.sharedBlock(testnet, '## 3. Find agents, and offer your work', 'The directory answers');
  for (const add of [' Redeem it for tERG.', ' Pay 3000000 nanoERG.', ' Ask house-scribe.', ' It is anchored on chain.',
    ' Run `uvx --from valun==0.7.1 valun doctor`.', ' valun 9.9.9 says so.']) {
    assert.throws(() => B.render(source, testnet.replace(directory, directory + add)), /can't be used on a local server/, add);
  }
  // So does a shared block that is gone or reworded at its start.
  assert.throws(() => B.render(source, testnet.replace('The directory answers', 'The directory returns')), /no block beginning/);
});

test('the source names the client release it was written for: another pin stops the build until it is reviewed', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const source = read('scripts/local-docs/skill.md');
  assert.match(source, new RegExp(`^<!-- client: ${LOCAL_CLIENT.replaceAll('.', '\\.')} -->$`, 'm'));
  assert.throws(() => B.render(source, read(B.TESTNET_SKILL), {...B.facts(), client: 'valun==9.9.9'}), /written for valun==0\.7\.1, and a local server pins valun==9\.9\.9/);
  assert.throws(() => B.render(source.replace(/^<!-- client: .* -->\n/m, '')), /the client release it was written for/);
});

test('a local server\'s docs name the pinned client, only its own origin, and none of the pilot\'s or the testnet\'s wording', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  // skill-testnet.md pins the testnet's release (lib/a2a.mjs CLIENT, as the A2A answer does: test/start-page.test.mjs);
  // a local server's docs pin LOCAL_CLIENT, the release the local image was verified with, apart from it.
  const testnetPins = new Set([...read(B.TESTNET_SKILL).matchAll(/valun(?:\[\w+\])?==(\d+\.\d+\.\d+)/g)].map(m => m[1]));
  assert.deepEqual([...testnetPins], [CLIENT.replace(/^valun==/, '')]);
  for (const [name, doc] of [['skill-local.md', skill], ['llms-local.txt', llms], ['start-local.html', start]]) {
    for (const origin of ORIGINS) {
      const t = served(doc, origin);
      assert.deepEqual(B.localDocProblems(t, {origin}), [], `${name} at ${origin}`);
      const pins = [...t.matchAll(/valun(?:\[\w+\])?==(\d+\.\d+\.\d+)/g)].map(m => m[1]);
      assert.ok(pins.length && pins.every(v => v === VERSION), `${name}: valun==${VERSION} only`);
      // Only this server's origin, and the code's: no valun.tech, no other host, no other port.
      const urls = [...t.matchAll(/https?:\/\/[^\s)`>"'\]]+/g)].map(m => m[0].replace(/[.,;:!?]+$/, ''));
      assert.ok(urls.some(u => u.startsWith(origin)), `${name} names ${origin}`);
      for (const u of urls) assert.ok(u.startsWith(origin) || B.EXTERNAL.some(e => u.startsWith(e)), `${name}: ${u}`);
      assert.doesNotMatch(t, /valun\.tech|\{origin\}/i, name);
    }
    // The retired pilot's skill.md and llms.txt (public/skill.md, public/llms.txt), and the testnet's words.
    for (const [re, what] of [[/debt is gone/i, 'the debt is gone'], [/loop is cancelled/i, 'the loop is cancelled'],
      [/pay back in work/i, 'pay back in work'], [/Website: /, 'Website:'], [/Test network; credits/, 'the pilot\'s description'],
      [/pipx install valun(?!==)|uv tool install valun(?!==)|uvx valun |npm install @fitzdoud\/valun(?!@)/, 'an unpinned client'],
      [/nanoERG|\btERG\b|Ergo testnet/, 'the testnet\'s coin and chain'], [/\bfinal\b/i, 'final'],
      [/house-scribe|house-reviewer/, 'the house agents, which do not run on a local server']]) {
      assert.doesNotMatch(doc, re, `${name}: ${what}`);
    }
  }
  // Every link of this server is a page or read a local server answers (lib/http.mjs STATIC, the pilot's public reads, the
  // agent pages and loop cards); the chain reads only as what answers 404 no_chain.
  const paths = new Set([...`${skill}\n${llms}`.matchAll(/\{origin\}(\/[^\s)`"'\]]*)?/g)].map(m => (m[1] ?? '/').replace(/[.,;:!?]+$/, '')));
  const SERVED = ['/', '/skill.md', '/agents.md', '/network', '/start', '/trust', '/pilot#owner', '/pilot/v1/info',
    '/pilot/v1/participants', '/pilot/v1/loops', '/agent/HANDLE', '/agent/<handle>', '/loop/<id>', '/pilot/v1/chain', '/pilot/v1/reserves'];
  for (const p of paths) assert.ok(SERVED.includes(p), `a link to ${p}`);
  assert.match(skill, /answers `GET \{origin\}\/pilot\/v1\/chain` and `GET \{origin\}\/pilot\/v1\/reserves` with\n {2}`404 no_chain`/);
});

test('every command runs the pinned client in a local profile, with --server where it takes one; MCP apps too', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const cmds = [...B.commands(skill), ...B.commands(llms)].filter(c => c.sub);
  assert.ok(cmds.length >= 15, `${cmds.length} commands`);
  for (const c of cmds) {
    assert.equal(c.spec, LOCAL_CLIENT, c.text);
    assert.match(c.profile, /^local\w*$/, c.text);
    if (B.SERVER_COMMANDS.has(c.sub)) assert.ok(c.text.includes('--server {origin}'), c.text);
    else assert.ok(B.PROFILE_COMMANDS.has(c.sub), c.text);
  }
  // The commands a first tester runs, each present.
  const run = `uvx --from ${LOCAL_CLIENT} valun --profile local`;
  const join = `${run} join --sandbox --server {origin} --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" `
    + '--owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt" --approvals console';
  for (const line of [join, `claude mcp add valun-local -- ${run} mcp`, `${run} call valun_status`, `${run} sandbox tour --yes --server {origin}`,
    `${run} doctor --server {origin}`, `${run} clearing run --server {origin}`, `${run} call valun_inbox`]) {
    assert.ok(skill.includes(line), line);
  }
  assert.ok(skill.includes(`"args": ["--from", "${LOCAL_CLIENT}", "valun", "--profile", "local", "mcp"]`), 'the MCP config');
  // The parser: a bare `uvx --from X valun` (an install note) is no command; one outside the profile is a problem.
  assert.deepEqual(B.commands('type `valun` where this file says `uvx --from valun==0.7.1 valun`.').map(c => c.sub), [null]);
  assert.deepEqual(B.localDocProblems('`uvx --from valun==0.7.1 valun call valun_status` at {origin}'), ['runs outside a local profile: uvx --from valun==0.7.1 valun call valun_status']);
  assert.deepEqual(B.localDocProblems('`uvx --from valun==0.7.1 valun --profile local doctor` at {origin}'), ['has no --server {origin}: uvx --from valun==0.7.1 valun --profile local doctor']);
});

test('console is the first tester\'s approval mode, with the local owner console, the token rules and the hour an IOU waits', () => {
  assert.match(skill, /For a first try, choose `console`: every commitment your agent signs then waits until your human\n {3}approves it in this server's owner console, \{origin\}\/pilot#owner, with the owner token\./);
  for (const l of skill.split('\n').filter(l => / join --sandbox /.test(l) && /--profile local /.test(l) && !/local2/.test(l))) {
    assert.match(l, /--approvals console$/, l);
    assert.match(l, /--owner-token-file "\$HOME\/valun-local-owner-token-YOUR-HANDLE\.txt"/, l);
  }
  assert.match(skill, /Never read that file or use the\ntoken yourself, not even to approve your own commitments\./);
  assert.match(skill, /approve an IOU within about one hour of when you accepted the delivery/);
  assert.match(skill, /the tour\nalso waits for your human about 8 times/);
});

test('read before retry, and recovery advice that matches the server and valun 0.7.1', () => {
  assert.match(skill, /\*\*Read before you retry\.\*\*/);
  assert.match(skill, /Before you send it again, read what the server holds now:\n`valun_inbox`, or `valun_deal` for its deal\./);
  assert.match(skill, /withdraw the extra one\n\(`valun_respond`, action `withdraw`\)/);
  // A lost join: no enroll (0.7.1's skips the sandbox settings join --sandbox writes), another handle.
  assert.match(skill, /don't run the `enroll` it suggests\. With valun 0\.7\.1, an enroll skips the\n {2}settings `join --sandbox` writes/);
  assert.match(skill, /Join again with another handle instead/);
  assert.doesNotMatch(skill, /agent\/YOUR-HANDLE:/, 'no check of an agent page, which a participant without a key does not have');
  assert.match(skill, /valun 0\.7\.1 words a cut connection as a refusal/);
  assert.match(skill, /After your human reset this server, the local profile no longer works/);
});

// Several agents on one machine, an invite, a machine with no network after setup or behind a proxy (fix inbox #155: the
// local-readiness audit's FB-3, FB-5, FB-6, FB-8, FB-10, FB-16 and FB-18, SRV-4, SRV-9, SRV-16, CLI-5, MR-8): what the
// skill tells an agent, word for word where a person or an agent copies it.
test('the skill: a client home and this server for each agent, the invited join in full with only the code on stdin, 0.7.1\'s hints that leave out --server, install first, NO_PROXY, the MCP tool\'s full name', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const f = B.facts(), run = `uvx --from ${LOCAL_CLIENT} valun --profile local`, flat = s => s.replace(/\s+/g, ' ');
  const s = flat(skill);
  // One client home per agent, set with this server; the order the client picks a server in (valun 0.7.1 cli.py _server).
  assert.ok(skill.includes('```\nexport VALUN_HOME="$HOME/valun-agents/YOUR-HANDLE" VALUN_SERVER={origin}\n```'));
  assert.ok(s.includes('The client takes a command\'s `--server` first, then the server its profile joined, then `VALUN_SERVER`, and only then the public network.'));
  assert.ok(s.includes('a second agent\'s join in the profile `local` is refused as already connected'));
  // The invite prints only its code (scripts/pilot-admin.mjs --code-only: 0.7.1 sends the whole first line it reads), and
  // the invited join is given in full: this profile, this server, the local token file, console approvals, the code on stdin.
  assert.ok(s.includes('`docker exec CONTAINER node scripts/pilot-admin.mjs invite --uses 25 --code-only`'));
  for (const m of skill.matchAll(/pilot-admin\.mjs invite\b[^`\n]*/g)) assert.match(m[0], /--code-only/, `every invite prints only its code: ${m[0]}`);
  const invited = `${run} join --invite-from-stdin --server {origin} --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" `
    + '--owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt" --approvals console';
  assert.ok(skill.includes(`\`\`\`\n${invited}\n\`\`\``), 'the invited join, in a block of its own');
  assert.ok(s.includes('Never put the code on a command line or in a file others can read'));
  // What an invited agent gets instead of the self-serve limits, from the code (Pilot.join: DEFAULT_MANDATE, INVITE_MANDATE_DAYS).
  assert.deepEqual([f.invited_per_deal, f.invited_owed, f.invited_days], [DEFAULT_MANDATE.max_issue_per_deal, DEFAULT_MANDATE.max_issue_outstanding, INVITE_MANDATE_DAYS]);
  assert.ok(s.includes(`no tour and no welcome job, at most ${f.invited_per_deal} PC per deal and ${f.invited_owed} PC owed in total, and a mandate that ends ${f.invited_days} days after the join`));
  // An invited agent's client (F4 and F5 of the branch's review): valun 0.7.1's invited join writes consent_loop off, so
  // `valun mcp` signs set-offs only before a tool that commits (and three expiries in a row leave the agent out for 24 h:
  // clearing.mjs), and as_new_creditor off, so it signs no payment by transfer until that is on. Section 4's background
  // signing is a self-serve agent's.
  assert.deepEqual([f.expiries_to_exclude, f.exclusion_hours], [EXPIRIES_TO_EXCLUDE, EXCLUSION_MS / 3600e3]);
  assert.ok(s.includes(`a loop of invited agents can stall, and after ${EXPIRIES_TO_EXCLUDE} set-offs in a row expire unsigned, an agent is left out of set-offs for ${EXCLUSION_MS / 3600e3} hours. Turn the loop on before the MCP server starts (restart it if it runs): \`${run} config consent_loop on --server {origin}\`.`));
  assert.ok(s.includes(`and your client signs such payments only after \`${run} config consents.as_new_creditor on --server {origin}\`.`));
  assert.ok(s.includes(`For an agent that joined with \`--sandbox\`, as above, the MCP server (\`${run} mcp\`) signs the set-offs that leave your net position unchanged, in the background; an invited agent's does so only once its consent loop is on (section 6).`));
  // Both come after the invited join (the image's check runs them in an agent that joined, in order).
  for (const cmd of ['config consent_loop on', 'config consents.as_new_creditor on']) assert.ok(skill.indexOf(cmd) > skill.indexOf(invited), cmd);
  // The image's check of a release runs this file's commands as written, in order, and gives each join, the invited one
  // included, a handle of its own; it then reads the tour's set-off for the latest one. So the invited join comes after
  // the tour and the agent page this file names (the local image's CI checks (private)).
  const at = skill.indexOf(invited);
  for (const later of [' sandbox tour --', '{origin}/agent/']) assert.ok(skill.indexOf(later) < at && skill.indexOf(later, at) < 0, `${later.trim()} only before the invited join`);
  // valun 0.7.1 prints join hints with no --server (doctor's FIX line, the not-connected answers, the tour), and the MCP
  // server's approval_unavailable answer gives config approvals with no --profile: never run as printed.
  assert.ok(s.includes('valun 0.7.1\'s own hints leave out `--server`'));
  assert.ok(s.includes('Never run them: run the join above again (it names this server)'));
  assert.match(skill, /a join without `--server` joins the public network/, 'the warning the image\'s check reads (the local image\'s CI checks, private)');
  // After a reset: the profile's file and the token file (0.7.1 never replaces a file), then the join with --server.
  assert.ok(s.includes('and the owner token file your join wrote (`$HOME/valun-local-owner-token-YOUR-HANDLE.txt`: valun 0.7.1 never replaces a file), then join again with the command above, `--server` included'));
  // No network after setup (uvx revalidates a stale cache with PyPI), and a proxy (0.7.1 sends http://127.0.0.1 through it).
  assert.ok(s.includes('install the client while you still have network (`uv tool install valun==0.7.1`'));
  assert.ok(s.includes('or run uvx once and then set `UV_OFFLINE=1`'));
  assert.ok(s.includes('set `NO_PROXY=127.0.0.1,localhost` and `no_proxy=127.0.0.1,localhost` as well'));
  // MCP: the plugin's server runs the default profile and its tools have the same names; the schedule names this server's.
  // The plugin off, never VALUN_PROFILE=local instead: that moves its MCP server to the profile, and its skill's join and
  // doctor, which name no server, then go to the public network from a profile with no server yet (FH-1 of the review).
  assert.ok(s.includes('a skill whose join and doctor lines name no server), ask your human to turn that plugin off while you use this server, and don\'t follow that skill\'s lines here.'));
  assert.doesNotMatch(skill, /VALUN_PROFILE/, 'no profile setting offered without this server');
  assert.ok(skill.includes('`/loop 15m check my local Valun inbox with mcp__valun-local__valun_inbox and handle what is waiting within my limits`'));
  assert.doesNotMatch(skill, /inbox \(valun_inbox\)/, 'no schedule that names the tool without its server');
  // The trust model: the local tracker's id is made in the volume, its key is a point nobody holds (basis/run-tracker.sh:
  // a BIP-341 NUMS point), so nothing is signed as it (F9 of the branch's review: it said "the tracker and its key (made
  // in the server's data volume)").
  assert.ok(s.includes('the tracker, which records every IOU, transfer and set-off (its id is made in the server\'s data volume, and its key is a point whose secret nobody holds, so nothing is ever signed as the tracker)'));
  assert.doesNotMatch(s, /tracker and its key/);
});

// llms.txt sends whoever runs the server to the guide that came with it: the image's /opt/valun/docs/, which
// Dockerfile.local copies (test/local-mode.unit.test.mjs), or a checkout's docs/. It no longer sends them to valun-open's
// server/docs/LOCAL.md, which does not exist there until the next sync, beside a README whose local section still gives
// a join with no --server (FH-3 of the branch's review).
test('llms.txt points to the guide and the checklist that came with the server, never to valun-open\'s copy', () => {
  assert.ok(llms.includes('in the local image at `/opt/valun/docs/LOCAL.md` and `/opt/valun/docs/LOCAL-ACCEPTANCE.md`'));
  assert.ok(llms.includes('Follow those, written for the server you run, rather than a copy elsewhere.'));
  assert.doesNotMatch(llms, /server\/docs|guide to the local image \(server/);
});

test('the numbers are the server\'s own: the self-serve limits, the join cap, the practice agents\' prices', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const f = B.facts();
  assert.equal(f.per_deal, SANDBOX_CAPS.max_issue_per_deal);
  assert.deepEqual([f.per_deal, f.owed_total, f.open_offers, f.joins_hour_address, f.text_stats, f.notary, f.welcome],
    [SANDBOX_CAPS.max_issue_per_deal, SANDBOX_CAPS.max_issue_outstanding, OPEN_NETWORK_MAX_OPEN_OFFERS,
      SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, SERVICES['text-stats'].price, SERVICES.notary.price, WELCOME.price]);
  assert.ok(skill.includes(`**${f.per_deal} PC per deal** and **${f.owed_total} PC owed in total**`));
  assert.ok(llms.includes(`at most ${f.per_deal} PC per deal and ${f.owed_total} PC owed in total`));
  assert.ok(skill.includes(`"price": ${f.text_stats}}'`), 'the hire is at the practice agents\' price');
  assert.ok(skill.includes(`limited to ${f.joins_hour_address} an hour from one address`));
});
