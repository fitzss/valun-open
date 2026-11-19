import {LOCAL} from '../environment.mjs';

// The network this server runs, its unit and its amount scale (one place). Amounts are whole numbers in the unit,
// everywhere: deals, notes, limits, positions.
//   valun-pilot-1    unit PC, scale 1: synthetic credits on a pilot tracker with no chain (the default).
//   valun-testnet-1  unit nanoERG, scale 1,000,000: Ergo TESTNET. Notes are denominated in ERG (the Basis reserve
//                    contract pays raw nanoERG), so the defaults and bounds sized for PC are multiplied by the scale:
//                    one "PC-sized" amount is 1,000,000 nanoERG = 0.001 tERG. Test coins: no monetary value.
// PILOT_NETWORK picks one; nothing else is accepted, so a typo cannot make an unknown network.
export const NETWORKS = Object.freeze({
  'valun-pilot-1': Object.freeze({unit: 'PC', scale: 1, chain: null, origin: 'https://valun.tech'}),
  'valun-testnet-1': Object.freeze({unit: 'nanoERG', scale: 1_000_000, chain: 'ergo-testnet', denomination: 'erg',
    origin: 'https://valun-testnet.fly.dev'}),
});

const chosen = process.env.PILOT_NETWORK || 'valun-pilot-1';
if (!Object.hasOwn(NETWORKS, chosen)) throw new Error(`PILOT_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}, not '${chosen}'`);
export const NETWORK = chosen;
export const UNIT = NETWORKS[NETWORK].unit;
export const SCALE = NETWORKS[NETWORK].scale;
export const CHAIN = NETWORKS[NETWORK].chain;          // null: no chain
export const ON_TESTNET = CHAIN === 'ergo-testnet';
// A local server (VALUN_ENVIRONMENT=local, lib/environment.mjs) has no chain, so it runs only a network without one:
// valun-pilot-1. The testnet's network needs its tracker on Ergo testnet, and the released clients tell their agents a
// valun-testnet-1 tracker anchors its state there, which a local tracker never does.
if (LOCAL && CHAIN) throw new Error(`VALUN_ENVIRONMENT=local runs a network with no chain (valun-pilot-1), not ${NETWORK}, which needs its tracker on ${CHAIN}`);
// Where this network is reached in public. Its links (loop cards, agent pages, the A2A card, the join prompts) point
// here, so a testnet page never sends an agent to the pilot's records or onboarding (the first testnet run found its
// loop cards at valun.tech/loop/<id>, a 404 there).
// VALUN_PUBLIC_ORIGIN overrides it (an https origin, no path): the testnet once valun.tech serves it (2026-11-13, the
// pilot retired; its app replays every request to the testnet's). A local server's links name the server itself: by
// default http://127.0.0.1:<PORT>; its VALUN_PUBLIC_ORIGIN may also be http on loopback (127.0.0.1, localhost or [::1],
// with a port), for a container whose port is published as another.
export const LOCAL_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const override = process.env.VALUN_PUBLIC_ORIGIN;
if (override !== undefined && !(/^https:\/\/[a-z0-9.-]+$/.test(override) || (LOCAL && LOCAL_ORIGIN_RE.test(override))))
  throw new Error(`VALUN_PUBLIC_ORIGIN must be an https origin with no path${LOCAL ? ', or http://127.0.0.1, http://localhost or http://[::1] with a port' : ''}, not '${override}'`);
const localOrigin = () => `http://127.0.0.1:${/^\d{1,5}$/.test(process.env.PORT ?? '') ? process.env.PORT : '4320'}`;
// Never the public network's own hosts, or a public service's, on a local server (fix inbox #155): it writes its origin
// into every join and --server its skill.md, llms.txt, banner and A2A answer give, so VALUN_PUBLIC_ORIGIN=https://valun.tech
// (the testnet's value of this setting, easy to copy) made a local server send its agents' joins to the public testnet,
// in a profile named local (the local-readiness audit, FB-13). Refused there: valun.tech and every name under it, Fly's
// app hosts (*.fly.dev: the testnet's, staging's, and the retired desk's, which replays to the testnet) and the Ergo
// explorer's (*.ergoplatform.com). Elsewhere nothing changes: the testnet's own origin is https://valun.tech.
const PUBLIC_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:valun\.tech|fly\.dev|ergoplatform\.com)\.?$/;
if (LOCAL && override !== undefined && PUBLIC_HOST_RE.test(override.replace(/^https:\/\//, '')))
  throw new Error(`VALUN_PUBLIC_ORIGIN=${override} names the public network or a public service, not this local server: its agents would be sent `
    + `there (every join its skill.md gives names it with --server). Give this server's own origin, ${localOrigin()} by default`);
export const PUBLIC_ORIGIN = override || (LOCAL ? localOrigin() : NETWORKS[NETWORK].origin);

// A default or bound written in PC-sized amounts, in this network's unit.
export const pc = n => n * SCALE;

// Whole nanoERG as tERG: 3000000 -> "0.003".
export const tergOf = n => (Number(n) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
// An amount as people read it: "3 PC" on the pilot; "3000000 nanoERG (0.003 tERG)" on the testnet.
export function amt(n) {
  if (UNIT !== 'nanoERG') return `${n} ${UNIT}`;
  return `${n} nanoERG (${tergOf(n)} tERG)`;
}

// The honest one-line labels that differ by network.
export const BACKING = ON_TESTNET
  ? 'Ergo TESTNET: the tracker anchors its state on testnet; an issuer may back its notes with a tERG reserve on testnet; tERG are test coins with no monetary value'
  : 'none: the pilot tracker has no chain and no reserves; PC are simulated units';
// Where a note is held. On the testnet, whether a tracker box on Ergo testnet commits it is said apart, from the note's
// own confirmation (Pilot.view, labels.basis): "its state anchored on Ergo testnet" stood beside confirmation local_only
// (the newcomer run of Nov 18, finding 12).
export const TRACKER_PLACE = ON_TESTNET ? 'the testnet tracker' : 'the pilot tracker (local, no chain)';
