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
import secrets
import stat
import time
import time as _systime          # the store's lock and retries: never the `time` a test or replay harness replaces
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from . import basis as vb
from . import novation as nv
from . import records

NETWORK = 'valun-pilot-1'
PROTOCOL = 'valun-deal/1'
PILOT_TOKEN_ID = hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
UNIT = 'PC'
# Optional state keys a store keeps for this client (every store must keep them; all may be absent):
#   issued    {pair: confirmed total} of this client's outgoing edges (the 0.3 record, kept equal to records' confirmed)
#   records   per-edge confirmed state and pending entries (records.py), and records['paid_deals'] {deal_id: {route,
#             edge, total, timestamp}}: deals a confirmed payment paid, never paid again (decision D-1 item 5)
#   pins      {tracker_nft_id, denomination} (R13)
#   circulation (novation.py): signed (R4) {edge: {str(ts): {op, slots}}}; novated_edges {edge: true} (R12);
#             transfer_attempts {deal_id: [attempt]} (D-1); approved_payments {deal_id: quote_digest} (the quote a
#             payment by transfer was signed with); consent_policy {setoff, as_issuer, as_new_creditor, max_PC,
#             accept_issuers, refuse_issuers} (absent: every role off); consent_loop (for the agent layer);
#             consents_last_run_ms and consent_log (the last CONSENT_LOG_MAX decisions of process_consents());
#             journal_seq (the GET /edges journal position sync_edges() has read up to).
CORE_STATE_KEYS = ('issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments', 'consent_policy',
                   'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq')
# Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them.
RESERVED_MS_FROM = 995
# Circulating credit (PROTOCOL.md 18; design 4.1, 6.3, 6.6, 11).
FEATURES_HEADER = 'X-Valun-Features'          # 'consents/1;roles=<roles>', sent once /info lists circulation/1
CONSENT_ROLES = (('setoff', 'setoff'), ('as_issuer', 'issuer'), ('as_new_creditor', 'creditor'))   # (policy flag, header role)
CONSENT_LOG_MAX = 100                         # process_consents() keeps the last 100 decisions in consent_log
RECORDS_KEEP_MS = 7 * 24 * 3600 * 1000        # what did not apply is dropped after 7 days (design 11)
EDGES_PAGE = 200                              # GET /edges answers at most this many journal entries at a time
EDGES_MAX_PAGES = 50                          # sync_edges() reads at most this many pages per call
_JOURNAL_NOVATIONS = ('transfer_out', 'transfer_in', 'setoff')     # journal kinds that make an edge bound-only
# Residues of what stops being usable after novation.MAX_AGE_MS: bound notes, set-offs, transfers (novation.BOUND_MS,
# SETOFF_MS, TRANSFER_MS; written out because novation.py imports this module, so nv is not complete at import time).
_EXPIRING_MS = (997, 998, 999)


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


def statement(kind, *parts) -> str:
    return '\n'.join([f'valun-pilot/{kind}/1', *parts])


def _iso(dt) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


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


def _nat(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _seg(v):
    """A server-chosen id as one URL path segment (or query value)."""
    return urllib.parse.quote(str(v), safe='')


def _transient(e):
    """A failure to reach or be served by the server, not an answer about the request itself: try again later."""
    return e.code == 'unreachable' or (e.status is not None and (e.status >= 500 or e.status == 429))


def _guarded(fn, *args):
    """A novation.py records helper; its ValueError (a record that is not of its shape) is records_unreadable (R9)."""
    try:
        return fn(*args)
    except ValueError:
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
    .save() and .save_credentials(secret_hex, token)."""

    def __init__(self, store, server=None, timeout=30):
        self.store = FileStore(store) if isinstance(store, (str, os.PathLike)) else store
        self.state = self.store.state
        self.timeout = timeout
        self._server = server.rstrip('/') if server else None    # kept apart: a reloaded profile never redirects requests
        if self._server:
            self.state['server'] = self._server
        self._advertised = []                   # the features the last GET /info listed (for the capability header)

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
                return json.loads(r.read().decode('utf-8') or 'null')
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
    def join(self, invite, handle, operator, display_name='', about='', services=''):
        """Create a participant. Returns the owner token and enrollment code: both are for the HUMAN operator."""
        return self.request('POST', '/pilot/v1/join', {'invite': invite, 'handle': handle, 'display_name': display_name,
                                                       'operator': operator, 'about': about, 'services': services}, auth=False)

    def join_sandbox(self, handle, operator, display_name='', about=''):
        """Create a sandbox-only participant without an invite (where the server offers it): it can deal only with the
        server's sandbox agents, within small limits, for a week. Returns the owner token and enrollment code: both are
        for the HUMAN operator."""
        return self.request('POST', '/pilot/v1/join-sandbox', {'handle': handle, 'operator': operator,
                                                               'display_name': display_name, 'about': about}, auth=False)

    def enroll(self, participant_id, code):
        """Generate this agent's key locally and register its public key with a proof-of-possession signature."""
        if self.connected:
            raise ValunError('already_connected', 'this client already holds an enrolled key')
        secret = vb.generate_secret()
        pk = vb.public_key(secret).hex()
        sig = vb.sign(statement('enroll', NETWORK, participant_id, pk, sha256_hex(code)).encode('utf-8'), secret, bytes.fromhex(pk)).hex()
        r = self.request('POST', '/pilot/v1/enroll', {'participant_id': participant_id, 'code': code, 'pubkey': pk, 'signature': sig}, auth=False)
        self.state.update({'participant_id': participant_id, 'pubkey': pk, 'network': r['network'],
                           'enrolled_at': _iso(datetime.now(timezone.utc)), 'issued': self.state.get('issued', {})})
        self.store.save_credentials(secret.hex(), r['agent_token'])
        self._save()
        return {'participant_id': participant_id, 'pubkey': pk, 'network': r['network']}

    # ---------- reads ----------
    def info(self):
        """The network's public description. Its tracker and unit are pinned in an enrolled profile the first time they
        are read (at enroll, or on the first call after an upgrade); a later answer naming others is refused. The
        features it lists decide whether later requests carry the capability header (features_header)."""
        r = self.request('GET', '/pilot/v1/info', auth=False)
        self._pin(r)
        self._advertised = _features_of(r) if isinstance(r, dict) else []
        return r

    def features_header(self):
        """The X-Valun-Features value this client sends with its requests (PROTOCOL.md 18.1; design 4.1):
        'consents/1;roles=<roles>', the consent roles its local consent_policy signs by itself (consent_roles), once
        the server's GET /info has listed circulation/1. None when it has not, or when no role is on."""
        if 'circulation/1' not in getattr(self, '_advertised', ()):
            return None
        roles = consent_roles(self.state.get('consent_policy'))
        return f"consents/1;roles={','.join(roles)}" if roles else None

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
        if t['network'] != NETWORK or t['protocol'] != PROTOCOL:
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
                    offer_ttl_hours=24, deal_id=None, version=1, prior=None):
        if role not in ('payer', 'payee'):
            raise ValunError('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)')
        info = self.info()
        other = {'id': counterparty_id, 'pubkey': self._registered_key(counterparty_id)}
        me = {'id': self.participant_id, 'pubkey': self.pubkey}
        now = datetime.now(timezone.utc)
        return {'protocol': PROTOCOL, 'network': NETWORK, 'tracker_nft_id': info['tracker_nft_id'], 'denomination': info['denomination'],
                'deal_id': deal_id or ('vd_' + secrets.token_hex(8)), 'version': version, 'prior_terms_hash': prior,
                'nonce': secrets.token_hex(16), 'proposer': self.participant_id,
                'payer': me if role == 'payer' else other, 'payee': other if role == 'payer' else me,
                'service': {'title': title, 'description': description, 'deliverable': deliverable},
                'price': {'amount': int(price), 'unit': UNIT}, 'consideration': 'credit_note_on_delivery_accepted',
                'deliver_by': _iso(now + timedelta(hours=deliver_by_hours)), 'offer_expires_at': _iso(now + timedelta(hours=offer_ttl_hours))}

    def propose(self, counterparty_id, role, title, description, deliverable, price, deliver_by_hours=48, offer_ttl_hours=24):
        t = self.build_terms(counterparty_id, role, title, description, deliverable, price, deliver_by_hours, offer_ttl_hours)
        h = terms_hash(t)
        return self.request('POST', '/pilot/v1/deals', {'terms': t, 'terms_hash': h, 'signature': self._sign(statement('propose', h))})

    def counter(self, deal_id, price=None, title=None, description=None, deliverable=None, deliver_by_hours=None, offer_ttl_hours=24,
                expected_terms_hash=None):
        """Sign a counter-offer: the given changes, the rest copied from the current offer. With expected_terms_hash
        (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current offer is another.
        The new version follows the version inside the verified (hashed) terms, not the server's view of the deal."""
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
                             due_h, offer_ttl_hours, deal_id=deal_id, version=t0['version'] + 1, prior=chk['terms_hash'])
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
        confirmed state of the edge is refused as well (ledger_mismatch). The note M(I,R,P+price,ts) and its prior
        acknowledgment M(I,R,P,ts) are built and signed here and sent as credit_note {total, timestamp, signature,
        prior_total, prior_signature}, after the R4 record, the payment attempt and the pending entry are saved.

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
                        f"the server shows an older prior credit note to this payee ({shown['total']} PC at {shown['timestamp']}) "
                        f"than your own record ({mine['total']} PC at {mine['timestamp']}). Ask your operator."))
            return None
        r = self._decide(lambda state, edges: nv.evaluate_bound_template(tpl, self._ctx(
            state, now_ms, features, deal=deal, payee_current_pk=payee, edges=edges)), signed_at, refuse=older_prior)
        if not r['ok']:
            raise _refusal_error(r)
        msgs = nv.slot_messages(r['to_sign'], tpl['tracker_nft_id'], tpl['denomination'])
        note = {'total': tpl['total'], 'timestamp': tpl['timestamp'], 'signature': self._sign_message(msgs[nv.slot_key(pair, 'new')])}
        body = {'terms_hash': h, 'deliverable_sha256': dh, 'signature': self._sign(statement('complete', h, dh)),
                'credit_note': dict(note, prior_total=tpl['prior_total'],
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
        ctx = {'me_pk': self.pubkey, 'me_id': self.participant_id, 'now_ms': now_ms, 'verify': _verify_hex,
               'pins': _pins_of(state), 'records': state.get('records'), 'signed': state.get('signed'),
               'transfer_attempts': state.get('transfer_attempts'), 'novated_edges': state.get('novated_edges'),
               'features': list(features), 'consent_policy': state.get('consent_policy')}
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
            raise ValunError('ledger_mismatch', f"the server says you have issued this payee {tpl['prior_total']} PC of credit notes so far; your own record says {known}. Ask your operator.")
        for p in self._pending_notes(pair, deal_id):
            # Still pending, so neither its deal nor the edge shows its outcome. If the edge has reached its total, it may
            # have applied (an owner approved it after this client signed): paying the deal again could pay it twice.
            if isinstance(p.get('total'), int) and not isinstance(p['total'], bool) and tpl['prior_total'] >= p['total']:
                raise ValunError('already_paid', (f"your earlier credit note for this deal ({p['total']} PC in total to this payee) may "
                                                  f"already be on the tracker: the edge's total is {tpl['prior_total']} PC now. Refusing "
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
            self._refuse_paid_again(deal_id, [p for _st, p in found])

    @staticmethod
    def _refuse_paid_again(deal_id, applied):
        """A note of mine that applied paid its own deal: never sign a second payment for it, whatever the server says."""
        for p in applied:
            if p.get('kind') == 'note' and p.get('ref') == deal_id:
                raise ValunError('already_paid', (f"your credit note for this deal ({p.get('total')} PC) is already on the tracker, so "
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
        the payee's signature on the delivery; the server lists circulation/1 (feature_unavailable); the template is for
        the issuer chosen, under that participant's current key (bad_template); novation.evaluate_payer_template
        (15.3 R1-R13, and decision D-1: one live payment attempt per deal across notes and transfers, with one GET
        /edges read-back when an earlier attempt's edge must be read). With expected_quote_digest (the quote the owner
        approved) another quote is stale_quote; with expected_claim_total (my claim on A that the owner saw) another
        prior total of A->me is stale_claim.

        Saved before anything is sent (R9): the R4 record of the three slots, the payment attempt (transfer_attempts),
        the pending decrease of my claim on A (records) and approved_payments[deal_id] = the quote digest. Then it signs
        the complete statement (an unconditional acceptance of the delivery), the pay statement and the slots
        '<A>><me>:prior', '<A>><me>:new' and '<A>><C>:new', and posts them. A 409 transfer_stale is retried once with a
        fresh template under the same quote digest (D-1 lets it sign at once only while my claim on A is unchanged).
        paid_by_transfer records the deal as paid; a refusal, or payment_due, forgets the pending entry, and the
        attempt stays until it is dead. Returns the deal view."""
        self._secret()
        d = self.deal(deal_id)
        terms, h, dh = self._accepted_delivery(d, deal_id, expected_deliverable_sha256)
        payee = self._registered_key(terms['payee']['id'])
        self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
        features = self._circulation()
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
                if e.status is not None and 400 <= e.status < 500:     # refused: the server recorded none of it
                    self._settle(forget)
                    if e.code == 'transfer_stale' and not retry:
                        fresh = (e.extra or {}).get('template')
                        tpl = fresh if isinstance(fresh, dict) else self.transfer_template(deal_id, issuer_id)
                        approved = approved or r['summary']['quote_digest']
                        continue
                raise                           # otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
            status = view.get('status') if isinstance(view, dict) else None
            if status == 'paid_by_transfer':
                self._settle(lambda state, a=a: _guarded(nv.mark_paid, state, a['deal_id'], 'transfer', a['edge'], a['total'],
                                                         a['timestamp']))
            elif status == 'payment_due':
                self._settle(forget)
            return view

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
                return _refused(r, 'stale_claim', f'your claim on this issuer is {held} PC now, not the {claim} PC you reviewed; '
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
        to_before = tpl['to_edge'].get('before')
        msgs = nv.slot_messages(r['to_sign'], tpl['tracker_nft_id'], tpl['denomination'])
        body = {'issuer_id': issuer_id, 'terms_hash': deal['terms_hash'], 'deliverable_sha256': deal['deliverable_sha256'],
                'quote_digest': q, 'timestamp': tpl['timestamp'], 'from_prior_total': tpl['from_edge']['before']['total'],
                'to_prior_total': to_before['total'] if to_before is not None else 0,
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

    def process_consents(self, policy=None, now_ms=None):
        """Sign by itself the consents its owner's policy allows, and refuse the others (PROTOCOL.md 15.3, 18.9; design
        6.6). Deterministic; no rate limit here (the agent layer runs it at most once per 60 s).

        `policy` is the local consent policy ({setoff, as_issuer, as_new_creditor, max_PC, accept_issuers,
        refuse_issuers}); None takes the profile's consent_policy, and an absent policy signs nothing. The owner's side
        is the mandate GET /me shows (effective_limits); the stricter of the two applies (R8). Nothing more is read or
        sent unless GET /info lists circulation/1 (the run is still recorded in consents_last_run_ms).

        Each item of GET /consents is checked by novation.evaluate_consent for the one role it gives this client (payer:
        a regenerated transfer of my own payment, re-signed only under the quote my payment was signed with; issuer;
        payee: the deal is read and verified here, delivered by me and paid by this transfer; member: a set-off). An
        item it allows is written ahead (R9), signed (the 80-byte messages rebuilt here, R1) and posted with each
        edge's revision; an item it refuses is refused at the server with the refusal code as its reason; a
        transfer_window_open that needs a read-back is decided again after one GET /edges per run. Items that are not
        collecting, that have nothing left for me to sign, whose deal could not be read now, whose posting failed, or
        whose signatures came back as stale revisions wait for a later run.

        Returns {signed: [entry], refused: [entry], waiting: [entry]}, entry = {id, kind, role, deal_id, amount,
        your_net_change_PC, your_total_owed_change_PC, code, reason} (signed entries add state and rejected; an entry
        whose request failed adds error). Each decision is appended to consent_log (the last CONSENT_LOG_MAX), and
        consents_last_run_ms is set to now_ms."""
        self._secret()
        report = {'signed': [], 'refused': [], 'waiting': []}
        now = int(time.time() * 1000) if now_ms is None else now_ms
        log = []

        def logged(state):
            old = state.get('consent_log')
            state['consent_log'] = ((old if isinstance(old, list) else []) + log)[-CONSENT_LOG_MAX:]
            state['consents_last_run_ms'] = now
        features = _features_of(self.info())
        if 'circulation/1' not in features:
            self._settle(logged)                # a run, for the agent layer's rate limit: there was nothing to do
            return report
        data = self.consents()
        items = data.get('consents') if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ValunError('bad_response', 'GET /consents did not answer {consents: [...]}')
        if items:
            mandate = _mandate_of(self.me())
            run = {'deals': {}, 'edges': None, 'read': False}

            def read_back():                    # at most one GET /edges per run
                if not run['read']:
                    run['read'], run['edges'] = True, self._read_back()
                return run['edges']
            for item in items:
                bucket, entry = self._consent(item, policy, mandate, features, now, run, read_back)
                report[bucket].append(entry)
                log.append({'at': _iso(datetime.now(timezone.utc)), 'id': entry['id'], 'kind': entry['kind'],
                            'role': entry['role'], 'decision': bucket, 'code': entry['code'], 'deal_id': entry['deal_id'],
                            'amount': entry['amount'], 'your_net_change_PC': entry['your_net_change_PC']})
        self._settle(logged)
        return report

    def _consent(self, item, policy, mandate, features, now, run, read_back):
        """process_consents() for one item: (bucket, entry)."""
        if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
            return 'waiting', self._consent_entry(item, None, code='bad_consent', reason='a consent item without an id')
        if item.get('state') != 'collecting':
            return 'waiting', self._consent_entry(item, None, reason=f"the item is {str(item.get('state'))[:32]}, not collecting signatures")
        roles = item.get('your_roles')
        role = roles[0] if isinstance(roles, list) and len(roles) == 1 else None
        deal, payee_pk = None, None
        if role in ('payer', 'payee'):
            try:
                deal, payee_pk = self._consent_deal(item, role, run)
            except ValunError as e:             # the deal could not be read now: decide on a later run
                return 'waiting', self._consent_entry(item, None, code=e.code, reason=str(e), error=e.code)
        signed_at = _iso(datetime.now(timezone.utc))

        def evaluate(state, edges):
            approved = None
            if role == 'payer' and deal is not None:
                ap = state.get('approved_payments')
                approved = ap.get(deal['deal_id']) if isinstance(ap, dict) else None
            return nv.evaluate_consent(item, self._ctx(
                state, now, features, consent_policy=policy if policy is not None else state.get('consent_policy'),
                mandate=mandate, deal=deal, payee_current_pk=payee_pk, approved_quote_digest=approved, edges=edges))
        r = self._decide(evaluate, signed_at, edges=run['edges']['edges'] if run['edges'] else None, read_back=read_back)
        if not r['ok']:
            try:
                self.refuse_consent(item['id'], r['code'])
            except ValunError as e:
                return 'refused', self._consent_entry(item, r, error=e.code)
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
            return 'waiting', self._consent_entry(item, r, error=e.code, reason=str(e))
        answer = ans.get('state') if isinstance(ans, dict) else None
        rejected = ans.get('rejected') if isinstance(ans, dict) and isinstance(ans.get('rejected'), list) else []
        a = r['write_ahead']['attempt']
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

    @staticmethod
    def _consent_entry(item, r, **more):
        s = (r or {}).get('summary') or {}
        it = item if isinstance(item, dict) else {}
        roles = it.get('your_roles')
        e = {'id': it.get('id') if isinstance(it.get('id'), str) else None, 'kind': it.get('kind') if isinstance(it.get('kind'), str) else None,
             'role': s.get('role') or (roles[0] if isinstance(roles, list) and len(roles) == 1 and isinstance(roles[0], str) else None),
             'deal_id': s.get('deal_id'), 'amount': s.get('amount'), 'your_net_change_PC': s.get('your_net_change_PC'),
             'your_total_owed_change_PC': s.get('your_total_owed_change_PC'), 'code': (r or {}).get('code'),
             'reason': s.get('reason')}
        e.update(more)
        return e

    @staticmethod
    def _forget_pending(state, pending):
        recs = _records_in(state)
        for p in pending:
            records.remove_pending(recs, p['pair'], p['total'], p['timestamp'], p['ref'])

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
        (novation.attempt_outcome) or whose deal is recorded as paid. Ordinary credit notes never expire, so their
        pending entries are kept until a newer state of their edge is confirmed. journal_seq advances to next_seq.
        Pages of EDGES_PAGE journal entries are read until a shorter one (at most EDGES_MAX_PAGES), in one step.

        Returns {edges: {edge: EdgeState} (each verified edge's current state, as the D-1 read-back), applied: [entries
        promoted], paid_deals: [deal ids newly recorded as paid], novated: [edges newly marked], rejected: [{edge, seq,
        reason}], doubtful: [edges listed only with a state that did not verify: not read], pruned: {signed, pending,
        attempts}, journal_seq}."""
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
        state that did not verify) and that my records hold no state of does not exist. Returns {signed, pending,
        attempts}: how many entries were dropped."""
        horizon = now_ms - RECORDS_KEEP_MS
        n = {'signed': 0, 'pending': 0, 'attempts': 0}
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
        paid = recs.get(nv.PAID_DEALS_KEY) if isinstance(recs.get(nv.PAID_DEALS_KEY), dict) else {}
        att = state.get('transfer_attempts')

        def done(deal_id, a):
            if not (_attempt_shape(a) and a['timestamp'] < horizon):
                return False                    # a malformed attempt is kept: the evaluators refuse it (R9)
            if deal_id in paid:
                return True
            st = read_back(a['edge'])
            if st is None:
                return False
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
