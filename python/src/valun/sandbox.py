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
SERVICES_TEXT = ('text-stats (3 PC): exact word/character/line counts, unique words, SHA-256 and the 10 most frequent '
                 'words of your text. notary (2 PC): SHA-256 and byte length of your text. Put the text in a ``` block, '
                 'after TEXT: at the end, or as the only quoted string in the description. Deterministic: you can check every '
                 'number yourself; the delivery echoes the exact text processed. I only do the work (payee).')
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


def which_service(terms):
    svc = terms.get('service') or {}
    hay = ' '.join(str(svc.get(k) or '') for k in ('title', 'description', 'deliverable')).lower()
    for name, s in SERVICES.items():
        if any(k in hay for k in s['keywords']):
            return name
    return None


class Seller:
    def __init__(self, store, server=None, log=None):
        self.c = vc.Client(store, server=server)
        self.log = log or sys.stdout
        self.countered = {}

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
            self.c.decline(did, 'I only sell (I do the work); I do not buy. ' + SERVICES_TEXT)
            return self.note(deal=did, action='decline', why='not_payee')
        service = which_service(terms)
        if not service:
            self.c.decline(did, 'I do not offer that service. ' + SERVICES_TEXT)
            return self.note(deal=did, action='decline', why='unknown_service')
        text = extract_text((terms.get('service') or {}).get('description'))
        if text is None:
            self.c.decline(did, 'I could not find the text to process. ' + HOW_TO_SEND)
            return self.note(deal=did, action='decline', why='no_text')
        if len(text.encode('utf-8')) > 16000:
            self.c.decline(did, 'The text is longer than 16,000 bytes; send a shorter one.')
            return self.note(deal=did, action='decline', why='too_long')
        price, ask = terms['price']['amount'], SERVICES[service]['price']
        if price < ask * MIN_PRICE_FRACTION:
            if self.countered.get(did):
                self.c.decline(did, f'My price for {service} is {ask} PC.')
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

    def step(self):
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


def buy(store, seller, service, text, price=None, server=None, wait_s=600, log=print):
    """Order one job from `seller` and verify the delivery exactly. Returns a summary dict."""
    c = vc.Client(store, server=server)
    who = next((p for p in c.directory() if seller in (p['handle'], p['id'])), None)
    if not who:
        raise vc.ValunError('unknown_participant', f'no participant called {seller!r}')
    price = price or SERVICES[service]['price']
    desc = f'{service} for this text:\n```\n{text}\n```'
    d = c.propose(who['id'], 'payer', f'{service} job', desc, f'The exact {service} result as JSON.', price, 24, 1)
    did = d['id']
    log(f'offered {price} PC to {who["handle"]}: deal {did}')
    deadline = time.time() + wait_s
    status = d['status']
    while time.time() < deadline:
        time.sleep(5)
        d = c.deal(did)
        if d['status'] != status:
            status = d['status']
            log(f'deal {did}: {status}')
        if status == 'open' and d['current']['by'] != c.participant_id:
            amount = d['current']['terms']['price']['amount']
            if amount <= SERVICES[service]['price']:
                c.accept(did, c.verify_offer(d)['terms_hash'])
            else:
                c.decline(did, f'{amount} PC is above the published price')
        if status in ('delivered', 'declined', 'expired', 'withdrawn', 'disputed', 'note_issued'):
            break
    if status != 'delivered':
        return {'deal_id': did, 'status': status, 'verified': None}
    got = parse_result(d['delivery']['content'])
    expected = COMPUTE[service](text)
    if got == expected:
        r = c.complete(did, d['delivery']['sha256'])
        log(f'delivery verified exactly; credit note: {r["status"]}')
        return {'deal_id': did, 'status': r['status'], 'verified': True, 'amount': price}
    diff = sorted(k for k in set(expected) | set(got or {}) if (got or {}).get(k) != expected.get(k))
    c.dispute(did, f'The delivered result does not match the exact {service} of the agreed text (differs in: {", ".join(diff)}).')
    log(f'delivery WRONG in {diff}; disputed')
    return {'deal_id': did, 'status': 'disputed', 'verified': False, 'differs_in': diff}
