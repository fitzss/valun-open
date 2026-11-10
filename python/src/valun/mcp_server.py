"""Valun as a local MCP server (stdio), for any MCP client: Claude Desktop, Claude Code, Cursor, VS Code, Hermes,
and others. Standard library only.

The participant's key and agent token stay in the local profile file; the server process signs locally and talks to
the Valun network over HTTPS. Nothing secret is ever written to stdout or stderr.

Approvals (the profile's `approvals` setting, chosen at `valun join`):
  ask            before signing a commitment, ask the person through the MCP client (elicitation), with the text and
                 the bound arguments the core prepares from one read of what would be signed. If the client cannot
                 show such a prompt, or that read fails, the commitment is refused (fail closed) with an explanation.
  client-prompt  rely on the MCP client's own per-tool confirmation (commitment tools are annotated as such).
  console        sign, but the Valun server holds every commitment for the owner in the web owner console (the owner
                 mandate has approve_above 0 and review_deliveries on).
  none           act within the owner's limits without asking.
The Valun server enforces the owner's mandate in every mode.

Consents (circulating credit): before every tool call that is not read-only the core signs the consents the owner's
policy allows (at most once a minute). With the profile's consent_loop 'on' (the default for sandbox joins), a
background thread also does so every CONSENT_LOOP_S seconds (with jitter) while the server offers circulation/1. Every
agent call, the loop's included, holds the process-wide STORE_LOCK; the loop never writes to stdout.
"""
import hashlib
import hmac
import json
import random
import secrets
import sys
import threading
import time

from . import __version__
from . import client as vc
from . import schemas
from .agent import ValunAgent, error_payload, LIMIT_TOOLS, READ_ONLY_TOOLS, SIGNING_TOOLS

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
COMMITS = SIGNING_TOOLS     # from the core's classification: every tool that can sign a commitment (fail closed)
# client-prompt mode: the tools this app is asked to confirm. valun_set_limits too: a call that loosens a recorded cap is a
# commitment for the core (agent.is_commitment), and `valun call` asks for it (audit AI-4).
CLIENT_PROMPTED = COMMITS + LIMIT_TOOLS
APPROVAL_STATE_TTL_S = 600  # 2026-07-28: an approval's requestState is accepted once, within 10 minutes (audit AI-2)
INSTRUCTIONS = ('Valun is an experimental network where agents make service-for-credit deals with other, independently '
                'controlled agents. Call valun_status first in every session and follow your owner\'s recorded goals and '
                'limits; record new instructions with valun_set_limits. Use valun_directory to find counterparties, '
                'valun_deal to read exact terms before answering, and base word/link counts on the measurements it returns. '
                'Accepting a delivery issues a credit note: an outstanding promise, not a payment. PC have no monetary value. '
                'Accepting a delivery pays: with your own credit note, or with pay_with=<issuer> to pass on a note you hold. '
                "Your Valun client signs net-neutral set-offs and, within your owner's policy, consents about your own debt "
                'and payments to you; never ask your owner about those.')
STORE_LOCK = threading.RLock()      # every agent call in this process holds it (the tools, and the consent loop)
CONSENT_LOOP_S = 60                 # the consent loop's period (seconds), plus up to CONSENT_LOOP_JITTER_S
CONSENT_LOOP_JITTER_S = 10
APPROVAL_TEXT = {
    'ask': 'Before you sign an offer, counter-offer, acceptance or credit note, your owner is asked through this app and '
           'sees exactly what you would sign; if they decline, nothing is signed.',
    'client-prompt': 'Your app asks your owner before each Valun tool that signs a commitment (if your owner has not '
                     'allowed it permanently).',
    'console': ('Every commitment you sign waits for your owner in the Valun owner console before it takes effect: offers, '
                'counter-offers and acceptances, and accepting a delivery (its credit note is issued only after your owner '
                'approves it).'),
    'none': 'You act on your own within your owner\'s limits; nobody is asked before you sign.',
}


def tool_list(approvals='ask'):
    """Tool definitions. destructiveHint is always explicit (its default is true). In client-prompt mode the signing
    tools and valun_set_limits (which can loosen the owner's recorded limits) carry Claude Code's
    requiresUserInteraction flag, which makes it ask before every such call, and destructiveHint."""
    out = []
    for t in schemas.ALL:
        ro = t['name'] in READ_ONLY_TOOLS
        prompted = approvals == 'client-prompt' and t['name'] in CLIENT_PROMPTED
        tool = {'name': t['name'], 'title': TITLES[t['name']], 'description': t['description'], 'inputSchema': t['parameters'],
                'annotations': {'title': TITLES[t['name']], 'readOnlyHint': ro,
                                'destructiveHint': t['name'] in COMMITS or prompted, 'idempotentHint': ro, 'openWorldHint': True}}
        if prompted:
            tool['_meta'] = {'anthropic/requiresUserInteraction': True}
        out.append(tool)
    return out


class ConsentLoop(threading.Thread):
    """The optional consent loop (design 6.6): while the profile's consent_loop is 'on', every `interval_s` seconds plus
    up to `jitter_s` of jitter it lets the core sign the consents the owner's policy allows (agent.consents_if_due(),
    which asks GET /info and does nothing more unless the server lists circulation/1, and runs at most once a minute
    whoever triggers it). Each run holds STORE_LOCK, so it never interleaves with a tool call of this process. It never
    writes to stdout (stdout carries JSON-RPC only) and never raises; a daemon thread, stopped by stop()."""

    def __init__(self, agent, interval_s=CONSENT_LOOP_S, jitter_s=CONSENT_LOOP_JITTER_S, lock=None):
        super().__init__(name='valun-consent-loop', daemon=True)
        self.agent, self.interval_s, self.jitter_s = agent, interval_s, jitter_s
        self.lock = lock or STORE_LOCK
        self.runs = 0
        self._halt = threading.Event()     # not _stop: threading.Thread has a method of that name

    def stop(self):
        self._halt.set()

    def enabled(self):
        """consent_loop 'on' in the profile as it is now on disk (the owner may change it while this process runs)."""
        store = getattr(self.agent, 'store', None)
        reload = getattr(store, 'reload', None)
        try:
            if callable(reload):
                reload()
            return (getattr(store, 'state', None) or {}).get('consent_loop') == 'on'
        except Exception:  # noqa: BLE001 - an unreadable profile: do nothing (the tools say why)
            return False

    def run_once(self):
        with self.lock:
            try:
                if self.enabled():
                    self.runs += 1
                    self.agent.consents_if_due()
            except Exception:  # noqa: BLE001 - a background run must never take the server down
                pass

    def run(self):
        while not self._halt.wait(self.interval_s + random.uniform(0, self.jitter_s)):
            self.run_once()


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
        self._spent = {}                      # nonce -> issue time of each 2026-07-28 approval state already used
        self._spent_lock = threading.Lock()

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
    def _mac(self, name, args, nonce, issued):
        body = json.dumps([name, args, nonce, issued], sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        return hmac.new(self._key, body, hashlib.sha256).hexdigest()

    def _state(self, name, args, now=None):
        """A fresh requestState for one approval: '<nonce>.<issued s>.<HMAC over the tool, its exact arguments, the nonce
        and the issue time>'. It binds the approval to exactly this call: a retry with anything else is asked again."""
        nonce, issued = secrets.token_hex(16), int(time.time() if now is None else now)
        return f'{nonce}.{issued}.{self._mac(name, args, nonce, issued)}'

    def _spend_state(self, given, name, args, now=None):
        """Accept a requestState once (audit AI-2): it must be one this process issued for exactly this tool and these
        arguments, at most APPROVAL_STATE_TTL_S old, and not used before. A resent approved call (a host retry or replay)
        is asked again instead of signing another commitment."""
        parts = given.split('.') if isinstance(given, str) else []
        if len(parts) != 3 or not parts[1].isdigit() or len(parts[0]) != 32:
            return False
        nonce, issued, mac = parts[0], int(parts[1]), parts[2]
        now = int(time.time() if now is None else now)
        if not hmac.compare_digest(mac, self._mac(name, args, nonce, issued)) or not (now - APPROVAL_STATE_TTL_S <= issued <= now + 5):
            return False
        with self._spent_lock:
            for k in [k for k, t in self._spent.items() if t < now - APPROVAL_STATE_TTL_S]:
                del self._spent[k]
            if nonce in self._spent:
                return False
            self._spent[nonce] = issued
        return True

    def call_modern(self, p, meta):
        name, args = p.get('name'), p.get('arguments') or {}
        if name not in self.agent.handlers:
            raise ValueError(f'unknown tool: {name}')
        caps = meta.get('io.modelcontextprotocol/clientCapabilities') or {}
        if self.approvals == 'ask' and self._commits(name, args):
            if 'elicitation' not in caps:
                return self.result(dict(APPROVAL_UNAVAILABLE), error=True, modern=True)
            with STORE_LOCK:
                prepared, refusal = self.agent.prepare_or_refusal(name, args)   # approval and signature cover the same terms
            if refusal:
                return self.result(refusal, error=True, modern=True)
            args, text = prepared['args'], prepared['text']
            if text is not None:                # None: the read prepare() made shows this call commits nothing
                answer = (p.get('inputResponses') or {}).get('approval')
                if not isinstance(answer, dict) or not self._spend_state(p.get('requestState'), name, args):
                    return {'resultType': 'input_required', 'requestState': self._state(name, args), 'inputRequests': {'approval': {
                        'method': 'elicitation/create', 'params': {'mode': 'form', 'message': text + '\n\nApprove this commitment?',
                                                                   'requestedSchema': APPROVAL_SCHEMA}}}}
                if not (answer.get('action') == 'accept' and (answer.get('content') or {}).get('approve') is True):
                    return self.result({'error': 'owner_declined', 'owner_answer': answer.get('action') or 'unknown',
                                        'message': 'your owner did not approve this commitment; nothing was signed'}, error=True, modern=True)
        try:
            return self.result(self._run(name, args), modern=True)
        except Exception as e:  # noqa: BLE001
            return self.result(error_payload(e, self.agent.setup_hint), error=True, modern=True)

    # ---------- agent calls: each holds STORE_LOCK (never while waiting for the owner's answer) ----------
    def _commits(self, name, args):
        with STORE_LOCK:
            return self.agent.is_commitment(name, args)

    def _run(self, name, args):
        with STORE_LOCK:
            return self.agent.call(name, args)

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
        if self.approvals == 'ask' and self._commits(name, args):
            if 'elicitation' not in self.client_caps:
                return self.result(dict(APPROVAL_UNAVAILABLE), error=True)
            with STORE_LOCK:
                prepared, refusal = self.agent.prepare_or_refusal(name, args)   # approval and signature cover the same terms
            if refusal:
                return self.result(refusal, error=True)
            args = prepared['args']
            if prepared['text'] is not None:    # None: the read prepare() made shows this call commits nothing
                refusal = self.ask_owner(name, args, prepared['text'])
                if refusal:
                    return self.result(refusal, error=True)
        try:
            return self.result(self._run(name, args))
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
    def ask_owner(self, name, args, text):
        """None if the owner approved; otherwise a refusal payload. Uses MCP elicitation (client asks the person) with
        `text`: the approval text prepare() built together with `args`, the exact arguments the call then signs with.
        There is no default: asking with a text prepared here could approve a snapshot while the caller signs other,
        unpinned arguments, so a missing or empty text is refused (nothing is asked, nothing is signed)."""
        if 'elicitation' not in self.client_caps:
            return dict(APPROVAL_UNAVAILABLE)
        if not isinstance(text, str) or not text:
            return error_payload(vc.ValunError('approval_unbound', 'could not read what you would sign; nothing was signed'),
                                 self.agent.setup_hint)
        self._next_id += 1
        rid = f'valun-approval-{self._next_id}'
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


SETUP_HINT = 'run `valun join` in a terminal'


def run(store, approvals='ask', server=None, check_link_hosts=True, consent_loop_s=CONSENT_LOOP_S,
        consent_loop_jitter_s=CONSENT_LOOP_JITTER_S, setup_hint=None):
    """Serve MCP over stdio for this profile's store. setup_hint (None: SETUP_HINT) is what the tools tell the agent its
    owner must do while the profile is not joined; `valun --profile NAME mcp` passes one that names the profile."""
    agent = ValunAgent(store, approvals=APPROVAL_TEXT.get(approvals, ''), check_link_hosts=check_link_hosts,
                       setup_hint=setup_hint or SETUP_HINT, server=server)
    loop = None
    if (getattr(store, 'state', None) or {}).get('consent_loop') == 'on':
        loop = ConsentLoop(agent, consent_loop_s, consent_loop_jitter_s)
        loop.start()
    try:
        return McpServer(agent, approvals).serve()
    finally:
        if loop is not None:
            loop.stop()
