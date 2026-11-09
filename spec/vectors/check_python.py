#!/usr/bin/env python3
"""Checks every valun-deal/1 vector against a Python client, so the server and that client provably agree, or the
disagreement is reported. Two clients can be checked (one per run):

    python spec/vectors/check_python.py                    the Hermes plugin (default)
    python spec/vectors/check_python.py --client package   the framework-neutral `valun` package

  --client plugin   hermes-plugin-valun: valun_core/ (0.3.0 and later; agent.py read as text), or valun_basis.py and
                    valun_client.py (earlier; tools.py read as text). Directory:
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
                        Every replay must send the step's request exactly once (a second send is a disagreement), with
                        the recorded Authorization header and exactly the recorded X-Valun-Features header (none where
                        none is recorded: steps 1-147 ran with circulation off), and its body must carry exactly the
                        signatures the recorded body carries (keys `signature` / `*_signature` at any depth, slots of a
                        `signatures` map): none missing and none extra.
                        Since release v16 (steps 148+, circulation on): each server-verified Basis message is rebuilt by
                        the client for its edge; a replayed call starts from its client_state, must sign exactly the
                        signature_fields pointers, each over the message the server verified for that field
                        (server_verified[].field), and must hold client_state_after afterwards.
- circulation.json      (release v16) timestamp residue classes; the 80-byte messages of bound notes, transfer slots
                        and set-off slots; quote digests; the pay statement; the signatures of tracker requests; and the
                        decisions of the client signing firewall (novation.evaluate_consent / evaluate_payer_template /
                        evaluate_bound_template: sign exactly these slots, or refuse with this code; PROTOCOL.md 15.3).

Protocol features: the circulation checks (tiers `circulation` and `consent`) count for a client that declares
'circulation/1' in PROTOCOL_FEATURES (its client or novation module), or for a run given --require circulation/1;
otherwise each is n/a, so a client released before circulating credit is not failed by them.
  --require circulation/1   hold the client to circulating credit whether or not it declares it (the package's CI run);
                            the vectors must then include circulation.json and transcript steps 148+ (exit status 2
                            otherwise, so a wrong --vectors-dir or older vectors cannot pass these checks vacuously)
  --vectors-dir DIR         read the vector files from DIR (default: next to this script)

Outcomes: agree | differ | python_error | n/a. Exit status 1 when any `core`/`terms`/`client_path`/`replay`/
`circulation`/`consent` check does not agree (n/a never fails); `wire`, `refused`, `edge` and `generic` results are
informative and never fail the run. Exit status 2 when the client cannot be found or imported, when the vectors folder
lacks one of the six files every vector set has, or when --require names a feature the vectors do not cover.
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

vb = vc = nv = None   # the client's basis, client and (0.4 and later) novation modules, set by load_client()
CLIENT = {}           # name, label, tool_file, refs, features (declared), required


def fail(message):
    """The run cannot be made (the client cannot be found or imported, a vector file is missing, or the vectors lack what
    --require needs): exit status 2 (status 1 means a disagreement)."""
    print(f'error: {message}', file=sys.stderr)
    raise SystemExit(2)


def load_plugin(plugin_dir):
    plugin_dir = os.path.abspath(plugin_dir)
    core = os.path.join(plugin_dir, 'valun_core')
    if os.path.isfile(os.path.join(core, 'client.py')):   # 0.3.0 and later: the shared core, vendored as valun_core/
        spec = importlib.util.spec_from_file_location('valun_core', os.path.join(core, '__init__.py'), submodule_search_locations=[core])
        pkg = importlib.util.module_from_spec(spec)
        sys.modules['valun_core'] = pkg
        spec.loader.exec_module(pkg)
        b = importlib.import_module('valun_core.basis')
        c = importlib.import_module('valun_core.client')
        n = importlib.import_module('valun_core.novation') if os.path.isfile(os.path.join(core, 'novation.py')) else None
        for m in (pkg, b, c, n):   # never check another copy by accident
            if m is not None and not os.path.abspath(m.__file__).startswith(core + os.sep):
                fail(f'{m.__name__} was imported from {m.__file__}, not from {core}')
        assert c.vb is b
        return (b, c, n, os.path.join(core, 'agent.py'),
                f'the Hermes plugin (hermes-plugin-valun, core {getattr(pkg, "__version__", "?")}) at {plugin_dir}')
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
    return b, c, None, os.path.join(plugin_dir, 'tools.py'), f'the Hermes plugin (hermes-plugin-valun) at {plugin_dir}'


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
    n = importlib.import_module('valun.novation') if os.path.isfile(os.path.join(src, 'valun', 'novation.py')) else None
    for m in (pkg, b, c, n):   # never check an installed copy by accident
        if m is not None and not os.path.abspath(m.__file__).startswith(src + os.sep):
            fail(f'{m.__name__} was imported from {m.__file__}, not from {src}')
    assert c.vb is b
    return b, c, n, os.path.join(src, 'valun', 'agent.py'), f'the valun package {getattr(pkg, "__version__", "?")} at {src}'


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
    global vb, vc, nv
    if args.client == 'plugin':
        vb, vc, nv, tool_file, label = load_plugin(args.plugin_dir)
    else:
        vb, vc, nv, tool_file, label = load_package(args.package_src)
    # The protocol features the client declares (PROTOCOL_FEATURES in its client or novation module, e.g.
    # ('bound_notes/1', 'circulation/1')); --require holds it to a feature whether or not it declares it.
    declared = getattr(vc, 'PROTOCOL_FEATURES', None) or getattr(nv, 'PROTOCOL_FEATURES', None) or ()
    CLIENT.update(name=args.client, label=label, tool_file=tool_file, features=tuple(declared), required=tuple(args.require or ()),
                  refs={'decline': source_ref(vc.Client.decline, "statement('decline'"), 'dispute': source_ref(vc.Client.dispute, "statement('dispute'")})


def supports(feature):
    """Whether the checks of `feature` (circulation/1: transcript steps 148+ and circulation.json) count for this run:
    the client declares it in PROTOCOL_FEATURES, or the run requires it (--require). Otherwise they are n/a, so a
    client released before the feature (for example the Hermes plugin 0.3.0 CI pins) is not failed by them."""
    return feature in CLIENT.get('features', ()) or feature in CLIENT.get('required', ())


def feature_tier(feature):
    return 'circulation' if feature in ('circulation/1', 'bound_notes/1') else 'replay'


RESULTS = []          # (file, name, check, tier, outcome, detail)
FAILING_TIERS = {'core', 'terms', 'client_path', 'replay', 'circulation', 'consent'}  # 'wire': the Python clients refuse float-written numbers (a safe refusal)
# 'circulation' and 'consent' (release v16) are recorded only when the client declares circulation/1 or the run requires
# it (supports()); otherwise each such check is n/a.


def record(file, name, check, tier, outcome, detail=''):
    RESULTS.append((file, name, check, tier, outcome, detail))


def attempt(fn):
    try:
        return fn(), None
    except Exception as e:  # noqa: BLE001 - a Python error is itself a result
        return None, f'{type(e).__name__}: {e}'


VECTORS = HERE        # --vectors-dir: the folder the vector files are read from (default: next to this script)
# The files every vector set has (circulation.json only since release v16).
VECTOR_FILES = ('canonical.json', 'statements.json', 'basis-notes.json', 'basis-signatures.json', 'terms-validation.json', 'transcript.json')


def vec(name):
    with open(os.path.join(VECTORS, name), encoding='utf-8') as f:
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
    if k == 'pay':                       # release v16 (circulation.json): valun-pilot/pay/1 LF deal_id LF quote_digest
        return [i['deal_id'], i['quote_digest']]
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


FEATURES_HEADER = 'X-Valun-Features'      # PROTOCOL.md 18.1: the capability header (release v16)


def header_of(req, name):
    """The value of the request header `name` (compared case-insensitively), or None when the request has none."""
    for k, v in req.header_items():
        if k.lower() == name.lower():
            return v
    return None


class Transport:
    """Answers a replayed client from the step's records: the reads it recorded (client_reads, as often as the client
    asks) and the step's own request, which the recorded run sent once. Of that request the first send is kept (body,
    Authorization and X-Valun-Features headers) and every send is counted (sends), so a client that sends it twice is
    reported."""
    def __init__(self, step, token_placeholder):
        self.reads = step.get('client_reads', {})
        self.req, self.res = step['request'], step['response']
        self.token = token_placeholder
        self.captured, self.sent, self.problems = None, False, []
        self.features, self.sends = None, 0

    def urlopen(self, req, timeout=None):
        method, path = req.get_method(), req.full_url[len(BASE):]
        auth = header_of(req, 'Authorization')
        key = f'{method} {path}'
        if key in self.reads:
            r = self.reads[key]
            return self._answer(req, r['status'], r['body'])
        if method == self.req['method'] and path == self.req['path']:
            self.sends += 1
            if self.sends == 1:
                want = self.req.get('headers', {}).get('authorization')
                if want and auth != want:
                    self.problems.append(f'Authorization header {auth!r}, expected {want!r}')
                self.captured = json.loads(req.data.decode('utf-8')) if req.data else None
                self.features = header_of(req, FEATURES_HEADER)
                self.sent = True
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
    """The body with its signatures taken out, for comparing request bodies (signature bytes may differ between
    implementations: each must verify, which is checked separately). Every key named 'signature' or ending in
    '_signature' is dropped, at any depth and inside lists too; a 'signatures' map (slot -> signature) keeps its slots,
    each with the value '<signature>', so the set of slots signed is still compared."""
    if isinstance(body, list):
        return [strip_sigs(x) for x in body]
    if not isinstance(body, dict):
        return copy.deepcopy(body)
    out = {}
    for k, v in body.items():
        if k == 'signature' or (isinstance(k, str) and k.endswith('_signature')):
            continue
        if k == 'signatures' and isinstance(v, dict):
            out[k] = {slot: '<signature>' for slot in v}
            continue
        out[k] = strip_sigs(v)
    return out


def pointer_escape(key):
    """One reference token of a JSON pointer (RFC 6901): '~' as '~0', '/' as '~1'."""
    return str(key).replace('~', '~0').replace('/', '~1')


def sig_paths(body, base=''):
    """The JSON pointers of every signature a request body carries: each key named 'signature' or ending in
    '_signature', at any depth and inside lists too, and each slot of a 'signatures' map. These are exactly the values
    strip_sigs takes out, so a replay compares this set on its own: a client must send exactly the signatures the
    recorded request carries (no fewer, and none over anything else)."""
    out = set()
    if isinstance(body, list):
        for i, x in enumerate(body):
            out |= sig_paths(x, f'{base}/{i}')
    elif isinstance(body, dict):
        for k, v in body.items():
            p = f'{base}/{pointer_escape(k)}'
            if k == 'signature' or (isinstance(k, str) and k.endswith('_signature')):
                out.add(p)
            elif k == 'signatures' and isinstance(v, dict):
                out |= {f'{p}/{pointer_escape(slot)}' for slot in v}
            else:
                out |= sig_paths(v, p)
    return out


def sig_path_problems(got, want_paths):
    """The differences between the signatures a client's body carries and the ones it must carry (want_paths)."""
    have, want = sig_paths(got), set(want_paths)
    out = []
    if have - want:
        out.append('the request body carries signature(s) the recorded request does not: ' + ', '.join(sorted(have - want)))
    if want - have:
        out.append('the request body lacks signature(s) the recorded request carries: ' + ', '.join(sorted(want - have)))
    return out


def pointer_get(doc, ptr):
    """The value at JSON pointer `ptr` (RFC 6901) in doc, or a KeyError."""
    if ptr == '':
        return doc
    cur = doc
    for raw in ptr.split('/')[1:]:
        part = raw.replace('~1', '/').replace('~0', '~')
        if isinstance(cur, list):
            cur = cur[int(part)]
        elif isinstance(cur, dict):
            cur = cur[part]
        else:
            raise KeyError(ptr)
    return cur


def replay(step, meta, participants, variant=None):
    """Runs the step's client_call through the client's real Client method against the recorded answers. Returns
    (transport, key, raised, state after the call). client_call.client_state (release v16 steps) is the profile's
    records before the call, merged over the enrolled profile (server, participant_id, pubkey, issued)."""
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
            state = {'server': BASE, 'participant_id': pid, 'pubkey': key['pubkey'], 'issued': {}}
            state.update(copy.deepcopy(call.get('client_state') or {}))
            client = vc.Client(FakeStore(state, secret.hex(), token))
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
    return transport, key, raised, client.state


def check_v16_request(step, call, got, key, variant=None):
    """Release v16 steps: the body (signatures aside); the signatures it carries, which must be exactly the fields the
    step names (signature_fields, JSON pointers into the body; none other); and each of those signatures: it must
    verify, under this client's key, over the message the server verified for that field (server_verified[].field), or
    over client_call.expected_messages[field] when the server refused before it verified anything. (The capability
    header is checked for every replay, in check_transcript.)"""
    problems = []
    want = step['request'].get('body')
    if strip_sigs(got) != strip_sigs(want):
        problems.append(f'request body differs: python {json.dumps(strip_sigs(got))[:300]} vs recorded {json.dumps(strip_sigs(want))[:300]}')
    extra = sorted(sig_paths(got) - set(call['signature_fields']))
    if extra:          # a missing one is reported below, field by field
        problems.append('the request body carries signature(s) the step does not name (signature_fields): ' + ', '.join(extra))
    sent = got if got is not None else {}
    by_field = {e['field']: e for e in step['server_verified'] if 'field' in e}
    expected = call.get('expected_messages') or {}
    for ptr in call['signature_fields']:
        try:
            sig = pointer_get(sent, ptr)
        except (KeyError, IndexError, ValueError):
            problems.append(f'no signature at {ptr} in the request body')
            continue
        e = by_field.get(ptr)
        msg = bytes.fromhex(e['message_hex']) if e else bytes.fromhex(expected[ptr]) if ptr in expected else None
        if msg is None:
            problems.append(f'the vectors name no message for the signature at {ptr}')
        elif e is not None and e['pubkey'] != key['pubkey']:
            problems.append(f'the server verified the signature at {ptr} under another key')
        elif not (isinstance(sig, str) and verify_hex(sig, msg, key['pubkey'])):
            problems.append(f'the signature at {ptr} does not verify over ' + (f'the message the server verified ({e["kind"]})' if e else 'the expected message'))
    return problems


def state_problems(state, want, path='state'):
    """client_state_after: the records a client must hold after the call (a subset: only the keys given are compared;
    a dict compares its given keys, a list compares element by element and must have the same length, other values
    compare equal; the value None means the key must be absent or None)."""
    out = []
    if isinstance(want, dict):
        if want and not isinstance(state, dict):
            return [f'{path} is {json.dumps(state)[:120]}, not an object']
        for k, v in want.items():
            if v is None:
                if isinstance(state, dict) and state.get(k) is not None:
                    out.append(f'{path}.{k} is {json.dumps(state.get(k))[:120]}, expected none')
                continue
            if not isinstance(state, dict) or k not in state:
                out.append(f'{path}.{k} is missing')
                continue
            out += state_problems(state[k], v, f'{path}.{k}')
        return out
    if isinstance(want, list):
        if not isinstance(state, list) or len(state) != len(want):
            return [f'{path} is {json.dumps(state)[:160]}, expected {len(want)} item(s) like {json.dumps(want)[:160]}']
        for i, (x, y) in enumerate(zip(state, want)):
            out += state_problems(x, y, f'{path}[{i}]')
        return out
    return [] if state == want else [f'{path} is {json.dumps(state)[:120]}, expected {json.dumps(want)[:120]}']


def rebuilt_message(edge, message_hex, meta):
    """note_message(issuer, recipient, total, timestamp, tracker, unit) for the edge, with the total and the timestamp
    read from the message itself (bytes 32-40 and 40-48, big-endian): equal to message_hex when the client's message
    builder agrees on the debt key and the layout."""
    issuer, recipient = edge.split('>')
    raw = bytes.fromhex(message_hex)
    total, ts = int.from_bytes(raw[32:40], 'big'), int.from_bytes(raw[40:48], 'big')
    return vb.note_message(bytes.fromhex(issuer), bytes.fromhex(recipient), total, ts, bytes.fromhex(meta['fixture_tracker_nft_id']),
                           meta['pilot_denomination']).hex()


def check_transcript():
    data = vec('transcript.json')
    meta, participants = data['meta'], data['participants']
    for step in data['steps']:
        sname = f'step {step["n"]}: {step["label"][:70]}'
        for i, e in enumerate(step['server_verified']):
            ok, err = attempt(lambda: verify_hex(e['signature'], bytes.fromhex(e['message_hex']), e['pubkey']))
            record('transcript.json', sname, f'server-verified signature {i + 1} ({e["kind"]}) == {e["valid"]}', 'core',
                   'python_error' if err else ('agree' if ok == e['valid'] else 'differ'), err or '')
            if e.get('edge'):           # release v16: the 80-byte message rebuilt from its edge, total and timestamp
                m, err = attempt(lambda: rebuilt_message(e['edge'], e['message_hex'], meta))
                record('transcript.json', sname, f'server-verified message {i + 1} rebuilt for edge {e["edge"][:8]}..>{e["edge"].split(">")[1][:8]}..', 'core',
                       'python_error' if err else ('agree' if m == e['message_hex'] else 'differ'), err or '')
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
            feature = step['client_call'].get('feature')
            tier = 'client_path' if variant else feature_tier(feature) if feature else 'replay'
            if feature and not supports(feature):
                record('transcript.json', sname, label, tier, 'n/a', f'the client does not declare {feature} (PROTOCOL_FEATURES) and the run does not --require it')
                continue
            out, err = attempt(lambda: replay(step, meta, participants, variant))
            if err:
                record('transcript.json', sname, label, tier, 'python_error', err)
                continue
            transport, key, raised, after = out
            problems = list(transport.problems)
            got = transport.captured
            call = step['client_call']
            want_err = call.get('expect_error')
            if raised is not None and raised.code != want_err:
                problems.append(f'client raised {raised.code}: {raised}')
            if want_err and (raised is None or raised.code != want_err):
                problems.append(f'expected the client to raise {want_err}')
            if transport.sends > 1:
                problems.append(f'the client sent the step\'s request ({step["request"]["method"]} {step["request"]["path"]}) {transport.sends} times; '
                                'the recorded run sent it once')
            if transport.sent:
                # The capability header (PROTOCOL.md 18.1) exactly as recorded: none where none is recorded (steps 1-147
                # ran with circulation off, so a client sends none there; decision D-2 h), the roles its records declare
                # after GET /info lists circulation/1, and the empty list once to withdraw them (decision D-3 b).
                hdr = step['request'].get('headers', {}).get(FEATURES_HEADER.lower())
                if transport.features != hdr:
                    problems.append(f'{FEATURES_HEADER} header {transport.features!r}, expected '
                                    + (repr(hdr) if hdr is not None else 'none (the recorded request carries none)'))
            if not transport.sent and call.get('expect_no_request'):
                pass                            # the client must refuse before it sends anything (checked by expect_error)
            elif transport.sent and call.get('expect_no_request'):
                problems.append('the client sent the request, but it must refuse before sending anything')
            elif not transport.sent:
                problems.append('the client sent no request for this step')
            elif 'signature_fields' in call:
                problems += check_v16_request(step, call, got, key, variant)
            else:
                want = step['request'].get('body')
                if variant:
                    want = {**want, 'reason': variant['reason_sent']}
                if strip_sigs(got) != strip_sigs(want):
                    problems.append(f'request body differs: python {json.dumps(strip_sigs(got))[:300]} vs recorded {json.dumps(strip_sigs(want))[:300]}')
                problems += sig_path_problems(got, sig_paths(want))
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
            if 'client_state_after' in call:
                problems += [f'client records after the call: {x}' for x in state_problems(after, call['client_state_after'])]
            record('transcript.json', sname, label, tier, 'differ' if problems else 'agree', ' | '.join(problems))


# ---------------------------------------------------------------------------------------------------------------------
# circulation.json (release v16, circulating credit; PROTOCOL.md 15.3 and 18)
def guarded_verify(pubkey_hex, msg, sig_hex):
    """The evaluators' verify(pubkey_hex, msg_bytes, sig_hex): False for anything that is not a valid signature."""
    try:
        return vb.verify(bytes.fromhex(sig_hex), msg, bytes.fromhex(pubkey_hex))
    except Exception:  # noqa: BLE001 - not hex, wrong length: does not verify
        return False


EVALUATORS = {'consent': 'evaluate_consent', 'payer_template': 'evaluate_payer_template', 'bound_template': 'evaluate_bound_template'}


def evaluate(v):
    """Runs the client's own evaluator for one decision vector (novation.evaluate_consent / evaluate_payer_template /
    evaluate_bound_template) with the vector's context and this client's Basis verifier."""
    ctx = copy.deepcopy(v['ctx'])
    ctx['verify'] = guarded_verify
    return getattr(nv, EVALUATORS[v['evaluator']])(copy.deepcopy(v['input']), ctx)


def check_decision(v, meta, file):
    name, tier = v['name'], 'consent'
    if not supports('circulation/1'):
        record(file, name, f'{v["evaluator"]} decision', tier, 'n/a', 'the client does not declare circulation/1 and the run does not --require it')
        return
    if nv is None or not hasattr(nv, EVALUATORS[v['evaluator']]):
        record(file, name, f'{v["evaluator"]} decision', tier, 'python_error', f'the client has no novation.{EVALUATORS[v["evaluator"]]}')
        return
    r, err = attempt(lambda: evaluate(v))
    if err:
        record(file, name, f'{v["evaluator"]} decision', tier, 'python_error', err)
        return
    want = v['expected']
    problems = []
    if want == 'sign':
        if not r.get('ok'):
            problems.append(f'refused with {r.get("code")}: {str((r.get("summary") or {}).get("reason"))[:160]}')
        else:
            slots = [t[0] for t in r['to_sign']]
            if slots != v['slots']:
                problems.append(f'signs slots {slots}, expected {v["slots"]}')
            else:
                msgs, e2 = attempt(lambda: nv.slot_messages(r['to_sign'], meta['fixture_tracker_nft_id'], meta['pilot_denomination']))
                if e2:
                    problems.append(f'slot_messages: {e2}')
                else:
                    for slot in slots:
                        if msgs[slot].hex() != v['messages'][slot]:
                            problems.append(f'the message for {slot} differs')
    else:
        code = want['refuse']
        if r.get('ok'):
            problems.append(f'would sign {[t[0] for t in r.get("to_sign") or []]}; expected the refusal {code}')
        elif r.get('code') != code:
            problems.append(f'refused with {r.get("code")}, expected {code}: {str((r.get("summary") or {}).get("reason"))[:160]}')
    for k, x in (v.get('summary') or {}).items():
        got = (r.get('summary') or {}).get(k)
        if got != x:
            problems.append(f'summary.{k} is {json.dumps(got)[:120]}, expected {json.dumps(x)[:120]}')
    label = f'{v["evaluator"]} decision: ' + ('sign ' + ', '.join(sl.split(':')[-1] for sl in v.get('slots', [])) if want == 'sign' else f'refuse {want["refuse"]}')
    record(file, name, label, tier, 'differ' if problems else 'agree', ' | '.join(problems))


def check_circulation():
    path = os.path.join(VECTORS, 'circulation.json')
    if not os.path.isfile(path):
        return
    data = vec('circulation.json')
    meta, file = data['meta'], 'circulation.json'
    nft, denom = meta['fixture_tracker_nft_id'], meta['pilot_denomination']
    circ = supports('circulation/1')
    # Timestamp residues (PROTOCOL.md 18.4): which operation each ending is for, and whether an ordinary note may use it.
    for v in data['timestamps']:
        if 'accepted_as' not in v:      # the server's choice of a timestamp (novationTimestamp): server-side, informative
            record(file, v['name'], 'server choice of the timestamp (server-side rule)', 'edge', 'n/a', json.dumps(v.get('server_choice')))
            continue
        if not circ or nv is None:
            record(file, v['name'], 'residue classes', 'circulation', 'n/a' if not circ else 'python_error',
                   'the client does not declare circulation/1 and the run does not --require it' if not circ else 'the client has no novation module')
            continue
        def classes(ts):
            safe = isinstance(ts, int) and not isinstance(ts, bool) and 0 <= ts <= nv.MAX_SAFE_INTEGER   # every signed number is a safe integer
            return {'ordinary': safe and ts % 1000 not in nv.RESERVED_MS, **{k: safe and ts % 1000 == nv.RESIDUE[k] for k in ('bound', 'transfer', 'setoff')}}
        got, err = attempt(lambda: classes(v['ts']))
        record(file, v['name'], 'residue classes', 'circulation', 'python_error' if err else ('agree' if got == v['accepted_as'] else 'differ'),
               err or ('' if got == v['accepted_as'] else f'python {got} vs {v["accepted_as"]}'))
    # Every message a circulation operation signs is the 80-byte Basis note message M(I,R,t,ts).
    for v in data['messages']:
        m, err = attempt(lambda: vb.note_message(bytes.fromhex(v['issuer_pubkey']), bytes.fromhex(v['recipient_pubkey']), v['total'], v['timestamp'],
                                                 bytes.fromhex(v['tracker_nft_id']), v['denomination']).hex())
        record(file, v['name'], 'note message', 'core', 'python_error' if err else ('agree' if m == v['message_hex'] else 'differ'), err or '')
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['message_hex']), v['signer_pubkey']))
        record(file, v['name'], f'signature verifies == {v.get("valid", True)}', 'core', 'python_error' if err else ('agree' if ok == v.get('valid', True) else 'differ'), err or '')
    # The transfer quote and its digest (PROTOCOL.md 18.3 item 4).
    for v in data['quote_digests']:
        c, err = attempt(lambda: vc.canonical(v['quote']))
        record(file, v['name'], 'canonical(Q)', 'core', 'python_error' if err else ('agree' if c == v['canonical'] else 'differ'), err or '')
        h, err = attempt(lambda: vc.sha256_hex(v['canonical']))
        record(file, v['name'], 'quote_digest = sha256hex(canonical(Q))', 'core', 'python_error' if err else ('agree' if h == v['quote_digest'] else 'differ'), err or '')
        if not circ:
            record(file, v['name'], 'novation.quote_digest', 'circulation', 'n/a', 'the client does not declare circulation/1 and the run does not --require it')
            continue
        q, err = attempt(lambda: nv.quote_digest(v['quote']))
        record(file, v['name'], 'novation.quote_digest', 'circulation', 'python_error' if err else ('agree' if q == v['quote_digest'] else 'differ'), err or '')
    # The pay statement (valun-pilot/pay/1): text, bytes, signature.
    for v in data['statements']:
        st, err = attempt(lambda: vc.statement(v['kind'], *statement_parts(v)))
        ok = not err and st == v['statement'] and st.encode('utf-8').hex() == v['statement_utf8_hex']
        record(file, v['name'], 'statement text', 'core', 'python_error' if err else ('agree' if ok else 'differ'), err or ('' if ok else f'python {st!r}'))
        ok, err = attempt(lambda: verify_hex(v['signature'], bytes.fromhex(v['statement_utf8_hex']), v['pubkey']))
        record(file, v['name'], f'signature verifies == {v.get("valid", True)}', 'core', 'python_error' if err else ('agree' if ok == v.get('valid', True) else 'differ'), err or '')
        if circ and nv is not None and v['kind'] == 'pay':
            ps, err = attempt(lambda: nv.pay_statement(v['inputs']['deal_id'], v['inputs']['quote_digest']))
            record(file, v['name'], 'novation.pay_statement', 'circulation', 'python_error' if err else ('agree' if ps == v['statement'] else 'differ'), err or '')
    # Tracker requests (POST /notes/transfer, /notes/setoff): each signature over the message the tracker checks for its
    # field, rebuilt by the client; the tracker's answer itself is tracker-side (informative).
    for group in ('transfers', 'setoffs'):
        for v in data[group]:
            for sg in v['signatures']:
                m, err = attempt(lambda: vb.note_message(bytes.fromhex(sg['issuer_pubkey']), bytes.fromhex(sg['recipient_pubkey']), sg['total'], sg['timestamp'],
                                                         bytes.fromhex(nft), denom).hex())
                record(file, v['name'], f'{sg["field"]}: message', 'core', 'python_error' if err else ('agree' if m == sg['message_hex'] else 'differ'), err or '')
                ok, err = attempt(lambda: guarded_verify(sg['signer_pubkey'], bytes.fromhex(sg['message_hex']), sg['signature']))
                record(file, v['name'], f'{sg["field"]}: verifies == {sg["valid"]}', 'core', 'python_error' if err else ('agree' if ok == sg['valid'] else 'differ'), err or '')
            o = v['tracker_outcome']
            record(file, v['name'], 'tracker outcome (tracker-side rule)', 'edge', 'n/a', f'{o.get("status")} {o.get("code") or ""}'.strip())
    # The client's signing firewall (PROTOCOL.md 15.3): sign exactly these slots, or refuse with this code.
    for group in ('consents', 'payer_templates', 'bound_templates'):
        for v in data[group]:
            check_decision(v, meta, file)


# ---------------------------------------------------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description='Check the valun-deal/1 conformance vectors against a Python client.')
    p.add_argument('--client', choices=('plugin', 'package'), default=os.environ.get('VALUN_CLIENT') or 'plugin',
                   help='plugin = hermes-plugin-valun (default), package = the valun package (default: env VALUN_CLIENT, else plugin)')
    p.add_argument('--plugin-dir', default=os.environ.get('VALUN_PLUGIN_DIR') or os.path.join(HERE, '..', '..', '..', 'hermes-plugin-valun'),
                   help='checkout of hermes-plugin-valun (default: env VALUN_PLUGIN_DIR, else ../../../hermes-plugin-valun)')
    p.add_argument('--package-src', default=os.environ.get('VALUN_PACKAGE_SRC') or os.path.join(REPO, 'python', 'src'),
                   help='folder that contains the valun package (default: env VALUN_PACKAGE_SRC, else python/src of this repository)')
    p.add_argument('--vectors-dir', default=HERE, help='folder holding the vector files (default: the folder of this script)')
    p.add_argument('--require', action='append', metavar='FEATURE', choices=('circulation/1',),
                   help='hold the client to a protocol feature (circulation/1: transcript steps 148+ and circulation.json) even if it '
                        'does not declare it in PROTOCOL_FEATURES; without it those checks count only for a client that declares it')
    a = p.parse_args(argv)
    if a.client not in ('plugin', 'package'):
        p.error(f'VALUN_CLIENT must be plugin or package, not {a.client!r}')
    return a


def main(argv=None):
    global VECTORS
    args = parse_args(argv)
    VECTORS = os.path.abspath(args.vectors_dir)
    absent = [f for f in VECTOR_FILES if not os.path.isfile(os.path.join(VECTORS, f))]
    if absent:
        fail(f'{VECTORS} holds no vector set: it has no {", ".join(absent)} (see --vectors-dir)')
    load_client(args)
    release = vec('canonical.json')['meta'].get('server_release', '?')
    print(f'valun-deal/1 vectors (server release {release}) vs {CLIENT["label"]}')
    missing = []
    if supports('circulation/1'):
        missing = [] if os.path.isfile(os.path.join(VECTORS, 'circulation.json')) else ['circulation.json']
        if not any((s.get('client_call') or {}).get('feature') == 'circulation/1' for s in vec('transcript.json')['steps']):
            missing.append('transcript steps for circulation/1 (148 and later)')
        if missing and 'circulation/1' in CLIENT['required']:
            fail(f'--require circulation/1, but the vectors in {VECTORS} have no {" and no ".join(missing)}: they predate release v16, or '
                 '--vectors-dir names the wrong folder, so the checks this run requires cannot be made')
        if missing:
            print(f'note: the vectors in {VECTORS} have no {" and no ".join(missing)} (vectors from before release v16): '
                  'the circulation/1 checks are not made')
    held = [f for f in ('circulation/1',) if supports(f) and not missing]
    print(f'protocol features: declared {list(CLIENT["features"]) or "none"}; required {list(CLIENT["required"]) or "none"}; '
          + (f'checked: {", ".join(held)}' if held else 'circulation/1 checks are n/a'))
    for f in (check_canonical, check_statements, check_notes, check_signatures, check_validation, check_transcript, check_circulation):
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
    failing = [r for r in RESULTS if r[3] in FAILING_TIERS and r[4] not in ('agree', 'n/a')]   # n/a: a check that does not apply to this client
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
