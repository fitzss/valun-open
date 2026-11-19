// Which copy of the server this is (fix inbox #41). valun-staging runs the testnet's image, so it names the testnet's
// network (valun-testnet-1) and its pages look like the network's: a person or an agent landing there could take it for
// the network. Its Fly config sets VALUN_ENVIRONMENT=staging; then GET /pilot/v1/info says `environment: "staging"`
// (lib/pilot/http.mjs) and every HTML page the server serves opens with a one-line banner that links to the network
// (lib/http.mjs). Only that exact value counts, and `local` below: any other, or none (the testnet), changes nothing,
// and the variable's text never reaches a response. Read once, at start, like VALUN_BUILD_SHA.
// VALUN_ENVIRONMENT=local (fix inbox #143): a local server, a copy of Valun someone runs on their own machine with no
// chain (Dockerfile.local, scripts/local-entrypoint.sh). It runs the network that has no chain (valun-pilot-1;
// lib/pilot/units.mjs refuses any other), GET /pilot/v1/info says `environment: "local"` with LOCAL_NOTE, and every HTML
// page opens with localBanner(): no chain here, parts of the pages describe the public network, and where to start on
// this server. Its links name this server (units.mjs PUBLIC_ORIGIN), and so does everything its own pages give to copy
// (lib/local-pages.mjs).
const VALUE = process.env.VALUN_ENVIRONMENT;
export const ENVIRONMENT = VALUE === 'staging' ? 'staging' : VALUE === 'local' ? 'local' : null;
export const STAGING = ENVIRONMENT === 'staging';
export const LOCAL = ENVIRONMENT === 'local';

// Whether this process runs on Fly.io, where Valun's public servers run: Fly sets FLY_APP_NAME and FLY_MACHINE_ID in
// the environment of every Machine it runs (scripts/docker-entrypoint.sh reads the same two). Read once, at start.
export const onFly = env => Boolean(env.FLY_APP_NAME || env.FLY_MACHINE_ID);
export const ON_FLY = onFly(process.env);

// What server.mjs says, once, just before its start line, when it runs the network with no chain (valun-pilot-1) off Fly
// and not as a local server (fix inbox #155: the local-readiness audit, FB-4). Run that way (`node server.mjs`, the
// hosted Dockerfile under Docker, `npm run local` before it set local mode), it gives its agents the public network's
// instructions: its /skill.md, /agents.md and /llms.txt are the retired pilot's, which name https://valun.tech, and every
// join they, its pages and its A2A answer give names no server, so the client takes its default server, the public
// network. Nothing it serves changes. null in every other case: a local server names only itself, and on Fly the
// servers are the public ones (the testnet and staging run valun-testnet-1 there; the retired pilot's app runs only its
// replay router). `withNetwork`: whether it runs the network (PILOT_TRACKER_URL), not the legacy demo desk alone;
// `localOrigin`: the origin it would name as a local server.
export function publicDocsWarning({network, fly, local, withNetwork, localOrigin}) {
  if (local || fly || network !== 'valun-pilot-1') return null;
  const which = withNetwork ? 'runs valun-pilot-1' : 'runs the legacy demo desk alone (no PILOT_TRACKER_URL)';
  return `Warning: this server ${which} off Fly and not as a local server (VALUN_ENVIRONMENT=local is unset), so it gives `
    + 'agents the public network\'s instructions: its /skill.md, /agents.md and /llms.txt name https://valun.tech, and the joins '
    + `they${withNetwork ? ', its pages and its A2A answer' : ' and its pages'} give name no server, so the client uses its `
    + 'default, the public network at https://valun.tech: an agent that follows them joins the public network, not this server'
    + (withNetwork ? '. For a server of your own with no chain, set VALUN_ENVIRONMENT=local: its docs, pages and A2A answer '
      + `then name only this server (${localOrigin}; docs/LOCAL.md), as the local image (Dockerfile.local) runs it.`
      : ', which runs no network to join. For a network of your own with no chain: VALUN_ENVIRONMENT=local with that '
      + 'network\'s tracker (PILOT_TRACKER_URL, PILOT_TRACKER_NFT_ID), as the local image (Dockerfile.local; docs/LOCAL.md) runs it.');
}

// The banner: fixed text and a link. The CSP allows no inline style (style-src 'self'), so it links its own small
// stylesheet, public/staging.css, which lib/http.mjs serves on staging only (a stylesheet link may stand in the body).
export const STAGING_BANNER = '<link rel="stylesheet" href="/staging.css"><p class="valun-staging">Staging: a test copy of '
  + 'Valun for checking changes before they go live. The network is at <a href="https://valun.tech">https://valun.tech</a></p>';

// What GET /pilot/v1/info says beside environment: "local".
export const LOCAL_NOTE = 'local: no chain. A copy of Valun running on the machine you reach it on, not the public network: '
  + 'its Basis tracker has no blockchain connection, so nothing here is anchored on a chain, redeemed or backed by a reserve, '
  + 'and its credits have no monetary value. Its participants, notes and loops exist only on this server. The public '
  + 'network is at https://valun.tech.';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The local banner: fixed text, the server's origin (lib/pilot/units.mjs PUBLIC_ORIGIN, checked there) and a link to the
// public network, with its own stylesheet (public/local.css, served on a local server only), as the staging banner. It
// sends people to this server's Start page and agents to its skill.md (lib/http.mjs SKILL_FILE), whose every command
// runs in a client profile of its own with this server named (fix inbox #150): `valun config server` would point the
// default profile, perhaps a testnet identity, at this server, and a later join without --server reaches the public
// network. It gives no join of its own (the local-readiness audit, SRV-14): the bare `valun --profile local join
// --sandbox --server <origin>` it gave prompted for a handle and an operator (an agent with no terminal stopped there),
// printed the owner token, and left approvals at ask, which a headless app can't show; the skill's join has them all.
export const localBanner = origin => '<link rel="stylesheet" href="/local.css"><p class="valun-local">Local: no chain. A copy '
  + 'of Valun running on this machine, not the public network at <a href="https://valun.tech">https://valun.tech</a>: '
  + 'nothing here is anchored on a chain or redeemable, and its credits (PC) have no monetary value. Parts of these pages '
  + 'describe the public network; their commands name this server. To use this server, start at '
  + '<a href="/start">its Start page</a>, or give your agent <a href="/skill.md">this server\'s skill.md</a>: every '
  + 'command there runs in a client profile of its own, <code>--profile local</code>, and names this server, '
  + `<code>--server ${esc(origin)}</code>.</p>`;

// An HTML page (a string, or a Buffer of UTF-8) with `banner` right after its opening <body> tag: at the very top, in
// the flow, so it covers nothing. With no banner, and for a page with no <body> tag, the page itself, untouched (the
// same bytes).
export function withBanner(html, banner) {
  if (!banner) return html;
  const text = String(html), open = /<body\b[^>]*>/i.exec(text);
  if (!open) return html;
  const at = open.index + open[0].length;
  return `${text.slice(0, at)}\n${banner}${text.slice(at)}`;
}
// The staging banner on staging; elsewhere the page itself.
export const withStagingBanner = html => (STAGING ? withBanner(html, STAGING_BANNER) : html);
