"""The client's transport (fix inbox #132; the muse tester report, 2026-11-17): urllib calls to valun.tech failed with
RemoteDisconnected or IncompleteRead, `valun doctor` then said "The server refused this agent ... enroll again", and
the agent tools answered internal_error. Now Client.request sends a read again (GET, at most three tries) when its
answer is cut, when a proxy answers 502, 503 or 504 itself, or when its answer is not JSON; never a write, whose
outcome it reports as unknown. It asks for gzip and decodes it, error answers too. What still fails is unreachable
(cause connection_cut or not_connected) or bad_response (cause not_json), with words that say what it means; doctor
says "refused" only for a 401 or 403, and never suggests revoking or enrolling for a cut connection. After the RC's
review: a request whose answer did not come within the timeout is never sent again (cause timed_out), a server URL
that is not valid is not_connected (never a cut), and a gzip answer is decoded to at most MAX_ANSWER_BYTES.

The fault server is a real HTTP/1.1 server on loopback that answers as Node's send() does behind Fly (chunked, no
Content-Length) and cuts chosen answers the ways the report saw: no answer at all (RemoteDisconnected), part of the
body (IncompleteRead), the whole body without its last chunk. Test data only; nothing leaves this machine."""
import base64
import contextlib
import gzip
import http.client
import http.server
import io
import json
import os
import re
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zlib
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import agent as va  # noqa: E402
from valun import basis as vb  # noqa: E402
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402

INFO = {'network': 'valun-testnet-1', 'unit': 'nanoERG', 'tracker_nft_id': 'aa' * 32, 'denomination': 'erg',
        'features': [], 'pad': 'x' * 6200}
ME = {'participant': {'id': 'vp_0a0a0a0a0a0a', 'handle': 'tester', 'status': 'active'}, 'mandate_version': 1,
      'mandate': {'max_issue_per_deal': 5_000_000, 'max_issue_outstanding': 40_000_000, 'approve_above': 0},
      'position': {}, 'authority': {}, 'pad': 'x' * 6000}
SECRET, TOKEN = '11' * 32, 'vpa_TEST-ONLY-transport'


class FaultServer:
    """schedule: {'METHOD /path': [mode, ...]}, one mode per request in order (the last one repeats; 'ok' for a route
    not named). Modes: ok; gzip (the body gzip-compressed, Content-Encoding: gzip); nothing (the request is read and the
    connection closed with no answer: RemoteDisconnected); partial (4337 bytes of the body, then closed: IncompleteRead);
    noterm (the whole body without the last chunk, then closed); html (200 with a page that is not JSON); proxy502 (502
    with a proxy's page, no Valun error); busy503 (503 with a Valun error: the server's own answer); hang (the request is
    read and nothing is answered until the server is closed: a busy server, for the client's timeout). seen: each
    request as (method, path, its Accept-Encoding header)."""

    def __init__(self, schedule=None):
        self.schedule, self.seen, self.counts, self.lock = dict(schedule or {}), [], {}, threading.Lock()
        self.release = threading.Event()        # ends the waits of 'hang'
        outer = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                outer.handle(self)

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.httpd = Server(('127.0.0.1', 0), Handler)
        self.base = f'http://127.0.0.1:{self.httpd.server_address[1]}'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.release.set()
        self.httpd.shutdown()
        self.httpd.server_close()

    def answer(self, method, path):
        if path == '/pilot/v1/info':
            return 200, INFO
        if path == '/pilot/v1/me':
            return 200, ME
        if method == 'POST' and path == '/pilot/v1/deals':
            return 201, {'id': 'vd_0123456789abcdef', 'status': 'open'}
        return 404, {'error': 'not_found', 'message': 'no such route'}

    def handle(self, h):
        line = h.rfile.readline().decode('latin1').strip()
        if not line:
            return
        method, target, _ = line.split(' ', 2)
        headers = {}
        while True:
            x = h.rfile.readline().decode('latin1')
            if x in ('\r\n', '\n', ''):
                break
            k, v = x.split(':', 1)
            headers[k.strip().lower()] = v.strip()
        h.rfile.read(int(headers.get('content-length', '0') or 0))
        path = target.split('?')[0]
        key = f'{method} {path}'
        with self.lock:
            n = self.counts.get(key, 0)
            self.counts[key] = n + 1
            self.seen.append((method, path, headers.get('accept-encoding')))
        modes = self.schedule.get(key, ['ok'])
        mode = modes[min(n, len(modes) - 1)]
        if mode == 'nothing':
            return
        if mode == 'hang':          # a busy server: the request is read, and no answer comes while the test runs
            self.release.wait(30)
            return
        status, obj = self.answer(method, path)
        body, extra = json.dumps(obj, indent=1).encode(), ''
        if mode == 'html':
            status, body = 200, b'<html><body>Sign in to this network to continue</body></html>'
        elif mode == 'proxy502':
            status, body = 502, b'<html><body>502 Bad Gateway</body></html>'
        elif mode == 'busy503':
            status, body = 503, json.dumps({'error': 'tracker_unavailable', 'message': 'try again in a minute'}).encode()
        elif mode == 'gzip':
            body, extra = gzip.compress(body), 'Content-Encoding: gzip\r\n'
        head = (f'HTTP/1.1 {status} X\r\nContent-Type: application/json; charset=utf-8\r\n{extra}Connection: close\r\n'
                'Transfer-Encoding: chunked\r\n\r\n').encode()
        if mode == 'partial':
            h.wfile.write(head + f'{len(body):X}\r\n'.encode() + body[:4337])
        elif mode == 'noterm':
            h.wfile.write(head + f'{len(body):X}\r\n'.encode() + body + b'\r\n')
        else:
            h.wfile.write(head + f'{len(body):X}\r\n'.encode() + body + b'\r\n0\r\n\r\n')
        h.wfile.flush()
        try:
            h.connection.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    def count(self, key):
        return self.counts.get(key, 0)


def opening(fn):
    """Every Client's one try (Client._open, its own opener) answered by fn(req, timeout) instead: a test's own
    answers, raised or returned as urllib's would be."""
    return mock.patch.object(vc.Client, '_open', lambda c, req: fn(req, timeout=c.timeout))


class Mem:
    def __init__(self, state=None, secret=None, token=None):
        self.state, self._secret, self._token = dict(state or {}), secret, token

    def secret(self):
        return self._secret

    def token(self):
        return self._token

    def save(self):
        pass

    def save_credentials(self, secret, token):
        self._secret, self._token = secret, token


class Base(unittest.TestCase):
    schedule = None

    def setUp(self):
        self.fs = FaultServer(self.schedule)
        self.addCleanup(self.fs.close)
        fast = mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0))     # the same tries, without the waits
        fast.start()
        self.addCleanup(fast.stop)

    def client(self, **state):
        return vc.Client(Mem(dict({'server': self.fs.base}, **state), SECRET, TOKEN), timeout=10)

    def cut(self, key, *modes):
        self.fs.schedule[key] = list(modes)


class Reads(Base):
    def test_a_read_whose_answer_is_cut_is_sent_again_and_succeeds(self):
        for modes in (['nothing', 'ok'], ['partial', 'noterm', 'ok'], ['html', 'ok'], ['proxy502', 'ok']):
            self.fs.counts.clear()
            self.cut('GET /pilot/v1/info', *modes)
            self.assertEqual(self.client().request('GET', '/pilot/v1/info', auth=False)['network'], 'valun-testnet-1', modes)
            self.assertEqual(self.fs.count('GET /pilot/v1/info'), len(modes), modes)

    def test_a_read_cut_every_time_is_unreachable_connection_cut_after_three_tries(self):
        for mode, error in (('nothing', 'RemoteDisconnected'), ('partial', 'IncompleteRead'), ('noterm', 'IncompleteRead')):
            self.fs.counts.clear()
            self.cut('GET /pilot/v1/me', mode)
            with self.assertRaises(vc.ValunError) as e:
                self.client().me()
            x = e.exception
            self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('transport_error')),
                             ('unreachable', None, 'connection_cut', error), mode)
            self.assertNotIn('outcome', x.extra, 'a read changes nothing at the server')
            self.assertIn(f'the connection to {self.fs.base} was cut before its whole answer arrived', str(x))
            self.assertIn('(3 tries). The server was reached, so this is the network between this machine and the server',
                          str(x))
            self.assertIn('not a refusal', str(x))
            self.assertEqual(self.fs.count('GET /pilot/v1/me'), 3, mode)
            self.assertTrue(vc.transport_cut(x) and vc.answer_unread(x))

    def test_an_answer_that_is_never_json_is_bad_response_not_json(self):
        self.cut('GET /pilot/v1/info', 'html')
        with self.assertRaises(vc.ValunError) as e:
            self.client().request('GET', '/pilot/v1/info', auth=False)
        x = e.exception
        self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('http_status')), ('bad_response', None, 'not_json', 200))
        self.assertIn('is not JSON (HTTP 200, 61 bytes, 3 tries): it was cut short, or something between this machine and the '
                      'server (a captive portal, a proxy or antivirus) answered instead', str(x))
        self.assertEqual(self.fs.count('GET /pilot/v1/info'), 3)

    def test_the_servers_own_error_is_answered_at_once(self):
        self.cut('GET /pilot/v1/me', 'busy503')
        with self.assertRaises(vc.ValunError) as e:
            self.client().me()
        self.assertEqual((e.exception.code, e.exception.status), ('tracker_unavailable', 503))
        self.assertEqual(self.fs.count('GET /pilot/v1/me'), 1, 'a Valun error is the server\'s answer: not sent again')
        with self.assertRaises(vc.ValunError) as e:
            self.client().request('GET', '/pilot/v1/nowhere')
        self.assertEqual((e.exception.code, e.exception.status, str(e.exception)), ('not_found', 404, 'no such route'))
        self.assertEqual(self.fs.count('GET /pilot/v1/nowhere'), 1)
        self.cut('GET /pilot/v1/me', 'proxy502')
        with self.assertRaises(vc.ValunError) as e:
            self.client().me()
        self.assertEqual((e.exception.code, e.exception.status, str(e.exception)), ('http_error', 502, 'HTTP 502'))

    def test_gzip_is_asked_for_and_decoded_also_in_an_error_answer(self):
        self.cut('GET /pilot/v1/info', 'gzip')
        self.cut('GET /pilot/v1/nowhere', 'gzip')
        self.assertEqual(self.client().request('GET', '/pilot/v1/info', auth=False)['pad'], 'x' * 6200)
        with self.assertRaises(vc.ValunError) as e:
            self.client().request('GET', '/pilot/v1/nowhere')
        self.assertEqual((e.exception.code, e.exception.status), ('not_found', 404))
        self.assertEqual({enc for _m, _p, enc in self.fs.seen}, {'gzip'})

    def test_a_connection_that_cannot_be_made_is_not_sent_again_but_one_cut_while_it_is_set_up_is(self):
        calls = []

        def refused(req, timeout=None):
            calls.append(req.full_url)
            raise urllib.error.URLError(ConnectionRefusedError(10061, 'refused'))
        with opening(refused), self.assertRaises(vc.ValunError) as e:
            self.client().me()
        self.assertEqual((e.exception.code, e.exception.extra.get('cause'), len(calls)), ('unreachable', 'not_connected', 1))
        self.assertTrue(str(e.exception).startswith(f'cannot reach {self.fs.base}: '), str(e.exception))
        self.assertFalse(vc.transport_cut(e.exception))
        calls.clear()

        def reset(req, timeout=None):
            calls.append(req.full_url)
            raise urllib.error.URLError(ConnectionResetError(10054, 'reset by peer'))
        with opening(reset), self.assertRaises(vc.ValunError) as e:
            self.client().me()
        self.assertEqual((e.exception.extra.get('cause'), e.exception.extra.get('transport_error'), len(calls)),
                         ('not_connected', 'ConnectionResetError', 3))
        self.assertIn('(3 tries)', str(e.exception))


class Writes(Base):
    def test_a_write_is_sent_once_and_its_cut_answer_has_an_unknown_outcome(self):
        for mode, cause in (('nothing', 'connection_cut'), ('partial', 'connection_cut'), ('html', 'not_json')):
            self.fs.counts.clear()
            self.cut('POST /pilot/v1/deals', mode)
            with self.assertRaises(vc.ValunError) as e:
                self.client().request('POST', '/pilot/v1/deals', {'terms': {}})
            x = e.exception
            self.assertEqual((x.status, x.extra.get('cause'), x.extra.get('outcome')), (None, cause, 'unknown'), mode)
            self.assertIn('The request was sent, so the server may have done it: read what it holds before sending it again',
                          str(x))
            self.assertEqual(self.fs.count('POST /pilot/v1/deals'), 1, 'a write is never sent again')
            self.assertTrue(vc.answer_unread(x), 'an enrollment is sent again on it, by its own rule')


class Timeouts(Base):
    """The 0.7.2 review (p3): a read whose answer did not come within the client's timeout was sent twice more, so a GET
    to a busy server took three timeouts (about 92 s at the default 30 s), tripled its load, and was reported as a cut
    connection of this machine's network. Now a request that timed out is never sent again, and is named so."""

    def ask(self, method, path, timeout=0.5):
        c = vc.Client(Mem({'server': self.fs.base}, SECRET, TOKEN), timeout=timeout)
        t0 = time.monotonic()
        with self.assertRaises(vc.ValunError) as e:
            c.request(method, path, {'terms': {}} if method == 'POST' else None)
        return e.exception, time.monotonic() - t0

    def test_a_read_or_a_write_whose_answer_does_not_come_in_time_is_asked_once_and_named_for_what_it_is(self):
        for method, path in (('GET', '/pilot/v1/me'), ('POST', '/pilot/v1/deals')):
            self.cut(f'{method} {path}', 'hang')
            x, took = self.ask(method, path)
            self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('transport_error'), x.extra.get('timeout_s')),
                             ('unreachable', None, 'timed_out', 'TimeoutError', 0.5), method)
            self.assertEqual(self.fs.count(f'{method} {path}'), 1, 'a request that timed out is not sent again')
            self.assertLess(took, 10, 'one timeout, and no hang')
            self.assertIn(f'{self.fs.base} did not answer within 0.5 s (TimeoutError: timed out)', str(x))
            self.assertNotIn('cut', str(x))
            self.assertNotIn('tries', str(x))
            self.assertTrue(vc.transport_cut(x) and vc.answer_unread(x), 'the server was reached; not a refusal')
            if method == 'GET':
                self.assertNotIn('outcome', x.extra)
                self.assertIn('it may be busy', str(x))
                self.assertEqual(va.error_payload(x)['what_this_means'], va.TRANSPORT_WORDS['timed_out|'])
            else:
                self.assertEqual(x.extra.get('outcome'), 'unknown')
                self.assertIn('The request was sent, so the server may have done it', str(x))
                self.assertEqual(va.error_payload(x)['what_this_means'], va.TRANSPORT_WORDS['timed_out|unknown'])

    def test_the_network_an_enrollment_signs_for_is_read_with_one_request(self):
        # enroll's own three tries around Client.request made up to nine requests (about 99 s) to a stuck server
        self.cut('GET /pilot/v1/info', 'hang')
        self.assertIsNone(cli._server_network(self.fs.base, timeout=0.5))
        self.assertEqual(self.fs.count('GET /pilot/v1/info'), 1)
        # a cut answer is read again, by the transport itself
        self.fs.counts.clear()
        self.cut('GET /pilot/v1/info', 'nothing', 'ok')
        self.assertEqual(cli._server_network(self.fs.base), 'valun-testnet-1')
        self.assertEqual(self.fs.count('GET /pilot/v1/info'), 2)


class ServerUrls(Base):
    """The 0.7.2 review (p4): `doctor --server http://127.0.0.1:80x` said the connection was cut before its answer was
    complete (InvalidURL, 3 tries) and to try another network: http.client refuses the URL before anything is sent, and
    the transport took that for a cut. A server URL that is not valid is now not_connected, never sent (since the RC's
    review, round 3, judged before anything is sent: client.server_problem, naming the setting)."""

    def test_a_server_url_that_is_not_valid_is_never_sent_and_never_a_cut(self):
        calls, real = [], vc.Client._open

        def counting(c, req):
            calls.append(req.full_url)
            return real(c, req)
        for url, words in (('http://127.0.0.1:80x', 'has a port that is not a number from 1 to 65535'),
                           ('valun.tech', 'has no scheme (a server URL starts with https://)')):
            calls.clear()
            for method in ('GET', 'POST'):
                with mock.patch.object(vc.Client, '_open', counting), self.assertRaises(vc.ValunError) as e:
                    vc.Client(Mem({'server': url}), timeout=5).request(method, '/pilot/v1/info', {} if method == 'POST' else None,
                                                                       auth=False)
                x = e.exception
                self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('transport_error')),
                                 ('unreachable', None, 'not_connected', 'ValueError'), url)
                self.assertEqual(str(x), "This profile's server must be an http(s) URL with a host, such as "
                                         f'https://valun.tech: "{url}" {words}. Nothing was sent.')
                self.assertNotIn('outcome', x.extra, 'nothing was sent')
                self.assertFalse(vc.transport_cut(x))
            self.assertEqual(calls, [], 'never sent')


class Gzip(unittest.TestCase):
    """The 0.7.2 review: every request asks for gzip, and an answer was decompressed whole, so a small body from a broken
    or hostile server or proxy could expand (about 1000:1) until it filled this machine's memory. An answer is now
    decoded to at most MAX_ANSWER_BYTES (64 MB), and one that expands further is bad_response, cause too_large."""
    GZ = {'Content-Encoding': 'gzip'}

    def test_an_answer_is_decoded_to_at_most_the_cap(self):
        self.assertEqual(vc.MAX_ANSWER_BYTES, 64 * 1024 * 1024)
        body = gzip.compress(b'0' * 4096)
        self.assertEqual(vc._decoded(body, self.GZ, limit=4096), b'0' * 4096)
        with self.assertRaises(vc.AnswerTooLarge):
            vc._decoded(body, self.GZ, limit=4095)
        # as gzip.decompress reads it: concatenated members, NUL padding after them; an empty body is empty
        self.assertEqual(vc._decoded(gzip.compress(b'ab') + gzip.compress(b'cd') + b'\x00\x00', self.GZ), b'abcd')
        self.assertEqual(vc._decoded(b'', self.GZ), b'')
        self.assertEqual(vc._decoded(b'{}', {}), b'{}', 'an answer that is not compressed is as it came')
        for cut in (body[:-5], body[:10], b'not gzip at all', gzip.compress(b'ab') + b'garbage'):
            with self.assertRaises(http.client.IncompleteRead):
                vc._decoded(cut, self.GZ)
        # a bomb: 80 MB of zeros in about 80 KB is refused at the 64 MB cap, not decoded whole
        z = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
        chunk = bytes(1024 * 1024)
        bomb = b''.join(z.compress(chunk) for _ in range(80)) + z.flush()
        self.assertLess(len(bomb), 200_000)
        with self.assertRaises(vc.AnswerTooLarge):
            vc._decoded(bomb, self.GZ)


class TooLarge(Base):
    def test_an_answer_too_large_to_read_is_bad_response_and_not_sent_again(self):
        self.cut('GET /pilot/v1/info', 'gzip')
        with mock.patch.object(vc, 'MAX_ANSWER_BYTES', 1000), self.assertRaises(vc.ValunError) as e:
            self.client().request('GET', '/pilot/v1/info', auth=False)
        x = e.exception
        self.assertEqual((x.code, x.status, x.extra.get('cause')), ('bad_response', None, 'too_large'))
        self.assertIn('is larger than 1000 bytes once decompressed, so it was not read', str(x))
        self.assertEqual(vc.size_text(vc.MAX_ANSWER_BYTES), '64 MB')
        self.assertEqual(self.fs.count('GET /pilot/v1/info'), 1)


class Consents(unittest.TestCase):
    def test_an_answer_that_is_not_json_is_transient(self):
        # the 0.7.2 review: a consent's deal read answered with a page that is not JSON was refused (deal_mismatch)
        self.assertTrue(vc._transient(vc.ValunError('bad_response', 'm', None, {'cause': 'not_json', 'http_status': 200})))
        self.assertTrue(vc._transient(vc.ValunError('unreachable', 'm', None, {'cause': 'timed_out'})))
        self.assertFalse(vc._transient(vc.ValunError('bad_response', 'm', None, {})), "the client's own check of an answer")
        self.assertFalse(vc._transient(vc.ValunError('bad_response', 'm', None, {'cause': 'too_large'})))
        self.assertFalse(vc._transient(vc.ValunError('deal_mismatch', 'm', 409)))


class AgentWords(Base):
    def test_valun_call_reports_a_transport_error_never_internal_error(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': self.fs.base, 'participant_id': 'vp_0a0a0a0a0a0a', 'pubkey': '02' + '11' * 32,
                       'network': 'valun-testnet-1', 'secret': SECRET, 'agent_token': TOKEN, 'approvals': 'none'}, f)
        self.cut('GET /pilot/v1/me', 'nothing')
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'VALUN_HOME': home.name}), contextlib.redirect_stdout(out):
            for k in ('VALUN_PROFILE', 'VALUN_SERVER'):
                os.environ.pop(k, None)
            rc = cli.main(['call', 'valun_status'])
        r = json.loads(out.getvalue())
        self.assertEqual(rc, 1)
        self.assertEqual((r['error'], r['cause'], r['transport_error']), ('unreachable', 'connection_cut', 'RemoteDisconnected'))
        self.assertEqual(r['what_this_means'], va.TRANSPORT_WORDS['connection_cut|'])
        self.assertNotIn(SECRET, out.getvalue())
        self.assertNotIn(TOKEN, out.getvalue())

    def test_the_words_by_cause_and_outcome(self):
        def words(code, **extra):
            return va.error_payload(vc.ValunError(code, 'm', None, extra)).get('what_this_means')
        self.assertIn('not a refusal', words('unreachable', cause='connection_cut'))
        self.assertIn('the server may have done it. Do not send it again before you read', words('unreachable', cause='connection_cut',
                                                                                                    outcome='unknown'))
        self.assertIn('could not be reached, so nothing was sent', words('unreachable', cause='not_connected'))
        self.assertIn('captive portal', words('bad_response', cause='not_json'))
        self.assertEqual(words('unreachable'), va.TRANSPORT_WORDS['|'])
        self.assertIsNone(words('bad_response'), "a bad_response that names no cause is the client's own check")
        self.assertIsNone(va.error_payload(vc.ValunError('unreachable', 'm', 503, {})).get('what_this_means'))
        self.assertEqual(words('unreachable', cause={'x': 1}), va.TRANSPORT_WORDS['|'])
        self.assertEqual(words('unreachable', what_this_means='kept'), 'kept')


class ReadBeforeRetry(Base):
    """Fix inbox #148 (the first-tester readiness assessment of 2026-11-18): when the answer to a commitment was lost,
    0.7.1 said internal_error, and the natural retry made a second commitment (two held offers; with approvals none,
    two agreed deals). The client never sends a write again (#132), and every answer to a write whose outcome is unknown
    says that the server may have done it, and what to read before sending it again: valun_inbox, valun_deal for its
    deal, or valun_guarantees for a guarantee (0.7.2's first words named no read for a guarantee's offer, answer or
    call, and an answer too large to read said nothing). Ctrl+C during `valun call` of a write says the same."""
    READ_FIRST = ('the server may have done it. Do not send it again before you read what the server holds now '
                  '(valun_inbox, valun_deal for its deal, or valun_guarantees for a guarantee), so that nothing is done twice.')

    def profile(self, approvals='none'):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': self.fs.base, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'pubkey': vb.public_key(bytes.fromhex(SECRET)).hex(), 'secret': SECRET, 'agent_token': TOKEN,
                       'approvals': approvals}, f)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER'):
            os.environ.pop(k, None)

    def test_every_lost_write_says_the_server_may_have_done_it_and_what_to_read(self):
        for mode, cause in (('nothing', 'connection_cut'), ('partial', 'connection_cut'), ('html', 'not_json'),
                            ('gzip', 'too_large'), ('hang', 'timed_out')):
            self.fs.counts.clear()
            self.cut('POST /pilot/v1/deals', mode)
            with mock.patch.object(vc, 'MAX_ANSWER_BYTES', 20), self.assertRaises(vc.ValunError) as e:
                vc.Client(Mem({'server': self.fs.base}, SECRET, TOKEN), timeout=0.5).request('POST', '/pilot/v1/deals',
                                                                                          {'terms': {}})
            r = va.error_payload(e.exception)
            self.assertEqual((r.get('cause'), r.get('outcome')), (cause, 'unknown'), mode)
            self.assertTrue(r.get('what_this_means', '').endswith(self.READ_FIRST), (mode, r.get('what_this_means')))
            self.assertEqual(self.fs.count('POST /pilot/v1/deals'), 1, 'a write is never sent again')
        # a read whose answer was too large: not the server's, and nothing was done (no words, as before)
        self.assertNotIn('what_this_means', va.error_payload(vc.ValunError('bad_response', 'm', None, {'cause': 'too_large'})))
        # a failure that names no cause: the same reads, for a commitment
        words = va.error_payload(vc.ValunError('unreachable', 'm', None, {}))['what_this_means']
        self.assertIn('If this call was a commitment, read what the server holds now (valun_inbox, valun_deal for its deal, '
                      'or valun_guarantees for a guarantee) before you send it again.', words)

    def test_ctrl_c_during_valun_call_of_a_write_says_to_read_before_sending_it_again(self):
        self.profile('none')
        offer = {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 'notary job', 'description': 'notary for x',
                 'deliverable': 'The exact notary result as JSON.', 'price': 2000000}

        def stopped(agent, name, args=None):        # Ctrl+C while the call is on its way
            raise KeyboardInterrupt
        for tool, args in (('valun_propose', offer), ('valun_respond', {'deal_id': 'vd_0123456789abcdef', 'action': 'accept'}),
                           ('valun_offer_guarantee', {'debtor': 'x', 'creditor': 'y', 'amount': 5})):
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.object(va.ValunAgent, 'call', stopped), contextlib.redirect_stdout(out), \
                    contextlib.redirect_stderr(err):
                rc = cli.main(['call', tool, json.dumps(args)])
            r = json.loads(out.getvalue())
            self.assertEqual((rc, r['error'], r['outcome']), (130, 'interrupted', 'unknown'), tool)
            self.assertEqual(r['message'], f'stopped (Ctrl+C) before the answer to {tool} arrived')
            self.assertEqual(r['what_this_means'], 'Your Valun client was stopped (Ctrl+C) before the answer to this call '
                                                   'arrived, so ' + self.READ_FIRST)
            self.assertEqual(err.getvalue(), '\nvalun call: stopped (Ctrl+C).\n', 'never a traceback')
        # a read: nothing to read first, so the short line only, as for any command
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(va.ValunAgent, 'call', stopped), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(['call', 'valun_status'])
        self.assertEqual((rc, out.getvalue(), err.getvalue()), (130, '', '\nvalun call: stopped (Ctrl+C).\n'))

    def test_valun_call_of_a_cut_write_answers_the_same_words(self):
        # end to end: `valun call` of a write whose answer is cut, through this transport (the server's deal view is
        # not served here, so the write is a decline's: its deal is read from a client double first)
        self.profile('none')
        self.cut('POST /pilot/v1/deals/vd_0123456789abcdef/decline', 'nothing')
        deal = {'id': 'vd_0123456789abcdef', 'current': {'terms_hash': 'ab' * 32}}
        out = io.StringIO()
        with mock.patch.object(vc.Client, 'deal', lambda c, did, *a, **k: deal), contextlib.redirect_stdout(out):
            rc = cli.main(['call', 'valun_respond', json.dumps({'deal_id': deal['id'], 'action': 'decline', 'reason': 'busy'})])
        r = json.loads(out.getvalue())
        self.assertEqual((rc, r['error'], r['cause'], r['outcome']), (1, 'unreachable', 'connection_cut', 'unknown'))
        self.assertEqual(r['what_this_means'], 'Your request reached the Valun server, but the connection was cut before '
                                               'its answer arrived, so ' + self.READ_FIRST)
        self.assertEqual(self.fs.count('POST /pilot/v1/deals/vd_0123456789abcdef/decline'), 1)


class Doctor(Base):
    def setUp(self):
        super().setUp()
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': self.fs.base, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'secret': SECRET, 'agent_token': TOKEN, 'approvals': 'console'}, f)
        if os.name != 'nt':
            os.chmod(os.path.join(home.name, 'profiles', 'default.json'), 0o600)

    def doctor(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}):
            rc = cli.main(['doctor'])
        return rc, out.getvalue()

    def test_a_cut_answer_to_me_is_named_and_no_enroll_is_suggested(self):
        for mode, error in (('nothing', 'RemoteDisconnected'), ('partial', 'IncompleteRead')):
            self.cut('GET /pilot/v1/me', mode)
            rc, out = self.doctor()
            self.assertEqual(rc, 1, out)
            self.assertIn(f'FIX   The connection to {self.fs.base} was cut before its answer was complete ({error}, 3 tries). '
                          'The server was reached and nothing refused this agent', out)
            self.assertIn('This agent itself could not be checked.', out)
            self.assertNotIn('refused this agent (', out)
            self.assertNotIn('enroll', out)
            self.assertNotIn('revoke', out)

    def test_a_cut_answer_to_info_and_one_that_is_not_json(self):
        self.cut('GET /pilot/v1/info', 'partial')
        rc, out = self.doctor()
        self.assertIn(f'FIX   The connection to {self.fs.base} was cut before its answer was complete (IncompleteRead, 3 tries)', out)
        self.assertNotIn('not reachable', out)
        self.assertNotIn('enroll', out)
        self.assertEqual(self.fs.count('GET /pilot/v1/me'), 0, 'the agent is not checked against a server it cannot read')
        self.cut('GET /pilot/v1/info', 'html')
        rc, out = self.doctor()
        self.assertIn(f'FIX   The answers from {self.fs.base} were not JSON (3 tries)', out)

    def test_a_refusal_is_still_a_refusal_and_another_failure_is_not_one(self):
        self.fs.answer = lambda method, path: ((200, INFO) if path == '/pilot/v1/info' else
                                               (401, {'error': 'unauthorized', 'message': 'missing or invalid token'}))
        rc, out = self.doctor()
        self.assertIn('FIX   The server refused this agent (unauthorized): if the owner revoked it, `valun --profile default '
                      'enroll` again.', out)
        self.fs.answer = lambda method, path: ((200, INFO) if path == '/pilot/v1/info' else
                                               (429, {'error': 'rate_limited', 'message': 'slow down'}))
        rc, out = self.doctor()
        self.assertIn('FIX   This agent could not be checked (rate_limited: slow down). Nothing was signed, and nothing says '
                      'the server refused it', out)
        self.assertNotIn('enroll', out)

    def test_no_answer_in_time_is_named_so_after_one_request_and_never_a_cut_or_a_refusal(self):
        for key in ('GET /pilot/v1/info', 'GET /pilot/v1/me'):
            self.fs.schedule.clear()
            self.fs.counts.clear()
            self.cut(key, 'hang')
            with mock.patch.object(vc.Client.__init__, '__defaults__', (None, 0.5, True)):     # the client's timeout
                rc, out = self.doctor()
            self.assertEqual(rc, 1, out)
            self.assertIn(f'FIX   {self.fs.base} did not answer within 0.5 s (TimeoutError): it may be busy, or something '
                          'between this machine and the server held the answer. Nothing refused this agent. Run `valun '
                          '--profile default doctor` again in a few minutes; if it keeps failing, try another network.', out)
            self.assertNotIn('cut', out)
            self.assertNotIn('enroll', out)
            self.assertEqual(self.fs.count(key), 1, 'asked once')
        self.assertIn('This agent itself could not be checked.', out)

    def test_a_server_url_that_is_not_valid_is_not_called_a_cut(self):
        out, calls, real = io.StringIO(), [], vc.Client._open

        def counting(c, req):
            calls.append(req.full_url)
            return real(c, req)
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(vc.Client, '_open', counting):
            rc = cli.main(['doctor', '--server', 'http://127.0.0.1:80x'])
        self.assertEqual(calls, [], 'never sent (the RC\'s review, round 3: judged first)')
        self.assertEqual(rc, 1)
        self.assertIn('FIX   --server must be an http(s) URL with a host, such as https://valun.tech: "http://127.0.0.1:80x" '
                      'has a port that is not a number from 1 to 65535. Nothing was sent.', out.getvalue())
        self.assertNotIn('cut', out.getvalue())
        # a join with such a server sends nothing, and keeps nothing of a join
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(vc.Client, '_open', counting):
            rc = cli.main(['--profile', 'fresh', 'join', '--sandbox', '--handle', 'h-url', '--operator', 'Fitz',
                           '--server', 'valun.tech'])
        self.assertEqual(rc, 1)
        self.assertEqual(err.getvalue(), 'valun join: --server must be an http(s) URL with a host, such as https://valun.tech: '
                                         '"valun.tech" has no scheme (a server URL starts with https://). Nothing was sent.\n')
        self.assertEqual(calls, [])
        self.assertFalse(os.path.exists(os.path.join(os.environ['VALUN_HOME'], 'profiles', 'fresh.json')))

    def test_a_proxy_this_machine_sets_is_named_by_scheme_and_host_name_only(self):
        self.cut('GET /pilot/v1/me', 'nothing')
        out = io.StringIO()
        proxies = {'https': 'http://user:secret@proxy.example:8080', 'no': 'localhost'}
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: proxies):
            cli.main(['doctor'])
        self.assertIn('Python on this machine sends these requests through the proxy it sets for https (proxy.example) '
                      '(curl and Node do not use it by default)', out.getvalue())
        for never in ('secret', 'user:', ':8080'):
            self.assertNotIn(never, out.getvalue())

    def test_doctor_names_each_proxys_host_itself_with_no_command_to_run(self):
        # The RC's review: the command doctor named printed urllib.request.getproxies(), the proxy's user and password
        # included, into the output a tester pastes into a report. Round 3 (regressions R4-REG-2): the command it named
        # then began with `python`, which stock Ubuntu (python3 only) and a uvx install on Windows (the Store's alias)
        # do not have, and its test put a `python` on the PATH first. doctor names the host names itself now.
        self.cut('GET /pilot/v1/me', 'nothing')
        for proxies, named in (({'https': 'http://TEST-ONLY-user:TEST-ONLY-pass@proxy.example:8080'}, 'https (proxy.example)'),
                               ({'http': 'proxy2.example:3128', 'https': 'HTTP://Proxy.Example:8080/'},
                                'http (proxy2.example), https (proxy.example)'),
                               ({'https': 'http://[fd00::1]:8080'}, 'https (fd00::1)'),
                               ({'https': 'http://bad host:80'}, 'https (a host this client does not print)')):
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: proxies):
                cli.main(['doctor'])
            self.assertIn(f'through the proxy it sets for {named} (curl and Node do not use it by default), so that proxy '
                          'may be what cut them.', out.getvalue())
            for never in ('python -c', '`python', 'TEST-ONLY', ':8080', ':3128', 'bad host'):
                self.assertNotIn(never, out.getvalue(), proxies)

    def test_a_proxy_user_or_password_with_a_slash_question_mark_or_hash_is_never_printed_as_its_host(self):
        # The RC's review, round 4 (doctor-proxy-host-prints-proxy-user): doctor read the proxy's host with urlsplit,
        # which ends the authority at the first / ? or #, where urllib (_parse_proxy, as client.proxy_refusal reads it)
        # ends it at the first / after its @. For a user name or password with one of them in it unencoded, which urllib
        # uses as meant (the right proxy; the user and password only on the CONNECT), doctor printed the user name as
        # the proxy's host, lower-cased, or the part of an API key before its /. Each host named here is the one urllib
        # connects to (ProxyHandler: req.host).
        self.cut('GET /pilot/v1/me', 'nothing')
        for url, named in (('http://TEST-ONLY-user:Ab/Cd+Ef==@proxy.example:3128', 'proxy.example'),    # a / in the password
                           ('http://TEST-ONLY-user:pa?ss@proxy.example:3128', 'proxy.example'),         # a ?
                           ('http://TEST-ONLY-user:pa#ss@proxy.example:3128', 'proxy.example'),         # a #
                           ('http://TEST-ONLY-KEY-123/xyz@proxy.example:3128', 'proxy.example'),        # a / in the user
                           ('http://TEST-ONLY-zone-KEY/abc:TEST-ONLY-pw@proxy.example:3128/', 'proxy.example'),
                           ('TEST-ONLY-user:Ab/Cd@proxy.example:3128', 'proxy.example'),       # host:port, no scheme
                           ('http://TEST-ONLY-u:TEST-ONLY-p@proxy%2Eexample:3128', 'proxy.example'),    # urllib unquotes it
                           # an @ and then a / in the password: urllib takes part of it for the host, so none is named
                           ('http://TEST-ONLY-user:p@TESTONLYfrag/word@proxy.example:3128',
                            'a host this client does not print')):
            req = urllib.request.Request('https://valun-test.invalid/x')
            urllib.request.ProxyHandler({'https': url}).proxy_open(req, url, 'https')
            if named != 'a host this client does not print':
                self.assertEqual(http.client.HTTPConnection(req.host).host, named, url)
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {'https': url}):
                cli.main(['doctor'])
            self.assertIn(f'through the proxy it sets for https ({named}) (curl and Node do not use it by default)',
                          out.getvalue(), url)
            for never in ('test-only', 'testonly', 'ab/cd', 'pa?ss', 'pa#ss', ':3128'):
                self.assertNotIn(never, out.getvalue().lower(), url)


# A certificate made for these tests only (EC P-256, valid 2026 to 2126), for valun-test.invalid: a name no CA issues and
# no resolver answers (.invalid), signed by a CA that only the opener these tests install trusts. Its key is public on
# purpose, and protects nothing.
PROXIED_HOST = 'valun-test.invalid'
TEST_CA = """-----BEGIN CERTIFICATE-----
MIIBsjCCAVegAwIBAgIUaehE7TETBxLXQm05eXIyELBm670wCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwadmFsdW4gdGVzdCBDQSAodGVzdHMgb25seSkwIBcNMjYwMTAx
MDAwMDAwWhgPMjEyNjAxMDEwMDAwMDBaMCUxIzAhBgNVBAMMGnZhbHVuIHRlc3Qg
Q0EgKHRlc3RzIG9ubHkpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6r49LCx5
ozP56qEwKpdUyjiuOyrLEuE7goa8ipBr0RIo7gJUHdse7bOFrnFch56R7gUaZEXD
1YBX+dsyvk/ZKqNjMGEwHwYDVR0jBBgwFoAUSFmeZfFBKUrMGb+PgADLuQjdPhkw
DwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFEhZnmXx
QSlKzBm/j4AAy7kI3T4ZMAoGCCqGSM49BAMCA0kAMEYCIQCcDl9rSOdQwIPKn6oO
cK2+2wqsM2hxJ1xErQe9eawJXwIhAPD7LggsOzj5mhUofW4+awLpWfb6AZycps9r
18Z5nYfr
-----END CERTIFICATE-----
"""
TEST_CERT = """-----BEGIN CERTIFICATE-----
MIIB3DCCAYKgAwIBAgIUe27EUOiir0wbj5xrcSFF1YxKfqgwCgYIKoZIzj0EAwIw
JTEjMCEGA1UEAwwadmFsdW4gdGVzdCBDQSAodGVzdHMgb25seSkwIBcNMjYwMTAx
MDAwMDAwWhgPMjEyNjAxMDEwMDAwMDBaMB0xGzAZBgNVBAMMEnZhbHVuLXRlc3Qu
aW52YWxpZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABOM6VrE1uo4COSviQmn9
V68n5QdUa2vhXMGEEP+IcjggOT9fww6AdP0pxggRAl0OPi6bjRnq2yz6bL59qjG9
8AWjgZUwgZIwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAww
CgYIKwYBBQUHAwEwHQYDVR0RBBYwFIISdmFsdW4tdGVzdC5pbnZhbGlkMB0GA1Ud
DgQWBBTo+cO+mYP2cRNgXAjhYSAVjLnSVzAfBgNVHSMEGDAWgBRIWZ5l8UEpSswZ
v4+AAMu5CN0+GTAKBggqhkjOPQQDAgNIADBFAiBn9NrSzIfzsUpVie0MkiR1TfPF
KS5/OJAmC+hRFBzHJAIhALNmGw3ns3lfElx5qcTvuUP9ug8NO8AqPE1c/PCzWZfL
-----END CERTIFICATE-----
"""
TEST_KEY = """-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMGOVN5a5i5VGl5lU
Tgoxe5ApBpRRSmRUgZbBWtTgPNuhRANCAATjOlaxNbqOAjkr4kJp/VevJ+UHVGtr
4VzBhBD/iHI4IDk/X8MOgHT9KcYIEQJdDj4um40Z6tss+my+faoxvfAF
-----END PRIVATE KEY-----
"""
OWNER_TOKEN = 'vpo_TEST-ONLY-transport'


def machine_proxy(test, url):
    """This machine's proxy settings, for the rest of `test`: `url` for http and https, as HTTPS_PROXY and HTTP_PROXY (or
    the Windows system proxy) set them (urllib.request.getproxies, which a Client's own opener reads), and no host
    bypassed, whatever this machine's own settings. urllib.request.urlopen's opener is made again from them (0.7.2's
    candidates sent through it), and the one it had is put back after."""
    for patch in (mock.patch.object(urllib.request, 'getproxies', lambda: {'https': url, 'http': url}),
                  mock.patch.object(urllib.request, 'proxy_bypass', lambda host: False)):
        patch.start()
        test.addCleanup(patch.stop)
    old = getattr(urllib.request, '_opener', None)
    urllib.request.install_opener(None)
    test.addCleanup(urllib.request.install_opener, old)


class HttpsProxy:
    """A local HTTPS proxy, as HTTPS_PROXY or the system's proxy settings name one. It accepts each CONNECT to
    valun-test.invalid:443, ends the tunnel's TLS here with the test certificate (as a proxy or antivirus that scans
    HTTPS does, and as the staging test's proxy did), reads the request in it, and answers it from `answers` (by path),
    or cuts the connection with no answer (RemoteDisconnected) for the first cuts[path] requests of a path. A CONNECT to
    another port is refused with 403, as a proxy that allows only port 443 does, or accepted (port80='accept') to see
    what the client sends in it. seen: one entry per CONNECT, (its target, what the client sent in the tunnel: 'tls', a
    TLS handshake, or 'plain', or 'refused', the request line, whether it carried an Authorization header).
    plain_auth: an Authorization header was sent in clear text. A request in absolute form (GET http://host/path, how
    urllib sends an http request through a proxy) is answered 407 when demand_auth (a proxy that wants credentials) and
    from `answers` otherwise; it is seen as ('absolute', 'plain', its request line, whether it carried Authorization)."""

    def __init__(self, cuts=None, port80='refuse', demand_auth=False):
        self.cuts, self.port80, self.seen, self.counts, self.plain_auth = dict(cuts or {}), port80, [], {}, False
        self.demand_auth = demand_auth
        self.answers = {'/pilot/v1/info': INFO, '/pilot/v1/me': ME,
                        '/pilot/v1/owner': {'participant': {'id': 'vp_0a0a0a0a0a0a'}, 'mandate': ME['mandate']},
                        '/pilot/v1/enroll': {'agent_token': TOKEN, 'network': 'valun-testnet-1'}}
        self.lock = threading.Lock()
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        with tempfile.TemporaryDirectory() as d:       # load_cert_chain reads files only
            cert, key = os.path.join(d, 'cert.pem'), os.path.join(d, 'key.pem')
            for path, text in ((cert, TEST_CERT), (key, TEST_KEY)):
                with open(path, 'w', encoding='ascii') as f:
                    f.write(text)
            self.tls.load_cert_chain(cert, key)
        self.sock = socket.create_server(('127.0.0.1', 0))
        self.url = f'http://127.0.0.1:{self.sock.getsockname()[1]}'
        threading.Thread(target=self.serve, daemon=True).start()

    def close(self):
        self.sock.close()

    def serve(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self.tunnel, args=(c,), daemon=True).start()

    @staticmethod
    def head(s):
        """A request's head (up to its blank line), and the start of its body."""
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
        head, _, rest = buf.partition(b'\r\n\r\n')
        return head.decode('latin-1'), rest

    def tunnel(self, c):
        s = c
        try:
            c.settimeout(10)
            first, _ = self.head(c)
            method, target = first.split('\r\n', 1)[0].split(' ')[:2]
            if method != 'CONNECT':                     # absolute form: an http request sent through this proxy
                line = first.split('\r\n', 1)[0]
                auth = 'authorization:' in first.lower().replace('proxy-authorization:', '')
                with self.lock:
                    self.seen.append(('absolute', 'plain', line, auth))
                self.plain_auth = self.plain_auth or auth
                if self.demand_auth:
                    c.sendall(b'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n'
                              b'Content-Length: 0\r\nConnection: close\r\n\r\n')
                    return
                path = urllib.parse.urlsplit(target).path
                out = json.dumps(self.answers.get(path, {'error': 'not_found'})).encode()
                c.sendall(b'HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n'
                          % (200 if path in self.answers else 404, len(out)) + out)
                return
            if not target.endswith(':443') and self.port80 == 'refuse':
                self.seen.append((f'CONNECT {target}', 'refused', None, None))
                c.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
                return
            c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
            kind = 'tls' if c.recv(1, socket.MSG_PEEK) == b'\x16' else 'plain'    # a TLS handshake record starts 0x16
            if kind == 'tls':
                s = self.tls.wrap_socket(c, server_side=True)
            head, rest = self.head(s)
            lines = head.split('\r\n')
            headers = {k.strip().lower(): v.strip() for k, _, v in (x.partition(':') for x in lines[1:])}
            body = rest
            while len(body) < int(headers.get('content-length') or 0):
                body += s.recv(4096)
            auth = 'authorization' in headers
            self.plain_auth = self.plain_auth or (kind == 'plain' and auth)
            path = urllib.parse.urlsplit(lines[0].split(' ')[1]).path
            with self.lock:
                self.counts[path] = n = self.counts.get(path, 0) + 1
                self.seen.append((f'CONNECT {target}', kind, lines[0], auth))
            if kind == 'plain' or n <= self.cuts.get(path, 0):
                return                                  # cut: closed with no answer
            out = json.dumps(self.answers.get(path, {'error': 'not_found'})).encode()
            s.sendall(b'HTTP/1.1 %d X\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n'
                      % (200 if path in self.answers else 404, len(out)) + out)
        except (OSError, ValueError, IndexError):
            pass
        finally:
            with contextlib.suppress(OSError):
                s.shutdown(socket.SHUT_RDWR)
            s.close()


class ThroughAnHttpsProxy(unittest.TestCase):
    """The RC's staging test (2026-11-18), problem 1: the read retry sent the same urllib Request again, and urllib's
    ProxyHandler rewrites the Request it sends (Request.set_proxy). Through an HTTPS proxy, the second try of a read cut
    once carried its whole URL inside the tunnel, and the third went out as plain HTTP, tunnelled to the server's port 80,
    with its Bearer token in clear text; where the proxy refused port 80, doctor said "cannot reach" instead of naming the
    cut. Every try is now a new Request, so every try is a CONNECT to port 443 and a TLS handshake. A ServerRequest also
    refuses to be sent through a proxy a second time, and its token never follows a redirect. The proxy, its TLS and the
    servers are on loopback: nothing leaves this machine."""

    def setUp(self):
        for patch in (mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0)), mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0))):
            patch.start()
            self.addCleanup(patch.stop)

    def proxy(self, **kw):
        """The proxy, as this machine's proxy settings name it for both schemes (HTTPS_PROXY and HTTP_PROXY, or the
        Windows system proxy: urllib.request.getproxies, which a Client's own opener reads), and the test CA trusted
        (client.tls_context)."""
        p = HttpsProxy(**kw)
        self.addCleanup(p.close)
        machine_proxy(self, p.url)
        trust = mock.patch.object(vc, 'tls_context', lambda: ssl.create_default_context(cadata=TEST_CA))
        trust.start()
        self.addCleanup(trust.stop)
        return p

    def client(self, **state):
        return vc.Client(Mem(dict({'server': f'https://{PROXIED_HOST}'}, **state), SECRET, TOKEN), timeout=10)

    def test_every_try_of_a_read_cut_twice_is_tls_to_the_servers_port_443(self):
        p = self.proxy(cuts={'/pilot/v1/me': 2}, port80='accept')
        try:
            got = self.client().me()
        except vc.ValunError as e:
            got = e
        self.assertEqual([x[:2] for x in p.seen], [(f'CONNECT {PROXIED_HOST}:443', 'tls')] * 3, p.seen)
        self.assertFalse(p.plain_auth, 'the token is never sent in clear text')
        self.assertEqual([x[2:] for x in p.seen], [('GET /pilot/v1/me HTTP/1.1', True)] * 3,
                         'each try is the same request as the first: its path, and the token')
        self.assertEqual(got, ME)

    def test_the_owner_tokens_read_and_an_enrollment_sent_again_are_tls_to_port_443_every_time(self):
        p = self.proxy(cuts={'/pilot/v1/owner': 2, '/pilot/v1/enroll': 1}, port80='accept')
        c = self.client(participant_id='vp_0a0a0a0a0a0a')
        self.assertEqual(c._check_owner(OWNER_TOKEN)['participant']['id'], 'vp_0a0a0a0a0a0a')
        fresh = vc.Client(Mem({'server': f'https://{PROXIED_HOST}', 'network': 'valun-testnet-1'}), timeout=10)
        self.assertEqual(fresh.enroll('vp_0a0a0a0a0a0a', 'TEST-ONLY-code')['tries'], 2)
        self.assertEqual([x[:2] for x in p.seen], [(f'CONNECT {PROXIED_HOST}:443', 'tls')] * 5, p.seen)
        self.assertEqual([x[2] for x in p.seen], ['GET /pilot/v1/owner HTTP/1.1'] * 3 + ['POST /pilot/v1/enroll HTTP/1.1'] * 2)
        self.assertFalse(p.plain_auth)

    def test_doctor_names_a_read_cut_three_times_a_cut_where_the_proxy_allows_only_port_443(self):
        p = self.proxy(cuts={'/pilot/v1/me': 3}, port80='refuse')
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        os.makedirs(os.path.join(home.name, 'profiles'))
        path = os.path.join(home.name, 'profiles', 'default.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'server': f'https://{PROXIED_HOST}', 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'secret': SECRET, 'agent_token': TOKEN, 'approvals': 'console'}, f)
        if os.name != 'nt':
            os.chmod(path, 0o600)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['doctor'])
        self.assertEqual(rc, 1, out.getvalue())
        self.assertIn(f'FIX   The connection to https://{PROXIED_HOST} was cut before its answer was complete '
                      '(RemoteDisconnected, 3 tries). The server was reached and nothing refused this agent', out.getvalue())
        self.assertNotIn('cannot reach', out.getvalue())
        self.assertEqual([x[:3] for x in p.seen], [(f'CONNECT {PROXIED_HOST}:443', 'tls', 'GET /pilot/v1/info HTTP/1.1')]
                         + [(f'CONNECT {PROXIED_HOST}:443', 'tls', 'GET /pilot/v1/me HTTP/1.1')] * 3, p.seen)

    def test_a_server_request_goes_through_a_proxy_once_and_the_client_says_nothing_was_sent(self):
        p = self.proxy()
        req = vc.ServerRequest(f'https://{PROXIED_HOST}/pilot/v1/info', method='GET')
        opener = vc.server_opener()
        with opener.open(req, timeout=10) as r:
            self.assertEqual(json.loads(r.read())['network'], 'valun-testnet-1')
        with self.assertRaises(vc.DestinationRefused) as e:
            opener.open(req, timeout=10)                        # the same Request again: urllib would rewrite it
        self.assertEqual(len(p.seen), 1, 'refused before anything was sent')
        self.assertIn(f'https://{PROXIED_HOST}', str(e.exception))
        self.assertTrue(e.exception.sent, 'that Request went out once already')
        # Client.request: refused before anything is sent, named so, and never tried again
        calls = []

        def twice(req, timeout=None):                           # a proxy handler that sends one Request through twice
            calls.append(req.full_url)
            req.set_proxy('127.0.0.1:9', 'http')
            req.set_proxy('127.0.0.1:9', 'http')
        with opening(twice), self.assertRaises(vc.ValunError) as e:
            self.client().me()
        x = e.exception
        self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('transport_error'), len(calls)),
                         ('unreachable', None, 'not_connected', 'DestinationRefused', 1))
        self.assertIn(f'cannot reach https://{PROXIED_HOST}: ', str(x))
        self.assertIn('nothing was sent', str(x))
        self.assertNotIn(TOKEN, str(x))
        self.assertFalse(vc.transport_cut(x))

    def test_a_second_pass_after_one_went_out_is_never_said_to_have_sent_nothing(self):
        # The words, wherever a handler sends a Request again after an answer (this client's own opener has none)
        def resent(req, timeout=None):                          # a handler that sends a Request again after an answer
            req.set_proxy('127.0.0.1:9', 'http')
            req.went_out = True                                 # the first pass went out, and was answered
            req.set_proxy('127.0.0.1:9', 'http')
        for method, path in (('GET', '/pilot/v1/me'), ('POST', '/pilot/v1/deals')):
            with opening(resent), self.assertRaises(vc.ValunError) as e:
                self.client().request(method, path, {'terms': {}} if method == 'POST' else None)
            x = e.exception
            self.assertIn('so it was not sent again', str(x), method)
            self.assertNotIn('nothing was sent', str(x))
            self.assertNotIn('cannot reach', str(x))
            self.assertNotEqual(x.extra.get('cause'), 'not_connected', 'it may have reached the proxy, or the server')
            self.assertEqual(x.extra.get('transport_error'), 'DestinationRefused')
            if method == 'POST':
                self.assertEqual(x.extra.get('outcome'), 'unknown')
                self.assertIn('The request was sent, so the server may have done it', str(x))
            self.assertNotEqual(va.error_payload(x)['what_this_means'], va.TRANSPORT_WORDS['not_connected|'])


def origin(test, answer, tls=False, host='127.0.0.1'):
    """A local origin server on `host`, plain or TLS with the test certificate (valun-test.invalid, signed by the test CA
    that nothing on this machine trusts), answering every GET and POST with answer(handler). Returns (its base URL, the
    Authorization header of each request it read)."""
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get('Authorization'))
            self.rfile.read(int(self.headers.get('Content-Length') or 0))       # read whole: a close never resets it
            answer(self)
        do_POST = do_PUT = do_HEAD = do_GET

        def log_message(self, *a):
            pass

    class Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ':' in host else socket.AF_INET
        daemon_threads = True
    s = Server((host, 0), Handler)
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        with tempfile.TemporaryDirectory() as d:       # load_cert_chain reads files only
            cert, key = os.path.join(d, 'cert.pem'), os.path.join(d, 'key.pem')
            for path, text in ((cert, TEST_CERT), (key, TEST_KEY)):
                with open(path, 'w', encoding='ascii') as f:
                    f.write(text)
            ctx.load_cert_chain(cert, key)
        s.socket = ctx.wrap_socket(s.socket, server_side=True)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    test.addCleanup(s.server_close)
    test.addCleanup(s.shutdown)
    return f"{'https' if tls else 'http'}://{f'[{host}]' if ':' in host else host}:{s.server_address[1]}", seen


def answer_json(obj, status=200, headers=None):
    def answer(h):
        body = json.dumps(obj).encode()
        h.send_response(status)
        h.send_header('Content-Type', 'application/json')
        h.send_header('Content-Length', str(len(body)))
        for k, v in (headers or {}).items():
            h.send_header(k, v)
        h.end_headers()
        if h.command != 'HEAD':
            h.wfile.write(body)
    return answer


def moved_to(location, code=302):
    """An answer that redirects to `location` (None: a 3xx with no Location)."""
    def answer(h):
        h.send_response(code)
        if location is not None:
            h.send_header('Location', location)
        h.send_header('Content-Length', '0')
        h.end_headers()
    return answer


class Redirects(unittest.TestCase):
    """The RC's review (transport-security: redirect-followed-and-misdiagnosed, proxy-credentials-follow-redirect): the
    token never followed a redirect, but the Python client did, to any http or https address, and took the other
    origin's answer for the configured server's (a POST answered 301, 302 or 303 went on as a GET elsewhere, and that
    GET's answer was the write's result); the proxy's credentials went along. For an http:// URL whose host moves every
    request to https:// (Fly's force_https), the redirected request had no token, its 401 made doctor say "The server
    refused this agent ... enroll again" and the tools "This agent is not connected". Now no redirect is followed: a 3xx
    is ValunError('redirected'), naming the scheme and host it pointed to, nothing done, and doctor, the tools and join
    word it as a redirect, never as a refusal or a lost connection. Loopback only."""

    def setUp(self):
        fast = mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0))
        fast.start()
        self.addCleanup(fast.stop)

    def client(self, base):
        return vc.Client(Mem({'server': base}, SECRET, TOKEN), timeout=10)

    def test_no_redirect_is_followed_and_each_is_named_for_what_it_is(self):
        other, other_seen = origin(self, answer_json({'participant': {'handle': 'NOT-THE-CONFIGURED-SERVER'},
                                                      'deal_id': 'vd_FROM_OTHER_ORIGIN'}))
        for code in (301, 302, 303, 307, 308):
            for method in ('GET', 'POST', 'HEAD'):
                base, seen = origin(self, moved_to(other + '/pilot/v1/elsewhere?token=x', code))
                with self.assertRaises(vc.ValunError) as e:
                    self.client(base).request(method, '/pilot/v1/deals', {'terms': {}} if method == 'POST' else None)
                x = e.exception
                self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('location'), x.extra.get('http_status')),
                                 ('redirected', code, 'redirect', other, code), (code, method))
                self.assertEqual(str(x), f'{base} answered with a redirect (HTTP {code}) to {other}. This client follows '
                                         f'no redirect, so nothing was done ({vc.REDIRECT_WHY})')
                self.assertEqual(seen, ['Bearer ' + TOKEN], 'asked once')
                self.assertFalse(vc.answer_unread(x) or vc.transport_cut(x) or vc._transient(x), 'an answer, not a cut')
        self.assertEqual(other_seen, [], "the redirect's target is never asked, and its answer never taken for the server's")

    def test_where_a_redirect_points_is_shown_as_its_scheme_and_host_only(self):
        for location, shown in (('https://valun.example/pilot/v1/me?code=SECRET', 'https://valun.example'),
                                ('HTTPS://Valun.Example:443/x', 'https://valun.example'),
                                ('http://valun.example:8080/', 'http://valun.example:8080'),
                                ('https://[::1]:8443/pilot', 'https://[::1]:8443'),
                                ('/pilot/v1/other', 'BASE'), ('ftp://files.example/x', None), ('javascript:alert(1)', None),
                                ('https://user:pass@valun.example/', 'https://valun.example'), ('https://bad host/', None),
                                ('https://évil.example/', None), ('https://valun.example:99999/', None), (None, None)):
            base, _ = origin(self, moved_to(location))
            with self.assertRaises(vc.ValunError) as e:
                self.client(base).me()
            want = base if shown == 'BASE' else shown
            self.assertEqual(e.exception.extra.get('location'), want, location)
            self.assertEqual(f' to {want}' in str(e.exception), want is not None, str(e.exception))
            self.assertNotIn('SECRET', str(e.exception))
            self.assertNotIn('pass', str(e.exception))

    def doctor(self, base, *argv):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        os.makedirs(os.path.join(home.name, 'profiles'))
        with open(os.path.join(home.name, 'profiles', 'default.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': base, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'pubkey': vb.public_key(bytes.fromhex(SECRET)).hex(), 'secret': SECRET, 'agent_token': TOKEN,
                       'approvals': 'none'}, f)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}):
            rc = cli.main(list(argv) or ['doctor'])
        return rc, out.getvalue()

    def test_an_http_url_whose_host_moves_it_to_https_is_a_redirect_in_doctor_and_the_tools_never_a_refusal(self):
        # Fly's force_https: the http front answers 301 to the same path on https, where a request without its token
        # gets 401 (the RC's doctor: "FIX The server refused this agent (unauthorized) ... enroll again")
        https, https_seen = origin(self, answer_json({'error': 'unauthorized', 'message': 'missing token'}, 401), tls=True)
        front, front_seen = origin(self, moved_to(https + '/pilot/v1/info', 301))
        rc, out = self.doctor(front)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'FIX   {front} answers with a redirect to {https}, and this client follows no redirect, so nothing was '
                      f'sent on there and nothing refused this agent. If {https} is your Valun server, use it: '
                      f'`valun --profile default config server {https}`.', out)
        for wrong in ('refused this agent (', 'enroll', 'not reachable', 'cut', 'reachable:'):
            self.assertNotIn(wrong, out)
        self.assertEqual(https_seen, [], 'nothing was sent on to the https address')
        # the tools
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['call', 'valun_status'])
        r = json.loads(out.getvalue())
        self.assertEqual((rc, r['error'], r['cause']), (1, 'redirected', 'redirect'), r)
        self.assertEqual(r['what_this_means'], va.redirected_text(https))
        self.assertIn(f'answered with a redirect to {https}, which your Valun client never follows, so nothing was done and '
                      'nothing refused this agent', r['what_this_means'])
        self.assertNotIn('not connected', r['what_this_means'])
        self.assertEqual(https_seen, [])

    def test_doctors_agent_check_names_a_redirect_of_me_alone(self):
        def me_moves(h):
            if h.path.endswith('/pilot/v1/me'):
                return moved_to('https://elsewhere.example/pilot/v1/me', 307)(h)
            return answer_json(INFO)(h)
        base, _ = origin(self, me_moves)
        rc, out = self.doctor(base)
        self.assertIn(f'FIX   {base} answers with a redirect to https://elsewhere.example, and this client follows no '
                      'redirect, so nothing was sent on there and nothing refused this agent. If https://elsewhere.example '
                      'is your Valun server, use it: `valun --profile default config server https://elsewhere.example`. '
                      'This agent itself could not be checked.', out)
        self.assertNotIn('refused this agent (', out)
        self.assertNotIn('enroll', out)

    def test_a_join_answered_with_a_redirect_names_it_and_the_join_there(self):
        base, _ = origin(self, moved_to('https://valun.example/pilot/v1/join-sandbox', 308))
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name}), \
                contextlib.redirect_stdout(out):
            for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
                os.environ.pop(k, None)
            rc = cli.main(['--profile', 'r', 'join', '--sandbox', '--handle', 'h-redir', '--operator', 'Ann', '--server', base])
        self.assertEqual(rc, 1)
        self.assertIn(f'Joining failed (redirected): {base} answered with a redirect (HTTP 308) to https://valun.example. '
                      'This client follows no redirect, so nothing was done', out.getvalue())
        self.assertIn('  Next: if https://valun.example is your Valun server, join it: `valun --profile r join --sandbox '
                      '--handle h-redir --operator Ann --server https://valun.example`.', out.getvalue())


class PlainHttp(unittest.TestCase):
    """The RC's review (transport-security plain-http-token-to-proxy, corrected, and missed[0]): both clients put the agent's
    and the owner's tokens on plain http to whatever host an http:// server URL named, and through this machine's proxy,
    while the 0.7.2 notes said the tokens went only to the configured server and called plain http "a local server".
    Now a token goes over plain http only to a server on this machine (which no proxy is used for: OwnOpener), unless
    VALUN_ALLOW_PLAIN_HTTP=1; otherwise nothing is sent, nor a join or an enrollment, whose answers carry one, and
    doctor names the opt-in and what it costs. The "other machine" here is valun-test.invalid behind a local proxy, so
    a request that went out would reach that proxy: nothing leaves this machine."""
    SERVER = f'http://{PROXIED_HOST}'

    def setUp(self):
        self.p = HttpsProxy()
        self.addCleanup(self.p.close)
        machine_proxy(self, self.p.url)
        for patch in (mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0)), mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0))):
            patch.start()
            self.addCleanup(patch.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('VALUN_ALLOW_PLAIN_HTTP', None)

    def client(self, token=TOKEN, **state):
        return vc.Client(Mem(dict({'server': self.SERVER}, **state), SECRET, token), timeout=10)

    def test_no_token_and_no_join_or_enrollment_goes_over_plain_http_to_another_machine(self):
        for call in (lambda c: c.me(), lambda c: c.request('POST', '/pilot/v1/deals', {'terms': {}}),
                     lambda c: c.request('GET', '/pilot/v1/owner', token=OWNER_TOKEN),
                     lambda c: c.join_sandbox('h-plain', 'Ann'), lambda c: c.join('INVITE', 'h-plain', 'Ann')):
            with self.assertRaises(vc.ValunError) as e:
                call(self.client())
            x = e.exception
            self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('opt_in')),
                             ('plain_http', None, 'plain_http', 'VALUN_ALLOW_PLAIN_HTTP'), str(x))
            self.assertEqual(str(x), f'{self.SERVER} is plain http on another machine, so this client sends it no token, nor a '
                                     'join or an enrollment, whose answers carry one: over plain http a token crosses the '
                                     'network in clear text, for anyone on the way to read and use. Nothing was sent. Use '
                                     f'its https:// address (https://{PROXIED_HOST}), or, only on a network you trust, set '
                                     'VALUN_ALLOW_PLAIN_HTTP=1 to send tokens over plain http anyway')
            self.assertFalse(vc.answer_unread(x) or vc.transport_cut(x) or vc._transient(x), 'nothing was sent')
            self.assertEqual(va.error_payload(x)['what_this_means'], va.PLAIN_HTTP_TEXT)
        fresh = vc.Client(Mem({'server': self.SERVER, 'network': 'valun-testnet-1'}), timeout=10)
        with self.assertRaises(vc.ValunError) as e:
            fresh.enroll('vp_0a0a0a0a0a0a', 'TEST-ONLY-code')
        self.assertEqual(e.exception.code, 'plain_http', 'refused at once, never enroll_unconfirmed')
        self.assertEqual(self.p.seen, [], 'nothing reached the proxy, or anything past it')
        # a read that carries no token, and whose answer carries none, goes as before (through the proxy here)
        self.assertEqual(self.client(token=None).request('GET', '/pilot/v1/info', auth=False)['network'], 'valun-testnet-1')
        self.assertEqual(self.p.seen, [('absolute', 'plain', f'GET {self.SERVER}/pilot/v1/info HTTP/1.1', False)])

    def test_with_the_opt_in_tokens_go_over_plain_http_and_doctor_says_they_cross_in_clear_text(self):
        os.environ['VALUN_ALLOW_PLAIN_HTTP'] = '1'
        self.assertEqual(self.client().me(), ME)
        self.assertEqual(self.p.seen, [('absolute', 'plain', f'GET {self.SERVER}/pilot/v1/me HTTP/1.1', True)])
        self.assertTrue(self.p.plain_auth)
        for v in ('0', 'yes', 'true', ' '):         # only 1 opts in
            os.environ['VALUN_ALLOW_PLAIN_HTTP'] = v
            with self.assertRaises(vc.ValunError) as e:
                self.client().me()
            self.assertEqual(e.exception.code, 'plain_http', v)
        os.environ['VALUN_ALLOW_PLAIN_HTTP'] = '1'
        rc, out = self.doctor()
        self.assertIn(f'FIX   {self.SERVER} is plain http on another machine, and VALUN_ALLOW_PLAIN_HTTP=1 is set, so this '
                      "client sends this agent's and its owner's tokens there in clear text: anyone on the network between "
                      'can read them and act as this agent or its owner. Use its https:// address: `valun --profile default '
                      f'config server https://{PROXIED_HOST}`, and unset VALUN_ALLOW_PLAIN_HTTP.', out)
        self.assertIn('ok    Agent accepted by the server as tester', out)

    def doctor(self, server=None):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)
        os.makedirs(os.path.join(home.name, 'profiles'), exist_ok=True)
        path = os.path.join(home.name, 'profiles', 'default.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'server': server or self.SERVER, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'pubkey': vb.public_key(bytes.fromhex(SECRET)).hex(), 'secret': SECRET, 'agent_token': TOKEN,
                       'approvals': 'none'}, f)
        if os.name != 'nt':
            os.chmod(path, 0o600)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['doctor'])
        return rc, out.getvalue()

    def test_doctor_flags_an_http_server_and_names_the_opt_in_and_the_tools_and_join_say_nothing_was_sent(self):
        rc, out = self.doctor()
        self.assertEqual(rc, 1, out)
        self.assertIn(f'FIX   {self.SERVER} is plain http on another machine, so this client sends it no token, nor a join or '
                      'an enrollment, whose answers carry one: over plain http a token would cross the network in clear '
                      f'text. Use its https:// address: `valun --profile default config server https://{PROXIED_HOST}`. Only '
                      'on a network you trust, VALUN_ALLOW_PLAIN_HTTP=1 sends tokens over plain http anyway. This agent '
                      'itself was not checked: that takes its token.', out)
        self.assertIn(f'ok    Server {self.SERVER} reachable', out, 'GET /info carries no token')
        self.assertNotIn('could not be checked', out)
        self.assertEqual([s[3] for s in self.p.seen], [False], 'only GET /info went out, with no token')
        # the tools
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['call', 'valun_status'])
        r = json.loads(out.getvalue())
        self.assertEqual((rc, r['error'], r['what_this_means']), (1, 'plain_http', va.PLAIN_HTTP_TEXT))
        # a join: nothing sent, nothing kept
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = cli.main(['--profile', 'j', 'join', '--sandbox', '--handle', 'h-plain', '--operator', 'Ann',
                           '--server', self.SERVER])
        self.assertEqual(rc, 1)
        self.assertIn(f'Joining failed (plain_http): {self.SERVER} is plain http on another machine, so this client sends it '
                      'no token, nor a join or an enrollment', out.getvalue())
        self.assertFalse(os.path.exists(os.path.join(os.environ['VALUN_HOME'], 'profiles', 'j.json')))
        self.assertEqual([s[3] for s in self.p.seen], [False], 'the join was never sent')

    def test_localhost_with_a_final_dot_is_another_machine(self):
        # The RC's review, round 3 (transport-security localhost-trailing-dot-resolved-by-dns): both clients counted
        # 'localhost.' as this machine, so http://localhost.:PORT got the tokens over plain http without the opt-in;
        # glibc looks that name up in DNS, not in /etc/hosts, so on Linux the token went in clear text to whatever address
        # the DNS server gave. It is another machine now: refused (plain_http), nothing sent, here or to the proxy.
        base, seen = origin(self, answer_json(ME))
        port = base.rsplit(':', 1)[1]
        for name in ('localhost.', 'LOCALHOST.', 'localhost..'):
            server = f'http://{name}:{port}'
            for call in (lambda c: c.me(), lambda c: c.join_sandbox('h-dot', 'Ann')):
                with self.assertRaises(vc.ValunError) as e:
                    call(vc.Client(Mem({'server': server}, SECRET, TOKEN), timeout=10))
                self.assertEqual((e.exception.code, e.exception.extra.get('cause')), ('plain_http', 'plain_http'), server)
                self.assertTrue(str(e.exception).startswith(f'{server} is plain http on another machine'), str(e.exception))
            self.assertTrue(cli._plain_http_words(server, 'default', True)[0], f'doctor flags {server}')
        self.assertEqual(seen, [], 'nothing reached this machine')
        self.assertEqual(self.p.seen, [], 'nor the proxy')
        self.assertEqual(vc.Client(Mem({'server': f'http://localhost:{port}'}, SECRET, TOKEN), timeout=10).me(), ME,
                         'localhost itself is this machine')

    def test_doctor_names_a_plain_http_server_on_this_machine_without_a_fix(self):
        base, seen = origin(self, lambda h: answer_json(INFO if h.path.endswith('/info') else ME)(h))
        rc, out = self.doctor(base)
        self.assertEqual(rc, 0, out)
        self.assertIn(f'ok    Server {base} is plain http on this machine: its tokens never leave it, and no proxy is used '
                      'for it', out)
        self.assertIn('ok    Agent accepted by the server as tester', out)
        self.assertEqual(self.p.seen, [])
        self.assertEqual(seen, [None, 'Bearer ' + TOKEN])
        for server, mine in (('http://127.0.0.1:8080', True), ('http://localhost:8080', True), ('http://[::1]:9', True),
                             ('http://localhost.:8080', False), ('http://192.168.1.10:8080', False),
                             ('http://valun.tech', False)):
            words = cli._plain_http_words(server, 'default', True)
            self.assertEqual(words[0], not mine, server)
        self.assertIsNone(cli._plain_http_words('https://valun.tech', 'default', True))
        self.assertEqual([vc.https_of(s) for s in ('http://valun.tech', 'http://valun.tech:80/', 'http://h.example:8080/x/',
                                                    'https://valun.tech', 'http://[fd00::1]:9')],
                         ['https://valun.tech', 'https://valun.tech', 'https://h.example:8080/x', None, 'https://[fd00::1]:9'])


HOSTLESS = ('http:', 'http:/', 'http://', 'HTTP:/', 'https:', 'https://')
USERINFO_SERVER = f'https://TEST-ONLY-user:TEST-ONLY-pass@{PROXIED_HOST}'


class ServerSettings(unittest.TestCase):
    """The RC's review, round 3 (transport-security js-hostless-server-url-bypasses-both-guards): a server setting with no
    host ('http://', 'http:', 'HTTP:/') is not a URL on its own, so neither JS guard judged it, while `server + path` was
    one whose host was the path's first segment ('http:' + '/pilot/v1/me' is http://pilot/v1/me): the JS client sent the
    agent and owner tokens, joins and enrollments there in clear text; `valun config server http://` stored 'http:'
    without a word, and this client sent an in-memory 'HTTP:/' to 'pilot' with the opt-in. Now both clients refuse a
    server setting that is not scheme://host[:port][/path] (client.server_problem) wherever it is set or used, before
    anything is sent, naming the setting: `config server`, --server, VALUN_SERVER, a join, a profile's own server. A
    machine proxy stands for wherever such a request would go: nothing reaches it."""

    def setUp(self):
        self.p = HttpsProxy()
        self.addCleanup(self.p.close)
        machine_proxy(self, self.p.url)
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV', 'VALUN_ALLOW_PLAIN_HTTP'):
            os.environ.pop(k, None)
        for patch in (mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0)), mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0))):
            patch.start()
            self.addCleanup(patch.stop)
        self.sent = []
        real = vc.Client._open

        def counting(c, req):
            self.sent.append(req.full_url)
            return real(c, req)
        patch = mock.patch.object(vc.Client, '_open', counting)
        patch.start()
        self.addCleanup(patch.stop)

    def refused(self, call, words):
        with self.assertRaises(vc.ValunError) as e:
            call()
        x = e.exception
        self.assertEqual((x.code, x.status, x.extra.get('cause')), ('unreachable', None, 'not_connected'), str(x))
        self.assertEqual(str(x), words)
        self.assertFalse(vc.transport_cut(x))
        return x

    def test_the_client_refuses_a_server_with_no_host_from_its_profile_or_its_argument(self):
        for opt_in in ('', '1'):        # the opt-in to plain http changes nothing here
            os.environ['VALUN_ALLOW_PLAIN_HTTP'] = opt_in
            for server in HOSTLESS:
                for given in ('profile', 'argument'):
                    def client(token=TOKEN):
                        if given == 'profile':
                            return vc.Client(Mem({'server': server, 'network': 'valun-testnet-1'}, SECRET, token), timeout=10)
                        return vc.Client(Mem({'network': 'valun-testnet-1'}, SECRET, token), server, timeout=10)
                    setting = "This profile's server" if given == 'profile' else 'The server this Client was given'
                    shown = json.dumps(server if given == 'profile' else server.rstrip('/'))
                    words = (f'{setting} must be an http(s) URL with a host, such as https://valun.tech: {shown} has no '
                             'host. Nothing was sent.')
                    for call in (lambda: client().me(), lambda: client().request('GET', '/pilot/v1/owner', token=OWNER_TOKEN),
                                 lambda: client(None).join_sandbox('h-nohost', 'Ann'),
                                 lambda: client(None).join('INVITE', 'h-nohost', 'Ann'),
                                 lambda: client(None).enroll('vp_0a0a0a0a0a0a', 'TEST-ONLY-code'),
                                 lambda: client(None).request('GET', '/pilot/v1/info', auth=False)):
                        x = self.refused(call, words)
                        self.assertEqual(va.error_payload(x)['what_this_means'], va.TRANSPORT_WORDS['not_connected|'])
        self.assertEqual(self.sent, [], 'nothing was sent')
        self.assertEqual(self.p.seen, [], 'nothing reached the proxy, or anything past it')

    def test_a_user_and_password_in_the_server_are_refused_and_never_repeated_and_a_path_is_kept(self):
        x = self.refused(lambda: vc.Client(Mem({'server': USERINFO_SERVER}, SECRET, TOKEN), timeout=10).me(),
                         "This profile's server must be an http(s) URL with a host, such as https://valun.tech: it has a "
                         'user name or password (before an @), which a server URL never carries, so it is not repeated '
                         'here. Nothing was sent.')
        self.assertNotIn('TEST-ONLY', json.dumps(va.error_payload(x)))
        self.assertEqual((self.sent, self.p.seen), ([], []))
        # a path is part of a server URL (a server behind a prefix): kept, on the server's own host
        paths = []
        base, seen = origin(self, lambda h: (paths.append(h.path), answer_json(ME)(h)))
        for server, state in ((base + '/base', {}), (base, {'server': base + '/base/'})):
            paths.clear()
            c = vc.Client(Mem(state, SECRET, TOKEN), server if not state else None, timeout=10)
            self.assertEqual(c.me(), ME, server)
            self.assertEqual(paths, ['/base/pilot/v1/me' if not state else '/base//pilot/v1/me'], server)
        self.assertIsNone(vc.server_problem(base + '/base'))
        # a request path joins onto the server's host unless it starts from its root: refused before anything is sent
        for path in ('.evil.example/x', '@evil.example/x', 'pilot/v1/me', ''):
            with self.assertRaises(vc.ValunError) as e:
                vc.Client(Mem({'server': base}, SECRET, TOKEN), timeout=10).request('GET', path)
            self.assertEqual(e.exception.code, 'bad_arguments', path)
        self.assertEqual(len(seen), 2, 'only the two reads of the prefixed server')

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}):
            rc = cli.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def profile(self, server, name='default', **more):
        path = os.path.join(os.environ['VALUN_HOME'], 'profiles', f'{name}.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(dict({'server': server, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                            'secret': SECRET, 'agent_token': TOKEN, 'approvals': 'none'}, **more), f)
        return path

    def test_config_server_refuses_a_url_with_no_host_and_keeps_the_one_it_has(self):
        path = self.profile('https://valun.example')
        for bad, shown, why in [*((s, json.dumps(s.rstrip('/')), 'has no host') for s in HOSTLESS),
                                (USERINFO_SERVER, 'it', 'has a user name or password (before an @), which a server URL '
                                                        'never carries, so it is not repeated here'),
                                ('valun.tech', '"valun.tech"', 'has no scheme (a server URL starts with https://)'),
                                ('https://valun.example?x=1', '"https://valun.example?x=1"',
                                 'has a query or a fragment (? or #), which a server URL never carries')]:
            rc, out, err = self.cli('config', 'server', bad)
            self.assertEqual((rc, err), (1, ''), bad)
            self.assertEqual(out, f'server must be an http(s) URL with a host, such as https://valun.tech: {shown} {why}. '
                                  'Nothing was changed.\n')
            self.assertNotIn('TEST-ONLY', out)
            with open(path, encoding='utf-8') as f:
                self.assertEqual(json.load(f)['server'], 'https://valun.example', 'unchanged')
        rc, out, err = self.cli('config', 'server', 'https://valun.example/base/')
        self.assertEqual((rc, out), (0, 'server = https://valun.example/base\n'))
        self.assertEqual(self.sent, [])

    def test_a_server_setting_with_no_host_is_named_where_it_came_from_and_nothing_is_sent(self):
        # a profile whose file names 'http:' (what 0.7.1 and the RC's `config server http://` stored)
        self.profile('http:')
        with open(os.path.join(os.environ['VALUN_HOME'], 'profiles', 'nokey.json'), 'w', encoding='utf-8') as f:
            json.dump({'server': 'http:'}, f)

        def fix(name='default'):
            return ("This profile's server must be an http(s) URL with a host, such as https://valun.tech: \"http:\" has "
                    f'no host. Nothing was sent. Set it again: `valun --profile {name} config server URL` (URL: your '
                    'Valun server, such as https://valun.tech).')
        rc, out, err = self.cli('doctor')
        self.assertEqual(rc, 1, out)
        self.assertIn(f'FIX   {fix()}\n', out)
        self.assertNotIn('reachable', out)
        rc, out, err = self.cli('status')
        self.assertEqual(rc, 1)
        self.assertIn('server:           "http:"\n', out)
        self.assertTrue(out.endswith(fix() + '\n'), out)
        for name, server, line, why in (('creds', USERINFO_SERVER, '(not shown: it has a user name or password)',
                                         'it has a user name or password (before an @)'),
                                        ('num', 5, '5', 'it is not text')):
            self.profile(server, name)
            rc, out, err = self.cli('--profile', name, 'status')
            self.assertEqual(rc, 1, out)
            self.assertIn(f'server:           {line}\n', out)
            self.assertIn(f"This profile's server must be an http(s) URL with a host, such as https://valun.tech: {why}", out)
            self.assertNotIn('TEST-ONLY', out)
        for argv in (('call', 'valun_status'), ('mcp',), ('console', '--no-open'), ('audit', '--explorer', 'https://explorer.invalid'),
                     ('--profile', 'nokey', 'enroll', '--participant', 'vp_0a0a0a0a0a0a', '--code-from-stdin')):
            rc, out, err = self.cli(*argv)
            self.assertEqual(rc, 2 if 'audit' in argv else 1, argv)
            self.assertIn(fix('nokey' if 'nokey' in argv else 'default'), out if 'audit' in argv else err, argv)
        # --server, VALUN_SERVER and a join, in a profile that has not joined
        for server in HOSTLESS:
            shown = json.dumps(server.rstrip('/'))
            rc, out, err = self.cli('--profile', 'fresh', 'join', '--sandbox', '--handle', 'h-nohost', '--operator', 'Ann',
                                    '--server', server)
            self.assertEqual((rc, out), (1, ''), server)
            self.assertEqual(err, f'valun join: --server must be an http(s) URL with a host, such as https://valun.tech: '
                                  f'{shown} has no host. Nothing was sent.\n')
            rc, out, err = self.cli('--profile', 'fresh', 'doctor', '--server', server)
            self.assertIn(f'FIX   --server must be an http(s) URL with a host, such as https://valun.tech: {shown} has no '
                          'host. Nothing was sent.\n', out)
            os.environ['VALUN_SERVER'] = server
            rc, out, err = self.cli('--profile', 'fresh', 'join', '--sandbox', '--handle', 'h-nohost', '--operator', 'Ann')
            self.assertEqual(rc, 1, server)
            self.assertEqual(err, f'valun join: VALUN_SERVER must be an http(s) URL with a host, such as https://valun.tech: '
                                  f'{shown} has no host. Nothing was sent. Correct it, or unset it for https://valun.tech.\n')
            del os.environ['VALUN_SERVER']
        rc, out, err = self.cli('--profile', 'fresh', 'join', '--sandbox', '--handle', 'h-nohost', '--operator', 'Ann',
                                '--server', USERINFO_SERVER)
        self.assertEqual(rc, 1)
        self.assertIn('--server must be an http(s) URL with a host, such as https://valun.tech: it has a user name or '
                      'password (before an @)', err)
        self.assertNotIn('TEST-ONLY', out + err)
        self.assertFalse(os.path.exists(os.path.join(os.environ['VALUN_HOME'], 'profiles', 'fresh.json')))
        self.assertEqual((self.sent, self.p.seen), ([], []), 'nothing was sent')


class ProfileServer(unittest.TestCase):
    """The RC's review (transport-security server-flag-sends-profile-tokens): a command's --server took the profile's
    place, so `valun doctor --server X` sent this profile's agent token to X and reported "Agent accepted by the server"
    for it, `config approvals ... --server X` sent the owner token there, and `valun console --server X` pointed the
    owner and the owner token at X without a word. Now a joined profile's tokens go only to the server its file names:
    nothing that carries one is sent elsewhere (wrong_server), doctor and console say which server is which, and
    `valun config server URL` moves a profile. Loopback only; test tokens."""
    OWN = 'https://profile-server.invalid'

    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV', 'VALUN_ALLOW_PLAIN_HTTP'):
            os.environ.pop(k, None)
        self.home = home.name
        os.makedirs(os.path.join(home.name, 'profiles'))
        self.path = os.path.join(home.name, 'profiles', 'default.json')
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': self.OWN, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'pubkey': vb.public_key(bytes.fromhex(SECRET)).hex(), 'secret': SECRET, 'agent_token': TOKEN,
                       'approvals': 'ask'}, f)
        self.other, self.seen = origin(self, lambda h: answer_json(INFO if h.path.endswith('/info') else
                                                                   {'participant': {'id': 'vp_0a0a0a0a0a0a'}, 'mandate': {}}
                                                                   if '/owner' in h.path else ME)(h))
        self.tf = os.path.join(home.name, 'owner-token.txt')
        with open(self.tf, 'w', encoding='utf-8') as f:
            f.write(OWNER_TOKEN + '\n')

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(cli.webbrowser, 'open', lambda url: True):
            rc = cli.main(list(argv))
        return rc, out.getvalue()

    def test_a_joined_profiles_tokens_never_go_to_another_server(self):
        store = vc.FileStore(self.path)
        c = vc.Client(store, self.other, timeout=10)
        for call in (lambda: c.me(), lambda: c.request('GET', '/pilot/v1/owner', token=OWNER_TOKEN),
                     lambda: c.request('POST', '/pilot/v1/deals', {'terms': {}})):
            with self.assertRaises(vc.ValunError) as e:
                call()
            x = e.exception
            self.assertEqual((x.code, x.status, x.extra.get('profile_server'), x.extra.get('server')),
                             ('wrong_server', None, self.OWN, self.other))
            self.assertEqual(str(x), f"this profile's participant is on {self.OWN}, so its tokens go only there: {self.other} "
                                     'is another server, and nothing was sent to it. Run this without --server, or, if '
                                     f'the profile has moved to {self.other}, set that first: `valun --profile default '
                                     f'config server {self.other}`')
            self.assertFalse(vc.answer_unread(x) or vc._transient(x))
            self.assertEqual(va.error_payload(x)['what_this_means'], va.WRONG_SERVER_TEXT)
        self.assertEqual(self.seen, [], 'nothing reached the other server')
        # a read that carries no token goes; so do the profile's own server in another spelling, and a moved profile
        self.assertEqual(c.request('GET', '/pilot/v1/info', auth=False)['network'], 'valun-testnet-1')
        for same in ('https://PROFILE-server.invalid/', 'https://profile-server.invalid:443'):
            self.assertTrue(vc.same_server(same, self.OWN), same)
        store.update(lambda st: st.update(server=self.other))         # `valun config server URL`
        self.assertEqual(vc.Client(store, self.other, timeout=10).me(), ME)
        self.assertEqual(self.seen, [None, 'Bearer ' + TOKEN])

    def test_doctor_with_another_server_checks_it_with_no_token_and_says_whose_server_is_whose(self):
        rc, out = self.run_cli('doctor', '--server', self.other)
        self.assertEqual(rc, 1, out)
        self.assertIn(f"FIX   --server {self.other} is not this profile's server: its participant vp_0a0a0a0a0a0a is on "
                      f'{self.OWN}, and its tokens go only there, so nothing with them was sent to {self.other}, and this '
                      'agent was not checked there. Check it on its own server: `valun --profile default doctor`; if the '
                      f'profile has moved to {self.other}: `valun --profile default config server {self.other}`.', out)
        self.assertNotIn('Agent accepted', out)
        self.assertEqual(self.seen, [None], 'GET /info only, with no token')

    def test_config_approvals_with_another_server_sends_no_owner_token(self):
        rc, out = self.run_cli('config', 'approvals', 'console', '--owner-token-file', self.tf, '--server', self.other)
        self.assertEqual(rc, 1, out)
        self.assertIn(f"Could not change the mandate (wrong_server): this profile's participant is on {self.OWN}", out)
        self.assertEqual(self.seen, [], 'the owner token went nowhere')
        with open(self.path, encoding='utf-8') as f:
            self.assertEqual(json.load(f)['approvals'], 'ask', 'nothing changed')

    def test_console_with_another_server_names_the_address_it_opens_and_the_profiles_own(self):
        rc, out = self.run_cli('console', '--no-open', '--server', self.other)
        self.assertEqual(rc, 0)
        self.assertIn(f"Owner console: {self.other}/pilot#owner, which is not this profile's server: its participant "
                      f'vp_0a0a0a0a0a0a is on {self.OWN}, whose owner console is {self.OWN}/pilot#owner. Its owner token works '
                      f'only there: never sign in at {self.other}/pilot#owner with it. `valun --profile default console` opens '
                      'its own.', out)
        self.assertNotIn('Sign in with your owner token', out)
        rc, out = self.run_cli('console', '--no-open')
        self.assertIn(f'Owner console: {self.OWN}/pilot#owner (participant vp_0a0a0a0a0a0a, profile default)', out)

    def test_a_profile_that_has_not_joined_takes_any_server(self):
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': self.OWN}, f)
        rc, out = self.run_cli('doctor', '--server', self.other)
        self.assertIn(f'ok    --server {self.other}: this profile names {self.OWN} as its server, and it has not joined yet '
                      f'(a join with --server {self.other} joins {self.other})', out)
        self.assertNotIn('is not this profile', out)

    def test_a_profile_server_with_a_password_is_never_repeated_where_another_server_is_named(self):
        # The RC's review, round 4 (wrong-server-words-repeat-profile-server-password): a profile's own server with a
        # user name and password (0.7.1's `valun config server` and join stored any value; or a hand edit) is refused
        # and never repeated without --server, but with --server naming another server, doctor's FIX line, `valun
        # console`, and wrong_server_refusal's words and extra.profile_server (`config approvals ... --server`) printed
        # it, its password included. Now each says what status says of it, which never repeats it, and nothing with a
        # token is sent anywhere.
        own = 'https://TESTuser:PW-NEVER-SHOWN@valun-test.invalid'
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': own, 'participant_id': 'vp_0a0a0a0a0a0a', 'network': 'valun-testnet-1',
                       'pubkey': vb.public_key(bytes.fromhex(SECRET)).hex(), 'secret': SECRET, 'agent_token': TOKEN,
                       'approvals': 'ask'}, f)
        bad = ("This profile's server must be an http(s) URL with a host, such as https://valun.tech: it has a user name or "
               'password (before an @), which a server URL never carries, so it is not repeated here.')
        again = 'Set it again: `valun --profile default config server URL`'
        never = ('PW-NEVER-SHOWN', 'TESTuser', 'valun-test.invalid')
        c = vc.Client(vc.FileStore(self.path), self.other, timeout=10)
        for call in (lambda: c.me(), lambda: c.request('GET', '/pilot/v1/owner', token=OWNER_TOKEN),
                     lambda: c.request('POST', '/pilot/v1/deals', {'terms': {}})):
            with self.assertRaises(vc.ValunError) as e:
                call()
            x = e.exception
            self.assertEqual((x.code, x.status, x.extra.get('cause'), x.extra.get('setting')),
                             ('unreachable', None, 'not_connected', "This profile's server"))
            self.assertEqual(str(x), f'{bad} Nothing was sent. {again}.')
            self.assertNotIn('profile_server', x.extra)
            for shown in (str(x), json.dumps(x.extra), json.dumps(va.error_payload(x))):
                for word in never:
                    self.assertNotIn(word, shown)
        self.assertEqual(self.seen, [], 'nothing reached the other server')
        # doctor checks the other server with no token, and says what status says of this profile's own
        rc, out = self.run_cli('doctor', '--server', self.other)
        self.assertEqual(rc, 1, out)
        self.assertIn(f'FIX   {bad} Its tokens go to no other server, so nothing with them was sent to {self.other}, and '
                      f'this agent was not checked there. {again} (URL: your Valun server, such as https://valun.tech).', out)
        self.assertNotIn('Agent accepted', out)
        self.assertEqual(self.seen, [None], 'GET /info only, with no token')
        # console opens the address asked for, and never repeats this profile's own
        rc, out2 = self.run_cli('console', '--no-open', '--server', self.other)
        self.assertEqual(rc, 0, out2)
        self.assertIn(f"Owner console: {self.other}/pilot#owner, which is not this profile's server. {bad} Its owner token "
                      f'works only on its own server: never sign in at {self.other}/pilot#owner with it. {again} (URL: '
                      'your Valun server, such as https://valun.tech).', out2)
        # config approvals sends no owner token, in the client's words
        rc, out3 = self.run_cli('config', 'approvals', 'console', '--owner-token-file', self.tf, '--server', self.other)
        self.assertEqual(rc, 1, out3)
        self.assertIn(f'Could not change the mandate (unreachable): {bad} Nothing was sent. {again}.', out3)
        self.assertEqual(self.seen, [None], 'the owner token went nowhere')
        # a profile that has not joined: doctor says the same, and no token was in play
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': own}, f)
        rc, out4 = self.run_cli('doctor', '--server', self.other)
        self.assertIn(f'FIX   {bad} Nothing was sent to it. {again} (URL: your Valun server, such as https://valun.tech).',
                      out4)
        for text in (out, out2, out3, out4):
            for word in never:
                self.assertNotIn(word, text)


class OwnOpener(unittest.TestCase):
    """The RC's review (transport-security, missed[1] and destination-refused-says-nothing-sent): Client.request sent
    through urllib.request.urlopen, so whatever a process set for urllib applied to the requests that carry the agent's
    or the owner's token: an opener another library installed (install_opener) with an HTTPSHandler that does not
    verify, or the common workaround ssl._create_default_https_context = ssl._create_unverified_context, sent the token
    to a server whose certificate this machine does not trust; an embedding application's ProxyBasicAuthHandler sent a
    request on after the proxy's 407, and the client said "nothing was sent" although the token had reached the proxy.
    Each Client now has its own opener (server_opener). Loopback only; test tokens and a test-only CA."""

    def setUp(self):
        old = getattr(urllib.request, '_opener', None)
        self.addCleanup(urllib.request.install_opener, old)
        fast = mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0))
        fast.start()
        self.addCleanup(fast.stop)

    def untrusted(self):
        base, seen = origin(self, answer_json(ME), tls=True)
        return vc.Client(Mem({'server': base}, SECRET, TOKEN), timeout=10), seen

    def assert_refused_untrusted(self, c, seen):
        with self.assertRaises(vc.ValunError) as e:
            c.me()
        x = e.exception
        self.assertEqual((x.code, x.extra.get('cause'), x.extra.get('transport_error')),
                         ('unreachable', 'not_connected', 'SSLCertVerificationError'), str(x))
        self.assertEqual(seen, [], 'nothing reached the server: its certificate is not one this machine trusts')

    def test_an_unverified_opener_another_library_installed_does_not_apply(self):
        unverified = ssl.create_default_context()
        unverified.check_hostname, unverified.verify_mode = False, ssl.CERT_NONE
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                                                  urllib.request.HTTPSHandler(context=unverified)))
        self.assert_refused_untrusted(*self.untrusted())

    def test_an_unverified_default_https_context_does_not_apply(self):
        # set as the workaround sets it, before anything of urllib runs (an HTTPSHandler takes its context when it is made)
        with mock.patch.object(ssl, '_create_default_https_context', ssl._create_unverified_context):
            urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
            self.assert_refused_untrusted(*self.untrusted())

    def test_an_embedding_apps_proxy_auth_handler_does_not_apply_and_nothing_is_said_unsent_that_went_out(self):
        p = HttpsProxy(demand_auth=True)
        self.addCleanup(p.close)
        machine_proxy(self, p.url)
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, p.url, 'TEST-ONLY-user', 'TEST-ONLY-pass')
        urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({'http': p.url}),
                                                                  urllib.request.ProxyBasicAuthHandler(mgr)))
        c = vc.Client(Mem({'server': f'http://{PROXIED_HOST}'}, SECRET, TOKEN), timeout=10)
        with mock.patch.dict(os.environ, {'VALUN_ALLOW_PLAIN_HTTP': '1'}), self.assertRaises(vc.ValunError) as e:
            c.me()
        x = e.exception
        self.assertEqual([s[0] for s in p.seen], ['absolute'], 'sent once, through the proxy this machine sets')
        self.assertNotIn('nothing was sent', str(x), 'the request reached the proxy')
        self.assertEqual((x.code, x.status), ('http_error', 407), str(x))

    def test_a_server_on_this_machine_is_never_reached_through_a_proxy(self):
        p = HttpsProxy()
        self.addCleanup(p.close)
        machine_proxy(self, p.url)
        for host, name in (('127.0.0.1', '127.0.0.1'), ('::1', '[::1]'), ('127.0.0.1', 'localhost')):
            try:
                base, seen = origin(self, answer_json(ME), host=host)
            except OSError:                             # no IPv6 on this machine
                continue
            base = base.replace(f'[{host}]' if ':' in host else host, name, 1)
            self.assertEqual(vc.Client(Mem({'server': base}, SECRET, TOKEN), timeout=10).me(), ME, base)
            self.assertEqual(seen, ['Bearer ' + TOKEN], f'{base} was reached directly')
        self.assertEqual(p.seen, [], 'nothing went to the proxy, which would have seen the token in clear text')
        for host, mine in (('127.0.0.1', True), ('127.8.9.10', True), ('[::1]', True), ('[::ffff:127.0.0.1]', True),
                           ('LocalHost', True), ('localhost.', False), ('LOCALHOST.', False), ('localhost..', False),
                           ('valun.tech', False), ('10.0.0.1', False), ('[::2]', False), ('127.0.0.1.example', False),
                           ('', False), (None, False)):
            self.assertEqual(vc.loopback_host(host), mine, host)


PROXY_VARS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')


class ProxySettingTest(unittest.TestCase):
    """A joined profile on an https server that is not in the lab (valun-test.invalid), and `proxy` as HTTPS_PROXY, the
    only proxy variable set: urllib.request.getproxies reads it as a user's shell sets it."""
    proxy = None

    def setUp(self):
        home = tempfile.TemporaryDirectory()
        self.addCleanup(home.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': home.name, 'HOME': home.name, 'USERPROFILE': home.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'VALUN_ALLOW_PLAIN_HTTP') + PROXY_VARS:
            os.environ.pop(k, None)
        os.environ['HTTPS_PROXY'] = self.proxy
        os.makedirs(os.path.join(home.name, 'profiles'))
        self.path = os.path.join(home.name, 'profiles', 's.json')
        with open(self.path, 'w', encoding='utf-8') as f:
            json.dump({'server': 'https://valun-test.invalid', 'participant_id': 'vp_0a0a0a0a0a0a',
                       'network': 'valun-testnet-1', 'secret': SECRET, 'agent_token': TOKEN, 'approvals': 'none'}, f)
        fast = mock.patch.object(vc, 'READ_RETRY_WAITS', (0, 0))
        fast.start()
        self.addCleanup(fast.stop)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            rc = cli.main(['--profile', 's', *argv])
        return rc, out.getvalue()


class AProxyUrlPythonCannotUse(ProxySettingTest):
    """The RC's review, round 3 (transport-security proxy-url-valueerror-prints-credentials): a proxy URL with one slash
    after its scheme, a plausible typo, makes urllib raise ValueError("proxy URL with no authority: '<the whole proxy
    URL>'") before it connects. Client.request let it out as it was: doctor printed the proxy's user and password in its
    FIX line (the output testers paste into a public report), `valun call` and the MCP tools returned internal_error
    with them in its message to the model, and Client.me() raised a ValueError, not ValunError('unreachable'). 0.7.1 the
    same. Nothing listens anywhere here: nothing was ever sent."""
    proxy = 'http:/TEST-ONLY-user:TEST-ONLY-proxy-pass@127.0.0.1:9'

    def test_the_client_says_unreachable_nothing_sent_and_names_no_credentials(self):
        with self.assertRaises(vc.ValunError) as e:
            vc.Client(self.path).me()
        x = e.exception
        self.assertEqual((x.code, x.extra.get('cause'), x.extra.get('transport_error')),
                         ('unreachable', 'not_connected', 'ProxyRefused'), str(x))
        self.assertIn("this machine's proxy setting for https is not a URL Python can use", str(x))
        self.assertIn('nothing was sent', str(x))
        for secret in ('TEST-ONLY-proxy-pass', 'TEST-ONLY-user'):
            self.assertNotIn(secret, str(x) + json.dumps(x.extra))

    def test_doctor_and_the_tools_name_no_credentials(self):
        rc, out = self.cli('doctor')
        self.assertEqual(rc, 1)
        self.assertIn("FIX   Server https://valun-test.invalid was not reached: this machine's proxy setting for https "
                      'is not a URL Python can use', out)
        rc, said = self.cli('call', 'valun_status')
        got = json.loads(said)
        self.assertEqual((got['error'], got.get('cause')), ('unreachable', 'not_connected'), said)
        for text in (out, said):
            for secret in ('TEST-ONLY-proxy-pass', 'TEST-ONLY-user'):
                self.assertNotIn(secret, text)

    def test_an_exceptions_payload_never_carries_a_urls_user_and_password_or_a_token(self):
        # error_payload's internal_error, for any exception the tools did not expect (its docstring: never secrets)
        for e, secrets in ((ValueError("proxy URL with no authority: 'http:/TEST-ONLY-u:TEST-ONLY-pw@h:1'"),
                            ('TEST-ONLY-u', 'TEST-ONLY-pw')),
                           (ValueError('see https://TEST-ONLY-u:TEST-ONLY-pw@proxy.example:8080/x'),
                            ('TEST-ONLY-u', 'TEST-ONLY-pw')),
                           (ValueError(f"Invalid header value b'Bearer {TOKEN}\\r\\n'"), (TOKEN,)),
                           (RuntimeError(f'token {OWNER_TOKEN} rejected'), (OWNER_TOKEN,))):
            got = va.error_payload(e)
            self.assertEqual(got['error'], 'internal_error')
            for s in secrets:
                self.assertNotIn(s, got['message'], got)
        self.assertEqual(va.error_payload(KeyError('deal_id')), {'error': 'internal_error', 'message': "KeyError: 'deal_id'"})


class PlainListener:
    """A TCP listener on loopback that stands in for a proxy: it records what each connection sends first (up to its
    blank line), then closes it with no answer. saw: those heads, as text."""

    def __init__(self):
        self.sock = socket.create_server(('127.0.0.1', 0))
        self.port, self.saw = self.sock.getsockname()[1], []
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            with c:
                c.settimeout(5)
                buf = b''
                with contextlib.suppress(OSError):
                    while b'\r\n\r\n' not in buf and len(buf) < 65536:
                        chunk = c.recv(4096)
                        if not chunk:
                            break
                        buf += chunk
                self.saw.append(buf.decode('latin-1'))

    def close(self):
        self.sock.close()


class AnHttpsProxyUrlWithCredentials(ProxySettingTest):
    """The RC's review, round 3 (transport-security https-proxy-url-credentials-in-clear): with HTTPS_PROXY=https://user:
    pass@proxy:port, Python sent its CONNECT, with a Proxy-Authorization header holding the user and password, over plain
    TCP to the proxy, although the proxy URL says https: urllib reaches every proxy without TLS (Node uses TLS to such a
    proxy). The agent's token stayed inside the TLS to the server, but the proxy's credentials crossed the network in
    clear text. 0.7.1 the same. The proxy here is a listener on loopback that answers nothing."""
    proxy = 'https://TEST-ONLY-user:TEST-ONLY-proxy-pass@127.0.0.1:{port}'

    def setUp(self):
        self.listener = PlainListener()
        self.addCleanup(self.listener.close)
        self.proxy = type(self).proxy.format(port=self.listener.port)
        super().setUp()

    def test_it_is_refused_before_anything_is_sent(self):
        with self.assertRaises(vc.ValunError) as e:
            vc.Client(self.path, timeout=5).me()
        x = e.exception
        self.assertEqual((x.code, x.extra.get('cause'), x.extra.get('transport_error')),
                         ('unreachable', 'not_connected', 'ProxyRefused'), str(x))
        self.assertIn("this machine's proxy setting for https is an https:// proxy URL with a user and password", str(x))
        self.assertIn('Python reaches a proxy without TLS, so they would cross the network to it in clear text', str(x))
        for secret in ('TEST-ONLY-proxy-pass', 'TEST-ONLY-user'):
            self.assertNotIn(secret, str(x))
        self.assertEqual(self.listener.saw, [], 'nothing reached the proxy: no CONNECT, no Proxy-Authorization')
        rc, out = self.cli('doctor')
        self.assertIn("FIX   Server https://valun-test.invalid was not reached: this machine's proxy setting for https "
                      'is an https:// proxy URL with a user and password', out)
        self.assertNotIn('TEST-ONLY-proxy-pass', out)
        self.assertEqual(self.listener.saw, [])


class AnHttpsProxyUrlWithoutCredentials(AnHttpsProxyUrlWithCredentials):
    """The same proxy URL without a user and password is used as before (no secret crosses in its CONNECT), and doctor
    says, by its scheme only, that Python reaches it without TLS: a proxy that speaks only TLS does not answer that."""
    proxy = 'https://127.0.0.1:{port}'

    def test_it_is_refused_before_anything_is_sent(self):
        with self.assertRaises(vc.ValunError) as e:
            vc.Client(self.path, timeout=5).me()
        self.assertEqual(e.exception.code, 'unreachable', str(e.exception))
        self.assertNotEqual(e.exception.extra.get('transport_error'), 'ProxyRefused')
        self.assertTrue(self.listener.saw and self.listener.saw[0].startswith('CONNECT valun-test.invalid:443 '),
                        self.listener.saw)
        self.assertNotIn('proxy-authorization', self.listener.saw[0].lower())
        rc, out = self.cli('doctor')
        self.assertIn('The proxy URL Python sets for https starts with https://, but Python reaches a proxy without TLS', out)


if __name__ == '__main__':
    unittest.main()
