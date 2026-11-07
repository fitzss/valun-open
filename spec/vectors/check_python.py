#!/usr/bin/env python3
"""Checks every valun-deal/1 vector against the Python client (hermes-plugin-valun), so the server and that client
provably agree, or the disagreement is reported.

    python spec/vectors/check_python.py            (VALUN_PLUGIN_DIR=<path> overrides ../../../hermes-plugin-valun)

The plugin's modules are imported by path and never modified (bytecode writing is switched off so not even a
__pycache__ file is added). No network: replays of the transcript patch urllib.request.urlopen in this process only.

What is checked
- canonical.json        valun_client.canonical / terms_hash on json.loads(input_json)
- statements.json       valun_client.statement(...) rebuilds each statement; valun_basis.verify checks each signature
                        (and rejects each negative); for decline/dispute every form the real server accepts (the reason as
                        sent and, since v8 as an alternative, its cleaned form), and whether the statement the plugin's
                        Client.decline / Client.dispute would sign for that reason is one of them
- basis-notes.json      valun_basis.debt_key / note_message, signatures where given
- basis-signatures.json valun_basis.verify on Basis's official TV001-TV011
- terms-validation.json terms_hash only (validation is server-only: the Python client has no validator)
- transcript.json       every signature the server verified; every terms_hash in every response; and every step with a
                        client_call is REPLAYED through the real Client method with the recorded responses: its request
                        body must equal the recorded one (signatures aside) and its signatures must verify over the exact
                        bytes the server verified (for decline/dispute: over one of the forms the server accepts for the
                        body the client sent, recorded by a dry run of the real code). Variants (tools.py paths that send
                        a different reason string) are replayed the same way. A step with expect_error must make the
                        client raise that error code.

Outcomes: agree | differ | python_error | n/a. Exit status 1 when any `core`/`terms`/`client_path`/`replay`
check does not agree; `wire`, `refused`, `edge` and `generic` results are informative and never fail the run.
"""
import sys

sys.dont_write_bytecode = True  # never add files to the plugin directory

import copy
import hashlib
import importlib.util
import io
import json
import os
import types
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.abspath(os.environ.get('VALUN_PLUGIN_DIR') or os.path.join(HERE, '..', '..', '..', 'hermes-plugin-valun'))
BASE = 'http://valun.invalid'
try:
    sys.stdout.reconfigure(errors='backslashreplace')
except Exception:
    pass


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(PLUGIN, name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


vb = load('valun_basis')
vc = load('valun_client')  # its `from . import valun_basis` fails outside the package; it then uses sys.modules['valun_basis']
assert vc.vb is vb

RESULTS = []          # (file, name, check, tier, outcome, detail)
FAILING_TIERS = {'core', 'terms', 'client_path', 'replay'}  # 'wire': the Python client refuses float-written numbers (a safe refusal)


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
            record('statements.json', name, 'server refuses the input', 'edge', 'n/a', v['server_outcome'].get('error', ''))
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
            # What the plugin's Client.decline / Client.dispute signs for this reason (valun_client.py:289 / 347: the reason
            # exactly as given, which is also what it sends). It must be one of the forms the server accepts.
            line = 'valun_client.py:289' if v['kind'] == 'decline' else 'valun_client.py:347'
            c, err = attempt(lambda: vc.statement(v['kind'], *pre, vc.sha256_hex(i['reason'])))
            accepted = [v['statement']] + [a['statement'] for a in v.get('accepted_alternatives', [])]
            ctier = 'edge' if tier == 'edge' else 'client_path'
            record('statements.json', name, f'Client.{v["kind"]} signs a form the server accepts ({line})', ctier,
                   'python_error' if err else ('agree' if c in accepted else 'differ'), err or ('' if c in accepted else f'client would sign {c!r}'))
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
            label = 'replay Client.%s%s' % (step['client_call']['method'], f' via {variant["name"]}' if variant else '')
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
def main():
    print(f'valun-deal/1 vectors vs the Python client at {PLUGIN}')
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
    print(f'\n{total} checks: {agree} agree, {len(failing)} disagreements in failing tiers, {len(informative)} informative differences, '
          f'{sum(1 for r in RESULTS if r[4] == "n/a")} not applicable.')
    return 1 if failing else 0


if __name__ == '__main__':
    sys.exit(main())
