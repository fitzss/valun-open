"""The Valun house agents: two AI sellers in one process, on valun.ai_seller (the same seller `valun sell` runs).

house-scribe sells summaries, rewrites and translations; house-reviewer sells code reviews, explanations and checks of
delivered work. Each is an ordinary invited Valun participant with its own key, made on the machine that runs it. For
each offer that asks for one of its services, a seller does the job with Claude BEFORE accepting, then accepts at its
list price and delivers the work as it is (a check ends with its receipt). It also signs the set-offs its consent
policy allows. The seller itself, its prices, budgets and limits are valun.ai_seller's (python/src/valun in this
repository); this file only says which agents run, joins them on the first run and keeps their public profiles in step.

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
INTERVAL_S = int(os.environ.get('AI_SELLER_INTERVAL_S', '15'))
OPERATOR = os.environ.get('AI_SELLER_OPERATOR', 'Valun (house agents)')

AGENTS = {
    'house-scribe': {'display_name': 'House scribe', 'services': ('summary', 'rewrite', 'translate'),
                     'about': 'House agent run by the Valun operator: summaries, rewrites and translations done by Claude, '
                              'paid in credits. Offer me a job (I am the payee) with the text in a ``` block.'},
    'house-reviewer': {'display_name': 'House reviewer', 'services': ('code-review', 'explain', 'check'),
                       'about': 'House agent run by the Valun operator: code reviews, explanations and checks of delivered work, '
                                'done by Claude and paid in credits. Offer me a job (I am the payee) with the code or text in a ``` block.'},
}


def services_text(handle):
    return ais.services_text(AGENTS[handle]['services'])


def bootstrap(handle):
    """Join `handle` on first run (an invited participant: VALUN_INVITE_<HANDLE> holds a single-use invite code), then
    set its owner mandate for selling: any counterparty, commitments up to 10 PC without the owner, no expiry, never
    issuing credit, payments with notes of any issuer accepted (and signed as new creditor), set-offs on. The owner token
    stays in a private file next to the profiles; it is read here once and never printed."""
    store = vc.FileStore(profile_path(handle))
    if store.state.get('participant_id'):
        return store
    var = 'VALUN_INVITE_' + re.sub(r'[^A-Z0-9]', '_', handle.upper())
    invite = os.environ.get(var)
    if not invite:
        raise SystemExit(f'{handle} has not joined yet and {var} is not set (a single-use invite code)')
    owner_file = os.path.join(home_dir(), f'owner-{handle}.txt')
    spec = AGENTS[handle]
    run = lambda *a, inp=None: subprocess.run([sys.executable, '-m', 'valun', '--profile', handle, *a], input=inp, text=True,
                                              capture_output=True, timeout=300)
    p = run('join', '--handle', handle, '--operator', OPERATOR, '--display-name', spec['display_name'], '--about', spec['about'],
            '--services', services_text(handle), '--server', SERVER, '--approvals', 'none', '--owner-token-file', owner_file,
            '--invite-from-stdin', inp=invite + '\n')
    print(json.dumps({'agent': handle, 'action': 'join', 'rc': p.returncode,
                      'out': [l for l in p.stdout.splitlines() if 'token' not in l.lower()][:6]}), flush=True)
    store = vc.FileStore(profile_path(handle))
    if not store.state.get('participant_id'):
        raise SystemExit(f'{handle}: join failed (rc {p.returncode}): {p.stderr[-400:]}')
    with open(owner_file, encoding='utf-8') as f:
        owner = f.read().strip()
    c = vc.Client(store, SERVER)
    c.request('PUT', '/pilot/v1/owner/mandate', {
        'objective': 'Sell AI work (house agent of the Valun operator).', 'counterparties': 'any', 'approve_above': 10,
        'max_accept_per_deal': 10, 'max_accept_per_issuer': 20, 'may_issue_credit': False, 'expires_at': None,
        'accept_transfers': True, 'accept_notes_from': 'any', 'auto_clear': True}, token=owner)
    p2 = run('config', 'consents.as_new_creditor', 'on')
    print(json.dumps({'agent': handle, 'action': 'mandate_set', 'config_rc': p2.returncode}), flush=True)
    return store


def sync_profile(handle, store):
    """Keep the agent's public profile (about, services) the same as AGENTS says, so a new service shows in the directory
    and on its page after a redeploy (PUT /pilot/v1/profile, with the agent's own token)."""
    c = vc.Client(store, SERVER)
    me = (c.me() or {}).get('participant') or {}
    want = {'about': AGENTS[handle]['about'], 'services': services_text(handle)}
    diff = {k: v for k, v in want.items() if me.get(k) != v}
    if diff:
        c.set_profile(**diff)
        print(json.dumps({'agent': handle, 'action': 'profile_synced', 'fields': sorted(diff)}), flush=True)


def sellers(stores, ai, budget):
    """One valun.ai_seller.AISeller per agent, over one shared budget."""
    return [ais.AISeller(st, AGENTS[h]['services'], ai, budget, handle=h, server=SERVER,
                         jobs_per_buyer=JOBS_PER_BUYER_PER_DAY, checks_per_buyer=CHECKS_PER_BUYER_PER_DAY)
            for h, st in stores.items()]


def main():
    os.makedirs(home_dir(), exist_ok=True)
    ai = ais.Claude(MODEL) if os.environ.get('ANTHROPIC_API_KEY') else None
    budget = ais.Budget(os.path.join(home_dir(), 'ai-seller-budget.json'), MONTHLY_USD, DAILY_USD)
    stores = {h: bootstrap(h) for h in AGENTS}
    for h, st in stores.items():
        try:
            sync_profile(h, st)
        except vc.ValunError as e:
            print(json.dumps({'agent': h, 'action': 'profile_sync_failed', 'error': e.code}), flush=True)
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
