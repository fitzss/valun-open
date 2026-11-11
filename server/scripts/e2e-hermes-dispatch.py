"""E2E-1: the Hermes plugin hermes-plugin-valun 0.4.0 through Hermes's REAL dispatch path, against a local v16 server.

No AI model. This script plays the agent and the owner, but every tool call goes through Hermes itself:
model_tools.handle_function_call -> the plugin's pre_tool_call hook (in the plugin host: plugins.isolation host) ->
tools.approval.request_tool_approval (Hermes's own approval gate, mode manual) -> the approval callback registered with
tools.terminal_tool.set_approval_callback (this script: it answers 'once' or 'deny', as a person at the CLI prompt
would) -> the handler, through the plugin host's proxy. The profile is joined with the real `hermes valun join
--sandbox` command. Checks:
  - an approved commitment runs (the binding made by the hook reaches the handler in the plugin host);
  - a declined commitment is blocked by Hermes and nothing is signed or recorded on the server;
  - decision D-3 a: a set-off that waits for this client is signed during valun_status (a read-only tool, never
    approval-gated), within the owner's standing policy, and the result lists it in consents_signed_now.

Run with the Hermes venv's Python, in a fresh short HERMES_HOME (an empty or new folder, at most 44 characters), with
loopback-only networking (the e2e script sets dead loopback proxies):
  python -B scripts/e2e-hermes-dispatch.py --home HOME_DIR --plugin PLUGIN_GIT_DIR --base URL --out R.json
                                           --owner-file FILE [--handle H] [--hermes HERMES_EXE]
The plugin is installed from its committed tree (git archive HEAD) into HERMES_HOME/plugins/valun. Exit 0 when ok.
"""
import argparse
import io
import json
import os
import secrets
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--home', required=True)
p.add_argument('--plugin', required=True)
p.add_argument('--base', required=True)
p.add_argument('--out', required=True)
p.add_argument('--owner-file', required=True)
p.add_argument('--handle', default=f'e2e-hm-{secrets.token_hex(3)}')
p.add_argument('--hermes', default=str(Path(sys.executable).with_name('hermes.exe' if os.name == 'nt' else 'hermes')))
args = p.parse_args()
HOME = Path(args.home)
assert len(str(HOME)) <= 44, 'a short Hermes home (Windows path limits)'
assert args.base.startswith('http://127.0.0.1:'), 'loopback servers only'
if HOME.exists() and any(HOME.iterdir()):
    sys.exit(f'{HOME} is not empty: this script only sets up a fresh Hermes home')
os.environ['HERMES_HOME'] = str(HOME)
X = 'sandbox-exact'
failures, approvals, events = [], [], []
result = {'ok': False, 'handle': args.handle, 'failures': failures, 'approvals': approvals, 'events': events}


def say(*a):
    print(f'[{time.strftime("%H:%M:%S")}] hermes:', *a, flush=True)


def check(ok, what, detail=None):
    say(('ok    ' if ok else 'FAIL  ') + what + ('' if ok or detail is None else f'\n        {json.dumps(detail, default=str)[:1500]}'))
    if not ok:
        failures.append({'what': what, 'detail': detail})
    return ok


class Abort(Exception):
    pass


def must(ok, what, detail=None):
    if not check(ok, what, detail):
        raise Abort(what)


def public(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(args.base + '/pilot/v1' + path, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def totals():
    out = {}
    for n in public('/ledger').get('notes') or []:
        if args.handle in (n.get('issuer_handle'), n.get('recipient_handle')):
            out[f"{n['issuer_handle']}>{n['recipient_handle']}"] = n.get('total')
    return out


def main():
    # 1. A fresh home: the plugin's committed tree in plugins/valun, enabled; Hermes's approval gate in mode manual (no
    # auxiliary model ever decides an approval here). `hermes <command>` plugin subcommands are wired only in process
    # (the plugin host skips register_cli_command), so the owner's join runs with the default isolation; the agent's tool
    # calls below run in the plugin host (plugins.isolation host).
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / 'config.yaml').write_text('plugins:\n  enabled:\n    - valun\napprovals:\n  mode: manual\n', encoding='utf-8')
    tar = subprocess.run(['git', '-C', args.plugin, 'archive', '--format=tar', 'HEAD'], capture_output=True, check=True).stdout
    dest = HOME / 'plugins' / 'valun'
    with tarfile.open(fileobj=io.BytesIO(tar)) as t:
        t.extractall(dest, filter='data')
    head = subprocess.run(['git', '-C', args.plugin, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    result['plugin_head'] = head
    say(f'plugin {head[:7]} installed in {dest}')
    # 2. Join with the real CLI command (the owner token goes to the new file; never printed). Where Windows Application
    #    Control refuses to start the venv's hermes.exe launcher (an unsigned console-script shim), the same CLI entry
    #    point runs as `python -m hermes_cli.main`, and the result says so.
    join = ['valun', 'join', '--sandbox', '--server', args.base, '--handle', args.handle, '--operator', 'E2E-1 hermes',
            '--owner-token-file', args.owner_file]
    run = dict(input='', capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, env=os.environ)
    try:
        j = subprocess.run([args.hermes, *join], **run)
    except OSError as e:
        result['hermes_launcher'] = f'{args.hermes} could not be started ({e.strerror or e}); ran python -m hermes_cli.main'
        say(f"the hermes launcher could not be started ({e.strerror or e}): running python -m hermes_cli.main instead")
        j = subprocess.run([sys.executable, '-m', 'hermes_cli.main', *join], **run)
    (Path(args.out).parent / 'hermes-join.log').write_text(f'[exit {j.returncode}]\n{j.stdout}\n[stderr]\n{j.stderr}', encoding='utf-8')
    must(j.returncode == 0 and Path(args.owner_file).is_file(), '`hermes valun join --sandbox` exits 0 and writes the owner token file',
         {'exit': j.returncode, 'tail': (j.stdout + j.stderr)[-800:]})

    # plugins.isolation host from here on: a line added under the top-level plugins mapping that join wrote.
    cfg = (HOME / 'config.yaml').read_text(encoding='utf-8')
    must(cfg.startswith('plugins:\n  enabled:\n') and '\n  isolation:' not in cfg, 'config.yaml as join left it: plugins first, no isolation key', cfg[:80])
    (HOME / 'config.yaml').write_text(cfg.replace('plugins:\n', 'plugins:\n  isolation: host\n', 1), encoding='utf-8')
    # 3. This process is the Hermes side: profile secret scope, an interactive CLI context and its approval callback.
    from agent.secret_scope import build_profile_secret_scope, set_secret_scope
    from tools import approval_context, terminal_tool
    import model_tools
    from hermes_cli import plugins as hplugins
    set_secret_scope(build_profile_secret_scope(HOME), profile_home=str(HOME))
    approval_context.set_hermes_interactive_context(True)
    decisions = []

    def approval_cb(command, description, **kw):
        answer = decisions.pop(0) if decisions else 'deny'
        approvals.append({'target': command, 'first_line': str(description).split('\n')[0][:200], 'answer': answer})
        say(f'  approval prompt ({answer}): {str(description).splitlines()[0][:150]}')
        return answer
    terminal_tool.set_approval_callback(approval_cb)
    hplugins.discover_plugins(force=True)
    mgr = hplugins.get_plugin_manager()
    info = [x for x in (mgr.list_plugins() if hasattr(mgr, 'list_plugins') else []) if (x.get('name') if isinstance(x, dict) else None) == 'valun']
    result['plugin_info'] = info
    calls = []
    # plugins.isolation host: no module of the plugin is imported into this (the Hermes) process.
    plugin_dir = str(dest.resolve()).lower()
    here = [m for m, mod in list(sys.modules.items()) if str(getattr(mod, '__file__', '') or '').lower().startswith(plugin_dir)]
    check(not here, 'the plugin runs in the plugin host: none of its modules is imported into the Hermes process', here[:5])

    def call(name, a=None, decision=None):
        if decision is not None:
            decisions.append(decision)
        asked = len(approvals)
        raw = model_tools.handle_function_call(name, dict(a or {}), task_id='e2e1', session_id='e2e1-session', tool_call_id=f'c{len(calls)}')
        try:
            out = json.loads(raw)
        except Exception:  # noqa: BLE001
            out = {'unparsed': str(raw)[:400]}
        calls.append({'tool': name, 'asked': len(approvals) > asked, 'error': out.get('error') if isinstance(out, dict) else None,
                      'status': out.get('status') if isinstance(out, dict) else None})
        say(f'  {name} -> {calls[-1]["status"] or calls[-1]["error"] or str(out)[:160]}')
        if decision is not None and decisions:
            decisions.clear()
        return out

    st = call('valun_status')
    must(isinstance(st, dict) and st.get('error') is None and st.get('sandbox_next_steps', {}).get('tour_step') == 1,
         'valun_status through handle_function_call (plugin host): tour step 1', st)
    check(st.get('consent_policy_in_force', {}).get('setoff') is True, 'the sandbox join turned on the set-off role (process_consents on)', st.get('consent_policy_in_force'))
    welcome = None
    for _ in range(60):
        welcome = next((x for x in (call('valun_inbox').get('respond') or []) if x.get('counterparty') == X and x.get('your_role') == 'payee'), None)
        if welcome:
            break
        time.sleep(1)
    must(welcome, 'the welcome job from sandbox-exact is in valun_inbox')
    # An approved commitment: the hook asks through Hermes's gate, the callback says once, the handler signs.
    acc = call('valun_respond', {'deal_id': welcome['deal_id'], 'action': 'accept'}, decision='once')
    must(acc.get('status') == 'agreed' and calls[-1]['asked'], 'APPROVED: valun_respond accept asked through Hermes and ran (agreed)', acc)
    check(approvals[-1]['target'].startswith('<valun_respond>'), "Hermes's approval gate named the plugin tool", approvals[-1])
    dl = call('valun_deliver', {'deal_id': welcome['deal_id'], 'exact_result': True}, decision='once')
    must(dl.get('status') == 'delivered', 'valun_deliver exact_result (approved if asked)', dl)
    for _ in range(60):
        if call('valun_deal', {'deal_id': welcome['deal_id']}).get('status') == 'note_issued':
            break
        time.sleep(2)
    check(totals().get(f'{X}>{args.handle}') == 3, 'sandbox-exact paid the welcome job: X>S 3', totals())
    # A declined commitment: blocked by Hermes; nothing reaches the server.
    deals_before = len(call('valun_inbox').get('waiting_on_others') or [])
    job = lambda svc, text: {'title': f'{svc} job', 'description': f'{svc} for this text:\n```\n{text}\n```',
                             'deliverable': f'The exact {svc} result as JSON.', 'deliver_within_hours': 24, 'offer_valid_hours': 1}
    no = call('valun_propose', {'counterparty': X, 'role': 'payer', **job('notary', 'E2E-1 hermes: declined by the owner.'), 'price': 2}, decision='deny')
    check(calls[-1]['asked'] and no.get('status') is None and 'deal_id' not in no, 'DECLINED: valun_propose asked through Hermes, the owner said deny, the call is blocked', no)
    after = call('valun_inbox')
    check(len(after.get('waiting_on_others') or []) == deals_before and not any('declined by the owner' in json.dumps(x) for x in after.get('waiting_on_others') or []),
          'the declined offer reached nobody (no new deal waits on sandbox-exact)', after.get('waiting_on_others'))
    # Buy notary from sandbox-exact with an own note (approved): the 2-cycle S>X 2 / X>S 3 then waits for this client's
    # set-off consent; only valun_status is called until it is signed (decision D-3 a).
    paid = None
    for attempt in range(1, 4):
        prop = call('valun_propose', {'counterparty': X, 'role': 'payer', **job('notary', f'E2E-1 hermes: paid with my own note ({attempt}).'), 'price': 2}, decision='once')
        must(prop.get('deal_id'), 'APPROVED: valun_propose notary to sandbox-exact', prop)
        d = None
        for _ in range(60):
            d = call('valun_deal', {'deal_id': prop['deal_id']})
            if d.get('status') in ('delivered', 'declined', 'expired'):
                break
            time.sleep(2)
        must(d.get('status') == 'delivered', 'sandbox-exact delivers', d.get('status'))
        rv = call('valun_review_delivery', {'deal_id': d['id'], 'decision': 'accept', 'pay_with': 'own_note',
                                            'expected_deliverable_sha256': d['delivery']['sha256']}, decision='once')
        must(rv.get('status') == 'note_issued', 'APPROVED: valun_review_delivery accept own_note: note_issued', rv)
        paid = d['id']
        break
    t = totals()
    check(t.get(f'{args.handle}>{X}') == 2 and t.get(f'{X}>{args.handle}') == 3, 'S>X 2 and X>S 3 before the set-off', t)
    signed, end = [], time.time() + 180
    while time.time() < end and not signed:
        time.sleep(5)
        s2 = call('valun_status')
        signed = [e for e in (s2.get('consents_signed_now') or []) if e.get('kind') == 'setoff' and e.get('role') == 'member']
        if s2.get('consents_signed_now'):
            events.append({'consents_signed_now': s2['consents_signed_now']})
    check(bool(signed), 'D-3 a: valun_status (read-only, not approval-gated) signed the set-off as member (consents_signed_now)', events)
    check(not any(c['asked'] for c in calls if c['tool'] == 'valun_status'), 'valun_status never asked the owner')
    time.sleep(2)
    t = totals()
    check(t.get(f'{args.handle}>{X}') == 0 and t.get(f'{X}>{args.handle}') == 1, 'after the set-off: S>X 0 and X>S 1', t)
    result['calls'] = calls
    result['paid_deal'] = paid


try:
    main()
except Abort:
    pass
except Exception as e:  # noqa: BLE001
    import traceback
    check(False, 'no unexpected error', traceback.format_exc()[-2500:])
result['ok'] = not failures
Path(args.out).write_text(json.dumps(result, indent=1, default=str), encoding='utf-8')
say('PASS' if result['ok'] else f'FAIL ({len(failures)})')
try:
    from hermes_cli import plugins as _hp
    if hasattr(_hp, 'shutdown_plugin_hosts'):
        _hp.shutdown_plugin_hosts()
except Exception:  # noqa: BLE001
    pass
sys.exit(0 if result['ok'] else 1)
