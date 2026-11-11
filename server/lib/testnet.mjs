// The funded Basis demo on Ergo TESTNET (2026-10-31 .. 2026-11-01), as recorded in the valun-pilot handoffs, plus a
// live re-read from the public testnet explorer. All values are public chain data; no keys or node access involved.
//
// Sources (valun-pilot\automation\handoffs): basis-demo-approval-2-20261031T003831Z (funding, note, commitment),
// basis-valun-v1-20261031T021123Z (note verified), basis-valun-v2-20261031T025025Z (reserve + claim bindings),
// basis-valun-v3-exec-20261101T035526Z (redemption, path E). Recorded checks used ONE trusted node (ours).

export const EXPLORER_API = 'https://api-testnet.ergoplatform.com/api/v1';
export const EXPLORER_UI = 'https://testnet.ergoplatform.com';

export const RECORDED = {
  network: 'Ergo testnet',
  recordedAt: '2026-11-01T03:49:07Z',
  parties: {
    issuer: {label: 'Issuer (reserve owner)', pubkey: '031f947799d10467861a086f6e8b8e66ec2fb0acdc0f30fa117bb52f739c06fcce'},
    recipient: {label: 'Recipient (note holder)', pubkey: '03bc6a33d2a821b96841df0347d05cd3660d2659768238165e255d54b16f85faaf'},
    tracker: {label: 'Tracker key (signs commitments)', pubkey: '035c6c37af2d245d9faa429082027b45022d0998d12bc3501948b655cb3ed24bb0'},
  },
  tokens: {
    trackerNft: '39377ea921c5b65527bc7b36a87aa66235c81076e255ce3edc482ec28e24f868',
    reserveNft: '09b08ab750e9c154a0ee6d5c7a47db638d59dc0a172873c01e195603a0c81812',
  },
  note: {amount: 10_000_000, denomination: 'nanoERG', issuedAt: '2026-10-31'},
  steps: [
    {key: 'mint', title: 'Tracker NFT minted', tx: 'e593edac091658270bb6e920b38763438743f7f016a53d9d0e46f9294c1a347d', height: 616431},
    {key: 'tracker-box', title: 'Tracker box + reserve NFT created', tx: '654f38044e74b90d1ac7e6a3cb8690759fa2ed686550b070c797e9c30a0c11b0', height: 616434},
    {key: 'reserve', title: 'Reserve funded: 50,000,000 nanoERG', tx: '4d2c8ef55757993a4ee32600fd0570670d47e3ddf9455a1693032506157f9555', height: 616440,
      box: 'd52f4a28e37eaa210f8cc4079e09c7c89d77fa63fe3f957568c1196b5460a88e'},
    {key: 'commit', title: 'Tracker committed the note (AVL digest in R5)', tx: 'f1ba9cca2c9fa3ce08865a3dd7602773ce6b202f246e3bba5ab46f44dd3298f1', height: 616448,
      box: 'a708a014e08d777d75ccd3d73ae21c63d37ae038b012bb8d3a0aeb7c2befdd52'},
    {key: 'redeem', title: 'Note redeemed against the reserve (emergency path E, after the tracker-box age limit)', tx: '3279a1c7fdd3f67fb2a14fda43f4fbbb5752b139658d94297579b44307f0673d', height: 618641},
  ],
  // Expectations checked by the live read: [boxId, expected value, expected spent-by tx or null, expected token]
  boxes: [
    {role: 'Original reserve (input of the redemption)', box: 'd52f4a28e37eaa210f8cc4079e09c7c89d77fa63fe3f957568c1196b5460a88e', value: 50_000_000, spentBy: '3279a1c7fdd3f67fb2a14fda43f4fbbb5752b139658d94297579b44307f0673d', token: '09b08ab750e9c154a0ee6d5c7a47db638d59dc0a172873c01e195603a0c81812'},
    {role: 'Continuing reserve after redemption', box: '0655dbf3fd4b50cc86f8e496b8336065e9767a8ad4bb0e22bac4ce1ffa9f10ce', value: 40_000_000, spentBy: null, token: '09b08ab750e9c154a0ee6d5c7a47db638d59dc0a172873c01e195603a0c81812'},
    {role: 'Payout to the note holder', box: '6a66297029f2df74444b84dbb7d4a3440fc8661b9b335c2cb5eb6b514187e81d', value: 9_000_000, spentBy: null, token: null},
    {role: 'Tracker box (commitment, data input of the redemption)', box: 'a708a014e08d777d75ccd3d73ae21c63d37ae038b012bb8d3a0aeb7c2befdd52', value: 9_000_000, spentBy: null, token: '39377ea921c5b65527bc7b36a87aa66235c81076e255ce3edc482ec28e24f868'},
  ],
  verified: [
    'V1 (2026-10-31): Valun verified the note itself - issuer signature, the commitment transaction, and tracker membership proof against the on-chain digest.',
    'V2 (2026-10-31): the reserve box, its contract, NFT and registers, and the note\'s bindings to it (issuer, tracker, debt), as separate claims.',
    'V3 (2026-11-01): one redemption transaction confirmed and checked output by output: 9,000,000 to the holder + 1,000,000 fee from the 10,000,000 note; reserve continues with 40,000,000.',
  ],
  notEstablished: [
    'Recorded checks trusted one node (ours); there was no independent consensus validation. The live read below adds the public explorer as a second, third-party source.',
    'The tracker was not told about the redemption: its own figures (amount_redeemed 0, outstanding 10,000,000) are STALE.',
    'Exclusive backing: one reserve backs every committed debt of its owner; Basis has no per-note allocation.',
    'Censorship resistance: a tracker that omits a note blocks its redemption (upstream README).',
    'Finality: confirmations are a policy threshold, not finality.',
    'Any market, adoption or monetary value: this was a single-operator test with testnet coins.',
  ],
};

export function createTestnetReader({fetchImpl = fetch, ttlMs = 120_000, now = () => Date.now()} = {}) {
  let cache = null;
  async function get(path) {
    const r = await fetchImpl(EXPLORER_API + path, {signal: AbortSignal.timeout(8000), headers: {accept: 'application/json'}});
    if (!r.ok) throw Error(`explorer ${r.status}`);
    return r.json();
  }
  async function read() {
    const at = new Date(now()).toISOString();
    const out = {source: `public explorer ${EXPLORER_API} (third party, not our node)`, at, network: null, boxes: [], redemption: null, error: null};
    try {
      const ns = await get('/networkState');
      out.network = {height: ns.height};
      for (const b of RECORDED.boxes) {
        try {
          const j = await get(`/boxes/${b.box}`);
          const tokens = (j.assets || []).map(a => a.tokenId);
          const checks = {
            exists: j.boxId === b.box,
            mainChain: j.mainChain === true,
            value: j.value === b.value,
            spentAsRecorded: (j.spentTransactionId ?? null) === b.spentBy,
            token: b.token ? tokens.includes(b.token) : tokens.length === 0,
          };
          out.boxes.push({role: b.role, box: b.box, value: j.value, spentBy: j.spentTransactionId ?? null, settlementHeight: j.settlementHeight, checks, ok: Object.values(checks).every(Boolean)});
        } catch (e) { out.boxes.push({role: b.role, box: b.box, error: e.message, ok: false}); }
      }
      const tx = await get(`/transactions/${RECORDED.steps.at(-1).tx}`);
      out.redemption = {tx: tx.id, inclusionHeight: tx.inclusionHeight, confirmations: tx.numConfirmations,
        inputs: tx.inputs.map(i => i.boxId), dataInputs: tx.dataInputs.map(i => i.boxId), outputs: tx.outputs.map(o => ({box: o.boxId, value: o.value}))};
    } catch (e) { out.error = e.message; }
    out.allMatch = !out.error && out.boxes.length === RECORDED.boxes.length && out.boxes.every(b => b.ok);
    return out;
  }
  return async function live() {
    if (cache && now() - cache.t < ttlMs) return {...cache.v, cached: true};
    const v = await read();
    cache = {t: now(), v};
    return {...v, cached: false};
  };
}
