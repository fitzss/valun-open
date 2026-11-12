"""Settlement on Ergo testnet for the Valun testnet network (valun-testnet-1): reserves and redemptions, signed by the
agent's own key (its Ergo address is the P2PK address of its Valun key; the server never holds it).

Plain Python here: the P2PK address, the order of a transaction's context extensions, the checks a client makes before
it signs anything the tracker built. Building and signing Ergo transactions use ergo-lib (sigma-rust), an OPTIONAL
dependency imported only when a settlement call needs it:
    pip install ergo-lib-python==0.28.0        (wheels for CPython 3.8 to 3.13 on Linux, macOS and Windows)
Ergo TESTNET only: every node this module talks to must say it is a testnet node. The JS client's js/src/ergo.js is
the same module; both check the same things."""
import copy
import hashlib
import json
import re
import urllib.error
import urllib.request
from types import SimpleNamespace

from . import basis as vb
from .client import ValunError

ERGO_LIB = 'ergo-lib-python'
ERGO_LIB_VERSION = '0.28.0'
FEE = 1_000_000            # the miner fee of a transaction this client builds (nanoERG)
MIN_CHANGE = 1_000_000     # the smallest change box it leaves (nanoERG)
MINER_FEE_TREE = ('1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a7017300'
                  '73011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304')
REDEEM_ACTION = '0200'     # context var #0 of the reserve input: Byte 0 (action 0 = redeem, reserve output index 0)


def ergo_lib():
    """ergo-lib's chain, transaction and wallet modules; ValunError ergo_lib_missing (with the install line) when absent."""
    try:
        from ergo_lib_python import chain, transaction, wallet
    except ImportError:
        raise ValunError('ergo_lib_missing', f'settlement on Ergo testnet signs with ergo-lib, which is not installed: '
                                             f'pip install {ERGO_LIB}=={ERGO_LIB_VERSION}') from None
    return SimpleNamespace(chain=chain, transaction=transaction, wallet=wallet)


# ---------- addresses ----------
_B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
_PUBKEY_RE = re.compile(r'0[23][0-9a-f]{64}\Z')


def _base58(b: bytes) -> str:
    n, s = int.from_bytes(b, 'big'), ''
    while n:
        n, r = divmod(n, 58)
        s = _B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s


def p2pk_tree(pubkey_hex: str) -> str:
    """The ErgoTree of the P2PK address of a compressed public key (66 hex): proveDlog(pk)."""
    if not isinstance(pubkey_hex, str) or not _PUBKEY_RE.match(pubkey_hex):
        raise ValunError('invalid_field', 'a public key is 33 bytes of hex (02.. or 03..)')
    return '0008cd' + pubkey_hex


def p2pk_address(pubkey_hex: str, testnet: bool = True) -> str:
    """The P2PK address of a compressed public key, testnet by default (prefix 0x11; mainnet 0x01)."""
    p2pk_tree(pubkey_hex)
    body = bytes([(0x10 if testnet else 0x00) + 0x01]) + bytes.fromhex(pubkey_hex)
    return _base58(body + hashlib.blake2b(body, digest_size=32).digest()[:4])


def address_to_tree(address: str) -> str:
    """The ErgoTree (hex) of a P2PK or P2S address of either network; the checksum is checked."""
    if not isinstance(address, str) or not address or any(ch not in _B58 for ch in address):
        raise ValunError('invalid_field', 'an address is a base58 string')
    n = 0
    for ch in address:
        n = n * 58 + _B58.index(ch)
    body = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    b = b'\0' * (len(address) - len(address.lstrip('1'))) + body
    if len(b) < 6 or hashlib.blake2b(b[:-4], digest_size=32).digest()[:4] != b[-4:]:
        raise ValunError('invalid_field', 'the address checksum is wrong')
    kind, content = b[0] & 0x0f, b[1:-4]
    if kind == 1 and len(content) == 33:
        return '0008cd' + content.hex()
    if kind == 3:
        return content.hex()
    raise ValunError('invalid_field', 'only P2PK and P2S addresses name a script')


# ---------- the order of context extensions ----------
# An input's context extension is a Scala Map[Byte, Constant]: the node serializes it (and so the bytes an input proof
# signs, and the transaction id) in Scala HashMap iteration order, and the Basis tracker binds a redemption submit to
# the exact JSON it built. Python keeps a dict's order, so what the server sends in that order stays in it; every
# transaction is still written with to_ergo_json, which puts each `extension` in Scala's order whatever it was given.
def _improve(h: int) -> int:
    m = 0xffffffff
    h = (h + (~(h << 9) & m)) & m
    h = (h ^ (h >> 14)) & m
    h = (h + (h << 4)) & m
    return (h ^ (h >> 10)) & m


def scala_extension_order(keys) -> list:
    """Scala 2.12 immutable HashMap iteration order of byte keys ({0,1,2,3,4,5,6,8} -> 0,5,1,6,2,3,8,4)."""
    out = []

    def build(level, ks):
        groups = {}
        for k in ks:
            groups.setdefault((_improve(k) >> level) & 0x1f, []).append(k)
        for idx in sorted(groups):
            g = groups[idx]
            if len(g) == 1:
                out.append(g[0])
            elif level >= 30:
                out.extend(g)
            else:
                build(level + 5, g)
    build(0, list(keys))
    return out


_BYTE_KEY = re.compile(r'(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])\Z')


def _ordered(v, key=None):
    if isinstance(v, dict):
        keys = list(v)
        if key == 'extension' and keys and all(isinstance(k, str) and _BYTE_KEY.match(k) for k in keys):
            keys = [str(k) for k in scala_extension_order([int(k) for k in keys])]
        return {k: _ordered(v[k], k) for k in keys}
    if isinstance(v, list):
        return [_ordered(x) for x in v]
    return v


def to_ergo_json(value) -> str:
    """Compact JSON text with every `extension` object (byte keys) in Scala order; otherwise in the given order."""
    return json.dumps(_ordered(value), separators=(',', ':'), ensure_ascii=False)


# ---------- the bytes a transaction's proofs sign (and its id) ----------
_HEX32 = re.compile(r'[0-9a-f]{64}\Z')
_HEXS = re.compile(r'(?:[0-9a-f]{2})*\Z')


def _vlq(v) -> bytes:
    n = int(v)
    if n < 0:
        raise ValunError('bad_tx', 'a negative number in a transaction')
    out = bytearray()
    while True:
        b = n & 0x7f
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _hex(h, what) -> bytes:
    if not isinstance(h, str) or not _HEXS.match(h):
        raise ValunError('bad_tx', f'{what} is not hex')
    return bytes.fromhex(h)


def tx_bytes_to_sign(tx) -> bytes:
    """The bytes a transaction's input proofs sign (node-format JSON, unsigned or signed; proofs ignored): Ergo's
    serialization with empty proofs, each context extension in Scala's order, ErgoTrees and constants as the bytes
    they are (any ErgoTree version). The JS client's ergo.txBytesToSign."""
    if not isinstance(tx, dict) or not isinstance(tx.get('inputs'), list) or not isinstance(tx.get('outputs'), list):
        raise ValunError('bad_tx', 'a transaction has inputs and outputs')
    out = bytearray(_vlq(len(tx['inputs'])))
    for i in tx['inputs']:
        if not _HEX32.match(str((i or {}).get('boxId', ''))):
            raise ValunError('bad_tx', 'an input box id is not 32 bytes of hex')
        out += bytes.fromhex(i['boxId']) + b'\x00'                 # the box id, an empty proof
        ext = i.get('extension')
        if ext is None:
            ext = (i.get('spendingProof') or {}).get('extension') or {}
        if not all(isinstance(k, str) and _BYTE_KEY.match(k) for k in ext):
            raise ValunError('bad_tx', 'a context extension key is not a byte')
        out.append(len(ext))
        for k in scala_extension_order([int(k) for k in ext]):
            out.append(k)
            out += _hex(ext[str(k)], 'a context extension value')
    data = tx.get('dataInputs') or []
    out += _vlq(len(data))
    for d in data:
        if not _HEX32.match(str((d or {}).get('boxId', ''))):
            raise ValunError('bad_tx', 'a data input box id is not 32 bytes of hex')
        out += bytes.fromhex(d['boxId'])
    token_ids = []
    for o in tx['outputs']:
        for a in o.get('assets') or []:
            if a.get('tokenId') not in token_ids:
                token_ids.append(a.get('tokenId'))
    out += _vlq(len(token_ids))
    for t in token_ids:
        if not _HEX32.match(str(t or '')):
            raise ValunError('bad_tx', 'a token id is not 32 bytes of hex')
        out += bytes.fromhex(t)
    out += _vlq(len(tx['outputs']))
    for o in tx['outputs']:
        out += _vlq(o['value']) + _hex(o.get('ergoTree'), 'an ErgoTree') + _vlq(o['creationHeight'])
        assets = o.get('assets') or []
        out.append(len(assets))
        for a in assets:
            out += _vlq(token_ids.index(a['tokenId'])) + _vlq(a['amount'])
        regs = o.get('additionalRegisters') or {}
        names = sorted(regs)
        if names != [f'R{4 + i}' for i in range(len(names))]:
            raise ValunError('bad_tx', 'registers must be R4, R5, ... in order')
        out.append(len(names))
        for r in names:
            out += _hex(regs[r], f'register {r}')
    return bytes(out)


def tx_id(tx) -> str:
    """The transaction id (hex): blake2b256 of the bytes to sign."""
    return hashlib.blake2b(tx_bytes_to_sign(tx), digest_size=32).digest().hex()


# ---------- an Ergo testnet node ----------
class Node:
    """The node's REST API (a testnet node: assert_testnet refuses any other)."""

    def __init__(self, base: str, timeout: float = 30.0, opener=None):
        if not isinstance(base, str) or not re.match(r'https?://', base):
            raise ValunError('invalid_field', 'the Ergo node URL is not http(s)')
        self.base, self.timeout, self._open = base.rstrip('/'), timeout, opener or urllib.request.urlopen

    def call(self, method: str, path: str, body: str = None):
        req = urllib.request.Request(self.base + path, method=method, data=body.encode('utf-8') if body is not None else None,
                                     headers={'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with self._open(req, timeout=self.timeout) as r:
                text = r.read().decode('utf-8')
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'replace')[:300]
            raise ValunError('node_error', f'the Ergo node refused {method} {path.split("?")[0]}: {detail or e.code}', e.code) from None
        except (urllib.error.URLError, OSError) as e:
            raise ValunError('node_unreachable', f'the Ergo node did not answer: {e}') from None
        return json.loads(text) if text else None

    def info(self):
        return self.call('GET', '/info')

    def assert_testnet(self):
        i = self.info()
        if str((i or {}).get('network', '')).lower() != 'testnet':
            raise ValunError('not_testnet', 'the Ergo node is not a testnet node; this client settles on Ergo testnet only')
        return i

    def unspent_by_address(self, address: str):
        return self.call('POST', '/blockchain/box/unspent/byAddress?offset=0&limit=100', json.dumps(address))

    def box(self, box_id: str):
        """An unspent box as the node reports it (node-format JSON)."""
        return self.call('GET', '/utxo/byId/' + re.sub(r'[^0-9a-f]', '', str(box_id)))

    def box_binary(self, box_id: str) -> str:
        return self.call('GET', f'/utxo/byIdBinary/{box_id}')['bytes']

    def last_headers(self, n: int = 10):
        return self.call('GET', f'/blocks/lastHeaders/{n}')

    def broadcast(self, tx):
        return self.call('POST', '/transactions', to_ergo_json(tx))


def state_context(E, headers):
    """The state context ergo-lib signs with, from 10 node-format headers (any order; the newest is the pre-header)."""
    if not isinstance(headers, list) or len(headers) < 10:
        raise ValunError('bad_headers', 'signing needs the last 10 block headers')
    hs = [E.chain.Header.from_json(h) for h in sorted(headers, key=lambda h: -h['height'])[:10]]
    return E.chain.ErgoStateContext(E.chain.PreHeader(hs[0]), hs, E.chain.Parameters.default())


def _boxes(E, hexes):
    return [E.chain.ErgoBox.from_bytes(bytes.fromhex(h)) for h in hexes]


# ---------- a reserve (the agent's own tERG, locked in the Basis reserve contract) ----------
def pick_plain_boxes(node, pubkey_hex: str, need: int):
    """Plain boxes (no tokens) at the key's own address, largest first, enough for `need` nanoERG."""
    tree = p2pk_tree(pubkey_hex)
    boxes = sorted((b for b in node.unspent_by_address(p2pk_address(pubkey_hex)) if b.get('ergoTree') == tree and not b.get('assets')),
                   key=lambda b: -int(b['value']))
    inputs, total = [], 0
    for b in boxes:
        inputs.append(b)
        total += int(b['value'])
        if total >= need:
            break
    if total < need:
        raise ValunError('unfunded', f'{p2pk_address(pubkey_hex)} holds {total} nanoERG in plain boxes; this needs {need} '
                                     f'(the amount, the fee and the change)')
    return inputs, total, tree


def check_reserve_payload(payload, *, erg_amount: int, nft_id: str, pubkey_hex: str, tracker_nft_id: str = None, reserve_contract: str = None):
    """The tracker's payment request for a reserve, checked before anything is signed: one output of exactly
    `erg_amount` at the network's reserve contract, minting one token whose id is `nft_id` (the first input), R4 the
    agent's key, R6 the network's tracker NFT. Returns the request (assets as tokenId/amount)."""
    reqs = payload.get('requests') if isinstance(payload, dict) else None
    if not isinstance(reqs, list) or len(reqs) != 1:
        raise ValunError('bad_payload', 'the reserve request must have exactly one output')
    r = dict(reqs[0])

    def fail(why):
        raise ValunError('bad_payload', f'refusing to sign the reserve: {why}')
    if int(r.get('value', -1)) != erg_amount:
        fail(f'it locks {r.get("value")} nanoERG, not the {erg_amount} asked')
    if reserve_contract and r.get('address') != reserve_contract:
        fail("its address is not the network's reserve contract")
    assets = [{'tokenId': a.get('token_id', a.get('tokenId')), 'amount': int(a.get('amount', 0))} for a in r.get('assets') or []]
    if len(assets) != 1 or assets[0]['tokenId'] != nft_id or assets[0]['amount'] != 1:
        fail('it must mint exactly one token, its id the first input box')
    regs = r.get('registers') or {}
    if regs.get('R4') != '07' + pubkey_hex:
        fail("its R4 is not this agent's key")
    if tracker_nft_id and regs.get('R6') != '0e20' + tracker_nft_id:
        fail("its R6 is not the network's tracker NFT")
    r['assets'] = assets
    return r


def build_reserve(*, secret_hex: str, pubkey_hex: str, erg_amount: int, node, payload_for, tracker_nft_id: str = None, reserve_contract: str = None):
    """A signed transaction that locks `erg_amount` nanoERG from the key's own address in a Basis ERG reserve: output 0
    the checked request, then the miner fee and the change back to the key's address."""
    E = ergo_lib()
    if not isinstance(erg_amount, int) or isinstance(erg_amount, bool) or erg_amount < 1:
        raise ValunError('invalid_field', 'erg_amount: whole nanoERG')
    node.assert_testnet()
    headers = node.last_headers(10)
    height = max(h['height'] for h in headers)
    inputs, total, tree = pick_plain_boxes(node, pubkey_hex, erg_amount + FEE + MIN_CHANGE)
    nft_id = inputs[0]['boxId']
    req = check_reserve_payload(payload_for(nft_id), erg_amount=erg_amount, nft_id=nft_id, pubkey_hex=pubkey_hex,
                                tracker_nft_id=tracker_nft_id, reserve_contract=reserve_contract)
    reserve_tree = bytes(E.chain.Address(req['address']).ergo_tree()).hex()
    outputs = [
        {'value': erg_amount, 'ergoTree': reserve_tree, 'creationHeight': height, 'assets': req['assets'], 'additionalRegisters': req['registers']},
        {'value': FEE, 'ergoTree': MINER_FEE_TREE, 'creationHeight': height, 'assets': [], 'additionalRegisters': {}},
        {'value': total - erg_amount - FEE, 'ergoTree': tree, 'creationHeight': height, 'assets': [], 'additionalRegisters': {}},
    ]
    unsigned = E.transaction.UnsignedTransaction.from_json({'inputs': [{'boxId': b['boxId'], 'extension': {}} for b in inputs],
                                                            'dataInputs': [], 'outputs': outputs})
    boxes = _boxes(E, [node.box_binary(b['boxId']) for b in inputs])
    w = E.wallet.Wallet([E.wallet.SecretKey.from_bytes(bytes.fromhex(secret_hex))])
    signed = w.sign_transaction(unsigned, boxes, [], state_context(E, headers))
    j = json.loads(signed.json())
    return {'signed': j, 'tx_id': str(signed.id), 'nft_id': nft_id, 'reserve_box_id': j['outputs'][0]['boxId'], 'locked_nanoerg': erg_amount}


# ---------- a redemption (the agent's claim on an issuer's reserve, paid to the agent's own address) ----------
def check_redemption(built, *, issuer_pubkey: str, recipient_pubkey: str, amount: int, tracker_nft_id: str = None,
                     reserve_tree: str = None, input_boxes=None):
    """The redemption the tracker built, checked before the agent's key signs it. `input_boxes` are the boxes it spends
    as the Ergo node reports them (GET /utxo/byId; never the tracker's copies), in input order. The agent's proof makes
    input 0 (the reserve) spendable, and a proof over these bytes would also spend any box of the agent's own, so it
    signs only when: input 0 is a reserve of the issuer for this network (the reserve contract, R4 the issuer's key, R6
    the tracker NFT); no input is a box at the agent's own address; output 0 is that reserve, `amount` lower, its owner,
    tracker and tokens kept; one output pays exactly `amount` to the agent's own address; the reserve input's context
    names this agent as receiver (#1) with action 0 (#0); and the transaction is the one the tracker fee-signed (same
    id). Returns a summary."""
    def fail(why):
        raise ValunError('bad_redemption', f'refusing to sign the redemption: {why}')
    tx = (built or {}).get('unsigned_tx') if isinstance(built, dict) else None
    if not isinstance(tx, dict) or not isinstance(tx.get('inputs'), list) or not isinstance(tx.get('outputs'), list) \
            or not isinstance(input_boxes, list):
        fail("the tracker's answer is not a redemption")
    if len(input_boxes) != len(tx['inputs']):
        fail('the input boxes do not match the inputs')
    boxes = input_boxes
    for i, b in enumerate(boxes):
        if not isinstance(b, dict) or b.get('boxId') != tx['inputs'][i]['boxId']:
            fail(f'input {i} is not the box the node reports for it')
    if (built.get('partial_tx') or {}).get('id') != tx_id(tx):
        fail('the transaction the tracker fee-signed is not the one to sign')
    reserve, own = boxes[0], p2pk_tree(recipient_pubkey)
    regs = reserve.get('additionalRegisters') or {}
    if reserve_tree and reserve['ergoTree'] != reserve_tree:
        fail("input 0 is not at the network's reserve contract")
    if regs.get('R4') != '07' + issuer_pubkey:
        fail("input 0 is not the issuer's reserve")
    if tracker_nft_id and regs.get('R6') != '0e20' + tracker_nft_id:
        fail("input 0 is not a reserve of this network's tracker")
    if any(b['ergoTree'] == own for b in boxes):
        fail("it would spend a box of this agent's own")
    out0 = tx['outputs'][0]
    if out0.get('ergoTree') != reserve['ergoTree'] or int(out0.get('value', -1)) != int(reserve['value']) - amount:
        fail(f'output 0 is not the reserve, {amount} nanoERG lower')
    oregs = out0.get('additionalRegisters') or {}
    if oregs.get('R4') != regs.get('R4') or oregs.get('R6') != regs.get('R6'):
        fail("output 0 changes the reserve's owner or tracker")
    tokens = lambda xs: [(a.get('tokenId'), str(a.get('amount'))) for a in xs or []]  # noqa: E731
    if tokens(out0.get('assets')) != tokens(reserve.get('assets')):
        fail("output 0 changes the reserve's tokens")
    paid = [o for o in tx['outputs'] if o.get('ergoTree') == own]
    if len(paid) != 1 or int(paid[0].get('value', -1)) != amount or paid[0].get('assets'):
        fail(f'no single output pays exactly {amount} nanoERG to this agent')
    ext = tx['inputs'][0].get('extension') or {}
    if ext.get('0') != REDEEM_ACTION:
        fail('the reserve input is not spent by the redeem action into output 0')
    if ext.get('1') != '07' + recipient_pubkey:
        fail('the reserve input does not name this agent as the receiver')
    return {'reserve_box_id': reserve['boxId'], 'reserve_value': int(reserve['value']), 'paid_nanoerg': amount, 'fee_inputs': len(boxes) - 1}


def sign_redemption(built, secret_hex: str):
    """The agent's proof for the reserve input (input 0) over exactly the transaction the tracker built (its bytes to
    sign, computed here), spliced into the tracker's fee-signed transaction. The reserve script reduces to
    proveDlog(receiver) once its other conditions hold, so the proof is the agent's Schnorr proof over those bytes
    (basis.ergo_prove_dlog): no ergo-lib, and any ErgoTree version. Returns the signed transaction (a dict; write it
    with to_ergo_json)."""
    tx = built['unsigned_tx']
    message = tx_bytes_to_sign(tx)
    signed = copy.deepcopy(built.get('partial_tx'))
    if not isinstance(signed, dict) or not signed.get('inputs') or signed['inputs'][0].get('boxId') != tx['inputs'][0]['boxId'] \
            or 'spendingProof' not in signed['inputs'][0]:
        raise ValunError('bad_redemption', 'the partly signed transaction does not start with the reserve input')
    if signed.get('id') != hashlib.blake2b(message, digest_size=32).digest().hex():
        raise ValunError('bad_redemption', 'the partly signed transaction is not the one built')
    signed['inputs'][0]['spendingProof']['proofBytes'] = vb.ergo_prove_dlog(message, bytes.fromhex(secret_hex)).hex()
    return signed
