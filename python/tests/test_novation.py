"""novation.py, the client signing firewall (PROTOCOL.md 15.3, design 4.11 and 6.2, decision D-1): a decision table
with at least one case per refusal code and accepted cases for every role; the bytes to sign (equal to
basis.note_message, signed and checked with basis.verify); the quote digest (the worked example of PROTOCOL.md 18.3);
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
def base_ctx(me, me_id, now=NOW, **over):
    c = {'me_pk': me.pk, 'me_id': me_id, 'now_ms': now, 'verify': verify, 'pins': dict(PINS), 'records': {},
         'signed': {}, 'transfer_attempts': {}, 'novated_edges': {}, 'features': ['bound_notes/1', 'circulation/1']}
    c.update(over)
    return c


def payer_ctx(now=NOW, **over):
    c = base_ctx(B, B_ID, now, deal=nv.deal_context(terms(), TH, DH), payee_current_pk=C.pk,
                 mandate={'pay_with_held_notes': 'when_asked'})
    c.update(over)
    return c


def regen_ctx(now=NOW, **over):
    """The payer of a regenerated transfer: its earlier attempt through A acknowledged the same prior, 10."""
    c = payer_ctx(now, transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]})
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
    ('bound: no participant id in the context', BT, bound_tpl, lambda: payer_ctx(me_id=None), 'deal_mismatch'),
    ('bound: my note for this deal is the prior shown, and my records know a later state', BT, bound_tpl,
     lambda: payer_ctx(records={BC: {'confirmed': {'total': 8, 'timestamp': TS_BC + 10, 'signature': 'aa'},
                                     'pending': [pending(6, TS_BC)]}}), 'already_paid'),
    ('bound: a template for another deal', BT, lambda: edit(bound_tpl(), set_(['deal_id'], 'vd_ffffffffffffffff')),
     payer_ctx, 'deal_mismatch'),

    # --- evaluate_consent, issuer ---
    ('issuer: sign', CO, issuer_item, issuer_ctx, None),
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

    # --- evaluate_consent, payer (a regenerated transfer) ---
    ('payer consent: sign (same prior as the earlier attempt)', CO, payer_item, regen_ctx, None),
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
     lambda: regen_ctx(transfer_attempts={DEAL: [attempt('transfer', AB, 10, 7, T_OLD, 'ab' * 32)]}), 'stale_quote'),
    ('payer consent: no mandate in the context', CO, payer_item, lambda: regen_ctx(mandate=None), 'policy_off'),
    ('payer consent: the destination at another timestamp', CO,
     lambda: edit(payer_item(), set_(['edges', 1, 'timestamp'], T999 - 1000)), regen_ctx, 'bad_consent'),
    ('payer consent: no participant id in the context', CO, payer_item, lambda: regen_ctx(me_id=None), 'deal_mismatch'),

    # --- evaluate_consent, member (a set-off) ---
    ('member: sign', CO, member_item, member_ctx, None),
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
    basis.note_message() and that the signer's signature over them verifies with basis.verify."""

    def assertSigns(self, r, signer, expected):
        self.assertTrue(r['ok'], r['summary']['reason'])
        self.assertEqual(r['to_sign'], expected)
        msgs = nv.slot_messages(r['to_sign'], NFT, DENOM)
        self.assertEqual(list(msgs), [s[0] for s in expected])
        for slot, issuer, recipient, total, ts in r['to_sign']:
            m = vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, ts, bytes.fromhex(NFT), DENOM)
            self.assertEqual(msgs[slot], m)
            self.assertEqual(len(m), 80)
            self.assertEqual(nv.message(issuer, recipient, total, ts, NFT, DENOM), m)
            signature = vb.sign(m, signer.secret, bytes.fromhex(signer.pk))
            self.assertTrue(vb.verify(signature, m, bytes.fromhex(signer.pk)))
            self.assertFalse(vb.verify(signature, m, bytes.fromhex(E.pk if signer is not E else A.pk)))
        return msgs

    def test_payer_template(self):
        r = PT(payer_tpl(), payer_ctx())
        self.assertSigns(r, B, [(AB + ':prior', A.pk, B.pk, 10, T999), (AB + ':new', A.pk, B.pk, 7, T999),
                                (AC + ':new', A.pk, C.pk, 7, T999)])
        s = r['summary']
        self.assertEqual((s['role'], s['kind'], s['deal_id'], s['amount'], s['timestamp']), ('payer', 'transfer', DEAL, 3, T999))
        self.assertEqual((s['your_net_change_PC'], s['your_total_owed_change_PC']), (-3, 0))
        self.assertEqual(s['quote_digest'], qd())
        self.assertEqual(nv.pay_statement(DEAL, s['quote_digest']), f'valun-pilot/pay/1\n{DEAL}\n{qd()}')
        self.assertEqual([e['your_role'] for e in s['edges']], ['creditor', 'payer'])
        wa = r['write_ahead']
        self.assertEqual(wa['op'], 'pay:' + DEAL)
        self.assertEqual(wa['signed'], [{'edge': AB, 'timestamp': T999, 'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7}},
                                        {'edge': AC, 'timestamp': T999, 'op': 'pay:' + DEAL, 'slots': {AC + ':new': 7}}])
        self.assertEqual(wa['pending'], [{'pair': AB, 'total': 7, 'timestamp': T999, 'kind': 'transfer', 'ref': DEAL,
                                          'direction': 'in'}])
        self.assertEqual(wa['attempt'], {'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10,
                                         'prior_timestamp': TS_AB, 'prior_signature': st(A, B, 10, TS_AB)['signature'],
                                         'total': 7, 'timestamp': T999, 'quote_digest': qd()})
        self.assertEqual(wa['attempts_seen'], [])

    def test_payer_template_ignores_the_server_hex(self):
        tpl = edit(payer_tpl(), set_(['messages'], {AB + ':new': vb.note_message(bytes.fromhex(A.pk), bytes.fromhex(B.pk), 1, 1, bytes.fromhex(NFT), DENOM).hex()}))
        r = PT(tpl, payer_ctx())
        self.assertEqual(r['to_sign'][1], (AB + ':new', A.pk, B.pk, 7, T999))     # R1: what was checked, not the hex

    def test_bound_note(self):
        r = BT(bound_tpl(), payer_ctx())
        self.assertSigns(r, B, [(BC + ':prior', B.pk, C.pk, 6, T997), (BC + ':new', B.pk, C.pk, 9, T997)])
        s = r['summary']
        self.assertEqual((s['kind'], s['your_net_change_PC'], s['your_total_owed_change_PC']), ('bound_note', -3, 3))
        self.assertEqual(r['write_ahead']['attempt'], {'deal_id': DEAL, 'route': 'note', 'edge': BC, 'prior': 6,
                                                       'prior_timestamp': TS_BC, 'prior_signature': st(B, C, 6, TS_BC)['signature'],
                                                       'total': 9, 'timestamp': T997, 'quote_digest': None})
        self.assertEqual(r['write_ahead']['pending'], [{'pair': BC, 'total': 9, 'timestamp': T997, 'kind': 'note',
                                                        'ref': DEAL, 'direction': 'out'}])
        r = BT(bound_tpl(prior=False), payer_ctx())
        self.assertSigns(r, B, [(BC + ':prior', B.pk, C.pk, 0, T997), (BC + ':new', B.pk, C.pk, 3, T997)])

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
        self.assertSigns(r, C, [(AC + ':prior', A.pk, C.pk, 4, T999), (AC + ':new', A.pk, C.pk, 7, T999)])
        self.assertEqual((r['summary']['your_net_change_PC'], r['summary']['deal_id']), (3, DEAL))
        r = CO(payee_item(Y=None), payee_ctx())
        self.assertSigns(r, C, [(AC + ':prior', A.pk, C.pk, 0, T999), (AC + ':new', A.pk, C.pk, 3, T999)])

    def test_payer_consent(self):
        r = CO(payer_item(), regen_ctx())
        self.assertSigns(r, B, [(AB + ':prior', A.pk, B.pk, 10, T999), (AB + ':new', A.pk, B.pk, 7, T999),
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
        self.assertEqual(payer[AB + ':prior'], nv.message(A.pk, B.pk, 10, T999, NFT, DENOM))
        self.assertEqual(payee[AC + ':prior'], nv.message(A.pk, C.pk, 4, T999, NFT, DENOM))
        self.assertEqual(len({*payer.values(), *issuer.values(), *payee.values()}), 4)   # 7 slots over 4 messages


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
        same = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd())]}
        self.assertTrue(PT(payer_tpl(), payer_ctx(transfer_attempts=same))['ok'])          # same prior: at once
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
    """An attempt record as 0.4.0 writes it: with the full state it acknowledged (decision D-2 a)."""
    return dict(attempt(route, edge, prior, total, timestamp, quote), deal_id=deal_id,
                prior_timestamp=prior_state['timestamp'], prior_signature=prior_state['signature'])


class D2aFullEdgeStates(unittest.TestCase):
    """Decision D-2 a: attempts are classified on full edge states (total, timestamp, signature)."""

    def test_a_same_prior_retry_needs_exactly_the_acknowledged_state(self):
        s0 = st(A, B, 10, TS_AB)
        earlier = {DEAL: [full('transfer', AB, 10, 7, T_OLD, s0, qd())]}
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
        earlier = {DEAL: [attempt('transfer', AB, 10, 7, T_OLD, qd(), prior_timestamp=TS_AB)]}
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
        # an attempt the evaluation weighed is no conflict (a same-prior retry)
        state = {}
        nv.apply_write_ahead(state, transfer['write_ahead'], 'x')
        retry = PT(payer_tpl(T=T999 + 1000, now=NOW + 1000), payer_ctx(now=NOW + 1000, **{k: state.get(k) for k in
                                                                       ('records', 'signed', 'transfer_attempts')}))
        self.assertTrue(retry['ok'], retry['summary']['reason'])
        self.assertEqual(len(retry['write_ahead']['attempts_seen']), 1)
        nv.apply_write_ahead(state, retry['write_ahead'], 'y')
        self.assertEqual(len(state['transfer_attempts'][DEAL]), 2)


class RecordsHelpers(unittest.TestCase):
    def test_write_ahead_round_trip(self):
        ctx = payer_ctx()
        r = PT(payer_tpl(), ctx)
        state = {}
        nv.apply_write_ahead(state, r['write_ahead'], '2026-11-08T12:00:00.000Z')
        self.assertEqual(state['signed'], {AB: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AB + ':prior': 10, AB + ':new': 7}}},
                                           AC: {str(T999): {'op': 'pay:' + DEAL, 'slots': {AC + ':new': 7}}}})
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
        self.assertTrue(nv.check_payment(DEAL, PRICE, 'transfer', AB, 10, payer_ctx(transfer_attempts=alive))['ok'])
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


if __name__ == '__main__':
    unittest.main()
