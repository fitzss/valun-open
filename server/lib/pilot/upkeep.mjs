// What server.mjs runs for the network besides requests: the hold of an unfinished join from the environment
// (joinHoldOptions), the release of the unfinished joins whose hold has ended, at startup (releaseJoins), and the
// periodic upkeep every UPKEEP_MS (upkeep). They live here, not in server.mjs, so that tests run exactly what the server
// runs (test/unfinished-join.unit.test.mjs; the review of fix inbox #131 found the server's own calls untested).
import {describeCapabilities} from '../basis.mjs';

export const UPKEEP_MS = 60000;

// PILOT_UNCLAIMED_JOIN_TTL_MS, how long a self-serve join whose agent never enrolled holds its handle (fix inbox #131;
// core.mjs UNCLAIMED_JOIN_TTL_MS, 1 hour by default), in whole ms, as the Pilot's constructor option: {} (the default)
// unless it is 1 to 10 digits. The hold never ends before its enrollment code expires, whatever this says.
export function joinHoldOptions(env = {}) {
  const v = env.PILOT_UNCLAIMED_JOIN_TTL_MS;
  return typeof v === 'string' && /^\d{1,10}$/.test(v) ? {unclaimedJoinTtlMs: Number(v)} : {};
}

// Releases the unfinished joins whose hold has ended (Pilot.releaseUnfinishedJoins: their handles are free again) and
// logs which; never rejects (a failure is logged). Resolves to the released [{id, handle}].
export function releaseJoins(pilot, {log = console.log, error = console.error} = {}) {
  return pilot.releaseUnfinishedJoins().then(r => {
    if (r.length) log(`Pilot: released ${r.length} unfinished join${r.length === 1 ? '' : 's'} (no agent key ever enrolled), their handles free again: ${r.map(x => x.handle).join(', ')}`);
    return r;
  }, e => { error(`Pilot: releasing unfinished joins failed: ${e.message}`); return []; });
}

// One periodic upkeep (server.mjs runs it every UPKEEP_MS while it runs; it never rejects, each step logs its own
// failure and the next one runs):
//   - while pilot writes are refused (MIG-1), the tracker's capabilities are read again; once they are tracker v3.2's,
//     the requested circulation mode applies as at startup, and startClearing() starts the clearing engine;
//   - recovery (invariant I-DECIDE): a deal left issuing_note by a tracker failure is settled without waiting for a
//     restart (its key pair is pair_busy meanwhile); recover() takes the pilot lock itself;
//   - the release of the unfinished joins whose hold has ended (releaseJoins);
//   - the edge journal's compaction (release v16.1, readiness R-19: at most once a day, and only while
//     pilot-edge-log.jsonl is larger than 16 MiB; Pilot.maybeCompactJournal).
export function upkeep(pilot, {startClearing = async () => {}, log = console.log, error = console.error} = {}) {
  return pilot.recheckTracker()
    .then(async lifted => {
      if (!lifted) return;
      const c = pilot.circulationStatus();
      log(`Pilot: tracker capabilities: ${describeCapabilities(pilot.trackerCaps)}`);
      log(`Pilot: circulating credit: ${pilot.mode}${c.requested !== c.mode ? ` (requested ${JSON.stringify(c.requested)})` : ''}`);
      await startClearing();
    })
    .then(() => pilot.recover())
    .then(r => { if (r.length) log(`Pilot: periodic recovery: ${r.join(', ')}`); })
    .catch(e => error(`Pilot: periodic recovery failed: ${e.message}`))
    .then(() => releaseJoins(pilot, {log, error}))
    .then(() => pilot.maybeCompactJournal()).catch(e => error(`Pilot: journal compaction failed: ${e.message}`));
}
