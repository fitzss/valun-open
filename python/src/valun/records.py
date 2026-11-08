"""A participant's own record of the credit edges it is party to.

Standard library only, and it imports nothing else from this package (it is vendored into the Hermes plugin).

    records = {pair: {'confirmed': EdgeState or None, 'pending': [entry, ...]}, 'paid_deals': {...}}
    pair    = '<issuer_pubkey>><recipient_pubkey>' (hex keys)

records['paid_deals'] (the one key that is not a pair; novation.PAID_DEALS_KEY) = {deal_id: {route ('note' or
           'transfer'), edge, total, timestamp}}: the deals a payment of this client is known to have paid, never paid
           again (decision D-1 item 5; written by novation.mark_paid and apply_findings). The functions here never read
           or write it: no pair key can equal 'paid_deals'.
EdgeState  {'total', 'timestamp', 'signature'}: the edge's note as last confirmed applied on the Basis tracker. The
           signature is the issuer's: the tracker stores the issuer's new signature for notes, transfers and set-offs.
           A confirmed state drops its signature 30 days after its timestamp (the client's pruning, design 11): it is
           then {'total', 'timestamp'}, which is all that is compared later.
entry      {'total', 'timestamp', 'kind', 'ref', 'direction', 'signed_at'}: something this client signed for the edge
           whose outcome is not known yet. kind: 'note' (a credit note) or a novation kind such as 'transfer' or
           'setoff'; ref: the deal, transfer or set-off id; direction: 'out' when this client is the edge's issuer,
           'in' when it is the creditor; signed_at: when it was signed (ISO 8601, UTC), as the caller gives it.

Rules
- A pending entry becomes confirmed only when a recorded outcome or the edge's current state shows it applied
  (confirm, sync_edge). Nothing is confirmed just because it was signed: an owner can still reject a held credit note,
  and a held note can go stale (OQ-23).
- A tracker edge's timestamps strictly increase. Once a state at timestamp T is confirmed, a pending entry at or before
  T can never apply, so it is dropped; and the confirmed state never moves back to an older timestamp.
- accept_prior: a prior note shown by the server is acceptable when it is the issuer's own signature (checked by the
  caller's verifier) and is not older than the confirmed state. The tracker enforces the rest (bound notes).
"""

MAX_U64 = 2 ** 64


def pair_key(issuer_pubkey, recipient_pubkey):
    return f'{issuer_pubkey}>{recipient_pubkey}'


def _nat(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v < MAX_U64


def edge_state(s):
    """A checked copy of an EdgeState {total, timestamp, signature}; ValueError when `s` is not one."""
    if not isinstance(s, dict) or not _nat(s.get('total')) or not _nat(s.get('timestamp')) \
            or not isinstance(s.get('signature'), str) or not s['signature']:
        raise ValueError('an edge state is {total, timestamp, signature}: two whole numbers and a signature')
    return {'total': s['total'], 'timestamp': s['timestamp'], 'signature': s['signature']}


def get(recs, pair):
    """One edge's record, without adding it: {'confirmed': EdgeState or None, 'pending': [entries]}."""
    e = (recs or {}).get(pair)
    e = e if isinstance(e, dict) else {}
    c = e.get('confirmed')
    return {'confirmed': c if isinstance(c, dict) else None,
            'pending': list(e.get('pending') or []) if isinstance(e.get('pending'), list) else []}


def confirmed_total(recs, pair):
    """The confirmed total of one edge, or None when nothing on it is confirmed."""
    c = get(recs, pair)['confirmed']
    return c.get('total') if c else None


def _entry(recs, pair):
    e = recs.get(pair)
    if not isinstance(e, dict):
        e = recs[pair] = {}
    if not isinstance(e.get('confirmed'), dict):
        e['confirmed'] = None
    if not isinstance(e.get('pending'), list):
        e['pending'] = []
    return e


def add_pending(recs, pair, total, timestamp, kind, ref=None, direction='out', signed_at=None):
    """Record something just signed for `pair` whose outcome is not known yet. Returns the entry (an identical entry
    already recorded is returned instead of a second copy)."""
    if not (_nat(total) and _nat(timestamp)):
        raise ValueError('a pending entry needs a whole-number total and timestamp')
    if direction not in ('out', 'in'):
        raise ValueError("direction is 'out' (I am the issuer) or 'in' (I am the creditor)")
    e = _entry(recs, pair)
    for p in e['pending']:
        if isinstance(p, dict) and (p.get('total'), p.get('timestamp'), p.get('kind'), p.get('ref')) == (total, timestamp, kind, ref):
            return p
    p = {'total': total, 'timestamp': timestamp, 'kind': kind, 'ref': ref, 'direction': direction, 'signed_at': signed_at}
    e['pending'].append(p)
    return p


def remove_pending(recs, pair, total, timestamp, ref=None):
    """Forget a pending entry that can never apply (for example the server refused it). Returns how many were removed."""
    e = recs.get(pair) if isinstance(recs, dict) else None
    if not isinstance(e, dict) or not isinstance(e.get('pending'), list):
        return 0
    keep = [p for p in e['pending'] if not (isinstance(p, dict) and p.get('total') == total and p.get('timestamp') == timestamp
                                            and (ref is None or p.get('ref') == ref))]
    removed = len(e['pending']) - len(keep)
    e['pending'] = keep
    return removed


def _apply(recs, pair, st):
    e = _entry(recs, pair)
    cur = e['confirmed']
    if cur is not None and _nat(cur.get('timestamp')) and st['timestamp'] < cur['timestamp']:
        return e, None, [], False               # older than what is confirmed: nothing changes
    match = next((p for p in e['pending'] if isinstance(p, dict)
                  and p.get('total') == st['total'] and p.get('timestamp') == st['timestamp']), None)
    keep, dropped = [], []
    for p in e['pending']:
        if isinstance(p, dict) and _nat(p.get('timestamp')) and p['timestamp'] > st['timestamp']:
            keep.append(p)                      # may still apply later
        elif p is not match:
            dropped.append(p)                   # at or before the confirmed state: it can never apply
    e['confirmed'], e['pending'] = st, keep
    return e, match, dropped, True


def confirm(recs, pair, state):
    """A recorded outcome shows `state` (an EdgeState) applied on `pair`: it becomes the confirmed state, a matching
    pending entry is promoted, and pending entries at or before its timestamp are dropped. A state older than the one
    already confirmed changes nothing. Returns the edge's record."""
    return _apply(recs, pair, edge_state(state))[0]


def sync_edge(recs, edge):
    """Apply one row of the edge's current state as the server shows it ({edge or issuer_pubkey and recipient_pubkey,
    total, timestamp, signature}; the caller verifies the signature first). Promotes a matching pending entry, drops
    pending entries older than the new confirmed timestamp, and never moves the confirmed state back in time.
    Returns {pair, changed, promoted (the pending entry that applied, or None), dropped [entries], confirmed}."""
    if not isinstance(edge, dict):
        raise ValueError('an edge row is a JSON object')
    pair = edge.get('edge')
    if pair is None and isinstance(edge.get('issuer_pubkey'), str) and isinstance(edge.get('recipient_pubkey'), str):
        pair = pair_key(edge['issuer_pubkey'], edge['recipient_pubkey'])
    issuer, sep, recipient = pair.partition('>') if isinstance(pair, str) else ('', '', '')
    if not (sep and issuer and recipient and '>' not in recipient):
        raise ValueError('an edge row names its edge as "<issuer_pubkey>><recipient_pubkey>"')
    e, match, dropped, changed = _apply(recs, pair, edge_state(edge))
    return {'pair': pair, 'changed': changed, 'promoted': match, 'dropped': dropped, 'confirmed': e['confirmed']}


def prior_problem(recs, pair, prior_note, my_pubkey, verify):
    """Why `prior_note` (the current note on my outgoing edge `pair`, as the server shows it) is not an acceptable
    prior, or None when it is. verify(issuer_pubkey, recipient_pubkey, total, timestamp, signature) -> bool checks the
    issuer's Basis note signature (the caller binds the tracker and unit).
      'bad_prior_signature'  it is not my own signature as the edge's issuer (or it is malformed)
      'stale_prior'          it is older than the state my records confirm (or contradicts it at the same timestamp)"""
    issuer, sep, recipient = str(pair).partition('>')
    if not sep or issuer != my_pubkey or not recipient or not isinstance(prior_note, dict):
        return 'bad_prior_signature'
    total, ts, sig = prior_note.get('total'), prior_note.get('timestamp'), prior_note.get('signature')
    if not (_nat(total) and _nat(ts) and isinstance(sig, str) and sig):
        return 'bad_prior_signature'
    try:
        ok = verify(issuer, recipient, total, ts, sig) is True
    except Exception:  # noqa: BLE001 - a verifier that fails accepts nothing
        ok = False
    if not ok:
        return 'bad_prior_signature'
    cur = get(recs, pair)['confirmed']
    if cur is not None and _nat(cur.get('timestamp')):
        if ts < cur['timestamp'] or (ts == cur['timestamp'] and total != cur.get('total')):
            return 'stale_prior'
    return None


def accept_prior(recs, pair, prior_note, my_pubkey, verify):
    """True when `prior_note` is a prior I signed as the edge's issuer and is not older than my confirmed state."""
    return prior_problem(recs, pair, prior_note, my_pubkey, verify) is None
