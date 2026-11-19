// R-3 (fix inbox #155: the local-readiness audit's FB-3, and the docs halves of FB-5 to FB-10 and FB-16 to FB-18; LD-1):
// every valun command the local docs give a person or an agent to copy runs in a client profile of its own and names
// this server wherever the command takes --server. The client's default server is the public testnet: a join without
// --server, on a profile with no server yet, joins it (the audit's FB-5), and the documented invited join did
// (`valun join --invite-from-stdin`, FB-3). The docs are read as the image's check of a release reads them
// (the local image's CI checks (private), R-10: every line of a fenced block and every code span that is a command):
//   - docs/LOCAL.md, all of it; its one allowed exception is the documented way back to the testnet, on the profile that
//     holds a testnet identity (`valun config server https://valun.tech`, in "If you already have a testnet profile");
//   - the README's local section ("A local server with no chain", up to the next section);
//   - docs/LOCAL-ACCEPTANCE.md, the outsider checklist; its two controls run without --server on purpose;
//   - a local server's skill.md and llms.txt (public/skill-local.md, public/llms-local.txt) as it serves them.
// A valun command is the word `valun` followed by --profile or one of valun 0.7.2's subcommands, wherever it stands in
// a line: after `uvx --from valun==X`, after `--` in `claude mcp add NAME --`, after an image in `docker run ... IMAGE`,
// in an MCP JSON config's args; and a Hermes line, `hermes -p P valun ...`. test/fixtures/local-copyable.mjs, the pages'
// check (R-2), judges each. Beyond that: the joins, the invite and the reset are written as valun 0.7.2 needs them (a
// token file per handle, which it never replaces and its join refuses when it exists: LD-1; only the invite's code on
// stdin), the facts a person needs are there (a proxy and plain http, a client home with VALUN_SERVER, the order the
// client picks a server in, the joins its hints print without --server, install first), and every number is the code's.
// No tracker; pure file reads.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {shellWords, invocationProblems, publicHosts, VALUN_SUBCOMMANDS} from './fixtures/local-copyable.mjs';
import {DEFAULT_MANDATE, SANDBOX_CAPS, SANDBOX_DAYS, INVITE_MANDATE_DAYS, OPEN_NETWORK_MAX_OPEN_OFFERS} from '../lib/pilot/core.mjs';
import {LIMITS as CLEARING_LIMITS, EXPIRIES_TO_EXCLUDE, EXCLUSION_MS} from '../lib/pilot/clearing.mjs';
import {WELCOME, SERVICES} from '../lib/pilot/sandbox.mjs';
import {SCALE} from '../lib/pilot/units.mjs';
import {LOCAL_CLIENT} from '../lib/a2a.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const ORIGIN = 'http://127.0.0.1:8080';
const flat = s => s.replace(/\s+/g, ' ');
const pcOf = n => n / SCALE;
// A whole-number constant a module does not export (as scripts/build-local-docs.mjs reads one).
const constant = (file, name) => Number(new RegExp(`\\b${name} = (\\d+)\\b`).exec(read(file))?.[1] ?? NaN);

// ---------- reading Markdown as the image's check reads it (its sections and snippets) ----------
// [{heading, lines}] of a Markdown file; the part before the first heading has heading ''.
function sections(text) {
  const out = [];
  let head = '', cur = [], fence = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) fence = !fence;
    if (!fence && /^#{1,4} /.test(line)) { out.push({heading: head, lines: cur}); head = line.replace(/^#+\s*/, '').trim(); cur = []; }
    else cur.push(line);
  }
  out.push({heading: head, lines: cur});
  return out;
}
// [{source: 'fenced'|'inline', text}] in document order: each line of a fenced block (continuation lines joined; a JSON
// block as one), and each code span of the prose.
function snippets(lines) {
  const out = [];
  let fence = false, block = [], lang = '';
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('```')) {
      if (!fence) { fence = true; block = []; lang = s.slice(3).trim(); continue; }
      fence = false;
      if (lang === 'json') out.push({source: 'fenced', text: block.join('\n').trim()});
      else for (const l of block.join('\n').replace(/\\\n\s*/g, ' ').split('\n')) if (l.trim()) out.push({source: 'fenced', text: l.trim()});
      continue;
    }
    if (fence) { block.push(line); continue; }
    for (const m of line.replace(/`{3,}/g, '   ').matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) out.push({source: 'inline', text: m[1].trim()});
  }
  return out;
}
// The README's local section: from its heading "A local server with no chain" to the next heading of its level or higher.
function readmeLocal(text) {
  const lines = text.split('\n'), at = lines.findIndex(l => /^## A local server with no chain\b/.test(l));
  if (at < 0) throw new Error('README.md has no section "A local server with no chain"');
  let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(at, end).join('\n');
}

// ---------- the valun commands in a snippet ----------
const ENV = /^[A-Z_][A-Z0-9_]*=/;
const SEP = new Set(['&&', ';', '|', '||']);
// An MCP JSON config's servers, as the command lines they run.
function jsonCommands(text) {
  if (!/^\{\s*"mcpServers"/.test(text)) return null;
  const servers = JSON.parse(text).mcpServers;
  return Object.values(servers).map(c => [c.command, ...c.args].map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a}'`)).join(' '));
}
// Every valun invocation in one command line, as word lists (with the environment assignments right before it); a Hermes
// line is one invocation, its first word 'hermes'.
function invocations(line) {
  const t = shellWords(line);
  if (t[0] === 'hermes') return t.includes('valun') ? [t] : [];
  const out = [];
  t.forEach((w, i) => {
    const next = t[i + 1] ?? '';
    if (w !== 'valun' || !(next === '--profile' || next.startsWith('--profile=') || VALUN_SUBCOMMANDS.has(next))) return;
    let from = i, end = t.length;
    while (from > 0 && ENV.test(t[from - 1])) from--;
    for (let j = i + 1; j < t.length; j++) if (SEP.has(t[j])) { end = j; break; }
    out.push(t.slice(from, end));
  });
  return out;
}
// Each command of a document: {doc, section, source, text, words (one invocation)}. A code span that begins with "... "
// right after a command is that command's prefix (up to its --profile NAME) with the rest, as the image's check reads it
// (the local image's CI checks, private): "`uvx --from valun==0.7.1 valun --profile local status` and `... doctor`"
// gives a doctor.
// A code span's sentences (`sentences`: every sentence of its section's prose that holds it) come with it, so that a bare
// `valun SUBCOMMAND` can be judged by what its sentence says (docProblems).
function commandsOf(doc, text) {
  const out = [];
  let prefix = null;
  for (const {heading, lines} of sections(text)) {
    for (const s of snippets(lines)) {
      const line = s.text.startsWith('... ') && prefix ? `${prefix} ${s.text.slice(4)}` : s.text;
      for (const l of jsonCommands(line) ?? [line]) {
        for (const words of invocations(l)) {
          out.push({doc, section: heading, source: s.source, text: s.text, words, sentences: s.source === 'inline' ? sentencesWith(lines, s.text) : []});
          const p = /^(.*?--profile \S+)/.exec(l);
          if (p) prefix = p[1];
        }
      }
    }
  }
  return out;
}
const COMMAND_LINE = /^(uvx |valun |docker |curl |hermes |claude mcp |codex mcp |export |pipx |uv tool |npm |git |\{"mcpServers")/;
// The sentences of a section's prose (its fenced blocks left out), each on one line: a sentence ends at a full stop
// followed by a space.
function proseSentences(lines) {
  let fence = false;
  const prose = lines.filter(l => { if (l.trim().startsWith('```')) { fence = !fence; return false; } return !fence; }).join('\n');
  return flat(prose).split(/(?<=\.) /);
}
const sentencesWith = (lines, span) => proseSentences(lines).filter(x => x.includes(`\`${span}\``));
// A bare `valun SUBCOMMAND` in prose (no profile, nothing after it) names a command; the reader may still run it as written.
// It is a mention, not a command, only in a sentence that says it is for the public network (`valun audit` and the
// `valun ergo` commands are for the public testnet). `valun doctor` never is: a reader checking a Reset runs it, and on the
// default profile it reads the public testnet (the review of local/readiness-r1, FH-2: LOCAL.md's Reset gave it bare).
const FOR_PUBLIC = /\bfor the public (testnet|network)\b/;
const mention = c => c.source === 'inline' && c.words.length === 2 && c.words[0] === 'valun' && c.words[1] !== 'doctor'
  && c.sentences.length > 0 && c.sentences.every(x => FOR_PUBLIC.test(x));

// ---------- the documents ----------
// docs/LOCAL.md, the README and the checklist are not in the hosted image's copy of the app (VALUN_APP_COPY=image: its
// Dockerfile copies lib/, public/ and test/, not docs/ or README.md). There a test that reads them is skipped, with the
// reason, as test/operations.test.mjs skips one; anywhere else a missing one fails it (needs). So they are read when a
// test first needs them, never as this file loads.
const DOC_FILES = ['docs/LOCAL.md', 'README.md', 'docs/LOCAL-ACCEPTANCE.md'];
function needs(t, ...files) {
  const missing = files.filter(f => !fs.existsSync(path.join(root, f)));
  if (!missing.length) return true;
  if (process.env.VALUN_APP_COPY !== 'image') assert.fail(`missing ${missing.join(', ')}`);
  t.skip(`needs ${missing.join(', ')}, which the container image's copy of the app does not have (VALUN_APP_COPY=image)`);
  return false;
}
let loaded = null;
function load() {
  if (loaded) return loaded;
  const LOCAL = read('docs/LOCAL.md'), README = read('README.md'), CHECKLIST = read('docs/LOCAL-ACCEPTANCE.md');
  const SKILL = read('public/skill-local.md').replaceAll('{origin}', ORIGIN), LLMS = read('public/llms-local.txt').replaceAll('{origin}', ORIGIN);
  const DOCS = {'docs/LOCAL.md': LOCAL, 'the README\'s local section': readmeLocal(README), 'docs/LOCAL-ACCEPTANCE.md': CHECKLIST,
    'skill-local.md (served)': SKILL, 'llms-local.txt (served)': LLMS};
  loaded = {LOCAL, README, CHECKLIST, SKILL, LLMS, DOCS};
  return loaded;
}
// The documented way back to the testnet (on the profile that holds a testnet identity, never the local one), and the
// checklist's two controls (they show that the tripwire catches a command with no server).
const ALLOWED = new Set([
  'docs/LOCAL.md|If you already have a testnet profile|valun config server https://valun.tech',
  'docs/LOCAL-ACCEPTANCE.md|3. Set the client tripwire|valun --profile tripwire-check doctor',
  'docs/LOCAL-ACCEPTANCE.md|9. Network isolation|valun --profile probe doctor']);
const allowed = c => ALLOWED.has(`${c.doc}|${c.section}|${c.text}`);

// Every problem of the local docs (the test below, and its check of itself on the old docs).
function docProblems(docs = load().DOCS, origin = ORIGIN) {
  const problems = [];
  for (const [doc, text] of Object.entries(docs)) {
    for (const c of commandsOf(doc, text)) {
      if (allowed(c)) continue;
      for (const p of invocationProblems(c.words, origin, {inline: mention(c)})) problems.push(`${doc} (${c.section || 'top'}): ${p}`);
    }
    for (const {heading, lines} of sections(text)) {
      for (const s of snippets(lines)) {
        if (!COMMAND_LINE.test(s.text) || allowed({doc, section: heading, text: s.text})) continue;
        for (const h of publicHosts(s.text)) problems.push(`${doc} (${heading || 'top'}): a command names ${h}: ${s.text.slice(0, 160)}`);
      }
      // VALUN_PROFILE alone moves a session to another profile, not to this server: on a profile with no server yet, a
      // line that names no server goes to the public testnet, which is what the Valun plugin's own skill gives (the
      // review of local/readiness-r1, FH-1: "start that session with VALUN_PROFILE=local" joined it). So VALUN_PROFILE=
      // is never offered without VALUN_SERVER= in the same sentence or command line.
      for (const x of [...proseSentences(lines), ...snippets(lines).filter(s => s.source === 'fenced').map(s => s.text)]) {
        if (x.includes('VALUN_PROFILE=') && !x.includes('VALUN_SERVER=')) problems.push(`${doc} (${heading || 'top'}): VALUN_PROFILE without VALUN_SERVER: ${x.slice(0, 200)}`);
      }
    }
  }
  return problems;
}

test('R-3: every valun command in LOCAL.md, the README\'s local section, the checklist and the served skill.md runs in a local profile and names this server where it takes --server', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  assert.deepEqual(docProblems(), []);
  // The check saw the commands: each document gives several (the README's local section its join, tour and invited
  // join), and the joins of each are among them.
  for (const [doc, text] of Object.entries(DOCS)) {
    const n = commandsOf(doc, text).length;
    if (doc.startsWith('llms')) continue;
    assert.ok(n >= (doc.startsWith('the README') ? 3 : 10), `${doc}: ${n} valun commands found`);
    assert.ok(commandsOf(doc, text).some(c => c.words.includes('join')), `${doc} gives a join`);
  }
  // The allowed exceptions are still where they are, each once (an exception nothing matches allows nothing).
  for (const key of ALLOWED) {
    const [doc, section, text] = key.split('|');
    assert.equal(commandsOf(doc, DOCS[doc]).filter(c => c.section === section && c.text === text).length, 1, key);
  }
});

test('R-3 checks what it should: the old docs\' invited join, a doctor or a tour without --server, a command outside a local profile, a public host in a command', () => {
  const doc = body => ({'docs/LOCAL.md': `## Many agents\n\n${body}\n`});
  for (const [body, want] of [
    ['- and join with `valun join --invite-from-stdin`.', /no --profile: valun join --invite-from-stdin/],
    ['- and join with `valun join --invite-from-stdin`.', /no --server http:\/\/127\.0\.0\.1:8080: valun join --invite-from-stdin/],
    ['```\nuvx --from valun==0.7.1 valun --profile local doctor\n```', /no --server/],
    ['- `uvx --from valun==0.7.1 valun --profile local status` and `... doctor`.', /no --server http:\/\/127\.0\.0\.1:8080: valun --profile local doctor$/m],
    ['```\nuvx --from valun==0.7.1 valun --profile local sandbox tour --yes\n```', /no --server/],
    ['```\nuvx --from valun==0.7.1 valun call valun_status\n```', /no --profile/],
    ['```\nuvx --from valun==0.7.1 valun --profile agent-2 call valun_status\n```', /not a local profile \(agent-2\)/],
    ['```\ndocker run --rm --network container:valun-local client valun --profile local join --sandbox --handle X\n```', /no --server/],
    ['```\nhermes -p valun-local valun join --sandbox --handle X\n```', /a Hermes join with no --server/],
    ['```\nuvx --from valun==0.7.1 valun --profile local join --sandbox --server https://valun.tech --handle X\n```', /names another server \(https:\/\/valun\.tech\)/],
    ['```\ncurl -s https://valun.tech/pilot/v1/info\n```', /a command names valun\.tech/],
    ['```json\n{"mcpServers": {"v": {"command": "uvx", "args": ["--from", "valun==0.7.1", "valun", "mcp"]}}}\n```', /no --profile: uvx --from valun==0\.7\.1 valun mcp|no --profile: valun mcp/]]) {
    assert.match(docProblems(doc(body)).join('\n'), want, body);
  }
  // A bare `valun SUBCOMMAND` is a mention only in a sentence that says it is for the public network, and `valun doctor`
  // never is (FH-2: LOCAL.md's Reset said "`valun doctor` reports tracker_mismatch", which run as written reads the
  // public testnet); the switch back is allowed only where it is documented.
  assert.deepEqual(docProblems(doc('Here `valun audit` and the `valun ergo` commands are for the public testnet.')), []);
  for (const [body, want] of [
    ['- a profile from before no longer works (`valun doctor` reports `tracker_mismatch`).', [/no --profile: valun doctor/, /no --server http:\/\/127\.0\.0\.1:8080: valun doctor/]],
    ['- `valun doctor` is for the public testnet.', [/no --server http:\/\/127\.0\.0\.1:8080: valun doctor/]],
    ['- the plugin runs `valun mcp` in the default profile.', [/no --profile: valun mcp/]],
    ['- `valun audit` is for the public testnet. Then `valun audit` checks this server.', [/no --profile: valun audit/]]]) {
    for (const w of want) assert.match(docProblems(doc(body)).join('\n'), w, body);
  }
  assert.match(docProblems(doc('```\nvalun config server https://valun.tech\n```')).join('\n'), /points a profile at another server/);
  // VALUN_PROFILE is offered only with VALUN_SERVER (FH-1: the old line, and its forms).
  for (const body of ['- turn it off, or start that Claude Code session with `VALUN_PROFILE=local`: its MCP server runs in the default profile.',
    '- start the app with VALUN_PROFILE=local.', '```\nexport VALUN_PROFILE=local\n```']) {
    assert.match(docProblems(doc(body)).join('\n'), /VALUN_PROFILE without VALUN_SERVER/, body);
  }
  for (const body of ['- start it with `VALUN_PROFILE=local` and `VALUN_SERVER=http://127.0.0.1:8080`.', '```\nexport VALUN_PROFILE=local VALUN_SERVER=http://127.0.0.1:8080\n```',
    '- run it where `VALUN_PROFILE` is not set.']) {
    assert.deepEqual(docProblems(doc(body)), [], body);
  }
});

// valun 0.7.2's joins as the docs write them: this profile and this server, a token file of its own per handle (valun
// never replaces a file, and 0.7.2's join refuses one that exists before anything is sent: "Nothing was sent", exit 2,
// cli.py _token_file_refusal; LD-1), the approvals, always written (0.7.2's --sandbox join without them uses console).
test('R-3: every join is written in full: --sandbox or --invite-from-stdin, a handle, an operator, a new token file per handle, and console or none approvals', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  let joins = 0;
  for (const [doc, text] of Object.entries(DOCS)) {
    for (const c of commandsOf(doc, text).filter(x => x.words[0] !== 'hermes' && x.words.includes('join') && !x.words.includes('...'))) {
      joins++;
      const w = c.words, arg = k => w[w.indexOf(k) + 1];
      assert.ok(w.includes('--sandbox') !== w.includes('--invite-from-stdin'), `${doc}: ${c.text}`);
      assert.equal(arg('--server'), ORIGIN, `${doc}: ${c.text}`);
      assert.match(arg('--handle') ?? '', /^(YOUR-HANDLE|HANDLE-[A-Z]+)$/, `${doc}: ${c.text}`);
      assert.ok(w.includes('--operator'), `${doc}: ${c.text}`);
      assert.match(arg('--approvals') ?? '', /^(console|none)$/, `${doc}: ${c.text}`);
      const file = arg('--owner-token-file') ?? '';
      if (doc === 'docs/LOCAL-ACCEPTANCE.md') assert.ok(file === `$HOME/valun-local-owner-token-${arg('--handle')}.txt` || /^\/agents\/\w+-token\.txt$/.test(file), `${doc}: ${c.text}`);
      else assert.equal(file, '$HOME/valun-local-owner-token-YOUR-HANDLE.txt', `${doc}: ${c.text}`);
    }
  }
  assert.ok(joins >= 10, `${joins} joins`);
  // No join, anywhere in these docs, writes the token to a file that a second join would find again.
  for (const [doc, text] of Object.entries(DOCS)) assert.doesNotMatch(text, /--owner-token-file "?local-owner-token\.txt/, doc);
});

// The invite: valun's join --invite-from-stdin sends the whole first line it reads as the code, so the docs give
// the invite command that prints only the code (scripts/pilot-admin.mjs --code-only); the image's check runs the docs'
// first invite command and pipes its first line into their invited join, once as pasted and once whole.
test('R-3: every invite prints only its code, the first one in LOCAL.md and the README is good for several joins, and comes before any listing of the invites', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  for (const [doc, text] of Object.entries(DOCS)) {
    for (const m of text.matchAll(/pilot-admin\.mjs invite\b(?!s)[^`\n|]*/g)) assert.match(m[0], /--code-only/, `${doc}: ${m[0]}`);
  }
  for (const doc of ['docs/LOCAL.md', 'the README\'s local section']) {
    const text = DOCS[doc], first = /docker exec CONTAINER node scripts\/pilot-admin\.mjs invite\b(?!s)[^`\n|]*/.exec(text);
    assert.ok(first, `${doc} gives an invite`);
    assert.ok(Number(/--uses (\d+)/.exec(first[0])?.[1]) >= 2, `${doc}: ${first[0]}`);
    const list = text.indexOf('pilot-admin.mjs invites');
    assert.ok(list < 0 || list > first.index, `${doc}: the invite comes before the listing of the invites`);
    // The invited join itself, on stdin, never with the code on a command line.
    assert.ok(commandsOf(doc, text).some(c => c.words.includes('--invite-from-stdin') && c.words.includes('--server')), doc);
    assert.doesNotMatch(text, /(echo|printf)[^`\n]*vpi_|--invite vpi_/, doc);
  }
  // The image's check gives each join a handle of its own, the invited one included, and checks the tour's set-off for
  // the latest: in each document the invited join comes after its tour and every agent page it names.
  for (const doc of ['docs/LOCAL.md', 'the README\'s local section', 'skill-local.md (served)']) {
    const text = DOCS[doc], at = text.search(/join --invite-from-stdin/);
    assert.ok(at > 0, doc);
    for (const later of [' sandbox tour --', `${ORIGIN}/agent/`]) assert.ok(text.indexOf(later, at) < 0, `${doc}: ${later.trim()} only before the invited join`);
  }
});

test('R-3: the README\'s local section has no config-server route ("works too": FB-9), and points to LOCAL.md and the checklist, which the image carries', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const local = DOCS['the README\'s local section'];
  assert.doesNotMatch(local, /works too|valun config server/);
  assert.ok(flat(local).includes('`docs/LOCAL-ACCEPTANCE.md` is the checklist an outsider runs against a release. The image carries both, and this file, in `/opt/valun`.'));
  assert.ok(flat(local).includes('On a profile that has not joined, a join valun 0.7.2 prints without `--server` goes to the public testnet: run the join above instead'));
  // Plain http only to this machine (valun 0.7.2 client.py PLAIN_HTTP_ENV), and where LOCAL.md says more.
  // The opt-in alone is not enough: the server takes writes only for its own origin or a loopback name (lib/pilot/http.mjs
  // localWriteRefusal: host_not_allowed), so the README points to the server's namespace, not to VALUN_ALLOW_PLAIN_HTTP.
  assert.ok(flat(local).includes('valun 0.7.2 sends tokens over plain http only to this machine (`127.0.0.1`, `localhost`), and the server takes writes only for its own origin or a loopback name: an agent in another container runs in the server\'s network namespace (`--network container:`), where `127.0.0.1` is the server'));
  assert.doesNotMatch(local, /VALUN_ALLOW_PLAIN_HTTP/, 'the README does not offer the opt-in, which alone gets 403 host_not_allowed');
  // The package is public, the image optional (Fitz's decision of Nov 19: testers onboard with uvx or pipx; the skill
  // says not a plain pip install).
  assert.ok(flat(local).includes('**Status:** the package is public: pulling it needs no login. It is optional: an agent joins the public testnet with the client alone (valun 0.7.2, with uvx, or pipx: pip in a virtual environment).'));
  assert.doesNotMatch(local, /unauthorized|is private|Once the image is public/);
  assert.ok(flat(local).includes('their source isn\'t public yet (fix inbox #99)'), 'the tracker fork\'s source is still not public');
});

// What a person needs and the audit found missing (FB-5, FB-6, FB-8, FB-10, FB-16, FB-17, FB-18; SRV-4, SRV-5, SRV-9,
// SRV-10, SRV-16; CLI-3, CLI-5, CLI-6, CLI-8, CLI-9, CLI-10, CLI-15, CLI-16; IMG-1, IMG-6, IMG-10, IMG-11, IMG-12, IMG-13,
// IMG-15; MR-2, MR-7, MR-8, MR-10, MR-11, MR-13, MR-14, MR-15, MR-16; COV-4, COV-12), each where LOCAL.md says it.
test('R-3: LOCAL.md says how to keep the public network out: the server order, VALUN_HOME with VALUN_SERVER, 0.7.2\'s hints, a refused join, owner commands, install first, a proxy, plain http', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const s = flat(LOCAL);
  for (const sentence of [
    'A command picks its server in this order: its own `--server`; else the server its profile joined; else `VALUN_SERVER`; else the public testnet.',
    // valun 0.7.2's hints name the profile, and --server where the command knows this server (cli.py _join_command,
    // _sandbox_join, _server_flag); on a profile that has not joined, call's and mcp's name none without VALUN_SERVER, and
    // the tour's "not joined yet" line never does (cli.py _server, cmd_sandbox).
    '**valun 0.7.2\'s printed hints name the profile, and the server where they know it.**',
    'On a profile that has not joined, `call` and `mcp`, which take no `--server`, print a join without it unless `VALUN_SERVER` is set, and the "not joined yet" line of the tour, `clearing`, `attempts`, `profile`, `card`, `verify-check`, `audit --mine`, `ergo` and `sell` names a bare join (no `--server`) in any case, even when the command itself was given `--server`: run as printed, such a join goes to the public testnet. Run this page\'s join line instead.',
    // valun 0.7.2's join prints only `Joining failed (<code>): <message>` for a 429, never retry_after_ms (cli.py
    // _join_refused; F2 of the branch's review): the wait it can show is the one the message names, in minutes.
    '**After a refused join** (`429 rate_limited` past a join cap) the profile holds nothing, not even a server. valun prints only the server\'s message (`Joining failed (rate_limited): ...`), which says how many minutes to wait (the HTTP answer\'s `retry_after_ms`): wait that long, then run the same join line again.',
    'It never overrides the server a profile joined, and valun\'s status ignores it',
    '**Owner commands** send your owner token to the profile\'s server, so they take the profile and the server too',
    'install the client first, or run uvx once with network and then set `UV_OFFLINE=1`',
    // A proxy: valun 0.7.2 reaches this machine directly (client.py _ServerProxyHandler, loopback_host); other tools may
    // not, and the JS client refuses a token through Node's environment proxy (js client.js nodeRoute).
    '**Behind a proxy.** valun 0.7.2 reaches a server on this machine (`127.0.0.1`, `localhost` or `::1`) directly, never through a proxy, whatever `HTTP_PROXY`, `http_proxy` or the system\'s proxy settings (Windows, macOS) say',
    'the JavaScript client under Node\'s environment proxy (`NODE_USE_ENV_PROXY=1`) refuses to send a token there until `NO_PROXY` names this machine',
    'Node\'s `fetch` ignores the proxy variables unless `NODE_USE_ENV_PROXY=1` is set.',
    // Plain http only to this machine, unless the client's environment opts in (client.py PLAIN_HTTP_ENV).
    'valun 0.7.2 sends a token over plain http (and a join or an enrollment, whose answers carry one) only to a server on this machine: `http://127.0.0.1:8080` and `http://localhost:8080` work as written.',
    'is refused before anything is sent (`plain_http`), unless `VALUN_ALLOW_PLAIN_HTTP=1` is set in that client\'s environment. Set it only on a network you trust',
    // The package is public; the image is optional (Fitz's decision of Nov 19).
    'The image is optional: an agent joins the public testnet with the client alone (valun 0.7.2, with uvx, or pipx: pip in a virtual environment). The package `ghcr.io/fitzss/valun-local` is public, so `docker pull` and the `docker run` below need no login.',
    // A console join links to the public network's page about approvals (valun 0.7.2 cli.py CONSOLE_DOC): a page to read.
    'Join\'s console line links to the public network\'s page about approvals (`https://valun.tech/start#approve`), a page to read and never a request; this server\'s own is `http://127.0.0.1:8080/start#approve`.',
    // The plugin off, and no VALUN_PROFILE=local instead: its skill's join and doctor name no server (FH-1).
    'If the Valun plugin for Claude Code is installed, turn it off while you use this server. The plugin is for the public testnet: its MCP server runs in the default profile, with tools of the same names as the local server\'s, and its skill tells the agent to join and run doctor with lines that name no server, which on a profile with no server yet reach the public testnet.',
    '`/loop 15m check my local Valun inbox with mcp__valun-local__valun_inbox and handle what is waiting within my limits`',
    'this server\'s `/skill.md` gives its lines, in a Hermes profile of its own that names this server; they have not been run against a local server yet.']) {
    assert.ok(s.includes(sentence), sentence);
  }
  assert.ok(LOCAL.includes('```\nexport NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost\n```'));
  assert.ok(LOCAL.includes(`\`\`\`\nuv tool install ${LOCAL_CLIENT}\nvalun --version\n\`\`\``));
  assert.doesNotMatch(LOCAL, /authentication \(`unauthorized`\)|is private while|docker login/, 'no line says the package is private');
  assert.ok(flat(LOCAL).includes('**Not public yet:** the tracker fork\'s source and its build recipe (fix inbox #99).'), 'the fork\'s source is still not public');
  assert.ok(LOCAL.includes('  export VALUN_HOME="$HOME/valun-agents/agent-2" VALUN_SERVER=http://127.0.0.1:8080\n'), 'one client home per agent, with this server');
  assert.ok(s.includes('In one home, a second agent\'s join in the profile `local` is refused (`Profile \'local\' is already connected`)'));
});

test('R-3: LOCAL.md\'s many agents, script, isolation and inspection parts: the invited defaults, the operator\'s mandate, pair_busy, the practice agents, the bounds, the calls, the JS client, the networks, the data and admin', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const s = flat(LOCAL), I = DEFAULT_MANDATE, S = SANDBOX_CAPS;
  // The invited defaults beside the self-serve ones, from the code (Pilot.join, joinSandbox).
  for (const row of [`| Per deal, as payer and as payee | ${pcOf(I.max_issue_per_deal)} PC | ${pcOf(S.max_issue_per_deal)} PC |`,
    `| Owed in total | ${pcOf(I.max_issue_outstanding)} PC | ${pcOf(S.max_issue_outstanding)} PC |`,
    `| Accepted from one issuer | ${pcOf(I.max_accept_per_issuer)} PC | ${pcOf(S.max_accept_per_issuer)} PC |`,
    `| How long | its mandate ends ${INVITE_MANDATE_DAYS} days after the join, unless its owner moves it | ${SANDBOX_DAYS} days, renewed while its agent is active |`]) {
    assert.ok(LOCAL.includes(row), row);
  }
  assert.equal(I.max_accept_per_deal, I.max_issue_per_deal, 'one figure per deal, as payer and as payee');
  assert.equal(S.max_accept_per_deal, S.max_issue_per_deal);
  assert.ok(s.includes(`at most ${pcOf(S.max_issue_per_deal)} PC per deal and ${pcOf(S.max_issue_outstanding)} PC owed in total, ${pcOf(S.max_accept_per_issuer)} PC accepted from one issuer, and ${OPEN_NETWORK_MAX_OPEN_OFFERS} open offers of its own at once, for ${SANDBOX_DAYS} days`));
  assert.ok(s.includes(`\`uvx --from ${LOCAL_CLIENT} valun --profile local config consents.as_new_creditor on --server http://127.0.0.1:8080\``));
  // An invited agent's MCP server signs no set-off in the background until its consent loop is on (valun 0.7.2's invited
  // join writes consent_loop off, and `valun mcp` then signs only before a tool that commits: F4 of the branch's review),
  // and the clearing engine leaves out an agent after so many expiries in a row (clearing.mjs).
  assert.ok(s.includes('| Set-offs and transfers of its own debt | its client signs them when it runs a call or `clearing watch`; its MCP server, once its consent loop is on (below) | its client signs them by itself; its MCP server in the background |'));
  assert.ok(s.includes(`after ${EXPIRIES_TO_EXCLUDE} set-offs in a row expire unsigned, an agent is left out of set-offs for ${EXCLUSION_MS / 3600e3} hours. Turn the loop on in each invited agent's profile before its MCP server starts: \`uvx --from ${LOCAL_CLIENT} valun --profile local config consent_loop on --server http://127.0.0.1:8080\`.`));
  // The operator raises one participant's limits (scripts/pilot-admin.mjs mandate: PUT /admin/participants/{vp}/mandate),
  // the payer's and the payee's sides (checkMandate: max_accept_per_deal for a payee). Then the owner's own changes are
  // refused until every field is back in the box (core.mjs setMandate checks the whole mandate against SANDBOX_CAPS: F3 of
  // the branch's review, which said "its owner can lower the limits again").
  assert.ok(s.includes('`docker exec CONTAINER node scripts/pilot-admin.mjs mandate <id> \'{"max_issue_per_deal": 25, "max_issue_outstanding": 200, "max_accept_per_deal": 25, "max_accept_per_issuer": 200}\'`'));
  assert.ok(s.includes('A deal needs both sides\' limits, the payer\'s to issue (`max_issue_...`) and the payee\'s to accept (`max_accept_...`), so a larger deal between two self-serve agents needs both of them raised.'));
  assert.ok(s.includes(`While any of its limits is above a self-serve agent's (${pcOf(S.max_issue_per_deal)} PC per deal, ${pcOf(S.max_issue_outstanding)} PC owed, ${pcOf(S.max_accept_per_issuer)} PC accepted from one issuer), every change its owner makes to its mandate is refused (\`403 sandbox_only\`), the approvals mode included (\`config approvals\` changes the mandate too), until one change brings all of them back within those, or the operator does.`));
  assert.doesNotMatch(s, /its owner can lower the limits again/);
  // One note at a time per key pair (core.mjs PAIR_BUSY_RETRY_MS), the practice agents' welcome job and purchases, the
  // clearing engine's bounds (clearing.mjs LIMITS).
  assert.ok(s.includes(`\`409 pair_busy\` with \`retry_after_ms\` (${constant('lib/pilot/core.mjs', 'PAIR_BUSY_RETRY_MS') / 1000} seconds)`));
  assert.ok(s.includes(`one welcome job (${pcOf(WELCOME.price)} PC)`) && WELCOME.price === SERVICES['text-stats'].price);
  assert.ok(s.includes(`(at most ${constant('lib/pilot/sandbox.mjs', 'PURCHASES_PER_STRANGER_PER_DAY')} a day from one agent)`));
  assert.ok(s.includes(`loops of 2 to ${CLEARING_LIMITS.max_cycle_length} IOUs, with at most ${CLEARING_LIMITS.max_collecting_per_participant} set-offs collecting signatures for one agent and ${CLEARING_LIMITS.max_collecting_total} in all`));
  assert.ok(s.includes('`-e PILOT_SANDBOX=0` stops them, and self-serve joins with them (`503 sandbox_unavailable`)'));
  // A script: the approval modes, the owner API, the four calls of a job (templates: the image's check runs none), the
  // JavaScript client with no default server.
  assert.ok(s.includes('GET `/pilot/v1/owner` lists the approvals waiting (state `pending`), and POST `/pilot/v1/owner/approvals/<id>` with `{"decision": "approve"}` decides one'));
  for (const tool of ['valun_propose', 'valun_respond', 'valun_deliver', 'valun_review_delivery']) assert.ok(LOCAL.includes(`valun --profile local call ${tool} '`), tool);
  assert.ok(s.includes(`\`@fitzdoud/valun\` ${LOCAL_CLIENT.replace('valun==', '')} (npm, no dependencies)`) && LOCAL.includes("server: 'http://127.0.0.1:8080'"));
  // A script writes the approvals (0.7.2's --sandbox join without them uses console), a tool's JSON in a file on Windows
  // (cli.py call --json-file), and a lost answer as 0.7.2 gives it (unreachable, outcome unknown).
  assert.ok(s.includes('and write the flag: valun 0.7.2\'s `join --sandbox` without it uses console, so a script that approves nothing waits.'));
  assert.ok(s.includes(`\`uvx --from ${LOCAL_CLIENT} valun --profile local call TOOL --json-file args.json\`, or \`-\` for standard input.`));
  assert.ok(s.includes('(valun 0.7.2 answers it `unreachable` with `"outcome": "unknown"`)'));
  // Isolation: link checks off, an agent's container in the server's namespace, a sealed server, neighbours, host
  // networking, servers side by side.
  for (const part of [`\`uvx --from ${LOCAL_CLIENT} valun --profile local config check_link_hosts off --server http://127.0.0.1:8080\``,
    '`--network container:valun-local` puts an agent\'s container in the server\'s own network namespace',
    '`docker run -d --name valun-sealed --network none -v valun-sealed:/data ghcr.io/fitzss/valun-local:latest`',
    // A network of the server's own, its agents in its namespace: an agent on that network names the server by its name
    // or address, and the server refuses its writes (F1 of the branch's review: "--network valun-lab for each").
    'give the server a network that no other container joins (`docker network create valun-lab`, then `--network valun-lab` in the server\'s `docker run` line only), and run its agents in its namespace with `--network container:` as above.',
    'unless you add `-e HOST=127.0.0.1`', 'each needs its own port and origin, its own volume and its own name', 'never run two servers on one volume']) {
    assert.ok(s.includes(part), part);
  }
  // Inspection: the reads, the logs, the data's files, admin through docker exec.
  for (const part of ['`GET http://127.0.0.1:8080/pilot/v1/ledger`', '`GET http://127.0.0.1:8080/pilot/v1/participants?all=1`', 'add `?before=` and a loop\'s id',
    '`docker exec CONTAINER tail -n 50 /data/pilot/tracker/stdout.log`', '`stdout.log.1`', '`docker exec CONTAINER ls /data/pilot /data/pilot/tracker`',
    '`pilot-state.json`', '`pilot-audit.jsonl`', '`pilot-edge-log.jsonl`', '`image-revision`', '`--log-opt max-size=10m --log-opt max-file=3`',
    '`docker exec CONTAINER node scripts/pilot-admin.mjs invites`', '`docker exec CONTAINER node scripts/pilot-admin.mjs clearing status --json`',
    '`docker exec CONTAINER node scripts/pilot-admin.mjs clearing run --json`', '`403 admin_loopback_only`']) {
    assert.ok(s.includes(part), part);
  }
  assert.doesNotMatch(s, /--network valun-lab` for each/);
  // The data's files: those there from the first start, and the three that come later (F6 of the branch's review: the
  // journal and the signer's records only once there is an IOU, lib/pilot/journal.mjs flushEdgeLog and sandbox.mjs
  // saveRecords; the join key with the first self-serve join, core.mjs takeSandboxJoinSlot).
  assert.ok(s.includes('Later: `sandbox-join-key` (the key that hashes the addresses joins come from) with the first self-serve join, `pilot-edge-log.jsonl` (the journal of each IOU edge) with the first IOU, and `sandbox-records.json` (what the server signed for the practice agents) once one of them has signed an IOU.'));
  // status prints its label padded to a column (valun 0.7.2 cli.py cmd_status), so no doc quotes `server: URL` as one string (F10).
  assert.doesNotMatch(LOCAL, /`server: http/);
});

// LD-1 (found by the image's check): LOCAL.md's Reset said to remove local.json and run the join line again, and valun
// never replaces the token file that line names (0.7.1 then printed the new owner token and exited 1; 0.7.2 sends
// nothing and exits 2), so the Reset says to remove it too. The Reset
// is one paragraph (the image's check reads it as the paragraph around `docker volume rm valun-local`: the files it says
// to remove, whether to join again, the messages it says doctor and join give a profile from before).
test('R-3: LOCAL.md\'s Reset works with valun 0.7.2: wait until the container is gone, remove the profile\'s file and its token file, join again with --server, or a new client home', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const lines = LOCAL.split('\n'), at = lines.findIndex(l => l.startsWith('- **Reset everything:**'));
  let end = at + 1;
  while (end < lines.length && /^ {2}\S/.test(lines[end])) end++;
  const item = flat(lines.slice(at, end).join(' '));
  assert.ok(item.startsWith('- **Reset everything:** stop the container and wait until `docker ps -a` no longer lists it'), item);
  // The doctor it names is the full command, in the profile local and naming this server (FH-2: a bare `valun doctor`,
  // run as written, read the public testnet).
  for (const part of ['then `docker volume rm valun-local`.', `its doctor, \`uvx --from ${LOCAL_CLIENT} valun --profile local doctor --server http://127.0.0.1:8080\`, reports \`tracker_mismatch\` and \`unauthorized\`, and \`join\` refuses it as already connected.`,
    'Remove that profile\'s file, `local.json` in its profiles folder (above), and the owner token file its join wrote (`$HOME/valun-local-owner-token-YOUR-HANDLE.txt`): valun never replaces a file, and its join refuses one that exists before anything is sent.',
    'Then run the join line above again, `--server` included', 'Or start each agent over in a new client home, a `VALUN_HOME` of its own.']) {
    assert.ok(item.includes(part), part);
  }
  // The token file the Reset names is the one the First use join writes, and LOCAL.md has one Reset.
  const first = commandsOf('docs/LOCAL.md', LOCAL).find(c => c.words.includes('join'));
  assert.equal(first.words[first.words.indexOf('--owner-token-file') + 1], '$HOME/valun-local-owner-token-YOUR-HANDLE.txt');
  assert.equal(LOCAL.match(/docker volume rm /g).length, 1);
});

test('R-3: LOCAL.md says what a local server cannot show, and how it is tested', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const s = flat(LOCAL);
  for (const part of ['**Anything on a chain:**', '**The testnet\'s units:**', '**The public network\'s population and operator:**',
    '**Limits as the public network applies them:**', '**The hosted testnet\'s throughput:**', '**Time:**',
    '**Agents on other machines, or in containers on a plain Docker network:**', '**What real agent apps and browsers do:**',
    '**Other Docker setups:**', '**Durability after a crash:**', '**Upgrades from images that do not exist yet:**',
    // How the image's CI runs the docs and the checklist (the local image's CI checks (private): the README and
    // LOCAL.md each on a fresh volume, the served skill.md on LOCAL.md's server; its outsider job runs the checklist the
    // image carries, /opt/valun/docs/LOCAL-ACCEPTANCE.md, each step's commands as written (fix inbox #163); every workflow
    // is dispatched by hand: F7 of the branch's review).
    'its workflows are dispatched by hand for the candidate\'s digest',
    'the commands of the README\'s local section and of this page, each on a fresh volume, then those of the served `/skill.md` on this page\'s server, as written and in order',
    'the outsider checklist from a job with no private access: the job runs `docs/LOCAL-ACCEPTANCE.md` as the image carries it, each step\'s commands as written.',
    // Agents that reach the server by another name: valun 0.7.2 sends no token over plain http there (PLAIN_HTTP_ENV).
    'and valun 0.7.2 sends tokens over plain http only to its own machine (unless `VALUN_ALLOW_PLAIN_HTTP=1` is set), so such a test needs `--network container:` or TLS in front of the server.']) {
    assert.ok(s.includes(part), part);
  }
});

// The checklist the image's CI runs (the local image's CI checks (private)): the same steps, in the
// same order, under the same titles, so that a person following this file does what that job checks.
test('R-3: docs/LOCAL-ACCEPTANCE.md has the image CI\'s steps, in its order, and its lines are the docs\' own', t => {
  if (!needs(t, ...DOC_FILES)) return;
  const {DOCS, LOCAL, README, CHECKLIST, SKILL} = load();
  const steps = CHECKLIST.split('\n').filter(l => /^## /.test(l)).map(l => l.slice(3));
  assert.deepEqual(steps, ['0. Prepare', '1. Get the image without private access', '2. Install the client while you still have network',
    '3. Set the client tripwire', '4. Start the server exactly as the docs say', '5. Read the server the way an agent would',
    '6. One agent, as the server\'s /skill.md says', '7. Connect an MCP app (optional)', '8. A small multi-agent run with your own agents',
    '9. Network isolation', '10. Limits behave as documented', '11. Restart and persistence', '12. Reset', '13. Inspect',
    '14. A second server beside the first (optional)', 'Verdict', 'How the image\'s CI runs it']);
  // Its server line is the README's, named; its skill lines are the served skill.md's, with a handle filled in.
  const readmeServer = /^docker run --rm (-p 127\.0\.0\.1:8080:8080 .*ghcr\.io\/fitzss\/valun-local):latest$/m.exec(readmeLocal(README));
  assert.ok(readmeServer && CHECKLIST.includes(`docker run --rm --name valun-local ${readmeServer[1]}:TAG`));
  const skillJoin = new RegExp(`^uvx --from ${LOCAL_CLIENT.replaceAll('.', '\\.')} (valun --profile local join --sandbox --server http://127\\.0\\.0\\.1:8080) --handle YOUR-HANDLE .*--approvals console$`, 'm').exec(SKILL);
  assert.ok(skillJoin && CHECKLIST.includes(`${skillJoin[1]} --handle HANDLE-A`), 'step 6: the skill\'s join, HANDLE-A');
  assert.ok(SKILL.includes('valun --profile local sandbox tour --yes --server http://127.0.0.1:8080') && CHECKLIST.includes('valun --profile local sandbox tour --yes --server http://127.0.0.1:8080'));
  // Step 10: what the client shows of the 13th join (the message, its wait in minutes) and where retry_after_ms is seen
  // (the HTTP answer: valun 0.7.2 never prints it, cli.py _join_refused).
  assert.ok(flat(CHECKLIST).includes('The 13th is refused: the client prints `Joining failed (rate_limited): ...`, a message that says how many minutes to wait and points to invites.'));
  assert.ok(flat(CHECKLIST).includes('`curl -s http://127.0.0.1:8080/pilot/v1/join-sandbox -H \'content-type: application/json\' -d \'{}\'`, answers 429 `rate_limited` with `retry_after_ms`'));
  assert.doesNotMatch(flat(`${LOCAL}\n${CHECKLIST}\n${SKILL}`), /wait the `retry_after_ms` it gave/, 'no doc says to wait a retry_after_ms that valun 0.7.2 does not show');
  // Step 12: the token file too (LD-1), and LOCAL.md's own Reset.
  assert.ok(flat(CHECKLIST).includes('After you remove `local.json` **and the token file step 6\'s join wrote** (`$HOME/valun-local-owner-token-HANDLE-A.txt`: valun never replaces a file that exists, and its join refuses one before anything is sent)'));
  // Step 2: the client release the docs pin (lib/a2a.mjs LOCAL_CLIENT), for uv, pipx and the client image.
  for (const part of [`Run \`uv tool install ${LOCAL_CLIENT}\` (or \`pipx install ${LOCAL_CLIENT}\`)`, `\`RUN pip install ${LOCAL_CLIENT}\``,
    `\`valun --version\` prints ${LOCAL_CLIENT.replace('valun==', '')}.`]) assert.ok(flat(CHECKLIST).includes(part), part);
  assert.doesNotMatch(CHECKLIST, /\*\*Today:\*\*/, 'no state of an earlier test image');
  // Step 13: the files there from the first start, and what step 12's reset leaves for the two that come with an IOU (F6).
  assert.ok(flat(CHECKLIST).includes('The files that `docs/LOCAL.md` lists in `/data/pilot` as there from the first start are there, and `sandbox-join-key` (step 12\'s joins made it).'));
  // What it is and how the CI runs it (F7, and fix inbox #163): the checklist the CI runs, as the image carries it,
  // dispatched by hand per digest, the docs on the volumes they run on, and every placeholder the CI fills in. The package
  // is public: step 1 needs no login (fix inbox #143).
  const c = flat(CHECKLIST);
  assert.ok(c.includes('**Status.** The package is public, so step 1 needs no login. This file is the checklist the image\'s CI runs: its outsider job runs these steps, in this order, from this file as the image carries it'));
  assert.ok(c.includes('**Step 1** is the anonymous pull itself, as a person makes it.'));
  assert.doesNotMatch(c, /while the package is private|step 1 fails until then|CI's own copy \(private\)/);
  assert.ok(c.includes('The job is dispatched by hand for each release candidate\'s digest'));
  assert.ok(c.includes('the README\'s and `docs/LOCAL.md`\'s each on a fresh volume, the served `/skill.md`\'s on `docs/LOCAL.md`\'s server.'));
  assert.ok(c.includes('(`YOUR-HANDLE` with a handle of its own for each join, `"YOUR NAME"` and `"YOUR HUMAN"`, `CONTAINER`, `TEXT`, `<revision>`, `<index digest>`)'));
  assert.doesNotMatch(c, /for every release candidate, from a job/);
});
