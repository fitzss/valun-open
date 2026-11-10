"""Client circulation methods against a fake Valun v16 server and tracker (offline, real signatures, throwaway keys):
bound complete() with its prior acknowledgment, pay_by_transfer() (body shape, signatures, the one stale retry,
stale_claim and stale_quote, the issuer resolution), cancel_transfer(), the D-1 fallback rule (R11 extended to own
notes; attempt_outcome_unknown; records['paid_deals']), process_consents() and its report, sync_edges() and the 7-day
pruning, the capability header, and that what is signed is saved before the HTTP POST is attempted (R9)."""
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.error
import urllib.parse
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import basis as vb  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import novation as nv  # noqa: E402
from valun import records  # noqa: E402

NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
PINS = {'tracker_nft_id': NFT, 'denomination': DENOM}
SERVER = 'http://valun.invalid'
NOW = 1_793_966_460_123
DEAL, DEAL2, TID, SID = 'vd_0123456789abcdef', 'vd_1123456789abcdef', 'vt_0123456789abcdef', 'vs_0123456789abcdef'
OWNER_TOKEN, OTHER_OWNER = 'vpo_owner-test-only', 'vpo_another-participants-owner'
AGENT_TOKEN = 'vpa_test-only'                  # this client's agent token (MemStore's), a throwaway test value
DAY = 24 * 3600 * 1000
LATER = nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 60_000        # past an attempt's fallback window


def key(label):
    """Throwaway test key: secret = (sha256(label) mod (n - 1)) + 1, as in the spec vectors."""
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'secret': secret, 'pubkey': vb.public_key(secret).hex()}


# A issues the note B (this client, by default) holds; C is the payee; E someone else; F an impostor whose handle is A's id.
A_ID, B_ID, C_ID, E_ID, F_ID = 'vp_a0a0a0a0a0a0', 'vp_b0b0b0b0b0b0', 'vp_c0c0c0c0c0c0', 'vp_e0e0e0e0e0e0', 'vp_f0f0f0f0f0f0'
A, B, C, E, F = (key(f'test/circulation/{n}') for n in ('issuer', 'payer', 'payee', 'other', 'impostor'))
KEYS = {A_ID: A, B_ID: B, C_ID: C, E_ID: E, F_ID: F}
HANDLES = {A_ID: 'issuer-a', B_ID: 'payer-b', C_ID: 'payee-c', E_ID: 'other-e', F_ID: A_ID}
AB, AC, BC, EA = (f"{i['pubkey']}>{r['pubkey']}" for i, r in ((A, B), (A, C), (B, C), (E, A)))
TS_AB, TS_AC, TS_BC, TS_EA = NOW - 900_000, NOW - 800_000 + 1, NOW - 700_000 + 2, NOW - 650_000 + 3     # ordinary residues


def res(t, r):
    """The largest timestamp <= t that ends in r ms."""
    return t - ((t - r) % 1000)


def next_ts(now, r, after):
    """How v16 picks a novation or bound-note timestamp: the largest one ending in r ms, at most now - 1500 and later
    than `after` (the next one when there is none yet: the server waits up to 3 s for it)."""
    t = res(now - 1500, r)
    return t if t > after else after + 1 + (r - (after + 1)) % 1000


def sign_text(k, text):
    return vb.sign(text.encode('utf-8'), k['secret'], bytes.fromhex(k['pubkey'])).hex()


def msg(issuer, recipient, total, ts):
    return vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, ts, bytes.fromhex(NFT), DENOM)


def pa(issuer, recipient, prior_total, prior_ts, ts):
    """PA(I,R,X,p,T): the 105-byte prior acknowledgment of tracker v3.2 (p = 0 for an absent edge)."""
    return vb.prior_ack_message(bytes.fromhex(issuer), bytes.fromhex(recipient), prior_total, prior_ts, ts, bytes.fromhex(NFT),
                                DENOM)


# GET /info novation of a v16 server on tracker v3.2: the novation constants and the tracker contract (design v3.2)
INFO_NOVATION = {'transfer_ms': 999, 'setoff_ms': 998, 'bound_note_ms': 997, 'reserved_ms': [995, 996, 997, 998, 999],
                 'max_age_ms': 3600000, 'transfer_ttl_ms': 1200000, 'setoff_ttl_ms': 1800000, 'fallback_margin_ms': 60000,
                 'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3,
                 'prior_ack': 'basis/prior-ack/1'}


def signed_by(k, data, sig):
    return isinstance(sig, str) and vb.verify(bytes.fromhex(sig), data, bytes.fromhex(k['pubkey']))


def st(issuer, recipient, total, ts, signer=None):
    """An EdgeState: the issuer's (or `signer`'s, to make a bad one) signature over M(issuer, recipient, total, ts)."""
    s = signer or issuer
    return {'total': total, 'timestamp': ts,
            'signature': vb.sign(msg(issuer['pubkey'], recipient['pubkey'], total, ts), s['secret'], bytes.fromhex(s['pubkey'])).hex()}


def make_deal(deal_id=DEAL, price=3, payer=B_ID, payee=C_ID, content='# Brief\n\nThree sources.\n', status='delivered'):
    pk, ek = KEYS[payer], KEYS[payee]
    t = {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': deal_id,
         'version': 1, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': payer,
         'payer': {'id': payer, 'pubkey': pk['pubkey']}, 'payee': {'id': payee, 'pubkey': ek['pubkey']},
         'service': {'title': 'Short research brief', 'description': 'Three sources.', 'deliverable': 'markdown'},
         'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
         'deliver_by': '2099-01-02T00:00:00.000Z', 'offer_expires_at': '2099-01-01T00:00:00.000Z'}
    h, dh = vc.terms_hash(t), vc.sha256_hex(content)
    return {'id': deal_id, 'status': status, 'your_role': 'payer', 'counterparty': {'id': payee, 'handle': HANDLES[payee]},
            'current': {'version': 1, 'by': payer, 'state': 'accepted', 'terms': t, 'terms_hash': h,
                        'signature': sign_text(pk, vc.statement('propose', h))},
            'agreement': {'version': 1, 'terms_hash': h, 'proposer_signature': sign_text(pk, vc.statement('propose', h)),
                          'acceptor_signature': sign_text(ek, vc.statement('accept', h))},
            'delivery': {'by': payee, 'title': 'Brief', 'content': content, 'sha256': dh, 'bytes': len(content.encode()),
                         'signature': sign_text(ek, vc.statement('deliver', h, dh))},
            'credit_note': None, 'payment': None}


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def time(self):
        return self.now / 1000


class Net:
    """A fake Valun v16 server (circulation on) with its tracker v3.2: just enough of /pilot/v1 for the circulation
    methods. A and C are server-run here: in transfer_mode 'apply' they sign at once and the transfer applies in the
    request. Prior slots are checked as tracker v3.2 does: PA over the edge's stored total and timestamp."""

    def __init__(self, clock, features=('bound_notes/1', 'circulation/1'), me_id=B_ID):
        self.clock, self.me_id = clock, me_id
        self.features = None if features is None else list(features)
        self.novation = dict(INFO_NOVATION)     # GET /info novation, with the features (None: a server that sends none)
        self.tracker, self.journal, self.seq, self.bound_only = {}, [], 0, set()
        self.deals, self.log, self.hooks = {}, [], []
        self.mandate = {'pay_with_held_notes': 'when_asked', 'auto_clear': True, 'novate_own_debt': True,
                        'accept_transfers': True, 'may_accept_credit': True, 'accept_notes_from': [A_ID],
                        'refuse_notes_from': [], 'max_accept_per_issuer': 50}
        self.option_issuers = [A_ID]
        self.transfer_mode = 'apply'            # 'apply', 'collect' (A and C do not sign yet) or 'review' (B's owner)
        self.review = False                     # complete(): hold the note for the owner
        self.force = []                         # [(code, fn)]: answer the next POST pay-by-transfer with 409 code after fn()
        self.pay_posts, self.consent_items, self.consent_posts, self.refusals = [], [], [], []
        self.consent_state, self.consent_rejected, self.page = {}, {}, 200
        self.directory_ids = [A_ID, B_ID, C_ID, E_ID]   # the participants GET /participants lists
        self.directory_extra = []               # more GET /participants rows (a lying or ambiguous directory)
        self.token, self.resolutions = None, []
        self.transfers = {}                     # the server's transfers by id, in valun-app FX-SV's states
        self.lose_answer = False                # POST pay-by-transfer is recorded, then no answer reaches the client
        self.transfer_view_edges = True         # GET /transfers shows the transfer's edges (False: a view without them)

    # ---------- setup ----------
    def pk(self, pid):
        return KEYS[pid]['pubkey']

    def set_edge(self, issuer, recipient, total, ts, signer=None, kind=None, ref=None):
        edge = f"{issuer['pubkey']}>{recipient['pubkey']}"
        before = self.tracker.get(edge, {'total': 0})['total']
        s = self.tracker[edge] = st(issuer, recipient, total, ts, signer)
        if kind:                                     # with an edge-journal entry (GET /edges journal)
            self.seq += 1
            self.journal.append({'seq': self.seq, 'at': '2026-11-08T12:00:00.000Z', 'kind': kind, 'ref': ref, 'edge': edge,
                                 'issuer_pubkey': issuer['pubkey'], 'recipient_pubkey': recipient['pubkey'],
                                 'delta': total - before, 'total_after': total, 'timestamp': ts, 'signature': s['signature']})
        return s

    def add_deal(self, deal_id=DEAL, **kw):
        self.deals[deal_id] = make_deal(deal_id, **kw)
        return self.deals[deal_id]

    # ---------- the HTTP surface ----------
    def handle(self, method, path, body=None):
        self.log.append((method, path, copy.deepcopy(body)))
        for hook in list(self.hooks):
            hook(method, path, body)
        route, _, query = path.partition('?')
        q = dict(urllib.parse.parse_qsl(query))
        parts = [urllib.parse.unquote(x) for x in route.split('/')[3:]]
        if method == 'GET' and parts == ['info']:
            out = {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM}
            if self.features is not None:
                out['features'] = list(self.features)
                if self.novation is not None:
                    out['novation'] = copy.deepcopy(self.novation)
            return out
        if method == 'GET' and len(parts) == 2 and parts[0] == 'participants' and parts[1] in KEYS:
            return {'id': parts[1], 'handle': HANDLES[parts[1]], 'status': 'active', 'pubkey': self.pk(parts[1])}
        if method == 'GET' and parts == ['participants']:          # the public directory
            return [{'id': pid, 'handle': HANDLES[pid], 'status': 'active', 'pubkey': self.pk(pid)}
                    for pid in self.directory_ids] + copy.deepcopy(self.directory_extra)
        if method == 'GET' and parts == ['owner']:                  # the owner's view (owner token only)
            if self.token == AGENT_TOKEN:       # FX-SV: the owner routes do not exist for an agent token (404)
                raise vc.ValunError('not_found', 'not found', 404)
            pid = {OWNER_TOKEN: self.me_id, OTHER_OWNER: E_ID}.get(self.token)   # E's owner token is another's
            if pid is None:
                raise vc.ValunError('unauthorized', 'owner token required', 401)
            return {'participant': {'id': pid, 'handle': HANDLES[pid]}, 'mandate': dict(self.mandate)}
        if method == 'GET' and parts == ['me']:
            return {'role': 'agent', 'participant': {'id': self.me_id}, 'mandate': dict(self.mandate),
                    'effective_limits': dict(self.mandate)}
        if len(parts) >= 2 and parts[0] == 'deals' and parts[1] in self.deals:
            did, rest = parts[1], parts[2:]
            if method == 'GET' and not rest:
                return copy.deepcopy(self.deals[did])
            if method == 'GET' and rest == ['credit-note-template']:
                return self.note_template(did, bound=q.get('bound') == '1')
            if method == 'POST' and rest == ['complete']:
                return self.complete(did, body)
            if method == 'GET' and rest == ['payment-options']:
                return self.payment_options(did)
            if method == 'GET' and rest == ['transfer-template']:
                return self.transfer_template(did, q.get('issuer'))
            if method == 'POST' and rest == ['pay-by-transfer']:
                out = self.pay(did, body)
                if self.lose_answer:
                    raise vc.ValunError('unreachable', 'cannot reach the server')
                return out
            if method == 'POST' and rest == ['cancel-transfer']:
                self.deals[did]['status'] = 'payment_due'
                if TID in self.transfers:
                    self.transfers[TID]['state'] = 'cancelled'
                return copy.deepcopy(self.deals[did])
            if method == 'POST' and rest == ['counter']:
                return {'id': did, 'status': 'open'}
        if parts == ['consents'] and method == 'GET':
            return {'consents': copy.deepcopy(self.consent_items), 'recently_resolved': []}
        if len(parts) == 2 and parts[0] == 'consents' and method == 'POST':
            return self.consent(parts[1], body)
        if len(parts) == 3 and parts[0] == 'consents' and parts[2] == 'refuse' and method == 'POST':
            self.refusals.append((parts[1], body))
            return {'id': parts[1], 'state': 'refused'}
        if parts == ['edges'] and method == 'GET' and self.features:
            return self.edges(int(q.get('since', '0')))
        circ = bool(self.features and 'circulation/1' in self.features)
        if method == 'GET' and len(parts) == 2 and parts[0] == 'transfers' and circ:
            if parts[1] not in self.transfers:
                raise vc.ValunError('not_found', 'not found', 404)
            view = self.transfer_view(self.transfers[parts[1]])
            return view if self.transfer_view_edges else dict(view, edges=[])
        if method == 'POST' and len(parts) == 6 and parts[:2] == ['owner', 'deals'] and parts[3] == 'attempts' \
                and parts[5] == 'resolve' and circ:
            return self.resolve(parts[2], parts[4], body)
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)

    def transfer_view(self, t):
        """GET /transfers/:vt as valun-app FX-SV shows it to the payer (transferView: both edges, the deal)."""
        return {'id': t['id'], 'kind': 'transfer', 'state': t['state'], 'your_roles': ['payer'], 'attempt': 1,
                'regenerated_from': None, 'regenerated_as': None, 'timestamp': t['timestamp'], 'amount': t['amount'],
                'issuer': {'id': A_ID, 'handle': HANDLES[A_ID]}, 'payer': {'id': B_ID, 'handle': HANDLES[B_ID]},
                'payee': {'id': C_ID, 'handle': HANDLES[C_ID]},
                'edges': [{'edge': e, 'before': copy.deepcopy(b), 'new_total': n, 'change': n - (b['total'] if b else 0),
                           'timestamp': t['timestamp']} for e, b, n in (t['from'], t['to'])],
                'deal': {'deal_id': t['deal_id'], 'terms_hash': self.deals[t['deal_id']]['agreement']['terms_hash'],
                         'price': t['amount'], 'quote_digest': t['quote_digest']},
                'result': None, 'fallback_after': None, 'signatures': None,
                'signatures_withheld': 'withheld until the Basis tracker records the transfer',
                **({'resolution': {'outcome': t['resolution']['outcome'], 'at': t['resolution']['at']}}
                   if t.get('resolution') else {})}

    def resolve(self, did, tid, body):
        """POST /owner/deals/:vd/attempts/:vt/resolve as valun-app FX-SV answers it (resolveAttempt). Like an attempt
        it does not hold, an agent token (the owner routes do not exist for it, http.mjs) and another participant's
        owner token (no party to the deal, partyDeal) get 404 not_found; a token it does not know gets 401."""
        if self.token == AGENT_TOKEN:
            raise vc.ValunError('not_found', 'not found', 404)
        if self.token == OTHER_OWNER:
            raise vc.ValunError('not_found', f'unknown deal {did}', 404)
        if self.token != OWNER_TOKEN:
            raise vc.ValunError('unauthorized', 'owner token required', 401)
        t = self.transfers.get(tid)
        if t is None or t['deal_id'] != did:
            raise vc.ValunError('not_found', f'unknown payment attempt {tid}', 404)
        if t['state'] not in ('outcome_unknown', 'inconsistent'):
            raise vc.ValunError('wrong_state', f"this payment attempt is {t['state']}; only one whose outcome is unknown "
                                               '(outcome_unknown or inconsistent) is resolved by its owner', 409)
        if body.get('outcome') not in ('not_applied', 'applied'):
            raise vc.ValunError('invalid_field', 'outcome must be "not_applied" or "applied"', 400)
        note = body.get('note')
        if note is not None and (not isinstance(note, str) or len(note.strip()) > 300
                                 or any(not ch.isprintable() for ch in note)):
            raise vc.ValunError('invalid_field', 'note is longer than 300 characters', 400)
        self.resolutions.append((did, tid, copy.deepcopy(body)))
        previous = t['state']
        t['state'] = 'applied' if body['outcome'] == 'applied' else 'resolved_not_applied'
        t['resolution'] = {'outcome': body['outcome'], 'at': '2026-11-08T13:00:00.000Z'}
        if body['outcome'] == 'applied':
            self.deals[did].update(status='paid_by_transfer', payment={'method': 'transfer', 'transfer_id': tid})
        return {'resolution': {'attempt_id': tid, 'outcome': body['outcome'], 'previous_state': previous,
                               'at': '2026-11-08T13:00:00.000Z', 'note': (note or '').strip()},
                'deal': copy.deepcopy(self.deals[did]), 'transfer': self.transfer_view(t)}

    def parties(self, did):
        t = self.deals[did]['current']['terms']
        return t, self.pk(t['payer']['id']), self.pk(t['payee']['id'])

    def note_template(self, did, bound):
        d = self.deals[did]
        t, I, R = self.parties(did)
        cur = self.tracker.get(f'{I}>{R}')
        last = cur['timestamp'] if cur else 0
        if bound:
            ts = next_ts(self.clock.now, 997, last)
        else:
            ts = max(self.clock.now - 1500, last + 1)
            if self.features and ts % 1000 >= 995:
                ts += 1000 - ts % 1000
        P, price = (cur['total'] if cur else 0), t['price']['amount']
        tpl = {'deal_id': did, 'terms_hash': d['agreement']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
               'issuer_pubkey': I, 'recipient_pubkey': R, 'keys_as_agreed': True, 'prior_total': P, 'price': price,
               'total': P + price, 'timestamp': ts, 'tracker_nft_id': NFT, 'denomination': DENOM, 'message_hex': '00'}
        if bound:
            tpl.update(prior_note=dict(cur) if cur else None, prior_message_hex='00')
        return tpl

    def complete(self, did, body):
        d = self.deals[did]
        t, I, R = self.parties(did)
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        payer = KEYS[t['payer']['id']]
        if not signed_by(payer, vc.statement('complete', h, dh).encode(), body['signature']):
            raise vc.ValunError('bad_signature', 'the completion statement does not verify', 403)
        n, edge = body['credit_note'], f'{I}>{R}'
        cur = self.tracker.get(edge)
        P = cur['total'] if cur else 0
        if n['total'] != P + t['price']['amount']:
            raise vc.ValunError('stale_note', 'the credit note total is not the prior plus the price', 409)
        if not signed_by(payer, msg(I, R, n['total'], n['timestamp']), n['signature']):
            raise vc.ValunError('bad_signature', 'the Basis note signature does not verify', 403)
        if n['timestamp'] % 1000 == 997:
            p = cur['timestamp'] if cur else 0
            if n.get('prior_total') != P or n.get('prior_timestamp', p) != p:
                raise vc.ValunError('stale_note', "a bound note's prior_total and prior_timestamp must be the pair's current "
                                                  'state', 409)
            if not signed_by(payer, pa(I, R, P, p, n['timestamp']), n.get('prior_signature')):
                raise vc.ValunError('bad_signature', 'the prior acknowledgment does not verify', 403)
        if self.review:
            d['status'] = 'completion_awaiting_owner'
            return copy.deepcopy(d)
        self.tracker[edge] = {'total': n['total'], 'timestamp': n['timestamp'], 'signature': n['signature']}
        self.seq += 1
        self.journal.append(dict(seq=self.seq, at='2026-11-08T12:00:00.000Z', kind='issue', ref=did, edge=edge, issuer_pubkey=I,
                                 recipient_pubkey=R, delta=n['total'] - P, total_after=n['total'], timestamp=n['timestamp'],
                                 signature=n['signature']))
        d['status'] = 'note_issued'
        d['credit_note'] = {'state': 'recorded', 'note': {'total': n['total'], 'timestamp': n['timestamp'], 'signature': n['signature']},
                            'tracker_note': {'amount_collected': n['total'], 'amount_redeemed': 0, 'timestamp': n['timestamp'],
                                             'signature': n['signature'], 'confirmation': 'local_only'}}
        return copy.deepcopy(d)

    def payment_options(self, did):
        t, Bk, _C = self.parties(did)
        held = []
        for iid in self.option_issuers:
            cur = self.tracker.get(f'{self.pk(iid)}>{Bk}')
            total = cur['total'] if cur else 0
            held.append({'issuer': {'id': iid, 'handle': HANDLES[iid], 'pubkey': self.pk(iid), 'operator_run': True},
                         'held': total, 'reserved': 0, 'spendable': total, 'enough': total >= t['price']['amount'],
                         'payee_accepts': True, 'issuer_consents': 'immediate', 'payee_consents': 'immediate', 'why_not': None})
        return {'deal_id': did, 'price': t['price']['amount'], 'payee': {'id': t['payee']['id']},
                'own_note': {'available': True, 'why_not': None}, 'held_notes': held, 'pending_transfer': None, 'fallback_after': None}

    def transfer_template(self, did, issuer_id):
        if issuer_id not in KEYS:
            raise vc.ValunError('not_found', 'no such participant', 404)
        d = self.deals[did]
        t, Bk, Ck = self.parties(did)
        Ak = self.pk(issuer_id)
        fb, tb = self.tracker.get(f'{Ak}>{Bk}'), self.tracker.get(f'{Ak}>{Ck}')
        if fb is None:
            raise vc.ValunError('insufficient_claim', 'you hold no note of this issuer', 409)
        a = t['price']['amount']
        T = next_ts(self.clock.now, 999, max(fb['timestamp'], tb['timestamp'] if tb else 0))
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        q = nv.quote_digest({'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': did, 'terms_hash': h,
                             'deliverable_sha256': dh, 'issuer_pubkey': Ak, 'payer_pubkey': Bk, 'payee_pubkey': Ck, 'amount': a})

        def who(pid, pk):
            return {'id': pid, 'handle': HANDLES[pid], 'pubkey': pk}
        return {'deal_id': did, 'terms_hash': h, 'deliverable_sha256': dh, 'issuer': who(issuer_id, Ak),
                'payer': who(t['payer']['id'], Bk), 'payee': who(t['payee']['id'], Ck), 'amount': a, 'timestamp': T,
                'from_edge': {'before': dict(fb), 'new_total': fb['total'] - a},
                'to_edge': {'before': dict(tb) if tb else None, 'new_total': (tb['total'] if tb else 0) + a},
                'tracker_nft_id': NFT, 'denomination': DENOM, 'quote_digest': q, 'collect_until': '2026-11-08T12:20:00.000Z',
                'messages': {f'{Ak}>{Bk}:prior': '00' * 80, f'{Ak}>{Bk}:new': '00' * 80, f'{Ak}>{Ck}:new': '00' * 80}}

    def pay(self, did, body):
        self.pay_posts.append(copy.deepcopy(body))
        if self.force:
            code, fn, *extra = self.force.pop(0)
            if fn:
                fn()
            if extra:                            # the answer of a transfer the server recorded (no fresh template)
                raise vc.ValunError(code, f'forced {code}', 409, copy.deepcopy(extra[0]))
            raise vc.ValunError(code, f'forced {code}', 409, {'template': self.transfer_template(did, body['issuer_id'])})
        d = self.deals[did]
        t, Bk, Ck = self.parties(did)
        Ak, a, T = self.pk(body['issuer_id']), t['price']['amount'], body['timestamp']
        fb, tb = self.tracker[f'{Ak}>{Bk}'], self.tracker.get(f'{Ak}>{Ck}')
        X, Y = fb['total'], tb['total'] if tb else 0
        if self.transfer_mode == 'due':          # the server ended the transfer without applying it
            self.record_transfer(did, 'failed', T, (f'{Ak}>{Bk}', fb, X - a), (f'{Ak}>{Ck}', tb, Y + a), a, body)
            self.deals[did].update(status='payment_due', payment={'method': 'transfer', 'transfer_id': TID, 'state': 'failed'})
            return copy.deepcopy(self.deals[did])
        if (body['from_prior_total'], body['to_prior_total']) != (X, Y) \
                or (body.get('from_prior_timestamp', fb['timestamp']), body.get('to_prior_timestamp', tb['timestamp'] if tb else 0)) \
                != (fb['timestamp'], tb['timestamp'] if tb else 0):
            raise vc.ValunError('transfer_stale', 'an edge moved', 409, {'template': self.transfer_template(did, body['issuer_id'])})
        h, dh, payer = d['agreement']['terms_hash'], d['delivery']['sha256'], KEYS[t['payer']['id']]
        q = self.transfer_template(did, body['issuer_id'])['quote_digest']
        ok = (body['quote_digest'] == q and signed_by(payer, vc.statement('complete', h, dh).encode(), body['completion_signature'])
              and signed_by(payer, nv.pay_statement(did, q).encode(), body['pay_signature'])
              and set(body['signatures']) == {f'{Ak}>{Bk}:prior', f'{Ak}>{Bk}:new', f'{Ak}>{Ck}:new'}
              and signed_by(payer, pa(Ak, Bk, X, fb['timestamp'], T), body['signatures'][f'{Ak}>{Bk}:prior'])
              and signed_by(payer, msg(Ak, Bk, X - a, T), body['signatures'][f'{Ak}>{Bk}:new'])
              and signed_by(payer, msg(Ak, Ck, Y + a, T), body['signatures'][f'{Ak}>{Ck}:new']))
        if not ok:
            raise vc.ValunError('bad_signature', 'a signature of the payment does not verify', 403)
        d['payment'] = {'method': 'transfer', 'transfer_id': TID}
        self.record_transfer(did, {'apply': 'applied', 'review': 'awaiting_owner'}.get(self.transfer_mode, 'collecting'), T,
                             (f'{Ak}>{Bk}', fb, X - a), (f'{Ak}>{Ck}', tb, Y + a), a, body)
        if self.transfer_mode == 'apply':
            issuer = KEYS[body['issuer_id']]
            self.set_edge(issuer, KEYS[t['payer']['id']], X - a, T, kind='transfer_out', ref=TID)
            self.set_edge(issuer, KEYS[t['payee']['id']], Y + a, T, kind='transfer_in', ref=TID)
            self.bound_only |= {f'{Ak}>{Bk}', f'{Ak}>{Ck}'}
            d['status'] = 'paid_by_transfer'
        else:
            d['status'] = 'completion_awaiting_owner' if self.transfer_mode == 'review' else 'paying_by_transfer'
        return copy.deepcopy(d)

    def record_transfer(self, did, state, T, frm, to, amount, body):
        """The server records the transfer (id TID: one per deal here), as GET /transfers shows it later."""
        self.transfers[TID] = {'id': TID, 'deal_id': did, 'state': state, 'timestamp': T, 'amount': amount,
                               'from': (frm[0], copy.deepcopy(frm[1]), frm[2]), 'to': (to[0], copy.deepcopy(to[1]), to[2]),
                               'quote_digest': body.get('quote_digest')}

    def consent(self, cid, body):
        item = next((i for i in self.consent_items if i['id'] == cid), None)
        if item is None:
            raise vc.ValunError('not_found', 'no such consent', 404)
        me = KEYS[self.me_id]
        edges = {e['edge']: e for e in item['edges']}
        for slot, sig in body['signatures'].items():
            edge, _, which = slot.rpartition(':')
            e = edges[edge]
            i, r = edge.split('>')
            if which == 'prior':              # tracker v3.2: PA over the state the item shows, (0, 0) for none
                data = pa(i, r, e['before']['total'] if e['before'] else 0, e['before']['timestamp'] if e['before'] else 0,
                          e['timestamp'])
            else:
                data = msg(i, r, e['new_total'], e['timestamp'])
            if not signed_by(me, data, sig):
                raise vc.ValunError('bad_signature', f'{slot} does not verify', 403)
        self.consent_posts.append((cid, copy.deepcopy(body)))
        return dict(copy.deepcopy(item), state=self.consent_state.get(cid, 'collecting'),
                    rejected=copy.deepcopy(self.consent_rejected.get(cid, [])))

    def edges(self, since):
        me = self.pk(self.me_id)

        def who(pk):
            pid = next((p for p, k in KEYS.items() if k['pubkey'] == pk), None)
            return {'id': pid, 'handle': HANDLES.get(pid)}

        rows = []
        for edge, s in self.tracker.items():
            i, r = edge.split('>')
            if me in (i, r):
                rows.append(dict(s, edge=edge, issuer=who(i), recipient=who(r), issuer_pubkey=i, recipient_pubkey=r,
                                 exact=True, bound_only=edge in self.bound_only, reserved=0, frozen=False))
        entries = [e for e in self.journal if e['seq'] > since and me in (e['issuer_pubkey'], e['recipient_pubkey'])]
        page = entries[:self.page]
        return {'incoming': [x for x in rows if x['recipient_pubkey'] == me], 'outgoing': [x for x in rows if x['issuer_pubkey'] == me],
                'journal': copy.deepcopy(page), 'next_seq': page[-1]['seq'] if len(entries) > self.page else self.seq}

    # ---------- what the client asked ----------
    def requests(self, method=None):
        return [f'{m} {p}' for m, p, _b in self.log if method is None or m == method]


class MemStore:
    """A store without update(): the client applies changes and calls save()."""

    def __init__(self, state, secret, token='vpa_test-only'):
        self.state, self._s, self._t = state, secret, token

    def secret(self):
        return self._s

    def token(self):
        return self._t

    def save(self):
        pass

    def save_credentials(self, secret_hex, token):
        self._s, self._t = secret_hex, token


def profile(me_id=B_ID, **extra):
    k = KEYS[me_id]
    state = {'server': SERVER, 'participant_id': me_id, 'pubkey': k['pubkey'], 'issued': {}, 'pins': dict(PINS)}
    state.update(extra)
    return MemStore(state, k['secret'].hex())


class NetClient(vc.Client):
    def __init__(self, net, store):
        super().__init__(store, server=SERVER)
        self.net = net

    def request(self, method, path, body=None, auth=True, token=None):
        self.net.token = token                   # the token a request carries instead of the agent's (owner routes)
        return self.net.handle(method, path, json.loads(json.dumps(body)) if body is not None else None)


class Base(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        p = mock.patch.object(vc, 'time', types.SimpleNamespace(time=self.clock.time))
        p.start()
        self.addCleanup(p.stop)
        self.net = Net(self.clock)
        self.net.add_deal()
        self.net.set_edge(A, B, 10, TS_AB)           # B holds 10 PC of A's notes
        self.net.set_edge(A, C, 4, TS_AC)            # C holds 4
        self.net.set_edge(B, C, 6, TS_BC)            # B owes C 6

    def client(self, store=None):
        self.store = store or profile()
        return NetClient(self.net, self.store)


def att(state, deal_id=DEAL):
    return (state.get('transfer_attempts') or {}).get(deal_id) or []


# ---------------------------------------------------------------------------------------------------------------------
class BoundComplete(Base):
    def test_the_note_and_its_prior_acknowledgment_are_signed_and_sent(self):
        c = self.client()
        r = c.complete(DEAL)
        self.assertEqual(r['status'], 'note_issued')
        self.assertIn(f'GET /pilot/v1/deals/{DEAL}/credit-note-template?prior=1&bound=1', self.net.requests())
        (_m, _p, body), = [x for x in self.net.log if x[0] == 'POST']
        n = body['credit_note']
        self.assertEqual(set(n), {'total', 'timestamp', 'signature', 'prior_total', 'prior_timestamp', 'prior_signature'})
        self.assertEqual((n['prior_total'], n['prior_timestamp'], n['total'], n['timestamp'] % 1000), (6, TS_BC, 9, 997))
        self.assertTrue(signed_by(B, msg(B['pubkey'], C['pubkey'], 9, n['timestamp']), n['signature']))
        # tracker v3.2: the prior acknowledgment is PA(B,C,6,TS_BC,ts), never the 80-byte M(B,C,6,ts)
        self.assertTrue(signed_by(B, pa(B['pubkey'], C['pubkey'], 6, TS_BC, n['timestamp']), n['prior_signature']))
        self.assertFalse(signed_by(B, msg(B['pubkey'], C['pubkey'], 6, n['timestamp']), n['prior_signature']))
        s = self.store.state
        self.assertEqual(records.get(s['records'], BC)['confirmed']['total'], 9)
        self.assertEqual(s['issued'], {BC: 9})
        self.assertEqual(s['records']['paid_deals'][DEAL], {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': n['timestamp']})
        self.assertEqual([(a['route'], a['edge'], a['prior'], a['total'], a['timestamp'], a['ack']) for a in att(s)],
                         [('note', BC, 6, 9, n['timestamp'], 'basis/prior-ack/1')])
        self.assertEqual(s['signed'][BC][str(n['timestamp'])], {'op': f'note:{DEAL}', 'slots': {f'{BC}:prior': 6, f'{BC}:new': 9},
                                                                 'prior_state': {'total': 6, 'timestamp': TS_BC}})

    def test_a_first_note_acknowledges_an_absent_edge(self):
        del self.net.tracker[BC]
        c = self.client()
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')
        n = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']
        self.assertEqual((n['prior_total'], n['prior_timestamp'], n['total']), (0, 0, 3))
        self.assertTrue(signed_by(B, pa(B['pubkey'], C['pubkey'], 0, 0, n['timestamp']), n['prior_signature']))   # (0, 0): no edge

    def test_a_deal_recorded_as_paid_is_never_paid_again(self):
        c = self.client()
        c.complete(DEAL)
        self.net.deals[DEAL].update(status='delivered', credit_note=None)      # a server that offers it again
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual(self.net.requests('POST'), [f'POST /pilot/v1/deals/{DEAL}/complete'])

    def test_a_held_bound_note_that_failed_is_signed_again_with_the_same_prior(self):
        # D-1 item 4: the owner approved too late, the tracker refused it (novation_expired) and the deal is note_failed.
        self.net.review = True
        c = self.client()
        self.assertEqual(c.complete(DEAL)['status'], 'completion_awaiting_owner')
        self.net.review = False
        self.net.deals[DEAL]['status'] = 'note_failed'
        self.clock.now += 20 * 60_000                   # within the first attempt's hour: a same-kind retry, same prior
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')
        first, second = [b['credit_note'] for m, _p, b in self.net.log if m == 'POST']
        self.assertEqual((first['prior_total'], second['prior_total']), (6, 6))
        self.assertGreater(second['timestamp'], first['timestamp'])
        self.assertEqual(len(att(self.store.state)), 2)
        self.assertEqual(records.get(self.store.state['records'], BC)['pending'], [])

    def test_a_held_note_approved_later_pays_its_deal(self):
        # Held for the owner, approved later: the deal view shows it issued. Asked to pay the deal again, the client
        # confirms its note from the deal, records the deal as paid, and refuses.
        self.net.review = True
        c = self.client()
        c.complete(DEAL)
        n = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']
        self.net.review = False
        self.net.tracker[BC] = {'total': n['total'], 'timestamp': n['timestamp'], 'signature': n['signature']}
        self.net.deals[DEAL].update(status='note_issued', credit_note={'state': 'recorded', 'tracker_note': {
            'amount_collected': n['total'], 'amount_redeemed': 0, 'timestamp': n['timestamp'], 'signature': n['signature']}})
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'already_paid')
        s = self.store.state
        self.assertEqual(s['records']['paid_deals'][DEAL], {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': n['timestamp']})
        self.assertEqual((records.get(s['records'], BC)['confirmed']['total'], s['issued']), (9, {BC: 9}))
        self.assertEqual(len(self.net.requests('POST')), 1)

    def test_a_refused_bound_note_is_forgotten_but_its_attempt_is_kept(self):
        def refuse(method, path, body):
            if method == 'POST':
                raise vc.ValunError('bad_signature', 'forced', 403)
        self.net.hooks.append(refuse)
        c = self.client()
        with self.assertRaises(vc.ValunError):
            c.complete(DEAL)
        self.assertEqual(records.get(self.store.state['records'], BC)['pending'], [])
        self.assertEqual(len(att(self.store.state)), 1)


class WriteAhead(Base):
    """R9: what is about to be signed is on disk (a FileStore profile) before the HTTP POST that carries it is attempted."""

    def file_client(self, me_id=B_ID, **extra):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        path = os.path.join(d.name, 'p.json')
        state = dict(profile(me_id, **extra).state, secret=KEYS[me_id]['secret'].hex(), agent_token='vpa_test-only')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(state, f)
        self.disk = []

        def snapshot(method, path_, body):
            if method == 'POST':
                with open(path, encoding='utf-8') as f:
                    self.disk.append((path_, json.load(f)))
        self.net.hooks.append(snapshot)
        return NetClient(self.net, vc.FileStore(path))

    def test_bound_complete(self):
        self.file_client().complete(DEAL)
        (path, disk), = self.disk
        T = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']['timestamp']
        self.assertEqual(path, f'/pilot/v1/deals/{DEAL}/complete')
        self.assertEqual(disk['signed'][BC][str(T)]['op'], f'note:{DEAL}')
        self.assertEqual([a['timestamp'] for a in disk['transfer_attempts'][DEAL]], [T])
        self.assertEqual([(p['total'], p['timestamp'], p['kind'], p['ref']) for p in disk['records'][BC]['pending']],
                         [(9, T, 'note', DEAL)])

    def test_pay_by_transfer(self):
        self.file_client().pay_by_transfer(DEAL, A_ID)
        (path, disk), = self.disk
        body = self.net.pay_posts[0]
        T = body['timestamp']
        self.assertEqual(path, f'/pilot/v1/deals/{DEAL}/pay-by-transfer')
        self.assertEqual(disk['signed'][AB][str(T)], {'op': f'pay:{DEAL}', 'slots': {f'{AB}:prior': 10, f'{AB}:new': 7},
                                                      'prior_state': {'total': 10, 'timestamp': TS_AB}})
        self.assertEqual(disk['signed'][AC][str(T)], {'op': f'pay:{DEAL}', 'slots': {f'{AC}:new': 7}})
        self.assertEqual([(a['route'], a['edge'], a['prior'], a['total'], a['ack']) for a in disk['transfer_attempts'][DEAL]],
                         [('transfer', AB, 10, 7, 'basis/prior-ack/1')])
        self.assertEqual([(p['total'], p['timestamp'], p['kind'], p['ref'], p['direction']) for p in disk['records'][AB]['pending']],
                         [(7, T, 'transfer', DEAL, 'in')])
        self.assertEqual(disk['approved_payments'], {DEAL: body['quote_digest']})

    def test_a_consent(self):
        self.net.me_id = A_ID
        self.net.consent_items = [issuer_item(res(NOW - 1500, 999))]
        self.file_client(A_ID, consent_policy=dict(POLICY)).process_consents()
        (path, disk), = self.disk
        T = res(NOW - 1500, 999)
        self.assertEqual(path, f'/pilot/v1/consents/{TID}')
        self.assertEqual(disk['signed'][AB][str(T)], {'op': f'transfer:{TID}', 'slots': {f'{AB}:new': 7}})
        self.assertEqual(disk['signed'][AC][str(T)], {'op': f'transfer:{TID}', 'slots': {f'{AC}:new': 7}})
        self.assertEqual([(p['total'], p['ref']) for p in disk['records'][AB]['pending']], [(7, TID)])


class PayByTransfer(Base):
    def test_body_shape_and_signatures(self):
        c = self.client()
        r = c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(r['status'], 'paid_by_transfer')
        reqs = self.net.requests()
        self.assertLess(reqs.index(f'GET /pilot/v1/deals/{DEAL}/payment-options'),
                        reqs.index(f'GET /pilot/v1/deals/{DEAL}/transfer-template?issuer={A_ID}'))
        body, = self.net.pay_posts
        self.assertEqual(set(body), {'issuer_id', 'terms_hash', 'deliverable_sha256', 'quote_digest', 'timestamp', 'from_prior_total',
                                     'from_prior_timestamp', 'to_prior_total', 'to_prior_timestamp', 'completion_signature',
                                     'pay_signature', 'signatures'})
        d = self.net.deals[DEAL]
        h, dh, T = d['agreement']['terms_hash'], d['delivery']['sha256'], body['timestamp']
        q = nv.quote_digest({'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': DEAL, 'terms_hash': h,
                             'deliverable_sha256': dh, 'issuer_pubkey': A['pubkey'], 'payer_pubkey': B['pubkey'],
                             'payee_pubkey': C['pubkey'], 'amount': 3})
        self.assertEqual((body['issuer_id'], body['terms_hash'], body['deliverable_sha256'], body['quote_digest']), (A_ID, h, dh, q))
        self.assertEqual((body['from_prior_total'], body['from_prior_timestamp'], body['to_prior_total'],
                          body['to_prior_timestamp'], T % 1000), (10, TS_AB, 4, TS_AC, 999))
        self.assertTrue(signed_by(B, vc.statement('complete', h, dh).encode(), body['completion_signature']))
        pay = nv.pay_statement(DEAL, q).encode()
        self.assertEqual(len(pay), 102)
        self.assertTrue(signed_by(B, pay, body['pay_signature']))
        self.assertEqual(set(body['signatures']), {f'{AB}:prior', f'{AB}:new', f'{AC}:new'})
        self.assertTrue(signed_by(B, pa(A['pubkey'], B['pubkey'], 10, TS_AB, T), body['signatures'][f'{AB}:prior']))
        self.assertFalse(signed_by(B, msg(A['pubkey'], B['pubkey'], 10, T), body['signatures'][f'{AB}:prior']))   # not v3.1's
        for slot, (i, rcp, total) in {f'{AB}:new': (A, B, 7), f'{AC}:new': (A, C, 7)}.items():
            self.assertTrue(signed_by(B, msg(i['pubkey'], rcp['pubkey'], total, T), body['signatures'][slot]), slot)
        s = self.store.state
        self.assertEqual(s['records']['paid_deals'][DEAL], {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T})
        self.assertEqual(s['approved_payments'], {DEAL: q})

    def test_terms_of_another_deal_are_not_paid(self):
        self.net.deals[DEAL] = make_deal(DEAL2)            # the view of DEAL shows the (genuinely signed) terms of DEAL2
        for pay in (lambda c: c.pay_by_transfer(DEAL, A_ID), lambda c: c.complete(DEAL)):
            with self.assertRaises(vc.ValunError) as e:
                pay(self.client())
            self.assertEqual(e.exception.code, 'deal_mismatch')
        self.assertEqual(self.net.requests('POST'), [])
        self.assertEqual(self.net.requests(), [f'GET /pilot/v1/deals/{DEAL}'] * 2)

    def test_a_template_for_another_issuer_key_is_refused(self):
        real = self.net.transfer_template

        def lying(did, issuer_id):
            tpl = real(did, issuer_id)
            tpl['issuer']['pubkey'] = E['pubkey']
            return tpl
        self.net.transfer_template = lying
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'bad_template')
        self.assertEqual(self.net.pay_posts, [])

    def moved(self, issuer, recipient, total, dt):
        """For Net.force: an edge moves while the payment is posted (to a timestamp dt after the posted T), and time
        passes, as when a server answers transfer_stale."""
        def fn():
            T = self.net.pay_posts[-1]['timestamp']
            self.clock.now += 2000
            self.net.set_edge(issuer, recipient, total, T + dt)
        return fn

    def test_a_stale_transfer_on_the_same_claim_is_signed_again_at_a_new_timestamp(self):
        # Tracker v3.2 (audit VS-1 closed): the payee's claim on A moved between the template and the POST; my claim did
        # not. The fresh template, at a new T, acknowledges the same state of my claim, (10, TS_AB), as the first
        # attempt: both prior acknowledgments are PA(A,B,10,TS_AB,T), and A->B is at that state at most once, so at most
        # one of the two can apply. It is signed at once (v3.1 clients waited an hour for the first attempt's window).
        self.net.force = [('transfer_stale', self.moved(A, C, 5, 1))]
        c = self.client()
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')
        first, second = self.net.pay_posts
        self.assertGreater(second['timestamp'], first['timestamp'])
        self.assertEqual([(p['from_prior_total'], p['from_prior_timestamp'], p['to_prior_total']) for p in (first, second)],
                         [(10, TS_AB, 4), (10, TS_AB, 5)])
        self.assertEqual(second['to_prior_timestamp'], first['timestamp'] + 1)
        self.assertEqual([(a['prior'], a['prior_timestamp'], a['timestamp']) for a in att(self.store.state)],
                         [(10, TS_AB, first['timestamp']), (10, TS_AB, second['timestamp'])])
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL]['timestamp'], second['timestamp'])

    def test_a_stale_transfer_is_not_signed_again_when_my_claim_came_back_to_its_total(self):
        # Another state of my claim at the same total (it moved and came back before the first attempt's T): not the
        # same prior state, so the fresh template waits for the first attempt's window (unchanged since v3.1).
        self.net.force = [('transfer_stale', self.moved(A, B, 10, -1))]
        c = self.client()
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertGreater(e.exception.extra['retry_after_ms'], 3_600_000)
        first, = self.net.pay_posts                                                       # nothing sent again
        self.assertEqual(records.get(self.store.state['records'], AB)['pending'], [])      # refused: forgotten
        self.assertEqual(len(att(self.store.state)), 1)                                   # the attempt stays (D-1)

    def test_a_stale_answer_with_the_same_template_is_signed_again(self):
        # The identical operation (the same T and totals) is excluded by the first at the tracker: signed again once.
        tpl = self.net.transfer_template(DEAL, A_ID)          # the template the client reads first (same clock)
        self.net.force = [('transfer_stale', None, {'template': tpl})]
        c = self.client()
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')
        first, second = self.net.pay_posts
        self.assertEqual([(p['timestamp'], p['from_prior_total'], p['to_prior_total'], p['quote_digest']) for p in (first, second)],
                         [(tpl['timestamp'], 10, 4, tpl['quote_digest'])] * 2)
        self.assertEqual(len(att(self.store.state)), 1)

    def test_no_retry_when_my_own_claim_moved(self):
        # The fresh template acknowledges another prior of my claim on A: not a same-kind retry with the same prior (D-1).
        # Moved to a state before the first attempt's T: that attempt may still apply, so a new one waits for its window.
        self.net.force = [('transfer_stale', self.moved(A, B, 12, -1))]
        c = self.client()
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertGreater(e.exception.extra['retry_after_ms'], 3_600_000)
        self.assertEqual(len(self.net.pay_posts), 1)
        # Moved past the first attempt's T to a total that is neither its prior nor its new total: it may have applied.
        self.setUp()
        self.net.force = [('transfer_stale', self.moved(A, B, 12, 1))]
        c = self.client()
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        self.assertEqual(len(self.net.pay_posts), 1)

    def test_stale_claim_and_stale_quote_sign_nothing(self):
        for kw, code in (({'expected_claim_total': 9}, 'stale_claim'), ({'expected_quote_digest': '00' * 32}, 'stale_quote')):
            self.setUp()
            c = self.client()
            with self.assertRaises(vc.ValunError) as e:
                c.pay_by_transfer(DEAL, A_ID, **kw)
            self.assertEqual(e.exception.code, code)
            self.assertEqual(self.net.pay_posts, [])
            s = self.store.state
            self.assertEqual((att(s), s.get('signed') or {}, records.get(s.get('records') or {}, AB)['pending']), ([], {}, []))

    def test_the_pins_the_owner_saw_are_accepted(self):
        tpl = self.net.transfer_template(DEAL, A_ID)
        c = self.client()
        d = self.net.deals[DEAL]
        r = c.pay_by_transfer(DEAL, A_ID, d['delivery']['sha256'], tpl['quote_digest'], 10)
        self.assertEqual(r['status'], 'paid_by_transfer')

    def test_issuer_resolution_takes_an_exact_id_first(self):
        self.net.option_issuers = [F_ID, A_ID]          # F's handle is A's id, and F is listed first
        self.client().pay_by_transfer(DEAL, A_ID)
        self.assertIn(f'GET /pilot/v1/deals/{DEAL}/transfer-template?issuer={A_ID}', self.net.requests())
        self.assertNotIn(f'GET /pilot/v1/deals/{DEAL}/transfer-template?issuer={F_ID}', self.net.requests())

    def test_issuer_resolution_by_handle_and_unknown(self):
        self.net.option_issuers = [A_ID]
        self.client().pay_by_transfer(DEAL, 'issuer-a')
        self.assertEqual(self.net.pay_posts[0]['issuer_id'], A_ID)
        self.setUp()
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(DEAL, 'nobody')
        self.assertEqual(e.exception.code, 'unknown_issuer')
        self.assertEqual(self.net.pay_posts, [])

    def test_without_circulation_nothing_is_signed(self):
        self.net.features = ['bound_notes/1']
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'feature_unavailable')
        self.assertEqual(self.net.requests('POST'), [])
        self.assertNotIn('transfer_attempts', self.store.state)

    def test_a_held_note_the_mandate_forbids_is_refused(self):
        self.net.mandate['pay_with_held_notes'] = 'never'
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'policy_off')
        self.assertEqual(self.net.pay_posts, [])

    def test_a_delivery_not_signed_by_the_payee_is_not_paid(self):
        d = self.net.deals[DEAL]
        d['delivery']['signature'] = sign_text(E, vc.statement('deliver', d['agreement']['terms_hash'], d['delivery']['sha256']))
        with self.assertRaises(vc.ValunError) as e:
            self.client().pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'bad_delivery_signature')
        self.assertEqual(self.net.pay_posts, [])
        self.assertEqual({k for k in ('signed', 'transfer_attempts', 'approved_payments') if k in self.store.state}, set())

    def test_a_payment_due_answer_forgets_the_pending_entry_and_keeps_the_attempt(self):
        self.net.transfer_mode = 'due'
        c = self.client()
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'payment_due')
        self.assertEqual(records.get(self.store.state['records'], AB)['pending'], [])
        (a,) = att(self.store.state)
        self.assertEqual((a['route'], a['edge'], a['prior'], a['total'], a['attempt_id']), ('transfer', AB, 10, 7, TID))
        self.assertNotIn(DEAL, self.store.state['records'].get('paid_deals') or {})

    def test_an_absent_destination_edge_is_acknowledged_as_0(self):
        del self.net.tracker[AC]                         # the payee has no claim on A yet
        c = self.client()
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')
        body, = self.net.pay_posts
        self.assertEqual((body['from_prior_total'], body['to_prior_total']), (10, 0))
        self.assertTrue(signed_by(B, msg(A['pubkey'], C['pubkey'], 3, body['timestamp']), body['signatures'][f'{AC}:new']))
        self.assertEqual(att(self.store.state)[0]['attempt_id'], TID)       # the server's id of the attempt, recorded

    def test_a_recorded_transfer_that_went_stale_is_not_retried(self):
        # The server recorded the transfer; the edges changed before it applied and it was made again (regenerated_as):
        # the payer's client does not sign another one here; it returns the deal as the server shows it.
        view = dict(copy.deepcopy(self.net.deals[DEAL]), status='paying_by_transfer')
        for extra, status in (({'transfer_id': TID, 'regenerated_as': 'vt_1111111111111111', 'code': 'edge_changed',
                                'deal': view}, 'paying_by_transfer'),
                              ({'transfer_id': TID, 'regenerated_as': None, 'code': 'edge_changed'}, 'delivered')):
            self.setUp()
            self.net.force = [('transfer_stale', None, extra)]
            c = self.client()
            r = c.pay_by_transfer(DEAL, A_ID)
            self.assertEqual(r['status'], status)
            self.assertEqual(len(self.net.pay_posts), 1)                  # no second POST, no fresh template asked
            self.assertEqual(self.net.requests().count(f'GET /pilot/v1/deals/{DEAL}/transfer-template?issuer={A_ID}'), 1)
            self.assertEqual(records.get(self.store.state['records'], AB)['pending'], [])
            self.assertEqual([x.get('attempt_id') for x in att(self.store.state)], [TID])

    def test_a_claim_pin_that_is_not_a_whole_number_is_refused(self):
        for claim in (10.0, True, -1, '10'):
            with self.assertRaises(vc.ValunError) as e:
                self.client().pay_by_transfer(DEAL, A_ID, expected_claim_total=claim)
            self.assertEqual(e.exception.code, 'bad_arguments', claim)
        self.assertEqual(self.net.log, [])                                # refused before any request

    def test_cancel_forgets_the_pending_entry_and_keeps_the_attempt(self):
        self.net.transfer_mode = 'collect'
        c = self.client()
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paying_by_transfer')
        self.assertEqual(len(records.get(self.store.state['records'], AB)['pending']), 1)
        self.assertEqual(c.cancel_transfer(DEAL)['status'], 'payment_due')
        self.assertIn(('POST', f'/pilot/v1/deals/{DEAL}/cancel-transfer', {}), self.net.log)
        self.assertEqual(records.get(self.store.state['records'], AB)['pending'], [])
        self.assertEqual(len(att(self.store.state)), 1)


class FallbackRule(Base):
    """Decision D-1: one live payment attempt per deal, across own notes and transfers (R11 extended)."""

    def failed_transfer(self):
        self.net.transfer_mode = 'collect'
        c = self.client()
        c.pay_by_transfer(DEAL, A_ID)
        c.cancel_transfer(DEAL)                      # payment_due: the transfer did not apply
        return c, self.net.pay_posts[0]['timestamp']

    def test_an_own_note_waits_until_the_transfer_attempt_is_dead(self):
        c, T = self.failed_transfer()
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertEqual(e.exception.extra['retry_after_ms'], T + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - self.clock.now)
        self.assertNotIn(f'POST /pilot/v1/deals/{DEAL}/complete', self.net.requests())
        # After T + 1 h + 2 min the attempt needs a read-back: GET /edges shows my claim on A untouched, so it is dead.
        self.clock.now = T + LATER
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')
        reqs = self.net.requests()
        self.assertLess(reqs.index('GET /pilot/v1/edges?since=0'), reqs.index(f'POST /pilot/v1/deals/{DEAL}/complete'))

    def test_an_edge_state_that_does_not_verify_is_no_read_back(self):
        c, T = self.failed_transfer()
        self.net.tracker[AB] = st(A, B, 10, TS_AB, signer=E)      # GET /edges lists my claim on A, unverifiable
        self.clock.now = T + LATER
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertEqual(e.exception.extra['needs_read_back'], [AB])
        self.assertNotIn(f'POST /pilot/v1/deals/{DEAL}/complete', self.net.requests())

    def test_an_unverifiable_state_of_a_new_edge_is_not_taken_for_its_absence(self):
        # A first bound note acknowledges an absent edge (prior 0). It was held, then applied; the server hides that and
        # lists the edge with a state that does not verify. That is no read-back, so the note is not taken for dead.
        del self.net.tracker[BC]
        self.net.review = True
        c = self.client()
        self.assertEqual(c.complete(DEAL)['status'], 'completion_awaiting_owner')
        n = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']
        self.net.deals[DEAL]['status'] = 'delivered'
        self.net.tracker[BC] = st(B, C, 3, n['timestamp'], signer=E)
        self.clock.now = n['timestamp'] + LATER
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual((e.exception.code, e.exception.extra['needs_read_back']), ('transfer_window_open', [BC]))
        self.assertEqual(self.net.pay_posts, [])

    def test_a_same_issuer_retry_on_the_same_claim_is_signed_at_once(self):
        # Tracker v3.2 (audit VS-1 closed, the same-prior exemption): a retry through the same issuer at a new T that
        # acknowledges the same state of my claim on A as the cancelled first attempt is signed at once: the two
        # exclude each other at the tracker.
        c, T = self.failed_transfer()
        self.net.transfer_mode = 'apply'
        self.clock.now += 60_000
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')
        first, second = self.net.pay_posts
        self.assertEqual((first['timestamp'], first['from_prior_timestamp'], second['from_prior_timestamp']), (T, TS_AB, TS_AB))
        self.assertGreater(second['timestamp'], T)

    def test_a_same_issuer_retry_after_my_claim_moved_waits_for_the_window(self):
        # Another state of my claim (here the same total at a later timestamp, before T): not the same prior, so the
        # retry waits for the first attempt's window and a read-back like any other payment.
        c, T = self.failed_transfer()
        self.net.transfer_mode = 'apply'
        self.net.set_edge(A, B, 10, TS_AB + 5)
        self.clock.now += 60_000
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertEqual(e.exception.extra['retry_after_ms'], T + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS + 1 - self.clock.now)
        self.assertEqual(len(self.net.pay_posts), 1)                 # nothing signed or sent again
        self.clock.now = T + LATER                                  # GET /edges shows my claim on A before T: dead
        self.assertEqual(c.pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')

    def test_an_attempt_that_may_have_applied_stops_every_retry(self):
        c, T = self.failed_transfer()
        self.net.set_edge(A, B, 12, T + 5000)        # my claim moved past T to a total that is neither 10 nor 7
        self.clock.now = T + LATER
        for pay in (lambda: c.complete(DEAL), lambda: c.pay_by_transfer(DEAL, A_ID)):
            with self.assertRaises(vc.ValunError) as e:
                pay()
            self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        self.assertEqual(self.net.requests('POST'), [f'POST /pilot/v1/deals/{DEAL}/pay-by-transfer',
                                                     f'POST /pilot/v1/deals/{DEAL}/cancel-transfer'])

    def test_a_transfer_waits_for_an_own_note_that_is_held(self):
        self.net.review = True
        c = self.client()
        self.assertEqual(c.complete(DEAL)['status'], 'completion_awaiting_owner')
        with self.assertRaises(vc.ValunError) as e:
            c.pay_by_transfer(DEAL, A_ID)
        self.assertEqual(e.exception.code, 'transfer_window_open')
        self.assertEqual(self.net.pay_posts, [])


class OrdinaryPath(Base):
    """complete() without bound notes (circulation off, or an older server): R12 and D-1 apply as well."""

    def setUp(self):
        super().setUp()
        self.net.features = None

    def test_a_novated_edge_takes_bound_notes_only(self):
        c = self.client(profile(novated_edges={BC: True}))
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'bound_note_required')
        self.assertEqual(self.net.requests('POST'), [])

    def test_a_deal_recorded_as_paid_is_refused(self):
        c = self.client(profile(records={'paid_deals': {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': 1}}}))
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual(self.net.requests('POST'), [])

    def test_an_ordinary_note_records_its_deal_as_paid(self):
        c = self.client(profile(issued={BC: 6}))
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')
        self.assertIn(f'GET /pilot/v1/deals/{DEAL}/credit-note-template', self.net.requests())
        n = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']
        self.assertEqual(set(n), {'total', 'timestamp', 'signature'})
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL]['route'], 'note')
        self.assertNotIn('transfer_attempts', self.store.state)


# ---------------------------------------------------------------------------------------------------------------------
# consent items, as GET /consents shows them (PROTOCOL.md 18.9)
POLICY = {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 20}


def edge_row(issuer, recipient, before_total, before_ts, new_total, ts, your_role, slots, ids, signed_by_you=()):
    before = None if before_total is None else st(issuer, recipient, before_total, before_ts)
    return {'edge': f"{issuer['pubkey']}>{recipient['pubkey']}", 'issuer': {'id': ids[0], 'handle': HANDLES[ids[0]]},
            'recipient': {'id': ids[1], 'handle': HANDLES[ids[1]]}, 'your_role': your_role, 'before': before,
            'change': new_total - (before_total or 0), 'new_total': new_total, 'timestamp': ts, 'revision': 1,
            'slots': list(slots), 'signed_by_you': list(signed_by_you)}


def consent_item(kind, iid, role, edges, context, **over):
    it = {'kind': kind, 'id': iid, 'state': 'collecting', 'your_roles': [role], 'created_at': '2026-11-08T12:00:00.000Z',
          'expires_at': '2026-11-08T12:20:00.000Z', 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
          'edges': edges, 'context': context, 'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': 0}}
    it.update(over)
    return it


def who3():
    return {'issuer': {'id': A_ID, 'handle': 'issuer-a'}, 'payer': {'id': B_ID, 'handle': 'payer-b'},
            'payee': {'id': C_ID, 'handle': 'payee-c'}}


def issuer_item(T, iid=TID, signed_by_you=(), **over):
    return consent_item('transfer', iid, 'issuer',
                        [edge_row(A, B, 10, TS_AB, 7, T, 'issuer', ['new'], (A_ID, B_ID), signed_by_you),
                         edge_row(A, C, 4, TS_AC, 7, T, 'issuer', ['new'], (A_ID, C_ID), signed_by_you)],
                        dict(who3(), amount=3), **over)


def member_item(ts):
    """A's two edges of a set-off: its debt to B falls by 2 and its claim on E falls by 2."""
    return consent_item('setoff', SID, 'member',
                        [edge_row(A, B, 10, TS_AB, 8, ts, 'issuer', ['new'], (A_ID, B_ID)),
                         edge_row(E, A, 5, TS_EA, 3, ts, 'creditor', ['new'], (E_ID, A_ID))], {})


class Consents(Base):
    def setUp(self):
        super().setUp()
        self.net.me_id = A_ID
        self.T = res(NOW - 1500, 999)

    def test_the_report_and_what_is_posted(self):
        T = self.T
        self.net.consent_items = [
            issuer_item(T),                                                       # signed
            member_item(res(NOW - 1500, 998)),                                    # signed
            issuer_item(T, iid='vt_1111111111111111', tracker_nft_id='11' * 32),  # refused: tracker_mismatch
            issuer_item(T - 1000, iid='vt_2222222222222222', signed_by_you=['new']),   # nothing left to sign
            issuer_item(T, iid='vt_3333333333333333', state='applying'),          # not collecting
        ]
        old_log = [{'at': 'x', 'id': f'vs_{i:016x}', 'decision': 'signed'} for i in range(98)]
        c = self.client(profile(A_ID, consent_policy=dict(POLICY), consent_log=old_log))
        rep = c.process_consents()
        self.assertEqual(set(rep), {'signed', 'refused', 'waiting'})
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(TID, 'issuer'), (SID, 'member')])
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [('vt_1111111111111111', 'tracker_mismatch')])
        self.assertEqual([e['id'] for e in rep['waiting']], ['vt_2222222222222222', 'vt_3333333333333333'])
        self.assertEqual(rep['signed'][0]['your_total_owed_change_PC'], 0)
        self.assertEqual(rep['signed'][1]['your_net_change_PC'], 0)
        (c1, b1), (c2, b2) = self.net.consent_posts
        self.assertEqual((c1, set(b1['signatures']), b1['revisions']), (TID, {f'{AB}:new', f'{AC}:new'}, {AB: 1, AC: 1}))
        self.assertEqual((c2, set(b2['signatures']), b2['revisions']), (SID, {f'{AB}:new', f'{EA}:new'}, {AB: 1, EA: 1}))
        self.assertEqual(self.net.refusals, [('vt_1111111111111111', {'reason': 'tracker_mismatch'})])
        s = self.store.state
        self.assertEqual(len(s['consent_log']), vc.CONSENT_LOG_MAX)
        self.assertEqual([(e['id'], e['decision']) for e in s['consent_log'][-5:]],
                         [(TID, 'signed'), (SID, 'signed'), ('vt_1111111111111111', 'refused'),
                          ('vt_2222222222222222', 'waiting'), ('vt_3333333333333333', 'waiting')])
        self.assertEqual(s['consents_last_run_ms'], NOW)
        self.assertEqual({p['ref'] for p in records.get(s['records'], AB)['pending']}, {TID, SID})

    def test_without_a_policy_nothing_is_signed(self):
        self.net.consent_items = [issuer_item(self.T)]
        rep = self.client(profile(A_ID)).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'policy_off')])
        self.assertEqual(self.net.consent_posts, [])
        self.assertEqual(self.net.refusals, [(TID, {'reason': 'policy_off'})])

    def test_the_policy_argument_is_used(self):
        self.net.consent_items = [issuer_item(self.T)]
        rep = self.client(profile(A_ID)).process_consents(policy=dict(POLICY))
        self.assertEqual([e['id'] for e in rep['signed']], [TID])

    def test_nothing_is_read_without_circulation(self):
        self.net.features = ['bound_notes/1']
        self.net.consent_items = [issuer_item(self.T)]
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual(rep, {'signed': [], 'refused': [], 'waiting': []})
        self.assertEqual(self.net.requests(), ['GET /pilot/v1/info'])
        self.assertEqual(self.store.state['consents_last_run_ms'], NOW)              # a run, for the agent's rate limit

    def test_a_payee_consent(self):
        self.net.me_id = C_ID
        d = self.net.deals[DEAL]
        d.update(status='paying_by_transfer', your_role='payee', payment={'method': 'transfer', 'transfer_id': TID})
        q = self.net.transfer_template(DEAL, A_ID)['quote_digest']
        self.net.consent_items = [consent_item(
            'transfer', TID, 'payee', [edge_row(A, C, 4, TS_AC, 7, self.T, 'creditor', ['prior', 'new'], (A_ID, C_ID))],
            dict(who3(), amount=3, deal={'deal_id': DEAL, 'terms_hash': d['agreement']['terms_hash'], 'price': 3, 'quote_digest': q}))]
        rep = self.client(profile(C_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['role'], e['deal_id']) for e in rep['signed']], [(TID, 'payee', DEAL)])
        (_cid, body), = self.net.consent_posts
        self.assertEqual(set(body['signatures']), {f'{AC}:prior', f'{AC}:new'})
        self.assertIn(f'GET /pilot/v1/deals/{DEAL}', self.net.requests())

    def test_a_payee_consent_is_refused_unless_this_transfer_pays_a_deal_it_delivered(self):
        for change in ({'payment': {'method': 'transfer', 'transfer_id': 'vt_ffffffffffffffff'}},     # another transfer
                       {'delivery_by': E_ID}):                                                     # someone else delivered
            self.setUp()
            self.net.me_id = C_ID
            d = self.net.deals[DEAL]
            d.update(status='paying_by_transfer', payment=change.get('payment', {'method': 'transfer', 'transfer_id': TID}))
            d['delivery']['by'] = change.get('delivery_by', C_ID)
            self.net.consent_items = [consent_item(
                'transfer', TID, 'payee', [edge_row(A, C, 4, TS_AC, 7, self.T, 'creditor', ['prior', 'new'], (A_ID, C_ID))],
                dict(who3(), amount=3, deal={'deal_id': DEAL, 'terms_hash': d['agreement']['terms_hash'], 'price': 3}))]
            rep = self.client(profile(C_ID, consent_policy=dict(POLICY))).process_consents()
            self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'deal_mismatch')], change)
            self.assertEqual(self.net.consent_posts, [])

    def payer_item(self):
        """B's own payment through A shown to it as a consent (the same prior of B's claim on A, at self.T)."""
        q = self.net.transfer_template(DEAL, A_ID)['quote_digest']
        d = self.net.deals[DEAL]
        return q, consent_item('transfer', TID, 'payer',
                               [edge_row(A, B, 10, TS_AB, 7, self.T, 'creditor', ['prior', 'new'], (A_ID, B_ID)),
                                edge_row(A, C, 4, TS_AC, 7, self.T, 'payer', ['new'], (A_ID, C_ID))],
                               dict(who3(), amount=3, deal={'deal_id': DEAL, 'terms_hash': d['agreement']['terms_hash'],
                                                            'price': 3, 'quote_digest': q}))

    def test_my_own_transfer_is_signed_again_under_the_approved_quote(self):
        # The identical operation (same prior, same T) shown as a consent: excluded by the first at the tracker.
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T, 'quote_digest': q, 'signed_at': None}]
        self.net.consent_state[TID] = 'applied'
        c = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier}))
        rep = c.process_consents()
        self.assertEqual([(e['id'], e['role'], e['state']) for e in rep['signed']], [(TID, 'payer', 'applied')])
        (_cid, body), = self.net.consent_posts
        self.assertEqual(set(body['signatures']), {f'{AB}:prior', f'{AB}:new', f'{AC}:new'})
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL]['route'], 'transfer')
        self.assertEqual(len(att(self.store.state)), 1)

    def test_a_regenerated_transfer_on_the_same_claim_is_signed_while_the_earlier_attempt_is_alive(self):
        # Tracker v3.2 (audit VS-1 closed): a regenerated transfer at a new T on the same state of my claim on A,
        # (10, TS_AB), as the earlier attempt is excluded by it at the tracker: signed under the approved quote.
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T - 60_000, 'quote_digest': q, 'ack': 'basis/prior-ack/1', 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(TID, 'payer')])
        (_cid, body), = self.net.consent_posts
        self.assertTrue(signed_by(B, pa(A['pubkey'], B['pubkey'], 10, TS_AB, self.T), body['signatures'][f'{AB}:prior']))

    def test_a_regenerated_transfer_is_refused_while_an_earlier_attempt_recorded_without_ack_is_alive(self):
        # The same earlier attempt recorded without ack (by a build that may have signed tracker v3.1's M(A,B,X,T) as
        # its prior acknowledgment, or by the first v3.2 build): treated as before tracker v3.2, it waits.
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T - 60_000, 'quote_digest': q, 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'transfer_window_open')])
        self.assertEqual(self.net.consent_posts, [])

    def test_a_regenerated_transfer_is_refused_while_an_earlier_attempt_on_another_state_is_alive(self):
        # The earlier attempt acknowledged another state of my claim (the same total, an earlier timestamp): not
        # excluded by this one, so refused while it can still apply.
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB - 1000, 'total': 7,
                    'timestamp': self.T - 60_000, 'quote_digest': q, 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'transfer_window_open')])
        self.assertEqual(self.net.consent_posts, [])

    def test_an_approval_does_not_cover_a_payer_consent_hours_later(self):
        # Audit AI-1 (the auditor's probe): the owner's approval was recorded for an attempt whose window has passed;
        # three hours later a payer consent under the same quote is refused, not signed.
        self.net.me_id = B_ID
        T0 = self.T
        self.clock.now = T0 + 3 * 3_600_000
        self.T = res(self.clock.now - 1500, 999)
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': T0, 'quote_digest': q, 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'stale_quote')])
        self.assertEqual(self.net.consent_posts, [])

    def test_a_regenerated_transfer_under_another_quote_is_refused(self):
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T, 'quote_digest': q, 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: 'ff' * 32}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'stale_quote')])
        self.assertEqual(self.net.consent_posts, [])

    def test_a_regenerated_transfer_whose_delivery_is_not_the_payees_is_refused(self):
        self.net.me_id = B_ID
        q, it = self.payer_item()
        self.net.consent_items = [it]
        d = self.net.deals[DEAL]
        d['delivery']['signature'] = sign_text(E, vc.statement('deliver', d['agreement']['terms_hash'], d['delivery']['sha256']))
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T - 60_000, 'quote_digest': q, 'signed_at': None}]
        rep = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier})).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'deal_mismatch')])
        self.assertEqual(self.net.consent_posts, [])

    def test_one_item_that_raises_does_not_stop_the_others_and_the_run_is_recorded(self):
        other = 'vt_4444444444444444'
        self.net.consent_items = [issuer_item(self.T), issuer_item(self.T - 1000, iid=other)]

        def boom(method, path, body):
            if method == 'POST' and path == f'/pilot/v1/consents/{TID}':
                raise RuntimeError('a bug while posting')
        self.net.hooks.append(boom)
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['waiting']], [(TID, 'internal_error')])
        self.assertEqual([e['id'] for e in rep['signed']], [other])
        s = self.store.state
        self.assertEqual([(e['id'], e['decision']) for e in s['consent_log']], [(TID, 'waiting'), (other, 'signed')])
        self.assertEqual(s['consents_last_run_ms'], NOW)
        # a run that stops early (GET /consents fails) is still recorded, for the agent layer's rate limit
        self.setUp()
        self.net.hooks.append(lambda m, p, b: (_ for _ in ()).throw(vc.ValunError('http_error', 'down', 503))
                              if p == '/pilot/v1/consents' else None)
        with self.assertRaises(vc.ValunError):
            self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual(self.store.state['consents_last_run_ms'], NOW)

    def payee_consent(self):
        self.net.me_id = C_ID
        d = self.net.deals[DEAL]
        d.update(status='paying_by_transfer', your_role='payee', payment={'method': 'transfer', 'transfer_id': TID})
        self.net.consent_items = [consent_item(
            'transfer', TID, 'payee', [edge_row(A, C, 4, TS_AC, 7, self.T, 'creditor', ['prior', 'new'], (A_ID, C_ID))],
            dict(who3(), amount=3, deal={'deal_id': DEAL, 'terms_hash': d['agreement']['terms_hash'], 'price': 3}))]
        return self.client(profile(C_ID, consent_policy=dict(POLICY)))

    def test_the_issuer_of_a_payment_to_me_is_named_by_the_directory_not_the_item(self):
        self.net.directory_ids = [B_ID, C_ID, E_ID]            # the directory does not list A: its id cannot be resolved
        rep = self.payee_consent().process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'issuer_refused')])
        self.assertEqual(self.net.consent_posts, [])
        self.assertEqual(self.net.requests().count('GET /pilot/v1/participants'), 1)
        # the directory cannot be read now: the item waits (it is not refused)
        self.setUp()
        self.net.hooks.append(lambda m, p, b: (_ for _ in ()).throw(vc.ValunError('http_error', 'down', 503))
                              if p == '/pilot/v1/participants' else None)
        rep = self.payee_consent().process_consents()
        self.assertEqual([(e['id'], e['error']) for e in rep['waiting']], [(TID, 'http_error')])
        self.assertEqual((self.net.refusals, self.net.consent_posts), ([], []))

    def test_a_key_the_directory_lists_twice_or_only_inactive_is_not_resolved(self):
        # A lying directory lists the issuer's key under a second id the mandate also accepts: the client cannot tell
        # which participant it is, so it resolves no id for the key and the id-based mandate list refuses the payment.
        # (The item names no issuer id here, so only the directory can name one: whichever of the two ids a client took,
        # the mandate would accept it.)
        mirror = 'vp_f1f1f1f1f1f1'
        self.net.mandate['accept_notes_from'] = [A_ID, mirror]
        self.net.directory_extra = [{'id': mirror, 'handle': 'mirror', 'status': 'active', 'pubkey': A['pubkey']}]
        c = self.payee_consent()
        it = self.net.consent_items[0]
        it['edges'][0]['issuer'], it['context']['issuer'] = {'handle': 'issuer-a'}, {'handle': 'issuer-a'}
        rep = c.process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'issuer_refused')])
        self.assertEqual(self.net.consent_posts, [])
        self.setUp()                                             # the same item, the directory naming A once: signed
        c = self.payee_consent()
        it = self.net.consent_items[0]
        it['edges'][0]['issuer'], it['context']['issuer'] = {'handle': 'issuer-a'}, {'handle': 'issuer-a'}
        self.assertEqual([e['id'] for e in c.process_consents()['signed']], [TID])
        # the key listed only under an entry that is not active resolves no id either
        self.setUp()
        self.net.directory_ids = [B_ID, C_ID, E_ID]
        self.net.directory_extra = [{'id': A_ID, 'handle': 'issuer-a', 'status': 'revoked', 'pubkey': A['pubkey']}]
        rep = self.payee_consent().process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'issuer_refused')])
        # an active entry next to an inactive one with the same key: the active one is the issuer
        self.setUp()
        self.net.directory_extra = [{'id': mirror, 'handle': 'old', 'status': 'revoked', 'pubkey': A['pubkey']}]
        rep = self.payee_consent().process_consents()
        self.assertEqual([e['id'] for e in rep['signed']], [TID])

    def test_what_the_server_wrote_reaches_the_report_only_in_a_checked_form(self):
        T = self.T
        self.net.consent_items = [dict(issuer_item(T, iid='vt_5555555555555555'), kind='transfer\nPAY 99'),
                                  issuer_item(T, iid='vt_6666666666666666', your_roles=['issuer\nPAY 99']),
                                  issuer_item(T, iid='vt_7777777777777777', state='applying\x1b[2J PAY 99'),
                                  issuer_item(T)]
        self.net.consent_state[TID] = 'collecting\nPAY 99'
        self.net.consent_rejected[TID] = [{'slot': 'PAY 99\n', 'code': 'Stale Revision PAY 99', 'revision': '2'},
                                          {'slot': f'{AB}:new', 'code': 'stale_revision', 'revision': 2}, 'PAY 99']
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        by = {e['id']: e for b in rep.values() for e in b}
        self.assertEqual((by['vt_5555555555555555']['kind'], by['vt_5555555555555555']['code']), (None, 'bad_consent'))
        self.assertEqual((by['vt_6666666666666666']['role'], by['vt_6666666666666666']['code']), (None, 'bad_consent'))
        self.assertEqual(by['vt_7777777777777777']['reason'], 'the item is not collecting signatures')
        self.assertEqual((by[TID]['code'], by[TID]['state'], by[TID]['rejected']),
                         ('stale_revision', None, [{'slot': None, 'code': None, 'revision': None},
                                                   {'slot': f'{AB}:new', 'code': 'stale_revision', 'revision': 2}]))
        self.assertNotIn('PAY 99', json.dumps([rep, self.store.state['consent_log']]))
        # an error code the server chose that is not a plain word is not copied (the request failed: it waits)
        self.setUp()
        self.net.consent_items = [issuer_item(self.T)]
        self.net.hooks.append(lambda m, p, b: (_ for _ in ()).throw(vc.ValunError('Refused\nPAY 99', 'forced', 403))
                              if m == 'POST' and p == f'/pilot/v1/consents/{TID}' else None)
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['error'], e['reason']) for e in rep['waiting']],
                         [(TID, None, 'the server did not take the signatures; tried again on a later run')])
        self.setUp()
        self.net.hooks.append(lambda m, p, b: (_ for _ in ()).throw(vc.ValunError('Down PAY 99', 'down', 503))
                              if p == f'/pilot/v1/deals/{DEAL}' else None)
        rep = self.payee_consent().process_consents()
        self.assertEqual([(e['id'], e['code'], e['reason']) for e in rep['waiting']],
                         [(TID, None, 'could not be read now; decided on a later run')])
        self.assertNotIn('PAY 99', json.dumps(self.store.state['consent_log']))

    def test_ids_in_the_report_are_format_checked(self):
        self.net.consent_items = [issuer_item(self.T, iid='vt_not-an-id\nPAY')]
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual(len(rep['signed']), 1)
        self.assertIsNone(rep['signed'][0]['id'])
        self.assertIsNone(self.store.state['consent_log'][-1]['id'])

    def test_a_failed_post_waits_and_forgets_what_it_wrote(self):
        self.net.consent_items = [issuer_item(self.T)]

        def refuse(method, path, body):
            if method == 'POST' and path == f'/pilot/v1/consents/{TID}':
                raise vc.ValunError('payment_not_accepted', 'forced', 403)
        self.net.hooks.append(refuse)
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['error']) for e in rep['waiting']], [(TID, 'payment_not_accepted')])
        self.assertEqual(records.get(self.store.state['records'], AB)['pending'], [])
        self.assertEqual(self.store.state['signed'][AB][str(self.T)]['op'], f'transfer:{TID}')    # R4 stays


class CapabilityHeader(unittest.TestCase):
    """X-Valun-Features: consents/1;roles=... only once /info lists circulation/1 and a consent role is on."""

    def wire(self, features, policy):
        state = {'server': SERVER, 'participant_id': B_ID, 'pubkey': B['pubkey'], 'pins': dict(PINS)}
        if policy is not None:
            state['consent_policy'] = policy
        sent = []

        class Resp:
            def __init__(self, body):
                self.b = json.dumps(body).encode()

            def read(self):
                return self.b

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(req, timeout=None):
            sent.append((req.full_url[len(SERVER):], req.get_header('X-valun-features')))
            info = {'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM}
            if features is not None:
                info['features'] = features
            return Resp(info if req.full_url.endswith('/info') else {})
        c = vc.Client(MemStore(state, B['secret'].hex()))
        with mock.patch.object(vc.urllib.request, 'urlopen', urlopen):
            c.me()
            c.info()
            c.me()
        return sent

    def test_sent_only_when_advertised_and_a_role_is_on(self):
        invite = {'setoff': True, 'as_issuer': True, 'as_new_creditor': False}
        self.assertEqual(self.wire(['bound_notes/1', 'circulation/1'], invite),
                         [('/pilot/v1/me', None), ('/pilot/v1/info', None), ('/pilot/v1/me', 'consents/1;roles=setoff,issuer')])
        self.assertEqual(self.wire(['bound_notes/1', 'circulation/1'], dict(POLICY))[-1],
                         ('/pilot/v1/me', 'consents/1;roles=setoff,issuer,creditor'))
        for features, policy in ((['bound_notes/1'], dict(POLICY)), (None, dict(POLICY)),
                                 (['bound_notes/1', 'circulation/1'], None),
                                 (['bound_notes/1', 'circulation/1'], {'setoff': False, 'as_issuer': 'yes'})):
            self.assertEqual([h for _p, h in self.wire(features, policy)], [None, None, None], (features, policy))

    def test_consent_roles(self):
        self.assertEqual(vc.consent_roles(None), [])
        self.assertEqual(vc.consent_roles({'as_new_creditor': True, 'setoff': True}), ['setoff', 'creditor'])


class ValueSafeRun(Base):
    """FX3-PY, decision D-3 a: process_consents(value_safe_only=True), the run an adapter without a consent loop makes
    before valun_status and valun_inbox. It signs set-offs (member) and payments to me by transfer (payee) as the
    firewall and the standing policy allow, refuses nothing, and never reads further, signs or refuses a consent in the
    issuer or payer role; it is recorded in consents_last_safe_run_ms only."""

    def setUp(self):
        super().setUp()
        self.net.me_id = A_ID
        self.T = res(NOW - 1500, 999)

    def test_a_set_off_is_signed_and_an_issuers_consent_is_never_signed_or_refused(self):
        T = self.T
        self.net.consent_items = [issuer_item(T), member_item(res(NOW - 1500, 998))]
        c = self.client(profile(A_ID, consent_policy=dict(POLICY)))
        rep = c.process_consents(value_safe_only=True)
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(SID, 'member')])
        self.assertEqual([(e['id'], e['role'], e['code']) for e in rep['waiting']], [(TID, 'issuer', 'not_value_safe')])
        self.assertEqual(rep['refused'], [])
        self.assertEqual([cid for cid, _body in self.net.consent_posts], [SID])      # nothing posted for the issuer's
        self.assertEqual(self.net.refusals, [])
        s = self.store.state
        self.assertNotIn(AC, s.get('signed') or {})                 # no write-ahead (R4) for the issuer's edges either
        self.assertEqual(s['consents_last_safe_run_ms'], NOW)
        self.assertNotIn('consents_last_run_ms', s)                 # it never delays a full run
        self.assertEqual([(e['id'], e['decision']) for e in s['consent_log']], [(SID, 'signed')])
        # The same issuer's consent is signed by a full run (before a tool call that is not read-only).
        self.net.consent_items = [issuer_item(T)]
        rep = c.process_consents()
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(TID, 'issuer')])
        self.assertEqual(self.store.state['consents_last_run_ms'], NOW)

    def test_a_payers_consent_is_not_read_signed_or_refused(self):
        self.net.me_id = B_ID
        q, it = Consents.payer_item(self)
        self.net.consent_items = [it]
        earlier = [{'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
                    'timestamp': self.T, 'quote_digest': q, 'signed_at': None}]
        self.net.consent_state[TID] = 'applied'
        c = self.client(profile(B_ID, approved_payments={DEAL: q}, transfer_attempts={DEAL: earlier},
                                consent_policy=dict(POLICY)))
        rep = c.process_consents(value_safe_only=True)
        self.assertEqual([(e['id'], e['role'], e['code']) for e in rep['waiting']], [(TID, 'payer', 'not_value_safe')])
        self.assertEqual((rep['signed'], rep['refused'], self.net.consent_posts, self.net.refusals), ([], [], [], []))
        self.assertEqual(self.net.requests(), ['GET /pilot/v1/info', 'GET /pilot/v1/consents'])   # nothing read further
        self.assertEqual(len(att(self.store.state)), 1)            # no attempt written ahead
        self.assertEqual(self.store.state['consent_log'], [])      # nothing decided
        rep = c.process_consents()                                  # a full run signs it again, as before
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(TID, 'payer')])

    def test_a_payment_to_me_is_signed_only_as_the_standing_policy_allows(self):
        c = Consents.payee_consent(self)
        rep = c.process_consents(value_safe_only=True)
        self.assertEqual([(e['id'], e['role'], e['deal_id']) for e in rep['signed']], [(TID, 'payee', DEAL)])
        (_cid, body), = self.net.consent_posts
        self.assertEqual(set(body['signatures']), {f'{AC}:prior', f'{AC}:new'})
        # as_new_creditor off: the evaluator refuses it, and a read refuses nothing: it waits for a full run
        self.setUp()
        c = Consents.payee_consent(self)
        c.state['consent_policy'] = dict(POLICY, as_new_creditor=False)
        rep = c.process_consents(value_safe_only=True)
        self.assertEqual([(e['id'], e['role'], e['code']) for e in rep['waiting']], [(TID, 'payee', 'policy_off')])
        self.assertEqual((rep['signed'], rep['refused'], self.net.consent_posts, self.net.refusals), ([], [], [], []))
        self.assertEqual([(e['id'], e['decision'], e['code']) for e in self.store.state['consent_log']],
                         [(TID, 'waiting', 'policy_off')])
        rep = c.process_consents()
        self.assertEqual([(e['id'], e['code']) for e in rep['refused']], [(TID, 'policy_off')])
        self.assertEqual(self.net.refusals, [(TID, {'reason': 'policy_off'})])

    def test_a_set_off_the_policy_refuses_waits_and_is_not_refused(self):
        self.net.consent_items = [member_item(res(NOW - 1500, 998))]
        c = self.client(profile(A_ID, consent_policy=dict(POLICY, setoff=False)))
        rep = c.process_consents(value_safe_only=True)
        self.assertEqual([(e['id'], e['code']) for e in rep['waiting']], [(SID, 'policy_off')])
        self.assertEqual((self.net.consent_posts, self.net.refusals), ([], []))
        rep = c.process_consents()
        self.assertEqual(self.net.refusals, [(SID, {'reason': 'policy_off'})])

    def test_the_value_safe_roles(self):
        self.assertEqual(vc.VALUE_SAFE_ROLES, ('member', 'payee'))
        self.assertEqual(vc.VALUE_SAFE_HEADER_ROLES, ('setoff', 'creditor'))
        self.assertTrue({'consents_last_safe_run_ms', 'consent_roles_declared'} <= set(vc.CORE_STATE_KEYS))


class _Resp:
    def __init__(self, body):
        self.b = json.dumps(body).encode()

    def read(self):
        return self.b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class RolesWithdrawn(unittest.TestCase):
    """FX3-PY, decision D-3 b: with every consent role off, or declare_roles False (an adapter whose process_consents is
    off), the client sends X-Valun-Features: consents/1;roles= (empty) while the server may still count roles it
    declared (consent_roles_declared), until a request the server authenticated has carried it with a 2xx answer; then
    it sends no header, also from another process on the same profile."""
    R = 'consents/1;roles='

    def setUp(self):
        self.sent, self.fail, self.features = [], {}, ['bound_notes/1', 'circulation/1']

    def client(self, policy, declare_roles=True, **extra):
        state = dict({'server': SERVER, 'participant_id': B_ID, 'pubkey': B['pubkey'], 'pins': dict(PINS)}, **extra)
        if policy is not None:
            state['consent_policy'] = policy
        self.store = MemStore(state, B['secret'].hex())
        return vc.Client(self.store, declare_roles=declare_roles)

    def urlopen(self, req, timeout=None):
        path = req.full_url[len(SERVER):]
        self.sent.append(req.get_header('X-valun-features'))
        code = self.fail.pop(path, None)
        if code:
            err = urllib.error.HTTPError(req.full_url, code, 'refused', {}, io.BytesIO(b'{"error": "rate_limited"}'))
            self.addCleanup(err.close)
            raise err
        info = {'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM}
        if self.features is not None:
            info['features'] = self.features
        return _Resp(info if path == '/pilot/v1/info' else {})

    def wire(self, c, *calls):
        with mock.patch.object(vc.urllib.request, 'urlopen', self.urlopen):
            for call in calls:
                try:
                    call(c)
                except vc.ValunError:
                    pass
        out, self.sent = self.sent, []
        return out

    def test_roles_turned_off_are_withdrawn_once(self):
        c = self.client({'setoff': True, 'as_issuer': True, 'as_new_creditor': False})
        self.assertEqual(self.wire(c, vc.Client.info, vc.Client.me), [None, 'consents/1;roles=setoff,issuer'])
        self.assertEqual(self.store.state['consent_roles_declared'], 'setoff,issuer')
        c.state['consent_policy'] = {'setoff': False, 'as_issuer': False, 'as_new_creditor': False}
        self.assertEqual(self.wire(c, vc.Client.me, vc.Client.me, vc.Client.inbox), [self.R, None, None])
        self.assertEqual(self.store.state['consent_roles_declared'], '')
        c.state['consent_policy'] = {'setoff': True}                       # a role on again is declared again
        self.assertEqual(self.wire(c, vc.Client.me), ['consents/1;roles=setoff'])
        self.assertEqual(self.store.state['consent_roles_declared'], 'setoff')

    def test_with_process_consents_off_the_roles_declared_before_are_withdrawn(self):
        c = self.client(dict(POLICY), declare_roles=False, consent_roles_declared='setoff,issuer,creditor')
        self.assertEqual(self.wire(c, vc.Client.info, vc.Client.me, vc.Client.me), [None, self.R, None])
        self.assertEqual(self.store.state['consent_roles_declared'], '')
        c = self.client(dict(POLICY), declare_roles=False)                 # it never declared any: no header at all
        self.assertEqual(self.wire(c, vc.Client.info, vc.Client.me), [None, None])
        self.assertNotIn('consent_roles_declared', self.store.state)

    def test_only_a_request_the_server_authenticated_and_answered_withdraws_them(self):
        # Public routes (the directory, a participant, GET /clearing) are answered before authentication, even when a
        # request to one carries the agent token; an owner token's request never sets the agent's roles; and a 429 may
        # come before authentication: each sends it again later.
        c = self.client({'setoff': False}, consent_roles_declared='setoff')
        self.fail['/pilot/v1/me'] = 429
        heads = self.wire(c, vc.Client.info, vc.Client.directory, lambda c: c.participant(C_ID),
                          lambda c: c.request('GET', '/pilot/v1/participants'),
                          lambda c: c.request('GET', f'/pilot/v1/participants/{C_ID}'),
                          lambda c: c.request('GET', '/pilot/v1/clearing'),
                          lambda c: c.request('GET', '/pilot/v1/owner', token=OWNER_TOKEN), vc.Client.me)
        self.assertEqual(heads, [None] + [self.R] * 7)
        self.assertEqual(self.store.state['consent_roles_declared'], 'setoff')
        self.assertEqual(self.wire(c, vc.Client.me, vc.Client.me), [self.R, None])
        self.assertEqual(self.store.state['consent_roles_declared'], '')

    def test_never_without_circulation(self):
        self.features = ['bound_notes/1']
        c = self.client({'setoff': False}, consent_roles_declared='setoff')
        self.assertEqual(self.wire(c, vc.Client.info, vc.Client.me, vc.Client.me), [None, None, None])
        self.assertEqual(self.store.state['consent_roles_declared'], 'setoff')

    def test_once_per_profile_across_processes(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'p.json')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump({'server': SERVER, 'participant_id': B_ID, 'pubkey': B['pubkey'], 'pins': dict(PINS),
                           'secret': B['secret'].hex(), 'agent_token': AGENT_TOKEN, 'consent_policy': dict(POLICY)}, f)
            self.assertEqual(self.wire(vc.Client(vc.FileStore(path)), vc.Client.info, vc.Client.me),
                             [None, 'consents/1;roles=setoff,issuer,creditor'])
            for heads in ([None, self.R, None], [None, None, None]):        # process_consents off, in two processes
                self.assertEqual(self.wire(vc.Client(vc.FileStore(path), declare_roles=False), vc.Client.info,
                                           vc.Client.me, vc.Client.me), heads)
            with open(path, encoding='utf-8') as f:
                self.assertEqual(json.load(f)['consent_roles_declared'], '')


class SyncEdges(Base):
    def test_states_confirm_records_mark_paid_deals_and_novated_edges(self):
        T1, T2 = res(NOW - 120_000, 999), res(NOW - 60_000, 997)
        self.net.set_edge(A, B, 7, T1, kind='transfer_out', ref=TID)      # my payment of DEAL by transfer applied
        self.net.set_edge(B, C, 9, T2, kind='issue', ref=DEAL2)           # my bound note for DEAL2 applied
        self.net.bound_only = {AB}
        recs = {}
        records.add_pending(recs, AB, 7, T1, 'transfer', DEAL, 'in')
        records.add_pending(recs, BC, 9, T2, 'note', DEAL2, 'out')
        c = self.client(profile(records=recs))
        out = c.sync_edges()
        s = self.store.state
        self.assertEqual(sorted(out['paid_deals']), sorted([DEAL, DEAL2]))
        self.assertEqual(s['records']['paid_deals'][DEAL], {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T1})
        self.assertEqual(s['records']['paid_deals'][DEAL2], {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': T2})
        self.assertEqual((records.get(s['records'], AB)['confirmed']['total'], records.get(s['records'], BC)['confirmed']['total']), (7, 9))
        self.assertEqual((records.get(s['records'], AB)['pending'], records.get(s['records'], BC)['pending']), ([], []))
        self.assertEqual(s['issued'], {BC: 9})
        self.assertEqual(s['novated_edges'], {AB: True})
        self.assertEqual(out['novated'], [AB])
        self.assertEqual((s['journal_seq'], out['journal_seq']), (self.net.seq, self.net.seq))
        self.assertEqual(set(out['edges']), {AB, BC})
        self.assertEqual(out['rejected'], [])
        c.sync_edges()                                                    # from journal_seq on: nothing new
        self.assertEqual(self.net.requests()[-1], f'GET /pilot/v1/edges?since={self.net.seq}')

    def test_the_journal_shows_states_the_current_rows_no_longer_do(self):
        # My bound note for DEAL2 applied at (9, T2); a set-off has lowered B->C since. Only the journal shows (9, T2), and
        # only the journal says a set-off changed the edge (this row does not say bound_only).
        T2, T3 = res(NOW - 60_000, 997), res(NOW - 30_000, 998)
        self.net.set_edge(B, C, 9, T2, kind='issue', ref=DEAL2)
        self.net.set_edge(B, C, 7, T3, kind='setoff', ref=SID)
        recs = {}
        records.add_pending(recs, BC, 9, T2, 'note', DEAL2, 'out')
        out = self.client(profile(records=recs)).sync_edges()
        s = self.store.state
        self.assertEqual(out['paid_deals'], [DEAL2])
        self.assertEqual([(a['pair'], a['ref']) for a in out['applied']], [(BC, DEAL2)])
        self.assertEqual(records.get(s['records'], BC)['confirmed']['total'], 7)
        self.assertEqual((out['novated'], s['novated_edges']), ([BC], {BC: True}))

    def test_a_state_that_does_not_verify_is_used_for_nothing(self):
        self.net.tracker[BC] = st(B, C, 99, NOW - 1000, signer=E)
        recs = {}
        records.add_pending(recs, BC, 9, res(NOW - 8 * DAY, 997), 'note', DEAL, 'out')     # old enough to prune, if it were read
        out = self.client(profile(records=recs)).sync_edges()
        self.assertEqual(out['rejected'], [{'edge': BC, 'seq': None, 'reason': 'bad_signature'}])
        self.assertEqual(out['doubtful'], [BC])
        self.assertNotIn(BC, out['edges'])
        self.assertIsNone(records.get(self.store.state['records'], BC)['confirmed'])
        self.assertEqual(len(records.get(self.store.state['records'], BC)['pending']), 1)      # no read-back: kept
        self.assertEqual(out['pruned']['pending'], 0)

    def test_an_attempt_whose_state_an_edge_shows_is_paid(self):
        T1 = res(NOW - 120_000, 999)
        self.net.set_edge(A, B, 7, T1)
        a = {'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB, 'total': 7,
             'timestamp': T1, 'quote_digest': None, 'signed_at': None}
        c = self.client(profile(transfer_attempts={DEAL: [a]}))
        self.assertEqual(c.sync_edges()['paid_deals'], [DEAL])
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL]['route'], 'transfer')

    def test_pages(self):
        for i in range(5):
            self.net.set_edge(B, C, 7 + i, NOW - 50_000 + 1000 * i, kind='issue', ref=f'vd_{i:016x}')
        self.net.page = 2
        with mock.patch.object(vc, 'EDGES_PAGE', 2):
            out = self.client().sync_edges()
        self.assertEqual([r for r in self.net.requests() if 'edges' in r],
                         ['GET /pilot/v1/edges?since=0', 'GET /pilot/v1/edges?since=2', 'GET /pilot/v1/edges?since=4'])
        self.assertEqual(out['journal_seq'], 5)
        self.assertEqual(records.get(self.store.state['records'], BC)['confirmed']['total'], 11)

    def test_seven_day_pruning(self):
        old, recent, older = NOW - 8 * DAY, NOW - DAY, NOW - 9 * DAY
        self.net.set_edge(B, C, 6, older)                     # B->C has not moved for 9 days
        recs = {}
        records.add_pending(recs, BC, 9, res(old, 997), 'note', DEAL, 'out')        # a bound note: expired, never applied
        records.add_pending(recs, BC, 9, old + 123 - old % 1000, 'note', DEAL2, 'out')   # an ordinary note never expires
        records.add_pending(recs, BC, 9, res(recent, 997), 'note', 'vd_2123456789abcdef', 'out')
        signed = {BC: {str(res(old, 997)): {'op': f'note:{DEAL}', 'slots': {}},
                       str(res(recent, 997)): {'op': 'note:vd_2123456789abcdef', 'slots': {}}}}

        def attempt(deal_id, ts):
            return {'deal_id': deal_id, 'route': 'note', 'edge': BC, 'prior': 6, 'prior_timestamp': older, 'total': 9,
                    'timestamp': ts, 'quote_digest': None, 'signed_at': None}
        attempts = {DEAL: [attempt(DEAL, res(old, 997))], 'vd_2123456789abcdef': [attempt('vd_2123456789abcdef', res(recent, 997))],
                    'vd_3123456789abcdef': [attempt('vd_3123456789abcdef', res(old - 5000, 997))],
                    'vd_4123456789abcdef': [{'deal_id': 'vd_4123456789abcdef', 'route': 'note', 'edge': BC}],     # malformed
                    # my claim on A moved past this old transfer's T to neither its prior nor its new total: unknown, kept
                    'vd_5123456789abcdef': [{'deal_id': 'vd_5123456789abcdef', 'route': 'transfer', 'edge': AB, 'prior': 12,
                                             'prior_timestamp': older, 'total': 9, 'timestamp': res(old, 999),
                                             'quote_digest': None, 'signed_at': None}]}
        recs['paid_deals'] = {'vd_3123456789abcdef': {'route': 'note', 'edge': BC, 'total': 9, 'timestamp': 1}}
        out = self.client(profile(records=recs, signed=signed, transfer_attempts=attempts)).sync_edges()
        s = self.store.state
        self.assertEqual(out['pruned'], {'signed': 1, 'pending': 1, 'attempts': 2, 'signatures': 0})   # + signatures (FX-PY)
        self.assertEqual(sorted(p['ref'] for p in records.get(s['records'], BC)['pending']), sorted([DEAL2, 'vd_2123456789abcdef']))
        self.assertEqual(list(s['signed'][BC]), [str(res(recent, 997))])
        self.assertEqual(sorted(s['transfer_attempts']), ['vd_2123456789abcdef', 'vd_4123456789abcdef', 'vd_5123456789abcdef'])


class SyncEdgesFxPy(Base):
    def test_an_applied_state_drops_its_signature_after_30_days(self):
        old = NOW - 31 * DAY
        self.net.set_edge(B, C, 6, old)                       # B->C has not moved for 31 days
        out = self.client().sync_edges()
        s = self.store.state
        self.assertEqual(records.get(s['records'], BC)['confirmed'], {'total': 6, 'timestamp': old})   # no signature
        self.assertIn('signature', records.get(s['records'], AB)['confirmed'])                       # 15 min old: kept
        self.assertEqual(out['pruned']['signatures'], 1)
        self.assertEqual(s['issued'], {BC: 6})
        self.client(self.store).sync_edges()                  # again: confirmed again from the row, dropped again
        self.assertNotIn('signature', records.get(s['records'], BC)['confirmed'])

    def test_an_unlisted_edge_is_no_read_back_for_an_attempt_that_acknowledged_a_prior_above_0(self):
        EB = f"{E['pubkey']}>{B['pubkey']}"                  # an edge GET /edges does not list (a server may hide it)
        old = NOW - 8 * DAY
        attempts = {'vd_6123456789abcdef': [{'deal_id': 'vd_6123456789abcdef', 'route': 'transfer', 'edge': EB, 'prior': 9,
                                             'total': 6, 'timestamp': res(old, 999), 'quote_digest': None, 'signed_at': None}]}
        out = self.client(profile(transfer_attempts=attempts)).sync_edges()
        self.assertEqual(out['pruned']['attempts'], 0)
        self.assertIn('vd_6123456789abcdef', self.store.state['transfer_attempts'])


class WriteAheadCodes(unittest.TestCase):
    def test_a_conflict_keeps_its_code(self):
        state = {'signed': {AB: {'5': {'op': 'setoff:vs_1', 'slots': {}}}}}
        wa = {'op': 'setoff:vs_2', 'signed': [{'edge': AB, 'timestamp': 5, 'op': 'setoff:vs_2', 'slots': {}}], 'pending': [],
              'attempt': None, 'attempts_seen': []}
        with self.assertRaises(vc.ValunError) as e:
            vc._guarded(nv.apply_write_ahead, state, wa, 'x')
        self.assertEqual(e.exception.code, 'timestamp_reused')
        with self.assertRaises(vc.ValunError) as e:
            vc._guarded(nv.apply_write_ahead, {'signed': []}, wa, 'x')
        self.assertEqual(e.exception.code, 'records_unreadable')


class Attempts(Base):
    """Decision D-2 d, the client side: the attempts a client records, how it judges each (as the payer evaluators do),
    and the owner's resolution of one, against a fake that answers like valun-app FX-SV: GET /transfers/:vt shows the
    payer's transfer; POST /owner/deals/:vd/attempts/:vt/resolve takes the owner token only, resolves only a transfer
    held as outcome_unknown or inconsistent (any other state: 409 wrong_state; an unknown one: 404 not_found) and
    answers {resolution, deal, transfer}."""

    def failed_transfer(self):
        """A transfer that collected signatures and was cancelled: the server holds it as cancelled (it ended)."""
        self.net.transfer_mode = 'collect'
        c = self.client()
        c.pay_by_transfer(DEAL, A_ID)
        c.cancel_transfer(DEAL)
        return c, self.net.pay_posts[0]['timestamp']

    def unknown_transfer(self, lose_answer=False):
        """A transfer whose outcome neither side knows: my claim on A moved past T to neither its prior nor its new
        total, and the server's read-back holds it as outcome_unknown. lose_answer: the POST got no answer, so my client
        never recorded the server's id of it."""
        self.net.transfer_mode = 'collect'
        self.net.lose_answer = lose_answer
        c = self.client()
        try:
            c.pay_by_transfer(DEAL, A_ID)
        except vc.ValunError as e:
            self.assertEqual((lose_answer, e.code), (True, 'unreachable'))
        self.net.lose_answer = False
        T = self.net.pay_posts[0]['timestamp']
        self.net.transfers[TID]['state'] = 'outcome_unknown'
        self.net.set_edge(A, B, 12, T + 5000)
        self.clock.now = T + LATER
        return c, T

    def held_bound_note_moved(self):
        """My bound note was held for my owner, who rejected it; then a set-off moved B>C past its timestamp (to neither
        its prior nor its new total), so my client cannot tell whether it applied. The server holds no attempt for it."""
        self.net.review = True
        c = self.client()
        self.assertEqual(c.complete(DEAL)['status'], 'completion_awaiting_owner')
        ts = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']['timestamp']
        self.net.review = False
        self.net.deals[DEAL]['status'] = 'delivered'             # rejected by the owner
        self.net.set_edge(B, C, 4, ts + 1001, kind='setoff', ref=SID)
        return c, ts

    def test_the_attempts_are_listed_with_how_the_client_judges_them(self):
        c, T = self.failed_transfer()
        rows = c.payment_attempts()
        self.assertEqual([(r['deal_id'], r['ref'], r['route'], r['prior'], r['total'], r['timestamp'], r['attempt_id'],
                           r['state'], r['paid']) for r in rows],
                         [(DEAL, '#1', 'transfer', 10, 7, T, TID, 'alive', False)])
        self.assertEqual(c.payment_attempts(edges={})[0]['state'], 'alive')     # not read: as the records say
        self.net.set_edge(A, B, 12, T + 5000)                 # my claim moved past T to neither 10 nor 7
        self.assertEqual(c.payment_attempts(edges=c.sync_edges()['edges'])[0]['state'], 'unknown')
        self.assertEqual(c.payment_attempts()[0]['state'], 'unknown')           # my records now hold that state

    def test_the_list_judges_attempts_as_the_payer_evaluators_do(self):
        # (a) proof from my own records: note N1 (DEAL) was held and rejected; note N2 (DEAL2) acknowledged the same prior
        # state of B>C later and applied. attempt_outcome alone says N1 'unknown'; my records prove it dead.
        self.net.review = True
        c = self.client()
        c.complete(DEAL)
        self.net.review = False
        self.net.deals[DEAL]['status'] = 'delivered'
        self.net.add_deal(DEAL2)
        self.clock.now += 30_000
        self.assertEqual(c.complete(DEAL2)['status'], 'note_issued')
        read = c.sync_edges()
        rows = {r['deal_id']: r for r in c.payment_attempts(edges=read['edges'], doubtful=read['doubtful'])}
        n1 = att(self.store.state)[0]
        self.assertEqual(nv.attempt_outcome(n1, self.clock.now, read['edges'][BC]), 'unknown')
        self.assertEqual((rows[DEAL]['state'], rows[DEAL2]['state']), ('dead', 'applied'))
        # (b) an absent edge: a first bound note acknowledged an absent B>C and was rejected; past its window, an edge
        # GET /edges does not list is its read-back (dead), while not reading the edges leaves it unread
        self.setUp()
        del self.net.tracker[BC]
        self.net.review = True
        c = self.client()
        c.complete(DEAL)
        ts = [b for m, _p, b in self.net.log if m == 'POST'][0]['credit_note']['timestamp']
        self.net.review = False
        self.clock.now = ts + LATER
        read = c.sync_edges()
        self.assertNotIn(BC, read['edges'])
        self.assertEqual(c.payment_attempts(edges=read['edges'], doubtful=read['doubtful'])[0]['state'], 'dead')
        self.assertEqual(c.payment_attempts()[0]['state'], 'unread')
        # the owner's resolution shows the attempts as the list does, from the same read-back
        self.assertEqual(c.resolution_plan(DEAL, '#1', edges=read['edges'], doubtful=read['doubtful'])['attempt']['state'],
                         'dead')
        self.assertEqual(c.payment_attempts(edges=read['edges'], doubtful=[BC])[0]['state'], 'unread')   # listed, unreadable

    def test_the_owner_resolves_an_unknown_attempt_as_not_applied(self):
        c, T = self.unknown_transfer()
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        plan = c.resolution_plan(DEAL, TID)
        self.assertEqual((plan['server'], plan['local'], plan['attempt']['ref'], plan['transfer']['state']),
                         (True, None, '#1', 'outcome_unknown'))
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'not_applied', owner_token='vpa_not-the-owner')
        self.assertEqual(e.exception.code, 'unauthorized')          # the owner token only; nothing changed
        self.assertNotIn('outcome', att(self.store.state)[0])
        r = c.resolve_attempt(DEAL, TID, 'not_applied', owner_token=OWNER_TOKEN, note='payee says not received')
        self.assertEqual(self.net.resolutions, [(DEAL, TID, {'outcome': 'not_applied', 'note': 'payee says not received'})])
        self.assertEqual((r['attempt_id'], r['outcome'], len(r['matched']), r['paid'], r['local']),
                         (TID, 'not_applied', 1, False, None))
        self.assertEqual(r['server']['resolution']['attempt_id'], TID)
        self.assertEqual(att(self.store.state)[0]['outcome'], 'not_applied')
        self.assertEqual(self.net.transfers[TID]['state'], 'resolved_not_applied')
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')      # its window has passed: the deal is paid now

    def test_the_owner_resolves_an_attempt_as_applied(self):
        c, T = self.unknown_transfer()
        r = c.resolve_attempt(DEAL, '#1', 'applied', owner_token=OWNER_TOKEN)
        self.assertEqual(self.net.resolutions, [(DEAL, TID, {'outcome': 'applied'})])     # the recorded server id
        self.assertTrue(r['paid'])
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL], {'route': 'transfer', 'edge': AB, 'total': 7,
                                                                           'timestamp': T})
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'already_paid')

    def test_a_transfer_whose_id_was_never_recorded_is_found_by_the_server_id_the_owner_gives(self):
        # The POST got no answer (the usual case): the server recorded the transfer, my client never learnt its id.
        c, T = self.unknown_transfer(lose_answer=True)
        read = c.sync_edges()
        (row,) = c.payment_attempts(edges=read['edges'], doubtful=read['doubtful'])
        self.assertEqual((row['attempt_id'], row['state']), (None, 'unknown'))
        self.assertEqual(c.resolution_plan(DEAL, '#1')['local'], 'no_server_id')
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)      # not without the owner's explicit choice
        self.assertEqual((e.exception.code, e.exception.extra['local_possible']), ('attempt_id_unknown', True))
        # The owner gives the id the owner console shows: GET /transfers identifies my attempt (its timestamp, my held
        # edge and its new total), the server resolves it and answers {resolution, deal, transfer} as FX-SV does.
        plan = c.resolution_plan(DEAL, TID)
        self.assertEqual((plan['server'], plan['attempt']['ref'], plan['transfer']['timestamp']), (True, '#1', T))
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        self.assertEqual(self.net.resolutions, [(DEAL, TID, {'outcome': 'not_applied'})])
        self.assertEqual((r['server']['resolution']['attempt_id'], r['server']['transfer']['state']),
                         (TID, 'resolved_not_applied'))
        (rec,) = att(self.store.state)
        self.assertEqual((rec['outcome'], rec['attempt_id'], len(r['matched'])), ('not_applied', TID, 1))
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')
        # once resolved there, the server holds it as ended: asking it again is the owner's explicit local choice
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'applied', OWNER_TOKEN)
        self.assertEqual((e.exception.code, e.exception.extra['local']), ('wrong_state', 'server_ended'))
        self.assertEqual(len(self.net.resolutions), 1)

    def test_the_resolve_answer_identifies_the_attempt_when_the_transfer_view_cannot(self):
        # GET /transfers shows the transfer without its edges, so the plan cannot tell which attempt of mine it is; the
        # transfer FX-SV's answer carries can (its timestamp, my held edge, its new total), and its id is recorded.
        c, T = self.unknown_transfer(lose_answer=True)
        self.net.transfer_view_edges = False
        plan = c.resolution_plan(DEAL, TID)
        self.assertEqual((plan['server'], plan['attempt']), (True, None))
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        (rec,) = att(self.store.state)
        self.assertEqual((rec['outcome'], rec['attempt_id'], len(r['matched'])), ('not_applied', TID, 1))
        # applied, with no record of mine left to match: the deal is recorded paid by what the answer shows
        self.setUp()
        c, T = self.unknown_transfer(lose_answer=True)
        self.net.transfer_view_edges = False
        self.store.state['transfer_attempts'] = {}
        self.store.state['records'][AB]['pending'] = []
        r = c.resolve_attempt(DEAL, TID, 'applied', OWNER_TOKEN)
        self.assertEqual((r['matched'], r['paid']), ([], True))
        self.assertEqual(self.store.state['records']['paid_deals'][DEAL], {'route': 'transfer', 'edge': AB, 'total': 7,
                                                                           'timestamp': T})

    def test_a_transfer_the_server_ended_is_resolved_in_the_records_by_the_owners_choice(self):
        # Cancelled at the server; later my claim on A moved past T: my client cannot tell, and the server has nothing to
        # resolve (409 wrong_state). The owner's decision is recorded in my records only, after a second choice.
        c, T = self.failed_transfer()
        self.net.set_edge(A, B, 12, T + 5000)
        self.clock.now = T + LATER
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        plan = c.resolution_plan(DEAL, '#1')
        self.assertEqual((plan['server'], plan['local'], plan['transfer']['state']), (False, 'server_ended', 'cancelled'))
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual((e.exception.code, e.exception.extra['local_possible']), ('wrong_state', True))
        self.assertNotIn('outcome', att(self.store.state)[0])
        r = c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN, local_only=True)
        self.assertEqual((r['server'], r['local'], len(r['matched']), self.net.resolutions), (None, 'server_ended', 1, []))
        self.assertIn('GET /pilot/v1/owner', self.net.requests())       # the owner token was checked
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')

    def test_a_409_from_the_server_is_raised_for_the_owners_choice(self):
        # GET /transfers showed outcome_unknown, then the server ended it before the owner's POST: 409 wrong_state.
        c, T = self.unknown_transfer()

        def ended(method, path, body):
            if method == 'POST' and path.endswith('/resolve'):
                self.net.transfers[TID]['state'] = 'failed'
        self.net.hooks.append(ended)
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        self.assertEqual((e.exception.code, e.exception.status, e.exception.extra['local_possible']), ('wrong_state', 409, True))
        self.assertEqual(e.exception.extra['server']['error'], 'wrong_state')
        self.assertNotIn('outcome', att(self.store.state)[0])
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN, local_only=True)
        self.assertEqual((r['server'], r['local'], att(self.store.state)[0]['outcome']), (None, 'server_ended', 'not_applied'))

    def test_applied_while_the_payees_edge_does_not_show_it_is_explained_and_not_recorded(self):
        # valun-app SV-AUTH-1: the server records 'applied' only while the payee's edge on the tracker shows the
        # transfer; otherwise 409 payee_edge_not_applied {payee_edge} and nothing changes. My client says why and what
        # to do instead (not_applied once the payee confirms, or ask the operator), and records nothing, not even
        # locally: recording it as applied in my records alone would stop my client paying a deal the payee may lack.
        c, T = self.unknown_transfer()
        server_says = []

        def refuse(method, path, body):
            if method == 'POST' and path.endswith('/resolve') and body.get('outcome') == 'applied':
                server_says.append(path)
                raise vc.ValunError('payee_edge_not_applied', "the payee's edge on the tracker does not show this "
                                    'transfer\x1b[2J', 409, {'payee_edge': 'prior'})
        self.net.hooks.append(refuse)
        before = copy.deepcopy(self.store.state)
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'applied', OWNER_TOKEN)
        err = e.exception
        self.assertEqual((err.code, err.status, len(server_says)), ('payee_edge_not_applied', 409, 1))
        self.assertEqual((err.extra['payee_edge'], err.extra['next_steps'], err.extra['local_possible']),
                         ('prior', ['not_applied', 'ask_operator'], False))
        self.assertEqual(err.extra['server']['error'], 'payee_edge_not_applied')
        self.assertIn('still at the state the transfer started from', str(err))
        self.assertIn('resolve it as not applied', str(err))
        self.assertIn('ask the operator', str(err))
        self.assertNotIn('\x1b', str(err))                      # the server's own text is not in the message
        self.assertEqual(self.store.state, before)              # nothing recorded: not the outcome, not paid_deals
        self.assertEqual((self.net.resolutions, self.net.transfers[TID]['state']), ([], 'outcome_unknown'))
        # a class the server did not name, or one in another form, is reported as unnamed
        for odd in (None, 'Prior!', 7):
            def odd_refusal(method, path, body, odd=odd):
                if method == 'POST' and path.endswith('/resolve'):
                    raise vc.ValunError('payee_edge_not_applied', 'no', 409, {} if odd is None else {'payee_edge': odd})
            self.net.hooks[:] = [odd_refusal]
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, TID, 'applied', OWNER_TOKEN)
            self.assertIsNone(e.exception.extra['payee_edge'])
            self.assertIn("the server did not say how it reads the payee's edge", str(e.exception))
        # the way it suggests: the owner resolves it as not applied, which the server records
        self.net.hooks[:] = []
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        self.assertEqual((r['outcome'], r['paid'], self.net.transfers[TID]['state']),
                         ('not_applied', False, 'resolved_not_applied'))

    def test_a_bound_note_is_resolved_in_the_records_only(self):
        # The server holds no payment attempt for a credit note (its route takes transfers only): the owner's decision
        # is recorded in my records, after the owner token is checked, and the deal can be paid once the window passed.
        c, ts = self.held_bound_note_moved()
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'attempt_outcome_unknown')
        self.assertEqual(c.resolution_plan(DEAL, '#1')['local'], 'note')
        for token, code in (('vpa_not-the-owner', 'not_owner'), (OTHER_OWNER, 'not_owner')):
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, '#1', 'not_applied', token)
            self.assertEqual(e.exception.code, code)
        self.assertNotIn('outcome', att(self.store.state)[0])
        r = c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual((r['server'], r['local'], len(r['matched']), self.net.resolutions), (None, 'note', 1, []))
        self.assertFalse([p for m, p, _b in self.net.log if m == 'POST' and p.startswith('/pilot/v1/owner')])
        with self.assertRaises(vc.ValunError) as e:
            c.complete(DEAL)
        self.assertEqual(e.exception.code, 'transfer_window_open')      # not before its window has passed
        self.clock.now = ts + LATER
        self.assertEqual(c.complete(DEAL)['status'], 'note_issued')

    def test_an_attempt_recorded_applied_stays_applied(self):
        c, T = self.unknown_transfer()
        # my records hold it applied (the owner's earlier decision): never resolved as not applied, nothing is sent
        c.resolve_attempt(DEAL, '#1', 'applied', OWNER_TOKEN)
        self.net.transfers[TID]['state'] = 'outcome_unknown'             # as if the server had not taken it
        posts = len(self.net.resolutions)
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual((len(self.net.resolutions), att(self.store.state)[0]['outcome']), (posts, 'applied'))
        # another process records it applied while the owner's not_applied is on its way: the evidence is kept
        self.setUp()
        c, T = self.unknown_transfer()

        def applied_meanwhile(method, path, body):
            if method == 'POST' and path.endswith('/resolve'):
                att(self.store.state)[0]['outcome'] = 'applied'
        self.net.hooks.append(applied_meanwhile)
        r = c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual((r['matched'][0]['outcome'], att(self.store.state)[0]['outcome']), ('applied', 'applied'))

    def test_a_live_transfer_or_a_bad_name_is_refused_before_anything_changes(self):
        self.net.transfer_mode = 'collect'
        c = self.client()
        c.pay_by_transfer(DEAL, A_ID)                                   # collecting signatures at the server
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual(e.exception.code, 'attempt_in_progress')
        for deal, attempt in ((DEAL, 'vs_0123456789abcdef'), (DEAL, '#0'), (DEAL, 'vt_0123'), ('vd_1', '#1'),
                              (DEAL, '#1\nx')):
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(deal, attempt, 'not_applied', OWNER_TOKEN)
            self.assertEqual(e.exception.code, 'bad_arguments', (deal, attempt))
        # the server's transfer of the id my records hold is not this attempt (another deal's): the owner may only
        # record a decision locally; an id the owner gives that names no payment of mine, nor any record, is unknown
        self.net.add_deal(DEAL2)
        self.net.transfers[TID]['deal_id'] = DEAL2
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        self.assertEqual((e.exception.code, e.exception.extra['local']), ('not_found', 'server_unknown'))
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, 'vt_9999999999999999', 'not_applied', OWNER_TOKEN)
        self.assertEqual(e.exception.code, 'unknown_attempt')
        self.net.transfers[TID]['deal_id'] = DEAL
        self.net.transfers[TID]['timestamp'] += 1000                   # or another timestamp than my record's
        self.assertEqual(c.resolution_plan(DEAL, '#1')['local'], 'server_unknown')
        for token in (None, '', '  '):
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, '#1', 'not_applied', token)
            self.assertEqual(e.exception.code, 'bad_arguments')
        self.assertEqual(self.net.resolutions, [])
        self.assertNotIn('outcome', att(self.store.state)[0])

    def test_the_note_is_checked_before_anything_is_sent(self):
        c, T = self.unknown_transfer()
        for bad in ('x' * 301, 'payee said no‮', 'zero​width', 'bell\x07', 'ok️', '\U0001F600' * 151):
            del self.net.log[:]
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN, note=bad)
            self.assertEqual(e.exception.code, 'bad_arguments', repr(bad))
            self.assertEqual(self.net.log, [], repr(bad))                 # nothing read or sent
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN, note='  ' + 'y' * 300 + '\n')
        self.assertEqual(self.net.resolutions, [(DEAL, TID, {'outcome': 'not_applied', 'note': 'y' * 300})])
        self.assertEqual(r['outcome'], 'not_applied')

    def test_without_the_server_only_the_records_change_and_a_pending_entry_becomes_a_record(self):
        # An ordinary note held, then (unknown to the client) rejected: the owner resolves it locally (no circulation).
        self.net.features = None
        self.net.review = True
        c = self.client(profile(issued={BC: 6}))
        c.complete(DEAL)
        self.net.review = False
        (row,) = c.payment_attempts()
        self.assertEqual((row['route'], row['prior'], row['attempt_id']), ('note', None, None))
        r = c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN)
        self.assertEqual((r['server'], len(r['matched']), self.net.resolutions), (None, 1, []))
        rec, = att(self.store.state)
        self.assertEqual((rec['route'], rec['edge'], rec['prior'], rec['total'], rec['outcome']), ('note', BC, 6, 9, 'not_applied'))
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#2', 'applied', OWNER_TOKEN)
        self.assertEqual(e.exception.code, 'unknown_attempt')
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, '#1', 'maybe', OWNER_TOKEN)
        self.assertEqual(e.exception.code, 'bad_arguments')

    # ----- FX2-PY -----
    def test_a_404_for_a_token_that_is_not_this_owners_offers_no_local_resolution(self):
        # FX-SV answers the owner route with 404 not_found for an agent token (the owner routes do not exist for it)
        # and for another participant's owner token (no party to the deal), as for an attempt it does not hold. The
        # owner token is checked with GET /owner before a resolution in the records only is offered.
        c, T = self.unknown_transfer()
        route = f'POST /pilot/v1/owner/deals/{DEAL}/attempts/{TID}/resolve'
        for token in (AGENT_TOKEN, OTHER_OWNER):
            del self.net.log[:]
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, TID, 'not_applied', token)
            self.assertEqual(e.exception.code, 'not_owner', token)
            self.assertNotIn('local_possible', e.exception.extra or {}, token)
            self.assertEqual(self.net.requests()[-2:], [route, 'GET /pilot/v1/owner'], token)
        self.assertEqual((self.net.resolutions, self.net.transfers[TID]['state']), ([], 'outcome_unknown'))
        self.assertNotIn('outcome', att(self.store.state)[0])
        # This participant's owner token: a 404 means the server holds no such attempt of the deal (it moved to another
        # deal before the POST, here), and the owner may then choose to record the decision locally.
        self.net.add_deal(DEAL2)

        def moved(method, path, body):
            if method == 'POST' and path.endswith('/resolve'):
                self.net.transfers[TID]['deal_id'] = DEAL2
        self.net.hooks.append(moved)
        del self.net.log[:]
        with self.assertRaises(vc.ValunError) as e:
            c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN)
        self.assertEqual((e.exception.code, e.exception.status, e.exception.extra['local_possible']), ('not_found', 404, True))
        self.assertEqual(e.exception.extra['server']['error'], 'not_found')
        self.assertEqual(self.net.requests()[-2:], [route, 'GET /pilot/v1/owner'])
        self.assertNotIn('outcome', att(self.store.state)[0])
        r = c.resolve_attempt(DEAL, TID, 'not_applied', OWNER_TOKEN, local_only=True)
        self.assertEqual((r['server'], r['local'], att(self.store.state)[0]['outcome']), (None, 'server_unknown', 'not_applied'))

    def test_only_the_attempt_the_owner_confirmed_is_resolved(self):
        # `valun attempts resolve` shows the plan for '#n', asks, then calls resolve_attempt with the confirmed attempt's
        # key. resolve_attempt plans again: if the deal's attempts changed in between (another process pruned the first,
        # here), '#1' names another attempt, and it refuses (attempt_changed) before anything is sent or changed.
        c, T = self.unknown_transfer()
        unknown = att(self.store.state)[0]
        earlier = dict(copy.deepcopy(unknown), timestamp=T - 2000, attempt_id=None)
        self.store.state['transfer_attempts'][DEAL].insert(0, earlier)
        plan = c.resolution_plan(DEAL, '#1')
        self.assertEqual((plan['attempt']['timestamp'], plan['local']), (T - 2000, 'no_server_id'))
        confirmed = vc.attempt_key(plan['attempt'])
        self.assertEqual(confirmed, ['transfer', AB, 7, T - 2000])
        self.store.state['transfer_attempts'][DEAL].pop(0)              # meanwhile: '#1' is now the unknown transfer
        del self.net.log[:]
        for expected in (confirmed, tuple(confirmed), None):
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN, local_only=True, expected_attempt=expected)
            self.assertEqual(e.exception.code, 'attempt_changed', expected)
        self.assertEqual(self.net.requests('POST'), [])
        self.assertNotIn('GET /pilot/v1/owner', self.net.requests())
        self.assertNotIn('outcome', att(self.store.state)[0])
        for bad in ('#1', ['transfer', AB, 7], 7):
            with self.assertRaises(vc.ValunError) as e:
                c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN, expected_attempt=bad)
            self.assertEqual(e.exception.code, 'bad_arguments', bad)
        # the attempt shown is the one resolved
        r = c.resolve_attempt(DEAL, '#1', 'not_applied', OWNER_TOKEN,
                              expected_attempt=vc.attempt_key(c.resolution_plan(DEAL, '#1')['attempt']))
        self.assertEqual((r['attempt_id'], self.net.resolutions), (TID, [(DEAL, TID, {'outcome': 'not_applied'})]))
        self.assertEqual(att(self.store.state)[0]['outcome'], 'not_applied')
        self.assertIsNone(vc.attempt_key(None))

    def test_a_paid_deal_names_the_attempt_that_paid_it(self):
        # INT-1: a transfer that was rejected (or cancelled) acknowledged the same prior state as the retry that then
        # paid the deal. A raise of an incoming edge needs no signature of mine (D-2 a), so my records cannot prove the
        # first dead; the deal is recorded as paid by the second, and payment_attempts names it (paid_by).
        c = self.client()
        T1, T2 = res(NOW - 120_000, 999), res(NOW - 60_000, 999)
        first = {'deal_id': DEAL, 'route': 'transfer', 'edge': AB, 'prior': 10, 'prior_timestamp': TS_AB,
                 'prior_signature': self.net.tracker[AB]['signature'], 'total': 7, 'timestamp': T1, 'quote_digest': None,
                 'signed_at': None, 'attempt_id': 'vt_1111111111111111'}
        self.store.state['transfer_attempts'] = {DEAL: [first, dict(first, timestamp=T2, attempt_id='vt_2222222222222222')]}
        self.store.state['records'] = {'paid_deals': {DEAL: {'route': 'transfer', 'edge': AB, 'total': 7, 'timestamp': T2}}}
        self.net.set_edge(A, B, 7, T2)                                  # the retry applied
        read = c.sync_edges()
        rows = c.payment_attempts(edges=read['edges'], doubtful=read['doubtful'])
        self.assertEqual([(r['ref'], r['state'], r['paid'], r['paid_by']) for r in rows],
                         [('#1', 'unknown', True, '#2'), ('#2', 'applied', True, '#2')])
        self.assertEqual(list(rows[0])[-2:], ['paid', 'paid_by'])        # appended last (the JS mirror keeps the order)
        # paid by a payment the list does not show, or not paid: no ref
        self.store.state['records']['paid_deals'][DEAL]['timestamp'] = T2 + 1000
        self.assertEqual([(r['paid'], r['paid_by']) for r in c.payment_attempts(edges=read['edges'])], [(True, None)] * 2)
        del self.store.state['records']['paid_deals'][DEAL]
        self.assertEqual([(r['paid'], r['paid_by']) for r in c.payment_attempts(edges=read['edges'])], [(False, None)] * 2)


class Counter(Base):
    def test_the_new_version_follows_the_verified_terms(self):
        d = make_deal(payer=C_ID, payee=B_ID, status='open')       # C (payer) offered; B, the payee, counters
        d['current']['state'] = 'open'
        d['current']['version'] = 7                                # the server's view; the hashed terms say 1
        d.pop('agreement')
        self.net.deals[DEAL] = d
        self.client().counter(DEAL, price=5)
        (_m, _p, body), = [x for x in self.net.log if x[0] == 'POST']
        self.assertEqual((body['terms']['version'], body['terms']['price']['amount']), (2, 5))
        self.assertEqual(body['terms']['prior_terms_hash'], d['current']['terms_hash'])


# ---------------------------------------------------------------------------------------------------------------------
class TrackerContract(Base):
    """Tracker v3.2 (design v3.2 section 5): bound notes, payments by transfer and the payer's and payee's consents sign
    prior acknowledgments PA(...), and are signed only when GET /info novation reports exactly the v3.2 contract
    (tracker_build valun-circulating-credit/4, transfer_version 4, bound_note_version 3, prior_ack basis/prior-ack/1).
    Otherwise they fail closed with feature_unavailable, before anything is asked for or signed, as on a server without
    circulation/1; issuer and set-off consents (80-byte note messages only) are not gated."""

    V31 = dict(INFO_NOVATION, tracker_build='valun-circulating-credit/3', transfer_version=3, bound_note_version=2)
    V31.pop('prior_ack')

    def contracts(self):
        return {'v3.1': self.V31, 'none': None, 'version as a string': dict(INFO_NOVATION, transfer_version='4'),
                'another prior_ack': dict(INFO_NOVATION, prior_ack='basis/prior-ack/2')}

    def test_a_bound_note_is_not_signed_without_the_contract(self):
        for name, novation in self.contracts().items():
            with self.subTest(name):
                self.setUp()
                self.net.novation = novation
                c = self.client()
                with self.assertRaises(vc.ValunError) as e:
                    c.complete(DEAL)
                self.assertEqual(e.exception.code, 'feature_unavailable')
                self.assertIn('nothing was signed', str(e.exception))
                # no template asked for, no ordinary note instead, nothing written ahead
                self.assertEqual([r for r in self.net.requests() if 'credit-note-template' in r or r.startswith('POST')], [])
                self.assertEqual(att(self.store.state), [])
                self.assertFalse(self.store.state.get('signed'))

    def test_a_payment_by_transfer_is_not_signed_without_the_contract(self):
        for name, novation in self.contracts().items():
            with self.subTest(name):
                self.setUp()
                self.net.novation = novation
                c = self.client()
                with self.assertRaises(vc.ValunError) as e:
                    c.pay_by_transfer(DEAL, A_ID)
                self.assertEqual(e.exception.code, 'feature_unavailable')
                self.assertEqual([r for r in self.net.requests() if 'transfer-template' in r or r.startswith('POST')], [])
                self.assertEqual(self.net.pay_posts, [])
                self.assertEqual(att(self.store.state), [])

    def test_with_the_contract_both_are_signed(self):
        self.assertEqual(self.client().complete(DEAL)['status'], 'note_issued')
        self.setUp()
        self.assertEqual(self.client().pay_by_transfer(DEAL, A_ID)['status'], 'paid_by_transfer')

    def test_payee_and_payer_consents_wait_and_set_offs_are_signed(self):
        T = res(NOW - 1500, 999)
        self.net.novation = self.V31
        self.net.me_id = C_ID
        d = self.net.deals[DEAL]
        d.update(status='paying_by_transfer', your_role='payee', payment={'method': 'transfer', 'transfer_id': TID})
        q = self.net.transfer_template(DEAL, A_ID)['quote_digest']
        self.net.consent_items = [consent_item(
            'transfer', TID, 'payee', [edge_row(A, C, 4, TS_AC, 7, T, 'creditor', ['prior', 'new'], (A_ID, C_ID))],
            dict(who3(), amount=3, deal={'deal_id': DEAL, 'terms_hash': d['agreement']['terms_hash'], 'price': 3, 'quote_digest': q}))]
        rep = self.client(profile(C_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['role'], e['code']) for e in rep['waiting']], [(TID, 'payee', 'feature_unavailable')])
        self.assertEqual((rep['signed'], rep['refused'], self.net.consent_posts, self.net.refusals), ([], [], [], []))
        self.assertNotIn(f'GET /pilot/v1/deals/{DEAL}', self.net.requests())      # not even read
        # the issuer's and a set-off member's consents sign 80-byte note messages only: signed on any contract
        self.setUp()
        self.net.novation, self.net.me_id = None, A_ID
        self.net.consent_items = [issuer_item(T), member_item(res(NOW - 1500, 998))]
        rep = self.client(profile(A_ID, consent_policy=dict(POLICY))).process_consents()
        self.assertEqual([(e['id'], e['role']) for e in rep['signed']], [(TID, 'issuer'), (SID, 'member')])

    def test_a_template_naming_another_prior_timestamp_is_refused(self):
        # The server may name the prior timestamp beside the prior total (bound template: prior_timestamp; transfer:
        # from_edge/to_edge.prior_timestamp): it must be the prior state's, as the total must be.
        real = self.net.handle

        def lying(method, path, body=None):
            out = real(method, path, body)
            if method == 'GET' and 'credit-note-template' in path:
                out = dict(out, prior_timestamp=out['prior_note']['timestamp'] - 1)
            if method == 'GET' and 'transfer-template' in path:
                out = copy.deepcopy(out)
                out['from_edge']['prior_timestamp'] = out['from_edge']['before']['timestamp'] + 1
            return out
        self.net.handle = lying
        for pay in (lambda c: c.complete(DEAL), lambda c: c.pay_by_transfer(DEAL, A_ID)):
            with self.assertRaises(vc.ValunError) as e:
                pay(self.client())
            self.assertEqual(e.exception.code, 'bad_template')
        self.assertEqual([r for r in self.net.requests() if r.startswith('POST')], [])

if __name__ == '__main__':
    unittest.main()
