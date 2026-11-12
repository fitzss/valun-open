"""Deterministic sandbox agents: always-on Valun counterparties that need no AI model.

Their work is exactly checkable, so anyone can test the protocol, their own agent or their own client against them at
any time, and a buyer can verify a delivery byte for byte instead of judging it.

Services (the text to process goes in a ``` fenced block in the offer's description):
  text-stats  exact statistics of the text: words (runs of non-whitespace, str.split()), characters (Unicode code
              points), lines, unique words (lower-cased), SHA-256 of the UTF-8 bytes, the 10 most frequent words.
  notary      the SHA-256 and byte length of the UTF-8 text, as a signed delivery (a timestamped hash record).
The text is the first ``` fenced block (without the fence lines), else everything after a final TEXT: label, else the
only quoted string in the description. The delivery echoes the exact text processed.

  valun --profile sandbox-stats sandbox seller [--interval 20]     run a seller (polls its inbox; Ctrl+C to stop)
  valun --profile someone sandbox buy SELLER text-stats [--price 3] order a job and verify the result exactly
                                  [--pay-with ISSUER]               pay with a note you hold (circulating credit)
  valun --profile someone sandbox earn                             do a job for a sandbox agent and get paid
  valun --profile someone sandbox tour [--yes]                     the five-step circulating-credit tour

With circulating credit (where the server's GET /info lists circulation/1) the server's sandbox agents also buy, pay
with notes they hold and clear cycles of debts. sell() offers them a job, earn() does the job one of them asked for
(the welcome job), and tour() takes a sandbox_only participant through the five steps of design 9.2, driven by
valun_status sandbox_next_steps so that the CLI and any agent take exactly the same path.
"""
import hashlib
import json
import re
import sys
import time
from collections import Counter
from datetime import datetime, timezone

from . import client as vc

SERVICES = {
    'text-stats': {'price': 3, 'keywords': ('text-stats', 'text stats', 'text statistics', 'word count')},
    'notary': {'price': 2, 'keywords': ('notary', 'notar', 'sha-256', 'sha256')},
}
MIN_PRICE_FRACTION = 1.0     # accept only at or above the asking price; counter once below it


def price_of(service, network=None):
    """The published price of a sandbox service in a network's unit: the PC-sized price times the network's scale (PC
    on the pilot; nanoERG on the testnet, x1e6), what the server's sandbox agents ask (lib/pilot/sandbox.mjs SERVICES)."""
    return SERVICES[service]['price'] * vc.network_of(network or vc.NETWORK)['scale']


def unit_of(network=None):
    return vc.network_of(network or vc.NETWORK)['unit']


def services_text(network=None):
    """What the services cost and how to send the text, in the network's unit."""
    u = unit_of(network)
    return (f'text-stats ({price_of("text-stats", network)} {u}): exact word/character/line counts, unique words, SHA-256 and '
            f'the 10 most frequent words of your text. notary ({price_of("notary", network)} {u}): SHA-256 and byte length of '
            'your text. Put the text in a ``` block, after TEXT: at the end, or as the only quoted string in the description. '
            'Deterministic: you can check every number yourself; the delivery echoes the exact text processed. I only do '
            'the work (payee).')


SERVICES_TEXT = services_text()      # the pilot's (kept for callers that read it)
_FENCE = re.compile(r'^```[^\n]*\n(.*?)\n```', re.S | re.M)
_LABEL = re.compile(r'(?:^|\n)\s*TEXT\s*:\s*(.+)\Z', re.S | re.I)
_QUOTED = re.compile(r'"([^"\n]{1,16000})"|“([^”\n]{1,16000})”')
HOW_TO_SEND = ('Put the text in a ``` fenced block, after a "TEXT:" label at the end of the description, or as the only '
               'quoted string in the description. Example description: text-stats of "The quick brown fox."')


def extract_text(description):
    """The text to process: a ``` fenced block; else everything after a final TEXT: label; else the only quoted
    string ("..." or curly quotes). None if absent or ambiguous. The delivery echoes exactly what was used."""
    d = description or ''
    m = _FENCE.search(d)
    if m:
        return m.group(1)
    m = _LABEL.search(d)
    if m:
        return m.group(1).strip()
    quoted = [a or b for a, b in _QUOTED.findall(d)]
    return quoted[0] if len(quoted) == 1 else None


def text_stats(text):
    words = text.split()
    freq = Counter(w.lower() for w in words)   # lower(), not casefold(): identical to JavaScript toLowerCase()
    return {'words': len(words), 'characters': len(text), 'lines': len(text.splitlines()) if text else 0,
            'unique_words': len(freq), 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
            'top_words': [[w, n] for w, n in sorted(freq.items(), key=lambda x: (-x[1], x[0]))[:10]]}


def notary(text):
    b = text.encode('utf-8')
    return {'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)}


COMPUTE = {'text-stats': text_stats, 'notary': notary}


def render(service, result, text=None):
    """The deliverable: a short explanation, the exact text processed, and the exact result as JSON (machine-readable)."""
    how = {'text-stats': ('Words are runs of non-whitespace characters (Python str.split()); characters are Unicode code '
                          'points; unique words and top words are lower-cased; SHA-256 is over the UTF-8 bytes of the text.'),
           'notary': 'SHA-256 and length are over the UTF-8 bytes of the text exactly as processed.'}[service]
    shown = '' if text is None else f'Text processed (exactly, as a JSON string): {json.dumps(text, ensure_ascii=False)}\n\n'
    return (f'# {service} result\n\n{how}\n\n{shown}The result below is deterministic: anyone can recompute it from that '
            f'text.\n\n```json\n{json.dumps(result, ensure_ascii=False, indent=1)}\n```\n')


def parse_result(content):
    m = re.search(r'```json\n(.*?)\n```', content or '', re.S)
    return json.loads(m.group(1)) if m else None


def check_delivery(terms, content):
    """For an exactly checkable service (text-stats, notary): recompute the result from the agreed text and compare it
    with the delivered JSON. None when the deal is not such a service. Used by the agent tools so that an AI model is
    told the fact (match or not) instead of having to compute a SHA-256 or count words itself."""
    service = which_service(terms)
    if not service:
        return None
    text = extract_text((terms.get('service') or {}).get('description'))
    if text is None:
        return {'service': service, 'checked': False, 'why': 'the agreed terms contain no text to recompute from'}
    expected, got = COMPUTE[service](text), parse_result(content)
    if got is None:
        return {'service': service, 'checked': True, 'exact_result_matches': False,
                'why': 'the delivery has no ```json result block to compare', 'expected': expected}
    diff = sorted(k for k in set(expected) | set(got) if got.get(k) != expected.get(k))
    return {'service': service, 'checked': True, 'exact_result_matches': not diff, 'differs_in': diff,
            **({'expected': {k: expected.get(k) for k in diff}, 'delivered': {k: got.get(k) for k in diff}} if diff else {}),
            'how': 'recomputed by your Valun client from the agreed text; a mismatch means the delivered result is wrong'}


_ANY_FENCE = re.compile(r'```.*?```', re.S)


def request_words(description):
    """The buyer's own words in a description: without the text to work on (its ``` blocks; else what follows a final
    TEXT: label; else its only quoted string), since that text can hold anything, a service's name or "sha256" included."""
    d = description or ''
    stripped = _ANY_FENCE.sub(' ', d)
    if stripped != d:
        return stripped
    m = _LABEL.search(d)
    if m:
        return d[:m.start()]
    return _QUOTED.sub(' ', d) if len(_QUOTED.findall(d)) == 1 else d


def which_service(terms):
    """The exactly checkable service a deal asks for, named in its title, deliverable or the buyer's own words (never in
    the text to work on: a code review of a hash function is not a notary job), or None."""
    svc = terms.get('service') or {}
    hay = ' '.join((str(svc.get('title') or ''), request_words(str(svc.get('description') or '')),
                    str(svc.get('deliverable') or ''))).lower()
    for name, s in SERVICES.items():
        if any(k in hay for k in s['keywords']):
            return name
    return None


class Seller:
    def __init__(self, store, server=None, log=None):
        self.c = vc.Client(store, server=server)
        self.log = log or sys.stdout
        self.countered = {}
        self.features = None        # the features of the last GET /info a consent run read (None: none yet)

    def note(self, **kw):
        kw['t'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        self.log.write(json.dumps(kw, ensure_ascii=False) + '\n')
        self.log.flush()

    def answer(self, item):
        did = item['deal_id']
        d = self.c.deal(did)
        try:
            chk = self.c.verify_offer(d)
        except vc.ValunError as e:
            self.c.decline(did, f'your offer failed my checks ({e.code}); please send a fresh one')
            return self.note(deal=did, action='decline', why=e.code)
        terms = d['current']['terms']
        if d.get('your_role') != 'payee':
            self.c.decline(did, 'I only sell (I do the work); I do not buy. ' + services_text(self.c.network))
            return self.note(deal=did, action='decline', why='not_payee')
        service = which_service(terms)
        if not service:
            self.c.decline(did, 'I do not offer that service. ' + services_text(self.c.network))
            return self.note(deal=did, action='decline', why='unknown_service')
        text = extract_text((terms.get('service') or {}).get('description'))
        if text is None:
            self.c.decline(did, 'I could not find the text to process. ' + HOW_TO_SEND)
            return self.note(deal=did, action='decline', why='no_text')
        if len(text.encode('utf-8')) > 16000:
            self.c.decline(did, 'The text is longer than 16,000 bytes; send a shorter one.')
            return self.note(deal=did, action='decline', why='too_long')
        price, ask = terms['price']['amount'], price_of(service, self.c.network)
        if price < ask * MIN_PRICE_FRACTION:
            if self.countered.get(did):
                self.c.decline(did, f'My price for {service} is {ask} {self.c.unit}.')
                return self.note(deal=did, action='decline', why='price', price=price)
            self.countered[did] = True
            self.c.counter(did, price=ask)
            return self.note(deal=did, action='counter', service=service, price=ask)
        self.c.accept(did, chk['terms_hash'])
        self.note(deal=did, action='accept', service=service, price=price)

    def deliver(self, item):
        did = item['deal_id']
        d = self.c.deal(did)
        terms = d['current']['terms']
        service = which_service(terms)
        text = extract_text((terms.get('service') or {}).get('description')) or ''
        result = COMPUTE[service](text)
        r = self.c.deliver(did, render(service, result, text), f'{service} result')
        self.note(deal=did, action='deliver', service=service, sha256=r['delivery']['sha256'])

    def consents(self):
        """Sign the consents this profile's policy allows (set-offs, transfers of its own debt, payments to it by
        transfer), at most once a minute, as the agent tools do before every action (agent.consents_due). Once a run has
        read a GET /info without circulation/1, no more requests are made for consents (decision D-2 h): GET /info is
        not read again, so a seller started before its server offered circulating credit signs no consents until it is
        restarted (`valun sandbox seller` again)."""
        from . import agent as va           # here: agent.py imports this module
        if self.features is not None and va.CIRCULATION not in self.features:
            return None
        try:
            r = va.consents_due(self.c)
        except vc.ValunError as e:
            return self.note(action='error', error=e.code, message=str(e))
        if r is not None:
            self.features = list(getattr(self.c, '_advertised', None) or [])
        for bucket in ('signed', 'refused'):
            for e in (r or {}).get(bucket, []):
                self.note(action=f'consent_{bucket}', id=e.get('id'), kind=e.get('kind'), role=e.get('role'),
                          amount=e.get('amount'), code=e.get('code'))
        return None

    def step(self):
        self.consents()
        box = self.c.inbox()
        for item in box.get('respond', []):
            try:
                self.answer(item)
            except vc.ValunError as e:
                self.note(deal=item['deal_id'], action='error', error=e.code, message=str(e))
        for item in box.get('deliver', []):
            try:
                self.deliver(item)
            except vc.ValunError as e:
                self.note(deal=item['deal_id'], action='error', error=e.code, message=str(e))

    def run(self, interval=20, max_hours=None):
        end = time.time() + max_hours * 3600 if max_hours else None
        self.note(action='start', participant=self.c.participant_id, interval=interval)
        while end is None or time.time() < end:
            try:
                self.step()
            except vc.ValunError as e:
                self.note(action='error', error=e.code, message=str(e))
            time.sleep(interval)
        self.note(action='stop')


def participant(c, who):
    """The directory entry `who` names: exactly that participant id, else (only when no id matches) that handle."""
    people = [p for p in c.directory() if isinstance(p, dict)]
    found = next((p for p in people if p.get('id') == who), None) or next((p for p in people if p.get('handle') == who), None)
    if not found:
        raise vc.ValunError('unknown_participant', f'no participant called {who!r}')
    return found


def buy(store, seller, service, text, price=None, server=None, wait_s=600, log=print, pay_with=None, poll_s=5):
    """Order one job from `seller` and verify the delivery exactly. Returns a summary dict. A delivery that is exactly
    right is paid with this agent's own credit note, or, with pay_with (the handle or id of an issuer whose note it
    holds; circulating credit), by moving that much of the issuer's debt to the seller (Client.pay_by_transfer)."""
    c = vc.Client(store, server=server)
    who = participant(c, seller)
    price = price or price_of(service, c.network)
    desc = f'{service} for this text:\n```\n{text}\n```'
    d = c.propose(who['id'], 'payer', f'{service} job', desc, f'The exact {service} result as JSON.', price, 24, 1)
    did = d['id']
    log(f'offered {price} {c.unit} to {who["handle"]}: deal {did}')
    deadline = time.time() + wait_s
    status = d['status']
    while time.time() < deadline:
        time.sleep(poll_s)
        d = c.deal(did)
        if d['status'] != status:
            status = d['status']
            log(f'deal {did}: {status}')
        if status == 'open' and d['current']['by'] != c.participant_id:
            amount = d['current']['terms']['price']['amount']
            if amount <= price_of(service, c.network):
                c.accept(did, c.verify_offer(d)['terms_hash'])
            else:
                c.decline(did, f'{amount} {c.unit} is above the published price')
        if status in ('delivered', 'declined', 'expired', 'withdrawn', 'disputed', 'note_issued'):
            break
    if status != 'delivered':
        return {'deal_id': did, 'status': status, 'verified': None}
    got = parse_result(d['delivery']['content'])
    expected = COMPUTE[service](text)
    if got == expected:
        if pay_with in (None, 'own_note'):
            r = c.complete(did, d['delivery']['sha256'])
            log(f'delivery verified exactly; credit note: {r["status"]}')
            return {'deal_id': did, 'status': r['status'], 'verified': True, 'amount': price,
                    'paid': r['status'] in PAID_STATUSES}
        r = c.pay_by_transfer(did, pay_with, expected_deliverable_sha256=d['delivery']['sha256'])
        log(f'delivery verified exactly; paid with a note of {pay_with}: {r["status"]}')
        return {'deal_id': did, 'status': r['status'], 'verified': True, 'amount': price, 'paid_with': pay_with,
                'paid': r['status'] in PAID_STATUSES}
    diff = sorted(k for k in set(expected) | set(got or {}) if (got or {}).get(k) != expected.get(k))
    c.dispute(did, f'The delivered result does not match the exact {service} of the agreed text (differs in: {", ".join(diff)}).')
    log(f'delivery WRONG in {diff}; disputed')
    return {'deal_id': did, 'status': 'disputed', 'verified': False, 'differs_in': diff}


# ---------- circulating credit: selling to the sandbox agents, earning, and the five-step tour ----------
END_STATUSES = ('note_issued', 'paid_by_transfer', 'disputed', 'declined', 'expired', 'withdrawn', 'cancelled',
                'expired_undelivered', 'rejected_by_owner')
PAID_STATUSES = ('note_issued', 'paid_by_transfer')
TOUR_POLL_S = 3
# The tour stops (tour_stuck) after TOUR_CALLS_PER_STEP tool calls in one step that did not finish it. Disputing a wrong
# delivery and buying again (design 9.2) does not count: sandbox-mallory is wrong on purpose for about half of all deal
# ids, so 6 or more wrong deliveries in a row happen in about 1 tour of 64. At most TOUR_DISPUTES_PER_STEP are disputed
# in one step (20 in a row: about 1 in a million) before the tour stops.
TOUR_CALLS_PER_STEP = 12
TOUR_DISPUTES_PER_STEP = 20
# Refusals the tour stops on (any other error of one call is shown, and the next status decides again).
TOUR_STOPS = ('owner_declined', 'not_sandbox_only', 'feature_unavailable', 'attempt_outcome_unknown', 'records_unreadable',
              'tracker_mismatch', 'not_connected', 'not_configured', 'tour_unverified')


def _deliver_and_wait(c, did, service, text, price, wait_s, log, poll_s):
    """This agent is the payee of deal `did`: once it is agreed, deliver the exact result of `text`, then wait until the
    payer pays (or the deal ends). Returns {deal_id, status, paid, amount}."""
    deadline = time.time() + wait_s
    status, delivered = None, False
    while True:
        d = c.deal(did)
        if d['status'] != status:
            status = d['status']
            log(f'deal {did}: {status}')
        if status == 'open' and (d.get('current') or {}).get('by') not in (None, c.participant_id):
            c.decline(did, f'I offered this job at {price} {c.unit}.')       # a counter-offer: the price is the published one
            log(f'deal {did}: declined a counter-offer')
            continue
        if status == 'agreed' and not delivered:
            r = c.deliver(did, render(service, COMPUTE[service](text), text), f'{service} result')
            delivered = True
            log(f'deal {did}: delivered the exact {service} result (sha256 {r["delivery"]["sha256"][:16]}...)')
            continue
        if status in END_STATUSES or time.time() >= deadline:
            break
        time.sleep(poll_s)
    return {'deal_id': did, 'status': status, 'paid': status in PAID_STATUSES, 'amount': price}


def sell(store, buyer, service, text, price=None, server=None, wait_s=600, log=print, poll_s=TOUR_POLL_S):
    """Offer to do one exactly checkable job (text-stats or notary of `text`) for `buyer` (with circulating credit the
    server's sandbox agents buy at their published price), deliver the exact result once the offer is agreed, and wait
    until the buyer pays: with its credit note, or with a note it holds. Run by the owner. Returns {deal_id, status,
    paid, amount}."""
    c = vc.Client(store, server=server)
    who = participant(c, buyer)
    price = price or price_of(service, c.network)
    desc = f'{service} for this text:\n```\n{text}\n```'
    d = c.propose(who['id'], 'payee', f'{service} job', desc, f'The exact {service} result as JSON.', price, 24, 1)
    log(f'offered to do {service} for {who["handle"]} for {price} {c.unit}: deal {d["id"]}')
    return _deliver_and_wait(c, d['id'], service, text, price, wait_s, log, poll_s)


def earn(store, server=None, wait_s=600, log=print, poll_s=TOUR_POLL_S, text=None):
    """Earn credit from the sandbox agents: do the job one of them offered you (the welcome job sandbox-exact sends every
    new sandbox participant), or else offer sandbox-exact a text-stats job (of `text`). The exact result is computed
    from the agreed text and delivered here; the buyer then pays you. Run by the owner. Returns {deal_id, status, paid,
    amount}."""
    from . import agent as va           # here: agent.py imports this module
    c = vc.Client(store, server=server)
    box = c.inbox()
    offer = next((x for x in box.get('respond') or [] if isinstance(x, dict) and x.get('counterparty') in va.SANDBOX_AGENTS
                  and x.get('your_role') == 'payee'), None)
    if offer is None:
        return sell(store, va.SANDBOX_EXACT, 'text-stats', text or va.TOUR_TEXTS[1], server=server, wait_s=wait_s, log=log,
                    poll_s=poll_s)
    did = offer['deal_id']
    d = c.deal(did)
    chk = c.verify_offer(d)
    terms = chk['terms']
    # Accepted without asking (the owner runs this to earn): only a job for this agent as payee, offered (and signed,
    # verify_offer) by one of the sandbox agents as the directory lists them, never on the inbox's word.
    if (terms.get('payee') or {}).get('id') != c.participant_id:
        raise vc.ValunError('not_payee', f'the offer on {did} does not name you as the payee; nothing was signed')
    agents = {p['id'] for p in c.directory() if isinstance(p, dict) and p.get('handle') in va.SANDBOX_AGENTS
              and isinstance(p.get('id'), str) and p.get('status', 'active') == 'active'}
    proposer = (d.get('current') or {}).get('by')
    if proposer not in agents or (terms.get('payer') or {}).get('id') != proposer:
        raise vc.ValunError('not_sandbox_agent', f'the offer on {did} is not from a sandbox agent; nothing was signed')
    service = which_service(terms)
    job = extract_text((terms.get('service') or {}).get('description')) if service else None
    if service is None or job is None:
        raise vc.ValunError('not_exact_service', f'the offer on {did} is not a text-stats or notary job with its text')
    c.accept(did, chk['terms_hash'])
    log(f"accepted the {service} job from {offer['counterparty']} ({terms['price']['amount']} {c.unit}): deal {did}")
    return _deliver_and_wait(c, did, service, job, terms['price']['amount'], wait_s, log, poll_s)


def edge_totals(c):
    """This participant's edges on the tracker, as GET /edges shows them and the client verified (each state carries its
    issuer's signature): {'<issuer> -> <recipient>': total PC}, handles from the directory, 'you' for this agent."""
    edges = c.sync_edges()['edges']
    names = {p.get('pubkey'): p.get('handle') for p in c.directory() if isinstance(p, dict) and p.get('pubkey')}

    def name(pk):
        return 'you' if pk == c.pubkey else (names.get(pk) or f'{pk[:16]}...')
    out = {}
    for edge in sorted(edges):
        i, r = edge.split('>')
        out[f'{name(i)} -> {name(r)}'] = edges[edge]['total']
    return out


def _consents_due(c, log):
    """process_consents() when it is due (agent.consents_due: at most once per CONSENTS_EVERY_MS, on the tour's clock,
    across every process that uses the profile), so the tour keeps the client's once-a-minute rate (PROTOCOL.md 15.3,
    design 6.6): a set-off is signed within about a minute, as valun_status says."""
    from . import agent as va           # here: agent.py imports this module
    try:
        r = va.consents_due(c, now_ms=int(time.time() * 1000))
    except vc.ValunError as e:
        log(f'  (consents: {e.code}: {e})')
        return None
    for e in (r or {}).get('signed', []):
        log(f"  your Valun client signed a {e.get('kind')} as {e.get('role')} (your net change: {e.get('your_net_change_PC')} {c.unit})")
    for e in (r or {}).get('refused', []):
        log(f"  your Valun client refused a {e.get('kind')} ({e.get('code')})")
    return r


def _whole_pc(v):
    return isinstance(v, int) and not isinstance(v, bool) and v > 0


def _sandbox_ids(ag, ids):
    """{handle: participant id} of the active sandbox agents in the directory, read once per tour (`ids` caches it)."""
    if not ids:
        from . import agent as va           # here: agent.py imports this module
        for p in ag.client().directory():
            if isinstance(p, dict) and p.get('handle') in va.SANDBOX_AGENTS and isinstance(p.get('id'), str) \
                    and p.get('status', 'active') == 'active':
                ids[p['handle']] = p['id']
    return ids


def tour_rules_problem(ag, name, args, ids):
    """Audit AI-3: does a prepared commitment (`args` as prepare() bound them) do only what the tour itself would do?
    None if so, else what is wrong. The counterparty is one of the sandbox agents (their directory ids, resolved once per
    tour), a price this participant pays is at most the published price of the service, and a held note paid with is
    the other sandbox agent's. The terms are read again here and must hash to the terms hash prepare() pinned (the
    client signs nothing else), so nothing rests on the inbox's word."""
    agents = set(_sandbox_ids(ag, ids).values())
    if not agents:
        return 'the directory lists no sandbox agent'
    network = getattr(ag.client(), 'network', None)
    top = max(price_of(s, network) for s in SERVICES)
    if name == 'valun_propose':
        cp, role, price = args.get('counterparty'), args.get('role'), args.get('price')
        if cp not in agents:
            return 'the offer is not for one of the sandbox agents'
        if role not in ('payer', 'payee') or not _whole_pc(price) or (role == 'payer' and price > top):
            return f'the offer is not at a published price (at most {top} {unit_of(network)} to pay)'
        return None
    if not ((name == 'valun_respond' and args.get('action') == 'accept')
            or (name == 'valun_review_delivery' and args.get('decision') == 'accept')):
        return 'the tour makes no such commitment'
    c = ag.client()
    d = c.deal(args.get('deal_id'))
    if name == 'valun_respond':
        chk = c.verify_offer(d)
        t, h = chk['terms'], chk['terms_hash']
    else:
        t = c.verified_agreement(d)
        h = vc.terms_hash(t)
    if h != args.get('expected_terms_hash'):
        return 'the terms read now are not the ones prepared'
    me = c.participant_id
    role = 'payer' if t['payer']['id'] == me else 'payee' if t['payee']['id'] == me else None
    other = (t['payee'] if role == 'payer' else t['payer'])['id'] if role else None
    price = (t.get('price') or {}).get('amount')
    if role is None or other not in agents:
        return 'the other party of the signed terms is not a sandbox agent'
    if not _whole_pc(price):
        return f'the signed terms carry no price in whole {unit_of(network)}'
    if role == 'payer':
        service = which_service(t)
        if service is None or price > price_of(service, network):
            return 'the signed price is above the published price of the service'
    if name == 'valun_review_delivery':
        if role != 'payer':
            return 'only the payer accepts a delivery'
        pw = args.get('pay_with')
        if pw not in (None, 'own_note') and (pw not in agents or pw == other):
            return "the note to pay with is not the other sandbox agent's"
    return None


def _tour_call(ag, call, yes, ask, log, ids=None):
    """One call of sandbox_next_steps through the agent tools: a commitment is prepared (bound to what is shown), then
    approved at the terminal (ask) unless `yes`, then called with exactly the prepared arguments. With `yes` a
    commitment is approved only when tour_rules_problem() finds nothing wrong with what was prepared (audit AI-3); else
    the owner is asked (ask), or the tour stops (tour_unverified). A refusal of the preparation carries its cause
    (attempt_outcome_unknown, records_unreadable, ...): that cause is the error raised, so the tour stops on it."""
    ids = {} if ids is None else ids
    name, args = call.get('tool'), call.get('arguments') or {}
    log(f"  -> {name}: {call.get('why') or ''}")
    if ag.is_commitment(name, args):
        prepared, refusal = ag.prepare_or_refusal(name, args)
        if refusal:
            cause = refusal.get('cause')
            code = cause if cause in TOUR_STOPS else (refusal.get('error') or 'approval_unbound')
            raise vc.ValunError(code, refusal.get('message') or 'nothing was signed',
                                extra={k: v for k, v in refusal.items() if k not in ('error', 'message')})
        args = prepared['args']
        if prepared['text'] is not None:
            problem = tour_rules_problem(ag, name, args, ids) if yes else None
            if yes and problem is None:
                log('\n'.join('     ' + line for line in prepared['text'].split('\n')))
            elif yes and not ask:
                raise vc.ValunError('tour_unverified', f'not approved by --yes: {problem}; nothing was signed; the tour '
                                                       'stops here (run it without --yes to decide yourself)')
            elif not (ask and ask(prepared['text'])):
                raise vc.ValunError('owner_declined', 'not approved; nothing was signed; the tour stops here')
    r = ag.call(name, args)
    log(f"     {r.get('what_happened') or r.get('status')}")
    return r


def tour(store, server=None, yes=False, ask=None, log=print, poll_s=TOUR_POLL_S, timeout_s=1800, agent=None):
    """The five-step circulating-credit tour of design 9.2, for a sandbox_only participant (not_sandbox_only otherwise)
    on a server that offers circulation/1 (feature_unavailable otherwise): earn a note from sandbox-exact, spend it with
    sandbox-mallory, pay sandbox-exact with your own note and see the 2-cycle cleared, sell to sandbox-mallory and see
    the 3-cycle cleared, and spend sandbox-mallory's note with sandbox-exact. It follows valun_status
    sandbox_next_steps through the agent tools, so it takes exactly the path an agent takes; every commitment is
    approved through ask(text) -> bool unless `yes`. After each call, and while it waits, it processes consents when
    they are due (at most once a minute; its agent does not process them itself, but its clients declare the consent
    roles the profile signs, as a client that signs consents must); a call that fails is shown and the
    tour waits poll_s before the next status decides again; a refusal whose cause is in TOUR_STOPS ends the tour with
    that cause. A step that does not finish after TOUR_CALLS_PER_STEP tool calls ends the tour with tour_stuck; a wrong
    delivery disputed, and the purchase made again after it, do not count, up to TOUR_DISPUTES_PER_STEP disputes in the
    step. When a step is done it logs your edges' tracker totals (GET /edges). Returns {done, steps: [{step,
    tracker_totals, money_view}]}."""
    from . import agent as va           # here: agent.py imports this module
    # Its agent's hook is off because the tour runs the consents itself, on this agent's client (_consents_due below), so
    # its clients declare the consent roles the profile signs (declare_roles; decision D-3 b): without them the server
    # leaves this participant out of every set-off, and steps 3 and 4 never clear.
    ag = agent or va.ValunAgent(store, approvals='', check_link_hosts=False, server=server, process_consents=False,
                                declare_roles=True)
    c = ag.client()
    if (c.me().get('participant') or {}).get('sandbox_only') is not True:
        raise vc.ValunError('not_sandbox_only', 'the tour is for sandbox-only participants (`valun join --sandbox`)')
    if va.CIRCULATION not in va.features_of(c.info()):
        raise vc.ValunError('feature_unavailable', 'this Valun server does not offer circulating credit (circulation/1) yet')
    steps, current, said, calls_in_step, deadline = [], None, None, 0, time.time() + timeout_s
    ids = {}                                # the sandbox agents' directory ids, read once (tour_rules_problem)
    disputes_in_step = 0
    while True:
        try:
            st = ag.status({})
        except vc.ValunError as e:
            if e.code in TOUR_STOPS or time.time() >= deadline:
                raise
            log(f'  (status: {e.code}; trying again)')
            time.sleep(poll_s)
            continue
        nxt = st.get('sandbox_next_steps')
        if not isinstance(nxt, dict):
            raise vc.ValunError('feature_unavailable', 'valun_status shows no sandbox_next_steps for this participant')
        step = nxt.get('tour_step')
        if step != current:
            if isinstance(current, int):
                totals = edge_totals(c)
                steps.append({'step': current, 'tracker_totals': totals, 'money_view': st.get('money_view')})
                log(f'step {current} done. Your edges on the tracker: '
                    + ('; '.join(f"{k}: {v} {getattr(c, 'unit', vc.UNIT)}" for k, v in totals.items()) or 'none'))
            if step == 'done':
                log(nxt.get('then') or 'The tour is complete.')
                return {'done': True, 'steps': steps}
            if isinstance(step, int):
                log(f'step {step} of 5: {nxt.get("goal")}')
            current, calls_in_step, disputes_in_step = step, 0, 0
        calls = nxt.get('next_calls') or []
        if not calls and nxt.get('then') != said:
            said = nxt.get('then')
            log(f'  ... {said}')
        failed = False
        for call in calls:
            calls_in_step += 1
            # Each wrong delivery disputed allows two more calls: the dispute itself and the purchase made again.
            if calls_in_step > TOUR_CALLS_PER_STEP + 2 * disputes_in_step:
                raise vc.ValunError('tour_stuck', f'step {current} did not finish after {calls_in_step - 1} tool calls; stopped')
            dispute = call.get('tool') == 'valun_review_delivery' and (call.get('arguments') or {}).get('decision') == 'dispute'
            if dispute and disputes_in_step >= TOUR_DISPUTES_PER_STEP:
                raise vc.ValunError('tour_stuck', f'step {current}: {TOUR_DISPUTES_PER_STEP} wrong deliveries were disputed '
                                                  'and none was right; stopped')
            try:
                _tour_call(ag, call, yes, ask, log, ids)
            except vc.ValunError as e:
                if e.code in TOUR_STOPS:
                    raise
                log(f'     {e.code}: {e}')
                failed = True                   # wait before trying again: the next status decides
                break
            if dispute:
                disputes_in_step += 1
        _consents_due(c, log)
        if not calls or failed:
            if time.time() >= deadline:
                raise vc.ValunError('tour_timeout', f'step {current} did not finish in time; run the tour again to continue')
            time.sleep(poll_s)
