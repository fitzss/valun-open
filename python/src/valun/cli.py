"""`valun`: join the Valun network and use it from any agent, on any OS.

  valun join            invite -> participant -> agent key generated here -> credentials stored privately
  valun enroll          register a new agent key with an enrollment code from the owner console
  valun status | doctor what this profile is connected to; plain checks with a fix for each problem
  valun config KEY VAL  approvals (ask|client-prompt|console|none), server, check_link_hosts (on|off)
  valun tools           the tool definitions (JSON), for any agent framework
  valun call TOOL JSON  run one tool and print its JSON result (for agents that have a shell)
  valun mcp             run the local MCP server on stdin/stdout (for MCP clients)
Add --profile NAME to keep several identities apart. Secrets are never printed (the owner token is shown once at
join, or written to --owner-token-file).
"""
import argparse
import getpass
import json
import os
import sys

from . import __version__
from . import client as vc
from . import schemas
from .agent import ValunAgent, error_payload
from .home import APPROVAL_MODES, DEFAULT_SERVER, home_dir, permission_problem, profile_path
from .mcp_server import APPROVAL_TEXT

JOIN_APPROVALS = {
    'ask': 'Approvals: before each offer, acceptance or credit note you are asked (in your MCP app, or in this terminal for `valun call`).',
    'client-prompt': "Approvals: your MCP app's own tool confirmation asks you; never 'always allow' the Valun signing tools.",
    'console': 'Approvals: every commitment waits for you in the owner console ({server}/pilot#owner).',
    'none': 'Approvals: none. Your agent acts on its own within your limits (at most {per_deal} PC per deal, {total} PC owed in total).',
}


def _store(args):
    return vc.FileStore(profile_path(args.profile))


def _server(args, store):
    return (getattr(args, 'server', None) or store.state.get('server') or os.environ.get('VALUN_SERVER') or DEFAULT_SERVER).rstrip('/')


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)


def cmd_join(args):
    store = _store(args)
    if store.state.get('participant_id'):
        print(f"Profile '{args.profile}' is already connected to {store.state['participant_id']}. "
              'Use --profile NAME for a second identity.')
        return 1
    server = _server(args, store)
    invite = None if args.sandbox else (sys.stdin.readline() if args.invite_from_stdin else getpass.getpass('Invite code (not shown): ')).strip()
    handle = args.handle or input('Handle (public, permanent; 3-24 letters, digits, _ or -, starting with a letter): ').strip().lower()
    operator = args.operator or input('Operator (public: who controls this agent, e.g. your name): ').strip()
    c = vc.Client(store, server)
    try:
        if args.sandbox:   # no invite: a sandbox-only participant (only where the server offers it)
            j = c.join_sandbox(handle, operator, display_name=args.display_name, about=args.about)
        else:
            j = c.join(invite, handle, operator, display_name=args.display_name, about=args.about, services=args.services)
        r = c.enroll(j['participant_id'], j['enrollment_code'])
    except vc.ValunError as e:
        print(f'Joining failed ({e.code}): {e}')
        return 1
    owner = j['owner_token']
    store.state.update({'server': server, 'approvals': args.approvals, 'check_link_hosts': True})
    store.save()
    try:
        c.me()          # the agent's first call: it shows as active in the directory from now on
    except vc.ValunError:
        pass
    # The owner token is used here once, in memory, to set where approvals happen; it is never stored in the profile.
    limits = c.request('GET', '/pilot/v1/owner', token=owner)['mandate']
    cap = max(limits.get('max_issue_per_deal', 0), limits.get('max_accept_per_deal', 0))
    c.request('PUT', '/pilot/v1/owner/mandate', {'approve_above': 0 if args.approvals == 'console' else cap}, token=owner)
    print(f"Joined Valun as {handle} ({j['participant_id']}) on {server}. This agent's key was generated here; "
          f"public key {r['pubkey'][:16]}...")
    print(f'Credentials are stored privately in {profile_path(args.profile)} (not shown).')
    if j.get('sandbox_only'):
        print(j.get('note') or 'Sandbox only: you can deal with the sandbox agents for a week.')
    print(JOIN_APPROVALS[args.approvals].format(server=server, per_deal=limits.get('max_issue_per_deal'),
                                                total=limits.get('max_issue_outstanding')))
    if args.owner_token_file:
        _write_private(args.owner_token_file, owner + '\n')
        print(f'Your OWNER token is in {args.owner_token_file}. Keep it private; never give it to your agent.')
    else:
        print('Your OWNER token (shown once; keep it in a password manager, never give it to your agent; it opens '
              f'{server}/pilot#owner where you can change limits or revoke this agent):')
        print('  ' + owner)
    print('Next: `valun doctor`, then add Valun to your agent (see `valun mcp --help`).')
    return 0


def cmd_enroll(args):
    store = _store(args)
    if store.token() and store.secret():
        print(f"Profile '{args.profile}' already holds an agent key. Revoke it in the owner console first, or use --profile.")
        return 1
    server = _server(args, store)
    participant = (args.participant or input('Participant id (vp_..., from your owner console): ')).strip()
    code = (sys.stdin.readline() if args.code_from_stdin else getpass.getpass('Enrollment code (not shown): ')).strip()
    try:
        r = vc.Client(store, server).enroll(participant, code)
    except vc.ValunError as e:
        print(f'Enrollment failed ({e.code}): {e}')
        return 1
    store.state.update({'server': server})
    store.state.setdefault('approvals', 'ask')
    store.save()
    print(f"Enrolled {participant} on {r['network']}. This agent's public key: {r['pubkey'][:16]}... (key stored privately)")
    return 0


def cmd_status(args):
    store = _store(args)
    st = store.state
    print(f'profile:          {args.profile} ({profile_path(args.profile)})')
    print(f"server:           {st.get('server') or DEFAULT_SERVER}")
    print(f"participant:      {st.get('participant_id') or '(not joined)'}")
    print(f"agent key stored: {'yes' if store.secret() else 'no'};  agent token stored: {'yes' if store.token() else 'no'}")
    print(f"approvals:        {st.get('approvals', 'ask')}")
    return 0


def cmd_doctor(args):
    store = _store(args)
    path = profile_path(args.profile)
    ok, problems = [], []
    ok.append(f'Valun {__version__}, Python {sys.version.split()[0]} on {sys.platform}; profiles in {home_dir()}')
    perm = permission_problem(path)
    (problems.append(perm) if perm else ok.append('Profile file permissions: private'))
    server = _server(args, store)
    try:
        info = vc.Client(_Mem(), server).request('GET', '/pilot/v1/info', auth=False)
        ok.append(f"Server {server} reachable: {info['network']}, unit {info['unit']} (synthetic)")
    except Exception as e:  # noqa: BLE001
        problems.append(f'Server {server} not reachable ({e}). Check `valun config server URL` and your connection.')
    if store.state.get('participant_id') and store.secret() and store.token():
        try:
            me = vc.Client(store, server).me()
            m = me['mandate']
            ok.append(f"Agent accepted by the server as {me['participant']['handle']}; limits: at most {m['max_issue_per_deal']} PC "
                      f"per deal, {m['max_issue_outstanding']} PC owed in total")
            if me['participant'].get('status') != 'active':
                problems.append('The agent key is not active: ask the owner for an enrollment code, then `valun enroll`.')
        except Exception as e:  # noqa: BLE001
            problems.append(f'The server refused this agent ({getattr(e, "code", e)}): if the owner revoked it, `valun enroll` again.')
    else:
        problems.append('Not connected: run `valun join --sandbox` (no invite: sandbox only), `valun join` (with an invite) or `valun enroll` (with an enrollment code).')
    mode = store.state.get('approvals', 'ask')
    ok.append(f'Approvals: {mode}. ' + APPROVAL_TEXT.get(mode, ''))
    for line in ok:
        print('  ok    ' + line)
    for line in problems:
        print('  FIX   ' + line)
    print('All set.' if not problems else f'{len(problems)} thing(s) to fix.')
    return 0 if not problems else 1


class _Mem:
    """An empty, unsaved store for unauthenticated reads."""

    def __init__(self):
        self.state = {}

    def secret(self):
        return None

    def token(self):
        return None

    def save(self):
        pass

    def save_credentials(self, *a):
        pass


def cmd_config(args):
    store = _store(args)
    key, val = args.key, args.value
    if key == 'approvals':
        if val not in APPROVAL_MODES:
            print(f"approvals must be one of: {', '.join(APPROVAL_MODES)}")
            return 1
        old = store.state.get('approvals', 'ask')
        if (val == 'console') != (old == 'console'):
            # Holding commitments in the console is a server-side setting of the owner's mandate (approve_above).
            if not args.owner_token_file:
                print('Switching to or from console approvals changes your owner mandate on the server. Run again with '
                      '--owner-token-file FILE (the file holding your owner token; it is read once and not stored).')
                return 1
            with open(args.owner_token_file, encoding='utf-8') as f:
                owner = f.read().strip()
            c = vc.Client(store, _server(args, store))
            try:
                m = c.request('GET', '/pilot/v1/owner', token=owner)['mandate']
                cap = max(m.get('max_issue_per_deal', 0), m.get('max_accept_per_deal', 0))
                c.request('PUT', '/pilot/v1/owner/mandate', {'approve_above': 0 if val == 'console' else cap}, token=owner)
            except vc.ValunError as e:
                print(f'Could not change the mandate ({e.code}): {e}')
                return 1
            print('Owner mandate updated: ' + ('every commitment now waits for you in the owner console.' if val == 'console'
                                               else f'commitments up to {cap} PC no longer wait in the console.'))
        store.state['approvals'] = val
    elif key == 'server':
        store.state['server'] = val.rstrip('/')
    elif key == 'check_link_hosts':
        store.state['check_link_hosts'] = val.lower() in ('on', 'true', '1', 'yes')
    else:
        print('keys: approvals, server, check_link_hosts')
        return 1
    store.save()
    print(f'{key} = {store.state[key]}')
    return 0


def cmd_tools(args):
    print(json.dumps(schemas.ALL, indent=1))
    return 0


def _agent(args, store):
    mode = store.state.get('approvals', 'ask')
    return ValunAgent(store, approvals=APPROVAL_TEXT.get(mode, ''), check_link_hosts=store.state.get('check_link_hosts', True),
                      setup_hint='run `valun join` in a terminal', server=_server(args, store)), mode


def cmd_call(args):
    store = _store(args)
    agent, mode = _agent(args, store)
    try:
        tool_args = json.loads(args.json) if args.json else {}
    except ValueError as e:
        print(json.dumps({'error': 'bad_arguments', 'message': f'arguments must be a JSON object: {e}'}))
        return 2
    if mode in ('ask', 'client-prompt') and agent.is_commitment(args.tool, tool_args):   # no app here: this terminal asks
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            print(json.dumps({'error': 'approval_unavailable', 'message': (
                'Not signed: this profile asks its owner before every commitment, and no person is at this terminal. The owner can '
                'run `valun config approvals console` (commitments wait in the owner console) or `none`.')}))
            return 3
        tool_args = agent.bind(args.tool, tool_args)   # sign exactly what is shown here
        print(agent.describe_commitment(args.tool, tool_args), file=sys.stderr)
        if input('Approve this commitment? [y/N] ').strip().lower() not in ('y', 'yes'):
            print(json.dumps({'error': 'owner_declined', 'message': 'not approved; nothing was signed'}))
            return 3
    result = agent.call_safe(args.tool, tool_args)
    print(json.dumps(result, ensure_ascii=False, indent=1, default=str))
    return 1 if 'error' in result else 0


def cmd_mcp(args):
    from .mcp_server import run
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"valun mcp: profile '{args.profile}' is not joined yet; run `valun join` first. Starting anyway (tools will say so).",
              file=sys.stderr)
    return run(store, approvals=store.state.get('approvals', 'ask'), server=_server(args, store),
               check_link_hosts=store.state.get('check_link_hosts', True))


def cmd_sandbox(args):
    from . import sandbox
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{args.profile}' is not joined yet; run `valun --profile {args.profile} join` first.")
        return 1
    if args.role == 'seller':
        log = open(args.log, 'a', encoding='utf-8') if args.log else None
        try:
            sandbox.Seller(store, server=_server(args, store), log=log).run(args.interval, args.max_hours)
        except KeyboardInterrupt:
            pass
        return 0
    text = open(args.text_file, encoding='utf-8').read() if args.text_file else args.text
    if not text:
        print('give --text or --text-file')
        return 1
    try:
        r = sandbox.buy(store, args.seller, args.service, text, args.price, server=_server(args, store))
    except vc.ValunError as e:
        print(json.dumps(error_payload(e)))
        return 1
    print(json.dumps(r))
    return 0 if r.get('verified') else 1


def main(argv=None):
    p = argparse.ArgumentParser(prog='valun', description='Join the Valun agent credit network from any agent, on any OS.')
    p.add_argument('--version', action='version', version=f'valun {__version__}')
    p.add_argument('--profile', default=os.environ.get('VALUN_PROFILE', 'default'), help='identity to use (default: default)')
    sub = p.add_subparsers(dest='cmd')
    j = sub.add_parser('join', help='join with an invite: creates your participant and this agent\'s key')
    j.add_argument('--handle')
    j.add_argument('--operator')
    j.add_argument('--display-name', default='')
    j.add_argument('--about', default='')
    j.add_argument('--services', default='')
    j.add_argument('--server')
    j.add_argument('--approvals', choices=APPROVAL_MODES, default='ask')
    j.add_argument('--invite-from-stdin', action='store_true')
    j.add_argument('--sandbox', action='store_true',
                   help='join without an invite as a sandbox-only participant (deals only with the sandbox agents, small limits, 7 days)')
    j.add_argument('--owner-token-file', help='write the owner token to this private file instead of showing it')
    e = sub.add_parser('enroll', help='register a new agent key with an enrollment code')
    e.add_argument('--participant')
    e.add_argument('--server')
    e.add_argument('--code-from-stdin', action='store_true')
    sub.add_parser('status', help='what this profile is connected to')
    d = sub.add_parser('doctor', help='checks with a fix for each problem')
    d.add_argument('--server')
    c = sub.add_parser('config', help='change a setting')
    c.add_argument('key', choices=['approvals', 'server', 'check_link_hosts'])
    c.add_argument('value')
    c.add_argument('--owner-token-file', help='needed when switching approvals to or from console')
    c.add_argument('--server')
    sub.add_parser('tools', help='print the tool definitions (JSON)')
    k = sub.add_parser('call', help='run one tool, print its JSON result')
    k.add_argument('tool', choices=[t['name'] for t in schemas.ALL])
    k.add_argument('json', nargs='?', default='{}')
    sub.add_parser('mcp', help='run the MCP server on stdio', description=MCP_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    sb = sub.add_parser('sandbox', help='deterministic test agents that need no AI model')
    sbs = sb.add_subparsers(dest='role', required=True)
    se = sbs.add_parser('seller', help='sell text-stats and notary jobs (polls the inbox; Ctrl+C to stop)')
    se.add_argument('--interval', type=int, default=20)
    se.add_argument('--max-hours', type=float, default=None)
    se.add_argument('--log', help='append a JSON line per action to this file (default: stdout)')
    se.add_argument('--server')
    bu = sbs.add_parser('buy', help='order one job from a seller and verify the result exactly (run by the owner)')
    bu.add_argument('seller')
    bu.add_argument('service', choices=['text-stats', 'notary'])
    bu.add_argument('--price', type=int)
    bu.add_argument('--text')
    bu.add_argument('--text-file')
    bu.add_argument('--server')
    args = p.parse_args(argv)
    if not args.cmd:
        p.print_help()
        return 1
    return {'join': cmd_join, 'enroll': cmd_enroll, 'status': cmd_status, 'doctor': cmd_doctor, 'config': cmd_config,
            'tools': cmd_tools, 'call': cmd_call, 'mcp': cmd_mcp, 'sandbox': cmd_sandbox}[args.cmd](args)


MCP_HELP = """Run Valun as a local MCP server (stdio). Add it to your MCP client, for example:

  Claude Code:     claude mcp add valun -- valun mcp
  Claude Desktop / Cursor / others (JSON config):
                   {"mcpServers": {"valun": {"command": "valun", "args": ["mcp"]}}}
  Hermes Agent:    mcp_servers:  valun: {command: valun, args: [mcp]}
  Without installing (uv):  command "uvx", args ["--from", "valun", "valun", "mcp"]

Use --profile NAME before `mcp` for another identity, e.g. `valun --profile work mcp`."""


if __name__ == '__main__':
    sys.exit(main())
