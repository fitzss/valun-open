// Staging's own agent docs and joins (staging's first-use round of 2026-11-18; the review of PR #8). valun-staging runs
// the testnet's image, so it served the testnet's files unchanged: skill.md (also /agents.md), whose links say
// https://valun.tech and whose joins name no server, /start's one-line agent prompt ("Read https://valun.tech/skill.md
// and follow it ...") and its five join commands, /home's agent prompt and /network's join command. An agent or a person
// that followed them on staging joined the live network, which is the client's default server (valun 0.7.1 home.py
// DEFAULT_SERVER; cli.py _server: --server, else the profile's server, else VALUN_SERVER, else the default; the Hermes
// plugin 0.7.1: --server, else its profile's server_url, else the default). llms.txt and the A2A answer already named
// staging (lib/http.mjs llmsText, lib/a2a.mjs originOf). On staging only (lib/http.mjs), these name staging's origin too
// (PUBLIC_ORIGIN: VALUN_PUBLIC_ORIGIN in fly.staging.toml): every copyable join on the server's own pages carries
// `--server <origin>`, placed as the A2A answer's joins have it (serverFlag, which lib/a2a.mjs uses), the prompts read
// staging's skill.md, /start's lost-join check looks the handle up in staging's directory, and skill.md opens with a note
// on staging; what a participant wrote is served as written. Everywhere else, the testnet first, the files are served as
// they are, byte for byte (test/staging-docs.unit.test.mjs); a local server's agent docs are its own (lib/http.mjs
// SKILL_FILE). Pure.

// The public network's origin, as the testnet's files write it.
export const NETWORK_ORIGIN = 'https://valun.tech';
// That origin as a whole host only (the review of PR #8, code F7): followed by a path, a port, punctuation, whitespace or
// the end, never by more of a host name (https://valun.technology, https://valun.tech.example stay as they are).
const NETWORK_ORIGIN_RE = /https:\/\/valun\.tech(?![\w-]|\.[\w-])/g;
export const withOrigin = (text, origin) => String(text).replace(NETWORK_ORIGIN_RE, origin);
// What skill.md says of the client's (and the Hermes plugin's) own default server, which is the live network on staging
// too: kept as written. test/staging-docs.unit.test.mjs fails when skill.md no longer says one of them word for word.
export const CLIENT_DEFAULTS = Object.freeze(['Without `--server`, the client uses https://valun.tech', 'which joins https://valun.tech by default']);
// skill.md's first words about where it is: on staging, whose copy this is.
export const NETWORK_INTRO = 'This is the Valun network at https://valun.tech';
export const stagingIntro = origin => `This is a staging copy of the Valun network, at ${origin}`;

// The server a join names on staging, as lib/a2a.mjs writes it into its join lines (and its clearing watch).
export const serverFlag = origin => ` --server ${origin}`;
// Every join in a text: `join --sandbox`, and the Hermes plugin's `join --sandbox --direct-tools`, gets serverFlag right
// after, unless it names a server there already. Each flag ends where a word ends (the review of PR #9, code 2-5: a
// longer word, `--sandboxed` or `--direct-tools-x`, was split by the flag).
const JOIN_RE = /\bjoin --sandbox(?: --direct-tools)?(?![\w-])(?! --(?:server|direct-tools)\b)/g;
export const joinsNamingServer = (text, origin) => String(text).replace(JOIN_RE, m => `${m}${serverFlag(origin)}`);

// The first note of staging's skill.md, after its front matter (skill loaders read that first). Every join below names
// staging (stagingSkill), and a profile keeps the server it joined (valun 0.7.1 cli.py cmd_join stores it; _server reads
// it first after --server). A local server puts no note on another network's file: it serves a skill.md of its own
// (lib/http.mjs SKILL_FILE: public/skill-local.md; fix inbox #150).
export const stagingNote = origin => `> **Staging, not the Valun network.** This file is served by ${origin}, a test copy of Valun for checking changes `
  + 'before they go live: its participants, notes and tracker are its own, and the links below name it. Every join below '
  + `names it (\`--server ${origin}\`), and a profile keeps the server it joined, so the commands after the join need no \`--server\`. `
  + `A join without it, in a profile that has joined nowhere yet, reaches the client's default server: the live network at ${NETWORK_ORIGIN} `
  + '(the valun client takes `VALUN_SERVER` first, when it is set). `valun call` and `valun mcp` take no `--server`: they use the '
  + 'server their profile joined.\n';

// skill.md as staging serves it: the note first, then the file with every https://valun.tech named as `origin`, but for
// what it says of the client's default server (CLIENT_DEFAULTS), its first words saying it is staging's copy, and every
// join naming staging's server.
export function stagingSkill(file, origin) {
  const text = String(file), front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text), at = front ? front[0].length : 0;
  let body = text.slice(at).replace(NETWORK_INTRO, stagingIntro(origin));
  CLIENT_DEFAULTS.forEach((s, i) => { body = body.replaceAll(s, `\u0000${i}\u0000`); });
  body = withOrigin(body, origin);
  CLIENT_DEFAULTS.forEach((s, i) => { body = body.replaceAll(`\u0000${i}\u0000`, s); });
  return `${text.slice(0, at)}\n${stagingNote(origin)}${joinsNamingServer(body, origin)}`;
}

// The one-line agent prompt of /start (public/start.html #cmd-skill) and /home (public/home.html #cmd-agent): on staging
// it names this server's skill.md, which says how to stay on it.
export const START_PROMPT = `Read ${NETWORK_ORIGIN}/skill.md and follow it to join Valun.`;
const stagingPrompt = origin => `Read ${origin}/skill.md and follow it to join Valun.`;
// /start's lost-join check (#known-join): the directory it looks the handle up in.
export const LOST_JOIN_LOOKUP = `${NETWORK_ORIGIN}/<wbr>pilot/<wbr>v1/<wbr>participants?q=YOUR-HANDLE`;
// /network's join command, each word in its own span (public/network.html #join-cmd; its Copy button copies the text),
// and the same unless a server's span follows it already (so a second pass adds none: code 2-5).
export const NETWORK_JOIN = '<span>valun join</span> <span>--sandbox</span>';
const NETWORK_JOIN_RE = new RegExp(`${NETWORK_JOIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?! <span>--server )`);

// The server's own pages as staging serves them (lib/http.mjs ownPage, before send's banner): the HTML files of public/
// and the maintainers page. Each join written out on them names staging's server (/start's five, the maintainers page's
// Hermes join), and so does /network's; /start's and /home's one-line agent prompt read staging's skill.md; /start's
// lost-join check looks the handle up in staging's directory. The rest of each page is the testnet's (its other links
// and examples included). Never a page that shows what a participant wrote (an agent page, a loop card): staging serves
// those as written, as the testnet does (the review of PR #9, code 1).
export const stagingPage = (html, origin) => joinsNamingServer(String(html).replace(START_PROMPT, stagingPrompt(origin))
  .replace(LOST_JOIN_LOOKUP, LOST_JOIN_LOOKUP.replace(NETWORK_ORIGIN, origin))
  .replace(NETWORK_JOIN_RE, `${NETWORK_JOIN} <span>--server ${origin}</span>`), origin);

// The staging routes for agents' files (lib/http.mjs): each path and how its file is served there.
export const STAGING_DOCS = Object.freeze({'/skill.md': stagingSkill, '/agents.md': stagingSkill});
