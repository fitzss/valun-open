// The agent docs of a LOCAL Valun server (VALUN_ENVIRONMENT=local, the local image; fix inbox #150): /skill.md and
// /agents.md (public/skill-local.md) and /llms.txt (public/llms-local.txt). A local server runs valun-pilot-1, in PC,
// with no chain, so the testnet's skill (public/skill-testnet.md: nanoERG, Ergo testnet, valun.tech) is wrong there,
// and the retired pilot's (public/skill.md) is out of date: no pinned client, no recovery advice. Its page for people,
// /start (public/start-local.html, an HTML page; fix inbox #155, FB-2), is rendered here too, from the same facts: the
// public network's /start gave a local server's visitors that network's prompt and joins. Each file is rendered from
// its source in scripts/local-docs/:
//   - {{name}}: a fact from the server's own constants (the self-serve limits and join caps, the practice agents' prices
//     and limits, the bound note's age), the client release (lib/a2a.mjs LOCAL_CLIENT: the release the local image is
//     checked with, which may be older than the one public/skill-testnet.md pins, lib/a2a.mjs CLIENT) and {{run}}, the
//     local command (uvx --from valun==X valun --profile local);
//   - a line `<!-- shared: HEADING | START -->`: the block of public/skill-testnet.md under that heading that begins with
//     START (a paragraph, a list item or a table), made local (localize): its commands run in the local profile, its
//     links name this server, its token files are the local ones. A shared block that names what a local server does
//     not have (the chain, tERG, reserves, the house agents, the public origin), runs a command that takes --server, or
//     names a client release other than LOCAL_CLIENT (the testnet's skill describes its own), stops the build: reword
//     that part in the source instead of copying it;
//   - {origin} stays: the server writes its own origin there when it serves the file (lib/http.mjs).
// A source names the client release it was written for (`<!-- client: valun==X -->`); when the server pins another,
// the build stops until the source has been reviewed against that release. Both files are then checked
// (localDocProblems): one client release, no unpinned install, every command in a local profile and with --server where
// it takes one, no link but this server's and the code's, and no testnet-only or pilot-era wording.
//
// Usage: node scripts/build-local-docs.mjs            write both files
//        node scripts/build-local-docs.mjs --check    exit 1 if either is stale (test/local-agent-docs.test.mjs runs it)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCAL_CLIENT} from '../lib/a2a.mjs';
import {SANDBOX_CAPS, SANDBOX_DAYS, SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, SANDBOX_JOINS_PER_HOUR_TOTAL,
  OPEN_NETWORK_MAX_OPEN_OFFERS, DEFAULT_MANDATE, INVITE_MANDATE_DAYS} from '../lib/pilot/core.mjs';
import {SERVICES, WELCOME, STRANGER_EARN_CAP} from '../lib/pilot/sandbox.mjs';
import {SCALE} from '../lib/pilot/units.mjs';
import {NOVATION_MAX_AGE_MS} from '../lib/pilot/caps.mjs';
import {DEFAULT_LIMITS} from '../lib/pilot/limits.mjs';
import {EXPIRIES_TO_EXCLUDE, EXCLUSION_MS} from '../lib/pilot/clearing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TESTNET_SKILL = 'public/skill-testnet.md';
export const DOCS = Object.freeze([
  Object.freeze({source: 'scripts/local-docs/skill.md', out: 'public/skill-local.md'}),
  Object.freeze({source: 'scripts/local-docs/llms.txt', out: 'public/llms-local.txt'}),
  Object.freeze({source: 'scripts/local-docs/start.html', out: 'public/start-local.html'})]);
export const PROFILE = 'local';
export const ORIGIN = '{origin}';
// valun 0.7.2's commands that take --server (its cli.py: every add_argument('--server'); console is new in 0.7.2), and
// those that do not: they use the server the profile joined.
export const SERVER_COMMANDS = new Set(['join', 'enroll', 'console', 'doctor', 'config', 'clearing', 'policy', 'attempts', 'profile',
  'card', 'verify-check', 'sell', 'ergo', 'audit', 'sandbox']);
export const PROFILE_COMMANDS = new Set(['status', 'tools', 'call', 'mcp']);
// The only links a local doc has besides this server's own: the code (the clients and the server, and the Hermes plugin,
// which a local server's A2A answer installs: lib/a2a.mjs), and uv's install page.
export const EXTERNAL = ['https://github.com/fitzss/valun-open', 'https://github.com/fitzss/hermes-plugin-valun', 'https://docs.astral.sh/uv/'];
// valun 0.7.2's default consent cap for a sandbox join (agent.py SANDBOX_CONSENT_POLICY max_PC), in PC.
const CLIENT_CONSENT_CAP_PC = 50;

const read = f => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
// A whole-number constant of a module that does not export it.
function constant(file, name) {
  const m = new RegExp(`\\b${name} = (\\d+)\\b`).exec(read(file));
  if (!m) throw new Error(`build-local-docs: no ${name} in ${file}`);
  return Number(m[1]);
}
const pcOf = n => n / SCALE;   // the constants are PC-sized amounts times the network's scale (1 on valun-pilot-1)
const hours = ms => (ms === 3600e3 ? 'one hour' : `${ms / 3600e3} hours`);

// The facts the sources name as {{name}}.
export function facts() {
  return {
    client: LOCAL_CLIENT, run: `uvx --from ${LOCAL_CLIENT} valun --profile ${PROFILE}`,
    per_deal: pcOf(SANDBOX_CAPS.max_issue_per_deal), owed_total: pcOf(SANDBOX_CAPS.max_issue_outstanding),
    per_issuer: pcOf(SANDBOX_CAPS.max_accept_per_issuer), open_offers: OPEN_NETWORK_MAX_OPEN_OFFERS, days: SANDBOX_DAYS,
    joins_hour_address: SANDBOX_JOINS_PER_HOUR_PER_ADDRESS, joins_hour_total: SANDBOX_JOINS_PER_HOUR_TOTAL,
    joins_day: constant('lib/pilot/core.mjs', 'SANDBOX_JOINS_PER_DAY'),
    // The request budgets' defaults (lib/pilot/limits.mjs; a local server's settings may change them, and its GET /info
    // `limits` gives the ones in force).
    writes_minute_address: DEFAULT_LIMITS.writes_per_minute.per_address, reads_minute_address: DEFAULT_LIMITS.reads_per_minute.per_address,
    writes_minute_token: DEFAULT_LIMITS.writes_per_minute.per_token, reads_minute_token: DEFAULT_LIMITS.reads_per_minute.per_token,
    text_stats: pcOf(SERVICES['text-stats'].price), notary: pcOf(SERVICES.notary.price), welcome: pcOf(WELCOME.price),
    per_stranger: constant('lib/pilot/sandbox.mjs', 'PURCHASES_PER_STRANGER_PER_DAY'), earn_cap: pcOf(STRANGER_EARN_CAP),
    bound_note_hours: hours(NOVATION_MAX_AGE_MS), consent_cap: CLIENT_CONSENT_CAP_PC,
    // An invited agent's defaults (core.mjs DEFAULT_MANDATE and INVITE_MANDATE_DAYS: Pilot.join), which the skill's
    // invited join states (fix inbox #155: an invited participant is not sandbox_only).
    invited_per_deal: pcOf(DEFAULT_MANDATE.max_issue_per_deal), invited_owed: pcOf(DEFAULT_MANDATE.max_issue_outstanding),
    invited_days: INVITE_MANDATE_DAYS,
    // The clearing engine leaves out a participant whose set-offs expired unsigned this many times in a row, for this
    // long (lib/pilot/clearing.mjs), which the skill states for an invited agent's MCP server with the consent loop off.
    expiries_to_exclude: EXPIRIES_TO_EXCLUDE, exclusion_hours: EXCLUSION_MS / 3600e3,
  };
}

// The block of `md` under the heading line `heading` (up to the next heading of its level or higher) that begins with
// `start`: a paragraph or a table (after a blank line, up to the next one), or a list item ("- ...", with its indented
// lines). Fenced code is never searched. Throws when there is none, so a reworded source block stops the build.
export function sharedBlock(md, heading, start) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const h = lines.indexOf(heading);
  if (h < 0 || !/^#{1,6} /.test(heading)) throw new Error(`build-local-docs: ${TESTNET_SKILL} has no heading "${heading}"`);
  const level = /^#+/.exec(heading)[0].length;
  let end = lines.findIndex((l, i) => i > h && /^#{1,6} /.test(l) && /^#+/.exec(l)[0].length <= level);
  if (end < 0) end = lines.length;
  const item = start.startsWith('- ');
  let fence = false, at = -1;
  for (let i = h + 1; i < end && at < 0; i++) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
    if (!fence && lines[i].startsWith(start) && (item || !lines[i - 1].trim())) at = i;
  }
  if (at < 0) throw new Error(`build-local-docs: no block beginning "${start}" under "${heading}" in ${TESTNET_SKILL}`);
  const out = [lines[at]];
  for (let i = at + 1; i < end; i++) {
    const l = lines[i];
    if (!l.trim() || (item && !/^\s/.test(l))) break;
    out.push(l);
  }
  return out.join('\n');
}

// Every valun command in `text` run through uvx: {spec, profile, sub, text}. A command ends at the end of its line, at
// the backtick that closes its code span, or, in an HTML page (the local /start), at the tag that closes its <code>;
// sub is null for the bare `uvx --from X valun` an install note names.
export function commands(text) {
  const out = [];
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/uvx --from (\S+) valun((?: [^`\n<]*)?)/g)) {
      const toks = m[2].trim().split(/\s+/).filter(Boolean);
      const profile = toks[0] === '--profile' ? toks[1] ?? '' : null;
      const sub = toks[profile === null ? 0 : 2] ?? null;
      out.push({spec: m[1], profile, sub: sub && /^[a-z][a-z-]*$/.test(sub) ? sub : null, text: m[0]});
    }
  }
  return out;
}

const UNPINNED = /uvx valun |uvx --from valun valun|pipx install valun(?!==)(?! inside)|uv tool install valun(?!==)|npm install @fitzdoud\/valun(?!@)/;
// What a local doc never says: the public origin, the testnet's coin and chain, the house agents (they don't run on a
// local server), "final", and the retired pilot's wording for a loop that clears (fix inbox #150).
const NEVER = [[/valun\.tech/i, 'the public origin (valun.tech)'], [/nanoERG|\btERG\b|Ergo testnet/, "the testnet's coin or chain"],
  [/house-scribe|house-reviewer/, 'a house agent'], [/\bfinal\b/i, '"final"'],
  [/debt is gone|loop is cancelled|cancels? out|pay back in work/i, "the retired pilot's wording"], [UNPINNED, 'an unpinned client']];
// What a shared block may not carry besides: it would describe the testnet's chain, or name a client release other
// than the one a local doc is written for (its words would be that release's: valun 0.7.2's for a doc of 0.7.1, say).
const LOCAL_VERSION = LOCAL_CLIENT.replace(/^valun==/, '');
const NEVER_SHARED = [[/\b(anchor(s|ed|ing)?|redeem(s|ed|ing)?|redemption|reserves?|audit)\b/i, 'the chain, reserves or redemption'],
  [new RegExp(`\\b(?!${LOCAL_VERSION.replaceAll('.', '\\.')}\\b)\\d+\\.\\d+\\.\\d+\\b`), 'a release other than the local client\'s']];

// Problems of a rendered local doc (served or not: `origin` is what stands for this server's origin in it).
export function localDocProblems(text, {origin = ORIGIN, version = LOCAL_VERSION} = {}) {
  const p = [];
  for (const [re, what] of NEVER) if (re.test(text)) p.push(`names ${what}: ${re.exec(text)[0]}`);
  const pins = [...text.matchAll(/valun(?:\[\w+\])?==(\d+\.\d+\.\d+)/g)].map(m => m[1]);
  if (!pins.length) p.push('pins no client release');
  for (const v of new Set(pins)) if (v !== version) p.push(`pins valun ${v}, not ${version}`);
  for (const c of commands(text)) {
    if (c.sub === null) continue;
    if (!/^local[\w-]*$/.test(c.profile ?? '')) p.push(`runs outside a local profile: ${c.text}`);
    if (SERVER_COMMANDS.has(c.sub) && !c.text.includes(`--server ${origin}`)) p.push(`has no --server ${origin}: ${c.text}`);
    if (!SERVER_COMMANDS.has(c.sub) && !PROFILE_COMMANDS.has(c.sub)) p.push(`runs an unknown command ${c.sub}: ${c.text}`);
  }
  for (const m of text.matchAll(/"args": \[([^\]]*)\]/g)) if (!m[1].includes('"--profile", "local"')) p.push(`an MCP config outside the local profile: ${m[0]}`);
  for (const m of text.matchAll(/(?:https?:\/\/|\{origin\})[^\s)`>"'\]]*/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!(url.startsWith(origin) || EXTERNAL.some(e => url.startsWith(e)))) p.push(`links ${url}`);
  }
  if (!text.includes(origin)) p.push(`never names this server (${origin})`);
  return p;
}

// A shared block, made local: this server's origin for the public one, the local token file, the local profile.
// The money's word in a shared block (fix inbox #173): the testnet's skill says "note"; a local server's docs keep the
// word of the release its image was verified with, IOU (skill-local.md glosses it as the credit note), until that image
// is released again. Each phrase is one a shared block has; a block without it is unchanged.
export const LOCAL_WORDS = Object.freeze([['decide whose notes you accept', 'decide whose IOUs you accept'], ['`accept` signs your note,', '`accept` signs your IOU,']]);
export function localize(block) {
  const t = LOCAL_WORDS.reduce((s, [testnet, local]) => s.replaceAll(testnet, local), block)
    .replace(/https:\/\/valun\.tech(?![\w.-])/g, ORIGIN)
    .replaceAll('valun-owner-token-', 'valun-local-owner-token-')
    .replace(/(uvx --from \S+ valun) (?!--profile )(?=[a-z])/g, `$1 --profile ${PROFILE} `);
  const bad = [...NEVER, ...NEVER_SHARED].filter(([re]) => re.test(t)).map(([re, what]) => `${what}: ${re.exec(t)[0]}`);
  for (const c of commands(t)) if (c.sub && SERVER_COMMANDS.has(c.sub)) bad.push(`it runs \`valun ${c.sub}\`, which takes --server`);
  if (bad.length) throw new Error(`build-local-docs: a shared block of ${TESTNET_SKILL} can't be used on a local server as it is (${bad.join('; ')}); `
    + `write that part in the source instead:\n${block}`);
  return t;
}

// One source rendered: its comments dropped (the client line checked), its shared blocks and facts filled in.
export function render(source, testnetSkill = read(TESTNET_SKILL), f = facts()) {
  let text = source.replace(/\r\n/g, '\n');
  const head = /^(?:<!--[\s\S]*?-->\n)+/.exec(text);
  const written = head && /<!-- client: (\S+) -->/.exec(head[0])?.[1];
  if (!written) throw new Error('build-local-docs: a source begins with its comments, among them the client release it was written for (<!-- client: valun==X -->)');
  if (written !== f.client) {
    throw new Error(`build-local-docs: the source was written for ${written}, and a local server pins ${f.client} (lib/a2a.mjs LOCAL_CLIENT): `
      + `check what it says of the client (its commands, flags and messages) against ${f.client}, then change its client line`);
  }
  text = text.slice(head[0].length);
  text = text.replace(/^<!-- shared: (.+?) \| (.+?) -->$/gm, (_, heading, start) => localize(sharedBlock(testnetSkill, heading, start)));
  if (/<!--/.test(text)) throw new Error(`build-local-docs: a comment left in the output: ${/<!--.*$/m.exec(text)[0]}`);
  text = text.replace(/\{\{(\w+)\}\}/g, (all, k) => {
    if (!Object.hasOwn(f, k)) throw new Error(`build-local-docs: no fact {{${k}}}`);
    return String(f[k]);
  });
  const problems = localDocProblems(text);
  if (problems.length) throw new Error(`build-local-docs: the rendered doc has problems:\n- ${problems.join('\n- ')}`);
  return text;
}

// Every doc as it renders today: [{out, text}].
export const build = () => {
  const skill = read(TESTNET_SKILL), f = facts();
  return DOCS.map(d => ({out: d.out, text: render(read(d.source), skill, f)}));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const docs = build();
  if (process.argv.includes('--check')) {
    const stale = docs.filter(d => !fs.existsSync(path.join(root, d.out)) || read(d.out) !== d.text).map(d => d.out);
    if (stale.length) { console.error(`build-local-docs: ${stale.join(', ')} stale; run node scripts/build-local-docs.mjs`); process.exit(1); }
    console.log(`build-local-docs: ${docs.map(d => d.out).join(', ')} current`);
  } else {
    for (const d of docs) fs.writeFileSync(path.join(root, d.out), d.text);
    console.log(`build-local-docs: wrote ${docs.map(d => `${d.out} (${Buffer.byteLength(d.text)} bytes)`).join(', ')}`);
  }
}
