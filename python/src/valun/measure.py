"""Deterministic facts about a delivery, for the agent that reviews it.

The plugin counts words and links and checks them against the numeric requirements written in the agreed terms
("300-500 words", "at least 3 cited sources"), and can check whether each link's host name exists in DNS. These are
measurements, not judgements: whether the work is accurate, on topic and good is still the reviewing agent's call.
DNS only: no page is fetched, no connection is opened to the linked hosts.
"""
import ipaddress
import re
import socket
from concurrent.futures import ThreadPoolExecutor, wait

URL = re.compile(r'https?://[^\s<>\[\]"\'`]+', re.I)
WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'’-]*")
WORD_RANGE = re.compile(r'(\d{2,5})\s*(?:-|–|—|to)\s*(\d{2,5})[\s-]*words?', re.I)
MIN_WORDS = re.compile(r'(?:at least|minimum(?: of)?|min\.?|no fewer than|no less than)\s*(\d{2,5})\s*words?', re.I)
# A limit on the whole text. "under", "fewer than" and "less than" are strict: "under 400 words" allows at most 399
# (STRICT). "no fewer than" and "no less than" are minimums (MIN_WORDS), never a limit.
MAX_PHRASE = r'(at most|up to|maximum(?: of)?|max\.?|under|(?<!no )fewer than|(?<!no )less than|no more than)'
MAX_WORDS = re.compile(MAX_PHRASE + r'\s*(\d{1,5})\s*words?', re.I)
# A limit on every bullet, line or item ("each bullet under 15 words", "every line at most 20 words", "15 words each"):
# measured per item, never as a limit on the whole text.
PER_ITEM = re.compile(r'(?:\b(?:each|every)(?:\s+(?:bullet(?:\s+point)?|point|line|item|sentence)s?)?|\bper\s+(?:bullet|point|line|item|sentence))'
                      r'\b[^.\n]{0,40}?' + MAX_PHRASE + r'\s*(\d{1,5})\s*words?'
                      r'|(\d{1,5})\s*words?\s+(?:or (?:fewer|less)\s+)?each', re.I)
STRICT = ('under', 'fewer than', 'less than')
# Text quoted in ``` blocks is the material to work on (or, for a check, the terms and work being checked), never the
# terms of this deal: its numbers are not requirements.
QUOTED = re.compile(r'```.*?```', re.S)
ITEM = re.compile(r'\s*(?:[-*•]|\d+[.)])\s+')
MIN_LINKS = re.compile(r'at least\s*(\d{1,2})\s*(?:cited\s+|linked\s+)?(?:sources|links|references|citations)', re.I)
MAX_LINKS_CHECKED = 10


def word_count(text):
    return len(WORD.findall(text or ''))


def links(text):
    out = []
    for u in URL.findall(text or ''):
        u = u.rstrip('.,;:!?*_')
        while u.endswith(')') and u.count(')') > u.count('('):   # "(see https://x/y)." -> drop the closing bracket
            u = u[:-1].rstrip('.,;:!?*_')
        if u not in out:
            out.append(u)
    return out


def _host(url):
    m = re.match(r'https?://([^/:?#]+)', url, re.I)
    return m.group(1).lower() if m else ''


def _resolve(host):
    """'public' | 'private' (resolves only to private, loopback or reserved addresses) | 'not_found'."""
    try:
        addrs = {a[4][0] for a in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
    except (socket.gaierror, UnicodeError, OSError):
        return 'not_found'
    ips = [ipaddress.ip_address(a.split('%')[0]) for a in addrs]
    return 'public' if any(ip.is_global for ip in ips) else 'private'


def host_status(urls, resolver=_resolve, timeout=4.0):
    hosts = list(dict.fromkeys(h for h in (_host(u) for u in urls) if h))[:MAX_LINKS_CHECKED]
    result = {h: 'unknown (lookup timed out)' for h in hosts}
    if not hosts:
        return result
    pool = ThreadPoolExecutor(max_workers=min(8, len(hosts)))
    futures = {pool.submit(resolver, h): h for h in hosts}
    done, _ = wait(futures, timeout=timeout)
    for f in done:
        result[futures[f]] = f.result()
    pool.shutdown(wait=False, cancel_futures=True)
    return result


def _limit(phrase, n):
    return n - 1 if phrase.lower() in STRICT else n


def requirements(terms_text):
    """Numeric requirements found in the agreed service text (title, description, deliverable), outside ``` blocks."""
    req = {}
    terms_text = QUOTED.sub(' ', terms_text or '')
    if (m := PER_ITEM.search(terms_text)):
        req['max_words_per_item'] = _limit(m.group(1), int(m.group(2))) if m.group(2) else int(m.group(3))
        terms_text = PER_ITEM.sub(' ', terms_text)      # a limit on each item is not also a limit on the whole text
    m = WORD_RANGE.search(terms_text)
    if m:
        lo, hi = sorted((int(m.group(1)), int(m.group(2))))
        req['min_words'], req['max_words'] = lo, hi
    else:
        if (m := MIN_WORDS.search(terms_text)):
            req['min_words'] = int(m.group(1))
        if (m := MAX_WORDS.search(terms_text)):
            req['max_words'] = _limit(m.group(1), int(m.group(2)))
    if (m := MIN_LINKS.search(terms_text)):
        req['min_links'] = int(m.group(1))
    return req


def item_word_counts(text):
    """The word count of each bullet or numbered item (its marker left out), or of each non-empty line if there are none."""
    lines = (text or '').splitlines()
    marked = [ln[m.end():] for ln in lines if (m := ITEM.match(ln))]
    return [word_count(ln) for ln in (marked or [ln for ln in lines if ln.strip()])]


def measure(text, terms_text, check_hosts=True, resolver=_resolve):
    words, found = word_count(text), links(text)
    req, checks = requirements(terms_text), []
    if 'min_words' in req or 'max_words' in req:
        lo, hi = req.get('min_words'), req.get('max_words')
        ok = (lo is None or words >= lo) and (hi is None or words <= hi)
        want = f'{lo}-{hi} words' if lo is not None and hi is not None else (f'at least {lo} words' if lo is not None else f'at most {hi} words')
        checks.append({'requirement': want, 'measured': f'{words} words', 'met': ok})
    if 'max_words_per_item' in req:
        cap, counts = req['max_words_per_item'], item_word_counts(text)
        checks.append({'requirement': f'at most {cap} words in each bullet or line',
                       'measured': f"{len(counts)} items of {', '.join(map(str, counts))} words" if counts else 'no items',
                       'met': bool(counts) and max(counts) <= cap})
    if 'min_links' in req:
        checks.append({'requirement': f"at least {req['min_links']} sources with links", 'measured': f'{len(found)} distinct links',
                       'met': len(found) >= req['min_links']})
    out = {'word_count': words, 'links': found, 'checks_against_agreed_terms': checks,
           'how_measured': 'by your Valun client, deterministically: words = runs of letters/digits; links = distinct http(s) '
                           'URLs; a limit on each bullet is measured per bullet (or per line). These are facts to use in your '
                           'review, not a verdict on quality, accuracy or relevance.'}
    if check_hosts and found:
        st = host_status(found, resolver)
        out['link_hosts'] = st
        missing = [h for h, s in st.items() if s == 'not_found']
        if missing:
            out['warning'] = ('These link hosts do not exist in DNS, so those sources cannot be real: ' + ', '.join(missing)
                              + '. A source whose link cannot work does not count as a working link.')
    return out
