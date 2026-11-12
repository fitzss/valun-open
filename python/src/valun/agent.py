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

Circulating credit (0.4; only where the server's GET /info lists circulation/1): valun_review_delivery can pay with a
note the agent holds (pay_with, a commitment the owner approves with its own text), valun_deliver can deliver the exact
result of a text-stats or notary job (exact_result), valun_status, valun_deal and valun_inbox show what can be spent,
what is being paid and what the client clears, and the client signs the consents its owner's policy allows by itself
(process_consents(), at most once per CONSENTS_EVERY_MS, before every tool call that is not read-only; with
consents_on_reads, an adapter without a consent loop also signs the value-safe ones, set-offs and payments to it by
transfer, before valun_status and valun_inbox: decision D-3 a).
"""
import json
import re
from datetime import datetime, timedelta, timezone

from . import basis as vb
from . import client as vc
from . import measure
from . import novation as nv
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
# The same labels where the server offers circulating credit (GET /info lists circulation/1): word for word the server's
# deal label (PROTOCOL.md 16.1, design 4.12), and nothing that says notes cannot move or be cleared.
CIRCULATION_SETTLEMENT = ('not settled: a credit note is an outstanding obligation. With circulating credit it can move to a '
                          'new creditor (debt transfer, signed by the debtor and both creditors) or be cancelled against an '
                          'equal opposite obligation (set-off, signed by every party; no net position changes). Nothing is '
                          'redeemed, there is no reserve, and PC have no value.')
SETTLEMENT_NOTE_CIRCULATION = CIRCULATION_SETTLEMENT
NOT_SETTLED_CIRCULATION = CIRCULATION_SETTLEMENT
HONEST_LABELS_CIRCULATION = {
    'what_basis_records': ('The pilot Basis tracker keeps one running total per key pair: what the issuer key owes the '
                           'recipient key, with a timestamp, signed by the issuer. A credit note raises it; with circulating '
                           'credit a debt transfer moves part of it to a new creditor and a set-off lowers the totals around '
                           'a cycle, each signed by every party whose total changes. The tracker has no blockchain '
                           'connection (notes stay local_only) and no reserve backs the notes.'),
    'outstanding_promise': CIRCULATION_SETTLEMENT,
    'third_party': ("Supported: paying a third party with your OWN credit note, or with a note you hold (pay_with: the "
                    "issuer's debt to you moves to the payee; the issuer, you and the payee each sign, and the issuer's "
                    'total debt does not change), and set-offs that cancel equal debts around a cycle (every party signs; '
                    'no net position changes). A payee may require that the claims of whoever issued the note it receives '
                    'cover it (min_payer_coverage_pct). Not supported: redeeming a note for anything outside the pilot.'),
}
REAL_VS_SIMULATED_CIRCULATION = {
    'real': "signatures by each participant's own key; Valun's acceptance and approval records; credit notes, debt "
            'transfers and set-offs held by a real Basis tracker (read back and reconciled by Valun, and checked by your '
            'client against the signatures)',
    'simulated': 'PC (pilot credits) have no monetary value; the Basis tracker has no blockchain connection (notes are '
                 'local_only, never on-chain); nothing is redeemed and there is no reserve: a set-off only cancels equal '
                 'opposite obligations',
    'not_proven': REAL_VS_SIMULATED['not_proven'],
}
CIRCULATION = 'circulation/1'
CONSENTS_EVERY_MS = 60_000      # process_consents() runs at most this often (state consents_last_run_ms; design 6.6)
# The local consent policy a join writes (design 6.6, 8): an invited participant's client signs set-offs and transfers of
# its own debt by itself, not payments to it by transfer (opt-in); a sandbox participant's client signs all three. The
# owner's mandate still has to allow each role (the stricter of the two applies), and max_PC caps one consent.
INVITE_CONSENT_POLICY = {'setoff': True, 'as_issuer': True, 'as_new_creditor': False, 'max_PC': 50}
SANDBOX_CONSENT_POLICY = {'setoff': True, 'as_issuer': True, 'as_new_creditor': True, 'max_PC': 50}
CONSENT_POLICY_KEYS = ('setoff', 'as_issuer', 'as_new_creditor', 'max_PC')
# Where the payer may pay from: the deal statuses GET /deals/{id}/payment-options serves (PROTOCOL.md 18.6 step 1).
PAYABLE = ('delivered', 'note_failed', 'payment_due')
# How fast an issuer signs a transfer of its debt (payment options issuer_consents), in an approval text.
CONSENT_SPEED_WORDS = {'immediate': 'immediately', 'auto': 'automatically',
                       'when_online': 'when its agent is next online', 'unavailable': 'not at the moment (unavailable)'}
# prepare() failures that keep their own code and setup hint instead of approval_unbound (still nothing is signed).
UNBOUND_PASS_THROUGH = ('not_connected', 'not_configured', 'tracker_mismatch')
# The server's sandbox agents (PROTOCOL.md 18.15) and the five-step tour a sandbox_only participant can take with them.
SANDBOX_EXACT, SANDBOX_MALLORY = 'sandbox-exact', 'sandbox-mallory'
SANDBOX_AGENTS = (SANDBOX_EXACT, SANDBOX_MALLORY)
TOUR_GOALS = {
    1: 'Earn: sandbox-exact buys text-stats from you (the welcome job, 3 PC). Deliver the exact result; it pays with its '
       'own credit note.',
    2: 'Spend a note you hold: buy notary from sandbox-mallory (2 PC) and pay with pay_with="sandbox-exact" (2 PC of '
       "sandbox-exact's debt to you move to sandbox-mallory). Dispute a wrong delivery and buy again.",
    3: 'Pay with your own note: buy notary from sandbox-exact (2 PC). Then the 2-cycle you -> sandbox-exact -> you (1 PC) '
       'is cleared by a set-off your Valun client signs by itself.',
    4: 'Sell: offer text-stats to sandbox-mallory (3 PC). It pays with its own note, and the 3-cycle sandbox-mallory -> '
       'you -> sandbox-exact -> sandbox-mallory (1 PC) clears.',
    5: 'Spend again: buy notary from sandbox-exact (2 PC) and pay with pay_with="sandbox-mallory". Then the server-only '
       'cycle between sandbox-exact and sandbox-mallory clears.',
}
TOUR_TEXTS = {1: 'Valun sandbox tour, step 1: my first paid job.',
              2: 'Valun sandbox tour, step 2: paid with a note I hold.',
              3: 'Valun sandbox tour, step 3: paid with my own note.',
              4: 'Valun sandbox tour, step 4: I sell my work.',
              5: 'Valun sandbox tour, step 5: paid with a note I hold again.'}
# What you hold / owe (PC) once each step is done, as tracker totals (design 9.2).
TOUR_AFTER = {1: (3, 0), 2: (1, 0), 3: (0, 1), 4: (2, 0), 5: (0, 0)}


BRIEF_NOTE = ('PC are pilot credits with no monetary value: a credit note is an outstanding promise, and nothing is redeemed. '
              'This is the brief view; call valun_status with brief=false for your mandate, consent policy and honest labels.')


def brief_status(out):
    """valun_status's brief view (brief=true, for small models), made from the full view, so it reads and signs exactly
    the same: who you are, your owner's objective and goals, the limits in force, where approvals happen, what you hold
    and owe, the notes you can spend, the payments and consents in progress, the next sandbox step, and one line on what
    PC are (the honest labels stay in the full view)."""
    def d(v):
        return v if isinstance(v, dict) else {}
    you, pos = d(out.get('you')), d(out.get('position'))
    b = {'brief': True, 'connected': out.get('connected'),
         'you': {k: you.get(k) for k in ('id', 'handle', 'sandbox_expires_at') if you.get(k) is not None},
         'objective_from_your_owner': out.get('objective_from_your_owner'),
         'goals_your_owner_told_you': out.get('goals_your_owner_told_you'),
         'limits_in_force': out.get('limits_in_force'), 'approvals': out.get('approvals'),
         'you_hold_PC': pos.get('claims_held'), 'you_owe_PC': pos.get('owes'), 'net_PC': pos.get('net')}
    if 'notes_you_can_spend' in out:
        b['notes_you_can_spend'] = [{k: n.get(k) for k in ('issuer', 'amount_PC', 'checked_by_your_client')}
                                    for n in (out.get('notes_you_can_spend') or []) if isinstance(n, dict)]
        b['payments_in_progress'] = len(out.get('payments_in_progress') or [])
        b['consents_pending'] = d(out.get('clearing')).get('consents_pending')
    step = out.get('sandbox_next_steps')
    if isinstance(step, dict):
        b['sandbox_next_steps'] = {k: step[k] for k in ('tour_step', 'next_calls', 'then') if k in step}
    b['note'] = BRIEF_NOTE
    return b


def labels(circulating):
    """The honest labels for a server with circulating credit (True) or without it: {settlement, not_settled,
    honest_labels, real_vs_simulated}."""
    if circulating:
        return {'settlement': SETTLEMENT_NOTE_CIRCULATION, 'not_settled': NOT_SETTLED_CIRCULATION,
                'honest_labels': HONEST_LABELS_CIRCULATION, 'real_vs_simulated': REAL_VS_SIMULATED_CIRCULATION}
    return {'settlement': SETTLEMENT_NOTE, 'not_settled': NOT_SETTLED, 'honest_labels': HONEST_LABELS,
            'real_vs_simulated': REAL_VS_SIMULATED}


def features_of(info):
    """The feature tags a GET /info answer lists ([] for a v15 server or circulation off; malformed: ['?'])."""
    raw = info.get('features') if isinstance(info, dict) else None
    if raw is None:
        return []
    return list(raw) if isinstance(raw, list) and all(isinstance(f, str) for f in raw) else ['?']


def consent_policy_in_force(local, mandate):
    """What a Valun client signs by itself, per consent role: the stricter of the local consent policy (the profile's
    consent_policy, changed with `valun config consents.*`) and the owner's mandate as GET /me shows it (rule R8 of
    PROTOCOL.md 15.3). Booleans per role, the local per-consent cap, and both sides as they are."""
    p = local if isinstance(local, dict) else {}
    m = mandate if isinstance(mandate, dict) else {}
    return {'setoff': p.get('setoff') is True and m.get('auto_clear') is True,
            'as_issuer': p.get('as_issuer') is True and m.get('novate_own_debt') is True,
            'as_new_creditor': (p.get('as_new_creditor') is True and m.get('accept_transfers') is True
                                and m.get('may_accept_credit') is not False),
            'max_PC': p.get('max_PC'),
            'local_policy': {k: p[k] for k in ('setoff', 'as_issuer', 'as_new_creditor', 'max_PC', 'accept_issuers',
                                               'refuse_issuers') if k in p},
            'owner_mandate': {k: m.get(k) for k in ('auto_clear', 'novate_own_debt', 'accept_transfers', 'accept_notes_from',
                                                    'refuse_notes_from', 'pay_with_held_notes', 'max_accept_per_issuer')},
            'how_to_change': ('your owner changes the local policy with `valun config consents.setoff|consents.as_issuer|'
                              'consents.as_new_creditor on|off` and `valun config consents.max_PC N`, and the mandate in '
                              'the owner console; the stricter of the two applies')}


def client_signs(policy):
    """consent_policy_in_force() as sentences: what the client signs by itself, without asking the owner."""
    cap = policy.get('max_PC')
    upto = f', up to {cap} PC each' if _whole(cap) else ''
    out = []
    if policy.get('setoff'):
        out.append(f'set-offs that cancel equal claims and debts of yours around a cycle (your net position does not change){upto}')
    if policy.get('as_issuer'):
        out.append(f'debt transfers that move your own debt to a new creditor (your total owed does not change){upto}')
    if policy.get('as_new_creditor'):
        out.append(f'payments to you by debt transfer, of notes from issuers your owner accepts{upto}')
    return out


def wants_consents(state):
    """Does this profile take part in consents at all? It has a consent policy (written at `valun join` since 0.4, or
    with `valun config consents.*`), or it has paid by transfer (a regenerated transfer needs its signature again). A
    0.3 profile has neither, so it is served exactly as by 0.3 (no consent request)."""
    if not isinstance(state, dict):
        return False
    return (isinstance(state.get('consent_policy'), dict) or bool(state.get('approved_payments'))
            or bool(state.get('transfer_attempts')))


def consents_due(c, now_ms=None, every_ms=CONSENTS_EVERY_MS, value_safe_only=False):
    """Client.process_consents() for a profile that takes part in consents (wants_consents), when its last run
    (consents_last_run_ms) is at least `every_ms` ago. Returns the run's report, or None when it did not run. Errors
    are the caller's (the agent's hook swallows them).

    value_safe_only (decision D-3 a; before a read-only tool): process_consents(value_safe_only=True), only for a
    local consent policy with a value-safe role on (consents.setoff or consents.as_new_creditor), and only when
    neither kind of run (consents_last_run_ms, consents_last_safe_run_ms) is less than `every_ms` ago."""
    state = c.state
    if not wants_consents(state) or not c.connected:
        return None
    if value_safe_only and not set(vc.consent_roles(state.get('consent_policy'))) & set(vc.VALUE_SAFE_HEADER_ROLES):
        return None                     # nothing a read could sign: no request at all
    now = int(vc.time.time() * 1000) if now_ms is None else now_ms
    for key in ('consents_last_run_ms', 'consents_last_safe_run_ms') if value_safe_only else ('consents_last_run_ms',):
        last = state.get(key)
        if _whole(last) and 0 <= now - last < every_ms:
            return None
    return c.process_consents(now_ms=now, value_safe_only=True) if value_safe_only else c.process_consents(now_ms=now)


def _verify_hex(pubkey_hex, msg, sig_hex):
    """novation.py's verifier: a Basis signature (hex) over msg (bytes) by pubkey_hex."""
    return vb.verify(bytes.fromhex(sig_hex), msg, bytes.fromhex(pubkey_hex))


# valun_set_limits argument -> (server field, kind). Caps can only be lowered below the owner's mandate, floors raised.
LIMIT_FIELDS = {
    'max_per_deal_as_payer': ('max_issue_per_deal', 'cap'), 'max_total_owed': ('max_issue_outstanding', 'cap'),
    'max_per_deal_as_payee': ('max_accept_per_deal', 'cap'), 'max_claim_per_payer': ('max_accept_per_issuer', 'cap'),
    'min_price_as_payee': ('min_price_as_payee', 'floor'), 'min_payer_coverage_pct': ('min_payer_coverage_pct', 'floor'),
}
TOOL_NAMES = [t['name'] for t in schemas.ALL]
READ_ONLY_TOOLS = ('valun_status', 'valun_directory', 'valun_inbox', 'valun_deal')
# The read-only tools before which an agent with consents_on_reads signs the value-safe consents (decision D-3 a), and
# the keys of each entry of their consents_signed_now.
CONSENTS_ON_READ_TOOLS = ('valun_status', 'valun_inbox')
SIGNED_NOW_KEYS = ('id', 'kind', 'role', 'deal_id', 'amount', 'your_net_change_PC', 'your_total_owed_change_PC', 'state')
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
        for k in ('rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means',
                  'cause'):
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
        if e.code == 'attempt_outcome_unknown':
            out['what_this_means'] = ('An earlier payment of this deal may have applied: the edge it would change has moved '
                                      'past it to a state your Valun client cannot explain. Nothing was signed, and your client '
                                      'will not pay this deal again by itself. Only your owner can resolve it, after confirming '
                                      'with the payee whether the payment arrived (in a terminal: `valun attempts list`, which '
                                      'also says when the Valun server ended an attempt before it reached the tracker, then '
                                      '`valun attempts resolve`). Tell your owner.')
        if e.code == 'transfer_window_open':
            out['what_this_means'] = ('An earlier payment attempt of this deal can still apply until it is more than an hour '
                                      'old, so another kind of payment could pay the deal twice. Nothing was signed. Retry the '
                                      'same payment, or wait retry_after_ms before paying another way.')
        if e.code in ('stale_quote', 'stale_claim'):
            out['what_this_means'] = ('The payment changed after it was approved (another quote, or your claim on the issuer '
                                      'moved). Nothing was signed. Read the deal again and accept again; your owner is asked '
                                      'again.')
        if e.code == 'feature_unavailable':
            out['what_this_means'] = ('This Valun server does not offer circulating credit (paying with notes you hold, '
                                      'set-offs), or not on the tracker contract your client signs for (tracker v3.2). '
                                      'Nothing was signed. Pay with your own credit note (leave pay_with out); if that fails '
                                      'too, tell your owner: the server must run tracker v3.2.')
        if e.code == 'unknown_issuer':
            out['what_this_means'] = ('The payment options for this deal list no note of yours from that issuer. Nothing was '
                                      'signed. valun_status notes_you_can_spend and valun_deal how_you_can_pay give the exact '
                                      'pay_with values.')
        if e.code == 'not_exact_service':
            out['what_this_means'] = ('exact_result works only for text-stats and notary jobs whose agreed description '
                                      'carries the text to process. Nothing was sent. Deliver the content yourself.')
        return out
    return {'error': 'internal_error', 'message': f'{type(e).__name__}: {e}'}


class ValunAgent:
    """The nine Valun tools over one participant's store.

    store: a path to a private state file, or any object with .state, .secret(), .token(), .save(), .save_credentials().
    approvals: one sentence telling the model where commitments are approved (adapter-specific).
    check_link_hosts: look up link host names in DNS when measuring deliveries (no page is fetched).
    process_consents: sign the consents the owner's policy allows before tools that are not read-only (consents_if_due);
      the CLI and the MCP server keep it on, the Hermes plugin passes its own setting (off unless the owner turns it on).
    declare_roles (None: as process_consents): do this agent's clients declare the consent roles their policy signs to
      the server (X-Valun-Features; Client declare_roles; decision D-3 b)? With it off they declare none, and withdraw
      the roles declared before. An adapter that turns process_consents off only because it signs consents through this
      agent's client by itself (the sandbox tour; a consent loop of its own) passes True: a client that signs consents
      must declare its roles, or the server leaves its participant out of every set-off and refuses transfers to it.
    consents_on_reads (decision D-3 a; off by default): for an adapter without a background consent loop (the Hermes
      plugin, and `valun call`): before valun_status and valun_inbox, sign the value-safe consents only (set-offs, and
      payments to me by transfer as the standing policy allows; never an issuer's or a payer's), at most once per
      CONSENTS_EVERY_MS (consents_on_read); the tool's result then says what was signed (consents_signed_now). Only with
      process_consents on. The MCP server leaves it off: it has its optional background loop instead.
    """

    def __init__(self, store, approvals='', check_link_hosts=True, setup_hint=None, server=None, process_consents=True,
                 consents_on_reads=False, declare_roles=None, brief_status=False):
        self.store = store
        self.approvals = approvals
        self.check_link_hosts = check_link_hosts
        self.setup_hint = setup_hint or 'run `valun join` (or `valun enroll`) in a terminal'
        self.server = server
        self.process_consents = process_consents is True
        self.consents_on_reads = consents_on_reads is True
        self.declare_roles = self.process_consents if declare_roles is None else declare_roles is True
        self.brief_status = brief_status is True    # valun_status answers the brief view unless brief=false is passed
        self.features = None        # the feature tags the last GET /info this agent read listed (None: none read yet)
        self.handlers = {'valun_status': self.status, 'valun_directory': self.directory, 'valun_inbox': self.inbox,
                         'valun_deal': self.deal, 'valun_propose': self.propose, 'valun_respond': self.respond,
                         'valun_deliver': self.deliver, 'valun_review_delivery': self.review, 'valun_set_limits': self.set_limits}

    # ---------- plumbing ----------
    def client(self, require_connection=True):
        c = vc.Client(self.store, server=self.server, declare_roles=self.declare_roles)
        if require_connection and (not c.connected or not c.participant_id):
            raise vc.ValunError('not_connected', f'not enrolled: the owner must {self.setup_hint}')
        return c

    def call(self, name, args=None):
        """Run one tool. Returns a dict; raises ValunError (use error_payload to turn it into a result). Before a tool
        that is not read-only, the client signs the consents its owner's policy allows (consents_if_due). With
        consents_on_reads, before valun_status and valun_inbox it signs the value-safe ones (consents_on_read), and when
        that run took place the result adds consents_signed_now: one entry (SIGNED_NOW_KEYS) for each consent it signed
        ([]: none)."""
        if name not in self.handlers:
            raise vc.ValunError('unknown_tool', f'no Valun tool called {name!r}')
        if name not in READ_ONLY_TOOLS:
            self.consents_if_due()
            return self.handlers[name](args or {})
        report = self.consents_on_read() if name in CONSENTS_ON_READ_TOOLS else None
        out = self.handlers[name](args or {})
        if report is not None and isinstance(out, dict):
            out['consents_signed_now'] = [{k: e.get(k) for k in SIGNED_NOW_KEYS} for e in report.get('signed') or []
                                          if isinstance(e, dict)]
        return out

    def consents_if_due(self, now_ms=None):
        """Process consents (Client.process_consents: set-offs, transfers of my own debt, payments to me, regenerated
        transfers of my payments) when they are due: at most once per CONSENTS_EVERY_MS, and only for a profile that
        takes part in consents (wants_consents), with this agent's process_consents on, on a server not already known to
        lack circulating credit (decision D-2 h: once a GET /info this agent read lists no circulation/1, no request is
        made for consents). Never from a read-only tool. Never raises: returns the report, or None when it did not run or
        failed (a failed run counts as a run, so a server that cannot be reached is not asked again before
        CONSENTS_EVERY_MS)."""
        if not self.process_consents:
            return None
        if self.features is not None and CIRCULATION not in self.features:
            return None
        try:
            c = self.client()
        except Exception:  # noqa: BLE001 - not connected: there is nothing to consent to
            return None
        now = int(vc.time.time() * 1000) if now_ms is None else now_ms
        try:
            report = consents_due(c, now)
        except Exception:  # noqa: BLE001 - a consent run must never stop the tool the agent asked for
            self._mark_consents_run(c, now)
            return None
        if report is not None:
            self._remember(c)
        return report

    def consents_on_read(self, now_ms=None):
        """Decision D-3 a: before valun_status and valun_inbox, for an agent with consents_on_reads and process_consents
        on, sign the value-safe consents (Client.process_consents(value_safe_only=True): set-offs, and payments to me by
        transfer as the standing policy allows; an issuer's or a payer's consent is never signed or refused here) when
        they are due: at most once per CONSENTS_EVERY_MS (consents_due; a full run before a tool that is not read-only
        counts too, and this run never delays one), for a profile whose local policy has a value-safe role on, on a
        server not already known to lack circulating credit (decision D-2 h). Never raises: returns the report, or None
        when it did not run, failed (a failed run counts as a run, in consents_last_safe_run_ms) or found that the server
        does not offer circulating credit (the tool's result is then as in 0.3: no consents_signed_now)."""
        if not (self.consents_on_reads and self.process_consents):
            return None
        if self.features is not None and CIRCULATION not in self.features:
            return None
        try:
            c = self.client()
        except Exception:  # noqa: BLE001 - not connected: there is nothing to consent to
            return None
        now = int(vc.time.time() * 1000) if now_ms is None else now_ms
        try:
            report = consents_due(c, now, value_safe_only=True)
        except Exception:  # noqa: BLE001 - a consent run must never stop the read the agent asked for
            self._mark_consents_run(c, now, 'consents_last_safe_run_ms')
            return None
        if report is None:
            return None
        return report if CIRCULATION in self._remember(c) else None

    @staticmethod
    def _mark_consents_run(c, now, key='consents_last_run_ms'):
        def mark(state):
            state[key] = now
        try:
            upd = getattr(c.store, 'update', None)
            if callable(upd):
                upd(mark)
            else:
                mark(c.state)
                c.store.save()
        except Exception:  # noqa: BLE001
            pass

    def _remember(self, c_or_info):
        """Remember (and return) the feature tags of a GET /info answer, or of the last one a client read."""
        if isinstance(c_or_info, dict) or c_or_info is None:
            self.features = features_of(c_or_info)
        else:
            self.features = list(getattr(c_or_info, '_advertised', None) or [])
        return self.features

    def _circulating(self, c=None):
        """Does the server offer circulating credit, as the last GET /info read (by `c`, or by this agent) said?"""
        seen = list(getattr(c, '_advertised', None) or []) if c is not None else []
        return CIRCULATION in seen or CIRCULATION in (self.features or [])

    def _known_circulation(self, c, deal=None):
        """Does the server offer circulating credit? From the features this agent already knows when it knows them;
        otherwise from one GET /info, read only when it can matter (decision D-2 h): always for a call that names no deal,
        and for a deal only when its view carries the `payment` key, which a server shows only with circulation on. A
        failed read counts as no circulation (the legacy label is not false), except a tracker the profile is not pinned
        to (tracker_mismatch), which stops the call."""
        if self.features is not None:
            return CIRCULATION in self.features
        if deal is not None and not (isinstance(deal, dict) and 'payment' in deal):
            return False
        try:
            return CIRCULATION in self._remember(c.info())
        except vc.ValunError as e:
            if e.code == 'tracker_mismatch':
                raise
            return False
        except Exception:  # noqa: BLE001 - a client that cannot read /info: as without circulation
            return False

    def call_safe(self, name, args=None):
        """Like call(), but never raises: errors come back as {'error': ...}."""
        try:
            return self.call(name, args)
        except Exception as e:  # noqa: BLE001 - adapters must always get a result
            return error_payload(e, self.setup_hint)

    def _resolve(self, c, who):
        """The directory entry `who` names: the participant with exactly that id; a handle only when no id matches (a
        handle may look like another participant's id)."""
        who = (who or '').strip().lower()
        people = [p for p in c.directory() if isinstance(p, dict)]
        for p in people:
            if p.get('id') == who:
                return p
        for p in people:
            if p.get('handle') == who:
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

        A delivery acceptance that pays with a held note (pay_with an issuer): also the issuer the deal's payment
        options list under that name (an exact participant id first, else its handle), its current directory key, and
        a fresh transfer template that novation.evaluate_payer_template accepts (PROTOCOL.md 15.3, decision D-1). The
        args pin pay_with to the issuer's id, expected_quote_digest (the quote the client computed: deal, terms hash,
        delivery, keys, amount) and expected_claim_total (my claim on the issuer the text shows); Client.pay_by_transfer
        refuses another quote or claim (stale_quote, stale_claim).

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
        never asked with a generic text, and nothing is signed (approval_unbound, with the code of the cause). A profile
        that is not connected or configured, or whose pinned tracker the server no longer names, gets that refusal
        itself (not_connected, not_configured, tracker_mismatch), with its own advice."""
        extra = {}
        try:
            prepared = self.prepare(name, args)
        except Exception as e:  # noqa: BLE001 - whatever went wrong, nothing is asked and nothing is signed
            prepared = None
            info = e.extra if isinstance(e, vc.ValunError) else {}
            if info.get('cause') in UNBOUND_PASS_THROUGH:
                return None, error_payload(vc.ValunError(info['cause'], info.get('cause_message') or UNBOUND_MESSAGE),
                                           self.setup_hint)
            extra = {k: info[k] for k in ('cause', 'retry_after_ms') if k in info}
        if isinstance(prepared, dict) and isinstance(prepared.get('args'), dict) and \
                (prepared.get('text') is None or (isinstance(prepared['text'], str) and prepared['text'])):
            return prepared, None
        return None, error_payload(vc.ValunError('approval_unbound', UNBOUND_MESSAGE, extra=extra), self.setup_hint)

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
        extra = {'cause': cause}
        if isinstance(e, vc.ValunError):
            extra['cause_message'] = str(e)[:300]
            if e.extra.get('retry_after_ms') is not None:
                extra['retry_after_ms'] = e.extra['retry_after_ms']
        return vc.ValunError('approval_unbound', UNBOUND_MESSAGE, extra=extra)

    @staticmethod
    def _pay_with(a):
        """The issuer a delivery acceptance pays with (pay_with, stripped and lower-cased), or None for the agent's own
        credit note (pay_with absent or 'own_note'). bad_arguments for anything else."""
        pw = a.get('pay_with')
        if pw is None or pw == 'own_note':
            return None
        if not isinstance(pw, str) or not pw.strip() or len(pw) > 64:
            raise vc.ValunError('bad_arguments', "pay_with is 'own_note' or the handle or id of an issuer whose note you hold")
        pw = pw.strip().lower()
        return None if pw == 'own_note' else pw

    @staticmethod
    def _needs_pins(name, a):
        if name == 'valun_respond' and a.get('action') in ('accept', 'counter'):
            return not a.get('expected_terms_hash')
        if name == 'valun_review_delivery' and a.get('decision') == 'accept':
            pins = ('expected_deliverable_sha256', 'expected_terms_hash')
            try:
                if ValunAgent._pay_with(a) is not None:
                    pins += ('expected_quote_digest', 'expected_claim_total')
            except vc.ValunError:
                return True                     # a malformed pay_with: binding refuses it (approval_unbound)
            return not all(a.get(k) for k in pins)
        return False

    def _snapshot(self, name, a):
        """The one read an approval is bound to and described from (checked: see prepare)."""
        c = self.client()
        if name == 'valun_propose':
            other = self._resolve(c, a.get('counterparty'))
            if not (isinstance(other, dict) and isinstance(other.get('id'), str) and other['id']):
                raise vc.ValunError('approval_unbound', 'the directory names no participant id')
            return {'counterparty': other, 'not_settled': labels(self._known_circulation(c))['not_settled']}
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
        snap = {'deal': d, 'checked': self._checked(d, did, c.participant_id, delivery=name == 'valun_review_delivery'),
                'not_settled': labels(self._known_circulation(c, d))['not_settled']}
        if name == 'valun_review_delivery' and a.get('decision') == 'accept' and self._pay_with(a) is not None:
            snap['transfer'] = self._transfer_snapshot(c, did, snap['checked'], self._pay_with(a))
            snap['not_settled'] = NOT_SETTLED_CIRCULATION
        return snap

    def _transfer_snapshot(self, c, did, chk, pay_with):
        """What paying deal `did` with a held note would sign, read and checked once (see prepare): the server offers
        circulation/1 and reports the tracker v3.2 contract (GET /info novation); the deal's payment options list a note of mine from the issuer `pay_with` names (an exact
        participant id first, else a handle only one listed issuer has); the issuer's and the payee's current directory
        keys; and a fresh transfer template for exactly that issuer and key, accepted by novation.evaluate_payer_template
        for the deal, terms and delivery `chk` checked (with one GET /edges read-back when D-1 needs one)."""
        if CIRCULATION not in self._remember(c.info()):
            raise vc.ValunError('feature_unavailable', 'this Valun server does not offer circulating credit (circulation/1)')
        problem = nv.contract_problem(getattr(c, '_novation', None))     # tracker v3.2, as Client.pay_by_transfer checks
        if problem:
            raise vc.ValunError('feature_unavailable', problem)
        option = self._held_note(c.payment_options(did), pay_with)
        iid = option['issuer']['id']
        issuer = self._current(c, iid)
        payee = self._current(c, chk['other_id'])
        me = c.me()
        mandate = next((me[k] for k in ('effective_limits', 'mandate') if isinstance(me, dict) and isinstance(me.get(k), dict)), None)
        tpl = c.transfer_template(did, iid)
        iss = tpl.get('issuer') if isinstance(tpl, dict) else None
        if not (isinstance(iss, dict) and iss.get('id') == iid and iss.get('pubkey') == issuer['pubkey']):
            raise vc.ValunError('bad_template', "the transfer template is not for that issuer under its current key")
        deal = nv.deal_context(chk['terms'], chk['terms_hash'], chk['sha256'])
        r = self._evaluate_payment(c, tpl, deal, payee['pubkey'], mandate)
        if not r['ok']:
            s = r.get('summary') or {}
            raise vc.ValunError(r['code'], s.get('reason') or r['code'],
                                extra={'retry_after_ms': s['retry_after_ms']} if s.get('retry_after_ms') is not None else None)
        before = tpl['to_edge'].get('before')
        return {'template': tpl, 'option': option, 'issuer': {'id': iid, 'handle': issuer.get('handle') or option['issuer'].get('handle'),
                                                               'pubkey': issuer['pubkey']},
                'payee': {'id': chk['other_id'], 'handle': payee.get('handle'), 'pubkey': payee['pubkey']},
                'quote_digest': r['summary']['quote_digest'], 'claim': tpl['from_edge']['before']['total'],
                'to_prior': before['total'] if isinstance(before, dict) else 0}

    @staticmethod
    def _held_note(opts, pay_with):
        """The payment option (a note I hold) `pay_with` names: an exact participant id first; a handle only when no id
        matches and exactly one listed issuer has it. unknown_issuer otherwise."""
        held = opts.get('held_notes') if isinstance(opts, dict) else None
        rows = [h for h in (held if isinstance(held, list) else []) if isinstance(h, dict) and isinstance(h.get('issuer'), dict)
                and isinstance(h['issuer'].get('id'), str) and h['issuer']['id']]
        for h in rows:
            if h['issuer']['id'] == pay_with:
                return h
        named = [h for h in rows if h['issuer'].get('handle') == pay_with]
        if len(named) == 1:
            return named[0]
        raise vc.ValunError('unknown_issuer', f'the payment options for this deal list no note of yours from {pay_with[:64]!r}')

    @staticmethod
    def _current(c, pid):
        """A participant's directory record, with its current (active) key."""
        p = c.participant(pid)
        if not (isinstance(p, dict) and p.get('status') == 'active' and isinstance(p.get('pubkey'), str) and p['pubkey']):
            raise vc.ValunError('counterparty_inactive', f'{pid} has no active registered key')
        return p

    def _evaluate_payment(self, c, tpl, deal, payee_pk, mandate):
        """novation.evaluate_payer_template on this profile's records as they are now, without recording anything (the
        client evaluates again, and records, when it signs). D-1: an earlier attempt whose edge must be read gets one
        GET /edges read-back (Client.sync_edges), as Client.pay_by_transfer does."""
        reload = getattr(c.store, 'reload', None)
        if callable(reload):
            reload()
        state = c.state
        pins = state.get('pins') if isinstance(state.get('pins'), dict) and state['pins'].get('tracker_nft_id') else None
        ctx = {'me_pk': c.pubkey, 'me_id': c.participant_id, 'now_ms': int(vc.time.time() * 1000), 'verify': _verify_hex,
               'pins': pins, 'records': state.get('records'), 'signed': state.get('signed'),
               'transfer_attempts': state.get('transfer_attempts'), 'novated_edges': state.get('novated_edges'),
               'features': list(self.features or []), 'consent_policy': state.get('consent_policy'), 'deal': deal,
               'payee_current_pk': payee_pk, 'approved_quote_digest': None, 'mandate': mandate, 'edges': None,
               'novation': getattr(c, '_novation', None)}
        r = nv.evaluate_payer_template(tpl, ctx)
        need = r['summary'].get('needs_read_back') if not r['ok'] and r['code'] == 'transfer_window_open' else None
        if need:
            try:
                fresh = c.sync_edges()
            except vc.ValunError:
                return r
            edges = dict(fresh['edges'])
            for e in need:
                if e not in fresh['doubtful']:
                    edges.setdefault(e, None)
            r = nv.evaluate_payer_template(tpl, dict(ctx, edges=edges))
        return r

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
            elif strict and (type(a[key]) is not type(value) or a[key] != value):     # 3.0 is not 3, True is not 1
                raise vc.ValunError(code, why)
        if name == 'valun_respond' and a.get('action') in ('accept', 'counter'):
            pin('expected_terms_hash', chk['terms_hash'], 'stale_terms', 'the offer changed after your agent read it')
        elif name == 'valun_review_delivery' and a.get('decision') == 'accept':
            pin('expected_deliverable_sha256', chk['sha256'], 'stale_delivery', 'the delivery changed after your agent read it')
            pin('expected_terms_hash', chk['terms_hash'], 'stale_terms', 'the agreed terms are not the ones your agent read')
            tr = snap.get('transfer')
            if tr is not None:              # paying with a held note: exactly the issuer, quote and claim shown
                a['pay_with'] = tr['issuer']['id']
                pin('expected_quote_digest', tr['quote_digest'], 'stale_quote', 'the payment changed after your agent read it')
                pin('expected_claim_total', tr['claim'], 'stale_claim', 'your claim on the issuer changed after your agent read it')
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
            return self._text_pay if self._pay_with(a) is not None else self._text_review
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
            snap.get('not_settled', NOT_SETTLED),
            quote_line('Offer text written by your agent', {k: a.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_accept(self, a, snap):
        chk = snap['checked']
        t, who, price, svc = chk['terms'], self._who(chk), chk['price'], chk['service']
        return '\n'.join([
            f"Valun - ACCEPT {who}'s offer ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}, version {shown(t.get('version'))}):",
            f"  you are the {ROLE_WORDS[chk['role']]}; price: {price} PC; deliver by {shown(t.get('deliver_by'))}",
            f"  terms hash {chk['terms_hash'][:16]}... (recomputed from these terms; your Valun client checks it again before signing)",
            'This makes the deal binding on both sides: ' + owes(chk['role'], who, price),
            snap.get('not_settled', NOT_SETTLED),
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
            snap.get('not_settled', NOT_SETTLED),
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
            snap.get('not_settled', NOT_SETTLED),
            quote_line('Delivery title and agreed service text', {'delivery_title': dl.get('title') or '', 'title': svc.get('title'),
                                                                  'deliverable': svc.get('deliverable')})])

    def _text_pay(self, a, snap):
        """A delivery acceptance paid with a held note (pay_with): what moves, from the checked transfer template."""
        chk, tr = snap['checked'], snap['transfer']
        t, svc, dl, content, price = chk['terms'], chk['service'], chk['delivery'], chk['content'], chk['price']
        payee = self._who(chk)
        iss = tr['issuer']
        issuer = shown(iss['handle']) if isinstance(iss.get('handle'), str) and iss['handle'] else shown(iss['id'])
        x, y = tr['claim'], tr['to_prior']
        speed = tr['option'].get('issuer_consents')
        m = measure.measure(content, ' '.join(str(svc.get(k) or '') for k in ('title', 'description', 'deliverable')), check_hosts=False)
        facts = [f"{x_['requirement']}: {x_['measured']} ({'met' if x_['met'] else 'NOT met'})" for x_ in m['checks_against_agreed_terms']]
        try:
            exact = sandbox.check_delivery(t, content)
        except Exception:  # noqa: BLE001 - a malformed result block is a fact to show, not a reason to hide the prompt
            exact = None
            facts.append('exact result: could not be checked')
        if exact and exact.get('checked'):
            facts.append('exact result: ' + ('matches the agreed text' if exact.get('exact_result_matches') else
                                             'DOES NOT MATCH (differs in ' + ', '.join(shown(k) for k in (exact.get('differs_in') or [])) + ')'))
        return '\n'.join([
            f"Valun - PAY {payee} {price} PC for deal {shown(t['deal_id'])} by moving {price} PC of {issuer}'s debt from you "
            f'to {payee}:',
            f'  your claim on {issuer}: {x} -> {x - price} PC (issuer signature checked by your client)',
            f'  {issuer} will owe {payee} {y} -> {y + price} PC; its total debt does not change',
            '  you issue no credit note for this deal',
            f'  {issuer} consents {CONSENT_SPEED_WORDS.get(speed, shown(speed))}; accepting is final: if the transfer does not '
            'complete the deal stays accepted and you pay later',
            f"  {issuer} is {shown(iss['id'])} and {payee} is {shown(chk['other_id'])}; quote {tr['quote_digest'][:16]}... "
            '(computed by your Valun client; it checks it again before signing)',
            f"  you accept the delivery: {len(content.encode('utf-8'))} bytes, sha256 {chk['sha256'][:16]}... (recomputed from "
            'the text measured here); agreed terms hash ' + chk['terms_hash'][:16] + '...',
            '  measured: ' + ('; '.join(facts) or f"{m['word_count']} words, {len(m['links'])} links"),
            snap.get('not_settled', NOT_SETTLED_CIRCULATION),
            quote_line('Delivery title and agreed service text', {'delivery_title': dl.get('title') or '', 'title': svc.get('title'),
                                                                  'deliverable': svc.get('deliverable')})])

    # ---------- tools ----------
    def status(self, a):
        brief = a.get('brief', self.brief_status) if isinstance(a, dict) else self.brief_status
        if not isinstance(brief, bool):
            raise vc.ValunError('bad_arguments', 'brief must be true or false')
        out = self._full_status()
        return brief_status(out) if brief else out

    def _full_status(self):
        c = self.client()
        me, info = c.me(), c.info()
        circulating = CIRCULATION in self._remember(info)
        lab = labels(circulating)
        recorded = me.get('agent_limits') or {}
        approvals = (self.approvals or 'Commitments are signed without asking your owner first.')
        approvals += f" The server also holds commitments priced above {me['mandate'].get('approve_above')} PC for the owner console."
        out = {'connected': True, 'server': c.state['server'], 'network': info['network'],
               'unit': info['unit'] + ' (pilot credits, no monetary value)',
               'you': me['participant'], 'objective_from_your_owner': me['mandate'].get('objective') or '(none set)',
               'goals_your_owner_told_you': recorded.get('notes') or '(none recorded yet: ask your owner, then use valun_set_limits)',
               'limits_you_recorded': {k: v for k, v in recorded.items() if k not in ('notes', 'set_at')},
               'limits_in_force': {arg: (me.get('effective_limits') or me['mandate']).get(field) for arg, (field, _k) in LIMIT_FIELDS.items()},
               'mandate': {k: v for k, v in me['mandate'].items() if k != 'objective'}, 'mandate_version': me['mandate_version'],
               'approvals': approvals, 'position': me['position'], 'authority': me['authority'], 'settlement': lab['settlement'],
               'honest_labels': lab['honest_labels'], 'real_vs_simulated': lab['real_vs_simulated']}
        if circulating:
            out.update(self._circulation_status(c, me))
        return out

    def _circulation_status(self, c, me):
        """valun_status with circulating credit: what you hold and owe, the notes you can spend (each checked against the
        issuer's signature on the tracker state GET /edges shows), payments in progress, what your client clears by
        itself, and for a sandbox_only participant the next tool calls of the five-step tour."""
        pos = me.get('position') if isinstance(me.get('position'), dict) else {}
        try:
            box = c.inbox()
        except vc.ValunError:
            box = {}
        box = box if isinstance(box, dict) else {}
        try:
            verified = c.sync_edges()['edges']
        except vc.ValunError:
            verified = {}
        notes = self._notes_you_can_spend(c, pos, verified)
        policy = consent_policy_in_force(c.state.get('consent_policy'),
                                         next((me[k] for k in ('effective_limits', 'mandate') if isinstance(me.get(k), dict)), None))
        signs = client_signs(policy)
        hold, owe, net = pos.get('claims_held'), pos.get('owes'), pos.get('net')
        cleared = pos.get('cleared_by_setoff', pos.get('settled', 0))
        pending = box.get('consents_waiting_for_your_client')
        if pending is None and isinstance(pos.get('pending'), dict):
            pending = pos['pending'].get('consents_waiting_for_you')
        log = c.state.get('consent_log') if isinstance(c.state.get('consent_log'), list) else []
        spend = sum(n['amount_PC'] for n in notes)
        summary = (f'You hold {shown(hold)} PC of credit notes others issued to you and owe {shown(owe)} PC (net {shown(net)} PC); '
                   f'set-offs have cleared {shown(cleared)} PC so far. '
                   + (f"You can spend {spend} PC of notes you hold ({', '.join(shown(n['issuer']) for n in notes)}) with pay_with "
                      'when you accept a delivery. ' if notes else 'You hold no notes you can spend now. ')
                   + ('Your Valun client signs by itself: ' + '; '.join(signs) + '.' if signs
                      else 'Your Valun client signs no consents by itself.')
                   + (f' {pending} consent(s) wait for your client.' if _whole(pending) and pending > 0 else ''))
        out = {'summary': summary,
               'money_view': {'you_hold_PC': hold, 'you_owe_PC': owe, 'net_PC': net, 'cleared_so_far_PC': cleared,
                              'how_to_read': ('hold: credit notes others issued to you that are still outstanding (what they '
                                              'owe you); owe: your own outstanding notes; net = hold - owe. Paying with a note '
                                              'you hold moves it to the payee (hold falls by the price); a set-off cancels equal '
                                              'claims and debts around a cycle (hold and owe fall together, net does not change); '
                                              'cleared_so_far counts what set-offs cancelled. Nothing is redeemed and PC have '
                                              'no value.')},
               'notes_you_can_spend': notes,
               'payments_in_progress': box.get('payments_in_progress') if isinstance(box.get('payments_in_progress'), list) else [],
               'clearing': {'your_client_signs': signs, 'consents_pending': pending,
                            'recent': [{k: e.get(k) for k in ('at', 'kind', 'decision', 'code', 'amount', 'your_net_change_PC')}
                                       for e in log[-5:] if isinstance(e, dict)]},
               'consent_policy_in_force': policy}
        participant = me.get('participant') if isinstance(me.get('participant'), dict) else {}
        if participant.get('sandbox_only') is True:
            out['sandbox_next_steps'] = self._sandbox_next_steps(c, participant, pos, box, notes)
        return out

    @staticmethod
    def _notes_you_can_spend(c, pos, verified):
        """The notes I hold that the server says I can spend now (position.spendable_notes; else the claims), each
        marked checked_by_your_client when the tracker state of that edge, as GET /edges showed it, carries the issuer's
        valid signature over a total that covers the amount."""
        rows = pos.get('spendable_notes')
        if not isinstance(rows, list):
            rows = [{'issuer_id': r.get('issuer_id'), 'issuer_handle': r.get('from'), 'issuer_pubkey': r.get('issuer_pubkey'),
                     'spendable': r.get('amount'), 'issuer_consents': None}
                    for r in (pos.get('claims') if isinstance(pos.get('claims'), list) else []) if isinstance(r, dict)]
        out = []
        for n in rows:
            if not isinstance(n, dict):
                continue
            amount = n.get('spendable')
            name = n.get('issuer_handle') or n.get('handle') or n.get('issuer_id')
            if not (_whole(amount) and amount > 0 and isinstance(name, str) and name):
                continue
            st = verified.get(f"{n.get('issuer_pubkey')}>{c.pubkey}") if isinstance(verified, dict) else None
            out.append({'issuer': name, 'amount_PC': amount,
                        'checked_by_your_client': isinstance(st, dict) and _whole(st.get('total')) and st['total'] >= amount,
                        'issuer_consents': n.get('issuer_consents'),
                        'how': f"valun_review_delivery decision='accept' pay_with={quoted(name)}: pays a delivery by moving that "
                               'much of their debt to you onto the payee'})
        return out

    def _sandbox_next_steps(self, c, participant, pos, box, notes):
        """The exact next tool calls of the five-step sandbox tour (design 9.2), from the inbox and the position: answer
        what waits for you first (an offer, a delivery to make, a delivery to review), then the next deal of the tour
        from what you hold and owe. Wait (no calls) while the sandbox agents or a set-off are working."""
        def amount(rows, key, who):
            return sum(r['amount'] for r in (rows if isinstance(rows, list) else [])
                       if isinstance(r, dict) and r.get(key) == who and _whole(r.get('amount')))
        hx, hm = amount(pos.get('claims'), 'from', SANDBOX_EXACT), amount(pos.get('claims'), 'from', SANDBOX_MALLORY)
        ox = amount(pos.get('debts'), 'to', SANDBOX_EXACT)
        spendable = {n['issuer']: n['amount_PC'] for n in notes}
        listed = {k: [x for x in (box.get(k) if isinstance(box.get(k), list) else [])
                      if isinstance(x, dict) and (x.get('counterparty') in SANDBOX_AGENTS or k == 'awaiting_your_owner')]
                  for k in ('respond', 'deliver', 'review_delivery', 'waiting_on_others', 'awaiting_your_owner', 'recent_closed')}
        held = {SANDBOX_EXACT: {'you_hold_PC': hx, 'you_owe_PC': ox}, SANDBOX_MALLORY: {'you_hold_PC': hm, 'you_owe_PC': 0}}

        def step_of(cp, role):
            if cp == SANDBOX_EXACT:
                return 1 if role == 'payee' else (5 if hm >= sandbox.SERVICES['notary']['price'] else 3)
            return 2 if role == 'payer' else 4

        def plan(step, calls, then):
            done = TOUR_AFTER.get(step) if isinstance(step, int) else None
            return {'tour_step': step, 'of': 5, 'goal': TOUR_GOALS.get(step, 'The tour is complete.'),
                    'next_calls': calls, 'then': then, 'with_the_sandbox_agents': held,
                    **({'when_done': {'you_hold_PC': done[0], 'you_owe_PC': done[1]}} if done else {})}

        def call(tool, args, why):
            return {'tool': tool, 'arguments': args, 'why': why}

        def offer(step, cp, role, service):
            price = sandbox.SERVICES[service]['price']
            args = {'counterparty': cp, 'role': role, 'title': f'{service} job',
                    'description': f'{service} for this text:\n```\n{TOUR_TEXTS[step]}\n```',
                    'deliverable': f'The exact {service} result as JSON.', 'price': price, 'deliver_within_hours': 24,
                    'offer_valid_hours': 1}
            why = (f'buy {service} from {cp} for {price} PC' if role == 'payer' else f'offer to sell {service} to {cp} for {price} PC')
            return plan(step, [call('valun_propose', args, why)],
                        f'{cp} answers within a few seconds; call valun_status again for the next step.')
        wait = 'The sandbox agents act within a few seconds: call valun_status again.'
        if listed['awaiting_your_owner']:
            x = listed['awaiting_your_owner'][0]
            return plan(None, [], f"Your owner must first approve deal {shown(x.get('deal_id'))} in the owner console; then call "
                                  'valun_status again.')
        for x in listed['review_delivery']:
            did, cp = x.get('deal_id'), x.get('counterparty')
            step = step_of(cp, 'payer')
            try:
                d = c.deal(did)
            except vc.ValunError as e:          # one deal that cannot be read now never fails the whole status
                return plan(step, [], f'Deal {shown(did)} could not be read just now ({shown(e.code)}); call valun_status '
                                      'again in a few seconds.')
            terms = ((d.get('current') or {}).get('terms') or {}) if isinstance(d, dict) else {}
            dl = (d.get('delivery') or {}) if isinstance(d, dict) else {}
            price = (terms.get('price') or {}).get('amount')
            try:
                exact = sandbox.check_delivery(terms, dl.get('content'))
            except Exception:  # noqa: BLE001 - an unreadable result block is a wrong one
                exact = {'checked': True, 'exact_result_matches': False, 'differs_in': ['the result block'],
                         'service': sandbox.which_service(terms)}
            if (isinstance(d, dict) and d.get('status') == 'payment_due') or (exact and exact.get('exact_result_matches')):
                other = SANDBOX_MALLORY if cp == SANDBOX_EXACT else SANDBOX_EXACT
                pay = other if _whole(price) and spendable.get(other, 0) >= price else 'own_note'
                args = {'deal_id': did, 'decision': 'accept', 'expected_deliverable_sha256': dl.get('sha256'), 'pay_with': pay}
                why = ('the delivery matches the exact result of the agreed text: accept it and pay '
                       + ('with your own credit note' if pay == 'own_note' else f'with the note {pay} issued to you'))
                return plan(step, [call('valun_review_delivery', args, why)],
                            'Payment by transfer applies at once with the sandbox agents; call valun_status again.')
            fields = ', '.join(str(k) for k in ((exact or {}).get('differs_in') or ['the result']))
            reason = (f"The delivered result does not match the exact {(exact or {}).get('service') or 'result'} of the agreed "
                      f'text (differs in: {fields}).')
            return plan(step, [call('valun_review_delivery', {'deal_id': did, 'decision': 'dispute', 'reason': reason},
                                    'the delivery is wrong: dispute it (nothing is paid), then buy again')],
                        'After the dispute, call valun_status again: the next call buys again.')
        for x in listed['deliver']:
            return plan(step_of(x.get('counterparty'), 'payee'),
                        [call('valun_deliver', {'deal_id': x.get('deal_id'), 'exact_result': True},
                              'deliver the exact result your Valun client computes from the agreed text')],
                        f"{x.get('counterparty')} checks it exactly and pays within a few seconds; call valun_status again.")
        for x in listed['respond']:
            role, price = x.get('your_role'), (x.get('price') or {}).get('amount') if isinstance(x.get('price'), dict) else None
            ok = role == 'payee' or (_whole(price) and price <= max(s['price'] for s in sandbox.SERVICES.values()))
            args = ({'deal_id': x.get('deal_id'), 'action': 'accept'} if ok else
                    {'deal_id': x.get('deal_id'), 'action': 'decline', 'reason': 'above the published price'})
            return plan(step_of(x.get('counterparty'), role),
                        [call('valun_respond', args, 'accept the offer (your Valun client checks its signature and terms)'
                              if ok else 'decline: the price is above the published one')],
                        'Then deliver (or wait for the delivery); call valun_status again.')
        if listed['waiting_on_others']:
            x = listed['waiting_on_others'][0]
            return plan(step_of(x.get('counterparty'), x.get('your_role')), [], wait)
        deals = pos.get('deals') if isinstance(pos.get('deals'), dict) else {}

        def count(bucket):
            return deals[bucket] if _whole(deals.get(bucket)) and deals[bucket] > 0 else 0
        # A deal agreed and not yet paid (position bucket agreed_note_not_issued) that no inbox list above shows: its
        # credit note is being recorded (the inbox lists issuing_note in no section, nor note_failed for the payee), or
        # it was paid between the GET /me these holdings come from and the GET /inbox read after it. Either way its note
        # is not in the holdings yet: wait, never start another deal on them (that sold a second job to sandbox-exact).
        if count('agreed_note_not_issued'):
            return plan(4 if ox > 0 else 1, [], 'A deal of yours with a sandbox agent is being paid (its credit note is being '
                                                 'recorded on the tracker); wait for it: call valun_status again in a few seconds.')
        if (hx > 0 or hm > 0) and ox > 0:
            return plan(3 if hx > 0 else 4, [], ('A set-off of the cycle is due: your Valun client signs it by itself at its '
                                                 'next consent run (within about a minute). Call valun_status again.'))
        notary = sandbox.SERVICES['notary']['price']
        paid_by_transfer = count('paid_by_transfer')
        cleared = pos.get('cleared_by_setoff', pos.get('settled', 0))
        cleared = cleared if _whole(cleared) and cleared > 0 else 0
        if hm >= notary:
            return offer(5, SANDBOX_EXACT, 'payer', 'notary')
        if hx >= notary and paid_by_transfer == 0:
            return offer(2, SANDBOX_MALLORY, 'payer', 'notary')
        if hx > 0:                              # once step 2 paid by transfer: pay sandbox-exact with your own note
            return offer(3, SANDBOX_EXACT, 'payer', 'notary')
        if ox > 0:
            return offer(4, SANDBOX_MALLORY, 'payee', 'text-stats')
        if paid_by_transfer > 0 and cleared > 0:
            return plan('done', [], self._tour_done_text(pos, cleared))
        any_exact = any(x.get('counterparty') == SANDBOX_EXACT for k in listed for x in listed[k])
        if not any_exact and recently_active(None, hours=10 / 60, joined_at=participant.get('joined_at')):
            return plan(1, [], 'The welcome job from sandbox-exact usually arrives within a minute of joining; call '
                               'valun_status again.')
        p = offer(1, SANDBOX_EXACT, 'payee', 'text-stats')
        if paid_by_transfer > 0:                # spent by transfer, but no set-off has cleared anything: not done yet
            p['then'] = ('The tour is not complete: no set-off has cleared any of your claims or debts yet, and you hold no '
                         "note to spend now. Earn sandbox-exact's note again; then pay sandbox-exact with your own note, and "
                         'the 2-cycle that forms is cleared by a set-off. sandbox-exact answers within a few seconds; call '
                         'valun_status again for the next step.')
        return p

    @staticmethod
    def _tour_done_text(pos, cleared):
        """What the tour did, from the participant's own position: earned (hold + spent by transfer + cleared), spent by
        transfer (transferred_out) and with its own notes (owes + cleared), and what set-offs cleared. Only a set-off
        that cleared something (cleared > 0) ends the tour, so this never claims one that did not happen."""
        hold, owe, out = pos.get('claims_held'), pos.get('owes'), pos.get('transferred_out')
        text = 'The tour is complete: '
        if _whole(hold) and _whole(owe) and _whole(out):
            text += (f'you earned {hold + out + cleared} PC and spent {out + owe + cleared} PC ({out} by transfer, '
                     f'{owe + cleared} with your own note), and ')
        text += (f'set-offs cancelled {cleared} PC of your claims and {cleared} PC of your debts without changing your net '
                 'position.')
        if (_whole(hold) and hold > 0) or (_whole(owe) and owe > 0):
            text += f' You still hold {shown(hold)} PC and owe {shown(owe)} PC.'
        return text + ' You can keep trading with the sandbox agents.'

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
        elif st == 'paying_by_transfer':
            out['whose_turn'] = ('theirs: the issuer and the payee sign the debt transfer that pays this deal (your Valun client '
                                 'signed your part)' if d.get('your_role') == 'payer' else
                                 'theirs: the debt transfer that pays you collects its signatures (your Valun client signs '
                                 'yours by itself if your owner allows it)')
        elif st == 'payment_due':
            out['whose_turn'] = ('yours: you accepted the delivery but it is not paid yet; pay it with valun_review_delivery '
                                 "decision='accept' (see how_you_can_pay)" if d.get('your_role') == 'payer' else
                                 'theirs: the payer accepted your delivery and must still pay it')
        elif st == 'paid_by_transfer':
            out['whose_turn'] = 'nobody: the deal is paid by debt transfer'
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
        if d.get('payment') is not None:           # circulating credit: the payment by transfer, as the server shows it
            out['payment'] = d['payment']
        if d.get('your_role') == 'payer' and st in PAYABLE and self._offers_circulation(c, d):
            try:
                out['how_you_can_pay'] = self._how_you_can_pay(c, a['deal_id'])
            except vc.ValunError as e:
                out['how_you_can_pay'] = {'problem': e.code, 'message': str(e)}
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

    def _offers_circulation(self, c, d=None):
        """Does the server offer circulation/1, for valun_deal? The features this agent already knows when it knows them;
        else one GET /info, only for a deal view that carries the `payment` key (a server shows it only with circulation
        on: with it off, valun_deal makes no request more than 0.3; decision D-2 h). False when /info cannot be read:
        the view is then as without circulation."""
        if self.features is not None:
            return CIRCULATION in self.features
        if not (isinstance(d, dict) and 'payment' in d):
            return False
        try:
            return CIRCULATION in self._remember(c.info())
        except vc.ValunError:
            return False

    @staticmethod
    def _how_you_can_pay(c, deal_id):
        """The payer's ways to pay a delivered (or note_failed, payment_due) deal, from GET payment-options: the own note
        and each note held, with the exact pay_with value. The server's view, for choosing: what is finally signed is
        checked again by the client (and asked of the owner with its own text)."""
        opts = c.payment_options(deal_id)
        opts = opts if isinstance(opts, dict) else {}
        own = opts.get('own_note') if isinstance(opts.get('own_note'), dict) else {}
        options = [{'pay_with': 'own_note', 'available': own.get('available') is True, 'why_not': own.get('why_not')}]
        for h in opts.get('held_notes') if isinstance(opts.get('held_notes'), list) else []:
            if not isinstance(h, dict) or not isinstance(h.get('issuer'), dict):
                continue
            iss = h['issuer']
            options.append({'pay_with': iss.get('handle') or iss.get('id'), 'issuer_id': iss.get('id'),
                            'operator_run': iss.get('operator_run'), 'spendable_PC': h.get('spendable'), 'enough': h.get('enough'),
                            'payee_accepts': h.get('payee_accepts'), 'issuer_consents': h.get('issuer_consents'),
                            'payee_consents': h.get('payee_consents'),
                            'available': h.get('why_not') is None and h.get('enough') is True, 'why_not': h.get('why_not')})
        return {'options': options, 'pending_transfer': opts.get('pending_transfer'), 'fallback_after': opts.get('fallback_after'),
                'how': ("valun_review_delivery decision='accept' with pay_with set to an available option (own_note issues your "
                        'own credit note; a handle passes on a note you hold). Accepting is final: if a transfer does not '
                        'complete, the deal stays accepted and you pay later.')}

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
        exact = a.get('exact_result')
        if exact is not None and not isinstance(exact, bool):
            raise vc.ValunError('bad_arguments', 'exact_result is true or false')
        if exact:
            if a.get('content') is not None:
                raise vc.ValunError('bad_arguments', 'with exact_result your Valun client computes the content: omit content')
            return self._deliver_exact(c, a)
        if not isinstance(a.get('content'), str) or not a['content']:
            raise vc.ValunError('bad_arguments', 'give content (the complete deliverable), or exact_result=true for a text-stats '
                                                 'or notary job')
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

    @staticmethod
    def _deliver_exact(c, a):
        """valun_deliver exact_result: the exact text-stats or notary result of the agreed text (the agreement's terms,
        checked by hash and both signatures), rendered as sandbox.render() does and delivered. not_exact_service for any
        other job, or when the agreed description carries no text to process."""
        d = c.deal(a['deal_id'])
        terms = c.verified_agreement(d)
        service = sandbox.which_service(terms)
        text = sandbox.extract_text((terms.get('service') or {}).get('description')) if service else None
        if service is None or text is None:
            raise vc.ValunError('not_exact_service', 'exact_result is for text-stats and notary jobs whose agreed description '
                                                     'carries the text; nothing was sent')
        result = sandbox.COMPUTE[service](text)
        r = c.deliver(a['deal_id'], sandbox.render(service, result, text), a.get('title') or f'{service} result')
        return {'deal_id': r['id'], 'status': r['status'], 'sha256': r['delivery']['sha256'],
                'exact_result': {'service': service, 'result': result},
                'what_happened': (f'Delivered and signed: the exact {service} result your Valun client computed from the agreed '
                                  'text. The payer can recompute it, then accepts it (paying you) or disputes it.')}

    def review(self, a):
        if a.get('decision') not in ('accept', 'dispute'):
            raise vc.ValunError('bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed")
        c = self.client()
        if a['decision'] == 'dispute':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a dispute needs a reason')
            r = c.dispute(a['deal_id'], a['reason'])
            return {'deal_id': r['id'], 'status': r['status'], 'what_happened': 'Disputed. No credit note was issued; the dispute is recorded.'}
        issuer = self._pay_with(a)
        if issuer is not None:
            return self._review_pay_with(c, a, issuer)
        r = c.complete(a['deal_id'], a.get('expected_deliverable_sha256'), a.get('expected_terms_hash'))
        n = r.get('credit_note') or {}
        if r['status'] == 'completion_awaiting_owner':
            msg = 'You accepted the delivery and signed the credit note; your owner must approve before it is issued to the tracker.'
        elif r['status'] == 'note_issued':
            msg = (f"Credit note issued: the Basis tracker now records that you owe {r['counterparty']['handle']} "
                   f"{(n.get('tracker_note') or {}).get('amount_collected')} PC in total (this deal added {n.get('amount')}). "
                   + labels(self._circulating(c))['settlement'])
        else:
            msg = r['status']
        return {'deal_id': r['id'], 'status': r['status'], 'what_happened': msg,
                'credit_note': {'state': n.get('state'), 'amount_PC': n.get('amount'), 'tracker_status': n.get('tracker_status'),
                                'confirmation': (n.get('tracker_note') or {}).get('confirmation'), 'settled': False}}

    def _review_pay_with(self, c, a, issuer):
        """valun_review_delivery accept with pay_with: Client.pay_by_transfer under the pins prepare() took (the delivery,
        the quote and my claim on the issuer)."""
        claim = a.get('expected_claim_total')
        if claim is not None and not (_whole(claim) and claim >= 0):
            raise vc.ValunError('bad_arguments', 'expected_claim_total is the whole number of PC of your claim that your '
                                                 'owner saw; nothing was signed')
        r = c.pay_by_transfer(a['deal_id'], issuer, expected_deliverable_sha256=a.get('expected_deliverable_sha256'),
                              expected_quote_digest=a.get('expected_quote_digest'),
                              expected_claim_total=claim)
        self._remember(c)
        st = r.get('status') if isinstance(r, dict) else None
        cp = (r.get('counterparty') or {}).get('handle') if isinstance(r, dict) and isinstance(r.get('counterparty'), dict) else None
        pay = r.get('payment') if isinstance(r, dict) and isinstance(r.get('payment'), dict) else {}
        iss = (pay.get('issuer') or {}).get('handle') if isinstance(pay.get('issuer'), dict) else None
        price = ((((r.get('current') or {}).get('terms') or {}).get('price') or {}).get('amount')) if isinstance(r, dict) else None
        who, by, amount = cp or 'the payee', iss or issuer, price if _whole(price) else 'the price in'
        msgs = {'paid_by_transfer': (f'Paid by debt transfer: {by} now owes {who} {amount} PC more and you {amount} PC '
                                     'less; you issued no credit note for this deal. ' + CIRCULATION_SETTLEMENT),
                'paying_by_transfer': ('You accepted the delivery and signed the debt transfer; it applies once the issuer and '
                                       'the payee sign. Accepting is final: if it does not complete, the deal stays accepted and '
                                       'you pay later.'),
                'completion_awaiting_owner': ('You accepted the delivery and signed the debt transfer; your owner must approve it '
                                              'in the owner console before it is submitted.'),
                'payment_due': ('The transfer did not apply: the delivery stays accepted and the deal is payment_due. Pay it '
                                'again (valun_deal how_you_can_pay).')}
        return {'deal_id': r.get('id') if isinstance(r, dict) else a['deal_id'], 'status': st, 'what_happened': msgs.get(st, st),
                'payment': pay or None}
