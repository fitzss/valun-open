"""Circulating credit, client side: the signing firewall (PROTOCOL.md 15.3; design 4.11 and 6.2; decision D-1).

Pure: the standard library and this package's basis, client (canonical, statement, sha256_hex) and records modules
only. No clock, no network, no files: the caller passes the time, its own records and pins, its local consent policy,
the owner's mandate as GET /me shows it, the edge states it read, and verify(pubkey_hex, msg_bytes, sig_hex). It is
vendored into the Hermes plugin (valun_core/novation.py) and mirrored by js/src/novation.js: same names, rules,
refusal codes, check order and summary fields.

Notation (PROTOCOL.md 18). An edge I->R (issuer key I, recipient key R, both hex) is keyed '<I>><R>' (edge_key).
M(I,R,t,ts) = message(I, R, t, ts, tracker_nft_id, denomination) is the 80-byte Basis note message
(basis.note_message). PA(I,R,X,p,T) = prior_message(I, R, X, p, T, tracker_nft_id, denomination) is the 105-byte prior
acknowledgment of tracker v3.2 (basis.prior_ack_message): the edge's stored total X and its note's timestamp p (0 and
0 for an absent edge) at the operation's timestamp T. An EdgeState {total, timestamp, signature} is the tracker's
current note on an edge: the issuer's signature over M(I,R,total,timestamp). A slot key is '<edge>:prior' or
'<edge>:new'. Below, A is the issuer of a held note, B the payer, C the payee, a the amount, X and Y the totals of A->B
and A->C (Y = 0 for an absent edge) and p_AB, p_AC their states' timestamps (p_AC = 0 for an absent edge), P the
payer's total to the payee and p its state's timestamp, T the operation's timestamp, d a set-off decrease.

What each evaluator signs (to_sign, in this order: [(slot_key, issuer_pk, recipient_pk, total, ts), ...] for a 'new'
slot and [(slot_key, issuer_pk, recipient_pk, prior_total, ts, prior_timestamp), ...] for a 'prior' slot):
  evaluate_bound_template   a bound credit note (residue 997): 'B>C:prior' PA(B,C,P,p,T), 'B>C:new' M(B,C,P+a,T)
  evaluate_payer_template   pay with a held note (999): 'A>B:prior' PA(A,B,X,p_AB,T), 'A>B:new' M(A,B,X-a,T),
                            'A>C:new' M(A,C,Y+a,T)
  evaluate_consent          payer (a regenerated transfer): the same three slots
                            issuer: 'A>B:new', 'A>C:new' (the decreased edge first)
                            payee: 'A>C:prior' PA(A,C,Y,p_AC,T), 'A>C:new' M(A,C,Y+a,T)
                            member (a set-off, 998): '<I>><R>:new' M(I,R,P-d,ts_e) on each of its edges, item order
A consent's to_sign leaves out the slots the item lists in signed_by_you. slot_messages(to_sign, nft, denomination)
rebuilds the bytes to sign (R1: nothing the server sent as hex is ever signed): PA for a prior slot, M for a new one.
The prior state a prior slot acknowledges is the verified EdgeState the item shows (bound: prior_note; transfer:
from_edge.before, to_edge.before; consent: edges[].before), or (0, 0) for an absent edge. A template or item that also
names a prior timestamp (bound: prior_timestamp; transfer: from_edge.prior_timestamp, to_edge.prior_timestamp;
consent: edges[].prior_timestamp) must name exactly that state's timestamp, as prior_total must be its total
(bad_template, bad_consent).

The tracker contract (tracker v3.2, design v3.2 section 5): bound notes, transfers (the payer's template and consent)
and the payee's consent sign prior slots, and are signed only when ctx['novation'] (GET /info novation) reports exactly
CONTRACT: tracker_build 'valun-circulating-credit/4', transfer_version 4, bound_note_version 3, prior_ack
'basis/prior-ack/1' (contract_problem); otherwise feature_unavailable, as the client refuses a server without
circulation/1. Issuer and set-off consents sign 80-byte note messages only and are not gated.

Each evaluator returns {'ok', 'code', 'to_sign', 'summary', 'write_ahead'}:
  ok, code     True and None when every rule holds; else False and one refusal code (REFUSAL_CODES), to_sign [].
  summary      role, kind, id, deal_id (ids only in the form ^v[dts]_[0-9a-f]{16}$, else None: shown_id), timestamp,
               amount; edges [{edge, your_role, before_total, new_total, change,
               timestamp}] (this participant's edges, plus the payer's destination edge with your_role 'payer');
               your_net_change_PC (changes as creditor minus changes as issuer), your_total_owed_change_PC (changes as
               issuer); quote_digest (payer roles); advisories [{code, edge, shown, recorded}] (an edge state that
               disagrees with this client's records: reported, never refused, because the tracker enforces prior
               acknowledgments and bound notes); applied [{pair, total, timestamp, kind, ref, direction, state}] (pending
               entries of this client that the item shows applied) and paid_deals {deal_id: {route, edge, total,
               timestamp}} (deals those entries or earlier attempts paid): the caller records both (apply_findings)
               whether or not the item is signed; retry_after_ms and needs_read_back (transfer_window_open); reason
               (one sentence, for people).
  write_ahead  only when ok: {op, signed [{edge, timestamp, op, slots {slot_key: total}, and for a group with a prior
               slot prior_state {total, timestamp}, the state its PA acknowledges}], pending [{pair, total,
               timestamp, kind, ref, direction}], attempt (a payment attempt) or None, attempts_seen [[route, edge,
               total, timestamp]] (the key of each earlier attempt of the deal this evaluation weighed: its attempt
               records and pending payment entries, in classify_attempts order; [] for an evaluation that makes no
               payment attempt)}. R9: the caller persists it (apply_write_ahead, which refuses a state that changed
               since: WriteAheadConflict; it compares the deal's attempts in the state with attempts_seen) BEFORE it
               sends any signature, best in the same locked step as the evaluation.

The checks, in this order (the first that fails gives the code; PROTOCOL.md 15.3 rule numbers):
  R9   records_unreadable    ctx records, records['paid_deals'], signed, transfer_attempts or novated_edges (or an
                             entry this evaluation reads) is not of its shape: refuse everything
  -    bad_template / bad_consent   the item is not well formed (fields, types, one role, state 'collecting', slots,
                             a prior total or prior timestamp other than its prior state's)
  D-1  already_paid          payer roles: records['paid_deals'] holds the deal (D-1 item 5)
  R13  tracker_mismatch      the item's (and the deal's) tracker_nft_id and denomination are not the pinned ones, or
                             nothing is pinned yet
  R6/R7  party checks        not_my_edge, self_edge, duplicate_edge; payer: deal_mismatch (another deal, terms or
                             delivery), self_edge (pay with my own note), pay_with_is_payee, wrong_destination (not the
                             payee's current key), amount_mismatch (amount != price); payee: deal_mismatch (not my deal as
                             payee with my current key, not delivered, not paid by this transfer, amount != price)
  R3   timestamp_domain      residue 997 (bound note), 999 (transfer), 998 (set-off); a template that is not bound on a
                             novated edge, or once bound_notes/1 is advertised: bound_note_required (R12)
  R6/R7  amounts             amount_mismatch (payer: X >= a, X - a, Y + a; bound: total = prior_total + price);
                             increase_in_setoff, not_net_neutral (member); total_owed_changes (issuer)
  R2   bad_prior_signature   every EdgeState shown (and every ctx edge state used) is its issuer's signature
  R5   timestamp_stale       T in [now - 10 min, now + 5 s] for what the client starts (bound note, payment by
                             transfer), [now - 55 min, now + 5 s] for a consent; T later than every prior timestamp shown
  D-1  already_paid, attempt_outcome_unknown, transfer_window_open   (payer roles: one live payment attempt per deal)
  -    stale_quote           payer roles: the quote digest is not the approved one (a regenerated transfer needs one)
  R8   policy_off, issuer_refused, policy_cap   the stricter of the local consent policy and the owner's mandate (the
                             payer roles need the mandate too); issuer lists are checked against the participant id the
                             client itself resolved for the issuer's key (ctx issuer_ids), never an id the item names
  R12  pending_unbound_note  a novation on an edge where this client holds an ordinary credit note that can still
                             apply (pending, and later than the edge's state shown)
       payment_attempt       a novation, or a bound note, that brings an edge of mine (as issuer) to the acknowledged
                             prior total of a bound note of mine on it that is later than it and can still apply (the
                             client side of decision D-2 c: on tracker v3.1 that note could then apply after it, and pay
                             its deal twice; on v3.2 its acknowledgment also binds the prior timestamp, so it cannot, and
                             the rule stays as a second line)
  v3.2 feature_unavailable   a bound note, the payer's transfer or the payee's consent while ctx['novation'] does not
                             report the tracker v3.2 contract (contract_problem): nothing that signs a prior slot
  R4   timestamp_reused      a different operation (or other totals) already signed at the same (edge, timestamp), or
                             a prior acknowledgment there of another prior state (the record's prior_state)

D-1, one live payment attempt per deal (R11 extended to own notes), with decision D-2 a (full edge states). An attempt
is a signed bound note or a signed transfer, recorded in transfer_attempts[deal_id] (write_ahead.attempt) with the full
edge state it acknowledged (prior, prior_timestamp, prior_signature) and ack 'basis/prior-ack/1' (PRIOR_ACK: its prior
slot was signed as PA); pending payment entries in the records count too.
attempt_outcome() classifies each earlier attempt from the current state of the edge it would change (the template's,
the item's or ctx['edges']; an absent edge is total 0 at timestamp 0, but only for an attempt that acknowledged an
absent edge: one that acknowledged a prior above 0 reads an absent edge as no read-back): 'applied' (the edge shows its
new state, its new total at its own timestamp, or my records confirm it) -> already_paid; 'unknown' (the edge holds any
other state at or past its timestamp, including its prior or its new total at a later timestamp) ->
attempt_outcome_unknown, for the owner to resolve, unless my own records prove it dead (proven_dead: a later bound note
of mine acknowledged the same prior state and applied, and nothing else of mine changed the edge in between); 'alive'
(it may still apply) and 'unread' (its window has passed but its edge was not read) -> transfer_window_open, unless
the new attempt is excluded by it at the tracker and the edge is still exactly the acknowledged prior state (total,
timestamp and signature; any other state gives attempt_outcome_unknown): a bound-note retry of mine that acknowledges
the same prior on the same edge (only my signature lowers my edge, and I never sign a novation or bound note that
brings it back to the prior of a bound note of mine that can still apply), a transfer signed again at the same
timestamp (the identical operation), or (the same-prior exemption, design v3.2 section 4) a transfer at another
timestamp that acknowledges the same prior state of the same held edge A->B, total AND timestamp, as the earlier
transfer recorded (prior, prior_timestamp), when both carry ack 'basis/prior-ack/1'. Audit VS-1 is closed by tracker
v3.2: both attempts' prior acknowledgments are PA(A,B,X,p_AB,T), the edge is at the state (X, p_AB) at most once (its
timestamps strictly increase), so the first of them to apply leaves the other dead for good, whatever totals A->B and
A->C come back to. An earlier attempt without ack is treated as before tracker v3.2: a 0.4.0 build on tracker v3.1
recorded prior_timestamp too but signed the 80-byte M(A,B,X,T), which does not exclude a PA attempt (records of the
first v3.2 builds, which signed PA but wrote no ack, are treated the same: one wait for their window).
Everything else stays windowed as before: a payment through another issuer or of another kind, one on another prior
state of the edge (it moved: a new prior), one after an earlier attempt that recorded no prior state, and every payment
while an ordinary note may apply. 'dead' (a read-back shows it did not
apply and now > T + MAX_AGE_MS + FALLBACK_MARGIN_MS) -> no constraint. A state older than the one the attempt acknowledged (its prior_timestamp) or
than this client's own confirmed state of the edge is no read-back (an edge's timestamps only increase); a confirmed
state at or past T counts as one. An ordinary (unbound) note never expires, so while it may still apply any other
payment is attempt_outcome_unknown. A pending payment entry that no attempt record covers (an ordinary note, say)
records no prior state, so its same-prior retries compare totals only; attempt records written by the 0.4 development
builds before D-2 carry prior_timestamp but no prior_signature, and are compared on total and timestamp.
classify_attempts() gives the same classification for one deal (for `valun attempts list` and the owner's resolution).
Residual risk: read-backs come from the server; a stale but genuine state is caught only through prior_timestamp and
this client's own records (PROTOCOL.md 16.2 7).

ctx keys (only me_pk, now_ms and verify are checked as arguments; the others give refusal codes when missing):
  me_pk            this participant's current public key (66 lowercase hex)
  now_ms           the time, ms since the epoch
  verify           verify(pubkey_hex, msg_bytes, sig_hex) -> bool (basis.verify over hex keys and signatures)
  unit             the network's unit, only for the words of a refusal ('PC' when absent; 0.5.1)
  me_id            this participant's id: required for the payer roles and bound notes (deal_mismatch without it)
  pins             {tracker_nft_id, denomination} pinned at enroll or on the first 0.4 run (R13)
  records          records.py records ({pair: {confirmed, pending}}), with records['paid_deals'] {deal_id: {route,
                   edge, total, timestamp}} (D-1 item 5); None = empty
  signed           R4 record {edge: {str(timestamp): {op, slots {slot_key: total}, prior_state}}}; prior_state {total,
                   timestamp}: the prior state a prior slot there acknowledged (PA), only where there is one (records
                   written before it was recorded have none); None = empty
  transfer_attempts  {deal_id: [attempt]}, attempt {deal_id, route 'note'|'transfer', edge (the edge whose prior it
                   acknowledges: A>B for a transfer, B>C for a note), prior, prior_timestamp and prior_signature (the
                   acknowledged state: timestamp 0 and signature None for an absent edge), total (that edge's total
                   once it applies), timestamp, quote_digest, ack ('basis/prior-ack/1': its prior slot was signed as
                   PA; absent in records written before it was recorded), signed_at; outcome 'applied' once the
                   client learnt it applied, or 'not_applied' only by the owner's decision (attempt_outcome);
                   attempt_id, the server's id of it, once known; resolved_at, the time (ISO 8601, UTC) of the owner's
                   decision, written with outcome by Client.resolve_attempt (for people: no rule here reads it)}; None
                   = empty
  novated_edges    edges a novation changed (a dict keyed by edge, or a list of edges); None = none (R12)
  features         /info features (bound templates: bound_notes/1 makes an unbound template bound_note_required)
  novation         GET /info novation, the server's report of its tracker's contract: a bound note, the payer's
                   transfer and the payee's consent are signed only when it holds exactly CONTRACT (contract_problem;
                   feature_unavailable otherwise)
  deal             deal_context(...): the verified agreement (payer roles, bound notes, payee)
  payee_current_pk the payee's current directory key (payer roles, bound notes)
  approved_quote_digest  the quote the owner approved (payer roles); a regenerated transfer (payer consent) must also
                   carry the quote of an earlier attempt of mine through the same issuer whose window is still open
                   (T + MAX_AGE_MS + FALLBACK_MARGIN_MS), else stale_quote (audit AI-1)
  consent_policy   local: {setoff, as_issuer, as_new_creditor (booleans), max_PC, accept_issuers, refuse_issuers
                   (participant ids or public keys; accept_issuers may be 'any')}; absent = every role off
  mandate          GET /me effective_limits (or mandate): auto_clear, novate_own_debt, accept_transfers,
                   may_accept_credit, accept_notes_from, refuse_notes_from, max_accept_per_issuer, pay_with_held_notes;
                   absent = every role off (the payer roles too: policy_off)
  issuer_ids       {issuer public key: participant id} as the client resolved them itself (the directory, GET
                   /participants, by key): the participant ids the issuer lists of R8 are checked against. The
                   client's _consent_issuer_ids builds it for the payee role: each key that exactly one active
                   directory entry holds. A key it leaves out (listed under two ids, only under inactive entries, or
                   not at all), like an absent issuer_ids, resolves no id; the issuer then passes only if the
                   mandate's accept_notes_from is 'any' and its refuse_notes_from is empty or absent, a local
                   refuse_issuers names public keys only (not the issuer's), and a local accept_issuers is absent,
                   'any' or names the issuer's key; else issuer_refused
  edges            {edge: EdgeState or None (absent)} the caller read just now (GET /edges), for D-1 read-backs
"""
import re

from . import basis as _basis
from . import client as _client
from . import records as _records

# ---------- constants (PROTOCOL.md 18.4, 18.8; design 3.1, 4.3; decision D-1) ----------
TRANSFER_MS = 999
SETOFF_MS = 998
BOUND_MS = 997
RESIDUE = {'transfer': TRANSFER_MS, 'setoff': SETOFF_MS, 'bound': BOUND_MS}
RESERVED_MS = (995, 996, 997, 998, 999)       # ts mod 1000 no ordinary credit note may use
MAX_AGE_MS = 3_600_000                        # the tracker refuses novations and bound notes older than this
FALLBACK_MARGIN_MS = 120_000                  # the client's margin beyond MAX_AGE_MS (the server's is 60 000)
INITIATE_WINDOW_MS = 600_000                  # what the client starts: T >= now - 10 min
CONSENT_WINDOW_MS = 3_300_000                 # a consent: T >= now - 55 min
FUTURE_SKEW_MS = 5_000                        # both: T <= now + 5 s
MAX_SAFE_INTEGER = 2 ** 53 - 1                # every number signed here is a safe integer (JavaScript parity)
QUOTE_KIND = 'valun-transfer-quote/1'
QUOTE_FIELDS = ('network', 'tracker_nft_id', 'denomination', 'deal_id', 'terms_hash', 'deliverable_sha256',
                'issuer_pubkey', 'payer_pubkey', 'payee_pubkey', 'amount')
ROLES = ('payer', 'issuer', 'payee', 'member')
ROUTES = ('note', 'transfer')
PAID_DEALS_KEY = 'paid_deals'                 # records[PAID_DEALS_KEY]: the per-deal paid record (D-1 item 5)
PRIOR_ACK = 'basis/prior-ack/1'               # the prior acknowledgment of tracker v3.2 (basis.PRIOR_ACK_TAG)
# The tracker contract this client signs prior slots for, as GET /info novation reports it (design v3.2 sections 3-5):
# exactly these values (the tracker's GET /capabilities build, novation.transfer.version, bound_notes.version and
# their prior_ack), else feature_unavailable.
CONTRACT = {'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3,
            'prior_ack': PRIOR_ACK}
REFUSAL_CODES = (
    # PROTOCOL.md 15.3 (normative)
    'bad_prior_signature', 'timestamp_domain', 'timestamp_reused', 'timestamp_stale', 'not_net_neutral',
    'increase_in_setoff', 'duplicate_edge', 'self_edge', 'not_my_edge', 'total_owed_changes', 'pay_with_is_payee',
    'wrong_destination', 'amount_mismatch', 'deal_mismatch', 'policy_off', 'policy_cap', 'issuer_refused',
    'records_unreadable', 'transfer_window_open', 'bound_note_required', 'pending_unbound_note', 'tracker_mismatch',
    # decision D-1
    'attempt_outcome_unknown', 'already_paid',
    # decision D-2 c, on the client: a novation that would let a bound note of mine apply after it
    'payment_attempt',
    # this module: a quote other than the approved one; an item that is not well formed
    'stale_quote', 'bad_template', 'bad_consent',
    # tracker v3.2: the server does not report the contract this client signs prior acknowledgments for
    'feature_unavailable',
)
ID_RE = re.compile(r'v[dts]_[0-9a-f]{16}\Z')  # a deal, transfer or set-off id, the only ids a summary carries
RECORDS_KEEP_MS = 604_800_000                 # = client.RECORDS_KEEP_MS: R4 records are kept this long (proven_dead)

_PUBKEY_RE = re.compile(r'0[23][0-9a-f]{64}\Z')
_HEX64_RE = re.compile(r'[0-9a-f]{64}\Z')
_U64 = 2 ** 64
_ABSENT = {'total': 0, 'timestamp': 0}        # the state of an edge that does not exist yet
_UNREADABLE = "this profile's records cannot be read; nothing was signed"


class WriteAheadConflict(ValueError):
    """apply_write_ahead() found the state changed since the evaluation it records (another process signed or paid
    meanwhile): nothing was written, and nothing may be signed; evaluate again. `code` is the refusal code:
    timestamp_reused (another operation at the same edge and timestamp), already_paid (the deal is recorded as paid),
    transfer_window_open (another payment attempt of the deal was recorded)."""

    def __init__(self, code, message):
        super().__init__(f'{code}: {message}')
        self.code = code


# ---------- small helpers ----------
def _nat(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_SAFE_INTEGER


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool) and -MAX_SAFE_INTEGER <= v <= MAX_SAFE_INTEGER


def _u64(v):                                  # what records.py itself accepts
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v < _U64


def _text(v):
    return isinstance(v, str) and v != ''


def _is_pk(v):
    return isinstance(v, str) and _PUBKEY_RE.match(v) is not None


def _state_shape(s):
    return isinstance(s, dict) and _nat(s.get('total')) and _nat(s.get('timestamp')) and _text(s.get('signature'))


def _id_of(party):
    return party['id'] if isinstance(party, dict) and _text(party.get('id')) else None


def _same_id(party, other_id):
    """A party {id, handle} the item names agrees with an id seen elsewhere (true when either is not given)."""
    pid = _id_of(party)
    return pid is None or other_id is None or pid == other_id


def _str_set(v):
    """The set of strings in list `v`, or None when `v` is not a list of strings."""
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        return None
    return set(v)


def _expires(attempt):
    """Transfers and bound notes stop being usable MAX_AGE_MS after their timestamp; an ordinary note never does."""
    return attempt.get('route') == 'transfer' or attempt.get('timestamp', 0) % 1000 == BOUND_MS


def _payment_route(p):
    """The payment a pending records entry is ('note' or 'transfer'), or None: a credit note this client issued, or the
    decrease of its own held claim in a transfer that pays a deal (ref a deal id, 'vd_...')."""
    if p.get('kind') == 'note' and p.get('direction') == 'out':
        return 'note'
    if p.get('kind') == 'transfer' and p.get('direction') == 'in' and isinstance(p.get('ref'), str) \
            and p['ref'].startswith('vd_'):
        return 'transfer'
    return None


def _pending(pair, total, timestamp, kind, ref, direction):
    return {'pair': pair, 'total': total, 'timestamp': timestamp, 'kind': kind, 'ref': ref, 'direction': direction}


def _attempt(deal_id, route, edge, prior, prior_timestamp, prior_signature, total, timestamp, quote, ack=None):
    """An attempt record; `ack` (PRIOR_ACK for what the evaluators sign: the prior slot is PA) only when given."""
    a = {'deal_id': deal_id, 'route': route, 'edge': edge, 'prior': prior, 'prior_timestamp': prior_timestamp,
         'prior_signature': prior_signature, 'total': total, 'timestamp': timestamp, 'quote_digest': quote}
    if ack is not None:
        a['ack'] = ack
    return a


def _attempt_ok(a):
    """An attempt record of the shape the evaluators write (transfer_attempts[deal_id][i]); else R9 refuses."""
    return (isinstance(a, dict) and a.get('route') in ROUTES and parse_edge(a.get('edge')) is not None
            and _u64(a.get('prior')) and _u64(a.get('total')) and _u64(a.get('timestamp')))


def _prior_state_ok(ps):
    """An R4 record's prior_state: {total, timestamp}, the prior state a PA at its (edge, timestamp) acknowledged."""
    return isinstance(ps, dict) and _u64(ps.get('total')) and _u64(ps.get('timestamp'))


def _same_prior_state(a, b):
    """Did attempts a and b acknowledge exactly the same edge state (total and timestamp, and signature where both
    recorded one)? False when either recorded no prior state (no prior_timestamp)."""
    if not (_u64(a.get('prior_timestamp')) and _u64(b.get('prior_timestamp'))):
        return False
    if (a['prior'], a['prior_timestamp']) != (b['prior'], b['prior_timestamp']):
        return False
    sa, sb = a.get('prior_signature'), b.get('prior_signature')
    return not (isinstance(sa, str) and isinstance(sb, str)) or sa == sb


def exact_prior(attempt, state):
    """D-2 a: is `state` (the edge's current state, verified; None when not read) exactly the state `attempt`
    acknowledged: its total, its timestamp (0: an absent edge) and its signature (when recorded: a record of the 0.4
    development builds before D-2 has prior_timestamp but no prior_signature, and is compared on total and timestamp)?
    An attempt that recorded no prior state (a pending payment entry no attempt record covers) is compared by its prior
    total alone, as D-1 does: True."""
    pt = attempt.get('prior_timestamp')
    if not _u64(pt):
        return True
    if state is None:
        return False
    if pt == 0:
        return 'signature' not in state and state['timestamp'] == 0 and state['total'] == 0
    if (state.get('total'), state.get('timestamp')) != (attempt.get('prior'), pt):
        return False
    sig = attempt.get('prior_signature')
    return not isinstance(sig, str) or state.get('signature') == sig


def shown_id(v):
    """`v` when it is a Valun deal, transfer or set-off id (^v[dts]_[0-9a-f]{16}$), else None: the only form in which an
    id an item or template names is copied into a summary (and so reaches an agent, a log or a terminal)."""
    return v if isinstance(v, str) and ID_RE.match(v) is not None else None


def _attempt_keys(state, deal_id):
    """(route, edge, total, timestamp) of every payment attempt of the deal that `state` records: attempt records and
    pending payment entries (records). For apply_write_ahead's check that no attempt appeared since the evaluation."""
    keys = set()
    att = state.get('transfer_attempts')
    for a in (att.get(deal_id) or []) if isinstance(att, dict) else ():
        if isinstance(a, dict):
            keys.add((a.get('route'), a.get('edge'), a.get('total'), a.get('timestamp')))
    recs = state.get('records')
    for pair, e in recs.items() if isinstance(recs, dict) else ():
        if pair == PAID_DEALS_KEY or not isinstance(e, dict) or not isinstance(e.get('pending'), list):
            continue
        for p in e['pending']:
            route = _payment_route(p) if isinstance(p, dict) else None
            if route is not None and p.get('ref') == deal_id:
                keys.add((route, pair, p.get('total'), p.get('timestamp')))
    return keys


# ---------- names, messages, digests ----------
def edge_key(issuer_pk, recipient_pk):
    """'<issuer_pk>><recipient_pk>', the key of an edge (records.pair_key)."""
    return _records.pair_key(issuer_pk, recipient_pk)


def parse_edge(key):
    """(issuer_pk, recipient_pk) of an edge key, or None when `key` is not two public keys joined by '>'."""
    if not isinstance(key, str):
        return None
    parts = key.split('>')
    if len(parts) != 2 or not _is_pk(parts[0]) or not _is_pk(parts[1]):
        return None
    return parts[0], parts[1]


def slot_key(edge, slot):
    """'<edge>:prior' or '<edge>:new'."""
    return f'{edge}:{slot}'


def message(issuer_pk, recipient_pk, total, timestamp, tracker_nft_id, denomination):
    """M(I,R,t,ts): the 80-byte Basis note message, basis.note_message() over hex keys and tracker id."""
    return _basis.note_message(bytes.fromhex(issuer_pk), bytes.fromhex(recipient_pk), total, timestamp,
                               bytes.fromhex(tracker_nft_id), denomination)


def prior_message(issuer_pk, recipient_pk, prior_total, prior_timestamp, timestamp, tracker_nft_id, denomination):
    """PA(I,R,X,p,T): the 105-byte prior acknowledgment of tracker v3.2, basis.prior_ack_message() over hex keys and
    tracker id (X the acknowledged total, p its state's timestamp, 0 and 0 for an absent edge; T the operation's)."""
    return _basis.prior_ack_message(bytes.fromhex(issuer_pk), bytes.fromhex(recipient_pk), prior_total, prior_timestamp,
                                    timestamp, bytes.fromhex(tracker_nft_id), denomination)


def slot_messages(to_sign, tracker_nft_id, denomination):
    """{slot_key: bytes} for an evaluator's to_sign list, in its order: the only bytes a client signs for it (R1). A
    prior slot (slot_key, I, R, X, T, p) is PA(I,R,X,p,T); a new slot (slot_key, I, R, t, T) is M(I,R,t,T). ValueError
    for an entry of neither form: a prior slot is never signed as an 80-byte note message."""
    out = {}
    for x in to_sign:
        prior = isinstance(x[0], str) and x[0].endswith(':prior')
        if len(x) != (6 if prior else 5):
            raise ValueError('a to_sign entry is (slot, issuer, recipient, total, ts) for a new slot and '
                             '(slot, issuer, recipient, prior_total, ts, prior_timestamp) for a prior slot')
        s, i, r, t, ts = x[:5]
        out[s] = (prior_message(i, r, t, x[5], ts, tracker_nft_id, denomination) if prior
                  else message(i, r, t, ts, tracker_nft_id, denomination))
    return out


def contract_problem(novation_info):
    """None when `novation_info` (GET /info novation, the server's report of its tracker's contract) holds exactly the
    tracker v3.2 contract CONTRACT (the same values of the same JSON types: 4, never '4', 4.0 or true); else one
    sentence naming the first field that differs. Only then are prior acknowledgments PA(...) signed."""
    if not isinstance(novation_info, dict):
        return ('this Valun server does not report the tracker contract this client signs for (GET /info has no '
                'novation object): tracker v3.2, prior acknowledgments basis/prior-ack/1')
    for k, want in CONTRACT.items():
        got = novation_info.get(k)
        if type(got) is not type(want) or got != want:
            return (f"this Valun server's tracker contract is not tracker v3.2 (GET /info novation.{k} is not "
                    f'{want!r}); this client signs prior acknowledgments basis/prior-ack/1 only')
    return None


def quote_digest(fields):
    """sha256hex(canonical(Q)), Q = {kind 'valun-transfer-quote/1', network, tracker_nft_id, denomination, deal_id,
    terms_hash, deliverable_sha256, issuer_pubkey, payer_pubkey, payee_pubkey, amount} (PROTOCOL.md 18.3 item 4).
    `fields` holds the ten values (other keys are ignored): printable ASCII strings and a positive safe integer amount,
    so every implementation of canonical() gives the same bytes. Q has no timestamp and no total, so a regenerated
    transfer keeps the digest the owner approved. ValueError for anything else."""
    if not isinstance(fields, dict):
        raise ValueError('quote fields must be a dict')
    q = {'kind': QUOTE_KIND}
    for k in QUOTE_FIELDS:
        v = fields.get(k)
        if k == 'amount':
            if not (_nat(v) and v > 0):
                raise ValueError('a quote amount is a positive whole number of PC (at most 2^53 - 1)')
        elif not (_text(v) and all(' ' <= c <= '~' for c in v)):
            raise ValueError(f'quote field {k} must be a non-empty printable ASCII string')
        q[k] = v
    return _client.sha256_hex(_client.canonical(q))


def pay_statement(deal_id, quote_digest_hex):
    """The pay statement the payer of a payment by transfer signs: client.statement('pay', deal_id, quote_digest),
    'valun-pilot/pay/1' LF deal_id LF quote_digest (102 bytes for a vd_ + 16 hex deal id; never 80)."""
    if not (_text(deal_id) and isinstance(quote_digest_hex, str) and _HEX64_RE.match(quote_digest_hex)):
        raise ValueError('a pay statement needs a deal id and a 64-hex quote digest')
    return _client.statement('pay', deal_id, quote_digest_hex)


def deal_context(terms, terms_hash, deliverable_sha256=None, delivered=False, transfer_id=None):
    """ctx['deal'] from terms the caller has verified (client.verified_agreement): their hash, the sha256 of the delivery
    it checked (payer roles), and for the payee whether it delivered on the deal and the transfer the deal view says pays
    it (deal.payment.transfer_id)."""
    return {'deal_id': terms['deal_id'], 'network': terms['network'], 'tracker_nft_id': terms['tracker_nft_id'],
            'denomination': terms['denomination'], 'terms_hash': terms_hash, 'deliverable_sha256': deliverable_sha256,
            'price': terms['price']['amount'],
            'payer': {'id': terms['payer']['id'], 'pubkey': terms['payer']['pubkey']},
            'payee': {'id': terms['payee']['id'], 'pubkey': terms['payee']['pubkey']},
            'delivered': delivered is True, 'transfer_id': transfer_id}


# ---------- D-1: payment attempts ----------
def attempt_outcome(attempt, now_ms, state=None):
    """How an earlier payment attempt stands (decision D-1, with D-2 a: edge states are compared in full). `state` is
    the current, verified EdgeState of the edge the attempt would change (an absent edge: {'total': 0, 'timestamp':
    0}), or None when it was not read. Returns
      'applied'  the edge holds its new state (its new total at its own timestamp), or the caller recorded it applied
                 (attempt['outcome'] == 'applied')
      'unknown'  the edge holds any other state at or past its timestamp: it may have applied (D-2 a: also its prior
                 total, or its new total, at a later timestamp; an edge can come back to a total)
      'alive'    it has not applied and may still apply (an ordinary, unbound note never stops being usable)
      'dead'     a read-back shows it did not apply (a state older than its timestamp) and now_ms > timestamp +
                 MAX_AGE_MS + FALLBACK_MARGIN_MS
      'unread'   its window has passed but the edge was not read, so it is not known to be dead
    attempt['outcome'] == 'not_applied' records the OWNER's decision, after confirming with the payee, that an attempt
    did not apply (the way out of attempt_outcome_unknown; a client never sets it by itself): the attempt is then 'dead'
    once its window has passed ('alive' before; an ordinary note only once its edge has moved past it), unless the edge
    holds exactly its new total at its timestamp. The evaluators also accept proof from this client's own records that
    an 'unknown' attempt is dead (proven_dead)."""
    outcome = attempt.get('outcome')
    if outcome == 'applied':
        return 'applied'
    T, total = attempt['timestamp'], attempt['total']
    expired = now_ms > T + MAX_AGE_MS + FALLBACK_MARGIN_MS
    if state is not None and (state['timestamp'], state['total']) == (T, total):
        return 'applied'
    if outcome == 'not_applied':
        if _expires(attempt):
            return 'dead' if expired else 'alive'
        return 'dead' if state is not None and state['timestamp'] > T else 'alive'   # an ordinary note never expires
    if state is None:
        return 'unread' if _expires(attempt) and expired else 'alive'
    if state['timestamp'] >= T:
        return 'unknown'          # not its new state, at or past its timestamp: it may have applied (D-2 a)
    if not _expires(attempt):
        return 'alive'
    return 'dead' if expired else 'alive'


# ---------- one evaluation ----------
class _Refusal(Exception):
    def __init__(self, code, reason):
        super().__init__(code)
        self.code, self.reason = code, reason


class _Run:
    """One evaluation: the context (checked once), the records it reads, and the summary built along the way."""

    def __init__(self, ctx, item_code, window_ms):
        if not isinstance(ctx, dict):
            raise ValueError('ctx must be a dict')
        if not _is_pk(ctx.get('me_pk')):
            raise ValueError("ctx['me_pk'] must be this participant's current public key (66 lowercase hex)")
        if not _nat(ctx.get('now_ms')):
            raise ValueError("ctx['now_ms'] must be the time in ms since the epoch")
        if not callable(ctx.get('verify')):
            raise ValueError("ctx['verify'] must be verify(pubkey_hex, msg_bytes, sig_hex) -> bool")
        if ctx.get('edges') is not None and not isinstance(ctx['edges'], dict):
            raise ValueError("ctx['edges'] must be {edge: EdgeState or None}")
        self.ctx, self.me, self.now, self._verify = ctx, ctx['me_pk'], ctx['now_ms'], ctx['verify']
        self.unit = ctx.get('unit') or 'PC'   # the network's unit, for the refusals' words (0.5.1; the pilot's by default)
        self.item_code, self.window_ms = item_code, window_ms
        self.ctx_edges = ctx.get('edges') or {}
        self.shown = {}                       # edge -> the state the item shows (verified), _ABSENT for an absent edge
        self.recs, self.paid, self.signed, self.attempts, self.novated = {}, {}, {}, {}, set()
        self.seen = []                        # [route, edge, total, timestamp] of the deal's attempts weighed (D-1)
        self.summary = {'role': None, 'kind': None, 'id': None, 'deal_id': None, 'timestamp': None, 'amount': None,
                        'edges': [], 'your_net_change_PC': None, 'your_total_owed_change_PC': None,
                        'quote_digest': None, 'advisories': [], 'applied': [], 'paid_deals': {},
                        'retry_after_ms': None, 'needs_read_back': [], 'reason': None}

    # ----- running -----
    def execute(self, fn, item):
        try:
            to_sign, write_ahead = fn(self, item)
            ok, code = True, None
        except _Refusal as r:
            to_sign, write_ahead, ok, code = [], None, False, r.code
            self.summary['reason'] = r.reason
        except (TypeError, ValueError, KeyError, AttributeError, IndexError, OverflowError) as e:
            # a shape the checks did not anticipate: refuse (never sign, never crash a consent loop)
            to_sign, write_ahead, ok, code = [], None, False, self.item_code
            self.summary['reason'] = f'the item could not be read ({type(e).__name__}); nothing was signed'
        edges = self.summary['edges']
        if edges:
            owed = sum(e['change'] for e in edges if e['your_role'] == 'issuer')
            self.summary['your_total_owed_change_PC'] = owed
            self.summary['your_net_change_PC'] = sum(e['change'] for e in edges if e['your_role'] == 'creditor') - owed
        return {'ok': ok, 'code': code, 'to_sign': to_sign, 'summary': self.summary, 'write_ahead': write_ahead}

    def refuse(self, code, reason):
        raise _Refusal(code, reason)

    def bad(self, reason):
        raise _Refusal(self.item_code, reason)

    def unreadable(self):
        raise _Refusal('records_unreadable', _UNREADABLE)

    # ----- R9: the records -----
    def load(self):
        c = self.ctx
        recs = {} if c.get('records') is None else c['records']
        if not isinstance(recs, dict):
            self.unreadable()
        paid = {} if recs.get(PAID_DEALS_KEY) is None else recs[PAID_DEALS_KEY]
        if not isinstance(paid, dict) or not all(isinstance(v, dict) for v in paid.values()):
            self.unreadable()
        signed = {} if c.get('signed') is None else c['signed']
        if not isinstance(signed, dict) or not all(isinstance(v, dict) for v in signed.values()):
            self.unreadable()
        attempts = {} if c.get('transfer_attempts') is None else c['transfer_attempts']
        if not isinstance(attempts, dict) or not all(isinstance(v, list) for v in attempts.values()):
            self.unreadable()
        nov = c.get('novated_edges')
        if nov is None:
            nov = set()
        elif isinstance(nov, dict):
            nov = set(nov)
        elif isinstance(nov, list) and all(isinstance(x, str) for x in nov):
            nov = set(nov)
        else:
            self.unreadable()
        self.recs, self.paid, self.signed, self.attempts, self.novated = recs, paid, signed, attempts, nov

    def pair(self, pair):
        """(confirmed, pending) of this client's record of `pair`."""
        e = self.recs.get(pair)
        if e is None:
            return None, []
        if not isinstance(e, dict):
            self.unreadable()
        conf, pend = e.get('confirmed'), e.get('pending')
        if conf is not None and not (isinstance(conf, dict) and _u64(conf.get('total')) and _u64(conf.get('timestamp'))):
            self.unreadable()
        pend = [] if pend is None else pend
        if not isinstance(pend, list) or not all(isinstance(p, dict) and _u64(p.get('total')) and _u64(p.get('timestamp'))
                                                 for p in pend):
            self.unreadable()
        return conf, pend

    def signed_entry(self, edge, ts):
        per = self.signed.get(edge)
        e = per.get(str(ts)) if per is not None else None
        if e is not None and not (isinstance(e, dict) and isinstance(e.get('op'), str) and isinstance(e.get('slots'), dict)
                                  and (e.get('prior_state') is None or _prior_state_ok(e['prior_state']))):
            self.unreadable()
        return e

    def deal_attempts(self, deal_id, price):
        """Earlier payment attempts for the deal: its attempt records, plus pending payment entries of it in the
        records that no attempt record covers (their prior follows from the price; None when the price is None)."""
        out = []
        for a in self.attempts.get(deal_id) or []:
            if not _attempt_ok(a):
                self.unreadable()
            out.append(a)
        for pair in list(self.recs):
            if pair == PAID_DEALS_KEY or parse_edge(pair) is None:
                continue
            for p in self.pair(pair)[1]:
                route = _payment_route(p)
                if route is None or p.get('ref') != deal_id:
                    continue
                if any(a['route'] == route and a['edge'] == pair and (a['total'], a['timestamp']) == (p['total'], p['timestamp'])
                       for a in out):
                    continue
                prior = None if price is None else p['total'] - price if route == 'note' else p['total'] + price
                out.append(_attempt(deal_id, route, pair, prior if prior is not None and prior >= 0 else None, None, None,
                                    p['total'], p['timestamp'], None))
        return out

    def edge_attempts(self, edge):
        """(deal_id, attempt) for every attempt record of mine, of any deal, on `edge` (R9: a malformed one refuses)."""
        out = []
        for deal_id, lst in self.attempts.items():
            for a in lst or []:
                if isinstance(a, dict) and a.get('edge') == edge:
                    if not _attempt_ok(a):
                        self.unreadable()
                    out.append((deal_id, a))
        return out

    # ----- R13, R2, R5 -----
    def have_pins(self):
        p = self.ctx.get('pins')
        if not (isinstance(p, dict) and _text(p.get('tracker_nft_id')) and _text(p.get('denomination'))):
            self.refuse('tracker_mismatch', 'this profile has no pinned tracker and unit yet; nothing was signed')
        return p

    def pins(self, nft, denom):
        p = self.have_pins()
        if nft != p['tracker_nft_id'] or denom != p['denomination']:
            self.refuse('tracker_mismatch', 'the item names a tracker or unit other than the ones this profile pinned')

    def same_tracker(self, deal):
        p = self.ctx['pins']
        if deal['tracker_nft_id'] != p['tracker_nft_id'] or deal['denomination'] != p['denomination']:
            self.refuse('tracker_mismatch', "the deal's agreed tracker or unit is not the one this profile pinned")

    def verified(self, issuer, recipient, state):
        """R2: `state` is the issuer's signature over M(issuer, recipient, total, timestamp) on the pinned tracker."""
        p = self.ctx['pins']
        try:
            msg = message(issuer, recipient, state['total'], state['timestamp'], p['tracker_nft_id'], p['denomination'])
            return self._verify(issuer, msg, state['signature']) is True
        except Exception:  # noqa: BLE001 - a verifier that fails accepts nothing
            return False

    def fresh(self, ts, befores):
        if ts < self.now - self.window_ms or ts > self.now + FUTURE_SKEW_MS:
            self.refuse('timestamp_stale', f'the timestamp {ts} is not within the window this client signs '
                                           f'({self.window_ms // 60000} minutes back, 5 seconds ahead)')
        if any(ts <= b for b in befores):
            self.refuse('timestamp_stale', f'the timestamp {ts} is not later than the state it changes')

    # ----- the deal (payer roles, bound notes, payee) -----
    def deal(self):
        d = self.ctx.get('deal')
        ok = (isinstance(d, dict) and _text(d.get('deal_id')) and _nat(d.get('price')) and d['price'] > 0
              and _text(d.get('terms_hash')) and _text(d.get('network')) and _text(d.get('tracker_nft_id'))
              and _text(d.get('denomination')) and isinstance(d.get('payer'), dict) and isinstance(d.get('payee'), dict)
              and _text(d['payer'].get('id')) and _text(d['payee'].get('id'))
              and _is_pk(d['payer'].get('pubkey')) and _is_pk(d['payee'].get('pubkey')))
        if not ok:
            self.refuse('deal_mismatch', 'the deal could not be checked against its verified agreement; nothing was signed')
        return d

    # ----- what the item shows -----
    def show(self, edge, state, mine):
        """Register a verified state the item shows. On my own edges: pending entries of mine it shows applied go to
        summary.applied (and the deals they paid to summary.paid_deals); a state that disagrees with my records is an
        advisory."""
        self.shown[edge] = _ABSENT if state is None else state
        if not mine:
            return
        conf, pend = self.pair(edge)
        if state is not None:
            for p in pend:
                if (p['total'], p['timestamp']) != (state['total'], state['timestamp']):
                    continue
                self.summary['applied'].append({'pair': edge, 'total': p['total'], 'timestamp': p['timestamp'],
                                                'kind': p.get('kind'), 'ref': p.get('ref'), 'direction': p.get('direction'),
                                                'state': {'total': state['total'], 'timestamp': state['timestamp'],
                                                          'signature': state['signature']}})
                route = _payment_route(p)
                if route is not None and _text(p.get('ref')) and p['ref'] not in self.summary['paid_deals']:
                    self.summary['paid_deals'][p['ref']] = {'route': route, 'edge': edge, 'total': p['total'],
                                                            'timestamp': p['timestamp']}
            # D-2 a: a payment attempt of mine whose exact new state the item shows applied, even when its pending entry
            # was forgotten (a refused or failed answer keeps only the attempt record): its deal is paid
            for deal_id, a in self.edge_attempts(edge):
                if (a['total'], a['timestamp']) == (state['total'], state['timestamp']) \
                        and deal_id not in self.summary['paid_deals']:
                    self.summary['paid_deals'][deal_id] = {'route': a['route'], 'edge': edge, 'total': a['total'],
                                                           'timestamp': a['timestamp']}
        if conf is not None:
            shown = state if state is not None else _ABSENT
            code = ('older_than_records' if conf['timestamp'] > shown['timestamp'] else
                    'conflicts_with_records' if conf['timestamp'] == shown['timestamp'] and conf['total'] != shown['total']
                    else None)
            if code:
                self.summary['advisories'].append({'code': code, 'edge': edge,
                                                   'shown': {'total': shown['total'], 'timestamp': shown['timestamp']},
                                                   'recorded': {'total': conf['total'], 'timestamp': conf['timestamp']}})

    def add_edge(self, edge, your_role, before_total, new_total, ts):
        self.summary['edges'].append({'edge': edge, 'your_role': your_role, 'before_total': before_total,
                                      'new_total': new_total, 'change': new_total - before_total, 'timestamp': ts})

    def state_of(self, edge):
        """The current state of `edge` for a D-1 read-back: the item's, else ctx['edges'] (verified here), else None."""
        if edge in self.shown:
            return self.shown[edge]
        if edge not in self.ctx_edges:
            return None
        st = self.ctx_edges[edge]
        if st is None:
            return _ABSENT
        keys = parse_edge(edge)
        if keys is None or not _state_shape(st) or not self.verified(keys[0], keys[1], st):
            self.refuse('bad_prior_signature', 'an edge state the client read is not its issuer\'s signature')
        return st

    # ----- D-1 -----
    def not_paid_yet(self, deal_id):
        if deal_id in self.paid:
            self.refuse('already_paid', 'your records show this deal is already paid; refusing to pay it again')

    def read_back(self, a, conf):
        """The current state of attempt a's edge as a D-1 read-back, or None when there is none: not read; absent
        although the attempt acknowledged a prior above 0 (the edge existed; an absent row is no read-back); or older
        than what this client already knows of the edge (an edge's timestamps only increase). My own confirmed state
        counts as one once it is at or past the attempt's timestamp."""
        state = self.state_of(a['edge'])
        if state is not None and 'signature' not in state and not (a.get('prior') == 0):
            state = None
        floor = max(conf['timestamp'] if conf is not None else 0,
                    a['prior_timestamp'] if _u64(a.get('prior_timestamp')) else 0)
        if state is None or state['timestamp'] < floor:
            state = conf if conf is not None and conf['timestamp'] >= a['timestamp'] else None
        return state

    def proven_dead(self, a, state):
        """D-2 a: do my own records prove that attempt `a` (a note of mine whose edge moved past its timestamp to
        `state`) never applied? Yes when a later bound note of mine on the same edge acknowledged exactly the same prior
        state and applied (`state` is its new state, or my records hold its deal paid by it), and I signed no other
        operation than credit notes on that edge between the two: only my signature lowers my own edge, so had `a`
        applied, the edge could not have been back at that prior when the later note applied. Needs my records of every
        operation since `a` (RECORDS_KEEP_MS)."""
        edge = a['edge']
        if state is None or a.get('route') != 'note' or state['timestamp'] <= a['timestamp'] \
                or not _u64(a.get('prior_timestamp')) or a['timestamp'] < self.now - RECORDS_KEEP_MS:
            return False
        for deal_id, b in self.edge_attempts(edge):
            if b is a or b['route'] != 'note' or b['timestamp'] <= a['timestamp'] or b['timestamp'] % 1000 != BOUND_MS \
                    or not _same_prior_state(a, b):
                continue
            paid = self.paid.get(deal_id)
            applied = ((state['total'], state['timestamp']) == (b['total'], b['timestamp']) or b.get('outcome') == 'applied'
                       or (isinstance(paid, dict)
                           and (paid.get('edge'), paid.get('total'), paid.get('timestamp')) == (edge, b['total'], b['timestamp'])))
            if applied and not self.signed_between(edge, a['timestamp'], b['timestamp']):
                return True
        return False

    def signed_between(self, edge, t1, t2):
        """Did I sign an operation other than a credit note on `edge` at a timestamp strictly between t1 and t2 (R4)?"""
        per = self.signed.get(edge) or {}
        for k in per:
            if isinstance(k, str) and k.isdigit() and t1 < int(k) < t2:
                e = self.signed_entry(edge, int(k))
                if e is not None and not e['op'].startswith('note:'):
                    return True
        return False

    def classify(self, deal_id, price):
        """[(attempt, outcome, read-back state)] for each earlier payment attempt of the deal (deal_attempts), as D-1 and
        D-2 a weigh it: 'applied' when my own confirmed state of its edge is its new state, or my records hold the deal
        paid by it (records['paid_deals']: the payer evaluators refuse a paid deal before they get here); else
        attempt_outcome() on its read-back (read_back), an 'unknown' one my own records prove dead (proven_dead) being
        'dead'."""
        looked = []
        paid = self.paid.get(deal_id)
        paid_by = (paid.get('route'), paid.get('edge'), paid.get('total'), paid.get('timestamp')) if paid else None
        for a in self.deal_attempts(deal_id, price):
            conf = self.pair(a['edge'])[0]
            if (conf is not None and (conf['total'], conf['timestamp']) == (a['total'], a['timestamp'])) \
                    or paid_by == (a['route'], a['edge'], a['total'], a['timestamp']):
                looked.append((a, 'applied', None))
                continue
            state = self.read_back(a, conf)
            o = attempt_outcome(a, self.now, state)
            if o == 'unknown' and self.proven_dead(a, state):
                o = 'dead'
            looked.append((a, o, state))
        return looked

    def one_live_attempt(self, deal_id, price, route, edge, prior, timestamp=None, prior_timestamp=None, ack=None):
        """D-1 and D-2 a: refuse a new payment attempt (route, edge, acknowledged prior, timestamp, the timestamp of
        the acknowledged prior state, and ack: PRIOR_ACK when its prior slot is signed as PA) for the deal unless every
        earlier attempt is dead or is excluded by this one at the tracker: the same route on the same edge,
        acknowledging the same prior, while the edge is still exactly the state the earlier one acknowledged; for a
        transfer also at the same timestamp (the identical operation signed again: the tracker applies an edge's
        operations at strictly increasing timestamps, so at most one of the two can apply) or, the same-prior exemption
        of tracker v3.2 (design v3.2 section 4), acknowledging the same prior state of the held edge, its total AND its
        timestamp, as the earlier transfer recorded, when both carry ack PRIOR_ACK.

        Why the exemption holds (audit VS-1, closed by tracker v3.2): the prior acknowledgment of A->B is
        PA(A,B,X,p_AB,T), and the edge is at (X, p_AB) at most once, so of two transfers acknowledging that state the
        first to apply leaves the other dead for good, at any T and whatever totals both edges come back to (on tracker
        v3.1, M(A,B,X,T) bound no prior timestamp and both could apply). Only an earlier attempt recorded with ack is
        known to have signed PA: one without it (written by a 0.4.0 build on tracker v3.1, which recorded
        prior_timestamp too but signed M(A,B,X,T), or by the first v3.2 builds, which wrote no ack) is treated as before
        tracker v3.2. A transfer on another prior state, or after an attempt that recorded none (prior_timestamp) or no
        ack, still waits for the window. A note retry stays excluded at
        another timestamp, as before: only my own signature lowers my own edge, and I sign no novation
        (no_bound_note_restored) and no bound note (_bound) that brings it back to the prior of a bound note of mine
        that can still apply (and on tracker v3.2 its acknowledgment binds the prior timestamp as well)."""
        self.not_paid_yet(deal_id)
        if deal_id in self.summary['paid_deals']:
            self.refuse('already_paid', 'a payment of yours for this deal shows as applied; refusing to pay it again')
        looked = self.classify(deal_id, price)
        self.seen = [[a['route'], a['edge'], a['total'], a['timestamp']] for a, _o, _s in looked]
        for a, o, _s in looked:
            if o == 'applied':
                self.summary['paid_deals'][deal_id] = {'route': a['route'], 'edge': a['edge'], 'total': a['total'],
                                                       'timestamp': a['timestamp']}
                self.refuse('already_paid', 'an earlier payment of yours for this deal applied; refusing to pay it again')

        def same(a):
            if not (a['route'] == route and a['edge'] == edge and a['prior'] == prior):
                return False
            if route == 'note' or (timestamp is not None and a['timestamp'] == timestamp):
                return True
            # tracker v3.2: the same prior state of the same held edge (total and timestamp) at another T, when both
            # attempts signed PA (ack): an attempt recorded without ack may have signed v3.1's M(A,B,X,T)
            return (ack == PRIOR_ACK and a.get('ack') == PRIOR_ACK and _nat(prior_timestamp)
                    and _u64(a.get('prior_timestamp')) and a['prior_timestamp'] == prior_timestamp)

        if any(o == 'unknown' or (o == 'alive' and same(a) and not exact_prior(a, s))
               or (o == 'alive' and not _expires(a) and not same(a)) for a, o, s in looked):
            self.refuse('attempt_outcome_unknown', 'an earlier payment attempt for this deal may have applied (or may '
                                                   'still apply at any time); only your owner can resolve it, after '
                                                   'confirming with the payee')
        looked = [(a, o) for a, o, _s in looked]
        blocking = [(a, o) for a, o in looked if o in ('alive', 'unread') and not same(a)]
        if blocking:
            waits = [a['timestamp'] + MAX_AGE_MS + FALLBACK_MARGIN_MS + 1 - self.now for a, o in blocking if o == 'alive']
            self.summary['retry_after_ms'] = max(waits) if waits else 0
            self.summary['needs_read_back'] = sorted({a['edge'] for a, o in blocking if o == 'unread'})
            self.refuse('transfer_window_open', 'an earlier payment attempt for this deal is not known to be dead yet; a '
                                                'different payment waits until its timestamp + 1 h + 2 min and a read-back')

    def approved_quotes(self, deal_id, held_edge):
        """The quote digests of my earlier transfer attempts for the deal through the same held note whose window is
        still open (now <= T + MAX_AGE_MS + FALLBACK_MARGIN_MS): the only quotes a payer consent re-signs under without
        a new approval (audit AI-1: an approval never licenses a payment long after the attempt it was given for)."""
        found = set()
        for a in self.attempts.get(deal_id) or []:
            if isinstance(a, dict) and a.get('route') == 'transfer' and a.get('edge') == held_edge \
                    and isinstance(a.get('quote_digest'), str) and _u64(a.get('timestamp')) \
                    and self.now <= a['timestamp'] + MAX_AGE_MS + FALLBACK_MARGIN_MS:
                found.add(a['quote_digest'])
        return found

    # ----- R8 -----
    def policy(self, local_flag, mandate_flag):
        p = self.ctx.get('consent_policy')
        p = p if isinstance(p, dict) else {}
        if p.get(local_flag) is not True:
            self.refuse('policy_off', f'your local consent policy does not sign this role by itself ({local_flag} is off)')
        m = self.ctx.get('mandate')
        if not isinstance(m, dict) or m.get(mandate_flag) is not True:
            self.refuse('policy_off', f"your owner's mandate does not allow this ({mandate_flag} is not on)")
        return p, m

    def cap(self, p, amount):
        cap = p.get('max_PC')
        if cap is not None and (not _nat(cap) or amount > cap):
            self.refuse('policy_cap', f'{amount} {self.unit} is above the cap your local consent policy sets for one consent')

    def issuer_accepted(self, p, m, issuer_pk, item_issuer_id):
        """R8's issuer lists, local (participant ids or public keys) and the mandate's (participant ids), checked against
        the issuer's key and the participant id this client resolved for that key itself (ctx issuer_ids, from the
        directory), never an id the item names: an item naming another id than the directory's is refused, and so is
        any list of ids when the client could not resolve the key."""
        ids = self.ctx.get('issuer_ids')
        resolved = ids.get(issuer_pk) if isinstance(ids, dict) else None
        resolved = resolved if _text(resolved) else None
        if item_issuer_id is not None and resolved is not None and item_issuer_id != resolved:
            self.refuse('issuer_refused', 'the item names another participant as the issuer than the directory lists for '
                                          "the issuer's key")
        names = {issuer_pk} | ({resolved} if resolved else set())
        refused = p.get('refuse_issuers')
        accepted = p.get('accept_issuers')
        m_refused = m.get('refuse_notes_from')
        m_accepted = m.get('accept_notes_from')
        ok = True
        if refused is not None:
            s = _str_set(refused)
            ok = ok and s is not None and not (s & names) and (resolved is not None or all(_is_pk(x) for x in s))
        if accepted is not None and accepted != 'any':
            s = _str_set(accepted)
            ok = ok and s is not None and bool(s & names)
        if m_refused is not None:
            s = _str_set(m_refused)
            ok = ok and s is not None and (not s or (resolved is not None and resolved not in s))
        if m_accepted != 'any':
            s = _str_set(m_accepted)
            ok = ok and s is not None and resolved is not None and resolved in s
        if not ok:
            self.refuse('issuer_refused', 'your policy or your owner does not accept notes from this issuer (as the '
                                          'directory names it)')

    # ----- R12, R4 -----
    def no_pending_unbound(self, edges):
        """R12: an ordinary note of mine that can still apply (later than the edge's state shown) blocks a novation."""
        for edge in edges:
            after = self.shown.get(edge, _ABSENT)['timestamp']
            for p in self.pair(edge)[1]:
                if p.get('kind') == 'note' and p.get('direction') == 'out' and p['timestamp'] % 1000 < RESERVED_MS[0] \
                        and p['timestamp'] > after:
                    self.refuse('pending_unbound_note', 'you hold an unapplied ordinary credit note on this edge; a '
                                                        'novation is signed only once it is settled either way')

    def no_bound_note_restored(self, changes):
        """R12 extended, the client side of decision D-2 c: never sign a novation that sets an edge of mine (as issuer)
        to the acknowledged prior total of a bound note of mine on that edge that is later than the novation and can
        still apply (within its maximum age, not known applied). On tracker v3.1 that note could then apply after the
        novation: had an earlier payment of its deal applied in between (a server can hide that), the deal would be
        paid twice. Also run for a bound note of mine (audit VS-1): a note for another deal can bring the edge back to
        that prior just as a novation can, after a set-off lowered it below. On tracker v3.2 the note's acknowledgment
        PA(I,R,P,p,ts) also binds the prior timestamp p, which the edge never has again once it moved, so the tracker
        refuses it there; this rule stays as a second line (relaxing it is a later step).
        `changes`: [(edge, new_total, timestamp)] of the novation's edges where I am the issuer (or the note's edge)."""
        for edge, new_total, ts in changes:
            for deal_id, b in self.edge_attempts(edge):
                if b['route'] != 'note' or b['timestamp'] % 1000 != BOUND_MS or b['timestamp'] <= ts \
                        or self.now > b['timestamp'] + MAX_AGE_MS + FALLBACK_MARGIN_MS or b.get('outcome') == 'applied':
                    continue
                paid = self.paid.get(deal_id)
                if isinstance(paid, dict) and (paid.get('edge'), paid.get('total'), paid.get('timestamp')) \
                        == (edge, b['total'], b['timestamp']):
                    continue
                if b['prior'] == new_total:
                    self.refuse('payment_attempt', 'this would bring your edge back to the prior a bound credit note of '
                                                   'yours acknowledged, which could then still apply; it is signed only '
                                                   'once that note is past its maximum age')

    def no_reuse(self, op, slots):
        """R4: refuse when my record holds, at one of the (edge, timestamp) of `slots`, another operation or other
        totals, or (tracker v3.2) a prior acknowledgment of another prior state: a group with a prior slot records the
        state its PA acknowledges (prior_state {total, timestamp}), and a second PA at the same (edge, timestamp, op)
        over another state is refused, as the server's sandbox signer refuses it. A record without prior_state (written
        before it was recorded) is compared on op and totals only. Returns write_ahead['signed']."""
        groups, priors, order = {}, {}, []
        for x in slots:
            s, i, r, total, ts = x[:5]
            key = (edge_key(i, r), ts)
            if key not in groups:
                groups[key] = {}
                order.append(key)
            groups[key][s] = total
            if len(x) == 6:                   # a prior slot (slot, I, R, X, T, p): PA(I,R,X,p,T)
                priors[key] = {'total': total, 'timestamp': x[5]}
        for key in order:
            have = self.signed_entry(*key)
            if have is not None and (have['op'] != op or have['slots'] != groups[key]):
                self.refuse('timestamp_reused', 'you already signed another operation at this edge and timestamp')
            hp = have.get('prior_state') if have is not None else None
            if hp is not None and key in priors \
                    and (hp['total'], hp['timestamp']) != (priors[key]['total'], priors[key]['timestamp']):
                self.refuse('timestamp_reused', 'you already acknowledged another prior state at this edge and timestamp')
        return [dict({'edge': e, 'timestamp': ts, 'op': op, 'slots': dict(groups[(e, ts)])},
                     **({'prior_state': dict(priors[(e, ts)])} if (e, ts) in priors else {})) for e, ts in order]

    def bound_advertised(self):
        f = self.ctx.get('features')
        return isinstance(f, list) and 'bound_notes/1' in f

    def contract(self):
        """Tracker v3.2: what signs a prior slot (PA) is signed only for the contract CONTRACT, as ctx['novation']
        (GET /info novation) reports it; otherwise feature_unavailable (fail closed, as for a server without
        circulation/1)."""
        problem = contract_problem(self.ctx.get('novation'))
        if problem:
            self.refuse('feature_unavailable', problem + '; nothing was signed')

    def prior_timestamp_named(self, named, state):
        """A prior timestamp the item names beside a prior state (absent or None: names none) must be that state's
        (0 for an absent edge): the template's prior timestamp is checked as its prior total is."""
        if named is None:
            return
        if not _nat(named) or named != (0 if state is None else state['timestamp']):
            self.bad("the item's prior timestamp is not the timestamp of the prior state it shows")


# ---------- bound credit notes ----------
def evaluate_bound_template(tpl, ctx):
    """Check a bound credit-note template (GET credit-note-template?prior=1&bound=1; PROTOCOL.md 18.5) for paying deal
    ctx['deal'] with this client's own note. ctx: me_pk, now_ms, verify, pins, deal, payee_current_pk, records, signed,
    transfer_attempts, novated_edges, features, edges. On ok, to_sign is the prior acknowledgment and the note."""
    return _Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(_bound, tpl)


def _bound(run, tpl):
    s = run.summary
    s['role'], s['kind'] = 'payer', 'bound_note'
    run.load()
    if not isinstance(tpl, dict):
        run.bad('the credit-note template is not a JSON object')
    D, I, R = tpl.get('deal_id'), tpl.get('issuer_pubkey'), tpl.get('recipient_pubkey')
    P, price, total, ts = tpl.get('prior_total'), tpl.get('price'), tpl.get('total'), tpl.get('timestamp')
    nft, denom = tpl.get('tracker_nft_id'), tpl.get('denomination')
    if not (_text(D) and _is_pk(I) and _is_pk(R) and _nat(P) and _nat(price) and price > 0 and _nat(total) and _nat(ts)
            and _text(nft) and _text(denom)):
        run.bad('the credit-note template is missing a field or has one of the wrong type')
    if 'prior_note' not in tpl or (tpl['prior_note'] is not None and not _state_shape(tpl['prior_note'])):
        run.bad('a bound template carries prior_note: the edge state {total, timestamp, signature}, or null')
    for k in ('terms_hash', 'deliverable_sha256'):
        if tpl.get(k) is not None and not _text(tpl[k]):
            run.bad(f'the template field {k} is not a string')
    prior = tpl['prior_note']
    if prior is None and P != 0:
        run.bad('the template shows no prior note but a prior total above 0')
    if prior is not None and prior['total'] != P:
        run.bad("the template's prior note does not match its prior total")
    run.prior_timestamp_named(tpl.get('prior_timestamp'), prior)
    p = 0 if prior is None else prior['timestamp']              # the acknowledged state: (P, p), (0, 0) for a new edge
    s['deal_id'], s['timestamp'], s['amount'] = shown_id(D), ts, price
    run.not_paid_yet(D)
    run.pins(nft, denom)
    deal = run.deal()
    run.same_tracker(deal)
    me_id = run.ctx.get('me_id')
    if D != deal['deal_id'] or tpl.get('terms_hash') not in (None, deal['terms_hash']) \
            or tpl.get('deliverable_sha256') not in (None, deal.get('deliverable_sha256')) \
            or not _text(me_id) or deal['payer']['id'] != me_id:
        run.refuse('deal_mismatch', 'the template is not for the deal, terms and delivery you are paying (as the payer)')
    if I != run.me:
        run.refuse('not_my_edge', 'the template is not for a credit note from your key')
    payee_now = run.ctx.get('payee_current_pk')
    if not _is_pk(payee_now) or R != payee_now:
        run.refuse('wrong_destination', "the template's recipient is not the payee's current key")
    edge = edge_key(I, R)
    if ts % 1000 != BOUND_MS:
        if edge in run.novated or run.bound_advertised():
            run.refuse('bound_note_required', 'this edge takes bound credit notes only (residue 997)')
        run.refuse('timestamp_domain', f'a bound credit note has a timestamp ending in 997 ms, not {ts % 1000}')
    if price != deal['price'] or total != P + price:
        run.refuse('amount_mismatch', f'the note must add exactly the agreed price ({deal["price"]} {run.unit})')
    if prior is not None and not run.verified(I, R, prior):
        run.refuse('bad_prior_signature', 'the prior note shown is not signed by your key')
    run.fresh(ts, [] if prior is None else [prior['timestamp']])
    run.show(edge, prior, mine=True)
    run.add_edge(edge, 'issuer', P, total, ts)
    run.one_live_attempt(D, deal['price'], 'note', edge, P, ts, p, PRIOR_ACK)
    run.no_bound_note_restored([(edge, total, ts)])
    run.contract()
    op = 'note:' + D
    slots = [(slot_key(edge, 'prior'), I, R, P, ts, p), (slot_key(edge, 'new'), I, R, total, ts)]
    signed = run.no_reuse(op, slots)
    return slots, {'op': op, 'signed': signed, 'pending': [_pending(edge, total, ts, 'note', D, 'out')],
                   'attempt': _attempt(D, 'note', edge, P, p, None if prior is None else prior['signature'], total, ts,
                                       None, PRIOR_ACK),
                   'attempts_seen': run.seen}


# ---------- paying with a held note ----------
def evaluate_payer_template(tpl, ctx):
    """Check a transfer template (GET /deals/:id/transfer-template; PROTOCOL.md 18.6 step 2) for paying deal
    ctx['deal'] with a note this client holds. ctx: me_pk, now_ms, verify, pins, deal (with deliverable_sha256),
    payee_current_pk, approved_quote_digest (optional), mandate (optional), records, signed, transfer_attempts, edges.
    On ok, summary.quote_digest is the digest to sign in the pay statement (pay_statement)."""
    return _Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(_payer_template, tpl)


def _payer_template(run, tpl):
    s = run.summary
    s['role'], s['kind'] = 'payer', 'transfer'
    run.load()
    if not isinstance(tpl, dict):
        run.bad('the transfer template is not a JSON object')
    iss, pay, pee, fe, te = (tpl.get(k) for k in ('issuer', 'payer', 'payee', 'from_edge', 'to_edge'))
    ok = (all(isinstance(x, dict) and _is_pk(x.get('pubkey')) for x in (iss, pay, pee))
          and isinstance(fe, dict) and isinstance(te, dict) and _nat(fe.get('new_total')) and _nat(te.get('new_total'))
          and (fe.get('before') is None or _state_shape(fe['before']))
          and (te.get('before') is None or _state_shape(te['before']))
          and _text(tpl.get('deal_id')) and _text(tpl.get('terms_hash')) and _text(tpl.get('deliverable_sha256'))
          and _nat(tpl.get('amount')) and tpl['amount'] > 0 and _nat(tpl.get('timestamp'))
          and _text(tpl.get('tracker_nft_id')) and _text(tpl.get('denomination'))
          and (tpl.get('quote_digest') is None or _text(tpl['quote_digest'])))
    if not ok:
        run.bad('the transfer template is missing a field or has one of the wrong type')
    run.prior_timestamp_named(fe.get('prior_timestamp'), fe.get('before'))
    run.prior_timestamp_named(te.get('prior_timestamp'), te.get('before'))
    v = {'deal_id': tpl['deal_id'], 'terms_hash': tpl['terms_hash'], 'deliverable': tpl['deliverable_sha256'],
         'A': iss['pubkey'], 'A_id': _id_of(iss), 'B': pay['pubkey'], 'B_id': _id_of(pay), 'C': pee['pubkey'],
         'C_id': _id_of(pee), 'amount': tpl['amount'], 'T': tpl['timestamp'], 'from_before': fe.get('before'),
         'from_new': fe['new_total'], 'to_before': te.get('before'), 'to_new': te['new_total'],
         'server_quote': tpl.get('quote_digest'), 'nft': tpl['tracker_nft_id'], 'denom': tpl['denomination'],
         'signed_by_you': set()}
    return _payer(run, v, consent=False)


def _payer(run, v, consent):
    """The payer's rules, for a template it asked for and for a regenerated transfer it is shown as a consent."""
    s, me = run.summary, run.me
    D, A, C, a, T = v['deal_id'], v['A'], v['C'], v['amount'], v['T']
    s['deal_id'], s['timestamp'], s['amount'] = shown_id(D), T, a
    run.not_paid_yet(D)
    run.pins(v['nft'], v['denom'])
    deal = run.deal()
    run.same_tracker(deal)
    me_id = run.ctx.get('me_id')
    if D != deal['deal_id'] or v['terms_hash'] != deal['terms_hash'] or not _text(deal.get('deliverable_sha256')) \
            or (v['deliverable'] is not None and v['deliverable'] != deal['deliverable_sha256']) \
            or not _text(me_id) or deal['payer']['id'] != me_id \
            or (v['B_id'] is not None and v['B_id'] != deal['payer']['id']):
        run.refuse('deal_mismatch', 'this payment is not for the deal, terms and delivery you accepted as payer')
    if v['B'] != me:
        run.refuse('not_my_edge', 'the held note is not on an edge to your key')
    payee_now = run.ctx.get('payee_current_pk')
    if A == me:
        run.refuse('self_edge', 'you cannot pay with a note you issued yourself')
    if A in (C, deal['payee']['pubkey'], payee_now) or (v['A_id'] is not None and v['A_id'] == deal['payee']['id']):
        run.refuse('pay_with_is_payee', 'the issuer of the note is the payee itself; a set-off would clear it instead')
    if not _is_pk(payee_now) or C != payee_now or (v['C_id'] is not None and v['C_id'] != deal['payee']['id']):
        run.refuse('wrong_destination', "the destination is not the payee's current key")
    if a != deal['price']:
        run.refuse('amount_mismatch', f'the amount must be the agreed price ({deal["price"]} {run.unit})')
    if T % 1000 != TRANSFER_MS:
        run.refuse('timestamp_domain', f'a transfer has a timestamp ending in 999 ms, not {T % 1000}')
    fb, tb = v['from_before'], v['to_before']
    if fb is None or fb['total'] < a or v['from_new'] != fb['total'] - a:
        run.refuse('amount_mismatch', f'your held claim must fall by exactly {a} {run.unit} (and cover it)')
    X, Y = fb['total'], tb['total'] if tb is not None else 0
    p_ab = fb['timestamp']                    # the held edge's state (X, p_AB): what my prior slot acknowledges
    if v['to_new'] != Y + a:
        run.refuse('amount_mismatch', f"the payee's claim must rise by exactly {a} {run.unit}")
    if not run.verified(A, me, fb) or (tb is not None and not run.verified(A, C, tb)):
        run.refuse('bad_prior_signature', "an edge state shown is not the issuer's signature")
    run.fresh(T, [fb['timestamp']] + ([tb['timestamp']] if tb is not None else []))
    held, dest = edge_key(A, me), edge_key(A, C)
    run.show(held, fb, mine=True)
    run.show(dest, tb, mine=False)
    run.add_edge(held, 'creditor', X, X - a, T)
    run.add_edge(dest, 'payer', Y, Y + a, T)
    run.one_live_attempt(D, deal['price'], 'transfer', held, X, T, p_ab, PRIOR_ACK)
    q = quote_digest({'network': deal['network'], 'tracker_nft_id': v['nft'], 'denomination': v['denom'],
                      'deal_id': D, 'terms_hash': deal['terms_hash'], 'deliverable_sha256': deal['deliverable_sha256'],
                      'issuer_pubkey': A, 'payer_pubkey': me, 'payee_pubkey': C, 'amount': a})
    s['quote_digest'] = q
    if v['server_quote'] is not None and v['server_quote'] != q:
        run.bad("the server's quote digest is not the one this client computes from the checked values")
    approved = run.ctx.get('approved_quote_digest')
    if approved is not None and approved != q:
        run.refuse('stale_quote', 'this payment is not the one your owner approved (the quote changed)')
    if consent and q not in run.approved_quotes(D, held):
        run.refuse('stale_quote', 'this payment is not one your owner approved for an attempt of yours that is still '
                                  'within its window (T + 1 h + 2 min); a payment made again later needs a new approval')
    m = run.ctx.get('mandate')
    if not isinstance(m, dict):
        run.refuse('policy_off', "your owner's mandate could not be read, so nothing is paid with a held note")
    if m.get('pay_with_held_notes') == 'never':
        run.refuse('policy_off', "your owner's mandate does not allow paying with held notes")
    run.contract()
    op = 'pay:' + D
    slots = [(slot_key(held, 'prior'), A, me, X, T, p_ab), (slot_key(held, 'new'), A, me, X - a, T),
             (slot_key(dest, 'new'), A, C, Y + a, T)]
    signed = run.no_reuse(op, slots)
    return ([x for x in slots if x[0] not in v['signed_by_you']],
            {'op': op, 'signed': signed, 'pending': [_pending(held, X - a, T, 'transfer', D, 'in')],
             'attempt': _attempt(D, 'transfer', held, X, p_ab, fb['signature'], X - a, T, q, PRIOR_ACK),
             'attempts_seen': run.seen})


# ---------- consents ----------
def evaluate_consent(item, ctx):
    """Check one GET /consents item (PROTOCOL.md 18.9) for the role it gives this client: payer (a regenerated
    transfer), issuer, payee or member (a set-off). ctx: me_pk, now_ms, verify, pins, records, signed, consent_policy,
    mandate; payer and payee also deal (and me_id); payer also payee_current_pk, approved_quote_digest,
    transfer_attempts, edges. A refused consent is refused at the server with the code as its reason."""
    return _Run(ctx, 'bad_consent', CONSENT_WINDOW_MS).execute(_consent, item)


def _consent(run, item):
    s = run.summary
    run.load()
    if not isinstance(item, dict):
        run.bad('the consent item is not a JSON object')
    kind, iid, roles = item.get('kind'), item.get('id'), item.get('your_roles')
    if kind not in ('transfer', 'setoff') or not _text(iid):
        run.bad('a consent item is a transfer or a set-off with an id')
    s['kind'], s['id'] = kind, shown_id(iid)
    if not (isinstance(roles, list) and len(roles) == 1 and roles[0] in ROLES):
        run.bad('a consent item gives exactly one role of yours')
    role = s['role'] = roles[0]
    if (kind == 'setoff') != (role == 'member'):
        run.bad('the role does not fit the kind of consent')
    if item.get('state') != 'collecting':
        run.bad('the item is not collecting signatures')
    nft, denom = item.get('tracker_nft_id'), item.get('denomination')
    context = {} if item.get('context') is None else item['context']
    if not (_text(nft) and _text(denom) and isinstance(context, dict)):
        run.bad('the consent item is missing its tracker, unit or context')
    edges = _consent_edges(run, item)
    run.pins(nft, denom)
    return {'member': _member, 'issuer': _issuer, 'payee': _payee, 'payer': _payer_consent}[role](run, item, edges, context)


def _consent_edges(run, item):
    raw = item.get('edges')
    if not isinstance(raw, list) or not raw or len(raw) > 64:
        run.bad('a consent item lists between 1 and 64 of your edges')
    out = []
    for e in raw:
        keys = parse_edge(e.get('edge')) if isinstance(e, dict) else None
        if keys is None:
            run.bad('an edge is not "<issuer_pubkey>><recipient_pubkey>"')
        before, new, ts, rev, change = e.get('before'), e.get('new_total'), e.get('timestamp'), e.get('revision'), e.get('change')
        slots = e.get('slots')
        done = [] if e.get('signed_by_you') is None else e['signed_by_you']
        if not ((before is None or _state_shape(before)) and _nat(new) and _nat(ts) and _nat(rev) and _int(change)
                and isinstance(slots, list) and slots and all(x in ('prior', 'new') for x in slots)
                and len(set(slots)) == len(slots) and isinstance(done, list) and all(x in slots for x in done)
                and e.get('your_role') in ('issuer', 'creditor', 'payer')):
            run.bad('an edge of the item is missing a field or has one of the wrong type')
        if change != new - (before['total'] if before is not None else 0):
            run.bad("an edge's change is not its new total minus its prior total")
        run.prior_timestamp_named(e.get('prior_timestamp'), before)
        out.append({'edge': e['edge'], 'I': keys[0], 'R': keys[1], 'before': before, 'new': new, 'ts': ts,
                    'slots': list(slots), 'done': set(done), 'your_role': e['your_role'],
                    'issuer_id': _id_of(e.get('issuer')), 'recipient_id': _id_of(e.get('recipient'))})
    return out


def _before_total(e):
    return e['before']['total'] if e['before'] is not None else 0


def _member(run, item, edges, context):
    me, s = run.me, run.summary
    if any(e['slots'] != ['new'] or e['before'] is None for e in edges):
        run.bad('a set-off edge is an existing edge with one slot, new')
    seen = set()
    for e in edges:
        if e['I'] == e['R']:
            run.refuse('self_edge', 'a set-off edge from a key to itself')
        if me not in (e['I'], e['R']):
            run.refuse('not_my_edge', 'the item shows an edge you are not a party to')
        if e['edge'] in seen:
            run.refuse('duplicate_edge', 'the item shows the same edge twice')
        seen.add(e['edge'])
    if any(e['your_role'] != ('issuer' if e['I'] == me else 'creditor') for e in edges):
        run.bad('the role the item gives you on an edge does not fit its keys')
    for e in edges:
        if e['ts'] % 1000 != SETOFF_MS:
            run.refuse('timestamp_domain', f"a set-off edge has a timestamp ending in 998 ms, not {e['ts'] % 1000}")
    for e in edges:
        if e['new'] >= e['before']['total']:
            run.refuse('increase_in_setoff', 'a set-off only lowers edges')
    as_creditor = sum(e['before']['total'] - e['new'] for e in edges if e['R'] == me)
    as_issuer = sum(e['before']['total'] - e['new'] for e in edges if e['I'] == me)
    if as_creditor != as_issuer:
        run.refuse('not_net_neutral', f'your claims would fall by {as_creditor} {run.unit} and your debts by {as_issuer} {run.unit}')
    for e in edges:
        if not run.verified(e['I'], e['R'], e['before']):
            run.refuse('bad_prior_signature', "an edge state shown is not its issuer's signature")
    for e in edges:
        run.fresh(e['ts'], [e['before']['timestamp']])
    for e in edges:
        run.show(e['edge'], e['before'], mine=True)
        run.add_edge(e['edge'], 'issuer' if e['I'] == me else 'creditor', e['before']['total'], e['new'], e['ts'])
    s['amount'] = as_creditor
    s['timestamp'] = edges[0]['ts'] if all(e['ts'] == edges[0]['ts'] for e in edges) else None
    p, _m = run.policy('setoff', 'auto_clear')
    run.cap(p, as_creditor)
    run.no_pending_unbound([e['edge'] for e in edges if e['I'] == me])
    run.no_bound_note_restored([(e['edge'], e['new'], e['ts']) for e in edges if e['I'] == me])
    op = 'setoff:' + item['id']
    slots = [(slot_key(e['edge'], 'new'), e['I'], e['R'], e['new'], e['ts']) for e in edges]
    signed = run.no_reuse(op, slots)
    done = {slot_key(e['edge'], x) for e in edges for x in e['done']}
    pending = [_pending(e['edge'], e['new'], e['ts'], 'setoff', item['id'], 'out' if e['I'] == me else 'in') for e in edges]
    return [x for x in slots if x[0] not in done], {'op': op, 'signed': signed, 'pending': pending, 'attempt': None,
                                                    'attempts_seen': []}


def _issuer(run, item, edges, context):
    me, s = run.me, run.summary
    a = context.get('amount')
    if len(edges) != 2 or any(e['your_role'] != 'issuer' or e['slots'] != ['new'] for e in edges) \
            or edges[0]['ts'] != edges[1]['ts'] or not (_nat(a) and a > 0):
        run.bad('an issuer consent shows its two edges, one slot (new) each, one timestamp, and the amount')
    T = edges[0]['ts']
    s['timestamp'], s['amount'] = T, a
    for e in edges:
        if e['I'] != me:
            run.refuse('not_my_edge', 'an edge of the transfer is not yours as issuer')
        if e['R'] == me:
            run.refuse('self_edge', 'a transfer edge from your key to itself')
    if edges[0]['edge'] == edges[1]['edge']:
        run.refuse('duplicate_edge', 'the item shows the same edge twice')
    if T % 1000 != TRANSFER_MS:
        run.refuse('timestamp_domain', f'a transfer has a timestamp ending in 999 ms, not {T % 1000}')
    dec = [e for e in edges if e['before'] is not None and e['new'] < e['before']['total']]
    inc = [e for e in edges if e['new'] > _before_total(e)]
    if len(dec) != 1 or len(inc) != 1:
        run.refuse('total_owed_changes', 'a transfer lowers one of your edges and raises the other by the same amount')
    fe, te = dec[0], inc[0]
    if fe['before']['total'] - fe['new'] != a or te['new'] - _before_total(te) != a:
        run.refuse('total_owed_changes', f'your total owed would change: both edges must move exactly {a} {run.unit}')
    if not (_same_id(context.get('payer'), fe['recipient_id']) and _same_id(context.get('payee'), te['recipient_id'])):
        run.bad('the item names creditors other than the ones its edges are to')
    if any(e['before'] is not None and not run.verified(me, e['R'], e['before']) for e in (fe, te)):
        run.refuse('bad_prior_signature', 'an edge state shown is not signed by your key')
    run.fresh(T, [e['before']['timestamp'] for e in (fe, te) if e['before'] is not None])
    for e in (fe, te):
        run.show(e['edge'], e['before'], mine=True)
        run.add_edge(e['edge'], 'issuer', _before_total(e), e['new'], T)
    p, _m = run.policy('as_issuer', 'novate_own_debt')
    run.cap(p, a)
    run.no_pending_unbound([fe['edge'], te['edge']])
    run.no_bound_note_restored([(fe['edge'], fe['new'], T), (te['edge'], te['new'], T)])
    op = 'transfer:' + item['id']
    slots = [(slot_key(fe['edge'], 'new'), me, fe['R'], fe['new'], T), (slot_key(te['edge'], 'new'), me, te['R'], te['new'], T)]
    signed = run.no_reuse(op, slots)
    done = {slot_key(e['edge'], x) for e in (fe, te) for x in e['done']}
    pending = [_pending(e['edge'], e['new'], T, 'transfer', item['id'], 'out') for e in (fe, te)]
    return [x for x in slots if x[0] not in done], {'op': op, 'signed': signed, 'pending': pending, 'attempt': None,
                                                    'attempts_seen': []}


def _payee(run, item, edges, context):
    me, s = run.me, run.summary
    a, cd = context.get('amount'), context.get('deal')
    if len(edges) != 1 or edges[0]['your_role'] != 'creditor' or sorted(edges[0]['slots']) != ['new', 'prior'] \
            or not (_nat(a) and a > 0):
        run.bad('a payee consent shows its one edge, two slots (prior and new), and the amount')
    e = edges[0]
    T = e['ts']
    s['timestamp'], s['amount'] = T, a
    if e['R'] != me:
        run.refuse('not_my_edge', 'the edge is not to your key')
    if e['I'] == me:
        run.refuse('self_edge', 'a transfer edge from your key to itself')
    deal = run.deal()
    s['deal_id'] = shown_id(deal['deal_id'])
    run.same_tracker(deal)
    Y = _before_total(e)
    me_id = run.ctx.get('me_id')
    if not (isinstance(cd, dict) and cd.get('deal_id') == deal['deal_id'] and cd.get('terms_hash') == deal['terms_hash']
            and cd.get('price', a) == a and deal['price'] == a and e['new'] == Y + a
            and deal['payee']['pubkey'] == me and (me_id is None or deal['payee']['id'] == me_id)
            and deal.get('delivered') is True and deal.get('transfer_id') == item['id']
            and _same_id(context.get('payer'), deal['payer']['id'])):
        run.refuse('deal_mismatch', 'this transfer does not pay a deal you delivered on as payee, by exactly its price')
    if T % 1000 != TRANSFER_MS:
        run.refuse('timestamp_domain', f'a transfer has a timestamp ending in 999 ms, not {T % 1000}')
    if e['before'] is not None and not run.verified(e['I'], me, e['before']):
        run.refuse('bad_prior_signature', "the edge state shown is not the issuer's signature")
    run.fresh(T, [e['before']['timestamp']] if e['before'] is not None else [])
    run.show(e['edge'], e['before'], mine=True)
    run.add_edge(e['edge'], 'creditor', Y, e['new'], T)
    p, m = run.policy('as_new_creditor', 'accept_transfers')
    if m.get('may_accept_credit') is False:
        run.refuse('policy_off', "your owner's mandate does not allow accepting credit")
    run.issuer_accepted(p, m, e['I'], e['issuer_id'] or _id_of(context.get('issuer')))
    run.cap(p, a)
    cap = m.get('max_accept_per_issuer')
    if cap is not None and (not _nat(cap) or Y + a > cap):
        run.refuse('policy_cap', f'your claim on this issuer would be {Y + a} {run.unit}, above max_accept_per_issuer')
    run.contract()
    op = 'transfer:' + item['id']
    p_ac = e['before']['timestamp'] if e['before'] is not None else 0    # the state (Y, p_AC) I acknowledge, (0, 0): none
    slots = [(slot_key(e['edge'], 'prior'), e['I'], me, Y, T, p_ac), (slot_key(e['edge'], 'new'), e['I'], me, e['new'], T)]
    signed = run.no_reuse(op, slots)
    done = {slot_key(e['edge'], x) for x in e['done']}
    return ([x for x in slots if x[0] not in done],
            {'op': op, 'signed': signed, 'pending': [_pending(e['edge'], e['new'], T, 'transfer', item['id'], 'in')],
             'attempt': None, 'attempts_seen': []})


def _payer_consent(run, item, edges, context):
    me = run.me
    cd, a = context.get('deal'), context.get('amount')
    if len(edges) != 2 or not (isinstance(cd, dict) and _text(cd.get('deal_id')) and _text(cd.get('terms_hash'))
                               and _nat(a) and a > 0 and cd.get('price', a) == a
                               and (cd.get('quote_digest') is None or _text(cd['quote_digest']))):
        run.bad('a payer consent shows the held edge, the destination edge, the deal and the amount it pays')
    held = [e for e in edges if e['R'] == me]
    if len(held) != 1:
        run.refuse('not_my_edge', 'the item does not show exactly one held edge to your key')
    fe = held[0]
    te = edges[1] if edges[0] is fe else edges[0]
    if fe['your_role'] != 'creditor' or sorted(fe['slots']) != ['new', 'prior'] or te['your_role'] != 'payer' \
            or te['slots'] != ['new'] or te['I'] != fe['I'] or te['ts'] != fe['ts']:
        run.bad('a payer signs prior and new on its held edge and new on the destination, one issuer, one timestamp')
    v = {'deal_id': cd['deal_id'], 'terms_hash': cd['terms_hash'], 'deliverable': None,
         'A': fe['I'], 'A_id': fe['issuer_id'] or _id_of(context.get('issuer')), 'B': me, 'B_id': _id_of(context.get('payer')),
         'C': te['R'], 'C_id': te['recipient_id'] or _id_of(context.get('payee')), 'amount': a, 'T': fe['ts'],
         'from_before': fe['before'], 'from_new': fe['new'], 'to_before': te['before'], 'to_new': te['new'],
         'server_quote': cd.get('quote_digest'), 'nft': item['tracker_nft_id'], 'denom': item['denomination'],
         'signed_by_you': {slot_key(fe['edge'], x) for x in fe['done']} | {slot_key(te['edge'], x) for x in te['done']}}
    return _payer(run, v, consent=True)


# ---------- helpers for the caller's records (no clock: signed_at is passed in) ----------
def _sub(state, key):
    v = state.get(key)
    if v is None:
        v = state[key] = {}
    if not isinstance(v, dict):
        raise ValueError(f'records_unreadable: state[{key!r}] is not a JSON object')
    return v


def apply_write_ahead(state, write_ahead, signed_at=None):
    """R9: record in the client's state (in place) what an evaluation is about to sign, before anything is sent:
    state['signed'] (R4), the pending entries in state['records'] (records.add_pending) and the payment attempt in
    state['transfer_attempts'][deal_id] (D-1). Run it inside the store's update(), on the state the evaluation read
    (evaluate and write ahead in one locked step). Idempotent.
    It checks first, and writes nothing when the state changed since the evaluation (a concurrent process): another
    operation, or a prior acknowledgment of another prior state (prior_state), already recorded at one of its (edge,
    timestamp) (WriteAheadConflict timestamp_reused, R4), the deal
    recorded as paid (already_paid), or a payment attempt of the deal that the evaluation did not weigh
    (write_ahead['attempts_seen']; transfer_window_open, D-1: so a second attempt is never added on a stale snapshot).
    ValueError (records_unreadable) for a record that is not of its shape."""
    signed, recs, attempts = _sub(state, 'signed'), _sub(state, 'records'), _sub(state, 'transfer_attempts')
    for g in write_ahead['signed']:
        per = signed.get(g['edge'])
        if per is not None and not isinstance(per, dict):
            raise ValueError("records_unreadable: state['signed'] holds an edge that is not a JSON object")
        have = per.get(str(g['timestamp'])) if per else None
        if have is not None and (not isinstance(have, dict) or have.get('op') != g['op'] or have.get('slots') != g['slots']):
            raise WriteAheadConflict('timestamp_reused', 'another operation is already recorded at this edge and '
                                                         'timestamp; nothing was signed')
        hp, gp = (have.get('prior_state') if have is not None else None), g.get('prior_state')
        if hp is not None and gp is not None and not (_prior_state_ok(hp) and (hp['total'], hp['timestamp'])
                                                      == (gp['total'], gp['timestamp'])):
            raise WriteAheadConflict('timestamp_reused', 'another prior state is already acknowledged at this edge and '
                                                         'timestamp; nothing was signed')
    a = write_ahead.get('attempt')
    if a:
        lst = attempts.get(a['deal_id'])
        if lst is not None and not isinstance(lst, list):
            raise ValueError("records_unreadable: state['transfer_attempts'] holds a deal that is not a list")
        paid = recs.get(PAID_DEALS_KEY)
        if isinstance(paid, dict) and a['deal_id'] in paid:
            raise WriteAheadConflict('already_paid', 'this deal is recorded as paid; nothing was signed')
        mine = (a['route'], a['edge'], a['total'], a['timestamp'])
        seen = {tuple(x) for x in write_ahead.get('attempts_seen') or [] if isinstance(x, (list, tuple))}
        if any(k != mine and k not in seen for k in _attempt_keys(state, a['deal_id'])):
            raise WriteAheadConflict('transfer_window_open', 'another payment attempt of this deal was recorded '
                                                             'meanwhile; evaluate it again; nothing was signed')
    for g in write_ahead['signed']:
        ps = g.get('prior_state')
        signed.setdefault(g['edge'], {})[str(g['timestamp'])] = dict({'op': g['op'], 'slots': dict(g['slots'])},
                                                                     **({'prior_state': dict(ps)} if ps else {}))
    for p in write_ahead['pending']:
        _records.add_pending(recs, p['pair'], p['total'], p['timestamp'], p['kind'], p['ref'], p['direction'], signed_at)
    if a:
        lst = attempts.setdefault(a['deal_id'], [])
        keys = ('route', 'edge', 'prior', 'total', 'timestamp')
        if not any(isinstance(x, dict) and all(x.get(k) == a[k] for k in keys) for x in lst):
            lst.append(dict(a, signed_at=signed_at))


def apply_findings(state, summary, me_pk=None):
    """Record what an evaluation found, signed or not (PROTOCOL.md 15.3 notes; D-1 item 5): pending entries the item
    showed applied become confirmed (records.confirm; with me_pk, the 0.3 'issued' record of an outgoing edge follows),
    and the deals they paid go into state['records']['paid_deals'], never to be paid again. Returns the deal ids it
    newly recorded as paid."""
    recs = _sub(state, 'records')
    for a in summary.get('applied') or []:
        e = _records.confirm(recs, a['pair'], a['state'])
        if me_pk and a['pair'].startswith(f'{me_pk}>') and e['confirmed']:
            _sub(state, 'issued')[a['pair']] = e['confirmed']['total']
    new = []
    for deal_id, info in (summary.get('paid_deals') or {}).items():
        if mark_paid(state, deal_id, info['route'], info['edge'], info['total'], info['timestamp']):
            new.append(deal_id)
    return new


def mark_paid(state, deal_id, route, edge, total, timestamp):
    """D-1 item 5: once a payment of the deal is confirmed (by a read-back or by an item showing it applied), record
    records['paid_deals'][deal_id] = {route, edge, total, timestamp}; every payer evaluation then refuses the deal
    (already_paid). The first record is kept. True when it was new."""
    if route not in ROUTES:
        raise ValueError("a paid deal's route is 'note' or 'transfer'")
    paid = _sub(state, 'records').setdefault(PAID_DEALS_KEY, {})
    if not isinstance(paid, dict):
        raise ValueError("records_unreadable: records['paid_deals'] is not a JSON object")
    if deal_id in paid:
        return False
    paid[deal_id] = {'route': route, 'edge': edge, 'total': total, 'timestamp': timestamp}
    return True


def unbound_note_problem(edge, novated_edges, features=None):
    """R12 for an ordinary (unbound) credit note on `edge`, for a client's ordinary complete() path: 'bound_note_required'
    when the edge is in novated_edges or the server advertises bound_notes/1, 'records_unreadable' when novated_edges
    cannot be read, else None."""
    if novated_edges is not None and not isinstance(novated_edges, (dict, list)):
        return 'records_unreadable'
    if isinstance(novated_edges, list) and not all(isinstance(x, str) for x in novated_edges):
        return 'records_unreadable'
    if (novated_edges is not None and edge in novated_edges) or (isinstance(features, list) and 'bound_notes/1' in features):
        return 'bound_note_required'
    return None


def check_payment(deal_id, price, route, edge, prior, ctx):
    """D-1 alone, for a payment the evaluators above do not see (a client's ordinary complete() path): may a new
    attempt (route 'note' or 'transfer', the edge whose prior it acknowledges, that prior) be signed for the deal now?
    ctx: me_pk, now_ms, verify, pins (to verify ctx['edges']), records, transfer_attempts, edges. Returns {ok, code,
    summary} with the codes and summary fields of the evaluators."""
    def go(run, _item):
        s = run.summary
        s['role'], s['kind'], s['deal_id'] = 'payer', route, shown_id(deal_id)
        run.load()
        if not (_text(deal_id) and _nat(price) and price > 0 and route in ROUTES and parse_edge(edge) is not None
                and _nat(prior)):
            run.bad('check_payment takes a deal id, its price, a route, an edge and a prior total')
        run.have_pins()
        # no timestamps: never the same transfer signed again, never the same-prior exemption (an ordinary note
        # acknowledges no prior state)
        run.one_live_attempt(deal_id, price, route, edge, prior)
        return [], None
    r = _Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(go, None)
    return {'ok': r['ok'], 'code': r['code'], 'summary': r['summary']}


def classify_attempts(deal_id, ctx, price=None):
    """The earlier payment attempts of a deal and how the evaluators weigh each now (D-1 with D-2 a), for listing them
    (`valun attempts list`) and for the owner's resolution of one: the deal's attempt records in their order, then its
    pending payment entries that no record covers (their prior from `price`, or None without it), each with its
    outcome as the payer evaluators classify it: 'applied' (my confirmed state of its edge, its read-back, or the
    owner's decision shows it applied), 'unknown' (it may have applied: only the owner can resolve it), 'alive',
    'unread' or 'dead' (also an 'unknown' one that my own records prove dead, proven_dead). Read-backs follow the
    evaluators' rules: ctx['edges'] (verified on the pinned tracker; not used without pins), where an absent edge is no
    read-back for an attempt that acknowledged a prior above 0, and a state older than its prior state or than my
    confirmed state is none; my confirmed state at or past the attempt counts as one. ctx: me_pk, now_ms, verify, pins,
    records, signed, transfer_attempts, edges. Returns {ok, code, attempts: [{attempt, outcome}]}: ok False (and no
    attempts) with records_unreadable for records that cannot be read, bad_prior_signature for an edge state that does
    not verify, bad_template for arguments that are not a deal id and a positive price (or None)."""
    def go(run, _item):
        run.load()
        if not (_text(deal_id) and (price is None or (_nat(price) and price > 0))):
            run.bad('classify_attempts takes a deal id and its price (or None)')
        p = run.ctx.get('pins')
        if not (isinstance(p, dict) and _text(p.get('tracker_nft_id')) and _text(p.get('denomination'))):
            run.ctx_edges = {}                 # nothing to verify a read-back against: none is used
        return [{'attempt': a, 'outcome': o} for a, o, _s in run.classify(deal_id, price)], None
    r = _Run(ctx, 'bad_template', INITIATE_WINDOW_MS).execute(go, None)
    return {'ok': r['ok'], 'code': r['code'], 'attempts': r['to_sign'] if r['ok'] else []}
