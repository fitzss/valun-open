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
]);
