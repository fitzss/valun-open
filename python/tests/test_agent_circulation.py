"""The agent tools with circulating credit (0.4), against a fake Valun v16 server with its tracker and the two sandbox
agents (offline, real signatures, throwaway keys): pay_with is a commitment, its approval text shows what moves and its
arguments pin the issuer, the quote and the claim (a stale one is refused, a prepare failure blocks every adapter);
exact_result delivers the exact text-stats or notary result; the new status, deal and inbox fields and the circulation
labels appear only when GET /info lists circulation/1 and are worded exactly; process_consents() runs before tools that
are not read-only, at most once a minute, never from read-only tools; sandbox_next_steps; and the phase-0 fixes
(_resolve by exact id first, prepare_or_refusal keeps setup refusals, ask_owner needs its text).

The World here (also used by test_cli_tour.py) is the server's sandbox as the five-step tour of design 9.2 sees it:
sandbox-exact (X) and sandbox-mallory (M) are server-run, sign at once, buy and sell exactly checkable jobs, pay with
bound credit notes (never by transfer here), and every cycle through the stranger (S, the client under test) is
proposed to it as a set-off; the server-only cycle X <-> M is cleared at once."""
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun import novation as nv  # noqa: E402
from valun import sandbox as sb  # noqa: E402
from valun import schemas  # noqa: E402

NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
SERVER = 'http://valun.invalid'
CIRC = ('bound_notes/1', 'circulation/1')
AGENT_TOKEN = 'vpa_test-only'                   # the agent token the World enrolls (a throwaway test value)
UNBOUND = 'could not read what you would sign; nothing was signed'
SERVER_SETTLEMENT = ('not settled: a credit note is an outstanding obligation. With circulating credit it can move to a new '
                     'creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an equal '
                     'opposite obligation (set-off, signed by every party; no net position changes). Nothing is redeemed, '
                     'there is no reserve, and PC have no value.')


def key(label):
    """Throwaway test key: secret = (sha256(label) mod (n - 1)) + 1, as in the spec vectors."""
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'secret': secret, 'pubkey': vb.public_key(secret).hex()}


S_ID, X_ID, M_ID, O_ID = 'vp_5a5a5a5a5a5a', 'vp_e1e1e1e1e1e1', 'vp_d1d1d1d1d1d1', 'vp_0b0b0b0b0b0b'
S, X, M, O = (key(f'test/tour/{n}') for n in ('stranger', 'exact', 'mallory', 'outsider'))
HANDLES = {S_ID: 'stranger', X_ID: va.SANDBOX_EXACT, M_ID: va.SANDBOX_MALLORY, O_ID: 'outsider'}
WELCOME = 'Welcome to the Valun sandbox, stranger. This text is your first paid job.'


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def now_ms():
    return int(time.time() * 1000)


def next_ts(now, r, after):
    """How v16 picks a novation or bound-note timestamp: the largest ending in r ms, at most now - 1500 and later than
    `after` (else the next one after `after`)."""
    t = (now - 1500) - ((now - 1500 - r) % 1000)
    return t if t > after else after + 1 + (r - (after + 1)) % 1000


def sign_text(k, text):
    return vb.sign(text.encode('utf-8'), k['secret'], bytes.fromhex(k['pubkey'])).hex()


def msg(i, r, total, ts):
    return vb.note_message(bytes.fromhex(i), bytes.fromhex(r), total, ts, bytes.fromhex(NFT), DENOM)


def pa(i, r, prior_total, prior_ts, ts):
    """PA(I,R,X,p,T), the prior acknowledgment of tracker v3.2 (p = 0 for an absent edge)."""
    return vb.prior_ack_message(bytes.fromhex(i), bytes.fromhex(r), prior_total, prior_ts, ts, bytes.fromhex(NFT), DENOM)


# GET /info novation of a v16 server on tracker v3.2: the novation constants and the tracker contract (design v3.2)
INFO_NOVATION = {'transfer_ms': 999, 'setoff_ms': 998, 'bound_note_ms': 997, 'reserved_ms': [995, 996, 997, 998, 999],
                 'max_age_ms': 3600000, 'transfer_ttl_ms': 1200000, 'setoff_ttl_ms': 1800000, 'fallback_margin_ms': 60000,
                 'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3,
                 'prior_ack': 'basis/prior-ack/1'}


def sign_note(k, recipient_pk, total, ts):
    return vb.sign(msg(k['pubkey'], recipient_pk, total, ts), k['secret'], bytes.fromhex(k['pubkey'])).hex()


def signed_by(pk, data, sig):
    try:
        return isinstance(sig, str) and vb.verify(bytes.fromhex(sig), data, bytes.fromhex(pk))
    except ValueError:
        return False


SANDBOX_MANDATE = {'objective': 'Self-serve sandbox', 'may_issue_credit': True, 'may_accept_credit': True,
                   'max_issue_per_deal': 5, 'max_issue_outstanding': 40, 'max_accept_per_deal': 5, 'max_accept_per_issuer': 40,
                   'min_price_as_payee': 0, 'min_payer_coverage_pct': 0, 'counterparties': [X_ID, M_ID], 'approve_above': 1000,
                   'review_deliveries': False, 'expires_at': None, 'auto_clear': True, 'novate_own_debt': True,
                   'accept_transfers': True, 'accept_notes_from': [X_ID, M_ID], 'refuse_notes_from': [],
                   'pay_with_held_notes': 'when_asked'}
CIRCULATION_FIELDS = ('auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from', 'refuse_notes_from',
                      'pay_with_held_notes')
V15_MANDATE = {k: v for k, v in SANDBOX_MANDATE.items() if k not in CIRCULATION_FIELDS}


class World:
    """A fake Valun v16 server (circulation on unless features say otherwise), its tracker, and the sandbox agents, for
    the stranger S. Every request is answered, then the sandbox agents act (tick): what the real server does a few
    hundred ms later happens here at once."""

    def __init__(self, features=CIRC, sandbox_only=True, welcome=True, wrong=1, s_key=S):
        self.features = None if features is None else list(features)
        self.keys = {X_ID: X, M_ID: M, O_ID: O}
        if s_key is not None:
            self.keys[S_ID] = s_key
        self.sandbox_only, self.welcome, self.welcomed, self.wrong_left = sandbox_only, welcome, False, wrong
        self.tracker, self.journal, self.seq, self.bound_only = {}, [], 0, set()
        self.deals, self.order, self.items, self.cycles = {}, [], {}, {}
        self.log, self.posts, self.puts, self.counter = [], [], [], 0
        self.mandate = dict(SANDBOX_MANDATE if features and 'circulation/1' in features else V15_MANDATE)
        self.mandate_version, self.joined = 1, now_ms()
        self.fail = {}                          # 'METHOD /route' -> [ValunError, ...]: raised once each, in order
        self.template_issuer = None             # force the transfer template's issuer pubkey (a lying server)
        self.bad_edge_signatures = False        # /edges rows signed by the wrong key
        self.pay_due = False                    # pay-by-transfer ends payment_due (the transfer did not apply)
        self.pay_unknown = False                # pay-by-transfer is recorded and its outcome stays unknown (outcome_unknown)
        self.lose_pay_answer = False            # pay-by-transfer is recorded, then no answer reaches the client
        self.resolutions = []                   # (deal, attempt, body, token) of POST owner .../attempts/.../resolve
        self.transfers = {}                     # the server's transfers by id, in valun-app FX-SV's states
        # The consent roles the server took from S's X-Valun-Features header (a set; wired() records them). None: no gate,
        # for the tests whose requests carry no header. A set: as the v16 server, a set-off through S is proposed only
        # while S declared the setoff role (its clearing participant check; decision D-3 b withdraws it at once).
        self.s_roles = None

    # ---------- helpers ----------
    def pk(self, pid):
        return self.keys[pid]['pubkey']

    def pid_of(self, pk):
        return next((p for p, k in self.keys.items() if k['pubkey'] == pk), None)

    def edge(self, i, r):
        return f'{self.pk(i)}>{self.pk(r)}'

    def total(self, i, r):
        st = self.tracker.get(self.edge(i, r))
        return st['total'] if st else 0

    def set_edge(self, i, r, total, ts, kind='issue', ref=None, signature=None):
        """Put a state on the tracker (signed by the issuer, or with `signature`) and journal it."""
        e = self.edge(i, r)
        before = self.total(i, r)
        sig = signature or sign_note(self.keys[i], self.pk(r), total, ts)
        self.tracker[e] = {'total': total, 'timestamp': ts, 'signature': sig}
        self.seq += 1
        self.journal.append({'seq': self.seq, 'at': iso(now_ms()), 'kind': kind, 'ref': ref, 'edge': e, 'issuer_pubkey': self.pk(i),
                             'recipient_pubkey': self.pk(r), 'delta': total - before, 'total_after': total, 'timestamp': ts,
                             'signature': sig})
        if kind != 'issue':
            self.bound_only.add(e)

    def last_ts(self, i, r):
        st = self.tracker.get(self.edge(i, r))
        return st['timestamp'] if st else 0

    def new_id(self, prefix):
        self.counter += 1
        return prefix + hashlib.sha256(f'{prefix}{self.counter}'.encode()).hexdigest()[:16]

    def public(self, pid):
        services = sb.SERVICES_TEXT if pid in (X_ID, M_ID) else ''
        out = {'id': pid, 'handle': HANDLES[pid], 'display_name': HANDLES[pid], 'operator': 'test', 'about': '', 'services': services,
               'pubkey': self.pk(pid) if pid in self.keys else None, 'status': 'active' if pid in self.keys else 'pending',
               'joined_at': iso(self.joined), 'agent_last_seen': iso(now_ms())}
        if pid == S_ID and self.sandbox_only:
            out.update(sandbox_only=True, sandbox_expires_at=iso(self.joined + 7 * 86400000))
        return out

    # ---------- deals ----------
    def add_deal(self, payer, payee, title, description, deliverable, price, proposer=None, by_signature=None, terms=None):
        did = terms['deal_id'] if terms else self.new_id('vd_')
        proposer = proposer or (terms or {}).get('proposer') or payer
        if terms is None:
            n = now_ms()
            terms = {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': did,
                     'version': 1, 'prior_terms_hash': None, 'nonce': hashlib.sha256(did.encode()).hexdigest()[:32],
                     'proposer': proposer, 'payer': {'id': payer, 'pubkey': self.pk(payer)}, 'payee': {'id': payee, 'pubkey': self.pk(payee)},
                     'service': {'title': title, 'description': description, 'deliverable': deliverable},
                     'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
                     'deliver_by': iso(n + 48 * 3600000), 'offer_expires_at': iso(n + 24 * 3600000)}
        h = vc.terms_hash(terms)
        sig = by_signature or sign_text(self.keys[proposer], vc.statement('propose', h))
        self.deals[did] = {'id': did, 'payer': terms['payer']['id'], 'payee': terms['payee']['id'], 'status': 'open',
                           'current': {'version': 1, 'by': proposer, 'state': 'open', 'terms': terms, 'terms_hash': h, 'signature': sig},
                           'agreement': None, 'delivery': None, 'credit_note': None, 'payment': None, 'dispute': None}
        self.order.append(did)
        return self.deals[did]

    def agree(self, did, acceptor_signature):
        d = self.deals[did]
        h = d['current']['terms_hash']
        d['agreement'] = {'version': 1, 'terms_hash': h, 'formed_at': iso(now_ms()), 'proposer_signature': d['current']['signature'],
                          'acceptor_signature': acceptor_signature}
        d['current']['state'] = 'accepted'
        d['status'] = 'agreed'

    def deliver(self, did, content, title, by):
        d = self.deals[did]
        h, dh = d['agreement']['terms_hash'], vc.sha256_hex(content)
        d['delivery'] = {'by': by, 'title': title, 'content': content, 'sha256': dh, 'bytes': len(content.encode()),
                         'signature': sign_text(self.keys[by], vc.statement('deliver', h, dh)), 'late': False}
        d['status'] = 'delivered'

    def delivered_deal(self, payer=S_ID, payee=M_ID, service='notary', text='hello world', wrong=False):
        """A deal agreed and delivered (payee the agent), for the tests that start at the review."""
        price = sb.SERVICES[service]['price']
        d = self.add_deal(payer, payee, f'{service} job', f'{service} for this text:\n```\n{text}\n```',
                          f'The exact {service} result as JSON.', price)
        self.agree(d['id'], sign_text(self.keys[payee], vc.statement('accept', d['current']['terms_hash'])))
        result = sb.COMPUTE[service](text)
        if wrong:
            result = dict(result, bytes=result.get('bytes', 0) + 1) if service == 'notary' else dict(result, words=result['words'] + 1)
        self.deliver(d['id'], sb.render(service, result, text), f'{service} result', payee)
        return d['id']

    def view(self, did):
        d = self.deals[did]
        role = 'payer' if d['payer'] == S_ID else 'payee'
        other = d['payee'] if role == 'payer' else d['payer']
        out = {'id': did, 'status': d['status'], 'you': S_ID, 'your_role': role, 'counterparty': self.public(other),
               'next_actions': [], 'current': copy.deepcopy(d['current']),
               'versions': [{'version': 1, 'by': d['current']['by'], 'state': d['current']['state'],
                             'terms_hash': d['current']['terms_hash'], 'price': d['current']['terms']['price'],
                             'signature': d['current']['signature']}],
               'acceptance': None, 'agreement': copy.deepcopy(d['agreement']), 'decline': None, 'delivery': copy.deepcopy(d['delivery']),
               'completion': None, 'dispute': d['dispute'], 'credit_note': copy.deepcopy(d['credit_note']), 'cancellation': None,
               'approvals': [], 'history': [], 'labels': {}}
        if d['payment'] is not None or (self.features and 'circulation/1' in self.features):
            out['payment'] = copy.deepcopy(d['payment'])        # as v16: the key is there in circulation modes (null: none)
        return out

    def brief(self, did):
        d = self.deals[did]
        t = d['current']['terms']
        role = 'payer' if d['payer'] == S_ID else 'payee'
        return {'deal_id': did, 'status': d['status'], 'counterparty': HANDLES[d['payee'] if role == 'payer' else d['payer']],
                'your_role': role, 'title': t['service']['title'], 'price': t['price'], 'version': 1,
                'offer_expires_at': t['offer_expires_at'], 'deliver_by': t['deliver_by']}

    def inbox(self):
        box = {k: [] for k in ('respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed')}
        for did in self.order:
            d = self.deals[did]
            if S_ID not in (d['payer'], d['payee']):
                continue
            payer, st = d['payer'] == S_ID, d['status']
            if st == 'open':
                sec = 'waiting_on_others' if d['current']['by'] == S_ID else 'respond'
            elif st == 'agreed':
                sec = 'waiting_on_others' if payer else 'deliver'
            elif st in ('delivered', 'note_failed', 'payment_due'):
                sec = 'review_delivery' if payer else 'waiting_on_others'
            elif st == 'paying_by_transfer':
                sec = 'waiting_on_others'
            else:
                sec = 'recent_closed'
            box[sec].append(self.brief(did))
        if self.features and 'circulation/1' in self.features:
            box['consents_waiting_for_your_client'] = sum(1 for i in self.items.values() if i['state'] == 'collecting')
            box['payments_in_progress'] = [dict(self.brief(did), payment=self.deals[did]['payment']) for did in self.order
                                           if self.deals[did]['status'] == 'paying_by_transfer']
        return box

    def position(self):
        me = self.pk(S_ID)
        claims, debts = [], []
        for e, st in self.tracker.items():
            i, r = e.split('>')
            if r == me:
                claims.append({'from': HANDLES[self.pid_of(i)], 'amount': st['total'], 'issuer_id': self.pid_of(i), 'issuer_pubkey': i,
                               'recipient_pubkey': r})
            if i == me:
                debts.append({'to': HANDLES[self.pid_of(r)], 'amount': st['total'], 'recipient_id': self.pid_of(r), 'recipient_pubkey': r,
                              'issuer_pubkey': i})
        held, owes = sum(c['amount'] for c in claims), sum(d['amount'] for d in debts)
        buckets = {'credit_notes_issued': 0, 'open': 0, 'agreed_note_not_issued': 0, 'disputed': 0, 'declined': 0,
                   'expired_or_withdrawn': 0}
        for d in self.deals.values():
            st = d['status']
            b = {'note_issued': 'credit_notes_issued', 'open': 'open', 'disputed': 'disputed', 'declined': 'declined',
                 'paid_by_transfer': 'paid_by_transfer'}.get(st, 'agreed_note_not_issued')
            buckets[b] = buckets.get(b, 0) + 1
        out = {'participant_id': S_ID, 'unit': DENOM, 'claims_held': held, 'owes': owes, 'net': held - owes,
               'claims': [{'from': c['from'], 'amount': c['amount']} for c in claims],
               'debts': [{'to': d['to'], 'amount': d['amount']} for d in debts], 'deals': buckets, 'settled': 0,
               'backing': 'none: the pilot tracker has no chain and no reserves; PC are simulated units', 'meaning': 'v15'}
        if not (self.features and 'circulation/1' in self.features):
            out['deals'] = {k: v for k, v in buckets.items() if k != 'paid_by_transfer'}
            return out
        cleared = sum(-j['delta'] for j in self.journal if j['kind'] == 'setoff' and j['issuer_pubkey'] == me)
        buckets.setdefault('paid_by_transfer', 0)
        out.update(gross=held + owes, cleared_by_setoff=cleared, settled=cleared, settled_how='by set-off only; nothing is redeemed',
                   claims=claims, debts=debts, deals=buckets,
                   spendable_notes=[{'issuer_id': c['issuer_id'], 'issuer_handle': c['from'], 'issuer_pubkey': c['issuer_pubkey'],
                                     'outstanding': c['amount'], 'reserved': 0, 'spendable': c['amount'], 'issuer_consents': 'immediate'}
                                    for c in claims if c['amount'] > 0],
                   pending={'paying_by_transfer': 0, 'consents_waiting_for_you': sum(1 for i in self.items.values() if i['state'] == 'collecting'),
                            'consents_waiting_for_others': 0})
        return out

    # ---------- the sandbox agents ----------
    def tick(self):
        if self.features and 'circulation/1' in self.features and self.welcome and not self.welcomed and S_ID in self.keys:
            self.welcomed = True
            self.add_deal(X_ID, S_ID, 'Welcome job: text-stats', f'Your first paid job: text-stats of this text:\n```\n{WELCOME}\n```',
                          'the exact text-stats result as JSON (your Valun client can compute it: valun_deliver exact_result=true)', 3)
        for did in list(self.order):
            d = self.deals[did]
            if S_ID not in (d['payer'], d['payee']):
                continue
            agent = d['payee'] if d['payer'] == S_ID else d['payer']
            if agent not in (X_ID, M_ID):
                continue
            terms = d['current']['terms']
            service = sb.which_service(terms)
            text = sb.extract_text(terms['service']['description'])
            if d['status'] == 'open' and d['current']['by'] == S_ID:
                self.agree(did, sign_text(self.keys[agent], vc.statement('accept', d['current']['terms_hash'])))
            if d['status'] == 'agreed' and d['payee'] == agent:
                result = sb.COMPUTE[service](text)
                if agent == M_ID and self.wrong_left > 0:
                    self.wrong_left -= 1
                    result = dict(result, bytes=result['bytes'] + 1) if service == 'notary' else dict(result, words=result['words'] + 1)
                self.deliver(did, sb.render(service, result, text), f'{service} result', agent)
            if d['status'] == 'delivered' and d['payer'] == agent:
                if sb.parse_result(d['delivery']['content']) == sb.COMPUTE[service](text):
                    self.agent_pays(did, agent)
                else:
                    d['status'] = 'disputed'
        self.clear()

    def agent_pays(self, did, agent):
        """A sandbox agent pays a stranger's delivery with its own bound credit note (residue 997)."""
        d = self.deals[did]
        price = d['current']['terms']['price']['amount']
        P = self.total(agent, S_ID)
        ts = next_ts(now_ms(), 997, self.last_ts(agent, S_ID))
        self.set_edge(agent, S_ID, P + price, ts, 'issue', did)
        st = self.tracker[self.edge(agent, S_ID)]
        d['status'] = 'note_issued'
        d['credit_note'] = {'state': 'recorded', 'amount': price, 'note': dict(st),
                            'tracker_note': {'amount_collected': st['total'], 'timestamp': ts, 'signature': st['signature'],
                                             'confirmation': 'local_only'}}

    def clear(self):
        """The clearing engine, as the tour needs it: the server-only cycle X <-> M at once; every 2- or 3-cycle through
        S proposed to S as one set-off (one at a time)."""
        if S_ID not in self.keys:
            return None
        if self.total(X_ID, M_ID) > 0 and self.total(M_ID, X_ID) > 0:
            d = min(self.total(X_ID, M_ID), self.total(M_ID, X_ID))
            for i, r in ((X_ID, M_ID), (M_ID, X_ID)):
                self.set_edge(i, r, self.total(i, r) - d, next_ts(now_ms(), 998, self.last_ts(i, r)), 'setoff', 'vs_server')
        if any(i['state'] == 'collecting' for i in self.items.values()):
            return
        if self.s_roles is not None and 'setoff' not in self.s_roles:
            return None                         # setoff_consent: S is left out of every set-off
        for a in (X_ID, M_ID):
            if self.total(S_ID, a) > 0 and self.total(a, S_ID) > 0:
                return self.propose_setoff([(S_ID, a), (a, S_ID)])
        for a, b in ((X_ID, M_ID), (M_ID, X_ID)):
            if self.total(S_ID, a) > 0 and self.total(a, b) > 0 and self.total(b, S_ID) > 0:
                return self.propose_setoff([(b, S_ID), (S_ID, a), (a, b)])
        return None

    def propose_setoff(self, cycle):
        d = min(self.total(i, r) for i, r in cycle)
        sid = self.new_id('vs_')
        ts = {(i, r): next_ts(now_ms(), 998, self.last_ts(i, r)) for i, r in cycle}
        edges = []
        for i, r in cycle:
            if S_ID not in (i, r):
                continue
            before = dict(self.tracker[self.edge(i, r)])
            edges.append({'edge': self.edge(i, r), 'issuer': {'id': i, 'handle': HANDLES[i]}, 'recipient': {'id': r, 'handle': HANDLES[r]},
                          'your_role': 'issuer' if i == S_ID else 'creditor', 'before': before, 'change': -d,
                          'new_total': before['total'] - d, 'timestamp': ts[(i, r)], 'revision': 1, 'slots': ['new'], 'signed_by_you': []})
        self.items[sid] = {'kind': 'setoff', 'id': sid, 'state': 'collecting', 'your_roles': ['member'], 'created_at': iso(now_ms()),
                           'expires_at': iso(now_ms() + 1800000), 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
                           'edges': edges, 'context': {}, 'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': -d}}
        self.cycles[sid] = {'cycle': cycle, 'd': d, 'ts': ts}

    # ---------- the HTTP surface ----------
    def handle(self, method, path, body=None, token=None):
        self.log.append((method, path, copy.deepcopy(body)))
        route, _, query = path.partition('?')
        key_ = f'{method} {route}'
        if self.fail.get(key_):
            raise self.fail[key_].pop(0)
        out = self.route(method, route, dict(urllib.parse.parse_qsl(query)), body, token)
        out = copy.deepcopy(out)
        if method != 'GET' or route in ('/pilot/v1/inbox', '/pilot/v1/me'):
            self.tick()
        return out

    def route(self, method, route, q, body, token):
        parts = [urllib.parse.unquote(x) for x in route.split('/')[3:]]
        circ = bool(self.features and 'circulation/1' in self.features)
        if method == 'GET' and parts == ['info']:
            out = {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM}
            if self.features is not None:
                out['features'] = list(self.features)
                nov = getattr(self, 'novation', INFO_NOVATION)     # a test may set another (None: none)
                if nov is not None:
                    out['novation'] = copy.deepcopy(nov)
            return out
        if method == 'POST' and parts == ['join-sandbox']:
            return {'participant_id': S_ID, 'owner_token': 'vpo_test-only', 'enrollment_code': 'code', 'sandbox_only': True,
                    'note': 'sandbox only'}
        if method == 'POST' and parts == ['join']:
            self.sandbox_only = False
            return {'participant_id': S_ID, 'owner_token': 'vpo_test-only', 'enrollment_code': 'code'}
        if method == 'POST' and parts == ['enroll']:
            self.keys[S_ID] = {'pubkey': body['pubkey']}
            return {'network': vc.NETWORK, 'agent_token': AGENT_TOKEN}
        if method == 'GET' and parts == ['owner']:
            if token == AGENT_TOKEN:            # FX-SV: the owner routes do not exist for an agent token (404)
                raise vc.ValunError('not_found', 'not found', 404)
            if token != 'vpo_test-only':
                raise vc.ValunError('unauthorized', 'owner token required', 401)
            return {'participant': self.public(S_ID), 'mandate': dict(self.mandate)}
        if method == 'PUT' and parts == ['owner', 'mandate']:
            self.puts.append(copy.deepcopy(body))
            return {'mandate': dict(self.mandate)}
        if method == 'POST' and len(parts) == 6 and parts[:2] == ['owner', 'deals'] and parts[3] == 'attempts' \
                and parts[5] == 'resolve' and circ:
            return self.resolve(parts[2], parts[4], body, token)
        if circ and method == 'GET' and len(parts) == 2 and parts[0] == 'transfers':
            if parts[1] not in self.transfers:
                raise vc.ValunError('not_found', 'not found', 404)
            return self.transfer_view(self.transfers[parts[1]])
        if method == 'GET' and parts == ['participants']:
            return [self.public(p) for p in (S_ID, X_ID, M_ID) if p in self.keys or p == S_ID]
        if method == 'GET' and len(parts) == 2 and parts[0] == 'participants' and parts[1] in HANDLES:
            return self.public(parts[1])
        if method == 'GET' and parts == ['me']:
            return {'role': 'agent', 'participant': self.public(S_ID), 'mandate': dict(self.mandate), 'mandate_version': self.mandate_version,
                    'effective_limits': dict(self.mandate), 'agent_limits': {}, 'position': self.position(), 'authority': {}}
        if method == 'GET' and parts == ['inbox']:
            return self.inbox()
        if method == 'PUT' and parts == ['limits']:
            return {'agent_limits': dict(body), 'effective_limits': dict(self.mandate)}
        if method == 'POST' and parts == ['deals']:
            return self.post_deal(body)
        if len(parts) >= 2 and parts[0] == 'deals' and parts[1] in self.deals:
            return self.deal_route(method, parts[1], parts[2:], q, body, circ)
        if circ and parts == ['consents'] and method == 'GET':
            return {'consents': [copy.deepcopy(i) for i in self.items.values() if i['state'] == 'collecting'], 'recently_resolved': []}
        if circ and len(parts) == 2 and parts[0] == 'consents' and method == 'POST' and parts[1] in self.items:
            return self.consent(parts[1], body)
        if circ and len(parts) == 3 and parts[0] == 'consents' and parts[2] == 'refuse' and method == 'POST':
            self.items[parts[1]]['state'] = 'refused'
            return {'id': parts[1], 'state': 'refused'}
        if self.features and parts == ['edges'] and method == 'GET':
            return self.edges(int(q.get('since', '0')))
        raise vc.ValunError('not_found', f'no route {method} {route}', 404)

    def post_deal(self, body):
        t, h = body['terms'], body['terms_hash']
        if vc.terms_hash(t) != h or not signed_by(self.pk(S_ID), vc.statement('propose', h).encode(), body['signature']):
            raise vc.ValunError('bad_signature', 'the proposal does not verify', 403)
        d = self.add_deal(None, None, None, None, None, None, by_signature=body['signature'], terms=t)
        return self.view(d['id'])

    def deal_route(self, method, did, rest, q, body, circ):
        d = self.deals[did]
        h = d['current']['terms_hash']
        if method == 'GET' and not rest:
            return self.view(did)
        if method == 'POST' and rest == ['accept']:
            if not signed_by(self.pk(S_ID), vc.statement('accept', h).encode(), body['signature']):
                raise vc.ValunError('bad_signature', 'the acceptance does not verify', 403)
            self.agree(did, body['signature'])
            return self.view(did)
        if method == 'POST' and rest == ['decline']:
            d['status'] = 'declined'
            return self.view(did)
        if method == 'POST' and rest == ['deliver']:
            dh = vc.sha256_hex(body['content'])
            if dh != body['sha256'] or not signed_by(self.pk(S_ID), vc.statement('deliver', h, dh).encode(), body['signature']):
                raise vc.ValunError('bad_signature', 'the delivery does not verify', 403)
            self.posts.append(('deliver', did, copy.deepcopy(body)))
            d['delivery'] = {'by': S_ID, 'title': body['title'], 'content': body['content'], 'sha256': dh,
                             'bytes': len(body['content'].encode()), 'signature': body['signature'], 'late': False}
            d['status'] = 'delivered'
            return self.view(did)
        if method == 'POST' and rest == ['dispute']:
            d['status'], d['dispute'] = 'disputed', {'reason': body['reason']}
            return self.view(did)
        if method == 'GET' and rest == ['credit-note-template']:
            return self.note_template(did, q.get('bound') == '1')
        if method == 'POST' and rest == ['complete']:
            return self.complete(did, body)
        if circ and method == 'GET' and rest == ['payment-options']:
            return self.payment_options(did)
        if circ and method == 'GET' and rest == ['transfer-template']:
            return self.transfer_template(did, q.get('issuer'))
        if circ and method == 'POST' and rest == ['pay-by-transfer']:
            out = self.pay(did, body)
            if self.lose_pay_answer:
                raise vc.ValunError('unreachable', 'cannot reach the server')
            return out
        raise vc.ValunError('not_found', f'no route {method} {rest}', 404)

    def note_template(self, did, bound):
        d = self.deals[did]
        payee = d['payee']
        cur = self.tracker.get(self.edge(S_ID, payee))
        last = cur['timestamp'] if cur else 0
        ts = next_ts(now_ms(), 997, last) if bound else max(now_ms() - 1500, last + 1)
        if not bound and self.features and ts % 1000 >= 995:
            ts += 1000 - ts % 1000
        P, price = (cur['total'] if cur else 0), d['current']['terms']['price']['amount']
        tpl = {'deal_id': did, 'terms_hash': d['agreement']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
               'issuer_pubkey': self.pk(S_ID), 'recipient_pubkey': self.pk(payee), 'keys_as_agreed': True, 'prior_total': P,
               'price': price, 'total': P + price, 'timestamp': ts, 'tracker_nft_id': NFT, 'denomination': DENOM, 'message_hex': '00'}
        if bound:
            tpl.update(prior_note=dict(cur) if cur else None, prior_message_hex='00')
        return tpl

    def complete(self, did, body):
        d = self.deals[did]
        payee, me = d['payee'], self.pk(S_ID)
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        if not signed_by(me, vc.statement('complete', h, dh).encode(), body['signature']):
            raise vc.ValunError('bad_signature', 'the completion statement does not verify', 403)
        n, P = body['credit_note'], self.total(S_ID, payee)
        if n['total'] != P + d['current']['terms']['price']['amount'] or not signed_by(me, msg(me, self.pk(payee), n['total'], n['timestamp']), n['signature']):
            raise vc.ValunError('stale_note', 'the note is not the prior plus the price', 409)
        cur = self.tracker.get(self.edge(S_ID, payee))
        p = cur['timestamp'] if cur else 0
        if n['timestamp'] % 1000 == 997 and (n.get('prior_timestamp', p) != p
                                             or not signed_by(me, pa(me, self.pk(payee), P, p, n['timestamp']), n.get('prior_signature'))):
            raise vc.ValunError('bad_signature', 'the prior acknowledgment does not verify', 403)
        self.set_edge(S_ID, payee, n['total'], n['timestamp'], 'issue', did, signature=n['signature'])
        d['status'] = 'note_issued'
        d['credit_note'] = {'state': 'recorded', 'amount': d['current']['terms']['price']['amount'],
                            'note': {k: n[k] for k in ('total', 'timestamp', 'signature')},
                            'tracker_note': {'amount_collected': n['total'], 'timestamp': n['timestamp'], 'signature': n['signature'],
                                             'confirmation': 'local_only'}}
        return self.view(did)

    def payment_options(self, did):
        d = self.deals[did]
        price, payee = d['current']['terms']['price']['amount'], d['payee']
        held = []
        for iid in (X_ID, M_ID, O_ID):
            total = self.total(iid, S_ID)
            if total <= 0:
                continue
            why = 'pay_with_is_payee' if iid == payee else (None if total >= price else 'insufficient_claim')
            held.append({'issuer': {'id': iid, 'handle': HANDLES[iid], 'pubkey': self.pk(iid), 'operator_run': iid != O_ID},
                         'held': total, 'reserved': 0, 'spendable': total, 'enough': total >= price, 'payee_accepts': True,
                         'issuer_consents': 'immediate' if iid != O_ID else 'when_online', 'payee_consents': 'immediate', 'why_not': why})
        return {'deal_id': did, 'price': price, 'payee': self.public(payee), 'own_note': {'available': True, 'why_not': None},
                'held_notes': held, 'pending_transfer': None, 'fallback_after': None}

    def transfer_template(self, did, issuer_id):
        if issuer_id not in self.keys:
            raise vc.ValunError('not_found', 'no such participant', 404)
        d = self.deals[did]
        a, payee = d['current']['terms']['price']['amount'], d['payee']
        fb, tb = self.tracker.get(self.edge(issuer_id, S_ID)), self.tracker.get(self.edge(issuer_id, payee))
        if fb is None or fb['total'] < a:
            raise vc.ValunError('insufficient_claim', 'you hold too little of this issuer', 409)
        T = next_ts(now_ms(), 999, max(fb['timestamp'], tb['timestamp'] if tb else 0))
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        A, B, C = self.pk(issuer_id), self.pk(S_ID), self.pk(payee)
        q = nv.quote_digest({'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': did, 'terms_hash': h,
                             'deliverable_sha256': dh, 'issuer_pubkey': A, 'payer_pubkey': B, 'payee_pubkey': C, 'amount': a})

        def who(pid, pk):
            return {'id': pid, 'handle': HANDLES[pid], 'pubkey': pk}
        return {'deal_id': did, 'terms_hash': h, 'deliverable_sha256': dh, 'issuer': who(issuer_id, self.template_issuer or A),
                'payer': who(S_ID, B), 'payee': who(payee, C), 'amount': a, 'timestamp': T,
                'from_edge': {'before': dict(fb), 'new_total': fb['total'] - a},
                'to_edge': {'before': dict(tb) if tb else None, 'new_total': (tb['total'] if tb else 0) + a},
                'tracker_nft_id': NFT, 'denomination': DENOM, 'quote_digest': q, 'collect_until': iso(now_ms() + 1200000),
                'messages': {}}

    def pay(self, did, body):
        self.posts.append(('pay-by-transfer', did, copy.deepcopy(body)))
        d = self.deals[did]
        iid, a, T = body['issuer_id'], d['current']['terms']['price']['amount'], body['timestamp']
        A, B, C = self.pk(iid), self.pk(S_ID), self.pk(d['payee'])
        X_, Y_ = self.total(iid, S_ID), self.total(iid, d['payee'])
        if (body['from_prior_total'], body['to_prior_total']) != (X_, Y_):
            raise vc.ValunError('transfer_stale', 'an edge moved', 409, {'template': self.transfer_template(did, iid)})
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        q = self.transfer_template(did, iid)['quote_digest']
        s = body['signatures']
        ok = (body['quote_digest'] == q and signed_by(B, vc.statement('complete', h, dh).encode(), body['completion_signature'])
              and signed_by(B, nv.pay_statement(did, q).encode(), body['pay_signature'])
              and signed_by(B, pa(A, B, X_, self.tracker[self.edge(iid, S_ID)]['timestamp'], T), s.get(f'{A}>{B}:prior'))
              and signed_by(B, msg(A, B, X_ - a, T), s.get(f'{A}>{B}:new'))
              and signed_by(B, msg(A, C, Y_ + a, T), s.get(f'{A}>{C}:new')))
        if not ok:
            raise vc.ValunError('bad_signature', 'a signature of the payment does not verify', 403)
        tid = self.new_id('vt_')
        fb, tb = self.tracker.get(self.edge(iid, S_ID)), self.tracker.get(self.edge(iid, d['payee']))
        self.add_transfer(tid, did, 'failed' if self.pay_due else 'outcome_unknown' if self.pay_unknown else 'applied', T,
                          (self.edge(iid, S_ID), fb, X_ - a), (self.edge(iid, d['payee']), tb, Y_ + a), a)
        if self.pay_due or self.pay_unknown:
            d['status'] = 'payment_due' if self.pay_due else 'paying_by_transfer'
            d['payment'] = {'method': 'transfer', 'state': self.transfers[tid]['state'], 'transfer_id': tid,
                            'issuer': {'id': iid}, 'amount': a}
            return self.view(did)
        self.set_edge(iid, S_ID, X_ - a, T, 'transfer_out', tid)
        self.set_edge(iid, d['payee'], Y_ + a, T, 'transfer_in', tid)
        d['status'] = 'paid_by_transfer'
        d['payment'] = {'method': 'transfer', 'state': 'applied', 'transfer_id': tid, 'issuer': {'id': iid, 'handle': HANDLES[iid]},
                        'amount': a}
        return self.view(did)

    def add_transfer(self, tid, did, state, T, frm, to, amount):
        """The server records a transfer (FX-SV states), as GET /transfers/:vt shows it later."""
        self.transfers[tid] = {'id': tid, 'deal_id': did, 'state': state, 'timestamp': T, 'amount': amount,
                               'from': (frm[0], copy.deepcopy(frm[1]), frm[2]), 'to': (to[0], copy.deepcopy(to[1]), to[2])}

    def transfer_view(self, t):
        """GET /transfers/:vt as valun-app FX-SV shows it to the payer (transferView: both edges, the deal)."""
        d = self.deals.get(t['deal_id'])
        return {'id': t['id'], 'kind': 'transfer', 'state': t['state'], 'your_roles': ['payer'], 'attempt': 1,
                'regenerated_from': None, 'regenerated_as': None, 'timestamp': t['timestamp'], 'amount': t['amount'],
                'edges': [{'edge': e, 'before': copy.deepcopy(b), 'new_total': n, 'change': n - (b['total'] if b else 0),
                           'timestamp': t['timestamp']} for e, b, n in (t['from'], t['to'])],
                'deal': {'deal_id': t['deal_id'], 'terms_hash': d['current']['terms_hash'] if d else None,
                         'price': t['amount'], 'quote_digest': None},
                'result': None, 'fallback_after': None, 'signatures': None,
                'signatures_withheld': 'withheld until the Basis tracker records the transfer'}

    def resolve(self, did, tid, body, token):
        """POST /owner/deals/:vd/attempts/:vt/resolve as valun-app FX-SV answers it (resolveAttempt). The owner routes
        do not exist for an agent token: 404 not_found, as for an attempt it does not hold (http.mjs)."""
        if token == AGENT_TOKEN:
            raise vc.ValunError('not_found', 'not found', 404)
        if token != 'vpo_test-only':
            raise vc.ValunError('unauthorized', 'owner token required', 401)
        t = self.transfers.get(tid)
        if t is None or t['deal_id'] != did:
            raise vc.ValunError('not_found', f'unknown payment attempt {tid}', 404)
        if t['state'] not in ('outcome_unknown', 'inconsistent'):
            raise vc.ValunError('wrong_state', f"this payment attempt is {t['state']}; only one whose outcome is unknown "
                                               '(outcome_unknown or inconsistent) is resolved by its owner', 409)
        if body.get('outcome') not in ('not_applied', 'applied'):
            raise vc.ValunError('invalid_field', 'outcome must be "not_applied" or "applied"', 400)
        self.resolutions.append((did, tid, copy.deepcopy(body), token))
        previous = t['state']
        t['state'] = 'applied' if body['outcome'] == 'applied' else 'resolved_not_applied'
        if body['outcome'] == 'applied' and did in self.deals:
            self.deals[did].update(status='paid_by_transfer', payment={'method': 'transfer', 'transfer_id': tid})
        return {'resolution': {'attempt_id': tid, 'outcome': body['outcome'], 'previous_state': previous,
                               'at': iso(now_ms()), 'note': (body.get('note') or '').strip()},
                'deal': self.view(did) if did in self.deals else None, 'transfer': self.transfer_view(t)}

    def consent(self, sid, body):
        item, cyc = self.items[sid], self.cycles[sid]
        me = self.pk(S_ID)
        mine = {e['edge']: e for e in item['edges']}
        for slot, sig in body['signatures'].items():
            edge = slot.rsplit(':', 1)[0]
            e = mine[edge]
            i, r = edge.split('>')
            if not signed_by(me, msg(i, r, e['new_total'], e['timestamp']), sig):
                raise vc.ValunError('bad_signature', f'{slot} does not verify', 403)
        if set(body['signatures']) != {f'{e}:new' for e in mine}:
            return dict(copy.deepcopy(item), rejected=[])
        for i, r in cyc['cycle']:
            e = self.edge(i, r)
            sig = body['signatures'].get(f'{e}:new') if i == S_ID else None
            self.set_edge(i, r, self.total(i, r) - cyc['d'], cyc['ts'][(i, r)], 'setoff', sid, signature=sig)
        item['state'] = 'applied'
        return dict(copy.deepcopy(item), rejected=[])

    def edges(self, since):
        me = self.pk(S_ID)
        rows = []
        for e, st in self.tracker.items():
            i, r = e.split('>')
            if me in (i, r):
                sig = st['signature'] if not self.bad_edge_signatures else sign_note(O, r, st['total'], st['timestamp'])
                rows.append({'edge': e, 'issuer': {'id': self.pid_of(i), 'handle': HANDLES[self.pid_of(i)]},
                             'recipient': {'id': self.pid_of(r), 'handle': HANDLES[self.pid_of(r)]}, 'issuer_pubkey': i,
                             'recipient_pubkey': r, 'total': st['total'], 'timestamp': st['timestamp'], 'signature': sig,
                             'exact': True, 'bound_only': e in self.bound_only, 'reserved': 0, 'frozen': False})
        entries = [j for j in self.journal if j['seq'] > since and me in (j['issuer_pubkey'], j['recipient_pubkey'])]
        if self.bad_edge_signatures:
            entries = []
        return {'incoming': [x for x in rows if x['recipient_pubkey'] == me], 'outgoing': [x for x in rows if x['issuer_pubkey'] == me],
                'journal': copy.deepcopy(entries[:200]), 'next_seq': self.seq}

    # ---------- what was asked ----------
    def requests(self, method=None):
        return [f'{m} {p}' for m, p, _b in self.log if method is None or m == method]


def profile_state(policy=va.SANDBOX_CONSENT_POLICY, loop='on', **extra):
    state = {'server': SERVER, 'participant_id': S_ID, 'pubkey': S['pubkey'], 'issued': {}, 'approvals': 'ask',
             'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}}
    if policy is not None:
        state['consent_policy'] = dict(policy)
    if loop is not None:
        state['consent_loop'] = loop
    state.update(extra)
    return state


class MemStore:
    """A store without update() or reload(): the client applies changes and calls save()."""

    def __init__(self, state, secret=S['secret'].hex(), token=AGENT_TOKEN):
        self.state, self._s, self._t = state, secret, token

    def secret(self):
        return self._s

    def token(self):
        return self._t

    def save(self):
        pass

    def save_credentials(self, secret_hex, token):
        self._s, self._t = secret_hex, token


def routed(world):
    """Every vc.Client request goes to `world` (the patch the CLI and agent tests use)."""
    def request(client, method, path, body=None, auth=True, token=None):
        return world.handle(method, path, json.loads(json.dumps(body)) if body is not None else None, token)
    return mock.patch.object(vc.Client, 'request', request)


REAL_REQUEST = vc.Client.request                # as imported: no routed() patch is started at import time
# The v16 server's routes answered before it authenticates the caller (valun-app lib/pilot/http.mjs), and
# GET /participants/{id}: no X-Valun-Features header sent to one of them reaches its record of the agent's roles.
PUBLIC_ROUTES = ('GET /pilot/v1/info', 'GET /pilot/v1/participants', 'GET /pilot/v1/ledger', 'GET /pilot/v1/clearing',
                 'POST /pilot/v1/join', 'POST /pilot/v1/join-sandbox', 'POST /pilot/v1/enroll')


class _Answer:
    def __init__(self, body):
        self.body = json.dumps(body).encode('utf-8')

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def wired(world, heads):
    """Two patches (start both): every vc.Client request goes to `world` through the real Client.request and urllib, even
    where routed() is started, so its headers and error answers are as on the wire. `heads` collects (method, route,
    X-Valun-Features) of each request. With world.s_roles a set, the world takes the roles as the v16 server does: from
    a request it authenticated with the agent token on an authenticated route and answered with 2xx; the empty list
    'consents/1;roles=' withdraws them at once (decision D-3 b); a request without the header leaves them as they are."""
    def urlopen(req, timeout=None):
        if not req.full_url.startswith(SERVER):
            raise urllib.error.URLError(f'not the test server: {req.full_url}')
        path, method = req.full_url[len(SERVER):], req.get_method()
        auth = req.get_header('Authorization') or ''
        tok = auth[len('Bearer '):] if auth.startswith('Bearer ') else None
        caps = req.get_header('X-valun-features')
        heads.append((method, path.split('?', 1)[0], caps))
        # The token world.handle() takes, as routed() gives it: an explicit (owner) token, else None for the agent's own;
        # on an owner route the agent token is passed as it is (the server answers it 404, as the world does).
        token = tok if tok != AGENT_TOKEN or path.startswith('/pilot/v1/owner') else None
        try:
            out = world.handle(method, path, json.loads(req.data.decode('utf-8')) if req.data else None, token)
        except vc.ValunError as e:
            if e.status is None:
                raise urllib.error.URLError(str(e)) from None
            body = json.dumps(dict(e.extra or {}, error=e.code, message=str(e))).encode('utf-8')
            raise urllib.error.HTTPError(req.full_url, e.status, e.code, {}, io.BytesIO(body)) from None
        route = path.split('?', 1)[0]
        public = f'{method} {route}' in PUBLIC_ROUTES or (method == 'GET' and route.startswith('/pilot/v1/participants/'))
        if world.s_roles is not None and caps is not None and tok == AGENT_TOKEN and not public:
            world.s_roles = {r for r in caps.split('roles=', 1)[-1].split(',') if r}
        return _Answer(out)
    return [mock.patch.object(vc.Client, 'request', REAL_REQUEST), mock.patch.object(vc.urllib.request, 'urlopen', urlopen)]


class Base(unittest.TestCase):
    features = CIRC

    def setUp(self):
        self.world = World(self.features)
        p = routed(self.world)
        p.start()
        self.addCleanup(p.stop)
        self.store = MemStore(profile_state())
        self.agent = va.ValunAgent(self.store, check_link_hosts=False)

    def hold(self, issuer, total):
        """S holds `total` PC of `issuer`'s notes (an ordinary note that was confirmed long ago)."""
        self.world.set_edge(issuer, S_ID, total, now_ms() - 3_600_000 - 7)


# ---------------------------------------------------------------------------------------------------------------------
class Schemas(unittest.TestCase):
    def test_still_nine_tools_in_the_original_order_with_new_keys_appended(self):
        self.assertEqual([t['name'] for t in schemas.ALL],
                         ['valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_propose', 'valun_respond',
                          'valun_deliver', 'valun_review_delivery', 'valun_set_limits'])
        self.assertEqual(list(schemas.REVIEW['parameters']['properties']),
                         ['deal_id', 'decision', 'reason', 'expected_deliverable_sha256', 'pay_with'])
        self.assertEqual(list(schemas.DELIVER['parameters']['properties']),
                         ['deal_id', 'content', 'send_anyway', 'title', 'exact_result'])
        self.assertEqual(schemas.DELIVER['parameters']['required'], ['deal_id'])
        self.assertEqual(schemas.REVIEW['parameters']['required'], ['deal_id', 'decision'])
        self.assertEqual(schemas.DELIVER['parameters']['properties']['exact_result']['type'], 'boolean')
        self.assertEqual(schemas.REVIEW['parameters']['properties']['pay_with']['type'], 'string')
        self.assertIn('notes_you_can_spend', schemas.STATUS['description'])
        self.assertIn('consents', schemas.INBOX['description'])
        self.assertEqual(va.TOOL_NAMES, [t['name'] for t in schemas.ALL])

    def test_pay_with_acceptances_are_commitments(self):
        a = va.ValunAgent(store=None)
        for pw in ('sandbox-exact', 'own_note', X_ID, '', 7, None):
            self.assertTrue(a.is_commitment('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept', 'pay_with': pw}), pw)
        self.assertFalse(a.is_commitment('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'dispute', 'pay_with': 'x'}))
        self.assertFalse(a.is_commitment('valun_deliver', {'deal_id': 'vd_1', 'exact_result': True}))


class PayWith(Base):
    def setUp(self):
        super().setUp()
        self.hold(X_ID, 3)
        self.did = self.world.delivered_deal(payee=M_ID, service='notary')
        self.args = {'deal_id': self.did, 'decision': 'accept', 'pay_with': 'sandbox-exact'}

    def test_prepare_pins_the_issuer_the_quote_and_the_claim_and_shows_what_moves(self):
        p = self.agent.prepare('valun_review_delivery', self.args)
        tpl = self.world.transfer_template(self.did, X_ID)
        d = self.world.deals[self.did]
        self.assertEqual(p['args'], {'deal_id': self.did, 'decision': 'accept', 'pay_with': X_ID,
                                     'expected_deliverable_sha256': d['delivery']['sha256'],
                                     'expected_terms_hash': d['current']['terms_hash'],
                                     'expected_quote_digest': tpl['quote_digest'], 'expected_claim_total': 3})
        lines = p['text'].split('\n')
        self.assertEqual(lines[0], f"Valun - PAY sandbox-mallory 2 PC for deal {self.did} by moving 2 PC of sandbox-exact's debt "
                                   'from you to sandbox-mallory:')
        self.assertEqual(lines[1:5], ['  your claim on sandbox-exact: 3 -> 1 PC (issuer signature checked by your client)',
                                      '  sandbox-exact will owe sandbox-mallory 0 -> 2 PC; its total debt does not change',
                                      '  you issue no credit note for this deal',
                                      '  sandbox-exact consents immediately; accepting is final: if the transfer does not complete '
                                      'the deal stays accepted and you pay later'])
        self.assertIn(f'sandbox-exact is {X_ID} and sandbox-mallory is {M_ID}', lines[5])
        self.assertIn('exact result: matches the agreed text', p['text'])
        self.assertEqual(lines[-2], va.NOT_SETTLED_CIRCULATION)
        self.assertTrue(lines[-1].startswith('Delivery title and agreed service text (quoted exactly): '))
        self.assertTrue(all(ord(ch) < 128 for ch in p['text']))
        self.assertNotIn('POST', [m for m, *_ in self.world.log])          # preparing signs and sends nothing

    def test_prepare_refuses_without_the_tracker_v32_contract(self):
        # tracker v3.2: the approval snapshot of a payment by transfer is made only for the contract the client signs
        # prior acknowledgments for (as Client.pay_by_transfer checks); nothing is read past GET /info, nothing signed
        for nov in (None, dict(INFO_NOVATION, transfer_version=3)):
            with self.subTest(novation=nov):
                self.world.novation = nov
                del self.world.log[:]
                with self.assertRaises(vc.ValunError) as e:
                    self.agent.prepare('valun_review_delivery', self.args)
                self.assertEqual((e.exception.code, e.exception.extra.get('cause')), ('approval_unbound', 'feature_unavailable'))
                self.assertFalse([r for m, r, _b in self.world.log if 'payment-options' in r or 'transfer-template' in r or m == 'POST'])

    def test_the_bound_call_pays_exactly_what_was_approved(self):
        p = self.agent.prepare('valun_review_delivery', self.args)
        r = self.agent.call('valun_review_delivery', p['args'])
        self.assertEqual(r['status'], 'paid_by_transfer')
        self.assertIn('sandbox-exact now owes sandbox-mallory 2 PC more and you 2 PC less', r['what_happened'])
        self.assertTrue(r['what_happened'].endswith(SERVER_SETTLEMENT))
        (_k, _d, body), = [x for x in self.world.posts if x[0] == 'pay-by-transfer']
        self.assertEqual((body['issuer_id'], body['quote_digest'], body['from_prior_total']),
                         (X_ID, p['args']['expected_quote_digest'], 3))
        self.assertEqual((self.world.total(X_ID, S_ID), self.world.total(X_ID, M_ID)), (1, 2))
        self.assertEqual(self.store.state['approved_payments'][self.did], p['args']['expected_quote_digest'])

    def test_a_claim_that_moves_after_the_approval_is_not_signed(self):
        p = self.agent.prepare('valun_review_delivery', self.args)
        self.world.set_edge(X_ID, S_ID, 5, now_ms() - 60_000)         # sandbox-exact issued more to S meanwhile
        with self.assertRaises(vc.ValunError) as e:
            self.agent.call('valun_review_delivery', p['args'])
        self.assertEqual(e.exception.code, 'stale_claim')
        self.assertFalse([x for x in self.world.posts if x[0] == 'pay-by-transfer'])

    def test_a_quote_that_changes_after_the_approval_is_not_signed(self):
        p = self.agent.prepare('valun_review_delivery', self.args)
        self.world.keys[M_ID] = key('test/tour/mallory-rotated')     # the payee's key is replaced: another quote
        with self.assertRaises(vc.ValunError) as e:
            self.agent.call('valun_review_delivery', p['args'])
        self.assertEqual(e.exception.code, 'stale_quote')
        self.assertFalse([x for x in self.world.posts if x[0] == 'pay-by-transfer'])

    def test_a_claim_pin_compares_type_and_value(self):
        # 3.0 == 3 and True == 1 in Python: a pin is the snapshot's only when it is the same whole number.
        for v in (3.0, True):
            with self.assertRaises(vc.ValunError) as e:
                self.agent.prepare('valun_review_delivery', dict(self.args, expected_claim_total=v))
            self.assertEqual((e.exception.code, e.exception.extra.get('cause')), ('approval_unbound', 'stale_claim'), v)
        snap = {'checked': {'sha256': 'a' * 64, 'terms_hash': 'b' * 64},
                'transfer': {'issuer': {'id': X_ID}, 'quote_digest': 'c' * 64, 'claim': 1}}
        args = {'decision': 'accept', 'expected_deliverable_sha256': 'a' * 64, 'expected_terms_hash': 'b' * 64,
                'expected_quote_digest': 'c' * 64}
        with self.assertRaises(vc.ValunError) as e:
            va.ValunAgent._bind_from('valun_review_delivery', dict(args, expected_claim_total=True), snap, strict=True)
        self.assertEqual(e.exception.code, 'stale_claim')
        self.assertEqual(va.ValunAgent._bind_from('valun_review_delivery', dict(args, expected_claim_total=1), snap,
                                                  strict=True)['expected_claim_total'], 1)

    def test_a_claim_pin_that_is_not_a_whole_number_is_refused_before_signing(self):
        calls = []

        class C:
            def pay_by_transfer(self, *a, **kw):
                calls.append((a, kw))
                return {}
        for v in (3.0, True, '3', -1):
            with self.assertRaises(vc.ValunError) as e:
                self.agent._review_pay_with(C(), dict(self.args, expected_claim_total=v), X_ID)
            self.assertEqual(e.exception.code, 'bad_arguments', v)
        self.assertEqual(calls, [])

    def test_a_pin_the_agent_passed_must_be_the_snapshots(self):
        for k, v, cause in (('expected_quote_digest', 'e' * 64, 'stale_quote'), ('expected_claim_total', 9, 'stale_claim'),
                            ('expected_deliverable_sha256', 'f' * 64, 'stale_delivery')):
            with self.assertRaises(vc.ValunError) as e:
                self.agent.prepare('valun_review_delivery', dict(self.args, **{k: v}))
            self.assertEqual((e.exception.code, e.exception.extra.get('cause')), ('approval_unbound', cause), k)

    def test_a_prepare_failure_blocks_and_signs_nothing(self):
        cases = {'feature_unavailable': lambda w: setattr(w, 'features', ['bound_notes/1']),
                 'unknown_issuer': lambda w: None,
                 'insufficient_claim': lambda w: w.fail.setdefault('GET /pilot/v1/deals/%s/transfer-template' % self.did, []).extend(
                     [vc.ValunError('insufficient_claim', 'you hold too little', 409)] * 2),
                 'bad_template': lambda w: setattr(w, 'template_issuer', O['pubkey'])}
        for cause, breaks in cases.items():
            self.world.fail.clear()
            self.world.features, self.world.template_issuer = list(CIRC), None
            breaks(self.world)
            args = dict(self.args, pay_with='sandbox-mallory') if cause == 'unknown_issuer' else self.args
            with self.assertRaises(vc.ValunError) as e:
                self.agent.prepare('valun_review_delivery', args)
            self.assertEqual((e.exception.code, str(e.exception), e.exception.extra.get('cause')), ('approval_unbound', UNBOUND, cause))
            prepared, refusal = self.agent.prepare_or_refusal('valun_review_delivery', args)
            self.assertEqual((prepared, refusal['error'], refusal['cause']), (None, 'approval_unbound', cause))
        # Every adapter refuses without asking: MCP (both protocol paths) and `valun call`.
        self.world.features = ['bound_notes/1']
        out = io.BytesIO()
        s = mcp_server.McpServer(self.agent, 'ask', inp=io.BytesIO(b''), out=out, log=io.StringIO())
        s.initialize({'protocolVersion': '2025-11-25', 'capabilities': {'elicitation': {}}})
        r = s.call('valun_review_delivery', self.args)
        self.assertEqual((r['isError'], r['structuredContent']['error'], r['structuredContent']['cause']),
                         (True, 'approval_unbound', 'feature_unavailable'))
        r = s.call_modern({'name': 'valun_review_delivery', 'arguments': self.args},
                          {'io.modelcontextprotocol/clientCapabilities': {'elicitation': {}}})
        self.assertEqual((r['resultType'], r['structuredContent']['error']), ('complete', 'approval_unbound'))
        self.assertEqual(out.getvalue(), b'')
        self.assertFalse([m for m, *_ in self.world.log if m == 'POST'])

    def test_a_malformed_pay_with_is_refused(self):
        for pw in ('', '   ', 7, ['sandbox-exact'], 'x' * 65):
            with self.assertRaises(vc.ValunError) as e:
                self.agent.prepare('valun_review_delivery', dict(self.args, pay_with=pw))
            self.assertEqual(e.exception.code, 'approval_unbound', pw)
            with self.assertRaises(vc.ValunError) as e:
                self.agent.review(dict(self.args, pay_with=pw))
            self.assertEqual(e.exception.code, 'bad_arguments', pw)

    def test_own_note_is_the_ordinary_review(self):
        p = self.agent.prepare('valun_review_delivery', dict(self.args, pay_with='own_note'))
        self.assertIn('ISSUE A CREDIT NOTE of 2 PC', p['text'])
        self.assertNotIn('expected_quote_digest', p['args'])
        r = self.agent.call('valun_review_delivery', p['args'])
        self.assertEqual(r['status'], 'note_issued')
        self.assertTrue(r['what_happened'].endswith(SERVER_SETTLEMENT))   # the server advertises circulation/1
        self.assertEqual(self.world.total(S_ID, M_ID), 2)

    def test_the_issuer_is_resolved_by_exact_id_first(self):
        opts = {'held_notes': [{'issuer': {'id': O_ID, 'handle': X_ID}}, {'issuer': {'id': X_ID, 'handle': 'sandbox-exact'}}]}
        self.assertEqual(va.ValunAgent._held_note(opts, X_ID)['issuer']['id'], X_ID)
        self.assertEqual(va.ValunAgent._held_note(opts, 'sandbox-exact')['issuer']['id'], X_ID)
        two = {'held_notes': [{'issuer': {'id': O_ID, 'handle': 'same'}}, {'issuer': {'id': X_ID, 'handle': 'same'}}]}
        with self.assertRaises(vc.ValunError) as e:
            va.ValunAgent._held_note(two, 'same')
        self.assertEqual(e.exception.code, 'unknown_issuer')


class ExactResult(Base):
    def setUp(self):
        super().setUp()
        self.world.tick()                       # the welcome job arrives
        self.did = self.world.order[0]
        self.world.agree(self.did, sign_text(S, vc.statement('accept', self.world.deals[self.did]['current']['terms_hash'])))

    def test_the_client_computes_and_delivers_the_exact_result(self):
        self.world.welcome = False
        r = self.agent.call('valun_deliver', {'deal_id': self.did, 'exact_result': True})
        (_k, _d, body), = [x for x in self.world.posts if x[0] == 'deliver']
        self.assertEqual(body['content'], sb.render('text-stats', sb.text_stats(WELCOME), WELCOME))
        self.assertEqual(r['exact_result'], {'service': 'text-stats', 'result': sb.text_stats(WELCOME)})
        self.assertEqual(r['sha256'], vc.sha256_hex(body['content']))
        self.assertEqual(self.world.deals[self.did]['status'], 'note_issued')     # sandbox-exact checked it and paid
        self.assertEqual(self.world.total(X_ID, S_ID), 3)

    def test_other_jobs_and_bad_arguments_are_refused(self):
        other = self.world.add_deal(X_ID, S_ID, 'Short research brief', 'Three sources.', 'markdown', 3)
        self.world.agree(other['id'], sign_text(S, vc.statement('accept', other['current']['terms_hash'])))
        for args, code in (({'deal_id': other['id'], 'exact_result': True}, 'not_exact_service'),
                           ({'deal_id': self.did, 'exact_result': True, 'content': 'x' * 300}, 'bad_arguments'),
                           ({'deal_id': self.did}, 'bad_arguments'),
                           ({'deal_id': self.did, 'exact_result': 'yes'}, 'bad_arguments')):
            with self.assertRaises(vc.ValunError) as e:
                self.agent.call('valun_deliver', args)
            self.assertEqual(e.exception.code, code, args)
            self.assertIn(code, ('not_exact_service', 'bad_arguments'))
        self.assertEqual([x for x in self.world.posts if x[0] == 'deliver'], [])
        self.assertIn('exact_result works only', va.error_payload(vc.ValunError('not_exact_service', 'x'))['what_this_means'])


LEGACY_STATUS_KEYS = ['connected', 'server', 'network', 'unit', 'you', 'objective_from_your_owner', 'goals_your_owner_told_you',
                      'limits_you_recorded', 'limits_in_force', 'mandate', 'mandate_version', 'approvals', 'position', 'authority',
                      'settlement', 'honest_labels', 'real_vs_simulated']
CIRCULATION_STATUS_KEYS = ['summary', 'money_view', 'notes_you_can_spend', 'payments_in_progress', 'clearing',
                           'consent_policy_in_force']


class OnlyWhenAdvertised(unittest.TestCase):
    def run_status(self, features, sandbox_only=True):
        w = World(features, sandbox_only=sandbox_only, welcome=False)
        w.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        with routed(w):
            return va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_status', {}), w

    def test_status_fields_and_labels(self):
        for features in (None, ['bound_notes/1']):
            st, w = self.run_status(features)
            self.assertEqual(list(st), LEGACY_STATUS_KEYS, features)
            self.assertEqual((st['settlement'], st['honest_labels'], st['real_vs_simulated']),
                             (va.SETTLEMENT_NOTE, va.HONEST_LABELS, va.REAL_VS_SIMULATED))
            self.assertNotIn('GET /pilot/v1/inbox', w.requests())
            self.assertFalse([r for r in w.requests() if 'edges' in r or 'consents' in r])
        st, _w = self.run_status(list(CIRC))
        self.assertEqual(list(st), LEGACY_STATUS_KEYS + CIRCULATION_STATUS_KEYS + ['sandbox_next_steps'])
        self.assertEqual(st['settlement'], SERVER_SETTLEMENT)
        self.assertEqual(st['honest_labels'], va.HONEST_LABELS_CIRCULATION)
        self.assertEqual(st['honest_labels']['outstanding_promise'], SERVER_SETTLEMENT)
        self.assertEqual(st['real_vs_simulated'], va.REAL_VS_SIMULATED_CIRCULATION)
        self.assertEqual(st['notes_you_can_spend'], [{'issuer': 'sandbox-exact', 'amount_PC': 3, 'checked_by_your_client': True,
                                                      'issuer_consents': 'immediate',
                                                      'how': "valun_review_delivery decision='accept' pay_with=\"sandbox-exact\": pays a "
                                                             'delivery by moving that much of their debt to you onto the payee'}])
        self.assertEqual({k: v for k, v in st['money_view'].items() if k != 'how_to_read'},
                         {'you_hold_PC': 3, 'you_owe_PC': 0, 'net_PC': 3, 'cleared_so_far_PC': 0})
        self.assertTrue(st['summary'].startswith('You hold 3 PC of credit notes others issued to you and owe 0 PC (net 3 PC)'))
        self.assertEqual(st['clearing']['consents_pending'], 0)
        self.assertEqual(len(st['clearing']['your_client_signs']), 3)
        self.assertEqual((st['consent_policy_in_force']['setoff'], st['consent_policy_in_force']['as_issuer'],
                          st['consent_policy_in_force']['as_new_creditor']), (True, True, True))
        self.assertEqual(st['sandbox_next_steps']['tour_step'], 2)
        st, _w = self.run_status(list(CIRC), sandbox_only=False)
        self.assertEqual(list(st), LEGACY_STATUS_KEYS + CIRCULATION_STATUS_KEYS)

    def test_a_note_whose_tracker_state_does_not_verify_is_not_checked(self):
        w = World(list(CIRC), welcome=False)
        w.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        w.bad_edge_signatures = True
        with routed(w):
            st = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_status', {})
        self.assertEqual([n['checked_by_your_client'] for n in st['notes_you_can_spend']], [False])

    def test_deal_fields(self):
        for features in (None, list(CIRC)):
            w = World(features, welcome=False)
            w.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
            did = w.delivered_deal(payee=M_ID)
            with routed(w):
                d = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_deal', {'deal_id': did})
            self.assertEqual(d['whose_turn'], 'yours: accept the delivery or dispute it')
            self.assertNotIn('payment', d)
            if features is None:
                self.assertNotIn('how_you_can_pay', d)
                self.assertFalse([r for r in w.requests() if 'payment-options' in r])
                continue
            hp = d['how_you_can_pay']
            self.assertEqual([o['pay_with'] for o in hp['options']], ['own_note', 'sandbox-exact'])
            self.assertEqual((hp['options'][1]['available'], hp['options'][1]['spendable_PC'], hp['options'][1]['issuer_id']),
                             (True, 3, X_ID))
        w = World(list(CIRC), welcome=False)
        w.set_edge(X_ID, S_ID, 3, now_ms() - 60_000)
        did = w.delivered_deal(payee=M_ID)
        w.deals[did]['payment'] = {'method': 'transfer', 'state': 'collecting', 'transfer_id': 'vt_1'}
        texts = {}
        with routed(w):
            for st in ('paying_by_transfer', 'payment_due', 'paid_by_transfer'):
                w.deals[did]['status'] = st
                d = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_deal', {'deal_id': did})
                texts[st] = d['whose_turn']
                self.assertEqual(d['payment']['transfer_id'], 'vt_1')
                self.assertEqual('how_you_can_pay' in d, st == 'payment_due')
        self.assertTrue(texts['paying_by_transfer'].startswith('theirs: the issuer and the payee sign the debt transfer'))
        self.assertTrue(texts['payment_due'].startswith('yours: you accepted the delivery but it is not paid yet'))
        self.assertEqual(texts['paid_by_transfer'], 'nobody: the deal is paid by debt transfer')

    def test_a_deal_whose_info_cannot_be_read_is_shown_as_without_circulation(self):
        w = World(list(CIRC), welcome=False)
        did = w.delivered_deal(payee=M_ID)
        w.fail['GET /pilot/v1/info'] = [vc.ValunError('http_error', 'down', 503)]
        with routed(w):
            d = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_deal', {'deal_id': did})
        self.assertEqual((d['status'], 'how_you_can_pay' in d), ('delivered', False))

    def test_inbox_passes_the_new_keys_through_only_when_the_server_sends_them(self):
        for features in (None, list(CIRC)):
            w = World(features, welcome=False)
            with routed(w):
                box = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_inbox', {})
            has = features is not None
            self.assertEqual(('consents_waiting_for_your_client' in box, 'payments_in_progress' in box), (has, has))

    def test_the_labels_are_exact(self):
        self.assertEqual(va.CIRCULATION_SETTLEMENT, SERVER_SETTLEMENT)
        self.assertEqual(va.SETTLEMENT_NOTE_CIRCULATION, SERVER_SETTLEMENT)
        self.assertEqual(va.NOT_SETTLED_CIRCULATION, SERVER_SETTLEMENT)
        self.assertEqual(va.labels(False), {'settlement': va.SETTLEMENT_NOTE, 'not_settled': va.NOT_SETTLED,
                                            'honest_labels': va.HONEST_LABELS, 'real_vs_simulated': va.REAL_VS_SIMULATED})
        self.assertEqual(va.labels(True)['honest_labels']['outstanding_promise'], SERVER_SETTLEMENT)
        self.assertEqual(set(va.HONEST_LABELS_CIRCULATION), set(va.HONEST_LABELS))
        self.assertEqual(set(va.REAL_VS_SIMULATED_CIRCULATION), set(va.REAL_VS_SIMULATED))
        for text in list(va.HONEST_LABELS_CIRCULATION.values()) + list(va.REAL_VS_SIMULATED_CIRCULATION.values()):
            self.assertNotIn('Not supported: transferring', text)
            self.assertNotIn('settlement does not exist', text)
        # The legacy labels stay word for word (circulation off).
        self.assertTrue(va.NOT_SETTLED.startswith('A credit note is an outstanding promise to pay, not a payment'))
        self.assertIn('Not supported: transferring, assigning or endorsing a note you hold', va.HONEST_LABELS['third_party'])

    def test_approval_texts_use_the_circulation_label_in_a_fresh_process(self):
        # Until FX-PY a fresh process showed the legacy label until a status read; now the snapshot reads /info itself
        # when it does not know the features yet (and the deal view shows circulation is on).
        w = World(list(CIRC), welcome=False)
        did = w.delivered_deal(payee=M_ID)
        with routed(w):
            a = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False)
            first = a.prepare('valun_review_delivery', {'deal_id': did, 'decision': 'accept'})['text'].split('\n')
            reads = w.requests().count('GET /pilot/v1/info')
            again = a.prepare('valun_review_delivery', {'deal_id': did, 'decision': 'accept'})['text'].split('\n')
            propose = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).prepare(
                'valun_propose', {'counterparty': 'sandbox-exact', 'role': 'payee', 'title': 't', 'description': 'd',
                                  'deliverable': 'x', 'price': 3})['text'].split('\n')
        self.assertEqual((first[-2], again[-2], propose[-2]), (va.NOT_SETTLED_CIRCULATION,) * 3)
        self.assertEqual((reads, w.requests().count('GET /pilot/v1/info')), (1, 2))     # known after the first read
        # circulation off: the legacy label, and no request more than 0.3 makes (decision D-2 h)
        w = World(None, welcome=False)
        did = w.delivered_deal(payee=M_ID)
        with routed(w):
            text = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).prepare(
                'valun_review_delivery', {'deal_id': did, 'decision': 'accept'})['text'].split('\n')
        self.assertEqual(text[-2], va.NOT_SETTLED)
        self.assertEqual(w.requests(), [f'GET /pilot/v1/deals/{did}'])


class Consents(Base):
    def consent_reads(self):
        return [r for r in self.world.requests() if r == 'GET /pilot/v1/consents']

    def test_they_run_before_tools_that_are_not_read_only_at_most_once_a_minute(self):
        clock = [now_ms()]
        with mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            for name, args in (('valun_status', {}), ('valun_inbox', {}), ('valun_directory', {}), ('valun_deal', {'deal_id': 'vd_x'})):
                self.agent.call_safe(name, args)
            self.assertEqual(self.consent_reads(), [])                        # never from read-only tools
            self.agent.call_safe('valun_set_limits', {'goals': 'buy briefs'})
            self.assertEqual(len(self.consent_reads()), 1)
            self.assertEqual(self.store.state['consents_last_run_ms'], clock[0])
            self.agent.call_safe('valun_set_limits', {'goals': 'buy briefs'})
            self.assertEqual(len(self.consent_reads()), 1)                    # 60 s have not passed
            clock[0] += va.CONSENTS_EVERY_MS
            self.agent.call_safe('valun_set_limits', {'goals': 'buy briefs'})
            self.assertEqual(len(self.consent_reads()), 2)

    def test_a_set_off_is_signed_before_the_tool_runs(self):
        self.world.welcome = False
        self.world.set_edge(X_ID, S_ID, 1, now_ms() - 120_000 + 1)
        self.world.set_edge(S_ID, X_ID, 2, now_ms() - 110_000 + 2, signature=sign_note(S, X['pubkey'], 2, now_ms() - 110_000 + 2))
        self.world.clear()
        self.agent.call_safe('valun_set_limits', {'goals': 'clear'})
        self.assertEqual((self.world.total(X_ID, S_ID), self.world.total(S_ID, X_ID)), (0, 1))
        self.assertEqual(self.store.state['consent_log'][-1]['decision'], 'signed')

    def test_a_profile_without_a_consent_policy_is_served_as_by_0_3(self):
        self.store.state.pop('consent_policy')
        self.agent.call_safe('valun_set_limits', {'goals': 'x'})
        self.assertFalse([r for r in self.world.requests() if r in ('GET /pilot/v1/consents', 'GET /pilot/v1/info')])
        self.assertNotIn('consents_last_run_ms', self.store.state)

    def test_a_failing_run_never_stops_the_tool_and_counts_as_a_run(self):
        self.world.fail['GET /pilot/v1/consents'] = [vc.ValunError('http_error', 'down', 503)]
        r = self.agent.call_safe('valun_set_limits', {'goals': 'x'})
        self.assertNotIn('error', r)
        self.assertIn('consents_last_run_ms', self.store.state)

    def test_an_agent_with_process_consents_off_never_processes_them(self):   # decision D-2 g (the Hermes plugin's switch)
        agent = va.ValunAgent(self.store, check_link_hosts=False, process_consents=False)
        self.assertIsNone(agent.consents_if_due())
        agent.call_safe('valun_set_limits', {'goals': 'buy briefs'})
        self.assertEqual(self.consent_reads(), [])
        self.assertNotIn('consents_last_run_ms', self.store.state)
        self.assertTrue(va.ValunAgent(self.store).process_consents)                     # on by default (CLI, MCP)


class ConsentsOnReads(Base):
    """FX3-PY, decision D-3 a: ValunAgent(consents_on_reads=True), for adapters without a background consent loop (the
    Hermes plugin, `valun call`). Before valun_status and valun_inbox its client signs the value-safe consents (set-offs;
    payments to it by transfer as the standing policy allows) at most once a minute, and the result says what it signed
    (consents_signed_now). A consent in the issuer or payer role is never signed or refused from a read."""

    def setUp(self):
        super().setUp()
        self.world.welcome = False
        self.agent = va.ValunAgent(self.store, check_link_hosts=False, consents_on_reads=True)

    def cycle(self):
        """S owes X 2 PC and holds 1 PC of X's notes: the World proposes S a set-off of 1 PC (S signs as member)."""
        self.world.set_edge(X_ID, S_ID, 1, now_ms() - 120_000 + 1)
        self.world.set_edge(S_ID, X_ID, 2, now_ms() - 110_000 + 2, signature=sign_note(S, X['pubkey'], 2, now_ms() - 110_000 + 2))
        self.world.clear()
        (sid,) = [i for i, it in self.world.items.items() if it['state'] == 'collecting']
        return sid

    def issuer_item(self):
        """A consent in S's issuer role (a transfer of S's own debt). It moves no edge, so a full run refuses it at once:
        what matters here is only whether a run touches it."""
        tid = 'vt_' + 'e' * 16
        self.world.items[tid] = {'kind': 'transfer', 'id': tid, 'state': 'collecting', 'your_roles': ['issuer'],
                                 'created_at': iso(now_ms()), 'expires_at': iso(now_ms() + 1_200_000), 'network': vc.NETWORK,
                                 'tracker_nft_id': NFT, 'denomination': DENOM, 'edges': [], 'context': {'amount': 1},
                                 'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': 0}}
        return tid

    def consent_reads(self):
        return self.world.requests().count('GET /pilot/v1/consents')

    def test_valun_status_signs_a_set_off_first_and_says_so(self):
        sid = self.cycle()
        r = self.agent.call('valun_status')
        self.assertEqual([(e['id'], e['kind'], e['role'], e['your_net_change_PC']) for e in r['consents_signed_now']],
                         [(sid, 'setoff', 'member', 0)])
        self.assertEqual(list(r['consents_signed_now'][0]), list(va.SIGNED_NOW_KEYS))
        self.assertEqual((self.world.total(X_ID, S_ID), self.world.total(S_ID, X_ID)), (0, 1))
        self.assertEqual((r['money_view']['you_hold_PC'], r['money_view']['you_owe_PC']), (0, 1))   # read after it
        self.assertEqual(self.store.state['consent_log'][-1]['decision'], 'signed')
        self.assertIn('consents_last_safe_run_ms', self.store.state)
        self.assertNotIn('consents_last_run_ms', self.store.state)

    def test_an_issuers_consent_is_never_signed_or_refused_from_a_read(self):
        sid, tid = self.cycle(), self.issuer_item()
        for name in ('valun_status', 'valun_inbox', 'valun_directory'):
            self.assertNotIn('error', self.agent.call_safe(name, {}), name)
        self.assertEqual([r for r in self.world.requests() if tid in r], [])        # not posted, not refused
        self.assertEqual((self.world.items[tid]['state'], self.world.items[sid]['state']), ('collecting', 'applied'))
        self.assertNotIn(tid, json.dumps(self.store.state.get('consent_log')))
        self.agent.call_safe('valun_set_limits', {'goals': 'x'})                      # not read-only: a full run
        self.assertEqual([r for r in self.world.requests() if tid in r], [f'POST /pilot/v1/consents/{tid}/refuse'])

    def test_reads_run_at_most_once_a_minute_and_never_delay_a_full_run(self):
        clock = [now_ms()]
        with mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            r = self.agent.call('valun_status')
            self.assertEqual((self.consent_reads(), r['consents_signed_now']), (1, []))
            r = self.agent.call('valun_inbox')
            self.assertEqual(self.consent_reads(), 1)
            self.assertNotIn('consents_signed_now', r)                      # no run in this call
            self.agent.call_safe('valun_set_limits', {'goals': 'x'})
            self.assertEqual(self.consent_reads(), 2)                        # a full run, although a read's ran just now
            r = self.agent.call('valun_status')
            self.assertEqual(self.consent_reads(), 2)                        # a full run counts for reads too
            self.assertNotIn('consents_signed_now', r)
            clock[0] += va.CONSENTS_EVERY_MS
            r = self.agent.call('valun_inbox')
            self.assertEqual((self.consent_reads(), r['consents_signed_now']), (3, []))
            clock[0] += va.CONSENTS_EVERY_MS
            self.agent.call_safe('valun_directory', {})
            self.agent.call_safe('valun_deal', {'deal_id': 'vd_' + '0' * 16})
            self.assertEqual(self.consent_reads(), 3)                        # only before valun_status and valun_inbox

    def test_a_full_run_counts_for_reads_too(self):
        # A run before a tool call that is not read-only handled every role: a read within the next minute runs none.
        clock = [now_ms()]
        with mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            self.agent.call_safe('valun_set_limits', {'goals': 'x'})
            self.assertEqual(self.consent_reads(), 1)
            self.assertNotIn('consents_last_safe_run_ms', self.store.state)
            self.assertNotIn('consents_signed_now', self.agent.call('valun_status'))
            self.assertEqual(self.consent_reads(), 1)
            clock[0] += va.CONSENTS_EVERY_MS
            r = self.agent.call('valun_status')
            self.assertEqual((self.consent_reads(), r['consents_signed_now']), (2, []))

    def test_a_read_run_that_failed_never_delays_a_full_run(self):
        # The read's run fails (GET /consents gets a 429): the read is answered as without it, the failure counts as a
        # read run only (consents_last_safe_run_ms), and the next tool call that is not read-only makes the full run at once.
        clock = [now_ms()]
        self.world.fail['GET /pilot/v1/consents'] = [vc.ValunError('rate_limited', 'too many requests; slow down', 429)]
        with mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            r = self.agent.call('valun_status')
            self.assertNotIn('consents_signed_now', r)
            self.assertEqual(self.consent_reads(), 1)
            self.assertEqual(self.store.state.get('consents_last_safe_run_ms'), clock[0])
            self.assertNotIn('consents_last_run_ms', self.store.state)
            clock[0] += 1000
            self.agent.call('valun_inbox')                                   # a read within the minute: no run
            self.assertEqual(self.consent_reads(), 1)
            self.agent.call_safe('valun_set_limits', {'goals': 'x'})
            self.assertEqual(self.consent_reads(), 2)                        # the full run, at once
            self.assertEqual(self.store.state.get('consents_last_run_ms'), clock[0])

    def test_only_with_the_option_process_consents_and_a_value_safe_role(self):
        self.cycle()
        for agent in (va.ValunAgent(self.store, check_link_hosts=False),                                  # off by default
                      va.ValunAgent(self.store, check_link_hosts=False, process_consents=False, consents_on_reads=True)):
            for name in ('valun_status', 'valun_inbox'):
                self.assertNotIn('consents_signed_now', agent.call(name))
        self.store.state['consent_policy'] = dict(va.SANDBOX_CONSENT_POLICY, setoff=False, as_new_creditor=False)
        self.assertNotIn('consents_signed_now', self.agent.call('valun_status'))     # only as_issuer: nothing value-safe
        self.assertEqual(self.consent_reads(), 0)
        self.assertFalse(va.ValunAgent(self.store).consents_on_reads)

    def test_without_circulation_the_results_are_as_without_the_option(self):
        # Decision D-2 h: the first run reads GET /info, finds no circulation/1, and no consent is asked for after it;
        # nor, once a run is due again (a minute later, and after), is GET /info read or the profile written for one: a
        # long-lived adapter makes exactly the requests and writes it makes without the option.
        w = World(None, welcome=False)
        clock = [now_ms()]
        with routed(w), mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            plain, safe = (va.ValunAgent(MemStore(profile_state()), check_link_hosts=False, consents_on_reads=on)
                           for on in (False, True))
            for name in ('valun_status', 'valun_inbox', 'valun_status'):
                self.assertEqual(safe.call(name), plain.call(name), name)
            writes = {}
            for agent in (plain, safe):
                agent.store.save = lambda key=id(agent): writes.__setitem__(key, writes.get(key, 0) + 1)
            for _ in range(3):
                clock[0] += va.CONSENTS_EVERY_MS + 1
                for name in ('valun_status', 'valun_inbox'):
                    n = len(w.log)
                    a = plain.call(name)
                    asked_plain, n = w.requests()[n:], len(w.log)
                    self.assertEqual(safe.call(name), a, name)
                    self.assertEqual(w.requests()[n:], asked_plain, name)
            self.assertEqual(writes.get(id(safe), 0), writes.get(id(plain), 0))
        self.assertEqual([r for r in w.requests() if 'consents' in r or 'edges' in r], [])

    def test_process_consents_off_declares_no_roles(self):                          # decision D-3 b
        self.assertTrue(self.agent.client().declare_roles)
        self.assertFalse(va.ValunAgent(self.store, process_consents=False).client().declare_roles)
        # An adapter that signs consents by itself with the hook off (the sandbox tour) declares them all the same.
        self.assertTrue(va.ValunAgent(self.store, process_consents=False, declare_roles=True).client().declare_roles)
        self.assertFalse(va.ValunAgent(self.store, declare_roles=False).client().declare_roles)


class CirculationOffWire(unittest.TestCase):
    """Decision D-2 h: with circulation off, the 0.4 agent makes no request more than 0.3 once it knows the features."""

    def test_a_04_profile_against_a_v15_server(self):
        w = World(None, welcome=False)
        did = w.delivered_deal(payee=M_ID)
        clock = [now_ms()]
        with routed(w), mock.patch.object(vc, 'time', types.SimpleNamespace(time=lambda: clock[0] / 1000)):
            a = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False)      # has a consent policy (0.4 join)
            a.call_safe('valun_set_limits', {'goals': 'one'})       # its first consent run reads /info once ...
            clock[0] += 2 * va.CONSENTS_EVERY_MS
            a.call_safe('valun_set_limits', {'goals': 'two'})       # ... and then knows: no more consent runs
            a.call('valun_deal', {'deal_id': did})                   # no /info for a payer deal either
        self.assertEqual(w.requests().count('GET /pilot/v1/info'), 1)
        self.assertNotIn('GET /pilot/v1/consents', w.requests())
        self.assertEqual(w.requests()[-1:], [f'GET /pilot/v1/deals/{did}'])
        # a fresh agent: valun_deal reads nothing more than the deal (the view has no payment key: circulation off)
        with routed(w):
            w.log.clear()
            d = va.ValunAgent(MemStore(profile_state()), check_link_hosts=False).call('valun_deal', {'deal_id': did})
        self.assertEqual((w.requests(), 'how_you_can_pay' in d), ([f'GET /pilot/v1/deals/{did}'], False))


class SandboxNextSteps(Base):
    def steps(self):
        return self.agent.call('valun_status', {})['sandbox_next_steps']

    def test_the_welcome_job_then_its_delivery(self):
        n = self.steps()
        self.assertEqual((n['tour_step'], [c['tool'] for c in n['next_calls']]), (1, ['valun_respond']))
        self.assertEqual(n['next_calls'][0]['arguments'], {'deal_id': self.world.order[0], 'action': 'accept'})
        self.assertEqual(n['when_done'], {'you_hold_PC': 3, 'you_owe_PC': 0})
        did = self.world.order[0]
        self.world.agree(did, sign_text(S, vc.statement('accept', self.world.deals[did]['current']['terms_hash'])))
        n = self.steps()
        self.assertEqual(n['next_calls'], [{'tool': 'valun_deliver', 'arguments': {'deal_id': did, 'exact_result': True},
                                            'why': 'deliver the exact result your Valun client computes from the agreed text'}])

    def test_a_wrong_delivery_is_disputed_and_a_right_one_paid_with_the_note_held(self):
        self.world.welcome = False
        self.hold(X_ID, 3)
        wrong = self.world.delivered_deal(payee=M_ID, wrong=True)
        n = self.steps()
        self.assertEqual((n['tour_step'], n['next_calls'][0]['arguments']['decision']), (2, 'dispute'))
        self.assertIn('differs in: bytes', n['next_calls'][0]['arguments']['reason'])
        self.world.deals[wrong]['status'] = 'disputed'
        n = self.steps()
        self.assertEqual((n['tour_step'], n['next_calls'][0]['tool'], n['next_calls'][0]['arguments']['counterparty']),
                         (2, 'valun_propose', 'sandbox-mallory'))
        right = self.world.delivered_deal(payee=M_ID)
        args = self.steps()['next_calls'][0]['arguments']
        self.assertEqual(args, {'deal_id': right, 'decision': 'accept', 'pay_with': 'sandbox-exact',
                                'expected_deliverable_sha256': self.world.deals[right]['delivery']['sha256']})

    def test_one_deal_that_cannot_be_read_gives_a_wait_plan(self):
        self.world.welcome = False
        self.hold(X_ID, 3)
        did = self.world.delivered_deal(payee=M_ID)
        self.world.fail[f'GET /pilot/v1/deals/{did}'] = [vc.ValunError('http_error', 'down', 503)]
        st = self.agent.call('valun_status', {})               # does not fail
        n = st['sandbox_next_steps']
        self.assertEqual((n['tour_step'], n['next_calls']), (2, []))
        self.assertIn(f'Deal {did} could not be read just now (http_error)', n['then'])
        self.assertEqual(self.steps()['next_calls'][0]['tool'], 'valun_review_delivery')   # the next status decides

    def test_an_approval_waiting_for_the_owner_is_waited_for(self):
        inbox = self.world.inbox
        self.world.inbox = lambda: dict(inbox(), awaiting_your_owner=[{'approval_id': 'va_0123456789abcdef', 'deal_id': 'vd_1',
                                                                       'kind': 'pay_by_transfer'}])
        n = self.steps()
        self.assertEqual((n['tour_step'], n['next_calls']), (None, []))
        self.assertIn('owner console', n['then'])

    def test_holdings_decide_the_next_deal_and_a_cycle_is_waited_for(self):
        self.world.welcome = False
        self.hold(M_ID, 2)
        n = self.steps()
        self.assertEqual((n['tour_step'], n['next_calls'][0]['arguments']['counterparty'], n['next_calls'][0]['arguments']['role']),
                         (5, 'sandbox-exact', 'payer'))
        self.world.set_edge(S_ID, X_ID, 1, now_ms() - 30_000, signature=sign_note(S, X['pubkey'], 1, now_ms() - 30_000))
        n = self.steps()
        self.assertEqual((n['tour_step'], n['next_calls']), (4, []))
        self.assertIn('set-off', n['then'])


class PhaseZeroFixes(unittest.TestCase):
    def test_resolve_takes_an_exact_id_before_a_handle(self):
        class C:
            def directory(self):
                return [{'id': O_ID, 'handle': X_ID}, {'id': X_ID, 'handle': 'sandbox-exact'}]
        a = va.ValunAgent(store=None)
        self.assertEqual(a._resolve(C(), X_ID)['id'], X_ID)
        self.assertEqual(a._resolve(C(), 'sandbox-exact')['id'], X_ID)
        with self.assertRaises(vc.ValunError):
            a._resolve(C(), 'nobody')

    def test_prepare_or_refusal_keeps_setup_refusals(self):
        args = {'deal_id': 'vd_0123456789abcdef', 'decision': 'accept'}
        p, refusal = va.ValunAgent(MemStore({}, secret=None, token=None)).prepare_or_refusal('valun_review_delivery', args)
        self.assertEqual((p, refusal['error']), (None, 'not_connected'))
        self.assertIn('not connected to Valun', refusal['what_this_means'])
        state = profile_state()
        state.pop('server')
        p, refusal = va.ValunAgent(MemStore(state)).prepare_or_refusal('valun_review_delivery', args)
        self.assertEqual(refusal['error'], 'not_configured')
        w = World(list(CIRC), welcome=False)
        did = w.delivered_deal(payee=M_ID)
        state = profile_state(pins={'tracker_nft_id': '22' * 32, 'denomination': DENOM})
        with routed(w):
            p, refusal = va.ValunAgent(MemStore(state)).prepare_or_refusal(
                'valun_review_delivery', {'deal_id': did, 'decision': 'accept', 'pay_with': 'sandbox-exact'})
        self.assertEqual(refusal['error'], 'tracker_mismatch')
        self.assertIn('different Basis tracker', refusal['what_this_means'])

    def test_ask_owner_needs_the_prepared_text(self):
        out = io.BytesIO()
        s = mcp_server.McpServer(va.ValunAgent(store=None), 'ask', inp=io.BytesIO(b''), out=out, log=io.StringIO())
        s.initialize({'protocolVersion': '2025-11-25', 'capabilities': {'elicitation': {}}})
        for text in (None, ''):
            r = s.ask_owner('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'}, text)
            self.assertEqual(r['error'], 'approval_unbound')
        with self.assertRaises(TypeError):
            s.ask_owner('valun_review_delivery', {'deal_id': 'vd_1', 'decision': 'accept'})   # text is required
        self.assertEqual(out.getvalue(), b'')


if __name__ == '__main__':
    unittest.main()
