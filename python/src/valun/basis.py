"""Basis-compatible Schnorr signatures over secp256k1, in pure Python (no dependencies).

Mirrors basis_core::schnorr_sign / SchnorrVerifier at Basis 3df7ed93 (crates/basis_core/src/impls.rs):
  signature = a (33-byte compressed point k*G) || z (32 bytes, big-endian)
  e = blake2b256(a || message || public_key), read as a big-endian integer
  z = k + e*s mod n, retried until e < 2^255 and 0 < z < 2^255 (on-chain compatibility: ErgoScript reads
  both with a signed conversion), verified as z*G == a + e*X.
Note message (80 bytes): debt_key(32) || total(8 BE) || timestamp(8 BE) || tracker_nft_id(32),
debt_key = blake2b256(issuer_pk || recipient_pk [|| token_id]).
Prior acknowledgment (105 bytes, tracker v3.2): PA(I,R,X,p,T) = "basis/prior-ack/1" (17 ASCII bytes) || debt_key(32) ||
X(8 BE) || p(8 BE) || T(8 BE) || tracker_nft_id(32): the edge's stored total X and its note's timestamp p (0 and 0 for
an edge with no note yet) at the operation's timestamp T. Never 80 bytes and never a Valun statement ("valun-"), so it
can be taken neither for a note message nor for a statement.

This is a client-side signer so a participant's key never leaves their machine. It is cross-checked against
Basis's official test vectors and against basis_core itself; the real tracker verifies every note it signs.
Not constant-time: fine for a local signer in an experiment, not for an exposed signing service.
"""
import hashlib
import secrets

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
HALF = 1 << 255


class SignatureError(ValueError):
    pass


def blake2b256(*parts: bytes) -> bytes:
    h = hashlib.blake2b(digest_size=32)
    for p in parts:
        h.update(p)
    return h.digest()


# ---- secp256k1 arithmetic (Jacobian coordinates) ----
def _double(j):
    if j is None:
        return None
    x, y, z = j
    if y == 0:
        return None
    s = 4 * x * y * y % P
    m = 3 * x * x % P
    x3 = (m * m - 2 * s) % P
    y3 = (m * (s - x3) - 8 * pow(y, 4, P)) % P
    return (x3, y3, 2 * y * z % P)


def _add(j1, j2):
    if j1 is None:
        return j2
    if j2 is None:
        return j1
    x1, y1, z1 = j1
    x2, y2, z2 = j2
    z1z1, z2z2 = z1 * z1 % P, z2 * z2 % P
    u1, u2 = x1 * z2z2 % P, x2 * z1z1 % P
    s1, s2 = y1 * z2 * z2z2 % P, y2 * z1 * z1z1 % P
    if u1 == u2:
        return _double(j1) if s1 == s2 else None
    h, r = (u2 - u1) % P, (s2 - s1) % P
    h2 = h * h % P
    h3, u1h2 = h * h2 % P, u1 * h2 % P
    x3 = (r * r - h3 - 2 * u1h2) % P
    y3 = (r * (u1h2 - x3) - s1 * h3) % P
    return (x3, y3, h * z1 * z2 % P)


def _affine(j):
    if j is None or j[2] % P == 0:
        return None
    zi = pow(j[2], -1, P)
    zi2 = zi * zi % P
    return (j[0] * zi2 % P, j[1] * zi2 * zi % P)


def _mul(k: int, pt):
    acc, add = None, (pt[0], pt[1], 1)
    while k:
        if k & 1:
            acc = _add(acc, add)
        add = _double(add)
        k >>= 1
    return acc  # Jacobian


def compress(pt) -> bytes:
    return bytes([2 + (pt[1] & 1)]) + pt[0].to_bytes(32, 'big')


def decompress(b: bytes):
    if len(b) != 33 or b[0] not in (2, 3):
        raise SignatureError('not a compressed secp256k1 point')
    x = int.from_bytes(b[1:], 'big')
    if x >= P:
        raise SignatureError('point x out of range')
    y2 = (pow(x, 3, P) + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if y * y % P != y2:
        raise SignatureError('point is not on the curve')
    if (y & 1) != (b[0] & 1):
        y = P - y
    return (x, y)


# ---- keys ----
def generate_secret() -> bytes:
    return (secrets.randbelow(N - 1) + 1).to_bytes(32, 'big')


def public_key(secret: bytes) -> bytes:
    s = int.from_bytes(secret, 'big')
    if not 0 < s < N:
        raise SignatureError('secret key out of range')
    return compress(_affine(_mul(s, G)))


def validate_public_key(pk: bytes) -> None:
    decompress(pk)


# ---- Ergo: the spending proof of proveDlog(pk) (the sigma protocol's Schnorr proof, Fiat-Shamir) ----
def _ergo_prop(pk: bytes) -> bytes:
    # the version-0 ErgoTree with constant segregation of SigmaProp(proveDlog(pk))
    return bytes([0x10, 0x01, 0x08, 0xcd]) + pk + bytes([0x73, 0x00])


def _ergo_challenge(prop: bytes, a: bytes, message: bytes) -> bytes:
    fs = b'\x01' + len(prop).to_bytes(2, 'big') + prop + len(a).to_bytes(2, 'big') + a
    return blake2b256(fs, message)[:24]


def ergo_prove_dlog(message: bytes, secret: bytes) -> bytes:
    """The 56-byte proof an Ergo node accepts for an input whose script reduces to proveDlog(pk) (pk = the secret's
    public key) over `message` (the transaction's bytes to sign): e (24 bytes) || z (32 bytes, big-endian), a = g^r,
    e = the first 24 bytes of blake2b256(0x01 || len(prop) || prop || len(a) || a || message), prop = the version-0
    ErgoTree of SigmaProp(proveDlog(pk)), z = r + e*x mod n (the JS client's basis.ergoProveDlog)."""
    x = int.from_bytes(secret, 'big')
    if not 0 < x < N:
        raise SignatureError('secret key out of range')
    prop = _ergo_prop(compress(_affine(_mul(x, G))))
    while True:
        r = secrets.randbelow(N - 1) + 1
        a = compress(_affine(_mul(r, G)))
        e = _ergo_challenge(prop, a, message)
        z = (r + int.from_bytes(e, 'big') * x) % N
        if z:
            return e + z.to_bytes(32, 'big')


def ergo_verify_dlog(proof: bytes, message: bytes, pk: bytes) -> bool:
    """True iff `proof` is a valid ergo_prove_dlog proof of `message` for public key `pk`. Never raises."""
    try:
        if len(proof) != 56:
            return False
        X = decompress(pk)
        e, z = proof[:24], int.from_bytes(proof[24:], 'big')
        if z >= N:
            return False
        a = _affine(_add(_mul(z, G), _mul((-int.from_bytes(e, 'big')) % N, X)))
        if a is None:
            return False
        return _ergo_challenge(_ergo_prop(compress(X)), compress(a), message) == e
    except (SignatureError, ValueError, TypeError):
        return False


# ---- Schnorr (Basis) ----
def _challenge(a: bytes, message: bytes, pk: bytes) -> bytes:
    return blake2b256(a, message, pk)


def sign(message: bytes, secret: bytes, pk: bytes = None) -> bytes:
    s = int.from_bytes(secret, 'big')
    if not 0 < s < N:
        raise SignatureError('secret key out of range')
    pk = pk or public_key(secret)
    if pk != public_key(secret):
        raise SignatureError('secret does not match public key')
    while True:
        k = secrets.randbelow(N - 1) + 1
        a = compress(_affine(_mul(k, G)))
        e_bytes = _challenge(a, message, pk)
        e = int.from_bytes(e_bytes, 'big')
        if e_bytes[0] >= 0x80 or e >= N:      # contract reads e as a signed integer
            continue
        z = (k + e * s) % N
        if z == 0 or z.bit_length() > 255:     # same retry rule as basis_core / SigUtils
            continue
        sig = a + z.to_bytes(32, 'big')
        if not verify(sig, message, pk):       # never emit a signature Basis would reject
            continue
        return sig


def verify(sig: bytes, message: bytes, pk: bytes) -> bool:
    try:
        if len(sig) != 65 or sig[0] not in (2, 3):
            return False
        a, z_bytes = sig[:33], sig[33:]
        if not any(z_bytes) or z_bytes[0] & 0x80:
            return False
        x_pt = decompress(pk)
        a_pt = decompress(a)
        e_bytes = _challenge(a, message, pk)
        e = int.from_bytes(e_bytes, 'big')
        if e_bytes[0] & 0x80 or e >= N:
            return False
        z = int.from_bytes(z_bytes, 'big')
        if not 0 < z < N:
            return False
        left = _affine(_mul(z, G))
        right = _affine(_add((a_pt[0], a_pt[1], 1), _mul(e, x_pt)))
        return left is not None and left == right
    except SignatureError:
        return False


# ---- Basis note messages ----
def debt_key(issuer_pk: bytes, recipient_pk: bytes, denomination: str = 'erg') -> bytes:
    if denomination == 'erg':
        return blake2b256(issuer_pk, recipient_pk)
    if denomination.startswith('token:') and len(denomination) == 70:
        return blake2b256(issuer_pk, recipient_pk, bytes.fromhex(denomination[6:]))
    raise SignatureError(f'unsupported denomination {denomination!r}')


def note_message(issuer_pk: bytes, recipient_pk: bytes, total: int, timestamp: int, tracker_nft_id: bytes,
                 denomination: str = 'erg') -> bytes:
    if not (0 <= total < 2**64 and 0 <= timestamp < 2**64) or len(tracker_nft_id) != 32:
        raise SignatureError('bad note fields')
    return (debt_key(issuer_pk, recipient_pk, denomination) + total.to_bytes(8, 'big')
            + timestamp.to_bytes(8, 'big') + tracker_nft_id)


PRIOR_ACK_TAG = b'basis/prior-ack/1'   # 17 ASCII bytes, no terminator (tracker v3.2 basis_core prior_ack_message)


def prior_ack_message(issuer_pk: bytes, recipient_pk: bytes, prior_total: int, prior_timestamp: int, timestamp: int,
                      tracker_nft_id: bytes, denomination: str = 'erg') -> bytes:
    """PA(I,R,X,p,T), the 105-byte prior acknowledgment of tracker v3.2: PRIOR_ACK_TAG || debt_key || X || p || T ||
    tracker_nft_id (u64 big-endian numbers). X is the edge's stored total the signer acknowledges, p the stored note's
    timestamp (X = 0 and p = 0 for an edge with no note yet), T the operation's timestamp (the transfer's T, or the
    bound note's own timestamp). It binds the exact prior state and the operation, so it cannot be reused for another."""
    if not (0 <= prior_total < 2**64 and 0 <= prior_timestamp < 2**64 and 0 <= timestamp < 2**64) \
            or len(tracker_nft_id) != 32:
        raise SignatureError('bad prior acknowledgment fields')
    return (PRIOR_ACK_TAG + debt_key(issuer_pk, recipient_pk, denomination) + prior_total.to_bytes(8, 'big')
            + prior_timestamp.to_bytes(8, 'big') + timestamp.to_bytes(8, 'big') + tracker_nft_id)
