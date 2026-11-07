"""The Valun agent tools, independent of any agent framework.

Every adapter (the MCP server, the `valun call` CLI, the Hermes plugin) exposes the same nine tools through this
module. An adapter supplies a store (where the participant's key, token and non-secret state live), a few settings,
and a sentence saying where approvals happen; this module does the protocol work: it builds and verifies what is
signed, measures deliveries against the agreed terms, and explains results in plain words.

Secrets never leave the store: no tool returns, logs or echoes the signing key or the agent token.
Ported from the Hermes plugin's tools.py (hermes-plugin-valun 0.2.0) with the Hermes-specific parts removed.
"""
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
    removing one). Setting a limit for the first time is never looser than the owner's mandate (the server refuses that)."""
    kinds = dict(LIMIT_FIELDS.values())
    for field, new in body.items():
        if field not in kinds or current.get(field) is None:
            continue
        old = current[field]
        if new is None or (kinds[field] == 'cap' and new > old) or (kinds[field] == 'floor' and new < old):
            return True
    return False


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
        for k in ('rule', 'mandate_version', 'measured'):
            if k in e.extra:
                out[k] = e.extra[k]
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
        """Does this call sign something that commits the owner (or loosen a limit)? Adapters ask the owner first."""
        args = args or {}
        if name == 'valun_propose':
            return True
        if name == 'valun_respond':
            return args.get('action') in ('accept', 'counter')
        if name == 'valun_review_delivery':
            return args.get('decision') == 'accept'
        if name == 'valun_set_limits':
            try:
                me = self.client().me()
                return loosens(me.get('agent_limits') or {}, limits_body(args))
            except Exception:  # noqa: BLE001 - when in doubt, ask the owner
                return True
        return False

    def describe_commitment(self, name, args):
        """Text for an approval prompt: exactly what the agent is about to sign, and what it means."""
        args = args or {}
        try:
            c = self.client()
            if name == 'valun_set_limits':
                me = c.me()
                cur, mandate, body = me.get('agent_limits') or {}, me['mandate'], limits_body(args)
                names = {field: arg for arg, (field, _k) in LIMIT_FIELDS.items()}
                lines = ['Valun - LOOSEN limits recorded from your instructions (the Valun server enforces them):']
                for field, new in body.items():
                    if field in names:
                        lines.append(f"  {names[field]}: {cur.get(field, mandate.get(field))} -> "
                                     f"{new if new is not None else 'removed'} (your owner mandate: {mandate.get(field)})")
                lines.append('Approve only if you asked your agent for this.')
                return '\n'.join(lines)
            if name == 'valun_propose':
                role, price, who = args.get('role'), args.get('price'), args.get('counterparty')
                return '\n'.join([
                    f'Valun - sign a NEW OFFER to {who}:',
                    f"  service: {args.get('title')}",
                    f"  deliverable: {args.get('deliverable')}",
                    f'  price: {price} PC; you are the ' + ('payer' if role == 'payer' else 'payee (you do the work)'),
                    f"  deliver within {args.get('deliver_within_hours') or 48} h; the offer stays open {args.get('offer_valid_hours') or 24} h",
                    f'If {who} accepts, the deal is binding without asking you again: '
                    + (f'after you accept their delivery you will owe them {price} PC (your credit note).' if role == 'payer'
                       else f'you must deliver; they would then owe you {price} PC (their credit note).'),
                    NOT_SETTLED])
            d = c.deal(args.get('deal_id'))
            cur = d.get('current') or {}
            t, who, role = cur.get('terms') or {}, (d.get('counterparty') or {}).get('handle'), d.get('your_role')
            price, svc = (t.get('price') or {}).get('amount'), t.get('service') or {}
            if name == 'valun_respond' and args.get('action') == 'accept':
                return '\n'.join([
                    f"Valun - ACCEPT {who}'s offer (deal {d['id']}, version {cur.get('version')}):",
                    f"  service: {svc.get('title')}",
                    f"  deliverable: {svc.get('deliverable')}",
                    f"  price: {price} PC; you are the {role}; deliver by {t.get('deliver_by')}",
                    f"  terms hash {(cur.get('terms_hash') or '')[:16]}... (rechecked by your Valun client before signing)",
                    'This makes the deal binding on both sides: '
                    + (f'after you accept the delivery you will owe {who} {price} PC.' if role == 'payer'
                       else f'you must deliver; {who} would then owe you {price} PC.'),
                    NOT_SETTLED])
            if name == 'valun_respond' and args.get('action') == 'counter':
                changes = [f'{k} {args[k]}' for k in ('price', 'title', 'description', 'deliverable', 'deliver_within_hours')
                           if args.get(k) not in (None, '')]
                return '\n'.join([
                    f"Valun - sign a COUNTER-OFFER to {who} (deal {d['id']}), replacing their version {cur.get('version')} at {price} PC:",
                    '  changes: ' + (', '.join(changes) or 'none'),
                    f'If {who} accepts it, the deal is binding without asking you again. You are the {role}.',
                    NOT_SETTLED])
            if name == 'valun_review_delivery':
                dl = d.get('delivery') or {}
                m = measure.measure(dl.get('content') or '', terms_text(d), check_hosts=False)
                facts = [f"{x['requirement']}: {x['measured']} ({'met' if x['met'] else 'NOT met'})" for x in m['checks_against_agreed_terms']]
                exact = sandbox.check_delivery(t, dl.get('content') or '')
                if exact and exact.get('checked'):
                    facts.append('exact result: ' + ('matches the agreed text' if exact.get('exact_result_matches')
                                                     else f"DOES NOT MATCH (differs in {', '.join(exact.get('differs_in') or [])})"))
                return '\n'.join([
                    f"Valun - ACCEPT {who}'s delivery (deal {d['id']}) and ISSUE A CREDIT NOTE of {price} PC to {who}:",
                    f"  delivered: {dl.get('title') or '(untitled)'}, {dl.get('bytes')} bytes, sha256 {(dl.get('sha256') or '')[:16]}...",
                    '  measured: ' + ('; '.join(facts) or f"{m['word_count']} words, {len(m['links'])} links"),
                    f'Your agent signs a Basis note; the pilot tracker then records that you owe {who} {price} PC more.',
                    NOT_SETTLED])
        except Exception:  # noqa: BLE001 - the prompt must still appear
            pass
        return f'Valun: sign a commitment ({name}).'

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
                          deliver_by_hours=a.get('deliver_within_hours'))
        else:
            raise vc.ValunError('bad_action', 'action must be accept, decline, counter or withdraw')
        held = act == 'counter' and r.get('pending_counter')
        explain = {'agreed': 'Agreement formed: both sides have signed the same terms.',
                   'accepted_awaiting_owner': 'You signed the acceptance; it becomes binding when your owner approves it.',
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
        c = self.client()
        if a['decision'] == 'dispute':
            if not (a.get('reason') or '').strip():
                raise vc.ValunError('reason_required', 'a dispute needs a reason')
            r = c.dispute(a['deal_id'], a['reason'])
            return {'deal_id': r['id'], 'status': r['status'], 'what_happened': 'Disputed. No credit note was issued; the dispute is recorded.'}
        r = c.complete(a['deal_id'], a.get('expected_deliverable_sha256'))
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
