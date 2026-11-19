"""Fix inbox #86: `valun audit --mine` after the outside tester's happy path (Basis, Nov 15 2026, build 89832cc, valun
0.7.1), offline. Seen there: MATCH on the published notes, then exit 3, "0 of 3 edges proven": the welcome note `valun
sandbox earn` was paid with was not in the client's records (not_in_records), and neither was the state the set-off it
signed gave its two edges (differs: anchored 0, your records 2000000; not_in_records).

The path, as Basis ran it: a fresh agent A runs `valun sandbox earn` (sandbox-exact's welcome job, paid with its note of
3,000,000 nanoERG); two more fresh agents B and C; three deals of 2,000,000 form the loop A -> B -> C -> A (each payee
delivers, each payer accepts the delivery with its credit note); `valun clearing run` in each profile signs the set-off
of that cycle (Client.process_consents, as the command runs it); the tracker box then commits the tracker's state; and
`valun audit --explorer ... --mine` in each profile. Expected: every edge proven, exit 0: the welcome note signed by
sandbox-exact, and each netted edge "netted by vs_..., signed by you" (status netted), or, for the edge the last signer
issues, its confirmed state with the signature it made (signed, netted_by). Both orders of signing are run.

The fakes: Net, a testnet server with bound notes and circulating credit (tracker v3.2, INFO_NOVATION of
test_agent_circulation.py) for several clients at once, with sandbox-exact and a clearing engine; and, once the box
commits, the audit's own World of test_audit.py (its chain, explorer and the server's public reads) holding the tracker's
state. Throwaway keys; no network."""
import contextlib
import copy
import hashlib
import io
import itertools
import json
import os
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from valun import agent as va  # noqa: E402
from valun import audit as vaudit  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import records  # noqa: E402
from valun import sandbox as sb  # noqa: E402
from valun import schemas  # noqa: E402
import test_audit as ta  # noqa: E402
from test_agent_circulation import INFO_NOVATION, MemStore, iso, key, next_ts, now_ms, sign_text, signed_by  # noqa: E402

SERVER, NFT, DENOM, TESTNET = ta.SERVER, ta.NFT, 'erg', schemas.TESTNET
X_ID, A_ID, B_ID, C_ID = 'vp_e1e1e1e1e1e1', 'vp_a0a0a0a0a0a0', 'vp_b1b1b1b1b1b1', 'vp_c1c1c1c1c1c1'
X, A, B, C = (key(f'test/86/{n}') for n in ('sandbox-exact', 'a', 'b', 'c'))
HANDLES = {X_ID: va.SANDBOX_EXACT, A_ID: 'basis-a', B_ID: 'basis-b', C_ID: 'basis-c'}
ID = {'a': A_ID, 'b': B_ID, 'c': C_ID}
WELCOME_PRICE, LOOP_PRICE = 3_000_000, 2_000_000
WELCOME = 'Welcome to the Valun sandbox. This text is your first paid job.'
# The owner mandate of a sandbox participant on the testnet (amounts in nanoERG): set-offs on (auto_clear), as `valun join`
# sets it; the fake enforces none of its limits.
MANDATE = {'objective': 'Self-serve sandbox', 'may_issue_credit': True, 'may_accept_credit': True, 'max_issue_per_deal': 5_000_000,
           'max_issue_outstanding': 40_000_000, 'max_accept_per_deal': 5_000_000, 'max_accept_per_issuer': 40_000_000,
           'min_price_as_payee': 0, 'min_payer_coverage_pct': 0, 'counterparties': [X_ID, A_ID, B_ID, C_ID],
           'approve_above': 1_000_000_000, 'review_deliveries': False, 'expires_at': None, 'auto_clear': True, 'novate_own_debt': True,
           'accept_transfers': True, 'accept_notes_from': [], 'refuse_notes_from': [], 'pay_with_held_notes': 'when_asked'}


def msg(i, r, total, ts):
    return vb.note_message(bytes.fromhex(i), bytes.fromhex(r), total, ts, bytes.fromhex(NFT), DENOM)


def pa(i, r, prior_total, prior_ts, ts):
    return vb.prior_ack_message(bytes.fromhex(i), bytes.fromhex(r), prior_total, prior_ts, ts, bytes.fromhex(NFT), DENOM)


def sign_note(k, recipient_pk, total, ts):
    return vb.sign(msg(k['pubkey'], recipient_pk, total, ts), k['secret'], bytes.fromhex(k['pubkey'])).hex()


class Net:
    """A fake Valun testnet server (bound_notes/1 and circulation/1, tracker v3.2) and its tracker, for several clients at
    once: each request is answered as the participant whose profile sends it. sandbox-exact (X) has offered A its welcome
    job (text-stats), and pays a delivery it checked exactly with its own bound note at once. The clearing engine proposes
    a cycle of the clients' edges as one set-off to all its members, and applies it once every member signed the new
    state of each of its edges: each edge then holds its issuer's signature, as on the tracker. What the real server does
    a few hundred ms later happens here at once (tick, after each request that is not a read, and after GET /me and
    /inbox). Every request is logged."""

    def __init__(self):
        self.keys = {X_ID: X, A_ID: A, B_ID: B, C_ID: C}
        self.tracker, self.journal, self.seq, self.counter = {}, [], 0, 0
        self.deals, self.order, self.setoffs, self.log = {}, [], {}, []
        self.edges_fail = False                  # GET /edges answers 503 (a server that cannot show the edges now)
        t = self.terms(X_ID, A_ID, X_ID, 'Welcome job: text-stats',
                       f'Your first paid job: text-stats of this text:\n```\n{WELCOME}\n```',
                       'the exact text-stats result as JSON (your Valun client can compute it)', WELCOME_PRICE)
        self.add_deal(t, sign_text(X, vc.statement('propose', vc.terms_hash(t))))

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

    def last_ts(self, i, r):
        st = self.tracker.get(self.edge(i, r))
        return st['timestamp'] if st else 0

    def set_edge(self, i, r, total, ts, kind, ref, signature=None):
        e, before = self.edge(i, r), self.total(i, r)
        sig = signature or sign_note(self.keys[i], self.pk(r), total, ts)
        self.tracker[e] = {'total': total, 'timestamp': ts, 'signature': sig}
        self.seq += 1
        self.journal.append({'seq': self.seq, 'at': iso(now_ms()), 'kind': kind, 'ref': ref, 'edge': e, 'issuer_pubkey': self.pk(i),
                             'recipient_pubkey': self.pk(r), 'delta': total - before, 'total_after': total, 'timestamp': ts,
                             'signature': sig})

    def new_id(self, prefix):
        self.counter += 1
        return prefix + hashlib.sha256(f'{prefix}{self.counter}'.encode()).hexdigest()[:16]

    def public(self, pid):
        return {'id': pid, 'handle': HANDLES[pid], 'display_name': HANDLES[pid], 'operator': 'test', 'about': '',
                'services': sb.SERVICES_TEXT if pid == X_ID else '', 'pubkey': self.pk(pid), 'status': 'active',
                'joined_at': iso(now_ms()), 'agent_last_seen': iso(now_ms())}

    # ---------- deals ----------
    def terms(self, payer, payee, proposer, title, description, deliverable, price):
        n = now_ms()
        return {'protocol': vc.PROTOCOL, 'network': TESTNET, 'tracker_nft_id': NFT, 'denomination': DENOM,
                'deal_id': self.new_id('vd_'), 'version': 1, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': proposer,
                'payer': {'id': payer, 'pubkey': self.pk(payer)}, 'payee': {'id': payee, 'pubkey': self.pk(payee)},
                'service': {'title': title, 'description': description, 'deliverable': deliverable},
                'price': {'amount': price, 'unit': 'nanoERG'}, 'consideration': 'credit_note_on_delivery_accepted',
                'deliver_by': iso(n + 48 * 3600000), 'offer_expires_at': iso(n + 24 * 3600000)}

    def add_deal(self, t, signature):
        did, h = t['deal_id'], vc.terms_hash(t)
        self.deals[did] = {'id': did, 'payer': t['payer']['id'], 'payee': t['payee']['id'], 'status': 'open',
                           'current': {'version': 1, 'by': t['proposer'], 'state': 'open', 'terms': t, 'terms_hash': h,
                                       'signature': signature},
                           'agreement': None, 'delivery': None, 'credit_note': None}
        self.order.append(did)
        return did

    def view(self, did, me):
        d = self.deals[did]
        role = 'payer' if d['payer'] == me else 'payee'
        other = d['payee'] if role == 'payer' else d['payer']
        cur = d['current']
        return {'id': did, 'status': d['status'], 'you': me, 'your_role': role, 'counterparty': self.public(other), 'next_actions': [],
                'current': copy.deepcopy(cur), 'versions': [{'version': 1, 'by': cur['by'], 'state': cur['state'],
                                                             'terms_hash': cur['terms_hash'], 'price': cur['terms']['price'],
                                                             'signature': cur['signature']}],
                'acceptance': None, 'agreement': copy.deepcopy(d['agreement']), 'decline': None, 'delivery': copy.deepcopy(d['delivery']),
                'completion': None, 'dispute': None, 'credit_note': copy.deepcopy(d['credit_note']), 'cancellation': None,
                'approvals': [], 'history': [], 'labels': {}, 'payment': None}

    def inbox(self, me):
        box = {k: [] for k in ('respond', 'deliver', 'review_delivery', 'awaiting_your_owner', 'waiting_on_others', 'recent_closed')}
        for did in self.order:
            d = self.deals[did]
            if me not in (d['payer'], d['payee']) or d['status'] != 'open' or d['current']['by'] == me:
                continue
            t = d['current']['terms']
            box['respond'].append({'deal_id': did, 'status': 'open', 'your_role': 'payer' if d['payer'] == me else 'payee',
                                   'counterparty': HANDLES[d['current']['by']], 'title': t['service']['title'], 'price': t['price'],
                                   'version': 1, 'offer_expires_at': t['offer_expires_at'], 'deliver_by': t['deliver_by']})
        box['consents_waiting_for_your_client'] = len(self.consents(me)['consents'])
        box['payments_in_progress'] = []
        return box

    def note_template(self, did, me):
        d = self.deals[did]
        payee, price = d['payee'], d['current']['terms']['price']['amount']
        cur = self.tracker.get(self.edge(me, payee))
        P = cur['total'] if cur else 0
        return {'deal_id': did, 'terms_hash': d['agreement']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
                'issuer_pubkey': self.pk(me), 'recipient_pubkey': self.pk(payee), 'keys_as_agreed': True, 'prior_total': P,
                'price': price, 'total': P + price, 'timestamp': next_ts(now_ms(), 997, cur['timestamp'] if cur else 0),
                'tracker_nft_id': NFT, 'denomination': DENOM, 'message_hex': '00', 'prior_note': dict(cur) if cur else None,
                'prior_message_hex': '00'}

    def complete(self, did, me, body):
        d = self.deals[did]
        payee, mk = d['payee'], self.pk(me)
        h, dh = d['agreement']['terms_hash'], d['delivery']['sha256']
        if not signed_by(mk, vc.statement('complete', h, dh).encode(), body['signature']):
            raise vc.ValunError('bad_signature', 'the completion statement does not verify', 403)
        n, cur = body['credit_note'], self.tracker.get(self.edge(me, payee))
        P, p = (cur['total'], cur['timestamp']) if cur else (0, 0)
        if n['total'] != P + d['current']['terms']['price']['amount'] or not signed_by(mk, msg(mk, self.pk(payee), n['total'], n['timestamp']), n['signature']) \
                or n.get('prior_timestamp') != p or not signed_by(mk, pa(mk, self.pk(payee), P, p, n['timestamp']), n.get('prior_signature')):
            raise vc.ValunError('stale_note', 'the bound note is not the prior plus the price', 409)
        self.paid(did, n['total'], n['timestamp'], n['signature'])
        return self.view(did, me)

    def paid(self, did, total, ts, signature=None):
        """The deal's payer's note on the tracker (its signature, or sandbox-exact's own), and the deal note_issued."""
        d = self.deals[did]
        self.set_edge(d['payer'], d['payee'], total, ts, 'issue', did, signature)
        st = self.tracker[self.edge(d['payer'], d['payee'])]
        d['status'] = 'note_issued'
        d['credit_note'] = {'state': 'recorded', 'amount': d['current']['terms']['price']['amount'], 'note': dict(st),
                            'tracker_note': {'amount_collected': st['total'], 'timestamp': ts, 'signature': st['signature'],
                                             'confirmation': 'confirmed'}}

    # ---------- sandbox-exact and the clearing engine ----------
    def tick(self):
        for did in list(self.order):
            d = self.deals[did]
            if d['payer'] == X_ID and d['status'] == 'delivered':
                text = sb.extract_text(d['current']['terms']['service']['description'])
                if sb.parse_result(d['delivery']['content']) == sb.COMPUTE['text-stats'](text):
                    self.paid(did, self.total(X_ID, d['payee']) + WELCOME_PRICE, next_ts(now_ms(), 997, self.last_ts(X_ID, d['payee'])))
                else:
                    d['status'] = 'disputed'
        if any(s['state'] == 'collecting' for s in self.setoffs.values()):
            return
        for a, b, c in itertools.permutations((A_ID, B_ID, C_ID)):
            cycle = [(a, b), (b, c), (c, a)]
            if all(self.total(i, r) > 0 for i, r in cycle):
                sid = self.new_id('vs_')
                self.setoffs[sid] = {'cycle': cycle, 'd': min(self.total(i, r) for i, r in cycle), 'state': 'collecting',
                                     'ts': {(i, r): next_ts(now_ms(), 998, self.last_ts(i, r)) for i, r in cycle},
                                     'before': {(i, r): dict(self.tracker[self.edge(i, r)]) for i, r in cycle}, 'sigs': {},
                                     'created': now_ms()}
                return

    def item(self, sid, me):
        s = self.setoffs[sid]
        edges = []
        for i, r in s['cycle']:
            if me not in (i, r):
                continue
            e, before = self.edge(i, r), s['before'][(i, r)]
            edges.append({'edge': e, 'issuer': {'id': i, 'handle': HANDLES[i]}, 'recipient': {'id': r, 'handle': HANDLES[r]},
                          'your_role': 'issuer' if i == me else 'creditor', 'before': dict(before), 'change': -s['d'],
                          'new_total': before['total'] - s['d'], 'timestamp': s['ts'][(i, r)], 'revision': 1, 'slots': ['new'],
                          'signed_by_you': ['new'] if f'{e}:new' in s['sigs'].get(me, {}) else []})
        return {'kind': 'setoff', 'id': sid, 'state': s['state'], 'your_roles': ['member'], 'created_at': iso(s['created']),
                'expires_at': iso(s['created'] + 1800000), 'network': TESTNET, 'tracker_nft_id': NFT, 'denomination': DENOM,
                'edges': edges, 'context': {}, 'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': -s['d']}}

    def consents(self, me):
        return {'consents': [self.item(sid, me) for sid, s in self.setoffs.items()
                             if s['state'] == 'collecting' and any(me in ij for ij in s['cycle'])], 'recently_resolved': []}

    def consent(self, sid, me, body):
        s = self.setoffs[sid]
        mine = {e['edge']: e for e in self.item(sid, me)['edges']}
        for slot, sig in body['signatures'].items():
            e = mine[slot.rsplit(':', 1)[0]]
            i, r = e['edge'].split('>')
            if not signed_by(self.pk(me), msg(i, r, e['new_total'], e['timestamp']), sig):
                raise vc.ValunError('bad_signature', f'{slot} does not verify', 403)
            s['sigs'].setdefault(me, {})[slot] = sig
        members = {p for ij in s['cycle'] for p in ij}
        if all(f'{self.edge(i, r)}:new' in s['sigs'].get(m, {}) for m in members for i, r in s['cycle'] if m in (i, r)):
            for i, r in s['cycle']:                 # every member signed: the tracker holds each new state, issuer-signed
                self.set_edge(i, r, s['before'][(i, r)]['total'] - s['d'], s['ts'][(i, r)], 'setoff', sid,
                              signature=s['sigs'][i][f'{self.edge(i, r)}:new'])
            s['state'] = 'applied'
        return dict(self.item(sid, me), rejected=[])

    def edges(self, me, since):
        mk = self.pk(me)
        rows = [{'edge': e, 'issuer': {'id': self.pid_of(e.split('>')[0])}, 'recipient': {'id': self.pid_of(e.split('>')[1])},
                 'issuer_pubkey': e.split('>')[0], 'recipient_pubkey': e.split('>')[1], 'total': st['total'], 'timestamp': st['timestamp'],
                 'signature': st['signature'], 'exact': True, 'bound_only': False, 'reserved': 0, 'frozen': False}
                for e, st in self.tracker.items() if mk in e.split('>')]
        journal = [j for j in self.journal if j['seq'] > since and mk in (j['issuer_pubkey'], j['recipient_pubkey'])]
        return {'incoming': [x for x in rows if x['recipient_pubkey'] == mk], 'outgoing': [x for x in rows if x['issuer_pubkey'] == mk],
                'journal': copy.deepcopy(journal[:200]), 'next_seq': self.seq}

    # ---------- the HTTP surface ----------
    def handle(self, me, method, path, body=None):
        self.log.append((me, method, path))
        route, _, query = path.partition('?')
        out = copy.deepcopy(self.route(me, method, [urllib.parse.unquote(x) for x in route.split('/')[3:]],
                                       dict(urllib.parse.parse_qsl(query)), body))
        if method != 'GET' or route in ('/pilot/v1/inbox', '/pilot/v1/me'):
            self.tick()
        return out

    def route(self, me, method, parts, q, body):
        if method == 'GET' and parts == ['info']:
            return {'network': TESTNET, 'protocol': vc.PROTOCOL, 'unit': 'nanoERG', 'tracker_nft_id': NFT, 'denomination': DENOM,
                    'features': ['bound_notes/1', 'circulation/1'], 'novation': copy.deepcopy(INFO_NOVATION)}
        if method == 'GET' and parts == ['participants']:
            return [self.public(p) for p in self.keys]
        if method == 'GET' and len(parts) == 2 and parts[0] == 'participants' and parts[1] in self.keys:
            return dict(self.public(parts[1]), public_position={})
        if method == 'GET' and parts == ['me']:
            return {'role': 'agent', 'participant': self.public(me), 'mandate': dict(MANDATE), 'mandate_version': 1,
                    'effective_limits': dict(MANDATE), 'agent_limits': {}, 'position': {'claims_held': 0, 'owes': 0}, 'authority': {}}
        if method == 'GET' and parts == ['inbox']:
            return self.inbox(me)
        if method == 'POST' and parts == ['deals']:
            t, h = body['terms'], body['terms_hash']
            if vc.terms_hash(t) != h or not signed_by(self.pk(me), vc.statement('propose', h).encode(), body['signature']):
                raise vc.ValunError('bad_signature', 'the proposal does not verify', 403)
            return self.view(self.add_deal(t, body['signature']), me)
        if len(parts) >= 2 and parts[0] == 'deals' and parts[1] in self.deals:
            did, rest, d = parts[1], parts[2:], self.deals[parts[1]]
            h = d['current']['terms_hash']
            if method == 'GET' and not rest:
                return self.view(did, me)
            if method == 'POST' and rest == ['accept']:
                if not signed_by(self.pk(me), vc.statement('accept', h).encode(), body['signature']):
                    raise vc.ValunError('bad_signature', 'the acceptance does not verify', 403)
                d['agreement'] = {'version': 1, 'terms_hash': h, 'formed_at': iso(now_ms()), 'proposer_signature': d['current']['signature'],
                                  'acceptor_signature': body['signature']}
                d['current']['state'], d['status'] = 'accepted', 'agreed'
                return self.view(did, me)
            if method == 'POST' and rest == ['deliver']:
                dh = vc.sha256_hex(body['content'])
                if dh != body['sha256'] or not signed_by(self.pk(me), vc.statement('deliver', h, dh).encode(), body['signature']):
                    raise vc.ValunError('bad_signature', 'the delivery does not verify', 403)
                d['delivery'] = {'by': me, 'title': body['title'], 'content': body['content'], 'sha256': dh,
                                 'bytes': len(body['content'].encode()), 'signature': body['signature'], 'late': False}
                d['status'] = 'delivered'
                return self.view(did, me)
            if method == 'GET' and rest == ['credit-note-template'] and q.get('bound') == '1':
                return self.note_template(did, me)
            if method == 'POST' and rest == ['complete']:
                return self.complete(did, me, body)
        if method == 'GET' and parts == ['consents']:
            return self.consents(me)
        if method == 'POST' and len(parts) == 2 and parts[0] == 'consents' and parts[1] in self.setoffs:
            return self.consent(parts[1], me, body)
        if method == 'GET' and parts == ['edges']:
            if self.edges_fail:
                raise vc.ValunError('unavailable', 'the edges cannot be read now', 503)
            return self.edges(me, int(q.get('since', '0')))
        raise vc.ValunError('not_found', f'no route {method} /{"/".join(parts)}', 404)


def routed(net):
    """Every vc.Client request goes to `net`, as the participant of the profile that sends it."""
    def request(client, method, path, body=None, auth=True, token=None):
        return net.handle(client.participant_id, method, path, json.loads(json.dumps(body)) if body is not None else None)
    return mock.patch.object(vc.Client, 'request', request)


def profile(pid, k):
    """A sandbox participant's profile on the testnet as `valun join --sandbox` leaves it: not pinned yet (the first GET
    /info pins it), the sandbox consent policy at the testnet's scale."""
    return {'server': SERVER, 'participant_id': pid, 'pubkey': k['pubkey'], 'network': TESTNET, 'issued': {}, 'approvals': 'none',
            'consent_policy': dict(va.SANDBOX_CONSENT_POLICY, max_PC=va.SANDBOX_CONSENT_POLICY['max_PC'] * 1_000_000), 'consent_loop': 'on'}


class Chain(ta.World):
    """test_audit.py's World (the tracker box, the explorer, GET /chain and /ledger/committed) once the box commits the
    state of `net`'s tracker; GET /ledger names each key's participant."""

    def __init__(self, net):
        super().__init__(nft=NFT)
        self.anchored = [ta.note(*e.split('>'), st['total']) for e, st in net.tracker.items()]
        self.published = copy.deepcopy(self.anchored)
        self.owner = {k['pubkey']: pid for pid, k in net.keys.items()}

    def ledger(self):
        out = super().ledger()
        for n in out['notes']:
            n['issuer'], n['recipient'] = self.owner.get(n['issuer_pubkey']), self.owner.get(n['recipient_pubkey'])
        return out


def audit_state(store):
    """What `valun audit` gives the audit of a profile (cli.AUDIT_STATE_KEYS)."""
    return {k: copy.deepcopy(store.state[k]) for k in cli.AUDIT_STATE_KEYS if k in store.state}


class HappyPath(unittest.TestCase):
    def run_path(self, order):
        """sandbox earn in A, the loop A -> B -> C -> A of 2,000,000 deals, then `valun clearing run` in each profile in
        `order`. Returns the server and the three profiles' stores."""
        net = Net()
        stores = {n: MemStore(profile(ID[n], k), secret=k['secret'].hex(), token=f'vpa_test-{n}') for n, k in (('a', A), ('b', B), ('c', C))}
        lines = []
        with routed(net):
            r = sb.earn(stores['a'], server=SERVER, wait_s=30, log=lines.append, poll_s=0)
            self.assertEqual((r['status'], r['paid'], r['amount']), ('note_issued', True, WELCOME_PRICE), lines)
            for payer, payee in (('a', 'b'), ('b', 'c'), ('c', 'a')):
                cp, ce = (vc.Client(stores[n], server=SERVER) for n in (payer, payee))
                did = cp.propose(ID[payee], 'payer', 'A short brief', f'A brief for {payer}', 'markdown', LOOP_PRICE, 24, 1)['id']
                ce.accept(did, ce.verify_offer(ce.deal(did))['terms_hash'])
                ce.deliver(did, f'The brief {payer} asked for.', 'brief')
                self.assertEqual(cp.complete(did, cp.deal(did)['delivery']['sha256'])['status'], 'note_issued')
            self.assertEqual(len(net.setoffs), 1, 'the clearing engine proposes the cycle as one set-off')
            reports = {n: vc.Client(stores[n], server=SERVER).process_consents() for n in order}     # `valun clearing run`
        sid = next(iter(net.setoffs))
        self.assertEqual(net.setoffs[sid]['state'], 'applied')
        self.assertEqual([[e['state'] for e in reports[n]['signed']] for n in order], [['collecting'], ['collecting'], ['applied']])
        self.assertEqual({e: st['total'] for e, st in net.tracker.items()},
                         {net.edge(X_ID, A_ID): WELCOME_PRICE, net.edge(A_ID, B_ID): 0, net.edge(B_ID, C_ID): 0, net.edge(C_ID, A_ID): 0})
        return net, stores, sid

    def mine(self, net, store, **kw):
        r = Chain(net).audit(profile_state=audit_state(store), mine=True, **kw)
        self.assertEqual(r['verdict'], 'MATCH', r['message'])
        return r, {e['edge']: e for e in r['mine']['edges']}

    def test_basis_happy_path_audit_mine_proves_every_edge_and_exits_0(self):
        for order in (('a', 'b', 'c'), ('c', 'b', 'a')):
            with self.subTest(order=order):
                net, stores, sid = self.run_path(order)
                last = order[-1]
                for n in ('a', 'b', 'c'):
                    r, got = self.mine(net, stores[n])
                    self.assertEqual((r['mine']['all_proven'], vaudit.exit_code(r)), (True, vaudit.EXIT_MATCH), (order, n, r['mine']))
                    for e in got.values():
                        self.assertIn(e['status'], vaudit.PROVEN_STATUS, (order, n, e))
                        self.assertEqual(e['anchored_total'], WELCOME_PRICE if e['edge'] == net.edge(X_ID, A_ID) else 0)
                        if e['edge'] != net.edge(X_ID, A_ID):
                            self.assertEqual(e['netted_by'], sid, (order, n, e))
                    issued = next(e for e in got.values() if e['role'] == 'issuer')
                    held = next(e for e in got.values() if e['role'] == 'recipient' and e['edge'] != net.edge(X_ID, A_ID))
                    # the edge the last signer issues: confirmed when the server answered applied, with its own signature
                    self.assertEqual(issued['status'], 'signed' if n == last else 'netted', (order, n, issued))
                    self.assertEqual((held['status'], held['netted_state']['as'], held['netted_state']['signed_by']),
                                     ('netted', 'creditor', 'you'), (order, n))
                    if issued['status'] == 'netted':
                        self.assertEqual((issued['netted_state']['as'], issued['recorded']['total']), ('issuer', LOOP_PRICE))
                    lines = '\n'.join(cli._audit_lines(r, True))
                    self.assertIn(f'netted by {sid}, signed by you', lines)
                    self.assertIn(f"{len(got)} of {len(got)} edges proven", lines)
                _r, got = self.mine(net, stores['a'])
                self.assertEqual(len(got), 3)
                welcome = got[net.edge(X_ID, A_ID)]
                self.assertEqual((welcome['status'], welcome['counterparty'], welcome['recorded']['total']), ('signed', X_ID, WELCOME_PRICE),
                                 'the welcome note sandbox earn was paid with is in the records, with its issuer signature')

    def test_what_0_7_1_left_in_the_records_is_what_basis_saw(self):
        """The records 0.7.1 kept on this path: no welcome note (earn read no edges) and no signature for the set-off's new
        states. --mine then finds what Basis reported: not_in_records, differs (anchored 0, records 2000000) and
        not_in_records, 0 of 3 proven, exit 3."""
        net, stores, sid = self.run_path(('a', 'b', 'c'))
        old = copy.deepcopy(stores['a'].state)
        recs = old['records']
        del recs[net.edge(X_ID, A_ID)]
        for pair, e in recs.items():
            for p in (e.get('pending') or []) if pair != 'paid_deals' else ():
                p.pop('signature', None)
        r = Chain(net).audit(profile_state=audit_state(MemStore(old)), mine=True)
        got = {e['edge']: (e['status'], e['anchored_total'], (e['recorded'] or {}).get('total')) for e in r['mine']['edges']}
        self.assertEqual(got, {net.edge(X_ID, A_ID): ('not_in_records', WELCOME_PRICE, None), net.edge(A_ID, B_ID): ('differs', 0, LOOP_PRICE),
                               net.edge(C_ID, A_ID): ('not_in_records', 0, None)})
        self.assertEqual((r['mine']['proven'], vaudit.exit_code(r)), (0, vaudit.EXIT_NOT_PROVEN))
        self.assertIn('0 of 3 edges proven (signed)', '\n'.join(cli._audit_lines(r, True)))

    def test_a_set_off_that_did_not_apply_on_every_edge_nets_none(self):
        """The 0.7.2 review of fix inbox #86: A and B sign the loop's set-off, C does not, so it never applies; B reads
        its edges back. A tracker that then commits only the decrease of B's claim on A (A>B at 0, B>C still 2000000)
        took 2000000 of B's net position: --mine must not prove A>B by B's own signature over the after-state it signed
        (netted), because the set-off did not reach the box on B's other edge. The same for a set-off whose records hold
        one of its edges only: a set-off nets a cycle, so fewer than two known edges prove nothing."""
        net = Net()
        stores = {n: MemStore(profile(ID[n], k), secret=k['secret'].hex(), token=f'vpa_test-{n}') for n, k in (('a', A), ('b', B), ('c', C))}
        with routed(net):
            sb.earn(stores['a'], server=SERVER, wait_s=30, log=lambda _s: None, poll_s=0)
            for payer, payee in (('a', 'b'), ('b', 'c'), ('c', 'a')):
                cp, ce = (vc.Client(stores[n], server=SERVER) for n in (payer, payee))
                did = cp.propose(ID[payee], 'payer', 'A short brief', f'A brief for {payer}', 'markdown', LOOP_PRICE, 24, 1)['id']
                ce.accept(did, ce.verify_offer(ce.deal(did))['terms_hash'])
                ce.deliver(did, f'The brief {payer} asked for.', 'brief')
                cp.complete(did, cp.deal(did)['delivery']['sha256'])
            for n in ('a', 'b'):                                    # C does not sign
                vc.Client(stores[n], server=SERVER).process_consents()
            sid = next(iter(net.setoffs))
            net.setoffs[sid]['state'] = 'refused'
            vc.Client(stores['b'], server=SERVER).sync_edges()
        ab, bc = net.edge(A_ID, B_ID), net.edge(B_ID, C_ID)
        self.assertEqual({p['ref'] for p in records.get(stores['b'].state['records'], ab)['pending'] if p.get('kind') == 'setoff'}, {sid},
                         "B's kept signature over A>B's after-state is still in its records")
        net.tracker[ab] = dict(net.tracker[ab], total=0)        # the box commits A>B at 0, and B>C as it was
        r = Chain(net).audit(profile_state=audit_state(stores['b']), mine=True)
        got = {e['edge']: e for e in r['mine']['edges']}
        self.assertEqual((got[ab]['status'], got[ab].get('netted_by'), 'netted_state' in got[ab]), ('differs', None, False))
        self.assertEqual((got[bc]['status'], got[bc]['anchored_total']), ('signed', LOOP_PRICE))
        self.assertEqual((r['mine']['all_proven'], vaudit.exit_code(r)), (False, vaudit.EXIT_NOT_PROVEN))
        # B's records knowing one edge of the set-off only (its other entries and its R4 record of B>C gone)
        state = audit_state(stores['b'])
        state['records'][bc]['pending'] = [p for p in state['records'][bc]['pending'] if p.get('ref') != sid]
        state['signed'].pop(bc, None)
        net.tracker[bc] = dict(net.tracker[bc], total=0)
        got = {e['edge']: e for e in Chain(net).audit(profile_state=state, mine=True)['mine']['edges']}
        self.assertEqual(got[ab]['status'], 'differs', 'one known edge of a set-off proves nothing')

    def test_valun_audit_mine_on_the_command_line_exits_0(self):
        net, stores, sid = self.run_path(('a', 'b', 'c'))
        chain = Chain(net)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'a.json'), 'w', encoding='utf-8') as f:
            json.dump(dict(stores['a'].state, secret=A['secret'].hex(), agent_token='vpa_test-a'), f)
        def run(*extra):
            out = io.StringIO()
            with mock.patch.dict(os.environ, {'VALUN_HOME': home.name}), mock.patch.object(vaudit, 'get_json', chain.get), \
                    routed(net), contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                rc = cli.main(['--profile', 'a', 'audit', '--explorer', ta.EXPLORER, '--mine', '--tracker-nft', NFT, *extra])
            return rc, out.getvalue()
        # The records as the path left them (--no-refresh): each netted edge proven by this client's own signature.
        rc, text = run('--no-refresh')
        self.assertEqual(rc, 0, text)
        self.assertTrue(text.startswith('MATCH: the 4 notes'), text)
        self.assertIn(f'netted              you owe {B_ID}: anchored 0 nanoERG (0 tERG): netted by {sid}, signed by you: the '
                      'anchored total is the state that set-off gives this edge, and your signature on it, in your records, '
                      'verifies', text)
        self.assertIn(f'netted              owed to you by {C_ID}: anchored 0 nanoERG (0 tERG): netted by {sid}, signed by you', text)
        self.assertIn(f'signed              owed to you by {X_ID}: anchored 3000000 nanoERG (0.003 tERG): its issuer signed', text)
        self.assertIn('3 of 3 edges proven (signed, or netted by a set-off you signed). Your records are read as they are: they '
                      'were not refreshed first.', text)
        self.assertNotIn(A['secret'].hex(), text)
        self.assertEqual({m for m in chain.log if not m.startswith(SERVER) and not m.startswith(ta.EXPLORER)}, set(), 'GET only, to them')
        # Refreshed first (the default): the edges' issuer-signed states are in the records, so each is signed.
        rc, text = run()
        self.assertEqual(rc, 0, text)
        self.assertIn(f'signed              you owe {B_ID}: anchored 0 nanoERG (0 tERG): its issuer signed this total: the '
                      f'signature in your records verifies (netted by {sid}, signed by you)', text)
        self.assertIn('3 of 3 edges proven (signed). Your client refreshed its records first (GET /pilot/v1/edges), as '
                      'valun_status does.', text)


class RefreshBeforeMine(unittest.TestCase):
    """0.7.2 (#86, the newcomer tests on staging, 2026-11-17): an IOU approved in the owner console was issued after the
    agent's MCP session had ended, so its record stayed pending, and `valun audit --mine` said "differs" (exit 3) until
    a valun_status read the edges. Now --mine first refreshes the records as valun_status does (GET /pilot/v1/edges from
    the profile's own server, each state checked against its issuer's signature); --no-refresh compares them as they
    are."""

    def test_records_behind_the_tracker_are_refreshed_before_mine(self):
        net, stores, sid = HappyPath.run_path(HappyPath(), ('a', 'b', 'c'))
        chain = Chain(net)
        state = copy.deepcopy(stores['a'].state)
        welcome = net.edge(X_ID, A_ID)
        state['records'].pop(welcome)               # a note the records do not hold yet (as after a console approval)
        state.pop('journal_seq', None)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        path = os.path.join(home.name, 'profiles', 'a.json')

        def run(*extra):
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(dict(state, secret=A['secret'].hex(), agent_token='vpa_test-a'), f)
            out, err = io.StringIO(), io.StringIO()
            n = len(net.log)
            with mock.patch.dict(os.environ, {'VALUN_HOME': home.name}), mock.patch.object(vaudit, 'get_json', chain.get), \
                    routed(net), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                rc = cli.main(['--profile', 'a', 'audit', '--explorer', ta.EXPLORER, '--mine', '--tracker-nft', NFT, *extra])
            return rc, out.getvalue(), err.getvalue(), net.log[n:]
        rc, out, err, sent = run('--no-refresh')
        self.assertEqual(rc, vaudit.EXIT_NOT_PROVEN, out)
        self.assertIn(f'not_in_records      owed to you by {X_ID}', out)
        self.assertEqual(sent, [], '--no-refresh: nothing is asked of the server but the audit\'s own GETs')
        rc, out, err, sent = run()
        self.assertEqual(rc, vaudit.EXIT_MATCH, out + err)
        self.assertIn(f'signed              owed to you by {X_ID}: anchored 3000000 nanoERG (0.003 tERG): its issuer signed', out)
        self.assertIn('3 of 3 edges proven', out)
        self.assertIn('Your records were refreshed first from http://valun.invalid (GET /pilot/v1/edges, each state checked '
                      "against its issuer's signature), as valun_status does", err)
        self.assertIn((A_ID, 'GET', '/pilot/v1/edges?since=0'), sent)
        self.assertEqual({m for _p, m, _x in sent}, {'GET'}, 'the refresh only reads')
        with open(path, encoding='utf-8') as f:
            self.assertIn(welcome, json.load(f)['records'], 'the refreshed records are kept')
        # a server whose edges cannot be read now: said so, and the records are compared as they are
        net.edges_fail = True
        rc, out, err, sent = run()
        self.assertEqual(rc, vaudit.EXIT_NOT_PROVEN, out)
        self.assertIn('Your records could not be refreshed first (unavailable: the edges cannot be read now): they are '
                      'compared as they are', err)


class Records(unittest.TestCase):
    """The two records fixes on their own: what sandbox earn records, and what a set-off this client signs records."""

    def test_sandbox_earn_records_the_note_it_was_paid_with(self):
        net = Net()
        store = MemStore(profile(A_ID, A), secret=A['secret'].hex(), token='vpa_test-a')
        with routed(net):
            sb.earn(store, server=SERVER, wait_s=30, log=lambda line: None, poll_s=0)
        st = records.get(store.state['records'], net.edge(X_ID, A_ID))['confirmed']
        self.assertEqual(st, net.tracker[net.edge(X_ID, A_ID)], "the edge's state, with sandbox-exact's signature")
        self.assertTrue(vc.verify_note(X['pubkey'], A['pubkey'], st['total'], st['timestamp'], st['signature'], NFT, DENOM))
        self.assertIn((A_ID, 'GET', '/pilot/v1/edges?since=0'), net.log, 'one read-back of the edges, as valun_status makes')
        # a server that cannot show the edges now: the earning stands, and says the records do not hold it yet
        net, lines = Net(), []
        net.edges_fail = True
        store = MemStore(profile(A_ID, A), secret=A['secret'].hex(), token='vpa_test-a')
        with routed(net):
            r = sb.earn(store, server=SERVER, wait_s=30, log=lines.append, poll_s=0)
        self.assertEqual(r['paid'], True)
        self.assertIn('  (your records do not hold this payment yet (unavailable); valun_status reads your edges again where this '
                      'server shows them)', lines)
        self.assertNotIn(net.edge(X_ID, A_ID), store.state.get('records') or {})

        # the 0.7.2 review: a profile that cannot be written once the buyer has paid (a full disk) does not lose the earning
        class FullDisk(MemStore):
            full = False

            def save(self):
                if self.full:
                    raise OSError(28, 'No space left on device')
        net, lines = Net(), []
        store = FullDisk(profile(A_ID, A), secret=A['secret'].hex(), token='vpa_test-a')
        paid = net.paid

        def paid_then_full(*a, **k):
            paid(*a, **k)
            store.full = True
        net.paid = paid_then_full
        with routed(net):
            r = sb.earn(store, server=SERVER, wait_s=30, log=lines.append, poll_s=0)
        self.assertEqual((r['paid'], r['status']), (True, 'note_issued'))
        self.assertTrue(any(x.startswith('  (your records do not hold this payment yet (OSError: ') for x in lines), lines)

    def test_a_second_consent_run_at_once_keeps_what_the_first_one_sent(self):
        """The 0.7.2 review: two consent runs of one profile at once (the MCP server's consent loop and `valun clearing
        run`) both read GET /consents before either posts; the server takes the first post and answers the second 409
        already_signed (it holds every slot of this member already). That refusal keeps the pending entries, and the
        signatures kept with them: they are the states the signatures the server holds sign, so --mine proves the edges
        the set-off netted once it applies (it removed them, and --mine answered not proven, as in #86)."""
        class Net409(Net):
            def consent(self, sid, me, body):
                mine = {e['edge'] for e in self.item(sid, me)['edges']}
                if all(f'{e}:new' in self.setoffs[sid]['sigs'].get(me, {}) for e in mine):
                    raise vc.ValunError('already_signed', 'you have signed every slot of yours on this set-off', 409)
                return super().consent(sid, me, body)
        net = Net409()
        stores = {n: MemStore(profile(ID[n], k), secret=k['secret'].hex(), token=f'vpa_test-{n}') for n, k in (('a', A), ('b', B), ('c', C))}
        with routed(net):
            sb.earn(stores['a'], server=SERVER, wait_s=30, log=lambda _s: None, poll_s=0)
            for payer, payee in (('a', 'b'), ('b', 'c'), ('c', 'a')):
                cp, ce = (vc.Client(stores[n], server=SERVER) for n in (payer, payee))
                did = cp.propose(ID[payee], 'payer', 'A short brief', f'A brief for {payer}', 'markdown', LOOP_PRICE, 24, 1)['id']
                ce.accept(did, ce.verify_offer(ce.deal(did))['terms_hash'])
                ce.deliver(did, f'The brief {payer} asked for.', 'brief')
                cp.complete(did, cp.deal(did)['delivery']['sha256'])
            stale = net.consents(A_ID)                      # what the second run read, before the first one posted
            vc.Client(stores['a'], server=SERVER).process_consents()
            second = vc.Client(stores['a'], server=SERVER)
            second.consents = lambda: stale
            report = second.process_consents()
            self.assertEqual([x.get('error') for x in report['waiting']], ['already_signed'])
            for e in (net.edge(A_ID, B_ID), net.edge(C_ID, A_ID)):
                self.assertEqual([p['kind'] for p in records.get(stores['a'].state['records'], e)['pending']], ['setoff'], e)
            for n in ('b', 'c'):
                vc.Client(stores[n], server=SERVER).process_consents()
        self.assertEqual(net.setoffs[next(iter(net.setoffs))]['state'], 'applied')
        r = Chain(net).audit(profile_state=audit_state(stores['a']), mine=True)
        self.assertEqual(([e['status'] for e in r['mine']['edges']], vaudit.exit_code(r)), (['signed', 'netted', 'netted'], vaudit.EXIT_MATCH))

    def test_a_set_off_this_client_signs_records_its_after_state_and_its_signature(self):
        path = HappyPath()
        net, stores, sid = HappyPath.run_path(path, ('a', 'b', 'c'))
        for n, mine_out, mine_in in (('a', (A_ID, B_ID), (C_ID, A_ID)), ('b', (B_ID, C_ID), (A_ID, B_ID)), ('c', (C_ID, A_ID), (B_ID, C_ID))):
            recs, k = stores[n].state['records'], {'a': A, 'b': B, 'c': C}[n]
            out_edge, in_edge = net.edge(*mine_out), net.edge(*mine_in)
            ts_out, ts_in = (net.setoffs[sid]['ts'][e] for e in (mine_out, mine_in))
            rec_out, rec_in = records.get(recs, out_edge), records.get(recs, in_edge)
            if n == 'c':                         # the last signer: the server answered applied
                self.assertEqual(rec_out['confirmed'], net.tracker[out_edge], 'its own signature is the one the tracker holds')
                self.assertEqual(rec_out['pending'], [])
                self.assertEqual(stores[n].state['issued'][out_edge], 0, "the 0.3 'issued' record follows")
            else:
                self.assertEqual(rec_out['confirmed']['total'], LOOP_PRICE, 'nothing is confirmed just because it was signed')
                [p] = rec_out['pending']
                self.assertEqual((p['total'], p['timestamp'], p['kind'], p['ref'], p['direction']), (0, ts_out, 'setoff', sid, 'out'))
                self.assertEqual(p['signature'], net.tracker[out_edge]['signature'], 'the issuer signature the tracker holds')
            [p] = rec_in['pending']                   # an edge it is the creditor of: its consent, pending until a read
            self.assertEqual((p['total'], p['timestamp'], p['ref'], p['direction']), (0, ts_in, sid, 'in'))
            i, r = in_edge.split('>')
            self.assertTrue(vb.verify(bytes.fromhex(p['signature']), msg(i, r, 0, ts_in), bytes.fromhex(k['pubkey'])))
            self.assertNotEqual(p['signature'], net.tracker[in_edge]['signature'])
            # a read of the edges then confirms both with their issuers' signatures, and no pending entry is left
            with routed(net):
                vc.Client(stores[n], server=SERVER).sync_edges()
            for e in (out_edge, in_edge):           # (the client saved its records anew: read them again)
                self.assertEqual(records.get(stores[n].state['records'], e), {'confirmed': net.tracker[e], 'pending': []}, (n, e))
            r = Chain(net).audit(profile_state=audit_state(stores[n]), mine=True)
            self.assertEqual({x['status'] for x in r['mine']['edges']}, {'signed'}, 'synced: signed, the netted ones named so')
            self.assertEqual(sorted(x.get('netted_by') or '' for x in r['mine']['edges']),
                             ([''] if n == 'a' else []) + [sid, sid])

    def test_note_signature_keeps_a_signature_on_the_matching_pending_entry_only(self):
        recs = {}
        records.add_pending(recs, 'i>r', 0, 1998, 'setoff', 'vs_' + '1' * 16, 'out')
        records.add_pending(recs, 'i>r', 5, 2998, 'setoff', 'vs_' + '2' * 16, 'out')
        self.assertEqual(records.note_signature(recs, 'i>r', 0, 1998, 'vs_' + '1' * 16, 'ab' * 64), 1)
        self.assertEqual([p.get('signature') for p in recs['i>r']['pending']], ['ab' * 64, None])
        self.assertEqual(records.note_signature(recs, 'i>r', 0, 1998, 'vs_' + '2' * 16, 'cd' * 64), 0, 'another ref')
        self.assertEqual(records.note_signature(recs, 'x>y', 0, 1998, None, 'cd' * 64), 0, 'no such edge')
        with self.assertRaises(ValueError):
            records.note_signature(recs, 'i>r', 0, 1998, 'vs_' + '1' * 16, '')
        self.assertEqual(records.confirm(recs, 'i>r', {'total': 0, 'timestamp': 1998, 'signature': 'ab' * 64})['pending'][0]['total'], 5,
                         'a pending entry with its signature is promoted as any other')


if __name__ == '__main__':
    unittest.main()
