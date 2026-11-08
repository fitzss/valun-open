"""The Valun agent tools, independent of any agent framework.

Every adapter (the MCP server, the `valun call` CLI, the Hermes plugin) exposes the same nine tools through this
module. An adapter supplies a store (where the participant's key, token and non-secret state live), a few settings,
and a sentence saying where approvals happen; this module does the protocol work: it builds and verifies what is
signed, measures deliveries against the agreed terms, and explains results in plain words.

Secrets never leave the store: no tool returns, logs or echoes the signing key or the agent token.
Ported from the Hermes plugin's tools.py (hermes-plugin-valun 0.2.0) with the Hermes-specific parts removed.

Approvals fail closed. is_commitment() treats every tool name it does not know as a commitment, and prepare() returns
the arguments to sign with and the owner's approval text from one snapshot of what would be signed. The text is built
only from values checked against what is signed (recomputed hashes, which the arguments then pin); when the snapshot
cannot be read or does not hold together it raises approval_unbound, and every adapter then refuses the call instead
of asking with a generic text.
"""
import json
import re
from datetime import datetime, timedelta, timezone

from . import client as vc
from . import measure
from . import sandbox
from . import schemas

SETTLEMENT_NOTE = ('Issuing a credit note creates an outstanding obligation (the payer owes the payee that many PC). '
                   'Nothing is settled in the Valun pilot: there is no redemption, reserve or clearing yet.')
NOT_SETTLED = ('A credit note is an outstanding promise to pay, not a payment: nothing is settled in the pilot. '
               'PC are synthetic units with no monetary value.')
HONEST_LABELS = {
    'what_basis_records': ('When a payer accepts a delivery, its agent signs a Basis note and the pilot Basis tracker '
                           'records it: the payer key, the payee key, the running total that payer owes that payee '
                           '(one cumulative total per key pair) and a timestamp. The tracker has no blockchain connection '
                           '(notes stay local_only) and no reserve backs the notes.'),
    'outstanding_promise': ('An issued credit note is an outstanding promise by the payer to pay that many PC. Nothing in '
                            'the pilot settles it: there is no redemption, reserve, clearing or netting. PC are synthetic '
                            'pilot units with no monetary value.'),
    'third_party': ('Supported: paying a third party with your OWN credit note; the third party may require that your '
                    'claims on the tracker cover it (min_payer_coverage_pct). Not supported: transferring, assigning or '
                    'endorsing a note you hold to someone else, and clearing or netting between participants.'),
}
REAL_VS_SIMULATED = {
    'real': "signatures by each participant's own key; Valun's acceptance and approval records; credit notes held by a "
            'real Basis tracker (read back and reconciled by Valun)',
    'simulated': 'PC (pilot credits) have no monetary value; the Basis tracker has no blockchain connection (notes are '
                 'local_only, never on-chain); settlement does not exist in the pilot',
    'not_proven': 'that delivered work is good (Valun records statements, it does not judge work); that any participant '
                  'will ever honour a credit note',
}
# valun_set_limits argument -> (server field, kind). Caps can only be lowered below the owner's mandate, floors raised.
LIMIT_FIELDS = {
    'max_per_deal_as_payer': ('max_issue_per_deal', 'cap'), 'max_total_owed': ('max_issue_outstanding', 'cap'),
    'max_per_deal_as_payee': ('max_accept_per_deal', 'cap'), 'max_claim_per_payer': ('max_accept_per_issuer', 'cap'),
    'min_price_as_payee': ('min_price_as_payee', 'floor'), 'min_payer_coverage_pct': ('min_payer_coverage_pct', 'floor'),
}
TOOL_NAMES = [t['name'] for t in schemas.ALL]
READ_ONLY_TOOLS = ('valun_status', 'valun_directory', 'valun_inbox', 'valun_deal')
# The classification every adapter takes from here (fail closed by name): these tools never commit the owner...
NOT_COMMITMENT_TOOLS = READ_ONLY_TOOLS + ('valun_deliver',)
# ...this one does only when it loosens a limit recorded before...
LIMIT_TOOLS = ('valun_set_limits',)
# ...and every other tool signs a commitment for some arguments (a new tool counts until it is classified above).
SIGNING_TOOLS = tuple(n for n in TOOL_NAMES if n not in NOT_COMMITMENT_TOOLS + LIMIT_TOOLS)
UNBOUND_MESSAGE = 'could not read what you would sign; nothing was signed'
GENERIC_TEXT = 'Valun: sign a commitment ({name}).'     # only for a tool this client does not know
QUOTE_MAX_CHARS = 2000      # per quoted field of an approval text (the server's own limit for service.description)
ROLE_WORDS = {'payer': 'payer', 'payee': 'payee (you do the work)'}
_PLAIN = re.compile(r'[A-Za-z0-9_.:@+-]{1,120}')
_DEAL_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')


def quoted(value):
    """Untrusted text (written by a counterparty, or by the agent from what it read) as ONE line of JSON. Newlines,
    control, bidi and all other non-ASCII characters are escaped, so it can never add, fake or reorder a line of an
    approval text."""
    return json.dumps(value, ensure_ascii=True, separators=(',', ':'))


def shown(value):
    """A server-supplied value for a computed line of an approval text: as is when it cannot carry layout (a whole
    number, or a short id, hash, handle or date), otherwise quoted as JSON."""
    if value is None:
        return 'none'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int) or (isinstance(value, str) and _PLAIN.fullmatch(value)):
        return str(value)
    return quoted(value)


def quote_line(label, fields):
    """The last line of an approval text: `label`, then `fields` (text a counterparty or the agent wrote) quoted as ONE
    JSON line. A text field longer than QUOTE_MAX_CHARS is cut to that many characters, and the label says so."""
    out, cut = {}, False
    for k, v in fields.items():
        if isinstance(v, str) and len(v) > QUOTE_MAX_CHARS:
            v, cut = v[:QUOTE_MAX_CHARS], True
        out[k] = v
    note = f'; fields over {QUOTE_MAX_CHARS} characters are cut to their first {QUOTE_MAX_CHARS}' if cut else ''
    return f'{label} (quoted exactly{note}): ' + quoted(out)


def owes(role, who, price):
    """What a binding deal means for this participant, in the role the signed terms give it."""
    return (f'after you accept their delivery you will owe {who} {price} PC (your credit note).' if role == 'payer'
            else f'you must deliver; {who} would then owe you {price} PC (their credit note).')


def limits_body(args):
    """Map valun_set_limits arguments to the server's /limits body."""
    body = {}
    for arg, (field, _kind) in LIMIT_FIELDS.items():
        if args.get(arg) is not None:
            body[field] = int(args[arg])
    for arg in args.get('clear') or []:
        if arg in LIMIT_FIELDS:
            body[LIMIT_FIELDS[arg][0]] = None
    if args.get('goals') is not None:
        body['notes'] = str(args['goals'])
    return body


def loosens(current, body):
    """True when a /limits body would loosen a limit the agent recorded before (a higher cap, a lower floor, or
    removing one). Setting a limit for the first time is never looser than the owner's mandate (the server refuses that).
    Fails closed: a field this client does not know, a kind of limit it does not know, or a value that is not a whole
    number counts as loosening. 'notes' (the owner's goals, as text) is not a limit."""
    kinds = dict(LIMIT_FIELDS.values())
    for field, new in body.items():
        if field == 'notes':
            continue
        kind = kinds.get(field)
        if kind not in ('cap', 'floor'):
            return True
        old = current.get(field)
        if old is None:
            continue
        if new is None or not (_whole(new) and _whole(old)) or (kind == 'cap' and new > old) or (kind == 'floor' and new < old):
            return True
    return False


def _whole(v):
    return isinstance(v, int) and not isinstance(v, bool)


def recently_active(last_seen, hours=24, joined_at=None):
    """Has this participant's agent made a call to Valun within the last `hours`? A participant that joined within that
    window counts as active even before its agent's first call (it is new, not idle)."""
    def within(iso):
        try:
            return datetime.now(timezone.utc) - datetime.fromisoformat(str(iso).replace('Z', '+00:00')) < timedelta(hours=hours)
        except (TypeError, ValueError):
            return False
    return within(last_seen) or within(joined_at)


def terms_text(d):
    """The agreed (or current) service text: where numeric requirements such as '300-500 words' are written."""
    t = ((d.get('current') or {}).get('terms') or {}).get('service') or {}
    return ' '.join(str(t.get(k) or '') for k in ('title', 'description', 'deliverable'))


def error_payload(e, setup_hint='run `valun join` (or `valun enroll`) in a terminal'):
    """A ValunError (or any exception) as a plain dict an agent can act on. Never includes secrets."""
    if isinstance(e, vc.ValunError):
        out = {'error': e.code, 'message': str(e)}
        for k in ('rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means'):
            if k in e.extra:
                out[k] = e.extra[k]
        if e.code == 'approval_unbound':
            out['what_this_means'] = ('Nothing was signed and your owner was not asked: your Valun client could not read and check '
                                      'exactly what this call would sign (the deal, offer or delivery could not be read, does not '
                                      'match its hash, or changed after you read it). Read the deal again with valun_deal and retry; '
                                      'if it keeps failing, tell your owner.')
        if e.code == 'tracker_mismatch':
            out['what_this_means'] = ('The Valun server now names a different Basis tracker or unit than the one this profile was '
                                      'set up with. Nothing was signed. Stop and tell your owner.')
        if e.code == 'bad_delivery_signature':
            out['what_this_means'] = ("The delivery is not signed by the payee's key, so it may not come from the payee. Nothing "
                                      'was signed. Do not accept it; tell your owner.')
        if e.code == 'records_unreadable':
            out['what_this_means'] = ('Your Valun client cannot read its own records, so it signs nothing until they are fixed. '
                                      'Nothing was signed. Tell your owner.')
        if e.code == 'already_paid':
            out['what_this_means'] = ('Your earlier credit note for this deal is (or may already be) on the tracker, so the deal '
                                      'counts as paid. Nothing was signed. Do not try to pay it again; tell your owner.')
        if e.code == 'mandate_exceeded':
            out['what_this_means'] = ("Your owner's mandate does not allow this. Nothing was recorded. Do not try to work around "
                                      'it; tell your owner if you think the limit should change.')
        if e.code == 'offer_not_authorized':
            out['what_this_means'] = ("The other side's owner no longer allows this offer (their mandate changed or is used up). "
                                      'Nothing was recorded. You may decline it or wait for a new offer.')
        if e.code in ('key_changed', 'payee_no_key'):
            out['what_this_means'] = ("A party's agent key was revoked or replaced by its owner. Offers that name the old key can "
                                      'no longer be agreed; agreed deals continue once the party has a new key.')
        if e.code in ('unauthorized', 'not_connected', 'not_configured'):
            out['what_this_means'] = f'This agent is not connected to Valun. Its owner must {setup_hint}.'
        if e.code == 'owner_declined':
            out['what_this_means'] = 'Your owner did not approve this commitment. Nothing was signed or sent.'
        return out
    return {'error': 'internal_error', 'message': f'{type(e).__name__}: {e}'}


class ValunAgent:
    """The nine Valun tools over one participant's store.

    store: a path to a private state file, or any object with .state, .secret(), .token(), .save(), .save_credentials().
    approvals: one sentence telling the model where commitments are approved (adapter-specific).
    check_link_hosts: look up link host names in DNS when measuring deliveries (no page is fetched).
    """

    def __init__(self, store, approvals='', check_link_hosts=True, setup_hint=None, server=None):
        self.store = store
        self.approvals = approvals
        self.check_link_hosts = check_link_hosts
        self.setup_hint = setup_hint or 'run `valun join` (or `valun enroll`) in a terminal'
        self.server = server
        self.handlers = {'valun_status': self.status, 'valun_directory': self.directory, 'valun_inbox': self.inbox,
                         'valun_deal': self.deal, 'valun_propose': self.propose, 'valun_respond': self.respond,
                         'valun_deliver': self.deliver, 'valun_review_delivery': self.review, 'valun_set_limits': self.set_limits}

    # ---------- plumbing ----------
    def client(self, require_connection=True):
        c = vc.Client(self.store, server=self.server)
        if require_connection and (not c.connected or not c.participant_id):
            raise vc.ValunError('not_connected', f'not enrolled: the owner must {self.setup_hint}')
        return c

    def call(self, name, args=None):
        """Run one tool. Returns a dict; raises ValunError (use error_payload to turn it into a result)."""
        if name not in self.handlers:
            raise vc.ValunError('unknown_tool', f'no Valun tool called {name!r}')
        return self.handlers[name](args or {})

    def call_safe(self, name, args=None):
        """Like call(), but never raises: errors come back as {'error': ...}."""
        try:
            return self.call(name, args)
        except Exception as e:  # noqa: BLE001 - adapters must always get a result
            return error_payload(e, self.setup_hint)

    def _resolve(self, c, who):
        who = (who or '').strip().lower()
        for p in c.directory():
            if p['id'] == who or p['handle'] == who:
                return p
        raise vc.ValunError('unknown_participant', f'no participant called {who!r}; use valun_directory')

    # ---------- approvals ----------
    def is_commitment(self, name, args):
        """Does this call sign something that commits the owner (or loosen a limit)? Adapters ask the owner first.
        Fails closed by name and by value: only these are not commitments: the read-only tools, valun_deliver,
        valun_respond with action exactly 'decline' or 'withdraw', valun_review_delivery with decision exactly 'dispute',
        and valun_set_limits calls that do not loosen a recorded limit. Every other call, including any tool name this
        client does not know and a misspelt "Accept", is a commitment."""
        a = args if isinstance(args, dict) else {}
        if name in LIMIT_TOOLS:
            try:
                me = self.client().me()
                return loosens(me.get('agent_limits') or {}, limits_body(args))
            except Exception:  # noqa: BLE001 - when in doubt, ask the owner
                return True
        return self._may_commit(name, a)

    @staticmethod
    def _may_commit(name, a):
        """The classification without any read: False only for calls that can never commit the owner."""
        if name in NOT_COMMITMENT_TOOLS:
            return False
        if name == 'valun_respond':
            return a.get('action') not in ('decline', 'withdraw')
        if name == 'valun_review_delivery':
            return a.get('decision') != 'dispute'
        return True

    def prepare(self, name, args):
        """Bind and describe a commitment from ONE snapshot of what it would sign. Returns {'args', 'text'}: the
        arguments to sign with and the owner's approval text. Adapters ask the owner with `text`, then call the tool with
        exactly `args`. text is None for a call that commits nothing (also a valun_set_limits call that this snapshot
        shows loosens nothing): it runs without asking.

        The text is built only from values checked against what is signed. An acceptance or counter-offer: the terms
        shown hash to the stated terms hash, are this deal's, name this participant as exactly one party and were
        offered by the other one, and the server's role and counterparty for the deal agree with them. A delivery
        acceptance: the same, and the agreement has that terms hash and the delivered text hashes to its sha256. The
        recomputed hashes are pinned in `args` (expected_terms_hash; for a delivery also expected_deliverable_sha256);
        the client reads the deal again when it signs and refuses anything else (stale_terms, stale_delivery). A new
        offer is pinned to the participant id the text shows. So the signature covers what the owner saw.

        Raises ValunError('approval_unbound') when what would be signed cannot be read or checked (any error, a missing
        or wrong hash, or a pin the agent passed that is not the snapshot's): the adapter must then refuse the call.
        A tool this client does not know gets a generic text; a known commitment never does."""
        a = dict(args) if isinstance(args, dict) else {}
        if name not in self.handlers:
            return {'args': a, 'text': GENERIC_TEXT.format(name=shown(name))}
        if not self._may_commit(name, a):
            return {'args': a, 'text': None}
        try:
            if args is not None and not isinstance(args, dict):
                raise vc.ValunError('bad_arguments', 'the arguments are not a JSON object')
            render = self._text_for(name, a)          # before any read: a misspelt action or decision has no text
            snap = self._snapshot(name, a)
            if name in LIMIT_TOOLS and not loosens(snap['me'].get('agent_limits') or {}, limits_body(a)):
                return {'args': a, 'text': None}      # this read shows nothing loosened: nothing to approve
            bound = self._bind_from(name, a, snap, strict=True)
            text = render(bound, snap)
        except Exception as e:  # noqa: BLE001 - nothing may be approved that could not be read and checked
            raise self._unbound(e) from None
        return {'args': bound, 'text': text}

    def prepare_or_refusal(self, name, args):
        """For adapters: (prepared, None), or (None, refusal). Ask the owner with prepared['text'], then sign with
        prepared['args']; when prepared['text'] is None the call commits nothing and runs without asking. The refusal is
        the result to return instead of asking when what would be signed cannot be read or checked: the owner is then
        never asked with a generic text, and nothing is signed (approval_unbound)."""
        try:
            prepared = self.prepare(name, args)
        except Exception:  # noqa: BLE001 - whatever went wrong, the answer is the same refusal
            prepared = None
        if isinstance(prepared, dict) and isinstance(prepared.get('args'), dict) and \
                (prepared.get('text') is None or (isinstance(prepared['text'], str) and prepared['text'])):
            return prepared, None
        return None, error_payload(vc.ValunError('approval_unbound', UNBOUND_MESSAGE), self.setup_hint)

    def bind(self, name, args):
        """prepare()'s pins alone, for adapters that ask with their own text (kept for compatibility): an acceptance or
        counter-offer is pinned to the recomputed hash of the terms shown, a delivery acceptance also to the recomputed
        hash of the delivered text, each checked as prepare() checks it. Pins the agent passed are kept (the client
        refuses to sign anything else). For a commitment it never returns the arguments unpinned: when the deal cannot be
        read or checked it raises ValunError('approval_unbound')."""
        a = dict(args) if isinstance(args, dict) else {}
        if not self._needs_pins(name, a):
            return a
        try:
            return self._bind_from(name, a, self._snapshot(name, a), strict=False)
        except Exception as e:  # noqa: BLE001
            raise self._unbound(e) from None

    def describe_commitment(self, name, args):
        """Text for an approval prompt: exactly what the agent is about to sign, and what it means (prepare() gives it
        together with the arguments it binds). Raises ValunError('approval_unbound') for a known commitment it cannot
        read and check: it never falls back to a generic text. None for a call that is not a commitment."""
        return self.prepare(name, args)['text']

    @staticmethod
    def _unbound(e):
        cause = e.code if isinstance(e, vc.ValunError) else type(e).__name__
        return vc.ValunError('approval_unbound', UNBOUND_MESSAGE, extra={'cause': cause})

    @staticmethod
    def _needs_pins(name, a):
        if name == 'valun_respond' and a.get('action') in ('accept', 'counter'):
            return not a.get('expected_terms_hash')
        if name == 'valun_review_delivery' and a.get('decision') == 'accept':
            return not (a.get('expected_deliverable_sha256') and a.get('expected_terms_hash'))
        return False

    def _snapshot(self, name, a):
        """The one read an approval is bound to and described from (checked: see prepare)."""
        c = self.client()
        if name == 'valun_propose':
            other = self._resolve(c, a.get('counterparty'))
            if not (isinstance(other, dict) and isinstance(other.get('id'), str) and other['id']):
                raise vc.ValunError('approval_unbound', 'the directory names no participant id')
            return {'counterparty': other}
        if name == 'valun_set_limits':
            me = c.me()
            if not isinstance(me, dict):
                raise vc.ValunError('approval_unbound', 'the server sent no participant record')
            return {'me': me}
        did = a.get('deal_id')
        if not (isinstance(did, str) and _DEAL_ID.fullmatch(did)):
            raise vc.ValunError('bad_arguments', 'deal_id is missing or malformed')
        d = c.deal(did)
        if not isinstance(d, dict):
            raise vc.ValunError('approval_unbound', 'the deal could not be read')
        return {'deal': d, 'checked': self._checked(d, did, c.participant_id, delivery=name == 'valun_review_delivery')}

    @staticmethod
    def _checked(d, did, me, delivery=False):
        """The values an approval text is built from, each checked against what the call signs (prepare). Raises
        ValunError when the deal as shown does not hold together."""
        cur = d.get('current')
        if not isinstance(cur, dict) or not cur:
            raise vc.ValunError('no_offer', 'this deal has no visible offer')
        t = cur.get('terms')
        if not isinstance(t, dict):
            raise vc.ValunError('approval_unbound', 'the offer shows no terms')
        h = vc.terms_hash(t)
        if cur.get('terms_hash') != h:
            raise vc.ValunError('hash_mismatch', 'the terms shown do not hash to the stated terms hash')
        if t.get('deal_id') != did:
            raise vc.ValunError('deal_mismatch', 'the terms shown are for another deal')
        ids = {r: t[r].get('id') if isinstance(t.get(r), dict) else None for r in ('payer', 'payee')}
        mine = [r for r, pid in ids.items() if isinstance(me, str) and me and pid == me]
        if len(mine) != 1:
            raise vc.ValunError('not_a_party', 'the terms do not name you as exactly one of the two parties')
        role = mine[0]
        other = ids['payee' if role == 'payer' else 'payer']
        if not (isinstance(other, str) and other):
            raise vc.ValunError('not_a_party', 'the terms name no other party')
        if d.get('your_role') is not None and d.get('your_role') != role:
            raise vc.ValunError('role_mismatch', f'the server says you are the {shown(d.get("your_role"))}; the terms make you the {role}')
        cp = d.get('counterparty') if isinstance(d.get('counterparty'), dict) else {}
        if cp.get('id') is not None and cp.get('id') != other:
            raise vc.ValunError('counterparty_mismatch', "the server's counterparty is not the other party in the terms")
        price = t.get('price')
        if not (isinstance(price, dict) and _whole(price.get('amount')) and price.get('unit') == vc.UNIT):
            raise vc.ValunError('bad_terms', 'the price is not a whole number of PC')
        out = {'terms': t, 'terms_hash': h, 'role': role, 'other_id': other, 'handle': cp.get('handle'), 'price': price['amount'],
               'service': t['service'] if isinstance(t.get('service'), dict) else {}}
        if not delivery:
            if t.get('proposer') != other:
                raise vc.ValunError('own_offer', 'the current offer is not the other party\'s: only they can be answered')
            return out
        if role != 'payer':
            raise vc.ValunError('not_payer', 'only the payer accepts a delivery')
        ag = d.get('agreement')
        if not isinstance(ag, dict) or ag.get('terms_hash') != h:
            raise vc.ValunError('hash_mismatch', "the agreement's terms hash is not the hash of the terms shown")
        dl = d.get('delivery')
        if not isinstance(dl, dict) or not dl:
            raise vc.ValunError('not_delivered', 'nothing has been delivered on this deal')
        content = dl.get('content')
        if not isinstance(content, str):
            raise vc.ValunError('approval_unbound', 'the delivery shows no text')
        sha = vc.sha256_hex(content)
        if dl.get('sha256') != sha:
            raise vc.ValunError('hash_mismatch', 'the delivered content does not match its sha256')
        out.update(delivery=dl, content=content, sha256=sha)
        return out

    @staticmethod
    def _bind_from(name, a, snap, strict):
        """The arguments to sign with: the agent's, plus the pins taken from the checked snapshot. With strict (prepare)
        a pin the agent passed must be the snapshot's: the text describes the snapshot, so the call may sign nothing else."""
        a = dict(a)
        chk = snap.get('checked') or {}

        def pin(key, value, code, why):
            if not a.get(key):
                a[key] = value
            elif strict and a[key] != value:
                raise vc.ValunError(code, why)
        if name == 'valun_respond' and a.get('action') in ('accept', 'counter'):
            pin('expected_terms_hash', chk['terms_hash'], 'stale_terms', 'the offer changed after your agent read it')
        elif name == 'valun_review_delivery' and a.get('decision') == 'accept':
            pin('expected_deliverable_sha256', chk['sha256'], 'stale_delivery', 'the delivery changed after your agent read it')
            pin('expected_terms_hash', chk['terms_hash'], 'stale_terms', 'the agreed terms are not the ones your agent read')
        elif name == 'valun_propose' and 'counterparty' in snap:
            a['counterparty'] = snap['counterparty']['id']     # the offer is signed for exactly the participant shown
        return a

    def _text_for(self, name, a):
        """The approval text builder for this call: (args, snapshot) -> text."""
        if name == 'valun_set_limits':
            return self._text_limits
        if name == 'valun_propose':
            return self._text_propose
        if name == 'valun_respond' and a.get('action') == 'accept':
            return self._text_accept
        if name == 'valun_respond' and a.get('action') == 'counter':
            return self._text_counter
        if name == 'valun_review_delivery' and a.get('decision') == 'accept':
            return self._text_review
        raise vc.ValunError('approval_unbound', f'no approval text for {name} with these arguments')

    # The texts: computed lines first (values the client computed or checked against what is signed, shown so that they
    # cannot carry layout), then text written by a counterparty or by the agent, quoted as one JSON line (quote_line).
    @staticmethod
    def _who(chk):
        h = chk.get('handle')
        return shown(h) if isinstance(h, str) and h else shown(chk['other_id'])

    @staticmethod
    def _text_limits(a, snap):
        me = snap['me']
        mandate = me.get('mandate')
        if not isinstance(mandate, dict):
            raise vc.ValunError('approval_unbound', 'the server sent no owner mandate')
        cur, body = me.get('agent_limits') or {}, limits_body(a)
        names = {field: arg for arg, (field, _k) in LIMIT_FIELDS.items()}
        lines = ['Valun - LOOSEN limits recorded from your instructions (the Valun server enforces them):']
        for field, new in body.items():
            if field in names:
                lines.append(f'  {names[field]}: {shown(cur.get(field, mandate.get(field)))} -> '
                             f"{shown(new) if new is not None else 'removed'} (your owner mandate: {shown(mandate.get(field))})")
        lines.append('Approve only if you asked your agent for this.')
        if 'notes' in body:
            lines.append('Goals written by your agent (quoted exactly): ' + quoted(body['notes']))
        return '\n'.join(lines)

    @staticmethod
    def _text_propose(a, snap):
        other = snap['counterparty']
        role = a.get('role')
        if role not in ('payer', 'payee'):
            raise vc.ValunError('bad_role', 'role must be payer or payee')
        price, due, ttl = int(a['price']), int(a.get('deliver_within_hours') or 48), int(a.get('offer_valid_hours') or 24)
        who = shown(other.get('handle'))
        return '\n'.join([
            f"Valun - sign a NEW OFFER to {who} ({shown(other['id'])}):",
            f'  you are the {ROLE_WORDS[role]}; price: {price} PC',
            f'  deliver within {due} h; the offer stays open {ttl} h',
            f'If {who} accepts, the deal is binding without asking you again: ' + owes(role, who, price),
            NOT_SETTLED,
            quote_line('Offer text written by your agent', {k: a.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_accept(self, a, snap):
        chk = snap['checked']
        t, who, price, svc = chk['terms'], self._who(chk), chk['price'], chk['service']
        return '\n'.join([
            f"Valun - ACCEPT {who}'s offer ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}, version {shown(t.get('version'))}):",
            f"  you are the {ROLE_WORDS[chk['role']]}; price: {price} PC; deliver by {shown(t.get('deliver_by'))}",
            f"  terms hash {chk['terms_hash'][:16]}... (recomputed from these terms; your Valun client checks it again before signing)",
            'This makes the deal binding on both sides: ' + owes(chk['role'], who, price),
            NOT_SETTLED,
            quote_line(f'Offer text written by {who}', {k: svc.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_counter(self, a, snap):
        chk = snap['checked']
        t, who, old, svc = chk['terms'], self._who(chk), chk['price'], chk['service']
        # Exactly what Client.counter() signs: these arguments, and the rest copied from the terms pinned by hash.
        price = int(a['price']) if a.get('price') is not None else old
        hours = a.get('deliver_within_hours')
        if hours is not None and not _whole(hours):
            raise vc.ValunError('bad_arguments', 'deliver_within_hours must be a whole number of hours')
        texts = [k for k in ('title', 'description', 'deliverable') if a.get(k)]
        changes = ([f'price {old} -> {price} PC'] if a.get('price') is not None else []) \
            + ([f'deliver within {hours} h'] if hours is not None else []) + [f'{k} (quoted below)' for k in texts]
        return '\n'.join([
            f"Valun - sign a COUNTER-OFFER to {who} ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}), "
            f"replacing their version {shown(t.get('version'))}:",
            f"  you are the {ROLE_WORDS[chk['role']]}; price: {price} PC",
            '  deliver ' + (f'within {hours} h of signing' if hours is not None else
                            f"by {shown(t.get('deliver_by'))} as in their offer (rounded down to the hour, at least 1 h after signing)"),
            '  your agent changes: ' + (', '.join(changes) or 'nothing') + '; the counter-offer stays open 24 h',
            f'If {who} accepts it, the deal is binding without asking you again: ' + owes(chk['role'], who, price),
            NOT_SETTLED,
            quote_line(f"Counter-offer text, with what your agent did not change copied from {who}'s offer",
                       {k: a[k] if a.get(k) else svc.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_review(self, a, snap):
        chk = snap['checked']
        t, who, price, svc, dl, content = chk['terms'], self._who(chk), chk['price'], chk['service'], chk['delivery'], chk['content']
        m = measure.measure(content, ' '.join(str(svc.get(k) or '') for k in ('title', 'description', 'deliverable')), check_hosts=False)
        facts = [f"{x['requirement']}: {x['measured']} ({'met' if x['met'] else 'NOT met'})" for x in m['checks_against_agreed_terms']]
        try:
            exact = sandbox.check_delivery(t, content)
        except Exception:  # noqa: BLE001 - a malformed result block is a fact to show, not a reason to hide the prompt
            exact = None
            facts.append('exact result: could not be checked')
        if exact and exact.get('checked'):
            facts.append('exact result: ' + ('matches the agreed text' if exact.get('exact_result_matches') else
                                             'DOES NOT MATCH (differs in ' + ', '.join(shown(k) for k in (exact.get('differs_in') or [])) + ')'))
        return '\n'.join([
            f"Valun - ACCEPT {who}'s delivery ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}) and ISSUE A CREDIT NOTE "
            f'of {price} PC to {who}:',
            f"  delivered: {len(content.encode('utf-8'))} bytes, sha256 {chk['sha256'][:16]}... (recomputed from the text measured here)",
            '  measured: ' + ('; '.join(facts) or f"{m['word_count']} words, {len(m['links'])} links"),
            f"  agreed terms hash {chk['terms_hash'][:16]}... (your Valun client checks both hashes again before signing)",
            f'Your agent signs a Basis note; the pilot tracker then records that you owe {who} {price} PC more.',
            NOT_SETTLED,
            quote_line('Delivery title and agreed service text', {'delivery_title': dl.get('title') or '', 'title': svc.get('title'),
                                                                  'deliverable': svc.get('deliverable')})])

    # ---------- tools ----------
    def status(self, a):
        c = self.client()
        me, info = c.me(), c.info()
        recorded = me.get('agent_limits') or {}
        approvals = (self.approvals or 'Commitments are signed without asking your owner first.')
        approvals += f" The server also holds commitments priced above {me['mandate'].get('approve_above')} PC for the owner console."
        return {'connected': True, 'server': c.state['server'], 'network': info['network'],
                'unit': info['unit'] + ' (pilot credits, no monetary value)',
                'you': me['participant'], 'objective_from_your_owner': me['mandate'].get('objective') or '(none set)',
                'goals_your_owner_told_you': recorded.get('notes') or '(none recorded yet: ask your owner, then use valun_set_limits)',
                'limits_you_recorded': {k: v for k, v in recorded.items() if k not in ('notes', 'set_at')},
                'limits_in_force': {arg: (me.get('effective_limits') or me['mandate']).get(field) for arg, (field, _k) in LIMIT_FIELDS.items()},
                'mandate': {k: v for k, v in me['mandate'].items() if k != 'objective'}, 'mandate_version': me['mandate_version'],
                'approvals': approvals, 'position': me['position'], 'authority': me['authority'], 'settlement': SETTLEMENT_NOTE,
                'honest_labels': HONEST_LABELS, 'real_vs_simulated': REAL_VS_SIMULATED}

    def set_limits(self, a):
        c = self.client()
        body = limits_body(a)
        if not body:
            raise vc.ValunError('nothing_to_record', "give at least one limit, a limit to clear, or your owner's goals")
        r = c.set_limits(body)
        eff = r.get('effective_limits') or {}
        return {'recorded': r.get('agent_limits'), 'limits_in_force': {arg: eff.get(field) for arg, (field, _k) in LIMIT_FIELDS.items()},
                'what_this_means': ("The Valun server now enforces these limits at every action, together with your owner's mandate "
                                    '(the stricter of the two applies). Only your owner can raise the mandate.')}

    def directory(self, a):
        c = self.client()
        q = (a.get('query') or '').lower()
        out = []
        for p in c.directory():
            if p['id'] == c.participant_id or p['status'] != 'active':
                continue
            text = ' '.join(str(p.get(k) or '') for k in ('handle', 'display_name', 'about', 'services')).lower()
            if q and q not in text:
                continue
            pos = c.participant(p['id']).get('public_position', {})
            out.append({'handle': p['handle'], 'id': p['id'], 'name': p['display_name'], 'operator': p['operator'], 'about': p['about'],
                        'services': p['services'], 'credit_notes_they_hold_PC': pos.get('claims_held'), 'credit_notes_they_owe_PC': pos.get('owes'),
                        'deals': pos.get('deals'), 'agent_last_seen': p.get('agent_last_seen'),
                        'agent_recently_active': recently_active(p.get('agent_last_seen'), joined_at=p.get('joined_at'))})
        out.sort(key=lambda x: not x['agent_recently_active'])
        return {'participants': out, 'note': ('positions are outstanding credit notes recorded by the pilot Basis tracker; nothing is settled; '
                                              'PC have no value. A participant whose agent has not been seen in the last 24 hours may never answer an offer.')}

    def inbox(self, a):
        return self.client().inbox()

    def deal(self, a):
        c = self.client()
        d = c.deal(a['deal_id'])
        out = {k: d.get(k) for k in ('id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement',
                                     'decline', 'completion', 'dispute', 'cancellation', 'approvals', 'labels')}
        if d.get('pending_counter'):
            pc = d['pending_counter']
            out['your_counter_offer_awaiting_owner'] = {'version': pc['version'], 'state': pc['state'], 'terms': pc.get('terms'),
                                                        'terms_hash': pc['terms_hash'], 'note': 'the other side cannot see it until your owner approves it'}
        cur, st = d.get('current') or {}, d.get('status')
        if st == 'open' and cur:
            out['whose_turn'] = ('yours: accept, counter or decline' if cur.get('by') != c.participant_id
                                 else 'theirs: your offer is open; you cannot accept your own offer, only withdraw it or wait')
        elif st == 'agreed':
            out['whose_turn'] = 'yours: deliver the work' if d.get('your_role') == 'payee' else 'theirs: they deliver'
        elif st in ('delivered', 'note_failed'):
            out['whose_turn'] = 'yours: accept the delivery or dispute it' if d.get('your_role') == 'payer' else 'theirs: they review your delivery'
        else:
            out['whose_turn'] = f'nobody: the deal is {st}'
        out['current_terms'] = d['current'] and {'version': d['current']['version'], 'by': d['current']['by'], 'state': d['current']['state'],
                                                 'terms': d['current']['terms'], 'terms_hash': d['current']['terms_hash']}
        if d.get('status') == 'open' and d.get('current'):
            try:
                chk = c.verify_offer(d)
                out['checked_by_your_client'] = {'terms_hash_recomputed': chk['terms_hash'], 'proposer_signature_valid': True}
            except vc.ValunError as e:
                out['checked_by_your_client'] = {'problem': e.code, 'message': str(e), 'advice': 'do not accept these terms'}
        if d.get('delivery'):
            dl = d['delivery']
            body = dl['content'] if len(dl['content']) <= 16000 else dl['content'][:16000] + '\n[... truncated for display; full text is on the server ...]'
            out['delivery'] = {'title': dl.get('title'), 'sha256': dl['sha256'], 'bytes': dl['bytes'], 'late': dl.get('late'), 'content': body}
            reviewing = d.get('your_role') == 'payer' and d.get('status') in ('delivered', 'note_failed')
            out['delivery']['measured_by_your_client'] = measure.measure(dl['content'], terms_text(d),
                                                                         check_hosts=reviewing and self.check_link_hosts)
            exact = sandbox.check_delivery((d.get('current') or {}).get('terms') or {}, dl['content'])
            if exact is not None:
                out['delivery']['checked_exactly_by_your_client'] = exact
                if reviewing and exact.get('checked') and not exact.get('exact_result_matches'):
                    out['delivery']['advice'] = ('The delivered result does not match the exact result of the agreed text '
                                                 f"(differs in: {', '.join(exact.get('differs_in') or ['the result block'])}). "
                                                 'Dispute it with that reason instead of issuing a credit note.')
        if d.get('credit_note'):
            n = d['credit_note']
            out['credit_note'] = {'state': n.get('state'), 'amount_PC': n.get('amount'), 'tracker_status': n.get('tracker_status'),
                                  'tracker_cumulative_total_PC': (n.get('tracker_note') or {}).get('amount_collected'),
                                  'confirmation': (n.get('tracker_note') or {}).get('confirmation'), 'verified_by_valun': n.get('verified_by_valun'),
                                  'outstanding': n.get('outstanding'), 'settled': n.get('settled', False),
                                  'issuer_pubkey': n.get('issuer_pubkey'), 'recipient_pubkey': n.get('recipient_pubkey')}
            if n.get('signature_withheld'):
                out['credit_note']['signature'] = 'withheld until the Basis tracker records the note'
        out['history'] = d.get('history', [])[-12:]
        prices = [(v['version'], 'you' if v['by'] == c.participant_id else (d.get('counterparty') or {}).get('handle'), v['price']['amount'])
                  for v in d.get('versions') or []]
        if prices:
            out['negotiation'] = {'prices_by_version': [f'v{n} {who}: {p} PC' for n, who, p in prices]}
            mine = [p for _, who, p in prices if who == 'you'][-2:]
            theirs = [p for _, who, p in prices if who != 'you'][-2:]
            if len(mine) == 2 and len(theirs) == 2 and mine[0] == mine[1] and theirs[0] == theirs[1] and mine[0] != theirs[0]:
                out['negotiation']['stalemate'] = (f'Both sides have repeated the same price ({mine[0]} vs {theirs[0]} PC). If no price '
                                                   'within your limits works for the other side, decline with a reason instead of countering again.')
        return out

    def propose(self, a):
        c = self.client()
        other = self._resolve(c, a['counterparty'])
        # A seller of exactly checkable work publishes that it needs the text in the description; check before signing.
        if a.get('role') == 'payer' and '``` block' in str(other.get('services') or '') \
                and sandbox.extract_text(a.get('description') or '') is None:
            raise vc.ValunError('missing_text', (
                f"Not signed. {other['handle']} needs the text to process inside the description, and yours has none. Put the "
                'exact text in a ``` fenced block in the description (or as the only "quoted" string, or after TEXT: at the '
                'end), then make the offer again.'))
        r = c.propose(other['id'], a['role'], a['title'], a['description'], a['deliverable'], int(a['price']),
                      int(a.get('deliver_within_hours') or 48), int(a.get('offer_valid_hours') or 24))
        waiting = r['status'] == 'proposed_awaiting_owner'
        idle = None if recently_active(other.get('agent_last_seen'), joined_at=other.get('joined_at')) else (
            f"{other['handle']}'s agent has not been seen in the last 24 hours; it may never answer. Consider an active seller too.")
        return {'deal_id': r['id'], 'status': r['status'], 'terms_hash': r['current']['terms_hash'] if r.get('current') else None,
                'what_happened': (f"Your signed offer is waiting for your owner's approval before {other['handle']} can see it." if waiting
                                  else f"{other['handle']} can now accept, decline or counter your signed offer."),
                'if_agreed': (f"After you accept their delivery you issue them a credit note of {a['price']} PC (you will owe them; not settled)."
                              if a['role'] == 'payer' else f"After they accept your delivery they issue you a credit note of {a['price']} PC (they will owe you; not settled)."),
                **({'warning': idle} if idle else {})}

    def respond(self, a):
        c = self.client()
        act, did = a['action'], a['deal_id']
        if act == 'accept':
            r = c.accept(did, a.get('expected_terms_hash'))
        elif act == 'decline':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a decline needs a short reason: the other side reads it and may make a better offer')
            r = c.decline(did, a['reason'].strip())
        elif act == 'withdraw':
            r = c.withdraw(did)
        elif act == 'counter':
            r = c.counter(did, price=a.get('price'), title=a.get('title'), description=a.get('description'), deliverable=a.get('deliverable'),
                          deliver_by_hours=a.get('deliver_within_hours'), expected_terms_hash=a.get('expected_terms_hash'))
        else:
            raise vc.ValunError('bad_action', 'action must be accept, decline, counter or withdraw')
        held = act == 'counter' and r.get('pending_counter')
        explain = {'agreed': 'Agreement formed: both sides have signed the same terms.',
                   'accepted_awaiting_owner': ('You signed the acceptance; it becomes binding when the owner holding it approves '
                                               '(yours, or the proposer\'s if their limits require it; valun_deal shows which).'),
                   'open': ("Your signed counter-offer waits for your owner's approval; the other side cannot see it yet." if held
                            else 'Your counter-offer is open for the other side.' if act == 'counter' else 'The offer is open.'),
                   'declined': 'You declined; nothing is owed.', 'withdrawn': 'Your offer is withdrawn.'}
        return {'deal_id': did, 'status': r['status'], 'what_happened': explain.get(r['status'], r['status']), 'next_actions': r.get('next_actions')}

    def deliver(self, a):
        c = self.client()
        d = c.deal(a['deal_id'])
        m = measure.measure(a['content'], terms_text(d), check_hosts=self.check_link_hosts)
        problems = [f"{x['requirement']}: measured {x['measured']}" for x in m['checks_against_agreed_terms'] if not x['met']]
        if m.get('warning'):
            problems.append(m['warning'])
        if problems and not a.get('send_anyway'):
            raise vc.ValunError('draft_does_not_meet_terms', 'Not sent. Your draft does not meet the agreed terms as measured: '
                                + ' | '.join(problems) + ' Fix it and deliver again (send_anyway=true only if you are sure; '
                                'the payer sees the same measurements).', extra={'measured': m})
        r = c.deliver(a['deal_id'], a['content'], a.get('title') or '')
        return {'deal_id': r['id'], 'status': r['status'], 'sha256': r['delivery']['sha256'],
                'what_happened': 'Delivered and signed. The payer will accept it (issuing you a credit note) or dispute it.'}

    def review(self, a):
        if a.get('decision') not in ('accept', 'dispute'):
            raise vc.ValunError('bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed")
        c = self.client()
        if a['decision'] == 'dispute':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a dispute needs a reason')
            r = c.dispute(a['deal_id'], a['reason'])
            return {'deal_id': r['id'], 'status': r['status'], 'what_happened': 'Disputed. No credit note was issued; the dispute is recorded.'}
        r = c.complete(a['deal_id'], a.get('expected_deliverable_sha256'), a.get('expected_terms_hash'))
        n = r.get('credit_note') or {}
        if r['status'] == 'completion_awaiting_owner':
            msg = 'You accepted the delivery and signed the credit note; your owner must approve before it is issued to the tracker.'
        elif r['status'] == 'note_issued':
            msg = (f"Credit note issued: the Basis tracker now records that you owe {r['counterparty']['handle']} "
                   f"{(n.get('tracker_note') or {}).get('amount_collected')} PC in total (this deal added {n.get('amount')}). " + SETTLEMENT_NOTE)
        else:
            msg = r['status']
        return {'deal_id': r['id'], 'status': r['status'], 'what_happened': msg,
                'credit_note': {'state': n.get('state'), 'amount_PC': n.get('amount'), 'tracker_status': n.get('tracker_status'),
                                'confirmation': (n.get('tracker_note') or {}).get('confirmation'), 'settled': False}}
