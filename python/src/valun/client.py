"""Valun pilot client: the participant side. Holds the participant's signing key locally and talks to a Valun server.

Trust model: the server is not trusted to tell this client what to sign. Before signing, the client recomputes the
terms hash itself, checks the counterparty's signature against the key in the public directory, and checks credit-note
templates against the agreed price and its own record of what it has already paid that payee. The key and tokens are
stored in a private state file and are never returned by any method.
"""
import hashlib
import json
import os
import secrets
import stat
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from . import basis as vb

NETWORK = 'valun-pilot-1'
PROTOCOL = 'valun-deal/1'
PILOT_TOKEN_ID = hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
UNIT = 'PC'


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


class FileStore:
    """Standalone storage: one private JSON file holds settings, the agent's credentials and its own record of credit
    notes issued. Used by the CLI and tests. (Inside Hermes the plugin uses Hermes's secret store instead.)"""

    def __init__(self, path):
        self.path = path
        self.state = {}
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                self.state = json.load(f)

    def secret(self):
        return self.state.get('secret')

    def token(self):
        return self.state.get('agent_token')

    def save_credentials(self, secret_hex, token):
        self.state['secret'], self.state['agent_token'] = secret_hex, token
        self.save()

    def save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + '.tmp'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(self.state, f, indent=1)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass


class Client:
    """`store` is a FileStore path (str) or any object with .state (non-secret dict), .secret(), .token(),
    .save() and .save_credentials(secret_hex, token)."""

    def __init__(self, store, server=None, timeout=30):
        self.store = FileStore(store) if isinstance(store, (str, os.PathLike)) else store
        self.state = self.store.state
        self.timeout = timeout
        if server:
            self.state['server'] = server.rstrip('/')

    def _save(self):
        self.store.save()

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
        if not self.state.get('server'):
            raise ValunError('not_configured', 'no Valun server configured')
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.state['server'] + path, data=data, method=method)
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
            raise ValunError('unreachable', f'cannot reach {self.state["server"]}: {e.reason}') from None

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
        return self.request('GET', '/pilot/v1/info', auth=False)

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

    def counter(self, deal_id, price=None, title=None, description=None, deliverable=None, deliver_by_hours=None, offer_ttl_hours=24):
        d = self.deal(deal_id)
        chk = self.verify_offer(d)
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

    def complete(self, deal_id, expected_deliverable_sha256=None):
        """Accept the delivery and pay: sign the Basis note for prior + price, after checking the template independently."""
        d = self.deal(deal_id)
        if not d.get('delivery') or not d.get('agreement'):
            raise ValunError('not_delivered', 'nothing has been delivered on this deal')
        dh = d['delivery']['sha256']
        if sha256_hex(d['delivery']['content']) != dh:
            raise ValunError('hash_mismatch', 'the delivered content does not match its hash')
        if expected_deliverable_sha256 and expected_deliverable_sha256 != dh:
            raise ValunError('stale_delivery', 'the delivery changed since you reviewed it')
        terms = self.verified_agreement(d)
        tpl = self.request('GET', f'/pilot/v1/deals/{deal_id}/credit-note-template')
        # The note is between the parties' CURRENT keys (an owner may have replaced an agent key after the deal was
        # agreed): it must be signed by this agent's key and credit the payee's key as the directory lists it now.
        payee = self._registered_key(terms['payee']['id'])
        if tpl['issuer_pubkey'] != self.pubkey or tpl['recipient_pubkey'] != payee:
            raise ValunError('bad_template', 'credit-note template names the wrong parties')
        if tpl['price'] != terms['price']['amount'] or tpl['total'] != tpl['prior_total'] + terms['price']['amount']:
            raise ValunError('bad_template', 'credit-note template does not add exactly the agreed price')
        pair = f'{self.pubkey}>{payee}'
        known = self.state.get('issued', {}).get(pair)
        if known is not None and known != tpl['prior_total']:
            raise ValunError('ledger_mismatch', f'the server says you have issued this payee {tpl["prior_total"]} PC of credit notes so far; your own record says {known}. Ask your operator.')
        if tpl['tracker_nft_id'] != terms['tracker_nft_id'] or tpl['denomination'] != terms['denomination']:
            raise ValunError('bad_template', 'credit-note template names a different tracker or unit')
        if abs(tpl['timestamp'] - int(time.time() * 1000)) > 10 * 60_000:
            raise ValunError('bad_template', 'credit-note template timestamp is not current')
        msg = vb.note_message(bytes.fromhex(self.pubkey), bytes.fromhex(payee), tpl['total'], tpl['timestamp'],
                              bytes.fromhex(tpl['tracker_nft_id']), tpl['denomination'])
        h = terms_hash(terms)
        body = {'terms_hash': h, 'deliverable_sha256': dh, 'signature': self._sign(statement('complete', h, dh)),
                'credit_note': {'total': tpl['total'], 'timestamp': tpl['timestamp'], 'signature': vb.sign(msg, self._secret(), bytes.fromhex(self.pubkey)).hex()}}
        r = self.request('POST', f'/pilot/v1/deals/{deal_id}/complete', body)
        if r.get('status') in ('note_issued', 'completion_awaiting_owner', 'issuing_note'):
            self.state.setdefault('issued', {})[pair] = tpl['total']
            self._save()
        return r

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
