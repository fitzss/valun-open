// The tracker binaries circulating credit may run on (design §4.1): the sha256 of basis_server, computed by the launcher
// and passed as PILOT_TRACKER_SHA256. A mode other than off takes effect only when the running binary's hash is listed
// here (lib/pilot/caps.mjs). Add a hash only for a build whose rules have been checked (TR-1 to TR-11). basis/BUILD.md
// gives the build recipe and the same hashes.
export const TRACKER_SHA256_PINS = Object.freeze([
  // tracker v3.2 (branch circulating-credit-v3.2, commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a: prior acknowledgments
  // PA(I,R,X,p,T) bind the prior state, audit VS-1 and R-17; transfers version 4, bound notes version 3), built offline
  // and staged at /home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release/basis_server.
  // Not pinned: tracker v3.1 (commit 24675ec1c0f374f29101812caf2fc87ab48468c9, basis_server cc0a6ade...) and TR-6's v3
  // build (9eca6480...). They report build valun-circulating-credit/3, which validateCaps no longer accepts (their prior
  // acknowledgments bind only the prior total), so a pin could never take effect; v3.1 was never deployed.
  'e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5',
  // tracker v4 (branch circulating-credit-v4, commit 602565e: the same Valun series TR-1..TR-13 rebased on upstream
  // master 43e2173, which adds multi-collateral reserves, local redemption signing and acceptance policy, plus TR-14),
  // built offline (target-v4) and staged at /home/valun/valun-app-bins-v4-20261112T1215Z/t/release/basis_server. Tracker
  // tests 784 passed, 0 failed. It runs the Valun testnet network (Ergo testnet) and may run the pilot.
  '6e410ab45a1a4a91efaa76ffd9d72acfc5c440ae4a4a553aad32ba1926a6849e',
  // tracker v4.1 (branch circulating-credit-v4, commit 6f00d1636d5eff2122dfd2d57b3f2ad876e3a031: v4 + TR-15 anchored
  // netting: with [server] anchored_netting, debt transfers and set-offs on edges with on-chain totals, never below a
  // redemption authorization and only while the tracker box is fresh; GET /capabilities anchored_netting version 1),
  // built offline (target-v4) and staged at /home/valun/valun-app-bins-v41-20261112T1306Z/t/release/basis_server.
  // Tracker tests 789 passed, 0 failed. It runs the Valun testnet network with circulation on.
  'd13541944f0bffa2e4d78acea0ca4f7e351e28a4adb95fedc186f0e2b927bb77',
  // tracker v4.2 (branch circulating-credit-v4, commit 4d91c47f3c51b1a3fa1a44951e7e389243c3fe7e: v4.1 + TR-16, TR-17:
  // the tracker box updater keeps running (its shutdown channel was closed at start, so it stopped after one cycle and
  // an on-chain tracker never anchored), puts the digest in shared state before startup, and polls an update in flight
  // every 30 s), staged at /home/valun/valun-app-bins-v42-20261112T1450Z/t/release/basis_server. Tracker tests 790/0.
  'b3e1a9b8cf72f77a3505f5073e680759539eeefd24e93b4f689798e6d9f03850',
  // tracker v4.3 (branch circulating-credit-v4, commit b84b2e780894beb980d789be22ec888ffe97d65a: v4.2 + TR-18: an address
  // of either network gives its ErgoTree, so a testnet tracker builds redemptions against its testnet-encoded reserve
  // contract), staged at /home/valun/valun-app-bins-v43-20261112T1455Z/t/release/basis_server. Tracker tests
  // (basis_offchain, basis_store, basis_server) 756 passed, 0 failed; basis_core is unchanged since v4.2 (35 passed).
  '9a114a1c3e3450add249701929c3445d19e68ae3992ad3d55ab6d3d3a59e1fb9',
]);
