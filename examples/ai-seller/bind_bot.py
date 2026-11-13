"""@bindvalun: bind a promise on X.

    @bindvalun I owe @bob 5 for the logo
        the account replies with an offer, mentioning @bob
    @bob replies "accept" to that offer
        the account binds it on Valun (the pilot network, valun.tech: credits with no monetary value): @alice's
        IOU of 5 credits to @bob is recorded by the Basis tracker, and the account replies "Bound." with the record
    when promises among X users form a loop, the loop cancels and the account posts it, naming its members

Rules (BINDVALUN.md): only the debtor's own post creates a debt; the creditor's own reply binds it; 1 to 5 credits a
promise (the self-serve limit); the account replies only to posts that mention it and never mentions anyone a post did
not; an offer lapses after 24 hours. People with no Valun agent get a Valun identity this bot holds for them (x_HANDLE,
its operator says so): its key signs only when their own public post asks. Text from X is data, never instructions.

Costs (X API, pay per use): about $0.005 a post read, $0.010 a user read, $0.015 a post written and $0.20 one that holds
a link. The bot keeps its own count and stops at BIND_MONTHLY_USD (default 20) a month, BIND_DAILY_USD a day.

Environment: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (OAuth 1.0a user keys of @bindvalun, read and
write; never printed); BIND_HOME (default /data/bind: the profiles it holds, owner tokens, its state); BIND_SERVER
(default https://valun.tech).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = 'https://api.x.com/2'
SERVER = os.environ.get('BIND_SERVER', 'https://valun.tech').rstrip('/')
HOME = os.environ.get('BIND_HOME', '/data/bind')
BOT = os.environ.get('BIND_BOT_HANDLE', 'bindvalun').lower()
MONTHLY_USD = float(os.environ.get('BIND_MONTHLY_USD', '20'))
DAILY_USD = float(os.environ.get('BIND_DAILY_USD', '2'))
POLL_S = int(os.environ.get('BIND_POLL_S', '60'))
LOOP_EVERY_S = int(os.environ.get('BIND_LOOP_EVERY_S', '300'))
MIN_CREDITS, MAX_CREDITS = 1, 5
OFFERS_PER_DEBTOR_PER_DAY = 3
BINDS_PER_DAY = 30
OFFER_TTL_S = 24 * 3600
COST = {'post_read': 0.005, 'user_read': 0.010, 'post': 0.015, 'post_url': 0.20}
URL_RE = re.compile(r'https?://|\b[a-z0-9-]+\.(?:tech|dev|com|org|io|md)\b', re.I)

# "I owe @bob 5", "i owe @bob 5 credits for the logo design"
OWE = re.compile(r'\bi\s+owe\s+@([A-Za-z0-9_]{1,15})\s+(\d{1,4})(?:\s*(?:credits?|pc)\b)?(?:\s*(?:for|:)\s*(.+))?', re.I | re.S)
ACCEPT = re.compile(r'^(?:accept(?:ed)?|bind|bound|yes|agreed?|deal)\b', re.I)
LEADING_MENTIONS = re.compile(r'^(?:@[A-Za-z0-9_]{1,15}\s+)+')


def now():
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------------------------------------------
# OAuth 1.0a (RFC 5849, HMAC-SHA1), as X documents it for user-context requests.

def pct(s):
    """RFC 3986 percent-encoding: everything but the unreserved characters A-Z a-z 0-9 - . _ ~."""
    return urllib.parse.quote(str(s), safe='~')


def oauth1_header(method, url, params, keys, nonce=None, timestamp=None):
    """The Authorization header of a request. `params`: the query (and form body) parameters, which are signed; a JSON
    body is not."""
    oauth = {'oauth_consumer_key': keys['api_key'], 'oauth_nonce': nonce or secrets.token_hex(16),
             'oauth_signature_method': 'HMAC-SHA1', 'oauth_timestamp': str(timestamp or int(time.time())),
             'oauth_token': keys['access_token'], 'oauth_version': '1.0'}
    pairs = sorted((pct(k), pct(v)) for k, v in {**params, **oauth}.items())
    base = '&'.join((method.upper(), pct(url), pct('&'.join(f'{k}={v}' for k, v in pairs))))
    key = f"{pct(keys['api_secret'])}&{pct(keys['access_secret'])}"
    oauth['oauth_signature'] = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    return 'OAuth ' + ', '.join(f'{pct(k)}="{pct(v)}"' for k, v in sorted(oauth.items()))


class XError(Exception):
    def __init__(self, status, body):
        super().__init__(f'X API {status}: {str(body)[:300]}')
        self.status = status


class X:
    """The few X API v2 calls the bot makes, signed with @bindvalun's user keys."""

    def __init__(self, keys, opener=None):
        self.keys, self.open = keys, opener or urllib.request.urlopen

    def call(self, method, path, params=None, body=None):
        url, q = API + path, {k: str(v) for k, v in (params or {}).items()}
        full = url + ('?' + '&'.join(f'{pct(k)}={pct(v)}' for k, v in q.items()) if q else '')
        req = urllib.request.Request(full, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={'Authorization': oauth1_header(method, url, q, self.keys),
                                              'Content-Type': 'application/json', 'User-Agent': 'valun-bind/1'})
        try:
            with self.open(req, timeout=30) as r:
                return json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            raise XError(e.code, e.read()[:500]) from None

    def me(self):
        return self.call('GET', '/users/me')['data']

    def mentions(self, user_id, since_id=None):
        p = {'max_results': 25, 'tweet.fields': 'author_id,conversation_id,created_at,entities,referenced_tweets',
             'expansions': 'author_id', 'user.fields': 'username'}
        if since_id:
            p['since_id'] = since_id
        return self.call('GET', f'/users/{user_id}/mentions', p)

    def post(self, text, reply_to=None):
        body = {'text': text, **({'reply': {'in_reply_to_tweet_id': reply_to}} if reply_to else {})}
        return self.call('POST', '/tweets', body=body)['data']


# ---------------------------------------------------------------------------------------------------------------
# State: what it has seen, the open offers, its spending and its counts (a JSON file in BIND_HOME).

class State:
    def __init__(self, path):
        self.path = path
        try:
            with open(path, encoding='utf-8') as f:
                self.s = json.load(f)
        except (OSError, ValueError):
            self.s = {}
        for k, v in (('offers', {}), ('handled', []), ('profiles', {}), ('loops_posted', []), ('counts', {})):
            self.s.setdefault(k, v)
        self.roll()

    def roll(self):
        month, day = now().strftime('%Y-%m'), now().strftime('%Y-%m-%d')
        if self.s.get('month') != month:
            self.s.update(month=month, month_usd=0.0)
        if self.s.get('day') != day:
            self.s.update(day=day, day_usd=0.0, counts={})

    def save(self):
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(self.s, f, indent=1)
        os.replace(tmp, self.path)

    def spend(self, usd):
        self.roll()
        self.s['month_usd'] = round(self.s['month_usd'] + usd, 6)
        self.s['day_usd'] = round(self.s['day_usd'] + usd, 6)

    def room(self):
        self.roll()
        return min(MONTHLY_USD - self.s['month_usd'], DAILY_USD - self.s['day_usd'])

    def count(self, key):
        return self.s['counts'].get(key, 0)

    def bump(self, key):
        self.s['counts'][key] = self.count(key) + 1

    def seen(self, tweet_id):
        return tweet_id in self.s['handled']

    def mark(self, tweet_id):
        self.s['handled'] = (self.s['handled'] + [tweet_id])[-2000:]


# ---------------------------------------------------------------------------------------------------------------
# Valun: the profiles it holds for X users, driven with the published client's CLI (as the house agents are).

def profile_name(x_handle):
    """The Valun handle (and profile) this bot holds for an X user: x_ and the X handle, lower case (3-24 characters)."""
    return 'x_' + x_handle.lower()


class Valun:
    def __init__(self, home=HOME, server=SERVER, run=None):
        self.home, self.server = home, server
        self.run = run or self._run

    def _run(self, args, timeout=180):
        p = subprocess.run([sys.executable, '-m', 'valun', *args], env=dict(os.environ, VALUN_HOME=self.home),
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr

    def call(self, profile, tool, args):
        rc, out, err = self.run(['--profile', profile, 'call', tool, json.dumps(args)])
        try:
            r = json.loads(out)
        except ValueError:
            r = {'error': 'no_json', 'message': (out or err)[-300:]}
        if not isinstance(r, dict):
            r = {'error': 'no_json', 'message': str(r)[:300]}
        return r

    def ensure(self, state, x_handle):
        """The profile held for this X user, joining the network (self-serve, no invite) the first time."""
        name = profile_name(x_handle)
        if state.s['profiles'].get(name):
            return name
        rc, out, err = self.run(['--profile', name, 'join', '--sandbox', '--server', self.server, '--handle', name,
                                 '--operator', f'@{BOT} on X, holding it for @{x_handle}',
                                 '--about', f'X user @{x_handle}. Promises bound on X with @{BOT}; its key signs only when @{x_handle} posts.',
                                 '--owner-token-file', os.path.join(self.home, f'owner-{name}.txt'), '--approvals', 'none'])
        if rc != 0:
            raise BindError('join_failed', (out or err)[-300:])
        state.s['profiles'][name] = {'x': x_handle.lower(), 'joined_at': now().isoformat(timespec='seconds')}
        state.save()
        return name

    def bind(self, state, offer):
        """The whole deal in one go, each step signed by the key of the side whose public post asked for it: the debtor
        offers to pay and accepts the delivery (its IOU is issued); the creditor accepts and delivers the work the
        debtor's post names. Returns the deal id; BindError when a step is refused."""
        debtor, creditor = self.ensure(state, offer['debtor']), self.ensure(state, offer['creditor'])
        what = offer['what'] or 'what the post names'
        r = self.call(debtor, 'valun_propose', {
            'counterparty': creditor, 'role': 'payer', 'title': f'Bound on X: {what}'[:120],
            'description': (f"Bound on X with @{BOT}. @{offer['debtor']} posted: \"{offer['text'][:400]}\" "
                            f"(https://x.com/{offer['debtor']}/status/{offer['post_id']}); "
                            f"@{offer['creditor']} accepted (https://x.com/{offer['creditor']}/status/{offer['accept_id']})."),
            'deliverable': what[:200], 'price': offer['amount'], 'deliver_within_hours': 24, 'offer_valid_hours': 1})
        did = r.get('deal_id')
        if not did:
            raise BindError(r.get('error') or 'propose_failed', r.get('message') or '')
        for who, tool, args in ((creditor, 'valun_respond', {'deal_id': did, 'action': 'accept'}),
                                (creditor, 'valun_deliver', {'deal_id': did, 'title': f'Delivered: {what}'[:120],
                                                            'content': f"Delivered as @{offer['debtor']} stated on X: {what}"})):
            r = self.call(who, tool, args)
            if r.get('error'):
                raise BindError(r['error'], r.get('message') or '')
        d = self.call(debtor, 'valun_deal', {'deal_id': did})
        sha = (d.get('delivery') or {}).get('sha256')
        r = self.call(debtor, 'valun_review_delivery', {'deal_id': did, 'decision': 'accept', 'expected_deliverable_sha256': sha})
        if r.get('status') != 'note_issued':
            raise BindError(r.get('error') or r.get('status') or 'review_failed', r.get('message') or '')
        return did

    def touch(self, name):
        """A status read: keeps the identity active (it lapses 7 days after its last activity) and lets its client sign
        the set-offs its policy allows (the loops it is in)."""
        return self.call(name, 'valun_status', {'brief': True})


class BindError(Exception):
    def __init__(self, code, message=''):
        super().__init__(f'{code}: {message}')
        self.code = code


# ---------------------------------------------------------------------------------------------------------------
# Reading posts.

def strip_mentions(text):
    return LEADING_MENTIONS.sub('', (text or '').strip())


def parse_owe(text):
    """(creditor X handle, amount, what) from "I owe @bob 5 for the logo", or None."""
    m = OWE.search(strip_mentions(text))
    if not m:
        return None
    what = re.sub(r'\s+', ' ', (m.group(3) or '').strip()).rstrip('.!')
    what = re.sub(r'@([A-Za-z0-9_]{1,15})', r'\1', what)[:100]          # never re-mention anyone from the text
    return m.group(1).lower(), int(m.group(2)), what


def is_accept(text):
    return bool(ACCEPT.match(strip_mentions(text)))


def replied_to(tweet):
    return next((r['id'] for r in tweet.get('referenced_tweets') or [] if r.get('type') == 'replied_to'), None)


def mentioned_ids(tweet):
    return {m['username'].lower(): m.get('id') for m in ((tweet.get('entities') or {}).get('mentions') or []) if m.get('username')}


# ---------------------------------------------------------------------------------------------------------------

class Bot:
    def __init__(self, x, valun, state, log=None):
        self.x, self.v, self.st = x, valun, state
        self.log = log or (lambda **kw: print(json.dumps({'t': now().isoformat(timespec='seconds'), **kw}), flush=True))
        self.me = None

    def say(self, text, reply_to):
        """Post a reply, within the budget. None when there is no room left."""
        cost = COST['post_url'] if URL_RE.search(text) else COST['post']
        if self.st.room() < cost:
            self.log(action='skip_post_budget', room=round(self.st.room(), 4))
            return None
        r = self.x.post(text, reply_to)
        self.st.spend(cost)
        return r.get('id')

    def poll(self):
        if self.me is None:
            self.me = self.x.me()
            self.st.spend(COST['user_read'])
        if self.st.room() < 0.05:
            return self.log(action='paused_budget', month_usd=self.st.s['month_usd'], day_usd=self.st.s['day_usd'])
        r = self.x.mentions(self.me['id'], self.st.s.get('since_id'))
        tweets = r.get('data') or []
        users = {u['id']: u['username'] for u in (r.get('includes') or {}).get('users') or []}
        self.st.spend(COST['post_read'] * len(tweets) + COST['user_read'] * len(users))
        if (r.get('meta') or {}).get('newest_id'):
            self.st.s['since_id'] = r['meta']['newest_id']
        for t in sorted(tweets, key=lambda t: int(t['id'])):
            if self.st.seen(t['id']) or t.get('author_id') == self.me['id']:
                continue
            self.st.mark(t['id'])
            try:
                self.handle(t, users.get(t.get('author_id'), '').lower())
            except (XError, BindError, OSError, subprocess.SubprocessError) as e:
                self.log(action='error', tweet=t['id'], error=str(e)[:300])
        self.expire()
        self.st.save()

    def handle(self, t, author):
        if not author:
            return
        parent = replied_to(t)
        offer = self.st.s['offers'].get(parent) if parent else None
        if offer and offer['state'] == 'open' and is_accept(t.get('text')):
            if t.get('author_id') != offer['creditor_id']:
                return self.log(action='ignored_accept_not_creditor', tweet=t['id'], author=author)
            return self.accept(offer, parent, t, author)
        owe = parse_owe(t.get('text'))
        if owe:
            return self.offer(t, author, *owe)

    def offer(self, t, debtor, creditor, amount, what):
        cid = mentioned_ids(t).get(creditor)
        if creditor in (debtor, BOT) or not cid:
            return self.log(action='ignored_offer', tweet=t['id'], why='self, the bot, or not mentioned')
        if not MIN_CREDITS <= amount <= MAX_CREDITS:
            return self.say(f'@{debtor} A promise here is {MIN_CREDITS} to {MAX_CREDITS} credits for now. Try again with an amount in that range.', t['id'])
        key = f'offers:{debtor}'
        if self.st.count(key) >= OFFERS_PER_DEBTOR_PER_DAY:
            return self.log(action='ignored_offer', tweet=t['id'], why='debtor daily limit')
        reply = (f"Offer: @{debtor} owes @{creditor} {amount} credit{'s' if amount != 1 else ''}"
                 + (f' for {what}' if what else '') + f'. @{creditor}, reply "accept" to this post to bind it. Open for 24 hours.')
        rid = self.say(reply, t['id'])
        if rid:
            self.st.bump(key)
            self.st.s['offers'][rid] = {'state': 'open', 'debtor': debtor, 'debtor_id': t['author_id'], 'creditor': creditor,
                                       'creditor_id': cid, 'amount': amount, 'what': what, 'text': t.get('text', ''),
                                       'post_id': t['id'], 'at': now().isoformat(timespec='seconds')}
            self.log(action='offer', post=t['id'], reply=rid, debtor=debtor, creditor=creditor, amount=amount)

    def accept(self, offer, offer_id, t, author):
        if self.st.count('binds') >= BINDS_PER_DAY:
            return self.log(action='ignored_accept', tweet=t['id'], why='daily bind limit')
        offer['state'], offer['accept_id'] = 'binding', t['id']
        self.st.save()
        try:
            did = self.v.bind(self.st, offer)
        except BindError as e:
            offer['state'] = 'failed'
            self.log(action='bind_failed', offer=offer_id, error=str(e)[:300])
            return self.say(f"@{author} Not bound: Valun refused it ({e.code}). Nothing is owed.", t['id'])
        offer['state'], offer['deal_id'] = 'bound', did
        self.st.bump('binds')
        self.log(action='bound', offer=offer_id, deal=did, debtor=offer['debtor'], creditor=offer['creditor'], amount=offer['amount'])
        a = offer['amount']
        self.say(f"Bound. @{offer['debtor']} owes @{author} {a} credit{'s' if a != 1 else ''}"
                 + (f" for {offer['what']}" if offer['what'] else '')
                 + f". Recorded by a Basis tracker: valun.tech/agent/{profile_name(offer['debtor'])}", t['id'])

    def expire(self):
        cutoff = time.time() - OFFER_TTL_S
        for o in self.st.s['offers'].values():
            if o['state'] == 'open' and datetime.fromisoformat(o['at']).timestamp() < cutoff:
                o['state'] = 'lapsed'

    # Loops: the set-offs among the identities it holds, once the server has applied them.
    def loops(self, fetch=None):
        for name in list(self.st.s['profiles']):
            self.v.touch(name)
        fetch = fetch or (lambda: json.loads(urllib.request.urlopen(f'{SERVER}/pilot/v1/loops', timeout=30).read()))
        held = {name: p['x'] for name, p in self.st.s['profiles'].items()}
        for loop in fetch().get('loops') or []:
            if loop['id'] in self.st.s['loops_posted']:
                continue
            names = [m.get('handle') for m in loop.get('members') or []]
            if len(names) < 2 or not any(n in held for n in names):
                continue
            shown = [f'@{held[n]}' if n in held else str(n) for n in names]
            each = loop.get('each_PC')
            text = (f"Loop closed: {' → '.join(shown + shown[:1])}. "
                    + (f'{each} credit{"s" if each != 1 else ""} of promises cancelled' if each else 'Promises cancelled')
                    + f'. Nobody paid anyone. valun.tech/loop/{loop["id"]}')
            cost = COST['post_url']
            if self.st.room() < cost:
                return
            r = self.x.post(text)
            self.st.spend(cost)
            self.st.s['loops_posted'] = (self.st.s['loops_posted'] + [loop['id']])[-500:]
            self.log(action='loop_posted', loop=loop['id'], post=r.get('id'))
        self.st.save()


def keys_from_env():
    names = {'api_key': 'X_API_KEY', 'api_secret': 'X_API_SECRET', 'access_token': 'X_ACCESS_TOKEN', 'access_secret': 'X_ACCESS_SECRET'}
    keys = {k: os.environ.get(v, '') for k, v in names.items()}
    missing = [names[k] for k, v in keys.items() if not v]
    if missing:
        raise SystemExit(f'bind bot: missing {", ".join(missing)} (the OAuth 1.0a user keys of @{BOT})')
    return keys


def main():
    os.makedirs(HOME, exist_ok=True)
    state = State(os.path.join(HOME, 'bind-state.json'))
    bot = Bot(X(keys_from_env()), Valun(), state)
    bot.log(action='start', server=SERVER, monthly_usd=MONTHLY_USD, daily_usd=DAILY_USD, month_usd=state.s['month_usd'])
    last_loops = 0.0
    while True:
        try:
            bot.poll()
            if time.time() - last_loops > LOOP_EVERY_S and state.s['profiles']:
                last_loops = time.time()
                bot.loops()
        except XError as e:
            bot.log(action='x_error', status=e.status, error=str(e)[:300])
            if e.status in (401, 403):
                time.sleep(600)
        except Exception as e:  # noqa: BLE001 - logged, then the loop goes on
            bot.log(action='error', error=f'{type(e).__name__}: {str(e)[:300]}')
        time.sleep(POLL_S)


if __name__ == '__main__':
    main()
