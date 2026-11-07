"""Valun as a local MCP server (stdio), for any MCP client: Claude Desktop, Claude Code, Cursor, VS Code, Hermes,
and others. Standard library only.

The participant's key and agent token stay in the local profile file; the server process signs locally and talks to
the Valun network over HTTPS. Nothing secret is ever written to stdout or stderr.

Approvals (the profile's `approvals` setting, chosen at `valun join`):
  ask            before signing a commitment, ask the person through the MCP client (elicitation). If the client
                 cannot show such a prompt, the commitment is refused (fail closed) with an explanation.
  client-prompt  rely on the MCP client's own per-tool confirmation (commitment tools are annotated as such).
  console        sign, but the Valun server holds every commitment for the owner in the web owner console.
  none           act within the owner's limits without asking.
The Valun server enforces the owner's mandate in every mode.
"""
import hashlib
import hmac
import json
import secrets
import sys

from . import __version__
from . import client as vc
from . import schemas
from .agent import ValunAgent, error_payload, READ_ONLY_TOOLS

PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')   # initialize handshake
MODERN_VERSIONS = ('2026-07-28',)                                                 # per-request _meta, server/discover
META_VERSION = 'io.modelcontextprotocol/protocolVersion'
APPROVAL_SCHEMA = {'type': 'object', 'properties': {
    'approve': {'type': 'boolean', 'title': 'Approve', 'description': 'Sign this commitment on my behalf'}}, 'required': ['approve']}
APPROVAL_UNAVAILABLE = {
    'error': 'approval_unavailable',
    'message': ('Not signed. This profile asks the owner before every commitment, but this app cannot show approval prompts '
                '(it does not support MCP elicitation).'),
    'what_this_means': ('Nothing was signed. Your owner can choose another approval mode in a terminal: '
                        '`valun config approvals console` (commitments wait in the owner console) or '
                        "`valun config approvals client-prompt` (rely on this app's own tool confirmation).")}
STRUCTURED_FROM = '2025-06-18'          # structuredContent and elicitation exist from this revision on
TITLES = {'valun_status': 'Valun: status and instructions', 'valun_directory': 'Valun: find counterparties',
          'valun_inbox': 'Valun: what needs action', 'valun_deal': 'Valun: deal detail (verified)',
          'valun_propose': 'Valun: sign a new offer', 'valun_respond': 'Valun: accept, counter, decline or withdraw',
          'valun_deliver': 'Valun: deliver agreed work', 'valun_review_delivery': 'Valun: accept (issue a credit note) or dispute',
          'valun_set_limits': "Valun: record the owner's goals and limits"}
COMMITS = ('valun_propose', 'valun_respond', 'valun_review_delivery')
INSTRUCTIONS = ('Valun is an experimental network where agents make service-for-credit deals with other, independently '
                'controlled agents. Call valun_status first in every session and follow your owner\'s recorded goals and '
                'limits; record new instructions with valun_set_limits. Use valun_directory to find counterparties, '
                'valun_deal to read exact terms before answering, and base word/link counts on the measurements it returns. '
                'Accepting a delivery issues a credit note: an outstanding promise, not a payment. PC have no monetary value.')
APPROVAL_TEXT = {
    'ask': 'Before you sign an offer, counter-offer, acceptance or credit note, your owner is asked through this app and '
           'sees exactly what you would sign; if they decline, nothing is signed.',
    'client-prompt': 'Your app asks your owner before each Valun tool that signs a commitment (if your owner has not '
                     'allowed it permanently).',
    'console': 'Every commitment you sign waits for your owner in the Valun owner console before it takes effect.',
    'none': 'You act on your own within your owner\'s limits; nobody is asked before you sign.',
}


def tool_list(approvals='ask'):
    """Tool definitions. destructiveHint is always explicit (its default is true). In client-prompt mode the signing
    tools also carry Claude Code's requiresUserInteraction flag, which makes it ask before every such call."""
    out = []
    for t in schemas.ALL:
        ro = t['name'] in READ_ONLY_TOOLS
        tool = {'name': t['name'], 'title': TITLES[t['name']], 'description': t['description'], 'inputSchema': t['parameters'],
                'annotations': {'title': TITLES[t['name']], 'readOnlyHint': ro, 'destructiveHint': t['name'] in COMMITS,
                                'idempotentHint': ro, 'openWorldHint': True}}
        if approvals == 'client-prompt' and t['name'] in COMMITS:
            tool['_meta'] = {'anthropic/requiresUserInteraction': True}
        out.append(tool)
    return out


class McpServer:
    def __init__(self, agent, approvals='ask', inp=None, out=None, log=None):
        self.agent, self.approvals = agent, approvals
        self.inp = inp or sys.stdin.buffer
        self.out = out or sys.stdout.buffer
        self.log = log or sys.stderr
        self.version = PROTOCOL_VERSIONS[0]
        self.client_caps = {}
        self.pending = []          # messages that arrived while we waited for an elicitation answer
        self._next_id = 0
        self._key = secrets.token_bytes(32)   # binds 2026-07-28 approvals to exact arguments (this process only)

    # ---------- transport ----------
    def send(self, msg):
        self.out.write(json.dumps(msg, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n')
        self.out.flush()

    def read(self):
        while True:
            line = self.inp.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line.decode('utf-8') if isinstance(line, bytes) else line)
            except ValueError:
                self.send({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse error'}})

    def serve(self):
        while True:
            msg = self.pending.pop(0) if self.pending else self.read()
            if msg is None:
                return 0
            for m in (msg if isinstance(msg, list) else [msg]):
                reply = self.handle(m)
                if reply is not None:
                    self.send(reply)

    # ---------- protocol ----------
    def handle(self, m):
        if not isinstance(m, dict):
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'invalid request'}}
        method, mid = m.get('method'), m.get('id')
        if method is None:
            return None                      # a response to something we did not ask: ignore
        if mid is None:
            return None                      # notifications (initialized, cancelled, ...) need no answer
        p = m.get('params') or {}
        meta = p.get('_meta') or {}
        modern = meta.get(META_VERSION) in MODERN_VERSIONS    # 2026-07-28: every request names its version; no handshake
        try:
            if method == 'server/discover':
                return self.ok(mid, {'resultType': 'complete', 'supportedVersions': list(MODERN_VERSIONS + PROTOCOL_VERSIONS),
                                     'capabilities': {'tools': {'listChanged': False}}, 'instructions': INSTRUCTIONS,
                                     'cacheScope': 'public', 'ttlMs': 3600000,
                                     '_meta': {'io.modelcontextprotocol/serverInfo': {'name': 'valun', 'title': 'Valun', 'version': __version__}}})
            if method == 'initialize':
                return self.ok(mid, self.initialize(p))
            if method == 'ping':
                return self.ok(mid, {})
            if method == 'tools/list':
                r = {'tools': tool_list(self.approvals)}
                if modern:
                    r.update({'resultType': 'complete', 'cacheScope': 'private', 'ttlMs': 3600000})
                return self.ok(mid, r)
            if method == 'tools/call':
                if modern:
                    return self.ok(mid, self.call_modern(p, meta))
                return self.ok(mid, self.call(p.get('name'), p.get('arguments') or {}))
            if method in ('resources/list', 'prompts/list'):
                r = {method.split('/')[0]: []}
                if modern:
                    r.update({'resultType': 'complete', 'cacheScope': 'public', 'ttlMs': 3600000})
                return self.ok(mid, r)
            return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32601, 'message': f'method not found: {method}'}}
        except Exception as e:  # noqa: BLE001 - a bad request must not kill the server
            return {'jsonrpc': '2.0', 'id': mid, 'error': {'code': -32603, 'message': f'{type(e).__name__}: {e}'}}

    # ---------- 2026-07-28: approvals as a multi-round-trip result ----------
    def _state(self, name, args):
        """Binds an approval to the exact tool and arguments: a retry with anything else is asked again."""
        body = json.dumps([name, args], sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        return hmac.new(self._key, body, hashlib.sha256).hexdigest()

    def call_modern(self, p, meta):
        name, args = p.get('name'), p.get('arguments') or {}
        if name not in self.agent.handlers:
            raise ValueError(f'unknown tool: {name}')
        caps = meta.get('io.modelcontextprotocol/clientCapabilities') or {}
        if self.approvals == 'ask' and self.agent.is_commitment(name, args):
            if 'elicitation' not in caps:
                return self.result(dict(APPROVAL_UNAVAILABLE), error=True, modern=True)
            state = self._state(name, args)
            answer = (p.get('inputResponses') or {}).get('approval')
            if answer is None or not hmac.compare_digest(str(p.get('requestState') or ''), state):
                text = self.agent.describe_commitment(name, args)
                return {'resultType': 'input_required', 'requestState': state, 'inputRequests': {'approval': {
                    'method': 'elicitation/create', 'params': {'mode': 'form', 'message': text + '\n\nApprove this commitment?',
                                                               'requestedSchema': APPROVAL_SCHEMA}}}}
            if not (answer.get('action') == 'accept' and (answer.get('content') or {}).get('approve') is True):
                return self.result({'error': 'owner_declined', 'owner_answer': answer.get('action') or 'unknown',
                                    'message': 'your owner did not approve this commitment; nothing was signed'}, error=True, modern=True)
        try:
            return self.result(self.agent.call(name, args), modern=True)
        except Exception as e:  # noqa: BLE001
            return self.result(error_payload(e, self.agent.setup_hint), error=True, modern=True)

    @staticmethod
    def ok(mid, result):
        return {'jsonrpc': '2.0', 'id': mid, 'result': result}

    def initialize(self, p):
        asked = p.get('protocolVersion')
        self.version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        self.client_caps = p.get('capabilities') or {}
        return {'protocolVersion': self.version, 'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': {'name': 'valun', 'title': 'Valun', 'version': __version__}, 'instructions': INSTRUCTIONS}

    def call(self, name, args):
        if name not in self.agent.handlers:
            raise ValueError(f'unknown tool: {name}')
        if self.approvals == 'ask' and self.agent.is_commitment(name, args):
            refusal = self.ask_owner(name, args)
            if refusal:
                return self.result(refusal, error=True)
        try:
            return self.result(self.agent.call(name, args))
        except Exception as e:  # noqa: BLE001
            return self.result(error_payload(e, self.agent.setup_hint), error=True)

    def result(self, payload, error=False, modern=False):
        r = {'content': [{'type': 'text', 'text': json.dumps(payload, ensure_ascii=False, default=str)}], 'isError': error}
        if modern or self.version >= STRUCTURED_FROM:
            r['structuredContent'] = payload
        if modern:
            r['resultType'] = 'complete'
        return r

    # ---------- approvals (2025-11-25 and earlier: a server-to-client request) ----------
    def ask_owner(self, name, args):
        """None if the owner approved; otherwise a refusal payload. Uses MCP elicitation (client asks the person)."""
        if 'elicitation' not in self.client_caps:
            return dict(APPROVAL_UNAVAILABLE)
        self._next_id += 1
        rid = f'valun-approval-{self._next_id}'
        text = self.agent.describe_commitment(name, args)
        mode = {'mode': 'form'} if self.version >= '2025-11-25' else {}   # form mode: the client sees and shows the text
        self.send({'jsonrpc': '2.0', 'id': rid, 'method': 'elicitation/create', 'params': {**mode,
            'message': text + '\n\nApprove this commitment?', 'requestedSchema': APPROVAL_SCHEMA}})
        while True:
            m = self.read()
            if m is None:
                return {'error': 'owner_declined', 'message': 'the app closed before the owner answered; nothing was signed'}
            if isinstance(m, dict) and m.get('id') == rid and 'method' not in m:
                res = m.get('result') or {}
                if res.get('action') == 'accept' and (res.get('content') or {}).get('approve') is True:
                    return None
                return {'error': 'owner_declined', 'message': 'your owner did not approve this commitment; nothing was signed',
                        'owner_answer': res.get('action') or ('error' if 'error' in m else 'unknown')}
            self.pending.append(m)


def run(store, approvals='ask', server=None, check_link_hosts=True):
    agent = ValunAgent(store, approvals=APPROVAL_TEXT.get(approvals, ''), check_link_hosts=check_link_hosts,
                       setup_hint='run `valun join` in a terminal', server=server)
    return McpServer(agent, approvals).serve()
