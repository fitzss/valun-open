"""Offline check of the real Claude class with the official SDK: a local mock of POST /v1/messages captures the request the
SDK sends and answers a canned reply, so the request's shape (model, effort, refusal fallback beta) and the parsing of
the reply are checked without an API key or any spending.   python check_request_shape.py"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

seen = {}
REPLY = {'id': 'msg_test', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5',
         'content': [{'type': 'text', 'text': '- one\n- two\n\nIn one sentence: fine.'}],
         'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': {'input_tokens': 321, 'output_tokens': 123}}


class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length') or 0))
        seen.update(path=self.path, beta=self.headers.get('anthropic-beta'), body=json.loads(body))
        out = json.dumps(REPLY).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('request-id', 'req_test')
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ.update(ANTHROPIC_BASE_URL=f'http://127.0.0.1:{srv.server_address[1]}', ANTHROPIC_API_KEY='test-key-not-real')
import ai_seller as A  # noqa: E402

spec = A.SERVICE_SPECS['summary']
r = A.Claude('claude-opus-5-5').run('SYSTEM', 'USER', spec)
b = seen['body']
checks = {
    'POST /v1/messages': seen['path'].startswith('/v1/messages'),
    'refusal fallback beta header': 'server-side-fallback-2026-07-01' in (seen['beta'] or ''),
    'fallbacks "default"': b.get('fallbacks') == 'default',
    'model claude-opus-5-5': b.get('model') == 'claude-opus-5-5',
    'effort low': b.get('output_config') == {'effort': 'low'},
    'max_tokens 3000': b.get('max_tokens') == 3000,
    'no thinking parameter (adaptive by default)': 'thinking' not in b,
    'system and one user message': b.get('system') == 'SYSTEM' and b.get('messages') == [{'role': 'user', 'content': 'USER'}],
    'reply text parsed': r.get('content') == '- one\n- two\n\nIn one sentence: fine.',
    'cost from usage': abs(r['cost'] - (321 * 4 + 123 * 20) / 1e6) < 1e-12,
    'request id kept': r.get('request_id') == 'req_test',
}
seen.clear()
A.Claude('claude-haiku-5-5').run('S', 'U', spec)
checks['haiku: no fallback (none exists for it)'] = 'fallbacks' not in seen['body'] and 'server-side-fallback' not in (seen['beta'] or '')
for k, ok in checks.items():
    print(('ok    ' if ok else 'FAIL  ') + k)
srv.shutdown()
sys.exit(0 if all(checks.values()) else 1)
