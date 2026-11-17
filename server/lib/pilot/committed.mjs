// The committed snapshot (fix inbox #62): the notes the tracker's confirmed box on Ergo testnet commits, as the tracker
// records them, and the server's own check of those records against the box's digest. GET /pilot/v1/ledger/committed
// serves it (lib/pilot/http.mjs); Pilot.committedSnapshot (lib/pilot/core.mjs) reads it. Pure helpers: no I/O.
//
// What the tracker records (basis_store, the same in tracker v4.4, Valun fork commit 321f09b, as upstream 43e2173):
//   - GET /tracker/state: the confirmed box (confirmed_box_id, its creation height confirmed_height, the digest its R5
//     commits confirmed_digest) and the update in flight (pending_tx_id, pending_digest), as the tracker box updater
//     last saw them on chain;
//   - GET /notes: every note in every denomination, each with confirmation {status, confirmed_total_debt,
//     pending_total_debt, pending_tx_id, ...}. confirmed_total_debt is the total the confirmed box commits for the
//     note, or null when no box has committed it. It is not the note's live total (amount_collected): a note raised or
//     lowered since the box keeps the total the box commits (its status is then local_only, or pending while an update
//     carries its new total). The tracker's own committed tree (generate_committed_tracker_lookup_proof, the one its
//     redemption proofs come from) is exactly the notes with a confirmed_total_debt, at that total, whatever their
//     status; so are these rows. A note no box has committed (confirmed_total_debt null: a new note, local_only) is not
//     a row; a committed total of 0 is a row (a leaf of the tree).
//
// A read must not mix two anchors. GET /notes is not one read: the tracker lists the notes, then reads each note's
// confirmation in its own step, while writes and the box updater go on. Writes never change a confirmed total; an
// anchor's promotion does: the updater records the new box in its state (set_confirmed), clears the update in flight
// (clear_pending), and only then queues ConfirmPendingNotes, one command of the tracker's thread, which copies the
// pending total of every note still pending into confirmed_total_debt and clears those notes' marks (pending_tx_id,
// pending_total_debt). (The tracker also rewrites confirmed totals when it repairs its records: at a restart, and when
// the box's digest is its live digest, reconcile_with_confirmed_digest; GET /ledger/committed reads a box again at least
// every minute.) So a read is taken between two state reads, and it is settled (settleRead) when the two agree on the
// confirmed box, its digest and height and on the update in flight (anchoringMoved), and either no note in it is
// pending under an update other than the one in flight the second read names (pendingElsewhere), or the read before
// it, under the same anchoring, found exactly the same such notes. Such a note is mid-promotion (its confirmed total
// still the earlier box's) only until that one command runs, and the command changes them all at once. But tracker
// v4.4 also leaves marks for good: a promotion or a revert clears the marks of the notes whose status is pending at
// that moment only, so a note written again while its update was in flight keeps them (the promotion race below)
// until a later update marks it again or the tracker restarts, and its status is pending again whenever a later write
// brings it back to the total marked, under an update long confirmed. Those marks are the same at every read, so the
// second read settles them. An unsettled read is never checked against the box: Pilot.committedSnapshot reads again,
// and after SNAPSHOT_RETRIES more reads answers 503 snapshot_moving. A promotion under way gives no false mismatch
// unless the tracker's thread has not run it by the next read, SNAPSHOT_PAUSE_MS or more later (the updater queues it
// right after it records the box).
//
// The check (selfCheck): consistent is true exactly when the rows, digested as the tracker digests its notes
// (lib/avl.mjs: construction basis-avl/1, docs/PILOT-API.md), give the confirmed digest. A false is served as it is:
// the tracker's records of what its box commits disagree with the box, and until they agree again (normally at its
// next box) the tracker builds no redemption at all (generate_committed_tracker_lookup_proof rebuilds the committed
// tree from these totals and refuses every build on a mismatch, before any proof). Tracker v4.4 (as upstream) gets
// there two ways:
//   - the promotion race: confirm_pending_notes promotes only the notes whose status is still pending when the box
//     confirms, so a note written again while the update that carries it is in flight (raised by a note, lowered by a
//     set-off or a debt transfer) keeps the earlier box's total, although the box commits the total marked for it; its
//     marks stay, naming the update (unpromoted tells this race);
//   - the mark race: mark_notes_pending records the live totals of the moment it runs, after the update with the
//     earlier digest was signed and sent, so a write in between leaves a confirmed total the box never committed.
// Both leave the confirmed digest as it is (it is the box's R5), and both are fix inbox #65 (a fork fix, after the
// launch): until it ships, an honest testnet shows such windows from a raced box's confirmation until the next box, and
// what the server says of them (KNOWN_RACE, committedMeaning) says that, not tampering, and to read again after it.
// Rows that cannot be digested at all (an AvlError: a malformed key, two notes with one debt key, a total that is not
// a u64) are a false too, with the refusal as the reason.
import {AvlError, debtKey, digest as avlDigest} from '../avl.mjs';
import {BasisError} from '../basis.mjs';

// The tree construction of the rows' digest, as docs/PILOT-API.md pins it ("Committed ledger"): a change of key, value,
// order or tree is a new id, with new vectors.
export const CONSTRUCTION = 'basis-avl/1';
// Pilot.committedSnapshot: reads after the first when a read was not settled, the pause before the k-th of them
// (k x SNAPSHOT_PAUSE_MS, so a promotion under way can finish), and the retry_after_ms of 503 snapshot_moving.
export const SNAPSHOT_RETRIES = 3;
export const SNAPSHOT_PAUSE_MS = 250;
export const SNAPSHOT_RETRY_AFTER_MS = 5000;
// 503 no_confirmed_box: the tracker names no confirmed box (it has not read its box on chain since it started): ask
// again in about a minute.
export const NO_BOX_RETRY_AFTER_MS = 60_000;

const STATE_FIELDS = ['confirmed_box_id', 'confirmed_digest', 'confirmed_height', 'pending_tx_id'];
const value = v => (v === undefined ? null : v);

// Whether the tracker's anchoring differs between two GET /tracker/state reads: the confirmed box, its digest or its
// height, or the update in flight (absent fields count as null).
export function anchoringMoved(before, after) {
  return STATE_FIELDS.some(f => value(before?.[f]) !== value(after?.[f]));
}

// The notes of a GET /notes read whose status is pending under an update other than the one in flight that `st` (the
// state read after it) names, as one string ('' when there is none): each note's issuer, recipient, denomination,
// update and confirmed total, sorted. Such a note may be mid-promotion (its confirmed_total_debt still the earlier
// box's), or carry marks the tracker left (see above). A promotion changes the string (it clears the marks of every
// note it promotes); a write changes it only by moving a note's status between pending and another; a new update's
// marks come with a move of the anchoring.
export function pendingElsewhere(notes, st) {
  const inFlight = value(st?.pending_tx_id);
  return notes.filter(n => n?.confirmation?.status === 'pending' && value(n.confirmation.pending_tx_id) !== inFlight)
    .map(n => JSON.stringify([n.issuer_pubkey, n.recipient_pubkey, n.denomination ?? null, value(n.confirmation.pending_tx_id), value(n.confirmation.confirmed_total_debt)]))
    .sort().join('\n');
}

// Whether a read (the state `before`, the GET /notes data `notes`, the state `after`) is settled, `held` being what the
// read before it left: {settled, held}, where held is what this read leaves for the next one ({st, marks} when only its
// pendingElsewhere marks kept it from settling, else null). Settled: the anchoring did not move, and either no note is
// pending elsewhere, or the read before found the same ones under the same anchoring (marks a promotion would have
// cleared by now).
export function settleRead(before, notes, after, held = null) {
  if (anchoringMoved(before, after)) return {settled: false, held: null};
  const marks = pendingElsewhere(notes, after);
  if (marks === '' || (held !== null && !anchoringMoved(held.st, after) && held.marks === marks)) return {settled: true, held: null};
  return {settled: false, held: {st: after, marks}};
}

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const order = (a, b) => (a.debt_key === b.debt_key ? 0 : a.debt_key === null ? 1 : b.debt_key === null ? -1 : a.debt_key < b.debt_key ? -1 : 1);

// The rows of the committed snapshot from GET /notes data read with exact amounts (Basis.allNotes({exact: true}): each
// total the decimal string the tracker wrote): {debt_key, issuer_pubkey, recipient_pubkey, denomination,
// committed_total} for every note with a confirmed_total_debt, in ascending debt-key order (the order the tree is
// built in; lowercase hex compares as the bytes do). A row's fields are the tracker's, unchanged; debt_key is null for
// a row whose keys or denomination are malformed (selfCheck then fails, with the reason), and such rows come last. A
// note with no confirmation, or a confirmation without confirmed_total_debt, is a BasisError: the tracker's answer
// does not say whether the note is committed, so no snapshot is built from it.
export function committedRows(notes) {
  if (!Array.isArray(notes)) throw new BasisError('tracker GET /notes: the notes are not a list');
  const rows = [];
  notes.forEach((n, i) => {
    const c = n?.confirmation;
    if (c === null || typeof c !== 'object' || !Object.hasOwn(c, 'confirmed_total_debt')) {
      throw new BasisError(`tracker GET /notes: note ${i} has no confirmation with confirmed_total_debt, so whether its box commits it is unknown`);
    }
    if (c.confirmed_total_debt === null) return;
    let key = null;
    try { key = hex(debtKey(n.issuer_pubkey, n.recipient_pubkey, n.denomination ?? 'erg')); } catch (e) { if (!(e instanceof AvlError)) throw e; }
    rows.push({debt_key: key, issuer_pubkey: n.issuer_pubkey, recipient_pubkey: n.recipient_pubkey, denomination: n.denomination, committed_total: c.confirmed_total_debt});
  });
  return rows.sort(order);
}

// What rows that give another digest than the box's are on an honest server, said wherever the disagreement is reported
// (the snapshot's inconsistency, and so its anchor.inconsistent audit line, change event and log line; fix inbox #65):
// tracker v4.4's promotion and mark races (above), which last from a box's confirmation until the tracker's next box.
export const KNOWN_RACE = 'tracker v4.4\'s known race after a box update, fix inbox #65: not tampering; it lasts until the tracker\'s next box';

// The server's check of the rows against the confirmed digest: {consistent, rebuilt_digest, inconsistency}.
// rebuilt_digest is the rows' digest (null when they cannot be digested); inconsistency, null when consistent, says
// why not in plain words, and, given the read the rows come from (`notes`, its state `st`), names the update the
// promotion race left unpromoted when the read shows one (unpromoted). Never throws for the rows' content: a refusal of
// lib/avl.mjs is a failed check.
export function selfCheck(rows, confirmedDigest, {notes = null, st = null} = {}) {
  let rebuilt = null, refusal = null;
  try {
    rebuilt = avlDigest(rows.map(r => ({issuer_pubkey: r.issuer_pubkey, recipient_pubkey: r.recipient_pubkey, denomination: r.denomination, total: r.committed_total})));
  } catch (e) {
    if (!(e instanceof AvlError)) throw e;
    refusal = e.message;
  }
  if (rebuilt !== null && rebuilt === confirmedDigest) return {consistent: true, rebuilt_digest: rebuilt, inconsistency: null};
  if (refusal !== null) {
    return {consistent: false, rebuilt_digest: null, inconsistency: `the rows cannot be digested as the tracker digests its notes (${refusal}), so they cannot be the notes the confirmed box commits`};
  }
  const race = notes ? unpromoted(notes, st, confirmedDigest) : null, one = race?.notes === 1;
  return {consistent: false, rebuilt_digest: rebuilt, inconsistency: `the rows give digest ${rebuilt} under ${CONSTRUCTION}, not ${confirmedDigest}, the digest the tracker says its confirmed box commits: the tracker's records of what that box commits disagree with it (${KNOWN_RACE})`
    + (race ? `; with the ${race.notes} note${one ? '' : 's'} still marked for update ${race.tx_id} at the total${one ? '' : 's'} marked (pending_total_debt), the rows give that digest: the box commits what that update carried, and the tracker did not promote ${one ? 'that note' : 'those notes'}, written again while it was in flight` : '')};
}

// The tell of the promotion race in a read whose rows do not give the confirmed digest: an update other than the one in
// flight that `st` names, whose marks some notes still carry (pending_tx_id, with a pending_total_debt), such that the
// rows with those notes at the totals marked for it (a note no box committed before becomes a row) give
// `confirmedDigest`: the box commits what that update carried, and the tracker did not promote those notes. {tx_id,
// notes} (how many notes), or null. At most UNPROMOTED_TRIES updates are tried, those marked on the most notes first
// (each try is one digest of every row); an update id that is not 64 lowercase hex characters is not one (it would be
// served and logged). In practice only the update that made the confirmed box matches: a later update marks again
// every note it changes (a later box with the very same digest, a keep-alive, matches the same marks).
export const UNPROMOTED_TRIES = 4;
const TX_ID = /^[0-9a-f]{64}$/;
export function unpromoted(notes, st, confirmedDigest) {
  const inFlight = value(st?.pending_tx_id), marked = new Map();
  notes.forEach((n, i) => {
    const c = n?.confirmation, tx = value(c?.pending_tx_id);
    if (typeof tx !== 'string' || !TX_ID.test(tx) || tx === inFlight || value(c.pending_total_debt) === null) return;
    if (!marked.has(tx)) marked.set(tx, new Set());
    marked.get(tx).add(i);
  });
  const tries = [...marked].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, UNPROMOTED_TRIES);
  for (const [tx, at] of tries) {
    const marks = notes.map((n, i) => (at.has(i) ? {...n, confirmation: {...n.confirmation, confirmed_total_debt: n.confirmation.pending_total_debt}} : n));
    if (selfCheck(committedRows(marks), confirmedDigest).consistent) return {tx_id: tx, notes: at.size};
  }
  return null;
}

// What the snapshot says, and what it does not (GET /ledger/committed what_this_means).
export function committedMeaning(consistent) {
  return consistent
    ? 'The rows are every note the tracker records as committed by its confirmed tracker box on Ergo testnet (box_id, created at height), each at the total that box commits; digested under the construction named (docs/PILOT-API.md), they give digest, which is what R5 of that box should hold: check it against the box on a chain source of your own. A match shows the totals the box commits, nothing more: not what is outstanding (redemptions are recorded in each reserve\'s own box), not that an issuer can pay, not that any deal was real.'
    : 'The tracker\'s records of what its confirmed tracker box commits do not give that box\'s digest (inconsistency says how). During or right after a box update this is tracker v4.4\'s known race (fix inbox #65), not tampering: a note written while the update that carries it is in flight, or between the update\'s digest and its marking of the notes, leaves the tracker\'s records of that box wrong until its next box (docs/PILOT-API.md, "Committed ledger"). What to do: wait for the tracker\'s next box (GET /pilot/v1/chain anchoring names it: usually within minutes, up to about 30 when Ergo testnet blocks are slow, or after 00:00 UTC once the daily cap of boxes is used up) and read this again. Meanwhile these rows are served as the tracker records them, the server records the disagreement (anchor.inconsistent), and the tracker refuses to build any redemption, for every note: it checks its records against the box before it builds one. The race never makes digest differ from R5 of the box: check that on a chain source of your own.';
}
