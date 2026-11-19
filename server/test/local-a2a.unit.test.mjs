// A local server's A2A front door (fix inbox #151, the first half; the local-readiness audit of Nov 18, FB-1, FB-14,
// SRV-13: test R-1). An agent that found a local server through its Agent Card and ran the join answer's lines joined the
// public testnet: they named no profile and no server, so they ran on the client's default profile against its default
// server, https://valun.tech; the card called the server the Valun test network, with the public site as its provider;
// and a request with Host valun-desk.fly.dev got links to the retired desk, which replays every request to the testnet.
// Now, on a local server (VALUN_ENVIRONMENT=local), for every Host a request may come with, in both protocol generations:
//   - the join answer's commands are the server's own skill.md's (public/skill-local.md, as it serves it): the MCP app's
//     two lines and the shell's two, word for word, and two of its keep-signing commands; every valun command in the
//     profile local, with --server <origin> where the command takes it (the image's checks parse them the same way),
//     console approvals and the local token file; Hermes in a profile of its own whose join names this server; no
//     Claude Code plugin; amounts in PC; a lost join sends the agent to skill.md, not to the public network's /start;
//   - its origin is the server's one origin (PUBLIC_ORIGIN: by default http://127.0.0.1:<PORT>), the one its skill.md
//     names, whatever the Host header says;
//   - the card names that origin, a local description and the code's home as its provider;
//   - nothing it answers (the other skills included) names a public host, and scripts/build-local-docs.mjs's checker of a
//     local doc finds nothing in it.
// Each setting runs in a process of its own (test/fixtures/local-a2a.mjs). The hosted answers are test/a2a.test.mjs's,
// test/staging-docs.unit.test.mjs's and test/testnet-network.test.mjs's, unchanged. No tracker.
import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LOCAL_CLIENT, LOCAL_MCP, LOCAL_RUN, LOST_JOIN_HERMES_LOCAL, LOST_JOIN_LOCAL} from '../lib/a2a.mjs';

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
const SKILL = fs.readFileSync(path.join(root, 'public', 'skill-local.md'), 'utf8').replace(/\r\n/g, '\n');
// The hosts and services an agent of a local server must never be sent to: the public network's (valun.tech, its Fly
// apps, the retired desk's host) and the Ergo explorer.
const PUBLIC_HOST = /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)*valun\.tech|[a-z0-9-]+\.fly\.dev|(?:[a-z0-9-]+\.)*ergoplatform\.com)(?![a-z0-9-])/i;
const PLUGIN = /\/plugin\s+(install\s+valun@valun|marketplace\s+add\s+fitzss\/valun-open)/;
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PILOT_|BASIS_|VALUN_|ERGO_)/.test(k) && k !== 'PORT'));
function serve(env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'local-a2a.mjs')], {cwd: root, env: {...clean(), ...env}});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`local-a2a.mjs exited ${code}: ${err}`))));
  });
}
// skill-local.md's fenced block after `marker`, as lines.
const fence = marker => /```\n([\s\S]*?)\n```/.exec(SKILL.slice(SKILL.indexOf(marker)))[1].split('\n');
// Every string in a JSON value, with where it is.
const strings = (v, at = 'data') => (typeof v === 'string' ? [[at, v]] : v && typeof v === 'object'
  ? Object.entries(v).flatMap(([k, x]) => strings(x, Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`)) : []);
// The parts of an A2A answer: 1.0's result is {message}, 0.3's the message itself.
const partsOf = r => (r.json.result.message ?? r.json.result).parts;
const answerOf = r => { const parts = partsOf(r); return {text: parts.find(p => typeof p.text === 'string').text, data: parts.find(p => p.data).data}; };
// The valun 0.7.2 subcommands that take --server (scripts/build-local-docs.mjs SERVER_COMMANDS: its cli.py).
const takesServer = cmd => B.SERVER_COMMANDS.has(/^uvx --from \S+ valun --profile \S+ ([a-z-]+)/.exec(cmd)?.[1]);
// The local docs' checker on a text that gives no command, so names no client release (the card, the other skills).
const unpinned = (text, origin) => B.localDocProblems(text, {origin}).filter(p => p !== 'pins no client release');

let runs;
before(async () => {
  // The image's settings (PORT 8080, no VALUN_PUBLIC_ORIGIN); a port published as another with its origin given; and an
  // https origin in front of it.
  const [local, at9000, https] = await Promise.all([serve({VALUN_ENVIRONMENT: 'local', PORT: '8080'}),
    serve({VALUN_ENVIRONMENT: 'local', PORT: '8080', VALUN_PUBLIC_ORIGIN: 'http://127.0.0.1:9000'}),
    serve({VALUN_ENVIRONMENT: 'local', PORT: '8080', VALUN_PUBLIC_ORIGIN: 'https://valun.example'})]);
  runs = {local, at9000, https};
});

test('local: the join answer\'s commands are skill-local.md\'s, in the profile local with --server <origin>, console approvals and the local token file, for every Host, in A2A 1.0 and 0.3', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  for (const [name, run, origin] of [['local', runs.local, 'http://127.0.0.1:8080'], ['at9000', runs.at9000, 'http://127.0.0.1:9000'], ['https', runs.https, 'https://valun.example']]) {
    assert.deepEqual([run.environment, run.origin], ['local', origin], name);
    const served = SKILL.replaceAll('{origin}', origin);
    const mcp = fence('**Claude Code, Codex, Cursor, or any MCP app.**').map(l => l.replaceAll('{origin}', origin));
    const shell = fence('**Any agent with a shell.**').map(l => l.replaceAll('{origin}', origin));
    // Hermes (fix inbox #155: FB-18): skill-local.md gives the answer's three lines, in a Hermes profile of its own that
    // names this server, marked as not yet run against a local server, as the answer's text says.
    const hermes = fence('**Hermes Agent**').map(l => l.replaceAll('{origin}', origin));
    assert.equal(mcp.length, 2, 'skill-local.md gives an MCP app two lines: the join, then claude mcp add');
    assert.equal(shell.length, 2, 'and a shell two: the join, then valun_status');
    assert.equal(hermes.length, 3, 'and Hermes three: the profile, the plugin, the join');
    assert.match(SKILL, /\*\*Hermes Agent\*\*, in a Hermes profile of its own \(these lines have not been run against a local server yet\):/);
    const first = answerOf(run.hosts['127.0.0.1:8080'].v1);
    for (const [host, h] of Object.entries(run.hosts)) {
      for (const gen of ['v1', 'v03']) {
        const at = `${name} ${host} ${gen}`, r = h[gen];
        assert.equal(r.status, 200, at);
        const {text, data} = answerOf(r);
        // One answer, whatever the Host and the generation: this server's origin.
        assert.deepEqual({text, data}, first, `${at}: the same answer as for 127.0.0.1:8080`);
        assert.equal(data.instructions, `${origin}/skill.md`, at);
        assert.equal(data.one_line, `Read ${origin}/skill.md and follow it to join Valun.`, at);
        assert.deepEqual([data.network, data.for_people], [`${origin}/network`, `${origin}/start`], at);
        // skill-local.md's lines, word for word, as the server serves the file.
        assert.deepEqual(data.mcp, mcp, `${at}: data.mcp is skill-local.md's MCP block`);
        assert.deepEqual(data.shell, shell, `${at}: data.shell is skill-local.md's shell block`);
        assert.deepEqual(data.hermes, hermes, `${at}: data.hermes is skill-local.md's Hermes block`);
        assert.equal(data.mcp[0], data.shell[0], at);
        assert.equal(data.mcp[0], `${LOCAL_RUN} join --sandbox --server ${origin} --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" `
          + '--owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt" --approvals console', at);
        assert.equal(data.mcp[1], `claude mcp add valun-local -- ${LOCAL_MCP}`, at);
        assert.deepEqual(data.keep_signing, [`${LOCAL_RUN} call valun_inbox`, `${LOCAL_RUN} clearing watch --server ${origin}`], at);
        for (const cmd of data.keep_signing) assert.ok(served.replace(/\s+/g, ' ').includes(`\`${cmd}\``), `${at}: skill-local.md gives \`${cmd}\``);
        // Every valun command: the pinned client in the profile local, and this server named where the command takes it.
        for (const cmd of [...data.mcp, ...data.shell, ...data.keep_signing]) {
          const run1 = cmd.startsWith('claude mcp add valun-local -- ') ? cmd.slice('claude mcp add valun-local -- '.length) : cmd;
          assert.ok(run1.startsWith(`uvx --from ${LOCAL_CLIENT} valun --profile local `), `${at}: ${cmd}`);
          if (takesServer(run1)) assert.ok(run1.includes(` --server ${origin}`), `${at}: ${cmd} names this server`);
        }
        // Hermes in a Hermes profile of its own, whose join names this server (the plugin's join takes --server; its
        // profile keeps that server for what follows), with the local token file.
        assert.deepEqual(data.hermes, ['hermes profile create valun-local --no-alias', 'hermes -p valun-local plugins install https://github.com/fitzss/hermes-plugin-valun --enable',
          `hermes -p valun-local valun join --sandbox --direct-tools --server ${origin} --handle YOUR-HANDLE --operator "YOUR HUMAN" --about "what you offer, in one line" `
            + '--owner-token-file "$HOME/valun-local-owner-token-YOUR-HANDLE.txt"'], at);
        // No Claude Code plugin: its MCP server runs `valun mcp` on the default profile.
        assert.equal(data.claude_code, undefined, at);
        assert.doesNotMatch(`${text}\n${JSON.stringify(data)}`, PLUGIN, at);
        // The text gives the same commands, and the one with none instead of console only after it.
        for (const cmd of [data.mcp[0], data.mcp[1], data.shell[1], ...data.keep_signing, data.hermes[2]]) assert.ok(text.includes(cmd), `${at}: the text gives ${cmd}`);
        assert.ok(text.includes(`Only if your human said you may act alone: ${data.shell[0].replace(/ --approvals console$/, ' --approvals none')}. Then ${data.shell[1]}.`), at);
        assert.doesNotMatch(JSON.stringify(data), /--approvals none/, `${at}: the data never gives none to copy`);
        // A lost join: what skill-local.md section 1 says ("If join goes wrong"), not the public network's /start: valun
        // 0.7.2's (LOST_JOIN_LOCAL: run the command it prints, in this profile with this server), and the Hermes plugin
        // 0.7.2's own join (LOST_JOIN_HERMES_LOCAL: its core's unreachable, no key kept, so no enroll and another handle).
        assert.equal(data.if_join_stops, `${LOST_JOIN_LOCAL} In Hermes, whose plugin joins with its own code: ${LOST_JOIN_HERMES_LOCAL} `
          + `Details: ${origin}/skill.md, section 1 ("If join goes wrong").`, at);
        assert.ok(served.includes('**If join goes wrong:**'), 'skill-local.md has that section');
        // The owner token and the default approvals, as valun 0.7.2 has them (cli.py _token_file_refusal, _hand_over,
        // default_approvals).
        // "Nothing was sent" is also join's answer when the server was not reached (cli.py _join_not_sent) and for a
        // plain_http refusal (client.py plain_http_refusal): fix what it names.
        assert.ok(text.includes('If join says "Nothing was sent", fix what it names: for a token file that exists already, or a folder that can\'t take one, join again with a new token file name; for no connection, run the doctor it names, then the same join.'), at);
        assert.doesNotMatch(`${text}\n${JSON.stringify(data)}`, /Python traceback|as valun 0\.7\.1 did/, `${at}: no 0.7.1 words for the Hermes plugin 0.7.2`);
        assert.ok(LOST_JOIN_HERMES_LOCAL.startsWith('If the plugin\'s join stops with Joining failed (unreachable) after a cut connection or a timeout'), at);
        assert.ok(text.includes('Console is also what a --sandbox join of valun 0.7.2 uses without --approvals.'), at);
        assert.doesNotMatch(text, /the default approvals, ask/, at);
        assert.ok(text.includes(`\n${data.if_join_stops}\n`), at);
        // PC, never credits; the limits in force.
        assert.equal(data.unit, 'PC', at);
        assert.doesNotMatch(text, /\b\d+\s+credits?\b/, at);
        assert.match(text, /at most 5 PC per deal and 40 PC owed in total\. PC have no monetary value\.$/, at);
        // No public host, and a local doc's checker finds nothing (each data string on a line of its own).
        for (const [k, v] of [['text', text], ...strings(data)]) assert.doesNotMatch(v, PUBLIC_HOST, `${at}: ${k}`);
        assert.deepEqual(B.localDocProblems([text, ...strings(data).map(([, v]) => v)].join('\n'), {origin}), [], at);
        // What it says of the client's default, and that a command without the profile acts on the default profile.
        assert.ok(text.startsWith(`This is a local Valun server at ${origin}: a copy of Valun with no chain, running on this machine, not the public network.`), at);
        assert.ok(text.includes('a join without --server, in a profile that has joined nowhere yet, joins the public network'), at);
      }
    }
  }
});

// The image's checks (the local image's CI checks (private)) read a command in the answer's text
// wherever one starts (`uvx --from valun==X valun`, `valun` as a word, `claude mcp add`, `hermes -p P valun`, in that
// order, each match taken whole) and runs to the first bracket, '. ', ', then', '; ' or line end; it is a command when
// its program is followed, after options, by a subcommand. Each such valun command in the text runs in the profile local
// and names this server where it takes --server, and the Hermes join names it, so no sentence reads as a command on the
// default profile or the default server.
test('local: every command the answer\'s text holds, read as the image\'s checks read one, runs in the profile local and names this server where it takes --server', t => {
  if (!needs(t, ...BUILD_FILES)) return;
  const origin = 'http://127.0.0.1:8080', {text} = answerOf(runs.local.hosts['127.0.0.1:8080'].v1);
  const SUBCOMMANDS = new Set([...B.SERVER_COMMANDS, ...B.PROFILE_COMMANDS, 'console']);
  const START = /uvx --from valun==\S+ valun(?![\w=.-])|(?<![\w/.=@-])valun(?![\w=.-])|claude mcp add\b|hermes -p \S+ valun(?![\w=.-])/g;
  const seen = {valun: 0, hermes: 0, claude: 0};
  for (const m of text.matchAll(START)) {
    const rest = text.slice(m.index).split(/[()]|\.\s|\.$|, then|; |\n/)[0];
    if (m[0] === 'claude mcp add') { seen.claude++; continue; }   // its valun command is matched on its own, next
    // The words after the program (`valun` here, the last word of the match).
    const words = rest.slice(m[0].length).trim().split(/\s+/);
    let i = 0;
    while (i < words.length && words[i].startsWith('-')) i += words[i] === '--profile' ? 2 : 1;
    if (!SUBCOMMANDS.has(words[i])) continue;
    if (m[0].startsWith('hermes ')) {
      seen.hermes++;
      if (words[i] === 'join') assert.ok(rest.includes(` --server ${origin} `), `a Hermes join with no --server: ${rest}`);
      continue;
    }
    seen.valun++;
    assert.deepEqual(words.slice(0, 2), ['--profile', 'local'], `no --profile local: ${rest}`);
    if (B.SERVER_COMMANDS.has(words[i])) assert.ok(rest.includes(`--server ${origin}`), `no --server: ${rest}`);
  }
  assert.deepEqual(seen, {valun: 9, hermes: 1, claude: 3}, 'the joins (MCP, shell, alone), claude mcp add twice and the --scope user line, the MCP server, valun_status, the inbox and clearing watch');
});

test('local: the Agent Card (both paths) names this server\'s origin for every Host, describes a local server, and names no public host', t => {
  if (!needs(t, ...BUILD_FILES)) return;   // unpinned: the local docs' checker
  for (const [name, run, origin] of [['local', runs.local, 'http://127.0.0.1:8080'], ['at9000', runs.at9000, 'http://127.0.0.1:9000'], ['https', runs.https, 'https://valun.example']]) {
    for (const [host, h] of Object.entries(run.hosts)) {
      for (const which of ['card', 'cardOld']) {
        const at = `${name} ${host} ${which}`, card = h[which].json;
        assert.equal(h[which].status, 200, at);
        assert.deepEqual(card, run.hosts['127.0.0.1:8080'].card.json, `${at}: one card, whatever the Host`);
        assert.deepEqual(card.supportedInterfaces.map(i => i.url), [`${origin}/a2a`, `${origin}/a2a`], at);
        assert.deepEqual([card.url, card.documentationUrl, card.iconUrl], [`${origin}/a2a`, `${origin}/skill.md`, `${origin}/favicon.svg`], at);
        assert.equal(card.name, 'Valun (local)', at);
        assert.ok(card.description.startsWith(`A local Valun server at ${origin}: a copy of Valun running on this machine, with no chain, not the public network.`), at);
        assert.doesNotMatch(card.description, /test network|So far almost every agent|tERG|\bcredits have\b/i, at);
        assert.deepEqual(card.provider, {organization: 'Valun', url: 'https://github.com/fitzss/valun-open'}, at);
        assert.deepEqual(card.skills.map(s => s.id), ['find-agents', 'find-work', 'join-valun', 'recent-loops'], at);
        assert.ok(card.skills.find(s => s.id === 'recent-loops').description.endsWith(`Each loop has a card at ${origin}/loop/<id>.`), at);
        for (const [k, v] of strings(card, 'card')) assert.doesNotMatch(v, PUBLIC_HOST, `${at}: ${k}`);
        assert.deepEqual(unpinned(strings(card).map(([, v]) => v).join('\n'), origin), [], at);
      }
      assert.deepEqual(h.a2aGet.json, {agent_card: `${origin}/.well-known/agent-card.json`, note: 'POST A2A JSON-RPC requests here (SendMessage, or message/send for A2A 0.3).'}, `${name} ${host}`);
    }
  }
});

test('local: the other skills (find agents, find paid work, recent loops) name only this server, say PC, and say who the agents here are', t => {
  if (!needs(t, ...BUILD_FILES)) return;   // unpinned: the local docs' checker
  const origin = 'http://127.0.0.1:8080', {skills} = runs.local;
  for (const [skill, r] of Object.entries(skills)) {
    for (const gen of ['v1', 'v03']) {
      const {text, data} = answerOf(r[gen]);
      assert.equal(data.skill, skill);
      for (const [k, v] of [['text', text], ...strings(data)]) assert.doesNotMatch(v, PUBLIC_HOST, `${skill} ${gen}: ${k}`);
      assert.doesNotMatch(text, /\b\d+\s+credits?\b|So far almost every agent on the network/, `${skill} ${gen}`);
      assert.deepEqual(unpinned([text, ...strings(data).map(([, v]) => v)].join('\n'), origin), [], `${skill} ${gen}`);
    }
  }
  assert.ok(answerOf(skills['find-agents'].v1).text.includes(`Every agent here joined this server, and exists only on it. To hire one, your agent joins Valun (${origin}/skill.md)`));
  const loops = answerOf(skills['recent-loops'].v1);
  assert.equal(loops.text, `The 1 most recent loop that cancelled out on this server:\n- sandbox-exact -> open-poet -> brief-bot -> sandbox-exact: 2 PC off each debt, 6 PC in all (${origin}/loop/vs_00000000000000aa)`);
  assert.equal(loops.data.loops[0].card_url, `${origin}/loop/vs_00000000000000aa`);
  assert.match(answerOf(skills['find-work'].v1).data.how_to_earn, new RegExp(`^Join Valun \\(${origin.replace(/[.]/g, '\\.')}/skill\\.md\\)`));
});

// R-4's second half, from the agent's side: the answer and the skill.md it links name the same origin for any Host
// (before, the answer named a loopback Host's port and skill.md PUBLIC_ORIGIN's: with the port published as another and
// no VALUN_PUBLIC_ORIGIN, an agent got :9000 from one and :8080 from the other).
test('local: for every Host, the answer\'s origin is the one the skill.md and llms.txt it links name', () => {
  for (const [name, run] of Object.entries(runs)) {
    for (const [host, h] of Object.entries(run.hosts)) {
      const {data} = answerOf(h.v1);
      assert.equal(h.skill.status, 200, `${name} ${host}`);
      assert.equal(h.skill.text, SKILL.replaceAll('{origin}', run.origin), `${name} ${host}: skill-local.md with this server's origin`);
      assert.equal(data.instructions, `${run.origin}/skill.md`, `${name} ${host}`);
      assert.ok(h.llms.text.includes(`${run.origin}/skill.md`) && !h.llms.text.includes('{origin}'), `${name} ${host}: llms.txt`);
    }
  }
});
