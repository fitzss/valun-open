// What a page or a script of a local server gives a person or an agent to copy or follow, checked for the public
// network (fix inbox #155: the local-readiness audit's FB-2; test R-2, test/local-pages.unit.test.mjs). These are the
// rules of the local image's own check of a running image (the local image's CI checks (private), R-11), so a page that
// passes here passes there:
//   - copyable: every <pre> block, every <code> span outside one, every link (href) but the local banner's, the
//     canonical link and the meta tags' URLs (og:url, og:image), and what an inline script or style names;
//   - none of them names a public host: valun.tech or a name under it, a *.fly.dev app, the Ergo explorer
//     (*.ergoplatform.com); none offers the Claude Code plugin (its MCP server runs the default profile);
//   - every `valun` command in them (`valun ...`, `uvx --from valun==X valun ...`, after `--` in `claude mcp add NAME --`,
//     the args of an MCP JSON config, a Hermes `hermes -p P valun ...` line) runs in a named profile and, where the
//     command takes --server (valun 0.7.1's cli.py), names this server's origin. A code span that is only a command's
//     name (`valun mcp`, `valun audit`) is a mention in prose, not a command to run.
// This check is a little stricter than the image's: the profile must be a local one (local, local2, ...), and a
// `uvx --from "valun[ai]==X" valun ...` counts as a command too.
// Pure (no I/O).

export const PUBLIC_HOST_RE = /(?<![a-z0-9.-])((?:[a-z0-9-]+\.)*valun\.tech|[a-z0-9-]+\.fly\.dev|(?:[a-z0-9-]+\.)*ergoplatform\.com)(?![a-z0-9-])/gi;
// valun 0.7.1's subcommands that take --server (python/src/valun/cli.py at v0.7.1: every add_argument('--server')), and
// the others.
export const SERVER_SUBCOMMANDS = new Set(['join', 'enroll', 'doctor', 'config', 'clearing', 'policy', 'attempts', 'profile', 'card',
  'verify-check', 'sell', 'ergo', 'audit', 'sandbox']);
export const VALUN_SUBCOMMANDS = new Set([...SERVER_SUBCOMMANDS, 'status', 'tools', 'call', 'mcp', 'console']);
const PLUGIN_RE = /\/plugin\s+(install\s+valun@valun|marketplace\s+add\s+fitzss\/valun-open)/;
const URL_RE = /(?:https?:)?\/\/[A-Za-z0-9.-]+(?::\d+)?[^\s'"`)<>\\]*/g;
const ENV_RE = /^[A-Z_][A-Z0-9_]*=/;

export const publicHosts = text => [...new Set([...String(text ?? '').matchAll(PUBLIC_HOST_RE)].map(m => m[1].toLowerCase()))].sort();

// A command line split as a POSIX shell splits it (Python's shlex.split): words at whitespace, '...' literal, "..." with
// \" \\ \$ \` escapes, \ outside quotes escaping the next character. An unbalanced quote: split at whitespace instead.
export function shellWords(cmd) {
  const out = [];
  let w = null, i = 0;
  const s = String(cmd);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { if (w !== null) { out.push(w); w = null; } i++; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return s.split(/\s+/).filter(Boolean);
      w = (w ?? '') + s.slice(i + 1, end); i = end + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, part = '';
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1])) { part += s[j + 1]; j++; } else part += s[j];
      }
      if (j >= s.length) return s.split(/\s+/).filter(Boolean);
      w = (w ?? '') + part; i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < s.length) { w = (w ?? '') + s[i + 1]; i += 2; continue; }
    w = (w ?? '') + c; i++;
  }
  if (w !== null) out.push(w);
  return out;
}

// Every `valun ...` invocation in one command line, as word lists starting at the program (with any environment
// assignments before it); a Hermes line is returned with the program 'hermes'.
export function valunInvocations(cmd) {
  const t = shellWords(cmd), found = [];
  if (t[0] === 'hermes' && t.slice(1).includes('valun')) return [t];
  t.forEach((w, i) => {
    if (w !== 'valun') return;
    const prev = i ? t[i - 1] : '';
    if (!(i === 0 || ['--', '&&', ';', '|', 'then', 'exec', 'sudo'].includes(prev) || /^valun(\[\w+\])?==/.test(prev) || ENV_RE.test(prev))) return;
    let end = t.length;
    for (let j = i + 1; j < t.length; j++) if (['&&', ';', '|', '||'].includes(t[j])) { end = j; break; }
    found.push([...t.slice(0, i).filter(x => ENV_RE.test(x)), ...t.slice(i, end)]);
  });
  return found;
}

// The problems of one invocation; `inline`: a code span in prose, where a bare `valun SUBCOMMAND` is a mention.
export function invocationProblems(words, origin, {inline = false} = {}) {
  const env = words.filter(x => ENV_RE.test(x)), inv = words.filter(x => !ENV_RE.test(x)), text = inv.join(' ');
  if (inv[0] === 'hermes') {
    if (inv.includes('join') && !inv.includes('--server')) return [`a Hermes join with no --server: ${text}`];
    if (inv.includes('--server')) {
      const v = inv[inv.indexOf('--server') + 1] ?? '';
      if (v.replace(/\/+$/, '') !== origin) return [`a Hermes line naming another server (${v}): ${text}`];
    }
    return [];
  }
  const args = inv.slice(1);
  let profile = null, i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '--profile' && i + 1 < args.length) { profile = args[i + 1]; i += 2; continue; }
    if (args[i].startsWith('--profile=')) profile = args[i].slice('--profile='.length);
    if (['--version', '-h', '--help'].includes(args[i])) return [];
    i++;
  }
  const envProfile = env.find(e => e.startsWith('VALUN_PROFILE='));
  if (envProfile) profile ??= envProfile.slice('VALUN_PROFILE='.length);
  if (i >= args.length) return [];                              // `valun` alone, or only options: no command
  const sub = args[i], rest = args.slice(i + 1);
  if (inline && !rest.length && profile === null) return [];   // a mention in prose (`valun mcp`, `valun audit`)
  const problems = [];
  if (profile === null) problems.push(`no --profile: ${text}`);
  else if (!/^local[\w-]*$/.test(profile)) problems.push(`not a local profile (${profile}): ${text}`);
  if (SERVER_SUBCOMMANDS.has(sub)) {
    if (sub === 'config' && rest[0] === 'server') {
      if ((rest[1] ?? '').replace(/\/+$/, '') !== origin) problems.push(`points a profile at another server (${rest[1] ?? ''}): ${text}`);
    } else if (rest.includes('--server')) {
      const v = rest[rest.indexOf('--server') + 1] ?? '';
      if (v.replace(/\/+$/, '') !== origin) problems.push(`names another server (${v}): ${text}`);
    } else if (!rest.some(x => x.startsWith('--server='))) problems.push(`no --server ${origin}: ${text}`);
  }
  return problems;
}

// The problems of one copyable snippet: public hosts, the plugin, and each valun command (continuation lines joined; a
// line of an MCP JSON config read as the command it runs).
export function snippetProblems(snippet, origin, {inline = false} = {}) {
  const problems = publicHosts(snippet).map(h => `names ${h}: ${String(snippet).trim().slice(0, 200)}`);
  if (PLUGIN_RE.test(snippet)) problems.push(`offers the Claude Code plugin: ${String(snippet).trim().slice(0, 160)}`);
  for (let line of String(snippet).replace(/\\\n\s*/g, ' ').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/\s+#\s.*$/, '');
    const json = /"args"\s*:\s*(\[[^\]]*\])/.exec(line);
    if (json && json[1].includes('"valun"')) {
      try {
        const args = JSON.parse(json[1]), command = /"command"\s*:\s*("[^"]*")/.exec(line);
        line = [command ? JSON.parse(command[1]) : 'uvx', ...args].map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
      } catch { /* not JSON after all: the line as it is */ }
    }
    for (const inv of valunInvocations(line)) problems.push(...invocationProblems(inv, origin, {inline}));
  }
  return problems;
}

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'};
export const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? all));
// An element's text: its tags dropped, character references decoded (what a Copy button copies of a block).
export const textOf = html => decode(String(html).replace(/<[^>]*>/g, ''));
const attrsOf = tag => Object.fromEntries([...tag.matchAll(/\s([a-z][\w:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gi)]
  .map(m => [m[1].toLowerCase(), m[2] === undefined ? '' : decode(m[2].replace(/^["']|["']$/g, ''))]));
const LOADS = ['src', 'href', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'longdesc', 'manifest', 'icon'];

// What a page offers to copy and what it loads or sends: {banner, pre, code, links, loads, scripts, styles}. The local
// banner (<p class="valun-local">, lib/environment.mjs) is its 'not the public network' sentence: its links are not
// counted, its code spans are.
export function pageParts(html) {
  let h = String(html);
  const parts = {banner: null, pre: [], code: [], links: [], loads: [], scripts: [], styles: []};
  const b = /<p class="valun-local">[\s\S]*?<\/p>/.exec(h);
  if (b) { parts.banner = b[0]; h = h.slice(0, b.index) + h.slice(b.index + b[0].length); }
  for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\ssrc=/i.test(m[1])) parts.scripts.push(m[2]);
  for (const m of h.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.styles.push(m[1]);
  const rest = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (all, inner) => { parts.pre.push(textOf(inner)); return ' '; });
  for (const m of rest.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) parts.code.push(textOf(m[1]));
  for (const m of (b ? b[0] : '').matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) parts.code.push(textOf(m[1]));
  for (const m of h.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = m[1].toLowerCase(), a = attrsOf(m[2]);
    if (tag === 'a' && a.href) { parts.links.push(['a', a.href]); continue; }
    if (tag === 'link' && (a.rel ?? '').toLowerCase() === 'canonical' && a.href) { parts.links.push(['canonical', a.href]); continue; }
    for (const k of LOADS) if (a[k]) parts.loads.push([`${tag} ${k}`, a[k]]);
    for (const k of ['srcset', 'imagesrcset']) if (a[k]) for (const p of a[k].split(',')) if (p.trim()) parts.loads.push([`${tag} ${k}`, p.trim().split(/\s+/)[0]]);
    if (a.style) for (const u of a.style.matchAll(/url\(\s*['"]?([^'")]+)/g)) parts.loads.push([`${tag} style`, u[1]]);
    if (tag === 'meta' && a.content) for (const u of a.content.matchAll(URL_RE)) parts.loads.push([`meta ${(a.property || a.name || '').toLowerCase()}`, u[0]]);
  }
  return parts;
}

// Every problem of a page: nothing it gives to copy or follow, and nothing it loads or sends, names a public host, and
// every valun command in it runs in a local profile and names `origin` where the command takes --server.
export function pageProblems(html, origin) {
  const p = pageParts(html), problems = [];
  for (const block of p.pre) problems.push(...snippetProblems(block, origin));
  for (const span of p.code) problems.push(...snippetProblems(span, origin, {inline: true}));
  for (const [kind, url] of [...p.links, ...p.loads]) for (const h of publicHosts(url)) problems.push(`${kind} ${url} (${h})`);
  for (const js of p.scripts) for (const u of js.matchAll(URL_RE)) for (const h of publicHosts(u[0])) problems.push(`an inline script names ${u[0]} (${h})`);
  for (const css of p.styles) for (const u of css.matchAll(/url\(\s*['"]?([^'")]+)|@import\s+['"]([^'"]+)/g)) for (const h of publicHosts(u[1] ?? u[2])) problems.push(`an inline style loads ${u[1] ?? u[2]} (${h})`);
  return [...new Set(problems)];
}

// The commands a script shows (the string given to each el('code', ...), a ${...} in it read as ARG) and the URLs it
// names, as the image's check reads public/pilot.js.
export function scriptCommands(js) {
  return [...String(js).matchAll(/el\('code',\s*\{[^}]*\},\s*(`[^`]*`|'[^']*'|"[^"]*")/g)].map(m => m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, 'ARG'));
}
export function scriptProblems(js, origin) {
  const problems = scriptCommands(js).flatMap(s => snippetProblems(s, origin));
  for (const u of String(js).matchAll(URL_RE)) for (const h of publicHosts(u[0])) problems.push(`names ${u[0]} (${h})`);
  return [...new Set(problems)];
}
// How many valun commands (and Hermes lines) a page's copyable parts hold, beside its problems: a check that saw none
// checked nothing.
export function pageCommands(html) {
  const p = pageParts(html);
  return [...p.pre, ...p.code].flatMap(s => String(s).replace(/\\\n\s*/g, ' ').split('\n').flatMap(l => valunInvocations(l.trim())));
}
