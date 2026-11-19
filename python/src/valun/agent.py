"""The Valun agent tools, independent of any agent framework.

Every adapter (the MCP server, the `valun call` CLI, the Hermes plugin) exposes the same tools through this
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
from . import fences
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
PAY_THIRD_PARTY_CIRCULATION = ("Supported: paying a third party with your OWN credit note, or with a note you hold "
                               "(pay_with: the issuer's debt to you moves to the payee; the issuer, you and the payee "
                               "each sign, and the issuer's total debt does not change), and set-offs that cancel "
                               'equal debts around a cycle (every party signs; no net position changes). A payee may '
                               'require that the claims of whoever issued the note it receives cover it '
                               '(min_payer_coverage_pct). ')
HONEST_LABELS_CIRCULATION = {
    'what_basis_records': ('The pilot Basis tracker keeps one running total per key pair: what the issuer key owes the '
                           'recipient key, with a timestamp, signed by the issuer. A credit note raises it; with circulating '
                           'credit a debt transfer moves part of it to a new creditor and a set-off lowers the totals around '
                           'a cycle, each signed by every party whose total changes. The tracker has no blockchain '
                           'connection (notes stay local_only) and no reserve backs the notes.'),
    'outstanding_promise': CIRCULATION_SETTLEMENT,
    'third_party': PAY_THIRD_PARTY_CIRCULATION + 'Not supported: redeeming a note for anything outside the pilot.',
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
# The same labels on the Valun testnet network (valun-testnet-1): word for word the server's testnet deal labels
# (lib/pilot/core.mjs SETTLEMENT_TESTNET, CIRCULATION_SETTLEMENT_TESTNET). There a creditor can redeem a note on Ergo
# testnet against its issuer's reserve, the tracker anchors its totals on Ergo testnet, and tERG have no monetary value.
# A netting is committed by the next tracker box, not final: it stays committed only as long as the tracker key never
# commits an earlier total again (valun-app e18eb73, the server's label since Nov 16; fix inbox #85, #100, #136 item 7;
# skill.md, Trust model).
TESTNET = 'valun-testnet-1'
TESTNET_REDEMPTION = ("Its creditor can redeem it on Ergo testnet against the issuer's tERG reserve, if the issuer posted "
                      'one; tERG are test coins with no monetary value.')
SETTLEMENT_TESTNET = 'not settled until redeemed: issuing a credit note creates an outstanding obligation. ' + TESTNET_REDEMPTION
CIRCULATION_SETTLEMENT_TESTNET = ('not settled until redeemed: a credit note is an outstanding obligation. With circulating '
                                  'credit it can move to a new creditor (debt transfer, signed by the debtor and both '
                                  'creditors) or be cancelled against an equal opposite obligation (set-off, signed by every '
                                  'party; no net position changes); a netting is committed once a tracker box on Ergo '
                                  'testnet commits it, and stays committed only as long as the tracker key never commits '
                                  'an earlier total again. ' + TESTNET_REDEMPTION)
_TESTNET_TRACKER = ('The Valun testnet Basis tracker keeps one running total per key pair: what the issuer key owes the '
                    'recipient key, with a timestamp, signed by the issuer, and anchors them on Ergo testnet (a tracker box '
                    'commits the digest of every total). ')
_TESTNET_BACKING = "A note is backed only by its issuer's reserve on Ergo testnet, if the issuer posted one."
HONEST_LABELS_TESTNET = {
    'what_basis_records': _TESTNET_TRACKER + 'A credit note raises a total. ' + _TESTNET_BACKING,
    'outstanding_promise': SETTLEMENT_TESTNET,
    'third_party': HONEST_LABELS['third_party'],
}
HONEST_LABELS_CIRCULATION_TESTNET = {
    'what_basis_records': (_TESTNET_TRACKER + 'A credit note raises a total; with circulating credit a debt transfer moves '
                           'part of it to a new creditor and a set-off lowers the totals around a cycle, each signed by every '
                           'party whose total changes. ' + _TESTNET_BACKING),
    'outstanding_promise': CIRCULATION_SETTLEMENT_TESTNET,
    'third_party': PAY_THIRD_PARTY_CIRCULATION + "A creditor redeems a note only against its issuer's reserve on Ergo testnet, in tERG.",
}
REAL_VS_SIMULATED_TESTNET = {
    'real': ("signatures by each participant's own key; Valun's acceptance and approval records; credit notes held by a "
             'real Basis tracker (read back and reconciled by Valun) and anchored on Ergo testnet; reserves and '
             'redemptions are Ergo testnet transactions'),
    'simulated': 'the value: tERG are Ergo testnet coins with no monetary value',
    'not_proven': ('that delivered work is good (Valun records statements, it does not judge work); that any participant '
                   'will honour a credit note beyond its reserve'),
}
REAL_VS_SIMULATED_CIRCULATION_TESTNET = {
    'real': ("signatures by each participant's own key; Valun's acceptance and approval records; credit notes, debt "
             'transfers and set-offs held by a real Basis tracker (read back and reconciled by Valun, and checked by your '
             'client against the signatures) and anchored on Ergo testnet; reserves and redemptions are Ergo testnet '
             'transactions'),
    'simulated': REAL_VS_SIMULATED_TESTNET['simulated'],
    'not_proven': REAL_VS_SIMULATED_TESTNET['not_proven'],
}
# What a unit is, after its name (valun_status unit), and the last words of how to read the money view.
UNIT_WORDS = {'PC': ' (pilot credits, no monetary value)', 'nanoERG': ' (of tERG: Ergo testnet coins with no monetary value)'}
VALUE_WORDS = {'PC': 'Nothing is redeemed and PC have no value.',
               'nanoERG': "A creditor can redeem a note on Ergo testnet against its issuer's reserve, if it has one; tERG "
                          'have no monetary value.'}
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
# prepare() failures that keep their own code and setup hint instead of approval_unbound (still nothing is signed): a
# redirect, a plain-http server and another server than the profile's too (the RC's review), which no read again changes
# and only the owner can; and tls_unverified, which only the JS client raises (certificate checks off in its process: the
# RC's review, round 3), as its agent's list has it.
UNBOUND_PASS_THROUGH = ('not_connected', 'not_configured', 'tracker_mismatch', 'redirected', 'plain_http', 'wrong_server',
                        'tls_unverified')
# A profile of the pilot network, retired on 2026-11-13 (fix inbox #30), on a server that now serves another network:
# that server knows neither its participant nor its key, nor the tracker it pinned, so its calls meet these refusals
# (JavaScript's client says wrong_tracker for a pin it was given). ValunAgent.retired() answers network_retired instead,
# with how to join again: in a new profile (rejoin_hint), since this one holds an identity of the old network.
RETIRED_CODES = ('unauthorized', 'not_connected', 'tracker_mismatch', 'wrong_network', 'wrong_tracker')
DEFAULT_REJOIN_HINT = ('join in a new profile, in a terminal: `valun --profile NAME join --sandbox --handle HANDLE '
                       '--operator "YOUR NAME" --owner-token-file FILE` (NAME: a profile name not used yet; HANDLE: '
                       'public and permanent; FILE: a new file for its owner token)')
# approval_unbound's what_this_means when its cause is unknown_participant: the handle (or id) a commitment names is in no
# entry of the network's directory, so reading the deal again cannot help (the 0.7.2 clean-user test: house-scribe, on
# a server that has none).
UNKNOWN_PARTICIPANT_TEXT = ('Nothing was signed and your owner was not asked: no participant with that handle exists on '
                            'this network. Find the one you mean with valun_directory, and use the handle it lists.')


def retired_text(network, rejoin_hint=DEFAULT_REJOIN_HINT):
    """network_retired's what_this_means: the profile's pilot network was retired, and the server serves `network`."""
    return (f"This agent's profile joined the pilot network ({vc.NETWORK}), which was retired on "
            f'{vc.PILOT_RETIRED_ON}: the Valun server now serves {network}, which knows neither this participant nor '
            f'its key. Nothing was signed. Its owner must use a profile on {network}: {rejoin_hint}.')


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


def tour_goal(step, unit=vc.UNIT, scale=1):
    """TOUR_GOALS[step] in a network's unit: its prices and cycle amounts are PC-sized (times the scale)."""
    goal = TOUR_GOALS.get(step, 'The tour is complete.')
    return goal if unit == 'PC' else re.sub(r'\b(\d+) PC\b', lambda m: vc.amount_text(int(m.group(1)) * scale, unit), goal)


# What you hold / owe (PC-sized, times the scale) once each step is done, as tracker totals (design 9.2).
TOUR_AFTER = {1: (3, 0), 2: (1, 0), 3: (0, 1), 4: (2, 0), 5: (0, 0)}
# How long a tour step asks the agent to wait before calling valun_status again (fix-inbox #8): the sandbox agents act
# within a few seconds; an owner approval takes a person; a 3-cycle whose third leg is missing (blocked:
# cycle_leg_missing) waits for another participant's payment; a set-off that is due is signed at the client's next
# consent run, at most once a minute (0.7.2: 15 s, not the sandbox agents' 5 s).
SANDBOX_RETRY_S, OWNER_RETRY_S, CYCLE_LEG_RETRY_S, SETOFF_DUE_RETRY_S = 5, 60, 30, 15
# The tour's end, kept in the profile: state[TOUR_DONE_KEY] is the participant id whose tour valun_status saw done.
# sandbox_next_steps reads the step from what the participant holds and owes with the sandbox agents, so a deal with them
# after the tour (`valun sandbox earn`) made it step 3 again, and `valun sandbox tour` started over there (the 0.7.2
# clean-user test). Once the end is kept, sandbox_next_steps stays done, with TOUR_COMPLETED.
TOUR_DONE_KEY = 'sandbox_tour_done'
TOUR_COMPLETED = ('The tour is complete. Deals with the sandbox agents from now on are not tour steps: valun_inbox shows '
                  'what waits for you, as with any agent. You can keep trading with the sandbox agents.')


BRIEF_NOTE = ('PC are pilot credits with no monetary value: a credit note is an outstanding promise, and nothing is redeemed. '
              'This is the brief view; call valun_status with brief=false for your mandate, consent policy and honest labels.')
BRIEF_NOTE_TESTNET = ('Amounts are nanoERG of tERG, Ergo testnet coins with no monetary value: a credit note is an outstanding '
                      "promise, which its creditor can redeem on Ergo testnet against the issuer's reserve, if it has one. "
                      'This is the brief view; call valun_status with brief=false for your mandate, consent policy and '
                      'honest labels.')


def self_serve_words(participant, info):
    """valun_status's words for a self-serve participant (sandbox_only: true), from the server's GET /info self_serve
    (open_network, renews_while_active) and the participant's sandbox_expires_at, or None for another participant. The
    Nov 18 fresh-join run (finding 5): the join note said "Open network: you can deal with any agent", and the record
    said sandbox_only: true, a name left from the boxed sandbox that limits nothing on an open network."""
    p = participant if isinstance(participant, dict) else {}
    if p.get('sandbox_only') is not True:
        return None
    ss = info.get('self_serve') if isinstance(info, dict) and isinstance(info.get('self_serve'), dict) else {}
    until = p.get('sandbox_expires_at')
    when = (f' until {shown(until)}' + (', renewed while your agent is active' if ss.get('renews_while_active') is True
                                        else '')) if isinstance(until, str) and until else ''
    if ss.get('open_network') is True:
        return ('A self-serve participant on the open network: you can deal with any agent whose owner allows it, within '
                f'small limits (limits_in_force){when}. sandbox_only: true says you joined without an invite; on this '
                'network it does not limit whom you deal with.')
    if ss.get('open_network') is False:
        return ('A self-serve sandbox participant: you can deal only with the sandbox agents (sandbox-exact and '
                f'sandbox-mallory), within small limits (limits_in_force){when}.')
    return f'A self-serve participant (sandbox_only: true: you joined without an invite), within small limits (limits_in_force){when}.'


def guarantees_waiting(g):
    """valun_status: the guarantees waiting for this agent, from the inbox's guarantees section (fix inbox #18): offers
    to answer as creditor, calls to honor as backer, and the guarantees it holds that are due (callable only while the
    issuer still owes it: valun_guarantees shows callable_now). None when nothing waits."""
    if not isinstance(g, dict):
        return None

    def rows(k):
        return [x for x in (g.get(k) if isinstance(g.get(k), list) else []) if isinstance(x, dict)]
    out = {'to_answer': [{k: x.get(k) for k in ('guarantee_id', 'backer', 'issuer', 'cap', 'due_at', 'expires_at')} for x in rows('to_answer')],
           'to_honor': [{k: x.get(k) for k in ('guarantee_id', 'call_id', 'amount', 'creditor', 'honor_by', 'overdue')} for x in rows('to_honor')],
           'due': [{k: x.get(k) for k in ('guarantee_id', 'backer', 'issuer', 'cap', 'expires_at')} for x in rows('active')
                   if x.get('your_role') == 'creditor' and x.get('due') is True and x.get('call_open') is not True]}
    if not any(out.values()):
        return None
    out['how'] = ("valun_guarantees shows each one. valun_respond_guarantee action='accept' or 'decline' answers an offer; "
                  "action='honor' pays a call with your own credit note. valun_call_guarantee calls a due one, only if the "
                  'issuer still owes you (callable_now).')
    return out


def guarantee_brief(g):
    """What the guarantee tools show of one guarantee view: its state and parties, the amounts, the calls."""
    if not isinstance(g, dict):
        return g
    out = {k: g.get(k) for k in ('guarantee_id', 'state', 'your_role') if k in g}
    for r in ('backer', 'issuer', 'creditor'):
        if isinstance(g.get(r), dict):
            out[r] = g[r].get('handle') or g[r].get('id')
    out.update({k: g.get(k) for k in ('unit', 'cap', 'claimed', 'honored', 'remaining_cap', 'issuer_owes_creditor', 'callable_now',
                                      'recovered_for_backer', 'due_at', 'expires_at', 'honor_within_hours', 'offer_expires_at', 'note',
                                      'next_actions', 'terms_hash') if k in g})
    out['calls'] = [{k: c.get(k) for k in ('call_id', 'amount', 'state', 'called_at', 'honor_by', 'overdue', 'honored_at', 'late', 'error')
                     if c.get(k) is not None} for c in (g.get('calls') or []) if isinstance(c, dict)]
    return out


def brief_status(out):
    """valun_status's brief view (brief=true, for small models), made from the full view, so it reads and signs exactly
    the same: who you are, your owner's objective and goals, the limits in force, where approvals happen, what you hold
    and owe (and the room your mandate leaves, where GET /me shows it), the notes you can spend, the payments and
    consents in progress, the next sandbox step, and one line on what PC are (the honest labels stay in the full view)."""
    def d(v):
        return v if isinstance(v, dict) else {}
    you, pos = d(out.get('you')), d(out.get('position'))
    b = {'brief': True, 'connected': out.get('connected'),
         'you': {k: you.get(k) for k in ('id', 'handle', 'sandbox_expires_at') if you.get(k) is not None},
         **({'you_are': out['you_are']} if isinstance(out.get('you_are'), str) else {}),
         'objective_from_your_owner': out.get('objective_from_your_owner'),
         'goals_your_owner_told_you': out.get('goals_your_owner_told_you'),
         'limits_in_force': out.get('limits_in_force'), 'approvals': out.get('approvals'),
         'you_hold_PC': pos.get('claims_held'), 'you_owe_PC': pos.get('owes'), 'net_PC': pos.get('net')}
    if isinstance(out.get('room'), dict):
        b['room'] = out['room']
    if 'notes_you_can_spend' in out:
        b['notes_you_can_spend'] = [{k: n.get(k) for k in ('issuer', 'amount_PC', 'checked_by_your_client')}
                                    for n in (out.get('notes_you_can_spend') or []) if isinstance(n, dict)]
        b['payments_in_progress'] = len(out.get('payments_in_progress') or [])
        b['consents_pending'] = d(out.get('clearing')).get('consents_pending')
    if out.get('guarantees_waiting'):
        b['guarantees_waiting'] = out['guarantees_waiting']
    step = out.get('sandbox_next_steps')
    if isinstance(step, dict):
        keys = ('tour_step', 'next_calls', 'then', 'blocked', 'retry_after_seconds')
        b['sandbox_next_steps'] = {k: step[k] for k in keys if k in step}
    b['note'] = BRIEF_NOTE_TESTNET if out.get('network') == TESTNET else BRIEF_NOTE
    return b


def labels(circulating, network=None):
    """The honest labels for a server with circulating credit (True) or without it, on `network` (the pilot unless it
    is valun-testnet-1): {settlement, not_settled, honest_labels, real_vs_simulated}."""
    if network == TESTNET:
        if circulating:
            return {'settlement': CIRCULATION_SETTLEMENT_TESTNET, 'not_settled': CIRCULATION_SETTLEMENT_TESTNET,
                    'honest_labels': HONEST_LABELS_CIRCULATION_TESTNET, 'real_vs_simulated': REAL_VS_SIMULATED_CIRCULATION_TESTNET}
        return {'settlement': SETTLEMENT_TESTNET, 'not_settled': SETTLEMENT_TESTNET, 'honest_labels': HONEST_LABELS_TESTNET,
                'real_vs_simulated': REAL_VS_SIMULATED_TESTNET}
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


def client_signs(policy, unit=vc.UNIT):
    """consent_policy_in_force() as sentences: what the client signs by itself, without asking the owner."""
    cap = policy.get('max_PC')
    upto = f', up to {vc.amount_text(cap, unit)} each' if _whole(cap) else ''
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
READ_ONLY_TOOLS = ('valun_status', 'valun_directory', 'valun_inbox', 'valun_deal', 'valun_guarantees', 'valun_check_payer')
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
_GUARANTEE_ID = re.compile(r'vg_[0-9a-f]{16}')
_CALL_ID = re.compile(r'vgc_[0-9a-f]{16}')


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


_APPROVAL_ID_RE = re.compile(r'va_[0-9a-f]{12}')


def owner_wait(c, r, deal_id, command=None, kind='deal'):
    """Where and what this participant's owner approves, for an answer that waits for them (the newcomer tests,
    2026-11-17: valun_propose, valun_respond and valun_review_delivery said the owner must approve, not where, nor which
    approval): (words, fields). words: ' in the owner console, <server>/pilot#owner (deal vd_..., approval va_...)',
    and with `command` (the terminal command that opens that console for this profile, `valun console`: the agent's
    console_command) '; in a terminal, `<command>` opens it'. fields: owner_console; approval_id when the server's
    answer names one pending approval of this participant for this deal (approval_ids when it names several); and
    console_command. kind: what deal_id names ('deal', or 'guarantee' for a guarantee offer)."""
    state = getattr(c, 'state', None)
    server = state.get('server') if isinstance(state, dict) else None
    server = server.rstrip('/') if isinstance(server, str) else ''
    rows = r.get('approvals') if isinstance(r, dict) and isinstance(r.get('approvals'), list) else []
    ids = sorted({a['id'] for a in rows if isinstance(a, dict) and a.get('state') == 'pending'
                  and isinstance(a.get('id'), str) and _APPROVAL_ID_RE.fullmatch(a['id'])})
    fields = {}
    if server:
        fields['owner_console'] = f'{server}/pilot#owner'
    if len(ids) == 1:
        fields['approval_id'] = ids[0]
    elif ids:
        fields['approval_ids'] = ids
    opens = ''
    if isinstance(command, str) and command:
        fields['console_command'] = command
        opens = f'; in a terminal, `{command}` opens it'
    which = ', '.join([f'{kind} {shown(deal_id)}'] + [f'approval {i}' for i in ids])
    where = f' in the owner console, {server}/pilot#owner' if server else ' in the owner console'
    return f'{where} ({which}{opens})', fields


# What the Valun server never holds for an owner, in any approval mode (the approval semantics of 2026-11-17): it holds
# only what the owner's mandate holds (approve_above, review_deliveries). A limit the agent recorded with
# valun_set_limits can be loosened or cleared with its agent token alone (PUT /limits), never past the owner's mandate.
NEVER_HELD = ('honoring a guarantee call (your IOU, recorded at once); accepting, calling and releasing guarantees; '
              'deliveries, declines, withdrawals and disputes; loosening or clearing a limit you recorded with '
              "valun_set_limits (never past your owner's mandate); and the consents your client signs by itself")
# valun_status's approvals sentence for console approvals (the mode the profile names; mcp_server.APPROVAL_TEXT and
# the CLI show it as theirs). The console's own address follows it (held_for_owner). What a rejection leaves, as the
# server does it (lib/pilot/core.mjs decideApproval, decidePayByTransfer): a rejected offer, acceptance or IOU stays on
# the server, still signed; a rejected payment by transfer is purged (endTransfer, purgeTransfer: only the signatures'
# sha256), and a payment through the same IOU at the same prior state is allowed at once (the same-prior exemption,
# novation.one_live_attempt). Any other payment of the deal waits until T + MAX_AGE_MS + FALLBACK_MARGIN_MS.
CONSOLE_APPROVALS = ('Console approvals: you sign every commitment yourself, and the Valun server holds these for your '
                     'owner in the owner console until they approve: your offers and counter-offers, your acceptances '
                     '(taking a job included), your guarantee offers, and the IOU or payment by transfer you sign when '
                     'you accept a delivery (console sets your owner mandate to approve_above 0 and review_deliveries '
                     'on). Each takes effect only when your owner approves it. Rejecting does not unsign it: the server '
                     'keeps your signed offer, acceptance or IOU on record, and a rejected IOU could still be recorded by '
                     'the tracker until an hour after you signed it, so paying that deal by transfer waits until 1 hour '
                     "and 2 minutes after you signed it (your Valun client's time, a minute after the server's, which the "
                     'owner console shows, as a margin for clocks that differ). A rejected payment by transfer is the '
                     'exception: it is deleted, '
                     'its signatures included (the server keeps only their hashes), and you may pay again through the same '
                     'IOU at once while it is unchanged; any other payment of that deal waits until 1 hour and 2 minutes '
                     'after you signed it. When an answer says something waits for your owner, tell them at once: nothing '
                     'else tells them. These are not held, so they take effect when you sign: ' + NEVER_HELD + '.')


def held_for_owner(mandate, server, unit=vc.UNIT, console=False):
    """valun_status's sentence on what the Valun server holds for the owner, from the owner mandate GET /me shows
    (approve_above: an offer, counter-offer or acceptance priced above it, and a guarantee offer capped above it;
    review_deliveries: the IOU or payment by transfer signed when the agent accepts a delivery) and where the owner
    decides (<server>/pilot#owner). console: the approvals sentence before it is CONSOLE_APPROVALS; with the mandate
    console sets, only the address follows (that sentence names the rest), and with another one, what it holds now."""
    m = mandate if isinstance(mandate, dict) else {}
    above, review = m.get('approve_above'), m.get('review_deliveries') is True
    url = f'{str(server).rstrip("/")}/pilot#owner' if isinstance(server, str) and server else None
    where = f'in the owner console ({url})' if url else 'in the owner console'
    if console and _whole(above) and above == 0 and review:
        return f'Your owner approves or rejects what waits for them in the owner console: {url or "/pilot#owner"}.'
    held = []
    if _whole(above) and above == 0:
        held.append('every offer, counter-offer, acceptance and guarantee offer you sign (approve_above 0)')
    elif _whole(above):
        held.append(f'your offers, counter-offers and acceptances priced above {vc.amount_text(above, unit)}, and your '
                    'guarantee offers capped above it (approve_above)')
    if review:
        held.append('the IOU or payment by transfer you sign when you accept a delivery (review_deliveries is on)')
    lead = ('Your owner has changed your owner mandate since console set it: the Valun server holds ' if console else
            'The Valun server also holds ')
    if not held:
        return lead + f'nothing for your owner {where} now.'
    return (lead + f"these for your owner {where} until they approve: {'; and '.join(held)}. It never holds an honor of "
            'a guarantee call.')


def _terms_of(r):
    """The current terms a deal view shows ({} when it shows none)."""
    cur = r.get('current') if isinstance(r, dict) and isinstance(r.get('current'), dict) else {}
    return cur.get('terms') if isinstance(cur.get('terms'), dict) else {}


def _handle_of(r, default='the other side'):
    """The counterparty's handle a deal view names, as a computed line shows it (default when it names none)."""
    cp = r.get('counterparty') if isinstance(r, dict) and isinstance(r.get('counterparty'), dict) else {}
    return shown(cp['handle']) if isinstance(cp.get('handle'), str) and cp['handle'] else default


def iso_ms(ms):
    """ms since the epoch as the server writes a time (ISO 8601, UTC, milliseconds: 2026-11-18T00:10:33.997Z); None for
    a value that is not a whole number of ms between 1970 and 3000."""
    if not (_whole(ms) and 0 <= ms < 32_503_680_000_000):
        return None
    return datetime.fromtimestamp(ms // 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + f'.{ms % 1000:03d}Z'


# A held IOU's approval ends this long before the tracker's hour (valun-app's HELD_NOTE_SEND_MARGIN_MS, da29d10, from
# 2026-11-18), so that an approval made in time reaches the tracker in time: the owner console's "Decide by" for it,
# decide_by in the server's approval view (the RC's staging test, 2026-11-18: this client named the hour itself, a minute
# later than the console). A server from before it (the testnet's 1b1f18f) ends no approval by itself: its card shows
# the tracker's hour as the deadline ("only until ...; after that it fails"), and sends an approval made after the hour,
# which fails at the tracker. This client's decide_by is then a minute before the time that console shows. The agent's
# answers cannot tell the two apart (decide_by is in the owner's approval views only), so 0.7.2 is released after the
# testnet runs da29d10 or later (RELEASING.md), and the owner's texts warn of the older server's late approval.
HELD_NOTE_SEND_MARGIN_MS = 60_000


def _bound_ts(note):
    """The timestamp of a bound note as a deal view shows it ({total, timestamp, prior_signature, ...}), else None (an
    ordinary note, which has no maximum age, or a note the view does not show)."""
    n = note if isinstance(note, dict) else {}
    ts = n.get('timestamp')
    if not _whole(ts) or not (n.get('prior_signature') or n.get('bound') is True or ts % 1000 == nv.BOUND_MS):
        return None
    return ts


def note_expires_at(note):
    """When the tracker stops taking a bound note (its timestamp + 1 h, novation.MAX_AGE_MS; the server's expires_at)
    as the server writes a time, for a note as a deal view shows it ({total, timestamp, prior_signature, ...}); None
    for an ordinary note, which has no maximum age, or a note the view does not show."""
    ts = _bound_ts(note)
    return None if ts is None else iso_ms(ts + nv.MAX_AGE_MS)


def note_decide_by(note):
    """Until when the owner can approve or reject a bound note held for them: the owner console's deadline, a minute
    before the tracker's (its timestamp + 1 h - HELD_NOTE_SEND_MARGIN_MS; the server's decide_by), as the server writes
    a time; None where note_expires_at is None."""
    ts = _bound_ts(note)
    return None if ts is None else iso_ms(ts + nv.MAX_AGE_MS - HELD_NOTE_SEND_MARGIN_MS)


def _deadline_words(by, exp):
    """A held IOU's deadline for the owner, in words: '<by>, the owner console's deadline, a minute before the
    tracker's limit (<exp>)'."""
    return f"{by}, the owner console's deadline, a minute before the tracker's limit ({exp})"


def _until(at, word='before'):
    """' before <at>' (or another word) for a time the server's answer names (an ISO 8601 string), else ''."""
    return f' {word} {shown(at)}' if isinstance(at, str) and at else ''


def free_after(ts):
    """Until when this client counts a payment attempt signed for `ts` (a bound note or a transfer) against another
    payment of its deal, as the server writes a time: its timestamp + 1 h + 2 min (novation.MAX_AGE_MS +
    FALLBACK_MARGIN_MS; attempt_outcome: dead only after it; the server's fallback_after is a minute sooner). None for a
    timestamp that is not a whole number."""
    return iso_ms(ts + nv.MAX_AGE_MS + nv.FALLBACK_MARGIN_MS) if _whole(ts) else None


# What free_after's time is, said beside it (the RC's staging test, 2026-11-18: after a rejected IOU the owner console
# said paying by transfer waits until its timestamp + 1 h + 60 s, the server's rule, and this client + 1 h + 2 min).
MARGIN_WORDS = ("your Valun client's time, a minute after the server's, which the owner console shows, as a margin for "
                'clocks that differ')


def held_note_hour(d, now_ms):
    """The payer's IOU the Valun server holds for its owner, in a deal view (completion_awaiting_owner, the payer's
    credit_note.note, a bound note): (decide_by, note_expires_at, passed): the owner console's deadline
    (note_decide_by), the tracker's, and whether now_ms is at the tracker's or later (approved then, on a server that
    has not ended it, it fails at the tracker and leaves the delivery accepted, unpaid and no longer disputable:
    approval probe D3). (None, None, False) for any other view: the payee's, a held payment by transfer, an ordinary
    note."""
    if not (isinstance(d, dict) and d.get('status') == 'completion_awaiting_owner' and d.get('your_role') == 'payer'):
        return None, None, False
    cn = d.get('credit_note') if isinstance(d.get('credit_note'), dict) else {}
    note = cn.get('note') if isinstance(cn.get('note'), dict) else None
    exp = note_expires_at(note)
    if exp is None:
        return None, None, False
    return note_decide_by(note), exp, _whole(now_ms) and now_ms >= note['timestamp'] + nv.MAX_AGE_MS


def held_note_of(c, row, now_ms):
    """The deadlines of the IOU this client signed for a pending issue_note approval an inbox row names
    (awaiting_your_owner: {approval_id, deal_id, kind}), from this client's own record of it (transfer_attempts[deal_id]:
    the note attempt whose approval_id it is; a bound note): (decide_by, note_expires_at, passed), as held_note_hour.
    (None, None, False) for another kind, or an IOU this client holds no record of."""
    if not (isinstance(row, dict) and row.get('kind') == 'issue_note' and isinstance(row.get('approval_id'), str)
            and isinstance(row.get('deal_id'), str)):
        return None, None, False
    state = getattr(c, 'state', None)
    att = state.get('transfer_attempts') if isinstance(state, dict) else None
    lst = att.get(row['deal_id']) if isinstance(att, dict) else None
    rec = next((a for a in (lst if isinstance(lst, list) else []) if isinstance(a, dict) and a.get('route') == 'note'
                and a.get('approval_id') == row['approval_id']), None)
    ts = rec.get('timestamp') if rec is not None else None
    exp = note_expires_at({'timestamp': ts}) if _whole(ts) else None
    if exp is None:
        return None, None, False
    return note_decide_by({'timestamp': ts}), exp, _whole(now_ms) and now_ms >= ts + nv.MAX_AGE_MS


def honor_marks(c, guarantee_id):
    """{call_id: timestamp of the note} of this client's own record of the calls of `guarantee_id` it honored or is
    honoring (client GUARANTEE_HONORS_KEY, which honor_guarantee writes ahead before it signs a note): before and after
    an honor, the call whose entry changed is the one it honored."""
    state = getattr(c, 'state', None)
    honors = state.get(vc.GUARANTEE_HONORS_KEY) if isinstance(state, dict) else None
    rec = honors.get(guarantee_id) if isinstance(honors, dict) else None
    calls = rec.get('calls') if isinstance(rec, dict) else None
    return {k: v.get('timestamp') for k, v in calls.items() if isinstance(k, str) and isinstance(v, dict)} \
        if isinstance(calls, dict) else {}


def acceptance_wait(c, r, deal_id, command=None):
    """What an acceptance held for an owner (accepted_awaiting_owner) waits for, as the server's answer names it:
    acceptance.held_for ('acceptor_owner' and/or 'proposer_owner') and the pending approvals of this participant
    (approvals: a deal view lists only the viewer's own). (text, fields). Only when this participant's owner holds it
    (held_for names acceptor_owner, or the answer lists a pending approval of this participant) does it name the owner
    console, with owner_wait's fields; when only the proposer's owner does, it says so and names no console (the 0.7.2
    review: it told the acceptor's owner to approve what only the proposer's owner held). An answer that names neither
    says both may, and where this owner would approve it, with no fields. The other side already sees that it was
    accepted and waits (never the acceptance's signature), and may still withdraw its offer (the approval semantics of
    2026-11-17)."""
    acc = r.get('acceptance') if isinstance(r, dict) and isinstance(r.get('acceptance'), dict) else {}
    held_for = acc.get('held_for') if isinstance(acc.get('held_for'), list) else []
    where, fields = owner_wait(c, r, deal_id, command)
    mine = 'acceptor_owner' in held_for or 'approval_id' in fields or 'approval_ids' in fields
    theirs = 'proposer_owner' in held_for
    cp, before = _handle_of(r), _until(_terms_of(r).get('offer_expires_at'))
    seen = (f' {cp} already sees that you accepted and that it waits (not your signature), and may still withdraw its '
            'offer.')
    if mine and theirs:
        return (f"You signed your acceptance of {cp}'s offer. It binds only once your owner approves it{where} and "
                f"{cp}'s owner confirms its offer (their limits require it){before}.{seen} Tell your owner. If your "
                'owner rejects it, the offer is open again. valun_deal shows when both are decided.'), fields
    if mine:
        return (f"You signed your acceptance of {cp}'s offer. It binds only once your owner approves it{where}{before}."
                f'{seen} Tell your owner: nothing else tells them. If your owner rejects it, the offer is open again.'), fields
    if theirs:
        return (f"You signed your acceptance. It binds once {cp}'s owner confirms its offer (their limits require it). "
                f"Nothing waits for your owner. If {cp}'s owner does not confirm, the offer is withdrawn and your "
                'acceptance is void; nothing is owed. valun_deal shows when it is decided.'), {}
    return ('You signed the acceptance; it becomes binding when the owner holding it approves (yours, or the '
            f"proposer's if their limits require it; valun_deal shows which). If it is yours, your owner approves it{where}."), {}


# The deal statuses in which an owner decides (valun_deal's whose_turn: owner_turn), and the one an owner's rejection of
# an offer ends a deal in.
OWNER_WAITS = ('proposed_awaiting_owner', 'accepted_awaiting_owner', 'completion_awaiting_owner', 'rejected_by_owner')


def owner_turn(d, me_id, now_ms=None):
    """valun_deal's whose_turn while an owner decides (OWNER_WAITS), for the viewer `me_id`: whose owner, and what
    waits for them (the approval semantics of 2026-11-17: 0.7.1 said 'nobody: the deal is ...' while this agent's own
    owner held it). An acceptance names the owners acceptance.held_for names, from the viewer's side. The payer's held
    payment says until when: a payment by transfer its hold's end (payment.expires_at); an IOU its hour
    (held_note_hour), and once that has passed, that the owner must reject it (the 0.7.2 review: an approval then fails
    at the tracker and leaves the delivery accepted and no longer disputable, approval probe D3)."""
    st, role = d.get('status'), d.get('your_role')
    if st == 'proposed_awaiting_owner':
        return "your owner's: your signed offer waits for them in the owner console; the other side cannot see it yet"
    if st == 'rejected_by_owner':
        return 'nobody: your owner rejected this offer; it was never shown to the other side, and binds nobody'
    if st == 'completion_awaiting_owner':
        if role != 'payer':
            return "the payer's owner's: the payment its agent signed when it accepted your delivery waits for them"
        pay = d.get('payment') if isinstance(d.get('payment'), dict) else {}
        hold = pay.get('expires_at') if pay.get('state') == 'awaiting_owner' else None
        if isinstance(hold, str) and hold:
            return ("your owner's: the payment by transfer you signed when you accepted the delivery waits for them in the "
                    f'owner console until {shown(hold)} (20 minutes after you signed it); then it ends and nothing moves')
        by, exp, passed = held_note_hour(d, now_ms)
        if passed:
            return ("your owner's: the IOU you signed when you accepted the delivery still waits for them, but the tracker "
                    f'records it only until {exp}, which has passed: tell your owner to reject it in the owner console '
                    '(approved now, it would fail at the tracker and leave the delivery accepted, unpaid and no longer '
                    'disputable), then accept the delivery again to sign a new IOU')
        if exp:
            return ("your owner's: the IOU you signed when you accepted the delivery waits for them in the owner console: "
                    f'they approve or reject it by {_deadline_words(by, exp)}')
        return ("your owner's: the IOU or payment by transfer you signed when you accepted the delivery waits for them in "
                "the owner console")
    acc = d.get('acceptance') if isinstance(d.get('acceptance'), dict) else {}
    held_for = acc.get('held_for') if isinstance(acc.get('held_for'), list) else []
    acceptor = acc.get('by') == me_id
    owners = [('your owner' if acceptor else "the acceptor's owner") if 'acceptor_owner' in held_for else None,
              ("the proposer's owner" if acceptor else 'your owner') if 'proposer_owner' in held_for else None]
    owners = [o for o in owners if o]
    return ('an owner\'s: the acceptance waits for ' + (' and '.join(owners) if owners else 'an owner (valun_deal '
                                                        'approvals lists your own owner\'s)') + ' in the owner console')


# The statuses of a deal that still waits for its payment: what a rejected or void IOU or payment by transfer leaves to
# do applies only then (owner_decisions, counterparty_owner_decisions; the 0.7.2 review).
UNPAID = ('delivered', 'payment_due', 'note_failed')


def _earlier(at, st):
    """The past-tense frame of a decision the deal has moved on from: ('Earlier (<at>), ', ' The deal has since moved
    on (<status>).')."""
    return (f'Earlier ({shown(at)}), ' if isinstance(at, str) and at else 'Earlier, ',
            f' The deal has since moved on ({shown(st)}).')


def _pay_steps(st, how):
    """What is left to do once a payment of this deal that the server held for the owner ended without being sent on
    (the deal is in UNPAID): `how`, how it may be paid again; while it is delivered, a dispute too."""
    if st == 'delivered':
        return f' The deal is back to delivered: {how}, or dispute the delivery.'
    return f' The delivery stays accepted, and you must still pay it: {how}.'


def owner_decisions(d, attempts=None):
    """valun_deal's owner_decisions: what this participant's owner (or the server, for them) decided about something its
    agent signed that the server held for the owner, and that ended without taking effect: the deal view's approvals
    (this participant's own) that were rejected or went void (client.hold_ended), each with what it leaves, in the
    approval semantics of 2026-11-17 and the server's code (lib/pilot/core.mjs): a rejected offer, acceptance or IOU
    stays on the server, still signed; a payment by transfer that ends is purged (only its signatures' hashes are kept).
    attempts: this client's payment attempt records of the deal (transfer_attempts[deal_id]), for the times this client
    actually allows (free_after: a payment of another kind waits until the attempt's timestamp + 1 h + 2 min) and
    whether it counts the attempt as not applied (learn_owner_decisions; then it is dead once its edge moves past it:
    novation.attempt_outcome). Next steps are given only for the last ended approval of each kind, and only while the
    deal's status still fits them (UNPAID for an IOU or a payment, open on the other side's offer for a counter-offer or
    an acceptance, open on this participant's offer for a confirmation its acceptance voided); otherwise a past-tense
    line says when it was decided and that the deal has moved on (the 0.7.2 review). [{approval_id, kind, state,
    decided_at, what_this_means}]; [] when there is none."""
    d = d if isinstance(d, dict) else {}
    rows = d.get('approvals') if isinstance(d.get('approvals'), list) else []
    cp, st = _handle_of(d), d.get('status')
    lead = 'The other side' if cp == 'the other side' else cp      # at the start of a sentence
    until = _until(_terms_of(d).get('offer_expires_at'), 'until')
    cur = d.get('current') if isinstance(d.get('current'), dict) else {}
    open_by = cur.get('by') if st == 'open' else None
    theirs_open = open_by is not None and open_by != d.get('you')
    mine_open = open_by is not None and d.get('you') is not None and open_by == d.get('you')
    pay = d.get('payment') if isinstance(d.get('payment'), dict) else {}
    recs = [a for a in (attempts if isinstance(attempts, list) else []) if isinstance(a, dict)]
    ended = [a for a in rows if isinstance(a, dict) and isinstance(a.get('id'), str) and _APPROVAL_ID_RE.fullmatch(a['id'])
             and vc.hold_ended(a.get('state'))]
    kind_of = lambda a: a.get('kind') if isinstance(a.get('kind'), str) else None     # noqa: E731
    last = {kind_of(a): a['id'] for a in ended}                # the last ended approval of each kind
    out = []
    for a in ended:
        kind, state = a.get('kind'), a['state']
        latest = last.get(kind_of(a)) == a['id']
        earlier, moved = _earlier(a.get('decided_at'), st)
        mine = next((r for r in recs if r.get('approval_id') == a['id']
                     or (isinstance(r.get('server_ended'), dict) and r['server_ended'].get('approval_id') == a['id'])), None)
        ts = mine.get('timestamp') if mine is not None and _whole(mine.get('timestamp')) else None
        counted = mine is not None and mine.get('outcome') == 'not_applied'
        if kind == 'propose':
            if state == 'rejected' and st == 'rejected_by_owner':
                text = (f'Your owner rejected your offer: {cp} never saw it, and the deal has ended. What you signed stays on '
                        'record at the Valun server and binds nobody. Make a new offer only if your owner wants one.')
            elif state == 'rejected':
                text = (f'Your owner rejected your counter-offer, and {cp} never saw it. Its offer stays as it was{until}: '
                        'you may accept it, counter again or decline it.' if latest and theirs_open else
                        f'{earlier}your owner rejected your counter-offer, and {cp} never saw it.{moved}')
            else:
                text = (f'Your offer (or counter-offer) ended before your owner approved it ({shown(state)}): it was never '
                        f'shown to {cp} and binds nobody.')
        elif kind == 'accept':
            if state == 'rejected':
                text = (f"Your owner did not approve your acceptance of {cp}'s offer. Nothing was agreed; the offer is open "
                        f'again{until}, and {cp} sees that the acceptance was not approved. Accept it again only if your '
                        'owner wants to: it would wait for them again.' if latest and theirs_open else
                        f"{earlier}your owner did not approve your acceptance of {cp}'s offer: nothing was agreed by it."
                        f'{moved}')
            else:
                text = (f'Your acceptance ended before your owner approved it ({shown(state)}): nothing was agreed, and '
                        'nothing is owed.')
        elif kind == 'confirm_offer':
            # The proposer's owner confirms an offer its agent made once it is accepted (F4). Rejected: the offer is
            # withdrawn on the owner's behalf. void_acceptance_rejected: the acceptor's owner rejected the acceptance
            # first, and the offer is open again (core.mjs decideApproval). Other void states: the acceptance ended.
            if state == 'rejected':
                text = (f'Your owner did not confirm your offer, which {cp} had accepted: the offer is withdrawn on your '
                        "owner's behalf and the acceptance is void. Nothing is agreed and nothing is owed.")
            elif state == 'void_acceptance_rejected':
                text = (f"{lead}'s owner did not approve its acceptance of your offer, so your owner had nothing to "
                        f'confirm. Nothing was agreed, and your offer is open again{until}.' if latest and mine_open else
                        f"{earlier}{cp}'s owner did not approve its acceptance of your offer, so your owner had nothing to "
                        f'confirm: nothing was agreed by it.{moved}')
            else:
                text = (f"{lead}'s acceptance of your offer ended before your owner confirmed it ({shown(state)}): nothing "
                        'was agreed, and nothing is owed.')
        elif kind == 'issue_note':
            bound = ts is not None and ts % 1000 == nv.BOUND_MS and free_after(ts) is not None
            if not (latest and st in UNPAID):
                text = (f'{earlier}your owner rejected the IOU you signed for this deal' if state == 'rejected' else
                        f'{earlier}the IOU you signed for this deal went void ({shown(state)})') + (
                    f': it was never sent to the tracker.{moved}')
            else:
                head = {'rejected': ('Your owner rejected the IOU you signed for this deal. The Valun server did not send it '
                                     'to the tracker, and you owe nothing for it.'),
                        'void_stale': ("The IOU you signed for this deal went void when your owner approved it (void_stale): "
                                       "the pair's IOU or a party's key had changed since you signed it. The Valun server "
                                       'did not send it, and you owe nothing for it.'),
                        'void_key_revoked': ("The IOU you signed for this deal went void before your owner decided "
                                             "(void_key_revoked): a party's key was revoked. The Valun server did not send "
                                             'it, and you owe nothing for it.')}.get(
                    state, f'The IOU you signed for this deal went void ({shown(state)}). The Valun server did not send it, '
                           'and you owe nothing for it.')
                steps = _pay_steps(st, ('accept the delivery again to sign a new IOU (it waits for your owner again)'
                                        if st == 'delivered' else
                                        'accept it again to sign a new IOU (it waits for your owner again)'))
                if state == 'rejected':
                    kept = (' The rejection did not unsign it: the server keeps it on record, and the tracker could still '
                            'record it ' + (f"until {note_expires_at({'timestamp': ts})}." if bound else
                                            'until an hour after you signed it.' if mine is None else
                                            'at any time (an ordinary note has no maximum age).'))
                else:
                    kept = ' The server keeps it on record, still signed, and never sends it.'
                # The waits are this client's own (novation.one_live_attempt) where it holds a record of the IOU, else
                # the server's (paymentBlockAt: until fallback_after, unless its journal shows the pair's IOU moved past
                # it: attemptDeadByJournal). A record not counted as not applied may still apply for the client, and
                # once the pair's IOU moves past it, that is attempt_outcome_unknown, as in 0.7.1.
                wait = (f'paying this deal by transfer waits until after {free_after(ts)} ({MARGIN_WORDS})' if bound else
                        'paying this deal by transfer waits until a little over an hour after you signed it, unless this '
                        "pair's IOU moves past it first" if mine is None
                        else "paying this deal by transfer waits until your client sees this pair's IOU move past it")
                if counted:
                    count = (' Your Valun client counts it as not applied: a new IOU of this deal may be signed now, and '
                             + wait + (", or until your client sees this pair's IOU move past it." if bound else '.'))
                elif mine is not None:
                    count = (f' {wait[0].upper()}{wait[1:]}.' if bound else '') + (
                        ' Your Valun client still counts it as a payment that may apply: once this pair\'s IOU moves past '
                        'it, your client pays this deal no more until your owner resolves it (`valun attempts resolve`).'
                        if bound else ' Your Valun client still counts it as a payment that may apply (an ordinary note '
                        'has no maximum age): it pays this deal by transfer no more until your owner resolves it '
                        '(`valun attempts resolve`).')
                else:
                    count = f' {wait[0].upper()}{wait[1:]}.'
                text = head + steps + kept + count
        elif kind == 'pay_by_transfer':
            if not (latest and st in UNPAID):
                text = (f'{earlier}your owner rejected your payment by transfer' if state == 'rejected' else
                        f'{earlier}your payment by transfer went void ({shown(state)})') + f': nothing moved.{moved}'
            else:
                head = {'rejected': 'Your owner rejected your payment by transfer.',
                        'void_expired': ('Your payment by transfer expired before your owner decided (its hold ends 20 '
                                         'minutes after you sign it).'),
                        'void_stale': ('Your payment by transfer went void when your owner approved it (void_stale): it was '
                                       "out of date (an IOU it moves, a party's key or a rule had changed since you signed "
                                       'it).'),
                        'void_key_revoked': ("Your payment by transfer went void before your owner decided "
                                             "(void_key_revoked): a party's key was revoked.")}.get(
                    state, f'Your payment by transfer went void ({shown(state)}).')
                fallback = pay.get('fallback_after') if isinstance(pay.get('fallback_after'), str) else None
                free = free_after(ts) if ts is not None else None
                other = (f'after {free} ({MARGIN_WORDS})' if free else f'after {shown(fallback)}' if fallback else
                         'about an hour after you signed it')
                # As for an IOU: this client's waits where it holds a record, else the server's (which ends once the IOU
                # it would have moved has moved past it: attemptDeadByJournal).
                sooner = (', or once your client sees that IOU move past it' if counted else
                          ' (or once that IOU moves past it)' if mine is None else '')
                text = (head + ' Nothing moved, and the Valun server deleted your signatures of it (it keeps only their '
                        'hashes).' + _pay_steps(st, 'pay again through the same IOU at once while it is unchanged (it '
                                                    'waits for your owner again), or with your own IOU or another IOU '
                                                    f'{other}{sooner}')
                        + (' Your Valun client counts it as not applied.' if counted else
                           ' Your Valun client still counts it as a payment that may apply: once that IOU moves past it, '
                           'your client pays this deal no more until your owner resolves it (`valun attempts resolve`).'
                           if mine is not None else ''))
        elif kind == 'guarantee_offer':
            text = (f'Your owner rejected your guarantee offer: it was never shown, and its cap no longer counts against '
                    'your limits. Nothing reached the tracker.' if state == 'rejected' else
                    f'Your guarantee offer ended before your owner approved it ({shown(state)}).')
        else:
            text = f'Approval {a["id"]} ({shown(kind)}) ended as {shown(state)} without taking effect.'
        out.append({'approval_id': a['id'], 'kind': kind, 'state': state, 'decided_at': a.get('decided_at'),
                    'what_this_means': text})
    return out


# The shared history events in which the other side's owner, or the Valun server, ended what the other side's agent
# signed and the server held (lib/pilot/core.mjs: decideApproval and decidePayByTransfer write owner_rejected and
# owner_approval_void_stale, by 'owner:<participant id>', with the approval's kind; endTransfer writes payment_void,
# by 'valun', for a held payment by transfer that ended before its owner decided).
COUNTERPARTY_OWNER_KINDS = ('accept', 'confirm_offer', 'issue_note', 'pay_by_transfer')


def counterparty_owner_decisions(d, me_id):
    """valun_deal's counterparty_owner_decisions: what the other side's owner decided in the owner console about what
    its agent signed for this deal (the deal view's shared history: owner_rejected and owner_approval_void_stale by
    owner:<the other participant>), and a held payment by transfer of the other side's that ended before its owner
    decided (payment_void, its reason expired or key_revoked; the payee's view), each with what it means for this
    participant, in the approval semantics of 2026-11-17 (the synth's words for the other side). As owner_decisions,
    the last of each kind says what it leaves while the deal's status still fits; the others, and one the deal has moved
    on from, say when it happened. me_id: this participant's id (a view without it, or a history without such events,
    gives []). [{at, kind, event, what_this_means}]."""
    if not (isinstance(d, dict) and isinstance(me_id, str) and me_id):
        return []
    hist = d.get('history') if isinstance(d.get('history'), list) else []
    rows = []
    for h in hist:
        if not isinstance(h, dict):
            continue
        by, event, kind = h.get('by'), h.get('event'), h.get('kind')
        if (isinstance(by, str) and by.startswith('owner:') and by != f'owner:{me_id}'
                and event in ('owner_rejected', 'owner_approval_void_stale') and kind in COUNTERPARTY_OWNER_KINDS):
            rows.append((h, kind, event))
        elif (by == 'valun' and event == 'payment_void' and h.get('reason') in ('expired', 'key_revoked')
              and d.get('your_role') == 'payee'):
            rows.append((h, 'pay_by_transfer', event))
    cp, st = _handle_of(d), d.get('status')
    lead = 'The other side' if cp == 'the other side' else cp
    until = _until(_terms_of(d).get('offer_expires_at'), 'until')
    last = {kind: i for i, (_h, kind, _e) in enumerate(rows)}
    out = []
    for i, (h, kind, event) in enumerate(rows):
        latest = last[kind] == i
        at = h.get('at') if isinstance(h.get('at'), str) and h.get('at') else None
        earlier, moved = _earlier(at, st)
        void = event == 'owner_approval_void_stale'
        if kind == 'accept':
            text = (f"{lead}'s owner did not approve its acceptance of your offer. Nothing was agreed, and your offer is "
                    f'open again{until}.' if latest and st == 'open' else
                    f"{earlier}{cp}'s owner did not approve its acceptance of your offer: nothing was agreed by it.{moved}")
        elif kind == 'confirm_offer':
            text = (f"{lead}'s owner withdrew its offer before the deal was agreed. Your acceptance is void, and nothing is "
                    'owed.')
        elif kind == 'issue_note':
            if latest and st in ('delivered', 'payment_due'):
                text = ((f"The IOU {cp}'s agent signed for your delivery went void when its owner approved it (it was out "
                         'of date).' if void else f"{lead}'s owner rejected the IOU its agent signed for your delivery.")
                        + f' Nothing reached the tracker, and {cp} owes you nothing for this deal yet. '
                        + (f"The deal is back to delivered: {cp}'s agent may accept it again or dispute it." if st == 'delivered'
                           else f'The delivery stays accepted: {cp} must still pay it.'))
            else:
                text = (f"{earlier}the IOU {cp}'s agent signed for your delivery went void when its owner approved it"
                        if void else f"{earlier}{cp}'s owner rejected the IOU its agent signed for your delivery") + (
                    f'; nothing reached the tracker.{moved}')
        else:                                   # pay_by_transfer
            what = ('went void when its owner approved it (it was out of date)' if void else
                    'expired before its owner decided (20 minutes after its agent signed it)'
                    if event == 'payment_void' and h.get('reason') == 'expired' else
                    "went void before its owner decided (a party's key was revoked)" if event == 'payment_void' else None)
            if latest and st in ('delivered', 'payment_due'):
                text = ((f"{lead}'s payment by transfer {what}." if what else
                         f"{lead}'s owner rejected its payment by transfer.")
                        + (' Nothing moved, and the deal is back to delivered.' if st == 'delivered' else
                           f' Nothing moved; the delivery stays accepted, and {cp} must still pay it.'))
            else:
                text = ((f"{earlier}{cp}'s payment by transfer {what}" if what else
                         f"{earlier}{cp}'s owner rejected its payment by transfer") + f'; nothing moved.{moved}')
        out.append({'at': at, 'kind': kind, 'event': event, 'what_this_means': text})
    return out


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


def owes(role, who, price, unit=vc.UNIT, circulating=False):
    """What a binding deal means for this participant, in the role the signed terms give it. With circulating credit
    (circulating True: the server offers it) a payer may pay with notes it holds instead of its own (pay_with), as only
    the acceptance of the delivery decides, so the payer's words promise no credit note (the 0.7.2 clean-user test: tour
    step 2's offer said "(your credit note)" for a deal the tour paid by transfer)."""
    p = vc.amount_text(price, unit)
    if role == 'payer' and circulating is True:
        return f'after you accept their delivery you will pay {who} {p}: with your credit note, or with notes you hold if you choose to.'
    return (f'after you accept their delivery you will owe {who} {p} (your credit note).' if role == 'payer'
            else f'you must deliver; {who} would then owe you {p} (their credit note).')


def tracker_words(network):
    """The tracker a credit note goes to, in an approval text."""
    return 'the Valun testnet tracker (anchored on Ergo testnet)' if network == TESTNET else 'the pilot tracker'


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


def _guarantee_int(a, k, default):
    """A whole-number argument of a guarantee tool, or its default (None: required) when it is absent or null."""
    v = a.get(k) if isinstance(a, dict) else None
    v = default if v is None else v
    if v is None:
        raise vc.ValunError('bad_arguments', f'{k} is required')
    if not _whole(v):
        raise vc.ValunError('bad_arguments', f'{k} must be a whole number')
    return v


def _got(v):
    """A value an agent passed, as a refusal quotes it: one line of JSON, at most 40 characters."""
    got = quoted(v)
    return got if len(got) <= 40 else got[:37] + '...'


def _count_message(k, v, units):
    return f'{k} must be a whole number of {units}, at least 1 (a JSON integer), not {_got(v)}; nothing was signed'


def _count(k, v, units):
    """v, the value of argument k of valun_propose or valun_respond (price, deliver_within_hours, offer_valid_hours),
    when it is a JSON integer of at least 1. Anything else is refused (bad_arguments, fix inbox #22), never truncated,
    rounded or replaced by a default: a float (1.5), a numeric string ("1000"), a boolean, 0 or a negative number."""
    if _whole(v) and 1 <= v <= nv.MAX_SAFE_INTEGER:
        return v
    raise vc.ValunError('bad_arguments', _count_message(k, v, units))


def _count_or(a, k, units, default=None):
    """Argument k checked by _count, or `default` when it is absent or null."""
    return default if a.get(k) is None else _count(k, a[k], units)


# The most hours an offer may give to deliver, and stay open (the schemas' maximum): the server refuses terms whose
# deliver_by is more than 30 days ahead, or whose offer_expires_at is more than 7 days ahead.
HOURS_MAX = {'deliver_within_hours': 720, 'offer_valid_hours': 168}


def _hours_or(a, k, default=None):
    """Argument k of valun_propose or valun_respond counter (deliver_within_hours, offer_valid_hours): _count_or, and
    at most HOURS_MAX[k], else bad_arguments before anything is read or signed (fix inbox #58 review: 0.7.1 signed terms
    the server then refused, or failed with internal_error on hours too many for a date)."""
    h = _count_or(a, k, 'hours', default)
    if h is not None and h > HOURS_MAX[k]:
        days = HOURS_MAX[k] // 24
        raise vc.ValunError('bad_arguments', f'{k} must be at most {HOURS_MAX[k]} hours ({days} days, the most the server takes), '
                                             f'not {_got(h)}; nothing was signed')
    return h


# What each required argument of a tool is, for the refusal when it is missing (fix inbox #58): every argument a tool's
# schema requires (REQUIRED_ARGUMENTS) has its words here, and ARGUMENT_WORDS_OF has a tool's own words for an argument
# that means something else there.
ARGUMENT_WORDS = {
    'deal_id': 'the deal id, vd_ + 16 hex, as valun_inbox lists it',
    'action': 'accept, decline, counter or withdraw',
    'counterparty': 'their handle or participant id',
    'role': 'payer to buy, payee to sell',
    'title': 'a short name of the service',
    'description': 'what exactly is to be done',
    'deliverable': 'what will be delivered and in what form',
    'payer': 'the handle or participant id of the agent that would owe you',
    'price': 'the price: a whole number, at least 1',
    'decision': 'accept or dispute',
    'amount': "what it would owe you, the deal's price: a whole number, at least 1",
    'issuer': 'the handle or participant id of the agent whose debt you back',
    'creditor': 'the handle or participant id of the agent you would pay',
    'cap': 'the most you pay in all: a whole number, at least 1',
    'due_in_hours': 'hours from now until the creditor can call: 0 for as soon as it accepts',
    'guarantee_id': 'the guarantee id, vg_ + 16 hex, as valun_guarantees lists it',
}
ARGUMENT_WORDS_OF = {'valun_respond_guarantee': {'action': 'accept, decline, release, withdraw or honor'}}
# The arguments each tool requires: its schema's `required`, what the model reads (tool_arguments refuses a call without one).
REQUIRED_ARGUMENTS = {t['name']: tuple(t['parameters'].get('required') or ()) for t in schemas.ALL}


# The arguments valun_propose needs besides its numbers (the price is checked as a number: _count).
PROPOSE_TEXTS = ('counterparty', 'role', 'title', 'description', 'deliverable')


def _required(a, keys, signs=True, words=None):
    """The values of the required arguments `keys` of a tool call, in that order. Fix inbox #58: a call without one (or
    with it null) is refused with bad_arguments naming each one missing and what it is (ARGUMENT_WORDS, or `words` for a
    tool's own), before anything is read, instead of failing on a KeyError (internal_error); arguments that are not a
    JSON object are refused the same way."""
    if not isinstance(a, dict):
        raise vc.ValunError('bad_arguments', 'the arguments are not a JSON object' + ('; nothing was signed' if signs else ''))
    missing = [k for k in keys if a.get(k) is None]
    if missing:
        w = {**ARGUMENT_WORDS, **(words or {})}
        raise vc.ValunError('bad_arguments', ('missing argument: ' if len(missing) == 1 else 'missing arguments: ')
                            + ', '.join(f'{k} ({w[k]})' for k in missing) + ('; nothing was signed' if signs else ''))
    return [a[k] for k in keys]


# Fix inbox #58 (0.7.2): each argument a tool's schema gives is checked against its type there (argument_refusal). The
# schema's properties of each tool, in the order the check goes through them:
PROPERTIES = {t['name']: t['parameters'].get('properties') or {} for t in schemas.ALL}
# The id shapes the server's routes take (valun-app lib/pilot/http.mjs: /deals/(vd_[0-9a-f]{16}), /guarantees/(vg_[0-9a-f]
# {16}) and .../calls/(vgc_[0-9a-f]{16}); lib/pilot/core.mjs and guarantees.mjs check them the same way): an id of another
# shape names nothing there, and a value that is not one never reaches a request.
ID_SHAPES = {'deal_id': re.compile(r'vd_[0-9a-f]{16}'), 'guarantee_id': re.compile(r'vg_[0-9a-f]{16}'),
             'call_id': re.compile(r'vgc_[0-9a-f]{16}')}
# A value that is not one of an argument's values (its schema's enum) gets the refusal its tool gave it before the core
# check did, code and words (a misspelt decision is still bad_decision): {tool: {argument: (code, message)}}.
ENUM_REFUSALS = {
    'valun_propose': {'role': ('bad_role', 'role must be payer (you pay with your credit) or payee (you do the work)')},
    'valun_respond': {'action': ('bad_action', 'action must be accept, decline, counter or withdraw')},
    'valun_review_delivery': {'decision': ('bad_decision', "decision must be exactly 'accept' or 'dispute'; nothing was signed")},
    'valun_respond_guarantee': {'action': ('bad_arguments', 'action must be accept, decline, release, withdraw or honor')},
}
# The refusals a tool gave an argument of the wrong type before the core check did, kept word for word (each names the
# argument and what it must be): (tool, argument) -> message; for an integer argument whose words name the network's unit
# or the tool's own words, a function of (the value, the unit).
_SAID = {
    ('valun_status', 'brief'): 'brief must be true or false',
    ('valun_deliver', 'exact_result'): 'exact_result is true or false',
    ('valun_review_delivery', 'pay_with'): "pay_with is 'own_note' or the handle or id of an issuer whose note you hold",
    ('valun_offer_guarantee', 'note'): 'note must be text',
    ('valun_respond_guarantee', 'reason'): 'reason must be text',
    ('valun_respond_guarantee', 'call_id'): 'call_id is malformed (vgc_ + 16 hex)',
    ('valun_call_guarantee', 'amount'): 'amount must be a whole number of at least 1',
    ('valun_check_payer', 'payer'): 'payer must be the handle or participant id (text) of the agent that would owe you',
    **{(t, 'guarantee_id'): 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees lists them)'
       for t in ('valun_guarantees', 'valun_respond_guarantee', 'valun_call_guarantee')},
    **{('valun_offer_guarantee', k): f'{k} must be a whole number'
       for k in ('cap', 'due_in_hours', 'callable_for_hours', 'honor_within_hours', 'offer_valid_hours')},
    **{(t, k): (lambda k: lambda v, unit: _count_message(k, v, unit if k in ('price', 'amount') else 'hours'))(k)
       for t, ks in (('valun_propose', ('price', 'deliver_within_hours', 'offer_valid_hours')),
                     ('valun_respond', ('price', 'deliver_within_hours', 'offer_valid_hours')), ('valun_check_payer', ('amount',)))
       for k in ks},
    ('valun_check_payer', 'deal_id'): lambda v, _u: ('deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as '
                                                     f'valun_inbox lists it, not {_got(v)}'),
    **{('valun_directory', k): (lambda k: lambda v, _u: _page_message(k, v, PAGE_WORDS[k]))(k) for k in ('limit', 'offset')},
}


def _deals_ok(v):
    """valun_offer_guarantee deals: 1 to vc.GUARANTEE_MAX_DEALS different deal ids (the client's own check, items first)."""
    return (isinstance(v, list) and 1 <= len(v) <= vc.GUARANTEE_MAX_DEALS
            and all(isinstance(d, str) and ID_SHAPES['deal_id'].fullmatch(d) for d in v) and len(set(v)) == len(v))


def argument_refusal(name, k, v, unit=vc.UNIT):
    """Why the value v (not null) of argument k does not fit tool `name`'s schema (PROPERTIES), as the ValunError its call
    answers, or None when it fits (fix inbox #58, 0.7.2). A string is a string, an integer an integer (a JSON integer
    JavaScript can hold exactly: a bool, 1.5 or "7" is not one), a boolean true or false, and a value with an enum one of
    its values (a list of them for valun_set_limits clear); deal_id, guarantee_id and call_id have the shape of the ids
    the server's routes take (ID_SHAPES), and valun_offer_guarantee deals is its list of deal ids. The refusal names the
    argument and what it must be: where its tool refused it already, with the same code and words (ENUM_REFUSALS,
    _SAID; `unit` is the network's, for the words of an amount), else bad_arguments '<k> must be a string (<what it is,
    for an argument the tool requires>), not <v>' (or a whole number, or true or false), ending in '; nothing was signed'
    for a tool that is not read-only. Only the type, values and shape: how many, how long or how large is the tool's
    own check, as before."""
    spec = PROPERTIES.get(name, {}).get(k)
    if not isinstance(spec, dict) or v is None:
        return None
    tail = '' if name in READ_ONLY_TOOLS else '; nothing was signed'
    t, enum = spec.get('type'), spec.get('enum')
    if enum is not None:
        if isinstance(v, str) and v in enum:
            return None
        code, message = ENUM_REFUSALS[name][k]
        return vc.ValunError(code, message)
    if t == 'string':
        shape = ID_SHAPES.get(k)
        fits = isinstance(v, str) and (shape is None or shape.fullmatch(v) is not None)
        words = {**ARGUMENT_WORDS, **ARGUMENT_WORDS_OF.get(name, {})}.get(k) if k in REQUIRED_ARGUMENTS.get(name, ()) else None
        need = ('the deal id, vd_ + 16 hex, as valun_inbox lists it' if k == 'deal_id' else
                'a string' + (f' ({words})' if words else ''))
    elif t == 'integer':
        fits, need = _safe_whole(v), 'a whole number (a JSON integer)'
    elif t == 'boolean':
        fits, need = isinstance(v, bool), 'true or false'
    elif (name, k) == ('valun_set_limits', 'clear'):
        names = spec['items']['enum']
        fits = isinstance(v, list) and all(isinstance(x, str) and x in names for x in v)
        need = f"a list of the limits to remove ({', '.join(names)})"
    elif (name, k) == ('valun_offer_guarantee', 'deals'):
        if _deals_ok(v):
            return None
        return vc.ValunError('bad_arguments', f'deals must be 1 to {vc.GUARANTEE_MAX_DEALS} different deal ids (vd_ + 16 hex)')
    else:
        return None
    if fits:
        return None
    said = _SAID.get((name, k))
    if callable(said):
        said = said(v, unit)
    return vc.ValunError('bad_arguments', said if said is not None else f'{k} must be {need}, not {_got(v)}{tail}')


def tool_arguments(name, args, unit=vc.UNIT):
    """The arguments of a call of the tool `name` (one of TOOL_NAMES), as its handler takes them: {} when there are none
    (absent or null), else the JSON object given, itself. Fix inbox #58: arguments that are not a JSON object, or that
    lack one of the tool's required arguments (REQUIRED_ARGUMENTS, its schema's `required`; null counts as missing), are
    refused with bad_arguments naming each one missing and what it is, before anything is read or signed, so no tool can
    fail on them later (an internal_error). Then each argument given (not null) must fit its schema's type (0.7.2,
    argument_refusal: the first one that does not, in the schema's order, is refused, naming it and what it must be).
    The refusal ends in '; nothing was signed' for the tools that are not read-only. `unit`: the network's unit, which
    the refusal of an amount names (ValunAgent passes its profile's: ValunAgent.tool_arguments). ValunAgent checks it
    where every call comes in: call(), and prepare_or_refusal() for the adapters that ask the owner before a commitment,
    which answers the same refusal instead of asking (prepare() refuses such a call too, approval_unbound with the cause
    the refusal's code). is_commitment() does not look at it: its classification stays fail closed, by name and by
    value."""
    signs = name not in READ_ONLY_TOOLS
    a = {} if args is None else args
    if not isinstance(a, dict):
        raise vc.ValunError('bad_arguments', 'the arguments are not a JSON object' + ('; nothing was signed' if signs else ''))
    _required(a, REQUIRED_ARGUMENTS.get(name, ()), signs=signs, words=ARGUMENT_WORDS_OF.get(name))
    for k in PROPERTIES.get(name, {}):
        e = argument_refusal(name, k, a.get(k), unit)
        if e is not None:
            raise e
    return a


# valun_check_payer (budget cards): the summary's first word for each verdict the server gives, and its words when the
# server gives no reasons; and the words for the payee's own side of the step (payee_side) when it would not simply go
# ahead and the server gives no reasons for it.
CHECK_LEAD = {'accept': 'Accept', 'ask_owner': "Ask the payer's owner", 'decline': 'Decline'}
CHECK_FALLBACK = {'accept': "its owner's budget card allows this IOU",
                  'ask_owner': "the payer's owner approves an IOU this size before it binds",
                  'decline': "its owner's budget card does not allow this IOU"}
CHECK_PAYEE_SIDE = {'decline': 'your own limits refuse it', 'ask_owner': 'your owner approves it before it binds'}
# Fix inbox #87: an ask_owner from a server that gives the step's verdict from both sides (payer_side): the summary's
# first words, and its words without reasons, by whose owner decides first (check_owners).
CHECK_ASK_LEAD = {'payee': 'Ask your owner', 'payer': "Ask the payer's owner", 'both': "Ask your owner and the payer's owner"}
CHECK_ASK_FALLBACK = {'payee': 'your owner approves it before it binds',
                      'payer': "the payer's owner approves an IOU this size before it binds",
                      'both': "your owner and the payer's owner approve it before it binds"}
# A deal id as the server writes one (the offer under review, deal=; counted_offers).
_OFFER_ID = re.compile(r'vd_[0-9a-f]{16}')


def _summary_parts(reasons):
    """The server's reasons for a summary: each a text put on one line without its final stop; the others left out."""
    return [p for p in (' '.join(r.split()).rstrip(' .;,') for r in (reasons if isinstance(reasons, list) else [])
                        if isinstance(r, str)) if p]


def _summary_text(parts):
    """The summary's parts as one text, without a final stop: a part that starts with a capital letter (A to Z: a
    sentence, as the server writes its reasons) follows the one before after a stop, any other after a comma. 0.7.1 put
    every part after a comma, so a sentence of the server's ran on mid-line ('..., Within its budget: ...')."""
    out = ''
    for i, p in enumerate(parts):
        out += p if i == 0 else ('. ' if 'A' <= p[0] <= 'Z' else ', ') + p
    return out


def check_owners(v):
    """Fix inbox #87: whose owner decides first in a check's ask_owner, from the step's two sides (payer_side and
    payee_side, each {verdict, rule, reasons}): 'payee' (this agent's own owner) when only the payee's side says
    ask_owner, 'payer' when only the payer's side does, else 'both'. An answer whose sides do not say whose (neither is an
    object with verdict ask_owner) names both, so this agent's own owner is never left out."""
    def asks(key):
        side = v.get(key) if isinstance(v, dict) else None
        return isinstance(side, dict) and side.get('verdict') == 'ask_owner'
    payer, payee = asks('payer_side'), asks('payee_side')
    return 'payee' if payee and not payer else 'payer' if payer and not payee else 'both'


def _safe_whole(v):
    return _whole(v) and -nv.MAX_SAFE_INTEGER <= v <= nv.MAX_SAFE_INTEGER


def offers_counted_at(v):
    """For a check of a new deal (an answer that names no deal_id): the deal ids of the payer's open offers to this agent
    that the answer says its outstanding already counts (counted_offers [{deal_id, amount}], fix inbox #60), at exactly
    the amount checked, as listed. An entry that is not {deal_id: a deal id, amount: a whole number} is left out."""
    v = v if isinstance(v, dict) else {}
    amount, rows = v.get('amount'), v.get('counted_offers')
    if 'deal_id' in v or not _safe_whole(amount) or not isinstance(rows, list):
        return []
    return [o['deal_id'] for o in rows if isinstance(o, dict) and isinstance(o.get('deal_id'), str)
            and _OFFER_ID.fullmatch(o['deal_id']) and _safe_whole(o.get('amount')) and o['amount'] == amount]


def check_summary(v):
    """valun_check_payer's summary: the verdict, its reasons and the cover as plain sentences, e.g. 'Accept: Both sides
    allow it. Within its budget: ... Your own side: Your own limits allow it. Backed for you up to 3 by @erin.' The
    reasons are the server's, each put on one line without its final stop, a sentence after a stop and a fragment after
    a comma (_summary_text); without any, the words of CHECK_FALLBACK. A verdict this client does not know reads Unknown.

    Fix inbox #87: a server that gives the step's verdict from both sides (its answer has payer_side: the payer's own
    {verdict, rule, reasons}, null for a payer whose owner has not published its card) gives the payee its own check's
    verdict for the step as the server enforces it: decline if either side declines, ask_owner if an owner on either
    side decides first, accept only if both go ahead, unknown when the payer's side was not checked (no card) and the
    payee's does not decline. The summary leads with that verdict; for ask_owner it names whose owner decides
    (check_owners): 'Ask your owner' when only the payee's side (payee_side) asks, "Ask the payer's owner" when only the
    payer's does, "Ask your owner and the payer's owner" otherwise. The cover is the server's to say: its sentence is
    among the payee's own reasons, which end the summary after 'Your own side: ' whatever that side's verdict (the words
    of CHECK_PAYEE_SIDE for a decline or ask_owner without reasons).

    A server from before #87 (no payer_side) gives the payer's verdict, and its summary is 0.7.1's: the lead of
    CHECK_LEAD, the cover named by this client ('backed for you up to N') only when cover.covered is a whole number above
    0 (the server shows it only to the payee itself, and null means not shown, never 0) and only for accept and
    ask_owner (a declined IOU would not be issued at all), and 'Your own side: ' with the payee's own reasons only when
    that side is decline (the payee's own limits refuse it) or ask_owner (the payee's owner decides first), so an Accept
    for the payer never reads as one for you.

    Fix inbox #60: a check of a new deal (no deal_id) at the price of an offer the payer made this agent is not a check
    of that offer, which the payer's outstanding already counts: the answer is for a new deal on top of it. So when the
    answer's counted_offers has offers at exactly the amount checked (offers_counted_at), the summary says so after the
    verdict and gives the call that answers for the offer: 'Decline, for a new deal on top of the offer you received at
    this price (vd_..., already counted): ... To check that offer itself, call valun_check_payer again with deal_id
    vd_...'. Several such offers are listed, and the call is with one of their deal_ids."""
    v = v if isinstance(v, dict) else {}
    verdict = v.get('verdict') if isinstance(v.get('verdict'), str) else None
    both = 'payer_side' in v                     # fix inbox #87: the step's verdict, from both sides
    owners = check_owners(v) if both and verdict == 'ask_owner' else None
    parts = _summary_parts(v.get('reasons'))
    if not parts:
        parts = [CHECK_ASK_FALLBACK[owners] if owners else CHECK_FALLBACK.get(verdict, 'the server gave no verdict this client knows')]
    covered = v['cover'].get('covered') if isinstance(v.get('cover'), dict) else None
    if not both and verdict in ('accept', 'ask_owner') and _whole(covered) and 0 < covered <= nv.MAX_SAFE_INTEGER:
        parts.append(f'backed for you up to {covered}')
    lead = CHECK_ASK_LEAD[owners] if owners else CHECK_LEAD.get(verdict, 'Unknown')
    text, offers = _summary_text(parts), offers_counted_at(v)
    if len(offers) == 1:
        out = (f'{lead}, for a new deal on top of the offer you received at this price ({offers[0]}, already counted): '
               f'{text}. To check that offer itself, call valun_check_payer again with deal_id {offers[0]}.')
    elif offers:
        out = (f"{lead}, for a new deal on top of the {len(offers)} offers you received at this price ({', '.join(offers)}, "
               f'already counted): {text}. To check one of them, call valun_check_payer again with its deal_id.')
    else:
        out = f'{lead}: {text}.'
    side = v.get('payee_side') if isinstance(v.get('payee_side'), dict) else {}
    yours = side.get('verdict') if isinstance(side.get('verdict'), str) else None
    if yours in CHECK_PAYEE_SIDE or (both and yours == 'accept'):
        own = _summary_parts(side.get('reasons')) or ([CHECK_PAYEE_SIDE[yours]] if yours in CHECK_PAYEE_SIDE else [])
        if own:
            out += f' Your own side: {_summary_text(own)}.'
    return out


def unchecked_payer(payer, amount, deal_id=None):
    """valun_check_payer's answer when the payer's owner has not published a budget card and the server says only that
    (404 card_not_public, as a server from before fix inbox #87 answers every check of such a payer; one with #87 answers
    the payee's own check for the payee's own side, which check_summary reads): an answer, not an error, with verdict
    'unknown' (and the offer under review, deal_id, when the check named one)."""
    who = shown(payer.get('handle') or payer.get('id'))
    return {'summary': (f"Unknown: {who}'s owner has not published a budget card, so its budget cannot be checked; decide "
                        'from its record (valun_directory) or ask your owner.'),
            'verdict': 'unknown', 'reasons': ["the payer's owner has not published a budget card"], 'rule': None, 'payer': payer,
            'amount': amount, **({} if deal_id is None else {'deal_id': deal_id})}


def _party(g, role, terms):
    """A guarantee party's handle as the view names it, else its id from the checked terms."""
    x = g.get(role) if isinstance(g, dict) else None
    return x.get('handle') if isinstance(x, dict) and isinstance(x.get('handle'), str) and x['handle'] else terms[role]['id']


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


# valun_directory answers one page (fix inbox #36: small models stalled on the whole directory, about 72 KB for 137
# participants): DIRECTORY_PAGE participants unless the agent asks for up to DIRECTORY_PAGE_MAX, with each about, services
# and wants cut to DIRECTORY_TEXT_MAX code points.
DIRECTORY_PAGE = 10
DIRECTORY_PAGE_MAX = 50
DIRECTORY_TEXT_MAX = 160
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def exact_facts(terms, content, counterparty):
    """The approval card's line on the exact check of a built-in job (sandbox.check_built_in; counterparty: the payee's
    handle), as a list of facts: [] when nothing was checked exactly (not a built-in job: the Nov 18 fresh-join run,
    finding 10; or no text to recompute from). A delivery with no ```json result block is not in the built-in format,
    which 0.7.1 and the RC showed as "DOES NOT MATCH (differs in )", with an empty list."""
    try:
        exact = sandbox.check_built_in(terms, content, counterparty)
    except Exception:  # noqa: BLE001 - a malformed result block is a fact to show, not a reason to hide the prompt
        return ['exact result: could not be checked']
    if not (exact and exact.get('checked')):
        return []
    if exact.get('exact_result_matches'):
        return ['exact result: matches the agreed text']
    if exact.get('built_in_format') is False:
        return ['exact result: not in the built-in format (no ```json result block)']
    return ['exact result: DOES NOT MATCH (differs in ' + ', '.join(shown(k) for k in (exact.get('differs_in') or [])) + ')']


# Where an IOU stands, by the confirmation its deal's credit note and its ledger row show (skill.md section 5, "Where your
# IOU stands"): on the testnet the tracker anchors its totals on Ergo testnet; the pilot's tracker has no chain at all.
# How soon the next box commits it is the server's own summary (valun-app d269b1e, Pilot.issuedSummary): one box at a
# time, at most 50 a UTC day (DAILY_TRACKER_SIGNATURES), "usually within 15 minutes of a change, as measured on this
# network", and after 00:00 UTC once the day's boxes are used up (on 2026-11-16, loops cleared after the cap waited 3.9
# to 5.5 hours).
CONFIRMATION_WORDS = {
    'local_only': ('recorded by the tracker; no tracker box on Ergo testnet commits it yet. The tracker posts one tracker '
                   'box at a time, at most 50 a UTC day: the next one commits it, usually within 15 minutes of a change, '
                   "as measured on the testnet, and once the day's 50 are used up, only after 00:00 UTC. The "
                   'confirmation then reads pending, then confirmed'),
    'pending': 'a tracker box carries it and waits for an Ergo testnet block; the confirmation then reads confirmed',
    'confirmed': 'a confirmed tracker box on Ergo testnet commits it',
}
CONFIRMATION_WORDS_PILOT = {'local_only': 'recorded by the pilot tracker, which has no blockchain connection: its notes stay '
                                          'local_only'}


def confirmation_means(confirmation, network=vc.NETWORK):
    """What a credit note's confirmation (local_only, pending, confirmed) means on this network, or None for another."""
    words = CONFIRMATION_WORDS if network == TESTNET else CONFIRMATION_WORDS_PILOT
    return words.get(confirmation) if isinstance(confirmation, str) else None


def server_summary(d):
    """The plain summary a server adds to a deal view at note_issued (valun-app, the Nov 18 fresh-join run's fix 5: its
    `summary`, or labels.summary), as text a tool can show (a str of at most 2000 characters), or None."""
    if not isinstance(d, dict):
        return None
    labs = d.get('labels') if isinstance(d.get('labels'), dict) else {}
    for s in (d.get('summary'), labs.get('summary')):
        if isinstance(s, str) and s.strip() and len(s) <= 2000:
            return s.strip()
    return None


def note_summary(d, network=vc.NETWORK, unit=vc.UNIT, circulating=False, server=None, role=None):
    """The plain ending of a deal whose IOU was issued (note_issued), for either side (the Nov 18 fresh-join run,
    finding 12: the buyer got 600 characters of settlement text and the seller nothing): the server's own summary when
    it sends one (server_summary), else one built here from the deal view: who owes whom and how much more, the
    tracker's running total for that pair, where the IOU stands (its confirmation: confirmation_means), how to check it
    (the ledger row, and on the testnet `valun audit --mine`), and how it is paid back, as this network and circulating
    credit allow. role: this side's ('payer' or 'payee'), else the view's your_role. None for any other deal."""
    if not (isinstance(d, dict) and d.get('status') == 'note_issued'):
        return None
    own = server_summary(d)
    if own:
        return own
    n = d.get('credit_note') if isinstance(d.get('credit_note'), dict) else {}
    tn = n.get('tracker_note') if isinstance(n.get('tracker_note'), dict) else {}
    cur = d.get('current') if isinstance(d.get('current'), dict) else {}
    terms = cur.get('terms') if isinstance(cur.get('terms'), dict) else {}
    price = terms.get('price').get('amount') if isinstance(terms.get('price'), dict) else None
    amount = n.get('amount') if _whole(n.get('amount')) else price
    cp = d.get('counterparty') if isinstance(d.get('counterparty'), dict) else {}
    who = shown(cp['handle']) if isinstance(cp.get('handle'), str) and cp['handle'] else 'the other party'
    payer = (role or d.get('your_role')) == 'payer'
    out = (f"You owe {who} {vc.amount_text(amount, unit) if _whole(amount) else 'the price'} more by this deal's IOU"
           if payer else
           f"{who} owes you {vc.amount_text(amount, unit) if _whole(amount) else 'the price'} more by this deal's IOU")
    total = tn.get('amount_collected')
    out += f" (the tracker's running total for that pair: {vc.amount_text(total, unit)})." if _whole(total) else '.'
    conf = n.get('confirmation') or tn.get('confirmation')
    means = confirmation_means(conf, network)
    row = (f"the row from {'you' if payer else who} to {who if payer else 'you'} in GET "
           f"{server or 'the server'}/pilot/v1/ledger")
    if network == TESTNET:
        out += (f' Where it stands: {conf}, {means}.' if means else
                ' Where it stands: the tracker recorded it, and a tracker box on Ergo testnet commits it.')
        out += (f' Check it: {row} (its total and confirmation), and `valun audit --mine`, which checks your records '
                'against the box once the next box commits them.')
        redeem = (f'{who} redeems it on Ergo testnet against your reserve, if you post one' if payer else
                  f"you redeem it on Ergo testnet against {who}'s reserve, if it posts one")
        if circulating:
            passes = (f'{who} passes it on (pays another agent with it, which changes only whom you owe)' if payer else
                      f'you pass it on (pay_with when you accept a delivery, which changes only whom {who} owes)')
            out += f' It stays outstanding until a loop clears it (a set-off around a cycle of debts), {passes}, or {redeem}.'
        else:
            out += f' It stays outstanding until {redeem}.'
        return out
    out += f' Where it stands: {means}.' if means else ' Where it stands: the pilot tracker recorded it.'
    out += f' Check it: {row}.'
    if circulating:
        return (out + ' It stays outstanding until a loop clears it (a set-off around a cycle of debts) or '
                + (f'{who} passes it on' if payer else 'you pass it on') + '; nothing in the pilot redeems it, and PC have '
                'no value.')
    return out + ' Nothing in the pilot settles it: there is no redemption, reserve or clearing, and PC have no value.'


def _server_of(c):
    """The server this client's profile names, or None."""
    state = getattr(c, 'state', None)
    s = state.get('server') if isinstance(state, dict) else None
    return s.rstrip('/') if isinstance(s, str) and s else None


def closed_summary(item):
    """valun_inbox's one line for a recently closed deal whose IOU was issued (note_issued), from its inbox brief (its
    counterparty, your_role and price), or None for any other."""
    if not (isinstance(item, dict) and item.get('status') == 'note_issued'):
        return None
    price = item.get('price') if isinstance(item.get('price'), dict) else {}
    amount, unit = price.get('amount'), price.get('unit')
    amt = vc.amount_text(amount, unit) if _whole(amount) and isinstance(unit, str) and unit else 'its price'
    cp = item.get('counterparty')
    who = shown(cp) if isinstance(cp, str) and cp else 'the other party'
    lead = (f'Paid with your IOU: this deal added {amt} to what you owe {who}.' if item.get('your_role') == 'payer' else
            f'{who} paid with its IOU: this deal added {amt} to what {who} owes you.')
    return lead + ' valun_deal shows where it stands on the tracker and how it is paid back.'


def exact_advice(exact):
    """valun_deal's advice to the payer of a built-in job whose delivery its client checked and found wrong
    (sandbox.check_built_in): dispute it, saying why. Not in the built-in format (no ```json result block) is said so,
    never "does not match"."""
    if exact.get('built_in_format') is False:
        return ('The delivery is not in the built-in format: it has no ```json result block to compare with the exact '
                'result of the agreed text. Dispute it with that reason instead of issuing an IOU.')
    return ('The delivered result does not match the exact result of the agreed text '
            f"(differs in: {', '.join(str(k) for k in (exact.get('differs_in') or ['the result block']))}). "
            'Dispute it with that reason instead of issuing an IOU.')


def directory_text(v):
    """An about, services or wants text as valun_directory shows it: its first DIRECTORY_TEXT_MAX code points, and '…'
    when it is longer. Any other value is returned as it is."""
    return v[:DIRECTORY_TEXT_MAX] + '…' if isinstance(v, str) and len(v) > DIRECTORY_TEXT_MAX else v


def seen_us(iso):
    """A time as recently_active reads it (ISO 8601 with a UTC offset; 'Z' is UTC) in microseconds since 1970-01-01
    UTC, exactly; None for anything else (a missing, naive or unreadable time: never seen)."""
    try:
        return (datetime.fromisoformat(str(iso).replace('Z', '+00:00')) - _EPOCH) // timedelta(microseconds=1)
    except (TypeError, ValueError, OverflowError):
        return None


# What valun_directory's limit and offset are, for the refusal of one that is not a whole number.
PAGE_WORDS = {'limit': f'how many participants to show: 1 to {DIRECTORY_PAGE_MAX}, {DIRECTORY_PAGE} by default',
              'offset': 'how many participants to skip: next_offset from the last answer, 0 by default'}


def _page_message(k, v, what):
    return f'{k} must be a whole number ({what}), not {_got(v)}'


def _page_arg(a, k, default, what):
    """valun_directory's limit or offset: `default` when it is absent or null, else a JSON integer (a bool is not one;
    nor is a number JavaScript cannot hold exactly). Anything else is refused (bad_arguments)."""
    v = a.get(k)
    if v is None:
        return default
    if _whole(v) and -nv.MAX_SAFE_INTEGER <= v <= nv.MAX_SAFE_INTEGER:
        return v
    raise vc.ValunError('bad_arguments', _page_message(k, v, what))


def service_text(svc):
    """A service's title, description and deliverable as the client reads their numeric requirements
    (measure.requirements): each without its fenced blocks (valun.fences), then joined by spaces. Read one by one, a
    field's fences never share a line with another field's text (fix inbox #70). Joined first, a description that ends at
    its closing fence would put the deliverable on that fence's line, so the block would not close and the deliverable
    would be read as quoted; one that starts with a fence would have the title on its opening line. The ``` ... ```
    quotes left are taken out of the joined text, so for plain ``` blocks the requirements are those valun 0.7.0 read."""
    return ' '.join(fences.without(str(svc.get(k) or '')) for k in ('title', 'description', 'deliverable'))


def terms_text(d):
    """The agreed (or current) service text: where numeric requirements such as '300-500 words' are written
    (service_text)."""
    t = ((d.get('current') or {}).get('terms') or {}).get('service') or {}
    return service_text(t)


# Fix inbox #35 (the clients' half of #32): every tool's answer gives each amount a unit-neutral name, by the rule the
# server's public answers follow (valun-app lib/pilot/amount-names.mjs). The network names its unit once (valun_status
# `unit`: nanoERG on the testnet), so an amount's name need not carry it, and an agent reading `you_hold_PC: 2500000` on
# the testnet should not report "2,500,000 PC". The `_PC` and `PC` names stay, as deprecated aliases with the same
# values, until a later release removes them, announced in the fix inbox and the changelog first.
_PC_SUFFIX = '_PC'


def _neutral_name(k):
    if k == 'PC':
        return 'amount'
    return k[:-len(_PC_SUFFIX)] if isinstance(k, str) and len(k) > len(_PC_SUFFIX) and k.endswith(_PC_SUFFIX) else None


def with_unit_neutral_names(v):
    """A tool's answer with each amount under its unit-neutral name too, at any depth: every key `<name>_PC` gets
    `<name>` just before it, and the `PC` of a {count, PC} tally gets `amount`, with the same value. A name already
    present is never overwritten, and a value that is not an object or an array passes through unchanged (a tuple is an
    array, as in JSON). The answer given is not changed: its objects and arrays are copied."""
    if isinstance(v, (list, tuple)):
        return [with_unit_neutral_names(x) for x in v]
    if not isinstance(v, dict):
        return v
    out = {}
    for k, x in v.items():
        y, n = with_unit_neutral_names(x), _neutral_name(k)
        if n and n not in v and n not in out:
            out[n] = y
        out[k] = y
    return out


# What a transport failure means for the agent (fix inbox #132), by the client's (cause, outcome): a read whose answer
# was cut after its tries, a request whose answer did not come in time (asked once), a write whose answer was cut or
# did not come (the server may have done it), an answer that is not JSON, the server not reached; None: a failure that
# names no cause (the server not reached, or its answer not read). The owner's check is named without a command line
# (the 0.7.2 review: a bare `valun` is not on the PATH of a uvx user, and the npm package has no CLI). A write whose
# outcome is unknown names what to read before sending it again (fix inbox #148: the natural retry of a lost offer made
# a second one): valun_inbox, valun_deal for its deal, or valun_guarantees for a guarantee's offer, answer or call.
_READ_AGAIN = ('Try again in a minute; if it keeps failing, tell your owner, who can check the connection with the '
               "doctor command of their Valun CLI, for this agent's profile.")
_READ_FIRST = 'valun_inbox, valun_deal for its deal, or valun_guarantees for a guarantee'
_WRITE_UNKNOWN = ('the server may have done it. Do not send it again before you read what the server holds now '
                  f'({_READ_FIRST}), so that nothing is done twice.')
TRANSPORT_WORDS = {
    'connection_cut|': ('The connection to the Valun server was cut before its whole answer arrived, also when your '
                        'Valun client asked again: that is the network between this machine and the server (or a '
                        'proxy, VPN or antivirus on it), not a refusal. ' + _READ_AGAIN),
    'connection_cut|unknown': ('Your request reached the Valun server, but the connection was cut before its answer '
                               'arrived, so ' + _WRITE_UNKNOWN),
    'timed_out|': ('The Valun server did not answer in time (your Valun client asked once, so as not to add to its '
                   'load): it may be busy, or something between this machine and the server held the answer; not a '
                   'refusal. ' + _READ_AGAIN),
    'timed_out|unknown': ('Your request was sent to the Valun server, but no answer came in time, so ' + _WRITE_UNKNOWN),
    'not_json|': ("The Valun server's answer was not JSON, also when your Valun client asked again: it was cut "
                  'short, or something between this machine and the server (a captive portal, proxy or antivirus) '
                  'answered instead. ' + _READ_AGAIN),
    'not_json|unknown': ("Your request reached the Valun server, but its answer was not JSON (cut short, or not the "
                         "server's), so " + _WRITE_UNKNOWN),
    'too_large|unknown': ("Your request reached the Valun server, but its answer was too large to read (not the "
                          "server's), so " + _WRITE_UNKNOWN),
    'not_connected|': 'The Valun server could not be reached, so nothing was sent to it. ' + _READ_AGAIN,
    '|': ('The Valun server could not be reached, or its answer did not arrive. If this call was a commitment, read what '
          f'the server holds now ({_READ_FIRST}) before you send it again. ' + _READ_AGAIN),
}

# A redirect (client.redirect_error; JS the same, with no address: fetch does not show where a refused redirect pointed):
# the client follows none, so nothing was done, and only the owner can change the server's address (the RC's review:
# the 401 that came back from where a redirect pointed was called "not connected").
_ORIGIN_RE = re.compile(r'https?://[a-z0-9.-]{1,253}(:[0-9]{1,5})?|https?://\[[0-9a-f:.]{2,45}\](:[0-9]{1,5})?')


def redirected_text(location):
    """what_this_means of a redirect: where it pointed (an origin, as the client names it) when it is known."""
    where = f' to {location}' if isinstance(location, str) and _ORIGIN_RE.fullmatch(location) else ''
    return (f"The address set as this agent's Valun server answered with a redirect{where}, which your Valun client "
            'never follows, so nothing was done and nothing refused this agent. Tell your owner: if that is their Valun '
            "server's address now, they set it as this agent's server (the config server command of their Valun CLI).")


# A plain-http server on another machine (client.plain_http_refusal; the JS client the same): no token is sent there.
PLAIN_HTTP_TEXT = ("Your Valun client sends no token to this agent's Valun server: its address is plain http:// on "
                   'another machine, where a token would cross the network in clear text. Nothing was sent. Tell your '
                   "owner: they set the server's https:// address (the config server command of their Valun CLI), or, "
                   'only on a network they trust, VALUN_ALLOW_PLAIN_HTTP=1 sends tokens over plain http anyway.')
# Another server than the one this agent's profile joined (client.wrong_server_refusal): its tokens go only there.
WRONG_SERVER_TEXT = ("This call was meant for another Valun server than the one this agent's profile joined, so your Valun "
                     'client sent its token nowhere. Nothing was sent. Tell your owner: a profile moves to another server '
                     'only with the config server command of their Valun CLI.')


# `valun call` stopped (Ctrl+C) before the answer to a call that is not read-only arrived: its request may have reached
# the server, as a lost answer's (fix inbox #148), so it says the same.
INTERRUPTED_WORDS = 'Your Valun client was stopped (Ctrl+C) before the answer to this call arrived, so ' + _WRITE_UNKNOWN


def transport_words(code, cause, outcome):
    """TRANSPORT_WORDS for an error with no HTTP status (unreachable, bad_response): None when none applies (a
    bad_response that names no cause)."""
    known = lambda v: v is None or isinstance(v, str)  # noqa: E731
    fallback = TRANSPORT_WORDS['|'] if code == 'unreachable' else None
    if not (known(cause) and known(outcome)):
        return fallback
    if cause is None and code != 'unreachable':
        return None
    return TRANSPORT_WORDS.get(f"{cause or ''}|{outcome or ''}", fallback)


# What an exception's own words may carry that must never reach the model (error_payload's internal_error): a URL's
# user and password (urllib's ValueError for a proxy URL it cannot read quotes the whole URL: the RC's review, round
# 3), a bearer token, and a Valun agent or owner token. The JS errorPayload removes the same.
_URL_USERINFO = re.compile(r'\b([A-Za-z][A-Za-z0-9+.-]*:/{0,2})[^\s/@\'"<>]+@')
_BEARER = re.compile(r'(?i)\b(bearer)\s+[^\s\'"]+')
_VALUN_TOKEN = re.compile(r'\b(vp[a-z])_[A-Za-z0-9_-]+')


def redacted(text):
    """`text` without a URL's user and password, a bearer token or a Valun token (each replaced with ***)."""
    text = _URL_USERINFO.sub(r'\1***@', str(text))
    text = _BEARER.sub(r'\1 ***', text)
    return _VALUN_TOKEN.sub(r'\1_***', text)


def error_payload(e, setup_hint='run `valun join` (or `valun enroll`) in a terminal'):
    """A ValunError (or any exception) as a plain dict an agent can act on. Never includes secrets: any other
    exception's words are redacted (a URL's user and password, a token)."""
    if isinstance(e, vc.ValunError):
        out = {'error': e.code, 'message': str(e)}
        for k in ('rule', 'mandate_version', 'measured', 'retry_after_ms', 'template', 'fallback_after', 'what_this_means',
                  'cause', 'transport_error', 'outcome'):
            if k in e.extra:
                out[k] = e.extra[k]
        if e.code in ('unreachable', 'bad_response') and 'what_this_means' not in out and e.status is None:
            words = transport_words(e.code, out.get('cause'), out.get('outcome'))
            if words is not None:
                out['what_this_means'] = words
        if e.code == 'redirected' and 'what_this_means' not in out:
            out['what_this_means'] = redirected_text(e.extra.get('location'))
        if e.code == 'plain_http' and 'what_this_means' not in out:
            out['what_this_means'] = PLAIN_HTTP_TEXT
        if e.code == 'wrong_server' and 'what_this_means' not in out:
            out['what_this_means'] = WRONG_SERVER_TEXT
        if e.code == 'approval_unbound' and out.get('cause') == 'unknown_participant':
            # the counterparty (or issuer, or creditor) named is in no directory entry: reading a deal again cannot help
            out['what_this_means'] = UNKNOWN_PARTICIPANT_TEXT
        elif e.code == 'approval_unbound':
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
        if e.code == 'network_retired' and 'what_this_means' not in out:     # ValunAgent.retired() gives its own
            out['what_this_means'] = retired_text('another network')
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
    return {'error': 'internal_error', 'message': redacted(f'{type(e).__name__}: {e}')}


class ValunAgent:
    """The Valun tools over one participant's store.

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
    rejoin_hint: what the owner of a profile of the retired pilot network must do to join the network its server now
      serves, in a new profile (network_retired; retired()). Default DEFAULT_REJOIN_HINT.
    console_command: the command the owner runs in a terminal to open the owner console for this profile (`valun
      --profile NAME console`, as the CLI and the MCP server name it); an answer that waits for the owner names it
      (owner_wait). None: no command is named (a host with no Valun CLI).
    """

    def __init__(self, store, approvals='', check_link_hosts=True, setup_hint=None, server=None, process_consents=True,
                 consents_on_reads=False, declare_roles=None, brief_status=False, rejoin_hint=None, console_command=None):
        self.store = store
        self.approvals = approvals
        self.console_command = console_command if isinstance(console_command, str) and console_command else None
        self.check_link_hosts = check_link_hosts
        self.setup_hint = setup_hint or 'run `valun join` (or `valun enroll`) in a terminal'
        self.rejoin_hint = rejoin_hint or DEFAULT_REJOIN_HINT
        self.server = server
        self.process_consents = process_consents is True
        self.consents_on_reads = consents_on_reads is True
        self.declare_roles = self.process_consents if declare_roles is None else declare_roles is True
        self.brief_status = brief_status is True    # valun_status answers the brief view unless brief=false is passed
        self.features = None        # the feature tags the last GET /info this agent read listed (None: none read yet)
        self.handlers = {'valun_status': self.status, 'valun_directory': self.directory, 'valun_inbox': self.inbox,
                         'valun_deal': self.deal, 'valun_propose': self.propose, 'valun_respond': self.respond,
                         'valun_deliver': self.deliver, 'valun_review_delivery': self.review, 'valun_set_limits': self.set_limits,
                         'valun_guarantees': self.guarantees, 'valun_offer_guarantee': self.offer_guarantee,
                         'valun_respond_guarantee': self.respond_guarantee, 'valun_call_guarantee': self.call_guarantee,
                         'valun_check_payer': self.check_payer}

    # ---------- plumbing ----------
    def client(self, require_connection=True):
        c = vc.Client(self.store, server=self.server, declare_roles=self.declare_roles)
        if require_connection and (not c.connected or not c.participant_id):
            raise vc.ValunError('not_connected', f'not enrolled: the owner must {self.setup_hint}')
        return c

    def call(self, name, args=None):
        """Run one tool. Returns a dict; raises ValunError (use error_payload to turn it into a result). Its arguments
        are checked first (tool_arguments, fix inbox #58: bad_arguments for arguments that are not a JSON object, lack
        a required one or, since 0.7.2, have one of another type than its schema's, before anything is read or signed;
        a value an enum does not list keeps its tool's code, bad_decision say). Before a tool that is not read-only, the
        client signs the consents its owner's policy allows (consents_if_due). With consents_on_reads, before
        valun_status and valun_inbox it signs the value-safe ones (consents_on_read), and when that run took place the result adds
        consents_signed_now: one entry (SIGNED_NOW_KEYS) for each consent it signed ([]: none). Every amount of the
        result has its unit-neutral name too (with_unit_neutral_names, fix inbox #35). A profile of the retired pilot
        network gets network_retired instead of the refusal its server gives it (retired(); fix inbox #30)."""
        if name not in self.handlers:
            raise vc.ValunError('unknown_tool', f'no Valun tool called {name!r}')
        a = self.tool_arguments(name, args)
        try:
            return self._run_tool(name, a)
        except vc.ValunError as e:
            retired = self.retired(e)
            if retired is None:
                raise
            raise retired from None

    def retired(self, e):
        """network_retired, for a profile of the pilot network (valun-pilot-1, retired on 2026-11-13; fix inbox #30), in
        place of a refusal it meets on a server that now serves another network: one of RETIRED_CODES, or
        approval_unbound with one of them as its cause. One GET /info, read only then, names the server's network
        (client.retired_pilot); its what_this_means says how to join again (rejoin_hint). None for any other error or
        profile, and when that read fails: the refusal then stands as it is."""
        if not isinstance(e, vc.ValunError):
            return None
        code = (e.extra or {}).get('cause') if e.code == 'approval_unbound' else e.code
        if code not in RETIRED_CODES:
            return None
        try:
            c = self.client(require_connection=False)
            if vc.profile_network(c.state) != vc.NETWORK:
                return None
            info = c.request('GET', '/pilot/v1/info', auth=False)
        except Exception:  # noqa: BLE001 - the server's network is not known: the refusal stands
            return None
        net = info.get('network') if isinstance(info, dict) else None
        if not vc.retired_pilot(c.state, net):
            return None
        shown_net = net if net in vc.NETWORKS else 'another network'    # the server's word: only a known name
        return vc.ValunError('network_retired', f'this profile is on the pilot network ({vc.NETWORK}), retired on '
                             f'{vc.PILOT_RETIRED_ON}; the server now serves {shown_net}; nothing was signed',
                             extra={'what_this_means': retired_text(shown_net, self.rejoin_hint)})

    def _run_tool(self, name, a):
        """call() once its arguments are checked."""
        if name not in READ_ONLY_TOOLS:
            self.consents_if_due()
            return with_unit_neutral_names(self.handlers[name](a))
        report = self.consents_on_read() if name in CONSENTS_ON_READ_TOOLS else None
        out = self.handlers[name](a)
        if report is not None and isinstance(out, dict):
            out['consents_signed_now'] = [{k: e.get(k) for k in SIGNED_NOW_KEYS} for e in report.get('signed') or []
                                          if isinstance(e, dict)]
        return with_unit_neutral_names(out)

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
        ValunAgent._mark(c, key, now)

    @staticmethod
    def _mark(c, key, value):
        """state[key] = value in the profile, through the store's update() where it has one (FileStore: under the
        profile lock, on the state reloaded from disk). A mark that fails is not retried, and never fails the call."""
        def mark(state):
            state[key] = value
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
        to (tracker_mismatch) or another network than the profile's (wrong_network), which stops the call: its owner is
        then not asked to approve what cannot be signed (a profile of the retired pilot gets network_retired)."""
        if self.features is not None:
            return CIRCULATION in self.features
        if deal is not None and not (isinstance(deal, dict) and 'payment' in deal):
            return False
        try:
            return CIRCULATION in self._remember(c.info())
        except vc.ValunError as e:
            if e.code in ('tracker_mismatch', 'wrong_network'):
                raise
            return False
        except Exception:  # noqa: BLE001 - a client that cannot read /info: as without circulation
            return False

    def tool_arguments(self, name, args):
        """The module's tool_arguments() (fix inbox #58), with this profile's unit for the words of an amount, read from
        its own records: nothing is read from the server (the pilot's PC when the profile cannot be read). A profile
        that has not joined yet is refused in the words of the one network it would join (client.profile_network; fix
        inbox #15): nanoERG, not the retired pilot's PC."""
        try:
            c = self.client(require_connection=False)
            state = getattr(c, 'state', None)
            if isinstance(state, dict) and not (state.get('network') or state.get('participant_id')):
                unit = vc.NETWORKS[vc.profile_network(state)]['unit']
            else:
                unit = getattr(c, 'unit', vc.UNIT)
        except Exception:  # noqa: BLE001 - a profile that cannot be read now: the call refuses it later, with its own code
            unit = vc.UNIT
        return tool_arguments(name, args, unit if isinstance(unit, str) else vc.UNIT)

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
        valun_respond_guarantee with action exactly 'accept', 'decline' or 'withdraw' (taking or refusing a backing, or
        taking back an offer, commits the owner to nothing), valun_call_guarantee (a claim the owner gains by), and
        valun_set_limits calls that do not loosen a recorded limit. Every other call, including any tool name this
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
        if name == 'valun_respond_guarantee':
            return a.get('action') not in ('accept', 'decline', 'withdraw')
        if name == 'valun_call_guarantee':
            return False
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
        or wrong hash, or a pin the agent passed that is not the snapshot's; with the cause bad_arguments, before any
        read, for arguments the tool refuses: tool_arguments): the adapter must then refuse the call. A tool this client
        does not know gets a generic text; a known commitment never does."""
        a = dict(args) if isinstance(args, dict) else {}
        if name not in self.handlers:
            return {'args': a, 'text': GENERIC_TEXT.format(name=shown(name))}
        if not self._may_commit(name, a):
            return {'args': a, 'text': None}
        try:
            self.tool_arguments(name, args)          # fix inbox #58: not a JSON object, a required argument missing, or one
            render = self._text_for(name, a)          # of the wrong type; before any read: a misspelt action has no text
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
        itself (not_connected, not_configured, tracker_mismatch), with its own advice, and so do arguments the tool
        refuses before anything is read (tool_arguments: bad_arguments, or a misspelt value's own code such as
        bad_decision, as the call itself answers; fix inbox #58). A profile of the retired pilot network gets
        network_retired (retired(); fix inbox #30)."""
        if name in TOOL_NAMES:
            try:
                self.tool_arguments(name, args)
            except vc.ValunError as e:
                return None, error_payload(e, self.setup_hint)
        extra = {}
        try:
            prepared = self.prepare(name, args)
        except Exception as e:  # noqa: BLE001 - whatever went wrong, nothing is asked and nothing is signed
            prepared = None
            retired = self.retired(e)
            if retired is not None:
                return None, error_payload(retired, self.setup_hint)
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
        if name == 'valun_respond_guarantee' and a.get('action') in ('release', 'honor'):
            return not a.get('expected_terms_hash') or (a.get('action') == 'honor' and not a.get('call_id'))
        if name == 'valun_offer_guarantee':
            return True
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
        unit, net = getattr(c, 'unit', vc.UNIT), getattr(c, 'network', vc.NETWORK)
        if name == 'valun_propose':
            other = self._resolve(c, a.get('counterparty'))
            if not (isinstance(other, dict) and isinstance(other.get('id'), str) and other['id']):
                raise vc.ValunError('approval_unbound', 'the directory names no participant id')
            circulating = self._known_circulation(c)
            return {'counterparty': other, 'circulating': circulating, 'not_settled': labels(circulating, net)['not_settled'],
                    'unit': unit, 'network': net}
        if name == 'valun_set_limits':
            me = c.me()
            if not isinstance(me, dict):
                raise vc.ValunError('approval_unbound', 'the server sent no participant record')
            return {'me': me}
        if name == 'valun_offer_guarantee':
            people = {r: self._resolve(c, a.get(r)) for r in ('issuer', 'creditor')}
            if not all(isinstance(p, dict) and isinstance(p.get('id'), str) and p['id'] for p in people.values()):
                raise vc.ValunError('approval_unbound', 'the directory names no participant id')
            return {**people, 'not_settled': labels(self._known_circulation(c), net)['not_settled'], 'unit': unit, 'network': net}
        if name == 'valun_respond_guarantee':
            gid = self._gid(a.get('guarantee_id'))
            g = c.guarantee(gid)
            role = 'backer' if a.get('action') == 'honor' else 'creditor'
            chk = c.verify_guarantee(g, role)
            snap = {'guarantee': g, 'checked': chk, 'not_settled': labels(True, net)['not_settled'], 'unit': unit, 'network': net}
            if a.get('action') == 'honor':
                calls = [x for x in (g.get('calls') or []) if isinstance(x, dict)]
                cid = a.get('call_id')
                call = next((x for x in calls if x.get('call_id') == cid), None) if cid else \
                    next((x for x in calls if x.get('state') in ('open', 'failed')), None)
                if call is None or call.get('state') not in ('open', 'failed') or not _whole(call.get('amount')) \
                        or not (isinstance(call.get('call_id'), str) and _CALL_ID.fullmatch(call['call_id'])):
                    raise vc.ValunError('nothing_to_honor', 'no call of this guarantee is waiting to be honored')
                snap['call'] = call
            return snap
        did = a.get('deal_id')
        if not (isinstance(did, str) and _DEAL_ID.fullmatch(did)):
            raise vc.ValunError('bad_arguments', 'deal_id is missing or malformed')
        d = c.deal(did)
        if not isinstance(d, dict):
            raise vc.ValunError('approval_unbound', 'the deal could not be read')
        snap = {'deal': d, 'checked': self._checked(d, did, c.participant_id, delivery=name == 'valun_review_delivery', unit=unit)}
        snap['circulating'] = self._known_circulation(c, d)      # read after the check, as before: what owes() says
        snap.update(not_settled=labels(snap['circulating'], net)['not_settled'], unit=unit, network=net)
        if name == 'valun_review_delivery' and a.get('decision') == 'accept' and self._pay_with(a) is not None:
            snap['transfer'] = self._transfer_snapshot(c, did, snap['checked'], self._pay_with(a))
            snap['not_settled'] = labels(True, net)['not_settled']
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
               'unit': getattr(c, 'unit', vc.UNIT),
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
    def _checked(d, did, me, delivery=False, unit=vc.UNIT):
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
        if not (isinstance(price, dict) and _whole(price.get('amount')) and price.get('unit') == unit):
            raise vc.ValunError('bad_terms', f'the price is not a whole number of {unit}')
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
        elif name == 'valun_offer_guarantee' and 'issuer' in snap:
            a['issuer'], a['creditor'] = snap['issuer']['id'], snap['creditor']['id']   # exactly the participants shown
        elif name == 'valun_respond_guarantee' and a.get('action') in ('release', 'honor'):
            pin('expected_terms_hash', chk['terms_hash'], 'stale_terms', 'the guarantee changed after your agent read it')
            if a.get('action') == 'honor':
                pin('call_id', snap['call']['call_id'], 'stale_call', 'the call is not the one your agent read')
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
        if name == 'valun_offer_guarantee':
            return self._text_offer_guarantee
        if name == 'valun_respond_guarantee' and a.get('action') == 'release':
            return self._text_release_guarantee
        if name == 'valun_respond_guarantee' and a.get('action') == 'honor':
            return self._text_honor_guarantee
        raise vc.ValunError('approval_unbound', f'no approval text for {name} with these arguments')

    @staticmethod
    def _text_offer_guarantee(a, snap):
        u = snap.get('unit', vc.UNIT)
        issuer, creditor = shown(snap['issuer'].get('handle')), shown(snap['creditor'].get('handle'))
        cap, due, window, honor, ttl = (_guarantee_int(a, k, d) for k, d in (('cap', None), ('due_in_hours', None), ('callable_for_hours', 168),
                                                                             ('honor_within_hours', 24), ('offer_valid_hours', 24)))
        return '\n'.join([
            f"Valun - sign a GUARANTEE: back what {issuer} ({shown(snap['issuer']['id'])}) owes {creditor} ({shown(snap['creditor']['id'])}):",
            (f'  you pay {creditor} up to {vc.amount_text(cap, u)} in all, for what {issuer} still owes it for the deals '
             f"{', '.join(shown(d) for d in a['deals'])} after {due} h from now (debt from any other deal is not covered),"
             if isinstance(a.get('deals'), list) and a.get('deals') else
             f'  you pay {creditor} up to {vc.amount_text(cap, u)} in all, for what {issuer} still owes it after {due} h from now '
             f'(any debt to it, also new debt: the cap is your exposure),'),
            f'  if {creditor} calls in the {window} h after that; you pay a call within {honor} h, with your own credit note',
            f'  the offer stays open {ttl} h; until the guarantee ends its cap counts against your limits as credit you may have to issue',
            f'If {creditor} accepts and calls, you will owe {creditor} what it called (your credit note); {issuer} still owes it too.',
            snap.get('not_settled', NOT_SETTLED),
            quote_line('Note written by your agent', {'note': a.get('note') or ''})])

    @staticmethod
    def _text_release_guarantee(a, snap):
        chk, g, u = snap['checked'], snap['guarantee'], snap.get('unit', vc.UNIT)
        t = chk['terms']
        backer, issuer = shown(_party(g, 'backer', t)), shown(_party(g, 'issuer', t))
        open_calls = [x for x in (g.get('calls') or []) if isinstance(x, dict) and x.get('state') in ('open', 'failed')]
        return '\n'.join([
            f"Valun - RELEASE guarantee {shown(g.get('guarantee_id'))} from {backer}: it backs what {issuer} owes you, up to "
            f"{vc.amount_text(t['cap']['amount'], u)}.",
            '  after this you can no longer call it' + (f'; its {len(open_calls)} unhonored call(s) end too' if open_calls else ''),
            f"  terms hash {chk['terms_hash'][:16]}... (recomputed from these terms; your Valun client checks it again before signing)",
            f'Releasing gives up the protection; {issuer} still owes you what it owes.'])

    @staticmethod
    def _text_honor_guarantee(a, snap):
        chk, g, call, u = snap['checked'], snap['guarantee'], snap['call'], snap.get('unit', vc.UNIT)
        t = chk['terms']
        creditor, issuer = shown(_party(g, 'creditor', t)), shown(_party(g, 'issuer', t))
        amount = call['amount']
        return '\n'.join([
            f"Valun - HONOR call {shown(call.get('call_id'))} of your guarantee {shown(g.get('guarantee_id'))}: ISSUE A CREDIT NOTE "
            f'of {vc.amount_text(amount, u)} to {creditor}:',
            f"  you backed what {issuer} owes {creditor}, up to {vc.amount_text(t['cap']['amount'], u)}; honored so far: "
            f"{vc.amount_text(g.get('honored') if _whole(g.get('honored')) else 0, u)}",
            f"  {issuer} owes {creditor} {shown(g.get('issuer_owes_creditor'))} {u} on the tracker now (as the server shows it); "
            f"the call is due by {shown(call.get('honor_by'))}",
            f"  terms hash {chk['terms_hash'][:16]}... (your Valun client checks the guarantee, the creditor's signature on the call "
            'and your own record of the cap again before signing)',
            f'Your agent signs a Basis note; {tracker_words(snap.get("network"))} then records that you owe {creditor} '
            f'{vc.amount_text(amount, u)} more.',
            snap.get('not_settled', NOT_SETTLED)])

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
        other, u = snap['counterparty'], snap.get('unit', vc.UNIT)
        _required(a, PROPOSE_TEXTS[1:])     # what propose() refuses (fix inbox #58) is never put to the owner; the
        # counterparty is the snapshot's (bound by _bind_from)
        role = a.get('role')
        if role not in ('payer', 'payee'):
            raise vc.ValunError('bad_role', 'role must be payer or payee')
        price, due, ttl = ValunAgent._offer_numbers(a, u)      # exactly what propose() signs, or its refusal
        who = shown(other.get('handle'))
        return '\n'.join([
            f"Valun - sign a NEW OFFER to {who} ({shown(other['id'])}):",
            f'  you are the {ROLE_WORDS[role]}; price: {vc.amount_text(price, u)}',
            f'  deliver within {due} h; the offer stays open {ttl} h',
            f'If {who} accepts, the deal is binding without asking you again: ' + owes(role, who, price, u, snap.get('circulating')),
            snap.get('not_settled', NOT_SETTLED),
            quote_line('Offer text written by your agent', {k: a.get(k) for k in ('title', 'description', 'deliverable')})])

    @staticmethod
    def _offer_numbers(a, unit):
        """valun_propose's price, deliver_within_hours (default 48) and offer_valid_hours (default 24, and never longer
        than the hours it gives to deliver: a 6 h job's offer stays open 6 h): each a JSON integer of at least 1
        (_count), the hours at most HOURS_MAX (_hours_or), and the offer open no longer than the hours it gives to deliver
        (check_offer_hours). Exactly what propose() signs, or bad_arguments before anything is read or signed (also for
        a missing price: fix inbox #58)."""
        price = _count('price', a.get('price'), unit)
        due = _hours_or(a, 'deliver_within_hours', 48)
        ttl = _hours_or(a, 'offer_valid_hours', min(24, due))
        vc.check_offer_hours(ttl, due)
        return price, due, ttl

    @staticmethod
    def _counter_numbers(a, unit):
        """valun_respond counter's price, deliver_within_hours and offer_valid_hours: each None when absent or null (the
        price and deadline of their offer; Client.counter's default validity), else a JSON integer of at least 1
        (_count), the hours at most HOURS_MAX (_hours_or); with both hours given, the counter-offer open no longer than
        the hours it gives to deliver."""
        price = _count_or(a, 'price', unit)
        hours, ttl = _hours_or(a, 'deliver_within_hours'), _hours_or(a, 'offer_valid_hours')
        if hours is not None and ttl is not None:
            vc.check_offer_hours(ttl, hours)
        return price, hours, ttl

    @staticmethod
    def _hours_to_deliver(deadline):
        """The hours Client.counter() gives a counter-offer to deliver when it keeps the deadline of the offer it answers:
        the whole hours left until `deadline`, at least 1. None when the deadline cannot be read."""
        try:
            left = datetime.fromisoformat(str(deadline).replace('Z', '+00:00')) - datetime.now(timezone.utc)
        except (TypeError, ValueError):
            return None
        return max(1, int(left.total_seconds() // 3600))

    def _text_accept(self, a, snap):
        chk = snap['checked']
        t, who, price, svc = chk['terms'], self._who(chk), chk['price'], chk['service']
        u = snap.get('unit', vc.UNIT)
        return '\n'.join([
            f"Valun - ACCEPT {who}'s offer ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}, version {shown(t.get('version'))}):",
            f"  you are the {ROLE_WORDS[chk['role']]}; price: {vc.amount_text(price, u)}; deliver by {shown(t.get('deliver_by'))}",
            f"  terms hash {chk['terms_hash'][:16]}... (recomputed from these terms; your Valun client checks it again before signing)",
            'This makes the deal binding on both sides: ' + owes(chk['role'], who, price, u, snap.get('circulating')),
            snap.get('not_settled', NOT_SETTLED),
            quote_line(f'Offer text written by {who}', {k: svc.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_counter(self, a, snap):
        chk = snap['checked']
        t, who, old, svc = chk['terms'], self._who(chk), chk['price'], chk['service']
        u = snap.get('unit', vc.UNIT)
        # Exactly what Client.counter() signs: these arguments, and the rest copied from the terms pinned by hash.
        new, hours, ttl = ValunAgent._counter_numbers(a, u)
        if ttl is not None and hours is None:     # their deadline, in the whole hours Client.counter() will give to deliver
            due = self._hours_to_deliver(t.get('deliver_by'))
            if due is not None:
                vc.check_offer_hours(ttl, due)
        price = old if new is None else new
        texts = [k for k in ('title', 'description', 'deliverable') if a.get(k)]
        changes = ([f'price {old} -> {price} {u}'] if new is not None else []) \
            + ([f'deliver within {hours} h'] if hours is not None else []) + [f'{k} (quoted below)' for k in texts]
        stays = (f'the counter-offer stays open {ttl} h' if ttl is not None else
                 f'the counter-offer stays open {vc.COUNTER_OFFER_HOURS} h, or less: never past its delivery deadline, nor past '
                 f"{shown(t.get('offer_expires_at'))}, when their offer ends")
        return '\n'.join([
            f"Valun - sign a COUNTER-OFFER to {who} ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}), "
            f"replacing their version {shown(t.get('version'))}:",
            f"  you are the {ROLE_WORDS[chk['role']]}; price: {vc.amount_text(price, u)}",
            '  deliver ' + (f'within {hours} h of signing' if hours is not None else
                            f"by {shown(t.get('deliver_by'))} as in their offer (rounded down to the hour, at least 1 h after signing)"),
            '  your agent changes: ' + (', '.join(changes) or 'nothing') + '; ' + stays,
            f'If {who} accepts it, the deal is binding without asking you again: ' + owes(chk['role'], who, price, u,
                                                                                       snap.get('circulating')),
            snap.get('not_settled', NOT_SETTLED),
            quote_line(f"Counter-offer text, with what your agent did not change copied from {who}'s offer",
                       {k: a[k] if a.get(k) else svc.get(k) for k in ('title', 'description', 'deliverable')})])

    def _text_review(self, a, snap):
        chk = snap['checked']
        t, who, price, svc, dl, content = chk['terms'], self._who(chk), chk['price'], chk['service'], chk['delivery'], chk['content']
        u = snap.get('unit', vc.UNIT)
        m = measure.measure(content, service_text(svc), check_hosts=False)
        facts = [f"{x['requirement']}: {x['measured']} ({'met' if x['met'] else 'NOT met'})" for x in m['checks_against_agreed_terms']]
        facts += exact_facts(t, content, chk.get('handle'))
        return '\n'.join([
            f"Valun - ACCEPT {who}'s delivery ({shown(chk['other_id'])}, deal {shown(t['deal_id'])}) and ISSUE A CREDIT NOTE "
            f'of {vc.amount_text(price, u)} to {who}:',
            f"  delivered: {len(content.encode('utf-8'))} bytes, sha256 {chk['sha256'][:16]}... (recomputed from the text measured here)",
            '  measured: ' + ('; '.join(facts) or f"{m['word_count']} words, {len(m['links'])} links"),
            f"  agreed terms hash {chk['terms_hash'][:16]}... (your Valun client checks both hashes again before signing)",
            f'Your agent signs a Basis note; {tracker_words(snap.get("network"))} then records that you owe {who} '
            f'{vc.amount_text(price, u)} more.',
            snap.get('not_settled', NOT_SETTLED),
            quote_line('Delivery title and agreed service text', {'delivery_title': dl.get('title') or '', 'title': svc.get('title'),
                                                                  'deliverable': svc.get('deliverable')})])

    def _text_pay(self, a, snap):
        """A delivery acceptance paid with a held note (pay_with): what moves, from the checked transfer template."""
        chk, tr = snap['checked'], snap['transfer']
        t, svc, dl, content, price = chk['terms'], chk['service'], chk['delivery'], chk['content'], chk['price']
        u = snap.get('unit', vc.UNIT)
        payee = self._who(chk)
        iss = tr['issuer']
        issuer = shown(iss['handle']) if isinstance(iss.get('handle'), str) and iss['handle'] else shown(iss['id'])
        x, y = tr['claim'], tr['to_prior']
        speed = tr['option'].get('issuer_consents')
        m = measure.measure(content, service_text(svc), check_hosts=False)
        facts = [f"{x_['requirement']}: {x_['measured']} ({'met' if x_['met'] else 'NOT met'})" for x_ in m['checks_against_agreed_terms']]
        facts += exact_facts(t, content, chk.get('handle'))
        return '\n'.join([
            f"Valun - PAY {payee} {vc.amount_text(price, u)} for deal {shown(t['deal_id'])} by moving {vc.amount_text(price, u)} "
            f"of {issuer}'s debt from you "
            f'to {payee}:',
            f'  your claim on {issuer}: {x} -> {x - price} {u} (issuer signature checked by your client)',
            f'  {issuer} will owe {payee} {y} -> {y + price} {u}; its total debt does not change',
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
        brief = a.get('brief') if isinstance(a, dict) else None
        brief = self.brief_status if brief is None else brief       # null is not given (fix inbox #58 review)
        if not isinstance(brief, bool):
            raise vc.ValunError('bad_arguments', 'brief must be true or false')
        out = self._full_status()
        return brief_status(out) if brief else out

    def _full_status(self):
        c = self.client()
        me, info = c.me(), c.info()
        circulating = CIRCULATION in self._remember(info)
        u, net = getattr(c, 'unit', vc.UNIT), getattr(c, 'network', vc.NETWORK)
        lab = labels(circulating, net)
        recorded = me.get('agent_limits') or {}
        # The approvals sentence of this adapter's mode, then what the server holds for the owner by the mandate in force
        # (approve_above and review_deliveries: the approval semantics of 2026-11-17), and where the owner decides.
        approvals = (self.approvals or 'Commitments are signed without asking your owner first.')
        approvals += ' ' + held_for_owner(me['mandate'], c.state.get('server'), u, console=self.approvals == CONSOLE_APPROVALS)
        words = self_serve_words(me['participant'], info)
        out = {'connected': True, 'server': c.state['server'], 'network': info['network'],
               'unit': info['unit'] + UNIT_WORDS.get(info['unit'], ''),
               'you': me['participant'], **({'you_are': words} if words else {}),
               'objective_from_your_owner': me['mandate'].get('objective') or '(none set)',
               'goals_your_owner_told_you': recorded.get('notes') or '(none recorded yet: ask your owner, then use valun_set_limits)',
               'limits_you_recorded': {k: v for k, v in recorded.items() if k not in ('notes', 'set_at')},
               'limits_in_force': {arg: (me.get('effective_limits') or me['mandate']).get(field) for arg, (field, _k) in LIMIT_FIELDS.items()},
               'mandate': {k: v for k, v in me['mandate'].items() if k != 'objective'}, 'mandate_version': me['mandate_version'],
               'approvals': approvals, 'position': me['position']}
        if isinstance(me.get('room'), dict):        # budget cards: what this agent owes now and may still owe
            out['room'] = me['room']
        out.update({'authority': me['authority'], 'settlement': lab['settlement'], 'honest_labels': lab['honest_labels'],
                    'real_vs_simulated': lab['real_vs_simulated']})
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
        u = getattr(c, 'unit', vc.UNIT)
        signs = client_signs(policy, u)
        hold, owe, net = pos.get('claims_held'), pos.get('owes'), pos.get('net')
        cleared = pos.get('cleared_by_setoff', pos.get('settled', 0))
        pending = box.get('consents_waiting_for_your_client')
        if pending is None and isinstance(pos.get('pending'), dict):
            pending = pos['pending'].get('consents_waiting_for_you')
        log = c.state.get('consent_log') if isinstance(c.state.get('consent_log'), list) else []
        spend = sum(n['amount_PC'] for n in notes)
        summary = (f'You hold {shown(hold)} {u} of credit notes others issued to you and owe {shown(owe)} {u} (net {shown(net)} {u}); '
                   f'set-offs have cleared {shown(cleared)} {u} so far. '
                   + (f"You can spend {vc.amount_text(spend, u)} of notes you hold ({', '.join(shown(n['issuer']) for n in notes)}) with pay_with "
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
                                              'cleared_so_far counts what set-offs cancelled. ' + VALUE_WORDS.get(u, VALUE_WORDS['PC']))},
               'notes_you_can_spend': notes,
               'payments_in_progress': box.get('payments_in_progress') if isinstance(box.get('payments_in_progress'), list) else [],
               'clearing': {'your_client_signs': signs, 'consents_pending': pending,
                            'recent': [{k: e.get(k) for k in ('at', 'kind', 'decision', 'code', 'amount', 'your_net_change_PC')}
                                       for e in log[-5:] if isinstance(e, dict)]},
               'consent_policy_in_force': policy}
        waiting = guarantees_waiting(box.get('guarantees'))
        if waiting:
            out['guarantees_waiting'] = waiting
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
        from what you hold and owe. Wait (no calls) while the sandbox agents or a set-off are working. Once the end has
        been seen, the profile keeps it (TOUR_DONE_KEY) and the tour stays done, whatever is dealt with them later. A
        done plan asks for no retry."""
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
                return 1 if role == 'payee' else (5 if hm >= sandbox.price_of('notary', getattr(c, 'network', None)) else 3)
            return 2 if role == 'payer' else 4

        def plan(step, calls, then, retry_after_seconds=SANDBOX_RETRY_S):
            done = TOUR_AFTER.get(step) if isinstance(step, int) else None
            scale = getattr(c, 'scale', 1)
            return {'tour_step': step, 'of': 5, 'goal': tour_goal(step, getattr(c, 'unit', vc.UNIT), scale),
                    'next_calls': calls, 'then': then, 'with_the_sandbox_agents': held,
                    **({'when_done': {'you_hold_PC': done[0] * scale, 'you_owe_PC': done[1] * scale}} if done else {}),
                    # fix-inbox #8: how long to wait before calling valun_status again, so a small model does not poll
                    **({'retry_after_seconds': retry_after_seconds} if retry_after_seconds else {})}

        def call(tool, args, why):
            return {'tool': tool, 'arguments': args, 'why': why}
        if c.participant_id and c.state.get(TOUR_DONE_KEY) == c.participant_id:
            return plan('done', [], TOUR_COMPLETED, None)    # done once: what it holds and owes now is not a tour step

        def offer(step, cp, role, service):
            price = sandbox.price_of(service, getattr(c, 'network', None))
            args = {'counterparty': cp, 'role': role, 'title': f'{service} job',
                    'description': f'{service} for this text:\n```\n{TOUR_TEXTS[step]}\n```',
                    'deliverable': f'The exact {service} result as JSON.', 'price': price, 'deliver_within_hours': 24,
                    'offer_valid_hours': 1}
            why = (f'buy {service} from {cp} for {price} {getattr(c, "unit", vc.UNIT)}' if role == 'payer' else f'offer to sell {service} to {cp} for {price} {getattr(c, "unit", vc.UNIT)}')
            return plan(step, [call('valun_propose', args, why)],
                        f'{cp} answers within a few seconds; call valun_status again for the next step.')
        wait = 'The sandbox agents act within a few seconds: call valun_status again.'
        if listed['awaiting_your_owner']:
            x = listed['awaiting_your_owner'][0]
            where, _wait = owner_wait(c, {'approvals': [{'id': x.get('approval_id'), 'state': 'pending'}]}, x.get('deal_id'),
                                      self.console_command)
            # A held IOU names the console's deadline for it, and once the tracker's hour has passed, that the owner must
            # reject it (the 0.7.2 review: an approval then fails at the tracker and leaves the delivery accepted and no
            # longer disputable).
            by, exp, passed = held_note_of(c, x, int(vc.time.time() * 1000))
            if passed:
                return plan(None, [], f'The IOU you signed for deal {shown(x.get("deal_id"))} still waits for your '
                                      f'owner{where}, but the tracker records it only until {exp}, which has passed: tell '
                                      'your owner to reject it there (approved now, it would fail at the tracker and leave '
                                      'the delivery accepted, unpaid and no longer disputable), then call valun_status '
                                      'again: the next step pays the deal again.', OWNER_RETRY_S)
            return plan(None, [], f'Your owner must first approve a commitment{where}'
                                  + (f' (an IOU: by {_deadline_words(by, exp)})' if exp else '')
                                  + '; tell them, then call valun_status again.', OWNER_RETRY_S)
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
                exact = sandbox.check_built_in(terms, dl.get('content'), cp)
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
            service = (exact or {}).get('service') or 'result'
            reason = (f'The delivery is not in the built-in format: it has no ```json result block to compare with the exact '
                      f'{service} of the agreed text.' if (exact or {}).get('built_in_format') is False else
                      f'The delivered result does not match the exact {service} of the agreed text (differs in: {fields}).')
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
            # Step 4's 3-cycle sandbox-mallory -> you -> sandbox-exact -> sandbox-mallory has a third leg that is not
            # yours: sandbox-exact's debt to sandbox-mallory (your step 2 moved part of it there). Without it no set-off
            # can be proposed, and waiting for one only ran into the tour's deadline (onboarding review, 2026-11-16).
            if hx == 0 and self._sandbox_leg(c, pos) == 0:
                u = getattr(c, 'unit', vc.UNIT)
                then = ('The 3-cycle sandbox-mallory -> you -> sandbox-exact -> sandbox-mallory cannot clear now: '
                        'it needs sandbox-exact to owe sandbox-mallory, and on the tracker sandbox-exact owes '
                        'sandbox-mallory nothing, so no set-off can be proposed. Nothing is lost: you hold '
                        f"{vc.amount_text(hm, u)} of sandbox-mallory's notes and owe {vc.amount_text(ox, u)} to "
                        'sandbox-exact. It can clear once sandbox-exact owes sandbox-mallory again; call '
                        'valun_status again in a minute, and if nothing has changed in a few minutes, stop and take '
                        'the tour again later: it goes on from here.')
                p = plan(4, [], then, CYCLE_LEG_RETRY_S)
                p['blocked'] = 'cycle_leg_missing'
                return p
            return plan(3 if hx > 0 else 4, [], ('A set-off of the cycle is due: your Valun client signs it by itself at its '
                                                 'next consent run (within about a minute). Call valun_status again.'),
                        SETOFF_DUE_RETRY_S)
        notary = sandbox.price_of('notary', getattr(c, 'network', None))
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
            self._mark(c, TOUR_DONE_KEY, c.participant_id)      # kept: later deals with them are not tour steps
            return plan('done', [], self._tour_done_text(pos, cleared, getattr(c, 'unit', vc.UNIT)), None)
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
    def _sandbox_leg(c, pos):
        """What sandbox-exact owes sandbox-mallory on the tracker: the leg of step 4's 3-cycle that is not the
        participant's own, from sandbox-exact's public record (GET /participants/{id}: its public_position debts), the
        narrowest read the server offers. 0.7.2's candidate read the whole public ledger here (about 270 KB) on every
        valun_status of step 4, every 3 seconds while the tour waited (the 0.7.2 review; fix inbox #128, #132).
        sandbox-exact's id is the one the participant's own debt to it names (position debts, recipient_id). None when
        that id is not known, or the record cannot be read now or shows no debts (then nothing is concluded from it)."""
        debts = pos.get('debts') if isinstance(pos, dict) and isinstance(pos.get('debts'), list) else []
        ids = sorted({d.get('recipient_id') for d in debts if isinstance(d, dict) and d.get('to') == SANDBOX_EXACT
                      and isinstance(d.get('recipient_id'), str) and vc._PID_RE.fullmatch(d['recipient_id'])})
        if len(ids) != 1:
            return None
        try:
            rec = c.participant(ids[0])
        except (vc.ValunError, AttributeError):
            return None
        pp = rec.get('public_position') if isinstance(rec, dict) and rec.get('handle') == SANDBOX_EXACT else None
        owes = pp.get('debts') if isinstance(pp, dict) else None
        if not isinstance(owes, list):
            return None
        return sum(d['amount'] for d in owes if isinstance(d, dict) and d.get('to') == SANDBOX_MALLORY and _whole(d.get('amount')))

    @staticmethod
    def _tour_done_text(pos, cleared, unit=vc.UNIT):
        """What the tour did, from the participant's own position: earned (hold + spent by transfer + cleared), spent by
        transfer (transferred_out) and with its own notes (owes + cleared), and what set-offs cleared. Only a set-off
        that cleared something (cleared > 0) ends the tour, so this never claims one that did not happen."""
        hold, owe, out = pos.get('claims_held'), pos.get('owes'), pos.get('transferred_out')
        text = 'The tour is complete: '
        if _whole(hold) and _whole(owe) and _whole(out):
            text += (f'you earned {hold + out + cleared} {unit} and spent {out + owe + cleared} {unit} ({out} by transfer, '
                     f'{owe + cleared} with your own note), and ')
        text += (f'set-offs cancelled {cleared} {unit} of your claims and {cleared} {unit} of your debts without changing your net '
                 'position.')
        if (_whole(hold) and hold > 0) or (_whole(owe) and owe > 0):
            text += f' You still hold {shown(hold)} {unit} and owe {shown(owe)} {unit}.'
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
        """One page of the active participants other than this one (fix inbox #36), from the list's own fields: those
        matching `query` (case-insensitive) in their handle or display name first, then in services or wants, then only in
        about (then the rest the text filter matches, across two fields); then the always-on agents the server runs
        (operator_run: sandbox-exact and sandbox-mallory), then its house agents (house_agent), then the rest (the Nov 18
        fresh-join run, finding 6: last-seen time alone put idle test agents among them); then those whose agent was
        active in the last 24 hours (recently_active); then the most recently seen (agent_last_seen, never seen last);
        then by handle. Only the page's participants are looked up (GET /participants/{id}, for their public position)."""
        c = self.client()
        q = (a.get('query') or '').lower()
        limit = min(max(_page_arg(a, 'limit', DIRECTORY_PAGE, PAGE_WORDS['limit']), 1), DIRECTORY_PAGE_MAX)
        offset = max(_page_arg(a, 'offset', 0, PAGE_WORDS['offset']), 0)
        ranked = []
        for p in c.directory():
            if p['id'] == c.participant_id or p['status'] != 'active':
                continue
            handle, name, about, services, wants = (str(p.get(k) or '').lower() for k in ('handle', 'display_name', 'about', 'services', 'wants'))
            if not q or q in handle or q in name:
                tier = 0
            elif q in services or q in wants:
                tier = 1
            elif q in about:
                tier = 2
            elif q in ' '.join((handle, name, about, services, wants)):
                tier = 3
            else:
                continue
            active = recently_active(p.get('agent_last_seen'), joined_at=p.get('joined_at'))
            seen = seen_us(p.get('agent_last_seen'))
            kind = 0 if p.get('operator_run') is True else 1 if p.get('house_agent') is True else 2
            ranked.append(((tier, kind, not active, seen is None, -(seen or 0), str(p.get('handle') or '')), p, active))
        ranked.sort(key=lambda r: r[0])
        out = []
        for _, p, active in ranked[offset:offset + limit]:
            pos = c.participant(p['id']).get('public_position', {})
            out.append({'handle': p['handle'], 'id': p['id'], 'name': p['display_name'], 'operator': p['operator'],
                        'about': directory_text(p['about']), 'services': directory_text(p['services']),
                        'wants': directory_text(p.get('wants') or ''), 'credit_notes_they_hold_PC': pos.get('claims_held'),
                        'credit_notes_they_owe_PC': pos.get('owes'), 'deals': pos.get('deals'),
                        'agent_last_seen': p.get('agent_last_seen'), 'agent_recently_active': active})
        where = ("positions are outstanding credit notes recorded by the Valun testnet Basis tracker and anchored on Ergo testnet; a "
                 "creditor can redeem one against its issuer's reserve, if it has one; tERG have no monetary value."
                 if getattr(c, 'network', vc.NETWORK) == TESTNET else
                 'positions are outstanding credit notes recorded by the pilot Basis tracker; nothing is settled; PC have no value.')
        total, end = len(ranked), offset + len(out)
        r = {'participants': out, 'total_matching': total, 'offset': offset}
        if end < total:
            r['next_offset'] = end
        r['note'] = where + ' A participant whose agent has not been seen in the last 24 hours may never answer an offer.'
        if end < total:
            r['how_to_see_more'] = (
                f'Showing {offset + 1}-{end} of {total} matching the query (best matches first). For more, call valun_directory '
                f'again with the same query and offset {end}, or narrow the query.' if q else
                f"Showing {offset + 1}-{end} of {total} (the operator's always-on agents first, then the most recently active). "
                'For more, call valun_directory again '
                f'with offset {end}, or narrow it with query.')
        return r

    def inbox(self, a):
        """The server's inbox, with a one-line summary first in each recently closed deal whose IOU was issued
        (closed_summary; the Nov 18 fresh-join run, finding 12: recent_closed showed only status note_issued)."""
        box = self.client().inbox()
        if isinstance(box, dict) and isinstance(box.get('recent_closed'), list):
            box = dict(box, recent_closed=[{'summary': closed_summary(x), **x} if closed_summary(x) else x
                                           for x in box['recent_closed']])
        return box

    # ---------- guarantees (fix inbox #18) ----------
    @staticmethod
    def _gid(v):
        if not (isinstance(v, str) and _GUARANTEE_ID.fullmatch(v)):
            raise vc.ValunError('bad_arguments', 'guarantee_id is missing or malformed (vg_ + 16 hex; valun_guarantees lists them)')
        return v

    def guarantees(self, a):
        c = self.client()
        if a.get('guarantee_id') is not None:
            g = c.guarantee(self._gid(a.get('guarantee_id')))
            out = guarantee_brief(g)
            if isinstance(g, dict):
                out['terms'] = g.get('terms')
                out['covers'] = g.get('covers')
                out['what_this_means'] = g.get('what_this_means')
                try:
                    chk = c.verify_guarantee(g)
                    out['checked_by_your_client'] = {'terms_hash_recomputed': chk['terms_hash'], 'backer_signature_valid': True}
                except vc.ValunError as e:
                    out['checked_by_your_client'] = {'problem': e.code, 'message': str(e)}
            return out
        gs = c.guarantees()
        return {'guarantees': [guarantee_brief(g) for g in (gs if isinstance(gs, list) else [])],
                'how': ("A guarantee is a backer's signed promise to pay one creditor, up to a cap, what one issuer still owes it "
                        'after the due time, if the creditor calls before it expires. valun_guarantees with guarantee_id shows one '
                        'with its terms.')}

    def offer_guarantee(self, a):
        c = self.client()
        issuer, creditor = self._resolve(c, a.get('issuer')), self._resolve(c, a.get('creditor'))
        vals = {k: _guarantee_int(a, k, d) for k, d in (('cap', None), ('due_in_hours', None), ('callable_for_hours', 168),
                                                         ('honor_within_hours', 24), ('offer_valid_hours', 24))}
        note = a.get('note') or ''
        if not isinstance(note, str):
            raise vc.ValunError('bad_arguments', 'note must be text')
        deals = a.get('deals')
        g = c.offer_guarantee(issuer['id'], creditor['id'], vals['cap'], vals['due_in_hours'], vals['callable_for_hours'],
                              vals['honor_within_hours'], vals['offer_valid_hours'], note, deals)
        out = {'guarantee': guarantee_brief(g)}
        who, of = shown(creditor.get('handle')), shown(issuer.get('handle'))
        calls = (f'If {who} calls it, you pay each call with your own IOU to {who}, which is recorded at once and never '
                 'held for your owner, even with console approvals.')
        if isinstance(g, dict) and g.get('state') == 'awaiting_owner':
            # Held for the owner (its cap above approve_above): where, which approval, until when, and that approving it
            # is the owner's last decision on it (the approval semantics of 2026-11-17).
            offer = g.get('offer') if isinstance(g.get('offer'), dict) else {}
            aid = offer.get('approval_id')
            where, wait = owner_wait(c, {'approvals': [{'id': aid, 'state': 'pending'}]} if isinstance(aid, str) else {},
                                     g.get('guarantee_id'), self.console_command, kind='guarantee')
            cap = vc.amount_text(g['cap'], getattr(c, 'unit', vc.UNIT)) if _whole(g.get('cap')) else 'its cap'
            out['what_happens_next'] = (f'Your signed guarantee offer waits for your owner before {who} can see it. Your '
                                        f"owner approves or rejects it{where}{_until(g.get('offer_expires_at'))}. Its cap "
                                        f'of {cap} counts against your total-owed limit while it waits. Tell your owner '
                                        f'that approving is their last step: {calls}')
            out.update(wait)
        else:
            out['what_happens_next'] = (f'{who} can accept or decline it. Once it is due, it can call what {of} still owes '
                                        f'it, up to the cap. {calls}')
        return out

    def respond_guarantee(self, a):
        c = self.client()
        gid, action = self._gid(a.get('guarantee_id')), a.get('action')
        exp = a.get('expected_terms_hash')
        if action == 'accept':
            g = c.accept_guarantee(gid, exp)
        elif action == 'decline':
            reason = a.get('reason') or ''
            if not isinstance(reason, str):
                raise vc.ValunError('bad_arguments', 'reason must be text')
            g = c.decline_guarantee(gid, reason)
        elif action == 'withdraw':
            g = c.withdraw_guarantee(gid)
        elif action == 'release':
            g = c.release_guarantee(gid, exp)
        elif action == 'honor':
            cid = a.get('call_id')
            if cid is not None and not (isinstance(cid, str) and _CALL_ID.fullmatch(cid)):
                raise vc.ValunError('bad_arguments', 'call_id is malformed (vgc_ + 16 hex)')
            before = honor_marks(c, gid)
            g = c.honor_guarantee(gid, cid, exp)
            if cid is None:
                # The call the client chose (its first open or failed one): the one its own honor record now holds a
                # new note for, written ahead before the note was signed (the 0.7.2 review: the reply named the last
                # honored call, whichever it was).
                after = honor_marks(c, gid)
                cid = next((k for k in sorted(after) if after[k] != before.get(k)), None)
        else:
            raise vc.ValunError('bad_arguments', "action must be accept, decline, release, withdraw or honor")
        out = {'guarantee': guarantee_brief(g)}
        if action == 'honor' and isinstance(g, dict):
            # An honor is never held for the owner, whatever the mandate says (the approval semantics of 2026-11-17).
            # What is said is the state the server answered for the call this client honored: a note the tracker did
            # not record leaves the call failed, with nothing more owed (guarantees.mjs submitNote).
            call = next((x for x in (g.get('calls') if isinstance(g.get('calls'), list) else []) if isinstance(x, dict)
                         and cid is not None and x.get('call_id') == cid), None)
            cr = g.get('creditor') if isinstance(g.get('creditor'), dict) else {}
            who = shown(cr.get('handle') or cr.get('id') or 'the creditor')
            state = call.get('state') if call is not None else None
            if state == 'honored' and _whole(call.get('amount')):
                amount = vc.amount_text(call['amount'], getattr(c, 'unit', vc.UNIT))
                out['what_happened'] = (f'You honored call {shown(cid)}: your IOU to {who} for {amount} '
                                        f"went to {tracker_words(getattr(c, 'network', vc.NETWORK))} at once. It was not "
                                        'held for your owner: honoring a guarantee call never is, even with console '
                                        f'approvals. You owe {who} {amount} more, and nothing is settled. Tell your owner.')
            elif state == 'failed':
                out['what_happened'] = (f'The tracker did not record your IOU for call {shown(cid)}, so it adds nothing to '
                                        f'what you owe {who}. The call still waits to be honored: honor it again (your '
                                        'client signs a new IOU), and tell your owner.')
            elif call is not None:
                out['what_happened'] = (f'Your IOU for call {shown(cid)} was sent; the server shows the call as '
                                        f'{shown(state)}: valun_guarantees shows when the tracker has recorded it. It was '
                                        'not held for your owner: honoring a guarantee call never is.')
        elif action == 'release':
            out['what_happened'] = ('You released the guarantee: it ends, and its calls not yet honored are void. A release '
                                    'is never held for your owner in the owner console.')
        return out

    def call_guarantee(self, a):
        c = self.client()
        gid, amount = self._gid(a.get('guarantee_id')), a.get('amount')
        if amount is not None and not (_whole(amount) and amount > 0):
            raise vc.ValunError('bad_arguments', 'amount must be a whole number of at least 1')
        g = c.call_guarantee(gid, amount, a.get('expected_terms_hash'))
        hours = g.get('honor_within_hours') if isinstance(g, dict) else None
        return {'guarantee': guarantee_brief(g),
                'what_happens_next': f'The backer has {shown(hours)} hours to honor the call with its own credit note to you.'}

    # ---------- budget cards ----------
    def check_payer(self, a):
        """valun_check_payer (read only): may `payer` owe this agent `amount` more, by the budget card its owner published?
        The server's verdict object (Client.check_payer, with this agent's token: it shows the cover only to the payee
        itself) with `summary` first (check_summary). The amount is checked as valun_propose checks its price (_count),
        before anything is read, and so is deal_id (fix inbox #60: the offer under review, which the server then counts
        once; vd_ + 16 hex). Without deal_id the answer is for a new deal on top of what the payer committed, and the
        summary says when an offer the payer made this agent at that price is among it (check_summary). Since fix inbox
        #87 the server's verdict is the step's, from both sides (payer_side, payee_side), and a payer whose owner has not
        published a card is checked on this agent's own side only (payer_side null: verdict decline when that side
        declines, else unknown). A server from before #87 answers card_not_public for such a payer: verdict 'unknown'
        (unchecked_payer), an answer, not an error."""
        c = self.client()
        payer, = _required(a, ('payer',), signs=False)
        if not isinstance(payer, str) or not payer.strip():
            raise vc.ValunError('bad_arguments', 'payer must be the handle or participant id (text) of the agent that would owe you')
        amount = _count('amount', a.get('amount'), getattr(c, 'unit', vc.UNIT))
        deal_id = a.get('deal_id')
        if deal_id is not None and not (isinstance(deal_id, str) and _OFFER_ID.fullmatch(deal_id)):
            got = quoted(deal_id)
            raise vc.ValunError('bad_arguments', 'deal_id must be the id of the offer you are deciding on, vd_ + 16 hex as valun_inbox '
                                                 f"lists it, not {got if len(got) <= 40 else got[:37] + '...'}")
        ref = c.resolve_participant(payer)
        try:
            v = c.check_payer(ref['id'], amount, deal_id=deal_id)
        except vc.ValunError as e:
            if e.code == 'card_not_public':
                return unchecked_payer(ref, amount, deal_id)
            raise
        if not isinstance(v, dict):
            raise vc.ValunError('bad_response', 'the server answered the check with no verdict')
        return {'summary': check_summary(v), **{k: x for k, x in v.items() if k != 'summary'}}

    def deal(self, a):
        c = self.client()
        did, = _required(a, ('deal_id',), signs=False)
        d = c.deal(did)
        # A payment of this deal that the server held for the owner and that ended unreleased (rejected in the owner
        # console, or void) is recorded as not applied, so that paying the deal again is not blocked by it (fix: the
        # approval probe's D2).
        if isinstance(d, dict) and d.get('your_role') == 'payer':
            c.learn_owner_decisions(did, d)
        out = {k: d.get(k) for k in ('id', 'status', 'your_role', 'counterparty', 'next_actions', 'versions', 'acceptance', 'agreement',
                                     'decline', 'completion', 'dispute', 'cancellation', 'approvals', 'labels')}
        att = c.state.get('transfer_attempts') if isinstance(getattr(c, 'state', None), dict) else None
        decided = owner_decisions(d, att.get(did) if isinstance(att, dict) else None)
        if decided:
            out['owner_decisions'] = decided
        theirs = counterparty_owner_decisions(d, c.participant_id)
        if theirs:                                  # the other side's owner's decisions (the 0.7.2 review)
            out['counterparty_owner_decisions'] = theirs
        now = int(vc.time.time() * 1000)
        if isinstance(d.get('retry_after_seconds'), int) and not isinstance(d['retry_after_seconds'], bool):
            out['retry_after_seconds'] = d['retry_after_seconds']   # the server's hint while it waits on the other side (#8)
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
        elif st == 'delivered':
            out['whose_turn'] = 'yours: accept the delivery or dispute it' if d.get('your_role') == 'payer' else 'theirs: they review your delivery'
        elif st == 'note_failed':
            # The IOU failed at the tracker after the delivery was accepted: the acceptance stands, so a dispute is refused
            # (the server's next_actions: complete, wait_for_transfer_window; approval probe D3).
            out['whose_turn'] = ('yours: the delivery stays accepted and is unpaid; pay it again (a new IOU, or by transfer '
                                 'when the window allows)' if d.get('your_role') == 'payer' else
                                 'theirs: the payer accepted your delivery and must pay it again (its IOU failed at the tracker)')
        elif st in OWNER_WAITS:
            out['whose_turn'] = owner_turn(d, c.participant_id, now)
            by, exp, _passed = held_note_hour(d, now)
            if exp:                                 # the held IOU's deadlines, which whose_turn names (the 0.7.2 review)
                out['decide_by'], out['note_expires_at'] = by, exp
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
            out['delivery'] = {'title': dl.get('title'), 'sha256': dl['sha256'], 'bytes': dl['bytes'], 'late': dl.get('late'), 'content': body,
                               # the payee's public signature over (deliver, terms_hash, content sha256): a receipt can be verified (#3)
                               'signature': dl.get('signature')}
            reviewing = d.get('your_role') == 'payer' and d.get('status') in ('delivered', 'note_failed')
            out['delivery']['measured_by_your_client'] = measure.measure(dl['content'], terms_text(d),
                                                                         check_hosts=reviewing and self.check_link_hosts)
            # A built-in job only (the Nov 18 fresh-join run, finding 10: "word count" in a free-form job's terms made a
            # correct plain-text answer "not match" text-stats, with the advice to dispute it).
            cp = d.get('counterparty') if isinstance(d.get('counterparty'), dict) else {}
            exact = sandbox.check_built_in((d.get('current') or {}).get('terms') or {}, dl['content'], cp.get('handle'))
            if exact is not None:
                out['delivery']['checked_exactly_by_your_client'] = exact
                if reviewing and exact.get('checked') and not exact.get('exact_result_matches'):
                    out['delivery']['advice'] = exact_advice(exact)
        if d.get('credit_note'):
            n = d['credit_note']
            out['credit_note'] = {'state': n.get('state'), 'amount_PC': n.get('amount'), 'tracker_status': n.get('tracker_status'),
                                  'tracker_cumulative_total_PC': (n.get('tracker_note') or {}).get('amount_collected'),
                                  # the server's live reading of the tracker when it sends one (#13), else the recorded one
                                  'confirmation': n.get('confirmation') or (n.get('tracker_note') or {}).get('confirmation'),
                                  'verified_by_valun': n.get('verified_by_valun'),
                                  'outstanding': n.get('outstanding'), 'settled': n.get('settled', False),
                                  'issuer_pubkey': n.get('issuer_pubkey'), 'recipient_pubkey': n.get('recipient_pubkey')}
            means = confirmation_means(out['credit_note']['confirmation'], getattr(c, 'network', vc.NETWORK))
            if means:                               # what local_only, pending or confirmed means (the Nov 18 run, #12)
                out['credit_note']['confirmation_means'] = means
            for k in ('redeemed', 'settled_how', 'pair_now'):         # on chain: what redemption did to this note (#13)
                if n.get(k) is not None:
                    out['credit_note'][k] = n[k]
            if n.get('signature_withheld'):
                out['credit_note']['signature'] = 'withheld until the Basis tracker records the note'
        if d.get('payment') is not None:           # circulating credit: the payment by transfer, as the server shows it
            out['payment'] = d['payment']
        if d.get('your_role') == 'payer' and st in PAYABLE and self._offers_circulation(c, d):
            try:
                out['how_you_can_pay'] = self._how_you_can_pay(c, did)
            except vc.ValunError as e:
                out['how_you_can_pay'] = {'problem': e.code, 'message': str(e)}
        out['history'] = d.get('history', [])[-12:]
        prices = [(v['version'], 'you' if v['by'] == c.participant_id else (d.get('counterparty') or {}).get('handle'), v['price']['amount'])
                  for v in d.get('versions') or []]
        if prices:
            u = getattr(c, 'unit', vc.UNIT)
            out['negotiation'] = {'prices_by_version': [f'v{n} {who}: {p} {u}' for n, who, p in prices]}
            mine = [p for _, who, p in prices if who == 'you'][-2:]
            theirs = [p for _, who, p in prices if who != 'you'][-2:]
            if len(mine) == 2 and len(theirs) == 2 and mine[0] == mine[1] and theirs[0] == theirs[1] and mine[0] != theirs[0]:
                out['negotiation']['stalemate'] = (f'Both sides have repeated the same price ({mine[0]} vs {theirs[0]} {u}). If no price '
                                                   'within your limits works for the other side, decline with a reason instead of countering again.')
        if st == 'note_issued':                     # the plain ending first, for either side (the Nov 18 run, #12)
            out = {'summary': note_summary(d, getattr(c, 'network', vc.NETWORK), getattr(c, 'unit', vc.UNIT),
                                           self._offers_circulation(c, d), _server_of(c)), **out}
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
        unit = getattr(c, 'unit', vc.UNIT)
        counterparty, role, title, description, deliverable = _required(a, PROPOSE_TEXTS)   # fix inbox #58
        price, due, ttl = self._offer_numbers(a, unit)      # whole numbers, refused before any read (fix inbox #22)
        other = self._resolve(c, counterparty)
        # A seller of exactly checkable work publishes that it needs the text in the description; check before signing.
        if role == 'payer' and '``` block' in str(other.get('services') or '') \
                and sandbox.extract_text(description or '') is None:
            raise vc.ValunError('missing_text', (
                f"Not signed. {other['handle']} needs the text to process inside the description, and yours has none. Put the "
                'exact text in a ``` fenced block in the description (or as the only "quoted" string, or after TEXT: at the '
                'end), then make the offer again.'))
        r = c.propose(other['id'], role, title, description, deliverable, price, due, ttl)
        waiting = r['status'] == 'proposed_awaiting_owner'
        idle = None if recently_active(other.get('agent_last_seen'), joined_at=other.get('joined_at')) else (
            f"{other['handle']}'s agent has not been seen in the last 24 hours; it may never answer. Consider an active seller too.")
        signed = vc.amount_text(price, unit)                # the amount signed, never the argument as given
        where, wait = owner_wait(c, r, r['id'], self.console_command) if waiting else ('', {})
        # Held for the owner (approve_above): the signed offer stays on the server and binds nobody until it is approved;
        # it already counts against the limits, and the agent may still withdraw it (the approval semantics of 2026-11-17).
        held = (f"Your signed offer waits for your owner before {other['handle']} can see it. Your owner approves or rejects "
                f"it{where}{_until(_terms_of(r).get('offer_expires_at'))}. Tell your owner now: nothing else tells them. "
                'While it waits it counts against your limits, and you can still withdraw it; if your owner rejects it, '
                'it binds nobody and the deal ends. valun_deal shows when it is decided.')
        return {'deal_id': r['id'], 'status': r['status'], 'terms_hash': r['current']['terms_hash'] if r.get('current') else None,
                'what_happened': (held if waiting
                                  else f"{other['handle']} can now accept, decline or counter your signed offer."),
                'if_agreed': (f"After you accept their delivery you issue them a credit note of {signed} (you will owe them; not settled)."
                              if role == 'payer' else f"After they accept your delivery they issue you a credit note of {signed} (they will owe you; not settled)."),
                **({'warning': idle} if idle else {}), **wait}

    def respond(self, a):
        c = self.client()
        did, act = _required(a, ('deal_id', 'action'))     # fix inbox #58: a missing one was a KeyError (internal_error)
        at = ''                                             # a counter-offer's price, as signed
        if act == 'accept':
            r = c.accept(did, a.get('expected_terms_hash'))
        elif act == 'decline':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a decline needs a short reason: the other side reads it and may make a better offer')
            r = c.decline(did, a['reason'].strip())
        elif act == 'withdraw':
            r = c.withdraw(did)
        elif act == 'counter':
            unit = getattr(c, 'unit', vc.UNIT)
            price, hours, ttl = self._counter_numbers(a, unit)    # whole numbers, refused before any read (fix inbox #22)
            r = c.counter(did, price=price, title=a.get('title'), description=a.get('description'), deliverable=a.get('deliverable'),
                          deliver_by_hours=hours, offer_ttl_hours=ttl, expected_terms_hash=a.get('expected_terms_hash'))
            at = f' at {vc.amount_text(price, unit)}' if price is not None else ' at the price of their offer'
        else:
            raise vc.ValunError('bad_action', 'action must be accept, decline, counter or withdraw')
        held = act == 'counter' and r.get('pending_counter')
        accepted, wait = ('', {})
        if r['status'] == 'accepted_awaiting_owner':        # whose owner holds it: acceptance_wait (the 0.7.2 review)
            accepted, wait = acceptance_wait(c, r, did, self.console_command)
        where = ''
        if held and r['status'] == 'open':
            where, wait = owner_wait(c, r, did, self.console_command)
        # A counter-offer held for the owner: the other side's offer stays open meanwhile, and this agent can neither
        # accept it nor counter again until the owner decides (the approval semantics of 2026-11-17).
        cp, until = _handle_of(r), _until(_terms_of(r).get('offer_expires_at'), 'until')
        explain = {'agreed': 'Agreement formed: both sides have signed the same terms.',
                   'accepted_awaiting_owner': accepted,
                   'open': (f'Your signed counter-offer{at} waits for your owner. {cp} cannot see it yet, and its own offer '
                            f'stays open{until}. While it waits, you can neither accept that '
                            f'offer nor counter again. Your owner approves or rejects it{where}. Tell your owner.' if held
                            else f'Your counter-offer{at} is open for the other side.' if act == 'counter' else 'The offer is open.'),
                   'declined': 'You declined; nothing is owed.', 'withdrawn': 'Your offer is withdrawn.'}
        return {'deal_id': did, 'status': r['status'], 'what_happened': explain.get(r['status'], r['status']), 'next_actions': r.get('next_actions'),
                **wait}

    def deliver(self, a):
        c = self.client()
        did, = _required(a, ('deal_id',))                  # fix inbox #58
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
        d = c.deal(did)
        m = measure.measure(a['content'], terms_text(d), check_hosts=self.check_link_hosts)
        problems = [f"{x['requirement']}: measured {x['measured']}" for x in m['checks_against_agreed_terms'] if not x['met']]
        if m.get('warning'):
            problems.append(m['warning'])
        if problems and not a.get('send_anyway'):
            raise vc.ValunError('draft_does_not_meet_terms', 'Not sent. Your draft does not meet the agreed terms as measured: '
                                + ' | '.join(problems) + ' Fix it and deliver again (send_anyway=true only if you are sure; '
                                'the payer sees the same measurements).', extra={'measured': m})
        r = c.deliver(did, a['content'], a.get('title') or '')
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
        did, = _required(a, ('deal_id',))                  # fix inbox #58
        if a['decision'] == 'dispute':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a dispute needs a reason')
            r = c.dispute(did, a['reason'])
            return {'deal_id': r['id'], 'status': r['status'], 'what_happened': 'Disputed. No credit note was issued; the dispute is recorded.'}
        issuer = self._pay_with(a)
        if issuer is not None:
            return self._review_pay_with(c, a, issuer)
        r = c.complete(did, a.get('expected_deliverable_sha256'), a.get('expected_terms_hash'))
        n = r.get('credit_note') or {}
        wait = {}
        if r['status'] == 'completion_awaiting_owner':
            # The IOU is held for the owner (review_deliveries): until when the owner can decide (the owner console's
            # deadline, a minute before the tracker's for a bound note: its timestamp + 1 h), what the payee already
            # sees, and what approving or rejecting it leaves (the approval semantics of 2026-11-17; approval probe D3:
            # an approval after that hour leaves the delivery accepted, unpaid, and no longer disputable).
            where, wait = owner_wait(c, r, r['id'], self.console_command)
            payee, unit = _handle_of(r, 'the payee'), getattr(c, 'unit', vc.UNIT)
            price = vc.amount_text(n['amount'], unit) if _whole(n.get('amount')) else 'the price'
            exp, by = note_expires_at(n.get('note')), note_decide_by(n.get('note'))
            if exp:
                wait['decide_by'], wait['note_expires_at'] = by, exp
            msg = (f'You accepted the delivery and signed your IOU to {payee} for {price}. The Valun server holds it for '
                   f"your owner: it is not on the tracker yet, and {payee} sees that you accepted the delivery but not the "
                   f"IOU's signature. Tell your owner to approve or reject it{where}"
                   + (f' by {_deadline_words(by, exp)}: an IOU still held at {exp} is never recorded and pays nothing, and '
                      'valun_deal then says what to do' if exp else '')
                   + f". If approved, you owe {payee} {price} more: a promise to pay that "
                   f"{tracker_words(getattr(c, 'network', vc.NETWORK))} records, not a settlement. If rejected, it is never "
                   'sent (the server keeps it, still signed) and the deal comes back to you: valun_deal says what you may '
                   'do (accept the delivery again with a new IOU, which waits for your owner again, or dispute it).')
        elif r['status'] == 'note_issued':
            msg = (f"Credit note issued: the Basis tracker now records that you owe {r['counterparty']['handle']} "
                   f"{(n.get('tracker_note') or {}).get('amount_collected')} {getattr(c, 'unit', vc.UNIT)} in total (this deal added {n.get('amount')}). "
                   + labels(self._circulating(c), getattr(c, 'network', vc.NETWORK))['settlement'])
        else:
            msg = r['status']
        conf = (n.get('tracker_note') or {}).get('confirmation')
        out = {'deal_id': r['id'], 'status': r['status'], 'what_happened': msg,
               'credit_note': {'state': n.get('state'), 'amount_PC': n.get('amount'), 'tracker_status': n.get('tracker_status'),
                               'confirmation': conf, 'settled': False}, **wait}
        if r['status'] == 'note_issued':
            # The plain ending first, then the long fields (the Nov 18 fresh-join run, finding 12).
            means = confirmation_means(conf, getattr(c, 'network', vc.NETWORK))
            if means:
                out['credit_note']['confirmation_means'] = means
            out = {'summary': note_summary(r, getattr(c, 'network', vc.NETWORK), getattr(c, 'unit', vc.UNIT),
                                           self._circulating(c), _server_of(c), role='payer'), **out}
        return out

    def _review_pay_with(self, c, a, issuer):
        """valun_review_delivery accept with pay_with: Client.pay_by_transfer under the pins prepare() took (the delivery,
        the quote and my claim on the issuer)."""
        claim = a.get('expected_claim_total')
        if claim is not None and not (_whole(claim) and claim >= 0):
            raise vc.ValunError('bad_arguments', f"expected_claim_total is the whole number of {getattr(c, 'unit', vc.UNIT)} of your claim that your "
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
        u = getattr(c, 'unit', vc.UNIT)
        did = r.get('id') if isinstance(r, dict) else a['deal_id']
        where, wait = owner_wait(c, r, did, self.console_command) if st == 'completion_awaiting_owner' else ('', {})
        # A payment by transfer held for the owner (review_deliveries): nobody else signs it until the owner approves, and
        # the hold ends 20 minutes after it was posted (payment.expires_at; the approval semantics of 2026-11-17).
        hold = pay.get('expires_at') if isinstance(pay.get('expires_at'), str) and pay.get('expires_at') else None
        if hold and st == 'completion_awaiting_owner':
            wait['hold_expires_at'] = hold
        priced = vc.amount_text(price, u) if _whole(price) else 'the price'
        held = (f"You accepted the delivery and signed a payment by transfer: {priced} of {shown(by)}'s IOU to you moves "
                f'to {who}. Nobody else has signed it. It waits for your owner{where}'
                + (f' until {shown(hold)}, 20 minutes after you signed it' if hold else '')
                + f': tell your owner now. Once approved, {shown(by)} and {who} sign it (their Valun clients do so by '
                'themselves where their owners allow it), and the delivery stays accepted even if the transfer then '
                'fails. If your owner rejects it, or that time passes, nothing moves and the deal comes back to you: you '
                f"may pay again through {shown(by)}'s IOU at once while it is unchanged, or any other way about an hour "
                'after you signed.')
        msgs = {'paid_by_transfer': (f'Paid by debt transfer: {by} now owes {who} {amount} {u} more and you {amount} {u} '
                                     'less; you issued no credit note for this deal. '
                                     + labels(True, getattr(c, 'network', vc.NETWORK))['settlement']),
                'paying_by_transfer': ('You accepted the delivery and signed the debt transfer; it applies once the issuer and '
                                       'the payee sign. Accepting is final: if it does not complete, the deal stays accepted and '
                                       'you pay later.'),
                'completion_awaiting_owner': held,
                'payment_due': ('The transfer did not apply: the delivery stays accepted and the deal is payment_due. Pay it '
                                'again (valun_deal how_you_can_pay).')}
        return {'deal_id': did, 'status': st, 'what_happened': msgs.get(st, st), 'payment': pay or None, **wait}
