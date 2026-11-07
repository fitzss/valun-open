"""Checks the pure-Python Basis signer against Basis's official cross-validation vectors
(specs/SCHNORR_SIGNATURE_SPEC.md, TV001-TV011, https://github.com/BetterMoneyLabs/basis-tracker at commit 3df7ed93;
Basis is released under CC0-1.0). Run: python -m unittest test_valun_basis"""
import unittest
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from valun import basis as vb  # noqa: E402

ALICE = bytes.fromhex('02fc84de78d191f6b47b6ba97bf1eb5ba3b541c8ca247461f41dafdd6db11bc063')
BOB = bytes.fromhex('023bc6f9ff8a2af3992d23c145de5a868bae6b80a3dd3b24a1de4c6486472e9dbd')
TRACKER = bytes.fromhex('02b651a75c3cec621fa493dfa45fbb42ff77943acdceeb9543163d76e3d81cb645')
NFT = bytes([0x42]) * 32
M1 = bytes.fromhex('76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000003b9aca0000000195e97f78004242424242424242424242424242424242424242424242424242424242424242')

VECTORS = [  # (name, issuer, amount, timestamp, message, signature, expected)
    ('TV001', ALICE, 1000000000, 1743379200000, M1, '027742dac59ea73f7f8710648f17b9fb8ccf570460a727c02b28a6e2f310ebf4711397afdac9e6cc799beedc3309ef2b4989598768f65ea78b95151c844e86408f', True),
    ('TV002', ALICE, 1000000000, 1743379200000, M1, '00' * 65, False),
    ('TV003', TRACKER, 500000000, 1743379201000, bytes.fromhex('52eb0beb0bd0e86206e0a817785aadabbef08730fd5654ea65ebcbe1ef1b3b9e000000001dcd650000000195e97f7be84242424242424242424242424242424242424242424242424242424242424242'), '02d052ebc2a622f61681dc9ad52a8cd062acc4c6acf9ba6cfdd507ae886b8054701319d7378338904e89be9604c16825a06fd831afa598248e3f3902be9d270c39', False),
    ('TV004', ALICE, 1000000000, 1743379200000, M1, '0240d01f20717b244800f147d2c9b559cd836c19aea344071c1639be2a22870e772bdbbaf89bb715fcc8c4ec7d8df464fb196c83a9616ef0ccd392f5ae8022d072', False),
    ('TV005', ALICE, 1000000000, 1743379200000, M1, '036eb16f1611ae82edfd2ca30251e6fbbb3eae03173eb16e270e53ce7f755342a16d86d89db441bb8905f86110f3e615ffaf3ceb9d7b1992c0d14d0e3cbf7f3931', False),
    ('TV006', ALICE, 1000000000, 1743379200000, M1, '028c3d344aefd0caa6a16ffdab0bd154b457585cd998e5ac80b86286a796f33f1e53488afbc8e3160caab535bac018b81bd62acea9b64c2a426d08727d42193720', False),
    ('TV007', ALICE, 1000000000, 1743379200000, M1, '03baecb66840002c131c54134b0abde112a0405f3d6d1d384b5815857ee68b9e624ba6d7c176c8631633c7e609af34f9e389f99c6e3fd64e16aa743956d66e1e11', False),
    ('TV008', ALICE, 1000000000, 1743379200000, M1, '0282fcc89cb99e3491bb43d1797ff2567fde0620ea38d78f937ae122ae0acf2f897169bcb397037aeb94eda8ee6e5642781f8fe1d85f33bc6a8ed5a440760fd029', False),
    ('TV009', ALICE, 2**64 - 1, 2**64 - 1, bytes.fromhex('76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851fffffffffffffffffffffffffffffffff4242424242424242424242424242424242424242424242424242424242424242'), '03917db7e61b54d50409c0447ebd27caa124d2702aa0ae5651381cd662162307c8055e54abdd0ba40be01c695edf95b9026c94f286a3353f63d1e2348e5d455c2f', False),
    ('TV010', ALICE, 0, 0, bytes.fromhex('76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000000000000000000000000000004242424242424242424242424242424242424242424242424242424242424242'), '0235f9989903d1e2ee8c274ba5494119b6deef7cd0d0e15dc07190011b524c891d5deec9c943adce1891dc5977cda361da0a81e81bbf489b3a7f6b8d2c15116ad4', True),
    ('TV011', ALICE, 500000000, 1743379202000, bytes.fromhex('76a4d85b3cac6917e0f0565ebcdc2fbf7656662ca97ef40b9ed1db70c211851f000000001dcd650000000195e97f7fd04242424242424242424242424242424242424242424242424242424242424242'), '02001d67f568ace3b32c68bd9cfdd3795d5df0f5057b4d837935578697675c8e334668c7b923ae13df8dd9725ac66c63a4ca6f05cc2e7d1c3d23abdcb750dea923', True),
]


class OfficialVectors(unittest.TestCase):
    def test_messages_rebuild_exactly(self):
        for name, issuer, amount, ts, msg, _sig, _ok in VECTORS:
            with self.subTest(name):
                self.assertEqual(vb.note_message(issuer, BOB, amount, ts, NFT), msg)

    def test_verify_matches_expected(self):
        for name, issuer, _a, _t, msg, sig, ok in VECTORS:
            with self.subTest(name):
                self.assertEqual(vb.verify(bytes.fromhex(sig), msg, issuer), ok)


class SignVerify(unittest.TestCase):
    def test_roundtrip_and_tamper(self):
        sk = vb.generate_secret()
        pk = vb.public_key(sk)
        msg = vb.note_message(pk, BOB, 12345, 1700000000000, NFT)
        sig = vb.sign(msg, sk)
        self.assertTrue(vb.verify(sig, msg, pk))
        self.assertLess(sig[33], 0x80)
        bad = bytearray(sig); bad[40] ^= 1
        self.assertFalse(vb.verify(bytes(bad), msg, pk))
        self.assertFalse(vb.verify(sig, msg[:-1] + b'\x00', pk))
        self.assertFalse(vb.verify(sig, msg, BOB))

    def test_secret_must_match_given_public_key(self):
        sk = vb.generate_secret()
        with self.assertRaises(vb.SignatureError):
            vb.sign(b'x', sk, ALICE)

    def test_token_denomination_key(self):
        token = 'token:' + 'ab' * 32
        self.assertEqual(vb.debt_key(ALICE, BOB, token), vb.blake2b256(ALICE, BOB, bytes.fromhex('ab' * 32)))
        with self.assertRaises(vb.SignatureError):
            vb.debt_key(ALICE, BOB, 'token:zz')


if __name__ == '__main__':
    unittest.main()
