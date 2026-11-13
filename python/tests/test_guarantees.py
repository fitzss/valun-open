"""Guarantees in the client and the agent tools (fix inbox #18), against a fake Valun server and tracker (offline, real
signatures): what a backer offers and signs, what a creditor checks before it accepts or calls, and how a backer honors
a call with its own bound credit note, checked and written ahead as a deal's note is (PROTOCOL.md 19). The fake server
verifies every statement and note signature the way the real one does."""
import hashlib
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src'))
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import records  # noqa: E402

NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
SERVER = 'http://valun.invalid'
NOVATION = {'transfer_ms': 999, 'setoff_ms': 998, 'bound_note_ms': 997, 'reserved_ms': [995, 996, 997, 998, 999], 'max_age_ms': 3600000,
            'transfer_ttl_ms': 1200000, 'setoff_ttl_ms': 1800000, 'fallback_margin_ms': 60000, 'tracker_build': 'valun-circulating-credit/4',
            'transfer_version': 4, 'bound_note_version': 3, 'prior_ack': 'basis/prior-ack/1'}


def key(label):
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'secret': secret, 'pubkey': vb.public_key(secret).hex()}


BOB, ALICE, CHARLIE, MALLORY = key('test/g-bob'), key('test/g-alice'), key('test/g-charlie'), key('test/g-mallory')
IDS = {'bob': 'vp_b0b0b0b0b0b0', 'alice': 'vp_a1a1a1a1a1a1', 'charlie': 'vp_c3c3c3c3c3c3'}
KEYS = {'bob': BOB, 'alice': ALICE, 'charlie': CHARLIE}


def sign_text(k, text):
    return vb.sign(text.encode('utf-8'), k['secret'], bytes.fromhex(k['pubkey'])).hex()


def text_ok(k_pub, text, sig):
    return vb.verify(bytes.fromhex(sig), text.encode('utf-8'), bytes.fromhex(k_pub))


class MemStore:
    def __init__(self, who):
        self.who = who
        self.state = {'server': SERVER, 'participant_id': IDS[who], 'pubkey': KEYS[who]['pubkey'], 'issued': {},
                      'pins': {'tracker_nft_id': NFT, 'denomination': DENOM}}
        self.saves = 0

    def secret(self):
        return KEYS[self.who]['secret'].hex()

    def token(self):
        return f'vpa_{self.who}'

    def save(self):
        self.saves += 1

    def save_credentials(self, *_a):
        pass


class World:
    """A fake server: guarantees, the directory, a tracker of edges, and statement checks as lib/pilot/guarantees.mjs."""

    def __init__(self, features=('bound_notes/1', 'circulation/1', 'guarantees/1')):
        self.features = list(features)
        self.g = {}                     # guarantee id -> server view (with 'terms', 'offer', 'calls', ...)
        self.tracker = {}               # pair -> {total, timestamp, signature}
        self.owed = 0                   # what alice owes charlie on the tracker (the server's figure)
        self.log = []
        self.honor_answer = None        # force the honor answer: ('state', s) or ('error', status, code)
        self.template_patch = {}

    def info(self):
        return {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'tracker_nft_id': NFT, 'denomination': DENOM,
                'features': self.features, 'novation': NOVATION}

    def view(self, g, who):
        out = json.loads(json.dumps(g))
        claimed = sum(c['amount'] for c in g['calls'] if c['state'] in ('open', 'issuing', 'failed', 'honored'))
        out.update(your_role=next((r for r in ('backer', 'issuer', 'creditor') if g['terms'][r]['id'] == IDS[who]), None),
                   claimed=claimed, honored=sum(c['amount'] for c in g['calls'] if c['state'] == 'honored'),
                   issuer_owes_creditor=self.owed, honor_within_hours=g['terms']['honor_within_hours'],
                   callable_now=max(0, min(g['terms']['cap']['amount'] - claimed, self.owed - claimed))
                   if g['state'] == 'active' and not any(c['state'] in ('open', 'failed') for c in g['calls']) else 0)
        return out

    def handle(self, who, method, path, body=None):
        self.log.append(f'{method} {path}')
        if method == 'GET' and path == '/pilot/v1/info':
            return self.info()
        if method == 'GET' and path == '/pilot/v1/participants':
            return [{'id': IDS[h], 'handle': h, 'status': 'active', 'pubkey': KEYS[h]['pubkey']} for h in IDS]
        for h in IDS:
            if method == 'GET' and path == f'/pilot/v1/participants/{IDS[h]}':
                return {'id': IDS[h], 'handle': h, 'status': 'active', 'pubkey': KEYS[h]['pubkey']}
        if method == 'GET' and path == '/pilot/v1/guarantees':
            return [self.view(g, who) for g in self.g.values() if IDS[who] in (g['terms'][r]['id'] for r in ('backer', 'issuer', 'creditor'))]
        if method == 'POST' and path == '/pilot/v1/guarantees':
            t, h = body['terms'], body['terms_hash']
            assert vc.terms_hash(t) == h and text_ok(KEYS[who]['pubkey'], vc.statement('guarantee-offer', h), body['signature'])
            g = {'guarantee_id': t['guarantee_id'], 'state': 'offered', 'terms': t, 'terms_hash': h, 'calls': [],
                 'offer': {'by': IDS[who], 'signature': body['signature']}, 'backer': {'id': t['backer']['id'], 'handle': 'bob'},
                 'issuer': {'id': t['issuer']['id'], 'handle': 'alice'}, 'creditor': {'id': t['creditor']['id'], 'handle': 'charlie'}}
            self.g[g['guarantee_id']] = g
            return self.view(g, who)
        parts = path.split('?')[0].split('/')
        if len(parts) >= 5 and parts[3] == 'guarantees' and parts[4] in self.g:
            g = self.g[parts[4]]
            h = g['terms_hash']
            rest = parts[5:]
            if method == 'GET' and not rest:
                return self.view(g, who)
            if method == 'POST' and rest in (['accept'], ['release'], ['withdraw']):
                kind = {'accept': 'guarantee-accept', 'release': 'guarantee-release', 'withdraw': 'guarantee-withdraw'}[rest[0]]
                if body['terms_hash'] != h or not text_ok(KEYS[who]['pubkey'], vc.statement(kind, h), body['signature']):
                    raise vc.ValunError('bad_signature', 'does not verify', 403)
                g['state'] = {'accept': 'active', 'release': 'released', 'withdraw': 'withdrawn'}[rest[0]]
                return self.view(g, who)
            if method == 'POST' and rest == ['decline']:
                assert text_ok(KEYS[who]['pubkey'], vc.statement('guarantee-decline', h, vc.sha256_hex(body['reason'])), body['signature'])
                g['state'] = 'declined'
                return self.view(g, who)
            if method == 'POST' and rest == ['calls']:
                assert text_ok(KEYS[who]['pubkey'], vc.statement('guarantee-call', h, body['call_id'], str(body['amount'])), body['signature'])
                g['calls'].append({'call_id': body['call_id'], 'amount': body['amount'], 'state': 'open', 'signature': body['signature'],
                                   'honor_by': '2099-01-01T00:00:00.000Z', 'overdue': False})
                return self.view(g, who)
            if len(rest) == 3 and rest[0] == 'calls' and rest[2] in ('note-template', 'honor'):
                c = next(x for x in g['calls'] if x['call_id'] == rest[1])
                pair = f"{BOB['pubkey']}>{CHARLIE['pubkey']}"
                cur = self.tracker.get(pair)
                if method == 'GET':
                    now = int(time.time() * 1000)
                    ts = (now - 1500) - (now - 1500 - 997) % 1000
                    prior = cur['total'] if cur else 0
                    tpl = {'guarantee_id': g['guarantee_id'], 'call_id': c['call_id'], 'terms_hash': h, 'amount': c['amount'],
                           'issuer_pubkey': BOB['pubkey'], 'recipient_pubkey': CHARLIE['pubkey'], 'prior_total': prior, 'total': prior + c['amount'],
                           'timestamp': ts, 'tracker_nft_id': NFT, 'denomination': DENOM, 'message_hex': '00',
                           'prior_note': dict(cur) if cur else None, 'prior_timestamp': cur['timestamp'] if cur else 0, 'prior_message_hex': '00'}
                    tpl.update(self.template_patch)
                    return tpl
                if self.honor_answer and self.honor_answer[0] == 'error':
                    raise vc.ValunError(self.honor_answer[2], 'forced', self.honor_answer[1])
                n = body['credit_note']
                prior, prior_ts = (cur['total'], cur['timestamp']) if cur else (0, 0)
                assert text_ok(BOB['pubkey'], vc.statement('guarantee-honor', h, c['call_id'], str(c['amount'])), body['signature'])
                assert vc.verify_note(BOB['pubkey'], CHARLIE['pubkey'], n['total'], n['timestamp'], n['signature'], NFT, DENOM)
                pa = vb.prior_ack_message(bytes.fromhex(BOB['pubkey']), bytes.fromhex(CHARLIE['pubkey']), prior, prior_ts, n['timestamp'],
                                          bytes.fromhex(NFT), DENOM)
                assert vb.verify(bytes.fromhex(n['prior_signature']), pa, bytes.fromhex(BOB['pubkey']))
                assert n['total'] == prior + c['amount'] and n['prior_total'] == prior and n['prior_timestamp'] == prior_ts
                state = self.honor_answer[1] if self.honor_answer else 'honored'
                c['state'] = state
                if state == 'honored':
                    self.tracker[pair] = {'total': n['total'], 'timestamp': n['timestamp'], 'signature': n['signature']}
                return self.view(g, who)
        raise vc.ValunError('not_found', f'no route {method} {path}', 404)


class WorldClient(vc.Client):
    def __init__(self, world, store):
        super().__init__(store, server=SERVER)
        self.world = world

    def request(self, method, path, body=None, auth=True, token=None):
        return self.world.handle(self.store.who, method, path, json.loads(json.dumps(body)) if body is not None else None)


def client(w, who):
    return WorldClient(w, MemStore(who))


def offered(w, **kw):
    """bob offers a guarantee of alice's debt to charlie; returns its id."""
    r = client(w, 'bob').offer_guarantee(IDS['alice'], IDS['charlie'], kw.pop('cap', 5), kw.pop('due_in_hours', 0), **kw)
    return r['guarantee_id']


class Offer(unittest.TestCase):
    def test_terms_name_the_three_registered_keys_and_are_signed(self):
        w = World()
        gid = offered(w, callable_for_hours=1, offer_valid_hours=24, note='for alice')
        g = w.g[gid]
        t = g['terms']
        self.assertEqual(t['protocol'], 'valun-guarantee/1')
        self.assertEqual((t['backer']['pubkey'], t['issuer']['pubkey'], t['creditor']['pubkey']), (BOB['pubkey'], ALICE['pubkey'], CHARLIE['pubkey']))
        self.assertEqual((t['cap'], t['covers'], t['honor_within_hours'], t['note']), ({'amount': 5, 'unit': 'PC'}, 'issuer_debt_to_creditor', 24, 'for alice'))
        self.assertEqual(t['offer_expires_at'], t['expires_at'], 'the offer never stays open past the expiry')
        self.assertRegex(gid, r'^vg_[0-9a-f]{16}$')

    def test_bad_arguments_and_a_server_without_guarantees_sign_nothing(self):
        w = World()
        c = client(w, 'bob')
        for kw in ({'cap': 0}, {'due_in_hours': -1}, {'callable_for_hours': 0}, {'honor_within_hours': 200}):
            args = dict({'cap': 5, 'due_in_hours': 0}, **kw)
            with self.assertRaises(vc.ValunError) as e:
                c.offer_guarantee(IDS['alice'], IDS['charlie'], args.pop('cap'), args.pop('due_in_hours'), **args)
            self.assertEqual(e.exception.code, 'bad_arguments', kw)
        with self.assertRaises(vc.ValunError) as e:
            c.offer_guarantee(IDS['charlie'], IDS['charlie'], 5, 0)
        self.assertEqual(e.exception.code, 'bad_arguments')
        w.features = ['bound_notes/1', 'circulation/1']
        with self.assertRaises(vc.ValunError) as e:
            client(w, 'bob').offer_guarantee(IDS['alice'], IDS['charlie'], 5, 0)
        self.assertEqual(e.exception.code, 'feature_unavailable')
        self.assertEqual(w.g, {})


class DealMode(unittest.TestCase):
    """Fix inbox #29: a guarantee that names the deals it backs (covers issuer_payment_for_deals)."""
    DEALS = ['vd_' + '1' * 16, 'vd_' + '2' * 16]

    def test_the_terms_name_the_deals_and_the_creditor_accepts_them(self):
        w = World()
        gid = offered(w, deals=list(self.DEALS))
        t = w.g[gid]['terms']
        self.assertEqual((t['covers'], t['deals']), ('issuer_payment_for_deals', self.DEALS))
        self.assertEqual(client(w, 'charlie').accept_guarantee(gid)['state'], 'active')

    def test_bad_deal_lists_sign_nothing(self):
        w = World()
        c = client(w, 'bob')
        for deals in ([], ['vd_123'], [self.DEALS[0], self.DEALS[0]], ['vd_' + '1' * 16] * 11, 'vd_' + '1' * 16, [7]):
            with self.assertRaises(vc.ValunError) as e:
                c.offer_guarantee(IDS['alice'], IDS['charlie'], 5, 0, deals=deals)
            self.assertEqual(e.exception.code, 'bad_arguments', deals)
        self.assertEqual(w.g, {})

    def test_the_creditor_refuses_deals_in_the_floating_mode_and_a_deal_mode_without_them(self):
        for tamper in (lambda g: _rehash(g, deals=['vd_' + '3' * 16]),
                       lambda g: (_rehash(g, covers='issuer_payment_for_deals'))):
            w = World()
            gid = offered(w)
            tamper(w.g[gid])
            with self.assertRaises(vc.ValunError) as e:
                client(w, 'charlie').accept_guarantee(gid)
            self.assertEqual(e.exception.code, 'bad_terms')
            self.assertEqual(w.g[gid]['state'], 'offered')


class CreditorChecks(unittest.TestCase):
    def test_accept_checks_the_terms_and_the_backers_signature_first(self):
        for tamper, code in ((lambda g: g['terms'].update(cap={'amount': 50, 'unit': 'PC'}), 'hash_mismatch'),
                             (lambda g: g['offer'].update(signature=sign_text(MALLORY, vc.statement('guarantee-offer', g['terms_hash']))), 'bad_signature'),
                             (lambda g: _rehash(g, network='valun-testnet-1'), 'wrong_network'),
                             (lambda g: _rehash(g, covers='anything'), 'bad_terms'),
                             (lambda g: _rehash(g, creditor={'id': IDS['alice'], 'pubkey': ALICE['pubkey']}), 'not_a_party')):
            w = World()
            gid = offered(w)
            tamper(w.g[gid])
            with self.assertRaises(vc.ValunError) as e:
                client(w, 'charlie').accept_guarantee(gid)
            self.assertEqual(e.exception.code, code)
            self.assertEqual(w.g[gid]['state'], 'offered', code)
        w = World()
        gid = offered(w)
        with self.assertRaises(vc.ValunError) as e:
            client(w, 'charlie').accept_guarantee(gid, expected_terms_hash='ab' * 32)
        self.assertEqual(e.exception.code, 'stale_terms')
        self.assertEqual(client(w, 'charlie').accept_guarantee(gid)['state'], 'active')

    def test_call_claims_what_is_callable_and_nothing_when_nothing_is(self):
        w = World()
        gid = offered(w, cap=5)
        client(w, 'charlie').accept_guarantee(gid)
        with self.assertRaises(vc.ValunError) as e:
            client(w, 'charlie').call_guarantee(gid)
        self.assertEqual(e.exception.code, 'nothing_callable')
        w.owed = 7
        r = client(w, 'charlie').call_guarantee(gid)
        self.assertEqual([(c['amount'], c['state']) for c in r['calls']], [(5, 'open')], 'the cap, though alice owes 7')
        with self.assertRaises(vc.ValunError) as e:
            client(w, 'bob').call_guarantee(gid)
        self.assertEqual(e.exception.code, 'not_a_party')


def _rehash(g, **changes):
    g['terms'].update(changes)
    g['terms_hash'] = vc.terms_hash(g['terms'])
    g['offer']['signature'] = sign_text(BOB, vc.statement('guarantee-offer', g['terms_hash']))


def called(w, cap=5, owed=7, amount=None):
    gid = offered(w, cap=cap)
    client(w, 'charlie').accept_guarantee(gid)
    w.owed = owed
    client(w, 'charlie').call_guarantee(gid, amount)
    return gid


class Honor(unittest.TestCase):
    PAIR = f"{BOB['pubkey']}>{CHARLIE['pubkey']}"

    def test_a_bound_note_for_exactly_the_call_is_written_ahead_then_confirmed(self):
        w = World()
        gid = called(w)
        s = MemStore('bob')
        r = WorldClient(w, s).honor_guarantee(gid)
        self.assertEqual([c['state'] for c in r['calls']], ['honored'])
        edge = w.tracker[self.PAIR]
        self.assertEqual((edge['total'], edge['timestamp'] % 1000), (5, 997))
        rec = records.get(s.state['records'], self.PAIR)
        self.assertEqual(rec['confirmed'], edge)
        self.assertEqual(rec['pending'], [])
        cid = r['calls'][0]['call_id']
        self.assertEqual(s.state['guarantee_honors'][gid], {'cap': 5, 'calls': {cid: {'amount': 5, 'state': 'honored', 'total': 5, 'timestamp': edge['timestamp']}}})
        signed = s.state['signed'][self.PAIR][str(edge['timestamp'])]
        self.assertEqual(signed['op'], 'guarantee_note:' + cid)
        self.assertEqual(signed['prior_state'], {'total': 0, 'timestamp': 0})
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).honor_guarantee(gid, cid)
        self.assertEqual(e.exception.code, 'already_honored')

    def test_refusals_before_anything_is_signed(self):
        cases = [
            ('a call the creditor did not sign', lambda w, gid, s: w.g[gid]['calls'][0].update(signature=sign_text(MALLORY, 'x')), 'bad_signature'),
            ('a template for another amount', lambda w, gid, s: w.template_patch.update(amount=6, total=6), 'bad_template'),
            ('a template for another key', lambda w, gid, s: w.template_patch.update(recipient_pubkey=MALLORY['pubkey']), 'bad_template'),
            ('an ordinary timestamp', lambda w, gid, s: w.template_patch.update(timestamp=int(time.time() * 1000) // 1000 * 1000 - 2000), 'bad_template'),
            ('a prior note that is not mine', lambda w, gid, s: _foreign_prior(w), 'ledger_mismatch'),
            ('a cap my own records say is spent', lambda w, gid, s: s.state.update(guarantee_honors={gid: {'cap': 5, 'calls': {'vgc_' + '1' * 16: {'amount': 1, 'state': 'honored'}}}}), 'exceeds_cap'),
        ]
        for name, prepare, code in cases:
            w = World()
            gid = called(w)
            s = MemStore('bob')
            prepare(w, gid, s)
            before, edge = json.dumps(s.state.get('signed')), json.dumps(w.tracker.get(self.PAIR))
            with self.assertRaises(vc.ValunError) as e:
                WorldClient(w, s).honor_guarantee(gid)
            self.assertEqual(e.exception.code, code, name)
            self.assertEqual(json.dumps(s.state.get('signed')), before, f'{name}: nothing recorded as signed')
            self.assertEqual(json.dumps(w.tracker.get(self.PAIR)), edge, f'{name}: the edge did not move')

    def test_refused_is_forgotten_no_answer_stays_pending_and_a_note_that_may_have_applied_is_never_followed(self):
        w = World()
        gid = called(w)
        s = MemStore('bob')
        w.honor_answer = ('error', 409, 'stale_note')
        with self.assertRaises(vc.ValunError):
            WorldClient(w, s).honor_guarantee(gid)
        self.assertEqual(records.get(s.state['records'], self.PAIR)['pending'], [])
        self.assertEqual([c['state'] for c in s.state['guarantee_honors'][gid]['calls'].values()], ['failed'])
        w.honor_answer = ('error', None, 'unreachable')
        with self.assertRaises(vc.ValunError):
            WorldClient(w, s).honor_guarantee(gid)
        pending = records.get(s.state['records'], self.PAIR)['pending']
        self.assertEqual([(p['kind'], p['total']) for p in pending], [('guarantee_note', 5)])
        # The edge reached that note's total meanwhile (it may be the note): never another for the same call.
        w.tracker[self.PAIR] = {'total': 5, 'timestamp': pending[0]['timestamp'] - 1, 'signature': vb.sign(
            vb.note_message(bytes.fromhex(BOB['pubkey']), bytes.fromhex(CHARLIE['pubkey']), 5, pending[0]['timestamp'] - 1, bytes.fromhex(NFT), DENOM),
            BOB['secret'], bytes.fromhex(BOB['pubkey'])).hex()}
        w.honor_answer = None
        with self.assertRaises(vc.ValunError) as e:
            WorldClient(w, s).honor_guarantee(gid)
        self.assertEqual(e.exception.code, 'honor_pending')


def _foreign_prior(w):
    ts = int(time.time() * 1000) - 60000
    w.tracker[f"{BOB['pubkey']}>{CHARLIE['pubkey']}"] = {'total': 1, 'timestamp': ts, 'signature': sign_text(MALLORY, 'not a note')}


class Tools(unittest.TestCase):
    def agent(self, w, who):
        a = va.ValunAgent(store=MemStore(who))
        a.client = lambda require_connection=True: client_for(w, a.store)
        return a

    def test_classification_and_approval_texts(self):
        a = va.ValunAgent(store=None)
        self.assertFalse(a.is_commitment('valun_guarantees', {}))
        self.assertFalse(a.is_commitment('valun_call_guarantee', {'guarantee_id': 'vg_' + '0' * 16}))
        for action, commits in (('accept', False), ('decline', False), ('withdraw', False), ('release', True), ('honor', True), ('Accept', True)):
            self.assertEqual(a.is_commitment('valun_respond_guarantee', {'guarantee_id': 'vg_' + '0' * 16, 'action': action}), commits, action)
        self.assertTrue(a.is_commitment('valun_offer_guarantee', {}))
        w = World()
        p = self.agent(w, 'bob').prepare('valun_offer_guarantee', {'issuer': 'alice', 'creditor': 'charlie', 'cap': 5, 'due_in_hours': 48})
        self.assertEqual((p['args']['issuer'], p['args']['creditor']), (IDS['alice'], IDS['charlie']), 'pinned to the participants shown')
        self.assertIn('sign a GUARANTEE: back what alice', p['text'])
        self.assertIn('up to 5 PC in all', p['text'])
        gid = called(w)
        p = self.agent(w, 'bob').prepare('valun_respond_guarantee', {'guarantee_id': gid, 'action': 'honor'})
        self.assertEqual(p['args']['expected_terms_hash'], w.g[gid]['terms_hash'])
        self.assertEqual(p['args']['call_id'], w.g[gid]['calls'][0]['call_id'])
        self.assertIn('ISSUE A CREDIT NOTE of 5 PC to charlie', p['text'])
        p = self.agent(w, 'charlie').prepare('valun_respond_guarantee', {'guarantee_id': gid, 'action': 'release'})
        self.assertIn('RELEASE guarantee', p['text'])
        self.assertIn('1 unhonored call(s) end too', p['text'])
        self.assertIsNone(self.agent(w, 'charlie').prepare('valun_respond_guarantee', {'guarantee_id': gid, 'action': 'accept'})['text'])

    def test_the_tools_end_to_end(self):
        w = World()
        out = self.agent(w, 'bob').call('valun_offer_guarantee', {'issuer': 'alice', 'creditor': 'charlie', 'cap': 5, 'due_in_hours': 0})
        gid = out['guarantee']['guarantee_id']
        self.assertIn('charlie can accept or decline it', out['what_happens_next'])
        self.assertEqual(self.agent(w, 'charlie').call('valun_respond_guarantee', {'guarantee_id': gid, 'action': 'accept'})['guarantee']['state'], 'active')
        w.owed = 3
        r = self.agent(w, 'charlie').call('valun_call_guarantee', {'guarantee_id': gid})
        self.assertEqual([c['amount'] for c in r['guarantee']['calls']], [3])
        listed = self.agent(w, 'bob').call('valun_guarantees', {})
        self.assertEqual([(g['guarantee_id'], g['your_role'], g['callable_now']) for g in listed['guarantees']], [(gid, 'backer', 0)])
        one = self.agent(w, 'bob').call('valun_guarantees', {'guarantee_id': gid})
        self.assertEqual(one['checked_by_your_client']['backer_signature_valid'], True)
        h = self.agent(w, 'bob').call('valun_respond_guarantee', {'guarantee_id': gid, 'action': 'honor'})
        self.assertEqual([c['state'] for c in h['guarantee']['calls']], ['honored'])
        with self.assertRaises(vc.ValunError) as e:
            self.agent(w, 'bob').call('valun_respond_guarantee', {'guarantee_id': 'vg_x', 'action': 'honor'})
        self.assertEqual(e.exception.code, 'bad_arguments')

    def test_status_lists_what_waits(self):
        self.assertIsNone(va.guarantees_waiting(None))
        self.assertIsNone(va.guarantees_waiting({'to_answer': [], 'to_honor': [], 'active': [{'your_role': 'creditor', 'due': False}]}))
        w = va.guarantees_waiting({'to_answer': [{'guarantee_id': 'vg_1', 'backer': 'bob', 'issuer': 'alice', 'cap': 5, 'due_at': 'd', 'expires_at': 'e', 'x': 1}],
                                   'to_honor': [], 'active': [{'guarantee_id': 'vg_2', 'your_role': 'creditor', 'due': True, 'call_open': False}]})
        self.assertEqual([x['guarantee_id'] for x in w['to_answer']], ['vg_1'])
        self.assertEqual([x['guarantee_id'] for x in w['due']], ['vg_2'])
        self.assertNotIn('x', w['to_answer'][0])
        self.assertIn('valun_call_guarantee', w['how'])
        self.assertEqual(va.brief_status({'guarantees_waiting': w})['guarantees_waiting'], w)


def client_for(w, store):
    return WorldClient(w, store)


if __name__ == '__main__':
    unittest.main()
