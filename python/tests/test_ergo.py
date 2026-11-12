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


    def test_the_native_transaction_id_is_ergo_libs(self):
        unsigned = E.transaction.UnsignedTransaction.from_json(ergo.to_ergo_json(VEC_TX))
        self.assertEqual(str(unsigned.id), ergo.tx_id(VEC_TX))


# ---------- redemption: the bytes to sign, the proof, the checks (plain Python, no ergo-lib) ----------
# A transaction id computed by ergo-lib 0.28.0 for this exact transaction (tokens, registers, an 8-key context
# extension written in Scala's order, a data input): the native serialization must give the same id.
VEC_TX = {'inputs': [{'boxId': 'aa' * 32, 'extension': {'0': '0200', '1': '07' + G, '2': '0e0101', '3': '0580897a', '4': '05a09c01',
                                                         '5': '0e0105', '6': '0e00', '8': '0e0108'}}, {'boxId': 'bb' * 32, 'extension': {}}],
          'dataInputs': [{'boxId': 'cc' * 32}],
          'outputs': [{'value': 197000000, 'ergoTree': '0008cd' + G, 'creationHeight': 639900, 'assets': [{'tokenId': 'dd' * 32, 'amount': 1}],
                       'additionalRegisters': {'R4': '07' + G, 'R5': '64' + '00' * 33 + '032000', 'R6': '0e20' + 'ee' * 32}},
                      {'value': 3000000, 'ergoTree': '0008cd' + G, 'creationHeight': 639900, 'assets': [], 'additionalRegisters': {}}]}


def redemption(amount=20_000_000):
    """A redemption as the tracker builds it (a stand-in reserve tree; the checks read the boxes as the node reports
    them), with its partly signed transaction."""
    issuer, rsecret, tsecret = pub_of(secret_of(3)), secret_of(4), secret_of(5)
    recipient, tracker = pub_of(rsecret), pub_of(tsecret)
    reserve_tree = f'100108cd{recipient}7300'
    reserve_box = {'boxId': '31' * 32, 'value': 100_000_000, 'ergoTree': reserve_tree, 'assets': [{'tokenId': '77' * 32, 'amount': 1}],
                   'additionalRegisters': {'R4': '07' + issuer, 'R5': AVL, 'R6': '0e20' + NFT}}
    fee_box = {'boxId': '32' * 32, 'value': 50_000_000, 'ergoTree': ergo.p2pk_tree(tracker), 'assets': [], 'additionalRegisters': {}}
    ext = {str(k): ('0200' if k == 0 else '07' + recipient if k == 1 else f'0e01{k * 17:02x}') for k in (0, 1, 2, 3, 4, 5, 6, 8)}
    unsigned_tx = {'inputs': [{'boxId': reserve_box['boxId'], 'extension': ext}, {'boxId': fee_box['boxId'], 'extension': {}}],
                   'dataInputs': [{'boxId': '33' * 32}],
                   'outputs': [{'value': 100_000_000 - amount, 'ergoTree': reserve_tree, 'creationHeight': 639_650, 'assets': [{'tokenId': '77' * 32, 'amount': 1}],
                                'additionalRegisters': {'R4': '07' + issuer, 'R5': AVL, 'R6': '0e20' + NFT}},
                               {'value': amount, 'ergoTree': ergo.p2pk_tree(recipient), 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}},
                               {'value': ergo.FEE, 'ergoTree': ergo.MINER_FEE_TREE, 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}},
                               {'value': 50_000_000 - ergo.FEE, 'ergoTree': ergo.p2pk_tree(tracker), 'creationHeight': 639_650, 'assets': [], 'additionalRegisters': {}}]}
    tid = ergo.tx_id(unsigned_tx)
    fee_proof = vb.ergo_prove_dlog(ergo.tx_bytes_to_sign(unsigned_tx), bytes.fromhex(tsecret)).hex()
    partial_tx = {'id': tid, 'inputs': [{'boxId': reserve_box['boxId'], 'spendingProof': {'proofBytes': '', 'extension': ext}},
                                        {'boxId': fee_box['boxId'], 'spendingProof': {'proofBytes': fee_proof, 'extension': {}}}],
                  'dataInputs': unsigned_tx['dataInputs'],
                  'outputs': [{**o, 'boxId': str(i) * 64, 'transactionId': tid, 'index': i} for i, o in enumerate(unsigned_tx['outputs'])]}
    built = json.loads(json.dumps({'issuer': {'pubkey': issuer}, 'unsigned_tx': unsigned_tx, 'partial_tx': partial_tx}))
    return dict(built=built, issuer=issuer, recipient=recipient, rsecret=rsecret, reserve_tree=reserve_tree, amount=amount,
                input_boxes=[reserve_box, fee_box], id=tid)


class Redemption(unittest.TestCase):
    def test_the_bytes_to_sign_give_the_id_ergo_lib_computes(self):
        self.assertEqual(ergo.tx_id(VEC_TX), '2590fd5d0448dd3d266b72b52e60c054bf2ea35266c24e1799ad7ef8c63bdd0b')
        shuffled = copy.deepcopy(VEC_TX)
        shuffled['inputs'][0]['extension'] = dict(sorted(shuffled['inputs'][0]['extension'].items(), reverse=True))
        self.assertEqual(ergo.tx_id(shuffled), ergo.tx_id(VEC_TX), 'written in Scala order whatever order it arrives in')
        for change, words in [(lambda t: t['inputs'][0].update(boxId='zz'), 'input box id'),
                              (lambda t: t['outputs'][0].update(additionalRegisters={'R5': '00'}), 'R4, R5'),
                              (lambda t: t['inputs'][0].update(extension={'x': '00'}), 'not a byte'),
                              (lambda t: t['outputs'][0].update(value=-1), 'negative'),
                              (lambda t: t['outputs'][0].update(ergoTree='xyz'), 'not hex')]:
            t = copy.deepcopy(VEC_TX)
            change(t)
            with self.assertRaises(ValunError) as e:
                ergo.tx_bytes_to_sign(t)
            self.assertEqual(e.exception.code, 'bad_tx')
            self.assertIn(words, str(e.exception))

    def test_the_proof_verifies_for_the_key_and_the_transaction_only(self):
        secret = bytes.fromhex(secret_of(9))
        pk, msg = vb.public_key(secret), ergo.tx_bytes_to_sign(VEC_TX)
        proof = vb.ergo_prove_dlog(msg, secret)
        self.assertEqual(len(proof), 56)
        self.assertTrue(vb.ergo_verify_dlog(proof, msg, pk))
        self.assertFalse(vb.ergo_verify_dlog(proof, msg, bytes.fromhex(G)), 'another key')
        self.assertFalse(vb.ergo_verify_dlog(proof, ergo.tx_bytes_to_sign({**VEC_TX, 'dataInputs': []}), pk), 'another transaction')
        bent = bytearray(proof)
        bent[30] ^= 1
        self.assertFalse(vb.ergo_verify_dlog(bytes(bent), msg, pk), 'a changed proof')
        self.assertNotEqual(vb.ergo_prove_dlog(msg, secret), proof, 'a fresh nonce every time')

    def test_an_address_of_either_network_gives_its_tree(self):
        self.assertEqual(ergo.address_to_tree('3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsN'), '0008cd' + G)
        self.assertEqual(ergo.address_to_tree('9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV'), '0008cd' + G)
        for bad in ('3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsM', '0OIl', ''):
            with self.assertRaises(ValunError):
                ergo.address_to_tree(bad)

    def test_check_redemption_the_issuers_reserve_exactly_the_amount_nothing_of_its_own(self):
        f = redemption()
        kw = dict(issuer_pubkey=f['issuer'], recipient_pubkey=f['recipient'], amount=f['amount'], tracker_nft_id=NFT,
                  reserve_tree=f['reserve_tree'], input_boxes=f['input_boxes'])
        self.assertEqual(ergo.check_redemption(f['built'], **kw),
                         {'reserve_box_id': '31' * 32, 'reserve_value': 100_000_000, 'paid_nanoerg': f['amount'], 'fee_inputs': 1})

        def resign(b):
            b['partial_tx']['id'] = ergo.tx_id(b['unsigned_tx'])

        def refused(change, words, **over):
            b, boxes = copy.deepcopy(f['built']), copy.deepcopy(f['input_boxes'])
            change(b, boxes)
            with self.assertRaises(ValunError) as e:
                ergo.check_redemption(b, **{**kw, 'input_boxes': boxes, **over})
            self.assertEqual(e.exception.code, 'bad_redemption')
            self.assertIn(words, str(e.exception))
        refused(lambda b, x: b['unsigned_tx']['outputs'][1].update(value=f['amount'] - 1), 'fee-signed is not the one')
        refused(lambda b, x: (b['unsigned_tx']['outputs'][1].update(value=f['amount'] - 1), resign(b)), 'pays exactly')
        refused(lambda b, x: (b['unsigned_tx']['outputs'][0].update(value=100_000_000 - f['amount'] - 1), resign(b)), 'output 0 is not the reserve')
        refused(lambda b, x: (b['unsigned_tx']['outputs'][0]['additionalRegisters'].update(R4='07' + G), resign(b)), 'owner or tracker')
        refused(lambda b, x: (b['unsigned_tx']['outputs'][0].update(assets=[]), resign(b)), 'tokens')
        refused(lambda b, x: (b['unsigned_tx']['inputs'][0]['extension'].update({'1': '07' + G}), resign(b)), 'receiver')
        refused(lambda b, x: (b['unsigned_tx']['inputs'][0]['extension'].update({'0': '0201'}), resign(b)), 'redeem action')
        refused(lambda b, x: x.reverse(), 'not the box the node reports')
        refused(lambda b, x: None, "not the issuer's reserve", issuer_pubkey=G)
        refused(lambda b, x: None, 'tracker', tracker_nft_id='00' * 32)
        refused(lambda b, x: None, 'reserve contract', reserve_tree='10010101d17300')
        refused(lambda b, x: x[1].update(ergoTree=ergo.p2pk_tree(f['recipient'])), "box of this agent's own")

    def test_sign_redemption_the_proof_over_the_bytes_spliced_into_the_trackers_transaction(self):
        f = redemption()
        signed = ergo.sign_redemption(f['built'], f['rsecret'])
        self.assertEqual(signed['id'], f['id'])
        proof = bytes.fromhex(signed['inputs'][0]['spendingProof']['proofBytes'])
        self.assertTrue(vb.ergo_verify_dlog(proof, ergo.tx_bytes_to_sign(f['built']['unsigned_tx']), bytes.fromhex(f['recipient'])))
        self.assertEqual(signed['inputs'][1], f['built']['partial_tx']['inputs'][1], "the tracker's fee proof is kept")
        self.assertEqual(f['built']['partial_tx']['inputs'][0]['spendingProof']['proofBytes'], '', 'the given transaction is not changed')
        for change in (lambda b: b['partial_tx'].update(id='ff' * 32), lambda b: b['partial_tx'].update(inputs=b['partial_tx']['inputs'][1:])):
            b = copy.deepcopy(f['built'])
            change(b)
            with self.assertRaises(ValunError) as e:
                ergo.sign_redemption(b, f['rsecret'])
            self.assertEqual(e.exception.code, 'bad_redemption')


if __name__ == '__main__':
    unittest.main()
