"""Client.complete() against a fake Valun server and tracker (offline, real signatures): what is recorded (pending vs
confirmed), when the prior note is accepted, the reserved-residue refusal, the payee's delivery signature, the
tracker pins, and that a profile not pinned yet is served exactly as by 0.3 (no /info read, no ?prior=1)."""
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
                return self.template(did, prior='?prior=1' in path)
            if method == 'POST' and parts[5:] == ['complete']:
                return self.complete(did, body)
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)

    def template(self, did, prior=False):
        d = self.deals[did]
        cur = self.tracker.get(self.pair)
        price = d['current']['terms']['price']['amount']
        last = cur['timestamp'] if cur else 0
        ts = self.template_ts if self.template_ts is not None else max(int(time.time() * 1000) - 1500, last + 1)
        if self.features and self.template_ts is None and ts % 1000 >= 995:
            ts += 1000 - ts % 1000                 # what the v16 server does for ordinary notes
        prior_total = cur['total'] if cur else 0
        tpl = {'deal_id': did, 'terms_hash': d['agreement']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
               'issuer_pubkey': ALICE['pubkey'], 'recipient_pubkey': self.payee_key['pubkey'], 'keys_as_agreed': True,
               'prior_total': prior_total, 'price': price, 'total': prior_total + price, 'timestamp': ts,
               'tracker_nft_id': self.nft, 'denomination': DENOM, 'message_hex': '00'}
        if prior:
            tpl['prior_note'] = dict(cur) if cur else None
        return tpl

    def complete(self, did, body):
        if self.complete_answer and self.complete_answer[0] == 'error':
            _kind, status, code = self.complete_answer
            raise vc.ValunError(code, f'forced {code}', status)
        note = body['credit_note']
        if not vc.verify_note(ALICE['pubkey'], self.payee_key['pubkey'], note['total'], note['timestamp'], note['signature'], self.nft, DENOM):
            raise vc.ValunError('bad_signature', 'the Basis note signature does not verify', 403)
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
        w.complete_answer = ('error', 409, 'stale_note')
        s.sent = False
        with self.assertRaises(vc.ValunError) as e:
            Marking(w, s).complete('vd_1')
        self.assertEqual(e.exception.code, 'stale_note')          # the server's refusal, not the busy profile

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
        self.assertIn('GET /pilot/v1/deals/vd_1/credit-note-template?prior=1', self.w.log)

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
        for residue in (995, 997, 999):
            w, s = World(features=['bound_notes/1']), pinned_store()
            w.add_deal('vd_1')
            w.template_ts = self.now // 1000 * 1000 - 2000 + residue
            with self.assertRaises(vc.ValunError) as e:
                WorldClient(w, s).complete('vd_1')
            self.assertEqual(e.exception.code, 'bad_template', residue)
            self.assertNotIn('POST /pilot/v1/deals/vd_1/complete', w.log)
        w, s = World(features=[]), pinned_store()             # no features: the 0.3 rules
        w.add_deal('vd_1')
        w.template_ts = self.now // 1000 * 1000 - 1001
        self.assertEqual(WorldClient(w, s).complete('vd_1')['status'], 'note_issued')


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
