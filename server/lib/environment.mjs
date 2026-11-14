// Which copy of the server this is (fix inbox #41). valun-staging runs the testnet's image, so it names the testnet's
// network (valun-testnet-1) and its pages look like the network's: a person or an agent landing there could take it for
// the network. Its Fly config sets VALUN_ENVIRONMENT=staging; then GET /pilot/v1/info says `environment: "staging"`
// (lib/pilot/http.mjs) and every HTML page the server serves opens with a one-line banner that links to the network
// (lib/http.mjs). Only that exact value counts: any other, or none (the testnet), changes nothing, and the variable's
// text never reaches a response. Read once, at start, like VALUN_BUILD_SHA.
export const ENVIRONMENT = process.env.VALUN_ENVIRONMENT === 'staging' ? 'staging' : null;
export const STAGING = ENVIRONMENT === 'staging';

// The banner: fixed text and a link. The CSP allows no inline style (style-src 'self'), so it links its own small
// stylesheet, public/staging.css, which lib/http.mjs serves on staging only (a stylesheet link may stand in the body).
export const STAGING_BANNER = '<link rel="stylesheet" href="/staging.css"><p class="valun-staging">Staging: a test copy of '
  + 'Valun for checking changes before they go live. The network is at <a href="https://valun.tech">https://valun.tech</a></p>';

// An HTML page (a string, or a Buffer of UTF-8) with the banner right after its opening <body> tag, on staging: at the
// very top, in the flow, so it covers nothing. Elsewhere, and for a page with no <body> tag, the page itself, untouched
// (the same bytes).
export function withStagingBanner(html) {
  if (!STAGING) return html;
  const text = String(html), open = /<body\b[^>]*>/i.exec(text);
  if (!open) return html;
  const at = open.index + open[0].length;
  return `${text.slice(0, at)}\n${STAGING_BANNER}${text.slice(at)}`;
}
