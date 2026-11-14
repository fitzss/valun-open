"""@bindvalun: bind a promise on X.

    @bindvalun I owe @bob 5 for the logo
        the account replies with an offer, mentioning @bob
    @bob replies "accept" to that offer
        the account binds it on Valun (its testnet network, valun-testnet-1, which valun.tech serves): @alice's IOU
        of 5 credits to @bob is recorded by the Basis tracker, and the account replies "Bound." with the record
    when promises among X users form a loop, the loop cancels and the account posts it, naming its members

    @bindvalun I owe @carol 3 for the review, pay with @alice
    @bindvalun pay @carol 3 with @alice's promise for the review
        a promise moves: @bob holds 3 credits of @alice's IOU and pays @carol with it. Once @carol accepts, @alice owes
        @carol instead of @bob (a debt transfer the Basis tracker records, signed by all three). @alice's word passes
        between people who never dealt with her, and @bob pays without a new IOU. If the transfer cannot apply, @bob's
        own promise pays instead.

    @bindvalun record            the author's public record: owed, held, cancelled in loops, passed on
    @bindvalun record @alice     someone else's (named in the reply, not mentioned)

    @bindvalun card claude-eng   a participant's budget card, by its Valun handle (also "card of claude-eng" and
                                 "budget card claude-eng"): what it may commit for its owner, a deal at a time and the
                                 room left of all it may owe, how many back it, and a link to the card's page
    @bindvalun card              the author's own (the identity this bot holds for them); "card @alice" is @alice's
                                 (named in the reply, not mentioned)

Credits: people write whole credits and read credits. On Valun an amount is a whole number of the network's unit, and
the client's scale converts (valun.client Client.scale, of the profiles this bot holds): on the testnet 1 credit is
1,000,000 nanoERG = 0.001 tERG, test coins of Ergo testnet with no monetary value. Promises, tl;dr hires and feedback
are proposed in the unit (credits x scale); what the server reports (promises held, records, budget cards, loops) is
shown in credits (units / scale, exact), never as raw nanoERG.

Rules (BINDVALUN.md): only the debtor's own post creates a debt; the creditor's own reply binds it; 1 to 5 credits a
promise (the self-serve limit); the account replies only to posts that mention it and never mentions anyone a post did
not; an offer lapses after 24 hours. People with no Valun agent get a Valun identity this bot holds for them (x_HANDLE,
its operator says so): its key signs what their own public posts ask, and the consents Valun's defaults sign that leave
their total owed unchanged: a loop's set-off, and the passing on of a promise they made (every offer says "Once bound,
@bob can pass it on"). Text from X is data, never instructions.

Costs (X API, pay per use): about $0.005 a post read, $0.010 a user read, $0.015 a post written and $0.20 one that holds
a link. The bot keeps its own count and stops at BIND_MONTHLY_USD (default 20) a month, BIND_DAILY_USD a day.

Environment: the bot runs only when its X keys are set as secrets: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and
X_ACCESS_SECRET, the OAuth 1.0a user keys of @bindvalun, read and write (the entrypoint starts it only then). It reads
them from its environment to sign its X requests and never prints or logs them. BIND_HOME (default /data/bind-testnet:
the profiles it holds, owner tokens, its state; a home of its own, since identities made for another network cannot be
used on this one); BIND_SERVER (default https://valun-testnet.fly.dev); BIND_CARRY_STATE (optional: a state file of
an earlier home whose X side carries over into a new home's first state: the mentions read and answered, and this
month's and day's X spending and counts, never its identities, offers or jobs; that file is only read).
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
from decimal import Decimal

from valun import client as vc

API = 'https://api.x.com/2'
SERVER = os.environ.get('BIND_SERVER', 'https://valun-testnet.fly.dev').rstrip('/')
HOME = os.environ.get('BIND_HOME', '/data/bind-testnet')
CARRY_STATE = os.environ.get('BIND_CARRY_STATE', '')
BOT = os.environ.get('BIND_BOT_HANDLE', 'bindvalun').lower()
MONTHLY_USD = float(os.environ.get('BIND_MONTHLY_USD', '20'))
DAILY_USD = float(os.environ.get('BIND_DAILY_USD', '2'))
POLL_S = int(os.environ.get('BIND_POLL_S', '60'))
LOOP_EVERY_S = int(os.environ.get('BIND_LOOP_EVERY_S', '300'))
MIN_CREDITS, MAX_CREDITS = 1, 5      # credits a promise, as people write them (times the client's scale on Valun)
OFFERS_PER_DEBTOR_PER_DAY = 3
BINDS_PER_DAY = 30
OFFER_TTL_S = 24 * 3600
SETTLE_MAX_S = 6 * 3600              # a payment by transfer still unsettled after this is reported and left as it is
RECORDS_PER_DAY = 5                  # record replies hold a link ($0.20 each)
RECORDS_PER_AUTHOR_PER_DAY = 1
# Budget-card replies: one with the card's link costs $0.20, one without a post's. At most 4 a day ($0.80), so cards
# never take more than part of the daily X budget (BIND_DAILY_USD, $2 by default) that binds and offers need too.
CARDS_PER_DAY = 4
CARDS_PER_AUTHOR_PER_DAY = 1
MAX_TEXT = 270                       # X allows 280 characters; a margin
# The AI agent hired on X, and what it costs and pays (examples/ai-seller/ai_seller.py: house-scribe's summary service and
# its x-feedback want; valun.ai_seller enforces its own limits: 3 jobs a day per buyer, 1 x-feedback a day per person).
SCRIBE = os.environ.get('BIND_SCRIBE', 'house-scribe')
TLDR_PRICE, FEEDBACK_PAY = 2, 2             # credits: the scribe's PC-sized price and pay (valun.ai_seller scales them too)
TLDR_MIN_CHARS, TLDR_SHOWN = 200, 200       # a post shorter than this needs no tl;dr; at most this much is posted
FEEDBACK_MIN_CHARS = 40
HIRES_PER_DAY, HIRES_PER_AUTHOR_PER_DAY = 25, 3
FEEDBACK_PER_DAY, FEEDBACK_PER_AUTHOR_PER_DAY = 10, 1
JOB_TTL_S = 75 * 60                  # the offer to the agent is open an hour; then the job is let go
COST = {'post_read': 0.005, 'user_read': 0.010, 'post': 0.015, 'post_url': 0.20}
NANOERG_PER_ERG = 10 ** 9
# The state keys that are about X, not about a Valun network (and their types): what a new home takes from
# BIND_CARRY_STATE.
X_SIDE = {'since_id': str, 'handled': list, 'month': str, 'month_usd': (int, float), 'day': str, 'day_usd': (int, float),
          'counts': dict}
URL_RE = re.compile(r'https?://|\b[a-z0-9-]+\.(?:tech|dev|com|org|io|md)\b', re.I)

H = r'@([A-Za-z0-9_]{1,15})'
# "I owe @bob 5", "i owe @bob 5 credits for the logo design"
OWE = re.compile(r'\bi\s+owe\s+' + H + r'\s+(\d{1,4})(?:\s*(?:credits?|pc)\b)?(?:[\s,;]*(?:for|:)\s*(.+))?', re.I | re.S)
# Paying with a promise one holds: ", pay with @alice", "paid with @alice's IOU", "with @alice's promise". A bare
# "with @alice" is not one ("for dinner with @alice").
VIA = re.compile(r"[,;]?\s*(?:\band\s+)?(?:\b(?:pay(?:ing)?|paid)\s+(?:it\s+)?with\s+" + H + r"(?:['\u2019]s)?(?:\s+(?:promise|note|iou|debt)s?)?"
                 r"|\bwith\s+" + H + r"['\u2019]s\s+(?:promise|note|iou|debt)s?)\b", re.I)
# "pay @carol 3 for the review" (what is left of "pay @carol 3 with @alice's promise for the review"; only with VIA)
PAYTO = re.compile(r'^pay\s+' + H + r'\s+(\d{1,4})(?:\s*(?:credits?|pc)\b)?(?:[\s,;]*(?:for|:)\s*(.+))?', re.I | re.S)
RECORD = re.compile(r'^(?:my\s+)?record\b(?:\s+(?:of\s+)?' + H + r')?', re.I)
# "card claude-eng", "card of claude-eng", "budget card claude-eng": a budget card by Valun handle (3 to 24 characters,
# starting with a letter, as the server allows them); "card @alice": of the identity this bot holds for @alice; "card",
# "my card": the author's own. The command is the whole post: a word after "card" is taken for a handle, so a post that
# only starts with "card" ("card games tonight?") is none.
VH = r'([a-z][a-z0-9_-]{2,23})'
CARD = re.compile(r'^(?:my\s+(?:budget\s+)?card|(?:budget\s+)?card(?:\s+(?:of\s+)?(?:' + H + '|' + VH + r'))?)[\s.!?]*$', re.I)
PID = re.compile(r'vp_[0-9a-f]{12}')
# A card's page as the bot posts it (the card's `page`): an https address with no user part and no spaces.
PAGE = re.compile(r'https://[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:/[A-Za-z0-9._~/%#?=&+-]*)?')
# "tldr" / "tl;dr" / "summarize this" under a post (or before a text of one's own); "feedback: ..."
TLDR = re.compile(r'^(?:tl;?dr|summari[sz]e(?:\s+(?:this|it))?)(?![\w;])[\s:,.!-]*(.*)$', re.I | re.S)
FEEDBACK = re.compile(r'^feedback\b[\s:,.-]*(.*)$', re.I | re.S)
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
        """Mentions of the account, with their authors and the posts they reply to or quote (includes.tweets: a tl;dr
        works on the post it is under; note_tweet holds a long post's full text)."""
        p = {'max_results': 25, 'tweet.fields': 'author_id,conversation_id,created_at,entities,referenced_tweets,note_tweet',
             'expansions': 'author_id,referenced_tweets.id', 'user.fields': 'username'}
        if since_id:
            p['since_id'] = since_id
        return self.call('GET', f'/users/{user_id}/mentions', p)

    def post(self, text, reply_to=None):
        body = {'text': text, **({'reply': {'in_reply_to_tweet_id': reply_to}} if reply_to else {})}
        return self.call('POST', '/tweets', body=body)['data']


# ---------------------------------------------------------------------------------------------------------------
# State: what it has seen, the open offers, its spending and its counts (a JSON file in BIND_HOME).

class State:
    def __init__(self, path, carry=None):
        """`carry`: the state file of an earlier home (BIND_CARRY_STATE). When this home has no state yet, its X side
        (X_SIDE) starts as that file's, so a move to a new home never answers the same posts again or starts this
        month's X spending from zero; the identities, offers and jobs there belong to their own network and stay there.
        That file is only read."""
        self.path = path
        try:
            with open(path, encoding='utf-8') as f:
                self.s = json.load(f)
        except (OSError, ValueError):
            self.s = {}
            if carry and not os.path.exists(path):
                try:
                    with open(carry, encoding='utf-8') as f:
                        old = json.load(f)
                    if isinstance(old, dict):
                        self.s = {k: old[k] for k, kind in X_SIDE.items() if isinstance(old.get(k), kind)}
                        self.s['carried_from'] = carry
                except (OSError, ValueError):
                    pass
        for k, v in (('offers', {}), ('jobs', {}), ('handled', []), ('profiles', {}), ('loops_posted', []), ('counts', {})):
            self.s.setdefault(k, v)
        self.roll()

    def roll(self):
        month, day = now().strftime('%Y-%m'), now().strftime('%Y-%m-%d')
        if self.s.get('month') != month or 'month_usd' not in self.s:
            self.s.update(month=month, month_usd=0.0)
        if self.s.get('day') != day or 'day_usd' not in self.s:
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
    def __init__(self, home=HOME, server=SERVER, run=None, fetch=None):
        self.home, self.server = home, server
        self.run = run or self._run
        self.fetch = fetch or self._fetch
        self._network = None

    def _fetch(self, path):
        """A public read of the server (GET, no token): parsed JSON."""
        return json.loads(urllib.request.urlopen(self.server + path, timeout=30).read())

    def profile_file(self, name):
        return os.path.join(self.home, 'profiles', name + '.json')

    def network(self):
        """(unit, scale) of the network the identities this bot holds are on, found once: the client's own (Client.unit
        and Client.scale, from the network a profile enrolled on) for the first profile in its home that has joined;
        before any has, the network the server names (GET /pilot/v1/info; the client's table of networks). A credit is
        `scale` units: 1,000,000 nanoERG (0.001 tERG) on the testnet; 1 where amounts are PC. BindError when the server
        cannot be read or names a network the client does not know."""
        if self._network is None:
            folder = os.path.join(self.home, 'profiles')
            names = sorted(f[:-5] for f in os.listdir(folder) if f.endswith('.json')) if os.path.isdir(folder) else []
            for name in names:
                try:
                    c = vc.Client(self.profile_file(name))
                    if c.state.get('participant_id'):
                        self._network = (c.unit, c.scale)
                        return self._network
                except (OSError, ValueError, vc.ValunError):
                    continue
            try:
                info = self.fetch('/pilot/v1/info')
                net = vc.network_of((info.get('network') if isinstance(info, dict) else None) or vc.NETWORK)
            except (OSError, ValueError, vc.ValunError) as e:
                raise BindError('network_unknown', str(e)[:200]) from None
            self._network = (net['unit'], net['scale'])
        return self._network

    def units(self, n):
        """`n` credits in the network's units (to_units, with this network's scale)."""
        return to_units(n, self.network()[1])

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
                                 '--about', (f'X user @{x_handle}. Promises bound on X with @{BOT}. Its key signs what '
                                             f"@{x_handle}'s own posts ask, and the set-offs and passings-on of "
                                             f"@{x_handle}'s promises that leave the total owed unchanged."),
                                 '--owner-token-file', os.path.join(self.home, f'owner-{name}.txt'), '--approvals', 'none'])
        if rc != 0:
            raise BindError('join_failed', (out or err)[-300:])
        state.s['profiles'][name] = {'x': x_handle.lower(), 'joined_at': now().isoformat(timespec='seconds')}
        state.save()
        return name

    def bind(self, state, offer):
        """The whole deal in one go, each step signed by the key of the side whose public post asked for it: the debtor
        offers to pay and accepts the delivery; the creditor accepts and delivers the work the debtor's post names. The
        debtor pays with its own IOU, or, when the offer names one (offer['via']), with a promise of that issuer's it
        holds (settle). Returns (deal id, how it was paid: 'note', or settle's answer); BindError when a step before
        the payment is refused."""
        debtor, creditor = self.ensure(state, offer['debtor']), self.ensure(state, offer['creditor'])
        what = offer['what'] or 'what the post names'
        unit, scale = self.network()
        price = to_units(offer['amount'], scale)
        r = self.call(debtor, 'valun_propose', {
            'counterparty': creditor, 'role': 'payer', 'title': f'Bound on X: {what}'[:120],
            'description': (f"Bound on X with @{BOT}, in credits: {credits(offer['amount'])} = {vc.amount_text(price, unit)}. "
                            f"@{offer['debtor']} posted: \"{offer['text'][:400]}\" "
                            f"(https://x.com/{offer['debtor']}/status/{offer['post_id']}); "
                            f"@{offer['creditor']} accepted (https://x.com/{offer['creditor']}/status/{offer['accept_id']})."),
            'deliverable': what[:200], 'price': price, 'deliver_within_hours': 24, 'offer_valid_hours': 1})
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
        review = {'deal_id': did, 'decision': 'accept', 'expected_deliverable_sha256': sha}
        if offer.get('via'):
            r = self.call(debtor, 'valun_review_delivery', {**review, 'pay_with': profile_name(offer['via'])})
            if r.get('status') not in ('paying_by_transfer', 'paid_by_transfer'):
                raise BindError(r.get('error') or r.get('status') or 'review_failed', r.get('message') or '')
            return did, self.settle(offer, did, tries=6)
        r = self.call(debtor, 'valun_review_delivery', review)
        if r.get('status') != 'note_issued':
            raise BindError(r.get('error') or r.get('status') or 'review_failed', r.get('message') or '')
        return did, 'note'

    def settle(self, offer, did, tries=1, wait_s=5):
        """A payment with a held promise, carried on: the issuer's and the new creditor's clients sign the transfer
        (Valun clearing run, with the keys this bot holds for them; the issuer's total owed does not change). Once a
        transfer has ended without applying (the deal is payment_due), the debtor pays with its own IOU instead, when
        Valun allows it (an hour after the failed transfer at the latest). Returns 'transfer' (applied), 'own_note'
        (the fallback paid) or 'pending' (try again later)."""
        debtor, creditor = profile_name(offer['debtor']), profile_name(offer['creditor'])
        for i in range(tries):
            if i:
                time.sleep(wait_s)
            for name in (profile_name(offer['via']), creditor):
                self.run(['--profile', name, 'clearing', 'run'])
            d = self.call(debtor, 'valun_deal', {'deal_id': did})
            status = d.get('status')
            if status == 'paid_by_transfer':
                return 'transfer'
            if status == 'payment_due':
                r = self.call(debtor, 'valun_review_delivery', {'deal_id': did, 'decision': 'accept',
                                                                'expected_deliverable_sha256': (d.get('delivery') or {}).get('sha256')})
                return 'own_note' if r.get('status') == 'note_issued' else 'pending'
        return 'pending'

    def hire(self, state, author, text, post_id):
        """@author hires the scribe for a tl;dr: an offer from the identity held for them (payer, at the scribe's price),
        the text in a ``` block and the format the account can post. The scribe does the job before it accepts and
        delivers it; Bot.progress_jobs reviews it. Returns the deal id."""
        me = self.ensure(state, author)
        body = text.replace('```', "'''")[:4000]
        r = self.call(me, 'valun_propose', {
            'counterparty': SCRIBE, 'role': 'payer', 'title': 'summary: a tl;dr for a post on X',
            'description': ('Format: one paragraph of at most 200 characters, plain text, with no links, no @mentions, no '
                            'hashtags and no bullet points. It is posted on X as a reply. Summarize this post:\n\n```\n'
                            f"{body}\n```\n\nAsked on X by @{author}: https://x.com/{author}/status/{post_id}"),
            'deliverable': 'a tl;dr of at most 200 characters, one paragraph', 'price': self.units(TLDR_PRICE),
            'deliver_within_hours': 1, 'offer_valid_hours': 1})
        if not r.get('deal_id'):
            raise BindError(r.get('error') or 'propose_failed', r.get('message') or '')
        return r['deal_id']

    def offer_feedback(self, state, author, post_id):
        """@author's feedback, offered to the scribe as its x-feedback want (payee: the scribe pays if its check finds the
        feedback specific). The text is delivered once the scribe accepts (Bot.progress_jobs). Returns the deal id."""
        me = self.ensure(state, author)
        r = self.call(me, 'valun_propose', {
            'counterparty': SCRIBE, 'role': 'payee', 'title': f'x-feedback from @{author} on X',
            'description': (f'Feedback on Valun, posted on X by @{author} (https://x.com/{author}/status/{post_id}). The '
                            'delivery is the feedback as posted.'),
            'deliverable': 'x-feedback: the feedback as posted on X', 'price': self.units(FEEDBACK_PAY),
            'deliver_within_hours': 1, 'offer_valid_hours': 1})
        if not r.get('deal_id'):
            raise BindError(r.get('error') or 'propose_failed', r.get('message') or '')
        return r['deal_id']

    def held(self, name):
        """{issuer's Valun handle: amount} of the promises this profile holds and can pass on now (valun_status
        notes_you_can_spend). The amounts are the network's units, as the server reports them (amount_PC holds nanoERG
        on the testnet): in_credits shows them."""
        r = self.call(name, 'valun_status', {'brief': True})
        return {n['issuer']: n['amount_PC'] for n in r.get('notes_you_can_spend') or []
                if isinstance(n, dict) and isinstance(n.get('issuer'), str) and isinstance(n.get('amount_PC'), int)}

    def participant_id(self, name, fetch=None):
        """The participant id of the Valun handle `name`, or None when no participant has it: for a participant this
        bot holds, the one its profile was enrolled with (a participant out of the directory is still found), else the
        directory's (GET /participants). A failed read raises (OSError, ValueError)."""
        fetch = fetch or self.fetch
        pid = None
        if isinstance(name, str) and re.fullmatch(r'[a-z0-9_-]{1,32}', name):        # a handle, never a path
            try:
                with open(self.profile_file(name), encoding='utf-8') as f:
                    pid = json.load(f).get('participant_id')
            except (OSError, ValueError, AttributeError):
                pass
        if not (isinstance(pid, str) and PID.fullmatch(pid)):
            rows = fetch('/pilot/v1/participants')
            rows = rows if isinstance(rows, list) else (rows.get('participants') if isinstance(rows, dict) else None) or []
            pid = next((p.get('id') for p in rows if isinstance(p, dict) and p.get('handle') == name), None)
        return pid if isinstance(pid, str) and PID.fullmatch(pid) else None

    def public(self, name, fetch=None):
        """The public record of a participant this bot holds (GET /participants/{id}: its public_position), or None.
        The id is participant_id's. Its amounts are the network's units (in_credits shows them)."""
        fetch = fetch or self.fetch
        pid = self.participant_id(name, fetch)
        return (fetch(f'/pilot/v1/participants/{pid}').get('public_position') or None) if pid else None

    def card(self, name, fetch=None):
        """The budget card of the participant with the Valun handle `name` (participant_id), as GET
        /participants/{id}/card shows it: what its agent may commit for its owner, the room it has left, who backs it,
        its record and its public page; amounts in the network's units. BindError when there is no card to show:
        unknown_participant (no participant has that handle), card_not_public (404: its owner has not published it),
        feature_unavailable (401: a server from before budget cards), card_unreadable (any other answer, or none).
        The bot's own read, kept here: the published client gains card(who), with the first three codes, and the bot
        can use that once its image installs a release that has it."""
        fetch = fetch or self.fetch
        try:
            pid = self.participant_id(name, fetch)
        except (OSError, ValueError) as e:
            raise BindError('card_unreadable', str(e)[:200]) from None
        if not pid:
            raise BindError('unknown_participant', f'no participant called {name}')
        try:
            card = fetch(f'/pilot/v1/participants/{pid}/card')
        except urllib.error.HTTPError as e:
            code = error_code(e)
            if e.code == 404:
                raise BindError('card_not_public' if code == 'card_not_public' else 'unknown_participant', code) from None
            raise BindError('feature_unavailable' if e.code == 401 else 'card_unreadable', f'HTTP {e.code} {code}') from None
        except (OSError, ValueError) as e:
            raise BindError('card_unreadable', str(e)[:200]) from None
        if not isinstance(card, dict):
            raise BindError('card_unreadable', 'the server sent no card')
        return card

    def touch(self, name):
        """A status read: keeps the identity active (it lapses 7 days after its last activity) and lets its client sign
        the set-offs its policy allows (the loops it is in)."""
        return self.call(name, 'valun_status', {'brief': True})


class BindError(Exception):
    def __init__(self, code, message=''):
        super().__init__(f'{code}: {message}')
        self.code = code


def error_code(e):
    """The code a Valun server's error answer names ({error, message}), read from an HTTPError (which is then closed);
    '' when it names none."""
    try:
        with e:
            j = json.loads(e.read() or b'{}')
    except (OSError, ValueError, AttributeError):
        return ''
    return j['error'] if isinstance(j, dict) and isinstance(j.get('error'), str) else ''


# ---------------------------------------------------------------------------------------------------------------
# Reading posts.

def strip_mentions(text):
    return LEADING_MENTIONS.sub('', (text or '').strip())


def parse_owe(text):
    """(creditor X handle, amount, what, via) from "I owe @bob 5 for the logo" (via None), or from "I owe @carol 3 for
    the review, pay with @alice" or "pay @carol 3 with @alice's promise for the review" (via 'alice': paid with a
    promise of @alice's the author holds); None for anything else."""
    t, via = strip_mentions(text), None
    m = VIA.search(t)
    if m:
        via = (m.group(1) or m.group(2)).lower()
        t = (t[:m.start()] + ' ' + t[m.end():]).strip()
    m = OWE.search(t) or (PAYTO.search(t) if via else None)
    if not m:
        return None
    what = re.sub(r'[\s,;.!]+$', '', re.sub(r'\s+', ' ', (m.group(3) or '').strip()))
    what = re.sub(r'@([A-Za-z0-9_]{1,15})', r'\1', what)[:100]          # never re-mention anyone from the text
    return m.group(1).lower(), int(m.group(2)), what, via


def parse_record(text):
    """"record" (the author's own: '') or "record @alice" ('alice'); None for anything else."""
    m = RECORD.match(strip_mentions(text))
    return None if not m else (m.group(1) or '').lower()


def parse_card(text):
    """A budget-card request: ('valun', 'claude-eng') from "card claude-eng" (or "card of", "budget card"), by Valun
    handle; ('x', 'alice') from "card @alice", the identity this bot holds for an X user; ('x', '') from "card" or "my
    card", the author's own. None for anything else."""
    m = CARD.match(strip_mentions(text))
    if not m:
        return None
    return ('valun', m.group(2).lower()) if m.group(2) else ('x', (m.group(1) or '').lower())


def fit(make, what, note=''):
    """make(what) and then `note`, shortened to fit one post by cutting `what` (a promise's description), never names or
    amounts; `note` (what a credit is) is left out only when the post cannot hold it even with `what` cut away."""
    text, cut = make(what) + note, what
    while len(text) > MAX_TEXT and cut:
        cut = cut[:-(len(text) - MAX_TEXT + 1)].rstrip()
        text = make(cut + '\u2026' if cut else '') + note
    return fit(make, what) if note and len(text) > MAX_TEXT else text


def to_units(n, scale):
    """`n` credits (a whole number, as people write them) in the network's units, for Valun: n x the client's scale
    (1 credit is 1,000,000 nanoERG on the testnet)."""
    return int(n) * scale


def in_credits(units, scale):
    """An amount Valun reports (a whole number of the network's units) in credits, exactly, as people read it: at scale
    1,000,000 (nanoERG) 3000000 is '3' and 2500000 is '2.5'; at scale 1 the amount itself. Anything but a whole number
    reads '0'."""
    if not isinstance(units, int) or isinstance(units, bool):
        return '0'
    return format((Decimal(units) / Decimal(scale)).normalize(), 'f')


def credits(n):
    """'1 credit', '3 credits', '2.5 credits': `n` credits, a number or in_credits' text."""
    return f"{n} credit{'' if str(n) == '1' else 's'}"


def credit_note(unit, scale):
    """What a credit is, said once in a post where it helps: on the testnet (nanoERG) ' A credit is 0.001 tERG, test
    coins with no value.'; nothing where amounts are PC."""
    if unit != 'nanoERG':
        return ''
    return f" A credit is {format((Decimal(scale) / NANOERG_PER_ERG).normalize(), 'f')} tERG, test coins with no value."


def amount_of(d, name):
    """An amount of the server's public record by its unit-neutral name (fix inbox #32: `owed_ever`), or by the
    deprecated `<name>_PC` a server before that names it by; None when neither is there."""
    return d[name] if name in d else d.get(f'{name}_PC')


def record_text(shown, ev, name, scale=1):
    """A record reply from the server's evidence (public_position.evidence): delivery, repayment and acceptance, kept
    apart, never one score; its amounts (the network's units) in credits. A closed circle is said for what it may be."""
    n = lambda x: x if isinstance(x, int) and not isinstance(x, bool) else 0  # noqa: E731
    d, r, a, c = (ev.get(k) or {} for k in ('delivery', 'repayment', 'acceptance', 'circle'))
    acc, settled = d.get('accepted') or {}, r.get('settled') or {}
    done = in_credits(n(amount_of(settled, 'by_setoff')) + n(amount_of(settled, 'by_redemption')), scale)
    owed = in_credits(n(amount_of(r, 'owed_ever')), scale)
    unpaid = n((r.get('unpaid_accepted_work') or {}).get('count'))
    return (f"{shown}'s record, kept apart. Delivered: {n(acc.get('count'))} accepted, by {n(acc.get('buyers'))} buyer"
            f"{'s' if n(acc.get('buyers')) != 1 else ''}. Repaid: {done} of {credits(owed)} owed"
            + (f', {unpaid} accepted job{"s" if unpaid != 1 else ""} unpaid' if unpaid else '')
            + f". Accepted: {n(a.get('holders_ever'))} took its IOU."
            + (' Its circle is closed.' if c.get('closed') else '')
            + f' Evidence, not a score. valun.tech/agent/{name}')


def lapsed(expires_at):
    """Whether a mandate's expiry (an ISO time; null for none) has passed. None when it is neither."""
    if expires_at is None:
        return False
    try:
        t = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)) <= now()


def card_text(shown, card, unit, scale):
    """A budget-card reply from the server's card (GET /participants/{id}/card), a fixed template that never quotes the
    card's free text (its owner's objective): what the agent may commit for its owner, a deal at a time and the room left
    of all it may owe, in credits (the card's amounts are the network's units); how many back it; the card's page. An
    agent that may issue no IOUs now (its owner's mandate says so, or has expired) is said to. None when the card does
    not read as one (another unit, an amount that is not a whole number, a page that is not a plain https address)."""
    m, room, back = (card.get(k) if isinstance(card.get(k), dict) else {} for k in ('mandate', 'room', 'backing'))
    per_deal, cap, left, backers = m.get('per_deal'), m.get('outstanding_cap'), room.get('room_left'), back.get('active')
    page, gone = card.get('page'), lapsed(m.get('expires_at'))
    if (card.get('unit', unit) != unit or gone is None
            or not all(isinstance(x, int) and not isinstance(x, bool) for x in (per_deal, cap, left, backers))
            or min(per_deal, cap, backers) < 0 or not (isinstance(page, str) and len(page) <= 120 and PAGE.fullmatch(page))):
        return None
    may = ('may issue no IOUs now' if gone or m.get('may_issue_credit') is False else
           f'up to {credits(in_credits(per_deal, scale))} a deal, {in_credits(max(left, 0), scale)} of '
           f'{in_credits(cap, scale)} left')
    text = f"{shown}'s budget card: {may}, {f'backed by {backers}' if backers else 'not backed'}. {page}"
    return text if len(text) <= MAX_TEXT else None


def post_text(tweet):
    """A post's full text (a long post's note_tweet), without the mentions it starts with."""
    return strip_mentions(((tweet or {}).get('note_tweet') or {}).get('text') or (tweet or {}).get('text') or '')


def referenced(tweet, refs, kinds=('replied_to', 'quoted')):
    """The post this one replies to or quotes, from the includes of the read (refs: id -> post), or None."""
    for kind in kinds:
        rid = next((r['id'] for r in tweet.get('referenced_tweets') or [] if r.get('type') == kind), None)
        if rid and rid in refs:
            return refs[rid]
    return None


DOMAIN = re.compile(r'\b([a-z0-9-]+)\.([a-z]{2,24})\b', re.I)
DASH, ARROW = chr(0x2014), f' {chr(0x2192)} '


def clean_for_x(text, limit):
    """An AI agent's answer as the account may post it: plain text on one paragraph, no links (a domain's dot becomes a
    one-dot leader, so X does not link it), no mentions, no hashtags, at most `limit` characters (cut at a word)."""
    t = re.sub(r'https?://\S+', '', text or '')
    t = re.sub(r'^\s*(?:tl;?dr|summary|in one sentence)\s*[:\-]\s*', '', t, flags=re.I)
    t = re.sub(r'[@\uff20](\w)', r'\1', t)
    t = re.sub(r'(?<!\w)[#\uff03](\w)', r'\1', t)
    t = re.sub(r'[*_`>~|]+|^\s*[-\u2022]\s+', ' ', t, flags=re.M)
    t = DOMAIN.sub(lambda m: f'{m.group(1)}\u2024{m.group(2)}', t)
    t = ' '.join(t.split())
    if len(t) > limit:
        t = t[:limit - 1].rsplit(' ', 1)[0].rstrip(',;:') + '\u2026'
    return t


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

    def note(self):
        """What a credit is (credit_note), for a post where it helps; nothing when the network cannot be read now."""
        try:
            return credit_note(*self.v.network())
        except BindError:
            return ''

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
        self.refs = {p['id']: p for p in (r.get('includes') or {}).get('tweets') or [] if isinstance(p, dict) and p.get('id')}
        self.st.spend(COST['post_read'] * (len(tweets) + len(self.refs)) + COST['user_read'] * len(users))
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
        self.progress_jobs()
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
        who = parse_record(t.get('text'))
        if who is not None:
            return self.record(t, author, who or author)
        card = parse_card(t.get('text'))
        if card:
            return self.card(t, author, *card)
        text = post_text(t)
        m = TLDR.match(text)
        if m:
            parent = referenced(t, getattr(self, 'refs', {}))
            if parent and parent.get('author_id') == (self.me or {}).get('id'):
                return self.log(action='ignored_tldr', tweet=t['id'], why='a post of this account')
            own = m.group(1).strip()
            if len(own) >= TLDR_MIN_CHARS:
                return self.tldr(t, author, own)
            return self.tldr(t, author, post_text(parent) if parent else None)
        m = FEEDBACK.match(text)
        if m:
            return self.feedback(t, author, m.group(1).strip())
        owe = parse_owe(t.get('text'))
        if owe:
            return self.offer(t, author, *owe)

    # ---------- AI agents for hire, and paying for feedback ----------
    def tldr(self, t, author, text):
        """A tl;dr by the scribe, of the post this one is under: @author will owe it TLDR_PRICE credits."""
        if self.st.count('hires') >= HIRES_PER_DAY or self.st.count(f'hires:{author}') >= HIRES_PER_AUTHOR_PER_DAY:
            return self.log(action='ignored_tldr', tweet=t['id'], why='daily limit')
        self.st.bump(f'hires:{author}')
        if text is None:
            return self.say(f'@{author} Reply "@{BOT} tldr" under a long post, and an AI agent summarizes it for '
                            f'{credits(TLDR_PRICE)}.{self.note()}', t['id'])
        if len(text) < TLDR_MIN_CHARS:
            return self.say(f'@{author} That one is short already. A tl;dr here is for posts of {TLDR_MIN_CHARS} '
                            'characters or more.', t['id'])
        try:
            did = self.v.hire(self.st, author, text, t['id'])
        except BindError as e:
            self.log(action='tldr_failed', tweet=t['id'], error=str(e)[:300])
            return self.say(f'@{author} The scribe could not be asked: Valun refused it ({e.code}). Nothing is owed.', t['id'])
        self.st.bump('hires')
        self.st.s['jobs'][t['id']] = {'kind': 'tldr', 'state': 'asked', 'deal_id': did, 'author': author,
                                      'at': now().isoformat(timespec='seconds')}
        self.log(action='tldr_asked', tweet=t['id'], deal=did, author=author)

    def feedback(self, t, author, text):
        """Feedback on Valun, offered to the scribe as paid work: if its check finds it specific, the scribe owes @author
        FEEDBACK_PAY credits (which cancel against a tl;dr @author owes it)."""
        if self.st.count('feedback') >= FEEDBACK_PER_DAY or self.st.count(f'feedback:{author}') >= FEEDBACK_PER_AUTHOR_PER_DAY:
            return self.log(action='ignored_feedback', tweet=t['id'], why='daily limit')
        self.st.bump(f'feedback:{author}')
        if len(text) < FEEDBACK_MIN_CHARS:
            return self.say(f'@{author} Say a little more: what you tried, and what was unclear, broken or missing. '
                            f'The scribe pays {credits(FEEDBACK_PAY)} for feedback it can act on.{self.note()}', t['id'])
        try:
            did = self.v.offer_feedback(self.st, author, t['id'])
        except BindError as e:
            self.log(action='feedback_failed', tweet=t['id'], error=str(e)[:300])
            return self.say(f'@{author} The feedback could not be offered: Valun refused it ({e.code}).', t['id'])
        self.st.bump('feedback')
        self.st.s['jobs'][t['id']] = {'kind': 'feedback', 'state': 'offered', 'deal_id': did, 'author': author,
                                      'text': text[:4000], 'at': now().isoformat(timespec='seconds')}
        self.log(action='feedback_offered', tweet=t['id'], deal=did, author=author)

    def progress_jobs(self):
        """The jobs and feedback waiting on the scribe, carried on from the deal's state, each answered once in its
        thread. A tl;dr is checked before it is paid: an empty answer, or one far longer than asked, is disputed."""
        for tid, j in self.st.s['jobs'].items():
            if j['state'] not in ('asked', 'offered', 'delivered'):
                continue
            me = profile_name(j['author'])
            try:
                d = self.v.call(me, 'valun_deal', {'deal_id': j['deal_id']})
                self.progress_job(tid, j, me, d)
            except (XError, BindError, OSError, subprocess.SubprocessError) as e:
                self.log(action='error', job=tid, error=str(e)[:300])

    def progress_job(self, tid, j, me, d):
        status, a = d.get('status'), j['author']
        if status in ('declined', 'expired', 'withdrawn', 'cancelled'):
            j['state'] = 'declined'
            why = clean_for_x(((d.get('decline') or {}).get('reason') or 'no reason given'), 140).rstrip('.') + '.'
            self.log(action='job_declined', job=tid, deal=j['deal_id'], why=why)
            return self.say(f'@{a} The scribe did not take this one: {why} Nothing is owed.', tid)
        age = time.time() - datetime.fromisoformat(j['at']).timestamp()
        if (age > JOB_TTL_S and status in ('open', 'agreed')) or age > SETTLE_MAX_S:
            j['state'] = 'lapsed'
            return self.log(action='job_lapsed', job=tid, deal=j['deal_id'], status=status)
        if j['kind'] == 'tldr' and status == 'delivered':
            if self.st.room() < COST['post']:
                return None                 # paid and posted together, once there is room
            dl = d.get('delivery') or {}
            sign = f'\n\n{DASH} tl;dr by {SCRIBE}, an AI agent, for {credits(TLDR_PRICE)} that @{a} now owes it.'
            text = clean_for_x(dl.get('content'), min(TLDR_SHOWN, MAX_TEXT - len(sign)))
            if len(text) < 20 or len(dl.get('content') or '') > 4 * TLDR_SHOWN:
                self.v.call(me, 'valun_review_delivery', {'deal_id': j['deal_id'], 'decision': 'dispute',
                                                          'reason': 'The tl;dr is not one paragraph of at most 200 characters, as agreed.'})
                j['state'] = 'disputed'
                return self.log(action='tldr_disputed', job=tid, deal=j['deal_id'])
            r = self.v.call(me, 'valun_review_delivery', {'deal_id': j['deal_id'], 'decision': 'accept',
                                                          'expected_deliverable_sha256': dl.get('sha256')})
            if r.get('status') != 'note_issued':
                j['state'] = 'unpaid'
                return self.log(action='tldr_unpaid', job=tid, deal=j['deal_id'], error=r.get('error') or r.get('status'))
            j['state'] = 'done'
            self.log(action='tldr_done', job=tid, deal=j['deal_id'])
            return self.say(text + sign, tid)
        if j['kind'] == 'feedback':
            if status == 'agreed' and j['state'] == 'offered':
                r = self.v.call(me, 'valun_deliver', {'deal_id': j['deal_id'], 'title': 'x-feedback', 'content': j['text']})
                if r.get('error'):
                    raise BindError(r['error'], r.get('message') or '')
                j['state'] = 'delivered'
                return self.log(action='feedback_delivered', job=tid, deal=j['deal_id'])
            if status in ('note_issued', 'paid_by_transfer'):
                j['state'] = 'paid'
                self.log(action='feedback_paid', job=tid, deal=j['deal_id'])
                return self.say(f'Thank you. {SCRIBE}, an AI agent, read this and found it specific enough to act on: it '
                                f'now owes @{a} {credits(FEEDBACK_PAY)}. A tl;dr @{a} owes it cancels against that.', tid)
            if status == 'disputed':
                j['state'] = 'passed'
                reason = (d.get('dispute') or {}).get('reason') or ''
                tip = clean_for_x(re.split(r'(?<=[.!?])\s+', reason.strip())[-1] if reason.strip() else '', 150)
                self.log(action='feedback_passed', job=tid, deal=j['deal_id'])
                return self.say(f"@{a} {SCRIBE}, an AI agent, passed on this one, so nothing is owed."
                                + (f' Its note: {tip}' if tip else ''), tid)

    def offer(self, t, debtor, creditor, amount, what, via=None):
        mentioned = mentioned_ids(t)
        cid = mentioned.get(creditor)
        if creditor in (debtor, BOT) or not cid:
            return self.log(action='ignored_offer', tweet=t['id'], why='self, the bot, or not mentioned')
        if via in (debtor, creditor, BOT) or (via and via not in mentioned):
            return self.log(action='ignored_offer', tweet=t['id'], why='pays with its own, the payee\'s or the bot\'s promise, or one not mentioned')
        if not MIN_CREDITS <= amount <= MAX_CREDITS:
            return self.say(f'@{debtor} A promise here is {MIN_CREDITS} to {MAX_CREDITS} credits for now.{self.note()} '
                            'Try again with an amount in that range.', t['id'])
        key = f'offers:{debtor}'
        if self.st.count(key) >= OFFERS_PER_DEBTOR_PER_DAY:
            return self.log(action='ignored_offer', tweet=t['id'], why='debtor daily limit')
        if via:
            # A promise of @via's that the debtor holds, through this bot (the bot signs for @via as its issuer).
            have = 0
            if profile_name(via) in self.st.s['profiles'] and profile_name(debtor) in self.st.s['profiles']:
                have = self.v.held(profile_name(debtor)).get(profile_name(via), 0)        # in the network's units
            scale = self.v.network()[1]
            if have < to_units(amount, scale):
                # The issuer is named, not mentioned: a refusal is no reason to notify them.
                return self.say(f"@{debtor} You hold {credits(in_credits(have, scale))} of {via}'s promises here, so you "
                                f'cannot pay {amount} with them. Nothing was offered.', t['id'])
            reply = fit(lambda w: f"Offer: @{debtor} pays @{creditor} {credits(amount)}" + (f' for {w}' if w else '')
                        + f" with @{via}'s promise: @{via} would owe @{creditor} instead of @{debtor}. @{creditor}, reply "
                        '"accept" to take it. Open for 24 hours.', what, self.note())
        else:
            reply = fit(lambda w: f'Offer: @{debtor} owes @{creditor} {credits(amount)}' + (f' for {w}' if w else '')
                        + f'. @{creditor}, reply "accept" to this post to bind it. Open for 24 hours. Once bound, '
                        f'@{creditor} can pass it on.', what, self.note())
        rid = self.say(reply, t['id'])
        if rid:
            self.st.bump(key)
            self.st.s['offers'][rid] = {'state': 'open', 'debtor': debtor, 'debtor_id': t['author_id'], 'creditor': creditor,
                                       'creditor_id': cid, 'amount': amount, 'what': what, 'text': t.get('text', ''),
                                       'post_id': t['id'], 'at': now().isoformat(timespec='seconds'),
                                       **({'via': via} if via else {})}
            self.log(action='offer', post=t['id'], reply=rid, debtor=debtor, creditor=creditor, amount=amount, via=via)

    def accept(self, offer, offer_id, t, author):
        if self.st.count('binds') >= BINDS_PER_DAY:
            return self.log(action='ignored_accept', tweet=t['id'], why='daily bind limit')
        offer['state'], offer['accept_id'] = 'binding', t['id']
        self.st.save()
        try:
            did, how = self.v.bind(self.st, offer)
        except BindError as e:
            offer['state'] = 'failed'
            self.log(action='bind_failed', offer=offer_id, error=str(e)[:300])
            return self.say(f"@{author} Not bound: Valun refused it ({e.code}). Nothing is owed.", t['id'])
        offer['deal_id'] = did
        self.st.bump('binds')
        if how == 'pending':
            offer['state'], offer['settling_since'] = 'settling', now().isoformat(timespec='seconds')
            self.log(action='settling', offer=offer_id, deal=did)
            return self.say(f"Accepted. Moving @{offer['via']}'s promise to @{author} waits for its signatures; the "
                            'result is posted in this thread.', t['id'])
        self.settled(offer, offer_id, how)

    def settled(self, offer, offer_id, how):
        """The reply that closes an offer: bound with the debtor's own IOU, paid with a promise, or the fallback."""
        d, c, a, via = offer['debtor'], offer['creditor'], offer['amount'], offer.get('via')
        offer['state'] = 'bound'
        self.log(action='bound', offer=offer_id, deal=offer.get('deal_id'), debtor=d, creditor=c, amount=a, via=via, how=how)
        if how == 'transfer':
            text = fit(lambda w: f"Paid with a promise. {credits(a)} of @{via}'s IOU to @{d} now belong{'s' if a == 1 else ''} to @{c}: @{via} "
                       f'owes @{c} instead, and @{d} paid' + (f' for {w}' if w else '') + ' with no new IOU. Recorded by '
                       f'a Basis tracker: valun.tech/agent/{profile_name(c)}', offer['what'])
        elif how == 'own_note':
            text = fit(lambda w: f"Bound. Moving @{via}'s promise did not apply, so @{d}'s own IOU paid: @{d} owes "
                       f'@{c} {credits(a)}' + (f' for {w}' if w else '') + '. Recorded by a Basis tracker: '
                       f'valun.tech/agent/{profile_name(d)}', offer['what'])
        else:
            text = fit(lambda w: f'Bound. @{d} owes @{c} {credits(a)}' + (f' for {w}' if w else '') + f'. @{c} can now '
                       f'pay others with it. Recorded by a Basis tracker: valun.tech/agent/{profile_name(d)}', offer['what'])
        self.say(text, offer['accept_id'])

    def settle_pending(self):
        """Offers accepted with a promise whose transfer had not applied yet: carried on, and answered once settled."""
        for oid, o in self.st.s['offers'].items():
            if o['state'] != 'settling':
                continue
            try:
                how = self.v.settle(o, o['deal_id'])
            except (BindError, OSError, subprocess.SubprocessError) as e:
                self.log(action='error', offer=oid, error=str(e)[:300])
                continue
            if how != 'pending':
                self.settled(o, oid, how)
            elif time.time() - datetime.fromisoformat(o['settling_since']).timestamp() > SETTLE_MAX_S:
                o['state'] = 'unsettled'
                self.log(action='unsettled', offer=oid, deal=o['deal_id'])
                self.say(f"Not settled: the delivery stays accepted, but neither @{o['via']}'s promise nor @{o['debtor']}'s "
                         f"own IOU has paid it yet. Valun records deal {o['deal_id']} as payment due.", o['accept_id'])
        self.st.save()

    def record(self, t, author, who):
        """A participant's public record, as one reply with its link."""
        if who == BOT or (who != author and who not in mentioned_ids(t)):
            return
        if self.st.count('records') >= RECORDS_PER_DAY or self.st.count(f'records:{author}') >= RECORDS_PER_AUTHOR_PER_DAY:
            return self.log(action='ignored_record', tweet=t['id'], why='daily record limit')
        name = profile_name(who)
        shown = f'@{who}' if who == author else who          # someone else is named, not mentioned
        held = name in self.st.s['profiles']
        try:
            pos = self.v.public(name) if held else None
        except (OSError, ValueError):
            pos = None
        if held and not pos:
            return self.log(action='record_unreadable', tweet=t['id'], who=who)
        if not pos:
            text = self.no_promises(shown)
        elif pos.get('evidence'):
            text = record_text(shown, pos['evidence'], name, self.v.network()[1])
        else:
            scale = self.v.network()[1]
            c = lambda k: in_credits(pos.get(k) or 0, scale)  # noqa: E731 - the network's units, in credits
            text = (f"{shown}'s record: owes {credits(c('owes'))}, holds {c('claims_held')} of "
                    f"others' promises; {credits(c('novated_as_issuer'))} of {shown}'s promises changed hands; "
                    f"{c('cleared_by_setoff')} cancelled in loops. valun.tech/agent/{name}")
        if self.say(text, t['id']):
            self.st.bump('records')
            self.st.bump(f'records:{author}')

    def no_promises(self, shown):
        """The answer for an X user this bot holds no identity for: none of their promises is bound here yet."""
        return (f'{shown} has no promises bound here yet. One starts with a post like '
                f'"@{BOT} I owe" plus someone\'s handle and {MIN_CREDITS} to {MAX_CREDITS} credits.{self.note()}')

    def card(self, t, author, kind, who):
        """A participant's budget card, as one reply: card_text, with the card's link; without a link, that its owner
        has published none, or that there is no such participant. `kind` 'valun': `who` is a Valun handle, looked up as
        it is; 'x': an X user (the author when `who` is ''), by the identity this bot holds for them, as record() reads
        one. Handles are written without @, so the reply mentions no one the post did not. An unknown Valun handle is
        not repeated (it is any word a post wrote)."""
        if kind == 'x':
            who = who or author
            if who == BOT or (who != author and who not in mentioned_ids(t)):
                return
        if self.st.count('cards') >= CARDS_PER_DAY or self.st.count(f'cards:{author}') >= CARDS_PER_AUTHOR_PER_DAY:
            return self.log(action='ignored_card', tweet=t['id'], why='daily card limit')
        name = profile_name(who) if kind == 'x' else who
        if kind == 'x' and name not in self.st.s['profiles']:
            text = self.no_promises(who)
        else:
            try:
                text = card_text(who, self.v.card(name), *self.v.network())
            except BindError as e:
                if e.code == 'card_not_public':
                    text = f'{who} has not published a budget card.'
                elif e.code == 'unknown_participant' and kind == 'valun':
                    text = 'No Valun participant has that handle.'
                else:
                    return self.log(action='card_unreadable', tweet=t['id'], who=name, error=e.code)
            if text is None:
                return self.log(action='card_unreadable', tweet=t['id'], who=name, error='not_a_card')
        if self.say(text, t['id']):
            self.st.bump('cards')
            self.st.bump(f'cards:{author}')

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
            k = next(i for i, n in enumerate(names) if n in held)          # start at a person on X, in the loop's order
            names = names[k:] + names[:k]
            shown = [f'@{held[n]}' if n in held else f'{n} (AI)' if str(n).startswith('house-') else str(n) for n in names]
            each = amount_of(loop, 'each')                 # the network's units (nanoERG on the testnet), or None
            whole = isinstance(each, int) and not isinstance(each, bool) and each > 0
            text = (f'Loop closed: {ARROW.join(shown + shown[:1])}. '
                    + (f'{credits(in_credits(each, self.v.network()[1]))} of promises cancelled' if whole else 'Promises cancelled')
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
    state = State(os.path.join(HOME, 'bind-state.json'), carry=CARRY_STATE or None)
    bot = Bot(X(keys_from_env()), Valun(), state)
    bot.log(action='start', server=SERVER, home=HOME, carried_from=state.s.get('carried_from'), monthly_usd=MONTHLY_USD,
            daily_usd=DAILY_USD, month_usd=state.s['month_usd'])
    last_loops = 0.0
    while True:
        try:
            bot.poll()
            if time.time() - last_loops > LOOP_EVERY_S and state.s['profiles']:
                last_loops = time.time()
                bot.settle_pending()
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
