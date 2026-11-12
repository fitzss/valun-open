"""novation.py, the client signing firewall (PROTOCOL.md 15.3, design 4.11 and 6.2, decision D-1): a decision table
with at least one case per refusal code and accepted cases for every role; the bytes to sign (equal to
basis.note_message for a new slot and basis.prior_ack_message for a prior slot, tracker v3.2; signed and checked with
basis.verify); the tracker v3.2 contract gate and the same-prior exemption; the quote digest (the worked example of PROTOCOL.md 18.3);
the D-1 payment-attempt rules; and the helpers that record what was signed and found. Offline, real signatures,
throwaway keys derived from public labels."""
import ast
import copy
import hashlib
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), 'src')
sys.path.insert(0, SRC)
from valun import basis as vb  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import novation as nv  # noqa: E402

NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
PINS = {'tracker_nft_id': NFT, 'denomination': DENOM}
NETWORK = 'valun-pilot-1'
DEAL, TID, SID = 'vd_0123456789abcdef', 'vt_0123456789abcdef', 'vs_0123456789abcdef'
TH = hashlib.sha256(b'novation test: terms').hexdigest()
DH = hashlib.sha256(b'novation test: delivery').hexdigest()
PRICE = 3
ACK = 'basis/prior-ack/1'                    # novation.PRIOR_ACK, spelled out: an attempt record's ack
A_ID, B_ID, C_ID, E_ID = 'vp_a0a0a0a0a0a0', 'vp_b0b0b0b0b0b0', 'vp_c0c0c0c0c0c0', 'vp_e0e0e0e0e0e0'


class Key:
    """Throwaway test key: secret = (sha256(label) mod (n - 1)) + 1, as in the spec vectors."""

    def __init__(self, label):
        self.secret = ((int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1).to_bytes(32, 'big')
        self.pk = vb.public_key(self.secret).hex()


# A issues the held note, B pays (and is "me" by default), C is the payee (C2 after a key rotation), E someone else.
A, B, C, C2, E = (Key(f'test/novation/{n}') for n in ('issuer', 'payer', 'payee', 'payee-rotated', 'other'))
AB, AC, BC, BE, EB = (f'{i.pk}>{r.pk}' for i, r in ((A, B), (A, C), (B, C), (B, E), (E, B)))

NOW = 1_793_966_460_123


def res(t, r):
    """The largest timestamp <= t that ends in r ms."""
    return t - ((t - r) % 1000)


T999, T998, T997 = (res(NOW - 1500, r) for r in (999, 998, 997))
T_OLD = T999 - 60_000                         # an earlier attempt, a minute before the current template
TS_AB, TS_AC, TS_BC, TS_BE = NOW - 900_000, NOW - 800_000 + 1, NOW - 700_000 + 2, NOW - 650_000 + 3   # ordinary residues
LATE = T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 10_000      # after T_OLD's window

_SIGS = {}


def sig(signer, issuer, recipient, total, ts):
    k = (signer.pk, issuer.pk, recipient.pk, total, ts)
    if k not in _SIGS:
        msg = vb.note_message(bytes.fromhex(issuer.pk), bytes.fromhex(recipient.pk), total, ts, bytes.fromhex(NFT), DENOM)
        _SIGS[k] = vb.sign(msg, signer.secret, bytes.fromhex(signer.pk)).hex()
    return _SIGS[k]


def st(issuer, recipient, total, ts, signer=None):
    """An EdgeState, signed by the issuer (or, to make a bad one, by `signer`)."""
    return {'total': total, 'timestamp': ts, 'signature': sig(signer or issuer, issuer, recipient, total, ts)}


def verify(pk, msg, sig_hex):
    return vb.verify(bytes.fromhex(sig_hex), msg, bytes.fromhex(pk))


def terms(price=PRICE, payee=None):
    payee = payee or C
    return {'deal_id': DEAL, 'network': NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
            'price': {'amount': price, 'unit': 'PC'}, 'payer': {'id': B_ID, 'pubkey': B.pk},
            'payee': {'id': C_ID, 'pubkey': payee.pk}}


def qd(issuer=None, payee=None, amount=PRICE, deal=DEAL):
    return nv.quote_digest({'network': NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': deal,
                            'terms_hash': TH, 'deliverable_sha256': DH, 'issuer_pubkey': (issuer or A).pk,
                            'payer_pubkey': B.pk, 'payee_pubkey': (payee or C).pk, 'amount': amount})


def edit(obj, fn):
    """A deep copy of obj changed by fn (returns the copy)."""
    o = copy.deepcopy(obj)
    fn(o)
    return o


def attempt(route, edge, prior, total, timestamp, quote=None, **extra):
    return dict({'deal_id': DEAL, 'route': route, 'edge': edge, 'prior': prior, 'total': total, 'timestamp': timestamp,
                 'quote_digest': quote}, **extra)


def pending(total, ts, kind='note', ref=DEAL, direction='out'):
    return {'total': total, 'timestamp': ts, 'kind': kind, 'ref': ref, 'direction': direction, 'signed_at': None}


# ---------- items ----------
def payer_tpl(now=NOW, X=10, Y=4, a=PRICE, issuer=None, payee=None, T=None):
    """GET transfer-template: B pays C `a` PC with A's note; A->B is at X, A->C at Y (None: absent)."""
    issuer, payee = issuer or A, payee or C
    T = res(now - 1500, 999) if T is None else T
    return {'deal_id': DEAL, 'terms_hash': TH, 'deliverable_sha256': DH,
            'issuer': {'id': A_ID, 'handle': 'issuer-a', 'pubkey': issuer.pk},
            'payer': {'id': B_ID, 'handle': 'payer-b', 'pubkey': B.pk},
            'payee': {'id': C_ID, 'handle': 'payee-c', 'pubkey': payee.pk},
            'amount': a, 'timestamp': T,
            'from_edge': {'before': st(issuer, B, X, TS_AB), 'new_total': X - a},
            'to_edge': {'before': st(issuer, payee, Y, TS_AC) if Y is not None else None, 'new_total': (Y or 0) + a},
            'tracker_nft_id': NFT, 'denomination': DENOM, 'quote_digest': qd(issuer, payee, a),
            'collect_until': '2026-11-08T12:20:00.000Z',
            'messages': {'A>B:prior': '00' * 80, 'A>B:new': '00' * 80, 'A>C:new': '00' * 80}}   # never signed (R1)


def bound_tpl(now=NOW, P=6, price=PRICE, prior=True, ts=None):
    """GET credit-note-template?prior=1&bound=1: B's bound note to C on top of P (prior False: a new edge)."""
    ts = res(now - 1500, 997) if ts is None else ts
    P = P if prior else 0
    return {'deal_id': DEAL, 'terms_hash': TH, 'deliverable_sha256': DH, 'issuer_pubkey': B.pk,
            'recipient_pubkey': C.pk, 'keys_as_agreed': True, 'prior_total': P, 'price': price, 'total': P + price,
            'timestamp': ts, 'tracker_nft_id': NFT, 'denomination': DENOM, 'message_hex': 'ff' * 80,
            'prior_note': st(B, C, P, TS_BC) if prior else None, 'prior_message_hex': 'ee' * 80}


def row(issuer, recipient, before_total, before_ts, new_total, ts, your_role, slots, ids, signed_by_you=None):
    before = None if before_total is None else st(issuer, recipient, before_total, before_ts)
    return {'edge': f'{issuer.pk}>{recipient.pk}', 'issuer': {'id': ids[0], 'handle': 'h-' + ids[0][-2:]},
            'recipient': {'id': ids[1], 'handle': 'h-' + ids[1][-2:]}, 'your_role': your_role, 'before': before,
            'change': new_total - (before_total or 0), 'new_total': new_total, 'timestamp': ts, 'revision': 1,
            'slots': list(slots), 'signed_by_you': list(signed_by_you or [])}


def item(kind, iid, role, edges, context):
    return {'kind': kind, 'id': iid, 'state': 'collecting', 'your_roles': [role],
            'created_at': '2026-11-08T12:00:00.000Z', 'expires_at': '2026-11-08T12:20:00.000Z', 'network': NETWORK,
            'tracker_nft_id': NFT, 'denomination': DENOM, 'edges': edges, 'context': context,
            'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': 0}}


def parties():
    return {'issuer': {'id': A_ID, 'handle': 'issuer-a'}, 'payer': {'id': B_ID, 'handle': 'payer-b'},
            'payee': {'id': C_ID, 'handle': 'payee-c'}}


def issuer_item(T=T999, X=10, Y=4, a=PRICE):
    return item('transfer', TID, 'issuer',
                [row(A, B, X, TS_AB, X - a, T, 'issuer', ['new'], (A_ID, B_ID)),
                 row(A, C, Y, TS_AC, (Y or 0) + a, T, 'issuer', ['new'], (A_ID, C_ID))],
                dict(parties(), amount=a))


def payee_item(T=T999, Y=4, a=PRICE):
    return item('transfer', TID, 'payee', [row(A, C, Y, TS_AC, (Y or 0) + a, T, 'creditor', ['prior', 'new'], (A_ID, C_ID))],
                dict(parties(), amount=a, deal={'deal_id': DEAL, 'terms_hash': TH, 'price': a, 'quote_digest': qd()}))


def payer_item(T=T999, X=10, Y=4, a=PRICE):
    return item('transfer', TID, 'payer',
                [row(A, B, X, TS_AB, X - a, T, 'creditor', ['prior', 'new'], (A_ID, B_ID)),
                 row(A, C, Y, TS_AC, Y + a, T, 'payer', ['new'], (A_ID, C_ID))],
                dict(parties(), amount=a, deal={'deal_id': DEAL, 'terms_hash': TH, 'price': a, 'quote_digest': qd()}))


def member_item(ts=T998):
    """B's two edges of a set-off: its claim on A falls by 2 and its debt to E falls by 2."""
    return item('setoff', SID, 'member',
                [row(A, B, 10, TS_AB, 8, ts, 'creditor', ['new'], (A_ID, B_ID)),
                 row(B, E, 5, TS_BE, 3, ts, 'issuer', ['new'], (B_ID, E_ID))], {})


# ---------- contexts ----------
# GET /info novation of a server on tracker v3.2: the v16 constants and the contract the clients sign prior slots for
# (spelled out here, so a change of novation.CONTRACT fails these tests).
INFO_NOVATION = {'transfer_ms': 999, 'setoff_ms': 998, 'bound_note_ms': 997, 'reserved_ms': [995, 996, 997, 998, 999],
                 'max_age_ms': 3600000, 'transfer_ttl_ms': 1200000, 'setoff_ttl_ms': 1800000, 'fallback_margin_ms': 60000,
                 'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3,
                 'prior_ack': 'basis/prior-ack/1'}


def base_ctx(me, me_id, now=NOW, **over):
    c = {'me_pk': me.pk, 'me_id': me_id, 'now_ms': now, 'verify': verify, 'pins': dict(PINS), 'records': {},
         'signed': {}, 'transfer_attempts': {}, 'novated_edges': {}, 'features': ['bound_notes/1', 'circulation/1'],
         'novation': copy.deepcopy(INFO_NOVATION)}
    c.update(over)
    return c


def payer_ctx(now=NOW, **over):
    c = base_ctx(B, B_ID, now, deal=nv.deal_context(terms(), TH, DH), payee_current_pk=C.pk,
                 mandate={'pay_with_held_notes': 'when_asked'})
    c.update(over)
    return c


def regen_ctx(now=NOW, **over):
    """The payer shown its own transfer again as a consent: its earlier attempt through A acknowledged the same prior,
    10, at the same timestamp T999 (the identical operation, which the tracker can apply at most once). A transfer
    regenerated at a new T while that attempt is alive is signed only when it acknowledges the same prior state, total
    and timestamp, as the attempt recorded (tracker v3.2, audit VS-1 closed: see VS1SamePriorTransferRetries); this
    record carries no prior_timestamp, so there it waits."""
    c = payer_ctx(now, transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T999, qd())]})
    c.update(over)
    return c


POLICY = {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 20}
MANDATE = {'auto_clear': True, 'novate_own_debt': True, 'accept_transfers': True, 'may_accept_credit': True,
           'accept_notes_from': [A_ID], 'refuse_notes_from': [], 'max_accept_per_issuer': 50,
           'pay_with_held_notes': 'when_asked'}


def issuer_ctx(**over):
    c = base_ctx(A, A_ID, consent_policy=dict(POLICY), mandate=dict(MANDATE))
    c.update(over)
    return c


def payee_ctx(**over):
    # issuer_ids: the participant id the payee's client resolved itself for the issuer's key (the directory)
    c = base_ctx(C, C_ID, consent_policy=dict(POLICY), mandate=dict(MANDATE),
                 deal=nv.deal_context(terms(), TH, DH, delivered=True, transfer_id=TID), issuer_ids={A.pk: A_ID})
    c.update(over)
    return c


def member_ctx(**over):
    c = base_ctx(B, B_ID, consent_policy=dict(POLICY), mandate=dict(MANDATE))
    c.update(over)
    return c


PT, BT, CO = nv.evaluate_payer_template, nv.evaluate_bound_template, nv.evaluate_consent


def set_(path, value):
    """fn(obj) setting obj[path...] = value."""
    def fn(o):
        for k in path[:-1]:
            o = o[k]
        o[path[-1]] = value
    return fn


def delete(path):
    def fn(o):
        for k in path[:-1]:
            o = o[k]
        del o[path[-1]]
    return fn


# ---------- the decision table: (name, evaluator, item(), ctx(), expected code or None) ----------
CASES = [
    # --- evaluate_payer_template (pay with a held note) ---
    ('payer: sign', PT, payer_tpl, payer_ctx, None),
    ('payer: sign, the payee has no claim on the issuer yet', PT, lambda: payer_tpl(Y=None), payer_ctx, None),
    ('payer: records not an object', PT, payer_tpl, lambda: payer_ctx(records='lost'), 'records_unreadable'),
    ('payer: paid_deals not an object', PT, payer_tpl, lambda: payer_ctx(records={'paid_deals': []}), 'records_unreadable'),
    ('payer: signed record not an object', PT, payer_tpl, lambda: payer_ctx(signed=['x']), 'records_unreadable'),
    ('payer: attempts of the deal not a list', PT, payer_tpl, lambda: payer_ctx(transfer_attempts={DEAL: 'x'}),
     'records_unreadable'),
    ('payer: a record of the held edge not an object', PT, payer_tpl, lambda: payer_ctx(records={AB: 5}),
     'records_unreadable'),
    ('payer: no from_edge', PT, lambda: edit(payer_tpl(), delete(['from_edge'])), payer_ctx, 'bad_template'),
    ('payer: amount a string', PT, lambda: edit(payer_tpl(), set_(['amount'], '3')), payer_ctx, 'bad_template'),
    ("payer: the server's quote digest is not the client's", PT,
     lambda: edit(payer_tpl(), set_(['quote_digest'], '00' * 32)), payer_ctx, 'bad_template'),
    ('payer: the deal is in paid_deals', PT, payer_tpl,
     lambda: payer_ctx(records={'paid_deals': {DEAL: {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': 1}}}),
     'already_paid'),
    ('payer: another tracker', PT, lambda: edit(payer_tpl(), set_(['tracker_nft_id'], '11' * 32)), payer_ctx,
     'tracker_mismatch'),
    ('payer: nothing pinned', PT, payer_tpl, lambda: payer_ctx(pins=None), 'tracker_mismatch'),
    ('payer: the agreed tracker is not the pinned one', PT, payer_tpl,
     lambda: payer_ctx(deal=dict(nv.deal_context(terms(), TH, DH), tracker_nft_id='11' * 32), pins=dict(PINS)),
     'tracker_mismatch'),
    ('payer: another deal', PT, lambda: edit(payer_tpl(), set_(['deal_id'], 'vd_ffffffffffffffff')), payer_ctx,
     'deal_mismatch'),
    ('payer: other terms', PT, lambda: edit(payer_tpl(), set_(['terms_hash'], 'ab' * 32)), payer_ctx, 'deal_mismatch'),
    ('payer: another delivery', PT, lambda: edit(payer_tpl(), set_(['deliverable_sha256'], 'cd' * 32)), payer_ctx,
     'deal_mismatch'),
    ('payer: the delivery accepted is not known', PT, payer_tpl,
     lambda: payer_ctx(deal=nv.deal_context(terms(), TH, None)), 'deal_mismatch'),
    ('payer: not my deal as payer', PT, payer_tpl, lambda: payer_ctx(me_id=E_ID), 'deal_mismatch'),
    ('payer: the held edge is not to my key', PT, lambda: edit(payer_tpl(), set_(['payer', 'pubkey'], E.pk)), payer_ctx,
     'not_my_edge'),
    ('payer: my own note', PT, lambda: payer_tpl(issuer=B), payer_ctx, 'self_edge'),
    ("payer: the payee's own note", PT, lambda: payer_tpl(issuer=C), payer_ctx, 'pay_with_is_payee'),
    ('payer: the issuer id is the payee', PT, lambda: edit(payer_tpl(), set_(['issuer', 'id'], C_ID)), payer_ctx,
     'pay_with_is_payee'),
    ("payer: not the payee's current key", PT, payer_tpl, lambda: payer_ctx(payee_current_pk=C2.pk), 'wrong_destination'),
    ('payer: the payee id is not the deal payee', PT, lambda: edit(payer_tpl(), set_(['payee', 'id'], E_ID)), payer_ctx,
     'wrong_destination'),
    ('payer: amount above the price', PT, lambda: payer_tpl(a=4), payer_ctx, 'amount_mismatch'),
    ('payer: residue 998', PT, lambda: payer_tpl(T=T998), payer_ctx, 'timestamp_domain'),
    ('payer: the claim does not cover the price', PT,
     lambda: edit(payer_tpl(X=2), set_(['from_edge', 'new_total'], 0)), payer_ctx, 'amount_mismatch'),
    ('payer: a negative new total', PT, lambda: payer_tpl(X=2), payer_ctx, 'bad_template'),
    ('payer: the held claim falls by the wrong amount', PT,
     lambda: edit(payer_tpl(), set_(['from_edge', 'new_total'], 8)), payer_ctx, 'amount_mismatch'),
    ("payer: the payee's claim rises by the wrong amount", PT,
     lambda: edit(payer_tpl(), set_(['to_edge', 'new_total'], 9)), payer_ctx, 'amount_mismatch'),
    ('payer: held state not signed by the issuer', PT,
     lambda: edit(payer_tpl(), set_(['from_edge', 'before'], st(A, B, 10, TS_AB, signer=E))), payer_ctx,
     'bad_prior_signature'),
    ('payer: destination state not signed by the issuer', PT,
     lambda: edit(payer_tpl(), set_(['to_edge', 'before', 'signature'], '02' + '11' * 64)), payer_ctx,
     'bad_prior_signature'),
    ('payer: more than 10 minutes old', PT, lambda: payer_tpl(T=res(NOW - 600_001, 999)), payer_ctx, 'timestamp_stale'),
    ('payer: more than 5 s ahead', PT, lambda: payer_tpl(T=res(NOW + 6_000, 999)), payer_ctx, 'timestamp_stale'),
    ('payer: not after the held state', PT,
     lambda: edit(payer_tpl(), set_(['from_edge', 'before'], st(A, B, 10, T999))), payer_ctx, 'timestamp_stale'),
    ('payer: my own note for the deal may still apply', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('note', BC, 6, 9, res(NOW - 30_000, 997))]}),
     'transfer_window_open'),
    ('payer: an earlier transfer through E may have applied', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', EB, 9, 6, T_OLD)]},
                       edges={EB: st(E, B, 4, T_OLD + 1000)}), 'attempt_outcome_unknown'),
    ('payer: an earlier transfer through E applied', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', EB, 9, 6, T_OLD)]}, edges={EB: st(E, B, 6, T_OLD)}),
     'already_paid'),
    ('payer: not the approved quote', PT, payer_tpl, lambda: payer_ctx(approved_quote_digest='ab' * 32), 'stale_quote'),
    ('payer: the mandate never pays with held notes', PT, payer_tpl,
     lambda: payer_ctx(mandate={'pay_with_held_notes': 'never'}), 'policy_off'),
    ('payer: another operation already signed at (A>B, T)', PT, payer_tpl,
     lambda: payer_ctx(signed={AB: {str(T999): {'op': 'pay:vd_ffffffffffffffff', 'slots': {AB + ':prior': 10}}}}),
     'timestamp_reused'),
    # R4 since tracker v3.2: a group with a prior slot records the prior state its PA acknowledged (prior_state); the
    # same operation at the same (A>B, T) over another prior state is refused, as the server's sandbox signer refuses it
    ('payer: the same operation at (A>B, T) acknowledged another prior state', PT, payer_tpl,
     lambda: payer_ctx(signed={AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7},
                                                 'prior_state': {'total': 10, 'timestamp': TS_AB - 1000}}}}),
     'timestamp_reused'),
    ('payer: sign, the same operation at (A>B, T) recorded with this prior state', PT, payer_tpl,
     lambda: payer_ctx(signed={AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7},
                                                 'prior_state': {'total': 10, 'timestamp': TS_AB}}}}),
     None),
    ('payer: sign, the same operation at (A>B, T) recorded before prior states were', PT, payer_tpl,
     lambda: payer_ctx(signed={AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7}}}}),
     None),
    ('payer: a prior_state in the R4 record that is not {total, timestamp}', PT, payer_tpl,
     lambda: payer_ctx(signed={AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7},
                                                 'prior_state': {'total': 10}}}}),
     'records_unreadable'),
    # FX-PY: the payer roles need the mandate and this participant's id
    ('payer: the template names another payer id', PT, lambda: edit(payer_tpl(), set_(['payer', 'id'], E_ID)), payer_ctx,
     'deal_mismatch'),
    ('payer: pins without a tracker', PT, payer_tpl, lambda: payer_ctx(pins={}), 'tracker_mismatch'),
    ('payer: no mandate in the context', PT, payer_tpl, lambda: payer_ctx(mandate=None), 'policy_off'),
    ('payer: no participant id in the context', PT, payer_tpl, lambda: payer_ctx(me_id=None), 'deal_mismatch'),
    ('payer: my records confirm an earlier attempt that the edge has moved past', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', EB, 9, 6, T_OLD, prior_timestamp=TS_AB)]},
                       records={EB: {'confirmed': {'total': 6, 'timestamp': T_OLD, 'signature': 'aa'}, 'pending': []}},
                       edges={EB: st(E, B, 9, T_OLD + 1000)}), 'already_paid'),
    # tracker v3.2 (design v3.2 section 4): the same-prior exemption; the same issuer at a new T is signed at once when
    # it acknowledges the same state of the held edge (total AND timestamp) as the earlier transfer recorded, and both
    # signed PA (the record's ack)
    ('payer: sign a retry at a new T on the same prior state as an earlier transfer (tracker v3.2)', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB,
                                                         ack=ACK)]}),
     None),
    # ... not after an earlier transfer recorded without ack (a 0.4.0 build on tracker v3.1 signed M(A,B,X,T) there; the
    # first v3.2 build wrote no ack): treated as before tracker v3.2, it waits for its window
    ('payer: a retry on the same prior state after an earlier transfer recorded without ack waits', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB)]}),
     'transfer_window_open'),
    ('payer: a retry on the same prior state after an earlier transfer with another ack waits', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB,
                                                         ack='basis/prior-ack/2')]}),
     'transfer_window_open'),
    ('payer: a retry on the same total but another prior timestamp waits for the earlier window', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB - 1000)]}),
     'transfer_window_open'),
    ('payer: a retry after an earlier transfer that recorded no prior state waits', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}), 'transfer_window_open'),
    ('payer: the same prior state through another issuer waits', PT, payer_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', EB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB)]}),
     'transfer_window_open'),
    # tracker v3.2: the template's prior timestamps, where it names them, are its prior states' (as the totals are)
    ('payer: sign, the template names the prior timestamps of both edges', PT,
     lambda: edit(payer_tpl(), lambda o: (o['from_edge'].update(prior_timestamp=TS_AB), o['to_edge'].update(prior_timestamp=TS_AC))),
     payer_ctx, None),
    ('payer: sign, the template names prior timestamp 0 for a new destination edge', PT,
     lambda: edit(payer_tpl(Y=None), set_(['to_edge', 'prior_timestamp'], 0)), payer_ctx, None),
    ("payer: the held edge's prior timestamp is not its state's", PT,
     lambda: edit(payer_tpl(), set_(['from_edge', 'prior_timestamp'], TS_AB + 1)), payer_ctx, 'bad_template'),
    ("payer: a prior timestamp for a new destination edge", PT,
     lambda: edit(payer_tpl(Y=None), set_(['to_edge', 'prior_timestamp'], TS_AC)), payer_ctx, 'bad_template'),
    ('payer: a prior timestamp that is not a whole number', PT,
     lambda: edit(payer_tpl(), set_(['to_edge', 'prior_timestamp'], str(TS_AC))), payer_ctx, 'bad_template'),
    # tracker v3.2: the contract (GET /info novation) or nothing that signs a prior slot
    ('payer: GET /info shows no novation contract', PT, payer_tpl, lambda: payer_ctx(novation=None), 'feature_unavailable'),
    ('payer: the tracker v3.1 contract (transfer version 3)', PT, payer_tpl,
     lambda: payer_ctx(novation=dict(INFO_NOVATION, transfer_version=3)), 'feature_unavailable'),
    ('payer: a contract version written as a string', PT, payer_tpl,
     lambda: payer_ctx(novation=dict(INFO_NOVATION, transfer_version='4')), 'feature_unavailable'),
    ('payer: another prior acknowledgment', PT, payer_tpl,
     lambda: payer_ctx(novation=dict(INFO_NOVATION, prior_ack='basis/prior-ack/2')), 'feature_unavailable'),
    ('payer: another tracker build', PT, payer_tpl,
     lambda: payer_ctx(novation=dict(INFO_NOVATION, tracker_build='valun-circulating-credit/3')), 'feature_unavailable'),

    # --- evaluate_bound_template (pay with my own bound note) ---
    ('bound: sign', BT, bound_tpl, payer_ctx, None),
    ('bound: sign, a new edge', BT, lambda: bound_tpl(prior=False), payer_ctx, None),
    ('bound: attempts not an object', BT, bound_tpl, lambda: payer_ctx(transfer_attempts=[]), 'records_unreadable'),
    ('bound: novated_edges unreadable', BT, bound_tpl, lambda: payer_ctx(novated_edges=7), 'records_unreadable'),
    ('bound: no prior_note', BT, lambda: edit(bound_tpl(), delete(['prior_note'])), payer_ctx, 'bad_template'),
    ('bound: prior_note does not match prior_total', BT, lambda: edit(bound_tpl(), set_(['prior_total'], 5)), payer_ctx,
     'bad_template'),
    ('bound: no prior note, prior_total above 0', BT, lambda: edit(bound_tpl(prior=False), set_(['prior_total'], 1)),
     payer_ctx, 'bad_template'),
    ('bound: the deal is in paid_deals', BT, bound_tpl,
     lambda: payer_ctx(records={'paid_deals': {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': 1}}}),
     'already_paid'),
    ('bound: another unit', BT, lambda: edit(bound_tpl(), set_(['denomination'], 'erg')), payer_ctx, 'tracker_mismatch'),
    ('bound: another delivery', BT, lambda: edit(bound_tpl(), set_(['deliverable_sha256'], 'cd' * 32)), payer_ctx,
     'deal_mismatch'),
    ('bound: a note from another key', BT, lambda: edit(bound_tpl(), set_(['issuer_pubkey'], A.pk)), payer_ctx,
     'not_my_edge'),
    ("bound: not to the payee's current key", BT, bound_tpl, lambda: payer_ctx(payee_current_pk=C2.pk),
     'wrong_destination'),
    ('bound: unbound once bound_notes/1 is advertised', BT, lambda: bound_tpl(ts=res(NOW - 1500, 500)), payer_ctx,
     'bound_note_required'),
    ('bound: unbound on a novated edge', BT, lambda: bound_tpl(ts=res(NOW - 1500, 500)),
     lambda: payer_ctx(features=None, novated_edges={BC: {'since': 1}}), 'bound_note_required'),
    ('bound: residue 999', BT, lambda: bound_tpl(ts=res(NOW - 1500, 999)), lambda: payer_ctx(features=None),
     'timestamp_domain'),
    ('bound: adds more than the price', BT, lambda: edit(bound_tpl(), set_(['total'], 10)), payer_ctx, 'amount_mismatch'),
    ('bound: price is not the agreed price', BT, lambda: bound_tpl(price=4), payer_ctx, 'amount_mismatch'),
    ('bound: prior note not signed by my key', BT,
     lambda: edit(bound_tpl(), set_(['prior_note'], st(B, C, 6, TS_BC, signer=A))), payer_ctx, 'bad_prior_signature'),
    ('bound: more than 10 minutes old', BT, lambda: bound_tpl(ts=res(NOW - 600_001, 997)), payer_ctx, 'timestamp_stale'),
    ('bound: my pending note for this deal is the prior shown', BT, bound_tpl,
     lambda: payer_ctx(records={BC: {'confirmed': None, 'pending': [pending(6, TS_BC)]}}), 'already_paid'),
    ('bound: an earlier transfer may still apply', BT, bound_tpl,
     lambda: payer_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}), 'transfer_window_open'),
    ('bound: another operation already signed at (B>C, T)', BT, bound_tpl,
     lambda: payer_ctx(signed={BC: {str(T997): {'op': 'note:vd_ffffffffffffffff', 'slots': {BC + ':new': 9}}}}),
     'timestamp_reused'),
    ('bound: the same note at (B>C, T) acknowledged another prior state', BT, bound_tpl,
     lambda: payer_ctx(signed={BC: {str(T997): {'op': 'note:' + DEAL, 'slots': {BC + ':prior': 6, BC + ':new': 9},
                                                 'prior_state': {'total': 6, 'timestamp': TS_BC - 1000}}}}),
     'timestamp_reused'),
    ('bound: no participant id in the context', BT, bound_tpl, lambda: payer_ctx(me_id=None), 'deal_mismatch'),
    ('bound: my note for this deal is the prior shown, and my records know a later state', BT, bound_tpl,
     lambda: payer_ctx(records={BC: {'confirmed': {'total': 8, 'timestamp': TS_BC + 10, 'signature': 'aa'},
                                     'pending': [pending(6, TS_BC)]}}), 'already_paid'),
    ('bound: a template for another deal', BT, lambda: edit(bound_tpl(), set_(['deal_id'], 'vd_ffffffffffffffff')),
     payer_ctx, 'deal_mismatch'),
    # tracker v3.2: prior_timestamp beside prior_total is the prior note's timestamp (0 for a new edge)
    ('bound: sign, the template names the prior timestamp', BT, lambda: edit(bound_tpl(), set_(['prior_timestamp'], TS_BC)),
     payer_ctx, None),
    ('bound: sign, a new edge with prior timestamp 0', BT, lambda: edit(bound_tpl(prior=False), set_(['prior_timestamp'], 0)),
     payer_ctx, None),
    ('bound: prior_timestamp is not the prior note\'s', BT, lambda: edit(bound_tpl(), set_(['prior_timestamp'], TS_BC - 1)),
     payer_ctx, 'bad_template'),
    ('bound: a prior timestamp for a new edge', BT, lambda: edit(bound_tpl(prior=False), set_(['prior_timestamp'], TS_BC)),
     payer_ctx, 'bad_template'),
    ('bound: the tracker v3.1 contract (bound notes version 2)', BT, bound_tpl,
     lambda: payer_ctx(novation=dict(INFO_NOVATION, bound_note_version=2)), 'feature_unavailable'),
    ('bound: GET /info shows no novation contract', BT, bound_tpl, lambda: payer_ctx(novation=None), 'feature_unavailable'),

    # --- evaluate_consent, issuer ---
    ('issuer: sign', CO, issuer_item, issuer_ctx, None),
    # the issuer signs 80-byte note messages only: not gated on the tracker v3.2 contract
    ('issuer: sign without a novation contract in GET /info', CO, issuer_item, lambda: issuer_ctx(novation=None), None),
    ('issuer: sign, a new edge to the payee', CO, lambda: issuer_item(Y=None), issuer_ctx, None),
    ('issuer: two roles', CO, lambda: edit(issuer_item(), set_(['your_roles'], ['issuer', 'payee'])), issuer_ctx,
     'bad_consent'),
    ('issuer: not collecting', CO, lambda: edit(issuer_item(), set_(['state'], 'applied')), issuer_ctx, 'bad_consent'),
    ('issuer: change inconsistent with the totals', CO, lambda: edit(issuer_item(), set_(['edges', 0, 'change'], -2)),
     issuer_ctx, 'bad_consent'),
    ('issuer: a prior slot asked of the issuer', CO, lambda: edit(issuer_item(), set_(['edges', 0, 'slots'], ['prior', 'new'])),
     issuer_ctx, 'bad_consent'),
    ('issuer: records of an edge unreadable', CO, issuer_item,
     lambda: issuer_ctx(records={AC: {'confirmed': None, 'pending': 'x'}}), 'records_unreadable'),
    ('issuer: another tracker', CO, lambda: edit(issuer_item(), set_(['tracker_nft_id'], '22' * 32)), issuer_ctx,
     'tracker_mismatch'),
    ('issuer: not my edges', CO, issuer_item, lambda: issuer_ctx(me_pk=E.pk), 'not_my_edge'),
    ('issuer: a self edge', CO,
     lambda: edit(issuer_item(), set_(['edges', 1], row(A, A, 4, TS_AC, 7, T999, 'issuer', ['new'], (A_ID, A_ID)))),
     issuer_ctx, 'self_edge'),
    ('issuer: the same edge twice', CO,
     lambda: edit(issuer_item(), set_(['edges', 1], row(A, B, 4, TS_AC, 7, T999, 'issuer', ['new'], (A_ID, B_ID)))),
     issuer_ctx, 'duplicate_edge'),
    ('issuer: residue 998', CO, lambda: issuer_item(T=T998), issuer_ctx, 'timestamp_domain'),
    ('issuer: the raise is larger than the fall', CO,
     lambda: edit(issuer_item(), set_(['edges', 1], row(A, C, 4, TS_AC, 8, T999, 'issuer', ['new'], (A_ID, C_ID)))),
     issuer_ctx, 'total_owed_changes'),
    ('issuer: both edges rise', CO,
     lambda: edit(issuer_item(), set_(['edges', 0], row(A, B, 10, TS_AB, 13, T999, 'issuer', ['new'], (A_ID, B_ID)))),
     issuer_ctx, 'total_owed_changes'),
    ('issuer: a state not signed by my key', CO,
     lambda: edit(issuer_item(), set_(['edges', 0, 'before'], st(A, B, 10, TS_AB, signer=E))), issuer_ctx,
     'bad_prior_signature'),
    ('issuer: more than 55 minutes old', CO, lambda: issuer_item(T=res(NOW - 3_300_001, 999)), issuer_ctx,
     'timestamp_stale'),
    ('issuer: my policy does not sign as issuer', CO, issuer_item,
     lambda: issuer_ctx(consent_policy=dict(POLICY, as_issuer=False)), 'policy_off'),
    ('issuer: no local policy at all', CO, issuer_item, lambda: issuer_ctx(consent_policy=None), 'policy_off'),
    ('issuer: the mandate does not novate own debt', CO, issuer_item,
     lambda: issuer_ctx(mandate=dict(MANDATE, novate_own_debt=False)), 'policy_off'),
    ('issuer: the mandate could not be read', CO, issuer_item, lambda: issuer_ctx(mandate=None), 'policy_off'),
    ('issuer: above my cap per consent', CO, issuer_item, lambda: issuer_ctx(consent_policy=dict(POLICY, max_PC=2)),
     'policy_cap'),
    ('issuer: an ordinary note of mine on A>C may still apply', CO, issuer_item,
     lambda: issuer_ctx(records={AC: {'confirmed': None, 'pending': [pending(9, TS_AC + 5_000, ref='vd_aaaaaaaaaaaaaaaa')]}}),
     'pending_unbound_note'),
    ('issuer: another operation already signed at (A>B, T)', CO, issuer_item,
     lambda: issuer_ctx(signed={AB: {str(T999): {'op': 'transfer:vt_ffffffffffffffff', 'slots': {AB + ':new': 7}}}}),
     'timestamp_reused'),

    # --- evaluate_consent, payee (being paid by transfer) ---
    ('payee: sign', CO, payee_item, payee_ctx, None),
    ('payee: sign, a first claim on the issuer', CO, lambda: payee_item(Y=None), payee_ctx, None),
    # tracker v3.2: the payee's prior slot is PA(A,C,Y,p_AC,T): only for the contract, and a named prior timestamp is
    # the state's
    ('payee: the tracker v3.1 contract', CO, payee_item,
     lambda: payee_ctx(novation=dict(INFO_NOVATION, tracker_build='valun-circulating-credit/3', transfer_version=3,
                                     bound_note_version=2, prior_ack=None)), 'feature_unavailable'),
    ('payee: GET /info novation is not an object', CO, payee_item, lambda: payee_ctx(novation=['v3.2']),
     'feature_unavailable'),
    ('payee: sign, the item names the prior timestamp of my edge', CO,
     lambda: edit(payee_item(), set_(['edges', 0, 'prior_timestamp'], TS_AC)), payee_ctx, None),
    ("payee: the item's prior timestamp is not my edge's state's", CO,
     lambda: edit(payee_item(), set_(['edges', 0, 'prior_timestamp'], TS_AC + 1)), payee_ctx, 'bad_consent'),
    ('payee: only the new slot', CO, lambda: edit(payee_item(), set_(['edges', 0, 'slots'], ['new'])), payee_ctx,
     'bad_consent'),
    ('payee: an unknown slot', CO, lambda: edit(payee_item(), set_(['edges', 0, 'slots'], ['prior', 'old'])), payee_ctx,
     'bad_consent'),
    ('payee: not my edge', CO, payee_item, lambda: payee_ctx(me_pk=E.pk), 'not_my_edge'),
    ('payee: the deal could not be read', CO, payee_item, lambda: payee_ctx(deal=None), 'deal_mismatch'),
    ('payee: not delivered', CO, payee_item,
     lambda: payee_ctx(deal=nv.deal_context(terms(), TH, DH, delivered=False, transfer_id=TID)), 'deal_mismatch'),
    ('payee: the deal is paid by another transfer', CO, payee_item,
     lambda: payee_ctx(deal=nv.deal_context(terms(), TH, DH, delivered=True, transfer_id='vt_ffffffffffffffff')),
     'deal_mismatch'),
    ('payee: the amount is not the price', CO, lambda: payee_item(a=2), payee_ctx, 'deal_mismatch'),
    ('payee: the terms name my old key', CO, payee_item,
     lambda: payee_ctx(me_pk=C.pk, deal=nv.deal_context(terms(payee=C2), TH, DH, delivered=True, transfer_id=TID)),
     'deal_mismatch'),
    ('payee: residue 997', CO, lambda: payee_item(T=T997), payee_ctx, 'timestamp_domain'),
    ("payee: a state not the issuer's", CO,
     lambda: edit(payee_item(), set_(['edges', 0, 'before'], st(A, C, 4, TS_AC, signer=B))), payee_ctx,
     'bad_prior_signature'),
    ('payee: more than 5 s ahead', CO, lambda: payee_item(T=res(NOW + 6_000, 999)), payee_ctx, 'timestamp_stale'),
    ('payee: my policy does not accept transfers', CO, payee_item,
     lambda: payee_ctx(consent_policy=dict(POLICY, as_new_creditor=False)), 'policy_off'),
    ('payee: the mandate does not accept transfers', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, accept_transfers=False)), 'policy_off'),
    ('payee: the mandate does not accept credit', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, may_accept_credit=False)), 'policy_off'),
    ('payee: the mandate accepts notes from nobody', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, accept_notes_from=[])), 'issuer_refused'),
    ('payee: the mandate refuses this issuer', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, accept_notes_from='any', refuse_notes_from=[A_ID])), 'issuer_refused'),
    ('payee: my policy refuses this issuer key', CO, payee_item,
     lambda: payee_ctx(consent_policy=dict(POLICY, refuse_issuers=[A.pk])), 'issuer_refused'),
    ('payee: my policy accepts only another issuer', CO, payee_item,
     lambda: payee_ctx(consent_policy=dict(POLICY, accept_issuers=[E_ID])), 'issuer_refused'),
    ('payee: above max_accept_per_issuer', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, max_accept_per_issuer=6)), 'policy_cap'),
    ('payee: above my cap per consent', CO, payee_item, lambda: payee_ctx(consent_policy=dict(POLICY, max_PC=2)),
     'policy_cap'),
    ('payee: another operation already signed at (A>C, T)', CO, payee_item,
     lambda: payee_ctx(signed={AC: {str(T999): {'op': 'transfer:vt_ffffffffffffffff', 'slots': {AC + ':prior': 4}}}}),
     'timestamp_reused'),
    ('payee: the same transfer at (A>C, T) acknowledged another prior state', CO, payee_item,
     lambda: payee_ctx(signed={AC: {str(T999): {'op': 'transfer:' + TID, 'slots': {AC + ':prior': 4, AC + ':new': 7},
                                                 'prior_state': {'total': 4, 'timestamp': TS_AC + 1000}}}}),
     'timestamp_reused'),
    ('payee: sign, the same transfer at (A>C, T) recorded with this prior state', CO, payee_item,
     lambda: payee_ctx(signed={AC: {str(T999): {'op': 'transfer:' + TID, 'slots': {AC + ':prior': 4, AC + ':new': 7},
                                                 'prior_state': {'total': 4, 'timestamp': TS_AC}}}}),
     None),
    ('payee: credited less than the price (new total Y + 2, amount 3)', CO,
     lambda: edit(payee_item(), lambda o: o['edges'][0].update(new_total=6, change=2)), payee_ctx, 'deal_mismatch'),
    ('payee: an edge from my key to itself', CO,
     lambda: edit(payee_item(), set_(['edges', 0], row(C, C, 4, TS_AC, 7, T999, 'creditor', ['prior', 'new'], (C_ID, C_ID)))),
     payee_ctx, 'self_edge'),
    # FX-PY: issuer lists are checked against the id my client resolved for the issuer's key, never the item's labels
    ('payee: my client could not resolve the issuer id', CO, payee_item, lambda: payee_ctx(issuer_ids={}), 'issuer_refused'),
    ('payee: the mandate refuses the issuer, the item leaves out its ids', CO,
     lambda: edit(payee_item(), lambda o: (o['edges'][0].pop('issuer'), o['context'].pop('issuer'))),
     lambda: payee_ctx(mandate=dict(MANDATE, accept_notes_from='any', refuse_notes_from=[A_ID])), 'issuer_refused'),
    ('payee: the item names another issuer id than the directory', CO,
     lambda: edit(payee_item(), lambda o: (o['edges'][0]['issuer'].update(id=E_ID), o['context']['issuer'].update(id=E_ID))),
     lambda: payee_ctx(mandate=dict(MANDATE, accept_notes_from=[A_ID, E_ID])), 'issuer_refused'),
    ('payee: a local refusal by id, the id not resolved', CO, payee_item,
     lambda: payee_ctx(issuer_ids={}, mandate=dict(MANDATE, accept_notes_from='any'),
                       consent_policy=dict(POLICY, refuse_issuers=[A_ID])), 'issuer_refused'),
    # FX2-PY: the mandate's refuse list names only another participant, but without the issuer's id my client cannot
    # tell that the issuer is not on it (a directory that leaves out a refused issuer's key must not get it paid)
    ('payee: the mandate refuses by id and my client could not resolve the issuer', CO, payee_item,
     lambda: payee_ctx(issuer_ids={}, mandate=dict(MANDATE, accept_notes_from='any', refuse_notes_from=[E_ID])),
     'issuer_refused'),
    ('payee: sign, the mandate refuses only another id and my client resolved the issuer', CO, payee_item,
     lambda: payee_ctx(mandate=dict(MANDATE, accept_notes_from='any', refuse_notes_from=[E_ID])), None),

    # --- evaluate_consent, payer (a regenerated transfer) ---
    ('payer consent: sign (the same operation as the earlier attempt: same prior, same T)', CO, payer_item, regen_ctx, None),
    # tracker v3.2 closes audit VS-1: regenerated at a new T on the same prior state (total and timestamp) of the held
    # edge as the earlier attempt recorded is signed at once (they exclude each other at the tracker)
    ('payer consent: sign a regenerated transfer at a new T on the same prior state (tracker v3.2)', CO, payer_item,
     lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB,
                                                         ack=ACK)]}),
     None),
    ('payer consent: a regenerated transfer on the same prior state after an earlier one recorded without ack', CO,
     payer_item, lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB)]}),
     'transfer_window_open'),
    # ... but not when the earlier attempt recorded no prior state, or another one (the same total, another timestamp)
    ('payer consent: a regenerated transfer while an earlier attempt without a recorded prior state is alive', CO,
     payer_item, lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}),
     'transfer_window_open'),
    ('payer consent: a regenerated transfer on another prior state of the held edge', CO, payer_item,
     lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB - 1000)]}),
     'transfer_window_open'),
    ('payer consent: the tracker v3.1 contract', CO, payer_item,
     lambda: regen_ctx(novation=dict(INFO_NOVATION, transfer_version=3)), 'feature_unavailable'),
    # audit AI-1: past the earlier attempt's window its approval covers no new attempt, even one the client recorded
    ('payer consent: past the earlier attempt\'s window', CO, lambda: payer_item(T=res(LATE - 1500, 999)),
     lambda: regen_ctx(now=LATE, transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}), 'stale_quote'),
    ('payer consent: past the window, with the approved quote recorded', CO, lambda: payer_item(T=res(LATE - 1500, 999)),
     lambda: regen_ctx(now=LATE, approved_quote_digest=qd(),
                       transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}), 'stale_quote'),
    ('payer consent: no deal in the context', CO, lambda: edit(payer_item(), delete(['context', 'deal'])), regen_ctx,
     'bad_consent'),
    ('payer consent: the deal is in paid_deals', CO, payer_item,
     lambda: regen_ctx(records={'paid_deals': {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T_OLD}}}),
     'already_paid'),
    ('payer consent: no held edge to my key', CO, payer_item, lambda: regen_ctx(me_pk=E.pk), 'not_my_edge'),
    ("payer consent: not the payee's current key", CO, payer_item, lambda: regen_ctx(payee_current_pk=C2.pk),
     'wrong_destination'),
    ('payer consent: residue 998', CO, lambda: payer_item(T=T998), regen_ctx, 'timestamp_domain'),
    ('payer consent: the earlier attempt acknowledged another prior', CO, payer_item,
     lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 12, 9, T_OLD, qd())]}), 'transfer_window_open'),
    ('payer consent: nothing approved', CO, payer_item, lambda: regen_ctx(transfer_attempts={}), 'stale_quote'),
    ('payer consent: the quote changed', CO, payer_item,
     lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T999, 'ab' * 32)]}), 'stale_quote'),
    ('payer consent: no mandate in the context', CO, payer_item, lambda: regen_ctx(mandate=None), 'policy_off'),
    ('payer consent: the destination at another timestamp', CO,
     lambda: edit(payer_item(), set_(['edges', 1, 'timestamp'], T999 - 1000)), regen_ctx, 'bad_consent'),
    ('payer consent: no participant id in the context', CO, payer_item, lambda: regen_ctx(me_id=None), 'deal_mismatch'),

    # --- evaluate_consent, member (a set-off) ---
    ('member: sign', CO, member_item, member_ctx, None),
    # a set-off signs 80-byte note messages only (set-off version 3 is unchanged): not gated on the contract
    ('member: sign without a novation contract in GET /info', CO, member_item, lambda: member_ctx(novation=None), None),
    ('member: records not an object', CO, member_item, lambda: member_ctx(records=[]), 'records_unreadable'),
    ('member: a signed entry unreadable', CO, member_item, lambda: member_ctx(signed={AB: {str(T998): 'x'}}),
     'records_unreadable'),
    ('member: an edge without a prior state', CO, lambda: edit(member_item(), set_(['edges', 0, 'before'], None)),
     member_ctx, 'bad_consent'),
    ('member: a prior slot asked in a set-off', CO, lambda: edit(member_item(), set_(['edges', 0, 'slots'], ['prior', 'new'])),
     member_ctx, 'bad_consent'),
    ('member: an absent edge in a set-off', CO,
     lambda: edit(member_item(), lambda o: o['edges'][0].update(before=None, change=8)), member_ctx, 'bad_consent'),
    ('member: the role on an edge does not fit its keys', CO,
     lambda: edit(member_item(), set_(['edges', 0, 'your_role'], 'issuer')), member_ctx, 'bad_consent'),
    ('member: the kind does not fit the role', CO, lambda: edit(member_item(), set_(['kind'], 'transfer')), member_ctx,
     'bad_consent'),
    ('member: another unit', CO, lambda: edit(member_item(), set_(['denomination'], 'erg')), member_ctx,
     'tracker_mismatch'),
    ('member: a self edge', CO,
     lambda: edit(member_item(), set_(['edges', 1], row(B, B, 5, TS_BE, 3, T998, 'issuer', ['new'], (B_ID, B_ID)))),
     member_ctx, 'self_edge'),
    ('member: an edge I am not party to', CO,
     lambda: edit(member_item(), lambda o: o['edges'].append(row(A, C, 4, TS_AC, 2, T998, 'creditor', ['new'], (A_ID, C_ID)))),
     member_ctx, 'not_my_edge'),
    ('member: the same edge twice', CO, lambda: edit(member_item(), lambda o: o['edges'].append(copy.deepcopy(o['edges'][0]))),
     member_ctx, 'duplicate_edge'),
    ('member: residue 999', CO, lambda: member_item(ts=T999), member_ctx, 'timestamp_domain'),
    ('member: an edge that rises', CO,
     lambda: edit(member_item(), set_(['edges', 0], row(A, B, 10, TS_AB, 12, T998, 'creditor', ['new'], (A_ID, B_ID)))),
     member_ctx, 'increase_in_setoff'),
    ('member: my claims fall more than my debts', CO,
     lambda: edit(member_item(), set_(['edges', 1], row(B, E, 5, TS_BE, 4, T998, 'issuer', ['new'], (B_ID, E_ID)))),
     member_ctx, 'not_net_neutral'),
    ("member: a state not its issuer's", CO,
     lambda: edit(member_item(), set_(['edges', 1, 'before'], st(B, E, 5, TS_BE, signer=E))), member_ctx,
     'bad_prior_signature'),
    ('member: more than 55 minutes old', CO, lambda: member_item(ts=res(NOW - 3_300_001, 998)), member_ctx,
     'timestamp_stale'),
    ('member: my policy does not sign set-offs', CO, member_item,
     lambda: member_ctx(consent_policy=dict(POLICY, setoff=False)), 'policy_off'),
    ('member: the mandate does not clear', CO, member_item, lambda: member_ctx(mandate=dict(MANDATE, auto_clear=False)),
     'policy_off'),
    ('member: above my cap per consent', CO, member_item, lambda: member_ctx(consent_policy=dict(POLICY, max_PC=1)),
     'policy_cap'),
    ('member: a malformed cap', CO, member_item, lambda: member_ctx(consent_policy=dict(POLICY, max_PC='5')),
     'policy_cap'),
    ('member: an ordinary note of mine on B>E may still apply', CO, member_item,
     lambda: member_ctx(records={BE: {'confirmed': None, 'pending': [pending(9, TS_BE + 5_000, ref='vd_aaaaaaaaaaaaaaaa')]}}),
     'pending_unbound_note'),
    ('member: another operation already signed at (A>B, ts)', CO, member_item,
     lambda: member_ctx(signed={AB: {str(T998): {'op': 'setoff:vs_ffffffffffffffff', 'slots': {AB + ':new': 8}}}}),
     'timestamp_reused'),
    ('member: the same operation signed again', CO, member_item,
     lambda: member_ctx(signed={AB: {str(T998): {'op': 'setoff:' + SID, 'slots': {AB + ':new': 8}}}}), None),
    # R12: a pending BOUND note of mine later than the state shown does not block a set-off (it cannot apply out of turn)
    ('member: a pending bound note of mine on B>E, later than the state shown', CO, member_item,
     lambda: member_ctx(records={BE: {'confirmed': None, 'pending': [pending(9, res(NOW - 1000, 997), ref='vd_aaaaaaaaaaaaaaaa')]}}),
     None),
    # D-2 c on the client: ... unless the set-off brings B>E back to the prior that bound note acknowledged
    ('member: B>E back to the prior of a live bound note of mine', CO, member_item,
     lambda: member_ctx(transfer_attempts={'vd_bbbbbbbbbbbbbbbb': [dict(attempt('note', BE, 3, 6, res(NOW - 1000, 997)),
                                                                          deal_id='vd_bbbbbbbbbbbbbbbb')]}),
     'payment_attempt'),
    ('member: a live bound note of mine whose prior is another total', CO, member_item,
     lambda: member_ctx(transfer_attempts={'vd_bbbbbbbbbbbbbbbb': [dict(attempt('note', BE, 4, 7, res(NOW - 1000, 997)),
                                                                          deal_id='vd_bbbbbbbbbbbbbbbb')]}), None),
    ('issuer: A>B back to the prior of a live bound note of mine', CO, issuer_item,
     lambda: issuer_ctx(transfer_attempts={'vd_bbbbbbbbbbbbbbbb': [dict(attempt('note', AB, 7, 10, res(NOW - 1000, 997)),
                                                                          deal_id='vd_bbbbbbbbbbbbbbbb')]}),
     'payment_attempt'),
]


class DecisionTable(unittest.TestCase):
    def test_every_case(self):
        for name, fn, make_item, make_ctx, expected in CASES:
            with self.subTest(name):
                it, ctx = make_item(), make_ctx()
                it_before = copy.deepcopy(it)
                ctx_before = copy.deepcopy({k: v for k, v in ctx.items() if k != 'verify'})
                r = fn(it, ctx)
                self.assertEqual(it, it_before)                              # pure: nothing it is given changes
                self.assertEqual({k: v for k, v in ctx.items() if k != 'verify'}, ctx_before)
                self.assertEqual(r['code'], expected, (name, r['summary']['reason']))
                self.assertEqual(r['ok'], expected is None)
                self.assertEqual(set(r), {'ok', 'code', 'to_sign', 'summary', 'write_ahead'})
                if expected is None:
                    self.assertTrue(r['to_sign'] or r['summary']['edges'])
                    self.assertIsNotNone(r['write_ahead'])
                else:
                    self.assertEqual((r['to_sign'], r['write_ahead']), ([], None))
                    self.assertIn(expected, nv.REFUSAL_CODES)
                    self.assertTrue(r['summary']['reason'])
                    self.assertFalse(r['summary']['reason'].startswith('the item could not be read'), name)

    def test_every_refusal_code_has_a_case(self):
        covered = {c[4] for c in CASES if c[4] is not None}
        self.assertEqual(set(nv.REFUSAL_CODES) - covered, set())
        self.assertEqual(covered - set(nv.REFUSAL_CODES), set())

    def test_the_spec_codes_and_the_d1_codes_are_all_there(self):
        spec = ('bad_prior_signature timestamp_domain timestamp_reused timestamp_stale not_net_neutral increase_in_setoff '
                'duplicate_edge self_edge not_my_edge total_owed_changes pay_with_is_payee wrong_destination '
                'amount_mismatch deal_mismatch policy_off policy_cap issuer_refused records_unreadable '
                'transfer_window_open bound_note_required pending_unbound_note tracker_mismatch').split()
        self.assertEqual(len(spec), 22)
        self.assertLessEqual(set(spec) | {'attempt_outcome_unknown', 'already_paid'}, set(nv.REFUSAL_CODES))
        self.assertEqual(len(nv.REFUSAL_CODES), len(set(nv.REFUSAL_CODES)))


class SignedBytes(unittest.TestCase):
    """Accepted cases for every role: the slots, totals and timestamps of the spec's tables, and messages that are
    basis.note_message() (a new slot) or basis.prior_ack_message() (a prior slot, tracker v3.2) and that the signer's
    signature over them verifies with basis.verify."""

    def assertSigns(self, r, signer, expected):
        self.assertTrue(r['ok'], r['summary']['reason'])
        self.assertEqual(r['to_sign'], expected)
        msgs = nv.slot_messages(r['to_sign'], NFT, DENOM)
        self.assertEqual(list(msgs), [s[0] for s in expected])
        for entry in r['to_sign']:
            slot, issuer, recipient, total, ts = entry[:5]
            if slot.endswith(':prior'):
                self.assertEqual(len(entry), 6)
                m = vb.prior_ack_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, entry[5], ts,
                                         bytes.fromhex(NFT), DENOM)
                self.assertEqual(len(m), 105)
                self.assertEqual(m[:17], b'basis/prior-ack/1')
                self.assertEqual(nv.prior_message(issuer, recipient, total, entry[5], ts, NFT, DENOM), m)
                self.assertNotEqual(m[17:], nv.message(issuer, recipient, total, ts, NFT, DENOM))
            else:
                self.assertEqual(len(entry), 5)
                m = vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, ts, bytes.fromhex(NFT), DENOM)
                self.assertEqual(len(m), 80)
                self.assertEqual(nv.message(issuer, recipient, total, ts, NFT, DENOM), m)
            self.assertEqual(msgs[slot], m)
            signature = vb.sign(m, signer.secret, bytes.fromhex(signer.pk))
            self.assertTrue(vb.verify(signature, m, bytes.fromhex(signer.pk)))
            self.assertFalse(vb.verify(signature, m, bytes.fromhex(E.pk if signer is not E else A.pk)))
        return msgs

    def test_payer_template(self):
        r = PT(payer_tpl(), payer_ctx())
        self.assertSigns(r, B, [(AB + ':prior', A.pk, B.pk, 10, T999, TS_AB), (AB + ':new', A.pk, B.pk, 7, T999),
                                (AC + ':new', A.pk, C.pk, 7, T999)])
        s = r['summary']
        self.assertEqual((s['role'], s['kind'], s['deal_id'], s['amount'], s['timestamp']), ('payer', 'transfer', DEAL, 3, T999))
        self.assertEqual((s['your_net_change_PC'], s['your_total_owed_change_PC']), (-3, 0))
        self.assertEqual(s['quote_digest'], qd())
        self.assertEqual(nv.pay_statement(DEAL, s['quote_digest']), f'valun-pilot/pay/1\n{DEAL}\n{qd()}')
        self.assertEqual([e['your_role'] for e in s['edges']], ['creditor', 'payer'])
        wa = r['write_ahead']
        self.assertEqual(wa['op'], 'pay:' + DEAL)
        # R4: the group with the prior slot also records the prior state its PA acknowledges
        self.assertEqual(wa['signed'], [{'edge': AB, 'timestamp': T999, 'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7},
                                         'prior_state': {'total': 10, 'timestamp': TS_AB}},
                                        {'edge': AC, 'timestamp': T999, 'op': 'pay:' + DEAL, 'slots': {AC + ':new': 7}}])
        self.assertEqual(wa['pending'], [{'pair': AB, 'total': 7, 'timestamp': T999, 'kind': 'transfer', 'ref': DEAL,
                                          'direction': 'in'}])
        self.assertEqual(wa['attempt'], {'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10,
                                         'prior_timestamp': TS_AB, 'prior_signature': st(A, B, 10, TS_AB)['signature'],
                                         'total': 7, 'timestamp': T999, 'quote_digest': qd(), 'ack': ACK})
        self.assertEqual(wa['attempts_seen'], [])

    def test_payer_template_ignores_the_server_hex(self):
        tpl = edit(payer_tpl(), set_(['messages'], {AB + ':new': vb.note_message(bytes.fromhex(A.pk), bytes.fromhex(B.pk), 1, 1, bytes.fromhex(NFT), DENOM).hex()}))
        r = PT(tpl, payer_ctx())
        self.assertEqual(r['to_sign'][1], (AB + ':new', A.pk, B.pk, 7, T999))     # R1: what was checked, not the hex

    def test_bound_note(self):
        r = BT(bound_tpl(), payer_ctx())
        self.assertSigns(r, B, [(BC + ':prior', B.pk, C.pk, 6, T997, TS_BC), (BC + ':new', B.pk, C.pk, 9, T997)])
        s = r['summary']
        self.assertEqual((s['kind'], s['your_net_change_PC'], s['your_total_owed_change_PC']), ('bound_note', -3, 3))
        self.assertEqual(r['write_ahead']['attempt'], {'deal_id': DEAL, 'route': 'note', 'edge': BC, 'prior': 6,
                                                       'prior_timestamp': TS_BC, 'prior_signature': st(B, C, 6, TS_BC)['signature'],
                                                       'total': 9, 'timestamp': T997, 'quote_digest': None, 'ack': ACK})
        self.assertEqual(r['write_ahead']['pending'], [{'pair': BC, 'total': 9, 'timestamp': T997, 'kind': 'note',
                                                        'ref': DEAL, 'direction': 'out'}])
        self.assertEqual(r['write_ahead']['signed'], [{'edge': BC, 'timestamp': T997, 'op': 'note:' + DEAL,
                                                       'slots': {BC + ':prior': 6, BC + ':new': 9},
                                                       'prior_state': {'total': 6, 'timestamp': TS_BC}}])
        r = BT(bound_tpl(prior=False), payer_ctx())
        self.assertSigns(r, B, [(BC + ':prior', B.pk, C.pk, 0, T997, 0), (BC + ':new', B.pk, C.pk, 3, T997)])
        self.assertEqual(r['write_ahead']['signed'][0]['prior_state'], {'total': 0, 'timestamp': 0})     # (0, 0): no edge

    def test_issuer(self):
        r = CO(issuer_item(), issuer_ctx())
        self.assertSigns(r, A, [(AB + ':new', A.pk, B.pk, 7, T999), (AC + ':new', A.pk, C.pk, 7, T999)])
        self.assertEqual((r['summary']['your_net_change_PC'], r['summary']['your_total_owed_change_PC']), (0, 0))
        self.assertIsNone(r['write_ahead']['attempt'])
        # the decreased edge comes first even when the item lists the raised one first
        swapped = edit(issuer_item(), lambda o: o['edges'].reverse())
        self.assertEqual([s[0] for s in CO(swapped, issuer_ctx())['to_sign']], [AB + ':new', AC + ':new'])

    def test_payee(self):
        r = CO(payee_item(), payee_ctx())
        self.assertSigns(r, C, [(AC + ':prior', A.pk, C.pk, 4, T999, TS_AC), (AC + ':new', A.pk, C.pk, 7, T999)])
        self.assertEqual((r['summary']['your_net_change_PC'], r['summary']['deal_id']), (3, DEAL))
        self.assertEqual(r['write_ahead']['signed'], [{'edge': AC, 'timestamp': T999, 'op': 'transfer:' + TID,
                                                       'slots': {AC + ':prior': 4, AC + ':new': 7},
                                                       'prior_state': {'total': 4, 'timestamp': TS_AC}}])
        r = CO(payee_item(Y=None), payee_ctx())
        self.assertSigns(r, C, [(AC + ':prior', A.pk, C.pk, 0, T999, 0), (AC + ':new', A.pk, C.pk, 3, T999)])

    def test_payer_consent(self):
        r = CO(payer_item(), regen_ctx())
        self.assertSigns(r, B, [(AB + ':prior', A.pk, B.pk, 10, T999, TS_AB), (AB + ':new', A.pk, B.pk, 7, T999),
                                (AC + ':new', A.pk, C.pk, 7, T999)])
        self.assertEqual(r['summary']['quote_digest'], qd())

    def test_member(self):
        r = CO(member_item(), member_ctx())
        self.assertSigns(r, B, [(AB + ':new', A.pk, B.pk, 8, T998), (BE + ':new', B.pk, E.pk, 3, T998)])
        s = r['summary']
        self.assertEqual((s['amount'], s['your_net_change_PC'], s['your_total_owed_change_PC'], s['timestamp']), (2, 0, -2, T998))
        self.assertEqual([p['direction'] for p in r['write_ahead']['pending']], ['in', 'out'])

    def test_a_three_edge_member_with_its_own_timestamps(self):
        # B is creditor of A (falls 3) and of E (falls 1), and owes 4 to C: balanced; per-edge timestamps
        t1, t2, t3 = T998, T998 - 1000, T998 - 2000
        it = item('setoff', SID, 'member',
                  [row(A, B, 10, TS_AB, 7, t1, 'creditor', ['new'], (A_ID, B_ID)),
                   row(E, B, 6, TS_BE, 5, t2, 'creditor', ['new'], (E_ID, B_ID)),
                   row(B, C, 9, TS_BC, 5, t3, 'issuer', ['new'], (B_ID, C_ID))], {})
        r = CO(it, member_ctx())
        self.assertSigns(r, B, [(AB + ':new', A.pk, B.pk, 7, t1), (EB + ':new', E.pk, B.pk, 5, t2), (BC + ':new', B.pk, C.pk, 5, t3)])
        self.assertIsNone(r['summary']['timestamp'])

    def test_already_signed_slots_are_left_out(self):
        it = edit(payee_item(), set_(['edges', 0, 'signed_by_you'], ['prior']))
        self.assertEqual([s[0] for s in CO(it, payee_ctx())['to_sign']], [AC + ':new'])
        it = edit(member_item(), set_(['edges', 0, 'signed_by_you'], ['new']))
        self.assertEqual([s[0] for s in CO(it, member_ctx())['to_sign']], [BE + ':new'])
        # the payer of a regenerated transfer, too (its write-ahead still records all three slots: R4)
        it = edit(payer_item(), set_(['edges', 0, 'signed_by_you'], ['prior']))
        r = CO(it, regen_ctx())
        self.assertEqual([s[0] for s in r['to_sign']], [AB + ':new', AC + ':new'])
        self.assertEqual(r['write_ahead']['signed'][0]['slots'], {AB + ':prior': 10, AB + ':new': 7})

    def test_the_seven_transfer_slots_agree_across_roles(self):
        """The payer's, the issuer's and the payee's messages are the seven slots of one tracker request (18.6)."""
        payer = nv.slot_messages(PT(payer_tpl(), payer_ctx())['to_sign'], NFT, DENOM)
        issuer = nv.slot_messages(CO(issuer_item(), issuer_ctx())['to_sign'], NFT, DENOM)
        payee = nv.slot_messages(CO(payee_item(), payee_ctx())['to_sign'], NFT, DENOM)
        self.assertEqual(payer[AB + ':new'], issuer[AB + ':new'])              # from_recipient = issuer_from
        self.assertEqual(payer[AC + ':new'], issuer[AC + ':new'])              # from_recipient_to = issuer_to
        self.assertEqual(payee[AC + ':new'], issuer[AC + ':new'])              # to_recipient = issuer_to
        # tracker v3.2: the two prior slots are PA over each edge's total and timestamp at T, never M(A,B,X,T)
        self.assertEqual(payer[AB + ':prior'], nv.prior_message(A.pk, B.pk, 10, TS_AB, T999, NFT, DENOM))
        self.assertEqual(payee[AC + ':prior'], nv.prior_message(A.pk, C.pk, 4, TS_AC, T999, NFT, DENOM))
        self.assertNotIn(nv.message(A.pk, B.pk, 10, T999, NFT, DENOM), {*payer.values(), *issuer.values(), *payee.values()})
        self.assertEqual(len({*payer.values(), *issuer.values(), *payee.values()}), 4)   # 7 slots over 4 messages

    def test_slot_messages_never_sign_a_prior_slot_as_a_note_message(self):
        to_sign = PT(payer_tpl(), payer_ctx())['to_sign']
        with self.assertRaises(ValueError):                              # a prior slot without its prior timestamp
            nv.slot_messages([to_sign[0][:5]] + to_sign[1:], NFT, DENOM)
        with self.assertRaises(ValueError):                              # a new slot with one
            nv.slot_messages([to_sign[0], to_sign[1] + (TS_AB,)], NFT, DENOM)
        msgs = nv.slot_messages(to_sign, NFT, DENOM)
        self.assertEqual([len(m) for m in msgs.values()], [105, 80, 80])


class Freshness(unittest.TestCase):
    """R5 boundaries: 10 minutes back for what the client starts, 55 for a consent, 5 seconds ahead for both."""

    def test_windows(self):
        T = T999
        for now, ok in ((T + 600_000, True), (T + 600_001, False), (T - 5_000, True), (T - 5_001, False)):
            with self.subTest(now=now - T):
                self.assertEqual(PT(payer_tpl(T=T), payer_ctx(now=now))['code'], None if ok else 'timestamp_stale')
        for now, ok in ((T + 3_300_000, True), (T + 3_300_001, False), (T - 5_000, True), (T - 5_001, False)):
            with self.subTest(consent=now - T):
                self.assertEqual(CO(issuer_item(T=T), issuer_ctx(now_ms=now))['code'], None if ok else 'timestamp_stale')


class AttemptOutcome(unittest.TestCase):
    """D-1: how an earlier attempt stands, from the current state of the edge it would change."""

    def test_transfer_and_bound_note_attempts(self):
        T = T_OLD
        late = T + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1
        for route, edge in (('transfer', AB), ('note', BC)):
            a = attempt(route, edge, 10, 7, T if route == 'transfer' else T - 2)    # T - 2 ends in 997
            t = a['timestamp']
            late_a = t + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1
            table = [
                (None, NOW, 'alive'), (None, late_a, 'unread'),
                ({'total': 10, 'timestamp': t - 5}, NOW, 'alive'), ({'total': 10, 'timestamp': t - 5}, late_a, 'dead'),
                ({'total': 12, 'timestamp': t - 5}, NOW, 'alive'), ({'total': 12, 'timestamp': t - 5}, late_a, 'dead'),
                ({'total': 0, 'timestamp': 0}, late_a, 'dead'),
                ({'total': 7, 'timestamp': t}, NOW, 'applied'), ({'total': 8, 'timestamp': t}, late_a, 'unknown'),
                # D-2 a: past T only its exact new state proves it applied, and its prior total no longer proves it did
                # not (D-1 said 'applied' and 'alive' / 'dead' for these three)
                ({'total': 7, 'timestamp': t + 1}, late_a, 'unknown'),
                ({'total': 10, 'timestamp': t + 1}, NOW, 'unknown'), ({'total': 10, 'timestamp': t + 1}, late_a, 'unknown'),
                ({'total': 5, 'timestamp': t + 1}, NOW, 'unknown'),
                ({'total': 10, 'timestamp': t - 5}, late_a - 1, 'alive'),        # now == T + 1 h + 2 min: not yet dead
            ]
            for state, now, expected in table:
                with self.subTest(route=route, state=state, now=now - t):
                    self.assertEqual(nv.attempt_outcome(a, now, state), expected)
            self.assertEqual(nv.attempt_outcome(dict(a, outcome='applied'), NOW, {'total': 10, 'timestamp': t - 5}), 'applied')
        self.assertLess(T, late)

    def test_the_owner_resolves_an_unknown_outcome(self):
        a = attempt('transfer', AB, 10, 7, T_OLD, outcome='not_applied')
        late = T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1
        moved = {'total': 13, 'timestamp': T_OLD + 1000}                   # unknown without the owner's decision
        self.assertEqual(nv.attempt_outcome(dict(a, outcome=None), late, moved), 'unknown')
        self.assertEqual(nv.attempt_outcome(a, late, moved), 'dead')
        self.assertEqual(nv.attempt_outcome(a, late, None), 'dead')
        self.assertEqual(nv.attempt_outcome(a, late - 1, moved), 'alive')   # its window must still pass
        self.assertEqual(nv.attempt_outcome(a, late, {'total': 7, 'timestamp': T_OLD}), 'applied')   # evidence wins
        # through an evaluator: the deal can be paid another way once the window has passed
        attempts = {DEAL: [a]}
        edges = {AB: st(A, B, 13, T_OLD + 1000)}
        self.assertEqual(BT(bound_tpl(), payer_ctx(transfer_attempts=attempts, edges=edges))['code'], 'transfer_window_open')
        self.assertTrue(BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges=edges))['ok'])
        unresolved = {DEAL: [dict(a, outcome=None)]}
        self.assertEqual(BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=unresolved, edges=edges))['code'],
                         'attempt_outcome_unknown')
        # an ordinary note never expires: the owner's decision frees the deal only once its edge has moved past it
        o = attempt('note', BC, 6, 9, NOW - 50_000, outcome='not_applied')
        far = NOW + 10 * nv.MAX_AGE_MS
        self.assertEqual(nv.attempt_outcome(o, far, None), 'alive')
        self.assertEqual(nv.attempt_outcome(o, far, {'total': 6, 'timestamp': NOW - 60_000}), 'alive')
        self.assertEqual(nv.attempt_outcome(o, NOW, {'total': 20, 'timestamp': NOW - 40_000}), 'dead')

    def test_an_ordinary_note_never_expires(self):
        a = attempt('note', BC, 6, 9, NOW - 50_000)                 # ends in 123: an ordinary note
        far = NOW + 10 * nv.MAX_AGE_MS
        self.assertEqual(nv.attempt_outcome(a, far, None), 'alive')
        self.assertEqual(nv.attempt_outcome(a, far, {'total': 6, 'timestamp': NOW - 60_000}), 'alive')
        # moved past it, back at its prior total: D-1 said 'dead'; D-2 a: it may have applied in between
        self.assertEqual(nv.attempt_outcome(a, NOW, {'total': 6, 'timestamp': NOW - 40_000}), 'unknown')
        self.assertEqual(nv.attempt_outcome(a, NOW, {'total': 9, 'timestamp': NOW - 50_000}), 'applied')


class OneLivePaymentAttempt(unittest.TestCase):
    """D-1 through the evaluators: one live payment attempt per deal, across kinds."""

    def test_a_held_bound_note_that_failed_is_retried_with_the_same_prior(self):   # D-1 item 4
        for age in (30_000, nv.MAX_AGE_MS + 10 * 60_000):               # still usable, or long expired
            earlier = attempt('note', BC, 6, 9, res(NOW - age, 997))
            # the template shows the prior the earlier note acknowledged: a state older than that note (D-2 a: a state
            # at a later timestamp would be another one, even at the same total; see test_d2a_*)
            tpl = edit(bound_tpl(), set_(['prior_note'], st(B, C, 6, earlier['timestamp'] - 5_000)))
            r = BT(tpl, payer_ctx(transfer_attempts={DEAL: [earlier]}))
            self.assertTrue(r['ok'], (age, r['summary']['reason']))

    def test_a_bound_note_on_a_moved_edge_waits_for_the_earlier_one(self):
        earlier = attempt('note', BC, 5, 8, res(NOW - 30_000, 997))      # acknowledged 5; the edge is now at 6
        r = BT(bound_tpl(), payer_ctx(transfer_attempts={DEAL: [earlier]}))
        self.assertEqual(r['code'], 'transfer_window_open')
        self.assertEqual(r['summary']['retry_after_ms'], earlier['timestamp'] + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW)

    def test_an_own_note_waits_for_an_earlier_transfer_then_needs_a_read_back(self):
        attempts = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}
        r = BT(bound_tpl(), payer_ctx(transfer_attempts=attempts))
        self.assertEqual(r['code'], 'transfer_window_open')
        self.assertEqual(r['summary']['retry_after_ms'], T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW)
        # after the window: still refused until the held edge is read back
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts))
        self.assertEqual((r['code'], r['summary']['needs_read_back'], r['summary']['retry_after_ms']),
                         ('transfer_window_open', [AB], 0))
        # read back: the held edge is still at the attempt's prior state, so it never applied
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 10, TS_AB)}))
        self.assertTrue(r['ok'], r['summary']['reason'])
        # read back: it applied
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 7, T_OLD)}))
        self.assertEqual(r['code'], 'already_paid')
        self.assertEqual(r['summary']['paid_deals'], {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T_OLD}})
        # read back: moved past it to a total that is neither its prior nor its new one
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 13, T_OLD + 1000)}))
        self.assertEqual(r['code'], 'attempt_outcome_unknown')
        # a read-back that is not the issuer's signature is refused
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 10, TS_AB, signer=E)}))
        self.assertEqual(r['code'], 'bad_prior_signature')

    def test_a_transfer_waits_for_an_earlier_own_note(self):
        attempts = {DEAL: [attempt('note', BC, 6, 9, res(NOW - 30_000, 997), prior_timestamp=TS_BC)]}
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=attempts))['code'], 'transfer_window_open')
        late = attempts[DEAL][0]['timestamp'] + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 5_000
        r = PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=attempts))
        self.assertEqual((r['code'], r['summary']['needs_read_back']), ('transfer_window_open', [BC]))
        r = PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=attempts, edges={BC: st(B, C, 6, TS_BC)}))
        self.assertTrue(r['ok'], r['summary']['reason'])
        # a read-back older than the state the attempt acknowledged is stale (timestamps only increase): no read-back
        for stale in (None, st(B, C, 5, TS_BC - 1)):
            r = PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=attempts, edges={BC: stale}))
            self.assertEqual((r['code'], r['summary']['needs_read_back']), ('transfer_window_open', [BC]))
        # nor is one older than my own confirmed state of the edge
        recs = {BC: {'confirmed': {'total': 6, 'timestamp': TS_BC + 7, 'signature': 'aa'}, 'pending': []}}
        r = PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=attempts, records=recs, edges={BC: st(B, C, 6, TS_BC)}))
        self.assertEqual(r['code'], 'transfer_window_open')
        # a first note on a new edge: the absent edge is its prior state
        attempts0 = {DEAL: [attempt('note', BC, 0, 3, res(NOW - 30_000, 997), prior_timestamp=0)]}
        r = PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=attempts0, edges={BC: None}))
        self.assertTrue(r['ok'], r['summary']['reason'])

    def test_my_confirmed_state_past_the_attempt_is_a_read_back(self):
        attempts = {DEAL: [attempt('transfer', EB, 9, 6, T_OLD, prior_timestamp=TS_AB)]}
        # D-2 a: past T, the prior total (D-1: signed) and the new total (D-1: already_paid) are other states too
        for total, code in ((9, 'attempt_outcome_unknown'), (6, 'attempt_outcome_unknown'), (2, 'attempt_outcome_unknown')):
            recs = {EB: {'confirmed': {'total': total, 'timestamp': T_OLD + 1000, 'signature': 'aa'}, 'pending': []}}
            r = PT(payer_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, records=recs))
            self.assertEqual(r['code'], code, total)

    def test_same_issuer_retries(self):
        # tracker v3.2 (audit VS-1 closed): the same prior state of the held edge (total and timestamp) at another T is
        # excluded at the tracker: signed at once
        same = {DEAL: [full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB), qd())]}
        r = PT(payer_tpl(), payer_ctx(transfer_attempts=same))
        self.assertTrue(r['ok'], r['summary']['reason'])
        # the same state recorded without ack (a record of a build that may have signed v3.1's M(A,B,X,T) there, or of
        # the first v3.2 build): treated as before tracker v3.2, it waits for its window
        unmarked = {DEAL: [{k: v for k, v in same[DEAL][0].items() if k != 'ack'}]}
        r = PT(payer_tpl(), payer_ctx(transfer_attempts=unmarked))
        self.assertEqual((r['code'], r['summary']['retry_after_ms']),
                         ('transfer_window_open', T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW))
        # ... once: past its window, read back at its prior state, the retry is signed
        r = PT(payer_tpl(now=LATE, T=res(LATE - 1500, 999)), payer_ctx(now=LATE, transfer_attempts=unmarked,
                                                                       edges={AB: st(A, B, 10, TS_AB)}))
        self.assertTrue(r['ok'], r['summary']['reason'])
        # the same total recorded without its state's timestamp: not shown to be the same state, it waits
        totals_only = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}
        r = PT(payer_tpl(), payer_ctx(transfer_attempts=totals_only))
        self.assertEqual(r['code'], 'transfer_window_open')
        self.assertEqual(r['summary']['retry_after_ms'], T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW)
        # the same total at another timestamp of the edge (it moved and came back before T_OLD): it waits
        other_state = {DEAL: [full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB - 1000), qd())]}
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=other_state))['code'], 'transfer_window_open')
        # another kind (an own bound note) on the same deal still waits for that note's window
        note = {DEAL: [full('note', BC, 6, 9, res(NOW - 30_000, 997), st(B, C, 6, TS_BC))]}
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=note))['code'], 'transfer_window_open')
        # the identical operation signed again (same prior, same T): at once
        again = {DEAL: [attempt('transfer', AB, 10, 7, T999, qd())]}
        self.assertTrue(PT(payer_tpl(), payer_ctx(transfer_attempts=again))['ok'])
        other = {DEAL: [attempt('transfer', AB, 12, 9, T_OLD, qd())]}                    # the edge moved since
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=other))['code'], 'transfer_window_open')
        moved_past = {DEAL: [attempt('transfer', AB, 12, 9, T_OLD - 30_000, qd())]}
        tpl = edit(payer_tpl(), set_(['from_edge', 'before'], st(A, B, 10, T_OLD - 10_001)))   # 12 -> 10 after it: unknown
        self.assertEqual(PT(tpl, payer_ctx(transfer_attempts=moved_past))['code'], 'attempt_outcome_unknown')

    def test_the_held_edge_shows_the_earlier_attempt_applied(self):
        attempts = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}
        tpl = edit(payer_tpl(X=7), set_(['from_edge', 'before'], st(A, B, 7, T_OLD)))
        r = PT(tpl, payer_ctx(transfer_attempts=attempts))
        self.assertEqual(r['code'], 'already_paid')
        self.assertEqual(r['summary']['paid_deals'][DEAL]['route'], 'transfer')
        # the same from the pending entry alone (no attempt record): my held claim is at the decrease I signed
        recs = {AB: {'confirmed': None, 'pending': [pending(7, T_OLD, kind='transfer', direction='in')]}}
        r = PT(tpl, payer_ctx(records=recs))
        self.assertEqual(r['code'], 'already_paid')
        self.assertEqual(r['summary']['applied'][0]['pair'], AB)

    def test_my_records_confirm_an_attempt(self):
        attempts = {DEAL: [attempt('transfer', EB, 9, 6, T_OLD)]}
        recs = {EB: {'confirmed': {'total': 6, 'timestamp': T_OLD, 'signature': 'aa'}, 'pending': []}}
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=attempts, records=recs))['code'], 'already_paid')
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts={DEAL: [attempt('transfer', EB, 9, 6, T_OLD, outcome='applied')]}))['code'],
                         'already_paid')

    def test_an_unexpiring_ordinary_note_blocks_other_payments(self):
        recs = {BC: {'confirmed': None, 'pending': [pending(9, NOW - 50_000)]}}      # ordinary, prior 9 - 3 = 6
        far = NOW + 3 * nv.MAX_AGE_MS
        self.assertEqual(PT(payer_tpl(now=far), payer_ctx(now=far, records=recs))['code'], 'attempt_outcome_unknown')
        r = PT(payer_tpl(now=far), payer_ctx(now=far, records=recs, edges={BC: st(B, C, 6, NOW - 40_000)}))
        # the edge moved past it, back at its prior: D-1 signed (it never can apply now); D-2 a: it may have applied
        # in between, so only the owner can free the deal
        self.assertEqual(r['code'], 'attempt_outcome_unknown')
        r = PT(payer_tpl(now=far), payer_ctx(now=far, records=recs, edges={BC: st(B, C, 9, NOW - 50_000)}))
        self.assertEqual(r['code'], 'already_paid')

    def test_paid_deals_refuse_every_payer_path(self):
        paid = {'paid_deals': {DEAL: {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': T997}}}
        self.assertEqual(BT(bound_tpl(), payer_ctx(records=paid))['code'], 'already_paid')
        self.assertEqual(PT(payer_tpl(), payer_ctx(records=paid))['code'], 'already_paid')
        self.assertEqual(CO(payer_item(), regen_ctx(records=paid))['code'], 'already_paid')
        self.assertEqual(nv.check_payment(DEAL, PRICE, 'note', BC, 6, payer_ctx(records=paid))['code'], 'already_paid')
        # other deals are not affected
        other = {'paid_deals': {'vd_ffffffffffffffff': paid['paid_deals'][DEAL]}}
        self.assertTrue(BT(bound_tpl(), payer_ctx(records=other))['ok'])


def full(route, edge, prior, total, timestamp, prior_state, quote=None, deal_id=DEAL):
    """An attempt record as 0.4.0 writes it: with the full state it acknowledged (decision D-2 a) and ack, its prior
    slot signed as PA (tracker v3.2)."""
    return dict(attempt(route, edge, prior, total, timestamp, quote), deal_id=deal_id,
                prior_timestamp=prior_state['timestamp'], prior_signature=prior_state['signature'], ack=ACK)


class D2aFullEdgeStates(unittest.TestCase):
    """Decision D-2 a: attempts are classified on full edge states (total, timestamp, signature)."""

    def test_a_same_prior_retry_needs_exactly_the_acknowledged_state(self):
        s0 = st(A, B, 10, TS_AB)
        earlier = {DEAL: [full('transfer', AB, 10, 7, T999, s0, qd())]}        # signed again at the same T (VS-1)
        self.assertTrue(PT(payer_tpl(), payer_ctx(transfer_attempts=earlier))['ok'])         # the edge is exactly s0
        # the same total at a later timestamp (before the earlier T): the edge moved and came back, the earlier attempt
        # could have applied in between (D-1 signed this)
        later = edit(payer_tpl(), set_(['from_edge', 'before'], st(A, B, 10, TS_AB + 5)))
        self.assertEqual(PT(later, payer_ctx(transfer_attempts=earlier))['code'], 'attempt_outcome_unknown')
        # the same total and timestamp but not the signature recorded
        other_sig = {DEAL: [dict(earlier[DEAL][0], prior_signature='ab' * 64)]}
        self.assertEqual(PT(payer_tpl(), payer_ctx(transfer_attempts=other_sig))['code'], 'attempt_outcome_unknown')
        # a regenerated transfer (the payer's consent) follows the same rule
        self.assertTrue(CO(payer_item(), regen_ctx(transfer_attempts=earlier))['ok'])
        moved = edit(payer_item(), set_(['edges', 0, 'before'], st(A, B, 10, TS_AB + 5)))
        self.assertEqual(CO(moved, regen_ctx(transfer_attempts=earlier))['code'], 'attempt_outcome_unknown')

    def test_a_record_without_a_prior_signature_is_compared_on_total_and_timestamp(self):
        # An attempt record of the 0.4 development builds before D-2: prior_timestamp, but no prior_signature.
        earlier = {DEAL: [attempt('transfer', AB, 10, 7, T999, qd(), prior_timestamp=TS_AB)]}   # the same T (VS-1)
        self.assertNotIn('prior_signature', earlier[DEAL][0])
        self.assertTrue(PT(payer_tpl(), payer_ctx(transfer_attempts=earlier))['ok'])        # exactly (10, TS_AB)
        # the same prior total at another timestamp, still before the earlier T: another state of the edge
        later = edit(payer_tpl(), set_(['from_edge', 'before'], st(A, B, 10, TS_AB + 5)))
        self.assertEqual(PT(later, payer_ctx(transfer_attempts=earlier))['code'], 'attempt_outcome_unknown')
        self.assertFalse(nv.exact_prior(earlier[DEAL][0], st(A, B, 10, TS_AB + 5)))
        self.assertTrue(nv.exact_prior(earlier[DEAL][0], st(A, B, 10, TS_AB)))

    def test_an_acknowledged_absent_edge_must_still_be_absent(self):
        first = {DEAL: [full('note', BC, 0, 3, res(NOW - 30_000, 997), {'timestamp': 0, 'signature': None})]}
        self.assertTrue(BT(bound_tpl(prior=False), payer_ctx(transfer_attempts=first))['ok'])
        self.assertEqual(nv.exact_prior(first[DEAL][0], {'total': 0, 'timestamp': 0}), True)
        self.assertEqual(nv.exact_prior(first[DEAL][0], st(B, C, 0, TS_BC)), False)

    def test_moved_past_the_attempt_back_to_its_prior_is_unknown(self):
        attempts = {DEAL: [full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB), qd())]}
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 10, T_OLD + 1000)}))
        self.assertEqual(r['code'], 'attempt_outcome_unknown')          # D-1 signed: 'moved past T at the prior total'
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: st(A, B, 7, T_OLD + 1000)}))
        self.assertEqual(r['code'], 'attempt_outcome_unknown')          # D-1: already_paid ('moved past T to its new total')

    def test_my_own_later_note_on_the_same_prior_proves_an_attempt_dead(self):
        # Deal DEAL's note N1 (prior s0) never applied: my note for another deal, N2, acknowledged the same s0 later and
        # applied, and nothing else of mine changed B>C in between (only my signature lowers it).
        s0 = st(B, C, 6, TS_BC)
        t1, t2 = res(NOW - 50_000, 997), res(NOW - 20_000, 997)
        n1 = full('note', BC, 6, 9, t1, s0)
        n2 = full('note', BC, 6, 9, t2, s0, deal_id='vd_2222222222222222')
        attempts = {DEAL: [n1], 'vd_2222222222222222': [n2]}
        now_state = st(B, C, 9, t2)                                     # N2's new state
        tpl = edit(bound_tpl(), lambda o: o.update(prior_note=now_state, prior_total=9, total=12))
        r = BT(tpl, payer_ctx(transfer_attempts=attempts))
        self.assertTrue(r['ok'], r['summary']['reason'])
        self.assertEqual(list(r['summary']['paid_deals']), ['vd_2222222222222222'])     # and N2 is recorded as applied
        # no proof: a set-off of mine lowered B>C between the two notes (the edge could have come back to 6)
        signed = {BC: {str(t1 + 10_001): {'op': 'setoff:vs_ffffffffffffffff', 'slots': {BC + ':new': 6}}}}
        self.assertEqual(BT(tpl, payer_ctx(transfer_attempts=attempts, signed=signed))['code'], 'attempt_outcome_unknown')
        # no proof: N2 acknowledged another state
        other = dict(attempts, **{'vd_2222222222222222': [dict(n2, prior_timestamp=TS_BC + 1)]})
        self.assertEqual(BT(tpl, payer_ctx(transfer_attempts=other))['code'], 'attempt_outcome_unknown')
        # no proof: N2 did not apply (the edge shows another state)
        tpl2 = edit(bound_tpl(), lambda o: o.update(prior_note=st(B, C, 9, t2 + 1000), prior_total=9, total=12))
        self.assertEqual(BT(tpl2, payer_ctx(transfer_attempts=attempts))['code'], 'attempt_outcome_unknown')

    def test_an_item_showing_an_attempts_new_state_records_its_deal_paid(self):
        # The pending entry of my note was forgotten (a refused answer); its attempt record stays, and a set-off item
        # that shows B>E at exactly that note's new state proves the note applied.
        attempts = {'vd_cccccccccccccccc': [dict(attempt('note', BE, 2, 5, TS_BE), deal_id='vd_cccccccccccccccc')]}
        r = CO(member_item(), member_ctx(transfer_attempts=attempts))
        self.assertTrue(r['ok'], r['summary']['reason'])
        self.assertEqual(r['summary']['paid_deals'], {'vd_cccccccccccccccc': {'route': 'note', 'edge': BE, 'total': 5,
                                                                              'timestamp': TS_BE}})


class VS1SamePriorTransferRetries(unittest.TestCase):
    """Audit VS-1, closed by tracker v3.2. On tracker v3.1 the creditors' prior acknowledgments of a transfer were
    M(A,B,X,T) and M(A,C,Y,T), with no prior timestamp, and the tracker compared only the stored totals with them, so two
    transfers B signed for the same priors both applied when A->B and A->C came back to X and Y between T1 and T2 (A a
    note to B, C a transfer or set-off out of A->C), and the client held a same-issuer retry at a new T back for the
    earlier window. On v3.2 they are PA(A,B,X,p_AB,T) and PA(A,C,Y,p_AC,T) over the STORED total and timestamp: A->B is
    at (X, p_AB) at most once, so the first of the two to apply leaves the other dead for good, and the client signs a
    retry on the same prior state at once (the same-prior exemption, design v3.2 section 4). A retry on another prior
    state still waits."""

    @staticmethod
    def tracker_v32(edges, a, T, b_prior_sig, c_prior_sig):
        """A model of tracker v3.2 check_transfer's prior slots: B's and C's prior signatures verify over PA of each
        edge's stored total and timestamp (0, 0 for an absent edge) at T, and T is newer than both edges."""
        (X, p), (Y, q) = edges[AB], edges.get(AC, (0, 0))
        if T <= p or T <= q or not verify(B.pk, nv.prior_message(A.pk, B.pk, X, p, T, NFT, DENOM), b_prior_sig) \
                or not verify(C.pk, nv.prior_message(A.pk, C.pk, Y, q, T, NFT, DENOM), c_prior_sig):
            return False
        edges[AB], edges[AC] = (X - a, T), (Y + a, T)
        return True

    @staticmethod
    def tracker_v31(edges, a, T, b_prior_sig, c_prior_sig):
        """The tracker v3.1 check, for comparison: the prior signatures over M(A,B,X,T) and M(A,C,Y,T), stored totals."""
        (X, p), (Y, q) = edges[AB], edges.get(AC, (0, 0))
        if T <= p or T <= q or not verify(B.pk, nv.message(A.pk, B.pk, X, T, NFT, DENOM), b_prior_sig) \
                or not verify(C.pk, nv.message(A.pk, C.pk, Y, T, NFT, DENOM), c_prior_sig):
            return False
        edges[AB], edges[AC] = (X - a, T), (Y + a, T)
        return True

    @staticmethod
    def signed(k, msg):
        return vb.sign(msg, k.secret, bytes.fromhex(k.pk)).hex()

    def b_prior(self, r):
        """B's signature of the prior slot an evaluation of mine allowed, over the bytes slot_messages builds (R1)."""
        return self.signed(B, nv.slot_messages(r['to_sign'], NFT, DENOM)[AB + ':prior'])

    def c_prior(self, T):
        """C's signature of its prior slot of the transfer at T, as the payee's own client allows and builds it."""
        r = CO(payee_item(T=T), payee_ctx())
        self.assertTrue(r['ok'], r['summary']['reason'])
        return self.signed(C, nv.slot_messages(r['to_sign'], NFT, DENOM)[AC + ':prior'])

    @staticmethod
    def mine(state):
        return {k: copy.deepcopy(state.get(k)) for k in ('records', 'signed', 'transfer_attempts')}

    def test_both_edges_back_at_their_priors_between_T1_and_T2(self):
        T1, T2 = T_OLD, T999
        first = PT(payer_tpl(T=T1, now=T1 + 1500), payer_ctx(now=T1 + 1500))
        self.assertTrue(first['ok'], first['summary']['reason'])
        state = {}
        nv.apply_write_ahead(state, first['write_ahead'], 'x')
        # The client: attempt 2 at T2 acknowledges the same state of my claim on A, (10, TS_AB), as attempt 1 recorded:
        # it is signed at once (v3.1 clients refused it with transfer_window_open until T1 + 1 h + 2 min)
        second = PT(payer_tpl(T=T2), payer_ctx(**self.mine(state)))
        self.assertTrue(second['ok'], second['summary']['reason'])
        self.assertEqual(second['write_ahead']['attempts_seen'], [['transfer', AB, 7, T1]])
        self.assertEqual(second['write_ahead']['attempt']['prior_timestamp'], TS_AB)
        # the same as a regenerated transfer the server presents as a consent (under attempt 1's quote, still in window)
        c = CO(payer_item(T=T2), regen_ctx(**self.mine(state)))
        self.assertTrue(c['ok'], c['summary']['reason'])
        # The tracker v3.2 side, with the signatures these evaluations allow: attempt 1 applies; A raises A->B back to
        # 10 and C moves 3 out of A->C, both between T1 and T2; attempt 2 never applies (its PA names (10, TS_AB), and
        # A->B is now at (10, T1 + 10 000))
        edges = {AB: (10, TS_AB), AC: (4, TS_AC)}
        self.assertTrue(self.tracker_v32(edges, PRICE, T1, self.b_prior(first), self.c_prior(T1)))
        edges[AB], edges[AC] = (10, T1 + 10_000), (4, T1 + 20_000)
        self.assertFalse(self.tracker_v32(dict(edges), PRICE, T2, self.b_prior(second), self.c_prior(T2)))
        self.assertFalse(self.tracker_v32(dict(edges), PRICE, T2, self.b_prior(c), self.c_prior(T2)))
        # (tracker v3.1 applied it: its acknowledgments M(A,B,10,T2) and M(A,C,4,T2) match the stored totals again)
        self.assertTrue(self.tracker_v31(dict(edges), PRICE, T2, self.signed(B, nv.message(A.pk, B.pk, 10, T2, NFT, DENOM)),
                                         self.signed(C, nv.message(A.pk, C.pk, 4, T2, NFT, DENOM))))
        # and in the other order: attempt 2 first, then attempt 1 is older than the edge
        edges = {AB: (10, TS_AB), AC: (4, TS_AC)}
        self.assertTrue(self.tracker_v32(edges, PRICE, T2, self.b_prior(second), self.c_prior(T2)))
        self.assertFalse(self.tracker_v32(edges, PRICE, T1, self.b_prior(first), self.c_prior(T1)))

    def test_a_retry_on_another_prior_state_still_waits(self):
        T1, T2 = T_OLD, T999
        first = PT(payer_tpl(T=T1, now=T1 + 1500), payer_ctx(now=T1 + 1500))
        state = {}
        nv.apply_write_ahead(state, first['write_ahead'], 'x')
        # my claim on A is at the same total at another timestamp, before T1: another state (attempt 1 is dead on v3.2,
        # but nothing here proves that it did not apply): the retry waits for attempt 1's window, as before
        moved = edit(payer_tpl(T=T2), set_(['from_edge', 'before'], st(A, B, 10, TS_AB + 5)))
        r = PT(moved, payer_ctx(**self.mine(state)))
        self.assertEqual(r['code'], 'transfer_window_open')
        self.assertEqual(r['summary']['retry_after_ms'], T1 + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW)
        # another total: the same
        self.assertEqual(PT(payer_tpl(T=T2, X=12), payer_ctx(**self.mine(state)))['code'], 'transfer_window_open')
        # past T1 (attempt 1 may have applied in between): only the owner can resolve it
        past = edit(payer_tpl(T=T2), set_(['from_edge', 'before'], st(A, B, 10, T1 + 10_000)))
        self.assertEqual(PT(past, payer_ctx(**self.mine(state)))['code'], 'attempt_outcome_unknown')
        # the same state but another signature than attempt 1 recorded (D-2 a): only the owner can resolve it
        other_sig = edit(payer_tpl(T=T2), set_(['from_edge', 'before'], st(A, B, 10, TS_AB)))
        att = self.mine(state)
        att['transfer_attempts'][DEAL][0]['prior_signature'] = 'ab' * 64
        self.assertEqual(PT(other_sig, payer_ctx(**att))['code'], 'attempt_outcome_unknown')
        # past the window, with a read-back older than T1 (attempt 1 cannot apply any more), a new template is signed
        late = PT(payer_tpl(T=res(LATE - 1500, 999), now=LATE), payer_ctx(now=LATE, **self.mine(state)))
        self.assertTrue(late['ok'], late['summary']['reason'])

    def test_the_same_operation_signed_again_is_excluded(self):
        T1 = T999
        first = PT(payer_tpl(T=T1), payer_ctx())
        state = {}
        nv.apply_write_ahead(state, first['write_ahead'], 'x')
        again = PT(payer_tpl(T=T1, now=NOW + 2000), payer_ctx(now=NOW + 2000, **self.mine(state)))
        self.assertTrue(again['ok'], again['summary']['reason'])
        self.assertEqual(again['to_sign'], first['to_sign'])
        edges = {AB: (10, TS_AB), AC: (4, TS_AC)}
        self.assertTrue(self.tracker_v32(edges, PRICE, T1, self.b_prior(first), self.c_prior(T1)))
        edges[AB], edges[AC] = (10, T1 + 10_000), (4, T1 + 20_000)  # both back at their totals, after T1
        self.assertFalse(self.tracker_v32(edges, PRICE, T1, self.b_prior(again), self.c_prior(T1)))   # never again

    def test_two_bound_notes_on_the_same_prior_state_never_both_apply(self):
        # The bound-note analogue (the issuer-side twin of VS-1, readiness R-17): notes N1 (ts1) and N2 (ts2) of mine,
        # both on the prior state (6, TS_BC) of B->C. N2 is signed at once (the same-prior note retry, as before). On
        # v3.1 both applied if a set-off lowered B->C back to 6 in between; on v3.2 N2's PA(B,C,6,TS_BC,ts2) names a
        # state the edge never has again.
        ts1, ts2 = res(NOW - 60_000, 997), T997
        n1 = BT(bound_tpl(ts=ts1, now=ts1 + 1500), payer_ctx(now=ts1 + 1500))
        self.assertTrue(n1['ok'], n1['summary']['reason'])
        state = {}
        nv.apply_write_ahead(state, n1['write_ahead'], 'x')
        n2 = BT(bound_tpl(ts=ts2), payer_ctx(**self.mine(state)))
        self.assertTrue(n2['ok'], n2['summary']['reason'])

        def note(edge, r, ts):          # a model of tracker v3.2 POST /notes at residue 997 (bound note)
            P, p = edge[0]
            msgs = nv.slot_messages(r['to_sign'], NFT, DENOM)
            if ts <= p or not verify(B.pk, nv.prior_message(B.pk, C.pk, P, p, ts, NFT, DENOM), self.signed(B, msgs[BC + ':prior'])):
                return False
            edge[0] = (P + PRICE, ts)
            return True
        edge = [(6, TS_BC)]
        self.assertTrue(note(edge, n1, ts1))
        edge[0] = (6, res(ts1 + 10_000, 998))       # a set-off lowers B->C back to 6 between ts1 and ts2
        self.assertFalse(note(edge, n2, ts2))
        self.assertEqual(nv.slot_messages(n2['to_sign'], NFT, DENOM)[BC + ':prior'],
                         nv.prior_message(B.pk, C.pk, 6, TS_BC, ts2, NFT, DENOM))

    def test_a_bound_note_never_brings_my_edge_back_to_the_prior_of_a_live_bound_note(self):
        # The note route keeps its same-prior retry because only my signature moves my edge. Its twin of D-2 c: a bound
        # note for another deal that sets B->C to the prior a later bound note of mine acknowledged is refused (after a
        # set-off lowered the edge, that later note could otherwise apply on top of the note it retried).
        other = 'vd_00000000000000ee'
        later = dict(attempt('note', BC, 9, 12, res(NOW + 2000, 997), prior_timestamp=TS_BC), deal_id=other)
        r = BT(bound_tpl(), payer_ctx(transfer_attempts={other: [later]}))
        self.assertEqual(r['code'], 'payment_attempt')
        # not when that note is past its maximum age, applied, or acknowledged another total
        self.assertTrue(BT(bound_tpl(), payer_ctx(transfer_attempts={other: [dict(later, prior=8)]}))['ok'])
        self.assertTrue(BT(bound_tpl(), payer_ctx(transfer_attempts={other: [dict(later, outcome='applied')]}))['ok'])
        far = later['timestamp'] + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1
        self.assertTrue(BT(bound_tpl(now=far), payer_ctx(now=far, transfer_attempts={other: [later]}))['ok'])

    def test_a_same_prior_bound_note_retry_is_still_signed_at_once(self):
        earlier = {DEAL: [full('note', BC, 6, 9, res(NOW - 60_000, 997), st(B, C, 6, TS_BC))]}
        self.assertTrue(BT(bound_tpl(), payer_ctx(transfer_attempts=earlier))['ok'])


class ClassifyAttempts(unittest.TestCase):
    """classify_attempts: a deal's payment attempts as the payer evaluators weigh them (for `valun attempts list` and the
    owner's resolution)."""

    def test_the_deals_attempts_and_how_each_stands(self):
        a1 = full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB), qd())
        recs = {BC: {'confirmed': None, 'pending': [pending(9, NOW - 50_000)]}}         # an ordinary note, no record
        ctx = payer_ctx(transfer_attempts={DEAL: [a1]}, records=recs)
        r = nv.classify_attempts(DEAL, ctx)
        self.assertEqual((r['ok'], r['code']), (True, None))
        self.assertEqual([(x['attempt']['route'], x['attempt']['prior'], x['outcome']) for x in r['attempts']],
                         [('transfer', 10, 'alive'), ('note', None, 'alive')])
        self.assertIs(r['attempts'][0]['attempt'], a1)                  # the record itself, for the caller to update
        self.assertEqual(nv.classify_attempts(DEAL, ctx, price=PRICE)['attempts'][1]['attempt']['prior'], 6)
        self.assertEqual(nv.classify_attempts('vd_ffffffffffffffff', ctx)['attempts'], [])
        # a read-back past T at another state: unknown; the same, with my records holding the deal paid by it: applied
        moved = {AB: st(A, B, 12, T_OLD + 1000)}
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: [a1]}, edges=moved))['attempts'][0]
                         ['outcome'], 'unknown')
        paid = {'paid_deals': {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T_OLD}}}
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: [a1]}, records=paid, edges=moved))
                         ['attempts'][0]['outcome'], 'applied')
        other_paid = {'paid_deals': {DEAL: {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': T997}}}
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: [a1]}, records=other_paid,
                                                              edges=moved))['attempts'][0]['outcome'], 'unknown')
        # without pins the edges read cannot be verified: they are not used
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(pins=None, transfer_attempts={DEAL: [a1]}, edges=moved))
                         ['attempts'][0]['outcome'], 'alive')
        # past the window: an attempt that acknowledged an absent edge reads an absent edge as dead; one that
        # acknowledged a prior above 0 does not (no read-back)
        late = T_OLD + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1
        first = full('note', BC, 0, 3, T_OLD - 2, {'timestamp': 0, 'signature': None})
        r = nv.classify_attempts(DEAL, payer_ctx(now=late, transfer_attempts={DEAL: [first, a1]}, edges={BC: None, AB: None}))
        self.assertEqual([x['outcome'] for x in r['attempts']], ['dead', 'unread'])

    def test_my_own_records_prove_an_attempt_dead(self):
        s0 = st(B, C, 6, TS_BC)
        t1, t2 = res(NOW - 50_000, 997), res(NOW - 20_000, 997)
        attempts = {DEAL: [full('note', BC, 6, 9, t1, s0)], 'vd_2222222222222222': [full('note', BC, 6, 9, t2, s0,
                                                                                         deal_id='vd_2222222222222222')]}
        ctx = payer_ctx(transfer_attempts=attempts, edges={BC: st(B, C, 9, t2)})
        self.assertEqual(nv.attempt_outcome(attempts[DEAL][0], NOW, st(B, C, 9, t2)), 'unknown')
        self.assertEqual(nv.classify_attempts(DEAL, ctx)['attempts'][0]['outcome'], 'dead')
        self.assertEqual(nv.classify_attempts('vd_2222222222222222', ctx)['attempts'][0]['outcome'], 'applied')

    def test_what_cannot_be_read_or_verified_is_refused(self):
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: 'x'})),
                         {'ok': False, 'code': 'records_unreadable', 'attempts': []})
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: [{'route': 'x'}]}))['code'],
                         'records_unreadable')
        a1 = full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB), qd())
        self.assertEqual(nv.classify_attempts(DEAL, payer_ctx(transfer_attempts={DEAL: [a1]},
                                                              edges={AB: st(A, B, 12, T_OLD + 1000, signer=E)}))['code'],
                         'bad_prior_signature')
        for deal, price in (('', None), (None, None), (DEAL, 0), (DEAL, 2.5), (DEAL, True)):
            self.assertEqual(nv.classify_attempts(deal, payer_ctx(), price=price)['code'], 'bad_template', (deal, price))


class AbsentReadBack(unittest.TestCase):
    def test_an_absent_edge_is_no_read_back_for_an_attempt_that_acknowledged_a_prior_above_0(self):
        # my held-edge decrease is pending (no attempt record): its prior was 10, so A>B existed
        recs = {AB: {'confirmed': None, 'pending': [pending(7, T_OLD, kind='transfer', direction='in')]}}
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, records=recs, edges={AB: None}))
        self.assertEqual((r['code'], r['summary']['needs_read_back']), ('transfer_window_open', [AB]))
        attempts = {DEAL: [full('transfer', AB, 10, 7, T_OLD, st(A, B, 10, TS_AB), qd())]}
        r = BT(bound_tpl(now=LATE), payer_ctx(now=LATE, transfer_attempts=attempts, edges={AB: None}))
        self.assertEqual((r['code'], r['summary']['needs_read_back']), ('transfer_window_open', [AB]))
        # a first note on a new edge acknowledged an absent edge: absent is its read-back
        first = {DEAL: [full('note', BC, 0, 3, res(NOW - 30_000, 997), {'timestamp': 0, 'signature': None})]}
        late = first[DEAL][0]['timestamp'] + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 5_000
        self.assertTrue(PT(payer_tpl(now=late), payer_ctx(now=late, transfer_attempts=first, edges={BC: None}))['ok'])


class SummaryIds(unittest.TestCase):
    def test_ids_are_copied_only_in_their_format(self):
        r = CO(member_item(), member_ctx())
        self.assertEqual(r['summary']['id'], SID)
        for bad in ('vs_1', 'vs_0123456789ABCDEF', 'vs_0123456789abcdef\nPAY 99', 'setoff 7'):
            r = CO(edit(member_item(), set_(['id'], bad)), member_ctx())
            self.assertTrue(r['ok'])                               # the id is not signed; it is only not shown
            self.assertIsNone(r['summary']['id'], bad)
        r = BT(edit(bound_tpl(), set_(['deal_id'], 'vd_ff\nPAY')), payer_ctx())
        self.assertEqual((r['code'], r['summary']['deal_id']), ('deal_mismatch', None))
        # the payer roles: a transfer template, and a regenerated transfer whose deal id is the server's context.deal text
        r = PT(edit(payer_tpl(), set_(['deal_id'], 'vd_ff\nPAY')), payer_ctx())
        self.assertEqual((r['code'], r['summary']['deal_id']), ('deal_mismatch', None))
        r = CO(edit(payer_item(), set_(['context', 'deal', 'deal_id'], 'vd_ff\nPAY')), regen_ctx())
        self.assertEqual((r['code'], r['summary']['deal_id']), ('deal_mismatch', None))
        self.assertEqual(nv.check_payment('vd_x', PRICE, 'note', BC, 6, payer_ctx())['summary']['deal_id'], None)
        self.assertEqual(nv.shown_id('vt_0123456789abcdef'), 'vt_0123456789abcdef')
        self.assertIsNone(nv.shown_id('vp_0123456789abcdef'))      # a participant id is not one of these


class WriteAheadConflicts(unittest.TestCase):
    """apply_write_ahead re-checks what it writes against the state as it is now (two evaluations on one snapshot)."""

    def test_another_operation_at_the_same_edge_and_timestamp(self):
        one = CO(member_item(), member_ctx())
        two = CO(edit(member_item(), set_(['id'], 'vs_1111111111111111')), member_ctx())
        self.assertTrue(one['ok'] and two['ok'])                       # both evaluated on the same (stale) snapshot
        state = {}
        nv.apply_write_ahead(state, one['write_ahead'], 'x')
        before = copy.deepcopy(state)
        with self.assertRaises(nv.WriteAheadConflict) as e:
            nv.apply_write_ahead(state, two['write_ahead'], 'x')
        self.assertEqual(e.exception.code, 'timestamp_reused')
        self.assertIsInstance(e.exception, ValueError)
        self.assertEqual(state, before)                                # nothing written
        nv.apply_write_ahead(state, one['write_ahead'], 'y')           # the same one again: idempotent
        self.assertEqual(state, before)

    def test_a_second_prior_acknowledgment_of_another_state_at_the_same_edge_timestamp_and_operation(self):
        # Tracker v3.2, R4: the same transfer (op transfer:TID, the same totals at (A>C, T999)) shown over two states of
        # my edge with the same total (4 at TS_AC, then 4 at TS_AC + 5): PA(A,C,4,TS_AC,T) and PA(A,C,4,TS_AC + 5,T)
        # are two different acknowledgments; the second is never signed (the server's sandbox signer refuses the same)
        other = edit(payee_item(), set_(['edges', 0, 'before'], st(A, C, 4, TS_AC + 5)))
        one, two = CO(payee_item(), payee_ctx()), CO(other, payee_ctx())
        self.assertTrue(one['ok'] and two['ok'])                       # both evaluated on the same (stale) snapshot
        self.assertEqual([g['prior_state'] for g in (one['write_ahead']['signed'][0], two['write_ahead']['signed'][0])],
                         [{'total': 4, 'timestamp': TS_AC}, {'total': 4, 'timestamp': TS_AC + 5}])
        state = {}
        nv.apply_write_ahead(state, one['write_ahead'], 'x')
        before = copy.deepcopy(state)
        with self.assertRaises(nv.WriteAheadConflict) as e:
            nv.apply_write_ahead(state, two['write_ahead'], 'x')
        self.assertEqual(e.exception.code, 'timestamp_reused')
        self.assertEqual(state, before)                                # nothing written
        r = CO(other, payee_ctx(signed=state['signed']))               # evaluated on the state as it is now: refused
        self.assertEqual((r['code'], r['to_sign']), ('timestamp_reused', []))
        self.assertTrue(CO(payee_item(), payee_ctx(signed=state['signed']))['ok'])   # the same PA again: signed
        # a record written before prior states were recorded is compared on op and totals, and gets the prior state
        legacy = {'signed': {AC: {str(T999): {'op': 'transfer:' + TID, 'slots': {AC + ':prior': 4, AC + ':new': 7}}}}}
        nv.apply_write_ahead(legacy, two['write_ahead'], 'x')
        self.assertEqual(legacy['signed'][AC][str(T999)]['prior_state'], {'total': 4, 'timestamp': TS_AC + 5})
        # the bound note the same: the same note at (B>C, T997) over another state of B>C
        n1 = BT(bound_tpl(), payer_ctx())
        state = {}
        nv.apply_write_ahead(state, n1['write_ahead'], 'x')
        n2 = BT(edit(bound_tpl(), set_(['prior_note'], st(B, C, 6, TS_BC + 5))), payer_ctx(signed=state['signed']))
        self.assertEqual(n2['code'], 'timestamp_reused')

    def test_a_second_payment_attempt_of_the_deal_is_never_added_on_a_stale_snapshot(self):
        bound, transfer = BT(bound_tpl(), payer_ctx()), PT(payer_tpl(), payer_ctx())
        self.assertTrue(bound['ok'] and transfer['ok'])
        state = {}
        nv.apply_write_ahead(state, bound['write_ahead'], 'x')
        before = copy.deepcopy(state)
        with self.assertRaises(nv.WriteAheadConflict) as e:
            nv.apply_write_ahead(state, transfer['write_ahead'], 'x')
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertEqual(state, before)
        self.assertEqual([a['route'] for a in state['transfer_attempts'][DEAL]], ['note'])
        # the same check sees a pending payment entry the other path wrote (an ordinary note, no attempt record)
        state = {'records': {BC: {'confirmed': None, 'pending': [pending(9, NOW - 1000)]}}}
        with self.assertRaises(nv.WriteAheadConflict):
            nv.apply_write_ahead(state, transfer['write_ahead'], 'x')
        # a deal recorded as paid meanwhile
        state = {}
        nv.mark_paid(state, DEAL, 'note', BC, 9, T997)
        with self.assertRaises(nv.WriteAheadConflict) as e:
            nv.apply_write_ahead(state, transfer['write_ahead'], 'x')
        self.assertEqual(e.exception.code, 'already_paid')
        # an attempt the evaluation weighed is no conflict (the same operation signed again, same T: audit VS-1)
        state = {}
        nv.apply_write_ahead(state, transfer['write_ahead'], 'x')
        saved = {k: state.get(k) for k in ('records', 'signed', 'transfer_attempts')}
        retry = PT(payer_tpl(T=T999, now=NOW + 1000), payer_ctx(now=NOW + 1000, **copy.deepcopy(saved)))
        self.assertTrue(retry['ok'], retry['summary']['reason'])
        self.assertEqual(len(retry['write_ahead']['attempts_seen']), 1)
        nv.apply_write_ahead(state, retry['write_ahead'], 'y')
        self.assertEqual(len(state['transfer_attempts'][DEAL]), 1)          # the same attempt
        # tracker v3.2: the same prior state at a later T is signed at once (the first can then never apply after it,
        # nor it after the first) and recorded as a second attempt the evaluation weighed
        later = PT(payer_tpl(T=T999 + 1000, now=NOW + 1000), payer_ctx(now=NOW + 1000, **copy.deepcopy(saved)))
        self.assertTrue(later['ok'], later['summary']['reason'])
        self.assertEqual(later['write_ahead']['attempts_seen'], [['transfer', AB, 7, T999]])
        nv.apply_write_ahead(state, later['write_ahead'], 'z')
        self.assertEqual([a['timestamp'] for a in state['transfer_attempts'][DEAL]], [T999, T999 + 1000])
        # ... but not on another state of my held claim (the same total at another timestamp): it waits for both
        moved = edit(payer_tpl(T=T999 + 2000, now=NOW + 2000), set_(['from_edge', 'before'], st(A, B, 10, TS_AB + 5)))
        r = PT(moved, payer_ctx(now=NOW + 2000, **copy.deepcopy(saved)))
        self.assertEqual((r['code'], r['summary']['retry_after_ms']),
                         ('transfer_window_open', T999 + 1000 + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - NOW - 2000))


class RecordsHelpers(unittest.TestCase):
    def test_write_ahead_round_trip(self):
        ctx = payer_ctx()
        r = PT(payer_tpl(), ctx)
        state = {}
        nv.apply_write_ahead(state, r['write_ahead'], '2026-11-08T12:00:00.000Z')
        self.assertEqual(state['signed'], {AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7},
                                                            'prior_state': {'total': 10, 'timestamp': TS_AB}}},
                                           AC: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AC + ':new': 7}}}})
        self.assertEqual(state['transfer_attempts'][DEAL][0]['ack'], ACK)
        self.assertEqual(state['records'][AB]['pending'], [{'total': 7, 'timestamp': T999, 'kind': 'transfer', 'ref': DEAL,
                                                            'direction': 'in', 'signed_at': '2026-11-08T12:00:00.000Z'}])
        self.assertEqual(state['transfer_attempts'][DEAL], [dict(r['write_ahead']['attempt'], signed_at='2026-11-08T12:00:00.000Z')])
        snapshot = copy.deepcopy(state)
        nv.apply_write_ahead(state, r['write_ahead'], 'later')
        self.assertEqual(state, snapshot)                                    # idempotent
        mine = dict(records=state['records'], signed=state['signed'], transfer_attempts=state['transfer_attempts'])
        # the same template again (a retry after a crash) is the same operation and the same attempt
        self.assertTrue(PT(payer_tpl(), payer_ctx(**mine))['ok'])
        # a different kind of payment now waits; another deal cannot reuse (A>B, T)
        self.assertEqual(BT(bound_tpl(), payer_ctx(**mine))['code'], 'transfer_window_open')
        other = edit(payer_tpl(), set_(['deal_id'], 'vd_ffffffffffffffff'))
        other_ctx = payer_ctx(deal=dict(nv.deal_context(terms(), TH, DH), deal_id='vd_ffffffffffffffff'), **mine)
        other['quote_digest'] = qd(deal='vd_ffffffffffffffff')
        self.assertEqual(PT(other, other_ctx)['code'], 'timestamp_reused')
        with self.assertRaises(ValueError):
            nv.apply_write_ahead({'signed': []}, r['write_ahead'])

    def test_findings_confirm_applied_entries_and_record_the_deals_they_paid(self):
        state = {'records': {BC: {'confirmed': None, 'pending': [pending(6, TS_BC, ref='vd_aaaaaaaaaaaaaaaa')]}}, 'issued': {}}
        r = BT(bound_tpl(), payer_ctx(records=state['records']))
        self.assertTrue(r['ok'], r['summary']['reason'])                 # it paid another deal: this one may be paid
        self.assertEqual(r['summary']['applied'], [{'pair': BC, 'total': 6, 'timestamp': TS_BC, 'kind': 'note',
                                                    'ref': 'vd_aaaaaaaaaaaaaaaa', 'direction': 'out',
                                                    'state': st(B, C, 6, TS_BC)}])
        self.assertEqual(r['summary']['paid_deals'], {'vd_aaaaaaaaaaaaaaaa': {'route': 'note', 'edge': BC, 'total': 6,
                                                                              'timestamp': TS_BC}})
        self.assertEqual(nv.apply_findings(state, r['summary'], me_pk=B.pk), ['vd_aaaaaaaaaaaaaaaa'])
        self.assertEqual(state['records'][BC]['confirmed'], st(B, C, 6, TS_BC))
        self.assertEqual(state['records'][BC]['pending'], [])
        self.assertEqual(state['issued'], {BC: 6})
        self.assertEqual(nv.apply_findings(state, r['summary'], me_pk=B.pk), [])
        tpl = edit(bound_tpl(), set_(['deal_id'], 'vd_aaaaaaaaaaaaaaaa'))
        ctx = payer_ctx(records=state['records'], deal=dict(nv.deal_context(terms(), TH, DH), deal_id='vd_aaaaaaaaaaaaaaaa'))
        self.assertEqual(BT(tpl, ctx)['code'], 'already_paid')

    def test_advisories_report_a_disagreement_with_my_records(self):
        recs = {BC: {'confirmed': {'total': 8, 'timestamp': TS_BC + 10, 'signature': 'aa'}, 'pending': []}}
        r = BT(bound_tpl(), payer_ctx(records=recs))
        self.assertTrue(r['ok'], r['summary']['reason'])                 # advisory only: the tracker checks the prior
        self.assertEqual(r['summary']['advisories'], [{'code': 'older_than_records', 'edge': BC,
                                                       'shown': {'total': 6, 'timestamp': TS_BC},
                                                       'recorded': {'total': 8, 'timestamp': TS_BC + 10}}])
        recs = {BC: {'confirmed': {'total': 5, 'timestamp': TS_BC, 'signature': 'aa'}, 'pending': []}}
        self.assertEqual(BT(bound_tpl(), payer_ctx(records=recs))['summary']['advisories'][0]['code'], 'conflicts_with_records')

    def test_an_applied_ordinary_note_does_not_block_a_set_off(self):
        recs = {BE: {'confirmed': None, 'pending': [pending(5, TS_BE, ref='vd_aaaaaaaaaaaaaaaa')]}}
        r = CO(member_item(), member_ctx(records=recs))
        self.assertTrue(r['ok'], r['summary']['reason'])
        self.assertEqual(list(r['summary']['paid_deals']), ['vd_aaaaaaaaaaaaaaaa'])

    def test_mark_paid(self):
        state = {}
        self.assertTrue(nv.mark_paid(state, DEAL, 'note', BC, 9, T997))
        self.assertFalse(nv.mark_paid(state, DEAL, 'transfer', AB, 7, T999))
        self.assertEqual(state, {'records': {'paid_deals': {DEAL: {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': T997}}}})
        with self.assertRaises(ValueError):
            nv.mark_paid(state, 'vd_x', 'cash', BC, 1, 1)

    def test_unbound_note_problem(self):
        self.assertIsNone(nv.unbound_note_problem(BC, None))
        self.assertIsNone(nv.unbound_note_problem(BC, {AB: True}, ['other/1']))
        self.assertEqual(nv.unbound_note_problem(BC, {BC: {'since': 1}}), 'bound_note_required')
        self.assertEqual(nv.unbound_note_problem(BC, [BC]), 'bound_note_required')
        self.assertEqual(nv.unbound_note_problem(BC, None, ['bound_notes/1']), 'bound_note_required')
        self.assertEqual(nv.unbound_note_problem(BC, 'x'), 'records_unreadable')
        self.assertEqual(nv.unbound_note_problem(BC, [1]), 'records_unreadable')

    def test_check_payment(self):
        r = nv.check_payment(DEAL, PRICE, 'note', BC, 6, payer_ctx())
        self.assertEqual((set(r), r['ok'], r['code'], r['summary']['deal_id']), ({'ok', 'code', 'summary'}, True, None, DEAL))
        alive = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}
        self.assertEqual(nv.check_payment(DEAL, PRICE, 'note', BC, 6, payer_ctx(transfer_attempts=alive))['code'], 'transfer_window_open')
        # audit VS-1: check_payment knows no timestamp, so a transfer is never taken as the same operation again
        self.assertEqual(nv.check_payment(DEAL, PRICE, 'transfer', AB, 10, payer_ctx(transfer_attempts=alive))['code'],
                         'transfer_window_open')
        self.assertEqual(nv.check_payment(DEAL, PRICE, 'note', BC, 6, payer_ctx(records='x'))['code'], 'records_unreadable')
        self.assertEqual(nv.check_payment(DEAL, PRICE, 'note', BC, 6, payer_ctx(pins=None))['code'], 'tracker_mismatch')
        self.assertEqual(nv.check_payment(DEAL, 0, 'note', BC, 6, payer_ctx())['code'], 'bad_template')


class QuoteDigest(unittest.TestCase):
    """PROTOCOL.md 18.3 item 4 and its worked example: the canonical bytes, and so the digest, are fixed."""
    ALICE = '035e2b6f7e5a63fc1335cca864db07e5872b9c21f3cafe766a6c1987977221e7b5'
    BOB = '039ce92ed225dafa349eff0a99eca476219acdcc5991d7c12cdd587c3ee365bf05'
    CAROL = '0265ad727818ed16c0dc99185145ba5c0413efa30465f783b7de4b43c799a2e124'
    FIELDS = {'network': 'valun-pilot-1', 'tracker_nft_id': NFT,
              'denomination': 'token:01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274',
              'deal_id': 'vd_0123456789abcdef', 'terms_hash': '5f7bccd0e836183a82fbab738a617faa25673c4ead77eeb3da94c7ef4c9e6003',
              'deliverable_sha256': hashlib.sha256(b'example delivery').hexdigest(),
              'issuer_pubkey': CAROL, 'payer_pubkey': ALICE, 'payee_pubkey': BOB, 'amount': 20}

    def test_worked_example(self):
        self.assertEqual(self.FIELDS['deliverable_sha256'], 'd6823e3f1b084c3135394414d58c8da1bec863f96cdec489f123426d4085c9fc')
        text = ('{"amount":20,"deal_id":"vd_0123456789abcdef",'
                '"deliverable_sha256":"d6823e3f1b084c3135394414d58c8da1bec863f96cdec489f123426d4085c9fc",'
                '"denomination":"token:01cb4b85df0e2e4fd965b52ca943a96f654f8bd91ed3ba60df67a3a2aeaa3274",'
                f'"issuer_pubkey":"{self.CAROL}","kind":"valun-transfer-quote/1","network":"valun-pilot-1",'
                f'"payee_pubkey":"{self.BOB}","payer_pubkey":"{self.ALICE}",'
                '"terms_hash":"5f7bccd0e836183a82fbab738a617faa25673c4ead77eeb3da94c7ef4c9e6003",'
                f'"tracker_nft_id":"{NFT}"}}')
        self.assertEqual(len(text.encode('utf-8')), 696)
        self.assertEqual(vc.canonical(dict(self.FIELDS, kind=nv.QUOTE_KIND)), text)
        self.assertEqual(hashlib.sha256(text.encode('utf-8')).hexdigest(),
                         '377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e')
        self.assertEqual(nv.quote_digest(self.FIELDS), '377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e')
        stmt = nv.pay_statement('vd_0123456789abcdef', nv.quote_digest(self.FIELDS))
        self.assertEqual(stmt, vc.statement('pay', 'vd_0123456789abcdef', '377beb8f1235b91ee4f71a3b6cad819e4d29e67fa1267a074531a4557782ad1e'))
        self.assertEqual(len(stmt.encode('utf-8')), 102)

    def test_order_and_extra_keys_do_not_matter(self):
        shuffled = dict(reversed(list(self.FIELDS.items())), handle='ignored', kind='ignored too')
        self.assertEqual(nv.quote_digest(shuffled), nv.quote_digest(self.FIELDS))

    def test_bad_fields(self):
        for k, v in (('amount', 0), ('amount', True), ('amount', 2.0), ('amount', '20'), ('amount', 2 ** 53),
                     ('deal_id', ''), ('deal_id', None), ('network', 'valun-pilot-é'), ('terms_hash', 'a\nb'),
                     ('payee_pubkey', 5)):
            with self.subTest(k=k, v=v), self.assertRaises(ValueError):
                nv.quote_digest(dict(self.FIELDS, **{k: v}))
        with self.assertRaises(ValueError):
            nv.quote_digest({k: v for k, v in self.FIELDS.items() if k != 'issuer_pubkey'})
        for args in ((DEAL, 'ab'), ('', '00' * 32), (DEAL, 'AB' * 32)):
            with self.assertRaises(ValueError):
                nv.pay_statement(*args)


class ModuleContract(unittest.TestCase):
    def test_imports_only_the_standard_library_and_sibling_modules(self):
        with open(os.path.join(SRC, 'valun', 'novation.py'), encoding='utf-8') as f:
            tree = ast.parse(f.read())
        stdlib, siblings = set(), set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                stdlib.update(a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    self.assertEqual((node.level, node.module), (1, None))
                    siblings.update(a.name for a in node.names)
                else:
                    stdlib.add(node.module.split('.')[0])
        self.assertLessEqual(stdlib, set(sys.stdlib_module_names))
        self.assertEqual(stdlib & {'time', 'datetime', 'urllib', 'http', 'socket', 'os', 'random', 'secrets'}, set())
        self.assertLessEqual(siblings, {'basis', 'client', 'records'})
        self.assertEqual(siblings & {'cli', 'mcp_server', 'home', 'agent'}, set())

    def test_constants(self):
        self.assertEqual(nv.RECORDS_KEEP_MS, vc.RECORDS_KEEP_MS)        # proven_dead relies on the client's R4 pruning
        self.assertEqual(nv.ID_RE.pattern, r'v[dts]_[0-9a-f]{16}\Z')
        self.assertEqual(nv.RESIDUE, {'transfer': 999, 'setoff': 998, 'bound': 997})
        self.assertEqual(nv.RESERVED_MS, (995, 996, 997, 998, 999))
        self.assertEqual((nv.MAX_AGE_MS, nv.FALLBACK_MARGIN_MS), (3_600_000, 120_000))
        self.assertEqual((nv.INITIATE_WINDOW_MS, nv.CONSENT_WINDOW_MS, nv.FUTURE_SKEW_MS), (600_000, 3_300_000, 5_000))
        self.assertEqual(nv.QUOTE_KIND, 'valun-transfer-quote/1')

    def test_edge_helpers(self):
        self.assertEqual(nv.edge_key(A.pk, B.pk), AB)
        self.assertEqual(nv.parse_edge(AB), (A.pk, B.pk))
        for bad in (None, 5, A.pk, AB + '>' + C.pk, AB.upper(), f'{A.pk}>{B.pk[:-2]}'):
            self.assertIsNone(nv.parse_edge(bad))
        self.assertEqual(nv.slot_key(AB, 'prior'), AB + ':prior')

    def test_deal_context(self):
        d = nv.deal_context(terms(), TH, DH, delivered=True, transfer_id=TID)
        self.assertEqual(d, {'deal_id': DEAL, 'network': NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
                             'terms_hash': TH, 'deliverable_sha256': DH, 'price': PRICE,
                             'payer': {'id': B_ID, 'pubkey': B.pk}, 'payee': {'id': C_ID, 'pubkey': C.pk},
                             'delivered': True, 'transfer_id': TID})

    def test_context_arguments_are_checked(self):
        for bad in ([], dict(payer_ctx(), me_pk='nope'), dict(payer_ctx(), now_ms=-1), dict(payer_ctx(), now_ms=True),
                    dict(payer_ctx(), verify=None), dict(payer_ctx(), edges=[])):
            for fn, it in ((PT, payer_tpl()), (BT, bound_tpl()), (CO, member_item())):
                with self.subTest(fn=fn.__name__), self.assertRaises(ValueError):
                    fn(it, bad)

    def test_malformed_items_are_refused_never_raised(self):
        junk = [None, [], 'x', 5, {}, {'edges': [None]},
                {'kind': 'transfer', 'id': TID, 'your_roles': ['payee'], 'state': 'collecting', 'tracker_nft_id': NFT,
                 'denomination': DENOM, 'edges': [{'edge': 5}]},
                edit(payee_item(), set_(['context'], 'x')), edit(payee_item(), set_(['context', 'amount'], '3')),
                edit(payee_item(), set_(['context', 'deal'], ['x'])), edit(member_item(), set_(['edges'], [])),
                edit(member_item(), set_(['edges', 0, 'signed_by_you'], ['old'])),
                edit(member_item(), set_(['edges', 0, 'slots'], [{}])),
                edit(issuer_item(), set_(['edges', 0, 'revision'], None)),
                edit(issuer_item(), set_(['context', 'payer'], {'id': E_ID})),
                edit(payer_item(), set_(['edges', 1, 'your_role'], 'creditor'))]
        for j in junk:
            with self.subTest(item=str(j)[:60]):
                for ctx in (payee_ctx(), member_ctx(), issuer_ctx(), regen_ctx()):
                    r = CO(j, ctx)
                    self.assertFalse(r['ok'])
                    self.assertIn(r['code'], nv.REFUSAL_CODES)
        for j in (None, [], {}, edit(payer_tpl(), set_(['from_edge', 'before'], {'total': 1})),
                  edit(payer_tpl(), set_(['issuer'], 'A'))):
            self.assertEqual(PT(j, payer_ctx())['code'], 'bad_template')
        for j in (None, [], {}, edit(bound_tpl(), set_(['prior_note'], {'total': 6})), edit(bound_tpl(), set_(['price'], 0))):
            self.assertEqual(BT(j, payer_ctx())['code'], 'bad_template')

    def test_a_verifier_that_raises_accepts_nothing(self):
        def boom(*_a):
            raise RuntimeError('verifier down')
        self.assertEqual(PT(payer_tpl(), payer_ctx(verify=boom))['code'], 'bad_prior_signature')
        self.assertEqual(CO(member_item(), member_ctx(verify=lambda *_a: 1))['code'], 'bad_prior_signature')   # not True


class ReasonsInTheUnit(unittest.TestCase):
    # 0.5.1: a refusal's words name the network's unit, ctx['unit'] (both clients pass it); 'PC' when it is absent.
    def test_a_refusal_names_the_networks_unit(self):
        ctx = issuer_ctx(consent_policy=dict(POLICY, max_PC=2))
        r = CO(issuer_item(), ctx)
        self.assertEqual(r['code'], 'policy_cap')
        self.assertIn(' PC is above the cap', r['summary']['reason'])
        r = CO(issuer_item(), dict(ctx, unit='nanoERG'))
        self.assertEqual(r['code'], 'policy_cap')
        self.assertIn(' nanoERG is above the cap', r['summary']['reason'])
        self.assertNotIn(' PC', r['summary']['reason'])


if __name__ == '__main__':
    unittest.main()
