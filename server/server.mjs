// Valun: web app + JSON API + MCP endpoint, on a real Basis tracker. Wiring and startup only; see lib/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Basis, makeSignerRunner, describeCapabilities, trackerPin} from './lib/basis.mjs';
import {Store} from './lib/store.mjs';
import {Valun} from './lib/valun.mjs';
import {createTestnetReader} from './lib/testnet.mjs';
import {createService} from './lib/service.mjs';
import {createMcp} from './lib/mcp.mjs';
import {createHandler} from './lib/http.mjs';
import {seed} from './lib/seed.mjs';
import crypto from 'node:crypto';
import {Pilot, PilotStore, PILOT_DENOMINATION} from './lib/pilot/core.mjs';
import {NETWORK, ON_TESTNET} from './lib/pilot/units.mjs';
import {createPilotRoutes, PUBLIC_CACHE_MS} from './lib/pilot/http.mjs';
import {createA2A} from './lib/a2a.mjs';
import {TRACKER_SHA256_PINS} from './lib/pilot/pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const cfg = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 4320),
  dataDir: path.resolve(env.VALUN_DATA_DIR || path.join(here, 'data')),
  trackerUrl: env.BASIS_TRACKER_URL || 'http://127.0.0.1:3048',
  trackerNftId: env.BASIS_TRACKER_NFT_ID || '',
  signer: env.BASIS_SIGNER || '/opt/valun/bin/valun_signer',
  runner: env.BASIS_RUNNER || 'direct',
  deployment: env.VALUN_DEPLOYMENT || 'local',
  writeToken: env.VALUN_WRITE_TOKEN || '',
  trustFlyClientIp: env.VALUN_TRUST_FLY_CLIENT_IP === '1',
  // Burst protection for the public pilot reads (lib/pilot/http.mjs): at most one computation per this many ms while the
  // pilot state is unchanged; 0 turns it off.
  publicCacheMs: /^\d{1,6}$/.test(env.PILOT_PUBLIC_CACHE_MS ?? '') ? Number(env.PILOT_PUBLIC_CACHE_MS) : PUBLIC_CACHE_MS,
  seed: env.VALUN_SEED !== '0',
  // The tracker source /api/status names. For tracker v3 it is taken from the demo tracker's GET /capabilities at
  // startup (main below: tracker v3.2 = Valun fork commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a, basis/BUILD.md);
  // a tracker without capabilities is the Basis 3df7ed93 build. BASIS_PIN overrides both.
  basisPin: env.BASIS_PIN || 'Basis 3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3 + sigma-rust 8120eddd',
};
if (!cfg.trackerNftId) {
  const f = path.join(cfg.dataDir, 'tracker-nft-id');
  if (fs.existsSync(f)) cfg.trackerNftId = fs.readFileSync(f, 'utf8').trim();
}
if (!/^[0-9a-f]{64}$/.test(cfg.trackerNftId)) { console.error('BASIS_TRACKER_NFT_ID (or data/tracker-nft-id) must be the tracker\'s 32-byte id'); process.exit(1); }

const store = new Store(cfg.dataDir);
const basis = new Basis({trackerUrl: cfg.trackerUrl, trackerNftId: cfg.trackerNftId, runSigner: makeSignerRunner({mode: cfg.runner, signerPath: cfg.signer})});
const valun = new Valun({store, basis});
const service = createService({valun, basis, store, cfg, testnetLive: createTestnetReader()});
const mcp = createMcp({service, store});

// Pilot network (valun-pilot-1, or valun-testnet-1 with PILOT_NETWORK: lib/pilot/units.mjs): enabled when a second,
// pilot-only Basis tracker is configured.
const pilotCfg = {trackerUrl: env.PILOT_TRACKER_URL || '', nftId: env.PILOT_TRACKER_NFT_ID || '', dataDir: path.resolve(env.PILOT_DATA_DIR || path.join(cfg.dataDir, '..', 'pilot'))};
let pilot = null, pilotRoutes = null;
if (pilotCfg.trackerUrl) {
  if (!/^[0-9a-f]{64}$/.test(pilotCfg.nftId)) { console.error("PILOT_TRACKER_NFT_ID must be the pilot tracker's 32-byte id"); process.exit(1); }
  const pilotBasis = new Basis({trackerUrl: pilotCfg.trackerUrl, trackerNftId: pilotCfg.nftId, denomination: ON_TESTNET ? 'erg' : PILOT_DENOMINATION,
    runSigner: makeSignerRunner({mode: cfg.runner, signerPath: cfg.signer})});
  // Circulating credit (design §4.1): PILOT_CIRCULATION = off (default) | bound | sandbox | on; it takes effect only with a
  // tracker whose capabilities validate and whose binary's sha256 (PILOT_TRACKER_SHA256, computed by the launcher) is
  // pinned in lib/pilot/pins.mjs. Otherwise the pilot runs with circulation off and logs why.
  pilot = new Pilot({store: new PilotStore(pilotCfg.dataDir), basis: pilotBasis, openSandbox: env.PILOT_OPEN_SANDBOX === '1',   // self-serve sandbox join: off unless PILOT_OPEN_SANDBOX=1
    openNetwork: env.PILOT_OPEN_NETWORK === '1',   // self-serve participants deal with anyone (core.mjs OPEN_NETWORK_MAX_OPEN_OFFERS): off unless 1
    circulation: env.PILOT_CIRCULATION || 'off', trackerSha256: env.PILOT_TRACKER_SHA256 || null});
  // The Valun testnet network (PILOT_NETWORK=valun-testnet-1): where its tracker is anchored on Ergo testnet. on_chain
  // only once the tracker's NFT was minted (the launcher sets PILOT_TRACKER_ON_CHAIN=1 then).
  if (ON_TESTNET) pilot.chain = {name: 'ergo-testnet', on_chain: env.PILOT_TRACKER_ON_CHAIN === '1', tracker_nft_id: pilotCfg.nftId,
    tracker_address: env.PILOT_TRACKER_ADDRESS || null, reserve_contract: env.PILOT_RESERVE_CONTRACT || null,
    node: env.ERGO_NODE_URL || 'http://213.239.193.208:9052', explorer: 'https://testnet.ergoplatform.com'};
  // Admin (invites) only from loopback inside the host, with a token kept on the data volume. No public admin route.
  const adminFile = path.join(pilotCfg.dataDir, 'admin-token');
  if (!fs.existsSync(adminFile)) fs.writeFileSync(adminFile, crypto.randomBytes(24).toString('base64url'), {mode: 0o600});
  pilotRoutes = createPilotRoutes({pilot, cfg, adminTokenHash: crypto.createHash('sha256').update(fs.readFileSync(adminFile, 'utf8').trim()).digest('hex')});
}
// The A2A front door (read-only: directory, how to join, recent loops) exists with the pilot.
const a2a = pilot ? createA2A({pilot}) : null;
const server = http.createServer(createHandler({service, mcp, cfg, publicDir: path.join(here, 'public'), pilotRoutes, a2a}));
// The clearing engine, once, when the effective mode is sandbox or on (at startup, or when MIG-1's refusal lifts).
async function startClearing() {
  if (!pilot || !pilot.circulating || pilot.clearing) return;
  const {Clearing} = await import('./lib/pilot/clearing.mjs');
  pilot.clearing = new Clearing({pilot, log: m => console.log(m)}).start();
  console.log('Pilot: clearing engine running');
}

async function main() {
  for (let i = 0; i < 60 && !(await basis.health().catch(() => false)); i++) await new Promise(r => setTimeout(r, 500));
  if (!(await basis.health().catch(() => false))) throw Error(`Basis tracker not reachable at ${cfg.trackerUrl}`);
  // A tracker that reports its build (tracker v3) is named by its own commit, as its own report, with '(binary not
  // pinned)' unless the launcher's sha256 of the basis_server it runs (PILOT_TRACKER_SHA256) is in lib/pilot/pins.mjs;
  // any other tracker keeps the text above.
  if (!env.BASIS_PIN) cfg.basisPin = trackerPin(await basis.capabilities().catch(() => null), cfg.basisPin, {pinned: TRACKER_SHA256_PINS.includes(env.PILOT_TRACKER_SHA256)});
  if (pilot) {
    for (let i = 0; i < 60 && !(await pilot.basis.health().catch(() => false)); i++) await new Promise(r => setTimeout(r, 500));
    if (!(await pilot.basis.health().catch(() => false))) throw Error(`pilot tracker not reachable at ${pilotCfg.trackerUrl}`);
    // What the pilot tracker says it enforces (GET /capabilities, tracker v3); null for an older tracker. A failed read
    // counts as null (fail closed). Kept on the pilot as trackerCaps (setting it applies the effective circulation mode:
    // migrate() adds what that mode needs); one log line says what it is, another which mode is in effect (and, when
    // it is not the one requested, why: Pilot.mode logs the reason). With null, ordinary note templates still ask the
    // tracker for its reserved residues again (Pilot.reservedResidues, MIG-5). MIG-1 (release v16.1): capabilities that
    // are not tracker v3.2's on a state with circulating-credit history make the pilot refuse every write to its tracker
    // (Pilot.writeRefusal: one ALARM, with what that tracker would revive; 503 tracker_downgraded; GET /pilot/v1/info
    // writes_refused) until a read every 60 s (Pilot.recheckTracker, below) finds tracker v3.2 again.
    pilot.trackerCaps = await pilot.basis.capabilities().then(
      caps => { console.log(`Pilot: tracker capabilities: ${describeCapabilities(caps)}`); return caps; },
      e => { console.error(`Pilot: tracker capabilities: unknown, the read failed (${e.message}); treated as none`); return null; });
    const circ = pilot.circulationStatus();
    console.log(`Pilot: circulating credit: ${pilot.mode}${circ.requested !== circ.mode ? ` (requested ${JSON.stringify(circ.requested)})` : ''}`);
    const pr = await pilot.recover();
    if (pr.length) console.log(`Pilot: recovered interrupted payments: ${pr.join(', ')}`);
    // The edge journal's compaction (release v16.1, readiness R-19): at startup and then on the timer, at most once a day
    // and only while pilot-edge-log.jsonl is larger than 16 MiB (Pilot.maybeCompactJournal; it never throws).
    await pilot.maybeCompactJournal();
    // And every 60 s while running (invariant I-DECIDE): a deal left issuing_note by a tracker failure is settled without
    // waiting for a restart (its key pair is pair_busy meanwhile). recover() takes the pilot lock itself; the timer does
    // not keep the process alive. While pilot writes are refused (MIG-1) it first reads the tracker's capabilities again:
    // once they are tracker v3.2's, the requested mode applies as at startup (the clearing engine starts when it runs).
    setInterval(() => pilot.recheckTracker()
      .then(async lifted => {
        if (!lifted) return;
        const c = pilot.circulationStatus();
        console.log(`Pilot: tracker capabilities: ${describeCapabilities(pilot.trackerCaps)}`);
        console.log(`Pilot: circulating credit: ${pilot.mode}${c.requested !== c.mode ? ` (requested ${JSON.stringify(c.requested)})` : ''}`);
        await startClearing();
      })
      .then(() => pilot.recover())
      .then(r => { if (r.length) console.log(`Pilot: periodic recovery: ${r.join(', ')}`); })
      .catch(e => console.error(`Pilot: periodic recovery failed: ${e.message}`))
      .then(() => pilot.maybeCompactJournal()).catch(e => console.error(`Pilot: journal compaction failed: ${e.message}`)), 60000).unref();
    // Always-on deterministic sandbox participants (sandbox-exact, sandbox-mallory); PILOT_SANDBOX=0 turns them off.
    if (env.PILOT_SANDBOX !== '0') {
      const {Sandbox} = await import('./lib/pilot/sandbox.mjs');
      await new Sandbox(pilot, {dataDir: pilotCfg.dataDir, log: m => console.log(m)}).start()
        .then(() => console.log('Pilot: sandbox agents running'), e => console.error(`Pilot: sandbox not started: ${e.message}`));
    }
    // The clearing engine (multilateral set-off; lib/pilot/clearing.mjs), after the sandbox (its agents are members in
    // mode sandbox), in circulation modes sandbox and on only: a batch search at startup and every 10 minutes, the
    // incremental search after every increase, proposals on consent polls. Its timers do not keep the process alive.
    await startClearing();
  }
  const recovered = await valun.recover();
  if (recovered.length) console.log(`Recovered interrupted submissions: ${recovered.map(r => `${r.id}=${r.status}`).join(', ')}`);
  if (cfg.seed && !store.state.seededAt) { console.log('Seeding (or finishing) the synthetic demo world...'); await seed(valun); }
  server.listen(cfg.port, cfg.host, () => console.log(`Valun (${cfg.deployment}) on http://${cfg.host}:${cfg.port} - tracker ${cfg.trackerUrl} - MCP at /mcp${pilot ? ` - ${NETWORK} ${pilot.basis.url} (${pilot.basis.denomination.slice(0, 18)}…)` : ''}`));
}
// Graceful stop (Fly sends SIGINT when it stops an idle machine): finish in-flight requests, then exit.
// The entrypoint stops the tracker only after this process has exited.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  console.log(`${sig}: finishing in-flight requests`);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 4000).unref();
});
main().catch(e => { console.error(e.message); process.exit(1); });
