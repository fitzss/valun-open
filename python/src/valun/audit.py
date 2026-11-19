"""`valun audit`: check the operator (fix inbox #62, step 6b). It rebuilds the AVL+ digest of the ledger a Valun server
publishes (valun/avl.py) and compares it with R5 of the one unspent box holding the tracker's NFT, read from a chain
source the user names: the public Ergo explorer or the user's own node, never a source the server names. Read only: it
sends GET requests and nothing else, sends no token, signs nothing and writes nothing (not even this profile's records).

The check, as the server-side auditor makes it (valun-app scripts/ops/anchor-audit.mjs, fix inbox #62 step 5):
  1. GET /pilot/v1/chain of the server: its network and the tracker's NFT id. That id is the server's word, and a
     tracker the operator made itself could commit whatever the server publishes (a decoy), while the reserves, and so
     every redemption, trust the real one (fix inbox #66). So the NFT must be pinned (_pin_of):
       - with --tracker-nft (tracker_nft), it must be that one, and nothing else is asked (anchor-audit.mjs
         --tracker-nft);
       - otherwise it must pass every pin that applies: this profile's (pinned at its first read of the server's GET
         /info; it applies to the audit of the profile's own server, and with --mine: the notes this profile signs and
         verifies name that tracker), and the one this audit ships for a server it knows (TRACKER_NFTS, by the server's
         origin, the table anchor-audit.mjs pins). The pin is per server, not per network: staging and the testnet
         both say valun-testnet-1, each with a tracker of its own.
     Another NFT than a pin is UNKNOWN (tracker_mismatch, naming the NFT pinned and the one named), and nothing else is
     read. Without --tracker-nft, for a server TRACKER_NFTS does not know, the reserves are asked too, as
     anchor-audit.mjs asks them for a server it pins none for: the reserve contract GET /chain names must be the one
     this audit pins (RESERVE_CONTRACT_SHA256), and at least one unspent box there, on the chain source, must name the
     NFT in R6 (with an owner key in R4); else UNKNOWN (tracker_not_pinned). An operator can make such a reserve for a
     decoy too, so with no other pin a pass is reported with a warning that asks for one. A node lists the boxes at an
     address only for a POST, which this audit does not send: read from a node, a server TRACKER_NFTS does not know is
     UNKNOWN (tracker_not_pinned) unless --tracker-nft names the NFT. A chain source that is the node /chain itself
     names is used, with a warning: the operator may run it. One at the server's own origin is refused (the command's
     usage error, as anchor-audit.mjs refuses it): the server's word is what is checked.
  2. The rows the server publishes for its confirmed tracker box: GET /pilot/v1/ledger/committed {network,
     construction, box_id, height, digest, rows [{issuer_pubkey, recipient_pubkey, denomination, committed_total,
     debt_key}], ...}. Its construction must be CONSTRUCTION (a snapshot that names none is refused too), its network
     the one GET /chain names, its box, height and digest given, and a row's debt_key, where it has one, the debt key
     of its issuer, recipient and denomination; anything else is UNKNOWN. A row's denomination that is null or absent
     is erg. From a server without that route (it answers an unknown public route 401 without a token, 404 with one),
     GET /chain, GET /ledger, GET /chain: the ledger's rows are taken as the confirmed state only while both reads of
     /chain say the tracker's state is anchored (anchoring.anchored, and its local digest equal to the one its
     confirmed box commits) and name the same tracker NFT, box, height, digest and update in flight (pending_tx_id).
     Those reads are SETTLE_S apart, longer than the server's public read cache (valun-app lib/pilot/http.mjs
     PUBLIC_CACHE_MS, 3 s), so each one is computed after the one before it: the server serves GET /chain and GET
     /ledger from that cache while its state is unsaved, and it writes the tracker before it saves, so without the
     wait the second /chain could be the first one's cached answer, older than a note the ledger shows. The ledger
     lists the notes in the network's denomination only (GET /info denomination, also a note's null or absent one),
     with totals as JSON numbers; the committed snapshot lists every denomination, with totals as decimal strings.
     While the ledger is ahead of the box (not anchored) that route compares nothing: UNKNOWN (not_anchored), which says
     so plainly (fix inbox #86). --wait-anchored [SECONDS] (wait_anchored) first reads GET /chain every WAIT_POLL_S
     until it says the tracker's state is anchored, for at most SECONDS (WAIT_ANCHORED_S by default), then audits.
  3. The chain source's unspent boxes holding the NFT: exactly one, which holds the NFT (one token), is not spent and is
     on the main chain. Anything else is UNKNOWN (source_inconsistent, no_tracker_box), never a pass. The NFT's place
     among the box's tokens (in the order of their index, when the source gives every token one): the reserve contract
     reads a tracker box's NFT as its first token (basis.es tracker.tokens(0)).
  4. R5 decoded as an AvlTree constant: 0x64 || digest (33 bytes) || flags || key length (VLQ) || value length (an
     Option of a VLQ). The construction this client rebuilds (CONSTRUCTION) has key length 32 and no fixed value
     length; another tree is UNKNOWN (not_an_avl_tree).
  5. The chain source's height: the box's age in blocks, and the two windows that open as the box ages: nettings
     (transfers and set-offs that lower an anchored edge) are refused from H + 1440 (the tracker's anchored netting,
     fresh_blocks), and the reserve contract redeems without the tracker's signature from H + 2161 (a box older than
     2160 blocks), H being the box's creation height. A source that gives no height is UNKNOWN (source_unreadable,
     source_inconsistent), as anchor-audit.mjs has it.
  6. The rows' digest (avl.digest: sorted by debt key, refused when malformed) against R5's:
       MATCH     equal, and the NFT is the box's first token: the box commits exactly the published rows;
       MISMATCH  different, and the server's rows are for that very box (the box id it names is the source's). Rows
                 of GET /ledger are a MISMATCH only when they give the digest both reads of GET /chain name as the
                 anchored state, which is not R5: the server's confirmed digest is not on chain. Rows of GET /ledger
                 that give neither are not the state the server calls anchored; a ledger read under a server cache
                 longer than SETTLE_S looks so, as does a tracker note GET /ledger does not list (another
                 denomination), so they are read again, and UNKNOWN (ledger_moving) when they stay so;
       UNKNOWN   anything that leaves the comparison undecided. The snapshot naming another box than the source's one
                 unspent box (the chain moved during the audit, or the source lags), a snapshot still moving (503
                 snapshot_moving) and a ledger read that moved are read again, ATTEMPTS times in all, waiting between
                 reads (RETRY_S, or the server's retry_after_ms, at most MAX_WAIT_S); then UNKNOWN. Rows that give R5
                 of a box holding the NFT other than as its first token are UNKNOWN (nft_not_first): no redemption can
                 use that box.
     A total the server wrote as a JSON number above 2^53 - 1 is UNKNOWN (inexact_total): a JavaScript server's Number
     may have been rounded before it was written, and an exact int of a rounded total would give a false MISMATCH.

What a MATCH proves: the one unspent tracker-NFT box, created at height H, commits in R5 the AVL+ digest of exactly the
published set of (debt key, cumulative total). It does not prove what is outstanding (redemptions are recorded in each
reserve's own tree), that an issuer can pay, that any deal was real, that the parties are independent, that a key
belongs to a handle (names are not anchored) or that a mandate was kept (DOES_NOT_PROVE).

--mine (a joined profile; on a MATCH only, since only then are the published totals the anchored ones) lists this
participant's edges in those rows, as issuer and as recipient, on every key it has: this agent's key, every other key
GET /ledger names as this participant's (current or past; the server's word, since names are not anchored; no
derived keys exist yet), and every key this profile's records show it signed with (a pending entry's direction: out,
the edge's issuer; in, its recipient); and every edge this profile's records confirm, on any key, at the total the
rows hold for that edge (an edge's key the audit cannot place still has its anchored total). Each edge's
anchored total is compared with the state this profile's records confirm for it (records.py: {total, timestamp,
signature}, the issuer's signature on that state, verified when it was recorded and verified again here on this
profile's pinned tracker and unit). The records are read as they are: the audit does not sync them. Status (MINE_STATUS):
  signed               the total is the recorded one and its issuer's signature verifies: at height H the chain commits a
                       total its issuer signed (a proven status). netted_by names the set-off this client signed that
                       state in, when its R4 record (state['signed']) shows one
  netted               fix inbox #86: the total is the after-state of a set-off this client signed (a pending entry of
                       kind setoff in its records, newer than any confirmed state), and its own signature on it, kept
                       with that entry, verifies under the key of its side: on an edge it issues, the issuer's; on one it
                       is the creditor of, the recipient's (a proven status: netted_by, the set-off; netted_state). A
                       set-off applies only with every member's signature, so the chain commits a state this client signed
  signature_not_held   the total is the recorded one, but the records hold no signature for it (a confirmed state drops
                       its signature 30 days after its timestamp)
  bad_signature        the total is the recorded one, and the signature held for it does not verify
  differs              the total is not the recorded one (an anchor behind the records, records not synced since, or a
                       change this client did not sign: the own-edge monitor, a later step, tells these apart)
  not_in_records       published, and the records hold no state of the edge
  not_anchored         the records confirm a state of the edge, and the published rows have none
A profile without a pinned tracker and denomination (pins, set at its first read of the server's GET /info) has records
that cannot be matched to the rows or verified: --mine then lists no edge and says so (problem no_pinned_tracker), and
nothing of it is proven. So does a profile pinned to another tracker than the one audited (problem another_tracker:
--tracker-nft named another), whose records are of that other tracker's notes.

Exit codes (EXIT_*), the same as anchor-audit.mjs's (EXIT), so that one watcher reads both:
  0  MATCH (with --mine: and every edge proven, signed or netted);
  1  MISMATCH, and nothing else;
  2  nothing was compared: UNKNOWN, whatever its reason, a usage error (argparse's, and the command's own: a profile it
     cannot use, a URL, a --tracker-nft that is not a token id, the server itself as the chain source, --mine without
     a joined profile) and a fault of the command (UNKNOWN, reason fault). anchor-audit.mjs gives 2 for all of these
     too (INCONSISTENT, REFUSED, ERROR);
  3  MATCH, and with --mine an edge not proven (anchor-audit.mjs has no --mine).
The two give the same exit code on the 41 recorded reads of tests/fixtures/audit-verdicts/xtool.json, each read with
its tracker NFT pinned: anchor-audit.mjs at valun-app 9748f39, which keeps them in its tests with the verdict table of
its docs/PILOT-API.md ("Verdicts"), and this audit in test_audit_pin.py. Elsewhere they differ in these ways:
  - a box the server names other than the source's one unspent tracker box, with rows that give the digest the server
    claims for it: this audit does not look that box up, and is UNKNOWN (box_moved, after reading again), where
    anchor-audit.mjs reads it on the source and gives a MISMATCH when R5 there is another digest (or no AvlTree), the
    box holds no tracker NFT, or the source lacks it although its tracker box was created after the height claimed;
  - the tracker NFT: both pin the same servers (TRACKER_NFTS, by origin), --tracker-nft overrides that pin in both,
    and both ask the reserves for any other server; but this audit also holds the NFT to this profile's pin (step 1),
    which anchor-audit.mjs has no notion of, and read from a node, a server TRACKER_NFTS does not know is UNKNOWN here
    without --tracker-nft (this audit sends GET only), where anchor-audit.mjs asks the node for the reserves with a
    POST that only reads;
  - GET /pilot/v1/info: from a server without GET /ledger/committed, this audit reads the rows' denomination there and
    is UNKNOWN when it cannot (server_unreadable), where anchor-audit.mjs takes erg and does not read it;
  - reading again: this audit reads again (ATTEMPTS times, RETRY_S apart) when rows that do not give R5 are for another
    box than the source's (box_moved) and when rows of GET /ledger give neither digest (ledger_moving), and may then
    compare, where anchor-audit.mjs is 2 at once (its watcher's next run reads again); anchor-audit.mjs reads GET
    /ledger/committed again on any 503 (waiting the server's retry_after_ms, 0.25 to 10 s), this audit only on 503
    snapshot_moving (503 no_confirmed_box is UNKNOWN at once, not_anchored, and another 503 server_unreadable).
"""
import hashlib
import http.client
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from . import __version__
from . import avl
from . import basis as vb
from . import client as vc
from . import ergo
from . import records

CONSTRUCTION = 'basis-avl/1'            # the tree avl.py builds: what GET /ledger/committed names as its construction
LEDGER_ROUTE = '/pilot/v1/ledger'       # the older reads' rows (step 2): the result's rows.from
USER_AGENT = f'valun-audit/{__version__}'
FRESH_BLOCKS = 1440                     # nettings of anchored edges are refused once the box is this old (anchored netting)
TRACKER_LESS_AFTER_BLOCKS = 2160        # the reserve contract waives the tracker's signature for a box older than this
ATTEMPTS = 3
RETRY_S = 5.0
MAX_WAIT_S = 15.0
# --wait-anchored (fix inbox #86): GET /chain every WAIT_POLL_S until the tracker's state is anchored, for at most the
# seconds given (WAIT_ANCHORED_S when none are: two of the tracker's checks, GET /chain check_interval_seconds 300).
WAIT_ANCHORED_S = 600.0
WAIT_ANCHORED_MAX_S = 86400.0
WAIT_POLL_S = 15.0
# The wait before each of GET /ledger and the second GET /chain of the older reads (step 2), from the answer before it:
# longer than the server's public read cache (valun-app lib/pilot/http.mjs PUBLIC_CACHE_MS, 3 s; an entry is served
# while it is younger than that and the server's state unsaved). A request sent SETTLE_S after an answer is then served
# an entry computed after that answer was, so the three reads are computed in the order they are sent. As
# scripts/ops/anchor-audit.mjs SETTLE_MS.
SETTLE_S = 3.5
MAX_ANSWER_BYTES = 64 * 1024 * 1024
BOX_LIMIT = 10                          # boxes asked for: more than one is already inconsistent
# The tracker NFT of each server this audit knows, as its GET /pilot/v1/chain named it on TRACKER_NFTS_READ: the table
# of anchor-audit.mjs (TRACKER_NFTS), keyed as there by the server's origin (origin()). valun.tech is the testnet's Fly
# app; staging runs a tracker of its own, and both say network valun-testnet-1, so the pin is per server, not per
# network. A server that moves to a new tracker is audited with --tracker-nft until this table names it.
TRACKER_NFTS = {
    'https://valun.tech': 'dca981fc5d4842caf230e1b3a83cd3289663afc61b10b3f53678ccdefea5add2',
    'https://valun-testnet.fly.dev': 'dca981fc5d4842caf230e1b3a83cd3289663afc61b10b3f53678ccdefea5add2',
    'https://valun-staging.fly.dev': '170213cb89e5c0286d390a8cc0015de3c19688f77aa0dddbf3a3d235ea22d42d',
}
TRACKER_NFTS_READ = '2026-11-14'
# The Basis reserve contract the testnet's GET /pilot/v1/chain names (reserve_contract), pinned by the sha256 of its
# address as anchor-audit.mjs RESERVE_CONTRACT_SHA256 pins it (staging names the same one): for a server TRACKER_NFTS
# does not know, a reserve box there must name the tracker NFT (step 1).
RESERVE_CONTRACT_SHA256 = '19f9e7ccf9fcdb339d336448b382029abb650c0d1ace0d34b2e2f4778bd9f427'
RESERVE_PAGE = 100                      # the boxes at the reserve contract asked for at a time, as anchor-audit.mjs
RESERVE_LIST_MAX = 5000                 # and at most (anchor-audit.mjs RESERVE_LIST_MAX)
# The module docstring: one code for every "nothing was compared", 2, as anchor-audit.mjs EXIT.INCONSISTENT,
# EXIT.REFUSED and its faults (and as argparse exits on a usage error).
EXIT_MATCH, EXIT_MISMATCH, EXIT_NOTHING_COMPARED, EXIT_NOT_PROVEN = 0, 1, 2, 3
EXIT_UNKNOWN = EXIT_USAGE = EXIT_NOTHING_COMPARED
MINE_STATUS = ('signed', 'netted', 'signature_not_held', 'bad_signature', 'differs', 'not_in_records', 'not_anchored')
PROVEN_STATUS = ('signed', 'netted')                       # the statuses --mine counts as proven
_SETOFF_ID = re.compile(r'vs_[0-9a-f]{16}')
PROVES = ('The one unspent box holding the tracker NFT, created at height {height}, commits in R5 the AVL+ digest of exactly '
          'these {count} rows: for each note, its issuer key, recipient key, denomination and cumulative total, as anchored.')
DOES_NOT_PROVE = (
    'what is outstanding: redemptions are recorded in each reserve\'s own tree on chain, which this does not read',
    'that an issuer can pay',
    'that any deal was real or any work good',
    'that the participants are independent of each other',
    'that a key belongs to a handle: names are not anchored',
    'that a mandate was kept',
)
_HEX64 = re.compile(r'[0-9a-f]{64}')
_HEX66 = re.compile(r'[0-9a-f]{66}')
_HEX = re.compile(r'(?:[0-9a-f]{2})+')
_GROUP_ELEMENT = re.compile(r'070[23][0-9a-f]{64}')     # a GroupElement register: 0x07 || a compressed point
_DIGITS = re.compile(r'0|[1-9][0-9]*')


class ReadError(Exception):
    """A GET that gave no usable answer: none at all, an HTTP error status, or not JSON. status: the HTTP status (None
    without an answer); code: the `error` of a JSON error body (a Valun server's error code), if any; extra: that body."""

    def __init__(self, url, message, status=None, code=None, extra=None):
        super().__init__(message)
        self.url, self.status, self.code, self.extra = url, status, code, extra or {}


class _Unknown(Exception):
    """The comparison is left undecided: verdict UNKNOWN with this reason and message."""

    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


class _Again(Exception):
    """Read again (the snapshot or the box moved during the reads); after the last attempt, UNKNOWN with this reason."""

    def __init__(self, reason, message, wait_s=RETRY_S):
        super().__init__(message)
        self.reason, self.wait_s = reason, wait_s


def _short(v, n=300):
    s = str(v)
    return s if len(s) <= n else s[:n - 3] + '...'


def _nat(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _no_constant(name):
    raise ValueError(f'{name} is not JSON')


def _read_by(r, end, url):
    """The answer's body, read a buffer at a time, before the time.monotonic() `end`: a server that sends it a byte at a
    time (each within the socket's timeout) is cut off there (the 0.7.2 review), with at most MAX_ANSWER_BYTES + 1."""
    read = getattr(r, 'read1', None)
    if read is None:                            # a response object with no read1: read as before
        return r.read(MAX_ANSWER_BYTES + 1)
    chunks, n = [], 0
    while n <= MAX_ANSWER_BYTES:
        if time.monotonic() > end:
            raise ReadError(url, 'no answer in time (the server sends it too slowly)')
        b = read(min(1 << 16, MAX_ANSWER_BYTES + 1 - n))
        if not b:
            break
        chunks.append(b)
        n += len(b)
    return b''.join(chunks)


def get_json(url, timeout=30.0):
    """GET url and parse its JSON answer (exactly: integers stay ints; NaN and Infinity are refused). ReadError when there
    is no answer, an error status or no JSON, and when the answer has not come within `timeout` seconds of the request
    (each socket operation has that timeout too)."""
    req = urllib.request.Request(url, method='GET', headers={'Accept': 'application/json', 'User-Agent': USER_AGENT})
    end = time.monotonic() + timeout
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = _read_by(r, end, url)
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read(65536).decode('utf-8'))
        except Exception:  # noqa: BLE001 - an error body that is not JSON: the status says enough
            body = None
        finally:
            e.close()                           # the error's answer, read: its connection is not left to the collector
        body = body if isinstance(body, dict) else {}
        code = body.get('error') if isinstance(body.get('error'), str) else None
        msg = body.get('message') if isinstance(body.get('message'), str) else None
        raise ReadError(url, f'HTTP {e.code}' + (f' {code}' if code else '') + (f': {_short(msg)}' if msg else ''),
                        e.code, code, body) from None
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
        raise ReadError(url, f'no answer ({_short(getattr(e, "reason", None) or e)})') from None
    if len(data) > MAX_ANSWER_BYTES:
        raise ReadError(url, 'the answer is larger than 64 MiB')
    try:
        return json.loads(data.decode('utf-8'), parse_constant=_no_constant)
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise ReadError(url, f'the answer is not JSON ({_short(e, 120)})') from None


def base_url(url, what):
    """An http(s) URL with a host and no query or fragment, without its trailing slashes; ValueError otherwise."""
    if not isinstance(url, str) or any(c.isspace() for c in url):
        raise ValueError(f'{what} must be an http(s) URL')
    try:
        p = urllib.parse.urlsplit(url)
        port_ok = p.port is None or p.port > 0
    except ValueError:
        raise ValueError(f'{what} must be an http(s) URL') from None
    if p.scheme.lower() not in ('http', 'https') or not p.hostname or p.query or p.fragment or not port_ok:
        raise ValueError(f'{what} must be an http(s) URL with a host and no query (for example https://api-testnet.ergoplatform.com)')
    return url.rstrip('/')


def same_place(a, b):
    """Whether two URLs name the same scheme, host, port and path (the host's case, the default port and trailing
    slashes aside)."""
    def norm(u):
        p = urllib.parse.urlsplit(u.strip())
        port = p.port or {'http': 80, 'https': 443}.get(p.scheme.lower())
        return p.scheme.lower(), (p.hostname or '').lower(), port, p.path.rstrip('/')
    try:
        return isinstance(a, str) and isinstance(b, str) and norm(a) == norm(b)
    except ValueError:
        return False


def same_origin(a, b):
    """Whether two URLs name the same scheme, host and port (the host's case and the default port aside): one server
    answers both, whatever their paths."""
    def norm(u):
        p = urllib.parse.urlsplit(u.strip())
        return p.scheme.lower(), (p.hostname or '').lower(), p.port or {'http': 80, 'https': 443}.get(p.scheme.lower())
    try:
        return isinstance(a, str) and isinstance(b, str) and norm(a) == norm(b)
    except ValueError:
        return False


# ---------------------------------------------------------------------------------------------------------------------
# The chain source the user names.

class Explorer:
    """The Ergo explorer API v1: https://api-testnet.ergoplatform.com (the /api/v1 prefix is added when the URL has none)."""
    kind = 'explorer'
    lists_by_address = True                 # with a GET: the reserves can be asked (step 1)

    def __init__(self, url, get=None):
        self.url = base_url(url, '--explorer')
        self.api = self.url if self.url.endswith('/api/v1') else self.url + '/api/v1'
        self._get = get or get_json             # looked up when made, so a test can stand in for HTTP

    def check(self):
        """Nothing to check first: the explorer names no network, and the tracker NFT exists on one chain only."""

    def unspent_boxes(self, token_id):
        """(the boxes listed, the number of boxes the source counts or None)."""
        page = self._get(f'{self.api}/boxes/unspent/byTokenId/{token_id}?offset=0&limit={BOX_LIMIT}')
        if not isinstance(page, dict) or not isinstance(page.get('items'), list):
            raise _Unknown('source_inconsistent', 'the explorer did not answer {items, total} for the unspent boxes holding the tracker NFT')
        return page['items'], page.get('total') if _nat(page.get('total')) else None

    def unspent_at(self, address):
        """The unspent boxes at an address (the reserve contract), RESERVE_PAGE at a time and RESERVE_LIST_MAX at most, as
        anchor-audit.mjs reads them: (the boxes listed, as listed; whether that is all of them)."""
        listed, total = [], None
        for offset in range(0, RESERVE_LIST_MAX, RESERVE_PAGE):
            page = self._get(f'{self.api}/boxes/unspent/byAddress/{address}?offset={offset}&limit={RESERVE_PAGE}')
            if not isinstance(page, dict) or not isinstance(page.get('items'), list):
                raise _Unknown('source_inconsistent', 'the explorer did not answer {items, total} for the unspent boxes at the reserve contract')
            if _nat(page.get('total')):
                total = page['total']
            listed += page['items']
            if len(page['items']) < RESERVE_PAGE or (total is not None and offset + RESERVE_PAGE >= total):
                return listed, True
        return listed, False

    def height(self):
        ns = self._get(f'{self.api}/networkState')
        h = ns.get('height') if isinstance(ns, dict) else None
        if not _nat(h):
            raise _Unknown('source_inconsistent', 'the explorer did not give its height (GET /api/v1/networkState)')
        return h


class Node:
    """An Ergo node's REST API with the blockchain index (extraIndex): a testnet node (GET /info network)."""
    kind = 'node'
    # A node lists the boxes at an address only for a POST (/blockchain/box/unspent/byAddress), which this audit does not
    # send: the reserves cannot be asked from it (step 1).
    lists_by_address = False

    def __init__(self, url, get=None):
        self.url = base_url(url, '--node')
        self._get = get or get_json             # looked up when made, so a test can stand in for HTTP

    def check(self):
        """Before any box is taken from it: the node must say it is a testnet node."""
        self.height()

    def unspent_boxes(self, token_id):
        page = self._get(f'{self.url}/blockchain/box/unspent/byTokenId/{token_id}?offset=0&limit={BOX_LIMIT}')
        if not isinstance(page, list):
            raise _Unknown('source_inconsistent', 'the node did not answer a list of the unspent boxes holding the tracker NFT')
        return page, None

    def height(self):
        info = self._get(f'{self.url}/info')
        if not isinstance(info, dict) or str(info.get('network', '')).lower() != 'testnet':
            net = info.get('network') if isinstance(info, dict) else None
            raise _Unknown('source_inconsistent', f'the node says it is on {_short(net, 40)!r}, not testnet (GET /info network)')
        if not _nat(info.get('fullHeight')):
            raise _Unknown('source_inconsistent', 'the node did not give its height (GET /info fullHeight)')
        return info['fullHeight']


def _vlq(b, i):
    """An unsigned VLQ (LEB128, as SigmaByteWriter.putUInt writes it) at b[i]: (value, the index after it)."""
    value = 0
    for n in range(5):
        if i >= len(b):
            raise ValueError('it ends inside a number')
        value |= (b[i] & 0x7f) << (7 * n)
        i += 1
        if not b[i - 1] & 0x80:
            return value, i
    raise ValueError('a number longer than 5 bytes')


def decode_r5(value):
    """An AvlTree constant as a register holds it, hex: 0x64 || digest (33 bytes) || flags (1 byte) || key length (VLQ)
    || value length (0x00: none; 0x01 then a VLQ). Returns {digest, flags, key_length, value_length}; ValueError when it
    is not one (also with bytes after it)."""
    if not isinstance(value, str) or not _HEX.fullmatch(value.lower()):
        raise ValueError('it is not hex')
    b = bytes.fromhex(value)
    if len(b) < 37 or b[0] != 0x64:
        raise ValueError('it is not an AvlTree constant (type 0x64, a 33-byte digest, flags, key length, value length)')
    digest, flags = b[1:34], b[34]
    key_length, i = _vlq(b, 35)
    if i >= len(b):
        raise ValueError('it ends before its value length')
    tag, i = b[i], i + 1
    if tag == 0:
        value_length = None
    elif tag == 1:
        value_length, i = _vlq(b, i)
    else:
        raise ValueError(f'its value length is not an Option (tag {tag})')
    if i != len(b):
        raise ValueError(f'{len(b) - i} bytes follow the AvlTree')
    return {'digest': digest.hex(), 'flags': flags, 'key_length': key_length, 'value_length': value_length}


def _box_view(b, nft_id, kind):
    """The fields the audit uses of one box the source listed as unspent and holding the NFT, after checking that it is
    such a box; _Unknown(source_inconsistent) naming what is wrong otherwise."""
    bad = lambda why: _Unknown('source_inconsistent', why)  # noqa: E731
    if not isinstance(b, dict):
        raise bad(f'the {kind} listed something that is not a box')
    box_id = b.get('boxId').lower() if isinstance(b.get('boxId'), str) else None
    if not box_id or not _HEX64.fullmatch(box_id):
        raise bad(f'the {kind} listed a box without a box id')
    assets = b.get('assets') if isinstance(b.get('assets'), list) else []
    held = [a for a in assets if isinstance(a, dict) and isinstance(a.get('tokenId'), str) and a['tokenId'].lower() == nft_id]
    if not held:
        raise bad(f'the {kind} listed box {box_id} as holding the tracker NFT, and it does not hold it')
    if len(held) != 1 or not _nat(held[0].get('amount')) or held[0]['amount'] != 1:
        raise bad(f'box {box_id} holds the tracker NFT\'s token {len(held)} time(s), amount {_short(held[0].get("amount"), 30)}: an NFT is one token')
    if b.get('spentTransactionId') is not None:
        raise bad(f'the {kind} listed box {box_id} as unspent, and it was spent (transaction {_short(b["spentTransactionId"], 80)})')
    if b.get('mainChain') is False:
        raise bad(f'the {kind} listed box {box_id}, which is not on the main chain')
    if not _nat(b.get('creationHeight')):
        raise bad(f'the {kind} gave box {box_id} no creation height')
    regs = b.get('additionalRegisters') if isinstance(b.get('additionalRegisters'), dict) else {}
    r5 = regs.get('R5')
    if isinstance(r5, dict):                    # the explorer: {serializedValue, sigmaType, renderedValue}
        r5 = r5.get('serializedValue')
    tx = b.get('transactionId')
    # The tokens in their order in the box: by their index when the source gives every one an index (the explorer
    # does), else as listed; as anchor-audit.mjs assetsOf orders them.
    indexed = all(isinstance(a, dict) and isinstance(a.get('index'), int) and not isinstance(a['index'], bool) for a in assets)
    order = sorted(assets, key=lambda a: a['index']) if indexed else assets
    return {'box_id': box_id, 'tx_id': tx.lower() if isinstance(tx, str) and _HEX64.fullmatch(tx.lower()) else None,
            'creation_height': b['creationHeight'], 'r5': r5.lower() if isinstance(r5, str) else None,
            'nft_index': next(i for i, a in enumerate(order) if a is held[0])}


def _hint(source, e):
    """How to fix the usual wrong sources: a node without the blockchain index, an explorer's web page instead of its API."""
    if source.kind == 'node' and e.status in (400, 404):
        return ' (a node lists boxes by token only with its blockchain index: extraIndex = true in its configuration)'
    if source.kind == 'explorer' and (e.status == 404 or 'not JSON' in str(e)):
        return " (name the explorer's API, such as https://api-testnet.ergoplatform.com, not its web pages)"
    return ''


def _the_box(source, nft_id):
    """The one unspent box holding the NFT in the source, with R5 decoded and the construction checked."""
    try:
        listed, total = source.unspent_boxes(nft_id)
    except ReadError as e:
        raise _Unknown('source_unreadable', f'the {source.kind} at {source.url} did not answer: {e}{_hint(source, e)}') from None
    boxes = [_box_view(b, nft_id, source.kind) for b in listed]
    if total is not None and total != len(boxes):
        raise _Unknown('source_inconsistent', f'the {source.kind} at {source.url} counts {total} unspent boxes holding the '
                                              f'tracker NFT and lists {len(boxes)}: an NFT is in one box')
    count = len(boxes)
    if count == 0:
        raise _Unknown('no_tracker_box', f'the {source.kind} at {source.url} shows no unspent box holding the tracker NFT '
                                         f'{nft_id} (another network, a source that does not index it, or the NFT gone)')
    if count > 1:
        ids = ', '.join(b['box_id'] for b in boxes)
        raise _Unknown('source_inconsistent', f'the {source.kind} at {source.url} shows {count} unspent boxes holding the '
                                              f'tracker NFT ({ids}): an NFT is in one box')
    box = boxes[0]
    if box['r5'] is None:
        raise _Unknown('not_an_avl_tree', f"box {box['box_id']} has no R5 register: it commits no tree")
    try:
        tree = decode_r5(box['r5'])
    except ValueError as e:
        raise _Unknown('not_an_avl_tree', f"R5 of box {box['box_id']} is not an AvlTree: {e}") from None
    if tree['key_length'] != avl.KEY_LENGTH or tree['value_length'] is not None:
        raise _Unknown('not_an_avl_tree', f"R5 of box {box['box_id']} is a tree with key length {tree['key_length']} and value "
                                          f"length {tree['value_length']}, not this client's construction {CONSTRUCTION} (key "
                                          'length 32, no fixed value length)')
    return {**box, 'digest': tree['digest'], 'flags': tree['flags']}


# ---------------------------------------------------------------------------------------------------------------------
# What the server publishes.

def _read(get, server, path, what='the server'):
    try:
        return get(server + path)
    except ReadError as e:
        raise _Unknown('server_unreadable', f'{what} did not answer GET {path}: {e}') from None


def _chain(get, server):
    """GET /pilot/v1/chain: its network, its tracker NFT and its anchoring, checked."""
    try:
        chain = get(server + '/pilot/v1/chain')
    except ReadError as e:
        if e.status == 404 or e.code == 'testnet_bootstrapping':
            raise _Unknown('not_on_chain', f'{server} anchors no tracker on chain (GET /pilot/v1/chain: {e})') from None
        raise _Unknown('server_unreadable', f'the server did not answer GET /pilot/v1/chain: {e}') from None
    if not isinstance(chain, dict) or chain.get('on_chain') is not True:
        raise _Unknown('not_on_chain', f'{server} anchors no tracker on chain (GET /pilot/v1/chain on_chain is not true)')
    nft = chain.get('tracker_nft_id')
    if not isinstance(nft, str) or not _HEX64.fullmatch(nft):
        raise _Unknown('server_unreadable', 'GET /pilot/v1/chain names no tracker NFT (64 lowercase hex)')
    return chain


def _anchor_of(chain):
    """The fields of /chain anchoring that must stay the same around a ledger read (anchor-audit.mjs sameAnchoring: the
    update in flight too)."""
    a = chain.get('anchoring') if isinstance(chain.get('anchoring'), dict) else {}
    return {k: a.get(k) for k in ('anchored', 'local_digest', 'confirmed_digest', 'confirmed_box_id', 'confirmed_height',
                                  'pending_tx_id')}


def _row_of(n, denomination, total_key):
    """A row avl.digest() takes, from a ledger note (total_key 'total') or a committed row ('committed_total', never its
    live total): a malformed one is passed on as it is, so that digest() refuses it with its row number. A denomination
    that is null or absent is `denomination` (None: none is given, which digest() reads as erg), as anchor-audit.mjs
    reads one (null as erg)."""
    if not isinstance(n, dict):
        return n
    row = {'issuer_pubkey': n.get('issuer_pubkey'), 'recipient_pubkey': n.get('recipient_pubkey'), 'total': n.get(total_key)}
    d = n.get('denomination')
    if d is None:
        d = denomination
    if d is not None:
        row['denomination'] = d
    return row


def _committed(get, server, chain):
    """GET /pilot/v1/ledger/committed, or None from a server without it (an unknown public route answers 401
    unauthorized without a token, 404 with one). chain: this attempt's GET /chain, whose network the snapshot's must be."""
    try:
        snap = get(server + '/pilot/v1/ledger/committed')
    except ReadError as e:
        if e.status == 404 or (e.status == 401 and e.code == 'unauthorized'):
            return None
        if e.status == 503 and e.code == 'snapshot_moving':
            wait = e.extra.get('retry_after_ms')
            raise _Again('snapshot_moving', f'the server\'s committed snapshot kept moving ({e})',
                         wait / 1000 if _nat(wait) else RETRY_S) from None
        if e.status == 503 and e.code == 'no_confirmed_box':
            raise _Unknown('not_anchored', f'the server\'s tracker names no confirmed tracker box yet (GET '
                                           f'/pilot/v1/ledger/committed: {e}), so nothing is anchored to compare: run '
                                           'the audit again in a minute') from None
        raise _Unknown('server_unreadable', f'the server did not answer GET /pilot/v1/ledger/committed: {e}') from None
    if not isinstance(snap, dict) or not isinstance(snap.get('rows'), list):
        raise _Unknown('server_unreadable', 'GET /pilot/v1/ledger/committed did not answer {box_id, rows, ...}')
    # The construction is named, never assumed: rows of another tree, rebuilt as this one, would be a false MISMATCH.
    if snap.get('construction') != CONSTRUCTION:
        named = f"the construction {_short(snap.get('construction'), 60)!r}" if 'construction' in snap else 'no construction'
        raise _Unknown('unknown_construction', f'GET /pilot/v1/ledger/committed names {named}; this client rebuilds '
                                               f'{CONSTRUCTION} only' + (': update valun' if 'construction' in snap else ''))
    net, chain_net = snap.get('network'), chain.get('network')
    if net and chain_net and net != chain_net:              # as anchor-audit.mjs: compared where both name one
        raise _Unknown('server_inconsistent', f'the committed snapshot is of network {_short(net, 40)!r}, and GET '
                                              f'/pilot/v1/chain of {_short(chain_net, 40)!r}')
    box_id, height, digest = snap.get('box_id'), snap.get('height'), snap.get('digest')
    if not (isinstance(box_id, str) and _HEX64.fullmatch(box_id)) or not _nat(height) \
            or not (isinstance(digest, str) and _HEX66.fullmatch(digest)):
        raise _Unknown('server_unreadable', 'GET /pilot/v1/ledger/committed names no box, height or digest (box_id: 64 '
                                            'lowercase hex; height: a block height; digest: 66 lowercase hex)')
    rows = [_row_of(n, None, 'committed_total') for n in snap['rows']]
    # A row's debt key, where the snapshot gives one, must be its issuer's, recipient's and denomination's (as
    # anchor-audit.mjs checks it): a key the row's fields cannot give is left to digest(), which refuses the row.
    for i, (n, row) in enumerate(zip(snap['rows'], rows)):
        its_key = n.get('debt_key') if isinstance(n, dict) else None
        if its_key is None:
            continue
        try:
            own = avl.debt_key(row['issuer_pubkey'], row['recipient_pubkey'], row.get('denomination', 'erg')).hex()
        except avl.AvlError:
            continue
        if its_key != own:
            raise _Unknown('server_inconsistent', f'rows[{i}] of GET /pilot/v1/ledger/committed names the debt key '
                                                  f'{_short(its_key, 70)}, and its issuer, recipient and denomination give {own}')
    return {'from': '/pilot/v1/ledger/committed', 'rows': rows, 'box_id': box_id, 'height': height, 'digest': digest,
            'consistent': snap.get('consistent') if isinstance(snap.get('consistent'), bool) else None, 'notes': None}


def anchored_now(chain):
    """Does a GET /pilot/v1/chain answer say the tracker's state is anchored now: anchoring.anchored, and its local digest
    the confirmed one (the published ledger is then the state its confirmed box commits)?"""
    a = _anchor_of(chain)
    return a['anchored'] is True and isinstance(a['local_digest'], str) and a['local_digest'] == a['confirmed_digest']


def _wait_anchored(get, server, chain, nft, sleep, deadline, clock, log=None):
    """--wait-anchored (fix inbox #86): GET /pilot/v1/chain every WAIT_POLL_S until it says the tracker's state is
    anchored (anchored_now), until `deadline` on `clock` (the 0.7.2 review: one deadline for the whole audit, which
    counts the reads too, so the wait ends at the deadline, or one read after it; get_json caps a read's time). A read
    that fails meanwhile is read again at the next poll; another tracker NFT is UNKNOWN (server_inconsistent). Returns
    the last answer read; log(text) says once that it waits."""
    if not anchored_now(chain) and log is not None:
        log(f'The tracker\'s state is not anchored yet (its ledger is ahead of its last box): waiting up to '
            f'{max(0.0, deadline - clock()):g} s for the next box, reading GET /pilot/v1/chain every {WAIT_POLL_S:g} s.')
    while not anchored_now(chain):
        left = deadline - clock()
        if not left > 0:
            break
        sleep(min(WAIT_POLL_S, left))
        try:
            fresh = _chain(get, server)
        except _Unknown as u:
            if u.reason != 'server_unreadable':
                raise
            continue                            # read again at the next poll
        if fresh['tracker_nft_id'] != nft:
            raise _Unknown('server_inconsistent', 'GET /pilot/v1/chain named another tracker NFT during the audit')
        chain = fresh
    return chain


def _ledger_between(get, server, chain_a, sleep, waited=None):
    """GET /ledger between two reads of GET /chain, taken as the confirmed state only while both say the same box and
    digest and that the tracker's state is anchored. GET /ledger is sent SETTLE_S after chain_a was answered, and the
    second GET /chain SETTLE_S after the ledger was: the server's public read cache serves an entry for at most
    PUBLIC_CACHE_MS, so each answer is computed after the one before it, and the two /chain answers bracket the ledger.
    (The pilot writes the tracker, then saves, and only a save ends a cache entry: a second /chain sent at once could be
    the first one's cached answer, older than a note the ledger computed after the write shows.) Not anchored: UNKNOWN
    (not_anchored), saying why plainly (fix inbox #86): this server has no committed-snapshot route, and the older one
    compares only while the published ledger is the anchored state; `waited`, the seconds --wait-anchored waited (None:
    it was not asked to wait)."""
    a = _anchor_of(chain_a)
    if not anchored_now(chain_a) or not (isinstance(a['confirmed_box_id'], str) and _HEX64.fullmatch(a['confirmed_box_id'])):
        anchoring = chain_a.get('anchoring')
        state = anchoring.get('state') if isinstance(anchoring, dict) else None
        raise _Unknown('not_anchored', (
            'this server has no committed-snapshot route yet (GET /pilot/v1/ledger/committed is not deployed on it), so '
            'this audit can compare only the ledger it publishes (GET /pilot/v1/ledger), and only while that ledger is the '
            'state its last tracker box anchored. Right now the ledger is ahead of that box (GET /pilot/v1/chain '
            'anchoring: not anchored, or its local digest is not the confirmed one'
            + (f'; state {_short(state, 40)}' if state else '') + ')'
            + ('. Run the audit right after the next tracker box (one is made about every 5 minutes while notes change), '
               'or pass --wait-anchored to wait for it' if waited is None else
               f', and it was so still when the {waited:g} s this audit waited for a box ran out (--wait-anchored). Run '
               'the audit again after the next tracker box (one is made about every 5 minutes while notes change), or '
               'wait longer (--wait-anchored SECONDS)')))
    info = _read(get, server, '/pilot/v1/info')
    denomination = info.get('denomination') if isinstance(info, dict) else None
    if not isinstance(denomination, str):
        raise _Unknown('server_unreadable', 'GET /pilot/v1/info names no denomination')
    sleep(SETTLE_S)
    ledger = _read(get, server, '/pilot/v1/ledger')
    if not isinstance(ledger, dict) or not isinstance(ledger.get('notes'), list):
        raise _Unknown('server_unreadable', 'GET /pilot/v1/ledger did not answer {notes, ...}')
    sleep(SETTLE_S)
    chain_b = _chain(get, server)
    if chain_b['tracker_nft_id'] != chain_a['tracker_nft_id']:
        raise _Unknown('server_inconsistent', 'GET /pilot/v1/chain named another tracker NFT during the audit')
    if _anchor_of(chain_b) != a:
        raise _Again('ledger_moving', 'the tracker\'s state or box changed while its ledger was read')
    return {'from': LEDGER_ROUTE, 'rows': [_row_of(n, denomination, 'total') for n in ledger['notes']],
            'box_id': a['confirmed_box_id'], 'height': a['confirmed_height'] if _nat(a['confirmed_height']) else None,
            'digest': a['confirmed_digest'] if isinstance(a['confirmed_digest'], str) else None, 'consistent': None,
            'notes': ledger['notes']}


def _inexact(rows):
    """The first row whose total is a JSON number above 2^53 - 1 (a JavaScript server's Number may have been rounded
    before it was written), as (row, total); None when there is none."""
    for i, r in enumerate(rows):
        t = r.get('total') if isinstance(r, dict) else None
        if isinstance(t, (int, float)) and not isinstance(t, bool) and abs(t) > avl.MAX_SAFE_INTEGER:
            return i, t
    return None


# ---------------------------------------------------------------------------------------------------------------------
# The tracker NFT (step 1): which one the server must name.

def origin(url):
    """A URL's origin as a JavaScript URL gives it (anchor-audit.mjs keys TRACKER_NFTS by it): scheme://host[:port], the
    scheme and host in lower case and a default port left out; None for anything that is not an http(s) URL."""
    try:
        p = urllib.parse.urlsplit(url.strip())
        port = p.port
    except (AttributeError, ValueError):
        return None
    scheme, host = p.scheme.lower(), p.hostname
    if scheme not in ('http', 'https') or not host:
        return None
    host = f'[{host}]' if ':' in host else host
    return f'{scheme}://{host}' + ('' if port in (None, {'http': 80, 'https': 443}[scheme]) else f':{port}')


def tracker_nft_id(value):
    """A tracker NFT id as --tracker-nft takes it: 64 lowercase hex characters, as GET /pilot/v1/chain writes one (and
    as anchor-audit.mjs takes it); ValueError for anything else."""
    if not (isinstance(value, str) and _HEX64.fullmatch(value)):
        raise ValueError('--tracker-nft must be a token id: 64 lowercase hex characters, as GET /pilot/v1/chain names it')
    return value


def _profile_pin(server, state, mine):
    """The tracker NFT this profile pinned, where its pin applies (step 1: the audit of its own server, or --mine)."""
    pins = vc._pins_of(state)
    return pins['tracker_nft_id'] if pins and (mine or same_place(server, state.get('server'))) else None


def _pin_of(server, nft, state, mine, tracker_nft):
    """Step 1, before anything else is read: the pins `nft` (the one GET /chain names) must hold to, as {pin, pinned_by,
    ask_reserves, warnings, mismatch}. With tracker_nft (--tracker-nft) it is that one only, as anchor-audit.mjs takes
    it. Otherwise it must hold to every pin that applies: this profile's first, then the one TRACKER_NFTS has for this
    server; for a server TRACKER_NFTS does not know, the reserves are asked as well (ask_reserves: _reserves_naming), so
    that no NFT anchor-audit.mjs would refuse passes here. pinned_by: who pinned `pin` ('you', 'profile', 'this audit';
    None when no pin applies, and pin is None). mismatch: the UNKNOWN's message (tracker_mismatch) when `nft` is not a
    pin, naming both; `pin` is then the one it is not."""
    at, profile, known = origin(server), _profile_pin(server, state, mine), TRACKER_NFTS.get(origin(server))
    out = {'pin': None, 'pinned_by': None, 'ask_reserves': False, 'warnings': [], 'mismatch': None}
    if tracker_nft is not None:
        out.update(pin=tracker_nft, pinned_by='you')
        if nft != tracker_nft:
            out['mismatch'] = f'the server {server} names tracker NFT {nft}, not {tracker_nft}, the one you pinned (--tracker-nft)'
        if profile is not None and profile != tracker_nft:
            out['warnings'].append(f'this profile is pinned to tracker {profile}, and you pinned {tracker_nft} '
                                   '(--tracker-nft): the notes this profile signs and verifies name its own')
        if known is not None and known != tracker_nft:
            out['warnings'].append(f'this audit pins tracker {known} for {at} (its GET /pilot/v1/chain of '
                                   f'{TRACKER_NFTS_READ}), and you pinned {tracker_nft} (--tracker-nft)')
    elif profile is not None and nft != profile:
        out.update(pin=profile, pinned_by='profile', mismatch=(
            f'the server {server} names tracker NFT {nft}, not {profile}, the one this profile is pinned to: the notes it '
            'signs and verifies name that one'))
    elif known is not None and nft != known:
        out.update(pin=known, pinned_by='this audit', mismatch=(
            f'the server {server} names tracker NFT {nft}, not {known}, the one this audit pins for {at} (its GET '
            f'/pilot/v1/chain of {TRACKER_NFTS_READ}): a tracker the operator made could commit whatever it publishes. If '
            f'the operator moved to a new tracker, check that the reserves trust it, then pass --tracker-nft {nft}'))
    else:
        by = 'profile' if profile is not None else 'this audit' if known is not None else None
        out.update(pin=nft if by else None, pinned_by=by, ask_reserves=known is None)
    return out


def _whole(v):
    """A whole number as a source may write a box's value or a token amount: an int, or a decimal string of one."""
    return _nat(v) or (isinstance(v, str) and _DIGITS.fullmatch(v) is not None)


def _register(regs, name):
    """A register's hex as the explorer ({serializedValue, ...}) or a node (the hex itself) gives it; None without it."""
    v = regs.get(name)
    return v if isinstance(v, str) else v.get('serializedValue') if isinstance(v, dict) else None


def _coll_byte(value):
    """A Coll[Byte] register (0x0e || its length, a VLQ || the bytes), lowercase hex: the bytes as hex; ValueError
    otherwise (as anchor-audit.mjs decodeCollByte)."""
    if not isinstance(value, str) or not _HEX.fullmatch(value):
        raise ValueError('it is not lowercase hex')
    b = bytes.fromhex(value)
    if b[0] != 0x0e:
        raise ValueError('it is not a Coll[Byte]')
    n, i = _vlq(b, 1)
    if i + n != len(b):
        raise ValueError('its length is not that of its bytes')
    return b[i:].hex()


def _reserve_box(b, kind, tree, address):
    """One box the source listed at the reserve contract, checked as anchor-audit.mjs checks it (normBox,
    reserveListing): {box_id, tracker: the NFT of the tracker it trusts (R6), owner: its owner's key (R4)}, both None
    when either register cannot be read. _Unknown(source_inconsistent) for a box that is no box, is not at the contract
    (by its ErgoTree: the explorer's address of a long script is an abbreviation), or is spent."""
    bad = lambda why: _Unknown('source_inconsistent', why)  # noqa: E731
    if not isinstance(b, dict):
        raise bad(f'the {kind} listed something that is not a box at the reserve contract')
    box_id = b.get('boxId')
    if not (isinstance(box_id, str) and _HEX64.fullmatch(box_id)):
        raise bad(f'the {kind} listed a box at the reserve contract without a box id')
    assets = b.get('assets') if isinstance(b.get('assets'), list) else []
    if not _nat(b.get('creationHeight')) or not _whole(b.get('value')) \
            or not all(isinstance(a, dict) and _whole(a.get('amount')) for a in assets):
        raise bad(f'reserve box {box_id} has no creation height, or a value or token amount that is not a whole number')
    if (b.get('ergoTree') != tree) if tree is not None else (b.get('address') != address):
        raise bad(f'box {box_id}, listed at the reserve contract, is not at its address (another ErgoTree)')
    if b.get('spentTransactionId'):
        raise bad(f'reserve box {box_id}, listed as unspent, was spent (transaction {_short(b["spentTransactionId"], 80)})')
    regs = b.get('additionalRegisters') if isinstance(b.get('additionalRegisters'), dict) else {}
    owner = _register(regs, 'R4')
    try:
        tracker = _coll_byte(_register(regs, 'R6'))
        if not (isinstance(owner, str) and _GROUP_ELEMENT.fullmatch(owner)):
            raise ValueError('R4 is not a GroupElement')
    except ValueError:
        return {'box_id': box_id, 'tracker': None, 'owner': None}
    return {'box_id': box_id, 'tracker': tracker, 'owner': owner[2:]}


def _reserves_naming(source, chain, nft, server, pinned_by=None):
    """Step 1 for a server TRACKER_NFTS does not know, as anchor-audit.mjs asks the reserves for a server it pins no NFT
    for: the reserve contract GET /chain names must be the pinned one (RESERVE_CONTRACT_SHA256), and at least one
    unspent box there, as the chain source lists them, must name the tracker NFT in R6 (with an owner key in R4).
    Returns how many do; _Unknown otherwise (tracker_not_pinned, or the source's reasons). pinned_by: who else pinned
    the NFT ('profile': this profile's pin, which is not enough, as it took the server's word at its first read)."""
    at = origin(server) or server
    why = (" (this profile's pin is not enough: it took the server's word at the profile's first read of it)"
           if pinned_by == 'profile' else '')
    address = chain.get('reserve_contract')
    if not (isinstance(address, str) and address):
        raise _Unknown('tracker_not_pinned', (
            f'this audit pins no tracker NFT for {at}{why}, and GET /pilot/v1/chain names no reserve contract that could '
            f'show a reserve trusting the tracker NFT {nft} it names: a tracker the operator made could commit whatever it '
            'publishes; pin the tracker NFT you expect with --tracker-nft'))
    if hashlib.sha256(address.encode('utf-8')).hexdigest() != RESERVE_CONTRACT_SHA256:
        raise _Unknown('tracker_not_pinned', (
            f"the tracker NFT {nft} and the reserve contract are both only the server's word (this audit pins no tracker "
            f'NFT for {at}{why}, and the reserve contract GET /pilot/v1/chain names is not the one it pins): a tracker the '
            'operator made could commit whatever it publishes; pin the tracker NFT you expect with --tracker-nft'))
    if not source.lists_by_address:
        raise _Unknown('tracker_not_pinned', (
            f'this audit pins no tracker NFT for {at}{why}, so it asks the reserves whether they trust the tracker NFT '
            f'{nft} the server names, and a {source.kind} lists the boxes at the reserve contract only for a POST, which '
            'this audit does not send (GET only): pin the tracker NFT you expect with --tracker-nft, or name the explorer '
            '(--explorer) to ask the reserves'))
    try:
        tree = ergo.address_to_tree(address)
    except vc.ValunError:
        tree = None                             # compared by the address the source gives, as anchor-audit.mjs does
    try:
        listed, complete = source.unspent_at(address)
    except ReadError as e:
        raise _Unknown('source_unreadable', f'the {source.kind} at {source.url} did not list the boxes at the reserve '
                                            f'contract: {e}{_hint(source, e)}') from None
    boxes = {x['box_id']: x for x in (_reserve_box(b, source.kind, tree, address) for b in listed)}
    naming = sum(1 for x in boxes.values() if x['tracker'] == nft and x['owner'] is not None)
    others = sum(1 for x in boxes.values() if x['tracker'] is not None and x['tracker'] != nft)
    if not naming:
        raise _Unknown('tracker_not_pinned', (
            f'no reserve box at the pinned reserve contract names the tracker NFT {nft} the server gives'
            + (f' ({others} name another)' if others else '')
            + ('' if complete else f' among the first {len(boxes)} the {source.kind} lists') + why
            + ': it may be a tracker the operator made to commit whatever it publishes, which no redemption trusts; pin '
              'the tracker NFT you expect with --tracker-nft (a tracker with no reserve yet must be pinned)'))
    return naming


# ---------------------------------------------------------------------------------------------------------------------
# The audit.

def audit(server, source, *, profile_state=None, mine=False, tracker_nft=None, get=None, sleep=None, attempts=ATTEMPTS,
          wait_anchored=None, log=None, clock=None):
    """Check that the rows `server` publishes are what the one unspent tracker-NFT box in `source` (an Explorer or a Node)
    commits (the module docstring). profile_state: a profile's state (its server and pins and, for mine, its
    participant, key, records and R4 records), read and never changed. tracker_nft: the tracker NFT id the server must name
    (--tracker-nft; tracker_nft_id() checks it, ValueError), which overrides every other pin (step 1). wait_anchored
    (--wait-anchored, fix inbox #86): before the rows are read, wait until GET /chain says the tracker's state is
    anchored, for at most this many seconds in all (_wait_anchored; one deadline, which a later attempt waits under too,
    when the state moved on meanwhile; the result's waited_s says how long it waited): its ledger is then the state its
    box commits, so a server without GET /ledger/committed can be compared, and --mine compares records the box has
    caught up with; log(text) says that it waits. clock() reads the time the deadline is on (time.monotonic; with an
    injected sleep and no clock, the time slept). Returns the
    result as a JSON-ready dict: verdict MATCH, MISMATCH or UNKNOWN, reason and message, the tracker {nft: the one GET
    /chain names, pin: the one it must be (None when nothing pins it), pinned_by: 'you', 'profile', 'this audit' or
    None, reserves_naming_it: how many reserves at the pinned reserve contract name it (None when they were not
    asked)} and tracker_nft_pinned (whether a pin holds it), the box, the rows' source, count and digest, what the
    server says, the height, the box's age and windows, warnings, and with mine the edges (mine_report).
    exit_code(result) is the command's exit code. get(url) reads the server (get_json by default) and sleep(seconds)
    waits between attempts and between the older reads of step 2 (time.sleep)."""
    if tracker_nft is not None:
        tracker_nft_id(tracker_nft)
    get, sleep = get or get_json, sleep or time.sleep
    if clock is None and sleep is time.sleep:
        clock = time.monotonic
    elif clock is None:                         # an injected sleep (a test's): the time is what it slept
        spent, slept = [0.0], sleep

        def sleep(s):
            spent[0] += s
            slept(s)

        def clock():
            return spent[0]
    waited = [0.0]

    def wait(chain, deadline, log=None):
        t = clock()
        try:
            return _wait_anchored(get, server, chain, chain['tracker_nft_id'], sleep, deadline, clock, log)
        finally:
            waited[0] += clock() - t
    out = {'verdict': None, 'reason': None, 'message': None, 'server': server, 'network': None, 'tracker_nft_id': None,
           'tracker_nft_pinned': False, 'tracker': None, 'construction': CONSTRUCTION,
           'chain_source': {'kind': source.kind, 'url': source.url, 'named_by_server': False},
           'box': None, 'rows': None, 'server_says': None, 'height': None, 'box_age_blocks': None,
           'nettings_refused_from_height': None, 'tracker_less_redemption_from_height': None, 'attempts': 0, 'warnings': [],
           'waited_s': None}
    state = profile_state if isinstance(profile_state, dict) else {}
    attempts = max(1, attempts)
    try:
        chain = _chain(get, server)
        nft = chain['tracker_nft_id']
        out.update(network=chain.get('network') if isinstance(chain.get('network'), str) else None, tracker_nft_id=nft)
        if source.kind == 'node' and same_place(source.url, chain.get('node')):
            out['chain_source']['named_by_server'] = True
            out['warnings'].append(f'the chain source {source.url} is the node the server itself names (GET /pilot/v1/chain '
                                   'node): the operator may run it, so this is not an independent check; name your own node '
                                   'or the public explorer')
        pin = _pin_of(server, nft, state, mine, tracker_nft)
        out['tracker'] = {'nft': nft, 'pin': pin['pin'], 'pinned_by': pin['pinned_by'], 'reserves_naming_it': None}
        if pin['mismatch']:
            raise _Unknown('tracker_mismatch', pin['mismatch'])
        out['tracker_nft_pinned'] = pin['pinned_by'] is not None
        out['warnings'] += pin['warnings']
        try:
            source.check()
        except ReadError as e:
            raise _Unknown('source_unreadable', f'the {source.kind} at {source.url} did not answer: {e}{_hint(source, e)}') from None
        if pin['ask_reserves']:
            n = out['tracker']['reserves_naming_it'] = _reserves_naming(source, chain, nft, server, pin['pinned_by'])
            if pin['pinned_by'] is None:            # anchor-audit.mjs's warning: the reserves are no pin
                out['warnings'].append(f"the tracker NFT {nft} is not pinned for {origin(server) or server}: {n} reserve "
                                       f"box{'' if n == 1 else 'es'} at the pinned reserve contract name{'s' if n == 1 else ''} "
                                       'it, which an operator can arrange for a tracker of its own too; pin it with --tracker-nft')
        deadline = clock() + min(float(wait_anchored), WAIT_ANCHORED_MAX_S) if wait_anchored else None
        if deadline is not None:
            chain = wait(chain, deadline, log)
            out['waited_s'] = round(waited[0], 3)
        for attempt in range(1, attempts + 1):
            out['attempts'] = attempt
            try:
                if attempt > 1:
                    chain = _chain(get, server)
                    if chain['tracker_nft_id'] != nft:
                        raise _Unknown('server_inconsistent', 'GET /pilot/v1/chain named another tracker NFT during the audit')
                    if deadline is not None:        # the state moved on meanwhile: wait again, under the same deadline
                        chain = wait(chain, deadline)
                        out['waited_s'] = round(waited[0], 3)
                snap = _committed(get, server, chain) or _ledger_between(get, server, chain, sleep, out['waited_s'])
                box = _the_box(source, nft)
                inexact = _inexact(snap['rows'])
                if inexact:
                    raise _Unknown('inexact_total', f'rows[{inexact[0]}] of GET {snap["from"]} has the total {inexact[1]}, a JSON '
                                                    'number above 2^53 - 1, which a JavaScript server may have rounded before '
                                                    'writing it; it cannot be checked exactly')
                try:
                    rebuilt = avl.digest(snap['rows'])
                except avl.AvlError as e:
                    raise _Unknown('rows_malformed', f'the rows of GET {snap["from"]} cannot be digested as the tracker digests '
                                                     f'its notes: {e}') from None
                if rebuilt != box['digest'] and snap['box_id'] != box['box_id']:
                    raise _Again('box_moved', f"GET {snap['from']} is for box {snap['box_id']}, and the {source.kind}'s one "
                                              f"unspent tracker box is {box['box_id']} (the chain moved during the audit, or "
                                              'the source lags): run the audit again in a minute')
                # Rows of GET /ledger that give neither R5 nor the digest GET /chain, read before and after them, names
                # as the anchored state are not that state: a ledger read under a server cache longer than SETTLE_S
                # looks so, as does a tracker note GET /ledger does not list. Read again, and UNKNOWN when they stay so:
                # never a MISMATCH (the module docstring), which on this route needs rows that give that digest.
                if snap['from'] == LEDGER_ROUTE and rebuilt != box['digest'] and rebuilt != snap['digest']:
                    raise _Again('ledger_moving', (
                        f"the {len(snap['rows'])} rows of GET {LEDGER_ROUTE} give {rebuilt}, which is neither R5 of box "
                        f"{box['box_id']} ({box['digest']}) nor the digest GET /pilot/v1/chain, read before and after them, "
                        f"names as the tracker's anchored state ({_short(snap['digest'], 80)}): the ledger the server "
                        'published is not the state it calls anchored, so it is not compared with the box. A ledger read '
                        'under a server cache longer than this audit waits looks so, and so does a tracker note GET '
                        "/pilot/v1/ledger does not list (it lists the network's denomination only): run the audit again, "
                        'and if it stays so, against a server with GET /pilot/v1/ledger/committed (every note, exactly)'))
                break
            except _Again as again:
                if attempt == attempts:
                    raise _Unknown(again.reason, str(again)) from None
                sleep(min(max(again.wait_s, 0.0), MAX_WAIT_S))
        # The source's height, which the box's age and windows need: none is UNKNOWN (as anchor-audit.mjs has it).
        try:
            height = source.height()
        except ReadError as e:
            raise _Unknown('source_unreadable', f"the {source.kind} at {source.url} did not give its height, so the box's "
                                                f'age is not known: {e}{_hint(source, e)}') from None
        h = box['creation_height']
        out['box'] = {k: box[k] for k in ('box_id', 'tx_id', 'creation_height', 'r5', 'digest', 'flags')}
        out['rows'] = {'from': snap['from'], 'count': len(snap['rows']), 'digest': rebuilt}
        out['server_says'] = {'box_id': snap['box_id'], 'height': snap['height'], 'digest': snap['digest'],
                              'consistent': snap['consistent']}
        out['height'], out['box_age_blocks'] = height, height - h
        out['nettings_refused_from_height'], out['tracker_less_redemption_from_height'] = h + FRESH_BLOCKS, h + TRACKER_LESS_AFTER_BLOCKS + 1
        if out['box_age_blocks'] < 0:
            out['warnings'].append(f"the {source.kind}'s height {height} is below the box's creation height {h}")
        if box['nft_index'] != 0:
            not_first = (f"box {box['box_id']} holds the tracker NFT as its token {box['nft_index']}, and the reserve contract "
                         "reads a tracker box's NFT as its first token (basis.es tracker.tokens(0)): no redemption can use "
                         'this box as it is')
            # No window of the box's age applies to a box no redemption can use (anchor-audit.mjs: windows null).
            out['nettings_refused_from_height'] = out['tracker_less_redemption_from_height'] = None
            if rebuilt == box['digest']:
                raise _Unknown('nft_not_first', f'the rows give R5 of the one unspent box holding the tracker NFT, and {not_first}, '
                                                'so what it commits binds no redemption: nothing is proven')
            out['warnings'].append(not_first)
        if rebuilt == box['digest']:
            out.update(verdict='MATCH', message=PROVES.format(height=box['creation_height'], count=len(snap['rows'])))
            # What the server says of its box, where the chain says otherwise (the rows give R5 all the same).
            if snap['box_id'] != box['box_id']:
                out['warnings'].append(f"the server's rows are for box {snap['box_id']}, and the source's one unspent tracker box "
                                       f"is {box['box_id']}; their digests are equal")
            elif snap['digest'] is not None and snap['digest'] != box['digest']:
                out['warnings'].append(f"the server says box {box['box_id']} commits {_short(snap['digest'], 80)}, and its R5 "
                                       f"is {box['digest']}: the rows give R5")
            elif snap['height'] is not None and snap['height'] != box['creation_height']:
                out['warnings'].append(f"the server says box {box['box_id']} was created at height {snap['height']}; the "
                                       f"{source.kind} says {box['creation_height']}")
            if snap['consistent'] is False:
                out['warnings'].append("the server's own check of these rows says consistent: false, and they give R5")
        else:
            claimed = snap['digest']
            out.update(verdict='MISMATCH', reason='records_disagree_with_chain', message=(
                f"the {len(snap['rows'])} rows of GET {snap['from']}, which the server publishes for box {box['box_id']}, do "
                f"not rebuild the digest that box commits in R5 ({box['digest']}, read from the {source.kind} at "
                f"{source.url}; the rows give {rebuilt}): the tracker's records and the chain disagree."
                + ('' if claimed is None else
                   f" The rows give the digest the server says that box commits ({_short(claimed, 80)}), which is not "
                   "its R5: the server's confirmed digest is not on chain." if rebuilt == claimed else
                   f" They do not give the digest the server says that box commits either ({_short(claimed, 80)}).")
                + ' Either the tracker anchored a state other than the one it reports (a fault, such as a write between '
                'its digest and its confirmation) or the published records were changed. Report it with this output.'
                + (' The server\'s own check of these rows says consistent: '
                   f"{str(snap['consistent']).lower()}." if snap['consistent'] is not None else '')))
    except _Unknown as u:
        out.update(verdict='UNKNOWN', reason=u.reason, message=str(u))
        return out
    if out['verdict'] != 'MATCH':
        return out                      # no published total is known to be anchored: --mine lists nothing
    out['does_not_prove'] = list(DOES_NOT_PROVE)
    if mine:
        try:
            notes = snap['notes'] if snap['notes'] is not None else _read(get, server, '/pilot/v1/ledger').get('notes')
        except (_Unknown, AttributeError) as e:
            notes = None
            out['warnings'].append(f'--mine: GET /pilot/v1/ledger could not be read, so only this agent\'s own key and the '
                                   f'keys this profile\'s records show are known: {e}')
        out['mine'] = mine_report(state, snap['rows'], notes if isinstance(notes, list) else [], tracker_nft=nft)
    return out


def exit_code(result):
    """The command's exit code for an audit result (the module docstring)."""
    v = result.get('verdict')
    if v == 'MISMATCH':
        return EXIT_MISMATCH
    if v != 'MATCH':
        return EXIT_NOTHING_COMPARED
    mine = result.get('mine')
    if mine is not None and not mine.get('all_proven'):
        return EXIT_NOT_PROVEN
    return EXIT_MATCH


# ---------------------------------------------------------------------------------------------------------------------
# --mine: this participant's edges.

def _pubkey_ok(v):
    return isinstance(v, str) and len(v) == 66 and v[:2] in ('02', '03') and all(c in '0123456789abcdef' for c in v)


def _pair_keys(pair):
    """(issuer, recipient) of a records pair '<issuer>><recipient>' of two public keys; (None, None) for anything else
    (records['paid_deals'] among them)."""
    i, sep, rc = pair.partition('>') if isinstance(pair, str) else ('', '', '')
    return (i, rc) if sep and _pubkey_ok(i) and _pubkey_ok(rc) else (None, None)


def mine_report(state, rows, notes, tracker_nft=None):
    """This participant's edges in the anchored rows and in this profile's records (the module docstring): {participant,
    keys [{pubkey, known_from}], edges [...], proven, not_proven, all_proven}, and {problem, message} when nothing can
    be compared. state: the profile's state, read and never changed; rows: the rows the chain commits (an audit's MATCH:
    digested already, so each total is a str of digits, an int or a safe-integer float, and no two rows share a pair
    and denomination); notes: GET /ledger's notes, which name each key's participant; tracker_nft: the tracker whose box
    commits the rows (None: the pinned one). known_from: this_agent (the profile's key), ledger (GET /ledger names it as
    this participant's) or records (this profile signed with it)."""
    pid, me, pins = state.get('participant_id'), state.get('pubkey'), vc._pins_of(state)
    keys, owner = {}, {}
    if _pubkey_ok(me):
        keys[me] = 'this_agent'
    for n in notes:
        for side in ('issuer', 'recipient'):
            k, p = (n.get(f'{side}_pubkey'), n.get(side)) if isinstance(n, dict) else (None, None)
            if _pubkey_ok(k) and isinstance(p, str):
                owner.setdefault(k, p)
                if p == pid and k not in keys:
                    keys[k] = 'ledger'
    recs = state.get('records') if isinstance(state.get('records'), dict) else {}
    # Every pair of the records is an edge this client is party to (records.py), on the key it held when it signed: a
    # pending entry's direction says which side that key is (out: the issuer; in: the recipient). A pair with neither
    # key known, and no single direction, places no key: its edge is still listed below, at its anchored total.
    for pair in recs:
        i, rc = _pair_keys(pair)
        if i is None or i in keys or rc in keys:
            continue
        dirs = {p.get('direction') for p in records.get(recs, pair)['pending'] if isinstance(p, dict)}
        k = i if dirs == {'out'} else rc if dirs == {'in'} else None
        if k is not None:
            keys[k] = 'records'
    key_list = [{'pubkey': k, 'known_from': how} for k, how in keys.items()]
    if not (pins and isinstance(pins.get('denomination'), str)):
        return {'participant': pid, 'keys': key_list, 'edges': [], 'proven': 0, 'not_proven': 0, 'all_proven': False,
                'problem': 'no_pinned_tracker',
                'message': 'this profile has no pinned tracker and denomination yet (it pins them at its first read of the '
                           "server's GET /info, such as `valun call valun_status`), so its records can be neither matched "
                           'to the anchored rows nor verified: nothing of yours is proven'}
    if tracker_nft is not None and pins['tracker_nft_id'] != tracker_nft:
        return {'participant': pid, 'keys': key_list, 'edges': [], 'proven': 0, 'not_proven': 0, 'all_proven': False,
                'problem': 'another_tracker',
                'message': f"this profile is pinned to tracker {pins['tracker_nft_id']}, and these rows are what the box of "
                           f'tracker {tracker_nft} commits (--tracker-nft): its records are of the other tracker\'s notes, so '
                           'they are not compared with these rows: nothing of yours is proven'}
    denomination = pins['denomination']
    verify = vc.Client._note_verifier(pins['tracker_nft_id'], denomination)
    # Every row by (pair, denomination), whatever its keys, indexed once: the rows on a key of this participant are
    # listed from it, and each edge this profile's records confirm is looked up in it (the records are about the pinned
    # denomination only), so an edge on a key the audit did not place is compared at its anchored total, never called
    # not_anchored.
    anchored = {(records.pair_key(r['issuer_pubkey'], r['recipient_pubkey']), r.get('denomination', 'erg')):
                (r['issuer_pubkey'], r['recipient_pubkey'], int(r['total'])) for r in rows}
    mine = _Mine(keys, _consent_verifier(pins['tracker_nft_id'], denomination),
                 state.get('signed') if isinstance(state.get('signed'), dict) else {}, recs,
                 {pair: total for (pair, d), (_i, _rc, total) in anchored.items() if d == denomination})
    edges, listed = [], set()
    for (pair, d), (i, rc, total) in anchored.items():
        if i not in keys and rc not in keys:
            continue
        mine_here = d == denomination                   # this profile's records are about its pinned denomination only
        if mine_here:
            listed.add(pair)
        edges.append(_edge(pair, i, rc, d, total, records.get(recs, pair) if mine_here else None, verify, keys, owner, mine))
    for pair in recs:
        if pair == 'paid_deals' or pair in listed or not isinstance(pair, str) or '>' not in pair:
            continue
        rec = records.get(recs, pair)
        if rec['confirmed'] is None:
            continue
        i, _sep, rc = pair.partition('>')
        hit = anchored.get((pair, denomination))
        edges.append(_edge(pair, i, rc, denomination, hit[2] if hit else None, rec, verify, keys, owner, mine))
    proven = sum(1 for e in edges if e['status'] in PROVEN_STATUS)
    return {'participant': pid, 'keys': key_list, 'edges': edges, 'proven': proven, 'not_proven': len(edges) - proven, 'all_proven': proven == len(edges)}


def _consent_verifier(tracker_nft_id, denomination):
    """verify(key, issuer, recipient, total, timestamp, signature): is `signature` the Basis signature of `key` over the
    note message of that edge state on this tracker and unit (M(I,R,t,ts), the message a set-off's members sign for each
    of its edges)? False for anything malformed."""
    def verify(key, issuer, recipient, total, timestamp, signature):
        try:
            msg = vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, timestamp, bytes.fromhex(tracker_nft_id),
                                  denomination)
            return vb.verify(bytes.fromhex(signature), msg, bytes.fromhex(key)) is True
        except (ValueError, TypeError, AttributeError, OverflowError):
            return False
    return verify


class _Mine:
    """What --mine knows of this client beyond an edge's record: its keys, a verifier of its own signatures
    (_consent_verifier), its R4 records of what it signed (state['signed']: {edge: {timestamp: {op, slots}}}), its
    records of every edge (recs) and the anchored total of each edge in the pinned denomination (anchored: {pair:
    total})."""

    def __init__(self, keys, verify, signed, recs=None, anchored=None):
        self.keys, self.verify, self.signed = keys, verify, signed
        self.recs, self.anchored = recs if isinstance(recs, dict) else {}, anchored if isinstance(anchored, dict) else {}

    def members(self, sid):
        """The edges this client signed in set-off `sid`, each with the after-state it signed there: {pair: (total,
        timestamp)}, from its pending entries (kind 'setoff', ref sid) and its R4 records (op 'setoff:<sid>', the slot
        '<pair>:new')."""
        out = {}
        for pair in self.recs:
            if pair == 'paid_deals' or not isinstance(pair, str) or '>' not in pair:
                continue
            for p in records.get(self.recs, pair)['pending']:
                if isinstance(p, dict) and p.get('kind') == 'setoff' and p.get('ref') == sid and records._nat(p.get('total')) \
                        and records._nat(p.get('timestamp')):
                    out[pair] = (p['total'], p['timestamp'])
        for pair, per in self.signed.items():
            for ts, g in (per.items() if isinstance(per, dict) else ()):
                slots = g.get('slots') if isinstance(g, dict) and isinstance(g.get('slots'), dict) else {}
                total = slots.get(f'{pair}:new')
                if g.get('op') == f'setoff:{sid}' and records._nat(total) and isinstance(ts, str) and ts.isdigit():
                    out.setdefault(pair, (total, int(ts)))
        return out

    def applied(self, sid):
        """Did set-off `sid` reach the box on every edge this client signed in it (members)? Each must be anchored at the
        total this client signed there, or confirmed in its records at that timestamp or later and anchored at that
        confirmed total (the edge moved on since). Fails closed: a set-off nets a cycle, so each of its members is on an
        edge it owes and one it is owed, and one of which this client's records know fewer than two edges (pruned, or
        never written) has not. A set-off the tracker refused, that expired or that moved only some of its edges never
        makes an edge netted, even where an edge's anchored total happens to be the one this client signed (fix inbox #86
        review: the server's own rule, every edge of a set-off moved, or none)."""
        members = self.members(sid)
        if len(members) < 2:
            return False
        for pair, (total, ts) in members.items():
            at = self.anchored.get(pair)
            if at == total:
                continue
            conf = records.get(self.recs, pair)['confirmed'] if pair in self.recs else None
            if not (conf and records._nat(conf.get('timestamp')) and conf['timestamp'] >= ts and records._nat(conf.get('total'))
                    and conf['total'] == at):
                return False
        return True

    def setoff_at(self, pair, total, timestamp):
        """The set-off this client signed this edge's state (total, timestamp) in, by its R4 record (op 'setoff:<id>',
        its new slot at that total), or None."""
        per = self.signed.get(pair) if isinstance(self.signed.get(pair), dict) else {}
        g = per.get(str(timestamp)) if isinstance(per.get(str(timestamp)), dict) else {}
        op, slots = g.get('op'), g.get('slots') if isinstance(g.get('slots'), dict) else {}
        sid = op[len('setoff:'):] if isinstance(op, str) and op.startswith('setoff:') else None
        return sid if sid and _SETOFF_ID.fullmatch(sid) and slots.get(f'{pair}:new') == total else None

    def netted(self, rec, issuer, recipient, anchored):
        """Fix inbox #86: the after-state of a set-off this client signed, pending in its records (kind 'setoff', ref the
        set-off's id), whose total is the anchored one, newer than the confirmed state, with this client's own signature
        on it (records.note_signature) verifying under the key of its side of the edge, one of its keys: on an edge it
        issues the issuer's, on one it is the creditor of the recipient's; and the set-off reached the box on every edge
        this client signed in it (applied). (entry, side) or None. The set-off can apply only with the signatures of all
        its members, so the chain committing its after-states commits states this client signed itself."""
        conf = rec['confirmed'] if rec else None
        after = conf.get('timestamp') if conf and records._nat(conf.get('timestamp')) else -1
        for p in reversed(rec['pending'] if rec else []):
            if not (isinstance(p, dict) and p.get('kind') == 'setoff' and isinstance(p.get('ref'), str) and _SETOFF_ID.fullmatch(p['ref'])
                    and records._nat(p.get('total')) and p['total'] == anchored and records._nat(p.get('timestamp'))
                    and p['timestamp'] > after and isinstance(p.get('signature'), str) and p['signature']):
                continue
            side, key = ('issuer', issuer) if p.get('direction') == 'out' else ('creditor', recipient) if p.get('direction') == 'in' else (None, None)
            if key in self.keys and self.verify(key, issuer, recipient, p['total'], p['timestamp'], p['signature']) \
                    and self.applied(p['ref']):
                return p, side
        return None


def _edge(pair, issuer, recipient, denomination, anchored, rec, verify, keys, owner, mine):
    role = ('issuer_and_recipient' if issuer in keys and recipient in keys else 'issuer' if issuer in keys
            else 'recipient' if recipient in keys else None)
    other = recipient if role == 'issuer' else issuer if role == 'recipient' else None
    conf = rec['confirmed'] if rec else None
    sig = conf.get('signature') if conf else None
    held = isinstance(sig, str) and bool(sig)
    verified, netted, netted_by = None, None, None
    matches = conf is not None and records._nat(conf.get('total')) and conf['total'] == anchored
    if anchored is not None and not matches:
        netted = mine.netted(rec, issuer, recipient, anchored)
    if anchored is None:
        status = 'not_anchored'
    elif netted is not None:
        status, verified, netted_by = 'netted', True, netted[0]['ref']
    elif conf is None:
        status = 'not_in_records'
    elif not matches:
        status = 'differs'
    elif not held:
        status = 'signature_not_held'
    else:
        try:
            verified = verify(issuer, recipient, conf['total'], conf.get('timestamp'), sig) is True
        except Exception:  # noqa: BLE001 - a verifier that fails proves nothing
            verified = False
        status = 'signed' if verified else 'bad_signature'
    if matches and anchored is not None:        # a confirmed state a set-off this client signed gave the edge
        netted_by = mine.setoff_at(pair, conf['total'], conf.get('timestamp'))
    out = {'edge': pair, 'role': role, 'counterparty_key': other, 'counterparty': owner.get(other) if other else None,
           'denomination': denomination, 'anchored_total': anchored,
           'recorded': ({'total': conf.get('total'), 'timestamp': conf.get('timestamp'), 'signature': 'held' if held else 'not_held'}
                        if conf else None),
           'signature_verified': verified, 'status': status}
    if netted_by is not None:
        out['netted_by'] = netted_by
    if netted is not None:
        out['netted_state'] = {'total': netted[0]['total'], 'timestamp': netted[0]['timestamp'], 'signed_by': 'you', 'as': netted[1]}
    pending = [p.get('total') for p in (rec['pending'] if rec else []) if isinstance(p, dict) and records._nat(p.get('total'))]
    if pending:
        out['pending_totals'] = pending
    return out
