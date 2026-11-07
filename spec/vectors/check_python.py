#!/usr/bin/env python3
"""Checks every valun-deal/1 vector against a Python client, so the server and that client provably agree, or the
disagreement is reported. Two clients can be checked (one per run):

    python spec/vectors/check_python.py                    the Hermes plugin (default)
    python spec/vectors/check_python.py --client package   the framework-neutral `valun` package

  --client plugin   hermes-plugin-valun: valun_basis.py, valun_client.py (and tools.py, read as text). Directory:
                    --plugin-dir, else VALUN_PLUGIN_DIR, else ../../../hermes-plugin-valun (next to this repository).
  --client package  the `valun` package: valun/basis.py, valun/client.py (and agent.py, read as text), imported as the
                    package `valun` from --package-src, else VALUN_PACKAGE_SRC, else python/src of this repository
                    (so a fresh checkout of valun-open works with no install; an installed copy is never used).
  VALUN_CLIENT=plugin|package selects the client when --client is not given.

The client's modules are imported and never modified (bytecode writing is switched off so not even a __pycache__ file
is added). Its tool layer (tools.py / agent.py) is only read as text. No network: replays of the transcript patch
urllib.request.urlopen in this process only. Standard library only; Python 3.10 or later.

What is checked
- canonical.json        canonical / terms_hash on json.loads(input_json)
- statements.json       statement(...) rebuilds each statement; basis.verify checks each signature (and rejects each
                        negative); for decline/dispute every form the real server accepts (the reason as sent and, since
                        v8 as an alternative, its cleaned form), and whether the statement Client.decline /
                        Client.dispute would sign for that reason is one of them. Reasons the server refuses (tier
                        `refused`, since v9) are server-only and reported as not applicable.
- basis-notes.json      debt_key / note_message, signatures where given
- basis-signatures.json verify on Basis's official TV001-TV011
- terms-validation.json terms_hash only (validation is server-only: neither Python client has a terms validator)
- transcript.json       every signature the server verified; every terms_hash in every response; and every step with a
                        client_call is REPLAYED through the real Client method with the recorded responses: its request
                        body must equal the recorded one (signatures aside) and its signatures must verify over the exact
                        bytes the server verified (for decline/dispute: over one of the forms the server accepts for the
                        body the client sent, recorded by a dry run of the real code). Variants (agent-tool paths that
                        send a different reason string) are replayed the same way, after checking that the client's tool
                        layer still calls Client.decline / Client.dispute the way the variant says. A step with
                        expect_error must make the client raise that error code. `probes` are server-only.

Outcomes: agree | differ | python_error | n/a. Exit status 1 when any `core`/`terms`/`client_path`/`replay`
check does not agree; `wire`, `refused`, `edge` and `generic` results are informative and never fail the run. Exit
status 2 when the client cannot be found or imported.
"""
import sys

sys.dont_write_bytecode = True  # never add files to the client's directory

import argparse
import copy
import hashlib
import importlib
import importlib.util
import inspect
import io
import json
import os
import re
import types
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))      # the valun-open checkout
BASE = 'http://valun.invalid'
try:
    sys.stdout.reconfigure(errors='backslashreplace')
except Exception:
    pass

vb = vc = None        # the client's basis and client modules, set by load_client()
CLIENT = {}           # name, label, tool_file, refs


def fail(message):
    """The client cannot be found or imported: exit status 2 (status 1 means a disagreement)."""
    print(f'error: {message}', file=sys.stderr)
    raise SystemExit(2)


def load_plugin(plugin_dir):
    plugin_dir = os.path.abspath(plugin_dir)
    for f in ('valun_basis.py', 'valun_client.py'):
        if not os.path.isfile(os.path.join(plugin_dir, f)):
            fail(f'{f} not found in {plugin_dir} (set VALUN_PLUGIN_DIR or --plugin-dir to a checkout of hermes-plugin-valun)')

    def load(name):
        spec = importlib.util.spec_from_file_location(name, os.path.join(plugin_dir, name + '.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        return mod

    b = load('valun_basis')
    c = load('valun_client')  # its `from . import valun_basis` fails outside the package; it then uses sys.modules['valun_basis']
    assert c.vb is b
    return b, c, os.path.join(plugin_dir, 'tools.py'), f'the Hermes plugin (hermes-plugin-valun) at {plugin_dir}'


def load_package(src):
    src = os.path.abspath(src)
    if not os.path.isfile(os.path.join(src, 'valun', 'client.py')):
        fail(f'valun/client.py not found in {src} (set VALUN_PACKAGE_SRC or --package-src to the python/src folder of a valun-open checkout)')
    sys.path.insert(0, src)
    for m in [k for k in sys.modules if k == 'valun' or k.startswith('valun.')]:
        del sys.modules[m]
    pkg = importlib.import_module('valun')
    b = importlib.import_module('valun.basis')
    c = importlib.import_module('valun.client')
    for m in (pkg, b, c):   # never check an installed copy by accident
        if not os.path.abspath(m.__file__).startswith(src + os.sep):
            fail(f'{m.__name__} was imported from {m.__file__}, not from {src}')
    assert c.vb is b
    return b, c, os.path.join(src, 'valun', 'agent.py'), f'the valun package {getattr(pkg, "__version__", "?")} at {src}'


def source_ref(func, needle):
    """file:line of the first line of `func` containing `needle` (for labels; computed, so it never goes stale)."""
    lines, start = inspect.getsourcelines(func)
    name = os.path.basename(inspect.getsourcefile(func))
    for i, line in enumerate(lines):
        if needle in line:
            return f'{name}:{start + i}'
    return f'{name}:{start}'


def tool_calls(method):
    """Lines of the client's agent-tool layer (tools.py / agent.py, read as text) that call Client.<method>."""
    path = CLIENT['tool_file']
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8') as f:
        return [(i + 1, line.strip()) for i, line in enumerate(f.read().split('\n')) if re.search(r'\bc\.' + method + r'\(', line)]


def load_client(args):
    global vb, vc
    if args.client == 'plugin':
        vb, vc, tool_file, label = load_plugin(args.plugin_dir)
    else:
        vb, vc, tool_file, label = load_package(args.package_src)
    CLIENT.update(name=args.client, label=label, tool_file=tool_file,
                  refs={'decline': source_ref(vc.Client.decline, "statement('decline'"), 'dispute': source_ref(vc.Client.dispute, "statement('dispute'")})


RESULTS = []          # (file, name, check, tier, outcome, detail)
FAILING_TIERS = {'core', 'terms', 'client_path', 'replay'}  # 'wire': the Python clients refuse float-written numbers (a safe refusal)


def record(file, name, check, tier, outcome, detail=''):
    RESULTS.append((file, name, check, tier, outcome, detail))


def attempt(fn):
    try:
        return fn(), None
    except Exception as e:  # noqa: BLE001 - a Python error is itself a result
        return None, f'{type(e).__name__}: {e}'


def vec(name):
    with open(os.path.join(HERE, name), encoding='utf-8') as f:
        return json.load(f)


def test_key(label):
    """secret = (int(sha256(utf8(label))) mod (n - 1)) + 1: the PUBLIC test-key derivation in generate.mjs."""
    s = int.from_bytes(hashlib.sha256(label.encode('utf-8')).digest(), 'big') % (vb.N - 1) + 1
    return s.to_bytes(32, 'big')


def verify_hex(sig_hex, msg_bytes, pk_hex):
    return vb.verify(bytes.fromhex(sig_hex), msg_bytes, bytes.fromhex(pk_hex))


# ---------------------------------------------------------------------------------------------------------------------
def check_keys(meta, file):
    for name, k in meta['test_keys'].items():
        pk, err = attempt(lambda: vb.public_key(test_key(k['label'])).hex())
        record(file, f'test-key/{name}', 'public key from label', 'core', 'python_error' if err else ('agree' if pk == k['pubkey'] else 'differ'), err or '')


def check_canonical():
    data = vec('canonical.json')
    check_keys(data['meta'], 'canonical.json')
    for v in data['vectors']:
        tier = v['tier']
        obj, err = attempt(lambda: json.loads(v['input_json']))
        if err:
            record('canonical.json', v['name'], 'json.loads', tier, 'python_error', err)
            continue
        c, err = attempt(lambda: vc.canonical(obj))
        if err:
            record('canonical.json', v['name'], 'canonical', tier, 'python_error', err)
            continue
        record('canonical.json', v['name'], 'canonical', tier, 'agree' if c == v['canonical'] else 'differ',
               '' if c == v['canonical'] else f'python {c[:120]!r} vs server {v["canonical"][:120]!r}')
        h, err = attempt(lambda: vc.terms_hash(obj))
        record('canonical.json', v['name'], 'terms_hash', tier, 'python_error' if err else ('agree' if h == v['terms_hash'] else 'differ'), err or '')


def statement_parts(v):
    i, k = v['inputs'], v['kind']
    if k == 'enroll':
        return [i['network'], i['participant_id'], i['pubkey'], vc.sha256_hex(i['enrollment_code'])]
    if k in ('propose', 'accept', 'withdraw'):
        return [i['terms_hash']]
    if k == 'decline':
        return [i['terms_hash'], vc.sha256_hex(i['reason'])]
    if k == 'deliver':
        return [i['terms_hash'], vc.sha256_hex(i['content'])]
    if k == 'complete':
        return [i['terms_hash'], i['deliverable_sha256']]
    if k == 'dispute':
        return [i['terms_hash'], i['deliverable_sha256'], vc.sha256_hex(i['reason'])]
    raise ValueError(k)


def check_statements():
    data = vec('statements.json')
    for v in data['vectors']:
        tier, name = v['tier'], v['name']
        if v.get('server_outcome', 'accepted') != 'accepted':
            o = v['server_outcome']
            record('statements.json', name, 'server refuses the input (server-only rule)', tier, 'n/a', f'{o.get("status")} {o.get("error", "")}: {o.get("message", "")}')
            continue
        s, err = attempt(lambda: vc.statement(v['kind'], *statement_parts(v)))
        if err:
            record('statements.json', name, 'statement text', tier, 'python_error', err)
        else:
            ok = s == v['statement'] and s.encode('utf-8').hex() == v['statement_utf8_hex']
            record('statements.json', name, 'statement text', tier, 'agree' if ok else 'differ', '' if ok else f'python {s!r}')
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['statement_utf8_hex']), v['pubkey']))
        record('statements.json', name, 'signature verifies', tier, 'python_error' if err else ('agree' if ok else 'differ'), err or '')
        if v['kind'] in ('decline', 'dispute'):
            i = v['inputs']
            pre = [i['terms_hash']] + ([i['deliverable_sha256']] if v['kind'] == 'dispute' else [])
            # Every alternative form the server accepts (since v8: the cleaned reason) must rebuild and verify too.
            for alt in v.get('accepted_alternatives', []):
                a, err = attempt(lambda: vc.statement(v['kind'], *pre, vc.sha256_hex(i['reason_cleaned'])))
                record('statements.json', name, f'accepted alternative ({alt["form"]}) text', tier,
                       'python_error' if err else ('agree' if a == alt['statement'] else 'differ'), err or '')
                ok, err = attempt(lambda: verify_hex(alt['signature'], bytes.fromhex(alt['statement_utf8_hex']), v['pubkey']))
                record('statements.json', name, f'accepted alternative ({alt["form"]}) signature', tier,
                       'python_error' if err else ('agree' if ok else 'differ'), err or '')
            # The client's REAL Client.decline / Client.dispute, run for this reason against a stub server: it must send the
            # reason unchanged, and its signature must verify over one of the forms the server accepts.
            line = CLIENT['refs'][v['kind']]
            accepted = [v['statement']] + [a['statement'] for a in v.get('accepted_alternatives', [])]
            ctier = 'edge' if tier == 'edge' else 'client_path'
            body, err = attempt(lambda: client_reason_request(v['kind'], i, data['meta']['test_keys'][v['signer']]))
            problems = []
            if not err:
                if body.get('reason') != i['reason']:
                    problems.append(f'sent reason {body.get("reason")!r}, not the reason it was given')
                if not any(verify_hex(body.get('signature', ''), s.encode('utf-8'), v['pubkey']) for s in accepted):
                    problems.append('its signature verifies over none of the statements the server accepts')
            record('statements.json', name, f'Client.{v["kind"]} ({line}) sends the reason unchanged and signs a form the server accepts', ctier,
                   'python_error' if err else ('differ' if problems else 'agree'), err or ' | '.join(problems))
    for v in data['negative_signatures']:
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['statement_utf8_hex']), v['pubkey']))
        record('statements.json', v['name'], 'rejected by verify', v['tier'], 'python_error' if err else ('agree' if ok is False else 'differ'), err or v['why'])


def check_notes():
    data = vec('basis-notes.json')
    for v in data['vectors']:
        tier = v['tier']
        i, r, nft = bytes.fromhex(v['issuer_pubkey']), bytes.fromhex(v['recipient_pubkey']), bytes.fromhex(v['tracker_nft_id'])
        k, err = attempt(lambda: vb.debt_key(i, r, v['denomination']).hex())
        record('basis-notes.json', v['name'], 'debt key', tier, 'python_error' if err else ('agree' if k == v['debt_key_hex'] else 'differ'), err or '')
        m, err = attempt(lambda: vb.note_message(i, r, int(v['total']), int(v['timestamp']), nft, v['denomination']).hex())
        record('basis-notes.json', v['name'], 'note message', tier, 'python_error' if err else ('agree' if m == v['message_hex'] else 'differ'), err or '')
        if v.get('signature'):
            ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['message_hex']), v['issuer_pubkey']))
            record('basis-notes.json', v['name'], 'note signature verifies', tier, 'python_error' if err else ('agree' if ok else 'differ'), err or '')
    for v in data['negative_signatures']:
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['message_hex']), v['pubkey']))
        record('basis-notes.json', v['name'], 'rejected by verify', 'core', 'python_error' if err else ('agree' if ok is False else 'differ'), err or v['why'])


def check_signatures():
    for v in vec('basis-signatures.json')['vectors']:
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['message_hex']), v['pubkey']))
        record('basis-signatures.json', v['name'], f'verify == {v["valid"]}', v['tier'], 'python_error' if err else ('agree' if ok == v['valid'] else 'differ'), err or '')


def check_validation():
    for v in vec('terms-validation.json')['vectors']:
        h, err = attempt(lambda: vc.terms_hash(v['terms']))
        tier = 'core' if v['name'].startswith('ok/') else 'edge'
        record('terms-validation.json', v['name'], 'terms_hash', tier, 'python_error' if err else ('agree' if h == v['terms_hash'] else 'differ'), err or '')
        record('terms-validation.json', v['name'], 'validation (server-only rule)', 'edge', 'n/a', 'the Python client has no terms validator')


# ---------------------------------------------------------------------------------------------------------------------
# transcript replay
class Resp:
    def __init__(self, status, body):
        self.status, self._b = status, json.dumps(body).encode('utf-8')

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class Transport:
    def __init__(self, step, token_placeholder):
        self.reads = step.get('client_reads', {})
        self.req, self.res = step['request'], step['response']
        self.token = token_placeholder
        self.captured, self.problems = None, []

    def urlopen(self, req, timeout=None):
        method, path = req.get_method(), req.full_url[len(BASE):]
        auth = req.get_header('Authorization')
        key = f'{method} {path}'
        if key in self.reads:
            r = self.reads[key]
            return self._answer(req, r['status'], r['body'])
        if method == self.req['method'] and path == self.req['path']:
            want = self.req.get('headers', {}).get('authorization')
            if want and auth != want:
                self.problems.append(f'Authorization header {auth!r}, expected {want!r}')
            self.captured = json.loads(req.data.decode('utf-8')) if req.data else None
            return self._answer(req, self.res['status'], self.res['body'])
        self.problems.append(f'unexpected request {key}')
        raise urllib.error.HTTPError(req.full_url, 599, 'unexpected request in replay', {}, io.BytesIO(b'{"error":"unexpected_request"}'))

    @staticmethod
    def _answer(req, status, body):
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, 'error', {}, io.BytesIO(json.dumps(body).encode('utf-8')))
        return Resp(status, body)


class FakeStore:
    def __init__(self, state, secret_hex, token):
        self.state, self._s, self._t = state, secret_hex, token

    def secret(self):
        return self._s

    def token(self):
        return self._t

    def save(self):
        pass

    def save_credentials(self, secret_hex, token):
        self._s, self._t = secret_hex, token


def client_reason_request(kind, inputs, key):
    """Runs the client's real Client.decline / Client.dispute for one reason against a stub server and returns the body
    it POSTs. Only the reason handling is under test here: for a dispute the agreement check is bypassed (terms_hash is
    pinned to the vector's), because full disputes, agreement check included, are replayed from transcript.json."""
    th, deal_id = inputs['terms_hash'], 'vd_0000000000000000'
    deal = {'id': deal_id, 'current': {'terms_hash': th}, 'agreement': {'terms_hash': th}, 'delivery': {'sha256': inputs.get('deliverable_sha256')}}
    captured = {}

    def urlopen(req, timeout=None):
        if req.get_method() == 'GET' and req.full_url == f'{BASE}/pilot/v1/deals/{deal_id}':
            return Resp(200, deal)
        if req.get_method() == 'POST' and req.full_url == f'{BASE}/pilot/v1/deals/{deal_id}/{kind}':
            captured['body'] = json.loads(req.data.decode('utf-8'))
            return Resp(200, {'id': deal_id, 'status': 'declined' if kind == 'decline' else 'disputed'})
        raise AssertionError(f'unexpected request {req.get_method()} {req.full_url}')

    secret = test_key(key['label'])
    saved = (urllib.request.urlopen, vc.terms_hash)
    try:
        urllib.request.urlopen = urlopen
        vc.terms_hash = lambda _terms: th
        client = vc.Client(FakeStore({'server': BASE, 'participant_id': 'vp_000000000000', 'pubkey': key['pubkey'], 'issued': {}}, secret.hex(), 'stub-token'))
        client.verified_agreement = lambda _d: {}
        getattr(client, kind)(deal_id, inputs['reason'])
    finally:
        urllib.request.urlopen, vc.terms_hash = saved
    if 'body' not in captured:
        raise AssertionError(f'Client.{kind} sent no request')
    return captured['body']


def strip_sigs(body):
    b = copy.deepcopy(body)
    if isinstance(b, dict):
        b.pop('signature', None)
        if isinstance(b.get('credit_note'), dict):
            b['credit_note'].pop('signature', None)
    return b


def replay(step, meta, participants, variant=None):
    call = step['client_call']
    key = meta['test_keys'][call['key']]
    secret = test_key(key['label'])
    actor = step['actor'].split('.')[0]
    pid = participants[actor]['participant_id']
    at = datetime.fromisoformat(step['at'].replace('Z', '+00:00'))

    class FixedDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return at if tz is None else at.astimezone(tz)

    queue = list(call.get('token_hex', []))

    def token_hex(n):
        if not queue:
            raise AssertionError('client asked for more random values than the transcript recorded')
        v = queue.pop(0)
        if len(v) != 2 * n:
            raise AssertionError(f'token_hex({n}) but the recorded value has {len(v)} hex chars')
        return v

    saved = (vc.datetime, vc.time, vc.secrets, urllib.request.urlopen, vb.generate_secret)
    token = (step['request'].get('headers', {}).get('authorization') or 'Bearer <none>')[len('Bearer '):]
    transport = Transport(step, token)
    try:
        vc.datetime = FixedDT
        vc.time = types.SimpleNamespace(time=lambda: at.timestamp())
        vc.secrets = types.SimpleNamespace(token_hex=token_hex)
        urllib.request.urlopen = transport.urlopen
        if call['method'] == 'enroll':
            vb.generate_secret = lambda: secret
            client = vc.Client(FakeStore({'server': BASE}, None, None))
        else:
            client = vc.Client(FakeStore({'server': BASE, 'participant_id': pid, 'pubkey': key['pubkey'], 'issued': {}}, secret.hex(), token))
        args = dict(call['args'])
        if variant and variant.get('strip'):
            args['reason'] = args['reason'].strip()
        raised = None
        try:
            if call['method'] == 'set_limits':
                client.set_limits(args['body'])
            else:
                getattr(client, call['method'])(**args)
        except vc.ValunError as e:  # an expected refusal (expect_error) is a result, not a crash
            raised = e
    finally:
        vc.datetime, vc.time, vc.secrets, urllib.request.urlopen, vb.generate_secret = saved
    return transport, key, raised


def check_transcript():
    data = vec('transcript.json')
    meta, participants = data['meta'], data['participants']
    for step in data['steps']:
        sname = f'step {step["n"]}: {step["label"][:70]}'
        for i, e in enumerate(step['server_verified']):
            ok, err = attempt(lambda: verify_hex(e['signature'], bytes.fromhex(e['message_hex']), e['pubkey']))
            record('transcript.json', sname, f'server-verified signature {i + 1} ({e["kind"]}) == {e["valid"]}', 'core',
                   'python_error' if err else ('agree' if ok == e['valid'] else 'differ'), err or '')
        bodies = [step['response']['body']] + [r['body'] for r in step.get('client_reads', {}).values()]
        for b in bodies:
            for x in ([b] if isinstance(b, dict) else b if isinstance(b, list) else []):
                for part in ('current', 'pending_counter'):
                    c = x.get(part) if isinstance(x, dict) else None
                    if isinstance(c, dict) and c.get('terms'):
                        h, err = attempt(lambda: vc.terms_hash(c['terms']))
                        record('transcript.json', sname, f'{part}.terms_hash recomputed', 'core',
                               'python_error' if err else ('agree' if h == c['terms_hash'] else 'differ'), err or '')
        if not step.get('client_call'):
            continue
        for variant in [None] + step['client_call'].get('variants', []):
            label = 'replay Client.%s' % step['client_call']['method']
            if variant:
                # The variant describes an agent tool (e.g. valun_respond strips the reason before Client.decline). Check
                # that this client's tool layer still makes exactly that call, then replay the reason it would send.
                method = variant.get('client_method') or step['client_call']['method']
                where, calls = os.path.basename(CLIENT['tool_file']), tool_calls(method)
                if len(calls) != 1:
                    record('transcript.json', sname, f'{variant["name"]}: one call of Client.{method} in {where}', 'client_path', 'differ',
                           f'found {len(calls)}: ' + ' | '.join(f'{where}:{n}: {t}' for n, t in calls))
                else:
                    n, text = calls[0]
                    ok = ('.strip()' in text) == bool(variant.get('strip'))
                    record('transcript.json', sname, f'{variant["name"]} sends the reason {"stripped" if variant.get("strip") else "unchanged"} ({where}:{n})',
                           'client_path', 'agree' if ok else 'differ', '' if ok else f'{where}:{n}: {text}')
                    where = f'{where}:{n}'
                label += f' via {variant["name"]} ({where})'
            tier = 'client_path' if variant else 'replay'
            out, err = attempt(lambda: replay(step, meta, participants, variant))
            if err:
                record('transcript.json', sname, label, tier, 'python_error', err)
                continue
            transport, key, raised = out
            problems = list(transport.problems)
            got = transport.captured
            want_err = step['client_call'].get('expect_error')
            if raised is not None and raised.code != want_err:
                problems.append(f'client raised {raised.code}: {raised}')
            if want_err and (raised is None or raised.code != want_err):
                problems.append(f'expected the client to raise {want_err}')
            if got is None:
                problems.append('the client sent no request for this step')
            else:
                want = step['request'].get('body')
                if variant:
                    want = {**want, 'reason': variant['reason_sent']}
                if strip_sigs(got) != strip_sigs(want):
                    problems.append(f'request body differs: python {json.dumps(strip_sigs(got))[:300]} vs recorded {json.dumps(strip_sigs(want))[:300]}')
                stmts = [e for e in step['server_verified'] if e['kind'] == 'statement']
                notes = [e for e in step['server_verified'] if e['kind'] == 'basis_note_message']
                accepts = (variant or step).get('server_accepts')
                if got.get('signature') is not None:
                    if accepts is not None:
                        if not any(verify_hex(got['signature'], bytes.fromhex(f['message_hex']), key['pubkey']) for f in accepts):
                            problems.append('the client\'s signature verifies over none of the statements the server accepts for the body it sent: '
                                            + ' | '.join(repr(f['message_text']) for f in accepts))
                    elif not stmts and step['client_call'].get('expected_statement') is not None:
                        # the server refused before checking any signature; check against the real statements.* template
                        if not verify_hex(got['signature'], step['client_call']['expected_statement'].encode('utf-8'), key['pubkey']):
                            problems.append('the client signature does not verify over ' + repr(step['client_call']['expected_statement']))
                    elif not stmts:
                        problems.append('no statement was verified by the server for this step')
                    elif not verify_hex(got['signature'], bytes.fromhex(stmts[0]['message_hex']), stmts[0]['pubkey']):
                        problems.append(f'the client\'s signature does not verify over the statement the server verified: {stmts[0]["message_text"]!r}')
                cn = got.get('credit_note') if isinstance(got, dict) else None
                if cn:
                    if not notes:
                        problems.append('no note message was verified by the server for this step')
                    elif not verify_hex(cn['signature'], bytes.fromhex(notes[0]['message_hex']), notes[0]['pubkey']):
                        problems.append('the client\'s Basis note signature does not verify over the note message the server verified')
                if got.get('pubkey') and got['pubkey'] != key['pubkey']:
                    problems.append('enrolled a different public key')
            record('transcript.json', sname, label, tier, 'differ' if problems else 'agree', ' | '.join(problems))


# ---------------------------------------------------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Check the valun-deal/1 conformance vectors against a Python client.')
    p.add_argument('--client', choices=('plugin', 'package'), default=os.environ.get('VALUN_CLIENT') or 'plugin',
                   help='plugin = hermes-plugin-valun (default), package = the valun package (default: env VALUN_CLIENT, else plugin)')
    p.add_argument('--plugin-dir', default=os.environ.get('VALUN_PLUGIN_DIR') or os.path.join(HERE, '..', '..', '..', 'hermes-plugin-valun'),
                   help='checkout of hermes-plugin-valun (default: env VALUN_PLUGIN_DIR, else ../../../hermes-plugin-valun)')
    p.add_argument('--package-src', default=os.environ.get('VALUN_PACKAGE_SRC') or os.path.join(REPO, 'python', 'src'),
                   help='folder that contains the valun package (default: env VALUN_PACKAGE_SRC, else python/src of this repository)')
    a = p.parse_args(argv)
    if a.client not in ('plugin', 'package'):
        p.error(f'VALUN_CLIENT must be plugin or package, not {a.client!r}')
    return a


def main(argv=None):
    load_client(parse_args(argv))
    release = vec('canonical.json')['meta'].get('server_release', '?')
    print(f'valun-deal/1 vectors (server release {release}) vs {CLIENT["label"]}')
    for f in (check_canonical, check_statements, check_notes, check_signatures, check_validation, check_transcript):
        f()
    by = {}
    for file, _n, _c, tier, outcome, _d in RESULTS:
        by.setdefault(file, {}).setdefault(tier, {}).setdefault(outcome, 0)
        by[file][tier][outcome] += 1
    print('\nSummary (checks by file, tier and outcome):')
    for file in by:
        print(f'  {file}')
        for tier, outs in sorted(by[file].items()):
            print(f'    {tier:12} ' + ', '.join(f'{k} {v}' for k, v in sorted(outs.items())))
    failing = [r for r in RESULTS if r[3] in FAILING_TIERS and r[4] != 'agree']
    informative = [r for r in RESULTS if r[3] not in FAILING_TIERS and r[4] not in ('agree', 'n/a')]
    if informative:
        print(f'\nInformative differences (edge/generic inputs; do not fail the run): {len(informative)}')
        for file, n, c, tier, o, d in informative:
            print(f'  [{o}] {file} {n} :: {c}' + (f' :: {d[:160]}' if d else ''))
    if failing:
        print(f'\nDISAGREEMENTS between the server and the Python client: {len(failing)}')
        for file, n, c, tier, o, d in failing:
            print(f'  [{tier}/{o}] {file} {n} :: {c}' + (f'\n      {d[:400]}' if d else ''))
    total = len(RESULTS)
    agree = sum(1 for r in RESULTS if r[4] == 'agree')
    print(f'\n[{CLIENT["name"]}] {total} checks: {agree} agree, {len(failing)} disagreements in failing tiers, {len(informative)} informative differences, '
          f'{sum(1 for r in RESULTS if r[4] == "n/a")} not applicable.')
    return 1 if failing else 0


if __name__ == '__main__':
    sys.exit(main())
