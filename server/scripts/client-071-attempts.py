"""What valun 0.7.1 does when its agent pays a deal again after its owner rejected (or let expire) a payment of it that
Valun held, or Valun voided it on approval (a held IOU whose pair changed while it waited: 409 stale_note): the agent's
bound IOU, or its payment by transfer through an IOU it holds. 0.7.1 is never told of either
(it never reads an approval's state), so it keeps the payment as an attempt that may still apply (its novation.py,
decision D-1). For each event that can change the IOU that payment would have changed, this runs 0.7.1's own rules and
checks the facts the texts give about it. The owner's texts (the IOU card's and the payment card's, lib/pilot/core.mjs
approvalEffect; the owner console, public/pilot.js and pilot.html; /start; skill.md) give only what holds in every case:
0.7.1 usually pays again at once, it may refuse, and what to do for each answer (transfer_window_open: pay again once
the attempt's timestamp + 1 h + 2 min has passed; attempt_outcome_unknown: resolve it as not applied, then pay again
once that time has passed), which every case below checks (way_out). docs/PILOT-API.md gives the exact conditions,
which the cases check one by one. It runs 0.7.1's own rules (novation.py, records.py, basis.py and client.py as
released: valun-open tag v0.7.1, 53b0b2e), on client records built the way 0.7.1 builds them (evaluate, then
apply_findings and apply_write_ahead, as Client._decide does, with its one read-back of the edges when an attempt's edge
must be read: needs_read_back). Signatures are not checked (verify is a stub): the D-1 rule under test reads edge
states, not keys. Nothing is sent anywhere.

Run it with the released client:
  uv run --no-project --with valun==0.7.1 python -I scripts/client-071-attempts.py
or with a checkout of valun-open at v0.7.1:
  VALUN_SRC=../valun-open/python/src python scripts/client-071-attempts.py
CI runs it on the released wheel, pinned by hash (scripts/client-071-requirements.txt; .github/workflows/ci.yml).
It prints one line per case and exits 1 if any case does not come out as the texts say.
"""
import copy
import os
import sys

if os.environ.get('VALUN_SRC'):
    sys.path.insert(0, os.environ['VALUN_SRC'])
from valun import novation as nv          # noqa: E402  (0.7.1, as released)
from valun import records                 # noqa: E402
from valun import __version__             # noqa: E402

assert __version__ == '0.7.1'
B, C, D = '02' + 'b' * 64, '02' + 'c' * 64, '02' + 'd' * 64      # payer (the agent), payee, a third agent
A, E = '02' + 'a' * 64, '02' + 'e' * 64                          # issuers of IOUs the agent holds
NFT, DENOM = 'ab' * 32, 'erg'
PINS = {'tracker_nft_id': NFT, 'denomination': DENOM}
verify = lambda pk, msg, sig: True       # noqa: E731
BC, BD = nv.edge_key(B, C), nv.edge_key(B, D)
AB, AC, EB, EC = nv.edge_key(A, B), nv.edge_key(A, C), nv.edge_key(E, B), nv.edge_key(E, C)
MIN, HOUR, DAY = 60_000, 3_600_000, 86_400_000
T0 = 1_795_000_000_000                   # a time, ms
P0 = 3_000_000                           # what the agent owes the payee before (an earlier deal's IOU, confirmed)
PRICE = 2_000_000
WINDOW = nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS     # 0.7.1's window for an attempt: its timestamp + 1 h + 2 min


def bound_ts(now):
    """The template's timestamp: the largest one ending in 997 ms, at least 1.5 s before `now` (core.mjs residueTimestamp)."""
    t = (now - 1500) // 1000 * 1000 + 997
    return t if t <= now - 1500 else t - 1000


def transfer_ts(now):
    """A transfer template's timestamp: ending in 999 ms, a few seconds before `now`."""
    return (now - 3000) // 1000 * 1000 + 999


def world():
    """The tracker and the agent's 0.7.1 records: it owes the payee P0 (an earlier deal's IOU), and holds an IOU of A's
    (5,000,000) and one of E's (4,000,000), all confirmed in its records."""
    tracker = {BC: {'total': P0, 'timestamp': T0 - 2 * HOUR + 997, 'signature': 'sig-earlier'},
               AB: {'total': 5_000_000, 'timestamp': T0 - 2 * HOUR + 123, 'signature': 'sig-ab'},
               AC: {'total': 1_000_000, 'timestamp': T0 - 3 * HOUR + 456, 'signature': 'sig-ac'},
               EB: {'total': 4_000_000, 'timestamp': T0 - 3 * HOUR + 789, 'signature': 'sig-eb'}}
    state = {'pins': dict(PINS), 'records': {}, 'signed': {}, 'transfer_attempts': {}, 'novated_edges': {}}
    for edge in (BC, AB, EB):
        records.confirm(state['records'], edge, tracker[edge])     # the client confirmed these
    return tracker, state


def deal(deal_id, price=PRICE):
    terms = {'deal_id': deal_id, 'network': 'valun-testnet-1', 'tracker_nft_id': NFT, 'denomination': DENOM,
             'price': {'amount': price}, 'payer': {'id': 'vp_payer', 'pubkey': B}, 'payee': {'id': 'vp_payee', 'pubkey': C}}
    return nv.deal_context(terms, 'h' * 64, 'd' * 64, delivered=True)


def ctx(state, now, d=None, edges=None):
    return {'me_pk': B, 'me_id': 'vp_payer', 'now_ms': now, 'verify': verify, 'pins': PINS, 'deal': d,
            'payee_current_pk': C, 'records': state['records'], 'signed': state['signed'],
            'transfer_attempts': state['transfer_attempts'], 'novated_edges': state['novated_edges'],
            'features': ['bound_notes/1', 'circulation/1'], 'novation': dict(nv.CONTRACT), 'edges': edges,
            'consent_policy': {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 50_000_000,
                               'accept_issuers': 'any'},
            'mandate': {'auto_clear': True, 'novate_own_debt': True, 'accept_transfers': True, 'may_accept_credit': True,
                        'accept_notes_from': 'any', 'refuse_notes_from': [], 'pay_with_held_notes': 'when_asked',
                        'max_accept_per_issuer': 40_000_000}}


def decide(state, r, signed_at='2026-11-18T00:00:00Z'):
    """What Client._decide records for an evaluation: its findings, and (when it allows signing) its write-ahead."""
    nv.apply_findings(state, r['summary'], B)
    if r['ok'] and r['to_sign']:
        nv.apply_write_ahead(state, r['write_ahead'], signed_at)


def evaluated(tracker, state, evaluate):
    """Client._decide: evaluate(ctx edges) with no read-back first; when that is transfer_window_open because an
    earlier attempt's edge must be read (needs_read_back), once more after a read-back of the edges (GET /edges), an edge
    it does not list being absent. Records what the evaluation it returns found."""
    r = evaluate(None)
    need = r['summary'].get('needs_read_back') if not r['ok'] and r['code'] == 'transfer_window_open' else None
    if need:
        edges = copy.deepcopy(tracker)
        for e in need:
            edges.setdefault(e, None)
        r = evaluate(edges)
    decide(state, r)
    return r


def sign_iou(tracker, state, deal_id, now, price=PRICE):
    """The agent accepts the delivery of deal_id with its own IOU: 0.7.1 evaluates the server's bound template (the pair
    as the tracker holds it now) and, when allowed, records the IOU it signs. Returns (evaluation, the note or None)."""
    cur = tracker.get(BC)
    P = cur['total'] if cur else 0
    ts = bound_ts(now)
    tpl = {'deal_id': deal_id, 'terms_hash': 'h' * 64, 'deliverable_sha256': 'd' * 64, 'issuer_pubkey': B,
           'recipient_pubkey': C, 'prior_total': P, 'price': price, 'total': P + price, 'timestamp': ts,
           'tracker_nft_id': NFT, 'denomination': DENOM, 'prior_note': dict(cur) if cur else None,
           'prior_timestamp': cur['timestamp'] if cur else 0}
    r = evaluated(tracker, state, lambda edges: nv.evaluate_bound_template(tpl, ctx(state, now, deal(deal_id, price), edges)))
    return r, ({'total': P + price, 'timestamp': ts, 'signature': f'sig-{deal_id}-{ts}'} if r['ok'] else None)


def pay_by_transfer(tracker, state, deal_id, now, issuer=A, price=PRICE, payee=C):
    """The agent accepts the delivery of deal_id and pays it with an IOU it holds, `issuer`'s: 0.7.1 evaluates the
    server's transfer template (both edges as the tracker holds them now: the held one, issuer -> agent, falls by the
    price; issuer -> payee rises by it) and, when allowed, records the payment it signs (Client._transfer_signed).
    `payee`: the payee's current key (after a key change, the deal's terms still name the one they were agreed with).
    Returns (evaluation, its timestamp)."""
    held, dest = nv.edge_key(issuer, B), nv.edge_key(issuer, payee)
    T = transfer_ts(now)
    fb, tb = tracker[held], tracker.get(dest)
    tpl = {'issuer': {'id': 'vp_issuer', 'pubkey': issuer}, 'payer': {'id': 'vp_payer', 'pubkey': B},
           'payee': {'id': 'vp_payee', 'pubkey': payee},
           'from_edge': {'before': dict(fb), 'new_total': fb['total'] - price, 'prior_timestamp': fb['timestamp']},
           'to_edge': {'before': dict(tb) if tb else None, 'new_total': (tb['total'] if tb else 0) + price,
                       'prior_timestamp': tb['timestamp'] if tb else 0},
           'deal_id': deal_id, 'terms_hash': 'h' * 64, 'deliverable_sha256': 'd' * 64, 'amount': price, 'timestamp': T,
           'tracker_nft_id': NFT, 'denomination': DENOM, 'quote_digest': None}

    def evaluate(edges):
        c = ctx(state, now, deal(deal_id, price), edges)
        c['payee_current_pk'] = payee
        return nv.evaluate_payer_template(tpl, c)
    r = evaluated(tracker, state, evaluate)
    return r, T


def applied_transfer(tracker, state, T, issuer, price=PRICE):
    """The payment by transfer the agent just signed applied at the tracker, and its client read that back."""
    held, dest = nv.edge_key(issuer, B), nv.edge_key(issuer, C)
    tracker[held] = {'total': tracker[held]['total'] - price, 'timestamp': T, 'signature': 'sig-pay-held'}
    tracker[dest] = {'total': (tracker[dest]['total'] if dest in tracker else 0) + price, 'timestamp': T, 'signature': 'sig-pay-dest'}
    records.confirm(state['records'], held, tracker[held])


def debt_moved(tracker, state, now, edge_from, edge_to, amount, issuer_consent=True, apply=True):
    """A payment by transfer of the agent's debt: edge_from (one of the agent's IOUs) falls by `amount` and edge_to
    rises by it. With issuer_consent, the agent's 0.7.1 client signs its issuer consent first (evaluate_consent, role
    issuer), as it does by itself in every approval mode; then, with apply, the tracker applies the transfer (without
    it, the transfer never applies: it expires, or another party refuses it)."""
    T = transfer_ts(now)
    before_f, before_t = tracker.get(edge_from), tracker.get(edge_to)
    if issuer_consent:
        item = {'kind': 'transfer', 'id': 'vt_' + '1' * 16, 'your_roles': ['issuer'], 'state': 'collecting',
                'tracker_nft_id': NFT, 'denomination': DENOM,
                'context': {'amount': amount, 'payer': {'id': 'vp_payee'}, 'payee': {'id': 'vp_third'}},
                'edges': [{'edge': edge_from, 'before': dict(before_f), 'new_total': before_f['total'] - amount,
                           'timestamp': T, 'revision': 1, 'change': -amount, 'slots': ['new'], 'your_role': 'issuer',
                           'issuer': {'id': 'vp_payer'}, 'recipient': {'id': 'vp_payee'}},
                          {'edge': edge_to, 'before': dict(before_t) if before_t else None,
                           'new_total': (before_t['total'] if before_t else 0) + amount, 'timestamp': T, 'revision': 1,
                           'change': amount, 'slots': ['new'], 'your_role': 'issuer', 'issuer': {'id': 'vp_payer'},
                           'recipient': {'id': 'vp_third'}}]}
        r = nv.evaluate_consent(item, ctx(state, now))
        if not r['ok']:
            return r
        decide(state, r)
    if apply:
        tracker[edge_from] = {'total': before_f['total'] - amount, 'timestamp': T, 'signature': 'sig-transfer-from'}
        tracker[edge_to] = {'total': (before_t['total'] if before_t else 0) + amount, 'timestamp': T, 'signature': 'sig-transfer-to'}
    return None


def honor(tracker, state, now, amount, recorded=True):
    """The agent honors a guarantee call from the payee with its own IOU to it, as Client.honor_guarantee records it
    (op guarantee_note:<call>, a pending entry, no payment attempt), and the server records it at once (settled), or,
    without `recorded`, never does."""
    cur = tracker[BC]
    ts = bound_ts(now)
    wa = {'op': 'guarantee_note:vgc_' + '2' * 16,
          'signed': [{'edge': BC, 'timestamp': ts, 'op': 'guarantee_note:vgc_' + '2' * 16,
                      'slots': {nv.slot_key(BC, 'prior'): cur['total'], nv.slot_key(BC, 'new'): cur['total'] + amount},
                      'prior_state': {'total': cur['total'], 'timestamp': cur['timestamp']}}],
          'pending': [{'pair': BC, 'total': cur['total'] + amount, 'timestamp': ts, 'kind': 'guarantee_note',
                       'ref': 'vgc_' + '2' * 16, 'direction': 'out'}], 'attempt': None}
    nv.apply_write_ahead(state, wa, '2026-11-18T00:00:00Z')
    if recorded:
        tracker[BC] = {'total': cur['total'] + amount, 'timestamp': ts, 'signature': 'sig-honor'}
        records.confirm(state['records'], BC, tracker[BC])            # settle(): _confirm_in on 'honored'


def read_edges(tracker, state, *edges):
    """The client reads its edges back (valun_status does: Client.sync_edges confirms each state in its records)."""
    for edge in edges:
        records.confirm(state['records'], edge, tracker[edge])


def valun_status(tracker, state, edge, journal=()):
    """All that valun_status (Client.sync_edges, client.py 2808-2913) records of `edge`, as `valun attempts list` and
    `valun attempts resolve` also do before anything else (cli.py _edges_now): the edge's journal entries since the
    client last read it (`journal`, oldest first), then its current row. records.sync_edge takes each state (never moving
    the confirmed one back in time), a pending payment of its own that a state promotes marks its deal paid, and so does
    a payment attempt whose own state the journal or the row shows (mark_paid)."""
    seen = set()
    for st in [*journal, tracker[edge]]:
        seen.add((st['total'], st['timestamp']))
        p = records.sync_edge(state['records'], dict(st, edge=edge))['promoted']
        if p is not None and p.get('kind') == 'note' and p.get('direction') == 'out' and str(p.get('ref', '')).startswith('vd_'):
            nv.mark_paid(state, p['ref'], 'note', edge, p['total'], p['timestamp'])
    for deal_id, lst in state['transfer_attempts'].items():
        for a in lst:
            if a['edge'] == edge and (a['total'], a['timestamp']) in seen:
                nv.mark_paid(state, deal_id, a['route'], a['edge'], a['total'], a['timestamp'])


def resolve_not_applied(state, deal_id):
    """`valun attempts resolve DEAL '#1' --not-applied`: the owner's decision, recorded in the client's records
    (Client.resolve_attempt: outcome not_applied, resolved_at). For a credit note the server holds no attempt; for a
    payment by transfer the server ended (void_rejected, expired) it has nothing to resolve either, and the owner
    confirms recording it in the client's records only (cli.py: the second question, local_only)."""
    for a in state['transfer_attempts'][deal_id]:
        a['outcome'], a['resolved_at'] = 'not_applied', '2026-11-18T00:00:00Z'


def listed(tracker, state, deal_id, now):
    """What `valun attempts list` says of the deal's attempts (classify_attempts on a read-back of the edges). For an
    attempt it judges 'unknown', a payment by transfer whose server id its records hold and that the server shows ended
    before it ever reached the tracker (void_rejected, expired: client.py NEVER_APPLIED_TRANSFER) is shown with the
    server's word instead ("ended by the server ..."); it is the same 'unknown' to the evaluators (R11)."""
    r = nv.classify_attempts(deal_id, ctx(state, now, edges=copy.deepcopy(tracker)), PRICE)
    words = {'applied': 'applied', 'unknown': 'MAY HAVE APPLIED', 'alive': 'can still apply',
             'dead': 'did not apply (and can no longer)', 'unread': 'not known yet'}
    return [words[x['outcome']] for x in r['attempts']]


def outcome(r):
    return 'signed' if r['ok'] else f"refused {r['code']}" + (f" retry_after_ms={r['summary']['retry_after_ms']}"
                                                            if r['code'] == 'transfer_window_open' else '')


results, failures = [], 0


def check(name, got, want, extra=''):
    global failures
    ok = got == want if not callable(want) else want(got)
    failures += 0 if ok else 1
    results.append(f"{'PASS' if ok else 'FAIL'}  {name}: {got}{'  ' + extra if extra else ''}")


def section(title):
    results.append(f'-- {title}')


def wait_until(ts, now):
    """transfer_window_open with retry_after_ms = ts + 1 h + 2 min + 1 ms - now (0.7.1's window for an attempt at ts)."""
    return f'refused transfer_window_open retry_after_ms={ts + WINDOW + 1 - now}'


def after_window(ts, now=0):
    """A time once an attempt at ts has passed its window (ts + 1 h + 2 min), at least `now`, with a bound IOU's
    timestamp (1.5 s before it) past the window too."""
    return max(now, ts + WINDOW + 1500 + 1)


def way_out(tracker, state, deal_id, ts, now, pay):
    """What the owner's texts say to do on attempt_outcome_unknown: resolve the attempt as not applied (in a copy of the
    records), then have the agent pay again once its timestamp + 1 h + 2 min has passed. `pay(tracker, state, at)` pays;
    returns its outcome, which must be 'signed' in every case."""
    s = copy.deepcopy(state)
    resolve_not_applied(s, deal_id)
    return outcome(pay(copy.deepcopy(tracker), s, after_window(ts, now)))


def new_iou(deal_id):
    return lambda tracker, state, at: sign_iou(tracker, state, deal_id, at)[0]


def by_transfer(deal_id, issuer=A, payee=C):
    return lambda tracker, state, at: pay_by_transfer(tracker, state, deal_id, at, issuer=issuer, payee=payee)[0]


DEAL_A, DEAL_B, DEAL_C, DEAL_P, DEAL_Q = 'vd_' + 'a' * 16, 'vd_' + 'b' * 16, 'vd_' + 'c' * 16, 'vd_' + 'e' * 16, 'vd_' + 'f' * 16


def rejected_iou():
    """A world after the owner rejected the agent's bound IOU A1 for deal vd_A (signed at T0): 0.7.1 recorded it as a
    payment attempt; the tracker never saw it."""
    tracker, state = world()
    r, a1 = sign_iou(tracker, state, DEAL_A, T0)
    assert r['ok'], r
    return tracker, state, a1


def later_iou_applied(tracker, state, now):
    """The agent's later bound IOU to the same payee, for deal vd_B, signed at `now` and approved: the tracker records
    it (the agent's client learns of it when it next reads its edges: read_edges)."""
    r, b = sign_iou(tracker, state, DEAL_B, now)
    assert r['ok'], r
    tracker[BC] = b
    return b


section('a rejected or expired bound IOU (the IOU card)')
# 1. Nothing changed the pair: paying again works at once, within the hour and after it.
tracker, state, a1 = rejected_iou()
check('unchanged pair, 10 min later', listed(tracker, state, DEAL_A, T0 + 10 * MIN), ['can still apply'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 10 * MIN)
check('unchanged pair, pay again 10 min later', outcome(r), 'signed')
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 2 * HOUR)
check('unchanged pair, pay again 2 h later', outcome(r), 'signed')
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 8 * DAY)
check('unchanged pair, pay again 8 days later', outcome(r), 'signed')
# 1b. ... also when its client signed something else on the pair that never applied (PILOT-API.md: it signs at once while
#     the pair is exactly in the state the rejected IOU acknowledged).
for label, other in (('an honor signed, never recorded', lambda t, s: honor(t, s, T0 + 5 * MIN, 500_000, recorded=False)),
                     ('an issuer consent to a pass-on that never applied', lambda t, s: debt_moved(t, s, T0 + 5 * MIN, BC, BD, 1_000_000, apply=False))):
    tracker, state, a1 = rejected_iou()
    other(tracker, state)
    r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
    check(f'unchanged pair after {label}: pay again', outcome(r), 'signed')

# 2. A later IOU of the agent's to the same payee, for another deal, applied first: proven dead.
tracker, state, a1 = rejected_iou()
later_iou_applied(tracker, state, T0 + 10 * MIN)
check('later IOU (other deal) first: attempts list', listed(tracker, state, DEAL_A, T0 + 11 * MIN), ['did not apply (and can no longer)'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check('later IOU (other deal) first: pay again', outcome(r), 'signed')
# ... for 7 days (RECORDS_KEEP_MS): past them, the proof needs records 0.7.1 no longer keeps.
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 6 * DAY)
check('later IOU (other deal) first: pay again 6 days later', outcome(r), 'signed')
check('later IOU (other deal) first: attempts list 8 days later', listed(tracker, state, DEAL_A, T0 + 8 * DAY), ['MAY HAVE APPLIED'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 8 * DAY)
check('later IOU (other deal) first: pay again 8 days later', outcome(r), 'refused attempt_outcome_unknown',
      f'(RECORDS_KEEP_MS {nv.RECORDS_KEEP_MS}: 7 days)')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 8 * DAY, new_iou(DEAL_A)), 'signed')

# 2b. ... and only if the agent's client signed nothing else on the pair in between, not even something that never
#     applied: here, its issuer consent to the payee passing the agent's IOU on, a transfer that then never applied.
tracker, state, a1 = rejected_iou()
c = debt_moved(tracker, state, T0 + 5 * MIN, BC, BD, 1_000_000, apply=False)
check('consent to a pass-on that never applied, then a later IOU: consent signed', 'signed' if c is None else outcome(c), 'signed')
later_iou_applied(tracker, state, T0 + 10 * MIN)
check('consent to a pass-on that never applied, then a later IOU: the pair moved only by it', tracker[BC]['total'], P0 + PRICE)
check('consent to a pass-on that never applied, then a later IOU: attempts list', listed(tracker, state, DEAL_A, T0 + 11 * MIN), ['MAY HAVE APPLIED'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check('consent to a pass-on that never applied, then a later IOU: pay again', outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 11 * MIN, new_iou(DEAL_A)), 'signed')
# 2c. The same with a guarantee honor signed and never recorded.
tracker, state, a1 = rejected_iou()
honor(tracker, state, T0 + 5 * MIN, 500_000, recorded=False)
later_iou_applied(tracker, state, T0 + 10 * MIN)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check('an honor signed but never recorded, then a later IOU: pay again', outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 11 * MIN, new_iou(DEAL_A)), 'signed')
# 2e. Credit notes in between (the review of PR #9, v2): a third IOU of the agent's (deal C), signed between the
#     rejected one and the later one and never applied, does not stop the proof: signed_between counts only operations
#     other than credit notes (PILOT-API.md).
tracker, state, a1 = rejected_iou()
r, _c = sign_iou(tracker, state, DEAL_C, T0 + 5 * MIN)
check('a third IOU (another deal) signed in between, then rejected too: it was signed', outcome(r), 'signed')
b = later_iou_applied(tracker, state, T0 + 10 * MIN)
valun_status(tracker, state, BC)
check('a third IOU signed in between, never applied, then a later IOU applied: attempts list', listed(tracker, state, DEAL_A, T0 + 11 * MIN), ['did not apply (and can no longer)'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check('a third IOU signed in between, never applied, then a later IOU applied: pay again', outcome(r), 'signed')
# 2f. An honor signed before the client read the later IOU (the review of PR #9, v2): the later IOU applied first, then
#     the agent honors a guarantee call from the payee before its client read its edges. honor_guarantee runs no
#     evaluator, and its settle confirms the honor's state (records.confirm), which drops the later IOU's pending entry
#     without recording its deal paid: the proof fails, so 0.7.1 refuses at any age, until it reads its edges.
tracker, state, a1 = rejected_iou()
b = later_iou_applied(tracker, state, T0 + 10 * MIN)
honor(tracker, state, T0 + 20 * MIN, 500_000)
check('a later IOU first, then an honor before a read: the later IOU recorded paid', sorted(state['records'].get('paid_deals') or {}), [])
for label, now in (('25 min', T0 + 25 * MIN), ('3 h', T0 + 3 * HOUR)):
    r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now)
    check(f'a later IOU first, then an honor before a read: pay again {label} after', outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 25 * MIN, new_iou(DEAL_A)), 'signed')
s = copy.deepcopy(state)
resolve_not_applied(s, DEAL_A)
now = T0 + 25 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), s, DEAL_A, now)
check('... resolved --not-applied, pay again before the window has passed', outcome(r), wait_until(a1['timestamp'], now))
# ... or valun_status (sync_edges replays the journal: the later IOU, then the honor; so do `valun attempts list` and
#     `valun attempts resolve`, which read the edges back first: PILOT-API.md), and it signs at once.
s = copy.deepcopy(state)
valun_status(tracker, s, BC, journal=[b])
check('a later IOU first, then an honor before a read, then valun_status: attempts list', listed(tracker, s, DEAL_A, T0 + 25 * MIN), ['did not apply (and can no longer)'])
r, _ = sign_iou(copy.deepcopy(tracker), s, DEAL_A, T0 + 25 * MIN)
check('a later IOU first, then an honor before a read, then valun_status: pay again', outcome(r), 'signed')
# ... while an honor after the client read the later IOU changes nothing.
tracker, state, a1 = rejected_iou()
later_iou_applied(tracker, state, T0 + 10 * MIN)
valun_status(tracker, state, BC)
honor(tracker, state, T0 + 20 * MIN, 500_000)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 25 * MIN)
check('a later IOU first, read, then an honor: pay again', outcome(r), 'signed')
# 2d. Once a later IOU proved it dead, a change after that one changes nothing: here the payee then passed the agent's
#     IOU on (read by the client, or not). The texts say attempt_outcome_unknown comes once something other than a
#     later IOU of the agent's was the FIRST change after the rejected IOU's timestamp (the review of PR #9, item 3).
for read in (True, False):
    tracker, state, a1 = rejected_iou()
    later_iou_applied(tracker, state, T0 + 10 * MIN)
    if read:
        read_edges(tracker, state, BC)
    c = debt_moved(tracker, state, T0 + 20 * MIN, BC, BD, 1_000_000)
    check(f"a later IOU first{', read' if read else ''}, then the payee passed the agent's IOU on: issuer consent", 'signed' if c is None else outcome(c), 'signed')
    r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 25 * MIN)
    check(f"a later IOU first{', read' if read else ''}, then the payee passed the agent's IOU on: pay again", outcome(r), 'signed')

# 3. The payee passes the agent's IOU on to a third agent (a payment by transfer whose from-edge is the pair); the
#    agent's client signs its issuer consent by itself.
tracker, state, a1 = rejected_iou()
c = debt_moved(tracker, state, T0 + 10 * MIN, BC, BD, 1_000_000)
check("payee passed the agent's IOU on: issuer consent", 'signed' if c is None else outcome(c), 'signed')
check("payee passed the agent's IOU on: attempts list", listed(tracker, state, DEAL_A, T0 + 11 * MIN), ['MAY HAVE APPLIED'])
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check("payee passed the agent's IOU on: pay again", outcome(r), 'refused attempt_outcome_unknown')
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 3 * HOUR)
check("payee passed the agent's IOU on: pay again 3 h later (window long past)", outcome(r), 'refused attempt_outcome_unknown')
# ... then the owner resolves it as not applied.
resolve_not_applied(state, DEAL_A)
now = T0 + 20 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now)
check('after resolve --not-applied, 20 min later', outcome(r), wait_until(a1['timestamp'], now),
      f"(= the rejected IOU's timestamp + 1 h + 2 min + 1 ms - now; MAX_AGE_MS {nv.MAX_AGE_MS}, FALLBACK_MARGIN_MS {nv.FALLBACK_MARGIN_MS})")
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + WINDOW + 1500 + 1)
check('after resolve --not-applied, once its timestamp + 1 h + 2 min has passed', outcome(r), 'signed')

# 3b. The corner case after a resolve: the pair moved by something else, then came back to exactly the total the
#     rejected IOU acknowledged (the payee passed 1,000,000 of the agent's IOU on, then a third agent paid the payee
#     1,000,000 of the agent's IOU): 0.7.1 refuses again with attempt_outcome_unknown until the window has passed.
tracker, state, a1 = rejected_iou()
tracker[BD] = {'total': 1_500_000, 'timestamp': T0 - HOUR + 997, 'signature': 'sig-bd'}
read_edges(tracker, state, BD)
debt_moved(tracker, state, T0 + 5 * MIN, BC, BD, 1_000_000)
debt_moved(tracker, state, T0 + 10 * MIN, BD, BC, 1_000_000)
check('pair back at the total the rejected IOU acknowledged', (tracker[BC]['total'], tracker[BC]['timestamp'] > a1['timestamp']), (P0, True))
resolve_not_applied(state, DEAL_A)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 20 * MIN)
check('pair back at that total, after resolve --not-applied: pay again 20 min later', outcome(r), 'refused attempt_outcome_unknown')
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + WINDOW + 1500 + 1)
check('pair back at that total, after resolve --not-applied: once its window has passed', outcome(r), 'signed')

# 4. Another agent pays the payee with the agent's IOU (a payment by transfer whose to-edge is the pair).
tracker, state, a1 = rejected_iou()
tracker[BD] = {'total': 1_500_000, 'timestamp': T0 - HOUR + 997, 'signature': 'sig-bd'}
read_edges(tracker, state, BD)
c = debt_moved(tracker, state, T0 + 10 * MIN, BD, BC, 1_000_000)
check("a third agent paid the payee with the agent's IOU: issuer consent", 'signed' if c is None else outcome(c), 'signed')
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check("a third agent paid the payee with the agent's IOU: pay again", outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 11 * MIN, new_iou(DEAL_A)), 'signed')

# 5. The agent honors a guarantee call from the payee (its own IOU to it, not a deal's payment).
tracker, state, a1 = rejected_iou()
honor(tracker, state, T0 + 10 * MIN, 500_000)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 11 * MIN)
check('agent honored a guarantee call from the payee: pay again', outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 11 * MIN, new_iou(DEAL_A)), 'signed')

# 6. An IOU of the agent's to the same payee signed BEFORE the rejected one (both waited for the owner), recorded after
#    it: 0.7.1 waits for the rejected IOU's window instead.
tracker, state = world()
r0, b0 = sign_iou(tracker, state, DEAL_B, T0 - 5 * MIN)           # deal B's IOU, held
r1, a1 = sign_iou(tracker, state, DEAL_A, T0)                     # deal A's IOU, held too (same prior)
assert r0['ok'] and r1['ok']
tracker[BC] = b0                                                  # the owner approved deal B's; rejected deal A's
now = T0 + 10 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now)
check('an IOU signed before the rejected one, recorded after it: pay again', outcome(r), wait_until(a1['timestamp'], now))
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + WINDOW + 1500 + 1)
check('... once its window has passed', outcome(r), 'signed')

# 6b. A key change of either party, the old pair unchanged: the new IOU is on another pair (one_live_attempt's same()
#     needs the same edge), so 0.7.1 does not sign it at once: it waits for the rejected IOU's window. The texts say it
#     signs at once only while neither agent's key has changed (the review of PR #9, item 3).


def sign_iou_keys(tracker, state, deal_id, now, payer, payee, price=PRICE):
    """sign_iou after a key change: the agent's key is now `payer` and the payee's `payee` (the deal's terms still name
    the keys they were agreed with); the server's bound template is for that pair."""
    edge = nv.edge_key(payer, payee)
    cur = tracker.get(edge)
    P = cur['total'] if cur else 0
    tpl = {'deal_id': deal_id, 'terms_hash': 'h' * 64, 'deliverable_sha256': 'd' * 64, 'issuer_pubkey': payer,
           'recipient_pubkey': payee, 'prior_total': P, 'price': price, 'total': P + price, 'timestamp': bound_ts(now),
           'tracker_nft_id': NFT, 'denomination': DENOM, 'prior_note': dict(cur) if cur else None,
           'prior_timestamp': cur['timestamp'] if cur else 0}

    def evaluate(edges):
        c = ctx(state, now, deal(deal_id, price), edges)
        c['me_pk'], c['payee_current_pk'] = payer, payee
        return nv.evaluate_bound_template(tpl, c)
    return evaluated(tracker, state, evaluate)


B2, C2 = '03' + 'b' * 64, '03' + 'c' * 64             # the agent's new key; the payee's new key
for who, payer, payee in (("the payee's", B, C2), ("the agent's", B2, C)):
    tracker, state, a1 = rejected_iou()
    now = T0 + 10 * MIN
    r = sign_iou_keys(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, payer, payee)
    check(f"{who} key changed, the old pair unchanged: pay again 10 min later", outcome(r), wait_until(a1['timestamp'], now))
    r = sign_iou_keys(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + WINDOW + 1500 + 1, payer, payee)
    check(f"{who} key changed, the old pair unchanged: once its window has passed", outcome(r), 'signed')
# 6c. After a key change, a later IOU on the new pair proves nothing (the review of PR #9, v2: proven_dead needs the
#     same edge, as Valun's journal rule does, test/held-note-expiry.unit.test.mjs): the payee's key changed, the agent's
#     IOU for deal B went to its new key and applied, and the client read it; paying deal A by transfer (with E's IOU, to
#     the payee's new key) or with its own IOU still waits for the rejected IOU's window.
tracker, state, a1 = rejected_iou()
BC2 = nv.edge_key(B, C2)
r = sign_iou_keys(tracker, state, DEAL_B, T0 + 10 * MIN, B, C2)
check("the payee's key changed: deal B's IOU to its new key (a new pair)", outcome(r), 'signed')
tracker[BC2] = {'total': PRICE, 'timestamp': bound_ts(T0 + 10 * MIN), 'signature': 'sig-b-new-pair'}
valun_status(tracker, state, BC2)
check("... read by the client (valun_status): deal B recorded paid", sorted(state['records'].get('paid_deals') or {}), [DEAL_B])
now = T0 + 11 * MIN
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, issuer=E, payee=C2)
check("the payee's key changed, a later IOU on the new pair applied and read: pay deal A by transfer", outcome(r), wait_until(a1['timestamp'], now))
r = sign_iou_keys(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, B, C2)
check("... pay deal A with its own IOU", outcome(r), wait_until(a1['timestamp'], now))
check('... attempts list for deal A', listed(tracker, state, DEAL_A, now), ['can still apply'])
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, after_window(a1['timestamp']) + 1500, issuer=E, payee=C2)
check('... pay deal A by transfer once its window has passed (after a read-back)', outcome(r), 'signed')

# 7. A held IOU that expired (void_expired at its timestamp + 59 min): the same attempt to 0.7.1.
tracker, state, a1 = rejected_iou()
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + 59 * MIN + 1000)
check('expired held IOU, unchanged pair: pay again at once', outcome(r), 'signed')

# 8. Paying that deal by transfer instead (with E's IOU, which the agent holds). The server allows it once the rejected
#    IOU's timestamp + 1 h + 60 s has passed (fallback_after); 0.7.1 waits a minute more. Once a later IOU of the
#    agent's to the payee, signed after the rejected one, has applied, the server does not wait (its journal proves the
#    rejected IOU dead), and 0.7.1 does not either once its records hold that later IOU (valun_status reads the edges).
tracker, state, a1 = rejected_iou()
now = a1['timestamp'] + HOUR + 61_500
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, issuer=E)
check("pay that deal by transfer, the pair unchanged, at the IOU's timestamp + 1 h + 61.5 s (the server allows it)", outcome(r), wait_until(a1['timestamp'], now))
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, a1['timestamp'] + WINDOW + 3001, issuer=E)
check('... once its timestamp + 1 h + 2 min has passed (after a read-back)', outcome(r), 'signed')
tracker, state, a1 = rejected_iou()
later_iou_applied(tracker, state, T0 + 10 * MIN)
now = T0 + 11 * MIN
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, issuer=E)
check('later IOU applied, not yet read by the client: pay that deal by transfer', outcome(r), wait_until(a1['timestamp'], now))
read_edges(tracker, state, BC)
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, issuer=E)
check('later IOU applied, read by the client (valun_status): pay that deal by transfer', outcome(r), 'signed')


section('a held IOU voided on approval (409 stale_note; the owner console after it)')
# 14. What makes a held IOU stale through Valun while it waits: another IOU of the agent's to the same payee, for another
#     deal, approved first (signed before it, or after it while both waited), or a guarantee honor of the agent's to the
#     payee (recorded at once: only a note being issued holds the pair, core.mjs assertPairFree). A payment by transfer
#     through the pair and a set-off on it wait while it is held, and a key revocation voids it first (void_key_revoked).
#     0.7.1 is told of a void no more than of a rejection: it is the same attempt, on a pair that changed since. So the
#     console's words after the 409 drop "usually at once" (public/pilot.js iouTrap, stale): it may refuse, and the way
#     out of each answer ends in 'signed' (the review of PR #9, final round).
# 14a. Signed before it, approved first (two held IOUs approved in the order they were signed): its window.
tracker, state = world()
r0, b0 = sign_iou(tracker, state, DEAL_B, T0 - 5 * MIN)
r1, a1 = sign_iou(tracker, state, DEAL_A, T0)
assert r0['ok'] and r1['ok']
tracker[BC] = b0                                                  # deal B's approved and recorded; deal A's then void
now = T0 + 10 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now)
check('void after an IOU signed before it was approved: a new IOU', outcome(r), wait_until(a1['timestamp'], now))
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, now, issuer=E)
check('... by transfer', outcome(r), wait_until(a1['timestamp'], now))
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, after_window(a1['timestamp']))
check("... the texts' way out (transfer_window_open): a new IOU once its timestamp + 1 h + 2 min has passed", outcome(r), 'signed')
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, after_window(a1['timestamp']) + 1500, issuer=E)
check('... by transfer then (after a read-back)', outcome(r), 'signed')
# 14b. Signed after it while both waited, approved first: its records prove the void one dead, and it signs at once.
tracker, state, a1 = rejected_iou()
r, b = sign_iou(tracker, state, DEAL_B, T0 + 5 * MIN)
assert r['ok'], r
tracker[BC] = b
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 10 * MIN)
check('void after an IOU signed after it was approved: a new IOU', outcome(r), 'signed')
# 14c. A guarantee honor of the agent's to the payee, recorded while the IOU waited.
tracker, state, a1 = rejected_iou()
honor(tracker, state, T0 + 5 * MIN, 500_000)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_A, T0 + 10 * MIN)
check('void after an honor to the payee was recorded: a new IOU', outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 10 * MIN, new_iou(DEAL_A)), 'signed')
check('... or by transfer', way_out(tracker, state, DEAL_A, a1['timestamp'], T0 + 10 * MIN, by_transfer(DEAL_A, issuer=E)), 'signed')


section('a rejected or expired payment by transfer (the payment card)')


def rejected_payment():
    """A world after the owner rejected (or let expire) the agent's payment by transfer of deal vd_P with A's IOU, signed
    at T: the server purged its signatures; 0.7.1 recorded it as a payment attempt on A's IOU to the agent."""
    tracker, state = world()
    r, T = pay_by_transfer(tracker, state, DEAL_P, T0)
    assert r['ok'], r
    return tracker, state, T


# 9. A's IOU to the agent unchanged: through it again at once; any other way only after T + 1 h + 2 min.
tracker, state, T = rejected_payment()
check("A's IOU unchanged, 5 min later: attempts list", listed(tracker, state, DEAL_P, T0 + 5 * MIN), ['can still apply'])
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T0 + 5 * MIN)
check("A's IOU unchanged: pay through it again 5 min later", outcome(r), 'signed')
now = T0 + 5 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
check("A's IOU unchanged: pay with its own IOU 5 min later", outcome(r), wait_until(T, now))
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now, issuer=E)
check("A's IOU unchanged: pay with E's IOU 5 min later", outcome(r), wait_until(T, now))
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T + WINDOW + 1501)
check("A's IOU unchanged: pay with its own IOU once T + 1 h + 2 min has passed (after a read-back)", outcome(r), 'signed')

# 10. A's IOU to the agent changed after the payment's timestamp (A paid the agent with a new IOU), and the client read
#     it (valun_status): it refuses to pay the deal at all, at any age, until the owner resolves the payment.
tracker, state, T = rejected_payment()
tracker[AB] = {'total': 6_000_000, 'timestamp': T0 + 10 * MIN + 997, 'signature': 'sig-ab2'}
read_edges(tracker, state, AB)
for label, now in (('11 min', T0 + 11 * MIN), ('3 h', T0 + 3 * HOUR)):
    r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
    check(f"A paid the agent a new IOU, read: pay with its own IOU {label} after", outcome(r), 'refused attempt_outcome_unknown')
    r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
    check(f"A paid the agent a new IOU, read: pay through A's IOU again {label} after", outcome(r), 'refused attempt_outcome_unknown')
check('A paid the agent a new IOU: attempts list', listed(tracker, state, DEAL_P, T0 + 3 * HOUR), ['MAY HAVE APPLIED'])
# ... then the owner resolves it as not applied, in the client's records only: any other way after T + 1 h + 2 min.
resolve_not_applied(state, DEAL_P)
now = T0 + 20 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
check('after resolve --not-applied, 20 min after: pay with its own IOU', outcome(r), wait_until(T, now))
r, _ = pay_by_transfer(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
check("after resolve --not-applied, 20 min after: pay through A's IOU (another state of it)", outcome(r), wait_until(T, now))
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T + WINDOW + 1501)
check('after resolve --not-applied, once T + 1 h + 2 min has passed: pay with its own IOU', outcome(r), 'signed')

# 11. A's IOU changed, and the client has not read it yet: it waits for the window, then, once its read-back shows the
#     change, refuses.
tracker, state, T = rejected_payment()
tracker[AB] = {'total': 6_000_000, 'timestamp': T0 + 10 * MIN + 997, 'signature': 'sig-ab2'}
now = T0 + 11 * MIN
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, now)
check("A's IOU changed, not yet read: pay with its own IOU 11 min after", outcome(r), wait_until(T, now))
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T + WINDOW + 1501)
check("A's IOU changed, not yet read: once the window has passed (its read-back shows the change)", outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_P, T, T + WINDOW + 1501, new_iou(DEAL_P)), 'signed')

# 12. The agent paid another deal through A's IOU (it applied): A's IOU changed too.
tracker, state, T = rejected_payment()
r, T2 = pay_by_transfer(tracker, state, DEAL_Q, T0 + 10 * MIN)
assert r['ok'], r
applied_transfer(tracker, state, T2, A)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T0 + 11 * MIN)
check("the agent paid another deal through A's IOU: pay the first deal with its own IOU", outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_P, T, T0 + 11 * MIN, new_iou(DEAL_P)), 'signed')

# 13. Another agent paid the agent with an IOU of A's (A's IOU to the agent rose): the same.
tracker, state, T = rejected_payment()
tracker[nv.edge_key(A, D)] = {'total': 2_000_000, 'timestamp': T0 - HOUR + 321, 'signature': 'sig-ad'}
Tx = transfer_ts(T0 + 10 * MIN)
tracker[nv.edge_key(A, D)] = {'total': 1_000_000, 'timestamp': Tx, 'signature': 'sig-ad2'}
tracker[AB] = {'total': tracker[AB]['total'] + 1_000_000, 'timestamp': Tx, 'signature': 'sig-ab3'}
read_edges(tracker, state, AB)
r, _ = sign_iou(copy.deepcopy(tracker), copy.deepcopy(state), DEAL_P, T0 + 11 * MIN)
check("another agent paid the agent with A's IOU: pay with its own IOU", outcome(r), 'refused attempt_outcome_unknown')
check("... the texts' way out: resolve --not-applied, then pay again", way_out(tracker, state, DEAL_P, T, T0 + 11 * MIN, new_iou(DEAL_P)), 'signed')
check("... or through A's IOU, as it is now", way_out(tracker, state, DEAL_P, T, T0 + 11 * MIN, by_transfer(DEAL_P)), 'signed')

print(f'valun {__version__} novation.py (valun-open v0.7.1), D-1 after a rejected or expired payment that Valun held:')
print('\n'.join(results))
sys.exit(1 if failures else 0)
