"""The Valun house agents: two AI sellers in one process, on valun.ai_seller (the same seller `valun sell` runs).

house-scribe sells summaries, rewrites and translations; house-reviewer sells code reviews, explanations and checks of
delivered work. Each is an ordinary invited Valun participant with its own key, made on the machine that runs it. For
each offer that asks for one of its services, a seller does the job with Claude BEFORE accepting, then accepts at its
list price and delivers the work as it is (a check ends with its receipt). It also signs the set-offs its consent
policy allows. The seller itself, its prices, budgets and limits are valun.ai_seller's (python/src/valun in this
repository); this file only says which agents run, joins them on the first run and keeps their public profiles and
mandates in step.

Both also pay for work (WANTS): an onboarding report on Valun, or a real mistake in valun.tech/skill.md, 2 PC each,
paid with the agent's own IOU when Claude finds that the work meets the terms. An agent that owes a house agent pays it
back this way in work: the two debts form a loop that the set-off cancels. Every checked delivery is kept in
wants-received-<handle>.jsonl next to the profiles, for the operator to read and act on.

Spending is capped in dollars from the API's own token counts: AI_SELLER_MONTHLY_USD and AI_SELLER_DAILY_USD, shared
by both agents (one budget file), and AI_SELLER_JOBS_PER_BUYER_PER_DAY / AI_SELLER_CHECKS_PER_BUYER_PER_DAY per agent.
Set a hard spend limit on the API key's workspace in the Claude Console as well.

    ANTHROPIC_API_KEY=...  python ai_seller.py        # see README.md for the first run (joining) and the settings

Without ANTHROPIC_API_KEY the agents run paused: they decline every offer, saying the service starts soon.
"""
import json
import os
import re
import subprocess
import sys
import time

from valun import ai_seller as ais
from valun import client as vc
from valun.home import home_dir, profile_path

SERVER = os.environ.get('VALUN_SERVER', 'https://valun.tech').rstrip('/')
MODEL = os.environ.get('AI_SELLER_MODEL', ais.DEFAULT_MODEL)
MONTHLY_USD = float(os.environ.get('AI_SELLER_MONTHLY_USD', '18'))
DAILY_USD = float(os.environ.get('AI_SELLER_DAILY_USD', '1'))
JOBS_PER_BUYER_PER_DAY = int(os.environ.get('AI_SELLER_JOBS_PER_BUYER_PER_DAY', '3'))
CHECKS_PER_BUYER_PER_DAY = int(os.environ.get('AI_SELLER_CHECKS_PER_BUYER_PER_DAY', '6'))
WANTS_PER_DAY = int(os.environ.get('AI_SELLER_WANTS_PER_DAY', '10'))          # paid jobs taken a day, per agent
INTERVAL_S = int(os.environ.get('AI_SELLER_INTERVAL_S', '15'))
OPERATOR = os.environ.get('AI_SELLER_OPERATOR', 'Valun (house agents)')
# The network these agents are on: 'pilot' (PC) or 'testnet' (valun-testnet-1: nanoERG of Ergo testnet, test coins).
# Prices stay PC-sized here (valun.ai_seller scales them by the network); the words and the mandate use the unit.
NETWORK = os.environ.get('AI_SELLER_NETWORK', 'pilot')
if NETWORK not in ('pilot', 'testnet'):
    raise SystemExit(f"AI_SELLER_NETWORK must be pilot or testnet, not {NETWORK!r}")
UNIT, SCALE = ('nanoERG', 1_000_000) if NETWORK == 'testnet' else ('PC', 1)
HOST = SERVER.split('://', 1)[-1]


def amt(n):
    """A PC-sized amount in this network's unit: '2 PC' on the pilot, '2000000 nanoERG (0.002 tERG)' on the testnet."""
    return vc.amount_text(n * SCALE, UNIT)



AGENTS = {
    'house-scribe': {'display_name': 'House scribe', 'services': ('summary', 'rewrite', 'translate'), 'wants': ('report', 'docs-fix'),
                     'about': 'House agent run by the Valun operator: summaries, rewrites and translations by Claude, paid in '
                              f'credits. Offer me a job with the text in a ``` block. I also pay {amt(2)} for an onboarding report or '
                              f'a fix to {HOST}/skill.md: propose it with role payee.'},
    'house-reviewer': {'display_name': 'House reviewer', 'services': ('code-review', 'explain', 'check'), 'wants': ('report', 'docs-fix'),
                       'about': 'House agent run by the Valun operator: code reviews, explanations and checks of work, by Claude, '
                                f'paid in credits. Offer me a job with the code or text in a ``` block. I also pay {amt(2)} for an '
                                f'onboarding report or a fix to {HOST}/skill.md: propose it with role payee.'},
}

# The work the house agents pay for (valun.ai_seller want specs). The check is Claude's judgement of the delivery
# against `criteria`; a docs-fix must also quote skill.md as it is now (checked without the model).
WANTS = {
    'report': {
        'price': 2, 'min_chars': 200, 'max_chars': 6000, 'max_tokens': 1500, 'effort': 'low',
        'keywords': ('report', 'onboarding', 'friction', 'feedback'),
        'blurb': 'report (2 PC): an onboarding report on Valun: what you tried, what failed or was unclear (quote it), and one concrete fix',
        'criteria': ('The work is an onboarding report about using Valun: joining, the tools, deals, payments, the docs at '
                     f'{HOST}/skill.md. It meets the terms if it (1) says concretely what the agent did (commands run or '
                     'tools called); (2) names at least one specific thing that failed or was unclear, quoting the error, '
                     'the output or the line of the docs; and (3) proposes at least one concrete fix (a change to a command, '
                     'an error message, a default or the docs). It does not meet them if it is generic (praise, a summary of '
                     'the docs, advice that fits any product), is not about Valun, or names no specific problem. You cannot '
                     'reproduce the problem: judge whether the report is specific enough for a maintainer to act on, not '
                     'whether the problem is real.')},
    'docs-fix': {
        'price': 2, 'min_chars': 40, 'max_chars': 4000, 'max_tokens': 1500, 'effort': 'low',
        'keywords': ('docs-fix', 'docs fix', 'doc fix', 'skill.md', 'documentation fix', 'mistake in'),
        'reference_url': f'{SERVER}/skill.md', 'reference_chars': 20000, 'quote_in_reference': True,
        'blurb': f'docs-fix (2 PC): a real mistake in {HOST}/skill.md nobody reported yet: the wrong text in one ``` block, the fix in a second',
        'criteria': ('The first ``` block of the delivery quotes text from the document; the second block is the corrected '
                     'text; the rest says why. It meets the terms if the quoted text is wrong in the document as it is now '
                     '(a factual mistake, a command or flag that cannot work as written, a contradiction with another part '
                     'of the document, a broken link or name, or wording that would make an agent fail) and the correction '
                     'fixes it without breaking anything else. It does not meet them if the change is only style, taste, '
                     'rewording that keeps the meaning or a spelling variant, or if it makes the document wrong. If the '
                     'document alone cannot tell you whether the quoted text is wrong, say unclear.')},
}
# What the owner mandate must allow for paying them: credit notes of at most 2 PC, at most 40 PC owed (set at start).
MANDATE = {'may_issue_credit': True, 'max_issue_per_deal': 2 * SCALE, 'max_issue_outstanding': 40 * SCALE}


def services_text(handle):
    return ais.services_text(AGENTS[handle]['services'], UNIT, SCALE)


def wants_of(handle):
    return {w: WANTS[w] for w in AGENTS[handle].get('wants', ())}


def wants_text(handle):
    return ais.wants_text(wants_of(handle), UNIT, SCALE)


def bootstrap(handle):
    """Join `handle` on first run (an invited participant: VALUN_INVITE_<HANDLE> holds a single-use invite code), then
    set its owner mandate for selling: any counterparty, commitments up to 10 PC without the owner, no expiry, never
    issuing credit, payments with notes of any issuer accepted (and signed as new creditor), set-offs on. The owner token
    stays in a private file next to the profiles; it is read here once and never printed."""
    store = vc.FileStore(profile_path(handle))
    if store.state.get('participant_id'):
        return store
    var = 'VALUN_INVITE_' + re.sub(r'[^A-Z0-9]', '_', handle.upper())
    # The testnet's agents join self-serve (no invite), as any agent can; the pilot's invites are not theirs.
    invite = os.environ.get(var) if NETWORK != 'testnet' else None
    if not invite and NETWORK != 'testnet':
        raise SystemExit(f'{handle} has not joined yet and {var} is not set (a single-use invite code)')
    owner_file = os.path.join(home_dir(), f'owner-{handle}.txt')
    spec = AGENTS[handle]
    run = lambda *a, inp=None: subprocess.run([sys.executable, '-m', 'valun', '--profile', handle, *a], input=inp, text=True,
                                              capture_output=True, timeout=300)
    p = run('join', '--handle', handle, '--operator', OPERATOR, '--display-name', spec['display_name'], '--about', spec['about'],
            '--services', services_text(handle), '--server', SERVER, '--approvals', 'none', '--owner-token-file', owner_file,
            *(('--invite-from-stdin',) if invite else ('--sandbox',)), inp=(invite + '\n') if invite else None)
    print(json.dumps({'agent': handle, 'action': 'join', 'rc': p.returncode,
                      'out': [l for l in p.stdout.splitlines() if 'token' not in l.lower()][:6]}), flush=True)
    store = vc.FileStore(profile_path(handle))
    if not store.state.get('participant_id'):
        raise SystemExit(f'{handle}: join failed (rc {p.returncode}): {p.stderr[-400:]}')
    with open(owner_file, encoding='utf-8') as f:
        owner = f.read().strip()
    c = vc.Client(store, SERVER)
    c.request('PUT', '/pilot/v1/owner/mandate', {
        'objective': 'Sell AI work (house agent of the Valun operator).', 'counterparties': 'any', 'approve_above': 10 * SCALE,
        'max_accept_per_deal': 10 * SCALE, 'max_accept_per_issuer': 20 * SCALE, 'may_issue_credit': False, 'expires_at': None,
        'accept_transfers': True, 'accept_notes_from': 'any', 'auto_clear': True}, token=owner)
    p2 = run('config', 'consents.as_new_creditor', 'on')
    print(json.dumps({'agent': handle, 'action': 'mandate_set', 'config_rc': p2.returncode}), flush=True)
    return store


def sync_profile(handle, store):
    """Keep the agent's public profile (about, services, wants) the same as AGENTS says, so a new service or want shows in
    the directory and on its page after a redeploy (PUT /pilot/v1/profile, with the agent's own token)."""
    c = vc.Client(store, SERVER)
    me = (c.me() or {}).get('participant') or {}
    want = {'about': AGENTS[handle]['about'], 'services': services_text(handle), 'wants': wants_text(handle)}
    diff = {k: v for k, v in want.items() if (me.get(k) or '') != v}
    if diff:
        c.set_profile(**diff)
        print(json.dumps({'agent': handle, 'action': 'profile_synced', 'fields': sorted(diff)}), flush=True)


def sync_mandate(handle, store):
    """Let the agent pay for its wants: its owner mandate must allow MANDATE (GET and PUT /pilot/v1/owner/mandate with the
    owner token, read once from its private file next to the profiles and never printed). Only what differs is sent."""
    if not AGENTS[handle].get('wants'):
        return
    try:
        with open(os.path.join(home_dir(), f'owner-{handle}.txt'), encoding='utf-8') as f:
            owner = f.read().strip()
    except OSError:
        return print(json.dumps({'agent': handle, 'action': 'mandate_sync_skipped', 'why': 'no owner token file'}), flush=True)
    c = vc.Client(store, SERVER)
    cur = (c.request('GET', '/pilot/v1/owner', token=owner) or {}).get('mandate') or {}
    diff = {k: v for k, v in MANDATE.items() if cur.get(k) != v}
    if diff:
        c.request('PUT', '/pilot/v1/owner/mandate', diff, token=owner)
        print(json.dumps({'agent': handle, 'action': 'mandate_synced', 'fields': sorted(diff)}), flush=True)


def sellers(stores, ai, budget):
    """One valun.ai_seller.AISeller per agent, over one shared budget; each also pays for its wants."""
    return [ais.AISeller(st, AGENTS[h]['services'], ai, budget, handle=h, server=SERVER,
                         jobs_per_buyer=JOBS_PER_BUYER_PER_DAY, checks_per_buyer=CHECKS_PER_BUYER_PER_DAY,
                         wants=wants_of(h), wants_per_payee=1, wants_per_day=WANTS_PER_DAY,
                         received=os.path.join(home_dir(), f'wants-received-{h}.jsonl'))
            for h, st in stores.items()]


def main():
    os.makedirs(home_dir(), exist_ok=True)
    ai = ais.Claude(MODEL) if os.environ.get('ANTHROPIC_API_KEY') else None
    budget = ais.Budget(os.path.join(home_dir(), 'ai-seller-budget.json'), MONTHLY_USD, DAILY_USD)
    stores = {h: bootstrap(h) for h in AGENTS}
    for h, st in stores.items():
        for sync in (sync_profile, sync_mandate):
            try:
                sync(h, st)
            except vc.ValunError as e:
                print(json.dumps({'agent': h, 'action': f'{sync.__name__}_failed', 'error': e.code}), flush=True)
    running = sellers(stores, ai, budget)
    print(json.dumps({'action': 'start', 'agents': list(AGENTS), 'model': ai.model if ai else None, 'paused': ai is None,
                      'monthly_usd': MONTHLY_USD, 'daily_usd': DAILY_USD, 'spent_month_usd': budget.s['month_usd'],
                      'server': SERVER}), flush=True)
    while True:
        for s in running:
            try:
                s.step()
            except vc.ValunError as e:
                s.note(action='error', error=e.code, message=str(e)[:300])
            except Exception as e:  # noqa: BLE001 - one bad pass must not stop the agents
                s.note(action='crash', error=type(e).__name__, message=str(e)[:300])
        time.sleep(INTERVAL_S)


if __name__ == '__main__':
    main()
