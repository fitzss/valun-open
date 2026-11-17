// Which copy of the server this is (fix inbox #41). valun-staging runs the testnet's image, so it names the testnet's
// network (valun-testnet-1) and its pages look like the network's: a person or an agent landing there could take it for
// the network. Its Fly config sets VALUN_ENVIRONMENT=staging; then GET /pilot/v1/info says `environment: "staging"`
// (lib/pilot/http.mjs) and every HTML page the server serves opens with a one-line banner that links to the network
// (lib/http.mjs). Only that exact value counts, and `local` below: any other, or none (the testnet), changes nothing,
// and the variable's text never reaches a response. Read once, at start, like VALUN_BUILD_SHA.
// VALUN_ENVIRONMENT=local (fix inbox #143): a local server, a copy of Valun someone runs on their own machine with no
// chain (Dockerfile.local, scripts/local-entrypoint.sh). It runs the network that has no chain (valun-pilot-1;
// lib/pilot/units.mjs refuses any other), GET /pilot/v1/info says `environment: "local"` with LOCAL_NOTE, and every HTML
// page opens with localBanner(): no chain here, the pages' text describes the public network, and how to point a client
// at this server. Its links name this server (units.mjs PUBLIC_ORIGIN).
const VALUE = process.env.VALUN_ENVIRONMENT;
export const ENVIRONMENT = VALUE === 'staging' ? 'staging' : VALUE === 'local' ? 'local' : null;
export const STAGING = ENVIRONMENT === 'staging';
export const LOCAL = ENVIRONMENT === 'local';

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
// public network, with its own stylesheet (public/local.css, served on a local server only), as the staging banner.
export const localBanner = origin => '<link rel="stylesheet" href="/local.css"><p class="valun-local">Local: no chain. A copy '
  + 'of Valun running on this machine, not the public network: nothing here is anchored on a chain or redeemable, and '
  + 'its credits have no monetary value. The text of these pages describes the public network at '
  + `<a href="https://valun.tech">https://valun.tech</a>; to use this server, point your client at it: <code>valun config server ${esc(origin)}</code></p>`;

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
