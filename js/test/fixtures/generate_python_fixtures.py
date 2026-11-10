"""Record what the Python reference does, as fixtures for the JavaScript agent tools (offline; run from anywhere):

    python js/test/fixtures/generate_python_fixtures.py

Writes next to this file:
  schemas-python.json  python/src/valun/schemas.py ALL, exactly as Python holds it
  python-parity.json   outputs of measure.py, sandbox.py, records.py and agent.py helpers (and int()/repr()) for many
                       inputs, and the constants both clients must share (approval texts, labels, tool classes, ...);
                       since 0.4 also novation.py: every case of python/tests/test_novation.py CASES with its whole
                       result, a few helpers, and the capability header and consent-policy helpers of client.py/agent.py
  agent-python.json    the Python ValunAgent (call_safe, is_commitment, prepare, describe_commitment, bind) run against
                       recorded server responses, with the requests it made (and the X-Valun-Features header of each)
                       and the exact messages it signed; since 0.4 also client_scenarios: Client methods of circulating
                       credit the tools do not reach (sync_edges, payment attempts and their resolution, cancel_transfer,
                       process_consents, pay_by_transfer retries), recorded the same way
Each file records the SHA-256 (with LF line endings) of every valun.* module the generator imported (so mcp_server.py,
records.py and any module the agent comes to depend on are covered); the JS tests compare them with python/src when it
is present, so a change to the Python reference shows up until the fixtures are generated again.
Nothing here touches the network: the HTTP layer, DNS, the clock and random ids are replaced. Signing nonces are
deterministic, so a rerun writes identical files.
"""
import hashlib
import json
import os
import socket
import sys
import types
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, '..', '..', '..', 'python', 'src'))
sys.dont_write_bytecode = True          # read python/src only: no __pycache__ written there
sys.path.insert(0, SRC)
from valun import agent as va, basis as vb, client as vc, measure as vm, records as vr, sandbox as vs, schemas  # noqa: E402
from valun import novation as nv  # noqa: E402
from valun import mcp_server  # noqa: E402
from valun.mcp_server import APPROVAL_TEXT  # noqa: E402

BASE = 'http://valun.invalid'
T0 = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
T0_MS = int(T0.timestamp() * 1000)
NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
OTHER_NFT = '11' * 32
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
TOKEN = 'vpa_TEST-ONLY-token-never-shown'


def sources():
    """Every valun.* module imported here (the generator's view of the reference), by file name under python/src/valun."""
    pkg = os.path.join(SRC, 'valun')
    out = []
    for name, mod in sys.modules.items():
        f = getattr(mod, '__file__', None)
        if name.startswith('valun.') and f and os.path.dirname(os.path.abspath(f)) == pkg:
            out.append(os.path.basename(f))
    return sorted(set(out))


def source_hashes():
    out = {}
    for f in sources():
        with open(os.path.join(SRC, 'valun', f), 'rb') as fh:
            out[f] = hashlib.sha256(fh.read().replace(b'\r\n', b'\n')).hexdigest()
    return out


def write(name, data):
    with open(os.path.join(HERE, name), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('wrote', name)


# ---------- the replaced world: clock, random ids, DNS, HTTP, and a log of what is signed ----------
class FixedDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return T0 if tz is not None else T0.replace(tzinfo=None)


vc.datetime = FixedDatetime
va.datetime = FixedDatetime
vc.time = types.SimpleNamespace(time=lambda: T0_MS / 1000)
RANDOM = [0]


def token_hex(n):
    RANDOM[0] += 1
    return bytes([RANDOM[0] % 256] * n).hex()


vc.secrets = types.SimpleNamespace(token_hex=token_hex)
NONCE = [0]


def randbelow(n):
    """Deterministic signing nonces for the recorded deal views, so a rerun writes identical fixtures."""
    NONCE[0] += 1
    return int(hashlib.sha256(b'valun-open/js/fixture-nonce/%d' % NONCE[0]).hexdigest(), 16) % n


vb.secrets = types.SimpleNamespace(randbelow=randbelow)
SIGNED = []                              # every message vb.sign signed since the last clear: {signature, message_hex, pubkey}
_real_sign = vb.sign


def logged_sign(message, secret, pk=None):
    sig = _real_sign(message, secret, pk)
    SIGNED.append({'signature': sig.hex(), 'message_hex': bytes(message).hex(), 'pubkey': (pk or vb.public_key(secret)).hex()})
    return sig


vb.sign = logged_sign                    # the client calls vb.sign through the module, so this sees every signature

DNS = {'example.org': ['93.184.215.14'], 'example.com': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
       'docs.python.org': ['151.101.0.223', '2a04:4e42::223'], 'intranet.example': ['10.1.2.3', 'fd00::1'],
       'localhost.example': ['127.0.0.1', '::1'], 'cgnat.example': ['100.64.1.1'], 'mapped.example': ['::ffff:10.0.0.1'],
       'mapped-public.example': ['::ffff:8.8.8.8'], 'en.wikipedia.org': ['185.15.59.224'], 'arxiv.org': ['151.101.3.42']}


def fake_getaddrinfo(host, port, *args, **kwargs):
    if host not in DNS:
        raise socket.gaierror(socket.EAI_NONAME, 'Name or service not known')
    return [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, port)) for ip in DNS[host]]


vm.socket = types.SimpleNamespace(getaddrinfo=fake_getaddrinfo, IPPROTO_TCP=socket.IPPROTO_TCP, gaierror=socket.gaierror)

ROUTES, LOG, SENT, COUNTS = {}, [], [], {}


def is_sig_key(k):
    return k == 'signature' or (isinstance(k, str) and k.endswith('_signature'))


def unsigned(body):
    """A body without its signatures (they use a fresh random nonce each time): every key named signature or ending in
    _signature is dropped, in objects at any depth, lists included; a 'signatures' map (slot -> signature, release v16)
    keeps its slots, each with the value '<signature>', so the slots signed are still compared."""
    if isinstance(body, dict):
        return {k: ({slot: '<signature>' for slot in v} if k == 'signatures' and isinstance(v, dict) else unsigned(v))
                for k, v in body.items() if not is_sig_key(k)}
    if isinstance(body, list):
        return [unsigned(v) for v in body]
    return body


def signatures_in(body):
    """The signatures in a body, in document order (the same walk as unsigned(); a 'signatures' map's values in order)."""
    out = []
    if isinstance(body, dict):
        for k, v in body.items():
            if is_sig_key(k) and isinstance(v, str):
                out.append(v)
            elif k == 'signatures' and isinstance(v, dict):
                out.extend(x for x in v.values() if isinstance(x, str))
            else:
                out.extend(signatures_in(v))
    elif isinstance(body, list):
        for v in body:
            out.extend(signatures_in(v))
    return out


def fake_request(self, method, path, body=None, auth=True, token=None):
    if not self.state.get('server'):
        raise vc.ValunError('not_configured', 'no Valun server configured')
    key = f'{method} {path}'
    caps = self.features_header()           # the X-Valun-Features header Client.request() would send (release v16)
    LOG.append({'key': key, 'body': unsigned(body), 'features': caps})
    sigs = signatures_in(body)
    if sigs:                             # what each signature it sends was made over (the client made all of them, here)
        made = {s['signature']: s for s in SIGNED}
        assert all(s in made for s in sigs), f'{key} sends a signature this run did not make'
        SENT.append({'key': key, 'signed': [{'message_hex': made[s]['message_hex'], 'pubkey': made[s]['pubkey']} for s in sigs]})
    r = ROUTES.get(key)
    if isinstance(r, dict) and 'sequence' in r:  # a route that answers its n-th request with sequence[n] (then the last)
        n = COUNTS.get(key, 0)
        COUNTS[key] = n + 1
        r = r['sequence'][min(n, len(r['sequence']) - 1)]
    status, payload = (599, {'error': 'unexpected_request', 'message': key}) if r is None else (r.get('status', 200), r.get('body'))
    if 200 <= status < 300:
        tok = token or (self.store.token() if auth else None)
        if caps and token is None and auth and tok and vc._authenticated_route(path):
            self._roles_declared(caps)      # as Client.request(): the server took the roles of an authenticated 2xx
        return json.loads(json.dumps(payload))
    j = payload if isinstance(payload, dict) else {}
    raise vc.ValunError(j.get('error', 'http_error'), j.get('message') or j.get('error') or f'HTTP {status}', status,
                        {k: v for k, v in j.items() if k not in ('error', 'message')})


vc.Client.request = fake_request


class Store:
    def __init__(self, state, secret=None, token=None):
        self.state, self._secret, self._token = state, secret, token

    def secret(self):
        return self._secret

    def token(self):
        return self._token

    def save(self):
        pass

    def save_credentials(self, secret_hex, token):
        self._secret, self._token = secret_hex, token


def outcome(fn):
    """The value fn() returns, or what it raises: the type, a ValunError's code (and an approval_unbound's cause), the message."""
    try:
        return {'value': fn()}
    except vc.ValunError as e:
        out = {'raises': 'ValunError', 'code': e.code, 'message': str(e)}
        if 'cause' in e.extra:
            out['cause'] = e.extra['cause']
        return out
    except Exception as e:  # noqa: BLE001
        return {'raises': type(e).__name__, 'message': str(e)}


# ---------- participants and deals ----------
def key(label):
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'label': label, 'secret': secret.hex(), 'pubkey': vb.public_key(secret).hex()}


K = {n: key(f'valun-open/spec/test-key/{n}') for n in ('alice', 'bob', 'carol', 'erin', 'frank')}
ID = {'alice': 'vp_a1a1a1a1a1a1', 'bob': 'vp_b0b0b0b0b0b0', 'carol': 'vp_c0c0c0c0c0c0', 'dave': 'vp_d0d0d0d0d0d0',
      'erin': 'vp_e0e0e0e0e0e0', 'frank': 'vp_f0f0f0f0f0f0'}
NAME = {v: k for k, v in ID.items()}
SANDBOX_SERVICES = vs.SERVICES_TEXT[:300]
PEOPLE = [
    {'id': ID['alice'], 'handle': 'alice', 'display_name': 'Alice', 'operator': 'Alice Example', 'about': 'Buys research briefs.',
     'services': '', 'status': 'active', 'agent_last_seen': '2026-11-06T11:59:00.000Z', 'joined_at': '2026-10-01T00:00:00.000Z'},
    {'id': ID['bob'], 'handle': 'bob', 'display_name': 'Bob Briefs', 'operator': 'Bob Example', 'about': 'Writes research briefs.',
     'services': 'Research briefs, 300-500 words, with sources.', 'status': 'active',
     'agent_last_seen': '2026-11-06T11:00:00.000Z', 'joined_at': '2026-10-02T00:00:00.000Z'},
    {'id': ID['carol'], 'handle': 'sandbox-exact', 'display_name': 'Sandbox: exact results', 'operator': 'Valun operator (sandbox)',
     'about': 'Deterministic test agent.', 'services': SANDBOX_SERVICES, 'status': 'active',
     'agent_last_seen': '2026-11-01T00:00:00.000Z', 'joined_at': '2026-10-03T00:00:00.000Z'},
    {'id': ID['dave'], 'handle': 'dave', 'display_name': 'Dave', 'operator': 'Dave Example', 'about': 'Not enrolled yet.',
     'services': 'Translations', 'status': 'awaiting_agent', 'agent_last_seen': None, 'joined_at': '2026-11-06T10:00:00.000Z'},
    {'id': ID['erin'], 'handle': 'erin', 'display_name': 'Erin', 'operator': 'Erin Example', 'about': 'New: summaries.',
     'services': 'Summaries', 'status': 'active', 'agent_last_seen': None, 'joined_at': '2026-11-06T10:00:00.000Z'},
    {'id': ID['frank'], 'handle': 'frank', 'display_name': 'Frank', 'operator': 'Frank Example', 'about': 'Research and briefs.',
     'services': 'Market research', 'status': 'active', 'agent_last_seen': '2026-11-03T12:00:00.000Z', 'joined_at': '2026-10-04T00:00:00.000Z'},
]
POSITIONS = {ID['alice']: {'claims_held': 0, 'owes': 10, 'deals': {'completed': 1, 'disputed': 0}},
             ID['bob']: {'claims_held': 40, 'owes': 0, 'deals': {'completed': 3, 'disputed': 1}},
             ID['carol']: {'claims_held': 12, 'owes': 0, 'deals': {'completed': 6, 'disputed': 0}},
             ID['erin']: {'claims_held': 0, 'owes': 0, 'deals': {'completed': 0, 'disputed': 0}},
             ID['frank']: {'claims_held': 5, 'owes': 2, 'deals': {'completed': 1, 'disputed': 0}}}
PUBKEY = {ID[n]: K[n]['pubkey'] for n in K}
INFO = {'network': vc.NETWORK, 'protocol': vc.PROTOCOL, 'unit': 'PC', 'denomination': DENOM, 'tracker_nft_id': NFT, 'tracker_on_chain': False}
MANDATE = {'objective': 'Buy short research briefs for the newsletter.', 'may_issue_credit': True, 'may_accept_credit': True,
           'max_issue_per_deal': 30, 'max_issue_outstanding': 100, 'max_accept_per_deal': 50, 'max_accept_per_issuer': 200,
           'min_price_as_payee': 5, 'min_payer_coverage_pct': 0, 'counterparties': 'any', 'approve_above': 25,
           'review_deliveries': False, 'expires_at': '2026-12-01T00:00:00.000Z'}
ME = {'participant': {'id': ID['alice'], 'handle': 'alice', 'display_name': 'Alice', 'status': 'active'},
      'mandate': MANDATE, 'mandate_version': 3,
      'agent_limits': {'max_issue_per_deal': 20, 'min_price_as_payee': 8, 'notes': 'Briefs under 20 PC; prefer sources.', 'set_at': '2026-11-05T09:00:00.000Z'},
      'effective_limits': {'max_issue_per_deal': 20, 'max_issue_outstanding': 100, 'max_accept_per_deal': 50,
                           'max_accept_per_issuer': 200, 'min_price_as_payee': 8, 'min_payer_coverage_pct': 0},
      'position': {'claims_held_PC': 0, 'owes_PC': 10, 'outstanding': True}, 'authority': {'mandate_expires_at': '2026-12-01T00:00:00.000Z'}}
INBOX = {'respond': [{'deal_id': 'vd_1111111111111111', 'from': 'bob'}], 'deliver': [], 'review': [], 'awaiting_owner': [], 'waiting': []}
PAIR_AB = f"{K['alice']['pubkey']}>{K['bob']['pubkey']}"
PINS = {'tracker_nft_id': NFT, 'denomination': DENOM}


def base_routes():
    r = {'GET /pilot/v1/info': {'body': INFO}, 'GET /pilot/v1/me': {'body': ME}, 'GET /pilot/v1/participants': {'body': PEOPLE},
         'GET /pilot/v1/inbox': {'body': INBOX}}
    for p in PEOPLE:
        detail = {'id': p['id'], 'handle': p['handle'], 'status': p['status'], 'pubkey': PUBKEY.get(p['id'])}
        if p['id'] in POSITIONS:
            detail['public_position'] = POSITIONS[p['id']]
        r[f"GET /pilot/v1/participants/{p['id']}"] = {'body': detail}
    return r


def sign(name, text):
    return vb.sign(text.encode('utf-8'), bytes.fromhex(K[name]['secret'])).hex()


NOTE_SIGS = {}


def note_sig(name, recipient, total, ts):
    """The issuer's signature of one note state: one signature per state (as the tracker holds it), made once."""
    k = (name, recipient, total, ts)
    if k not in NOTE_SIGS:
        msg = vb.note_message(bytes.fromhex(K[name]['pubkey']), bytes.fromhex(K[recipient]['pubkey']), total, ts, bytes.fromhex(NFT), DENOM)
        NOTE_SIGS[k] = vb.sign(msg, bytes.fromhex(K[name]['secret'])).hex()
    return NOTE_SIGS[k]


def make_terms(deal_id, proposer, payer, payee, title, description, deliverable, price, version=1, prior=None,
               deliver_by='2099-01-02T00:00:00.000Z', expires='2099-01-01T00:00:00.000Z'):
    return {'protocol': vc.PROTOCOL, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': deal_id,
            'version': version, 'prior_terms_hash': prior, 'nonce': 'ab' * 16, 'proposer': ID[proposer],
            'payer': {'id': ID[payer], 'pubkey': K[payer]['pubkey']}, 'payee': {'id': ID[payee], 'pubkey': K[payee]['pubkey']},
            'service': {'title': title, 'description': description, 'deliverable': deliverable},
            'price': {'amount': price, 'unit': 'PC'}, 'consideration': 'credit_note_on_delivery_accepted',
            'deliver_by': deliver_by, 'offer_expires_at': expires}


def deal_view(t, proposer, status='open', your_role='payer', other='bob', versions=None, signature=None, **extra):
    h = vc.terms_hash(t)
    cur = {'version': t['version'], 'by': ID[proposer], 'state': 'open', 'terms': t, 'terms_hash': h,
           'signature': signature or sign(proposer, vc.statement('propose', h))}
    d = {'id': t['deal_id'], 'status': status, 'your_role': your_role, 'counterparty': {'id': ID[other], 'handle': PEOPLE_BY_ID[ID[other]]['handle']},
         'next_actions': ['accept', 'counter', 'decline'] if status == 'open' else [], 'current': cur, 'pending_counter': None,
         'versions': versions or [{'version': t['version'], 'by': ID[proposer], 'state': 'open', 'terms_hash': h, 'price': t['price']}],
         'history': [{'at': '2026-11-06T10:00:00.000Z', 'event': 'proposed', 'by': PEOPLE_BY_ID[ID[proposer]]['handle']}],
         'labels': {'unit': 'PC (pilot credits, no monetary value)'}}
    d.update(extra)
    return d


PEOPLE_BY_ID = {p['id']: p for p in PEOPLE}


def agreed(d, acceptor):
    h = d['current']['terms_hash']
    out = dict(d, status='agreed', next_actions=[])
    out['current'] = dict(d['current'], state='agreed')
    out['agreement'] = {'version': d['current']['version'], 'terms_hash': h, 'formed_at': '2026-11-06T10:30:00.000Z',
                        'proposer_signature': d['current']['signature'], 'acceptor_signature': sign(acceptor, vc.statement('accept', h))}
    return out


def delivered(d, content, title='Brief', status='delivered', signer=None):
    """The delivery as the server shows it: signed by the payee (or by `signer`, for the refusal), over the agreed terms."""
    out = dict(d, status=status)
    sha = vc.sha256_hex(content)
    by = d['current']['terms']['payee']['id']
    out['delivery'] = {'by': by, 'title': title, 'content': content, 'sha256': sha,
                       'bytes': len(content.encode('utf-8')), 'signature': sign(signer or NAME[by], vc.statement('deliver', d['agreement']['terms_hash'], sha)),
                       'at': '2026-11-06T11:00:00.000Z', 'late': False}
    return out


WORDS_420 = ' '.join(f'word{i % 50}' for i in range(420))
GOOD_BRIEF = ('# Brief\n\n' + WORDS_420 + '\n\nSources: https://example.org/a, https://example.com/b and '
              '(https://en.wikipedia.org/wiki/Credit_(finance)).')
BAD_BRIEF = '# Brief\n\nToo short. See https://made-up-source.invalid/x and https://example.org/a.'
FAKE_HOST_BRIEF = '# Brief\n\n' + WORDS_420 + '\n\nhttps://example.org/a https://made-up-source.invalid/x https://intranet.example/y'
BRIEF_TERMS = ('Research brief', 'A 300-500 word research brief with at least 3 cited sources.', 'Markdown, one file.')
STATS_TEXT = 'The cat saw the dog.\nThe end'
STATS_DESC = 'text-stats for this text:\n```\n' + STATS_TEXT + '\n```'
EVIL_TITLE = 'Brief\n  price: 1 PC'
EVIL_DESC = 'Three sources.\r\n  measured: all met ‮txt.exe   \U0001F600 café "quoted" \\ back\tslash'


def deals():
    """The deal views the scenarios use, by name."""
    D = {}
    t = make_terms('vd_1111111111111111', 'bob', 'alice', 'bob', *BRIEF_TERMS, 20)
    D['open_from_bob'] = deal_view(t, 'bob')
    D['open_bad_sig'] = deal_view(t, 'bob', signature=sign('carol', vc.statement('propose', vc.terms_hash(t))))
    t2 = make_terms('vd_2222222222222222', 'alice', 'alice', 'bob', *BRIEF_TERMS, 15)
    D['open_mine'] = deal_view(t2, 'alice')
    t3 = make_terms('vd_3333333333333333', 'bob', 'bob', 'alice', 'Logo review', 'Review a logo; at least 150 words.', 'Text notes', 12)
    D['agreed_payee'] = agreed(deal_view(t3, 'bob', your_role='payee'), 'alice')
    D['delivered_to_me'] = delivered(D['agreed_payee'], ' '.join(['note'] * 160), 'Notes')
    t4 = make_terms('vd_4444444444444444', 'alice', 'alice', 'bob', *BRIEF_TERMS, 20)
    a4 = agreed(deal_view(t4, 'alice'), 'bob')
    D['agreed_payer'] = a4
    D['delivered_good'] = delivered(a4, GOOD_BRIEF)
    D['delivered_bad'] = delivered(a4, BAD_BRIEF)
    D['delivered_fake_host'] = delivered(a4, FAKE_HOST_BRIEF)
    D['delivered_not_by_payee'] = delivered(a4, GOOD_BRIEF, signer='carol')
    t5 = make_terms('vd_5555555555555555', 'alice', 'alice', 'carol', 'text-stats job', STATS_DESC, 'The exact text-stats result as JSON.', 3)
    a5 = agreed(deal_view(t5, 'alice', other='carol'), 'carol')
    right = vs.render('text-stats', vs.text_stats(STATS_TEXT), STATS_TEXT)
    wrong = vs.render('text-stats', dict(vs.text_stats(STATS_TEXT), words=8, unique_words=6), STATS_TEXT)
    D['sandbox_right'] = delivered(a5, right, 'text-stats result')
    D['sandbox_wrong'] = delivered(a5, wrong, 'text-stats result')
    D['sandbox_no_json'] = delivered(a5, 'I counted 7 words. ' * 12, 'text-stats result')
    D['sandbox_wrong_as_payee'] = dict(D['sandbox_wrong'], your_role='payee')
    D['note_issued'] = dict(delivered(a4, GOOD_BRIEF, status='note_issued'), credit_note={
        'state': 'issued', 'amount': 20, 'tracker_status': 'recorded', 'tracker_note': {'amount_collected': 30, 'confirmation': 'local_only'},
        'verified_by_valun': True, 'outstanding': True, 'issuer_pubkey': K['alice']['pubkey'], 'recipient_pubkey': K['bob']['pubkey'],
        'signature_withheld': True})
    D['long_delivery'] = delivered(a4, ('x' * 15990) + ' \U0001F600' * 20)
    v1 = make_terms('vd_6666666666666666', 'alice', 'alice', 'bob', *BRIEF_TERMS, 10)
    h1 = vc.terms_hash(v1)
    v2 = make_terms('vd_6666666666666666', 'bob', 'alice', 'bob', *BRIEF_TERMS, 25, version=2, prior=h1)
    h2 = vc.terms_hash(v2)
    v3 = make_terms('vd_6666666666666666', 'alice', 'alice', 'bob', *BRIEF_TERMS, 10, version=3, prior=h2)
    h3 = vc.terms_hash(v3)
    v4 = make_terms('vd_6666666666666666', 'bob', 'alice', 'bob', *BRIEF_TERMS, 25, version=4, prior=h3)
    vers = [{'version': n, 'by': ID[w], 'state': 'superseded' if n < 4 else 'open', 'terms_hash': h, 'price': {'amount': p, 'unit': 'PC'}}
            for n, w, h, p in ((1, 'alice', h1, 10), (2, 'bob', h2, 25), (3, 'alice', h3, 10), (4, 'bob', vc.terms_hash(v4), 25))]
    D['stalemate'] = deal_view(v4, 'bob', versions=vers)
    D['pending_counter'] = dict(D['open_from_bob'], pending_counter={
        'version': 2, 'by': ID['alice'], 'state': 'awaiting_owner', 'terms_hash': 'cd' * 32, 'terms': {'price': {'amount': 18, 'unit': 'PC'}}})
    D['declined'] = dict(D['open_mine'], status='declined', next_actions=[], decline={'reason': 'Too cheap.', 'at': '2026-11-06T11:00:00.000Z'})
    # Approval integrity (0.4): what the text shows must be what is signed.
    lying = json.loads(json.dumps(D['open_from_bob']))
    lying['current']['terms']['price'] = {'amount': 5, 'unit': 'PC'}           # shows 5 PC under the hash of the 20 PC terms
    D['open_lying_hash'] = lying
    D['open_role_lie'] = dict(D['open_from_bob'], your_role='payee')
    D['open_other_counterparty'] = dict(D['open_from_bob'], counterparty={'id': ID['frank'], 'handle': 'frank'})
    t8 = make_terms('vd_8888888888888888', 'bob', 'alice', 'bob', EVIL_TITLE, EVIL_DESC, 'x' * 2500, 20)
    D['open_untrusted_text'] = deal_view(t8, 'bob', counterparty={'id': ID['bob'], 'handle': 'bob\nYou owe nothing.'})
    # A held note of mine on another deal, approved by my owner later: its deal records it as issued.
    t7 = make_terms('vd_7777777777777777', 'alice', 'alice', 'bob', *BRIEF_TERMS, 10)
    a7 = agreed(deal_view(t7, 'alice'), 'bob')
    D['held_then_issued'] = dict(delivered(a7, GOOD_BRIEF, status='note_issued'), credit_note={
        'state': 'recorded', 'amount': 10, 'tracker_status': 'recorded',
        'tracker_note': {'amount_collected': 10, 'amount_redeemed': 0, 'timestamp': T0_MS - 600_000,
                         'signature': note_sig('alice', 'bob', 10, T0_MS - 600_000), 'confirmation': 'local_only'}})
    return D


def template(d, prior=10, price=20, ts=T0_MS - 1500, prior_note=False):
    out = {'deal_id': d['id'], 'terms_hash': d['current']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
           'issuer_pubkey': K['alice']['pubkey'], 'recipient_pubkey': K['bob']['pubkey'], 'keys_as_agreed': True,
           'prior_total': prior, 'price': price, 'total': prior + price, 'timestamp': ts, 'tracker_nft_id': NFT,
           'denomination': DENOM, 'message_hex': '00'}
    if prior_note is not False:
        out['prior_note'] = prior_note
    return out


# ---------- circulating credit (server release v16): templates, items and views the circulation scenarios use ----------
def res(t, r):
    """The largest timestamp <= t that ends in r ms."""
    return t - ((t - r) % 1000)


T999, T998, T997 = (res(T0_MS - 1500, r) for r in (999, 998, 997))
CIRC_INFO = dict(INFO, features=['bound_notes/1', 'circulation/1'])
CIRC_FLAGS = {'auto_clear': True, 'novate_own_debt': True, 'accept_transfers': True, 'accept_notes_from': 'any',
              'refuse_notes_from': [], 'pay_with_held_notes': 'when_asked'}
POLICY = {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 50, 'accept_issuers': 'any', 'refuse_issuers': []}
POLICY_OFF = dict(POLICY, setoff=False, as_issuer=False, as_new_creditor=False)


def edge(i, r):
    return f"{K[i]['pubkey']}>{K[r]['pubkey']}"


def state_of(i, r, total, ts):
    """An EdgeState of edge i>r, signed by its issuer."""
    return {'total': total, 'timestamp': ts, 'signature': note_sig(i, r, total, ts)}


def me_circ(position=None, participant=None, flags=None):
    """GET /me of a circulation server: the mandate and the effective limits carry the consent flags."""
    out = dict(ME, mandate=dict(MANDATE, **(CIRC_FLAGS if flags is None else flags)),
               effective_limits=dict(ME['effective_limits'], may_accept_credit=True, **(CIRC_FLAGS if flags is None else flags)))
    if position is not None:
        out['position'] = position
    if participant is not None:
        out['participant'] = dict(ME['participant'], **participant)
    return out


def edges_view(incoming=(), outgoing=(), journal=(), next_seq=0):
    row = lambda i, r, st: {'edge': edge(i, r), 'issuer_pubkey': K[i]['pubkey'], 'recipient_pubkey': K[r]['pubkey'], **st,   # noqa: E731
                            'bound_only': False}
    return {'incoming': [row(*x) for x in incoming], 'outgoing': [row(*x) for x in outgoing], 'journal': list(journal),
            'next_seq': next_seq}


def bound_template(d, prior=10, price=20, ts=None, prior_note=None):
    """A v16 bound credit-note template (?prior=1&bound=1): a timestamp ending in 997 and the prior acknowledgment."""
    out = template(d, prior=prior, price=price, ts=T997 if ts is None else ts, prior_note=prior_note)
    out['prior_message_hex'] = '00'
    return out


def payment_options(d, issuer='frank', spendable=30, why_not=None, own=True):
    payee = NAME[d['current']['terms']['payee']['id']]
    held = [] if issuer is None else [{'issuer': {'id': ID[issuer], 'handle': PEOPLE_BY_ID[ID[issuer]]['handle'], 'pubkey': K[issuer]['pubkey'],
                                                  'operator_run': False},
                                       'held': spendable, 'reserved': 0, 'spendable': spendable, 'enough': why_not is None,
                                       'payee_accepts': True, 'issuer_consents': 'auto', 'payee_consents': 'auto', 'why_not': why_not}]
    return {'deal_id': d['id'], 'price': d['current']['terms']['price']['amount'],
            'payee': {'id': ID[payee], 'handle': payee, 'pubkey': K[payee]['pubkey']},
            'own_note': {'available': own, 'why_not': None if own else 'over_limit'}, 'held_notes': held,
            'pending_transfer': None, 'fallback_after': None}


def transfer_template(d, issuer='frank', claim=(30, T0_MS - 900_000 + 1), to_before=None, ts=None, amount=None):
    """GET transfer-template: pay deal d (alice pays) by moving `amount` of issuer's debt to alice onto the payee."""
    t = d['current']['terms']
    payee = NAME[t['payee']['id']]
    amount = t['price']['amount'] if amount is None else amount
    ts = T999 if ts is None else ts
    quote = {'kind': nv.QUOTE_KIND, 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM, 'deal_id': d['id'],
             'terms_hash': d['current']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
             'issuer_pubkey': K[issuer]['pubkey'], 'payer_pubkey': K['alice']['pubkey'], 'payee_pubkey': K[payee]['pubkey'], 'amount': amount}
    before_to = None if to_before is None else state_of(issuer, payee, *to_before)
    return {'deal_id': d['id'], 'terms_hash': d['current']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
            'issuer': {'id': ID[issuer], 'handle': PEOPLE_BY_ID[ID[issuer]]['handle'], 'pubkey': K[issuer]['pubkey']},
            'payer': {'id': ID['alice'], 'handle': 'alice', 'pubkey': K['alice']['pubkey']},
            'payee': {'id': ID[payee], 'handle': payee, 'pubkey': K[payee]['pubkey']},
            'amount': amount, 'timestamp': ts,
            'from_edge': {'edge': edge(issuer, 'alice'), 'before': state_of(issuer, 'alice', *claim), 'new_total': claim[0] - amount},
            'to_edge': {'edge': edge(issuer, payee), 'before': before_to, 'new_total': (0 if to_before is None else to_before[0]) + amount},
            'tracker_nft_id': NFT, 'denomination': DENOM, 'quote_digest': nv.quote_digest(quote),
            'collect_until': '2026-11-06T12:20:00.000Z', 'messages': {}}


def setoff_item(iid='vs_5e70ff5e70ff5e70', amount=6, ab=(10, T0_MS - 900_000 + 1), ba=(6, T0_MS - 800_000 + 2), ts=None,
                roles=('member',), state='collecting'):
    """A set-off of the 2-cycle alice -> bob -> alice (GET /consents item): alice is issuer of alice>bob and creditor of bob>alice."""
    ts = T998 if ts is None else ts
    rows = []
    for i, r, (total, t0), role in (('bob', 'alice', ba, 'creditor'), ('alice', 'bob', ab, 'issuer')):
        rows.append({'edge': edge(i, r), 'issuer': {'id': ID[i], 'handle': i}, 'recipient': {'id': ID[r], 'handle': r},
                     'your_role': role, 'before': state_of(i, r, total, t0), 'change': -amount, 'new_total': total - amount,
                     'timestamp': ts, 'revision': 1, 'slots': ['new'], 'signed_by_you': []})
    return {'kind': 'setoff', 'id': iid, 'state': state, 'your_roles': list(roles), 'created_at': '2026-11-06T11:58:00.000Z',
            'expires_at': '2026-11-06T12:28:00.000Z', 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
            'edges': rows, 'context': {'amount': amount}, 'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': -amount}}


def issuer_item(iid='vt_7a7a7a7a7a7a7a7a', amount=4, ts=None):
    """A transfer of alice's debt to bob onto frank (alice issuer: alice>bob falls, alice>frank rises): a consent alice
    signs as issuer (not value-safe)."""
    ts = T999 if ts is None else ts
    rows = [{'edge': edge('alice', 'bob'), 'issuer': {'id': ID['alice'], 'handle': 'alice'}, 'recipient': {'id': ID['bob'], 'handle': 'bob'},
             'your_role': 'issuer', 'before': state_of('alice', 'bob', 10, T0_MS - 900_000 + 1), 'change': -amount,
             'new_total': 10 - amount, 'timestamp': ts, 'revision': 1, 'slots': ['new'], 'signed_by_you': []},
            {'edge': edge('alice', 'frank'), 'issuer': {'id': ID['alice'], 'handle': 'alice'}, 'recipient': {'id': ID['frank'], 'handle': 'frank'},
             'your_role': 'issuer', 'before': None, 'change': amount, 'new_total': amount, 'timestamp': ts, 'revision': 1,
             'slots': ['new'], 'signed_by_you': []}]
    return {'kind': 'transfer', 'id': iid, 'state': 'collecting', 'your_roles': ['issuer'], 'created_at': '2026-11-06T11:58:00.000Z',
            'expires_at': '2026-11-06T12:18:00.000Z', 'network': vc.NETWORK, 'tracker_nft_id': NFT, 'denomination': DENOM,
            'edges': rows, 'context': {'amount': amount, 'deal': {'deal_id': 'vd_abababababababab'}},
            'summary': {'your_net_change_PC': 0, 'your_total_owed_change_PC': 0}}


def scenarios():
    D = deals()
    g = lambda name: {f"GET /pilot/v1/deals/{D[name]['id']}": {'body': D[name]}}   # noqa: E731
    post = lambda did, act, body, status=200: {f'POST /pilot/v1/deals/{did}/{act}': {'status': status, 'body': body}}   # noqa: E731
    S = []

    def add(name, tool, args, routes=None, store='alice', agent=None, state=None):
        S.append({'name': name, 'tool': tool, 'args': args, 'routes': routes or {}, 'store': store, 'agent': agent or {},
                  'state': state or {}})

    ask = {'approvals': APPROVAL_TEXT['ask']}
    # status
    add('status: full', 'valun_status', {}, agent=ask)
    add('status: default approvals sentence', 'valun_status', None)
    me2 = {k: v for k, v in ME.items() if k not in ('agent_limits', 'effective_limits')}
    me2['mandate'] = {k: v for k, v in MANDATE.items() if k != 'objective'}
    add('status: nothing recorded, no objective', 'valun_status', {}, {'GET /pilot/v1/me': {'body': me2}})
    add('status: not enrolled', 'valun_status', {}, store='unenrolled')
    add('status: not enrolled, MCP setup hint', 'valun_status', {}, store='unenrolled', agent={'setup_hint': 'run `valun join` in a terminal'})
    add('status: token refused by the server', 'valun_status', {},
        {'GET /pilot/v1/me': {'status': 401, 'body': {'error': 'unauthorized', 'message': 'agent token not recognised'}}})
    add('status: the profile is pinned to another tracker', 'valun_status', {}, state={'pins': {'tracker_nft_id': OTHER_NFT, 'denomination': DENOM}})
    add('status: console approvals sentence', 'valun_status', {}, agent={'approvals': APPROVAL_TEXT['console']})
    add('unknown tool', 'valun_pay', {})
    add('unknown tool name with a quote', "it's", {})
    add('unknown tool name with both quotes and a tab', 'a"b\'c\td', {})
    add('unknown tool name with non-ASCII', 'valun_café_\U0001F600', {'x': 1})
    # directory
    add('directory: everyone', 'valun_directory', {})
    add('directory: query', 'valun_directory', {'query': 'BRIEF'})
    add('directory: no match', 'valun_directory', {'query': 'nothing like this'})
    add('directory: query not text', 'valun_directory', {'query': 5})
    # inbox
    add('inbox', 'valun_inbox', {})
    # deal
    add('deal: open offer from bob, verified', 'valun_deal', {'deal_id': D['open_from_bob']['id']}, g('open_from_bob'))
    add('deal: bad proposer signature', 'valun_deal', {'deal_id': D['open_bad_sig']['id']}, g('open_bad_sig'))
    add('deal: my own open offer', 'valun_deal', {'deal_id': D['open_mine']['id']}, g('open_mine'))
    add('deal: agreed, I deliver', 'valun_deal', {'deal_id': D['agreed_payee']['id']}, g('agreed_payee'))
    add('deal: agreed, they deliver', 'valun_deal', {'deal_id': D['agreed_payer']['id']}, g('agreed_payer'))
    add('deal: good delivery measured, hosts checked', 'valun_deal', {'deal_id': D['delivered_good']['id']}, g('delivered_good'))
    add('deal: short delivery with a made-up host', 'valun_deal', {'deal_id': D['delivered_bad']['id']}, g('delivered_bad'))
    add('deal: host checks off', 'valun_deal', {'deal_id': D['delivered_bad']['id']}, g('delivered_bad'), agent={'check_link_hosts': False})
    add('deal: sandbox result matches', 'valun_deal', {'deal_id': D['sandbox_right']['id']}, g('sandbox_right'))
    add('deal: sandbox result wrong', 'valun_deal', {'deal_id': D['sandbox_wrong']['id']}, g('sandbox_wrong'))
    add('deal: sandbox delivery without a result block', 'valun_deal', {'deal_id': D['sandbox_no_json']['id']}, g('sandbox_no_json'))
    add('deal: sandbox wrong, seen by the payee (no advice)', 'valun_deal', {'deal_id': D['sandbox_wrong_as_payee']['id']}, g('sandbox_wrong_as_payee'))
    add('deal: credit note issued', 'valun_deal', {'deal_id': D['note_issued']['id']}, g('note_issued'))
    add('deal: long delivery truncated by code points', 'valun_deal', {'deal_id': D['long_delivery']['id']}, g('long_delivery'))
    add('deal: negotiation stalemate', 'valun_deal', {'deal_id': D['stalemate']['id']}, g('stalemate'))
    add('deal: my counter-offer awaiting my owner', 'valun_deal', {'deal_id': D['pending_counter']['id']}, g('pending_counter'))
    add('deal: declined', 'valun_deal', {'deal_id': D['declined']['id']}, g('declined'))
    add('deal: no deal_id', 'valun_deal', {})
    add('deal: unknown deal', 'valun_deal', {'deal_id': 'vd_0000000000000000'},
        {'GET /pilot/v1/deals/vd_0000000000000000': {'status': 404, 'body': {'error': 'not_found', 'message': 'no such deal'}}})
    # propose
    created = lambda status: {'POST /pilot/v1/deals': {'body': {'id': 'vd_0101010101010101', 'status': status,   # noqa: E731
                                                                'current': {'terms_hash': 'ef' * 32}}}}
    brief = {'counterparty': 'bob', 'role': 'payer', 'title': 'Research brief', 'description': BRIEF_TERMS[1], 'deliverable': BRIEF_TERMS[2], 'price': 18}
    add('propose: payer to bob', 'valun_propose', brief, created('open'))
    add('propose: held for my owner', 'valun_propose', dict(brief, price='22', deliver_within_hours=0, offer_valid_hours=12), created('proposed_awaiting_owner'))
    add('propose: payee, by participant id, spaces and capitals', 'valun_propose',
        dict(brief, counterparty='  BOB ', role='payee', price=9.7, deliver_within_hours=72), created('open'))
    add('propose: idle seller gets a warning', 'valun_propose', dict(brief, counterparty='frank'), created('open'))
    add('propose: new participant is not idle', 'valun_propose', dict(brief, counterparty='erin'), created('open'))
    add('propose: sandbox seller without the text', 'valun_propose',
        {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 'text-stats job', 'description': 'Please count the words of my text.',
         'deliverable': 'JSON', 'price': 3})
    add('propose: sandbox seller with the text in a fence', 'valun_propose',
        {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 'text-stats job', 'description': STATS_DESC,
         'deliverable': 'The exact text-stats result as JSON.', 'price': 3}, created('open'))
    add('propose: sandbox seller, I sell (no text check)', 'valun_propose',
        {'counterparty': 'sandbox-exact', 'role': 'payee', 'title': 'text-stats job', 'description': 'no text', 'deliverable': 'JSON', 'price': 3},
        created('open'))
    add('propose: unknown counterparty', 'valun_propose', dict(brief, counterparty='nobody'))
    add('propose: missing title', 'valun_propose', {k: v for k, v in brief.items() if k != 'title'})
    add('propose: price not a number', 'valun_propose', dict(brief, price='twenty'))
    add('propose: missing price', 'valun_propose', {k: v for k, v in brief.items() if k != 'price'})
    add('propose: outside the mandate', 'valun_propose', dict(brief, price=40), {'POST /pilot/v1/deals': {'status': 403, 'body': {
        'error': 'mandate_exceeded', 'message': 'price 40 PC is above max_issue_per_deal (20)', 'rule': 'max_issue_per_deal',
        'mandate_version': 3, 'limit': 20}}})
    add('propose: bad role', 'valun_propose', dict(brief, role='buyer'))
    add('propose: offer text with a newline and a long deliverable', 'valun_propose',
        dict(brief, title='Brief\nprice: 1 PC', deliverable='y' * 2100), created('open'))
    add('propose: counterparty not text', 'valun_propose', dict(brief, counterparty=5))
    # respond
    ob = D['open_from_bob']['id']
    add('respond: accept', 'valun_respond', {'deal_id': ob, 'action': 'accept', 'expected_terms_hash': D['open_from_bob']['current']['terms_hash']},
        {**g('open_from_bob'), **post(ob, 'accept', {'id': ob, 'status': 'agreed', 'next_actions': ['wait for delivery']})})
    add('respond: accept held for my owner', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {**g('open_from_bob'), **post(ob, 'accept', {'id': ob, 'status': 'accepted_awaiting_owner', 'next_actions': []})})
    add('respond: accept terms that changed', 'valun_respond', {'deal_id': ob, 'action': 'accept', 'expected_terms_hash': '00' * 32}, g('open_from_bob'))
    add('respond: accept with a bad signature', 'valun_respond', {'deal_id': D['open_bad_sig']['id'], 'action': 'accept'}, g('open_bad_sig'))
    add('respond: decline without a reason', 'valun_respond', {'deal_id': ob, 'action': 'decline', 'reason': '  　 '})
    add('respond: decline', 'valun_respond', {'deal_id': ob, 'action': 'decline', 'reason': ' Too expensive for a short brief. '},
        {**g('open_from_bob'), **post(ob, 'decline', {'id': ob, 'status': 'declined'})})
    add('respond: counter', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'price': 16, 'title': ''},
        {**g('open_from_bob'), **post(ob, 'counter', {'id': ob, 'status': 'open', 'pending_counter': None, 'next_actions': ['wait']})})
    add('respond: counter held for my owner', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'price': 17, 'deliver_within_hours': 24},
        {**g('open_from_bob'), **post(ob, 'counter', {'id': ob, 'status': 'open', 'pending_counter': {'version': 2}, 'next_actions': []})})
    add('respond: counter with new texts', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'title': 'Shorter brief', 'description': 'Two sources.'},
        {**g('open_from_bob'), **post(ob, 'counter', {'id': ob, 'status': 'open', 'pending_counter': None, 'next_actions': []})})
    add('respond: counter pinned to terms that changed', 'valun_respond',
        {'deal_id': ob, 'action': 'counter', 'price': 16, 'expected_terms_hash': '00' * 32}, g('open_from_bob'))
    add('respond: counter with fractional hours', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'deliver_within_hours': 1.5}, g('open_from_bob'))
    om = D['open_mine']['id']
    add('respond: withdraw', 'valun_respond', {'deal_id': om, 'action': 'withdraw'},
        {**g('open_mine'), **post(om, 'withdraw', {'id': om, 'status': 'withdrawn'})})
    add('respond: accept my own offer (only theirs can be answered)', 'valun_respond', {'deal_id': om, 'action': 'accept'}, g('open_mine'))
    add('respond: unknown action', 'valun_respond', {'deal_id': ob, 'action': 'maybe'})
    add('respond: missing action', 'valun_respond', {'deal_id': ob})
    add('respond: misspelt action is a commitment, then refused', 'valun_respond', {'deal_id': ob, 'action': 'Accept'}, g('open_from_bob'))
    add('respond: accept an unknown deal (nothing to bind)', 'valun_respond', {'deal_id': 'vd_0000000000000000', 'action': 'accept'},
        {'GET /pilot/v1/deals/vd_0000000000000000': {'status': 404, 'body': {'error': 'not_found', 'message': 'no such deal'}}})
    add('respond: server reports offer_not_authorized', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {**g('open_from_bob'), **post(ob, 'accept', {'error': 'offer_not_authorized', 'message': "bob's owner no longer allows this offer"}, 409)})
    lh = D['open_lying_hash']['id']
    add('respond: accept terms that do not hash to the stated hash', 'valun_respond', {'deal_id': lh, 'action': 'accept'},
        {f'GET /pilot/v1/deals/{lh}': {'body': D['open_lying_hash']}})
    add('respond: accept when the server says I am the payee', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {f'GET /pilot/v1/deals/{ob}': {'body': D['open_role_lie']}, **post(ob, 'accept', {'id': ob, 'status': 'agreed', 'next_actions': []})})
    add('respond: accept when the server names another counterparty', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {f'GET /pilot/v1/deals/{ob}': {'body': D['open_other_counterparty']}, **post(ob, 'accept', {'id': ob, 'status': 'agreed', 'next_actions': []})})
    ut = D['open_untrusted_text']['id']
    add('respond: accept an offer with untrusted text', 'valun_respond', {'deal_id': ut, 'action': 'accept'},
        {**g('open_untrusted_text'), **post(ut, 'accept', {'id': ut, 'status': 'agreed', 'next_actions': []})})
    add('respond: counter an offer with untrusted text', 'valun_respond', {'deal_id': ut, 'action': 'counter', 'price': 21},
        {**g('open_untrusted_text'), **post(ut, 'counter', {'id': ut, 'status': 'open', 'pending_counter': None, 'next_actions': []})})
    add('respond: arguments that are not an object', 'valun_respond', ['vd_1111111111111111', 'accept'])
    # deliver (I am the payee on agreed_payee: 'at least 150 words')
    ap = D['agreed_payee']['id']
    notes = ' '.join(['note'] * 160)
    add('deliver: meets the terms', 'valun_deliver', {'deal_id': ap, 'content': notes, 'title': 'Notes'},
        {**g('agreed_payee'), **post(ap, 'deliver', {'id': ap, 'status': 'delivered', 'delivery': {'sha256': vc.sha256_hex(notes)}})})
    add('deliver: gate refuses a short draft', 'valun_deliver', {'deal_id': ap, 'content': 'Too short: only a few words here.'}, g('agreed_payee'))
    add('deliver: send_anyway', 'valun_deliver', {'deal_id': ap, 'content': 'Too short: only a few words here.', 'send_anyway': True},
        {**g('agreed_payee'), **post(ap, 'deliver', {'id': ap, 'status': 'delivered', 'delivery': {'sha256': vc.sha256_hex('Too short: only a few words here.')}})})
    add('deliver: send_anyway as the string "false" is still true', 'valun_deliver',
        {'deal_id': ap, 'content': 'Too short: only a few words here.', 'send_anyway': 'false'},
        {**g('agreed_payee'), **post(ap, 'deliver', {'id': ap, 'status': 'delivered', 'delivery': {'sha256': vc.sha256_hex('Too short: only a few words here.')}})})
    t9 = make_terms('vd_9999999999999999', 'bob', 'bob', 'alice', *BRIEF_TERMS, 20)
    D9 = agreed(deal_view(t9, 'bob', your_role='payee'), 'alice')
    g9 = {f"GET /pilot/v1/deals/{D9['id']}": {'body': D9}}
    add('deliver: gate refuses made-up and missing link hosts', 'valun_deliver', {'deal_id': D9['id'], 'content': FAKE_HOST_BRIEF}, g9)
    add('deliver: gate counts links and words of a brief', 'valun_deliver', {'deal_id': D9['id'], 'content': BAD_BRIEF}, g9)
    add('deliver: host checks off let the made-up host through', 'valun_deliver', {'deal_id': D9['id'], 'content': FAKE_HOST_BRIEF},
        {**g9, **post(D9['id'], 'deliver', {'id': D9['id'], 'status': 'delivered', 'delivery': {'sha256': vc.sha256_hex(FAKE_HOST_BRIEF)}})},
        agent={'check_link_hosts': False})
    add('deliver: no agreement yet', 'valun_deliver', {'deal_id': ob, 'content': notes, 'send_anyway': True}, g('open_from_bob'))
    add('deliver: missing content', 'valun_deliver', {'deal_id': ap}, g('agreed_payee'))
    # review (I am the payer)
    dg = D['delivered_good']
    dgt = f"GET /pilot/v1/deals/{dg['id']}/credit-note-template"
    issued = post(dg['id'], 'complete', {'id': dg['id'], 'status': 'note_issued', 'counterparty': {'handle': 'bob'},
                                         'credit_note': {'state': 'issued', 'amount': 20, 'tracker_status': 'recorded',
                                                         'tracker_note': {'amount_collected': 30, 'confirmation': 'local_only'}}})
    add('review: accept issues the note', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept', 'expected_deliverable_sha256': dg['delivery']['sha256']},
        {**g('delivered_good'), dgt: {'body': template(dg)}, **issued})
    add('review: accept held for my owner', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg)},
         **post(dg['id'], 'complete', {'id': dg['id'], 'status': 'completion_awaiting_owner', 'counterparty': {'handle': 'bob'},
                                       'credit_note': {'state': 'awaiting_owner', 'amount': 20}})})
    add('review: accept, the server refuses the note', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg)},
         **post(dg['id'], 'complete', {'error': 'stale_note', 'message': 'the prior total changed; ask for a new template'}, 409)})
    add('review: accept, the server is unreachable after signing (stays pending)', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg)},
         **post(dg['id'], 'complete', {'error': 'tracker_unavailable', 'message': 'try again'}, 503)})
    add('review: accept a changed delivery', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept', 'expected_deliverable_sha256': '11' * 32},
        g('delivered_good'))
    add('review: accept terms other than the ones reviewed', 'valun_review_delivery',
        {'deal_id': dg['id'], 'decision': 'accept', 'expected_deliverable_sha256': dg['delivery']['sha256'], 'expected_terms_hash': 'ee' * 32},
        g('delivered_good'))
    nb = D['delivered_not_by_payee']
    add('review: accept a delivery not signed by the payee', 'valun_review_delivery', {'deal_id': nb['id'], 'decision': 'accept'},
        {f"GET /pilot/v1/deals/{nb['id']}": {'body': nb}, dgt: {'body': template(nb)}})
    add('review: accept when my own record says more was issued', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg)}}, state={'issued': {PAIR_AB: 50}})
    pend = {'total': 30, 'timestamp': T0_MS - 60_000, 'kind': 'note', 'ref': dg['id'], 'direction': 'out', 'signed_at': '2026-11-06T11:59:00.000Z'}
    add('review: accept a deal my pending note may already have paid', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg, prior=30)}}, state={'records': {PAIR_AB: {'confirmed': None, 'pending': [pend]}}})
    held = {'total': 10, 'timestamp': T0_MS - 600_000, 'kind': 'note', 'ref': D['held_then_issued']['id'], 'direction': 'out',
            'signed_at': '2026-11-06T11:50:00.000Z'}
    add('review: a held note approved later is first confirmed from its deal', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **g('held_then_issued'), dgt: {'body': template(dg)}, **issued},
        state={'issued': {PAIR_AB: 0}, 'records': {PAIR_AB: {'confirmed': None, 'pending': [held]}}})
    pinned = {'pins': dict(PINS)}
    bound_info = {'GET /pilot/v1/info': {'body': dict(INFO, features=['bound_notes/1'])}}
    dgb = dgt + '?prior=1&bound=1'          # release v16: a server listing bound_notes/1 serves bound templates (PROTOCOL.md 18.5)
    my_prior = {'total': 10, 'timestamp': T0_MS - 600_000, 'signature': note_sig('alice', 'bob', 10, T0_MS - 600_000)}
    add('review: pinned profile, the server shows my prior note', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': bound_template(dg, prior_note=my_prior)}, **issued}, state=pinned)
    add('review: pinned profile, a prior note not signed by me', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info,
         dgb: {'body': bound_template(dg, prior_note=dict(my_prior, signature=note_sig('carol', 'bob', 10, T0_MS - 600_000)))}},
        state=pinned)
    add('review: pinned profile, a prior note older than my records', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': bound_template(dg, prior_note=my_prior)}},
        state=dict(pinned, records={PAIR_AB: {'confirmed': {'total': 5, 'timestamp': T0_MS - 300_000, 'signature': 'aa'}, 'pending': []}}))
    add('review: pinned profile, no edge yet (no prior note)', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': bound_template(dg, prior=0, prior_note=None)}, **issued}, state=pinned)
    add('review: bound template on an ordinary timestamp', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': bound_template(dg, prior_note=my_prior, ts=T0_MS - 1500)}}, state=pinned)
    add('review: bound features, but the template carries no prior note', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': template(dg, ts=T997)}}, state=pinned)
    add('review: bound note, the server refuses it (stale_note)', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **bound_info, dgb: {'body': bound_template(dg, prior_note=my_prior)},
         **post(dg['id'], 'complete', {'error': 'stale_note', 'message': "a bound credit note's prior_total must be the pair's current total"}, 409)},
        state=pinned)
    add('review: an edge a novation changed takes bound notes only (R12)', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), 'GET /pilot/v1/info': {'body': dict(INFO, features=['circulation/1'])}, dgt: {'body': template(dg)}},
        state=dict(pinned, novated_edges={PAIR_AB: True}))
    add('review: pinned profile, a template timestamp in the reserved residues', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), 'GET /pilot/v1/info': {'body': dict(INFO, features=['circulation/1'])}, dgt: {'body': template(dg, ts=T0_MS - 1003)}},
        state=pinned)
    add('review: pinned profile, an empty feature list keeps the 0.3 rules', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), 'GET /pilot/v1/info': {'body': dict(INFO, features=[])}, dgt: {'body': template(dg, ts=T0_MS - 1003)}, **issued},
        state=pinned)
    add('review: pinned profile, malformed features count as advertised', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), 'GET /pilot/v1/info': {'body': dict(INFO, features='bound_notes/1')}, dgt: {'body': template(dg, ts=T0_MS - 1001)}},
        state=pinned)
    add('review: pinned profile, the server names another tracker', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), 'GET /pilot/v1/info': {'body': dict(INFO, tracker_nft_id=OTHER_NFT)}}, state=pinned)
    add('review: unpinned profile, a template timestamp ending in 999 (0.3 rules)', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), dgt: {'body': template(dg, ts=T0_MS - 1001)}, **issued})
    add('review: dispute without a reason', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'dispute'})
    sw = D['sandbox_wrong']
    add('review: dispute', 'valun_review_delivery', {'deal_id': sw['id'], 'decision': 'dispute', 'reason': 'The word count does not match the exact text-stats.'},
        {**g('sandbox_wrong'), **post(sw['id'], 'dispute', {'id': sw['id'], 'status': 'disputed'})})
    add('review: missing decision', 'valun_review_delivery', {'deal_id': dg['id']})
    add('review: misspelt decision is a commitment, then refused before connecting', 'valun_review_delivery',
        {'deal_id': dg['id'], 'decision': 'Accept'}, g('delivered_good'))
    add('review: misspelt decision, not enrolled', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'approve'}, store='unenrolled')
    add('review: decision of the wrong type', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': True}, g('delivered_good'))
    add('review: accept a sandbox result that does not match', 'valun_review_delivery', {'deal_id': D['sandbox_wrong']['id'], 'decision': 'accept'},
        g('sandbox_wrong'))
    add('review: accept when the server says I am the payee', 'valun_review_delivery', {'deal_id': D['sandbox_wrong_as_payee']['id'], 'decision': 'accept'},
        g('sandbox_wrong_as_payee'))
    add('review: accept as the payee (only the payer accepts)', 'valun_review_delivery', {'deal_id': D['delivered_to_me']['id'], 'decision': 'accept'},
        g('delivered_to_me'))
    # ---------- circulating credit (server release v16): pay_with, exact_result, consents, the new status and deal fields ----------
    circ = {'GET /pilot/v1/info': {'body': CIRC_INFO}}
    circ_me = {'GET /pilot/v1/me': {'body': me_circ()}}
    claim_fa = (30, T0_MS - 900_000 + 1)
    fa_edges = {'GET /pilot/v1/edges?since=0': {'body': edges_view(incoming=[('frank', 'alice', state_of('frank', 'alice', *claim_fa))],
                                                                    outgoing=[('alice', 'bob', state_of('alice', 'bob', 10, T0_MS - 600_000))],
                                                                    next_seq=2)}}
    po = f"GET /pilot/v1/deals/{dg['id']}/payment-options"
    tt = f"GET /pilot/v1/deals/{dg['id']}/transfer-template?issuer={ID['frank']}"
    pay_routes = {**g('delivered_good'), **circ, **circ_me, po: {'body': payment_options(dg)}, tt: {'body': transfer_template(dg, claim=claim_fa)}}
    paid_view = dict(dg, status='paid_by_transfer', counterparty={'id': ID['bob'], 'handle': 'bob'},
                     payment={'route': 'transfer', 'transfer_id': 'vt_1212121212121212', 'state': 'applied',
                              'issuer': {'id': ID['frank'], 'handle': 'frank'}, 'amount': 20})
    pbt = lambda body, status=200: post(dg['id'], 'pay-by-transfer', body, status)   # noqa: E731
    circ_state = {'pins': dict(PINS), 'consent_policy': dict(POLICY)}
    pw = {'deal_id': dg['id'], 'decision': 'accept', 'pay_with': 'frank'}
    add('review: pay with a held note (frank), applied', 'valun_review_delivery', pw, {**pay_routes, **pbt(paid_view)}, state=circ_state)
    add('review: pay with a held note by participant id, the transfer collects signatures', 'valun_review_delivery',
        dict(pw, pay_with=' ' + ID['frank'].upper() + ' '),
        {**pay_routes, **pbt(dict(paid_view, status='paying_by_transfer', payment=dict(paid_view['payment'], state='collecting')))},
        state=circ_state)
    add('review: pay with a held note, the transfer did not apply (payment_due)', 'valun_review_delivery', pw,
        {**pay_routes, **pbt(dict(paid_view, status='payment_due', payment=dict(paid_view['payment'], state='failed')))}, state=circ_state)
    add('review: pay with a held note, the server refuses it', 'valun_review_delivery', pw,
        {**pay_routes, **pbt({'error': 'issuer_refused', 'message': 'the issuer does not take part'}, 409)}, state=circ_state)
    add('review: pay with a held note, the server is unreachable after signing', 'valun_review_delivery', pw,
        {**pay_routes, **pbt({'error': 'tracker_unavailable', 'message': 'try again'}, 503)}, state=circ_state)
    add('review: pay with a held note the options do not list', 'valun_review_delivery', dict(pw, pay_with='erin'), pay_routes, state=circ_state)
    add('review: pay with a held note on a server without circulating credit', 'valun_review_delivery', pw,
        {**g('delivered_good'), po: {'body': payment_options(dg)}}, state=circ_state)
    add('review: pay with a held note, my claim changed after the owner saw it', 'valun_review_delivery',
        dict(pw, expected_claim_total=25, expected_quote_digest=transfer_template(dg, claim=claim_fa)['quote_digest'],
             expected_deliverable_sha256=dg['delivery']['sha256']), {**pay_routes, **pbt(paid_view)}, state=circ_state)
    add('review: pay with a held note, another quote than the one approved', 'valun_review_delivery',
        dict(pw, expected_quote_digest='ab' * 32), {**pay_routes, **pbt(paid_view)}, state=circ_state)
    add('review: pay_with that is not text', 'valun_review_delivery', dict(pw, pay_with=7), pay_routes, state=circ_state)
    add('review: pay_with own_note issues my own credit note', 'valun_review_delivery', dict(pw, pay_with='OWN_NOTE'),
        {**g('delivered_good'), dgt: {'body': template(dg)}, **issued})
    add('review: pay with a held note, the template names another issuer key', 'valun_review_delivery', pw,
        {**pay_routes, tt: {'body': dict(transfer_template(dg, claim=claim_fa),
                                         issuer={'id': ID['frank'], 'handle': 'frank', 'pubkey': K['erin']['pubkey']})}},
        state=circ_state)
    att = {'deal_id': dg['id'], 'route': 'note', 'edge': PAIR_AB, 'prior': 10, 'prior_timestamp': T0_MS - 600_000,
           'prior_signature': note_sig('alice', 'bob', 10, T0_MS - 600_000), 'total': 30, 'timestamp': T0_MS - 120_000 - 3,
           'quote_digest': None, 'signed_at': '2026-11-06T11:58:00.000Z'}
    add('review: pay with a held note while my own bound note of the deal can still apply (D-1)', 'valun_review_delivery', pw,
        {**pay_routes, **fa_edges}, state=dict(circ_state, transfer_attempts={dg['id']: [att]}))
    # bound notes on a circulation server, with the D-1 read-back
    add('review: bound note while a transfer of the deal can still apply (D-1, one read-back)', 'valun_review_delivery',
        {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **circ, dgb: {'body': bound_template(dg, prior_note=my_prior)}, **fa_edges},
        state=dict(circ_state, transfer_attempts={dg['id']: [{'deal_id': dg['id'], 'route': 'transfer', 'edge': edge('frank', 'alice'),
                                                              'prior': 30, 'prior_timestamp': claim_fa[1],
                                                              'prior_signature': state_of('frank', 'alice', *claim_fa)['signature'],
                                                              'total': 10, 'timestamp': T0_MS - 300_000 - 1,
                                                              'quote_digest': 'cd' * 32, 'signed_at': '2026-11-06T11:55:00.000Z'}]}))
    old_ts = T0_MS - nv.MAX_AGE_MS - nv.FALLBACK_MARGIN_MS - 10_000 - 1          # ends in 999: a transfer attempt, past its window
    old_claim = (30, T0_MS - 5_000_000 + 1)                                       # older than the attempt
    add('review: bound note after an old transfer attempt: one read-back shows it did not apply (D-1)', 'valun_review_delivery',
        {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **circ, dgb: {'body': bound_template(dg, prior_note=my_prior)}, **issued,
         'GET /pilot/v1/edges?since=0': {'body': edges_view(incoming=[('frank', 'alice', state_of('frank', 'alice', *old_claim))], next_seq=1)}},
        state=dict(circ_state, transfer_attempts={dg['id']: [{'deal_id': dg['id'], 'route': 'transfer', 'edge': edge('frank', 'alice'),
                                                              'prior': 30, 'prior_timestamp': old_claim[1],
                                                              'prior_signature': state_of('frank', 'alice', *old_claim)['signature'],
                                                              'total': 10, 'timestamp': old_ts,
                                                              'quote_digest': 'cd' * 32, 'signed_at': '2026-11-06T10:55:00.000Z'}]}))
    add('review: bound note on a circulation server, issued', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **circ, dgb: {'body': bound_template(dg, prior_note=my_prior)}, **issued}, state=circ_state)
    add('review: a deal my records show paid is never paid again', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), **circ, dgb: {'body': bound_template(dg, prior_note=my_prior)}},
        state=dict(circ_state, records={'paid_deals': {dg['id']: {'route': 'transfer', 'edge': edge('frank', 'alice'), 'total': 10,
                                                                   'timestamp': T0_MS - 300_000 - 1}}}))
    # exact_result (I am the payee of a text-stats job sandbox-exact asked for)
    t10 = make_terms('vd_aaaaaaaaaaaaaaaa', 'carol', 'carol', 'alice', 'text-stats job', STATS_DESC, 'The exact text-stats result as JSON.', 3)
    a10 = agreed(deal_view(t10, 'carol', your_role='payee', other='carol'), 'alice')
    exact_content = vs.render('text-stats', vs.text_stats(STATS_TEXT), STATS_TEXT)
    g10 = {f"GET /pilot/v1/deals/{a10['id']}": {'body': a10}}
    add('deliver: exact_result of a text-stats job', 'valun_deliver', {'deal_id': a10['id'], 'exact_result': True},
        {**g10, **post(a10['id'], 'deliver', {'id': a10['id'], 'status': 'delivered', 'delivery': {'sha256': vc.sha256_hex(exact_content)}})})
    add('deliver: exact_result of a job that is not text-stats or notary', 'valun_deliver', {'deal_id': ap, 'exact_result': True}, g('agreed_payee'))
    add('deliver: exact_result with content', 'valun_deliver', {'deal_id': a10['id'], 'exact_result': True, 'content': 'x' * 300}, g10)
    add('deliver: exact_result that is not a boolean', 'valun_deliver', {'deal_id': a10['id'], 'exact_result': 'yes'}, g10)
    add('deliver: exact_result false needs content', 'valun_deliver', {'deal_id': a10['id'], 'exact_result': False}, g10)
    # status and deal with circulating credit
    pos = {'claims_held': 30, 'owes': 10, 'net': 20, 'cleared_by_setoff': 2,
           'claims': [{'from': 'frank', 'issuer_id': ID['frank'], 'issuer_pubkey': K['frank']['pubkey'], 'amount': 30}],
           'debts': [{'to': 'bob', 'amount': 10}],
           'spendable_notes': [{'issuer_id': ID['frank'], 'issuer_handle': 'frank', 'issuer_pubkey': K['frank']['pubkey'], 'spendable': 30,
                                'issuer_consents': 'auto'},
                               {'issuer_id': ID['erin'], 'issuer_handle': 'erin', 'issuer_pubkey': K['erin']['pubkey'], 'spendable': 4,
                                'issuer_consents': 'when_online'}],
           'pending': {'consents_waiting_for_you': 1}}
    box = dict(INBOX, consents_waiting_for_your_client=2, payments_in_progress=[{'deal_id': 'vd_1212121212121212', 'state': 'collecting'}])
    status_routes = {**circ, 'GET /pilot/v1/me': {'body': me_circ(position=pos)}, 'GET /pilot/v1/inbox': {'body': box}, **fa_edges}
    log = [{'at': '2026-11-06T11:5%d:00.000Z' % n, 'id': 'vs_5e70ff5e70ff5e70', 'kind': 'setoff', 'role': 'member', 'decision': 'signed',
            'code': None, 'deal_id': None, 'amount': n, 'your_net_change_PC': 0} for n in range(7)]
    add('status: circulating credit, notes you can spend', 'valun_status', {}, status_routes,
        state=dict(circ_state, consent_log=log, consents_last_run_ms=T0_MS - 10_000), agent=ask)
    add('status: circulating credit, the edges cannot be read', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/edges?since=0': {'status': 500, 'body': {'error': 'internal', 'message': 'down'}},
         'GET /pilot/v1/inbox': {'status': 503, 'body': {'error': 'busy', 'message': 'later'}},
         'GET /pilot/v1/me': {'body': me_circ(position={k: v for k, v in pos.items() if k != 'spendable_notes'})}},
        state=dict(circ_state, consent_policy=POLICY_OFF))
    add('status: circulating credit, a profile not pinned yet', 'valun_status', {}, status_routes)
    sb = {'sandbox_only': True, 'joined_at': '2026-11-06T11:58:00.000Z'}
    add('status: sandbox tour, the welcome job is on its way', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position={'claims_held': 0, 'owes': 0, 'net': 0}, participant=sb)},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[])}}, state=circ_state)
    add('status: sandbox tour, the welcome job to deliver', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position={'claims_held': 0, 'owes': 0, 'net': 0}, participant=sb)},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[], deliver=[{'deal_id': a10['id'], 'counterparty': 'sandbox-exact'}])}},
        state=circ_state)
    sx = {'claims_held': 3, 'owes': 0, 'net': 3, 'claims': [{'from': 'sandbox-exact', 'amount': 3}], 'debts': [],
          'spendable_notes': [{'issuer_id': ID['carol'], 'issuer_handle': 'sandbox-exact', 'issuer_pubkey': K['carol']['pubkey'], 'spendable': 3}]}
    add('status: sandbox tour, step 2 buys with a note I hold', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position=sx, participant=sb)}, 'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[])}},
        state=circ_state)
    sw_ = D['sandbox_right']
    add('status: sandbox tour, a delivery to review that matches exactly', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position=sx, participant=sb)}, **g('sandbox_right'),
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[], review_delivery=[{'deal_id': sw_['id'], 'counterparty': 'sandbox-exact'}])}},
        state=circ_state)
    add('status: sandbox tour, a delivery to review that is wrong', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position=sx, participant=sb)}, **g('sandbox_wrong'),
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[], review_delivery=[{'deal_id': D['sandbox_wrong']['id'], 'counterparty': 'sandbox-exact'}])}},
        state=circ_state)
    add('status: sandbox tour, a set-off is due', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position=dict(sx, owes=1, debts=[{'to': 'sandbox-exact', 'amount': 1}]), participant=sb)},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[])}}, state=circ_state)
    add('status: sandbox tour, my owner must approve first', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position=sx, participant=sb)},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[], awaiting_your_owner=[{'deal_id': 'vd_1313131313131313', 'counterparty': 'bob'}])}},
        state=circ_state)
    add('status: sandbox tour, an offer above the published price', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position={'claims_held': 0, 'owes': 0}, participant=sb)},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[{'deal_id': 'vd_1414141414141414', 'counterparty': 'sandbox-mallory',
                                                               'your_role': 'payer', 'price': {'amount': 9, 'unit': 'PC'}}])}},
        state=circ_state)
    add('status: sandbox tour, complete', 'valun_status', {},
        {**status_routes, 'GET /pilot/v1/me': {'body': me_circ(position={'claims_held': 0, 'owes': 0, 'deals': {'paid_by_transfer': 2}},
                                                              participant={'sandbox_only': True, 'joined_at': '2026-11-01T00:00:00.000Z'})},
         'GET /pilot/v1/inbox': {'body': dict(INBOX, respond=[])}}, state=circ_state)
    pay_deal = dict(dg, payment=None)
    add('deal: delivered on a circulation server, how you can pay', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': pay_deal}, **circ, po: {'body': payment_options(dg, why_not=None)}}, state=circ_state)
    add('deal: payment options cannot be read', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': pay_deal}, **circ, po: {'status': 409, 'body': {'error': 'wrong_state', 'message': 'not payable'}}},
        state=circ_state)
    add('deal: paying by transfer (payer)', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': dict(paid_view, status='paying_by_transfer')}, **circ}, state=circ_state)
    add('deal: payment due (payer)', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': dict(paid_view, status='payment_due', payment=None)}, **circ,
         po: {'body': payment_options(dg, issuer=None, own=False)}}, state=circ_state)
    add('deal: payment due (payee)', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': dict(paid_view, status='payment_due', your_role='payee', payment=None)}, **circ},
        state=circ_state)
    add('deal: paid by transfer', 'valun_deal', {'deal_id': dg['id']}, {f"GET /pilot/v1/deals/{dg['id']}": {'body': paid_view}, **circ})
    add('deal: delivered, a server without circulation shows no payment key (no /info read)', 'valun_deal', {'deal_id': dg['id']},
        g('delivered_good'), state=circ_state)
    # consents: before a tool that is not read-only, and (consents_on_reads) the value-safe ones before status and inbox
    so = setoff_item()
    cons = lambda *items: {'GET /pilot/v1/consents': {'body': {'consents': list(items), 'recently_resolved': []}}}   # noqa: E731
    took = lambda iid, state='collecting', rejected=(): {f'POST /pilot/v1/consents/{iid}': {'body': {'id': iid, 'state': state,   # noqa: E731
                                                                                                    'rejected': list(rejected)}}}
    refuse = lambda iid: {f'POST /pilot/v1/consents/{iid}/refuse': {'body': {'id': iid, 'state': 'refused'}}}   # noqa: E731
    created_ = {'POST /pilot/v1/deals': {'body': {'id': 'vd_0101010101010101', 'status': 'open', 'current': {'terms_hash': 'ef' * 32}}}}
    add('propose: a due consent run signs a set-off first', 'valun_propose', brief,
        {**created_, **circ, **circ_me, **cons(so), **took(so['id'])}, state=circ_state)
    add('propose: a due consent run refuses a set-off over the cap and signs an issuer consent', 'valun_propose', brief,
        {**created_, **circ, **circ_me, **cons(setoff_item(iid='vs_5e70ff5e70ff5e71', amount=6), issuer_item()), **refuse('vs_5e70ff5e70ff5e71'),
         **took('vt_7a7a7a7a7a7a7a7a')}, state=dict(circ_state, consent_policy=dict(POLICY, max_PC=5)))
    add('propose: consents not due (a run less than a minute ago)', 'valun_propose', brief, {**created_, **circ, **cons(so)},
        state=dict(circ_state, consents_last_run_ms=T0_MS - 30_000))
    add('propose: a consent run on a server without circulating credit (one /info, nothing else)', 'valun_propose', brief, created_,
        state=circ_state)
    add('propose: a consent run that fails does not stop the tool', 'valun_propose', brief,
        {**created_, **circ, 'GET /pilot/v1/consents': {'status': 503, 'body': {'error': 'busy', 'message': 'later'}}}, state=circ_state)
    add('propose: a stale revision waits for a later run', 'valun_propose', brief,
        {**created_, **circ, **circ_me, **cons(so), **took(so['id'], rejected=[{'slot': f"{edge('bob', 'alice')}:new", 'code': 'stale_revision',
                                                                                  'revision': 2}])}, state=circ_state)
    add('propose: consents off for this agent (process_consents off)', 'valun_propose', brief, {**created_, **circ, **cons(so)},
        state=circ_state, agent={'process_consents': False})
    add('status: consents on reads sign a set-off (decision D-3 a)', 'valun_status', {},
        {**status_routes, **cons(so), **took(so['id'])}, state=circ_state, agent={'consents_on_reads': True})
    add('inbox: consents on reads leave an issuer consent for a full run', 'valun_inbox', {},
        {**circ, **circ_me, **cons(issuer_item(), so), **took(so['id'])}, state=circ_state, agent={'consents_on_reads': True})
    add('inbox: consents on reads, a set-off the cap refuses waits (nothing refused)', 'valun_inbox', {},
        {**circ, **circ_me, **cons(so)}, state=dict(circ_state, consent_policy=dict(POLICY, max_PC=5)), agent={'consents_on_reads': True})
    add('inbox: consents on reads, no value-safe role on: no consent request', 'valun_inbox', {}, {**circ, **cons(so)},
        state=dict(circ_state, consent_policy=dict(POLICY, setoff=False, as_new_creditor=False)), agent={'consents_on_reads': True})
    add('inbox: consents on reads, ran less than a minute ago', 'valun_inbox', {}, {**circ, **cons(so)},
        state=dict(circ_state, consents_last_safe_run_ms=T0_MS - 5_000), agent={'consents_on_reads': True})
    # D-3 a names valun_status and valun_inbox only: before the other read-only tools no consent run, even when one is due
    add('deal: consents on reads never run before valun_deal (a run due)', 'valun_deal', {'deal_id': dg['id']},
        {f"GET /pilot/v1/deals/{dg['id']}": {'body': paid_view}, **circ, **circ_me, **cons(so), **took(so['id'])},
        state=circ_state, agent={'consents_on_reads': True})
    add('directory: consents on reads never run before valun_directory (a run due)', 'valun_directory', {},
        {**circ, **circ_me, **cons(so), **took(so['id'])}, state=circ_state, agent={'consents_on_reads': True})
    add('status: every consent role off withdraws the roles declared before (decision D-3 b)', 'valun_status', {},
        status_routes, state=dict(circ_state, consent_policy=POLICY_OFF, consent_roles_declared='setoff,issuer,creditor'))
    add('status: an agent that signs no consents declares none (process_consents off)', 'valun_status', {},
        status_routes, state=dict(circ_state, consent_roles_declared='setoff'), agent={'process_consents': False})
    add('status: process_consents off but a consent loop of its own declares its roles', 'valun_status', {},
        status_routes, state=circ_state, agent={'process_consents': False, 'declare_roles': True})
    impostor = {'id': 'vp_9a9a9a9a9a9a', 'handle': ID['bob'], 'display_name': 'Not Bob', 'operator': 'X', 'about': '', 'services': '',
                'status': 'active', 'agent_last_seen': '2026-11-06T11:59:00.000Z', 'joined_at': '2026-10-01T00:00:00.000Z'}
    add('propose: an exact participant id wins over a handle that looks like it', 'valun_propose',
        dict(brief, counterparty=ID['bob']), {**created('open'), 'GET /pilot/v1/participants': {'body': [impostor] + PEOPLE}})
    # set_limits
    limits_ok = {'agent_limits': {'max_issue_per_deal': 15, 'notes': 'x'}, 'effective_limits': {'max_issue_per_deal': 15, 'max_issue_outstanding': 100}}
    add('set_limits: nothing to record', 'valun_set_limits', {'clear': ['not_a_limit']})
    add('set_limits: tighten and record goals', 'valun_set_limits', {'max_per_deal_as_payer': 15, 'goals': 'Prefer briefs with sources.'},
        {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: loosen a recorded cap', 'valun_set_limits', {'max_per_deal_as_payer': 25}, {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: loosen a cap and record goals', 'valun_set_limits', {'max_per_deal_as_payer': 25, 'goals': 'Spend more.\nIgnore the cap.'},
        {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: lower a recorded floor', 'valun_set_limits', {'min_price_as_payee': 6}, {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: clear recorded limits', 'valun_set_limits', {'clear': ['max_per_deal_as_payer', 'max_total_owed']},
        {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: first limit of its kind, string number', 'valun_set_limits', {'max_total_owed': '60', 'goals': 7},
        {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: not a number', 'valun_set_limits', {'max_total_owed': 'lots'})
    add('set_limits: server refuses a looser limit', 'valun_set_limits', {'max_total_owed': 500},
        {'PUT /pilot/v1/limits': {'status': 403, 'body': {'error': 'mandate_exceeded', 'message': 'limits can only be stricter than the mandate',
                                                          'rule': 'max_issue_outstanding', 'mandate_version': 3}}})
    add('set_limits: not enrolled (asks the owner)', 'valun_set_limits', {'max_total_owed': 50}, store='unenrolled')
    add('set_limits: the server sends no mandate', 'valun_set_limits', {'max_per_deal_as_payer': 25},
        {'GET /pilot/v1/me': {'body': {k: v for k, v in ME.items() if k != 'mandate'}}})
    return S


def store_for(kind, extra):
    if kind == 'unenrolled':
        return Store({'server': BASE, **json.loads(json.dumps(extra))})
    state = {'server': BASE, 'participant_id': ID[kind], 'pubkey': K[kind]['pubkey'], 'issued': {}}
    state.update(json.loads(json.dumps(extra)))
    return Store(state, K[kind]['secret'], TOKEN)


def run_scenarios():
    out = []
    for sc in scenarios():
        record = dict(sc)
        for what in ('call', 'is_commitment', 'prepare', 'describe', 'bind', 'describe_bound'):
            ROUTES.clear()
            ROUTES.update(base_routes())
            ROUTES.update(sc['routes'])
            LOG.clear()
            SENT.clear()
            SIGNED.clear()
            COUNTS.clear()
            RANDOM[0] = 0
            store = store_for(sc['store'], sc['state'])
            ag = va.ValunAgent(store, approvals=sc['agent'].get('approvals', ''), check_link_hosts=sc['agent'].get('check_link_hosts', True),
                               setup_hint=sc['agent'].get('setup_hint'), process_consents=sc['agent'].get('process_consents', True),
                               consents_on_reads=sc['agent'].get('consents_on_reads', False),
                               declare_roles=sc['agent'].get('declare_roles'))
            if what == 'call':
                record['result'] = ag.call_safe(sc['tool'], sc['args'])
                record['requests'] = list(LOG)
                record['signed'] = list(SENT)
                record['state_after'] = unsigned(store.state)
            elif what == 'is_commitment':
                try:
                    record['is_commitment'] = ag.is_commitment(sc['tool'], sc['args'])
                except Exception as e:  # noqa: BLE001
                    record['is_commitment'] = {'raises': type(e).__name__}
            elif what == 'prepare':       # every call: adapters ask with this text (None: run without asking) or refuse
                record['prepare'] = outcome(lambda: ag.prepare(sc['tool'], sc['args']))
                record['prepare_requests'] = list(LOG)
                record['prepare_or_refusal'] = list(ag.prepare_or_refusal(sc['tool'], sc['args']))
            elif record['is_commitment'] is not True:
                continue                  # adapters bind and describe only commitments
            elif what == 'describe':
                record['describe'] = outcome(lambda: ag.describe_commitment(sc['tool'], sc['args']))
            elif what == 'bind':
                record['bound'] = outcome(lambda: ag.bind(sc['tool'], sc['args']))
                record['bind_requests'] = list(LOG)
            elif 'value' in record['bound']:    # what an adapter that binds shows the owner: the text for the bound arguments
                record['describe_bound'] = outcome(lambda: ag.describe_commitment(sc['tool'], record['bound']['value']))
            if what != 'call':
                assert not SIGNED, f"{sc['name']}: {what} signed something"
        out.append(json.loads(json.dumps(record, default=str)))
    return out


# ---------- novation.py: the decision table of python/tests/test_novation.py, every case with its whole result ----------
TESTS = os.path.abspath(os.path.join(SRC, '..', 'tests'))


def has_float(v):
    if isinstance(v, float):
        return True
    if isinstance(v, dict):
        return any(has_float(x) for x in v.values())
    if isinstance(v, (list, tuple)):
        return any(has_float(x) for x in v)
    return False


def novation_cases():
    """Every case of test_novation.CASES (the evaluators' decision table: 141 cases, every refusal code): the item, the
    context (verify aside: the Basis verifier) and the whole result, {ok, code, to_sign, summary, write_ahead}."""
    sys.path.insert(0, TESTS)
    try:
        import test_novation as tn  # noqa: E402
    finally:
        sys.path.remove(TESTS)
    out = []
    for name, fn, make_item, make_ctx, expected in tn.CASES:
        it, ctx = make_item(), make_ctx()
        r = fn(json.loads(json.dumps(it)), dict(ctx))
        assert r['code'] == expected, name
        out.append({'name': name, 'evaluator': fn.__name__, 'item': it, 'ctx': {k: v for k, v in ctx.items() if k != 'verify'},
                    'result': r, 'floats': has_float([it, ctx])})
    return out


def novation_helpers():
    """attempt_outcome, unbound_note_problem, exact_prior and shown_id for a few inputs."""
    edge_ab = PAIR_AB
    att = {'deal_id': 'vd_4444444444444444', 'route': 'transfer', 'edge': edge_ab, 'prior': 10, 'prior_timestamp': T0_MS - 600_000,
           'prior_signature': note_sig('alice', 'bob', 10, T0_MS - 600_000), 'total': 30, 'timestamp': T0_MS - 120_000 - 1}
    note = dict(att, route='note', timestamp=T0_MS - 120_000 - 3)
    states = [None, {'total': 10, 'timestamp': T0_MS - 600_000}, {'total': 30, 'timestamp': att['timestamp']},
              {'total': 12, 'timestamp': T0_MS - 1000}, {'total': 0, 'timestamp': 0}]
    out = {'attempt_outcome': [[a, now, st, outcome(lambda a=a, now=now, st=st: nv.attempt_outcome(a, now, st))]
                               for a in (att, note, dict(att, outcome='applied'), dict(att, outcome='not_applied'))
                               for now in (T0_MS, T0_MS + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS) for st in states],
           'unbound_note_problem': [[e, nov, f, nv.unbound_note_problem(e, nov, f)]
                                    for e in (edge_ab,) for nov in (None, {}, {edge_ab: True}, [edge_ab], ['x'], 'bad', [3])
                                    for f in ([], ['circulation/1'], ['bound_notes/1', 'circulation/1'])],
           'shown_id': [[v, nv.shown_id(v)] for v in ('vd_0123456789abcdef', 'vt_0123456789abcdef', 'vs_0123456789abcdef', 'vp_0123456789ab',
                                                     'vd_0123456789ABCDEF', 'vd_0123456789abcdef\n', None, 5, '')],
           'exact_prior': [[a, st, outcome(lambda a=a, st=st: nv.exact_prior(a, st))] for a in (att, dict(att, prior=0, prior_timestamp=None,
                                                                                                         prior_signature=None))
                           for st in states + [dict(states[1], signature=att['prior_signature'])]]}
    return out


def client_helpers():
    """consent_roles(), the capability header (features_header) and the agent's consent helpers."""
    policies = [None, [], {}, {'setoff': True}, {'setoff': 1}, {'setoff': True, 'as_issuer': True, 'as_new_creditor': True},
                {'as_new_creditor': True, 'as_issuer': 'yes'}, dict(POLICY_OFF)]
    headers = []
    for adv in ([], ['bound_notes/1'], ['circulation/1'], ['?']):
        for pol in (None, dict(POLICY), dict(POLICY_OFF), {'setoff': True}):
            for declared in (None, '', 'setoff', 5):
                for declare in (True, False):
                    st = {} if pol is None else {'consent_policy': pol}
                    if declared is not None:
                        st['consent_roles_declared'] = declared
                    c = vc.Client(Store(dict(st)), server=BASE, declare_roles=declare)
                    c._advertised = list(adv)
                    headers.append([adv, pol, declared, declare, c.features_header()])
    mandates = [None, {}, CIRC_FLAGS, dict(CIRC_FLAGS, may_accept_credit=False), dict(CIRC_FLAGS, auto_clear=False, accept_transfers=1),
                me_circ()['effective_limits']]
    local = [None, dict(POLICY), dict(POLICY_OFF), {'setoff': True, 'max_PC': 5, 'extra': 1}, {'as_new_creditor': True, 'max_PC': True}]
    in_force = [[lp, m, va.consent_policy_in_force(lp, m)] for lp in local for m in mandates]
    return {'consent_roles': [[p_, vc.consent_roles(p_)] for p_ in policies], 'features_header': headers,
            'consent_policy_in_force': in_force, 'client_signs': [[x[2], va.client_signs(x[2])] for x in in_force],
            'wants_consents': [[st, va.wants_consents(st)] for st in (None, [], {}, {'consent_policy': {}}, {'consent_policy': None},
                                                                     {'approved_payments': {}}, {'approved_payments': {'vd_1': 'x'}},
                                                                     {'transfer_attempts': {'vd_1': []}}, {'transfer_attempts': []})],
            'labels': [[c_, va.labels(c_)] for c_ in (True, False)],
            'features_of': [[i, va.features_of(i)] for i in (None, [], {}, {'features': None}, {'features': []}, {'features': ['circulation/1']},
                                                           {'features': 'circulation/1'}, {'features': [1]}, {'features': ['a', 'b']})]}


# ---------- Client methods of circulating credit that the agent tools do not reach, as Python runs them ----------
def client_scenarios():
    D = deals()
    dg = D['delivered_good']
    S = []

    def add(name, method, kwargs, routes=None, state=None, store='alice'):
        S.append({'name': name, 'method': method, 'kwargs': kwargs, 'routes': routes or {}, 'state': state or {}, 'store': store})

    circ = {'GET /pilot/v1/info': {'body': CIRC_INFO}}
    pinned = {'pins': dict(PINS)}
    # ---- sync_edges ----
    fa = state_of('frank', 'alice', 30, T0_MS - 900_000 + 1)
    ab = state_of('alice', 'bob', 30, T0_MS - 60_000)
    bad = {'total': 7, 'timestamp': T0_MS - 500_000, 'signature': note_sig('carol', 'alice', 7, T0_MS - 500_000)}   # not erin's
    jrow = lambda seq, kind, i, r, st: {'seq': seq, 'at': '2026-11-06T11:00:00.000Z', 'kind': kind, 'ref': dg['id'], 'edge': edge(i, r),   # noqa: E731
                                        'issuer_pubkey': K[i]['pubkey'], 'recipient_pubkey': K[r]['pubkey'], 'delta': 1,
                                        'total_after': st['total'], 'timestamp': st['timestamp'], 'signature': st['signature']}
    view = edges_view(incoming=[('frank', 'alice', fa), ('erin', 'alice', bad)], outgoing=[('alice', 'bob', ab)],
                      journal=[jrow(1, 'issue', 'alice', 'bob', ab), jrow(2, 'setoff', 'frank', 'alice', fa),
                               dict(jrow(3, 'issue', 'erin', 'alice', bad))], next_seq=3)
    view['incoming'].append('not a row')
    pend = {'total': 30, 'timestamp': T0_MS - 60_000, 'kind': 'note', 'ref': dg['id'], 'direction': 'out', 'signed_at': '2026-11-06T11:59:00.000Z'}
    add('sync_edges: verified rows and journal; a pending note promoted and its deal paid; bad rows rejected', 'sync_edges', {},
        {'GET /pilot/v1/edges?since=0': {'body': view}}, dict(pinned, records={PAIR_AB: {'confirmed': None, 'pending': [pend]}}))
    page = [jrow(n, 'issue', 'alice', 'bob', ab) for n in range(1, vc.EDGES_PAGE + 1)]
    add('sync_edges: reads pages of the journal until a short one, from journal_seq', 'sync_edges', {},
        {'GET /pilot/v1/edges?since=5': {'body': edges_view(outgoing=[('alice', 'bob', ab)], journal=page, next_seq=205)},
         'GET /pilot/v1/edges?since=205': {'body': edges_view(outgoing=[('alice', 'bob', ab)], journal=[jrow(206, 'transfer_out', 'alice', 'bob', ab)],
                                                              next_seq=206)}}, dict(pinned, journal_seq=5))
    add('sync_edges: a profile not pinned yet is pinned first', 'sync_edges', {},
        {'GET /pilot/v1/edges?since=0': {'body': edges_view(outgoing=[('alice', 'bob', ab)], next_seq=1)}})
    add('sync_edges: GET /edges not an object', 'sync_edges', {}, {'GET /pilot/v1/edges?since=0': {'body': ['x']}}, pinned)
    later = T0_MS + 40 * 24 * 3600 * 1000
    old = T0_MS - 1_000_000
    old_att = {'deal_id': 'vd_5555555555555555', 'route': 'transfer', 'edge': edge('frank', 'alice'), 'prior': 30,
               'prior_timestamp': fa['timestamp'], 'prior_signature': fa['signature'], 'total': 25, 'timestamp': res(old, 999),
               'quote_digest': 'ab' * 32, 'signed_at': '2026-11-06T11:40:00.000Z'}
    add('sync_edges: prunes R4 records, expired pending entries, dead attempts and old signatures', 'sync_edges', {'now_ms': later},
        {'GET /pilot/v1/edges?since=0': {'body': edges_view(incoming=[('frank', 'alice', state_of('frank', 'alice', 30, T0_MS - 2_000_000 + 1))],
                                                            outgoing=[('alice', 'bob', ab)], next_seq=0)}},
        dict(pinned, signed={edge('frank', 'alice'): {str(res(old, 999)): {'slots': {f"{edge('frank', 'alice')}:new": 25}}},
                             edge('alice', 'bob'): {str(later - 1000): {'slots': {f'{PAIR_AB}:new': 31}}}},
             records={edge('frank', 'alice'): {'confirmed': None, 'pending': [
                 {'total': 25, 'timestamp': res(old, 999), 'kind': 'transfer', 'ref': 'vd_5555555555555555', 'direction': 'in',
                  'signed_at': '2026-11-06T11:40:00.000Z'}]},
                      PAIR_AB: {'confirmed': {'total': 10, 'timestamp': T0_MS - 600_000, 'signature': note_sig('alice', 'bob', 10, T0_MS - 600_000)},
                                'pending': []}},
             transfer_attempts={'vd_5555555555555555': [old_att], 'vd_6666666666666666': ['malformed']}))
    # ---- payment attempts and their resolution by the owner (decision D-2 d) ----
    vt = 'vt_3c3c3c3c3c3c3c3c'
    t_att = dict(old_att, deal_id=dg['id'], timestamp=res(T0_MS - 300_000, 999), total=10, attempt_id=vt)
    t_att_noid = {k: v for k, v in t_att.items() if k != 'attempt_id'}
    n_pend = {'total': 30, 'timestamp': T0_MS - 200_000 + 3, 'kind': 'note', 'ref': dg['id'], 'direction': 'out', 'signed_at': '2026-11-06T11:57:00.000Z'}
    att_state = dict(pinned, transfer_attempts={dg['id']: [t_att]}, records={PAIR_AB: {'confirmed': None, 'pending': [n_pend]}})
    tview = lambda state, deal=dg['id'], roles=('payer',), ts=t_att['timestamp'], total=10: {   # noqa: E731
        'id': vt, 'kind': 'transfer', 'state': state, 'your_roles': list(roles), 'timestamp': ts, 'amount': 20,
        'deal': {'deal_id': deal}, 'edges': [{'edge': edge('frank', 'alice'), 'new_total': total}, {'edge': edge('frank', 'bob'), 'new_total': 20}]}
    tr_route = lambda state, **kw: {f'GET /pilot/v1/transfers/{vt}': {'body': tview(state, **kw)}}   # noqa: E731
    add('payment_attempts: a transfer attempt and a pending note of one deal, classified (no request)', 'payment_attempts', {}, {}, att_state)
    add('payment_attempts: with a read-back of my edges', 'payment_attempts',
        {'edges': {edge('frank', 'alice'): fa}, 'doubtful': [], 'now_ms': T0_MS + 4_000_000}, {}, att_state)
    add('resolution_plan: a transfer the server holds as outcome_unknown', 'resolution_plan', {'deal_id': dg['id'], 'attempt': '#1'},
        {**circ, **tr_route('outcome_unknown')}, att_state)
    add('resolution_plan: by the server id of a transfer my records do not hold', 'resolution_plan', {'deal_id': dg['id'], 'attempt': vt},
        {**circ, **tr_route('outcome_unknown')}, dict(att_state, transfer_attempts={dg['id']: [t_att_noid]}))
    add('resolution_plan: a transfer still collecting', 'resolution_plan', {'deal_id': dg['id'], 'attempt': '#1'},
        {**circ, **tr_route('collecting')}, att_state)
    add('resolution_plan: another deal\'s transfer', 'resolution_plan', {'deal_id': dg['id'], 'attempt': '#1'},
        {**circ, **tr_route('outcome_unknown', deal='vd_0000000000000000')}, att_state)
    add('resolution_plan: a credit note (local only)', 'resolution_plan', {'deal_id': dg['id'], 'attempt': '#2'}, circ, att_state)
    add('resolution_plan: no such attempt', 'resolution_plan', {'deal_id': dg['id'], 'attempt': '#9'}, circ, att_state)
    add('resolution_plan: a malformed deal id', 'resolution_plan', {'deal_id': 'vd_x', 'attempt': '#1'}, circ, att_state)
    resolved = {f"POST /pilot/v1/owner/deals/{dg['id']}/attempts/{vt}/resolve": {'body': {
        'resolution': {'attempt_id': vt, 'outcome': 'applied', 'previous_state': 'outcome_unknown', 'at': '2026-11-06T12:00:00.000Z',
                       'note': 'bob confirmed'},
        'attempt': {'id': vt, 'kind': 'transfer', 'timestamp': t_att['timestamp']}, 'deal': {'id': dg['id'], 'status': 'paid_by_transfer'},
        'transfer': tview('applied')}}}
    owner_ok = {'GET /pilot/v1/owner': {'body': {'participant': {'id': ID['alice'], 'handle': 'alice'}}}}
    add('resolve_attempt: the server resolves a transfer as applied; my records follow', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'applied', 'owner_token': ' vpo_TEST-owner ', 'note': '  bob confirmed '},
        {**circ, **tr_route('outcome_unknown'), **resolved}, att_state)
    add('resolve_attempt: the server answers 404 to a token that is not the owner\'s', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'not_applied', 'owner_token': 'vpa_agent'},
        {**circ, **tr_route('outcome_unknown'),
         f"POST /pilot/v1/owner/deals/{dg['id']}/attempts/{vt}/resolve": {'status': 404, 'body': {'error': 'not_found', 'message': 'no such route'}},
         'GET /pilot/v1/owner': {'status': 404, 'body': {'error': 'not_found', 'message': 'no such route'}}}, att_state)
    add('resolve_attempt: the server holds it as ended (wrong_state), local resolution possible', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'not_applied', 'owner_token': 'vpo_TEST-owner'},
        {**circ, **tr_route('outcome_unknown'), **owner_ok,
         f"POST /pilot/v1/owner/deals/{dg['id']}/attempts/{vt}/resolve": {'status': 409, 'body': {'error': 'wrong_state', 'message': 'it ended'}}},
        att_state)
    # valun-app SV-AUTH-1: 'applied' while the payee's edge does not show the transfer is 409 payee_edge_not_applied {payee_edge}
    for p_edge in ('moved_past', None):
        refusal = {'error': 'payee_edge_not_applied', 'message': "the payee's edge does not show this transfer"}
        add(f"resolve_attempt: applied, refused while the payee's edge does not show it (payee_edge {p_edge})", 'resolve_attempt',
            {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'applied', 'owner_token': 'vpo_TEST-owner'},
            {**circ, **tr_route('outcome_unknown'), **owner_ok,
             f"POST /pilot/v1/owner/deals/{dg['id']}/attempts/{vt}/resolve": {'status': 409, 'body': (
                 refusal if p_edge is None else dict(refusal, payee_edge=p_edge))}},
            att_state)
    add('resolve_attempt: a credit note resolved in my records only (not applied)', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#2', 'outcome': 'not_applied', 'owner_token': 'vpo_TEST-owner'},
        {**circ, **owner_ok, **{f"GET /pilot/v1/deals/{dg['id']}": {'body': dg}}}, att_state)
    add('resolve_attempt: a transfer whose server id I never recorded needs local_only', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'not_applied', 'owner_token': 'vpo_TEST-owner'},
        {**circ, **owner_ok}, dict(att_state, transfer_attempts={dg['id']: [t_att_noid]}))
    add('resolve_attempt: local_only for a transfer without a server id', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'not_applied', 'owner_token': 'vpo_TEST-owner', 'local_only': True},
        {**circ, **owner_ok}, dict(att_state, transfer_attempts={dg['id']: [t_att_noid]}))
    add('resolve_attempt: the attempts changed since the owner confirmed', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'applied', 'owner_token': 'vpo_TEST-owner',
         'expected_attempt': ['note', PAIR_AB, 30, n_pend['timestamp']]}, {**circ, **tr_route('outcome_unknown')}, att_state)
    add('resolve_attempt: the owner token of another participant', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#2', 'outcome': 'applied', 'owner_token': 'vpo_TEST-other'},
        {**circ, 'GET /pilot/v1/owner': {'body': {'participant': {'id': ID['bob'], 'handle': 'bob'}}},
         f"GET /pilot/v1/deals/{dg['id']}": {'body': dg}}, att_state)
    add('resolve_attempt: a note with a bidi character', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'applied', 'owner_token': 'vpo_TEST-owner', 'note': 'ok \u202e'}, circ, att_state)
    add('resolve_attempt: an outcome that is not one', 'resolve_attempt',
        {'deal_id': dg['id'], 'attempt': '#1', 'outcome': 'maybe', 'owner_token': 'vpo_TEST-owner'}, circ, att_state)
    # ---- cancel a transfer ----
    t_pend = {'total': 10, 'timestamp': t_att['timestamp'], 'kind': 'transfer', 'ref': dg['id'], 'direction': 'in',
              'signed_at': '2026-11-06T11:55:00.000Z'}
    add('cancel_transfer: payment_due forgets the pending entry and keeps the attempt', 'cancel_transfer', {'deal_id': dg['id']},
        {f"POST /pilot/v1/deals/{dg['id']}/cancel-transfer": {'body': {'id': dg['id'], 'status': 'payment_due'}}},
        dict(pinned, transfer_attempts={dg['id']: [t_att]}, records={edge('frank', 'alice'): {'confirmed': None, 'pending': [t_pend]}}))
    add('cancel_transfer: the server refuses', 'cancel_transfer', {'deal_id': dg['id']},
        {f"POST /pilot/v1/deals/{dg['id']}/cancel-transfer": {'status': 409, 'body': {'error': 'wrong_state', 'message': 'not collecting'}}},
        dict(pinned, transfer_attempts={dg['id']: [t_att]}, records={edge('frank', 'alice'): {'confirmed': None, 'pending': [t_pend]}}))
    # ---- consents ----
    so = setoff_item()
    me_r = {'GET /pilot/v1/me': {'body': me_circ()}}
    cons = lambda *items: {'GET /pilot/v1/consents': {'body': {'consents': list(items), 'recently_resolved': []}}}   # noqa: E731
    add('process_consents: an explicit policy argument signs a set-off', 'process_consents', {'policy': dict(POLICY)},
        {**circ, **me_r, **cons(so), f"POST /pilot/v1/consents/{so['id']}": {'body': {'id': so['id'], 'state': 'applied', 'rejected': []}}}, pinned)
    add('process_consents: value_safe_only leaves an issuer consent alone', 'process_consents', {'value_safe_only': True},
        {**circ, **me_r, **cons(issuer_item(), so), f"POST /pilot/v1/consents/{so['id']}": {'body': {'id': so['id'], 'state': 'collecting',
                                                                                                     'rejected': []}}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('process_consents: the server refuses the signatures (4xx): the pending entries are forgotten', 'process_consents', {},
        {**circ, **me_r, **cons(so), f"POST /pilot/v1/consents/{so['id']}": {'status': 409, 'body': {'error': 'stale_item', 'message': 'gone'}}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('process_consents: items not collecting, without an id, or already signed wait', 'process_consents', {},
        {**circ, **me_r, **cons(setoff_item(iid='vs_0000000000000001', state='applying'), {'kind': 'setoff'},
                                  dict(setoff_item(iid='vs_0000000000000002'), edges=[dict(e, signed_by_you=['new']) for e in so['edges']]))},
        dict(pinned, consent_policy=dict(POLICY)))
    add('process_consents: GET /consents is not an object', 'process_consents', {}, {**circ, 'GET /pilot/v1/consents': {'body': [1, 2]}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('process_consents: a server without circulating credit (only GET /info)', 'process_consents', {}, {},
        dict(pinned, consent_policy=dict(POLICY)))
    add('process_consents: the refusal cannot be sent', 'process_consents', {},
        {**circ, **me_r, **cons(setoff_item(iid='vs_0000000000000003', amount=60)),
         'POST /pilot/v1/consents/vs_0000000000000003/refuse': {'status': 503, 'body': {'error': 'busy', 'message': 'later'}}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('refuse_consent: with and without a reason', 'refuse_consent', {'consent_id': so['id'], 'reason': 'policy_cap'},
        {f"POST /pilot/v1/consents/{so['id']}/refuse": {'body': {'id': so['id'], 'state': 'refused'}}}, pinned)
    # ---- pay by transfer: the retry rules ----
    claim_fa = (30, T0_MS - 900_000 + 1)
    tpl1 = transfer_template(dg, claim=claim_fa)
    # the payee's claim on frank moved while the payment was posted: a fresh template, a second later (my claim unchanged)
    tpl2 = transfer_template(dg, claim=claim_fa, to_before=(5, res(T0_MS - 1500, 999) + 1), ts=res(T0_MS - 1500, 999) + 1000)
    po = f"GET /pilot/v1/deals/{dg['id']}/payment-options"
    tt = f"GET /pilot/v1/deals/{dg['id']}/transfer-template?issuer={ID['frank']}"
    pbt = f"POST /pilot/v1/deals/{dg['id']}/pay-by-transfer"
    base_pay = {f"GET /pilot/v1/deals/{dg['id']}": {'body': dg}, **circ, **me_r, po: {'body': payment_options(dg)}, tt: {'body': tpl1}}
    paid = dict(dg, status='paid_by_transfer', payment={'route': 'transfer', 'transfer_id': 'vt_4d4d4d4d4d4d4d4d', 'state': 'applied'})
    # audit VS-1: a fresh template at a new T is not signed while the first attempt can still apply
    add('pay_by_transfer: transfer_stale with a fresh template at a new T is refused (transfer_window_open)', 'pay_by_transfer',
        {'deal_id': dg['id'], 'issuer': 'frank'},
        {**base_pay, pbt: {'sequence': [{'status': 409, 'body': {'error': 'transfer_stale', 'message': 'the edges moved', 'template': tpl2}},
                                        {'body': paid}]}}, dict(pinned, consent_policy=dict(POLICY)))
    add('pay_by_transfer: transfer_stale with the same template is signed again once (the identical operation)', 'pay_by_transfer',
        {'deal_id': dg['id'], 'issuer': 'frank'},
        {**base_pay, pbt: {'sequence': [{'status': 409, 'body': {'error': 'transfer_stale', 'message': 'the edges moved', 'template': tpl1}},
                                        {'body': paid}]}}, dict(pinned, consent_policy=dict(POLICY)))
    add('pay_by_transfer: transfer_stale twice is raised', 'pay_by_transfer', {'deal_id': dg['id'], 'issuer': 'frank'},
        {**base_pay, pbt: {'status': 409, 'body': {'error': 'transfer_stale', 'message': 'the edges moved', 'template': tpl1}}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('pay_by_transfer: transfer_stale naming the transfer it recorded is not retried', 'pay_by_transfer',
        {'deal_id': dg['id'], 'issuer': 'frank'},
        {**base_pay, pbt: {'status': 409, 'body': {'error': 'transfer_stale', 'message': 'regenerated', 'transfer_id': 'vt_5e5e5e5e5e5e5e5e',
                                                   'regenerated_as': 'vt_6f6f6f6f6f6f6f6f', 'deal': dict(dg, status='paying_by_transfer')}}},
        dict(pinned, consent_policy=dict(POLICY)))
    add('pay_by_transfer: expected_claim_total that is not a whole number', 'pay_by_transfer',
        {'deal_id': dg['id'], 'issuer': 'frank', 'expected_claim_total': -1}, base_pay, pinned)
    add('pay_by_transfer: an issuer named by a handle two listed issuers have', 'pay_by_transfer', {'deal_id': dg['id'], 'issuer': 'twin'},
        {**base_pay, po: {'body': dict(payment_options(dg), held_notes=[
            dict(payment_options(dg)['held_notes'][0], issuer={'id': ID['frank'], 'handle': 'twin', 'pubkey': K['frank']['pubkey']}),
            dict(payment_options(dg)['held_notes'][0], issuer={'id': ID['erin'], 'handle': 'twin', 'pubkey': K['erin']['pubkey']})])}},
        pinned)
    return S


def run_client_scenarios():
    out = []
    for sc in client_scenarios():
        ROUTES.clear()
        ROUTES.update(base_routes())
        ROUTES.update(sc['routes'])
        LOG.clear()
        SENT.clear()
        SIGNED.clear()
        COUNTS.clear()
        RANDOM[0] = 0
        store = store_for(sc['store'], sc['state'])
        c = vc.Client(store)
        record = dict(sc)
        record['result'] = outcome(lambda: getattr(c, sc['method'])(**json.loads(json.dumps(sc['kwargs']))))
        record['requests'] = list(LOG)
        record['signed'] = list(SENT)
        record['state_after'] = unsigned(store.state)
        out.append(json.loads(json.dumps(record, default=str)))
    return out


# ---------- helper-level parity ----------
def records_table():
    """records.py, step by step: each step's call and outcome, and the records afterwards (real signatures, alice -> bob)."""
    alice, bob = K['alice']['pubkey'], K['bob']['pubkey']
    pair = f'{alice}>{bob}'
    st = lambda total, ts, signer='alice': {'total': total, 'timestamp': ts, 'signature': note_sig(signer, 'bob', total, ts)}   # noqa: E731
    verify = lambda i, r, t, ts, sig: vc.verify_note(i, r, t, ts, sig, NFT, DENOM)   # noqa: E731

    def broken(*a):
        raise RuntimeError('verifier down')
    steps = [
        ('add_pending', [pair, 20, 1000, 'note', 'vd_1', 'out', '2026-11-08T00:00:00.000Z']),
        ('add_pending', [pair, 20, 1000, 'note', 'vd_1', 'out', 'later']),
        ('add_pending', [pair, 10, 900, 'note', 'vd_0']),
        ('add_pending', [pair, 99, 1000, 'setoff', 'vs_1', 'in']),
        ('add_pending', [pair, 30, 3000, 'transfer', 'vt_1', 'out']),
        ('add_pending', [pair, True, 1, 'note']),
        ('add_pending', [pair, -1, 1, 'note']),
        ('add_pending', [pair, 1, 1.5, 'note']),
        ('add_pending', [pair, '1', 1, 'note']),
        ('add_pending', [pair, 1, 1, 'note', None, 'sideways']),
        ('remove_pending', [pair, 20, 1000, 'vd_other']),
        ('get', [pair]),
        ('confirmed_total', [pair]),
        ('confirm', [pair, st(20, 1000)]),
        ('confirm', [pair, st(5, 500)]),
        ('confirm', [pair, {'total': 5, 'timestamp': 1500}]),
        ('confirmed_total', [pair]),
        ('add_pending', [pair, 40, 4000, 'note', 'vd_4']),
        ('sync_edge', [{'edge': pair, **st(30, 3000), 'exact': True}]),
        ('sync_edge', [{'issuer_pubkey': alice, 'recipient_pubkey': bob, **st(50, 5000)}]),
        ('sync_edge', [{'edge': pair, **st(30, 3000)}]),
        ('sync_edge', [{'total': 1, 'timestamp': 1, 'signature': 's'}]),
        ('sync_edge', [{'edge': 'nokey', 'total': 1, 'timestamp': 1, 'signature': 's'}]),
        ('sync_edge', [{'edge': 'a>b>c', 'total': 1, 'timestamp': 1, 'signature': 's'}]),
        ('sync_edge', [{'edge': pair, 'total': '1', 'timestamp': 1, 'signature': 's'}]),
        ('sync_edge', [['not', 'a', 'row']]),
        ('prior_problem', [pair, st(50, 5000), alice, 'verify']),
        ('prior_problem', [pair, st(40, 4500), alice, 'verify']),
        ('prior_problem', [pair, st(51, 5000), alice, 'verify']),
        ('prior_problem', [pair, st(60, 6000), alice, 'verify']),
        ('prior_problem', [pair, st(60, 6000, signer='carol'), alice, 'verify']),
        ('prior_problem', [pair, st(60, 6000), bob, 'verify']),
        ('prior_problem', [pair, {'total': 60, 'timestamp': 6000}, alice, 'verify']),
        ('prior_problem', [pair, st(60, 6000), alice, 'broken']),
        ('prior_problem', ['nokey', st(60, 6000), alice, 'verify']),
        ('accept_prior', [pair, st(60, 6000), alice, 'verify']),
        ('edge_state', [st(1, 2)]),
        ('edge_state', [{'total': 1, 'timestamp': 2, 'signature': ''}]),
        ('pair_key', [alice, bob]),
    ]
    recs, out = {}, []
    for fn, args in steps:
        verifiers = {'verify': verify, 'broken': broken} if fn in ('prior_problem', 'accept_prior') else {}
        call_args = [verifiers[a] if isinstance(a, str) and a in verifiers else a for a in args]
        if fn in ('pair_key', 'edge_state'):
            res = outcome(lambda: getattr(vr, fn)(*call_args))
        else:
            res = outcome(lambda: getattr(vr, fn)(recs, *call_args))
        out.append({'fn': fn, 'args': args, 'outcome': json.loads(json.dumps(res)), 'records': json.loads(json.dumps(recs))})
    return out


def parity():
    """Helper-level outputs for many inputs."""
    P = {}
    texts = ['', 'One two-three, four.', "It's Bob’s 2nd draft -- 3x faster", 'Title\n=====\n\nOne two-three, four.\n---',
             'café naïve über', 'A' + chr(0x1c) + 'B' + chr(0x85) + 'C', '日本語 123']
    P['word_count'] = [[t, vm.word_count(t)] for t in texts]
    link_texts = [
        'See https://en.wikipedia.org/wiki/Decentralized_finance_(cryptocurrency)). And (https://bitcoin.org/bitcoin.pdf), '
        'plus [paper](https://arxiv.org/abs/2103.06749).',
        'HTTPS://Example.ORG/A? http://example.org/a?q=1&r=2#frag, https://example.org/a? https://example.org/a',
        'quoted "https://example.com/x" and `https://example.com/y` and <https://example.com/z> [https://example.com/w]',
        'odd http' + chr(0x17f) + '://long-s.example/x and htTp://mixed.example/ and https:// alone',
        'wrapped (see https://example.org/a_(b)_c).** done https://example.org/end!?;:',
        'space' + chr(0x2028) + 'https://x.example/a' + chr(0x85) + 'https://y.example/b' + chr(0x3000) + 'tail',
        'no links here', 'https://user@host.example:8080/path https://[::1]/v6',
    ]
    P['links'] = [[t, vm.links(t)] for t in link_texts]
    P['hosts'] = [[u, vm._host(u)] for t in link_texts for u in vm.links(t)]
    req_texts = ['Research brief. 300-500 word research brief with at least 3 cited sources each with a working-looking link',
                 'markdown, under 400 words, at least 2 links', 'at least 150 words', '300–500 words', '500 — 300 words',
                 '200 to 400 words', '200 TO 400 WORDS', 'minimum of 250 words; maximum 900 words', 'min. 80 words, max. 120 words',
                 'no fewer than 100 words and no more than 2000 words', 'up to 600 word summary', 'at most 99 words',
                 'a short note', '٣٠٠-٥٠٠ words', '３００ words at least ２ sources',
                 'at le' + chr(0x17f) + 't 120 word' + chr(0x17f), 'mInImum 300 words', 'm' + chr(0x131) + 'n' + chr(0x131) + 'mum 300 words',
                 'm' + chr(0x130) + 'n 50 words', 'at least 3 lin' + chr(0x212a) + 's', 'at least 2 linked  references',
                 'at least 4cited sources', 'at least 1 citations', 'at least 123 sources', '300' + chr(0x1c) + '-' + chr(0x85) + '500 words',
                 '12345678 words', '10-20words', '10 - 20 - words', 'between 300 and 500 words']
    P['requirements'] = [[t, vm.requirements(t)] for t in req_texts]
    terms = 'A 300-500 word research brief with at least 3 cited sources.'
    P['measure'] = []
    for text, tt, hosts in [
            (('word ' * 481) + ' See https://example.org/a, https://example.com/b and (https://made-up.invalid/c).', terms, True),
            ('word ' * 575, terms, False), ('word ' * 575, terms, True), ('', '', True), ('Only https://example.org/x', 'at least 2 sources', True),
            ('a b c https://intranet.example/x https://cgnat.example/ https://mapped.example/ https://mapped-public.example/ https://localhost.example/ '
             'https://docs.python.org/3/ https://nowhere.invalid/ https://another.invalid/', 'under 10 words, at least 5 links', True),
            (' '.join(f'https://h{i}.invalid/' for i in range(12)), 'at least 3 links', True),
            ('words ' * 20, 'at most 99 words', True)]:
        P['measure'].append({'text': text, 'terms': tt, 'check_hosts': hosts, 'out': vm.measure(text, tt, check_hosts=hosts)})
    P['dns'] = DNS
    import ipaddress
    addrs = ['8.8.8.8', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.32.0.1', '192.0.0.9',
             '192.0.0.10', '192.0.0.11', '192.0.0.170', '192.0.0.172', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.20.0.1', '203.0.113.9',
             '224.0.0.1', '240.0.0.1', '255.255.255.255', '0.0.0.0', '1.1.1.1', '::1', '::', '2001:4860:4860::8888', '2001:db8::1',
             '2001::1', '2001:1::1', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:30::1', '2001:40::1', '2002::1',
             '3fff::1', '3ffe::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '64:ff9b::808:808', '64:ff9b:1::1', '100::1',
             '100:0:0:1::1', '::ffff:8.8.8.8', '::ffff:10.0.0.1', '::ffff:100.64.0.1', '::8.8.8.8', '2606:4700::1111', '1:2:3:4:5:6:7:8']
    P['is_global'] = [[a, ipaddress.ip_address(a).is_global] for a in addrs]
    descs = ['text-stats for this text:\n```\nhello  world\nsecond line\n```\nthanks', '```text\nx\n```', 'no fence here',
             'a ```inline``` mention\n```\nreal\n```', 'x\r```\nnot at a line start\n```', 'x\n```\n\n```', '```\nunclosed',
             'stats please\nTEXT: line one\nline two', 'TEXT:   padded  ', 'intro\n  text :  lower label ' + chr(0x1c),
             'intro\nTEXT: one\nTEXT: two', 'intro TEXT: not after a newline', 'TEXT:\n\n', 'TEXT: ' + chr(0x3000) + 'x' + chr(0x85),
             'of “curly quoted”', 'compare "a" with "b"', 'compare "a" with “b”', 'just "one" here', '""', '"line\nbreak"',
             'emoji "\U0001F600\U0001F600"', 'long "' + ('\U0001F600' * 9000) + '"', 'long "' + ('x' * 16001) + '"', '', None]
    P['extract_text'] = [[d, vs.extract_text(d)] for d in descs]
    stats_texts = ['a\r\nb\rc\nd', 'x\vy\fz' + chr(0x1c) + 'w' + chr(0x1d) + 'v' + chr(0x1e) + 'u' + chr(0x1f) + 't',
                   'p' + chr(0x85) + 'q' + chr(0x2028) + 'r' + chr(0x2029) + 's', 'trailing\n\n', 'İstanbul ISTANBUL istanbul',
                   'b a c b a b ' + ' '.join(f'w{i}' for i in range(15)), 'Ａ \U0001F600 Ａ \U0001F600 z', 'A​B C' + chr(0x180e) + 'D',
                   '\x00 \x01 nul', 'tab\there\tand\t\tthere']
    P['text_stats'] = [[t, vs.text_stats(t), vs.notary(t)] for t in stats_texts]
    r1 = vs.text_stats(STATS_TEXT)
    P['render'] = [['text-stats', r1, STATS_TEXT, vs.render('text-stats', r1, STATS_TEXT)],
                   ['notary', vs.notary('naive "quoted" \\ text\n\t\x01'), 'naive "quoted" \\ text\n\t\x01',
                    vs.render('notary', vs.notary('naive "quoted" \\ text\n\t\x01'), 'naive "quoted" \\ text\n\t\x01')],
                   ['text-stats', vs.text_stats('Straße   x'), None, vs.render('text-stats', vs.text_stats('Straße   x'))]]
    P['parse_result'] = [[c, vs.parse_result(c)] for c in ['', 'no block', '```json\n{"a": 1}\n```', 'x ```json\n[1, 2]\n``` y ```json\n{"b": 2}\n```',
                                                          '```json\nnull\n```', '```JSON\n{"a": 1}\n```', '```json\n{"a":\n 1}\n```']]
    sv = {'title': 'text-stats job', 'description': 'text-stats for:\n```\nhello world hello\n```', 'deliverable': 'JSON'}
    right = vs.text_stats('hello world hello')
    cases = [
        ({'service': sv}, vs.render('text-stats', right, 'hello world hello')),
        ({'service': sv}, vs.render('text-stats', dict(right, words=4), 'hello world hello')),
        ({'service': sv}, vs.render('text-stats', dict(right, words=4, sha256='00', zeta=1, alpha=None), 'x')),
        ({'service': sv}, '```json\n' + json.dumps(dict(right, words=3.0, extra=None)) + '\n```'),
        ({'service': sv}, '```json\n' + json.dumps({k: v for k, v in right.items() if k != 'lines'}) + '\n```'),
        ({'service': sv}, '```json\n' + json.dumps(dict(right, lines=True)) + '\n```'),
        ({'service': sv}, '```json\n' + json.dumps(dict(right, top_words=[list(x) for x in reversed(right['top_words'])])) + '\n```'),
        ({'service': sv}, 'no json here'),
        ({'service': sv}, '```json\nnull\n```'),
        ({'service': {'title': 'notary', 'description': 'no text'}}, 'x'),
        ({'service': {'title': 'Notary please', 'description': 'TEXT: abc'}}, vs.render('notary', vs.notary('abc'), 'abc')),
        ({'service': {'title': 'write a poem'}}, 'x'),
        ({}, 'x'),
        ({'service': None}, 'x'),
    ]
    P['check_delivery'] = [[t, c, vs.check_delivery(t, c)] for t, c in cases]
    P['which_service'] = [[t, vs.which_service(t)] for t in [
        {'service': {'title': 'Text statistics please'}}, {'service': {'description': 'SHA-256 of this'}},
        {'service': {'title': 'write me a poem'}}, {'service': {'deliverable': 'a WORD COUNT'}}, {'service': {'title': 'notarize this'}},
        {'service': {'title': 'notary and text-stats'}}, {'service': {'title': 5, 'description': None}}, {}, {'service': {}}]]
    times = ['2026-11-06T11:00:00.000Z', '2026-11-05T12:00:00.001Z', '2026-11-05T12:00:00.000Z', '2026-11-05T11:59:59.999Z',
             '2026-11-06T13:00:00+01:00', '2026-11-05T12:30:00+00:30', '2026-11-06T12:00:00', '2026-11-06', '2099-01-01T00:00:00Z',
             '2026-11-06T11:00Z', '2026-11-06T11Z', '2026-11-06 11:00:00Z', '20261106T110000Z', '2026-11-06T11:00:00,5Z',
             '2026-11-05T24:00:00Z', '2026-11-05T24:00:01Z', '2026-02-30T00:00:00Z', '2026-11-06T11:00:00+0100', '2026-11-06T11:00:00+01',
             '2026-11-06T11:00:00+01:00:30', '2026-11-06T11:00:00+24:00', 'garbage', None, 1730000000, '']
    P['recently_active'] = [[t, 24, None, va.recently_active(t)] for t in times]
    P['recently_active'] += [[None, 24, '2026-11-06T10:00:00.000Z', va.recently_active(None, joined_at='2026-11-06T10:00:00.000Z')],
                             ['2026-11-01T00:00:00Z', 24, '2026-10-01T00:00:00Z', va.recently_active('2026-11-01T00:00:00Z', joined_at='2026-10-01T00:00:00Z')],
                             ['2026-11-06T06:00:00Z', 4, None, va.recently_active('2026-11-06T06:00:00Z', hours=4)],
                             ['2026-11-06T09:00:00Z', 4, None, va.recently_active('2026-11-06T09:00:00Z', hours=4)]]

    lb = [{}, {'max_per_deal_as_payer': 10}, {'max_per_deal_as_payer': '12', 'max_total_owed': 7.9, 'min_price_as_payee': True},
          {'clear': ['max_total_owed', 'nope', 'min_payer_coverage_pct']}, {'max_total_owed': 5, 'clear': ['max_total_owed']},
          {'clear': 'max_total_owed'}, {'clear': {'max_total_owed': 1}}, {'goals': 'Be frugal.'}, {'goals': 12}, {'goals': None, 'max_total_owed': None},
          {'max_total_owed': 'lots'}, {'max_total_owed': [1]}, {'clear': 5}, {'clear': [['x']]}]
    P['limits_body'] = [[a, outcome(lambda a=a: va.limits_body(a))] for a in lb]
    lo = [({}, {'max_issue_per_deal': 50}), ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 25}),
          ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 15}), ({'max_issue_per_deal': 20}, {'max_issue_per_deal': None}),
          ({'min_price_as_payee': 8}, {'min_price_as_payee': 6}), ({'min_price_as_payee': 8}, {'min_price_as_payee': 9}),
          ({'max_issue_per_deal': None}, {'max_issue_per_deal': None}), ({'notes': 'x'}, {'notes': 'y'}),
          ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 20, 'notes': 'z'}), ({'max_issue_per_deal': '20'}, {'max_issue_per_deal': 25}),
          ({'max_issue_per_deal': 10}, {'auto_clear': True}), ({'max_issue_per_deal': 10}, {'max_issue_per_deal': '5'}),
          ({'max_issue_per_deal': 10}, {'max_issue_per_deal': 5.5}), ({'max_issue_per_deal': 10}, {'max_issue_per_deal': True}),
          ({'max_issue_per_deal': 10.5}, {'max_issue_per_deal': 5}), ({}, {'notes': 'goals only'}), ({'min_payer_coverage_pct': 50}, {'min_payer_coverage_pct': 60}),
          ([], {'notes': 'x'}), ([], {'max_issue_per_deal': 1}), ({}, [])]
    P['loosens'] = [[c, b, outcome(lambda c=c, b=b: va.loosens(c, b))] for c, b in lo]
    P['terms_text'] = [[d, va.terms_text(d)] for d in [{}, {'current': None}, {'current': {'terms': {'service': {'title': 'T', 'description': None, 'deliverable': 3}}}},
                                                     {'current': {'terms': {}}}]]
    errs = [('mandate_exceeded', 'too much', {'rule': 'max_issue_per_deal', 'mandate_version': 3, 'limit': 20}),
            ('offer_not_authorized', 'no longer allowed', {}), ('key_changed', 'k', {}), ('payee_no_key', 'k', {}),
            ('unauthorized', 'bad token', {}), ('not_connected', 'x', {}), ('not_configured', 'y', {}), ('owner_declined', 'no', {}),
            ('draft_does_not_meet_terms', 'Not sent.', {'measured': {'word_count': 3}}), ('stale_note', 'retry', {'template': {'a': 1}}),
            ('approval_unbound', va.UNBOUND_MESSAGE, {'cause': 'hash_mismatch'}), ('tracker_mismatch', 'other tracker', {'pinned': {'tracker_nft_id': 'x'}}),
            ('bad_delivery_signature', 'not the payee', {}), ('records_unreadable', 'cannot read', {}), ('already_paid', 'paid', {}),
            ('note_timestamp_ahead', 'later', {'retry_after_ms': 1200, 'template': {'total': 3}, 'fallback_after': '2026-11-08T01:00:00.000Z',
                                               'what_this_means': 'wait', 'internal': 'x'}),
            ('transfer_window_open', 'wait', {'fallback_after': '2026-11-08T01:00:00.000Z', 'retry_after_ms': 5}),
            ('approval_unbound', 'what the server says', {'what_this_means': 'from the server'}),
            ('approval_unbound', va.UNBOUND_MESSAGE, {'cause': 'transfer_window_open', 'retry_after_ms': 1500}),
            ('attempt_outcome_unknown', 'maybe applied', {'summary': {'reason': 'x'}}), ('transfer_window_open', 'wait', {'retry_after_ms': 9}),
            ('stale_quote', 'another quote', {}), ('stale_claim', 'claim moved', {}), ('feature_unavailable', 'no circulation', {}),
            ('unknown_issuer', 'no such note', {}), ('not_exact_service', 'not exact', {}), ('not_owner', 'no', {'cause': 'x'})]
    P['error_payload'] = [[c, m, x, va.error_payload(vc.ValunError(c, m, 400, x)), va.error_payload(vc.ValunError(c, m, 400, x), 'do X')]
                          for c, m, x in errs]
    quoted_values = ['plain', 'line\nbreak', 'tab\tcr\r', 'quote " and \\ backslash', 'bidi ‮ and   sep', 'café 日本',
                     'emoji \U0001F600', 'del \x7f nul \x00 esc \x1b bell \x07 bs \x08 ff \x0c', '', 5, -3, 0, 2.5, 1e-07, 123456.789, 1e22,
                     True, False, None, [1, 'a', None, [True]], {'b': 1, 'a': ['x\ny'], 'c': {'d': None}}, {'title': 'T', 'description': None}]
    P['quoted'] = [[v, va.quoted(v)] for v in quoted_values]
    P['shown'] = [[v, va.shown(v)] for v in quoted_values + ['vp_b0b0b0b0b0b0', '2099-01-02T00:00:00.000Z', 'a' * 120, 'a' * 121,
                                                         'has space', 'user@host.example', 'x+y-z.w:v_u', "it's"]]
    P['quote_line'] = [[label, fields, va.quote_line(label, fields)] for label, fields in [
        ('Offer text written by bob', {'title': 'T', 'description': 'D\nE', 'deliverable': None}),
        ('Offer text written by your agent', {'title': 'x' * 2000, 'description': 'y' * 2001, 'deliverable': '\U0001F600' * 2001}),
        ('Delivery title and agreed service text', {'delivery_title': '', 'title': 5, 'deliverable': ['a']}),
        ('Empty', {})]]
    P['owes'] = [[r, w, p, va.owes(r, w, p)] for r, w, p in [('payer', 'bob', 20), ('payee', 'bob', 7), ('anything', '"x\\ny"', 0)]]
    P['records'] = records_table()
    P['novation_cases'] = novation_cases()
    P['novation_helpers'] = novation_helpers()
    P['circulation'] = client_helpers()
    P['verify_note'] = [[args, vc.verify_note(*args)] for args in [
        [K['alice']['pubkey'], K['bob']['pubkey'], 10, 1000, note_sig('alice', 'bob', 10, 1000), NFT, DENOM],
        [K['alice']['pubkey'], K['bob']['pubkey'], 11, 1000, note_sig('alice', 'bob', 10, 1000), NFT, DENOM],
        [K['alice']['pubkey'], K['bob']['pubkey'], 10, 1000, note_sig('alice', 'bob', 10, 1000), OTHER_NFT, DENOM],
        [K['alice']['pubkey'], K['bob']['pubkey'], 10, 1000, note_sig('alice', 'bob', 10, 1000), NFT, 'erg'],
        [K['alice']['pubkey'], K['bob']['pubkey'], '10', 1000, note_sig('alice', 'bob', 10, 1000), NFT, DENOM],
        [K['alice']['pubkey'], K['bob']['pubkey'], 10, 1000, 'zz', NFT, DENOM],
        [K['alice']['pubkey'], K['bob']['pubkey'], -1, 1000, note_sig('alice', 'bob', 10, 1000), NFT, DENOM],
        [None, K['bob']['pubkey'], 10, 1000, note_sig('alice', 'bob', 10, 1000), NFT, DENOM]]]
    ints = [5, 5.7, -5.7, True, False, '12', ' 12 ', '+3', '-0', '1_000', '١٢', '１２', '12.0', '', 'abc', '1__0', '_1',
            None, [], {}, ' 　 7' + chr(0x85)]
    P['int'] = [[v, outcome(lambda v=v: int(v))] for v in ints]
    reprs = ['plain', "it's", 'say "hi"', 'both \' and "', 'back\\slash', 'tab\tnl\ncr\r', 'bell\x07del\x7f', 'nbsp soft­',
             'café 日本', 'zw​sp', 'line' + chr(0x2028) + 'sep', 'emoji \U0001F600', 'private ', 'unassigned \U000E0080',
             '\x85next', 5, -3, 2.5, -0.001, 1e-07, 123456.789, 1e+22, 0.1, True, False, None, [1, 'a', None], {'k': "v'", 'n': [True]}]
    P['repr'] = [[v, repr(v)] for v in reprs]
    return P


def constants():
    """Values both clients must hold identically (texts the owner or the model reads, and the classification of tools)."""
    return {'APPROVAL_TEXT': APPROVAL_TEXT, 'SETTLEMENT_NOTE': va.SETTLEMENT_NOTE, 'NOT_SETTLED': va.NOT_SETTLED,
            'HONEST_LABELS': va.HONEST_LABELS, 'REAL_VS_SIMULATED': va.REAL_VS_SIMULATED, 'LIMIT_FIELDS': va.LIMIT_FIELDS,
            'TOOL_NAMES': va.TOOL_NAMES, 'READ_ONLY_TOOLS': va.READ_ONLY_TOOLS, 'NOT_COMMITMENT_TOOLS': va.NOT_COMMITMENT_TOOLS,
            'LIMIT_TOOLS': va.LIMIT_TOOLS, 'SIGNING_TOOLS': va.SIGNING_TOOLS, 'COMMITS': mcp_server.COMMITS,
            'UNBOUND_MESSAGE': va.UNBOUND_MESSAGE, 'GENERIC_TEXT': va.GENERIC_TEXT, 'QUOTE_MAX_CHARS': va.QUOTE_MAX_CHARS,
            'ROLE_WORDS': va.ROLE_WORDS, 'DEFAULT_SETUP_HINT': va.ValunAgent(None).setup_hint,
            'CORE_STATE_KEYS': vc.CORE_STATE_KEYS, 'RESERVED_MS_FROM': vc.RESERVED_MS_FROM, 'NETWORK': vc.NETWORK,
            'PROTOCOL': vc.PROTOCOL, 'UNIT': vc.UNIT, 'PILOT_TOKEN_ID': vc.PILOT_TOKEN_ID,
            'FILESTORE': {'LOCK_WAIT_S': vc.FileStore.LOCK_WAIT_S, 'LOCK_STALE_S': vc.FileStore.LOCK_STALE_S},
            # 0.4 circulating credit (agent.py, client.py, novation.py)
            'CIRCULATION_SETTLEMENT': va.CIRCULATION_SETTLEMENT, 'SETTLEMENT_NOTE_CIRCULATION': va.SETTLEMENT_NOTE_CIRCULATION,
            'NOT_SETTLED_CIRCULATION': va.NOT_SETTLED_CIRCULATION, 'HONEST_LABELS_CIRCULATION': va.HONEST_LABELS_CIRCULATION,
            'REAL_VS_SIMULATED_CIRCULATION': va.REAL_VS_SIMULATED_CIRCULATION, 'CIRCULATION': va.CIRCULATION,
            'CONSENTS_EVERY_MS': va.CONSENTS_EVERY_MS, 'INVITE_CONSENT_POLICY': va.INVITE_CONSENT_POLICY,
            'SANDBOX_CONSENT_POLICY': va.SANDBOX_CONSENT_POLICY, 'CONSENT_POLICY_KEYS': va.CONSENT_POLICY_KEYS, 'PAYABLE': va.PAYABLE,
            'CONSENT_SPEED_WORDS': va.CONSENT_SPEED_WORDS, 'UNBOUND_PASS_THROUGH': va.UNBOUND_PASS_THROUGH,
            'SANDBOX_EXACT': va.SANDBOX_EXACT, 'SANDBOX_MALLORY': va.SANDBOX_MALLORY, 'SANDBOX_AGENTS': va.SANDBOX_AGENTS,
            'TOUR_GOALS': va.TOUR_GOALS, 'TOUR_TEXTS': va.TOUR_TEXTS, 'TOUR_AFTER': va.TOUR_AFTER,
            'CONSENTS_ON_READ_TOOLS': va.CONSENTS_ON_READ_TOOLS, 'SIGNED_NOW_KEYS': va.SIGNED_NOW_KEYS,
            'FEATURES_HEADER': vc.FEATURES_HEADER, 'CONSENT_ROLES': vc.CONSENT_ROLES, 'VALUE_SAFE_ROLES': vc.VALUE_SAFE_ROLES,
            'VALUE_SAFE_HEADER_ROLES': vc.VALUE_SAFE_HEADER_ROLES, 'CONSENT_LOG_MAX': vc.CONSENT_LOG_MAX,
            'RECORDS_KEEP_MS': vc.RECORDS_KEEP_MS, 'SIGNATURES_KEEP_MS': vc.SIGNATURES_KEEP_MS, 'ATTEMPT_OUTCOMES': vc.ATTEMPT_OUTCOMES,
            'UNRESOLVED_TRANSFER': vc.UNRESOLVED_TRANSFER, 'LIVE_TRANSFER': vc.LIVE_TRANSFER, 'LOCAL_CHOICES': vc.LOCAL_CHOICES,
            'RESOLVE_NOTE_MAX': vc.RESOLVE_NOTE_MAX, 'PAYEE_EDGE_WHY': vc.PAYEE_EDGE_WHY, 'PAYEE_EDGE_NEXT': vc.PAYEE_EDGE_NEXT,
            'EDGES_PAGE': vc.EDGES_PAGE, 'EDGES_MAX_PAGES': vc.EDGES_MAX_PAGES,
            'NOVATION': {k: getattr(nv, k) for k in ('TRANSFER_MS', 'SETOFF_MS', 'BOUND_MS', 'RESIDUE', 'RESERVED_MS', 'MAX_AGE_MS',
                                                    'FALLBACK_MARGIN_MS', 'INITIATE_WINDOW_MS', 'CONSENT_WINDOW_MS', 'FUTURE_SKEW_MS',
                                                    'MAX_SAFE_INTEGER', 'QUOTE_KIND', 'QUOTE_FIELDS', 'ROLES', 'ROUTES',
                                                    'PAID_DEALS_KEY', 'REFUSAL_CODES', 'RECORDS_KEEP_MS')}}


def main():
    P = parity()
    scen = run_scenarios()
    client_scen = run_client_scenarios()
    hashes = source_hashes()                 # after everything ran: every module the reference imported is listed
    with open(os.path.join(TESTS, 'test_novation.py'), 'rb') as fh:     # the decision table novation_cases records
        tests_sha = {'test_novation.py': hashlib.sha256(fh.read().replace(b'\r\n', b'\n')).hexdigest()}
    write('schemas-python.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python_sources_sha256': hashes,
                                  'tools': schemas.ALL})
    write('python-parity.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python': sys.version.split()[0],
                                 'python_sources_sha256': hashes, 'python_tests_sha256': tests_sha, 't0_ms': T0_MS, 'nft': NFT,
                                 'denomination': DENOM,
                                 'keys': {n: {'label': k['label'], 'pubkey': k['pubkey']} for n, k in K.items()},
                                 'constants': constants(), **P})
    write('agent-python.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python': sys.version.split()[0],
                                'python_sources_sha256': hashes, 'base': BASE, 't0_ms': T0_MS, 'token': TOKEN, 'ids': ID,
                                'keys': {n: {'label': k['label'], 'pubkey': k['pubkey']} for n, k in K.items()},
                                'base_routes': base_routes(), 'dns': DNS, 'scenarios': scen, 'client_scenarios': client_scen})


if __name__ == '__main__':
    main()
