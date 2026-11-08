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
import urllib.request
from datetime import datetime, timedelta, timezone

from . import basis as vb
from . import records

NETWORK = 'valun-pilot-1'
PROTOCOL = 'valun-deal/1'
PILOT_TOKEN_ID = hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
UNIT = 'PC'
# Optional state keys a store keeps for this client (every store must keep them; all may be absent):
#   issued    {pair: confirmed total} of this client's outgoing edges (the 0.3 record, kept equal to records' confirmed)
#   records   per-edge confirmed state and pending entries (records.py); pins {tracker_nft_id, denomination} (R13);
#   the others belong to circulation (signed, novated_edges, transfer_attempts, approved_payments, consents, journal).
CORE_STATE_KEYS = ('issued', 'records', 'signed', 'novated_edges', 'transfer_attempts', 'approved_payments', 'consent_policy',
                   'consent_loop', 'consents_last_run_ms', 'consent_log', 'pins', 'journal_seq')
# Timestamp residues (ts mod 1000) the v3 tracker keeps for other operations: an ordinary note never uses them.
RESERVED_MS_FROM = 995


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
        are read (at enroll, or on the first call after an upgrade); a later answer naming others is refused."""
        r = self.request('GET', '/pilot/v1/info', auth=False)
        self._pin(r)
        return r

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
        profile not pinned yet is served exactly as by 0.3 (no extra request): it is pinned by its first call."""
        if not self._pinned():
            return []
        raw = self.info().get('features')
        if raw is None:
            return []
        if isinstance(raw, list) and all(isinstance(f, str) for f in raw):
            return list(raw)
        return ['?']        # malformed: features count as advertised (the residue rule applies) and none is recognised

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
        (the hash of the offer the owner or agent inspected), refuses (stale_terms) if the current offer is another."""
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
                             due_h, offer_ttl_hours, deal_id=deal_id, version=d['current']['version'] + 1, prior=chk['terms_hash'])
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
        """Accept the delivery and pay: sign the Basis note for prior + price, after checking the template independently.

        Checked before signing: the content matches its hash (and the one the caller reviewed); the agreement's hash (and
        the one the caller reviewed) and both signatures; the payee's signature on the delivery; the template names this
        agent's key and the payee's current key, adds exactly the agreed price, names the agreed (and pinned) tracker and
        unit, and is current. The prior total must be one this client can stand behind: a prior note it signed itself and
        not older than its own records (when the server offers bound_notes/1), otherwise its own record of the confirmed
        total (ledger_mismatch). A pending note of its own that its deal or the prior note shows applied is confirmed on
        the way. A note of its own for THIS deal is never paid again while its records still hold it as pending and it
        may have applied: its deal or the prior note shows it applied, or the edge's total has reached that note's total
        (already_paid). Once a note is confirmed the records keep only the edge's total, not which deal it paid; the
        server's deal status covers a deal paid before. The note is recorded as pending before it is sent, and confirmed
        only when the server answers note_issued: an owner can still reject a held note (OQ-23)."""
        d = self.deal(deal_id)
        if not d.get('delivery') or not d.get('agreement'):
            raise ValunError('not_delivered', 'nothing has been delivered on this deal')
        dh = d['delivery']['sha256']
        if sha256_hex(d['delivery']['content']) != dh:
            raise ValunError('hash_mismatch', 'the delivered content does not match its hash')
        if expected_deliverable_sha256 and expected_deliverable_sha256 != dh:
            raise ValunError('stale_delivery', 'the delivery changed since you reviewed it')
        terms = self.verified_agreement(d)
        h = terms_hash(terms)
        if expected_terms_hash and expected_terms_hash != h:
            raise ValunError('stale_terms', 'the agreed terms are not the ones you reviewed; refusing to accept the delivery')
        # A pinned (0.4) profile reads /info: a server offering bound_notes/1 shows the prior note (?prior=1), and with
        # any feature the tracker keeps the timestamp residues 995-999 for other operations. Otherwise exactly as 0.3.
        features = self._features()
        with_prior = 'bound_notes/1' in features
        tpl = self.request('GET', f'/pilot/v1/deals/{deal_id}/credit-note-template' + ('?prior=1' if with_prior else ''))
        # The note is between the parties' CURRENT keys (an owner may have replaced an agent key after the deal was
        # agreed): it must be signed by this agent's key and credit the payee's key as the directory lists it now.
        payee = self._registered_key(terms['payee']['id'])
        if tpl['issuer_pubkey'] != self.pubkey or tpl['recipient_pubkey'] != payee:
            raise ValunError('bad_template', 'credit-note template names the wrong parties')
        if tpl['price'] != terms['price']['amount'] or tpl['total'] != tpl['prior_total'] + terms['price']['amount']:
            raise ValunError('bad_template', 'credit-note template does not add exactly the agreed price')
        self.check_delivery_signature(d['delivery'], h, terms['payee']['pubkey'], payee)
        pair = f'{self.pubkey}>{payee}'
        verify = self._note_verifier(terms['tracker_nft_id'], terms['denomination'])
        self._reload()
        self._check_records(pair, tpl, tpl.get('prior_note') if with_prior else None, payee, verify, deal_id, d)
        if tpl['tracker_nft_id'] != terms['tracker_nft_id'] or tpl['denomination'] != terms['denomination']:
            raise ValunError('bad_template', 'credit-note template names a different tracker or unit')
        self._check_pins(tpl['tracker_nft_id'], tpl['denomination'])
        if abs(tpl['timestamp'] - int(time.time() * 1000)) > 10 * 60_000:
            raise ValunError('bad_template', 'credit-note template timestamp is not current')
        if features and tpl['timestamp'] % 1000 >= RESERVED_MS_FROM:
            raise ValunError('bad_template', (f"credit-note template timestamp {tpl['timestamp']} ends in {tpl['timestamp'] % 1000}: "
                                              'the tracker keeps residues 995-999 for other operations; refusing to sign it as a credit note'))
        msg = vb.note_message(bytes.fromhex(self.pubkey), bytes.fromhex(payee), tpl['total'], tpl['timestamp'],
                              bytes.fromhex(tpl['tracker_nft_id']), tpl['denomination'])
        body = {'terms_hash': h, 'deliverable_sha256': dh, 'signature': self._sign(statement('complete', h, dh)),
                'credit_note': {'total': tpl['total'], 'timestamp': tpl['timestamp'], 'signature': vb.sign(msg, self._secret(), bytes.fromhex(self.pubkey)).hex()}}
        note = dict(body['credit_note'])
        signed_at = _iso(datetime.now(timezone.utc))

        def ahead(state):                       # written before the note is sent: its outcome is not known yet
            err = _pin_problem(_pins_of(state), tpl['tracker_nft_id'], tpl['denomination'])
            if err:
                raise err
            if not _pins_of(state):             # the first call after an upgrade pins the agreed tracker and unit
                state['pins'] = {'tracker_nft_id': tpl['tracker_nft_id'], 'denomination': tpl['denomination']}
            records.add_pending(_records_in(state), pair, note['total'], note['timestamp'], 'note', deal_id, 'out', signed_at)
        self._update(ahead)

        def forget(state):
            records.remove_pending(_records_in(state), pair, note['total'], note['timestamp'], deal_id)
        try:
            r = self.request('POST', f'/pilot/v1/deals/{deal_id}/complete', body)
        except ValunError as e:
            if e.status is not None and 400 <= e.status < 500:     # refused: this note can never apply
                self._settle(forget)
            raise                               # otherwise (unreachable, 5xx) the outcome is unknown: it stays pending
        status = r.get('status') if isinstance(r, dict) else None
        if status == 'note_issued':
            self._settle(lambda state: self._confirm_in(state, pair, note))
        elif status not in ('completion_awaiting_owner', 'issuing_note'):
            self._settle(forget)                # e.g. note_failed: the tracker does not hold it
        return r

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

    def _check_records(self, pair, tpl, prior, payee, verify, deal_id, d):
        """The template's prior must be one I can stand behind, and this deal must not be one my records may show paid.
        With a prior note (a server offering bound_notes/1) it must be the template's prior, signed by me and not older
        than my records; without one, the prior total must equal my record of the confirmed total, when I have one.
        First, a held or issuing note of mine that its deal now records as issued is confirmed (owner approvals happen
        after this client signed): when the totals disagree, and whenever a note of mine for this deal is pending."""
        if prior is not None and (not isinstance(prior, dict) or prior.get('total') != tpl['prior_total']):
            raise ValunError('bad_template', "the credit-note template's prior note does not match its prior total")
        known = self._known_total(pair)
        if self._pending_notes(pair, deal_id) or (prior is None and known is not None and known != tpl['prior_total']):
            self._confirm_issued(pair, payee, verify, deal_id, d)
        if prior is not None:
            self._check_prior(pair, prior, tpl, verify, deal_id)
        else:
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
        """Confirm my pending notes on this edge that their deals record as issued (with the note's own signature)."""
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
            self._update(lambda state: self._confirm_in(state, pair, latest))
            self._refuse_paid_again(deal_id, [p for _st, p in found])

    def _check_prior(self, pair, prior, tpl, verify, deal_id):
        """With a prior note (a 0.4 server): signed by me, and not older than my records. If it is one of my pending
        notes, that note applied: it is confirmed, and its own deal is never paid again."""
        mine = _records_in(self.state, create=False)
        problem = records.prior_problem(mine, pair, prior, self.pubkey, verify)
        if problem == 'bad_prior_signature':
            raise ValunError('bad_prior_signature', "the server's prior credit note to this payee is not signed by your key; refusing to sign a new one")
        if problem:
            mine = records.get(mine, pair)['confirmed'] or {}
            raise ValunError('ledger_mismatch', (f"the server shows an older prior credit note to this payee ({prior['total']} PC at "
                                                 f"{prior['timestamp']}) than your own record ({mine.get('total')} PC at {mine.get('timestamp')}). "
                                                 'Ask your operator.'))
        applied = [p for p in records.get(mine, pair)['pending']
                   if isinstance(p, dict) and (p.get('total'), p.get('timestamp')) == (prior['total'], prior['timestamp'])]
        if applied:
            edge = records.edge_state(prior)
            self._update(lambda state: self._confirm_in(state, pair, edge))
            self._refuse_paid_again(deal_id, applied)
        if tpl['timestamp'] <= prior['timestamp']:
            raise ValunError('bad_template', 'the credit-note template timestamp is not after the prior note')

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
