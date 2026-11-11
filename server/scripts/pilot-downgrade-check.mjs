// Before running server release v15 code on a pilot state that release v16 wrote (design §12.5, rollback): checks that
// nothing of circulating credit is still under way that v15 cannot finish or would get wrong, and then prepares the
// state for v15. Run it with the server STOPPED (a running server overwrites the file at its next save), on the
// pilot-state.json of the data folder (on the host: /data/pilot/pilot-state.json). In the image the entrypoint runs it
// before anything starts when VALUN_MAINTENANCE=downgrade-check (or downgrade-check-dry-run) is set, and exits with its
// exit code (scripts/docker-entrypoint.sh; docs/PILOT-API.md "Rollback to release v15").
//
// Usage: node scripts/pilot-downgrade-check.mjs <pilot-state.json> [--dry-run] [--now <ISO time or ms>]
//
// It refuses (exit 1, nothing written) while any of these exists:
//   - a payment by transfer awaiting its payer's owner, collecting signatures or being applied (v15 knows no
//     transfers: it would neither apply nor end it, and its deal would stay paying_by_transfer or held);
//   - a payment by transfer whose outcome is unknown (outcome_unknown or inconsistent): it may have paid the deal, and
//     v15 would let the payer pay it again. Its payer's owner resolves it first, while circulating credit is still on
//     (POST /pilot/v1/owner/deals/{vd}/attempts/{vt}/resolve exists in every mode but off, since MIG-4);
//   - a set-off collecting signatures or being applied;
//   - a deal paying_by_transfer, or a pending pay_by_transfer approval (v15 would decide it as another kind);
//   - a bound credit note held for its owner or being issued (v15 sends it without its prior acknowledgment: tracker
//     v3 refuses it, and the 3df7ed93 tracker would record it unbound).
// How to clear them: let the v16 server run with PILOT_CIRCULATION=off for at least 31 minutes (transfers stop
// collecting after 20, set-offs after 30; recovery, every 60 s, records that and decides those being applied), after
// the owners have resolved any outcome_unknown attempt and decided any held note; then stop it and run this again.
//
// Otherwise (exit 0) it writes a backup of the file as it was (<file>.v16-backup-<UTC time>, never overwriting one),
// maps every deal that is payment_due (the delivery accepted, the payment by transfer not applied) to note_failed,
// which v15 knows (the payer pays it with its own credit note), purges every unapplied note signature (MIG-1, design
// §12.5: the 3df7ed93 tracker has no maximum age and no bound-only edges, so a bound note v16 counts dead, or an
// ordinary one on an edge a transfer or set-off changed, would apply there): the signature and prior_signature of each
// payer-signed note the tracker did not record that v15 will not send (a deal's credit note unless it is issuing_note
// or completion_awaiting_owner, and its rejected, voided and replaced notes), keeping their sha256 as v16 does; the
// backup keeps them. It saves the file as the server does (atomically) and appends an audit line (downgrade.v15_prepared)
// to pilot-audit.jsonl next to it. --dry-run only reports.
// It also lists what v15 then shows differently (warnings, exit code unchanged): see `warnings` below, among them what
// running v15 code on tracker v3.2 does (ordinary notes at 995-999 ms and unbound notes on bound-only edges refused).
// Exit 2: usage, or a file that cannot be read or is not a pilot state.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--now');
const dry = args.includes('--dry-run');
const nowArg = opt('now');
const now = nowArg === undefined ? Date.now() : /^\d+$/.test(nowArg) ? Number(nowArg) : Date.parse(nowArg);
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
if (!file) fail('usage: node scripts/pilot-downgrade-check.mjs <pilot-state.json> [--dry-run] [--now <ISO time or ms>]');
if (!Number.isFinite(now)) fail(`--now: not a time: ${nowArg}`);

let text, s;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { fail(`cannot read ${file}: ${e.code || e.message}`); }
try { s = JSON.parse(text); } catch { fail(`${file} is not JSON`); }
if (!s || typeof s !== 'object' || !s.deals || typeof s.deals !== 'object' || !s.participants || typeof s.participants !== 'object')
  fail(`${file} is not a pilot state (no deals or participants)`);

const iso = t => new Date(t).toISOString();
const LIVE_TRANSFER = ['awaiting_owner', 'collecting', 'applying'], UNRESOLVED_TRANSFER = ['outcome_unknown', 'inconsistent'];
const LIVE_SETOFF = ['collecting', 'applying'];
const FALLBACK_MS = 3600000 + 60000;            // decision D-1: any new payment of the deal after T + 1 h + 60 s
const transfers = Object.values(s.transfers || {}), setoffs = Object.values(s.setoffs || {}), deals = Object.values(s.deals);
const ended = (x, ttl) => Number.isFinite(Date.parse(x.expires_at)) && now > Date.parse(x.expires_at)
  ? ` (its collection window ended ${x.expires_at}; the v16 server records it as expired at its next read or recovery, within 60 s: run it once more, then check again)` : ttl;

const refusals = [];
for (const t of transfers) {
  if (LIVE_TRANSFER.includes(t.state)) refusals.push(`transfer ${t.id} (deal ${t.deal_id}) is ${t.state}${t.state === 'applying'
    ? ': recovery decides it by reading the tracker back' : ended(t, `: it stops collecting at ${t.expires_at}`)}`);
  else if (UNRESOLVED_TRANSFER.includes(t.state)) refusals.push(`transfer ${t.id} (deal ${t.deal_id}) is ${t.state}: it may have paid the deal; its payer's owner resolves it (after confirming with the payee) while circulating credit is still on`);
}
for (const o of setoffs) if (LIVE_SETOFF.includes(o.state)) refusals.push(`set-off ${o.id} is ${o.state}${o.state === 'applying'
  ? ': recovery decides it by reading the tracker back' : ended(o, `: it stops collecting at ${o.expires_at}`)}`);
for (const d of deals) {
  if (d.status === 'paying_by_transfer') refusals.push(`deal ${d.id} is paying_by_transfer (v15 does not know this status)`);
  const n = d.credit_note;
  if ((d.status === 'completion_awaiting_owner' || d.status === 'issuing_note') && n?.note?.prior_signature)
    refusals.push(`deal ${d.id} holds a bound credit note (${d.status}): v15 would send it without its prior acknowledgment; the owner approves or rejects it first (issuing_note: recovery settles it)`);
}
for (const a of Object.values(s.approvals || {})) if (a.kind === 'pay_by_transfer' && a.state === 'pending')
  refusals.push(`approval ${a.id} (deal ${a.deal_id}) is a pending pay_by_transfer approval: v15 cannot decide this kind`);

if (refusals.length) {
  console.log(`REFUSED: ${file} still has ${refusals.length} item${refusals.length === 1 ? '' : 's'} of circulating credit under way; nothing was written.`);
  for (const r of refusals) console.log(`  - ${r}`);
  console.log('Resolve outcome_unknown attempts and decide held notes first; then run the v16 server with PILOT_CIRCULATION=off for at least 31 minutes, stop it and run this again.');
  process.exit(1);
}

// What v15 then shows differently (nothing here moves value; the tracker keeps every note as it is).
const due = deals.filter(d => d.status === 'payment_due');
const warnings = [];
const converted = deals.filter(d => d.payment && typeof d.payment === 'object' && d.payment.method === 'transfer' && !d.credit_note);
if (converted.length) warnings.push(`v15's migrate() turns the payment-by-transfer record (d.payment) of ${converted.length} deal(s) without a credit note into a credit-note record with no note (shown, not used): ${converted.map(d => d.id).join(', ')}`);
const paid = deals.filter(d => d.status === 'paid_by_transfer');
if (paid.length) warnings.push(`${paid.length} deal(s) paid by transfer keep the status paid_by_transfer, which v15 does not know (no inbox list or position count; the tracker holds the transfer): ${paid.map(d => d.id).join(', ')}`);
const windows = due.map(d => {
  const until = Math.max(0, ...(d.transfer_ids || []).map(id => s.transfers?.[id]).filter(t => t && t.state !== 'applied')
    .map(t => (Number.isSafeInteger(t.fallback_after) ? t.fallback_after : t.timestamp + FALLBACK_MS)),
    ...(d.refused_attempts || []).filter(a => a.kind === 'transfer').map(a => a.timestamp + FALLBACK_MS));
  return until > now ? `${d.id} until ${iso(until)}` : null;
}).filter(Boolean);
if (windows.length) warnings.push(`v15 does not enforce decision D-1's waiting time: a payer could pay these deals with its own note before an earlier transfer attempt is dead (a 0.4 client still refuses by itself, rule R11): ${windows.join(', ')}`);
const novated = Object.values(s.edges || {}).filter(e => e?.novated).length;
if (novated) warnings.push(`v15's reconciliation expects each edge's tracker total to be the credit notes issued through Valun: the ${novated} edge(s) a transfer or set-off changed will not match`);
const odd = [...transfers.filter(t => t.state === 'inconsistent'), ...setoffs.filter(o => o.state === 'inconsistent')];
if (odd.length) warnings.push(`set-offs left inconsistent (an alarm for the operator; nothing to finish): ${odd.map(x => x.id).join(', ')}`);
// v15 code on tracker v3.2 (only the app goes back): liveness only, nothing moves, but some pairs get stuck.
warnings.push(`if only the app goes back to v15 and tracker v3.2 keeps running: v15's ordinary credit-note templates can end in 995-999 ms, which tracker v3.2 keeps for other operations and refuses (an occasional note_failed: the payer signs a new note), and tracker v3.2 refuses every unbound note on a bound-only edge, so ${novated ? `the ${novated} edge(s) a transfer or set-off changed` : 'any edge a transfer or set-off changed'} can no longer be paid with v15's credit notes; run v15 with the 3df7ed93 tracker binary (after the drain of design §12.5), or expect those pairs to stay stuck`);
warnings.push('to run the 3df7ed93 tracker binary as well, the config needs the node layout again (BASIS_CONFIG_LAYOUT=auto picks it), and that binary accepts unbound notes on bound-only edges: no novation signature may be left unapplied (design §12.5); this check refuses while a transfer or set-off is under way and purges the unapplied note signatures (see below), and its backup keeps them');

for (const d of due) d.status = 'note_failed';
// MIG-1: the unapplied note signatures (sha256 kept, as v16 keeps them: lib/pilot/core.mjs ownNoteAttempts reads
// note.signature_sha256). Applied ones (recorded notes, applied transfers and set-offs) can never apply again: an
// edge's timestamps only grow.
const sigSha256 = sig => crypto.createHash('sha256').update(Buffer.from(String(sig), 'hex')).digest('hex');
const purgedDeals = [];
let purgedNotes = 0;
for (const d of deals) {
  const sent = d.status === 'issuing_note' || d.status === 'completion_awaiting_owner' ? d.credit_note : null;   // v15 still sends it
  let any = false;
  for (const n of [d.credit_note, ...(d.rejected_notes || []), ...(d.void_notes || []), ...(d.replaced_notes || [])]) {
    if (!n?.note || typeof n.note !== 'object' || n === sent || n.state === 'recorded') continue;
    let hit = false;
    if (typeof n.note.signature === 'string') { n.note.signature_sha256 ??= sigSha256(n.note.signature); delete n.note.signature; hit = true; }
    if (typeof n.note.prior_signature === 'string') { n.note.prior_signature_sha256 ??= sigSha256(n.note.prior_signature); delete n.note.prior_signature; hit = true; }
    if (hit) { purgedNotes += 1; any = true; }
  }
  if (any) purgedDeals.push(d.id);
}
const stamp = iso(now).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
let backup = `${file}.v16-backup-${stamp}`;
if (!dry) {
  for (let i = 1; fs.existsSync(backup); i++) backup = `${file}.v16-backup-${stamp}-${i}`;
  fs.writeFileSync(backup, text, {flag: 'wx'});
  if (due.length || purgedNotes) {
    const tmp = `${file}.downgrade.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, file);
  }
  fs.appendFileSync(path.join(path.dirname(file), 'pilot-audit.jsonl'), JSON.stringify({at: iso(now), type: 'downgrade.v15_prepared',
    backup: path.basename(backup), payment_due_to_note_failed: due.map(d => d.id), ...(purgedNotes ? {signatures_purged: {notes: purgedNotes, deals: purgedDeals}} : {})}) + '\n');
}
console.log(`${dry ? 'DRY RUN, nothing written: ' : ''}OK for a v15 rollback: no payment by transfer or set-off is under way.`);
if (!dry) console.log(`  backup of the file as it was: ${backup}`);
console.log(`  payment_due -> note_failed: ${due.length ? due.map(d => d.id).join(', ') : 'none'}${dry && due.length ? ' (not written)' : ''}`);
console.log(`  unapplied note signatures purged (sha256 kept): ${purgedNotes ? `${purgedNotes} note${purgedNotes === 1 ? '' : 's'} in ${purgedDeals.length} deal${purgedDeals.length === 1 ? '' : 's'}${dry ? ' (not written)' : `: ${purgedDeals.join(', ')}; the backup keeps them`}` : 'none'}`);
for (const w of warnings) console.log(`  note: ${w}`);
process.exit(0);
