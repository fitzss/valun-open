"""Valun pilot client: the participant side. Holds the participant's signing key locally and talks to a Valun server.

Trust model: the server is not trusted to tell this client what to sign. Before signing, the client recomputes the
terms hash itself, checks the counterparty's signature against the key in the public directory, and checks credit-note
templates against the agreed price and its own record of what it has already paid that payee. The key and tokens are
stored in a private state file and are never returned by any method.
"""
import contextlib
import copy
import hashlib
import json
import os
import random
import re
import secrets
import stat
import time
import time as _systime          # the store's lock and retries: never the `time` a test or replay harness replaces
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from . import basis as vb
from . import novation as nv
from . import records

NETWORK = 'valun-pilot-1'          # the default network: a profile enrolled before 0.5 is on it
PROTOCOL = 'valun-deal/1'
PILOT_TOKEN_ID = hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
UNIT = 'PC'
# The networks this client signs for (the server's lib/pilot/units.mjs). Amounts are whole numbers in the unit; `scale`
# sizes the defaults written in PC (a consent cap of 50 is 50 * scale), never a signed amount.
#   valun-pilot-1    PC: synthetic credits on a pilot tracker with no chain.
#   valun-testnet-1  nanoERG on Ergo TESTNET (test coins, no monetary value): ERG-denominated Basis notes.
NETWORKS = {'valun-pilot-1': {'unit': 'PC', 'scale': 1}, 'valun-testnet-1': {'unit': 'nanoERG', 'scale': 1_000_000}}


def amount_text(n, unit=UNIT):
    """An amount as people read it, in its network's unit: '3 PC' on the pilot; '3000000 nanoERG (0.003 tERG)' on the
    testnet (exact: whole nanoERG to tERG by integer arithmetic). Anything but a whole number is shown as is."""
    if unit != 'nanoERG' or not isinstance(n, int) or isinstance(n, bool):
        return f'{n} {unit}'
    whole, frac = divmod(abs(n), 10 ** 9)
    terg = f'{whole}.{frac:09d}'.rstrip('0').rstrip('.')
    return f"{n} nanoERG ({'-' if n < 0 else ''}{terg} tERG)"


def network_of(name):
    """The known network `name` ({unit, scale}); ValunError('unknown_network') for any other."""
    if not isinstance(name, str) or name not in NETWORKS:
        raise ValunError('unknown_network', f'this client does not know the Valun network {name!r} (it knows {", ".join(NETWORKS)}); '
                                            'nothing was signed. Update valun if this is a new network.')
    return NETWORKS[name]
# Optional state keys a store keeps for this client (every store must keep them; all may be absent):
#   issued    {pair: confirmed total} of this client's outgoing edges (the 0.3 record, kept equal to records' confirmed)
#   records   per-edge confirmed state and pending entries (records.py), and records['paid_deals'] {deal_id: {route,
#             edge, total, timestamp}}: deals a confirmed payment paid, never paid again (decision D-1 item 5)
#   pins      {tracker_nft_id, denomination} (R13)
#   circulation (novation.py): signed (R4) {edge: {str(ts): {op, slots, prior_state}}}; novated_edges {edge: true}
#             (R12); transfer_attempts {deal_id: [attempt]} (D-1, attempts with ack: signed as PA); approved_payments
#             {deal_id: quote_digest} (the quote a payment by transfer was signed with); consent_policy {setoff,
#             as_issuer, as_new_creditor, max_PC,
#             accept_issuers, refuse_issuers} (absent: every role off); consent_loop (for the agent layer);
#             consents_last_run_ms and consent_log (the last CONSENT_LOG_MAX decisions of process_consents());
#             journal_seq (the GET /edges journal position sync_edges() has read up to);
#             consents_last_safe_run_ms (the last process_consents(value_safe_only=True) run, decision D-3 a);
#             consent_roles_declared (the roles, 'setoff,issuer' say, that the server last took from this client's
#             X-Valun-Features header; '' once it took the empty list, decision D-3 b).
#   guarantee_honors (fix inbox #18) {guarantee_id: {cap, calls: {call_id: {amount, state ('pending', 'honored' or
#             'failed'), total, timestamp}}}}: the calls this client honored or is honoring as a backer, so it never pays
#             beyond the cap it signed, whatever a server shows.
CORE_STATE_KEYS = ('issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments', 'consent_policy',
                   'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq', 'consents_last_safe_run_ms',
                   'consent_roles_declared', 'guarantee_honors')
# Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them.
RESERVED_MS_FROM = 995

# Guarantees (servers listing guarantees/1; fix inbox #18): the terms protocol and the one kind of cover it has.
GUARANTEE_PROTOCOL = 'valun-guarantee/1'
GUARANTEE_COVERS = 'issuer_debt_to_creditor'
# The deal mode (fix inbox #29): the terms name the deals they back (terms.deals) and cover only what is unpaid of them.
GUARANTEE_COVERS_DEALS = 'issuer_payment_for_deals'
GUARANTEE_MAX_DEALS = 10
_DEAL_ID_RE = re.compile(r'vd_[0-9a-f]{16}')
GUARANTEE_HONORS_KEY = 'guarantee_honors'    # state[...][guarantee_id] = {cap, calls: {call_id: {amount, state, total, timestamp}}}
# Circulating credit (PROTOCOL.md 18; design 4.1, 6.3, 6.6, 11).
FEATURES_HEADER = 'X-Valun-Features'          # 'consents/1;roles=<roles>', sent once /info lists circulation/1
CONSENT_ROLES = (('setoff', 'setoff'), ('as_issuer', 'issuer'), ('as_new_creditor', 'creditor'))   # (policy flag, header role)
# The consent roles (novation.ROLES) a run before a read-only tool may sign (decision D-3 a): a set-off (member; it
# leaves the net position unchanged by construction) and a payment to me by transfer (payee: a new creditor, signed
# only as the standing policy allows). Never issuer or payer. VALUE_SAFE_HEADER_ROLES: the same as header roles.
VALUE_SAFE_ROLES = ('member', 'payee')
VALUE_SAFE_HEADER_ROLES = ('setoff', 'creditor')
# The routes the server answers before it authenticates the caller (GET /info, the public directory and ledger, GET
# /clearing, join and enroll): a request to one of them never records the roles its X-Valun-Features header declares.
_PUBLIC_ROUTES = ('/pilot/v1/info', '/pilot/v1/participants', '/pilot/v1/ledger', '/pilot/v1/clearing', '/pilot/v1/join',
                  '/pilot/v1/join-sandbox', '/pilot/v1/enroll')
CONSENT_LOG_MAX = 100                         # process_consents() keeps the last 100 decisions in consent_log
RECORDS_KEEP_MS = 7 * 24 * 3600 * 1000        # what did not apply is dropped after 7 days (design 11)
SIGNATURES_KEEP_MS = 30 * 24 * 3600 * 1000    # a confirmed (applied) state keeps its signature 30 days (design 11)
ATTEMPT_OUTCOMES = ('not_applied', 'applied')  # what the owner can decide about a payment attempt (decision D-2 d)
# The owner's resolution of a payment attempt (decision D-2 d; resolution_plan, resolve_attempt). The server resolves
# only a transfer it holds as UNRESOLVED_TRANSFER (POST /owner/deals/{vd}/attempts/{vt}/resolve, an owner note of at
# most RESOLVE_NOTE_MAX characters); a credit note's attempt, or a transfer on a server without circulation/1, is
# resolved in this client's records only; LOCAL_CHOICES are the cases where a transfer is resolved in this client's
# records only by the owner's explicit choice (resolve_attempt(local_only=True); the CLI asks a second time).
UNRESOLVED_TRANSFER = ('outcome_unknown', 'inconsistent')
LIVE_TRANSFER = ('awaiting_owner', 'collecting', 'applying')
LOCAL_CHOICES = ('no_server_id', 'server_unknown', 'server_ended')
# The transfer states the server sets only before it ever submits a transfer to the tracker (valun-app PILOT-API.md
# "Payment by debt transfer" steps 6-10 and the pay_by_transfer approval; PROTOCOL.md 18.6): while it waits for the
# payer's owner, before anyone else has signed (void_rejected: the owner rejected it; void_stale: it was stale when the
# owner approved it), while it collects signatures (cancelled by the payer; refused by the issuer or the payee), in
# either (expired, and void_expired, its approval's word: the collection window passed; void_key_revoked: a party's
# key was revoked, or found revoked in the re-check that precedes its first submission). The server saves `applying`
# before every tracker call and purges the signatures of a transfer that ends so, so on the server's word such a
# transfer never applied. Not among them: failed (it can follow a tracker call: a refusal, or a read-back that found an
# edge changed or moved past T at its prior total, which D-2 a does not take as proof), resolved_not_applied (an
# owner's decision), outcome_unknown, inconsistent, applied and the LIVE_TRANSFER states. Only what this client shows
# and advises uses it (attempts_overview, resolution_plan, `valun attempts`); the payer evaluators (R11) never see it,
# so the server's word never lets this client sign a payment sooner.
NEVER_APPLIED_TRANSFER = ('void_rejected', 'void_stale', 'void_expired', 'expired', 'cancelled', 'refused',
                          'void_key_revoked')
RESOLVE_NOTE_MAX = 300
# The server records an attempt as applied only while the payee's edge on the tracker shows the transfer (valun-app
# SV-AUTH-1): otherwise it answers 409 payee_edge_not_applied {payee_edge}, the class of the payee's edge as it read it
# (lib/pilot/novation.mjs classifyEdge), and nothing changes. resolve_attempt explains it in these words and offers no
# resolution in this client's records only: the owner resolves it as not applied, or asks the operator to look into it.
PAYEE_EDGE_WHY = {
    'prior': "the payee's edge is still at the state the transfer started from",
    'changed': "the payee's edge changed before the transfer's timestamp, so the transfer cannot have applied there",
    'moved_past': "the payee's edge moved past the transfer's timestamp at its earlier total",
    'unknown': "the payee's edge is at a state that does not show the transfer",
}
PAYEE_EDGE_NEXT = ('not_applied', 'ask_operator')
EDGES_PAGE = 200                              # GET /edges answers at most this many journal entries at a time
EDGES_MAX_PAGES = 50                          # sync_edges() reads at most this many pages per call
_JOURNAL_NOVATIONS = ('transfer_out', 'transfer_in', 'setoff')     # journal kinds that make an edge bound-only
# Residues of what stops being usable after novation.MAX_AGE_MS: bound notes, set-offs, transfers (novation.BOUND_MS,
# SETOFF_MS, TRANSFER_MS; written out because novation.py imports this module, so nv is not complete at import time).
_EXPIRING_MS = (997, 998, 999)
_DEAL_ID_RE = re.compile(r'vd_[0-9a-f]{16}\Z')
_TRANSFER_ID_RE = re.compile(r'vt_[0-9a-f]{16}\Z')
_ATTEMPT_REF_RE = re.compile(r'#[1-9][0-9]{0,3}\Z')
_SERVER_WORD_RE = re.compile(r'[a-z_]{1,40}\Z')
# Default_Ignorable_Code_Point characters outside the categories C* (they hide text): refused in the owner's note.
_IGNORABLE = ((0x034F, 0x034F), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F), (0x3164, 0x3164),
              (0xFE00, 0xFE0F), (0xFFA0, 0xFFA0), (0xE0100, 0xE01EF))


class ValunError(Exception):
    def __init__(self, code, message, status=None, extra=None):
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra or {}


def sha256_hex(s) -> str:
    return hashlib.sha256(s.encode('utf-8') if isinstance(s, str) else s).hexdigest()


def canonical(v) -> str:
    """Same canonical JSON as the server (sorted keys, no whitespace, non-ASCII kept as is)."""
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(v[k]) for k in sorted(v)) + '}'
    if isinstance(v, list):
        return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
        return json.dumps(v, ensure_ascii=False)
    raise ValunError('bad_terms', f'unsupported value in terms: {type(v).__name__}')


def terms_hash(terms) -> str:
    return sha256_hex(canonical(terms))


def _check_deal_ids(deals, code):
    """The deals a guarantee names (fix inbox #29): 1 to GUARANTEE_MAX_DEALS different deal ids."""
    if (not isinstance(deals, list) or not 1 <= len(deals) <= GUARANTEE_MAX_DEALS or len(set(deals)) != len(deals)
            or not all(isinstance(d, str) and _DEAL_ID_RE.fullmatch(d) for d in deals)):
        raise ValunError(code, f'deals must be 1 to {GUARANTEE_MAX_DEALS} different deal ids (vd_ + 16 hex)')


def statement(kind, *parts) -> str:
    return '\n'.join([f'valun-pilot/{kind}/1', *parts])


def _iso(dt) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


# How long a counter-offer stays open by default, at most (fix inbox #23): never past its own delivery deadline, nor past
# the end of the offer it answers (Client.counter).
COUNTER_OFFER_HOURS = 24


def _price_amount(price, unit=UNIT):
    """A price as it is signed: a whole number of at least 1, or a string of its decimal digits (as the JavaScript client
    takes it). Never truncated or rounded (fix inbox #22: 1.5 was signed as 1): anything else is refused (bad_price)."""
    n = int(price) if isinstance(price, str) and len(price) < 100 and re.fullmatch(r'[0-9]+', price) else price
    if isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= nv.MAX_SAFE_INTEGER:
        return n
    raise ValunError('bad_price', f'price must be a whole number of {unit}, at least 1')


def check_offer_hours(offer_hours, deliver_hours):
    """Refuse (bad_arguments, fix inbox #23), before anything is signed, an offer that would stay open longer than the
    hours it gives to deliver: it could be accepted after its work is due, and the server refuses such terms
    (deliver_by must not be earlier than offer_expires_at)."""
    if offer_hours > deliver_hours:
        raise ValunError('bad_arguments', (f'the offer would stay open {offer_hours} h, longer than the {deliver_hours} h it '
                                           'gives to deliver: it could be accepted after its work is due, which the server '
                                           f'refuses. Pass offer_valid_hours of at most {deliver_hours}; nothing was signed'))


def _records_in(state, create=True):
    """state['records'] (created when absent, unless create is False: then {}); a value that is not a record refuses
    everything (R9: records_unreadable)."""
    r = state.get('records')
    if r is None:
        if not create:
            return {}
        r = state['records'] = {}
    if not isinstance(r, dict):
        raise ValunError('records_unreadable', "this profile's records cannot be read; nothing was signed")
    return r


def _issued_in(state, create=True):
    r = state.get('issued')
    if r is None:
        if not create:
            return {}
        r = state['issued'] = {}
    if not isinstance(r, dict):
        raise ValunError('records_unreadable', "this profile's record of issued credit notes cannot be read; nothing was signed")
    return r


def _pins_of(state):
    p = state.get('pins')
    return p if isinstance(p, dict) and p.get('tracker_nft_id') else None


def _pin_problem(pins, tracker_nft_id, denomination):
    if pins and (pins.get('tracker_nft_id') != tracker_nft_id or pins.get('denomination') != denomination):
        return ValunError('tracker_mismatch', (
            f'this Valun server names tracker {str(tracker_nft_id)[:16]}... and unit {str(denomination)[:22]}..., but this '
            f"profile is pinned to tracker {str(pins.get('tracker_nft_id'))[:16]}... and unit {str(pins.get('denomination'))[:22]}...; "
            'nothing was signed. Ask your owner.'), extra={'pinned': dict(pins)})
    return None


def verify_note(issuer_pubkey, recipient_pubkey, total, timestamp, signature, tracker_nft_id, denomination):
    """Is `signature` the issuer's Basis signature over the note (issuer, recipient, total, timestamp) on this tracker
    and unit? Hex strings in; False for anything malformed."""
    try:
        msg = vb.note_message(bytes.fromhex(issuer_pubkey), bytes.fromhex(recipient_pubkey), total, timestamp,
                              bytes.fromhex(tracker_nft_id), denomination)
        return vb.verify(bytes.fromhex(signature), msg, bytes.fromhex(issuer_pubkey))
    except (ValueError, TypeError, AttributeError, OverflowError):
        return False


def consent_roles(policy):
    """The consent roles a local consent policy signs by itself, as the capability header names them: a subset of
    ('setoff', 'issuer', 'creditor'), in that order. An absent or malformed policy signs none (design 6.6)."""
    if not isinstance(policy, dict):
        return []
    return [role for flag, role in CONSENT_ROLES if policy.get(flag) is True]


def _authenticated_route(path):
    """Does the server authenticate the caller of this request path (every /pilot/v1 route but _PUBLIC_ROUTES and
    GET /participants/{id})? Only there does an agent's X-Valun-Features header reach the server's record of its
    roles."""
    route = path.split('?', 1)[0]
    return route.startswith('/pilot/v1/') and not any(route == r or route.startswith(r + '/') for r in _PUBLIC_ROUTES)


def _one_role(item):
    """The one role a GET /consents item gives this client (novation.ROLES), or None (no list, several, or unknown)."""
    roles = item.get('your_roles') if isinstance(item, dict) else None
    return roles[0] if isinstance(roles, list) and len(roles) == 1 and roles[0] in nv.ROLES else None


def _features_of(info):
    """The feature tags a GET /info answer lists: none when it has no `features` (v15, or circulation off); ['?'] when
    the list is malformed (features then count as advertised, and none is recognised)."""
    if not isinstance(info, dict):
        raise ValunError('bad_response', 'GET /info did not answer a JSON object')
    raw = info.get('features')
    if raw is None:
        return []
    if isinstance(raw, list) and all(isinstance(f, str) for f in raw):
        return list(raw)
    return ['?']


def _mandate_of(me):
    """The owner's mandate as GET /me shows it, with the agent's own recorded limits applied (effective_limits): the
    mandate side of R8. None when /me shows neither (every consent role is then off)."""
    if isinstance(me, dict):
        for k in ('effective_limits', 'mandate'):
            if isinstance(me.get(k), dict):
                return me[k]
    return None


def _verify_hex(pubkey_hex, msg, sig_hex):
    """novation.py's verifier: a Basis signature (hex) over msg (bytes) by pubkey_hex."""
    return vb.verify(bytes.fromhex(sig_hex), msg, bytes.fromhex(pubkey_hex))


def _text_signed(pubkey_hex, text, sig_hex):
    """Whether sig_hex is a Basis signature by pubkey_hex over the UTF-8 bytes of `text` (a Valun statement); False for
    anything malformed."""
    if not (_is_pubkey(pubkey_hex) and isinstance(sig_hex, str) and re.fullmatch(r'0[23][0-9a-f]{128}', sig_hex)):
        return False
    try:
        return vb.verify(bytes.fromhex(sig_hex), text.encode('utf-8'), bytes.fromhex(pubkey_hex)) is True
    except Exception:  # noqa: BLE001 - a verifier that fails accepts nothing
        return False


def _nat(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _is_pubkey(v):
    """A compressed public key as the directory lists it: 66 lowercase hex, starting 02 or 03."""
    return isinstance(v, str) and len(v) == 66 and v[:2] in ('02', '03') and all(c in '0123456789abcdef' for c in v)


def _seg(v):
    """A server-chosen id as one URL path segment (or query value)."""
    return urllib.parse.quote(str(v), safe='')


def _transient(e):
    """A failure to reach or be served by the server, not an answer about the request itself: try again later."""
    return e.code == 'unreachable' or (e.status is not None and (e.status >= 500 or e.status == 429))


def _guarded(fn, *args):
    """A novation.py records helper; its ValueError (a record that is not of its shape) is records_unreadable (R9), and
    its WriteAheadConflict (the records changed since the evaluation) keeps its own refusal code."""
    try:
        return fn(*args)
    except ValueError as e:
        code = getattr(e, 'code', None)
        if isinstance(code, str) and code in nv.REFUSAL_CODES:
            raise ValunError(code, f'{e}') from None
        raise ValunError('records_unreadable', "this profile's records cannot be read; nothing was signed") from None


def _dict_in(state, key):
    v = state.get(key)
    if v is None:
        v = state[key] = {}
    if not isinstance(v, dict):
        raise ValunError('records_unreadable', f"this profile's {key} record cannot be read; nothing was signed")
    return v


def _refused(r, code=None, reason=None):
    """An evaluation turned into a refusal (another code and reason than the evaluator's, when given)."""
    s = dict(r['summary'], reason=reason) if reason is not None else r['summary']
    return {'ok': False, 'code': code or r['code'], 'to_sign': [], 'summary': s, 'write_ahead': None}


def _refusal_error(r):
    """The ValunError for an evaluation that refuses: its code and reason, and what the caller needs to act on it
    (retry_after_ms and needs_read_back for transfer_window_open; the whole summary)."""
    s = r.get('summary') or {}
    extra = {'summary': s}
    if s.get('retry_after_ms') is not None:
        extra['retry_after_ms'] = s['retry_after_ms']
    if s.get('needs_read_back'):
        extra['needs_read_back'] = list(s['needs_read_back'])
    return ValunError(r['code'], s.get('reason') or f"refused ({r['code']}); nothing was signed", extra=extra)


def _paid_route(p):
    """The payment a pending entry of mine is, when it applied: 'note' (a credit note I issued for a deal) or
    'transfer' (the decrease of my held claim that paid a deal, ref 'vd_...'); None for anything else."""
    if not isinstance(p, dict) or not isinstance(p.get('ref'), str) or not p['ref']:
        return None
    if p.get('kind') == 'note' and p.get('direction') == 'out':
        return 'note'
    if p.get('kind') == 'transfer' and p.get('direction') == 'in' and p['ref'].startswith('vd_'):
        return 'transfer'
    return None


def _attempt_shape(a):
    """A payment attempt record as novation.py writes it (transfer_attempts[deal_id][i])."""
    return (isinstance(a, dict) and a.get('route') in ('note', 'transfer') and isinstance(a.get('edge'), str)
            and _nat(a.get('prior')) and _nat(a.get('total')) and _nat(a.get('timestamp')))


def attempt_key(a):
    """[route, edge, total, timestamp]: what names one payment attempt (an attempt record, a pending payment entry seen
    as an attempt, a payment_attempts() row, resolution_plan()['attempt']), whatever its place (#n) in its deal's list;
    the same key as novation's write_ahead.attempts_seen and records['paid_deals']. None for None. For
    resolve_attempt(expected_attempt=...)."""
    if a is None:
        return None
    return [a.get('route'), a.get('edge'), a.get('total'), a.get('timestamp')]


def _shows_attempt(info, r):
    """Is the transfer GET /transfers showed (info: Client._shown_transfer) the payment attempt row `r`: a transfer at
    the same timestamp on the same held edge of mine, at the same new total (when the view shows one)?"""
    return (r['route'] == 'transfer' and info['timestamp'] is not None and r['timestamp'] == info['timestamp']
            and r['edge'] == info['edge'] and (info['total'] is None or r['total'] == info['total']))


_UNCHECKED = object()                          # resolve_attempt(expected_attempt=...) not given: no check


def _server_word(v):
    """A code or state the server chose (an HTTP error code, a consent or transfer state), copied into what this client
    reports or records only in the form ^[a-z_]{1,40}$; else None."""
    return v if isinstance(v, str) and _SERVER_WORD_RE.match(v) is not None else None


def _payee_edge_refusal(e):
    """The server's 409 payee_edge_not_applied to a resolution as applied (PAYEE_EDGE_WHY), as the ValunError
    resolve_attempt raises: why, in words the owner can act on, and what to do instead (extra: payee_edge, the class
    the server named or None; next_steps PAYEE_EDGE_NEXT; local_possible False; server {error, message})."""
    edge = _server_word(e.extra.get('payee_edge'))
    why = PAYEE_EDGE_WHY.get(edge, "the server did not say how it reads the payee's edge")
    return ValunError('payee_edge_not_applied',
                      "the server did not record this payment as applied: the payee's edge on the tracker does not show "
                      f'this transfer ({why}); nothing was changed, at the server or in your records. If the payee '
                      'confirms that the payment did not arrive, resolve it as not applied; if the payee says it '
                      'arrived, ask the operator to look into it with the payee before you resolve it', 409,
                      extra={'payee_edge': edge, 'next_steps': list(PAYEE_EDGE_NEXT), 'local_possible': False,
                             'server': {'error': 'payee_edge_not_applied', 'message': str(e)[:300]}})


def _said(code):
    """' (code)' for a reason text, or '' without a code."""
    return f' ({code})' if code else ''


def _unsafe_text(s):
    """Does `s` hold a character that hides text or displays differently: a control other than tab, LF and CR, a
    format (bidi, zero-width), surrogate, private-use or unassigned character, or another Default_Ignorable_Code_Point
    (variation selectors, Hangul fillers)? Stricter than the server's rule (hasUnsafeText), never looser."""
    for ch in s:
        if ch in '\t\n\r':
            continue
        cp = ord(ch)
        if unicodedata.category(ch) in ('Cc', 'Cf', 'Cs', 'Co', 'Cn') or any(lo <= cp <= hi for lo, hi in _IGNORABLE):
            return True
    return False


def _owner_note(note):
    """The owner's note for the server's audit line of a resolution, as the server takes it (decision D-2 d): None when
    absent or blank; else the note trimmed, at most RESOLVE_NOTE_MAX characters (UTF-16 code units, as the server
    counts them), without control, bidi or invisible characters. Anything else is refused here (bad_arguments), before
    anything is sent."""
    if note is None:
        return None
    if not isinstance(note, str):
        raise ValunError('bad_arguments', 'the note is text; nothing was changed')
    t = note.strip()
    if not t:
        return None
    if _unsafe_text(t):
        raise ValunError('bad_arguments', 'the note contains control, bidi or invisible characters; remove them '
                                          '(nothing was changed)')
    if len(t.encode('utf-16-le')) // 2 > RESOLVE_NOTE_MAX:
        raise ValunError('bad_arguments', f'the note is longer than {RESOLVE_NOTE_MAX} characters; shorten it '
                                          '(nothing was changed)')
    return t


def _attempt_edges(state):
    """The edges of this client's payment attempts: those of its attempt records, and those of its pending payment
    entries."""
    edges = set()
    att = state.get('transfer_attempts')
    for lst in (att.values() if isinstance(att, dict) else ()):
        for a in (lst if isinstance(lst, list) else ()):
            if isinstance(a, dict) and isinstance(a.get('edge'), str):
                edges.add(a['edge'])
    recs = state.get('records')
    for pair, e in (recs.items() if isinstance(recs, dict) else ()):
        if pair != nv.PAID_DEALS_KEY and isinstance(e, dict) and isinstance(e.get('pending'), list) \
                and any(_paid_route(p) is not None for p in e['pending']):
            edges.add(pair)
    return edges


def _attempt_deals(state):
    """The deals this client records payment attempts of: its attempt records (transfer_attempts) and the deals of its
    pending payment entries (records)."""
    deals = set()
    att = state.get('transfer_attempts')
    for deal_id, lst in (att.items() if isinstance(att, dict) else ()):
        if isinstance(deal_id, str) and lst:
            deals.add(deal_id)
    recs = state.get('records')
    for pair, e in (recs.items() if isinstance(recs, dict) else ()):
        if pair == nv.PAID_DEALS_KEY or not isinstance(e, dict) or not isinstance(e.get('pending'), list):
            continue
        for p in e['pending']:
            if _paid_route(p) is not None:
                deals.add(p['ref'])
    return deals


def _mark_novated(state, edge):
    """R12: remember that a novation changed `edge` (it now takes bound notes only). True when it is new."""
    nov = state.get('novated_edges')
    if nov is None:
        nov = state['novated_edges'] = {}
    if isinstance(nov, dict):
        if edge in nov:
            return False
        nov[edge] = True
        return True
    if isinstance(nov, list) and all(isinstance(x, str) for x in nov):
        if edge in nov:
            return False
        nov.append(edge)
        return True
    raise ValunError('records_unreadable', "this profile's record of novated edges cannot be read; nothing was signed")


class FileStore:
    """Standalone storage: one private JSON file holds settings, the agent's credentials and its own record of credit
    notes issued. Used by the CLI and tests. (Inside Hermes the plugin uses Hermes's secret store instead.)

    Several processes may use one profile (an MCP server and `valun call`, say). update(fn) changes it as one step
    they cannot interleave: it holds the lock file '<path>.lock' (created with O_CREAT|O_EXCL; waits up to LOCK_WAIT_S;
    a lock older than LOCK_STALE_S was left by a process that died and is replaced), reloads the file, applies fn and
    saves atomically. The lock file holds '<pid> <time> <random>': its holder removes it only while it still holds
    exactly that. A stale lock is replaced only by a waiter holding '<path>.lock.break' (also O_CREAT|O_EXCL), after
    judging the lock's age again under it (_replace_stale). The JavaScript client uses the same protocol on the same
    files."""
    LOCK_WAIT_S = 5.0
    LOCK_STALE_S = 30.0

    def __init__(self, path):
        self.path = path
        self.state = {}
        if os.path.exists(path):
            self.state = self._load()

    def secret(self):
        return self.state.get('secret')

    def token(self):
        return self.state.get('agent_token')

    def save_credentials(self, secret_hex, token):
        self.state['secret'], self.state['agent_token'] = secret_hex, token
        self.save()

    def save(self):
        self._write(self.state)

    def update(self, fn):
        """Under the profile lock: reload the file (another process may have changed it), apply fn(state) and save.
        self.state is updated in place to the saved state; if fn raises, nothing is saved or changed. Returns fn's
        result. Changes made to self.state without saving are replaced by the file's contents."""
        with self._locked():
            work = self._read() if os.path.exists(self.path) else copy.deepcopy(self.state)
            result = fn(work)
            self._write(work)
            self.state.clear()
            self.state.update(work)
        return result

    def reload(self):
        """Replace self.state (in place) with the file's current contents, if the file exists."""
        if os.path.exists(self.path):
            fresh = self._read()
            self.state.clear()
            self.state.update(fresh)

    # ---------- file access ----------
    def _load(self):
        for attempt in range(50):
            try:
                with open(self.path, encoding='utf-8') as f:
                    return json.load(f)
            except PermissionError:            # Windows: the file is being replaced by another process right now
                if attempt == 49:
                    raise
                _systime.sleep(0.02)

    def _read(self):
        try:
            data = self._load()
        except (OSError, ValueError):
            raise ValunError('records_unreadable', f'cannot read the profile {self.path}; nothing was changed or signed') from None
        if not isinstance(data, dict):
            raise ValunError('records_unreadable', f'the profile {self.path} is not a JSON object; nothing was changed or signed')
        return data

    def _write(self, state):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = f'{self.path}.{os.getpid()}.{os.urandom(4).hex()}.tmp'    # one per write: concurrent writers never share it
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(state, f, indent=1)
                f.flush()
                os.fsync(f.fileno())
            for attempt in range(100):
                try:
                    os.replace(tmp, self.path)
                    break
                except PermissionError:        # Windows: another process has the profile open for reading right now
                    if attempt == 99:
                        raise
                    _systime.sleep(0.01)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
        try:
            os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass

    @contextlib.contextmanager
    def _locked(self):
        lock = self.path + '.lock'
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        deadline = _systime.monotonic() + self.LOCK_WAIT_S
        while True:
            try:        # O_BINARY (Windows): the mark is read back byte for byte when the lock is released
                fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
                break
            except FileExistsError:
                if self._replace_stale(lock) and _systime.monotonic() < deadline:
                    continue
            except PermissionError:            # Windows: the holder is deleting the lock file right now
                if os.name != 'nt':
                    raise                      # elsewhere it means the folder is not writable: say so at once
            if _systime.monotonic() >= deadline:
                raise ValunError('profile_busy', f'another Valun process is using the profile {self.path} (lock file {lock}); '
                                 'try again') from None
            _systime.sleep(0.005 + random.random() * 0.02)
        mark = f'{os.getpid()} {_systime.time():.3f} {os.urandom(8).hex()}\n'.encode('ascii')    # this holder's own lock
        try:
            try:
                written = os.write(fd, mark) == len(mark)
            finally:
                os.close(fd)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(lock)
            raise
        try:
            yield
        finally:
            self._release(lock, mark if written else None)

    @staticmethod
    def _release(lock, mark):
        """Remove the lock, unless it is no longer this holder's: one that held it longer than LOCK_STALE_S may have been
        replaced as stale, and the lock file then belongs to another process."""
        if mark is not None:
            try:
                with open(lock, 'rb') as f:
                    if f.read() != mark:
                        return
            except OSError:
                return
        with contextlib.suppress(OSError):
            os.unlink(lock)

    def _age(self, path):
        """Seconds since `path` was last modified; None when it does not exist (or is being deleted right now)."""
        try:
            return _systime.time() - os.path.getmtime(path)
        except OSError:
            return None

    def _replace_stale(self, lock):
        """True when the lock is gone, or was left by a process that died (older than LOCK_STALE_S) and is now removed.
        Waiters that find it stale take turns through a second O_CREAT|O_EXCL file, '<lock>.break', and judge the lock's
        age again while holding it. Only a holder of '<lock>.break' removes a stale lock, so a stale lock is removed once,
        and a lock that another waiter created after removing it is never removed by mistake. '<lock>.break' is held for
        a moment only: one older than LOCK_STALE_S was left by a waiter that died, and is removed."""
        age = self._age(lock)
        if age is None:
            return True                        # released meanwhile: try again at once
        if age <= self.LOCK_STALE_S:
            return False
        brk = lock + '.break'
        try:
            fd = os.open(brk, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError:                        # another waiter is replacing it right now
            held = self._age(brk)
            if held is not None and held > self.LOCK_STALE_S:
                with contextlib.suppress(OSError):
                    os.unlink(brk)
            return False
        try:
            os.close(fd)
            age = self._age(lock)              # again: the lock may have been replaced since it was judged stale
            if age is not None and age > self.LOCK_STALE_S:
                os.unlink(lock)
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                os.unlink(brk)
        return True


class Client:
    """`store` is a FileStore path (str) or any object with .state (non-secret dict), .secret(), .token(),
    .save() and .save_credentials(secret_hex, token).

    declare_roles: False for a client whose adapter signs no consent by itself (its process_consents is off, as the
    Hermes plugin's is by default): it declares no consent role in X-Valun-Features, whatever its consent policy says,
    and withdraws the roles it declared before (features_header; decision D-3 b). It changes only that header."""

    def __init__(self, store, server=None, timeout=30, declare_roles=True):
        self.store = FileStore(store) if isinstance(store, (str, os.PathLike)) else store
        self.state = self.store.state
        self.timeout = timeout
        self._server = server.rstrip('/') if server else None    # kept apart: a reloaded profile never redirects requests
        if self._server:
            self.state['server'] = self._server
        self._advertised = []                   # the features the last GET /info listed (for the capability header)
        self._novation = None                   # the last GET /info novation: the tracker contract (novation.CONTRACT)
        self.declare_roles = bool(declare_roles)

    def _save(self):
        self.store.save()

    def _update(self, fn):
        """Change this client's records: fn(state) on the store's state, then save. With a store that has update()
        (FileStore), under the profile lock and on the state reloaded from disk, so concurrent processes never lose
        each other's records; other stores apply fn to their state and save(). If fn raises, nothing changes."""
        upd = getattr(self.store, 'update', None)
        if callable(upd):
            result = upd(fn)
        else:
            work = copy.deepcopy(self.state)
            result = fn(work)
            self.state.clear()
            self.state.update(work)
            self.store.save()
        if self._server:
            self.state['server'] = self._server
        return result

    def _reload(self):
        """Read the records again where the store can (another process may have recorded notes since this one loaded)."""
        fn = getattr(self.store, 'reload', None)
        if callable(fn):
            fn()
            if self._server:
                self.state['server'] = self._server

    @property
    def connected(self):
        return bool(self.store.token() and self.store.secret())

    @property
    def pubkey(self):
        if not self.state.get('pubkey') and self.store.secret():
            self.state['pubkey'] = vb.public_key(bytes.fromhex(self.store.secret())).hex()
        return self.state.get('pubkey')

    @property
    def participant_id(self):
        return self.state.get('participant_id')

    def _secret(self):
        s = self.store.secret()
        if not s:
            raise ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it')
        return bytes.fromhex(s)

    def _sign(self, text) -> str:
        return vb.sign(text.encode('utf-8'), self._secret(), bytes.fromhex(self.pubkey)).hex()

    # ---------- HTTP ----------
    def request(self, method, path, body=None, auth=True, token=None):
        server = self._server or self.state.get('server')
        if not server:
            raise ValunError('not_configured', 'no Valun server configured')
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(server + path, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        req.add_header('Accept', 'application/json')
        tok = token or (self.store.token() if auth else None)
        if tok:
            req.add_header('Authorization', 'Bearer ' + tok)
        caps = self.features_header()
        if caps:
            req.add_header(FEATURES_HEADER, caps)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                out = json.loads(r.read().decode('utf-8') or 'null')
            if caps and token is None and auth and tok and _authenticated_route(path):
                self._roles_declared(caps)      # the server authenticated this agent, so it took the roles
            return out
        except urllib.error.HTTPError as e:
            try:
                j = json.loads(e.read().decode('utf-8'))
            except Exception:
                j = {}
            raise ValunError(j.get('error', 'http_error'), j.get('message') or j.get('error') or f'HTTP {e.code}', e.code,
                             {k: v for k, v in j.items() if k not in ('error', 'message')}) from None
        except urllib.error.URLError as e:
            raise ValunError('unreachable', f'cannot reach {server}: {e.reason}') from None

    # ---------- joining ----------
    def join(self, invite, handle, operator, display_name='', about='', services='', wants=''):
        """Create a participant. Returns the owner token and enrollment code: both are for the HUMAN operator. `wants`
        (what it pays others for, public) is sent only when given."""
        body = {'invite': invite, 'handle': handle, 'display_name': display_name, 'operator': operator, 'about': about,
                'services': services}
        if wants:
            body['wants'] = wants
        return self._joined(self.request('POST', '/pilot/v1/join', body, auth=False))

    def join_sandbox(self, handle, operator, display_name='', about='', services='', wants=''):
        """Create a self-serve participant without an invite (where the server offers it), within small limits. Where the
        server runs the open network (GET /info self_serve.open_network) it can deal with any participant whose owner
        allows it, for a week renewed while its agent is active; otherwise only with the server's sandbox agents, for a
        week. `services` (what it offers, public) and `wants` (what it pays others for, public) are sent only when given.
        Returns the owner token and enrollment code: both are for the HUMAN operator."""
        body = {'handle': handle, 'operator': operator, 'display_name': display_name, 'about': about}
        if services:
            body['services'] = services
        if wants:
            body['wants'] = wants
        return self._joined(self.request('POST', '/pilot/v1/join-sandbox', body, auth=False))

    def _joined(self, r):
        """A join's answer: servers since 0.5 name their network, which this profile then enrolls on (a known one only)."""
        if isinstance(r, dict) and r.get('network') is not None:
            network_of(r['network'])
            self.state['network'] = r['network']
        return r

    def set_profile(self, display_name=None, about=None, services=None, wants=None):
        """Change this participant's public profile (PUT /pilot/v1/profile, the agent's token): only the fields given.
        `wants` is what it pays others for (an empty string clears it; servers before 2026-11-12 refuse it)."""
        body = {k: v for k, v in (('display_name', display_name), ('about', about), ('services', services), ('wants', wants))
                if v is not None}
        if not body:
            raise ValunError('invalid_field', 'give at least one of display_name, about, services, wants')
        return self.request('PUT', '/pilot/v1/profile', body)

    def enroll(self, participant_id, code):
        """Generate this agent's key locally and register its public key with a proof-of-possession signature."""
        if self.connected:
            raise ValunError('already_connected', 'this client already holds an enrolled key')
        net = self.state.get('network') or NETWORK          # the network the join named (join, join_sandbox)
        network_of(net)
        secret = vb.generate_secret()
        pk = vb.public_key(secret).hex()
        sig = vb.sign(statement('enroll', net, participant_id, pk, sha256_hex(code)).encode('utf-8'), secret, bytes.fromhex(pk)).hex()
        r = self.request('POST', '/pilot/v1/enroll', {'participant_id': participant_id, 'code': code, 'pubkey': pk, 'signature': sig}, auth=False)
        if r.get('network') != net:
            raise ValunError('wrong_network', f"the server enrolled this key on {r.get('network')!r}, not {net!r}")
        self.state.update({'participant_id': participant_id, 'pubkey': pk, 'network': r['network'],
                           'enrolled_at': _iso(datetime.now(timezone.utc)), 'issued': self.state.get('issued', {})})
        self.store.save_credentials(secret.hex(), r['agent_token'])
        self._save()
        return {'participant_id': participant_id, 'pubkey': pk, 'network': r['network']}

    # ---------- reads ----------
    def info(self):
        """The network's public description. Its tracker and unit are pinned in an enrolled profile the first time they
        are read (at enroll, or on the first call after an upgrade); a later answer naming others is refused. The
        features it lists decide whether later requests carry the capability header (features_header); its `novation`
        object, the server's report of its tracker's contract, decides whether prior acknowledgments are signed
        (novation.contract_problem: tracker v3.2 only)."""
        r = self.request('GET', '/pilot/v1/info', auth=False)
        self._pin(r)
        self._advertised = _features_of(r) if isinstance(r, dict) else []
        self._novation = r.get('novation') if isinstance(r, dict) else None
        return r

    def features_header(self):
        """The X-Valun-Features value this client sends with its requests (PROTOCOL.md 18.1; design 4.1):
        'consents/1;roles=<roles>', the consent roles its local consent_policy signs by itself (consent_roles; none
        with declare_roles False), once the server's GET /info has listed circulation/1. None when it has not.

        With no role on (every role off, or declare_roles False), the empty list 'consents/1;roles=' is sent while the
        server may still count roles this client declared before (consent_roles_declared names some), so that the
        server forgets them at once instead of counting them for 7 more days (decision D-3 b); once the server has taken
        it, no header is sent (None). The server takes a header from an agent request it authenticated and answered
        with 2xx (request() then records it in consent_roles_declared)."""
        if 'circulation/1' not in getattr(self, '_advertised', ()):
            return None
        roles = consent_roles(self.state.get('consent_policy')) if getattr(self, 'declare_roles', True) else []
        if roles:
            return f"consents/1;roles={','.join(roles)}"
        declared = self.state.get('consent_roles_declared')
        return 'consents/1;roles=' if isinstance(declared, str) and declared else None

    def _roles_declared(self, caps):
        """Record (consent_roles_declared) the roles a header the server took declared: '' for the empty list, after
        which no header is sent until a role is on again. Written only when it changes; a write that fails is not
        retried (the header is then sent again on a later request, which changes nothing at the server)."""
        roles = caps.split('roles=', 1)[1] if 'roles=' in caps else ''
        if self.state.get('consent_roles_declared') == roles:
            return

        def note(state):
            state['consent_roles_declared'] = roles
        try:
            self._update(note)
        except (ValunError, OSError):
            pass

    # ---------- the network (0.5) ----------
    @property
    def network(self):
        """This profile's network: the one it enrolled on (state['network']), valun-pilot-1 for a profile without one."""
        n = self.state.get('network') or NETWORK
        network_of(n)
        return n

    @property
    def unit(self):
        return NETWORKS[self.network]['unit']

    @property
    def scale(self):
        return NETWORKS[self.network]['scale']

    # ---------- pins (R13) ----------
    def _pinned(self):
        return _pins_of(self.state) is not None

    def _check_pins(self, tracker_nft_id, denomination):
        err = _pin_problem(_pins_of(self.state), tracker_nft_id, denomination)
        if err:
            raise err

    def _pin(self, info):
        if not isinstance(info, dict):
            return
        nft, denom = info.get('tracker_nft_id'), info.get('denomination')
        if not (isinstance(nft, str) and nft and isinstance(denom, str) and denom):
            return
        if self._pinned():
            self._check_pins(nft, denom)
            return
        if not self.state.get('participant_id'):
            return                              # only an enrolled profile is pinned

        def pin(state):
            err = _pin_problem(_pins_of(state), nft, denom)
            if err:
                raise err
            if not _pins_of(state):
                state['pins'] = {'tracker_nft_id': nft, 'denomination': denom}
        self._update(pin)

    def _features(self):
        """The feature tags the server advertises in GET /info (which also checks the pins), for a pinned profile. A
        profile not pinned yet is served exactly as by 0.3 (no extra request): it is pinned by its first call.
        Malformed tags count as advertised (the residue rule applies) and none is recognised (['?'])."""
        if not self._pinned():
            return []
        return _features_of(self.info())

    def _circulation(self):
        """GET /info (which pins an enrolled profile) and its feature tags, for what needs circulating credit:
        feature_unavailable unless they list circulation/1."""
        features = _features_of(self.info())
        if 'circulation/1' not in features:
            raise ValunError('feature_unavailable', 'this Valun server does not offer circulating credit (circulation/1); '
                                                    'nothing was signed')
        return features

    def _contract(self):
        """Tracker v3.2 (design v3.2 section 5): what signs a prior acknowledgment PA(...) (a bound note, a payment by
        transfer, a payee's or payer's consent) is signed only when the last GET /info's novation object reports exactly
        the contract novation.CONTRACT; otherwise feature_unavailable before anything is asked for or signed, as for a
        server without circulation/1."""
        problem = nv.contract_problem(getattr(self, '_novation', None))
        if problem:
            raise ValunError('feature_unavailable', problem + '; nothing was signed')

    def me(self):
        return self.request('GET', '/pilot/v1/me')

    def inbox(self):
        return self.request('GET', '/pilot/v1/inbox')

    def deals(self):
        return self.request('GET', '/pilot/v1/deals')

    def deal(self, deal_id):
        return self.request('GET', f'/pilot/v1/deals/{deal_id}')

    def directory(self):
        return self.request('GET', '/pilot/v1/participants', auth=False)

    def participant(self, pid):
        return self.request('GET', f'/pilot/v1/participants/{pid}', auth=False)

    def ledger(self):
        return self.request('GET', '/pilot/v1/ledger', auth=False)

    def set_limits(self, body):
        """Record limits and goals the owner gave this agent; the server keeps them within the owner's mandate."""
        return self.request('PUT', '/pilot/v1/limits', body)

    # ---------- guarantees (servers listing guarantees/1; fix inbox #18) ----------
    # A guarantee is a backer's signed promise to pay one creditor, up to a cap, what one issuer still owes that
    # creditor after a due time, if the creditor calls before the expiry. What is signed here is checked first, as for
    # deals: the terms hash to their hash, are valun-guarantee/1 for this network and tracker, and name this agent with
    # its current key; the backer's offer verifies under the backer's registered key. The backer honors a call with its
    # own credit note to the creditor, for exactly the amount the creditor signed and never beyond the cap by its own
    # records, written ahead in its records before anything is sent.
    def guarantees(self):
        return self.request('GET', '/pilot/v1/guarantees')

    def guarantee(self, guarantee_id):
        return self.request('GET', f'/pilot/v1/guarantees/{_seg(guarantee_id)}')

    def _guarantees_offered(self):
        # GET /info itself (it pins a profile not pinned yet), not _features(), which serves such a profile as 0.3 did.
        if 'guarantees/1' not in _features_of(self.info()):
            raise ValunError('feature_unavailable', 'this Valun server offers no guarantees (GET /info features has no '
                                                    'guarantees/1); nothing was signed')

    def verify_guarantee(self, g, role=None):
        """The terms of a guarantee view, checked before anything is signed for it: they hash to terms_hash, are
        valun-guarantee/1 for this network and its tracker, cover issuer_debt_to_creditor with a whole cap in this
        network's unit, name this agent (as `role`, when given) with its current key, and the backer's offer signature
        verifies under the backer key the terms name, which must be the backer's registered key. Returns
        {'terms_hash', 'terms', 'role'}."""
        if not isinstance(g, dict) or not isinstance(g.get('terms'), dict):
            raise ValunError('bad_response', "the server did not return the guarantee's terms")
        t = g['terms']
        h = terms_hash(t)
        if h != g.get('terms_hash'):
            raise ValunError('hash_mismatch', "the guarantee's terms do not hash to its terms_hash; refusing to sign")
        if t.get('protocol') != GUARANTEE_PROTOCOL or t.get('network') != self.network:
            raise ValunError('wrong_network', 'the guarantee is for a different network or protocol')
        info = self.info()
        if t.get('tracker_nft_id') != info['tracker_nft_id'] or t.get('denomination') != info['denomination']:
            raise ValunError('wrong_tracker', 'the guarantee names a different tracker or unit than this network')
        cap = t.get('cap') if isinstance(t.get('cap'), dict) else {}
        if t.get('covers') not in (GUARANTEE_COVERS, GUARANTEE_COVERS_DEALS) or not (_nat(cap.get('amount')) and cap['amount'] > 0) or cap.get('unit') != self.unit:
            raise ValunError('bad_terms', 'the guarantee does not cover issuer_debt_to_creditor or issuer_payment_for_deals up to a whole cap in this network\'s unit')
        if t.get('covers') == GUARANTEE_COVERS_DEALS:
            _check_deal_ids(t.get('deals'), 'bad_terms')
        elif 'deals' in t:
            raise ValunError('bad_terms', 'the guarantee names deals but does not cover issuer_payment_for_deals')
        parties = {r: t.get(r) for r in ('backer', 'issuer', 'creditor')}
        if not all(isinstance(x, dict) and isinstance(x.get('id'), str) and _is_pubkey(x.get('pubkey')) for x in parties.values()):
            raise ValunError('bad_terms', 'the guarantee must name a backer, an issuer and a creditor, each with its key')
        mine = [r for r, x in parties.items() if x['id'] == self.participant_id]
        if not mine or (role is not None and role not in mine):
            raise ValunError('not_a_party', f'you are not the {role or "a party"} of this guarantee')
        r = role or mine[0]
        if parties[r]['pubkey'] != self.pubkey:
            raise ValunError('wrong_key', f'the guarantee names a different key for you as its {r}; ask your operator')
        backer_key = parties['backer']['pubkey']
        if r != 'backer' and self._registered_key(parties['backer']['id']) != backer_key:
            raise ValunError('wrong_key', "the backer key in the terms is not the backer's registered key")
        if not _text_signed(backer_key, statement('guarantee-offer', h), (g.get('offer') or {}).get('signature')):
            raise ValunError('bad_signature', "the backer's offer signature does not verify")
        return {'terms_hash': h, 'terms': t, 'role': r}

    def build_guarantee_terms(self, issuer_id, creditor_id, cap, due_in_hours, callable_for_hours=168, honor_within_hours=24,
                              offer_valid_hours=24, note='', deals=None):
        """The terms of a guarantee this agent offers as backer: the issuer's and the creditor's registered keys, the cap
        in this network's unit, callable from due_in_hours from now for callable_for_hours, honored within
        honor_within_hours, open for offer_valid_hours (never past the expiry). With `deals` (1 to 10 deal ids, in which
        the issuer pays the creditor), it covers only what is unpaid of those deals (fix inbox #29)."""
        if deals is not None:
            _check_deal_ids(deals, 'bad_arguments')
        for name, v, lo, hi in (('cap', cap, 1, None), ('due_in_hours', due_in_hours, 0, 1440), ('callable_for_hours', callable_for_hours, 1, 1440),
                                ('honor_within_hours', honor_within_hours, 1, 168), ('offer_valid_hours', offer_valid_hours, 1, 168)):
            if not _nat(v) or v < lo or (hi is not None and v > hi):
                raise ValunError('bad_arguments', f'{name} must be a whole number from {lo}' + (f' to {hi}' if hi is not None else ''))
        if not isinstance(note, str) or len(note) > 500:
            raise ValunError('bad_arguments', 'note must be text of at most 500 characters')
        if issuer_id == creditor_id or self.participant_id in (issuer_id, creditor_id):
            raise ValunError('bad_arguments', 'the issuer, the creditor and you (the backer) must be three different participants')
        info = self.info()
        now = datetime.now(timezone.utc)
        due = now + timedelta(hours=due_in_hours)
        expires = due + timedelta(hours=callable_for_hours)
        return {'protocol': GUARANTEE_PROTOCOL, 'network': self.network, 'tracker_nft_id': info['tracker_nft_id'],
                'denomination': info['denomination'], 'guarantee_id': 'vg_' + secrets.token_hex(8), 'nonce': secrets.token_hex(16),
                'backer': {'id': self.participant_id, 'pubkey': self.pubkey},
                'issuer': {'id': issuer_id, 'pubkey': self._registered_key(issuer_id)},
                'creditor': {'id': creditor_id, 'pubkey': self._registered_key(creditor_id)},
                'cap': {'amount': int(cap), 'unit': self.unit}, 'covers': GUARANTEE_COVERS_DEALS if deals is not None else GUARANTEE_COVERS,
                **({'deals': list(deals)} if deals is not None else {}),
                'due_at': _iso(due), 'expires_at': _iso(expires), 'honor_within_hours': int(honor_within_hours),
                'offer_expires_at': _iso(min(now + timedelta(hours=offer_valid_hours), expires)), 'note': note}

    def offer_guarantee(self, issuer_id, creditor_id, cap, due_in_hours, callable_for_hours=168, honor_within_hours=24,
                        offer_valid_hours=24, note='', deals=None):
        """Offer a guarantee as its backer (build_guarantee_terms), signed with statement guarantee-offer."""
        self._guarantees_offered()
        t = self.build_guarantee_terms(issuer_id, creditor_id, cap, due_in_hours, callable_for_hours, honor_within_hours,
                                       offer_valid_hours, note, deals)
        h = terms_hash(t)
        return self.request('POST', '/pilot/v1/guarantees', {'terms': t, 'terms_hash': h, 'signature': self._sign(statement('guarantee-offer', h))})

    def _checked_guarantee(self, guarantee_id, role, expected_terms_hash):
        self._guarantees_offered()
        g = self.guarantee(guarantee_id)
        chk = self.verify_guarantee(g, role)
        if expected_terms_hash and expected_terms_hash != chk['terms_hash']:
            raise ValunError('stale_terms', 'the guarantee is not the one you reviewed; read it again (valun_guarantees) first')
        return g, chk

    def accept_guarantee(self, guarantee_id, expected_terms_hash=None):
        """Accept a guarantee offered to this agent as its creditor (it commits the creditor to nothing)."""
        _g, chk = self._checked_guarantee(guarantee_id, 'creditor', expected_terms_hash)
        h = chk['terms_hash']
        return self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/accept', {'terms_hash': h, 'signature': self._sign(statement('guarantee-accept', h))})

    def decline_guarantee(self, guarantee_id, reason=''):
        g = self.guarantee(guarantee_id)
        h = g['terms_hash']
        return self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/decline', {
            'terms_hash': h, 'reason': reason, 'signature': self._sign(statement('guarantee-decline', h, sha256_hex(reason)))})

    def withdraw_guarantee(self, guarantee_id):
        g = self.guarantee(guarantee_id)
        h = g['terms_hash']
        return self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/withdraw', {'terms_hash': h, 'signature': self._sign(statement('guarantee-withdraw', h))})

    def release_guarantee(self, guarantee_id, expected_terms_hash=None):
        """End a guarantee this agent accepted as its creditor: it can no longer be called."""
        _g, chk = self._checked_guarantee(guarantee_id, 'creditor', expected_terms_hash)
        h = chk['terms_hash']
        return self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/release', {'terms_hash': h, 'signature': self._sign(statement('guarantee-release', h))})

    def call_guarantee(self, guarantee_id, amount=None, expected_terms_hash=None):
        """Call a guarantee this agent holds as its creditor, for `amount` (default: everything callable now, as the
        server computes it from the tracker). The server checks the amount again against the tracker."""
        g, chk = self._checked_guarantee(guarantee_id, 'creditor', expected_terms_hash)
        t, callable_now = chk['terms'], g.get('callable_now')
        a = callable_now if amount is None else amount
        if not _nat(a) or a < 1:
            raise ValunError('nothing_callable', (f'nothing can be called on this guarantee now (callable_now: {callable_now}). It is callable '
                                                  f"from {t['due_at']} until {t['expires_at']}, for what the issuer still owes you, "
                                                  'less what earlier calls claimed, within the cap left; nothing was signed'))
        cid = 'vgc_' + secrets.token_hex(8)
        h = chk['terms_hash']
        return self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/calls', {
            'call_id': cid, 'amount': a, 'terms_hash': h, 'signature': self._sign(statement('guarantee-call', h, cid, str(a)))})

    def honor_guarantee(self, guarantee_id, call_id=None, expected_terms_hash=None):
        """Pay a call of a guarantee this agent gave, with its own credit note to the creditor. Checked before anything
        is signed: the guarantee (verify_guarantee, as its backer); the call (open or failed, its id and a whole
        amount, signed by the creditor over exactly that id and amount, under the key the terms name or its registered
        key); this agent's own record of the calls it honored or is honoring, which with this one must stay within the
        cap it signed (exceeds_cap); and the note template as complete() checks a deal's: this agent's key, the
        creditor's current key, exactly the call's amount on top of the prior total, the pinned tracker and unit, a
        current timestamp. With a server listing bound_notes/1 the note is bound (its prior is this agent's own
        signature and not older than its records, and the prior acknowledgment PA(I,R,P,p,ts) is signed too; only for
        the tracker v3.2 contract); otherwise ordinary (the prior total must equal its record; an edge a novation
        changed takes bound notes only). R4 and the pending record are written ahead before anything is sent; an
        earlier note for the same call that may have applied is never followed by another (honor_pending)."""
        g, chk = self._checked_guarantee(guarantee_id, 'backer', expected_terms_hash)
        t, h = chk['terms'], chk['terms_hash']
        calls = [c for c in (g.get('calls') or []) if isinstance(c, dict)]
        if call_id is None:
            waiting = [c for c in calls if c.get('state') in ('open', 'failed')]
            if not waiting:
                raise ValunError('nothing_to_honor', 'no call of this guarantee is waiting to be honored; nothing was signed')
            c = waiting[0]
        else:
            c = next((x for x in calls if x.get('call_id') == call_id), None)
            if c is None:
                raise ValunError('not_found', f'this guarantee has no call {call_id}')
        cid, amount = c.get('call_id'), c.get('amount')
        if c.get('state') == 'honored':
            raise ValunError('already_honored', f'call {cid} is honored already')
        if c.get('state') not in ('open', 'failed') or not isinstance(cid, str) or not re.fullmatch(r'vgc_[0-9a-f]{16}', cid) or not (_nat(amount) and amount > 0):
            raise ValunError('wrong_state', f'call {cid} is {c.get("state")}; nothing to honor')
        creditor_id = t['creditor']['id']
        creditor_pk = self._registered_key(creditor_id)
        call_text = statement('guarantee-call', h, cid, str(amount))
        if not any(_text_signed(k, call_text, c.get('signature')) for k in {t['creditor']['pubkey'], creditor_pk}):
            raise ValunError('bad_signature', "the creditor's signature on this call does not verify; nothing was signed")
        cap = t['cap']['amount']
        features = self._features()
        bound = 'bound_notes/1' in features
        if bound:
            self._contract()                    # never an ordinary note instead: fail closed
        tpl = self.request('GET', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/calls/{_seg(cid)}/note-template' + ('?prior=1&bound=1' if bound else ''))
        if not isinstance(tpl, dict) or tpl.get('issuer_pubkey') != self.pubkey or tpl.get('recipient_pubkey') != creditor_pk:
            raise ValunError('bad_template', "the note template does not name your key and the creditor's current key")
        P, total, ts = tpl.get('prior_total'), tpl.get('total'), tpl.get('timestamp')
        if tpl.get('amount') != amount or not (_nat(P) and _nat(total) and _nat(ts)) or total != P + amount:
            raise ValunError('bad_template', "the note template does not add exactly the call's amount")
        nft, denom = tpl.get('tracker_nft_id'), tpl.get('denomination')
        if nft != t['tracker_nft_id'] or denom != t['denomination']:
            raise ValunError('bad_template', 'the note template names a different tracker or unit')
        self._check_pins(nft, denom)
        now_ms = int(time.time() * 1000)
        if bound:
            if ts % 1000 != nv.BOUND_MS or not (now_ms - 10 * 60_000 <= ts <= now_ms + 5000):
                raise ValunError('bad_template', 'the note template is not a current bound note (residue 997)')
        elif abs(ts - now_ms) > 10 * 60_000 or (features and ts % 1000 >= RESERVED_MS_FROM):
            raise ValunError('bad_template', 'the note template timestamp is not current, or ends in a residue kept for other operations')
        pair = f'{self.pubkey}>{creditor_pk}'
        verify = self._note_verifier(nft, denom)
        self._reload()
        p = 0
        if bound:
            prior = tpl.get('prior_note')
            if prior is None:
                known = self._known_total(pair)
                if P != 0 or tpl.get('prior_timestamp') != 0 or known not in (None, 0):
                    raise ValunError('ledger_mismatch', 'the server shows no note on this edge, but its template or your own records say otherwise. Ask your operator.')
            else:
                problem = records.prior_problem(_records_in(self.state, create=False), pair, prior, self.pubkey, verify)
                if problem or prior.get('total') != P or prior.get('timestamp') != tpl.get('prior_timestamp'):
                    raise ValunError('ledger_mismatch', ('the prior note the server shows on this edge is not your own latest note '
                                                         f'({problem or "it does not match the template"}). Ask your operator.'))
                p = prior['timestamp']
        else:
            known = self._known_total(pair)
            if known is not None and known != P:
                raise ValunError('ledger_mismatch', f'the server says you have issued this creditor {P} {self.unit} of credit notes so far; your own record says {known}. Ask your operator.')
        op, signed_at = 'guarantee_note:' + cid, _iso(datetime.now(timezone.utc))
        slots = {nv.slot_key(pair, 'new'): total}
        if bound:
            slots = {nv.slot_key(pair, 'prior'): P, **slots}
        wa = {'op': op, 'signed': [dict({'edge': pair, 'timestamp': ts, 'op': op, 'slots': slots}, **({'prior_state': {'total': P, 'timestamp': p}} if bound else {}))],
              'pending': [{'pair': pair, 'total': total, 'timestamp': ts, 'kind': 'guarantee_note', 'ref': cid, 'direction': 'out'}], 'attempt': None}
        agreed = {'tracker_nft_id': nft, 'denomination': denom}

        def ahead(state):                       # written before the note is signed and sent: its outcome is not known yet
            err = _pin_problem(_pins_of(state), nft, denom)
            if err:
                raise err
            if not bound:
                problem = nv.unbound_note_problem(pair, state.get('novated_edges'), features)
                if problem:
                    raise ValunError(problem, 'a novation changed this edge, so it takes bound credit notes only; nothing was signed'
                                     if problem == 'bound_note_required' else "this profile's record of novated edges cannot be read; nothing was signed")
            honors = _dict_in(state, GUARANTEE_HONORS_KEY)
            rec = honors.get(guarantee_id) if isinstance(honors.get(guarantee_id), dict) else {}
            mine = rec.get('calls') if isinstance(rec.get('calls'), dict) else {}
            others = sum(x.get('amount', 0) for k, x in mine.items() if k != cid and isinstance(x, dict) and x.get('state') in ('pending', 'honored') and _nat(x.get('amount')))
            if others + amount > cap:
                raise ValunError('exceeds_cap', (f'honoring {amount} {self.unit} would bring what you paid or are paying under this guarantee to '
                                                 f'{others + amount} {self.unit}, above its cap of {cap} {self.unit} (by your own records); nothing was signed'))
            was = mine.get(cid)
            if isinstance(was, dict) and was.get('state') == 'pending' and _nat(was.get('total')) and P >= was['total']:
                raise ValunError('honor_pending', (f'your earlier note for this call ({was["total"]} {self.unit} in total to this creditor) may already be on '
                                                   f'the tracker: the edge is at {P} {self.unit} now. Refusing to sign another. Ask your operator.'))
            _guarded(nv.apply_write_ahead, state, wa, signed_at)
            if not _pins_of(state):
                state['pins'] = dict(agreed)
            honors[guarantee_id] = {'cap': cap, 'calls': dict(mine, **{cid: {'amount': amount, 'state': 'pending', 'total': total, 'timestamp': ts}})}
        self._secret()                          # not_connected before anything is recorded
        self._update(ahead)
        note = {'total': total, 'timestamp': ts, 'signature': self._sign_message(nv.message(self.pubkey, creditor_pk, total, ts, nft, denom))}
        credit_note = dict(note)
        if bound:
            credit_note.update(prior_total=P, prior_timestamp=p, prior_signature=self._sign_message(nv.prior_message(self.pubkey, creditor_pk, P, p, ts, nft, denom)))
        body = {'terms_hash': h, 'amount': amount, 'signature': self._sign(statement('guarantee-honor', h, cid, str(amount))), 'credit_note': credit_note}

        def settle(state, outcome):
            honors = _dict_in(state, GUARANTEE_HONORS_KEY)
            rec = honors.get(guarantee_id)
            calls_rec = rec.get('calls') if isinstance(rec, dict) and isinstance(rec.get('calls'), dict) else None
            if outcome == 'honored':
                self._confirm_in(state, pair, note)
                if calls_rec is not None and isinstance(calls_rec.get(cid), dict):
                    calls_rec[cid]['state'] = 'honored'
            else:                               # refused or failed: this note will not be recorded
                records.remove_pending(_records_in(state), pair, total, ts, cid)
                if calls_rec is not None and isinstance(calls_rec.get(cid), dict) and calls_rec[cid].get('timestamp') == ts:
                    calls_rec[cid]['state'] = 'failed'
        try:
            r = self.request('POST', f'/pilot/v1/guarantees/{_seg(guarantee_id)}/calls/{_seg(cid)}/honor', body)
        except ValunError as e:
            if e.status is not None and 400 <= e.status < 500:
                self._settle(lambda state: settle(state, 'refused'))
            raise                               # otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
        shown = next((x for x in (r.get('calls') or []) if isinstance(x, dict) and x.get('call_id') == cid), None) if isinstance(r, dict) else None
        st = shown.get('state') if isinstance(shown, dict) else None
        if st == 'honored':
            self._settle(lambda state: settle(state, 'honored'))
        elif st == 'failed':
            self._settle(lambda state: settle(state, 'failed'))
        return r

    # ---------- independent checks ----------
    def _registered_key(self, pid):
        p = self.participant(pid)
        if p.get('status') != 'active' or not p.get('pubkey'):
            raise ValunError('counterparty_inactive', f'{pid} has no active registered key')
        return p['pubkey']

    def verify_offer(self, d):
        """Recompute the hash of the current terms and check the proposer's signature against the directory key."""
        cur = d.get('current')
        if not cur:
            raise ValunError('no_offer', 'this deal has no visible offer')
        t = cur['terms']
        h = terms_hash(t)
        if h != cur['terms_hash']:
            raise ValunError('hash_mismatch', 'the terms do not hash to the stated terms_hash; refusing to sign')
        if t['network'] != self.network or t['protocol'] != PROTOCOL:
            raise ValunError('wrong_network', 'terms are for a different network or protocol')
        info = self.info()
        if t['tracker_nft_id'] != info['tracker_nft_id'] or t['denomination'] != info['denomination']:
            raise ValunError('wrong_tracker', 'terms name a different tracker or unit than this network')
        mine = {'payer': t['payer'], 'payee': t['payee']}
        if self.participant_id not in (t['payer']['id'], t['payee']['id']):
            raise ValunError('not_a_party', 'you are not a party to these terms')
        for role, x in mine.items():
            if x['id'] == self.participant_id and x['pubkey'] != self.pubkey:
                raise ValunError('wrong_key', f'the terms name a different key for you as {role}')
        proposer_key = self._registered_key(cur['by'])
        if proposer_key != (t['payer'] if t['payer']['id'] == cur['by'] else t['payee'])['pubkey']:
            raise ValunError('wrong_key', 'the proposer key in the terms is not the registered key')
        if not vb.verify(bytes.fromhex(cur['signature']), statement('propose', h).encode('utf-8'), bytes.fromhex(proposer_key)):
            raise ValunError('bad_signature', "the proposer's signature does not verify")
        if datetime.fromisoformat(t['offer_expires_at'].replace('Z', '+00:00')) < datetime.now(timezone.utc):
            raise ValunError('expired', 'the offer has expired')
        return {'terms_hash': h, 'proposer_signature_valid': True, 'terms': t}

    # ---------- acts (all signed locally) ----------
    def build_terms(self, counterparty_id, role, title, description, deliverable, price, deliver_by_hours=48,
                    offer_ttl_hours=24, deal_id=None, version=1, prior=None, prior_expires_at=None):
        """valun-deal/1 terms for a new proposal (or, with deal_id, version and prior, a counter-offer); signs nothing.
        The price is a whole number of this network's unit, at least 1 (bad_price; never truncated). Delivery is due
        deliver_by_hours from now; the offer stays open offer_ttl_hours, or, with offer_ttl_hours None,
        COUNTER_OFFER_HOURS but never past deliver_by nor past prior_expires_at (an ISO time: the end of the offer a
        counter-offer answers). Times are whole seconds, rounded down. Terms the server would refuse for their times are
        refused here first (bad_arguments, fix inbox #23): an offer open longer than the hours it gives to deliver
        (check_offer_hours), or one that would already have expired when it is sent."""
        if role not in ('payer', 'payee'):
            raise ValunError('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)')
        amount = _price_amount(price, self.unit)
        if offer_ttl_hours is not None:
            check_offer_hours(offer_ttl_hours, deliver_by_hours)
        info = self.info()
        other = {'id': counterparty_id, 'pubkey': self._registered_key(counterparty_id)}
        me = {'id': self.participant_id, 'pubkey': self.pubkey}
        now = datetime.now(timezone.utc)
        deliver_by = now + timedelta(hours=deliver_by_hours)
        if offer_ttl_hours is None:
            ends = [now + timedelta(hours=COUNTER_OFFER_HOURS), deliver_by]
            if prior_expires_at is not None:
                ends.append(datetime.fromisoformat(prior_expires_at.replace('Z', '+00:00')))
            expires = _iso(min(ends))
        else:
            expires = _iso(now + timedelta(hours=offer_ttl_hours))
        if not datetime.fromisoformat(expires.replace('Z', '+00:00')) > now:
            raise ValunError('bad_arguments', (f'the offer would expire at {expires}, before it is sent: it must stay open '
                                               'for at least 1 h (offer_valid_hours); nothing was signed'))
        return {'protocol': PROTOCOL, 'network': self.network, 'tracker_nft_id': info['tracker_nft_id'], 'denomination': info['denomination'],
                'deal_id': deal_id or ('vd_' + secrets.token_hex(8)), 'version': version, 'prior_terms_hash': prior,
                'nonce': secrets.token_hex(16), 'proposer': self.participant_id,
                'payer': me if role == 'payer' else other, 'payee': other if role == 'payer' else me,
                'service': {'title': title, 'description': description, 'deliverable': deliverable},
                'price': {'amount': amount, 'unit': self.unit}, 'consideration': 'credit_note_on_delivery_accepted',
                'deliver_by': _iso(deliver_by), 'offer_expires_at': expires}

    def propose(self, counterparty_id, role, title, description, deliverable, price, deliver_by_hours=48, offer_ttl_hours=24):
        t = self.build_terms(counterparty_id, role, title, description, deliverable, price, deliver_by_hours, offer_ttl_hours)
        h = terms_hash(t)
        return self.request('POST', '/pilot/v1/deals', {'terms': t, 'terms_hash': h, 'signature': self._sign(statement('propose', h))})

    def counter(self, deal_id, price=None, title=None, description=None, deliverable=None, deliver_by_hours=None, offer_ttl_hours=None,
                expected_terms_hash=None):
        """Sign a counter-offer: the given changes, the rest copied from the current offer. With expected_terms_hash
        (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current offer is another.
        The new version follows the version inside the verified (hashed) terms, not the server's view of the deal.
        Delivery is due deliver_by_hours from now, by default by the current offer's deadline (rounded down to the hour,
        at least 1 h from now). The counter-offer stays open offer_ttl_hours; by default (fix inbox #23)
        COUNTER_OFFER_HOURS, but never past its own delivery deadline nor past the end of the offer it answers, so a
        price-only counter to an offer due within a day is valid terms too."""
        d = self.deal(deal_id)
        chk = self.verify_offer(d)
        if expected_terms_hash and expected_terms_hash != chk['terms_hash']:
            raise ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before countering')
        t0 = chk['terms']
        role = 'payer' if t0['payer']['id'] == self.participant_id else 'payee'
        other = t0['payee']['id'] if role == 'payer' else t0['payer']['id']
        due_h = deliver_by_hours if deliver_by_hours is not None else max(1, int((datetime.fromisoformat(t0['deliver_by'].replace('Z', '+00:00')) - datetime.now(timezone.utc)).total_seconds() // 3600))
        t = self.build_terms(other, role, title or t0['service']['title'], description or t0['service']['description'],
                             deliverable or t0['service']['deliverable'], price if price is not None else t0['price']['amount'],
                             due_h, offer_ttl_hours, deal_id=deal_id, version=t0['version'] + 1, prior=chk['terms_hash'],
                             prior_expires_at=t0['offer_expires_at'])
        h = terms_hash(t)
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/counter', {'terms': t, 'terms_hash': h, 'signature': self._sign(statement('propose', h))})

    def accept(self, deal_id, expected_terms_hash=None):
        d = self.deal(deal_id)
        chk = self.verify_offer(d)
        if expected_terms_hash and expected_terms_hash != chk['terms_hash']:
            raise ValunError('stale_terms', 'the offer changed since you inspected it; inspect it again before accepting')
        h = chk['terms_hash']
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/accept', {'terms_hash': h, 'signature': self._sign(statement('accept', h))})

    def decline(self, deal_id, reason=''):
        d = self.deal(deal_id)
        h = d['current']['terms_hash']
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/decline', {'terms_hash': h, 'reason': reason,
                                                                           'signature': self._sign(statement('decline', h, sha256_hex(reason)))})

    def withdraw(self, deal_id):
        d = self.deal(deal_id)
        h = (d.get('pending_counter') or d['current'])['terms_hash']
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/withdraw', {'terms_hash': h, 'signature': self._sign(statement('withdraw', h))})

    def deliver(self, deal_id, content, title=''):
        d = self.deal(deal_id)
        if not d.get('agreement'):
            raise ValunError('not_agreed', 'there is no agreement to deliver against')
        h, dh = d['agreement']['terms_hash'], sha256_hex(content)
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/deliver', {'terms_hash': h, 'content': content, 'title': title, 'sha256': dh,
                                                                            'signature': self._sign(statement('deliver', h, dh))})

    def complete(self, deal_id, expected_deliverable_sha256=None, expected_terms_hash=None):
        """Accept the delivery and pay with this agent's own credit note, after checking the template independently.

        Checked before anything is signed (_accepted_delivery): the content matches its hash (and the one the caller
        reviewed); the agreement's hash (and the one the caller reviewed) and both signatures; then the payee's signature
        on the delivery, under the key the terms name or the payee's current directory key.

        With a server that lists bound_notes/1 (a pinned profile reads /info), the note is a BOUND note (PROTOCOL.md
        18.5, design 6.3): the template is asked for with ?prior=1&bound=1 and checked by
        novation.evaluate_bound_template (15.3 R1-R13, and decision D-1: one live payment attempt per deal, with one
        GET /edges read-back when an earlier attempt's edge must be read); a prior older than this client's own
        confirmed state of the edge is refused as well (ledger_mismatch). Only for the tracker v3.2 contract (GET /info
        novation, novation.CONTRACT; feature_unavailable otherwise, before the template is asked for). The note
        M(I,R,P+price,ts) and its prior acknowledgment PA(I,R,P,p,ts) (p the prior note's timestamp, 0 for a new edge)
        are built and signed here and sent as credit_note {total, timestamp, signature, prior_total, prior_timestamp,
        prior_signature}, after the R4 record, the payment attempt and the pending entry are saved.

        Otherwise (no features, or a profile not pinned yet: exactly as 0.3 on the wire) an ORDINARY note: the template
        names this agent's key and the payee's current key, adds exactly the agreed price, names the agreed (and pinned)
        tracker and unit, is current and, when features are advertised, avoids the reserved residues 995-999
        (bad_template); the prior total must equal this client's own record of the confirmed total (ledger_mismatch);
        an edge a novation changed takes bound notes only (R12, bound_note_required); and D-1 applies
        (novation.check_payment: transfer_window_open, attempt_outcome_unknown, already_paid).

        Both: a pending note of its own that its deal or the prior note shows applied is confirmed on the way, and the
        deal it paid is recorded as paid (records['paid_deals']). A deal its records show paid, or one whose note of
        its own may have applied, is never paid again (already_paid). The note is recorded as pending before it is
        sent, and confirmed only when the server answers note_issued (the deal is then recorded as paid): an owner can
        still reject a held note (OQ-23). A refused note is forgotten; a bound note's payment attempt is kept until it
        is dead (D-1)."""
        d = self.deal(deal_id)
        terms, h, dh = self._accepted_delivery(d, deal_id, expected_deliverable_sha256, expected_terms_hash)
        # A pinned (0.4) profile reads /info: a server offering bound_notes/1 takes bound notes, and with any feature the
        # tracker keeps the timestamp residues 995-999 for other operations. Otherwise exactly as 0.3.
        features = self._features()
        if 'bound_notes/1' in features:
            return self._complete_bound(deal_id, d, terms, h, dh, features)
        tpl = self.request('GET', f'/pilot/v1/deals/{deal_id}/credit-note-template')
        # The note is between the parties' CURRENT keys (an owner may have replaced an agent key after the deal was
        # agreed): it must be signed by this agent's key and credit the payee's key as the directory lists it now.
        payee = self._registered_key(terms['payee']['id'])
        price = terms['price']['amount']
        if tpl['issuer_pubkey'] != self.pubkey or tpl['recipient_pubkey'] != payee:
            raise ValunError('bad_template', 'credit-note template names the wrong parties')
        if tpl['price'] != price or tpl['total'] != tpl['prior_total'] + price:
            raise ValunError('bad_template', 'credit-note template does not add exactly the agreed price')
        self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
        pair = f'{self.pubkey}>{payee}'
        verify = self._note_verifier(terms['tracker_nft_id'], terms['denomination'])
        self._reload()
        self._check_records(pair, tpl, payee, verify, deal_id, d)
        nft, denom = tpl['tracker_nft_id'], tpl['denomination']
        if nft != terms['tracker_nft_id'] or denom != terms['denomination']:
            raise ValunError('bad_template', 'credit-note template names a different tracker or unit')
        self._check_pins(nft, denom)
        now_ms = int(time.time() * 1000)
        if abs(tpl['timestamp'] - now_ms) > 10 * 60_000:
            raise ValunError('bad_template', 'credit-note template timestamp is not current')
        if features and tpl['timestamp'] % 1000 >= RESERVED_MS_FROM:
            raise ValunError('bad_template', (f"credit-note template timestamp {tpl['timestamp']} ends in {tpl['timestamp'] % 1000}: "
                                              'the tracker keeps residues 995-999 for other operations; refusing to sign it as a credit note'))
        self._secret()
        note = {'total': tpl['total'], 'timestamp': tpl['timestamp']}
        agreed = {'tracker_nft_id': nft, 'denomination': denom}
        signed_at = _iso(datetime.now(timezone.utc))

        def ahead(state):                       # written before the note is signed and sent: its outcome is not known yet
            err = _pin_problem(_pins_of(state), nft, denom)
            if err:
                raise err
            # R12: an edge a novation changed takes bound notes only. D-1: one live payment attempt per deal.
            problem = nv.unbound_note_problem(pair, state.get('novated_edges'), features)
            if problem == 'bound_note_required':
                raise ValunError(problem, 'a novation changed this edge, so it takes bound credit notes only, and this server '
                                          'offers none; nothing was signed')
            if problem:
                raise ValunError(problem, "this profile's record of novated edges cannot be read; nothing was signed")
            r = nv.check_payment(deal_id, price, 'note', pair, tpl['prior_total'],
                                 self._ctx(state, now_ms, features, pins=_pins_of(state) or agreed))
            _guarded(nv.apply_findings, state, r['summary'], self.pubkey)
            if not r['ok']:
                return r
            if not _pins_of(state):             # the first call after an upgrade pins the agreed tracker and unit
                state['pins'] = dict(agreed)
            records.add_pending(_records_in(state), pair, note['total'], note['timestamp'], 'note', deal_id, 'out', signed_at)
            return r
        r = self._update(ahead)
        if not r['ok']:
            raise _refusal_error(r)
        note['signature'] = self._sign_message(vb.note_message(bytes.fromhex(self.pubkey), bytes.fromhex(payee), note['total'],
                                                               note['timestamp'], bytes.fromhex(nft), denom))
        body = {'terms_hash': h, 'deliverable_sha256': dh, 'signature': self._sign(statement('complete', h, dh)),
                'credit_note': dict(note)}
        return self._send_note(deal_id, pair, body, note)

    def _complete_bound(self, deal_id, d, terms, h, dh, features):
        """complete() with a server that lists bound_notes/1: a bound note (see complete())."""
        self._contract()                        # never an ordinary note instead: fail closed
        tpl = self.request('GET', f'/pilot/v1/deals/{deal_id}/credit-note-template?prior=1&bound=1')
        payee = self._registered_key(terms['payee']['id'])
        self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
        pair = f'{self.pubkey}>{payee}'
        self._reload()
        known = self._known_total(pair)
        if self._pending_notes(pair, deal_id) or (isinstance(tpl, dict) and tpl.get('prior_note') is None
                                                   and known is not None and known != tpl.get('prior_total')):
            self._confirm_issued(pair, payee, self._note_verifier(terms['tracker_nft_id'], terms['denomination']), deal_id, d)
        self._secret()
        deal = nv.deal_context(terms, h, dh)
        now_ms = int(time.time() * 1000)
        signed_at = _iso(datetime.now(timezone.utc))

        def older_prior(r):                     # design 6.3: a prior I signed, not older than my own confirmed state
            for a in r['summary']['advisories']:
                if a['edge'] == pair:
                    shown, mine = a['shown'], a['recorded']
                    return _refused(r, 'ledger_mismatch', (
                        f"the server shows an older prior credit note to this payee ({shown['total']} {self.unit} at {shown['timestamp']}) "
                        f"than your own record ({mine['total']} {self.unit} at {mine['timestamp']}). Ask your operator."))
            return None
        r = self._decide(lambda state, edges: nv.evaluate_bound_template(tpl, self._ctx(
            state, now_ms, features, deal=deal, payee_current_pk=payee, edges=edges)), signed_at, refuse=older_prior)
        if not r['ok']:
            raise _refusal_error(r)
        msgs = nv.slot_messages(r['to_sign'], tpl['tracker_nft_id'], tpl['denomination'])
        note = {'total': tpl['total'], 'timestamp': tpl['timestamp'], 'signature': self._sign_message(msgs[nv.slot_key(pair, 'new')])}
        body = {'terms_hash': h, 'deliverable_sha256': dh, 'signature': self._sign(statement('complete', h, dh)),
                'credit_note': dict(note, prior_total=tpl['prior_total'],
                                    prior_timestamp=r['write_ahead']['attempt']['prior_timestamp'],
                                    prior_signature=self._sign_message(msgs[nv.slot_key(pair, 'prior')]))}
        return self._send_note(deal_id, pair, body, note)

    def _send_note(self, deal_id, pair, body, note):
        """POST complete with a credit note already recorded as pending, and record the outcome. note_issued: the note is
        confirmed and its deal recorded as paid. completion_awaiting_owner, issuing_note: it stays pending. Any other
        answer, or a refusal (4xx): the pending entry is forgotten (a bound note's payment attempt stays until it is
        dead, decision D-1). No answer (unreachable, 5xx): it stays pending, since the outcome is not known."""
        def forget(state):
            records.remove_pending(_records_in(state), pair, note['total'], note['timestamp'], deal_id)
        try:
            r = self.request('POST', f'/pilot/v1/deals/{deal_id}/complete', body)
        except ValunError as e:
            if e.status is not None and 400 <= e.status < 500:     # refused: the server did not record this note
                self._settle(forget)
            raise                               # otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
        status = r.get('status') if isinstance(r, dict) else None
        if status == 'note_issued':
            self._settle(lambda state: self._note_applied(state, deal_id, pair, note))
        elif status not in ('completion_awaiting_owner', 'issuing_note'):
            self._settle(forget)                # e.g. note_failed: the tracker does not hold it
        return r

    def _note_applied(self, state, deal_id, pair, note):
        """The server answered note_issued: the note is the edge's confirmed state, and it paid its deal (D-1 item 5)."""
        self._confirm_in(state, pair, note)
        _guarded(nv.mark_paid, state, deal_id, 'note', pair, note['total'], note['timestamp'])

    def _accepted_delivery(self, d, deal_id, expected_deliverable_sha256=None, expected_terms_hash=None):
        """What a payer accepts, checked before anything is asked for or signed (complete() and pay_by_transfer()): the
        deal has a delivery and an agreement; the content hashes to the delivery's sha256 (and to the one the caller
        reviewed: stale_delivery); the agreed terms hash to the agreement's hash and carry both parties' signatures
        (verified_agreement), are terms of `deal_id` (deal_mismatch) and hash to the ones the caller reviewed
        (stale_terms). Returns (terms, terms_hash, deliverable_sha256). The payee's signature on the delivery is checked
        once the payee's current key is known (check_delivery_signature)."""
        if not isinstance(d, dict) or not d.get('delivery') or not d.get('agreement'):
            raise ValunError('not_delivered', 'nothing has been delivered on this deal')
        dh = d['delivery']['sha256']
        if sha256_hex(d['delivery']['content']) != dh:
            raise ValunError('hash_mismatch', 'the delivered content does not match its hash')
        if expected_deliverable_sha256 and expected_deliverable_sha256 != dh:
            raise ValunError('stale_delivery', 'the delivery changed since you reviewed it')
        terms = self.verified_agreement(d)
        if terms.get('deal_id') != deal_id:
            raise ValunError('deal_mismatch', 'the agreed terms the server shows are for another deal; nothing was signed')
        h = terms_hash(terms)
        if expected_terms_hash and expected_terms_hash != h:
            raise ValunError('stale_terms', 'the agreed terms are not the ones you reviewed; refusing to accept the delivery')
        return terms, h, dh

    def _sign_message(self, msg) -> str:
        """A Basis signature by this agent's key over bytes this client built itself (R1)."""
        return vb.sign(msg, self._secret(), bytes.fromhex(self.pubkey)).hex()

    # ---------- the signing firewall (novation.py) ----------
    def _ctx(self, state, now_ms, features, **extra):
        """The evaluators' context, from this client's state as just reloaded under the profile lock (novation.py)."""
        ctx = {'me_pk': self.pubkey, 'me_id': self.participant_id, 'now_ms': now_ms, 'verify': _verify_hex, 'unit': self.unit,
               'pins': _pins_of(state), 'records': state.get('records'), 'signed': state.get('signed'),
               'transfer_attempts': state.get('transfer_attempts'), 'novated_edges': state.get('novated_edges'),
               'features': list(features), 'consent_policy': state.get('consent_policy'),
               'novation': getattr(self, '_novation', None)}
        ctx.update(extra)
        return ctx

    def _decide(self, evaluate, signed_at, refuse=None, also=None, edges=None, read_back=None):
        """Run a novation.py evaluator, evaluate(state, edges), on this client's state under the profile lock (update()
        reloads it, so another process cannot sign at the same edge and timestamp in between) and record, in the same
        step, what it found (apply_findings), whether or not it allows signing. When it does, refuse(result) names no
        other refusal and something is left to sign, also record what is about to be signed (apply_write_ahead, R9)
        and run also(state, result).
        An evaluation refused with transfer_window_open because an earlier attempt's edge was not read is decided once
        more after a read-back of my edges (read_back(), by default sync_edges(); decision D-1): an edge the read-back
        does not list at all does not exist. Returns the evaluation."""
        def deciding(ctx_edges):
            def fn(state):
                r = evaluate(state, ctx_edges)
                _guarded(nv.apply_findings, state, r['summary'], self.pubkey)
                if r['ok'] and refuse is not None:
                    r = refuse(r) or r
                if r['ok'] and r['to_sign']:
                    _guarded(nv.apply_write_ahead, state, r['write_ahead'], signed_at)
                    if also is not None:
                        also(state, r)
                return r
            return fn
        r = self._update(deciding(edges))
        need = r['summary'].get('needs_read_back') if not r['ok'] and r['code'] == 'transfer_window_open' else None
        if need:
            fresh = (read_back or self._read_back)()
            if fresh is not None:
                ctx_edges = dict(fresh['edges'])
                for e in need:
                    if e not in fresh['doubtful']:      # listed with a state that did not verify: still not read
                        ctx_edges.setdefault(e, None)
                r = self._update(deciding(ctx_edges))
        return r

    def _read_back(self):
        """My edges as GET /edges shows them now (sync_edges(): {edges, doubtful, ...}), or None when they cannot be
        read."""
        try:
            return self.sync_edges()
        except ValunError:
            return None

    def _settle(self, fn):
        """Record an outcome after the server answered. The attempt was written ahead, so if this fails (the profile is
        busy or unreadable, or the disk refuses the write) the entry simply stays pending and is settled later; the
        server's answer is what counts."""
        try:
            self._update(fn)
        except (ValunError, OSError):
            pass

    # ---------- records of credit notes (records.py) ----------
    def _confirm_in(self, state, pair, edge):
        e = records.confirm(_records_in(state), pair, edge)
        if e['confirmed'] and pair.startswith(f'{self.pubkey}>'):
            _issued_in(state)[pair] = e['confirmed']['total']    # the 0.3 record stays the confirmed total

    def _known_total(self, pair):
        """My own record of the confirmed total on an outgoing edge: the records' confirmed state, else the 0.3 record."""
        c = records.confirmed_total(_records_in(self.state, create=False), pair)
        return c if c is not None else _issued_in(self.state, create=False).get(pair)

    def _check_records(self, pair, tpl, payee, verify, deal_id, d):
        """An ordinary note's prior total must equal my record of the confirmed total, when I have one, and this deal
        must not be one my records may show paid. First, a held or issuing note of mine that its deal now records as
        issued is confirmed (owner approvals happen after this client signed): when the totals disagree, and whenever
        a note of mine for this deal is pending."""
        known = self._known_total(pair)
        if self._pending_notes(pair, deal_id) or (known is not None and known != tpl['prior_total']):
            self._confirm_issued(pair, payee, verify, deal_id, d)
        known = self._known_total(pair)
        if known is not None and known != tpl['prior_total']:
            raise ValunError('ledger_mismatch', f"the server says you have issued this payee {tpl['prior_total']} {self.unit} of credit notes so far; your own record says {known}. Ask your operator.")
        for p in self._pending_notes(pair, deal_id):
            # Still pending, so neither its deal nor the edge shows its outcome. If the edge has reached its total, it may
            # have applied (an owner approved it after this client signed): paying the deal again could pay it twice.
            if isinstance(p.get('total'), int) and not isinstance(p['total'], bool) and tpl['prior_total'] >= p['total']:
                raise ValunError('already_paid', (f"your earlier credit note for this deal ({p['total']} {self.unit} in total to this payee) may "
                                                  f"already be on the tracker: the edge's total is {tpl['prior_total']} {self.unit} now. Refusing "
                                                  'to pay it again. Ask your operator.'))

    def _pending_notes(self, pair, deal_id):
        """My pending credit notes for this deal on this edge."""
        return [p for p in records.get(_records_in(self.state, create=False), pair)['pending']
                if isinstance(p, dict) and p.get('kind') == 'note' and p.get('ref') == deal_id]

    def _confirm_issued(self, pair, payee, verify, deal_id, current=None):
        """Confirm my pending notes on this edge that their deals record as issued (with the note's own signature), and
        record the deals they paid (decision D-1 item 5)."""
        found = []
        for p in records.get(_records_in(self.state, create=False), pair)['pending']:
            if not (isinstance(p, dict) and p.get('kind') == 'note' and p.get('direction') == 'out' and isinstance(p.get('ref'), str)):
                continue
            try:
                d = current if current is not None and p['ref'] == deal_id else self.deal(p['ref'])
            except ValunError:
                continue
            if not isinstance(d, dict):
                continue
            tn = ((d.get('credit_note') or {}).get('tracker_note') or {}) if d.get('status') == 'note_issued' else {}
            st = {'total': tn.get('amount_collected'), 'timestamp': tn.get('timestamp'), 'signature': tn.get('signature')}
            if (st['total'], st['timestamp']) == (p.get('total'), p.get('timestamp')) \
                    and verify(self.pubkey, payee, st['total'], st['timestamp'], st['signature']):
                found.append((st, p))
        if found:
            latest = max((st for st, _p in found), key=lambda s: s['timestamp'])

            def confirm(state):
                self._confirm_in(state, pair, latest)
                for st, p in found:
                    _guarded(nv.mark_paid, state, p['ref'], 'note', pair, st['total'], st['timestamp'])
            self._update(confirm)
            self._refuse_paid_again(deal_id, [p for _st, p in found], self.unit)

    @staticmethod
    def _refuse_paid_again(deal_id, applied, unit=UNIT):
        """A note of mine that applied paid its own deal: never sign a second payment for it, whatever the server says."""
        for p in applied:
            if p.get('kind') == 'note' and p.get('ref') == deal_id:
                raise ValunError('already_paid', (f"your credit note for this deal ({p.get('total')} {unit}) is already on the tracker, so "
                                                  'the deal is paid; refusing to pay it again. Ask your operator.'))

    @staticmethod
    def _note_verifier(tracker_nft_id, denomination):
        return lambda issuer, recipient, total, ts, sig: verify_note(issuer, recipient, total, ts, sig, tracker_nft_id, denomination)

    @staticmethod
    def check_delivery_signature(delivery, terms_hash_hex, *payee_keys):
        """The payee signed this delivery: statement('deliver', terms_hash, sha256) verifies under one of `payee_keys`
        (the key the terms name, or the payee's current directory key after an owner replaced it). Else
        bad_delivery_signature."""
        sig, dh = delivery.get('signature'), delivery.get('sha256')
        text = statement('deliver', terms_hash_hex, str(dh)).encode('utf-8')
        for k in dict.fromkeys(payee_keys):
            try:
                if isinstance(sig, str) and isinstance(k, str) and vb.verify(bytes.fromhex(sig), text, bytes.fromhex(k)):
                    return
            except ValueError:
                pass
        raise ValunError('bad_delivery_signature', "the delivery is not signed by the payee's key; refusing to accept it")

    def dispute(self, deal_id, reason):
        d = self.deal(deal_id)
        terms = self.verified_agreement(d)
        h, dh = terms_hash(terms), d['delivery']['sha256']
        return self.request('POST', f'/pilot/v1/deals/{deal_id}/dispute', {'terms_hash': h, 'deliverable_sha256': dh, 'reason': reason,
                                                                            'signature': self._sign(statement('dispute', h, dh, sha256_hex(reason)))})

    def verified_agreement(self, d):
        """The agreed terms, checked: hash, both parties' signatures against their registered keys."""
        a = d.get('agreement')
        if not a:
            raise ValunError('not_agreed', 'no agreement on this deal')
        cur = d['current']
        t = cur['terms']
        h = terms_hash(t)
        if h != a['terms_hash']:
            raise ValunError('hash_mismatch', 'agreement hash does not match its terms')
        keys = {t['payer']['id']: t['payer']['pubkey'], t['payee']['id']: t['payee']['pubkey']}
        prop = cur['by']
        acc = t['payee']['id'] if prop == t['payer']['id'] else t['payer']['id']
        if not vb.verify(bytes.fromhex(a['proposer_signature']), statement('propose', h).encode(), bytes.fromhex(keys[prop])):
            raise ValunError('bad_signature', 'proposer signature on the agreement does not verify')
        if not vb.verify(bytes.fromhex(a['acceptor_signature']), statement('accept', h).encode(), bytes.fromhex(keys[acc])):
            raise ValunError('bad_signature', 'acceptor signature on the agreement does not verify')
        return t

    # ---------- circulating credit: payment by transfer (PROTOCOL.md 18.6; design 4.5, 6.3) ----------
    def payment_options(self, deal_id):
        """GET /deals/{id}/payment-options (the payer; a deal delivered, note_failed or payment_due): the own-note option
        and the notes this agent holds that could pay the deal ({issuer {id, handle, pubkey, operator_run}, held,
        reserved, spendable, enough, payee_accepts, issuer_consents, payee_consents, why_not}), any pending transfer and
        fallback_after. The server's view, for choosing: pay_by_transfer() checks the template itself."""
        return self.request('GET', f'/pilot/v1/deals/{_seg(deal_id)}/payment-options')

    def transfer_template(self, deal_id, issuer_id):
        """GET /deals/{id}/transfer-template?issuer=<participant id>: what paying the deal with that issuer's note would
        sign (deal_id, terms_hash, deliverable_sha256, issuer/payer/payee {id, handle, pubkey}, amount, timestamp,
        from_edge {before, new_total}, to_edge {before, new_total}, tracker_nft_id, denomination, quote_digest,
        collect_until, messages). Unchecked: pay_by_transfer() checks it before signing anything."""
        return self.request('GET', f'/pilot/v1/deals/{_seg(deal_id)}/transfer-template?issuer={_seg(issuer_id)}')

    def pay_by_transfer(self, deal_id, issuer, expected_deliverable_sha256=None, expected_quote_digest=None,
                        expected_claim_total=None):
        """Accept the delivery and pay the payee C with part of a note this agent holds: the issuer A's debt to me falls
        by the price and A's debt to C rises by it (PROTOCOL.md 18.6). `issuer` names A among the notes the deal's
        payment options list: by participant id, or by handle when no id matches (unknown_issuer otherwise).

        Checked before anything is signed: the delivery and the agreement as for complete() (_accepted_delivery), and
        the payee's signature on the delivery; the server lists circulation/1 and reports the tracker v3.2 contract (GET
        /info novation, novation.CONTRACT; feature_unavailable); the template is for
        the issuer chosen, under that participant's current key (bad_template); novation.evaluate_payer_template
        (15.3 R1-R13, and decision D-1: one live payment attempt per deal across notes and transfers, with one GET
        /edges read-back when an earlier attempt's edge must be read). With expected_quote_digest (the quote the owner
        approved) another quote is stale_quote; with expected_claim_total (my claim on A that the owner saw) another
        prior total of A->me is stale_claim.

        Saved before anything is sent (R9): the R4 record of the three slots, the payment attempt (transfer_attempts),
        the pending decrease of my claim on A (records) and approved_payments[deal_id] = the quote digest. Then it signs
        the complete statement (an unconditional acceptance of the delivery), the pay statement and the slots
        '<A>><me>:prior' (PA(A,me,X,p_AB,T): my claim's total and its state's timestamp, tracker v3.2), '<A>><me>:new'
        and '<A>><C>:new', and posts them with from_prior_total, from_prior_timestamp, to_prior_total and
        to_prior_timestamp (the edge states the template showed; 0 and 0 for a new destination edge). A 409
        transfer_stale that the server answers with a fresh template (it recorded nothing) is checked once more under
        the same quote digest: D-1 signs it as the identical operation (the first attempt's timestamp) or, at a new T,
        when it acknowledges the same state of my claim on A as the first attempt (total and timestamp: on tracker v3.2
        at most one of the two can apply, audit VS-1 closed), in both cases while my claim on A is exactly that state;
        a template on another state of my claim is transfer_window_open until the first attempt is dead; one that names
        the transfer it recorded (transfer_id, regenerated_as: the edges changed before it applied, and it may have been
        made again, to be signed as a consent) is not retried, and the deal view is returned. paid_by_transfer records
        the deal as paid; a refusal, or payment_due, forgets the pending entry, and the attempt stays until it is dead
        (with the server's id of it, attempt_id, once known). Returns the deal view."""
        if expected_claim_total is not None and not _nat(expected_claim_total):
            raise ValunError('bad_arguments', f'expected_claim_total is a whole number of {self.unit} (the claim your owner saw); '
                                              'nothing was signed')
        self._secret()
        d = self.deal(deal_id)
        terms, h, dh = self._accepted_delivery(d, deal_id, expected_deliverable_sha256)
        payee = self._registered_key(terms['payee']['id'])
        self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
        features = self._circulation()
        self._contract()
        issuer_id = self._resolve_issuer(deal_id, issuer)
        issuer_pk = self._registered_key(issuer_id)
        mandate = _mandate_of(self.me())
        deal = nv.deal_context(terms, h, dh)
        tpl = self.transfer_template(deal_id, issuer_id)
        approved = expected_quote_digest
        for retry in (False, True):
            r, body = self._transfer_signed(tpl, issuer_id, issuer_pk, payee, deal, features, mandate, approved,
                                            expected_claim_total)
            a = r['write_ahead']['attempt']

            def forget(state, a=a):
                records.remove_pending(_records_in(state), a['edge'], a['total'], a['timestamp'], deal['deal_id'])
            try:
                view = self.request('POST', f"/pilot/v1/deals/{_seg(deal['deal_id'])}/pay-by-transfer", body)
            except ValunError as e:
                if e.status is not None and 400 <= e.status < 500:     # refused, or recorded and failed: nothing moved
                    self._settle(forget)
                    ex = e.extra or {}
                    recorded = nv.shown_id(ex.get('transfer_id')) or nv.shown_id(ex.get('regenerated_as'))
                    if e.code == 'transfer_stale' and recorded:
                        # The server recorded this transfer and the edges changed before it applied (it says which, and
                        # whether it made it again): never retried here. A transfer made again is signed as a consent,
                        # under the quote approved now (process_consents); the deal view says where the deal stands.
                        tid = nv.shown_id(ex.get('transfer_id'))
                        if tid:
                            self._settle(lambda state, a=a: self._note_attempt_id(state, a, tid))
                        return ex['deal'] if isinstance(ex.get('deal'), dict) else self.deal(deal_id)
                    if e.code == 'transfer_stale' and not retry:
                        fresh = ex.get('template')
                        tpl = fresh if isinstance(fresh, dict) else self.transfer_template(deal_id, issuer_id)
                        approved = approved or r['summary']['quote_digest']
                        continue
                raise                           # otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
            status = view.get('status') if isinstance(view, dict) else None
            pay = view.get('payment') if isinstance(view, dict) and isinstance(view.get('payment'), dict) else {}
            tid = nv.shown_id(pay.get('transfer_id'))
            if tid:
                self._settle(lambda state, a=a: self._note_attempt_id(state, a, tid))
            if status == 'paid_by_transfer':
                self._settle(lambda state, a=a: _guarded(nv.mark_paid, state, a['deal_id'], 'transfer', a['edge'], a['total'],
                                                         a['timestamp']))
            elif status == 'payment_due':
                self._settle(forget)
            return view

    @staticmethod
    def _note_attempt_id(state, attempt, attempt_id):
        """Record the server's id of a payment attempt (its transfer id) on my record of it, for the owner (valun attempts
        list / resolve). An id it already has is kept."""
        att = state.get('transfer_attempts')
        for x in (att.get(attempt['deal_id']) or []) if isinstance(att, dict) else ():
            if isinstance(x, dict) and all(x.get(k) == attempt[k] for k in ('route', 'edge', 'total', 'timestamp')) \
                    and not x.get('attempt_id'):
                x['attempt_id'] = attempt_id

    def _transfer_signed(self, tpl, issuer_id, issuer_pk, payee, deal, features, mandate, approved, claim):
        """One attempt of pay_by_transfer(): check the template, save what is about to be signed, sign it. Returns
        (evaluation, POST body)."""
        iss = tpl.get('issuer') if isinstance(tpl, dict) else None
        if not (isinstance(iss, dict) and iss.get('id') == issuer_id and iss.get('pubkey') == issuer_pk):
            raise ValunError('bad_template', "the transfer template is not for the issuer you chose, under that issuer's "
                                             'current key; nothing was signed')
        now_ms = int(time.time() * 1000)
        signed_at = _iso(datetime.now(timezone.utc))

        def claim_shown(r):
            held = tpl['from_edge']['before']['total']
            if claim is not None and held != claim:
                return _refused(r, 'stale_claim', f'your claim on this issuer is {held} {self.unit} now, not the {claim} {self.unit} you reviewed; '
                                                  'nothing was signed. Review the payment again.')
            return None

        def approve(state, r):
            _dict_in(state, 'approved_payments')[deal['deal_id']] = r['summary']['quote_digest']
        r = self._decide(lambda state, edges: nv.evaluate_payer_template(tpl, self._ctx(
            state, now_ms, features, deal=deal, payee_current_pk=payee, approved_quote_digest=approved, mandate=mandate,
            edges=edges)), signed_at, refuse=claim_shown, also=approve)
        if not r['ok']:
            raise _refusal_error(r)
        q = r['summary']['quote_digest']
        from_before, to_before = tpl['from_edge']['before'], tpl['to_edge'].get('before')
        msgs = nv.slot_messages(r['to_sign'], tpl['tracker_nft_id'], tpl['denomination'])
        body = {'issuer_id': issuer_id, 'terms_hash': deal['terms_hash'], 'deliverable_sha256': deal['deliverable_sha256'],
                'quote_digest': q, 'timestamp': tpl['timestamp'], 'from_prior_total': from_before['total'],
                'from_prior_timestamp': from_before['timestamp'],
                'to_prior_total': to_before['total'] if to_before is not None else 0,
                'to_prior_timestamp': to_before['timestamp'] if to_before is not None else 0,
                'completion_signature': self._sign(statement('complete', deal['terms_hash'], deal['deliverable_sha256'])),
                'pay_signature': self._sign(nv.pay_statement(deal['deal_id'], q)),
                'signatures': {slot: self._sign_message(m) for slot, m in msgs.items()}}
        return r, body

    def _resolve_issuer(self, deal_id, issuer):
        """The participant id of the issuer `issuer` names among the notes the deal's payment options list: an exact
        participant id first; a handle only when no id matches, and only when exactly one listed issuer has it."""
        if not isinstance(issuer, str) or not issuer:
            raise ValunError('unknown_issuer', 'name the issuer of the note to pay with, by participant id or handle')
        opts = self.payment_options(deal_id)
        held = opts.get('held_notes') if isinstance(opts, dict) else None
        issuers = [h['issuer'] for h in (held if isinstance(held, list) else [])
                   if isinstance(h, dict) and isinstance(h.get('issuer'), dict) and isinstance(h['issuer'].get('id'), str)]
        for x in issuers:
            if x['id'] == issuer:
                return x['id']
        named = [x for x in issuers if x.get('handle') == issuer]
        if len(named) == 1:
            return named[0]['id']
        raise ValunError('unknown_issuer', f'the payment options for this deal list no note of yours from {issuer[:64]!r}; '
                                           'nothing was signed')

    def cancel_transfer(self, deal_id):
        """POST /deals/{id}/cancel-transfer (the payer, while its transfer collects signatures). Not signed: a refusal
        cannot move value. The deal becomes payment_due. The pending decrease of my held claim is forgotten; the payment
        attempt stays until it is dead (decision D-1), because its signatures exist until their maximum age."""
        r = self.request('POST', f'/pilot/v1/deals/{_seg(deal_id)}/cancel-transfer', {})
        if isinstance(r, dict) and r.get('status') in ('payment_due', 'delivered'):
            self._settle(lambda state: self._forget_transfers(state, deal_id))
        return r

    # ---------- payment attempts, and the owner's resolution of one (decisions D-1 item 3, D-2 d) ----------
    def _deal_rows(self, state, deal_id, now_ms, edges=None):
        """[(attempt, outcome)] of the deal's payment attempts in `state`, as the payer evaluators weigh them
        (novation.classify_attempts: attempt records, the objects of `state`, then pending payment entries that no
        record covers, with prior None). records_unreadable when the records cannot be read."""
        if not self.pubkey:
            raise ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it')
        r = nv.classify_attempts(deal_id, self._ctx(state, now_ms, [], edges=edges or None))
        if not r['ok']:
            raise ValunError(r['code'] if r['code'] in nv.REFUSAL_CODES else 'records_unreadable',
                             "this profile's record of payment attempts cannot be read, or an edge state read does not "
                             'verify; nothing was changed')
        return [(x['attempt'], x['outcome']) for x in r['attempts']]

    def payment_attempts(self, edges=None, now_ms=None, doubtful=None):
        """This client's payment attempts, deal by deal, as its records hold them, each with how the payer evaluators
        classify it now (novation.classify_attempts: the same read-back rules and the same proof from my own records as
        when a payment is signed). `edges` is a read-back of my edges, {edge: EdgeState} this client verified
        (sync_edges()['edges']): as for the evaluators' read-back, an edge of my attempts that it does not list does not
        exist, unless `doubtful` (sync_edges()['doubtful']) lists it (shown with a state that did not verify: not read);
        None: nothing was read. My own confirmed state of an edge counts once it is at or past the attempt. For `valun
        attempts list`; makes no request.
        Returns [{deal_id, ref ('#n': the deal's n-th attempt, for resolve_attempt), attempt_id (the server's id of a
        transfer, when known), route ('note' | 'transfer'), edge, prior (None: a pending entry without a record), total,
        timestamp, outcome (the owner's decision, if any), state ('applied' | 'unknown' | 'alive' | 'dead' | 'unread'),
        paid (the deal is recorded as paid), paid_by (the ref of the attempt records['paid_deals'] names as the deal's
        payment, by attempt_key; None when the deal is not recorded as paid, or is paid by a payment this list does not
        show)}]. On a paid deal an 'unknown' attempt blocks nothing (the deal is never paid again) and leaves nothing
        for the owner to resolve. records_unreadable when the records cannot be read."""
        now = int(time.time() * 1000) if now_ms is None else now_ms
        state = self.state
        recs = _records_in(state, create=False)
        paid = recs.get(nv.PAID_DEALS_KEY) if isinstance(recs.get(nv.PAID_DEALS_KEY), dict) else {}
        read = None
        if edges is not None:
            read, skip = dict(edges), set(doubtful or ())
            for e in _attempt_edges(state):
                if e not in read and e not in skip:
                    read[e] = None              # not listed: the edge does not exist
        out = []
        for deal_id in sorted(_attempt_deals(state)):
            rows = [{'deal_id': deal_id, 'ref': f'#{n}', 'attempt_id': nv.shown_id(a.get('attempt_id')),
                     'route': a['route'], 'edge': a['edge'], 'prior': a.get('prior'), 'total': a['total'],
                     'timestamp': a['timestamp'],
                     'outcome': a.get('outcome') if a.get('outcome') in ATTEMPT_OUTCOMES else None,
                     'state': o, 'paid': deal_id in paid}
                    for n, (a, o) in enumerate(self._deal_rows(state, deal_id, now, read), 1)]
            by = attempt_key(paid[deal_id]) if isinstance(paid.get(deal_id), dict) else None
            ref = next((r['ref'] for r in rows if by is not None and attempt_key(r) == by), None)
            for r in rows:
                r['paid_by'] = ref
            out.extend(rows)
        return out

    def attempts_overview(self, edges=None, now_ms=None, doubtful=None):
        """payment_attempts() as `valun attempts list` shows them: each row also has ended_at_server, the state in which
        the server ended a transfer attempt before it ever reached the tracker (NEVER_APPLIED_TRANSFER), or None. Only
        a transfer attempt the records classify 'unknown' (it may have applied) whose server id they hold is looked up,
        on a server whose GET /info (read once, when one is) lists circulation/1: GET /pilot/v1/transfers/{id} must show
        it as that attempt of mine (this deal, me as payer, its timestamp, my held edge and its new total). A read that
        fails, a transfer shown otherwise or in any other state, leaves ended_at_server None. What is shown only: `state`
        stays the records' classification, which the payer evaluators use (R11), and nothing is recorded, so the server's
        word never lets this client sign a payment sooner. records_unreadable as payment_attempts()."""
        rows = self.payment_attempts(edges=edges, now_ms=now_ms, doubtful=doubtful)
        self._ended_at_server(rows, None, {})
        return rows

    def _ended_at_server(self, rows, circulation, views):
        """Set ended_at_server on each of `rows` (attempts_overview). circulation: whether GET /info lists circulation/1,
        or None to read it when a row needs it; views: the GET /transfers answers read so far ({id: view}), shared with
        _plan_transfer so that one call reads a transfer once."""
        ask = [r for r in rows if r['route'] == 'transfer' and r['state'] == 'unknown' and r['attempt_id']]
        if ask and circulation is None:
            try:
                circulation = 'circulation/1' in _features_of(self.info())
            except ValunError:
                circulation = False
        for r in rows:
            r['ended_at_server'] = None
        for r in ask if circulation else ():
            try:
                t = self._transfer_view(r['attempt_id'], views)
            except ValunError:
                continue                        # not read: shown as the records classify it
            info = self._shown_transfer(t, r['attempt_id'], r['deal_id'])
            if info is not None and _shows_attempt(info, r) and info['state'] in NEVER_APPLIED_TRANSFER:
                r['ended_at_server'] = info['state']

    def _transfer_view(self, sid, views):
        """GET /pilot/v1/transfers/{sid} (with the agent's token), once per call that passes the same `views`; {} for a
        404 (the server shows no such transfer to me) or an answer that is not an object. Other errors are raised."""
        if sid not in views:
            try:
                t = self.request('GET', f'/pilot/v1/transfers/{_seg(sid)}')
            except ValunError as e:
                if e.status != 404:
                    raise
                t = None
            views[sid] = t if isinstance(t, dict) else {}
        return views[sid]

    def _shown_transfer(self, t, sid, deal_id):
        """{timestamp, edge, total, id, state} of a GET /transfers view (_held_of, and its state as _server_word) when it
        shows a transfer of mine as payer for deal `deal_id` under the id `sid` (or no id); None otherwise."""
        deal = t.get('deal') if isinstance(t.get('deal'), dict) else {}
        roles = t.get('your_roles') if isinstance(t.get('your_roles'), list) else []
        if not (t and deal.get('deal_id') == deal_id and 'payer' in roles and t.get('id') in (None, sid)):
            return None
        return dict(self._held_of(t), id=sid, state=_server_word(t.get('state')))

    def resolution_plan(self, deal_id, attempt, edges=None, now_ms=None, doubtful=None):
        """How resolve_attempt() would resolve payment attempt `attempt` of deal `deal_id` (decision D-2 d), so that the
        owner sees it before deciding. Reads GET /info, and GET /transfers/{id} (with the agent's token) for a transfer
        whose server id is known, given or recorded, on a server that lists circulation/1. Changes nothing.
          attempt  '#n' (the deal's n-th attempt as payment_attempts() lists it), or the server's id of a transfer
                   attempt (vt_ and 16 hex digits)
        Returns {deal_id, attempt (its row; None when a server id names none of my records), attempts (the deal's rows,
        as attempts_overview() shows them: with ended_at_server), attempt_id (the server's id, or None), route ('note' |
        'transfer'), transfer (what
        GET /transfers showed: {id, state, timestamp, edge, total}, edge and total those of my held edge; or None),
        server (True: the server resolves it first, then my records follow), local (None, or why only my records
        change: 'note' (the server holds no payment attempt for a credit note), 'no_circulation' (the server lists no
        circulation/1), 'no_server_id' (a transfer whose server id my client never recorded: its request got no answer,
        or the server refused it), 'server_unknown' (the server shows no such transfer of mine as this attempt: 404,
        or another deal's, timestamp or edge), 'server_ended' (the server holds it as ended: transfer.state))}. The three LOCAL_CHOICES need the owner's explicit choice
        (resolve_attempt(local_only=True)): if the server holds the attempt after all, it keeps blocking the deal
        there, which fails safe. ValunError: bad_arguments; unknown_attempt (no such attempt of the deal in my records,
        or a server id the owner gave that names neither a payment of mine for this deal nor any of my records);
        attempt_in_progress (the server shows the transfer still awaiting its owner, collecting or applying: it can
        still apply); records_unreadable; a read that fails."""
        if not (isinstance(deal_id, str) and _DEAL_ID_RE.match(deal_id)):
            raise ValunError('bad_arguments', 'name the deal by its id (vd_ and 16 hex digits)')
        by_ref = isinstance(attempt, str) and _ATTEMPT_REF_RE.match(attempt) is not None
        if not (by_ref or (isinstance(attempt, str) and _TRANSFER_ID_RE.match(attempt))):
            raise ValunError('bad_arguments', "name the attempt as #n from `valun attempts list`, or by the server's id "
                                              'of a transfer (vt_ and 16 hex digits)')
        circulation = 'circulation/1' in _features_of(self.info())
        rows = [r for r in self.payment_attempts(edges=edges, now_ms=now_ms, doubtful=doubtful) if r['deal_id'] == deal_id]
        views = {}
        self._ended_at_server(rows, circulation, views)         # the rows as attempts_overview() shows them
        if by_ref:
            n = int(attempt[1:])
            if n > len(rows):
                raise ValunError('unknown_attempt', f'your records hold no attempt {attempt} of this deal; see `valun '
                                                    'attempts list`; nothing was changed')
            target = rows[n - 1]
            sid = target['attempt_id'] if target['route'] == 'transfer' else None
        else:
            sid = attempt
            target = next((r for r in rows if r['attempt_id'] == sid), None)
        plan = {'deal_id': deal_id, 'attempt': target, 'attempts': rows, 'attempt_id': sid,
                'route': target['route'] if target is not None else 'transfer', 'transfer': None, 'server': False,
                'local': None}
        if plan['route'] == 'note':
            plan['local'] = 'note'
        elif not circulation:
            plan['local'] = 'no_circulation'
        elif sid is None:
            plan['local'] = 'no_server_id'
        else:
            self._plan_transfer(plan, views)
        return plan

    def _plan_transfer(self, plan, views):
        """resolution_plan() for a transfer with a server id, on a circulation server: GET /transfers/{id} (read once:
        `views`) says whether the server can resolve it (UNRESOLVED_TRANSFER), and, when my records hold no attempt with
        that id, which of my transfer attempts it is (its timestamp, and my held edge at its new total). A transfer the
        server does not show as this attempt of mine (404; another deal's, not mine as payer, or another timestamp or
        edge than the record of mine that holds the id) is 'server_unknown' for an attempt my records hold, and
        unknown_attempt for an id the owner gave that none of them holds. An 'unknown' attempt the server shows ended in
        a NEVER_APPLIED_TRANSFER state gets ended_at_server, as attempts_overview() would show it."""
        sid, target = plan['attempt_id'], plan['attempt']
        info = self._shown_transfer(self._transfer_view(sid, views), sid, plan['deal_id'])
        mine = info is not None
        if mine and target is None:
            found = [r for r in plan['attempts'] if _shows_attempt(info, r)]
            plan['attempt'] = target = found[0] if len(found) == 1 else None
        if not mine or (target is not None and not _shows_attempt(info, target)):
            if target is None:
                raise ValunError('unknown_attempt', f'the server shows no transfer {sid} of yours for this deal, and your '
                                                    'records hold no attempt with that id; name it as #n from `valun '
                                                    'attempts list` (nothing was changed)')
            plan['local'] = 'server_unknown'
            return
        plan['transfer'] = info
        if target is not None and target['state'] == 'unknown' and info['state'] in NEVER_APPLIED_TRANSFER:
            target['ended_at_server'] = info['state']
        if info['state'] in UNRESOLVED_TRANSFER:
            plan['server'] = True
        elif info['state'] in LIVE_TRANSFER:
            raise ValunError('attempt_in_progress', f"the server shows this transfer {info['state']}: it can still apply. "
                                                    'Wait until it ends (or cancel it); nothing was changed')
        else:
            plan['local'] = 'server_ended'

    def _held_of(self, t):
        """{timestamp, edge, total} of a transfer view (GET /transfers, or the transfer a resolve answer carries): its
        timestamp, and my held edge (the one to my key) at its new total; None for what the view does not show."""
        t = t if isinstance(t, dict) else {}
        held = [e for e in (t.get('edges') if isinstance(t.get('edges'), list) else [])
                if isinstance(e, dict) and isinstance(e.get('edge'), str) and nv.parse_edge(e['edge'])
                and e['edge'].endswith(f'>{self.pubkey}')]
        return {'timestamp': t.get('timestamp') if _nat(t.get('timestamp')) else None,
                'edge': held[0]['edge'] if len(held) == 1 else None,
                'total': held[0].get('new_total') if len(held) == 1 and _nat(held[0].get('new_total')) else None}

    def _check_owner(self, owner_token):
        """The owner token is the owner's of this profile's participant: GET /pilot/v1/owner with it (read only). For a
        resolution only this client's records record (the server is not told, so it does not check the token), and
        for `valun config approvals` to or from console (an owner token changes the mandate of its own participant).
        Returns the GET /owner answer (a dict that names this participant); not_owner when the server refuses the
        token (401, 403, 404: an agent token gets 404) or names another participant, or none."""
        try:
            me = self.request('GET', '/pilot/v1/owner', token=owner_token)
        except ValunError as e:
            if e.status in (401, 403, 404):
                raise ValunError('not_owner', 'this is not the owner token of this participant; nothing was changed',
                                 e.status) from None
            raise
        p = me.get('participant') if isinstance(me, dict) and isinstance(me.get('participant'), dict) else {}
        if not p.get('id') or p.get('id') != self.participant_id:
            raise ValunError('not_owner', 'this owner token is not the owner\'s of this profile\'s participant; nothing '
                                          'was changed')
        return me

    def resolve_attempt(self, deal_id, attempt, outcome, owner_token, note=None, local_only=False, edges=None,
                        now_ms=None, doubtful=None, expected_attempt=_UNCHECKED):
        """The OWNER's resolution of a payment attempt whose outcome is unknown (attempt_outcome_unknown, or a transfer
        the server holds as outcome_unknown or inconsistent), after confirming with the payee whether the payment arrived
        (decision D-2 d). Never called by an agent: `valun attempts resolve` runs it at a terminal, after asking.
          attempt      '#n' (the deal's n-th attempt as payment_attempts() lists it), or the server's id of a transfer
          outcome      'not_applied': it did not apply; the deal can be paid again once its window has passed (D-1)
                       'applied': it applied; the deal is recorded as paid by it, and never paid again
          owner_token  the owner token, used once as the bearer of one request and never stored (required)
          note         for the server's audit line: at most RESOLVE_NOTE_MAX characters, no control, bidi or invisible
                       characters (bad_arguments otherwise, before anything is sent)
          local_only   record the decision in this client's records only (the owner chose it: LOCAL_CHOICES)
          expected_attempt  attempt_key() of the attempt the owner confirmed (resolution_plan()['attempt'] as shown to
                       the owner; None when that plan named no attempt of my records): resolve_attempt plans again, on
                       the profile reloaded from its store, and when the attempt it would resolve is another (another
                       process recorded, resolved or pruned an attempt of the deal meanwhile, so '#n' names another
                       one) refuses with attempt_changed before anything is sent or changed. Not given: not checked. A
                       list or tuple of four, or None (bad_arguments otherwise).
        resolution_plan() decides the path. The server resolves it first when it holds the transfer as
        UNRESOLVED_TRANSFER: POST /pilot/v1/owner/deals/{deal}/attempts/{vt}/resolve {outcome, note?}; its answer
        {resolution {attempt_id, outcome, previous_state, at, note}, deal, transfer} says which attempt it resolved. A 409
        wrong_state answer (it holds the attempt as ended) is raised with extra {local_possible: True, server: {error,
        message}}: nothing changed; the owner may then resolve it locally. So is a 404 not_found answer (it holds no such
        attempt), but only once the owner token is checked (GET /pilot/v1/owner): the server also answers 404 to a token
        that is not an owner's (an agent token) and to another participant's owner token, and those are raised as
        not_owner, with nothing changed and no local resolution offered. A 409 payee_edge_not_applied answer to
        'applied' (the payee's edge on the tracker does not show the transfer, valun-app SV-AUTH-1) is raised as
        payee_edge_not_applied with a message that says why (PAYEE_EDGE_WHY) and what to do instead (resolve it as not
        applied once the payee confirms it did not arrive, or ask the operator), extra {payee_edge, next_steps:
        PAYEE_EDGE_NEXT, local_possible: False, server}: nothing changed, and no local resolution is offered, since
        recording it as applied in my records alone would make my client never pay a deal the payee may not have
        been paid for. A credit note's attempt ('note': the server
        holds none), or a transfer on a server without circulation/1, is resolved in this client's records only, as is,
        with local_only, a transfer of the LOCAL_CHOICES (without it, those are refused with local_possible:
        attempt_id_unknown, not_found, wrong_state); the owner token is then checked first (GET /pilot/v1/owner:
        not_owner when it is not this participant's). A payment my records show applied is never resolved as not
        applied (already_paid), nor one the server shows still in progress (attempt_in_progress).
        Then this client's records follow, under the profile lock: the attempt the plan identified (by '#n', by the
        server id my records hold, or by the timestamp, held edge and total GET /transfers showed) gets outcome,
        attempt_id (the id the server was asked about) and resolved_at (a pending entry becomes an attempt record, its
        prior from the deal's verified price); 'applied' records the deal as paid (records['paid_deals']), and an
        attempt recorded applied stays applied. not_applied for an attempt none of my records holds, when the server was
        not told, changes nothing (unknown_attempt).
        Returns {deal_id, attempt_id, outcome, server (its answer, or None), local (why only the records changed, or
        None), matched: [the attempts as now recorded], paid (the deal is recorded as paid)}."""
        if outcome not in ATTEMPT_OUTCOMES:
            raise ValunError('bad_arguments', "outcome is 'not_applied' or 'applied'")
        if not (isinstance(owner_token, str) and owner_token.strip()):
            raise ValunError('bad_arguments', 'the owner token is needed to resolve a payment attempt; nothing was changed')
        if not (expected_attempt is _UNCHECKED or expected_attempt is None
                or (isinstance(expected_attempt, (list, tuple)) and len(expected_attempt) == 4)):
            raise ValunError('bad_arguments', 'expected_attempt is the attempt_key() of the attempt confirmed, or None; '
                                              'nothing was changed')
        owner_token = owner_token.strip()
        note = _owner_note(note)
        now = int(time.time() * 1000) if now_ms is None else now_ms
        self._reload()                          # plan again on the records as they are now (another process may write)
        plan = self.resolution_plan(deal_id, attempt, edges=edges, now_ms=now, doubtful=doubtful)
        target, shown = plan['attempt'], plan['transfer'] or {}
        if expected_attempt is not _UNCHECKED and attempt_key(target) != (
                None if expected_attempt is None else list(expected_attempt)):
            raise ValunError('attempt_changed', f"the deal's payment attempts changed since you confirmed: {attempt} no "
                                                'longer names the attempt you were shown; nothing was changed; look at '
                                                'them again (`valun attempts list`) and resolve the one you mean')
        if outcome == 'not_applied' and ((target is not None and target['state'] == 'applied')
                                         or shown.get('state') == 'applied'):
            raise ValunError('already_paid', 'your records (or the server) show this payment applied, so the deal is '
                                             'paid; it is not resolved as not applied; nothing was changed')
        if plan['local'] in LOCAL_CHOICES and not local_only:
            code = {'no_server_id': 'attempt_id_unknown', 'server_unknown': 'not_found', 'server_ended': 'wrong_state'}
            raise ValunError(code[plan['local']], 'the server cannot resolve this transfer; only your owner can choose to '
                                                  "record the decision in your client's records only; nothing was changed",
                             extra={'local_possible': True, 'local': plan['local']})
        price = None
        if target is not None and target['prior'] is None:     # a pending entry: its record needs the verified price
            price = self.verified_agreement(self.deal(deal_id))['price']['amount']
        answer = None
        if plan['server'] and not local_only:
            body = {'outcome': outcome} if note is None else {'outcome': outcome, 'note': note}
            try:
                answer = self.request('POST', f"/pilot/v1/owner/deals/{_seg(deal_id)}/attempts/{_seg(plan['attempt_id'])}"
                                              '/resolve', body, token=owner_token)
            except ValunError as e:
                if (e.status, e.code) == (409, 'payee_edge_not_applied'):
                    raise _payee_edge_refusal(e) from None
                if (e.status, e.code) in ((404, 'not_found'), (409, 'wrong_state')):
                    if e.status == 404:
                        # The owner routes do not exist for an agent token, and another participant's owner token is
                        # no party to the deal: the server answers both with 404 too. A resolution in my records only is
                        # offered for a 404 only with this participant's owner token (not_owner otherwise).
                        self._check_owner(owner_token)
                    raise ValunError(e.code, f'the server did not resolve it: {str(e)[:300]}', e.status,
                                     extra={'local_possible': True, 'server': {'error': e.code, 'message': str(e)[:300]}}) \
                        from None
                raise
        else:
            self._check_owner(owner_token)
        # The server's id of the attempt: the one it was asked to resolve (its answer names it: resolution.attempt_id).
        # When the plan could not tell which attempt of mine it is, the transfer the answer carries can: its timestamp,
        # and my held edge at its new total (the same view as GET /transfers).
        sid = plan['attempt_id'] if plan['route'] == 'transfer' else None
        resolved = self._held_of(answer.get('transfer')) if target is None and isinstance(answer, dict) else {}
        signed_at = _iso(datetime.now(timezone.utc))
        key = (lambda a: (a['route'], a['edge'], a['total'], a['timestamp']))

        def apply(state):
            att = _dict_in(state, 'transfer_attempts')
            lst = att.get(deal_id)
            if lst is None:
                lst = att[deal_id] = []
            if not isinstance(lst, list):
                raise ValunError('records_unreadable', "this profile's record of payment attempts cannot be read")
            rows = [a for a, _o in self._deal_rows(state, deal_id, now)]
            if target is not None:
                hits = [a for a in rows if key(a) == key(target)]
            else:                               # recorded with the server's id meanwhile, or the one the answer shows
                hits = [a for a in rows if sid and a['route'] == 'transfer' and a.get('attempt_id') == sid]
                if not hits and resolved.get('timestamp') is not None and resolved.get('edge'):
                    hits = [a for a in rows if a['route'] == 'transfer' and a['timestamp'] == resolved['timestamp']
                            and a['edge'] == resolved['edge'] and resolved.get('total') in (None, a['total'])][:1]
            matched = []
            for a in hits:
                rec = next((x for x in lst if x is a), None)
                if rec is None:                 # a pending entry: recorded as an attempt from now on
                    if price is None:
                        continue
                    rec = dict(a, prior=(a['total'] - price if a['route'] == 'note' else a['total'] + price))
                    if rec['prior'] < 0:
                        continue
                    lst.append(rec)
                if outcome == 'applied' or rec.get('outcome') != 'applied':     # evidence that it applied is kept
                    rec['outcome'] = outcome
                if sid and rec['route'] == 'transfer' and not rec.get('attempt_id'):
                    rec['attempt_id'] = sid
                rec['resolved_at'] = signed_at
                matched.append(dict(rec))
                if outcome == 'applied':
                    _guarded(nv.mark_paid, state, deal_id, rec['route'], rec['edge'], rec['total'], rec['timestamp'])
            if outcome == 'applied' and not matched:
                seen = shown if shown.get('edge') else resolved
                _guarded(nv.mark_paid, state, deal_id, plan['route'], seen.get('edge'), seen.get('total'),
                         seen.get('timestamp'))
            if not lst:
                del att[deal_id]
            if outcome == 'not_applied' and not matched and answer is None:
                raise ValunError('unknown_attempt', 'your records hold no attempt this names, so nothing is resolved in '
                                                    'them; name it as #n from `valun attempts list`')
            paid = _records_in(state).get(nv.PAID_DEALS_KEY)
            return matched, isinstance(paid, dict) and deal_id in paid
        matched, paid = self._update(apply)
        return {'deal_id': deal_id, 'attempt_id': sid, 'outcome': outcome, 'server': answer,
                'local': None if answer is not None else (plan['local'] or 'owner_choice'), 'matched': matched,
                'paid': paid}

    @staticmethod
    def _forget_transfers(state, deal_id):
        att = state.get('transfer_attempts')
        lst = att.get(deal_id) if isinstance(att, dict) else None
        recs = _records_in(state)
        for a in lst if isinstance(lst, list) else []:
            if isinstance(a, dict) and a.get('route') == 'transfer' and isinstance(a.get('edge'), str):
                records.remove_pending(recs, a['edge'], a.get('total'), a.get('timestamp'), deal_id)

    # ---------- circulating credit: consents (PROTOCOL.md 15.3, 18.9; design 6.6) ----------
    def consents(self):
        """GET /consents: the transfers and set-offs that wait for this agent's signatures ({consents: [item],
        recently_resolved: [...]}). Reading it records the poll (presence) and may let the server propose set-offs."""
        return self.request('GET', '/pilot/v1/consents')

    def submit_consent(self, consent_id, signatures, revisions):
        """POST /consents/{id} {signatures {'<edge>:<slot>': sig}, revisions {edge: n}}: send signatures this client made
        (process_consents() makes them after its firewall and write-ahead). The answer is the item as GET /consents
        would now show it, plus rejected [{slot, code 'stale_revision', revision}]."""
        return self.request('POST', f'/pilot/v1/consents/{_seg(consent_id)}', {'signatures': signatures, 'revisions': revisions})

    def refuse_consent(self, consent_id, reason=None):
        """POST /consents/{id}/refuse {reason?}: end a transfer (its deal becomes payment_due) or a set-off (a 24-hour
        cooldown). Not signed: a refusal cannot move value."""
        return self.request('POST', f'/pilot/v1/consents/{_seg(consent_id)}/refuse', {} if reason is None else {'reason': reason})

    def process_consents(self, policy=None, now_ms=None, value_safe_only=False):
        """Sign by itself the consents its owner's policy allows, and refuse the others (PROTOCOL.md 15.3, 18.9; design
        6.6). Deterministic; no rate limit here (the agent layer runs it at most once per 60 s).

        value_safe_only (decision D-3 a): the run an adapter without a consent loop makes before a read-only tool
        (valun_status, valun_inbox). It handles only the items whose one role is in VALUE_SAFE_ROLES (member: a set-off;
        payee: a payment to me by transfer), and only by signing what the firewall and the policy allow: it refuses
        nothing (an item they refuse waits, with their code, for a full run), and an item in any other role (issuer,
        payer, or none it can name) is neither read further, signed nor refused (waiting, code 'not_value_safe'; not
        written to consent_log). The run is recorded in consents_last_safe_run_ms, never in consents_last_run_ms, so it
        never delays a full run.

        `policy` is the local consent policy ({setoff, as_issuer, as_new_creditor, max_PC, accept_issuers,
        refuse_issuers}); None takes the profile's consent_policy, and an absent policy signs nothing. The owner's side
        is the mandate GET /me shows (effective_limits); the stricter of the two applies (R8). Nothing more is read or
        sent unless GET /info lists circulation/1 (the run is still recorded in consents_last_run_ms).

        Each item of GET /consents is checked by novation.evaluate_consent for the one role it gives this client (payer:
        a regenerated transfer of my own payment, re-signed only under the quote my payment was signed with; issuer;
        payee: the deal is read and verified here, delivered by me and paid by this transfer; member: a set-off). A
        payer or payee item, which signs a prior acknowledgment, waits with code feature_unavailable (neither signed nor
        refused) unless GET /info novation reports the tracker v3.2 contract (novation.CONTRACT). An item it allows is
        written ahead (R9), signed (the messages rebuilt here, R1: PA(...) for a prior slot, the 80-byte M(...) for a new
        one) and posted with each edge's revision; an item it refuses is refused at the server with the refusal code as
        its reason; a transfer_window_open that needs a read-back is decided again after one GET /edges per run. Items
        that are not collecting, that have nothing left for me to sign, whose deal could not be read now, whose posting
        failed, or whose signatures came back as stale revisions wait for a later run.

        Returns {signed: [entry], refused: [entry], waiting: [entry]}, entry = {id, kind, role, deal_id, amount,
        your_net_change_PC, your_total_owed_change_PC, code, reason} (signed entries add state and rejected; an entry
        whose request failed adds error). What the server wrote reaches an entry only in a checked form (_consent_entry:
        ids as novation.shown_id, kind and role from their lists, error codes and states as plain words, ^[a-z_]{1,40}$,
        else None; a waiting item's own state is not quoted); a waiting entry's code may be internal_error (the item
        raised something unexpected). Each decision is appended to consent_log (the last CONSENT_LOG_MAX), and
        consents_last_run_ms is set to now_ms. Every item is handled on its own: one that raises (the profile is busy or
        unreadable, a request fails) waits with its code, and the next is handled; what the run decided is recorded even
        when it stops early (an unreadable GET /consents answer)."""
        self._secret()
        report = {'signed': [], 'refused': [], 'waiting': []}
        now = int(time.time() * 1000) if now_ms is None else now_ms
        log = []
        ran = 'consents_last_safe_run_ms' if value_safe_only else 'consents_last_run_ms'

        def logged(state):
            old = state.get('consent_log')
            state['consent_log'] = ((old if isinstance(old, list) else []) + log)[-CONSENT_LOG_MAX:]
            state[ran] = now

        def skipped(item):                      # value_safe_only: an item this run leaves as it is
            return value_safe_only and _one_role(item) not in VALUE_SAFE_ROLES
        try:
            features = _features_of(self.info())
            if 'circulation/1' not in features:
                return report                   # still a run, for the agent layer's rate limit: nothing to do
            data = self.consents()
            items = data.get('consents') if isinstance(data, dict) else None
            if not isinstance(items, list):
                raise ValunError('bad_response', 'GET /consents did not answer {consents: [...]}')
            if any(not skipped(item) for item in items):
                mandate = _mandate_of(self.me())
                run = {'deals': {}, 'edges': None, 'read': False, 'issuer_ids': None}

                def read_back():                # at most one GET /edges per run
                    if not run['read']:
                        run['read'], run['edges'] = True, self._read_back()
                    return run['edges']
            for item in items:
                if skipped(item):
                    report['waiting'].append(self._consent_entry(
                        item, None, code='not_value_safe',
                        reason='a consent in this role is signed or refused only before a tool call that is not read-only'))
                    continue
                try:
                    bucket, entry = self._consent(item, policy, mandate, features, now, run, read_back,
                                                  refuse=not value_safe_only)
                except Exception as e:  # noqa: BLE001 - one item never stops the others, nor the record of the run
                    code = _server_word(e.code) if isinstance(e, ValunError) else 'internal_error'
                    bucket, entry = 'waiting', self._consent_entry(
                        item, None, code=code, error=code,
                        reason=f'this item could not be handled now{_said(code)}; it is handled again on a later run')
                report[bucket].append(entry)
                log.append({'at': _iso(datetime.now(timezone.utc)), 'id': entry['id'], 'kind': entry['kind'],
                            'role': entry['role'], 'decision': bucket, 'code': entry['code'], 'deal_id': entry['deal_id'],
                            'amount': entry['amount'], 'your_net_change_PC': entry['your_net_change_PC']})
            return report
        finally:
            self._settle(logged)

    def _consent(self, item, policy, mandate, features, now, run, read_back, refuse=True):
        """process_consents() for one item: (bucket, entry). refuse False (a value_safe_only run): an item the evaluator
        refuses is not refused at the server; it waits, with the evaluator's code, for a full run."""
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
            return 'waiting', self._consent_entry(item, None, code='bad_consent', reason='a consent item without an id')
        if item.get('state') != 'collecting':
            return 'waiting', self._consent_entry(item, None, reason='the item is not collecting signatures')
        roles = item.get('your_roles')
        role = roles[0] if isinstance(roles, list) and len(roles) == 1 else None
        deal, payee_pk, issuer_ids = None, None, None
        problem = nv.contract_problem(getattr(self, '_novation', None)) if role in ('payer', 'payee') else None
        if problem:                             # tracker v3.2: a prior slot is signed for that contract only (fail closed)
            return 'waiting', self._consent_entry(item, None, code='feature_unavailable',
                                                  reason=problem + '; nothing was signed or refused')
        if role in ('payer', 'payee'):
            try:
                deal, payee_pk = self._consent_deal(item, role, run)
                if role == 'payee':
                    issuer_ids = self._consent_issuer_ids(run)
            except ValunError as e:             # the deal or the directory could not be read now: decide on a later run
                code = _server_word(e.code)
                return 'waiting', self._consent_entry(item, None, code=code, error=code,
                                                      reason=f'could not be read now{_said(code)}; decided on a later run')
        signed_at = _iso(datetime.now(timezone.utc))

        def evaluate(state, edges):
            approved = None
            if role == 'payer' and deal is not None:
                ap = state.get('approved_payments')
                approved = ap.get(deal['deal_id']) if isinstance(ap, dict) else None
            return nv.evaluate_consent(item, self._ctx(
                state, now, features, consent_policy=policy if policy is not None else state.get('consent_policy'),
                mandate=mandate, deal=deal, payee_current_pk=payee_pk, approved_quote_digest=approved, edges=edges,
                issuer_ids=issuer_ids))
        r = self._decide(evaluate, signed_at, edges=run['edges']['edges'] if run['edges'] else None, read_back=read_back)
        if not r['ok'] and not refuse:
            return 'waiting', self._consent_entry(item, r, reason='refused only by a consent run before a tool call that '
                                                                  'is not read-only')
        if not r['ok']:
            try:
                self.refuse_consent(item['id'], r['code'])
            except ValunError as e:
                return 'refused', self._consent_entry(item, r, error=_server_word(e.code))
            return 'refused', self._consent_entry(item, r)
        if not r['to_sign']:
            return 'waiting', self._consent_entry(item, r, reason='you have signed every slot of yours; waiting for the others')
        msgs = nv.slot_messages(r['to_sign'], item['tracker_nft_id'], item['denomination'])
        sigs = {slot: self._sign_message(m) for slot, m in msgs.items()}
        mine = {slot.rsplit(':', 1)[0] for slot in sigs}
        revisions = {e['edge']: e['revision'] for e in item['edges'] if e['edge'] in mine}
        try:
            ans = self.submit_consent(item['id'], sigs, revisions)
        except ValunError as e:
            if e.status is not None and 400 <= e.status < 500:     # refused: the server recorded none of these signatures
                self._settle(lambda state: self._forget_pending(state, r['write_ahead']['pending']))
            code = _server_word(e.code)
            return 'waiting', self._consent_entry(item, r, error=code,
                                                  reason=f'the server did not take the signatures{_said(code)}; tried '
                                                         'again on a later run')
        answer = _server_word(ans.get('state')) if isinstance(ans, dict) else None
        rejected = [{'slot': x['slot'] if isinstance(x.get('slot'), str) and x['slot'] in sigs else None,
                     'code': _server_word(x.get('code')),
                     'revision': x.get('revision') if _nat(x.get('revision')) else None}
                    for x in (ans.get('rejected') if isinstance(ans, dict) and isinstance(ans.get('rejected'), list) else [])
                    if isinstance(x, dict)]
        a = r['write_ahead']['attempt']
        tid = nv.shown_id(item['id'])
        if a is not None and tid:                # a regenerated transfer of my payment: the server's id of this attempt
            self._settle(lambda st: self._note_attempt_id(st, a, tid))
        if answer == 'applied' and a is not None:
            self._settle(lambda st: _guarded(nv.mark_paid, st, a['deal_id'], a['route'], a['edge'], a['total'], a['timestamp']))
        if rejected:
            return 'waiting', self._consent_entry(item, r, code='stale_revision', state=answer, rejected=rejected,
                                                  reason='an edge was regenerated while you signed; it is signed again on a later run')
        return 'signed', self._consent_entry(item, r, state=answer, rejected=[])

    def _consent_deal(self, item, role, run):
        """(deal context, payee's current key) for a payer or payee consent, from the deal it names, read and verified
        here (cached per run); (None, None) when it cannot be checked (the item is then refused: deal_mismatch).
        ValunError when the server cannot be read now."""
        cd = item.get('context').get('deal') if isinstance(item.get('context'), dict) else None
        deal_id = cd.get('deal_id') if isinstance(cd, dict) else None
        if not isinstance(deal_id, str) or not deal_id:
            return None, None
        key = (deal_id, role)
        if key in run['deals']:
            return run['deals'][key]
        out = (None, None)
        try:
            d = self.deal(deal_id)
            if role == 'payer':
                terms, h, dh = self._accepted_delivery(d, deal_id)
                payee = self._registered_key(terms['payee']['id'])
                self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
                out = (nv.deal_context(terms, h, dh), payee)
            else:
                terms = self.verified_agreement(d)
                dv, pay = d.get('delivery'), d.get('payment')
                delivered = (isinstance(dv, dict) and dv.get('by') == self.participant_id and isinstance(dv.get('content'), str)
                             and sha256_hex(dv['content']) == dv.get('sha256'))
                out = (nv.deal_context(terms, terms_hash(terms), dv['sha256'] if delivered else None, delivered=delivered,
                                       transfer_id=pay.get('transfer_id') if isinstance(pay, dict) else None), None)
        except ValunError as e:
            if _transient(e):
                raise
        except (KeyError, TypeError, ValueError, AttributeError):
            pass
        run['deals'][key] = out
        return out

    def _consent_issuer_ids(self, run):
        """{public key: participant id} of the active participants the public directory lists (GET /participants; one
        read per run), each key that exactly one of them holds: the ids a payee's issuer lists are checked against
        (R8), resolved by this client from the issuer's key and never taken from an item. ValunError when the
        directory cannot be read now."""
        if run.get('issuer_ids') is None:
            people = self.directory()
            if not isinstance(people, list):
                raise ValunError('bad_response', 'GET /participants did not answer a list')
            by_key = {}
            for p in people:
                if isinstance(p, dict) and p.get('status', 'active') == 'active' and isinstance(p.get('id'), str) \
                        and p['id'] and _is_pubkey(p.get('pubkey')):
                    by_key.setdefault(p['pubkey'], set()).add(p['id'])
            run['issuer_ids'] = {k: next(iter(v)) for k, v in by_key.items() if len(v) == 1}
        return run['issuer_ids']

    @staticmethod
    def _consent_entry(item, r, **more):
        """One entry of process_consents()'s report (and its consent_log line). What the server wrote is copied only in
        a checked form: ids as novation.shown_id, kind ('transfer' | 'setoff') and role (novation.ROLES) from their
        lists, codes and states as _server_word (the caller passes those already checked); the rest is what the
        evaluator computed (its summary, its code and its reason)."""
        s = (r or {}).get('summary') or {}
        it = item if isinstance(item, dict) else {}
        roles = it.get('your_roles')
        role = s.get('role') if s.get('role') in nv.ROLES else (
            roles[0] if isinstance(roles, list) and len(roles) == 1 and roles[0] in nv.ROLES else None)
        e = {'id': nv.shown_id(it.get('id')), 'kind': it.get('kind') if it.get('kind') in ('transfer', 'setoff') else None,
             'role': role, 'deal_id': nv.shown_id(s.get('deal_id')), 'amount': s.get('amount'),
             'your_net_change_PC': s.get('your_net_change_PC'),
             'your_total_owed_change_PC': s.get('your_total_owed_change_PC'), 'code': (r or {}).get('code'),
             'reason': s.get('reason')}
        e.update(more)
        return e

    @staticmethod
    def _forget_pending(state, pending):
        recs = _records_in(state)
        for p in pending:
            records.remove_pending(recs, p['pair'], p['total'], p['timestamp'], p['ref'])

    # ---------- settlement on Ergo testnet (the Valun testnet network, valun-testnet-1; valun/ergo.py) ----------
    # The agent's Ergo address is the P2PK address of its Valun key: its own key signs its own Ergo transactions, the
    # server never holds it. Signing needs ergo-lib (pip install ergo-lib-python==0.28.0); tERG have no monetary value.
    def _on_testnet(self):
        if self.network != 'valun-testnet-1':
            raise ValunError('not_testnet', 'settlement on Ergo testnet is for the Valun testnet network (valun-testnet-1); '
                                            f'this profile is on {self.network}')
        if not self.pubkey:
            raise ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it')

    def ergo_address(self):
        """This agent's Ergo testnet address (the P2PK address of its Valun key)."""
        from . import ergo
        self._on_testnet()
        return ergo.p2pk_address(self.pubkey)

    def chain(self):
        """GET /chain: the tracker's anchoring on Ergo testnet and the explorer links."""
        return self.request('GET', '/pilot/v1/chain', auth=False)

    def reserves(self):
        """GET /reserves: the Basis reserves the network's tracker sees, with their owners' handles."""
        return self.request('GET', '/pilot/v1/reserves', auth=False)

    @staticmethod
    def _ergo_node(chain, node_url=None):
        from . import ergo
        url = node_url or (chain or {}).get('node')
        if not isinstance(url, str) or not url:
            raise ValunError('not_configured', 'no Ergo testnet node: GET /chain names none; pass node_url')
        return ergo.Node(url)

    def create_reserve(self, erg_amount, broadcast=False, node_url=None):
        """Lock `erg_amount` nanoERG (0.01 to 2 tERG) of this agent's own tERG in a Basis reserve: the tracker builds the
        payment request (POST /reserves/create), this client checks it (ergo.check_reserve_payload), builds and signs the
        transaction from plain boxes at its own address, and with `broadcast` sends it to the Ergo testnet node. Without
        `broadcast` nothing leaves this client (the signed transaction is returned for a look first)."""
        from . import ergo
        self._on_testnet()
        chain = self.chain()
        node = self._ergo_node(chain, node_url)
        r = ergo.build_reserve(secret_hex=self._secret().hex(), pubkey_hex=self.pubkey, erg_amount=erg_amount, node=node,
                               tracker_nft_id=chain.get('tracker_nft_id'), reserve_contract=chain.get('reserve_contract'),
                               payload_for=lambda nft_id: self.request('POST', '/pilot/v1/reserves/create',
                                                                       {'erg_amount': erg_amount, 'nft_id': nft_id}))
        explorer = chain.get('explorer')
        out = {'broadcast': bool(broadcast), 'tx_id': r['tx_id'], 'nft_id': r['nft_id'], 'reserve_box_id': r['reserve_box_id'],
               'locked_nanoerg': r['locked_nanoerg'], 'address': ergo.p2pk_address(self.pubkey),
               'explorer': f"{explorer}/en/transactions/{r['tx_id']}" if explorer else None}
        if not broadcast:
            return {**out, 'signed': r['signed']}
        node.broadcast(r['signed'])
        return out

    def redeem(self, issuer, amount, broadcast=False):
        """Redeem `amount` nanoERG of the note `issuer` (a participant id or handle) issued to this agent, against the
        issuer's reserve: the tracker builds the transaction and pays its fee (POST /redemption/build), this client
        checks it (ergo.check_redemption), adds its own proof for the reserve input, and with `broadcast` submits it
        (POST /redemption/submit). Without `broadcast` nothing is submitted (the tracker's build lapses)."""
        from . import ergo
        self._on_testnet()
        if not isinstance(issuer, str) or not issuer:
            raise ValunError('invalid_field', 'issuer: the participant id or handle of the agent whose note you hold')
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 1:
            raise ValunError('invalid_field', 'amount: whole nanoERG to redeem')
        chain = self.chain()
        node = self._ergo_node(chain)
        node.assert_testnet()
        reserve_tree = ergo.address_to_tree(chain['reserve_contract']) if chain.get('reserve_contract') else None
        built = self.request('POST', '/pilot/v1/redemption/build', {'issuer': issuer, 'amount': amount})
        issuer_pubkey = ((built or {}).get('issuer') or {}).get('pubkey')
        if not isinstance(issuer_pubkey, str):
            raise ValunError('bad_redemption', 'the server named no issuer key')
        # The boxes it spends, as the Ergo node reports them (not the tracker's copies).
        input_boxes = [node.box(i.get('boxId')) for i in ((built or {}).get('unsigned_tx') or {}).get('inputs') or []]
        checked = ergo.check_redemption(built, issuer_pubkey=issuer_pubkey, recipient_pubkey=self.pubkey, amount=amount,
                                        tracker_nft_id=chain.get('tracker_nft_id'), reserve_tree=reserve_tree,
                                        input_boxes=input_boxes)
        signed = ergo.sign_redemption(built, self._secret().hex())
        explorer = chain.get('explorer')
        out = {'broadcast': bool(broadcast), 'tx_id': signed.get('id'), 'issuer': built['issuer'], 'amount': amount,
               'reserve_box_id': checked['reserve_box_id'], 'address': ergo.p2pk_address(self.pubkey),
               'explorer': f"{explorer}/en/transactions/{signed['id']}" if explorer and signed.get('id') else None}
        if not broadcast:
            return {**out, 'signed': signed}
        sub = self.request('POST', '/pilot/v1/redemption/submit', {'signed_tx': signed, 'unsigned_tx': built['unsigned_tx']})
        return {**out, 'tx_id': (sub or {}).get('tx_id') or out['tx_id'], 'explorer': (sub or {}).get('explorer') or out['explorer']}

    # ---------- circulating credit: my edges (PROTOCOL.md 18.14; design 6.1, 11) ----------
    def sync_edges(self, now_ms=None):
        """Bring this client's records up to date from GET /edges?since=<journal_seq> (mode bound and above).

        Every EdgeState shown, the current rows (incoming and outgoing) and the journal entries, is verified as its
        issuer's signature on the pinned tracker and unit (R2); one that does not verify is listed in rejected and
        used for nothing. With what verifies, in journal order and then the current rows: records.sync_edge confirms
        each state (never moving back in time), a pending entry of mine that a state shows is promoted (applied), and
        the deal a payment of mine paid goes into records['paid_deals'] (D-1 item 5), as does the deal of a payment
        attempt whose own state an edge shows; an edge a transfer or set-off changed (bound_only, or a journal entry
        transfer_out / transfer_in / setoff) goes into novated_edges (R12); the 0.3 'issued' record of an outgoing
        edge follows its confirmed total. Then what is past use is pruned (design 11; RECORDS_KEEP_MS = 7 days, so far
        beyond the 1-hour maximum age that a clock error cannot make a pruned entry signable or applicable again):
        R4 records of timestamps older than that, pending bound-note, transfer and set-off entries older than that
        which a current row shows did not apply, and payment attempts older than that which are dead
        (novation.attempt_outcome) or whose deal is recorded as paid; and a confirmed (applied) state keeps its total
        and timestamp but drops its signature SIGNATURES_KEEP_MS (30 days) after its timestamp. Ordinary credit notes
        never expire, so their pending entries are kept until a newer state of their edge is confirmed. journal_seq
        advances to next_seq. Pages of EDGES_PAGE journal entries are read until a shorter one (at most
        EDGES_MAX_PAGES), in one step.

        Returns {edges: {edge: EdgeState} (each verified edge's current state, as the D-1 read-back), applied: [entries
        promoted], paid_deals: [deal ids newly recorded as paid], novated: [edges newly marked], rejected: [{edge, seq,
        reason}], doubtful: [edges listed only with a state that did not verify: not read], pruned: {signed, pending,
        attempts, signatures} (how many R4 records, pending entries and payment attempts were dropped, and how many
        confirmed states dropped their signature), journal_seq}."""
        if not self._pinned():
            self.info()                         # pins an enrolled profile
        pins = _pins_of(self.state)
        if not pins:
            raise ValunError('tracker_mismatch', 'this profile has no pinned tracker and unit yet; nothing was read')
        me = self.pubkey
        if not me:
            raise ValunError('not_connected', 'this agent has no Valun signing key; the operator must enroll it')
        verify = self._note_verifier(pins['tracker_nft_id'], pins['denomination'])
        since = self.state.get('journal_seq')
        cursor = since if _nat(since) else 0
        rows, journal, next_seq = [], [], cursor
        for _page in range(EDGES_MAX_PAGES):
            data = self.request('GET', f'/pilot/v1/edges?since={cursor}')
            if not isinstance(data, dict):
                raise ValunError('bad_response', 'GET /edges did not answer a JSON object')
            page = data.get('journal') if isinstance(data.get('journal'), list) else []
            rows = [x for k in ('incoming', 'outgoing') for x in (data.get(k) if isinstance(data.get(k), list) else [])]
            journal.extend(page)
            nxt = data.get('next_seq')
            next_seq = nxt if _nat(nxt) and nxt >= cursor else cursor
            if len(page) < EDGES_PAGE or next_seq <= cursor:
                break
            cursor = next_seq
        current, rejected, history, doubtful = {}, [], [], set()
        for row in rows:
            got = self._edge_state(row, 'total', verify)
            if isinstance(got, str):
                rejected.append({'edge': row.get('edge') if isinstance(row, dict) else None, 'seq': None, 'reason': got})
                if isinstance(row, dict) and isinstance(row.get('edge'), str):
                    doubtful.add(row['edge'])           # listed, but not readable: no read-back of it this time
                continue
            current[got[0]] = (got[1], isinstance(row, dict) and row.get('bound_only') is True)
        for e in journal:
            got = self._edge_state(e, 'total_after', verify)
            if isinstance(got, str):
                rejected.append({'edge': e.get('edge') if isinstance(e, dict) else None,
                                 'seq': e.get('seq') if isinstance(e, dict) else None, 'reason': got})
                continue
            history.append((e.get('seq') if _nat(e.get('seq')) else 0, got[0], got[1], e.get('kind')))
        history.sort(key=lambda x: x[0])
        now = int(time.time() * 1000) if now_ms is None else now_ms

        def apply(state):
            recs, issued = _records_in(state), _issued_in(state)
            out = {'applied': [], 'paid_deals': [], 'novated': []}
            seen = {}

            def take(edge, st):
                seen.setdefault(edge, set()).add((st['total'], st['timestamp']))
                res = records.sync_edge(recs, dict(st, edge=edge))
                p = res['promoted']
                if p is not None:
                    out['applied'].append({'pair': edge, 'total': p.get('total'), 'timestamp': p.get('timestamp'),
                                           'kind': p.get('kind'), 'ref': p.get('ref'), 'direction': p.get('direction')})
                    route = _paid_route(p)
                    if route and _guarded(nv.mark_paid, state, p['ref'], route, edge, p['total'], p['timestamp']):
                        out['paid_deals'].append(p['ref'])
                if edge.startswith(f'{me}>') and res['confirmed']:
                    issued[edge] = res['confirmed']['total']

            for _seq, edge, st, kind in history:
                take(edge, st)
                if kind in _JOURNAL_NOVATIONS and _mark_novated(state, edge):
                    out['novated'].append(edge)
            for edge, (st, bound_only) in current.items():
                take(edge, st)
                if bound_only and _mark_novated(state, edge) and edge not in out['novated']:
                    out['novated'].append(edge)
            att = state.get('transfer_attempts')
            for deal_id, lst in (att.items() if isinstance(att, dict) else ()):
                for a in lst if isinstance(lst, list) else ():
                    if _attempt_shape(a) and (a['total'], a['timestamp']) in seen.get(a['edge'], ()) \
                            and _guarded(nv.mark_paid, state, deal_id, a['route'], a['edge'], a['total'], a['timestamp']):
                        out['paid_deals'].append(deal_id)
            out['pruned'] = self._prune(state, now, {edge: st for edge, (st, _b) in current.items()}, doubtful)
            state['journal_seq'] = next_seq
            return out
        out = self._update(apply)
        out.update(edges={edge: dict(st) for edge, (st, _b) in current.items()}, rejected=rejected,
                   doubtful=sorted(doubtful - set(current)), journal_seq=next_seq)
        return out

    @staticmethod
    def _edge_state(row, total_key, verify):
        """(edge, EdgeState) of a GET /edges row or journal entry whose issuer's signature verifies, else why not."""
        if not isinstance(row, dict):
            return 'not_an_object'
        i, r = row.get('issuer_pubkey'), row.get('recipient_pubkey')
        edge = row.get('edge')
        keys = nv.parse_edge(edge) if edge is not None else ((i, r) if nv.parse_edge(f'{i}>{r}') else None)
        if keys is None or (i is not None and i != keys[0]) or (r is not None and r != keys[1]):
            return 'bad_edge'
        st = {'total': row.get(total_key), 'timestamp': row.get('timestamp'), 'signature': row.get('signature')}
        if not (_nat(st['total']) and _nat(st['timestamp']) and isinstance(st['signature'], str) and st['signature']):
            return 'bad_state'
        if not verify(keys[0], keys[1], st['total'], st['timestamp'], st['signature']):
            return 'bad_signature'
        return nv.edge_key(*keys), st

    @staticmethod
    def _prune(state, now_ms, current, doubtful=()):
        """Drop what can no longer matter (design 11), RECORDS_KEEP_MS after it: see sync_edges(). `current` holds the
        verified current state of each edge just read; an edge it does not list, that is not in `doubtful` (listed with a
        state that did not verify) and that my records hold no state of does not exist (but is no read-back for an
        attempt that acknowledged a prior above 0 on it: that edge existed). A confirmed (applied) state keeps its
        total and timestamp, and drops its signature SIGNATURES_KEEP_MS (30 days) after its timestamp. Returns {signed,
        pending, attempts, signatures}: how many entries (signatures) were dropped."""
        horizon = now_ms - RECORDS_KEEP_MS
        n = {'signed': 0, 'pending': 0, 'attempts': 0, 'signatures': 0}
        signed = state.get('signed')
        if isinstance(signed, dict):
            for edge in list(signed):
                per = signed[edge]
                if not isinstance(per, dict):
                    continue
                for ts in list(per):
                    if isinstance(ts, str) and ts.isdigit() and int(ts) < horizon:
                        del per[ts]
                        n['signed'] += 1
                if not per:
                    del signed[edge]
        recs = state.get('records') if isinstance(state.get('records'), dict) else {}

        def read_back(edge):                    # the edge's current state as just read, or None when there is no read-back
            conf = records.get(recs, edge)['confirmed']
            st = current.get(edge)
            if st is None:
                return None if conf is not None or edge in doubtful else {'total': 0, 'timestamp': 0}
            if isinstance(conf, dict) and _nat(conf.get('timestamp')) and conf['timestamp'] > st['timestamp']:
                return None                     # older than what I already know: a stale read
            return st
        for pair, e in list(recs.items()):
            if pair == nv.PAID_DEALS_KEY or not isinstance(e, dict) or not isinstance(e.get('pending'), list):
                continue
            st = read_back(pair)
            if st is None:
                continue
            keep = [p for p in e['pending'] if not (isinstance(p, dict) and _nat(p.get('timestamp'))
                                                    and p['timestamp'] % 1000 in _EXPIRING_MS and p['timestamp'] < horizon
                                                    and p['timestamp'] > st['timestamp'])]
            n['pending'] += len(e['pending']) - len(keep)
            e['pending'] = keep
        sig_horizon = now_ms - SIGNATURES_KEEP_MS
        for pair, e in recs.items():
            conf = e.get('confirmed') if pair != nv.PAID_DEALS_KEY and isinstance(e, dict) else None
            if isinstance(conf, dict) and _nat(conf.get('timestamp')) and conf['timestamp'] < sig_horizon \
                    and 'signature' in conf:
                del conf['signature']           # applied long ago: its total and timestamp are what is still used
                n['signatures'] += 1
        paid = recs.get(nv.PAID_DEALS_KEY) if isinstance(recs.get(nv.PAID_DEALS_KEY), dict) else {}
        att = state.get('transfer_attempts')

        def done(deal_id, a):
            if not (_attempt_shape(a) and a['timestamp'] < horizon):
                return False                    # a malformed attempt is kept: the evaluators refuse it (R9)
            if deal_id in paid:
                return True
            st = read_back(a['edge'])
            if st is None or ('signature' not in st and a['prior'] > 0):
                return False                    # not read, or absent although the attempt acknowledged a prior above 0
            conf = records.get(recs, a['edge'])['confirmed']
            floor = max(conf['timestamp'] if isinstance(conf, dict) and _nat(conf.get('timestamp')) else 0,
                        a['prior_timestamp'] if _nat(a.get('prior_timestamp')) else 0)
            return st['timestamp'] >= floor and nv.attempt_outcome(a, now_ms, st) == 'dead'
        for deal_id in list(att) if isinstance(att, dict) else ():
            lst = att[deal_id]
            if not isinstance(lst, list):
                continue
            keep = [a for a in lst if not done(deal_id, a)]
            n['attempts'] += len(lst) - len(keep)
            if keep:
                att[deal_id] = keep
            else:
                del att[deal_id]
        return n
