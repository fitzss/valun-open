// Snapshot / compare what must survive a restart: the tracker's notes and digest, its NFT id, and Valun's records.
// Usage: node scripts/check-persistence.mjs snapshot BASE_URL FILE
//        node scripts/check-persistence.mjs compare  BASE_URL FILE     (exit 1 on any difference)
// With --pilot, the pilot network instead (/pilot/v1 on BASE_URL): its tracker NFT id and denomination, every ledger
// note (/pilot/v1/ledger), the reconciliation rows (v15's in every mode: the public ledger carries no journal columns,
// SV-PRIV-1; whatever columns a row has are compared), the participants' ids, handles, keys and statuses,
// and the pilot tracker's own local_digest, read from the tracker (loopback only, so run it on the host):
//        node scripts/check-persistence.mjs snapshot BASE_URL FILE --pilot [--pilot-tracker URL]
//        node scripts/check-persistence.mjs compare  BASE_URL FILE --pilot [--pilot-tracker URL]
// --pilot-tracker defaults to PILOT_TRACKER_URL, else http://127.0.0.1:3058 (the container's and start-local's pilot
// tracker). A tracker's live digest can differ from the one it computes when it starts after notes were updated in
// place (upstream Basis behaviour): take the snapshot after a restart, then restart again and compare.
import fs from 'node:fs';
const args = process.argv.slice(2), flags = new Set(args.filter(a => a.startsWith('--')));
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const pilotTracker = (opt('pilot-tracker') || process.env.PILOT_TRACKER_URL || 'http://127.0.0.1:3058').replace(/\/$/, '');
const [mode, base, file] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--pilot-tracker');
const pilot = flags.has('--pilot');
if (!['snapshot', 'compare'].includes(mode) || !base || !file) { console.error('usage: snapshot|compare BASE_URL FILE [--pilot [--pilot-tracker URL]]'); process.exit(2); }
const getFrom = async (root, p) => { const r = await fetch(root.replace(/\/$/, '') + p); if (!r.ok) throw Error(`${root}${p}: HTTP ${r.status}`); return r.json(); };
const get = p => getFrom(base, p);
// Canonical JSON (sorted keys), so a row compares by value whatever order its keys came in.
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);

async function take() {
  const [status, ledger, offers, participants] = await Promise.all([get('/api/status'), get('/api/ledger'), get('/api/offers'), get('/api/participants')]);
  return {
    trackerNftId: status.basis.trackerNftId,
    localDigest: ledger.trackerState.local_digest,
    notes: ledger.notes.map(n => `${n.issuer}>${n.recipient}=${n.total}/${n.redeemed}@${n.timestamp}`).sort(),
    offers: offers.map(o => `${o.id}:${o.status}:${o.termsHash}`).sort(),
    participants: participants.map(p => `${p.id}:${p.pubkey}`).sort(),
    reconciliation: ledger.reconciliation.map(r => r.status),
  };
}
async function takePilot() {
  const [info, ledger, participants, state] = await Promise.all([get('/pilot/v1/info'), get('/pilot/v1/ledger'), get('/pilot/v1/participants'),
    getFrom(pilotTracker, '/tracker/state')]);
  if (!state?.success || typeof state.data?.local_digest !== 'string') throw Error(`${pilotTracker}/tracker/state: no local_digest in the answer`);
  return {
    check: 'pilot',
    trackerNftId: info.tracker_nft_id,
    denomination: info.denomination,
    localDigest: state.data.local_digest,
    notes: ledger.notes.map(n => `${n.issuer_pubkey}>${n.recipient_pubkey}=${n.total}/${n.redeemed}@${n.timestamp}:${n.confirmation}:${n.issuer ?? '-'}>${n.recipient ?? '-'}`).sort(),
    reconciliation: ledger.reconciliation.map(canon).sort(),
    participants: participants.map(p => `${p.id}:${p.handle}:${p.pubkey ?? '-'}:${p.status}`).sort(),
  };
}
const now = await (pilot ? takePilot() : take()).catch(e => { console.error(`could not read: ${e.message}`); process.exit(2); });
const what = s => s.check === 'pilot'
  ? `pilot tracker NFT id, digest ${s.localDigest.slice(0, 12)}..., ${s.notes.length} notes, ${s.reconciliation.length} reconciliation rows, ${s.participants.length} participants`
  : `${s.notes.length} notes, ${s.offers.length} offers, ${s.participants.length} participants, digest ${s.localDigest.slice(0, 12)}...`;
if (mode === 'snapshot') {
  fs.writeFileSync(file, JSON.stringify(now, null, 1));
  console.log(`snapshot: ${what(now)}`);
} else {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  if ((before.check ?? 'demo') !== (now.check ?? 'demo')) { console.error(`${file} is a ${before.check ?? 'demo'} snapshot; compare it ${before.check === 'pilot' ? 'with' : 'without'} --pilot`); process.exit(2); }
  const diffs = Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(now[k]));
  if (!diffs.length) console.log(now.check === 'pilot' ? `SAME after restart: ${what(now)}` : `SAME after restart: tracker NFT id, digest, ${now.notes.length} notes, ${now.offers.length} offers, ${now.participants.length} participants`);
  else {
    console.log(`DIFFERENT after restart: ${diffs.join(', ')}`);
    for (const k of diffs.filter(k => Array.isArray(before[k]))) {
      const was = new Set(before[k]), is = new Set(now[k]);
      for (const x of before[k].filter(x => !is.has(x))) console.log(`  ${k}: gone     ${x}`);
      for (const x of now[k].filter(x => !was.has(x))) console.log(`  ${k}: new      ${x}`);
    }
    if (diffs.length === 1 && diffs[0] === 'localDigest') console.log('  Only the digest differs. A tracker\'s live digest can differ from the one it computes at startup after in-place note updates: take the snapshot after a restart and compare after another one.');
  }
  process.exit(diffs.length ? 1 : 0);
}
