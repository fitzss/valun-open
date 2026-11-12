"""valun.ergo: settlement on Ergo testnet for the Valun testnet network. The address, the context-extension order and
the checks are plain Python and always tested; building and signing use ergo-lib (an optional dependency): those
tests run where ergo-lib-python is installed and are skipped elsewhere (CI installs nothing). The JS client's
js/test/ergo.test.js is the same suite (and verifies the proofs with ergo-lib's verifier)."""
import copy
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import basis as vb  # noqa: E402
from valun import ergo  # noqa: E402
from valun.client import ValunError  # noqa: E402

G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
NFT = 'ab' * 32
AVL = '64' + '00' * 33 + '0320' + '00'
try:
    E = ergo.ergo_lib()
except ValunError:
    E = None


def secret_of(n):
    return bytes([0x11] * 31 + [n]).hex()


def pub_of(s):
    return vb.public_key(bytes.fromhex(s)).hex()


class Plain(unittest.TestCase):
    def test_address_and_tree_vectors_from_ergo_lib(self):
        self.assertEqual(ergo.p2pk_address(G), '3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsN')
        self.assertEqual(ergo.p2pk_address(G, testnet=False), '9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV')
        self.assertEqual(ergo.p2pk_tree(G), '0008cd' + G)
        for bad in ('', '04' + 'aa' * 32, G.upper(), G[2:], None):
            with self.assertRaises(ValunError) as e:
                ergo.p2pk_tree(bad)
            self.assertEqual(e.exception.code, 'invalid_field')

    def test_scala_order_the_trackers_vectors(self):
        self.assertEqual(ergo.scala_extension_order([0, 1, 2, 3, 4, 5, 6, 8]), [0, 5, 1, 6, 2, 3, 8, 4])
        self.assertEqual(ergo.scala_extension_order(range(9)), [0, 5, 1, 6, 2, 7, 3, 8, 4])
        self.assertEqual(ergo.scala_extension_order([8, 6, 5, 4, 3, 2, 1, 0]), [0, 5, 1, 6, 2, 3, 8, 4])
        ext = {str(k): f'0e0{k}' for k in (0, 1, 2, 3, 4, 5, 6, 8)}
        self.assertEqual(ergo.to_ergo_json({'inputs': [{'boxId': 'r', 'extension': ext}]}),
                         '{"inputs":[{"boxId":"r","extension":{"0":"0e00","5":"0e05","1":"0e01","6":"0e06","2":"0e02","3":"0e03","8":"0e08","4":"0e04"}}]}')
        self.assertEqual(ergo.to_ergo_json({'extension': {'a': 1, '0': 2}, 'other': {'5': 'x', '0': 'y'}}),
                         '{"extension":{"a":1,"0":2},"other":{"5":"x","0":"y"}}', 'only an extension of byte keys is reordered')

    def test_a_reserve_request_is_checked_before_anything_is_signed(self):
        pk, nft_id = pub_of(secret_of(1)), 'cd' * 32
        good = {'requests': [{'address': 'RESERVE', 'value': 50_000_000, 'assets': [{'token_id': nft_id, 'amount': 1}],
                              'registers': {'R4': '07' + pk, 'R5': '64', 'R6': '0e20' + NFT}}]}
        kw = dict(erg_amount=50_000_000, nft_id=nft_id, pubkey_hex=pk, tracker_nft_id=NFT, reserve_contract='RESERVE')
        self.assertEqual(ergo.check_reserve_payload(good, **kw)['assets'], [{'tokenId': nft_id, 'amount': 1}])
        for change, words in [(lambda r, p: r.update(value=50_000_001), 'locks 50000001'), (lambda r, p: r.update(address='OTHER'), 'reserve contract'),
                              (lambda r, p: r.update(assets=[]), 'exactly one token'), (lambda r, p: r['assets'][0].update(amount=2), 'exactly one token'),
                              (lambda r, p: r['assets'][0].update(token_id='ee' * 32), 'first input'),
                              (lambda r, p: r['registers'].update(R4='07' + G), 'R4 is not'), (lambda r, p: r['registers'].update(R6='0e20' + '00' * 32), 'tracker NFT'),
                              (lambda r, p: p['requests'].append(r), 'exactly one output')]:
            p = copy.deepcopy(good)
            change(p['requests'][0], p)
            with self.assertRaises(ValunError) as e:
                ergo.check_reserve_payload(p, **kw)
            self.assertEqual(e.exception.code, 'bad_payload')
            self.assertIn(words, str(e.exception))

    def test_the_node_must_be_a_testnet_node(self):
        def opener(network):
            class R(io.BytesIO):
                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False
            return lambda req, timeout=None: R(json.dumps({'network': network}).encode())
        ergo.Node('http://test.node', opener=opener('testnet')).assert_testnet()
        with self.assertRaises(ValunError) as e:
            ergo.Node('http://main.node', opener=opener('mainnet')).assert_testnet()
        self.assertEqual(e.exception.code, 'not_testnet')
        with self.assertRaises(ValunError):
            ergo.Node('file:///x')

    def test_without_ergo_lib_the_settlement_calls_say_how_to_install_it(self):
        if E is not None:
            self.skipTest('ergo-lib-python is installed here')
        with self.assertRaises(ValunError) as e:
            ergo.ergo_lib()
        self.assertEqual(e.exception.code, 'ergo_lib_missing')
        self.assertIn('pip install ergo-lib-python==0.28.0', str(e.exception))


def headers():
    base = {'extensionId': '00' * 32, 'difficulty': '1', 'votes': '000000', 'timestamp': 1_731_400_000_000, 'size': 221, 'unparsedBytes': '',
            'stateRoot': '00' * 33, 'height': 639_650, 'nBits': 117_811_961, 'version': 3, 'id': '', 'adProofsRoot': '00' * 32,
            'transactionsRoot': '00' * 32, 'extensionHash': '00' * 32, 'powSolutions': {'pk': G, 'w': G, 'n': '0000000000000000', 'd': 0},
            'adProofsId': '00' * 32, 'transactionsId': '00' * 32, 'parentId': '00' * 32}
    return [{**base, 'height': base['height'] + i, 'id': f'{i + 1:064x}', 'parentId': f'{i:064x}', 'timestamp': base['timestamp'] + i * 120_000}
            for i in range(10)]


def box_at(tree, value, tx_id='11' * 32, index=0, registers=None, tokens=()):
    c = E.chain
    regs = {getattr(c.NonMandatoryRegisterId, r): c.Constant.from_bytes(bytes.fromhex(h)) for r, h in (registers or {}).items()}
    cand = c.ErgoBoxCandidate(value=value, script=__import__('ergo_lib_python').ergo_tree.ErgoTree.from_bytes(bytes.fromhex(tree)), creation_height=639_600,
        tokens=[c.Token(c.TokenId(t), a) for t, a in tokens] or None, registers=regs or None)
    box = c.ErgoBox.from_box_candidate(cand, E.transaction.TxId(tx_id), index)
    return box, json.loads(box.json()), bytes(box).hex()


@unittest.skipIf(E is None, 'ergo-lib-python is not installed')
class WithErgoLib(unittest.TestCase):
    def test_build_reserve_plain_boxes_the_checked_request_output_0_a_proof_per_input(self):
        secret = secret_of(2)
        pk = pub_of(secret)
        tree = ergo.p2pk_tree(pk)
        a = box_at(tree, 300_000_000, tx_id='21' * 32)
        b = box_at(tree, 40_000_000, tx_id='22' * 32)
        tok = box_at(tree, 900_000_000, tx_id='23' * 32, tokens=[('ef' * 32, 5)])
        reserve_tree = '10010101d17300'
        reserve_address = E.chain.Address.recreate_from_ergo_tree(__import__('ergo_lib_python').ergo_tree.ErgoTree.from_bytes(bytes.fromhex(reserve_tree))).to_str(E.chain.NetworkPrefix.Testnet)
        by_id = {x[1]['boxId']: x for x in (a, b, tok)}
        hs = headers()

        class FakeNode:
            def assert_testnet(self):
                return {'network': 'testnet'}

            def last_headers(self, n):
                return hs

            def unspent_by_address(self, addr):
                assert addr == ergo.p2pk_address(pk)
                return [b[1], tok[1], a[1]]

            def box_binary(self, box_id):
                return by_id[box_id][2]
        asked = []

        def payload_for(nft_id):
            asked.append(nft_id)
            return {'requests': [{'address': reserve_address, 'value': 250_000_000, 'assets': [{'token_id': nft_id, 'amount': 1}],
                                  'registers': {'R4': '07' + pk, 'R5': AVL, 'R6': '0e20' + NFT}}]}
        r = ergo.build_reserve(secret_hex=secret, pubkey_hex=pk, erg_amount=250_000_000, node=FakeNode(), payload_for=payload_for,
                               tracker_nft_id=NFT, reserve_contract=reserve_address)
        self.assertEqual(asked, [a[1]['boxId']], 'the reserve NFT id is the first input: the largest plain box')
        self.assertEqual([i['boxId'] for i in r['signed']['inputs']], [a[1]['boxId']], 'the token box is never spent')
        self.assertEqual(len(r['signed']['inputs'][0]['spendingProof']['proofBytes']), 112, 'a proveDlog proof (56 bytes)')
        reserve, fee, change = r['signed']['outputs']
        self.assertEqual((reserve['ergoTree'], int(reserve['value'])), (reserve_tree, 250_000_000))
        self.assertEqual([(t['tokenId'], int(t['amount'])) for t in reserve['assets']], [(a[1]['boxId'], 1)])
        self.assertEqual((fee['ergoTree'], int(fee['value'])), (ergo.MINER_FEE_TREE, ergo.FEE))
        self.assertEqual((change['ergoTree'], int(change['value'])), (tree, 300_000_000 - 250_000_000 - ergo.FEE))
        with self.assertRaises(ValunError) as e:
            ergo.build_reserve(secret_hex=secret, pubkey_hex=pk, erg_amount=400_000_000, node=FakeNode(), payload_for=payload_for,
                               tracker_nft_id=NFT, reserve_contract=reserve_address)
        self.assertEqual(e.exception.code, 'unfunded')

    def fixture(self, amount=20_000_000):
        issuer, rsecret, tsecret = pub_of(secret_of(3)), secret_of(4), secret_of(5)
        recipient, tracker = pub_of(rsecret), pub_of(tsecret)
        reserve_tree = f'100108cd{recipient}7300'                 # a stand-in reserve script: proveDlog(receiver), segregated
        reserve = box_at(reserve_tree, 100_000_000, tx_id='31' * 32, registers={'R4': '07' + issuer, 'R5': AVL, 'R6': '0e20' + NFT}, tokens=[('77' * 32, 1)])
        fee_box = box_at(ergo.p2pk_tree(tracker), 50_000_000, tx_id='32' * 32)
        tracker_box = box_at(ergo.p2pk_tree(tracker), 10_000_000, tx_id='33' * 32, tokens=[(NFT, 1)])
        ext = {str(k): ('0200' if k == 0 else '07' + recipient if k == 1 else f'0e01{k * 17:02x}') for k in (0, 1, 2, 3, 4, 5, 6, 8)}
        unsigned_tx = {'inputs': [{'boxId': reserve[1]['boxId'], 'extension': ext}, {'boxId': fee_box[1]['boxId'], 'extension': {}}],
                       'dataInputs': [{'boxId': tracker_box[1]['boxId']}],
                       'outputs': [{'value': 100_000_000 - amount, 'ergoTree': reserve_tree, 'creationHeight': 639_650, 'assets': [{'tokenId': '77' * 32, 'amount': 1}],
                                    'additionalRegisters': {'R4': '07' + issuer, 'R5': AVL, 'R6': '0e20' + NFT}},
                                   {'value': amount, 'ergoTree': ergo.p2pk_tree(recipient), 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}},
                                   {'value': ergo.FEE, 'ergoTree': ergo.MINER_FEE_TREE, 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}},
                                   {'value': 50_000_000 - ergo.FEE, 'ergoTree': ergo.p2pk_tree(tracker), 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}}]}
        hs = headers()
        unsigned = E.transaction.UnsignedTransaction.from_json(ergo.to_ergo_json(unsigned_tx))
        w = E.wallet.Wallet([E.wallet.SecretKey.from_bytes(bytes.fromhex(tsecret))])
        fi = w.sign_tx_input(unsigned, 1, [reserve[0], fee_box[0]], [tracker_box[0]], ergo.state_context(E, hs))
        outputs = [json.loads(o.json()) for o in unsigned.outputs]
        partial_tx = {'id': str(unsigned.id), 'inputs': [{'boxId': reserve[1]['boxId'], 'spendingProof': {'proofBytes': '', 'extension': ext}},
                                                         {'boxId': str(fi.box_id), 'spendingProof': json.loads(fi.spending_proof.json())}],
                      'dataInputs': unsigned_tx['dataInputs'], 'outputs': outputs}
        built = json.loads(json.dumps({'issuer': {'pubkey': issuer}, 'unsigned_tx': unsigned_tx, 'partial_tx': partial_tx,
                                       'input_box_binaries': [reserve[2], fee_box[2]], 'data_box_binaries': [tracker_box[2]], 'headers': hs}))
        return dict(built=built, issuer=issuer, recipient=recipient, rsecret=rsecret, reserve_tree=reserve_tree, amount=amount, unsigned_id=str(unsigned.id))

    def test_check_redemption_signs_only_the_issuers_reserve_paying_exactly_the_amount(self):
        f = self.fixture()
        kw = dict(issuer_pubkey=f['issuer'], recipient_pubkey=f['recipient'], amount=f['amount'], tracker_nft_id=NFT, reserve_tree=f['reserve_tree'])
        self.assertEqual(ergo.check_redemption(E, f['built'], **kw)['paid_nanoerg'], f['amount'])

        def refused(change, words, **over):
            b = copy.deepcopy(f['built'])
            change(b)
            with self.assertRaises(ValunError) as e:
                ergo.check_redemption(E, b, **{**kw, **over})
            self.assertEqual(e.exception.code, 'bad_redemption')
            self.assertIn(words, str(e.exception))
        refused(lambda b: b['unsigned_tx']['outputs'][1].update(value=f['amount'] - 1), 'pays exactly')
        refused(lambda b: b['unsigned_tx']['outputs'][0].update(value=100_000_000 - f['amount'] - 1), 'output 0 is not the reserve')
        refused(lambda b: b['unsigned_tx']['outputs'][0]['additionalRegisters'].update(R4='07' + G), 'owner or tracker')
        refused(lambda b: b['unsigned_tx']['outputs'][0].update(assets=[]), 'tokens')
        refused(lambda b: b['unsigned_tx']['inputs'][0]['extension'].update({'1': '07' + G}), 'receiver')
        refused(lambda b: b['unsigned_tx']['inputs'][0]['extension'].update({'0': '0201'}), 'redeem action')
        refused(lambda b: b['unsigned_tx']['inputs'].reverse(), 'not the box given')
        refused(lambda b: None, "not the issuer's reserve", issuer_pubkey=G)
        refused(lambda b: None, 'tracker', tracker_nft_id='00' * 32)
        refused(lambda b: None, 'reserve contract', reserve_tree='10010101d17300')
        own = box_at(ergo.p2pk_tree(f['recipient']), 5_000_000, tx_id='34' * 32)

        def own_input(b):
            b['unsigned_tx']['inputs'][1] = {'boxId': own[1]['boxId'], 'extension': {}}
            b['input_box_binaries'][1] = own[2]
        refused(own_input, "box of this agent's own")

    def test_sign_redemption_splices_the_proof_into_the_trackers_transaction(self):
        f = self.fixture()
        signed = ergo.sign_redemption(f['built'], f['rsecret'])
        self.assertEqual(signed['id'], f['unsigned_id'])
        self.assertEqual(len(signed['inputs'][0]['spendingProof']['proofBytes']), 112)
        self.assertEqual(signed['inputs'][1], f['built']['partial_tx']['inputs'][1], "the tracker's fee proof is kept")
        self.assertEqual(f['built']['partial_tx']['inputs'][0]['spendingProof']['proofBytes'], '', 'the given transaction is not changed')
        tx = E.transaction.Transaction.from_json(ergo.to_ergo_json(signed))
        self.assertEqual(str(tx.id), f['unsigned_id'])
        sorted_built = copy.deepcopy(f['built'])
        sorted_built['unsigned_tx']['inputs'][0]['extension'] = dict(sorted(sorted_built['unsigned_tx']['inputs'][0]['extension'].items()))
        self.assertEqual(str(E.transaction.UnsignedTransaction.from_json(json.dumps(sorted_built['unsigned_tx'])).id) != f['unsigned_id'], True,
                         'with the keys in sorted order it would be another transaction')
        self.assertEqual(ergo.sign_redemption(sorted_built, f['rsecret'])['id'], f['unsigned_id'], 'to_ergo_json restores the order before signing')
        broken = copy.deepcopy(f['built'])
        broken['partial_tx']['inputs'] = broken['partial_tx']['inputs'][1:]
        with self.assertRaises(ValunError) as e:
            ergo.sign_redemption(broken, f['rsecret'])
        self.assertEqual(e.exception.code, 'bad_redemption')


if __name__ == '__main__':
    unittest.main()
