"""Record what the Python reference does, as fixtures for the JavaScript agent tools (offline; run from anywhere):

    python js/test/fixtures/generate_python_fixtures.py

Writes next to this file:
  schemas-python.json  python/src/valun/schemas.py ALL, exactly as Python holds it
  python-parity.json   outputs of measure.py, sandbox.py and agent.py helpers (and int()/repr()) for many inputs
  agent-python.json    the Python ValunAgent (call_safe, is_commitment, describe_commitment) run against recorded server
                       responses, with the requests it made
Each file records the SHA-256 (with LF line endings) of the Python sources it came from; the JS tests compare them with
python/src when it is present, so a change to the Python reference shows up until the fixtures are generated again.
Nothing here touches the network: the HTTP layer, DNS, the clock and random ids are replaced.
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
from valun import agent as va, basis as vb, client as vc, measure as vm, sandbox as vs, schemas  # noqa: E402
from valun.mcp_server import APPROVAL_TEXT  # noqa: E402

SOURCES = ['agent.py', 'client.py', 'measure.py', 'sandbox.py', 'schemas.py']
BASE = 'http://valun.invalid'
T0 = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)
T0_MS = int(T0.timestamp() * 1000)
NFT = '6869a94d5e9f95ac25e73164f9a4e9fe57d710c0794dfa13367ca2d96353a0fa'
DENOM = 'token:' + hashlib.sha256(b'valun-pilot-credit/1').hexdigest()
TOKEN = 'vpa_TEST-ONLY-token-never-shown'


def source_hashes():
    out = {}
    for f in SOURCES:
        with open(os.path.join(SRC, 'valun', f), 'rb') as fh:
            out[f] = hashlib.sha256(fh.read().replace(b'\r\n', b'\n')).hexdigest()
    return out


def write(name, data):
    with open(os.path.join(HERE, name), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print('wrote', name)


# ---------- the replaced world: clock, random ids, DNS, HTTP ----------
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

DNS = {'example.org': ['93.184.215.14'], 'example.com': ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
       'docs.python.org': ['151.101.0.223', '2a04:4e42::223'], 'intranet.example': ['10.1.2.3', 'fd00::1'],
       'localhost.example': ['127.0.0.1', '::1'], 'cgnat.example': ['100.64.1.1'], 'mapped.example': ['::ffff:10.0.0.1'],
       'mapped-public.example': ['::ffff:8.8.8.8'], 'en.wikipedia.org': ['185.15.59.224'], 'arxiv.org': ['151.101.3.42']}


def fake_getaddrinfo(host, port, *args, **kwargs):
    if host not in DNS:
        raise socket.gaierror(socket.EAI_NONAME, 'Name or service not known')
    return [(socket.AF_INET6 if ':' in ip else socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, port)) for ip in DNS[host]]


vm.socket = types.SimpleNamespace(getaddrinfo=fake_getaddrinfo, IPPROTO_TCP=socket.IPPROTO_TCP, gaierror=socket.gaierror)

ROUTES, LOG = {}, []


def unsigned(body):
    """A request body without its signatures (they use a fresh random nonce each time)."""
    if isinstance(body, dict):
        return {k: unsigned(v) for k, v in body.items() if k != 'signature'}
    return body


def fake_request(self, method, path, body=None, auth=True, token=None):
    if not self.state.get('server'):
        raise vc.ValunError('not_configured', 'no Valun server configured')
    key = f'{method} {path}'
    LOG.append({'key': key, 'body': unsigned(body)})
    r = ROUTES.get(key)
    status, payload = (599, {'error': 'unexpected_request', 'message': key}) if r is None else (r.get('status', 200), r.get('body'))
    if 200 <= status < 300:
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


# ---------- participants and deals ----------
def key(label):
    s = (int(hashlib.sha256(label.encode()).hexdigest(), 16) % (vb.N - 1)) + 1
    secret = s.to_bytes(32, 'big')
    return {'label': label, 'secret': secret.hex(), 'pubkey': vb.public_key(secret).hex()}


K = {n: key(f'valun-open/spec/test-key/{n}') for n in ('alice', 'bob', 'carol', 'erin', 'frank')}
ID = {'alice': 'vp_a1a1a1a1a1a1', 'bob': 'vp_b0b0b0b0b0b0', 'carol': 'vp_c0c0c0c0c0c0', 'dave': 'vp_d0d0d0d0d0d0',
      'erin': 'vp_e0e0e0e0e0e0', 'frank': 'vp_f0f0f0f0f0f0'}
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


def delivered(d, content, title='Brief', status='delivered'):
    out = dict(d, status=status)
    out['delivery'] = {'by': d['current']['terms']['payee']['id'], 'title': title, 'content': content, 'sha256': vc.sha256_hex(content),
                       'bytes': len(content.encode('utf-8')), 'signature': '00' * 65, 'at': '2026-11-06T11:00:00.000Z', 'late': False}
    return out


WORDS_420 = ' '.join(f'word{i % 50}' for i in range(420))
GOOD_BRIEF = ('# Brief\n\n' + WORDS_420 + '\n\nSources: https://example.org/a, https://example.com/b and '
              '(https://en.wikipedia.org/wiki/Credit_(finance)).')
BAD_BRIEF = '# Brief\n\nToo short. See https://made-up-source.invalid/x and https://example.org/a.'
FAKE_HOST_BRIEF = '# Brief\n\n' + WORDS_420 + '\n\nhttps://example.org/a https://made-up-source.invalid/x https://intranet.example/y'
BRIEF_TERMS = ('Research brief', 'A 300-500 word research brief on agent credit with at least 3 cited sources.', 'Markdown, one file.')
STATS_TEXT = 'The cat saw the dog.\nThe end'
STATS_DESC = 'text-stats for this text:\n```\n' + STATS_TEXT + '\n```'


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
    t4 = make_terms('vd_4444444444444444', 'alice', 'alice', 'bob', *BRIEF_TERMS, 20)
    a4 = agreed(deal_view(t4, 'alice'), 'bob')
    D['agreed_payer'] = a4
    D['delivered_good'] = delivered(a4, GOOD_BRIEF)
    D['delivered_bad'] = delivered(a4, BAD_BRIEF)
    D['delivered_fake_host'] = delivered(a4, FAKE_HOST_BRIEF)
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
    return D


def template(d, prior=10, price=20):
    return {'deal_id': d['id'], 'terms_hash': d['current']['terms_hash'], 'deliverable_sha256': d['delivery']['sha256'],
            'issuer_pubkey': K['alice']['pubkey'], 'recipient_pubkey': K['bob']['pubkey'], 'keys_as_agreed': True,
            'prior_total': prior, 'price': price, 'total': prior + price, 'timestamp': T0_MS - 1500, 'tracker_nft_id': NFT,
            'denomination': DENOM, 'message_hex': '00'}


def scenarios():
    D = deals()
    g = lambda name: {f"GET /pilot/v1/deals/{D[name]['id']}": {'body': D[name]}}   # noqa: E731
    post = lambda did, act, body, status=200: {f'POST /pilot/v1/deals/{did}/{act}': {'status': status, 'body': body}}   # noqa: E731
    S = []

    def add(name, tool, args, routes=None, store='alice', agent=None):
        S.append({'name': name, 'tool': tool, 'args': args, 'routes': routes or {}, 'store': store, 'agent': agent or {}})

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
    add('unknown tool', 'valun_pay', {})
    add('unknown tool name with a quote', "it's", {})
    add('unknown tool name with both quotes and a tab', 'a"b\'c\td', {})
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
    add('propose: outside the mandate', 'valun_propose', dict(brief, price=40), {'POST /pilot/v1/deals': {'status': 403, 'body': {
        'error': 'mandate_exceeded', 'message': 'price 40 PC is above max_issue_per_deal (20)', 'rule': 'max_issue_per_deal',
        'mandate_version': 3, 'limit': 20}}})
    add('propose: bad role', 'valun_propose', dict(brief, role='buyer'))
    # respond
    ob = D['open_from_bob']['id']
    add('respond: accept', 'valun_respond', {'deal_id': ob, 'action': 'accept', 'expected_terms_hash': D['open_from_bob']['current']['terms_hash']},
        {**g('open_from_bob'), **post(ob, 'accept', {'id': ob, 'status': 'agreed', 'next_actions': ['wait for delivery']})})
    add('respond: accept held for my owner', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {**g('open_from_bob'), **post(ob, 'accept', {'id': ob, 'status': 'accepted_awaiting_owner', 'next_actions': []})})
    add('respond: accept terms that changed', 'valun_respond', {'deal_id': ob, 'action': 'accept', 'expected_terms_hash': '00' * 32}, g('open_from_bob'))
    add('respond: accept with a bad signature', 'valun_respond', {'deal_id': D['open_bad_sig']['id'], 'action': 'accept'}, g('open_bad_sig'))
    add('respond: decline without a reason', 'valun_respond', {'deal_id': ob, 'action': 'decline', 'reason': '  \u3000 '})
    add('respond: decline', 'valun_respond', {'deal_id': ob, 'action': 'decline', 'reason': ' Too expensive for a short brief. '},
        {**g('open_from_bob'), **post(ob, 'decline', {'id': ob, 'status': 'declined'})})
    add('respond: counter', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'price': 16, 'title': ''},
        {**g('open_from_bob'), **post(ob, 'counter', {'id': ob, 'status': 'open', 'pending_counter': None, 'next_actions': ['wait']})})
    add('respond: counter held for my owner', 'valun_respond', {'deal_id': ob, 'action': 'counter', 'price': 17, 'deliver_within_hours': 24},
        {**g('open_from_bob'), **post(ob, 'counter', {'id': ob, 'status': 'open', 'pending_counter': {'version': 2}, 'next_actions': []})})
    om = D['open_mine']['id']
    add('respond: withdraw', 'valun_respond', {'deal_id': om, 'action': 'withdraw'},
        {**g('open_mine'), **post(om, 'withdraw', {'id': om, 'status': 'withdrawn'})})
    add('respond: unknown action', 'valun_respond', {'deal_id': ob, 'action': 'maybe'})
    add('respond: missing action', 'valun_respond', {'deal_id': ob})
    add('respond: misspelt action is a commitment, then refused', 'valun_respond', {'deal_id': ob, 'action': 'Accept'}, g('open_from_bob'))
    add('respond: accept an unknown deal (nothing to bind)', 'valun_respond', {'deal_id': 'vd_0000000000000000', 'action': 'accept'},
        {'GET /pilot/v1/deals/vd_0000000000000000': {'status': 404, 'body': {'error': 'not_found', 'message': 'no such deal'}}})
    add('respond: server reports offer_not_authorized', 'valun_respond', {'deal_id': ob, 'action': 'accept'},
        {**g('open_from_bob'), **post(ob, 'accept', {'error': 'offer_not_authorized', 'message': "bob's owner no longer allows this offer"}, 409)})
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
    add('review: accept issues the note', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept', 'expected_deliverable_sha256': dg['delivery']['sha256']},
        {**g('delivered_good'), f"GET /pilot/v1/deals/{dg['id']}/credit-note-template": {'body': template(dg)},
         **post(dg['id'], 'complete', {'id': dg['id'], 'status': 'note_issued', 'counterparty': {'handle': 'bob'},
                                       'credit_note': {'state': 'issued', 'amount': 20, 'tracker_status': 'recorded',
                                                       'tracker_note': {'amount_collected': 30, 'confirmation': 'local_only'}}})})
    add('review: accept held for my owner', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept'},
        {**g('delivered_good'), f"GET /pilot/v1/deals/{dg['id']}/credit-note-template": {'body': template(dg)},
         **post(dg['id'], 'complete', {'id': dg['id'], 'status': 'completion_awaiting_owner', 'counterparty': {'handle': 'bob'},
                                       'credit_note': {'state': 'awaiting_owner', 'amount': 20}})})
    add('review: accept a changed delivery', 'valun_review_delivery', {'deal_id': dg['id'], 'decision': 'accept', 'expected_deliverable_sha256': '11' * 32},
        g('delivered_good'))
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
    # set_limits
    limits_ok = {'agent_limits': {'max_issue_per_deal': 15, 'notes': 'x'}, 'effective_limits': {'max_issue_per_deal': 15, 'max_issue_outstanding': 100}}
    add('set_limits: nothing to record', 'valun_set_limits', {'clear': ['not_a_limit']})
    add('set_limits: tighten and record goals', 'valun_set_limits', {'max_per_deal_as_payer': 15, 'goals': 'Prefer briefs with sources.'},
        {'PUT /pilot/v1/limits': {'body': limits_ok}})
    add('set_limits: loosen a recorded cap', 'valun_set_limits', {'max_per_deal_as_payer': 25}, {'PUT /pilot/v1/limits': {'body': limits_ok}})
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
    return S


def store_for(kind):
    if kind == 'unenrolled':
        return Store({'server': BASE})
    state = {'server': BASE, 'participant_id': ID[kind], 'pubkey': K[kind]['pubkey'], 'issued': {}}
    return Store(state, K[kind]['secret'], TOKEN)


def run_scenarios():
    out = []
    for sc in scenarios():
        record = dict(sc)
        for what in ('call', 'is_commitment', 'describe', 'bind', 'describe_bound'):
            ROUTES.clear()
            ROUTES.update(base_routes())
            ROUTES.update(sc['routes'])
            LOG.clear()
            RANDOM[0] = 0
            store = store_for(sc['store'])
            ag = va.ValunAgent(store, approvals=sc['agent'].get('approvals', ''), check_link_hosts=sc['agent'].get('check_link_hosts', True),
                               setup_hint=sc['agent'].get('setup_hint'))
            if what == 'call':
                record['result'] = ag.call_safe(sc['tool'], sc['args'])
                record['requests'] = list(LOG)
                record['state_after'] = store.state
            elif what == 'is_commitment':
                try:
                    record['is_commitment'] = ag.is_commitment(sc['tool'], sc['args'])
                except Exception as e:  # noqa: BLE001
                    record['is_commitment'] = {'raises': type(e).__name__}
            elif record['is_commitment'] is not True:
                continue                  # adapters bind and describe only commitments
            elif what == 'describe':
                record['describe'] = ag.describe_commitment(sc['tool'], sc['args'])
            elif what == 'bind':
                record['bound'] = ag.bind(sc['tool'], sc['args'])
                record['bind_requests'] = list(LOG)
            else:                         # what an adapter shows the owner: the text for the bound arguments
                record['describe_bound'] = ag.describe_commitment(sc['tool'], record['bound'])
        out.append(json.loads(json.dumps(record, default=str)))
    return out


def parity():
    """Helper-level outputs for many inputs."""
    P = {}
    texts = ['', 'One two-three, four.', "It's Bob\u2019s 2nd draft -- 3x faster", 'Title\n=====\n\nOne two-three, four.\n---',
             'caf\u00e9 na\u00efve \u00fcber', 'A' + chr(0x1c) + 'B' + chr(0x85) + 'C', '\u65e5\u672c\u8a9e 123']
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
                 'markdown, under 400 words, at least 2 links', 'at least 150 words', '300\u2013500 words', '500 \u2014 300 words',
                 '200 to 400 words', '200 TO 400 WORDS', 'minimum of 250 words; maximum 900 words', 'min. 80 words, max. 120 words',
                 'no fewer than 100 words and no more than 2000 words', 'up to 600 word summary', 'at most 99 words',
                 'a short note', '\u0663\u0660\u0660-\u0665\u0660\u0660 words', '\uff13\uff10\uff10 words at least \uff12 sources',
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
             'of \u201ccurly quoted\u201d', 'compare "a" with "b"', 'compare "a" with \u201cb\u201d', 'just "one" here', '""', '"line\nbreak"',
             'emoji "\U0001F600\U0001F600"', 'long "' + ('\U0001F600' * 9000) + '"', 'long "' + ('x' * 16001) + '"', '', None]
    P['extract_text'] = [[d, vs.extract_text(d)] for d in descs]
    stats_texts = ['a\r\nb\rc\nd', 'x\vy\fz' + chr(0x1c) + 'w' + chr(0x1d) + 'v' + chr(0x1e) + 'u' + chr(0x1f) + 't',
                   'p' + chr(0x85) + 'q' + chr(0x2028) + 'r' + chr(0x2029) + 's', 'trailing\n\n', '\u0130stanbul ISTANBUL istanbul',
                   'b a c b a b ' + ' '.join(f'w{i}' for i in range(15)), '\uff21 \U0001F600 \uff21 \U0001F600 z', 'A\u200bB C' + chr(0x180e) + 'D',
                   '\x00 \x01 nul', 'tab\there\tand\t\tthere']
    P['text_stats'] = [[t, vs.text_stats(t), vs.notary(t)] for t in stats_texts]
    r1 = vs.text_stats(STATS_TEXT)
    P['render'] = [['text-stats', r1, STATS_TEXT, vs.render('text-stats', r1, STATS_TEXT)],
                   ['notary', vs.notary('naive "quoted" \\ text\n\t\x01'), 'naive "quoted" \\ text\n\t\x01',
                    vs.render('notary', vs.notary('naive "quoted" \\ text\n\t\x01'), 'naive "quoted" \\ text\n\t\x01')],
                   ['text-stats', vs.text_stats('Stra\u00dfe \u2028 x'), None, vs.render('text-stats', vs.text_stats('Stra\u00dfe \u2028 x'))]]
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

    def outcome(fn):
        try:
            return {'value': fn()}
        except Exception as e:  # noqa: BLE001
            return {'raises': type(e).__name__, 'message': str(e)}
    lb = [{}, {'max_per_deal_as_payer': 10}, {'max_per_deal_as_payer': '12', 'max_total_owed': 7.9, 'min_price_as_payee': True},
          {'clear': ['max_total_owed', 'nope', 'min_payer_coverage_pct']}, {'max_total_owed': 5, 'clear': ['max_total_owed']},
          {'clear': 'max_total_owed'}, {'clear': {'max_total_owed': 1}}, {'goals': 'Be frugal.'}, {'goals': 12}, {'goals': None, 'max_total_owed': None},
          {'max_total_owed': 'lots'}, {'max_total_owed': [1]}, {'clear': 5}, {'clear': [['x']]}]
    P['limits_body'] = [[a, outcome(lambda a=a: va.limits_body(a))] for a in lb]
    lo = [({}, {'max_issue_per_deal': 50}), ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 25}),
          ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 15}), ({'max_issue_per_deal': 20}, {'max_issue_per_deal': None}),
          ({'min_price_as_payee': 8}, {'min_price_as_payee': 6}), ({'min_price_as_payee': 8}, {'min_price_as_payee': 9}),
          ({'max_issue_per_deal': None}, {'max_issue_per_deal': None}), ({'notes': 'x'}, {'notes': 'y'}),
          ({'max_issue_per_deal': 20}, {'max_issue_per_deal': 20, 'notes': 'z'}), ({'max_issue_per_deal': '20'}, {'max_issue_per_deal': 25})]
    P['loosens'] = [[c, b, outcome(lambda c=c, b=b: va.loosens(c, b))] for c, b in lo]
    P['terms_text'] = [[d, va.terms_text(d)] for d in [{}, {'current': None}, {'current': {'terms': {'service': {'title': 'T', 'description': None, 'deliverable': 3}}}},
                                                     {'current': {'terms': {}}}]]
    errs = [('mandate_exceeded', 'too much', {'rule': 'max_issue_per_deal', 'mandate_version': 3, 'limit': 20}),
            ('offer_not_authorized', 'no longer allowed', {}), ('key_changed', 'k', {}), ('payee_no_key', 'k', {}),
            ('unauthorized', 'bad token', {}), ('not_connected', 'x', {}), ('not_configured', 'y', {}), ('owner_declined', 'no', {}),
            ('draft_does_not_meet_terms', 'Not sent.', {'measured': {'word_count': 3}}), ('stale_note', 'retry', {'template': {'a': 1}})]
    P['error_payload'] = [[c, m, x, va.error_payload(vc.ValunError(c, m, 400, x)), va.error_payload(vc.ValunError(c, m, 400, x), 'do X')]
                          for c, m, x in errs]
    ints = [5, 5.7, -5.7, True, False, '12', ' 12 ', '+3', '-0', '1_000', '\u0661\u0662', '\uff11\uff12', '12.0', '', 'abc', '1__0', '_1',
            None, [], {}, ' \u3000 7' + chr(0x85)]
    P['int'] = [[v, outcome(lambda v=v: int(v))] for v in ints]
    reprs = ['plain', "it's", 'say "hi"', 'both \' and "', 'back\\slash', 'tab\tnl\ncr\r', 'bell\x07del\x7f', 'nbsp\u00a0soft\u00ad',
             'caf\u00e9 \u65e5\u672c', 'zw\u200bsp', 'line' + chr(0x2028) + 'sep', 'emoji \U0001F600', 'private \ue000', 'unassigned \U000E0080',
             '\x85next', 5, -3, 2.5, -0.001, 1e-07, 123456.789, 1e+22, 0.1, True, False, None, [1, 'a', None], {'k': "v'", 'n': [True]}]
    P['repr'] = [[v, repr(v)] for v in reprs]
    return P


def main():
    hashes = source_hashes()
    write('schemas-python.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python_sources_sha256': hashes,
                                  'tools': schemas.ALL})
    write('python-parity.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python': sys.version.split()[0],
                                 'python_sources_sha256': hashes, 't0_ms': T0_MS, **parity()})
    write('agent-python.json', {'generated_by': 'js/test/fixtures/generate_python_fixtures.py', 'python': sys.version.split()[0],
                                'python_sources_sha256': hashes, 'base': BASE, 't0_ms': T0_MS, 'token': TOKEN, 'ids': ID,
                                'keys': {n: {'label': k['label'], 'pubkey': k['pubkey']} for n, k in K.items()},
                                'base_routes': base_routes(), 'dns': DNS, 'scenarios': run_scenarios()})


if __name__ == '__main__':
    main()
