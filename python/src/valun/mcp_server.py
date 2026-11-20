"""Valun as a local MCP server (stdio), for any MCP client: Claude Desktop, Claude Code, Cursor, VS Code, Hermes,
and others. Standard library only.

The participant's key and agent token stay in the local profile file; the server process signs locally and talks to
the Valun network over HTTPS. Nothing secret is ever written to stdout or stderr.

Approvals (the profile's `approvals` setting, chosen at `valun join`):
  ask            before signing a commitment, ask the person through the MCP client (elicitation), with the text and
                 the bound arguments the core prepares from one read of what would be signed. If the client cannot
                 show such a prompt, or that read fails, the commitment is refused (fail closed) with an explanation.
                 While a prompt waits, the read-only tools still answer; a prompt the app cancels, or nobody answers
                 within 10 minutes, signs nothing.
  client-prompt  rely on the MCP client's own per-tool confirmation (commitment tools are annotated as such): whatever
                 the client lets run is signed at once.
  console        sign at once, asking nobody; the Valun server then holds for the owner, in the web owner console, the
                 agent's offers, counter-offers, acceptances and guarantee offers (approve_above 0) and the IOU or
                 payment by transfer it signs when it accepts a delivery (review_deliveries on). It never holds an
                 honor of a guarantee call, a guarantee's acceptance, call or release, a delivery, decline, withdrawal or
                 dispute, the agent loosening or clearing a limit it recorded (valun_set_limits), or a consent.
  none           act within the owner's limits without asking.
The Valun server enforces the owner's mandate in every mode, and holds what the mandate holds (valun_status says what).

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
from .agent import CONSOLE_APPROVALS, ValunAgent, error_payload, LIMIT_TOOLS, READ_ONLY_TOOLS, SIGNING_TOOLS

PROTOCOL_VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05')   # initialize handshake
MODERN_VERSIONS = ('2026-07-28',)                                                 # per-request _meta, server/discover
META_VERSION = 'io.modelcontextprotocol/protocolVersion'
APPROVAL_SCHEMA = {'type': 'object', 'properties': {
    'approve': {'type': 'boolean', 'title': 'Approve', 'description': 'Sign this commitment on my behalf'}}, 'required': ['approve']}
def approval_unavailable(command='valun'):
    """The answer to a commitment where this app cannot ask the owner. `command`: what the owner runs in a terminal for
    this profile (`valun --profile NAME mcp` passes `valun --profile NAME`, or its uvx form under uvx: fix inbox #88).
    Each command it names runs as written (console needs the owner token file), client-prompt says what it relies on,
    and the mode takes effect once this server restarts: it reads the mode when it starts (the onboarding review). A
    profile that has not joined yet gets not_joined() instead: no owner token exists before a join."""
    return {
        'error': 'approval_unavailable',
        'message': ('Not signed. This profile asks the owner before every commitment, but this app cannot show approval prompts '
                    '(it does not support MCP elicitation).'),
        'what_this_means': ('Nothing was signed. Your owner can choose another approval mode in a terminal, then '
                            "restart this app's Valun server: "
                            f'`{command} config approvals console --owner-token-file FILE` (you then sign at once, and '
                            'your offers, acceptances and guarantee offers, and the note or payment at each delivery, wait '
                            'for them in the owner console; FILE: the file holding their owner token), '
                            f'`{command} config approvals client-prompt` (only if this app confirms each tool call '
                            'itself, as Claude Code is designed to (not yet tested with Valun): an app that runs '
                            'tools without asking asks nobody), or '
                            f"`{command} config approvals none` (you act on your own within your owner's limits).")}


APPROVAL_UNAVAILABLE = approval_unavailable()


def approval_cancelled(command='valun', server=None, message=None):
    """The answer to a commitment whose approval prompt was cancelled or dismissed (MCP elicitation's action cancel), that
    the app could not show or answered by itself (headless Claude Code cancels it; an error answer), or that the app
    closed before anyone answered: nothing was signed, and it is not the owner's refusal (the newcomer tests and the
    Claude Code host test, 2026-11-17: 0.7.1 said "your owner did not approve"). `command`: what the owner runs in a
    terminal for this profile; `server`: its server, for the owner console's address."""
    console = f' ({str(server).rstrip("/")}/pilot#owner)' if server else ''
    return {'error': 'approval_cancelled',
            'message': message or ('the approval prompt was cancelled or dismissed, or never shown to your owner: nothing '
                                   'was signed'),
            'what_this_means': ("Nothing was signed, and this is not your owner's refusal: nobody approved or declined it. "
                                'Tell your owner, and ask whether they saw the prompt. If this app cannot show approval '
                                'prompts to a person (it runs headless, or answers them by itself), your owner can hold '
                                f'what you sign in the owner console{console} instead (your offers, acceptances and '
                                'guarantee offers, and the note or payment at each delivery): '
                                f'`{command} config approvals console --owner-token-file FILE` (FILE: the file holding '
                                "their owner token), then restart this app's Valun server.")}


def not_joined(agent):
    """The answer to a commitment of a profile that has not joined yet (no participant, agent key or token):
    not_connected with the agent's setup hint, as valun_status answers it; None for a joined profile. The adapters
    (this server, `valun call`) give it before they look at the approval mode: approval_unavailable's commands cannot
    work before a join (the onboarding review). Local: nothing is read."""
    try:
        agent.client()
    except vc.ValunError as e:
        if e.code == 'not_connected':
            return error_payload(e, agent.setup_hint)
    except Exception:  # noqa: BLE001 - not known here: the call goes on as before, and says why
        pass
    return None


STRUCTURED_FROM = '2025-06-18'          # structuredContent and elicitation exist from this revision on
TITLES = {'valun_status': 'Valun: status and instructions', 'valun_directory': 'Valun: find counterparties',
          'valun_inbox': 'Valun: what needs action', 'valun_deal': 'Valun: deal detail (verified)',
          'valun_propose': 'Valun: sign a new offer', 'valun_respond': 'Valun: accept, counter, decline or withdraw',
          'valun_deliver': 'Valun: deliver agreed work', 'valun_review_delivery': 'Valun: accept (issue a note) or dispute',
          'valun_set_limits': "Valun: record the owner's goals and limits",
          'valun_guarantees': 'Valun: guarantees you are part of', 'valun_offer_guarantee': "Valun: guarantee another agent's notes",
          'valun_respond_guarantee': 'Valun: accept, decline, release, withdraw or honor a guarantee',
          'valun_call_guarantee': 'Valun: call a guarantee you hold',
          'valun_check_payer': "Valun: check a payer's budget card"}
COMMITS = SIGNING_TOOLS     # from the core's classification: every tool that can sign a commitment (fail closed)
# client-prompt mode: the tools this app is asked to confirm. valun_set_limits too: a call that loosens a recorded cap is a
# commitment for the core (agent.is_commitment), and `valun call` asks for it (audit AI-4).
CLIENT_PROMPTED = COMMITS + LIMIT_TOOLS
APPROVAL_STATE_TTL_S = 600  # 2026-07-28: an approval's requestState is accepted once, within 10 minutes (audit AI-2)
# 2025-11-25 and earlier (fix inbox #149): how long a tools/call waits for the answer to its approval form before it gives
# up, as long as a 2026-07-28 approval stays valid; and the requests answered at once while it waits (ask_owner).
APPROVAL_WAIT_S = APPROVAL_STATE_TTL_S
ANSWERED_WHILE_ASKING = ('ping', 'tools/list', 'resources/list', 'prompts/list')
ANSWERED = object()         # call()'s result for a tools/call that ask_owner's timer answered already: nothing to send
INSTRUCTIONS = ('Valun is an experimental network where agents, each holding its own key, make service-for-credit deals '
                "paid with notes (signed promises to pay). Most agents listed so far are the operator's test agents (house-*, sandbox-*, lab-*) or the "
                "team's own. Call valun_status first in every session and follow your owner's recorded goals and "
                'limits; record new instructions with valun_set_limits. Use valun_directory to find counterparties, '
                'valun_deal to read exact terms before answering, and base word/link counts on the measurements it returns. '
                'Before you take a note from an agent you do not know, run valun_check_payer. '
                'Accepting a delivery issues a note: an outstanding promise to pay, not a payment. PC have no monetary value. '
                'Accepting a delivery pays: with your own note, or with pay_with=<issuer> to pass on a note you hold. '
                "Your Valun client signs net-neutral set-offs and, within your owner's policy, consents about the notes you "
                'issued and payments to you; never ask your owner about those.')
# On the testnet network (0.5) the same instructions say what its amounts are.
INSTRUCTIONS_TESTNET = INSTRUCTIONS.replace(
    'PC have no monetary value. ', 'Amounts are nanoERG of tERG, Ergo testnet coins with no monetary value; a holder can '
    'redeem a note on Ergo testnet only against a tERG reserve locked under the key that signed it, if one was posted. ')
assert INSTRUCTIONS_TESTNET != INSTRUCTIONS
STORE_LOCK = threading.RLock()      # every agent call in this process holds it (the tools, and the consent loop)
CONSENT_LOOP_S = 60                 # the consent loop's period (seconds), plus up to CONSENT_LOOP_JITTER_S
CONSENT_LOOP_JITTER_S = 10
# Where approvals happen, by the profile's mode: valun_status's approvals sentence (the agent's `approvals`, followed by
# what the server holds by the owner mandate: agent.held_for_owner) and doctor's. Each says what happens, verified (the
# approval semantics of 2026-11-17): what ask asks for (agent.is_commitment), that client-prompt signs whatever the app
# lets run, and what console holds and never holds.
APPROVAL_TEXT = {
    'ask': ('Before you sign a commitment, your owner is asked through this app and sees exactly what you would sign: an '
            'offer, counter-offer or acceptance; accepting a delivery (with your own note, or paying with a note you '
            'hold); a guarantee offer; honoring or releasing a guarantee; or loosening a limit you recorded. If they '
            'decline, nothing is signed.'),
    'client-prompt': ("Your app's own confirmation of each Valun tool that signs is the only approval here: whatever it "
                      'lets run is signed at once, and an app that runs tools without asking (or a tool your owner '
                      'allowed permanently) asks nobody.'),
    'console': CONSOLE_APPROVALS,
    'none': 'You act on your own within your owner\'s limits; nobody is asked before you sign.',
}
# valun_status's approvals text in ask mode when the app declared no approval forms (MCP elicitation) at initialize.
ASK_WITHOUT_FORMS = ('Your owner chose to be asked in this app before each commitment, but this app declared no approval '
                     'forms (MCP elicitation), so every commitment you try is refused (approval_unavailable) and nothing '
                     'is signed. Reading, declining, delivering and disputing work. Tell your owner: in a terminal, '
                     '`{command} config approvals console --owner-token-file FILE` lets you sign at once and holds your '
                     'offers, acceptances and guarantee offers, and the note or payment at each delivery, for them in the '
                     "owner console instead (FILE: the file holding their owner token), then restart this app's Valun "
                     'server.')


def tool_list(approvals='ask', network=None):
    """Tool definitions, in the words of the profile's network (schemas.for_network). destructiveHint is always explicit
    (its default is true). In client-prompt mode the signing tools and valun_set_limits (which can loosen the owner's
    recorded limits) carry Claude Code's requiresUserInteraction flag, which makes it ask before every such call, and
    destructiveHint."""
    out = []
    for t in schemas.for_network(network):
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


def _wait_words(s):
    """A wait in seconds, in words: '10 minutes', '1 minute', else '0.5 seconds'."""
    if s >= 60 and s % 60 == 0:
        n = int(s // 60)
        return f"{n} minute{'' if n == 1 else 's'}"
    return f'{s:g} seconds'


class McpServer:
    approval_wait_s = APPROVAL_WAIT_S   # ask_owner's limit (seconds); a test may shorten it

    def __init__(self, agent, approvals='ask', inp=None, out=None, log=None, command='valun'):
        self.agent, self.approvals, self.command = agent, approvals, command
        self.approval_unavailable = approval_unavailable(command)     # its command names this profile (fix inbox #88)
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
        self._send_lock = threading.Lock()    # ask_owner's timer may answer a call from a thread of its own

    # ---------- transport ----------
    def send(self, msg):
        data = json.dumps(msg, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
        with self._send_lock:
            self.out.write(data)
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
                                     'capabilities': {'tools': {'listChanged': False}}, 'instructions': self.instructions(),
                                     'cacheScope': 'public', 'ttlMs': 3600000,
                                     '_meta': {'io.modelcontextprotocol/serverInfo': {'name': 'valun', 'title': 'Valun', 'version': __version__}}})
            if method == 'initialize':
                return self.ok(mid, self.initialize(p))
            if method == 'ping':
                return self.ok(mid, {})
            if method == 'tools/list':
                store = getattr(self.agent, 'store', None)
                r = {'tools': tool_list(self.approvals, vc.profile_network(getattr(store, 'state', None)))}
                if modern:
                    r.update({'resultType': 'complete', 'cacheScope': 'private', 'ttlMs': 3600000})
                return self.ok(mid, r)
            if method == 'tools/call':
                if modern:
                    return self.ok(mid, self.call_modern(p, meta))
                r = self.call(p.get('name'), p.get('arguments') or {}, mid)
                return None if r is ANSWERED else self.ok(mid, r)
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
            unjoined = self._unjoined()
            if unjoined:
                return self.result(unjoined, error=True, modern=True)
            if 'elicitation' not in caps:
                return self.result(dict(self.approval_unavailable), error=True, modern=True)
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
                refusal = self.refusal(answer.get('action'), answer.get('content'))
                if refusal:
                    return self.result(refusal, error=True, modern=True)
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

    def _unjoined(self):
        with STORE_LOCK:
            return not_joined(self.agent)

    @staticmethod
    def ok(mid, result):
        return {'jsonrpc': '2.0', 'id': mid, 'result': result}

    def instructions(self):
        """The instructions for this profile's network (client.profile_network): the testnet's say what its amounts are,
        also before the profile joins (fix inbox #15: the Claude Code plugin starts this server before the join); the
        pilot's only for a profile of the pilot."""
        state = getattr(getattr(self.agent, 'store', None), 'state', None)
        return INSTRUCTIONS if vc.profile_network(state) == vc.NETWORK else INSTRUCTIONS_TESTNET

    def initialize(self, p):
        asked = p.get('protocolVersion')
        self.version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        self.client_caps = p.get('capabilities') or {}
        if not isinstance(self.client_caps, dict):
            self.client_caps = {}
        if self.approvals == 'ask' and 'elicitation' not in self.client_caps and hasattr(self.agent, 'approvals'):
            # valun_status tells the agent where approvals happen: in an app that declared no approval forms, not "your
            # owner is asked through this app" (the newcomer tests: every commitment then failed approval_unavailable).
            self.agent.approvals = ASK_WITHOUT_FORMS.format(command=self.command)
        return {'protocolVersion': self.version, 'capabilities': {'tools': {'listChanged': False}},
                'serverInfo': {'name': 'valun', 'title': 'Valun', 'version': __version__}, 'instructions': self.instructions()}

    def call(self, name, args, call_id=None):
        """One tools/call (2025-11-25 and earlier); call_id: its JSON-RPC id, for ask_owner. ANSWERED when the call was
        answered while it waited (ask_owner's timer)."""
        if name not in self.agent.handlers:
            raise ValueError(f'unknown tool: {name}')
        if self.approvals == 'ask' and self._commits(name, args):
            unjoined = self._unjoined()
            if unjoined:
                return self.result(unjoined, error=True)
            if 'elicitation' not in self.client_caps:
                return self.result(dict(self.approval_unavailable), error=True)
            with STORE_LOCK:
                prepared, refusal = self.agent.prepare_or_refusal(name, args)   # approval and signature cover the same terms
            if refusal:
                return self.result(refusal, error=True)
            args = prepared['args']
            if prepared['text'] is not None:    # None: the read prepare() made shows this call commits nothing
                refusal = self.ask_owner(name, args, prepared['text'], call_id)
                if refusal is ANSWERED:
                    return ANSWERED
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
    def ask_owner(self, name, args, text, call_id=None):
        """None if the owner approved; otherwise a refusal payload (or ANSWERED, below). Uses MCP elicitation (client asks
        the person) with `text`: the approval text prepare() built together with `args`, the exact arguments the call then
        signs with. There is no default: asking with a text prepared here could approve a snapshot while the caller signs
        other, unpinned arguments, so a missing or empty text is refused (nothing is asked, nothing is signed).

        While it waits for the answer (fix inbox #149, the first-tester readiness assessment of 2026-11-18: 0.7.1 queued
        every other message until the form's answer came, so one form left open froze every Valun tool until the app
        restarted, and the app's cancellation was ignored); call_id is the JSON-RPC id of the tools/call that asks:
        - ping, the lists (ANSWERED_WHILE_ASKING) and the read-only tools are answered at once; any other request waits
          its turn, as before, and is dropped (neither run nor answered, as MCP says) if the app cancels it meanwhile;
        - the app's notifications/cancelled for this call ends the wait: approval_cancelled, nothing signed;
        - with no answer for approval_wait_s (APPROVAL_WAIT_S, 10 minutes) it gives up: approval_cancelled, nothing
          signed. A timer answers the call then, since the app may send nothing more (call() then answers nothing:
          ANSWERED); without a call_id the refusal is returned once the next message comes.
        In both cases the form is withdrawn (notifications/cancelled for its request), and an answer to it that comes
        later is ignored."""
        if 'elicitation' not in self.client_caps:
            return dict(self.approval_unavailable)
        if not isinstance(text, str) or not text:
            return error_payload(vc.ValunError('approval_unbound', 'could not read what you would sign; nothing was signed'),
                                 self.agent.setup_hint)
        self._next_id += 1
        rid = f'valun-approval-{self._next_id}'
        mode = {'mode': 'form'} if self.version >= '2025-11-25' else {}   # form mode: the client sees and shows the text
        self.send({'jsonrpc': '2.0', 'id': rid, 'method': 'elicitation/create', 'params': {**mode,
            'message': text + '\n\nApprove this commitment?', 'requestedSchema': APPROVAL_SCHEMA}})
        late = dict(self.cancelled(f'nobody answered the approval prompt within {_wait_words(self.approval_wait_s)}, so it '
                                   'was withdrawn: nothing was signed'), owner_answer='none')
        ended, lock = [None], threading.Lock()      # who ended the wait: 'here' (this loop) or 'timer'

        def give_up():
            with lock:
                if ended[0] is not None:
                    return
                ended[0] = 'timer'
            self.cancel_request(rid, f'no answer within {_wait_words(self.approval_wait_s)}')
            if call_id is not None:
                self.send(self.ok(call_id, self.result(late, error=True)))
        timer = threading.Timer(self.approval_wait_s, give_up)
        timer.daemon = True
        timer.start()
        try:
            while True:
                m = self.read()
                answer = isinstance(m, dict) and m.get('id') == rid and 'method' not in m
                cancels = self._cancelled_id(m)
                ours = call_id is not None and cancels is not None and cancels == call_id
                with lock:
                    if ended[0] is None and (m is None or answer or ours):
                        ended[0] = 'here'
                    gave_up = ended[0] == 'timer'
                if cancels is not None and not ours:    # a request that waits its turn, cancelled: dropped
                    self.pending = [q for q in self.pending
                                    if not (isinstance(q, dict) and 'method' in q and q.get('id') == cancels)]
                elif gave_up:
                    if m is not None and not (answer or ours):
                        self.pending.append(m)          # its turn comes next; a late answer, or the cancel, is dropped
                elif m is None:
                    return dict(self.cancelled('the app closed before anyone answered the approval prompt: nothing was '
                                               'signed'), owner_answer='none')
                elif answer:
                    res = m.get('result') if isinstance(m.get('result'), dict) else {}
                    return self.refusal(res.get('action') if 'error' not in m else 'error', res.get('content'))
                elif ours:
                    self.cancel_request(rid, 'the call was cancelled')
                    return dict(self.cancelled('this app cancelled the call before anyone answered its approval prompt: '
                                               'nothing was signed'), owner_answer='none')
                elif self._answered_now(m):
                    self.send(self.handle(m))
                else:
                    self.pending.append(m)
                if gave_up:
                    return ANSWERED if call_id is not None else late
        finally:
            timer.cancel()
            timer.join()            # never left writing to stdout once the wait is over

    def cancel_request(self, rid, reason):
        """Tell the app that this server no longer asks its request `rid` (MCP's notifications/cancelled, for a request
        sent in this direction): an approval form it may close. An answer to it that still comes is ignored."""
        self.send({'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': rid, 'reason': reason}})

    @staticmethod
    def _cancelled_id(m):
        """The request id a notifications/cancelled names; None for any other message."""
        if isinstance(m, dict) and m.get('method') == 'notifications/cancelled' and m.get('id') is None:
            p = m.get('params')
            return p.get('requestId') if isinstance(p, dict) else None
        return None

    @staticmethod
    def _answered_now(m):
        """Is `m` a request ask_owner answers while it waits: ping, the lists, or a read-only tool's call? Each signs
        nothing (the read-only tools are never commitments: agent.NOT_COMMITMENT_TOOLS), so none asks again."""
        if not isinstance(m, dict) or m.get('id') is None:
            return False
        p = m.get('params')
        return m.get('method') in ANSWERED_WHILE_ASKING or (
            m.get('method') == 'tools/call' and isinstance(p, dict) and p.get('name') in READ_ONLY_TOOLS)

    def cancelled(self, message=None):
        store = getattr(self.agent, 'store', None)
        state = getattr(store, 'state', None)
        server = getattr(self.agent, 'server', None) or (state.get('server') if isinstance(state, dict) else None)
        return approval_cancelled(self.command, server, message)

    def refusal(self, action, content):
        """None when the owner approved (action accept with approve true); otherwise what the call answers: the owner's
        refusal (owner_declined: action decline, or accept without approve), or a prompt that was cancelled, dismissed,
        never shown or answered with an error (approval_cancelled: not a refusal). owner_answer: the action."""
        if action == 'accept' and isinstance(content, dict) and content.get('approve') is True:
            return None
        answer = action if isinstance(action, str) and action in ('accept', 'decline', 'cancel', 'error') else 'unknown'
        if answer in ('accept', 'decline'):
            return {'error': 'owner_declined', 'message': 'your owner did not approve this commitment; nothing was signed',
                    'owner_answer': answer}
        return dict(self.cancelled(), owner_answer=answer)


SETUP_HINT = 'run `valun join` in a terminal'


def run(store, approvals='ask', server=None, check_link_hosts=True, consent_loop_s=CONSENT_LOOP_S,
        consent_loop_jitter_s=CONSENT_LOOP_JITTER_S, setup_hint=None, brief_status=False, command='valun',
        rejoin_hint=None):
    """Serve MCP over stdio for this profile's store. setup_hint (None: SETUP_HINT) is what the tools tell the agent its
    owner must do while the profile is not joined; `valun --profile NAME mcp` passes one that names the profile, and
    `command`, what its owner runs in a terminal for it (approval_unavailable), and for a profile of the retired pilot
    network rejoin_hint, how its owner goes on (network_retired; None: the agent's default)."""
    agent = ValunAgent(store, approvals=APPROVAL_TEXT.get(approvals, ''), check_link_hosts=check_link_hosts,
                       setup_hint=setup_hint or SETUP_HINT, server=server, brief_status=brief_status,
                       rejoin_hint=rejoin_hint, console_command=f'{command} console' if command else None)
    loop = None
    if (getattr(store, 'state', None) or {}).get('consent_loop') == 'on':
        loop = ConsentLoop(agent, consent_loop_s, consent_loop_jitter_s)
        loop.start()
    try:
        return McpServer(agent, approvals, command=command).serve()
    finally:
        if loop is not None:
            loop.stop()
