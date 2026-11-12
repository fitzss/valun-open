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
// Where this network is reached in public. Its links (loop cards, agent pages, the A2A card, the join prompts) point
// here, so a testnet page never sends an agent to the pilot's records or onboarding (the first testnet run found its
// loop cards at valun.tech/loop/<id>, a 404 there).
export const PUBLIC_ORIGIN = NETWORKS[NETWORK].origin;

// A default or bound written in PC-sized amounts, in this network's unit.
export const pc = n => n * SCALE;

// An amount as people read it: "3 PC" on the pilot; "3000000 nanoERG (0.003 tERG)" on the testnet.
export function amt(n) {
  if (UNIT !== 'nanoERG') return `${n} ${UNIT}`;
  const v = Number(n);
  const terg = (v / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return `${n} nanoERG (${terg} tERG)`;
}

// The honest one-line labels that differ by network.
export const BACKING = ON_TESTNET
  ? 'Ergo TESTNET: the tracker anchors its state on testnet; an issuer may back its notes with a tERG reserve on testnet; tERG are test coins with no monetary value'
  : 'none: the pilot tracker has no chain and no reserves; PC are simulated units';
export const TRACKER_PLACE = ON_TESTNET ? 'the testnet tracker (its state anchored on Ergo testnet)' : 'the pilot tracker (local, no chain)';
