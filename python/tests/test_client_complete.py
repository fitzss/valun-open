"""Client.complete() against a fake Valun server and tracker (offline, real signatures): what is recorded (pending vs
confirmed), when the prior note is accepted, the reserved-residue refusal, the payee's delivery signature, the
tracker pins, and that a profile not pinned yet is served exactly as by 0.3 (no /info read, no ?prior=1). A server
that lists bound_notes/1 serves bound templates (?prior=1&bound=1, timestamps ending in 997 ms) and checks bound
notes as v16 does (PROTOCOL.md 18.5); test_client_circulation.py has the bound-note signing in detail."""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import basis as vb  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import records  # noqa: E402

NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
OTHER_NFT = '11' * 32
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
SERVER = 'http://valun.invalid'


def key(label):
    """Throwaway test key: secret = (sha256(label) mod (n - 1)) + 1, as in the spec vectors."""
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'secret': secret, 'pubkey': vb.public_key(secret).hex()}


ALICE, BOB, BOB2, MALLORY = key('test/alice'), key('test/bob'), key('test/bob-rotated'), key('test/mallory')
ALICE_ID, BOB_ID = 'vp_a1a1a1a1a1a1', 'vp_b0b0b0b0b0b0'


def sign_text(k, text):
    return vb.sign(text.encode('utf-8'), k['secret'], bytes.fromhex(k['pubkey'])).hex()


def sign_note(k, recipient_pk, total, ts, nft=NFT):
    msg = vb.note_message(bytes.fromhex(k['pubkey']), bytes.fromhex(recipient_pk), total, ts, bytes.fromhex(nft), DENOM)
    return vb.sign(msg, k['secret'], bytes.fromhex(k['pubkey'])).hex()


class MemStore:
    """A store without update(): the client applies changes and calls save()."""

    def __init__(self, state=None, secret=ALICE['secret'].hex(), token='vpa_test-only'):
        self.state = state if state is not None else {'server': SERVER, 'participant_id': ALICE_ID, 'pubkey': ALICE['pubkey'], 'issued': {}}
        self._s, self._t, self.saves = secret, token, 0

    def secret(self):
        return self._s

    def token(self):
        return self._t

    def save(self):
        self.saves += 1

    def save_credentials(self, secret_hex, token):
        self._s, self._t = secret_hex, token


class World:
    """A fake Valun server with a fake tracker: just enough of /pilot/v1 for complete(). Alice pays, Bob is the payee."""

    def __init__(self, features=None, review_deliveries=False, nft=NFT):
        self.features, self.review_deliveries, self.nft = features, review_deliveries, nft
        self.payee_key = BOB                    # Bob's current directory key
        self.tracker = {}                       # pair -> {total, timestamp, signature}
        self.deals, self.held, self.log = {}, {}, []
        self.template_ts = None                 # force the next template timestamp (tests of the residue rule)
        self.complete_answer = None             # force the POST /complete answer: ('status', s) or ('error', http, code)

    # ---------- setup ----------
    def add_deal(self, deal_id, price=20, content='# Brief\n\nThree sources.\n', delivery_key=None, terms_payee=None):
        payee = terms_payee or BOB
        t = {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': self.nft, 'denomination': DENOM, 'deal_id': deal_id,
             'version': 1, 'prior_terms_hash': None, 'nonce': 'ab' * 16, 'proposer': ALICE_ID,
             'payer': {'id': ALICE_ID, 'pubkey': ALICE['pubkey']}, 'payee': {'id': BOB_ID, 'pubkey': payee['pubkey']},
             'service': {'title': 'Short research brief', 'description': 'Three sources.', 'deliverable': 'markdown'},
             'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
             'deliver_by': '2099-01-02T00:00:00.000Z', 'offer_expires_at': '2099-01-01T00:00:00.000Z'}
        h = vc.terms_hash(t)
        dh = vc.sha256_hex(content)
        self.deals[deal_id] = {
            'id': deal_id, 'status': 'delivered', 'your_role': 'payer', 'counterparty': {'id': BOB_ID, 'handle': 'bob'},
            'current': {'version': 1, 'by': ALICE_ID, 'state': 'accepted', 'terms': t, 'terms_hash': h,
                        'signature': sign_text(ALICE, vc.statement('propose', h))},
            'agreement': {'version': 1, 'terms_hash': h, 'proposer_signature': sign_text(ALICE, vc.statement('propose', h)),
                          'acceptor_signature': sign_text(payee, vc.statement('accept', h))},
            'delivery': {'by': BOB_ID, 'title': 'Brief', 'content': content, 'sha256': dh, 'bytes': len(content.encode()),
                         'signature': sign_text(delivery_key or payee, vc.statement('deliver', h, dh))},
            'credit_note': None}
        return self.deals[deal_id]

    @property
    def pair(self):
        return f"{ALICE['pubkey']}>{self.payee_key['pubkey']}"

    def set_edge(self, total, timestamp, signer=ALICE):
        self.tracker[self.pair] = {'total': total, 'timestamp': timestamp,
                                   'signature': sign_note(signer, self.payee_key['pubkey'], total, timestamp)}

    def info(self):
        out = {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': self.nft, 'denomination': DENOM}
        if self.features is not None:
            out['features'] = self.features
            # GET /info novation of a v16 server on tracker v3.2 (design v3.2): what the client signs a bound note for
            out['novation'] = {'transfer_ms': 999, 'setoff_ms': 998, 'bound_note_ms': 997, 'reserved_ms': [995, 996, 997, 998, 999],
                               'max_age_ms': 3600000, 'transfer_ttl_ms': 1200000, 'setoff_ttl_ms': 1800000,
                               'fallback_margin_ms': 60000, 'tracker_build': 'valun-circulating-credit/4',
                               'transfer_version': 4, 'bound_note_version': 3, 'prior_ack': 'basis/prior-ack/1'}
        return out

    # ---------- owner decisions on held notes ----------
    def owner_reject(self, deal_id):
        self.held.pop(deal_id)
        d = self.deals[deal_id]
        d['status'], d['credit_note'] = 'delivered', None

    def owner_approve(self, deal_id):
        note = self.held.pop(deal_id)
        self._apply(deal_id, note)

    def _apply(self, deal_id, note):
        note = {'total': note['total'], 'timestamp': note['timestamp'], 'signature': note['signature']}   # the EdgeState
        self.tracker[self.pair] = dict(note)
        self.deals[deal_id]['status'] = 'note_issued'
        self.deals[deal_id]['credit_note'] = {'state': 'recorded', 'note': dict(note), 'tracker_note': {
            'amount_collected': note['total'], 'amount_redeemed': 0, 'timestamp': note['timestamp'],
            'signature': note['signature'], 'confirmation': 'local_only'}}

    # ---------- the HTTP surface ----------
    def handle(self, method, path, body=None):
        self.log.append(f'{method} {path}')
        if method == 'GET' and path == '/pilot/v1/info':
            return self.info()
        if method == 'GET' and path == f'/pilot/v1/participants/{BOB_ID}':
            return {'id': BOB_ID, 'handle': 'bob', 'status': 'active', 'pubkey': self.payee_key['pubkey']}
        parts = path.split('?')[0].split('/')
        if len(parts) >= 5 and parts[3] == 'deals' and parts[4] in self.deals:
            did = parts[4]
            if method == 'GET' and len(parts) == 5:
                return json.loads(json.dumps(self.deals[did]))
            if method == 'GET' and parts[5:] == ['credit-note-template']:
                query = path.partition('?')[2].split('&')
                return self.template(did, prior='prior=1' in query, bound='bound=1' in query)
            if method == 'POST' and parts[5:] == ['complete']:
                return self.complete(did, body)
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)

    def template(self, did, prior=False, bound=False):
        d = self.deals[did]
        cur = self.tracker.get(self.pair)
        price = d['current']['terms']['price']['amount']
        last = cur['timestamp'] if cur else 0
        now = int(time.time() * 1000)
        if self.template_ts is not None:
            ts = self.template_ts
        elif bound:                                # v16 ?bound=1: the largest ts ending in 997 ms, <= now - 1500, > last
            ts = (now - 1500) - (now - 1500 - 997) % 1000
            if ts <= last:
                ts = last + 1 + (997 - (last + 1)) % 1000      # the next one (the server waits up to 3 s for it)
        else:
            ts = max(now - 1500, last + 1)
            if self.features and ts % 1000 >= 995:
                ts += 1000 - ts % 1000             # what the v16 server does for ordinary notes
        prior_total = cur['total'] if cur else 0
        tpl = {'deal_id': did, 'terms_hash': d['agreement']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
               'issuer_pubkey': ALICE['pubkey'], 'recipient_pubkey': self.payee_key['pubkey'], 'keys_as_agreed': True,
               'prior_total': prior_total, 'price': price, 'total': prior_total + price, 'timestamp': ts,
               'tracker_nft_id': self.nft, 'denomination': DENOM, 'message_hex': '00'}
        if prior or bound:
            tpl['prior_note'] = dict(cur) if cur else None
        if bound:
            tpl['prior_message_hex'] = '00'
        return tpl

    def complete(self, did, body):
        if self.complete_answer and self.complete_answer[0] == 'error':
            _kind, status, code = self.complete_answer
            raise vc.ValunError(code, f'forced {code}', status)
        note = body['credit_note']
        if not vc.verify_note(ALICE['pubkey'], self.payee_key['pubkey'], note['total'], note['timestamp'], note['signature'], self.nft, DENOM):
            raise vc.ValunError('bad_signature', 'the Basis note signature does not verify', 403)
        if self.features and note['timestamp'] % 1000 == 997:     # a bound note (v16, PROTOCOL.md 18.5)
            cur = self.tracker.get(self.pair)
            prior, prior_ts = (cur['total'], cur['timestamp']) if cur else (0, 0)
            if note.get('prior_total') != prior or note.get('prior_timestamp', prior_ts) != prior_ts:
                raise vc.ValunError('stale_note', "a bound credit note's prior_total and prior_timestamp must be the pair's "
                                                  'current state', 409)
            # tracker v3.2: the prior acknowledgment is PA(I,R,prior,prior_ts,ts) over the stored state
            pa = vb.prior_ack_message(bytes.fromhex(ALICE['pubkey']), bytes.fromhex(self.payee_key['pubkey']), prior, prior_ts,
                                      note['timestamp'], bytes.fromhex(self.nft), DENOM)
            sig = note.get('prior_signature')
            if not (isinstance(sig, str) and vb.verify(bytes.fromhex(sig), pa, bytes.fromhex(ALICE['pubkey']))):
                raise vc.ValunError('bad_signature', 'the prior acknowledgment does not verify', 403)
        if self.complete_answer:
            self.deals[did]['status'] = self.complete_answer[1]
            return {'id': did, 'status': self.complete_answer[1]}
        if self.review_deliveries:
            self.held[did] = dict(note)
            self.deals[did]['status'] = 'completion_awaiting_owner'
            return {'id': did, 'status': 'completion_awaiting_owner', 'credit_note': {'state': 'signed'}}
        self._apply(did, note)
        return json.loads(json.dumps(self.deals[did]))


class WorldClient(vc.Client):
    def __init__(self, world, store):
        super().__init__(store, server=SERVER)
        self.world = world

    def request(self, method, path, body=None, auth=True, token=None):
        return self.world.handle(method, path, json.loads(json.dumps(body)) if body is not None else None)


def pinned_store():
    s = MemStore()
    s.state['pins'] = {'tracker_nft_id': NFT, 'denomination': DENOM}
    return s


class Recording(unittest.TestCase):
    def test_note_issued_is_confirmed(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')
        r = WorldClient(w, s).complete('vd_1')
        self.assertEqual(r['status'], 'note_issued')
        self.assertEqual(s.state['issued'], {w.pair: 20})
        rec = records.get(s.state['records'], w.pair)
        self.assertEqual(rec['confirmed'], w.tracker[w.pair])
        self.assertEqual(rec['pending'], [])

    def test_held_and_issuing_notes_are_pending_not_issued(self):
        for answer in ('completion_awaiting_owner', 'issuing_note'):
            w, s = World(), MemStore()
            w.add_deal('vd_1')
            w.complete_answer = ('status', answer)
            WorldClient(w, s).complete('vd_1')
            self.assertEqual(s.state['issued'], {}, answer)            # OQ-23: nothing is confirmed yet
            rec = records.get(s.state['records'], w.pair)
            self.assertIsNone(rec['confirmed'])
            self.assertEqual([(p['total'], p['kind'], p['ref'], p['direction']) for p in rec['pending']], [(20, 'note', 'vd_1', 'out')])

    def test_failed_or_refused_note_is_forgotten_and_unknown_outcome_stays_pending(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')
        w.complete_answer = ('status', 'note_failed')
        WorldClient(w, s).complete('vd_1')
        self.assertEqual(records.get(s.state['records'], w.pair)['pending'], [])
        w.complete_answer = ('error', 409, 'stale_note')
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'stale_note')
        self.assertEqual(records.get(s.state['records'], w.pair)['pending'], [])
        w.complete_answer = ('error', None, 'unreachable')             # no answer: the server may have recorded it
        with self.assertRaises(vc.ValunError):
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(len(records.get(s.state['records'], w.pair)['pending']), 1)
        self.assertEqual(s.state['issued'], {})

    def test_a_record_that_cannot_be_written_after_the_answer_does_not_hide_it(self):
        class BusyAfterSending(MemStore):
            sent = False

            def update(self, fn):
                if self.sent:
                    raise vc.ValunError('profile_busy', 'busy')
                work = json.loads(json.dumps(self.state))
                result = fn(work)
                self.state.clear()
                self.state.update(work)
                return result
        w, s = World(), BusyAfterSending()
        w.add_deal('vd_1')

        class Marking(WorldClient):
            def request(self, method, path, body=None, auth=True, token=None):
                r = super().request(method, path, body, auth, token)
                if method == 'POST':
                    s.sent = True
                return r
        self.assertEqual(Marking(w, s).complete('vd_1')['status'], 'note_issued')
        self.assertEqual([p['total'] for p in records.get(s.state['records'], w.pair)['pending']], [20])   # settled later
        s.sent = False
        with self.assertRaises(vc.ValunError) as e:
            Marking(w, s).complete('vd_1')                        # a server that offers the paid deal again
        self.assertEqual(e.exception.code, 'already_paid')       # the entry still pending is enough to refuse
        w.add_deal('vd_2')
        w.complete_answer = ('error', 409, 'stale_note')
        s.sent = False
        with self.assertRaises(vc.ValunError) as e:
            Marking(w, s).complete('vd_2')
        self.assertEqual(e.exception.code, 'stale_note')          # the server's refusal, not the busy profile

    def test_a_disk_error_after_the_answer_does_not_hide_it(self):
        class DiskFullAfterSending(MemStore):
            sent = False

            def update(self, fn):
                if self.sent:
                    raise OSError(28, 'No space left on device')
                work = json.loads(json.dumps(self.state))
                result = fn(work)
                self.state.clear()
                self.state.update(work)
                return result
        w, s = World(), DiskFullAfterSending()
        w.add_deal('vd_1')

        class Marking(WorldClient):
            def request(self, method, path, body=None, auth=True, token=None):
                r = super().request(method, path, body, auth, token)
                if method == 'POST':
                    s.sent = True
                return r
        self.assertEqual(Marking(w, s).complete('vd_1')['status'], 'note_issued')     # issued: the answer is returned
        self.assertEqual(w.tracker[w.pair]['total'], 20)
        self.assertEqual([p['total'] for p in records.get(s.state['records'], w.pair)['pending']], [20])
        w.add_deal('vd_2')
        w.complete_answer = ('error', 409, 'stale_note')
        s.sent = False
        with self.assertRaises(vc.ValunError) as e:
            Marking(w, s).complete('vd_2')
        self.assertEqual(e.exception.code, 'stale_note')

    def test_terms_other_than_the_ones_reviewed_are_not_paid(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1', expected_terms_hash='e' * 64)
        self.assertEqual(e.exception.code, 'stale_terms')
        self.assertEqual(w.log, ['GET /pilot/v1/deals/vd_1'])     # refused before the template is even asked for
        h = w.deals['vd_1']['agreement']['terms_hash']
        self.assertEqual(WorldClient(w, s).complete('vd_1', w.deals['vd_1']['delivery']['sha256'], h)['status'], 'note_issued')

    def test_pending_is_written_before_the_note_is_sent(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')
        seen = []

        class Spy(WorldClient):
            def request(self, method, path, body=None, auth=True, token=None):
                if method == 'POST':
                    seen.append(records.get(self.state.get('records') or {}, w.pair)['pending'])
                return super().request(method, path, body, auth, token)
        Spy(w, s).complete('vd_1')
        self.assertEqual(len(seen), 1)
        self.assertEqual([p['total'] for p in seen[0]], [20])

    def test_filestore_profile_holds_the_records(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'alice.json')
            st = MemStore().state
            st.update(secret=ALICE['secret'].hex(), agent_token='vpa_test-only')
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(st, f)
            w = World()
            w.add_deal('vd_1')
            WorldClient(w, vc.FileStore(path)).complete('vd_1')
            with open(path, encoding='utf-8') as f:
                disk = json.load(f)
            self.assertEqual(disk['issued'], {w.pair: 20})
            self.assertEqual(disk['records'][w.pair]['confirmed']['total'], 20)
            self.assertEqual(disk['pins'], {'tracker_nft_id': NFT, 'denomination': DENOM})
            self.assertEqual(disk['server'], SERVER)
            self.assertFalse(os.path.exists(path + '.lock'))


class ZeroThreeCompatibility(unittest.TestCase):
    def test_unpinned_profile_reads_no_info_and_asks_no_prior(self):
        w, s = World(features=['bound_notes/1']), MemStore()
        w.add_deal('vd_1')
        w.template_ts = int(time.time() * 1000) // 1000 * 1000 - 1001    # ends in 999: 0.3 rules accept it
        WorldClient(w, s).complete('vd_1')
        self.assertEqual(w.log, ['GET /pilot/v1/deals/vd_1', 'GET /pilot/v1/deals/vd_1/credit-note-template',
                                 f'GET /pilot/v1/participants/{BOB_ID}', 'POST /pilot/v1/deals/vd_1/complete'])
        self.assertEqual(s.state['pins'], {'tracker_nft_id': NFT, 'denomination': DENOM})   # pinned by this first call

    def test_ledger_rule_kept_without_a_prior_note(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')
        w.set_edge(10, int(time.time() * 1000) - 60_000)
        s.state['issued'] = {w.pair: 30}
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'ledger_mismatch')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)


class PriorNote(unittest.TestCase):
    def setUp(self):
        self.w, self.s = World(features=['bound_notes/1']), pinned_store()
        self.w.add_deal('vd_1')
        self.now = int(time.time() * 1000)

    def run_complete(self):
        return WorldClient(self.w, self.s).complete('vd_1')

    def test_pinned_profile_asks_for_the_prior_note(self):
        self.run_complete()
        self.assertIn('GET /pilot/v1/info', self.w.log)
        self.assertIn('GET /pilot/v1/deals/vd_1/credit-note-template?prior=1&bound=1', self.w.log)   # a bound template (0.4)

    def test_a_lower_prior_i_signed_is_accepted_over_my_old_record(self):
        # My record says 50 (confirmed long ago); a set-off since lowered the edge to 30, signed by me as issuer.
        self.s.state['issued'] = {self.w.pair: 50}
        self.s.state['records'] = {self.w.pair: {'confirmed': {'total': 50, 'timestamp': self.now - 600_000, 'signature': 'x'}, 'pending': []}}
        self.w.set_edge(30, self.now - 60_000)
        r = self.run_complete()
        self.assertEqual(r['status'], 'note_issued')
        self.assertEqual(self.w.tracker[self.w.pair]['total'], 50)          # 30 + 20
        self.assertEqual(self.s.state['issued'], {self.w.pair: 50})
        self.assertEqual(records.get(self.s.state['records'], self.w.pair)['confirmed']['total'], 50)

    def test_a_prior_not_signed_by_me_is_refused(self):
        self.w.set_edge(30, self.now - 60_000, signer=MALLORY)
        with self.assertRaises(vc.ValunError) as e:
            self.run_complete()
        self.assertEqual(e.exception.code, 'bad_prior_signature')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', self.w.log)

    def test_a_prior_older_than_my_records_is_refused(self):
        # F-B shape: the server shows the higher total from before a decrease my records confirm.
        self.w.set_edge(30, self.now - 60_000)
        self.s.state['records'] = {self.w.pair: {'confirmed': {'total': 10, 'timestamp': self.now - 30_000, 'signature': 'x'}, 'pending': []}}
        with self.assertRaises(vc.ValunError) as e:
            self.run_complete()
        self.assertEqual(e.exception.code, 'ledger_mismatch')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', self.w.log)

    def test_a_pending_note_shown_as_the_prior_applied(self):
        # vd_0 was held and approved later: its note is the prior now. It is confirmed, and vd_1 is paid on top of it.
        w, s = self.w, self.s
        w.review_deliveries = True
        w.add_deal('vd_0', price=10)
        WorldClient(w, s).complete('vd_0')
        w.owner_approve('vd_0')
        w.review_deliveries = False
        r = WorldClient(w, s).complete('vd_1')
        self.assertEqual(r['status'], 'note_issued')
        self.assertEqual((s.state['issued'], w.tracker[w.pair]['total']), ({w.pair: 30}, 30))
        self.assertEqual(records.get(s.state['records'], w.pair)['pending'], [])

    def test_a_deal_whose_own_note_applied_is_never_paid_again(self):
        w, s = self.w, self.s
        w.review_deliveries = True
        WorldClient(w, s).complete('vd_1')                         # held: pending 20
        w.owner_approve('vd_1')                                    # applied
        w.deals['vd_1']['status'], w.review_deliveries = 'delivered', False    # a server that shows it unpaid again
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual(w.log.count('POST /pilot/v1/deals/vd_1/complete'), 1)
        self.assertEqual((s.state['issued'], w.tracker[w.pair]['total']), ({w.pair: 20}, 20))   # recorded as confirmed

    def test_the_prior_note_must_be_the_template_prior(self):
        self.w.set_edge(30, self.now - 60_000)

        class Lying(WorldClient):
            def request(self, method, path, body=None, auth=True, token=None):
                r = super().request(method, path, body, auth, token)
                if 'credit-note-template' in path:
                    r['prior_total'], r['total'] = 40, 60      # a higher prior than the note it shows
                return r
        with self.assertRaises(vc.ValunError) as e:
            Lying(self.w, self.s).complete('vd_1')
        self.assertEqual(e.exception.code, 'bad_template')

    def test_reserved_residue_refused_when_features_are_advertised(self):
        for residue in (995, 997, 999):            # an ordinary template (features advertised, but not bound_notes/1)
            w, s = World(features=['example/1']), pinned_store()
            w.add_deal('vd_1')
            w.template_ts = self.now // 1000 * 1000 - 2000 + residue
            with self.assertRaises(vc.ValunError) as e:
                WorldClient(w, s).complete('vd_1')
            self.assertEqual(e.exception.code, 'bad_template', residue)
            self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)
        for residue in (0, 994, 995, 996, 998, 999):     # with bound_notes/1 only a bound template is signed (R3, R12)
            w, s = World(features=['bound_notes/1']), pinned_store()
            w.add_deal('vd_1')
            w.template_ts = self.now // 1000 * 1000 - 2000 + residue
            with self.assertRaises(vc.ValunError) as e:
                WorldClient(w, s).complete('vd_1')
            self.assertEqual(e.exception.code, 'bound_note_required', residue)
            self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)
        w, s = World(features=[]), pinned_store()             # no features: the 0.3 rules
        w.add_deal('vd_1')
        w.template_ts = self.now // 1000 * 1000 - 1001
        self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'note_issued')


class PaidOnce(unittest.TestCase):
    """A note of mine for a deal that may have applied is not signed again, even on the 0.3 ledger path and even for the
    first note to a payee, when there is no confirmed record to compare with."""

    def held_then_approved(self, s, features=None):
        w = World(features=features, review_deliveries=True)
        w.add_deal('vd_1')
        self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'completion_awaiting_owner')
        w.owner_approve('vd_1')                                   # the tracker now holds the note
        w.review_deliveries = False
        return w

    def test_a_first_note_approved_later_is_not_paid_again(self):
        for s in (MemStore(), pinned_store()):                    # unpinned (0.3 path), and pinned with no features
            w = self.held_then_approved(s, features=[] if 'pins' in s.state else None)
            d = w.deals['vd_1']
            d['status'], d['credit_note'] = 'delivered', None     # a server that hides the note and offers the deal again
            with self.assertRaises(vc.ValunError) as e:
                WorldClient(w, s).complete('vd_1')
            self.assertEqual(e.exception.code, 'already_paid', s.state.get('pins'))
            self.assertEqual(w.log.count('POST /pilot/v1/deals/vd_1/complete'), 1)
            self.assertEqual(w.tracker[w.pair]['total'], 20)

    def test_a_first_note_approved_later_is_confirmed_from_its_deal(self):
        s = MemStore()
        w = self.held_then_approved(s)
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')                    # the deal itself says the note was issued
        self.assertEqual(e.exception.code, 'already_paid')
        self.assertEqual((s.state['issued'], records.get(s.state['records'], w.pair)['pending']), ({w.pair: 20}, []))

    def test_a_first_note_the_owner_rejected_is_paid(self):
        for s in (MemStore(), pinned_store()):
            w = World(features=[] if 'pins' in s.state else None, review_deliveries=True)
            w.add_deal('vd_1')
            WorldClient(w, s).complete('vd_1')
            w.owner_reject('vd_1')
            w.review_deliveries = False
            self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'note_issued')
            self.assertEqual((w.tracker[w.pair]['total'], s.state['issued']), (20, {w.pair: 20}))
            self.assertEqual(records.get(s.state['records'], w.pair)['pending'], [])


class DeliverySignature(unittest.TestCase):
    def test_a_delivery_not_signed_by_the_payee_is_refused(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1', delivery_key=MALLORY)
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'bad_delivery_signature')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)

    def test_the_payees_current_key_also_counts(self):
        # The terms name Bob's old key; Bob's owner replaced it and his agent signed the delivery with the new one.
        w, s = World(), MemStore()
        w.add_deal('vd_1', delivery_key=BOB2)
        w.payee_key = BOB2
        self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'note_issued')

    def test_a_missing_delivery_signature_is_refused(self):
        w, s = World(), MemStore()
        w.add_deal('vd_1')['delivery'].pop('signature')
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'bad_delivery_signature')


class Pins(unittest.TestCase):
    def test_info_pins_an_enrolled_profile_and_refuses_a_change(self):
        w, s = World(), MemStore()
        c = WorldClient(w, s)
        c.info()
        self.assertEqual(s.state['pins'], {'tracker_nft_id': NFT, 'denomination': DENOM})
        w.nft = OTHER_NFT
        with self.assertRaises(vc.ValunError) as e:
            c.info()
        self.assertEqual(e.exception.code, 'tracker_mismatch')

    def test_an_unenrolled_profile_is_not_pinned(self):
        s = MemStore({'server': SERVER})
        WorldClient(World(), s).info()
        self.assertNotIn('pins', s.state)

    def test_complete_refuses_another_tracker_than_pinned(self):
        w, s = World(nft=OTHER_NFT, features=['bound_notes/1']), pinned_store()
        w.add_deal('vd_1')
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')                        # /info names another tracker
        self.assertEqual(e.exception.code, 'tracker_mismatch')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)

    def test_the_pins_on_disk_are_checked_again_before_sending(self):
        class PinnedMeanwhile(MemStore):
            """update() reloads what is on disk: another process pinned the profile to another tracker meanwhile."""
            def update(self, fn):
                work = json.loads(json.dumps(self.state))
                work['pins'] = {'tracker_nft_id': NFT, 'denomination': DENOM}
                result = fn(work)
                self.state.clear()
                self.state.update(work)
                return result
        w, s = World(nft=OTHER_NFT), PinnedMeanwhile()
        w.add_deal('vd_1')
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'tracker_mismatch')
        self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)
        self.assertNotIn('pins', s.state)                                # nothing was saved


if __name__ == '__main__':
    unittest.main()
