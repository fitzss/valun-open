"""`valun`: join the Valun network and use it from any agent, on any OS.

  valun join            invite -> participant -> agent key generated here -> credentials stored privately
  valun enroll          register a new agent key with an enrollment code from the owner console
  valun status | doctor what this profile is connected to; plain checks with a fix for each problem
  valun config KEY VAL  approvals (ask|client-prompt|console|none), server, check_link_hosts (on|off),
                        consents.setoff | consents.as_issuer | consents.as_new_creditor (on|off), consents.max_PC N,
                        consent_loop (on|off)
  valun tools           the tool definitions (JSON), for any agent framework
  valun call TOOL JSON  run one tool and print its JSON result (for agents that have a shell)
  valun mcp             run the local MCP server on stdin/stdout (for MCP clients)
  valun clearing status|run|watch   circulating credit: what your client signs by itself, and signing it now
  valun policy show     the consent policy in force (local policy and owner mandate; the stricter applies)
  valun attempts list | resolve DEAL ATTEMPT --not-applied|--applied
                        the payment attempts your client records; the OWNER resolves one whose outcome is unknown
  valun sandbox ...     deterministic sandbox agents: seller, buy, earn, tour
Add --profile NAME to keep several identities apart. Secrets are never printed (the owner token is shown once at
join, or written to --owner-token-file).
"""
import argparse
import getpass
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

from . import __version__
from . import agent as va
from . import client as vc
from . import schemas
from .agent import ValunAgent, error_payload
from .home import APPROVAL_MODES, DEFAULT_SERVER, home_dir, permission_problem, profile_path
from .mcp_server import APPROVAL_TEXT
from .ai_seller import SERVICE_SPECS

JOIN_APPROVALS = {
    'ask': 'Approvals: before each offer, acceptance or credit note you are asked (in your MCP app, or in this terminal for `valun call`).',
    'client-prompt': "Approvals: your MCP app's own tool confirmation asks you; never 'always allow' the Valun signing tools.",
    'console': ('Approvals: every commitment waits for you in the owner console ({server}/pilot#owner), including accepting a '
                'delivery: its credit note is issued only after you approve it.'),
    'none': 'Approvals: none. Your agent acts on its own within your limits (at most {per_deal} PC per deal, {total} PC owed in total).',
}


def _store(args):
    return vc.FileStore(profile_path(args.profile))


def _profile(args):
    """This profile's name as profile_path() reads it ('default' for an empty --profile or VALUN_PROFILE), for the
    commands `valun join` and the not-joined hints print (`valun --profile NAME ...`): run elsewhere, whatever
    VALUN_PROFILE says there, each acts on this identity."""
    return (args.profile or 'default').strip().lower()


def _server(args, store):
    return (getattr(args, 'server', None) or store.state.get('server') or os.environ.get('VALUN_SERVER') or DEFAULT_SERVER).rstrip('/')


def _write_private(path, text):
    """Create `path` as a new private file (0600) holding `text`. An existing file is never replaced (O_EXCL: it may
    hold another identity's owner token; FileExistsError). If writing fails, the file this call created is removed."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        try:
            f = os.fdopen(fd, 'w', encoding='utf-8')
        except BaseException:
            os.close(fd)
            raise
        with f:
            f.write(text)
    except BaseException:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


def _approval_mandate(mode, cap):
    """The owner-mandate change when approvals switch to or from console. Console holds every commitment for the
    owner: every price (approve_above 0) and every accepted delivery, whose credit note waits for the owner's review
    (review_deliveries). Leaving console restores approve_above only: review_deliveries is the owner's own setting too
    (it can be chosen in the owner console), so it is left as it is and the owner is told how to turn it off."""
    if mode == 'console':
        return {'approve_above': 0, 'review_deliveries': True}
    return {'approve_above': cap}


def _pin(client):
    """Read /info once: the client pins the network's tracker and unit in the profile (a later change is refused).
    Returns the feature tags it lists ([] when it lists none or cannot be read)."""
    try:
        return va.features_of(client.info())
    except vc.ValunError:
        return []


def _on(value):
    """A config value as a boolean: on/off (also true/false, yes/no, 1/0); None for anything else."""
    v = str(value).strip().lower()
    return True if v in ('on', 'true', '1', 'yes') else False if v in ('off', 'false', '0', 'no') else None


def cmd_join(args):
    store = _store(args)
    if store.state.get('participant_id'):
        print(f"Profile '{args.profile}' is already connected to {store.state['participant_id']}. "
              'Use --profile NAME for a second identity.')
        return 1
    server = _server(args, store)
    if not args.sandbox and not args.invite_from_stdin:
        print('No invite code? Anyone can join without one: stop here (Ctrl+C) and run `valun join --sandbox`.')
    invite = None if args.sandbox else (sys.stdin.readline() if args.invite_from_stdin else getpass.getpass('Invite code (not shown): ')).strip()
    handle = args.handle or input('Handle (public, permanent; 3-24 letters, digits, _ or -, starting with a letter): ').strip().lower()
    operator = args.operator or input('Operator (public: who controls this agent, e.g. your name): ').strip()
    c = vc.Client(store, server)
    try:
        if args.sandbox:   # no invite: a sandbox-only participant (only where the server offers it)
            j = c.join_sandbox(handle, operator, display_name=args.display_name, about=args.about, services=args.services)
        else:
            j = c.join(invite, handle, operator, display_name=args.display_name, about=args.about, services=args.services)
    except vc.ValunError as e:
        print(f'Joining failed ({e.code}): {e}')
        return 1
    owner = j.get('owner_token') if isinstance(j, dict) else None
    if not (isinstance(owner, str) and owner):
        print('Joining failed (bad_response): the server did not answer an owner token.')
        return 1
    # Decision D-3 c: from here on the participant exists, and its owner token is in this answer only. It is handed over
    # first (_hand_over: written to --owner-token-file, or shown), before any local write that can fail (the agent's
    # key, the profile, the pins); whatever fails after this, join says what is not done and exits 1.
    handed = _hand_over(args, owner, server)
    step = ['enroll']
    try:
        finished = _join_steps(args, store, c, j, server, handle, owner, step)
    except Exception as e:  # noqa: BLE001 - the owner token is handed over already: say what stopped, never a traceback
        name, pid = _profile(args), _terminal_text(j.get('participant_id') or 'PARTICIPANT_ID', 40)
        print(f'Joining stopped ({_failure(e)}): {_terminal_text(e)}')
        print(f'  Your participant {pid} exists, and your owner token was handed over above. Not done: '
              + JOIN_NOT_DONE[step[0]].format(name=name, server=server, pid=pid) + '.')
        if step[0] == 'mandate' and args.clearing == 'off':
            _no_setoff_after_stop(store, name)
        print(f'Then run `valun --profile {name} doctor`.')
        finished = False
    if not handed:
        print(f'Exit code 1: {args.owner_token_file} was not written (your owner token is shown above instead).')
    return 0 if finished and handed else 1


# What a join that stopped on an unexpected error (a disk that is full, say) had not done yet, by the step it was in
# (cmd_join; decision D-3 c). Each leaves the profile on the safe side, and says how to finish.
JOIN_NOT_DONE = {
    'enroll': ("registering and storing this agent's key: issue an enrollment code in the owner console "
               '({server}/pilot#owner) with your owner token, then run `valun --profile {name} enroll --server {server} '
               '--participant {pid}`'),
    'settings': ("this profile's settings (until they are set it asks before each commitment, and its client signs no "
                 'consent by itself) and your owner mandate (approvals, auto_clear): set them with `valun --profile {name} '
                 'config ...` and in the owner console ({server}/pilot#owner)'),
    'mandate': ("your owner mandate's approve_above and auto_clear: set them in the owner console ({server}/pilot#owner) "
                '(with --approvals console this profile asks before each commitment until then)'),
    'approvals': ('console approvals in this profile: it asks before each commitment until you run '
                  '`valun --profile {name} config approvals console --owner-token-file FILE` (FILE: the file holding your '
                  'owner token)'),
    'clearing': ('consents.setoff off in this profile, so its client may still sign set-offs by itself: run '
                 '`valun --profile {name} config consents.setoff off`'),
    'report': 'nothing that join sets (only the rest of its report)',
}


def _failure(e):
    """What failed, as one word for this terminal: a ValunError's code, else the exception's class (OSError, say)."""
    return e.code if isinstance(e, vc.ValunError) else type(e).__name__


def _no_setoff_after_stop(store, name):
    """`valun join --clearing off` stopped in the mandate step (an OSError while it pinned the network, say), so auto_clear
    was not turned off: as when the mandate request fails (_mandate_not_set), this profile's client then signs no set-off
    by itself (consents.setoff off). When even that cannot be written, join prints the command that does it."""
    try:
        store.update(_no_setoff)
    except Exception as e:  # noqa: BLE001 - say how to do it instead
        print(f'  Not done either ({_failure(e)}): ' + JOIN_NOT_DONE['clearing'].format(name=name) + '.')
        return
    print('  Clearing: auto_clear was not turned off, so your client signs no set-off by itself (consents.setoff off); '
          'turn auto_clear off in the owner console too.')


def _key_stored(args, participant_id):
    """Does this profile, as saved on disk, hold this participant's agent key and token? (An enrolment whose request
    and first save succeeded, although a later save of the same profile failed.)"""
    try:
        disk = _store(args)
    except Exception:  # noqa: BLE001 - an unreadable profile holds nothing usable
        return False
    return bool(disk.state.get('participant_id') == participant_id and disk.secret() and disk.token())


def _join_steps(args, store, c, j, server, handle, owner, step):
    """`valun join` once its owner token was handed over: register this agent's key, save the profile, pin the network,
    set the owner mandate, and say what is in force. step[0] names the step it is in, for cmd_join's message when an
    unexpected error stops it. Returns True when every step was done; False after saying what is not done and how to
    finish it (with commands that name this profile)."""
    pid = j['participant_id']
    try:
        r = c.enroll(pid, j['enrollment_code'])
    except Exception as e:  # noqa: BLE001 - a request refused, or a key that could not be stored (OSError)
        if not _key_stored(args, pid):
            # The profile is not saved (it holds no key), so the command names the server as well as the profile.
            enroll = f'`valun --profile {_profile(args)} enroll --server {server} --participant {pid}`'
            if isinstance(e, vc.ValunError):    # refused, or never reached the server: no key is registered
                print(f"Your participant {pid} was created, but this agent's key could not be registered "
                      f'({_failure(e)}): {_terminal_text(e)}')
                print(f'To finish: issue an enrollment code in the owner console ({server}/pilot#owner) with your owner '
                      f'token, then run {enroll}.')
                return False
            # Not the request: the server registered the key (its answer reached this client, which then holds the
            # participant id) or may have (no answer was read), and the key was not stored here. While a key is
            # registered the server refuses a new enrollment code (already_enrolled); revoking the agent gives one.
            held = 'holds' if c.state.get('participant_id') == pid else 'may hold'
            print(f"Your participant {pid} was created, and the server {held} this agent's key, but the key could not be "
                  f'stored here ({_failure(e)}): {_terminal_text(e)}')
            print(f'To finish: in the owner console ({server}/pilot#owner), with your owner token, revoke this agent, which '
                  'gives a new enrollment code (a new code is refused while a key is registered)'
                  + ('' if held == 'holds' else '; if the console shows no agent key, issue an enrollment code instead')
                  + f', then run {enroll}.')
            return False
        # The key was registered and stored; a later save of the same profile failed. Go on with the profile as saved.
        store = _store(args)
        c = vc.Client(store, server)
        r = {'pubkey': str(store.state.get('pubkey') or '')}
    # The local consent policy (design 6.6): an invited participant's client signs set-offs and transfers of its own debt
    # by itself; a sandbox participant's client also accepts payments by transfer, and its MCP server runs the consent
    # loop. The owner's mandate must allow each role too (the stricter applies); `valun policy show` shows both.
    # Console approvals are recorded only once the mandate holds every commitment for the owner (below); until then
    # this profile asks (the default), so that a mandate step that fails leaves it on the safe side.
    step[0] = 'settings'
    store.state.update({'server': server, 'approvals': 'ask' if args.approvals == 'console' else args.approvals,
                        'check_link_hosts': True,
                        'consent_policy': dict(va.SANDBOX_CONSENT_POLICY if args.sandbox else va.INVITE_CONSENT_POLICY),
                        'consent_loop': 'on' if args.sandbox else 'off'})
    store.save()
    print(f"Joined Valun as {handle} ({pid}) on {server}. This agent's key was generated here; "
          f"public key {r['pubkey'][:16]}...")
    print(f'Credentials are stored privately in {profile_path(args.profile)} (not shown).')
    if j.get('sandbox_only'):
        print(j.get('note') or 'Sandbox only: you can deal with the sandbox agents for a week.')
    step[0] = 'mandate'
    try:
        c.me()          # the agent's first call: it shows as active in the directory from now on
    except vc.ValunError:
        pass
    # The pin step: GET /info pins the network's tracker and unit in the profile and says whether the server offers
    # circulating credit. When it cannot be read (a 429, say), that is not known: auto_clear is then not sent (a server
    # without circulating credit has no such field), so an explicit --clearing is not applied (below).
    try:
        circulating, unread = va.CIRCULATION in va.features_of(c.info()), None
    except vc.ValunError as e:
        circulating, unread = False, e
    clearing = args.clearing or 'auto'
    # The owner token is used here once, in memory, to set where approvals happen (and, where the server offers
    # circulating credit, whether set-offs clear this participant's cycles: auto_clear); it is never stored in the profile.
    try:
        got = c.request('GET', '/pilot/v1/owner', token=owner)
        limits = got.get('mandate') if isinstance(got, dict) else None
        if not isinstance(limits, dict):
            raise vc.ValunError('bad_response', 'GET /owner did not answer the owner mandate')
        cap = max(limits.get('max_issue_per_deal', 0), limits.get('max_accept_per_deal', 0))
        body = _approval_mandate(args.approvals, cap)
        if circulating:
            body['auto_clear'] = clearing == 'auto'
        c.request('PUT', '/pilot/v1/owner/mandate', body, token=owner)
    except vc.ValunError as e:
        step[0] = 'clearing'
        _mandate_not_set(args, store, e, server, circulating or unread is not None, clearing)
        return False
    if args.approvals == 'console':
        step[0] = 'approvals'
        store.update(lambda state: state.update(approvals='console'))
    step[0] = 'report'
    print(JOIN_APPROVALS[args.approvals].format(server=server, per_deal=limits.get('max_issue_per_deal'),
                                                total=limits.get('max_issue_outstanding')))
    finished, name = True, _profile(args)
    if circulating:
        print(f'Clearing: {clearing}. ' + ('Your Valun client signs set-offs that leave your net position unchanged, and '
                                           'transfers of your own debt, by itself; ' if clearing == 'auto' else
                                           'set-offs are off in your owner mandate; ')
              + (f'it also accepts payments by transfer (notes your owner mandate accepts), and `valun --profile {name} mcp` '
                 'signs them in the background (consent_loop on). ' if args.sandbox else
                 'payments to you by transfer are off until you turn them on. ')
              + f'See `valun --profile {name} policy show`; change it with `valun --profile {name} config consents.<role> '
                'on|off`.')
    elif unread is not None and args.clearing:
        # Not known whether the server offers circulating credit: --clearing is not in force, and with off this
        # profile's client signs no set-off by itself (as when the mandate step fails), whatever auto_clear says.
        finished = False
        print(f'Clearing: whether this server offers circulating credit could not be read ({unread.code}), so '
              f'--clearing {clearing} was not set in your owner mandate (auto_clear).')
        if clearing == 'off':
            step[0] = 'clearing'
            store.update(_no_setoff)
            print('  Your client signs no set-off by itself (consents.setoff off); if the server offers circulating '
                  f'credit, turn auto_clear off in the owner console ({server}/pilot#owner) too.')
        else:
            print(f'  If the server offers circulating credit, auto_clear is in the owner console ({server}/pilot#owner).')
    elif args.clearing:
        print('This server does not offer circulating credit yet, so --clearing changes nothing now; once it does, '
              'auto_clear is set in the owner console.')
    print(f'Next: `valun --profile {name} doctor`, then add `valun --profile {name} mcp` to your agent (see '
          '`valun mcp --help`).')
    return finished


def _hand_over(args, owner, server):
    """The owner token, to the owner, once: written to --owner-token-file (a new private file), or shown. A file that
    cannot be written, or that exists already (it is never replaced: it may hold another identity's owner token), does
    not lose it: it is shown instead, and False is returned (join then exits 1 once its other steps are done, so that a
    script that relies on the file notices). True otherwise."""
    if args.owner_token_file:
        try:
            _write_private(args.owner_token_file, owner + '\n')
            print(f'Your OWNER token is in {args.owner_token_file}. Keep it private; never give it to your agent.')
            return True
        except FileExistsError:
            print(f'{args.owner_token_file} exists already, so it was not replaced (it may hold another owner token); '
                  'your owner token is shown here instead.')
        except OSError as e:
            print(f'Cannot write {args.owner_token_file} ({e.strerror or e}), so your owner token is shown here instead.')
    print('Your OWNER token (shown once; keep it in a password manager, never give it to your agent; it opens '
          f'{server}/pilot#owner where you can change limits or revoke this agent):')
    print('  ' + owner)
    return not args.owner_token_file


def _no_setoff(state):
    """consents.setoff off in the profile's local consent policy (its other roles as they are)."""
    policy = state.get('consent_policy')
    state['consent_policy'] = dict(policy if isinstance(policy, dict) else {}, setoff=False)


def _mandate_not_set(args, store, e, server, circulating, clearing):
    """`valun join` after GET /owner or PUT /owner/mandate failed (a 429, say): the participant and this agent's key
    exist and the owner token was handed over already, so this says what is not in force and how to finish it, with
    commands that name this profile. The profile stays on the safe side: console approvals are not recorded (it asks
    before each commitment, the default, until the mandate holds them for the owner), and with --clearing off its client
    signs no set-off (consents.setoff off) while auto_clear is not set (circulating: the server offers circulating
    credit, or whether it does could not be read)."""
    name = _profile(args)
    print(f'Your owner mandate could not be set ({e.code}): {_terminal_text(e)}')
    if args.approvals == 'console':
        print('  Approvals: not yet held in the owner console, so this profile asks before each commitment (approvals '
              f'ask) until you run `valun --profile {name} config approvals console --owner-token-file FILE` (FILE: the '
              'file holding your owner token).')
    else:
        print(f'  Approvals: {args.approvals}; approve_above in your owner mandate was not set, so the owner console may '
              f'hold some commitments for you until you set it there ({server}/pilot#owner).')
    if circulating and clearing == 'off':
        store.update(_no_setoff)
        print('  Clearing: auto_clear was not turned off, so your client signs no set-off by itself (consents.setoff '
              'off); turn auto_clear off in the owner console too.')
    print(f'Then run `valun --profile {name} doctor`.')


def cmd_enroll(args):
    store = _store(args)
    if store.token() and store.secret():
        print(f"Profile '{args.profile}' already holds an agent key. Revoke it in the owner console first, or use --profile.")
        return 1
    server = _server(args, store)
    participant = (args.participant or input('Participant id (vp_..., from your owner console): ')).strip()
    code = (sys.stdin.readline() if args.code_from_stdin else getpass.getpass('Enrollment code (not shown): ')).strip()
    c = vc.Client(store, server)
    try:
        r = c.enroll(participant, code)
    except vc.ValunError as e:
        print(f'Enrollment failed ({e.code}): {e}')
        return 1
    store.state.update({'server': server})
    store.state.setdefault('approvals', 'ask')
    store.save()
    _pin(c)
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
    if isinstance(st.get('consent_policy'), dict) or 'consent_loop' in st:
        print(f"consents:         {_policy_line(st.get('consent_policy'))}; consent loop: {st.get('consent_loop', 'off')}")
    return 0


def _policy_line(policy):
    """The local consent policy in one line."""
    p = policy if isinstance(policy, dict) else {}
    on = lambda k: 'on' if p.get(k) is True else 'off'  # noqa: E731
    cap = p.get('max_PC')
    return (f"setoff {on('setoff')}, as_issuer {on('as_issuer')}, as_new_creditor {on('as_new_creditor')}, "
            f"max_PC {cap if cap is not None else 'none'}")


def cmd_doctor(args):
    store = _store(args)
    path = profile_path(args.profile)
    name = _profile(args)
    ok, problems = [], []
    ok.append(f'Valun {__version__}, Python {sys.version.split()[0]} on {sys.platform}; profiles in {home_dir()}')
    perm = permission_problem(path)
    (problems.append(perm) if perm else ok.append('Profile file permissions: private'))
    server = _server(args, store)
    try:
        info = vc.Client(_Mem(), server).request('GET', '/pilot/v1/info', auth=False)
        ok.append(f"Server {server} reachable: {info['network']}, unit {info['unit']} (synthetic)")
        pins = store.state.get('pins')
        if isinstance(pins, dict) and pins.get('tracker_nft_id'):
            if (pins.get('tracker_nft_id'), pins.get('denomination')) == (info.get('tracker_nft_id'), info.get('denomination')):
                ok.append('Tracker and unit: the ones pinned in this profile')
            else:
                problems.append('The server names a different tracker or unit than the ones pinned in this profile, so this '
                                'agent signs nothing (tracker_mismatch). Only if you know the network moved: '
                                f'`valun --profile {name} config server URL` pins it again.')
    except Exception as e:  # noqa: BLE001
        problems.append(f'Server {server} not reachable ({e}). Check `valun --profile {name} config server URL` and your '
                        'connection.')
    if store.state.get('participant_id') and store.secret() and store.token():
        try:
            me = vc.Client(store, server).me()
            m = me['mandate']
            ok.append(f"Agent accepted by the server as {me['participant']['handle']}; limits: at most {m['max_issue_per_deal']} PC "
                      f"per deal, {m['max_issue_outstanding']} PC owed in total")
            if me['participant'].get('status') != 'active':
                problems.append('The agent key is not active: ask the owner for an enrollment code, then '
                                f'`valun --profile {name} enroll`.')
        except Exception as e:  # noqa: BLE001
            problems.append(f'The server refused this agent ({getattr(e, "code", e)}): if the owner revoked it, '
                            f'`valun --profile {name} enroll` again.')
    else:
        problems.append(f'Not connected: run `valun --profile {name} join --sandbox` (no invite: sandbox only), '
                        f'`valun --profile {name} join` (with an invite) or `valun --profile {name} enroll` (with an '
                        'enrollment code).')
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
            owner = _owner_token(args)
            if owner is None:
                return 1
            c = vc.Client(store, _server(args, store))
            try:
                # An owner token changes the mandate of its own participant: it must be this profile's participant's,
                # or this profile would stop asking (console) while another participant's mandate changed (not_owner).
                m = c._check_owner(owner).get('mandate')
                if not isinstance(m, dict):
                    raise vc.ValunError('bad_response', 'GET /owner did not answer the owner mandate; nothing was changed')
                cap = max(m.get('max_issue_per_deal', 0), m.get('max_accept_per_deal', 0))
                c.request('PUT', '/pilot/v1/owner/mandate', _approval_mandate(val, cap), token=owner)
            except vc.ValunError as e:
                print(f'Could not change the mandate ({e.code}): {e}')
                if e.code == 'not_owner':
                    pid = store.state.get('participant_id') or 'none: it is not joined'
                    print(f"  Profile '{_profile(args)}' needs the owner token of its participant ({pid}); "
                          '`valun --profile NAME config ...` changes another profile.')
                return 1
            if val == 'console':
                print('Owner mandate updated: every commitment now waits for you in the owner console, including accepted '
                      'deliveries (their credit notes wait for your review).')
            else:
                print(f'Owner mandate updated: commitments up to {cap} PC no longer wait in the console.'
                      + (' Accepted deliveries still wait for your review (review_deliveries is on); turn that off in the '
                         f'owner console ({_server(args, store)}/pilot#owner) if you no longer want it.' if m.get('review_deliveries') else ''))
        changes = {'approvals': val}
    elif key == 'server':
        changes = {'server': val.rstrip('/')}
    elif key == 'check_link_hosts':
        changes = {'check_link_hosts': val.lower() in ('on', 'true', '1', 'yes')}
    elif key == 'brief_status':
        flag = _on(val)
        if flag is None:
            print('brief_status must be on or off')
            return 1
        changes = {'brief_status': flag}
    elif key in ('consents.setoff', 'consents.as_issuer', 'consents.as_new_creditor', 'consent_loop'):
        flag = _on(val)
        if flag is None:
            print(f'{key} must be on or off')
            return 1
        changes = {'consent_loop': 'on' if flag else 'off'} if key == 'consent_loop' else {key: flag}
    elif key == 'consents.max_PC':
        if val.strip().lower() == 'none':
            changes = {key: None}
        elif val.strip().isdigit() and int(val) <= 100000:
            changes = {key: int(val)}
        else:
            print('consents.max_PC must be a whole number of PC (0..100000), or none for no cap')
            return 1
    else:
        print('keys: approvals, server, check_link_hosts, brief_status, consents.setoff, consents.as_issuer, '
              'consents.as_new_creditor, consents.max_PC, consent_loop')
        return 1

    def apply(state):       # on the profile as it is now (another process, such as `valun mcp`, may have changed it)
        if key == 'server':
            state.pop('pins', None)     # the owner chose the network: its tracker and unit are pinned again on the next call
        if key.startswith('consents.'):
            # A profile without a policy yet (0.3, or `valun enroll`) starts from every role off.
            policy = state.get('consent_policy')
            policy = dict(policy) if isinstance(policy, dict) else {'setoff': False, 'as_issuer': False, 'as_new_creditor': False}
            policy[key.split('.', 1)[1]] = changes[key]
            if policy.get('max_PC') is None:
                policy.pop('max_PC', None)
            state['consent_policy'] = policy
        else:
            state.update(changes)
    store.update(apply)
    if key.startswith('consents.'):
        print(f"{key} = {_shown_value((store.state.get('consent_policy') or {}).get(key.split('.', 1)[1]))}  "
              f"({_policy_line(store.state.get('consent_policy'))})")
        if key == 'consents.as_new_creditor' and changes[key]:
            print('Payments to you by transfer also need your owner mandate to allow them (accept_transfers and '
                  'accept_notes_from, in the owner console); the stricter of the two applies.')
    else:
        print(f'{key} = {store.state[key]}')
        if key == 'consent_loop':
            print(f'The consent loop runs inside `valun --profile {_profile(args)} mcp` (restart it to start the loop); it '
                  'signs only what your consent policy and owner mandate allow.')
        if key == 'brief_status':
            print('valun_status now answers its ' + ('brief view (for small models); a call can still pass brief=false.'
                                                    if store.state[key] else 'full view; a call can still pass brief=true.')
                  + f' Restart `valun --profile {_profile(args)} mcp` for your MCP app to use it.')
    return 0


def _shown_value(v):
    return 'on' if v is True else 'off' if v is False else 'none' if v is None else str(v)


def cmd_tools(args):
    print(json.dumps(schemas.ALL, indent=1))
    return 0


def _agent(args, store):
    """The agent for `valun call`: one tool run, with no consent loop behind it, so before valun_status and valun_inbox
    it also signs the value-safe consents (consents_on_reads; decision D-3 a)."""
    mode = store.state.get('approvals', 'ask')
    return ValunAgent(store, approvals=APPROVAL_TEXT.get(mode, ''), check_link_hosts=store.state.get('check_link_hosts', True),
                      setup_hint=f'run `valun --profile {_profile(args)} join` in a terminal', server=_server(args, store),
                      consents_on_reads=True, brief_status=store.state.get('brief_status') is True), mode


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
            name = _profile(args)
            print(json.dumps({'error': 'approval_unavailable', 'message': (
                'Not signed: this profile asks its owner before every commitment, and no person is at this terminal. The owner can '
                f'run `valun --profile {name} config approvals console --owner-token-file FILE` (commitments wait in the owner '
                f'console; FILE: the file holding the owner token) or `valun --profile {name} config approvals none`.')}))
            return 3
        prepared, refusal = agent.prepare_or_refusal(args.tool, tool_args)   # sign exactly what is shown here, read once
        if refusal:                                     # nothing is signed, and nobody is asked with a generic text
            print(json.dumps(refusal, ensure_ascii=False, indent=1, default=str))
            return 3
        tool_args = prepared['args']
        if prepared['text'] is not None:                # None: the read prepare() made shows this call commits nothing
            print(prepared['text'], file=sys.stderr)
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
        print(f"valun mcp: profile '{_profile(args)}' is not joined yet; run `valun --profile {_profile(args)} join` first. "
              'Starting anyway (tools will say so).', file=sys.stderr)
    return run(store, approvals=store.state.get('approvals', 'ask'), server=_server(args, store),
               check_link_hosts=store.state.get('check_link_hosts', True),
               setup_hint=f'run `valun --profile {_profile(args)} join` in a terminal',
               brief_status=store.state.get('brief_status') is True)


def _connected(args):
    """The profile's store and a client, or (store, None) after saying how to join."""
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret() and store.token()):
        print(f"Profile '{_profile(args)}' is not joined yet; run `valun --profile {_profile(args)} join` first.")
        return store, None
    return store, vc.Client(store, _server(args, store))


def _decisions(report):
    """process_consents() decisions, one line each."""
    lines = []
    for bucket in ('signed', 'refused', 'waiting'):
        for e in report.get(bucket) or []:
            what = f"{e.get('kind')} {e.get('id')} as {e.get('role')}"
            if e.get('amount') is not None:
                what += f", {e.get('amount')} PC (your net change {e.get('your_net_change_PC')} PC)"
            why = e.get('code') or e.get('reason') or ''
            lines.append(f'  {bucket:8} {what}' + (f': {why}' if why and bucket != 'signed' else ''))
    return lines


def cmd_clearing(args):
    """valun clearing status|run|watch: circulating credit as this profile's client takes part in it."""
    store, c = _connected(args)
    if c is None:
        return 1
    try:
        features = va.features_of(c.info())
    except vc.ValunError as e:
        print(f'Cannot read the server ({e.code}): {e}')
        return 1
    if va.CIRCULATION not in features:
        print('This Valun server does not offer circulating credit (circulation/1): there is nothing to clear or consent to.')
        return 0
    if args.action == 'status':
        try:
            me = c.me()
            items = c.consents().get('consents') or []
        except vc.ValunError as e:
            print(f'Cannot read your consents ({e.code}): {e}')
            return 1
        policy = va.consent_policy_in_force(store.state.get('consent_policy'),
                                            next((me[k] for k in ('effective_limits', 'mandate') if isinstance(me.get(k), dict)), None))
        signs = va.client_signs(policy)
        pos = me.get('position') if isinstance(me.get('position'), dict) else {}
        print('Your Valun client signs by itself: ' + ('; '.join(signs) if signs else 'nothing (every consent role is off)'))
        print(f"Consents waiting for your client: {len([i for i in items if isinstance(i, dict) and i.get('state') == 'collecting'])}")
        print(f"Cleared by set-off so far: {pos.get('cleared_by_setoff', pos.get('settled', 0))} PC; you hold "
              f"{pos.get('claims_held')} PC and owe {pos.get('owes')} PC (net {pos.get('net')} PC).")
        log = store.state.get('consent_log') if isinstance(store.state.get('consent_log'), list) else []
        if log:
            print('Recent decisions of your client:')
            for e in log[-10:]:
                if isinstance(e, dict):
                    print(f"  {e.get('at')}  {e.get('decision'):8} {e.get('kind')} {e.get('id')} as {e.get('role')}"
                          + (f" ({e.get('code')})" if e.get('code') else ''))
        name = _profile(args)
        print(f"Consent loop in `valun --profile {name} mcp`: {store.state.get('consent_loop', 'off')}. "
              f'`valun --profile {name} clearing run` signs now.')
        return 0
    if args.action == 'run':
        try:
            r = c.process_consents()
        except vc.ValunError as e:
            print(json.dumps(error_payload(e)))
            return 1
        lines = _decisions(r)
        print('\n'.join(lines) if lines else 'Nothing waits for your client.')
        return 0
    print(f'Signing what your policy allows every {args.interval} s (Ctrl+C to stop).')
    try:
        while True:
            try:
                for line in _decisions(c.process_consents()):
                    if not line.lstrip().startswith('waiting'):
                        print(time.strftime('%H:%M:%S') + line)
            except vc.ValunError as e:
                print(f"{time.strftime('%H:%M:%S')}  {e.code}: {e}")
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0


def cmd_policy(args):
    """valun policy show: the consent policy in force, role by role (local policy and owner mandate)."""
    store = _store(args)
    local, name = store.state.get('consent_policy'), _profile(args)
    print(f'Local consent policy (this profile; `valun --profile {name} config consents.<role> on|off`): {_policy_line(local)}')
    print(f"Consent loop in `valun --profile {name} mcp` (`valun --profile {name} config consent_loop on|off`): "
          f"{store.state.get('consent_loop', 'off')}")
    mandate = None
    if store.state.get('participant_id') and store.secret() and store.token():
        try:
            c = vc.Client(store, _server(args, store))
            if va.CIRCULATION not in va.features_of(c.info()):
                print('This Valun server does not offer circulating credit (circulation/1): no consent is signed.')
                return 0
            me = c.me()
            mandate = next((me[k] for k in ('effective_limits', 'mandate') if isinstance(me.get(k), dict)), None)
        except vc.ValunError as e:
            print(f'Cannot read your owner mandate ({e.code}): {e}')
            return 1
    if mandate is None:
        print('Owner mandate: not read (this profile is not connected); nothing is signed without it.')
        return 0
    p = va.consent_policy_in_force(local, mandate)
    print('Owner mandate (the owner console): ' + ', '.join(f'{k} {_shown_value(v)}' if not isinstance(v, list) else
                                                             f"{k} {','.join(map(str, v)) or '[]'}"
                                                             for k, v in p['owner_mandate'].items()))
    for role, flag, what in (('setoff', 'auto_clear', 'set-offs (net-neutral)'),
                             ('as_issuer', 'novate_own_debt', 'transfers of your own debt'),
                             ('as_new_creditor', 'accept_transfers', 'payments to you by transfer')):
        print(f"  {what}: {'signed by your client' if p[role] else 'not signed'} (local {_shown_value((local or {}).get(role) if isinstance(local, dict) else None)}, "
              f"owner {flag} {_shown_value(mandate.get(flag))})")
    return 0


ATTEMPT_STATES = {'applied': 'applied: the deal is paid by it',
                  'unknown': 'MAY HAVE APPLIED: your client pays this deal no more until you resolve it',
                  'alive': 'can still apply',
                  'dead': 'did not apply (and can no longer)',
                  'unread': 'not known yet: its edge has not been read since its window closed'}
# An 'unknown' attempt of a deal recorded as paid: the deal is never paid again, so it blocks nothing and there is
# nothing for the owner to resolve. (D-2 a: a raise of an incoming edge needs no signature of this client, so its own
# records cannot prove such an attempt dead; the server proves it from its journal.)
UNKNOWN_BUT_PAID = "cannot be proven dead from your client's records, but the deal is {paid}: nothing to resolve"
# An 'unknown' attempt the server ended before it ever reached the tracker (Client.attempts_overview ended_at_server,
# vc.NEVER_APPLIED_TRANSFER): shown as ended there, with no resolution advised. It is the server's word: the client
# still judges by the tracker's state and its own records (R11), so it still counts the attempt when the deal is paid.
ENDED_AT_SERVER_WHY = {'void_rejected': 'your owner rejected it, before anyone else signed',
                       'void_stale': 'it was out of date when your owner approved it',
                       'void_expired': 'it expired while it waited for your owner',
                       'expired': 'it expired before every party had signed',
                       'cancelled': 'your client cancelled it while it collected signatures',
                       'refused': 'the issuer or the payee refused to sign it',
                       'void_key_revoked': "a party's key was revoked before it was submitted"}
ENDED_AT_SERVER = ('ended by the server ({state}: {why}), which says it never reached the tracker, so it did not apply; '
                   "your client cannot check that on the tracker, so it still pays this deal no more by itself")
ENDED_AT_SERVER_PAID = ('ended by the server ({state}: {why}), which says it never reached the tracker; the deal is '
                        '{paid}: nothing to resolve')


def _who_key(c, pk):
    return 'you' if pk == c.pubkey else f'{str(pk)[:16]}...'


def _attempt_line(c, r):
    """One payment attempt of `valun attempts list`, in plain words."""
    i, rcp = (r['edge'].split('>') + [''])[:2]
    when = datetime.fromtimestamp(r['timestamp'] / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    if r['route'] == 'note':
        what = (f"your credit note to {_who_key(c, rcp)}: your debt {r['prior'] if r['prior'] is not None else '?'} -> "
                f"{r['total']} PC")
    else:
        what = (f"paying with the note of {_who_key(c, i)}: your claim {r['prior'] if r['prior'] is not None else '?'} -> "
                f"{r['total']} PC")
    sid = f", server id {r['attempt_id']}" if r.get('attempt_id') else ''
    decided = f"; you resolved it: {r['outcome']}" if r.get('outcome') in vc.ATTEMPT_OUTCOMES and r.get('outcome') != 'applied' else ''
    paid = f"paid by {r['paid_by']}" if r.get('paid_by') else 'recorded as paid'
    ended = r.get('ended_at_server') if r['state'] == 'unknown' else None
    if ended in ENDED_AT_SERVER_WHY:
        state = (ENDED_AT_SERVER_PAID if r.get('paid') else ENDED_AT_SERVER).format(
            state=ended, why=ENDED_AT_SERVER_WHY[ended], paid=paid)
    elif r['state'] == 'unknown' and r.get('paid'):
        state = UNKNOWN_BUT_PAID.format(paid=paid)
    else:
        state = ATTEMPT_STATES.get(r['state'], r['state'])
    return f"  {r['ref']} {what}, signed for {when}{sid}: {state}{decided}"


def _edges_now(c):
    """A read-back of this profile's edges, each state checked by its client (sync_edges: {'edges', 'doubtful'}), where
    the server offers bound notes or circulating credit; {} when there is none to read or it cannot be read now."""
    try:
        features = va.features_of(c.info())
    except vc.ValunError as e:
        print(f'Cannot read the server ({e.code}); going by what your records hold.')
        return {}
    if 'bound_notes/1' not in features and va.CIRCULATION not in features:
        return {}
    try:
        read = c.sync_edges()
    except vc.ValunError as e:
        print(f'Cannot read your edges ({e.code}); going by what your records hold.')
        return {}
    return {'edges': read['edges'], 'doubtful': read['doubtful']}


# Why a resolution changes only your client's records (Client.resolution_plan local), for `valun attempts resolve`.
LOCAL_WHY = {
    'note': 'The server holds no payment attempt for a credit note: only your client\'s records change (your owner token '
            'is checked first, used once and not stored).',
    'no_circulation': 'This server offers no circulating credit, so only your client\'s records change (your owner token '
                      'is checked first, used once and not stored).',
    'no_server_id': "Your client did not record the server's id of this transfer (its request got no answer, or the "
                    'server refused it). If the owner console shows a transfer of this deal (vt_...), stop here and run '
                    'this again with that id, so that the server records your decision too.',
    'server_unknown': 'The server shows no such transfer of yours as this attempt (it may have refused it when it was '
                      'posted).',
    'server_ended': 'The server holds this transfer as {state}: it ended there, so the server has nothing to resolve; '
                    'your client still counts it as a payment that may have applied.',
}
# LOCAL_WHY['server_ended'] for a transfer the server ended before it ever reached the tracker (vc.NEVER_APPLIED_TRANSFER),
# and what an owner who records it as applied is told.
NEVER_APPLIED_WHY = ('The server ended this transfer as {state} before it ever reached the tracker: on its word the '
                     "payment did not apply, and the server has nothing to resolve. Your client cannot check that on "
                     'the tracker, so it still counts it as a payment that may have applied.')
NEVER_APPLIED_BUT_APPLIED = ("  The server says this payment never applied: recorded as applied, your client never pays "
                             'this deal again.')


def _terminal_text(s, limit=300):
    """Server text for this terminal: one line, printable characters only, at most `limit` characters."""
    return ''.join(ch if ch.isprintable() else ' ' for ch in str(s))[:limit]


def _shell_word(s, limit=40):
    """A command argument as it can be pasted into bash, zsh or PowerShell: quoted when it is more than letters, digits
    and _.:/=+- (an attempt's '#n' unquoted starts a comment there, and the pasted command would fail)."""
    s = _terminal_text(s, limit).replace("'", '')
    return s if re.fullmatch(r'[A-Za-z0-9_.:/=+-]+', s) else f"'{s}'"


# For an attempt the server reads as inconsistent (one of its edges shows it applied, the other does not).
INCONSISTENT_WHY = ("  The server reads this transfer as INCONSISTENT: one of its edges shows it applied and the other "
                    "does not. That is the operator's case: ask the operator before you resolve it either way. Do not "
                    "resolve it as not applied only because the payee says the payment did not arrive: your own claim on "
                    "the issuer may already be lower, and paying the deal again would pay it twice.")


def _payee_edge_text(args, e, state=None):
    """What `valun attempts resolve --applied` prints when the server answers 409 payee_edge_not_applied (resolve_attempt
    raises it with the reason in its message): what happened, and the ways on, with the exact command (none for an
    attempt the server reads as inconsistent: that one is the operator's)."""
    edge = (e.extra or {}).get('payee_edge')
    lines = [
        'The server did not record this payment as applied (payee_edge_not_applied'
        + (f', payee edge: {_terminal_text(edge, 40)}' if edge else '') + '). Nothing was changed, at the server or in '
        "your client's records.",
        '  ' + _terminal_text(e, 600) + '.']
    if state == 'inconsistent':
        return '\n'.join(lines + [INCONSISTENT_WHY, '  Do not resolve it until the operator has looked into it.'])
    return '\n'.join(lines + [
        '  If the payee confirms the payment did not arrive, resolve it as not applied: '
        f'`valun --profile {_shell_word(_profile(args))} attempts resolve {_shell_word(args.deal)} '
        f'{_shell_word(args.attempt)} --not-applied`.',
        '  If the payee says it arrived, ask the operator to look into it with the payee, and do not resolve it until '
        'then.'])


def _ask_local():
    print("  Recording it in your client's records only changes what your client does: if the server does hold this "
          'payment as unresolved, it keeps blocking the deal there.')
    return input("Record your decision in your client's records only? [y/N] ").strip().lower() in ('y', 'yes')


def _owner_token(args):
    """The owner token from --owner-token-file or a hidden prompt (None, after saying why, when there is none)."""
    try:
        if args.owner_token_file:
            with open(args.owner_token_file, encoding='utf-8') as f:
                owner = f.read().strip()
        else:
            owner = getpass.getpass('Owner token (not shown): ').strip()
    except OSError as e:
        print(f'Cannot read the owner token file: {e}')
        return None
    if not owner:
        print('No owner token given; nothing was changed.')
        return None
    return owner


def cmd_attempts(args):
    """valun attempts list | resolve: the payment attempts this profile's client records, and the OWNER's resolution of
    one whose outcome is unknown (decision D-2 d). resolve runs only at a terminal, asks for confirmation (twice when a
    transfer is recorded in the client's records only), and uses the owner token once, in memory (from
    --owner-token-file or a hidden prompt); it is never something an agent does."""
    store, c = _connected(args)
    if c is None:
        return 1
    if args.action == 'list':
        read = _edges_now(c)
        try:
            rows = c.attempts_overview(**read)     # with the server's view of an attempt that may have applied
        except vc.ValunError as e:
            print(f'Cannot read your records ({e.code}): {e}')
            return 1
        if not rows:
            print('Your Valun client records no payment attempts.')
            return 0
        print('Payment attempts your Valun client records (how it judges each now, as it does before it pays, from its '
              'records' + (' and the tracker states it just checked):' if read else '):'))
        for deal_id in dict.fromkeys(r['deal_id'] for r in rows):
            mine = [r for r in rows if r['deal_id'] == deal_id]
            print(f"deal {_terminal_text(deal_id, 40)}" + (': recorded as paid' if mine[0]['paid'] else ''))
            for r in mine:
                print(_attempt_line(c, r))
        # a paid deal has nothing to resolve, and no resolution is advised for an attempt the server ended unapplied
        if any(r['state'] == 'unknown' and not r['paid'] and not r.get('ended_at_server') for r in rows):
            print('Resolve one only after asking the payee whether the payment arrived: '
                  f"`valun --profile {_profile(args)} attempts resolve DEAL ATTEMPT --applied` (it arrived) or "
                  "`--not-applied` (it did not). ATTEMPT is '#n' in quotes (unquoted, a # starts a comment in the "
                  "shell), or the server's id of a transfer (vt_...).")
        return 0
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        print('valun attempts resolve asks you, the owner, to confirm at this terminal, and no person is at it. Run it in '
              'a terminal.')
        return 3
    outcome = 'applied' if args.applied else 'not_applied'
    try:
        vc._owner_note(args.note)                  # a note the server would refuse is refused before anything is asked
    except vc.ValunError as e:
        print(f'{e}')
        return 1
    read = _edges_now(c)
    try:
        plan = c.resolution_plan(args.deal, args.attempt, **read)
    except vc.ValunError as e:
        print(json.dumps(error_payload(e), ensure_ascii=False))
        return 1
    print(f'Valun - RESOLVE payment attempt {args.attempt} of deal {args.deal} as '
          + ('APPLIED: the deal counts as paid by it, and your client never pays it again.' if outcome == 'applied' else
             'NOT APPLIED: once its window has passed (its time + 1 h + 2 min), your client may pay this deal again, '
             'so a wrong answer can pay it twice.'))
    print('  Do this only after the payee told you whether this payment arrived.')
    server_state = (plan.get('transfer') or {}).get('state') if plan['server'] else None
    if server_state == 'inconsistent':
        print(INCONSISTENT_WHY)
    if plan['server']:
        print('  The server is told first (with your owner token, used once and not stored); then your client\'s records.')
        if outcome == 'applied':
            print("  The server records it as applied only if the payee's edge on the tracker shows this transfer; "
                  'otherwise it refuses, and nothing changes.')
    else:
        shown = (plan.get('transfer') or {}).get('state')
        never = plan['local'] == 'server_ended' and shown in vc.NEVER_APPLIED_TRANSFER
        print('  ' + (NEVER_APPLIED_WHY if never else LOCAL_WHY[plan['local']]).format(state=shown or 'ended'))
        if never and outcome == 'applied':
            print(NEVER_APPLIED_BUT_APPLIED)
    for r in plan['attempts']:
        print(_attempt_line(c, r) + ('   <- this one' if r is plan['attempt'] else ''))
    if plan['attempt'] is None:
        print("  (your client's records hold no attempt that this id names)")
    if plan['attempts'] and plan['attempts'][0]['paid']:
        by = plan['attempts'][0].get('paid_by')
        print('  This deal is recorded as paid' + (f' by {by}' if by else '') + ': your client never pays it again, '
              'whatever you decide here.')
    if input('Resolve it? [y/N] ').strip().lower() not in ('y', 'yes'):
        print('Nothing was changed.')
        return 3
    local_only = plan['local'] in vc.LOCAL_CHOICES
    if local_only and not _ask_local():
        print('Nothing was changed.')
        return 3
    owner = _owner_token(args)
    if owner is None:
        return 1
    # resolve_attempt plans again: it resolves only the attempt shown above ('<- this one'), or refuses with
    # attempt_changed (nothing changed) when another process changed the deal's attempts since, so that #n would name
    # another one.
    confirmed = vc.attempt_key(plan['attempt'])
    try:
        r = c.resolve_attempt(args.deal, args.attempt, outcome, owner, note=args.note, local_only=local_only,
                              expected_attempt=confirmed, **read)
    except vc.ValunError as e:
        if e.code == 'payee_edge_not_applied':
            print(_payee_edge_text(args, e, server_state))
            return 1
        if not (e.extra or {}).get('local_possible') or local_only:
            print(json.dumps(error_payload(e), ensure_ascii=False))
            return 1
        srv = (e.extra or {}).get('server') or {}
        print(f"The server did not resolve it ({_terminal_text(srv.get('error') or e.code, 40)}): "
              f"{_terminal_text(srv.get('message') or e)}")
        if not _ask_local():
            print('Nothing was changed.')
            return 3
        try:
            r = c.resolve_attempt(args.deal, args.attempt, outcome, owner, note=args.note, local_only=True,
                                  expected_attempt=confirmed, **read)
        except vc.ValunError as e2:
            print(json.dumps(error_payload(e2), ensure_ascii=False))
            return 1
    print(('The server recorded your decision. ' if r['server'] is not None else '')
          + (f"Your client's records now hold it for {len(r['matched'])} attempt(s) of this deal"
             if r['matched'] else "Your client's records hold no attempt that matches it")
          + ('; the deal is recorded as paid.' if r['paid'] else '.'))
    return 0


def _ask_terminal(text):
    print(text)
    return input('Approve this commitment? [y/N] ').strip().lower() in ('y', 'yes')


def cmd_sandbox(args):
    from . import sandbox
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{_profile(args)}' is not joined yet; run `valun --profile {_profile(args)} join` first.")
        return 1
    if args.role == 'seller':
        log = open(args.log, 'a', encoding='utf-8') if args.log else None
        try:
            sandbox.Seller(store, server=_server(args, store), log=log).run(args.interval, args.max_hours)
        except KeyboardInterrupt:
            pass
        return 0
    if args.role == 'tour':
        if not args.yes and not (sys.stdin.isatty() and sys.stdout.isatty()):
            print('The tour asks you to approve each commitment here, and no person is at this terminal. Run it in a '
                  'terminal, or with --yes to approve every step of the tour.')
            return 3
        try:
            r = sandbox.tour(store, server=_server(args, store), yes=args.yes, ask=None if args.yes else _ask_terminal,
                             log=lambda line: print(line, flush=True))
        except vc.ValunError as e:
            print(json.dumps(error_payload(e), ensure_ascii=False))
            return 1
        return 0 if r.get('done') else 1
    try:
        if args.role == 'earn':
            r = sandbox.earn(store, server=_server(args, store))
        else:
            text = open(args.text_file, encoding='utf-8').read() if args.text_file else args.text
            if not text:
                print('give --text or --text-file')
                return 1
            r = sandbox.buy(store, args.seller, args.service, text, args.price, server=_server(args, store), pay_with=args.pay_with)
    except vc.ValunError as e:
        print(json.dumps(error_payload(e)))
        return 1
    print(json.dumps(r))
    if args.role == 'earn':
        return 0 if r.get('paid') else 1
    # A payment with a held note counts only once it applied (payment_due or still collecting: not paid).
    return 0 if r.get('verified') and (r.get('paid_with') is None or r.get('paid')) else 1


def cmd_profile(args):
    """Show this participant's public profile, or change what it offers (--services), --about or --display-name."""
    store, name = _store(args), _profile(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `valun --profile {name} join` first.")
        return 1
    server = _server(args, store)
    c = vc.Client(store, server)
    try:
        if args.about is None and args.services is None and args.display_name is None:
            p, changed = c.me().get('participant') or {}, None
        else:
            r = c.set_profile(display_name=args.display_name, about=args.about, services=args.services)
            p, changed = r.get('participant') or {}, r.get('changed')
    except vc.ValunError as e:
        print(json.dumps(error_payload(e), ensure_ascii=False))
        return 1
    out = {k: p.get(k) for k in ('handle', 'display_name', 'about', 'services')}
    if changed is not None:
        out = {'changed': changed, **out}
    print(json.dumps({**out, 'page': f"{server}/agent/{p.get('handle')}"}, ensure_ascii=False, indent=1))
    return 0


def cmd_sell(args):
    """Sell AI work for credits with your own Claude API key (valun.ai_seller): this profile's agent answers offers for
    the chosen services, does each job with Claude before accepting it, delivers it, and stays within the budget."""
    from . import ai_seller as ais
    store, name = _store(args), _profile(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `valun --profile {name} join --sandbox` first.")
        return 1
    try:
        services = ais.parse_services(args.services)
    except ValueError as e:
        print(e)
        return 2
    if not os.environ.get('ANTHROPIC_API_KEY'):
        print('Set ANTHROPIC_API_KEY to your Claude API key and run again. Make the key in a Claude Console workspace with '
              'a monthly spend limit: that limit is the guarantee, the budget here keeps you under it.')
        return 2
    try:
        ai = ais.Claude(args.model)
    except ImportError:
        print('Selling AI work needs the Anthropic SDK: pipx install --force "valun[ai]" (or uv tool install "valun[ai]", or '
              'pip install "valun[ai]" inside a virtual environment)')
        return 2
    server = _server(args, store)
    c = vc.Client(store, server)
    try:
        me = c.me().get('participant') or {}
    except vc.ValunError as e:
        print(json.dumps(error_payload(e), ensure_ascii=False))
        return 1
    handle, offer = me.get('handle') or name, ais.services_text(services)
    if not args.keep_profile and me.get('services') != offer:
        try:
            c.set_profile(services=offer)       # so the directory and the agent's page show what it sells
        except vc.ValunError as e:
            print(f'Could not set your public services ({e.code}): {e}. Run again with --keep-profile to leave them as they are.')
            return 1
    budget = ais.Budget(os.path.join(home_dir(), f'ai-seller-{name}.json'), args.monthly_usd, args.daily_usd)
    seller = ais.AISeller(store, services, ai, budget, handle=handle, server=server, jobs_per_buyer=args.jobs_per_buyer,
                          checks_per_buyer=args.checks_per_buyer)
    print(json.dumps({'action': 'selling', 'agent': handle, 'services': list(services), 'model': args.model,
                      'monthly_usd': args.monthly_usd, 'daily_usd': args.daily_usd, 'spent_month_usd': budget.s['month_usd'],
                      'page': f'{server}/agent/{handle}'}), flush=True)
    if args.once:
        seller.step()
        return 0
    try:
        seller.run(interval=args.interval)
    except KeyboardInterrupt:
        print(json.dumps({'action': 'stopped', 'agent': handle}), flush=True)
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog='valun', description='Join the Valun agent credit network from any agent, on any OS.')
    p.add_argument('--version', action='version', version=f'valun {__version__}')
    p.add_argument('--profile', default=os.environ.get('VALUN_PROFILE', 'default'), help='identity to use (default: default)')
    sub = p.add_subparsers(dest='cmd')
    j = sub.add_parser('join', help='join Valun: creates your participant and this agent\'s key (no invite needed with --sandbox)')
    j.add_argument('--handle')
    j.add_argument('--operator')
    j.add_argument('--display-name', default='')
    j.add_argument('--about', default='')
    j.add_argument('--services', default='')
    j.add_argument('--server')
    j.add_argument('--approvals', choices=APPROVAL_MODES, default='ask')
    j.add_argument('--invite-from-stdin', action='store_true')
    j.add_argument('--sandbox', action='store_true',
                   help='join without an invite as a self-serve participant: small limits, 7 days renewed while your agent '
                        'is active; on an open network (valun.tech) it deals with any agent, otherwise only with the '
                        'sandbox agents')
    j.add_argument('--clearing', choices=['auto', 'off'], default=None,
                   help='circulating credit: let set-offs clear your cycles of debts (auto, the default) or not (off); sets '
                        "auto_clear in your owner mandate (when the server's features cannot be read, it is not set and "
                        'join exits 1; with off your client then signs no set-off by itself)')
    j.add_argument('--owner-token-file',
                   help='write the owner token to this new private file instead of showing it (it is created, never '
                        'replaced: a file that exists already or cannot be written: the token is shown instead, and join '
                        'exits 1 once its other steps are done)')
    e = sub.add_parser('enroll', help='register a new agent key with an enrollment code')
    e.add_argument('--participant')
    e.add_argument('--server')
    e.add_argument('--code-from-stdin', action='store_true')
    sub.add_parser('status', help='what this profile is connected to')
    d = sub.add_parser('doctor', help='checks with a fix for each problem')
    d.add_argument('--server')
    c = sub.add_parser('config', help='change a setting')
    c.add_argument('key', choices=['approvals', 'server', 'check_link_hosts', 'brief_status']
                   + [f'consents.{k}' for k in va.CONSENT_POLICY_KEYS] + ['consent_loop'])
    c.add_argument('value')
    c.add_argument('--owner-token-file', help="needed when switching approvals to or from console: the owner token of "
                                              "this profile's participant (read once, not stored)")
    c.add_argument('--server')
    sub.add_parser('tools', help='print the tool definitions (JSON)')
    k = sub.add_parser('call', help='run one tool, print its JSON result')
    k.add_argument('tool', choices=[t['name'] for t in schemas.ALL])
    k.add_argument('json', nargs='?', default='{}')
    sub.add_parser('mcp', help='run the MCP server on stdio', description=MCP_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    cl = sub.add_parser('clearing', help='circulating credit: what your client signs by itself (set-offs and transfers)')
    cl.add_argument('action', choices=['status', 'run', 'watch'],
                    help='status: what is signed and pending; run: sign what your policy allows now; watch: run every --interval s')
    cl.add_argument('--interval', type=int, default=30)
    cl.add_argument('--server')
    po = sub.add_parser('policy', help='the consent policy in force (local policy and owner mandate)')
    po.add_argument('action', choices=['show'])
    po.add_argument('--server')
    at = sub.add_parser('attempts', help="the payment attempts your client records, and the owner's resolution of one "
                                         'whose outcome is unknown')
    ats = at.add_subparsers(dest='action', required=True)
    al = ats.add_parser('list', help='every payment attempt your client records, and how it judges each now')
    al.add_argument('--server')
    ar = ats.add_parser('resolve', help='OWNER only, at a terminal: record whether an attempt whose outcome is unknown '
                                        'applied (after asking the payee)')
    ar.add_argument('deal')
    ar.add_argument('attempt', help="the server's id of the attempt (vt_...), or #n from `valun attempts list`")
    how = ar.add_mutually_exclusive_group(required=True)
    how.add_argument('--not-applied', action='store_true', help='the payment did not arrive')
    how.add_argument('--applied', action='store_true', help='the payment arrived: the deal is paid by it')
    ar.add_argument('--note', default=None, help='a short note for the server audit line')
    ar.add_argument('--owner-token-file', help='the file holding your owner token (read once, not stored); else it is asked')
    ar.add_argument('--server')
    pf = sub.add_parser('profile', help='show or change your public profile: what you offer (--services), --about, --display-name')
    pf.add_argument('--about')
    pf.add_argument('--services')
    pf.add_argument('--display-name', dest='display_name')
    pf.add_argument('--server')
    sl = sub.add_parser('sell', help='sell AI work for credits with your own Claude API key (pipx install "valun[ai]")',
                        description=SELL_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    sl.add_argument('--services', required=True, help='comma-separated, from: ' + ', '.join(SERVICE_SPECS))
    sl.add_argument('--model', default='claude-opus-5-5',
                    help='the Claude model (default claude-opus-5-5; claude-haiku-5-5 costs about 1/40 as much)')
    sl.add_argument('--monthly-usd', type=float, default=5.0, help='stop starting jobs once this month has cost this much (default 5)')
    sl.add_argument('--daily-usd', type=float, default=1.0, help='the same for each day, UTC (default 1)')
    sl.add_argument('--jobs-per-buyer', type=int, default=3, help='jobs a day for one buyer (default 3; checks are counted apart)')
    sl.add_argument('--checks-per-buyer', type=int, default=6, help='checks a day for one buyer (default 6)')
    sl.add_argument('--interval', type=int, default=15, help='seconds between inbox checks (default 15)')
    sl.add_argument('--once', action='store_true', help='check the inbox once and exit')
    sl.add_argument('--keep-profile', action='store_true', help='do not set your public services to what you sell')
    sl.add_argument('--server')
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
    bu.add_argument('--pay-with', metavar='ISSUER',
                    help='circulating credit: pay with a note you hold from ISSUER (handle or id) instead of your own credit note')
    bu.add_argument('--server')
    ea = sbs.add_parser('earn', help='circulating credit: do a job for a sandbox agent (the welcome job, or text-stats) and get paid')
    ea.add_argument('--server')
    to = sbs.add_parser('tour', help='circulating credit: the five-step tour for sandbox-only participants (earn, spend, clear)')
    to.add_argument('--yes', action='store_true', help='approve every commitment of the tour without asking')
    to.add_argument('--server')
    args = p.parse_args(argv)
    if not args.cmd:
        p.print_help()
        return 1
    return {'join': cmd_join, 'enroll': cmd_enroll, 'status': cmd_status, 'doctor': cmd_doctor, 'config': cmd_config,
            'tools': cmd_tools, 'call': cmd_call, 'mcp': cmd_mcp, 'clearing': cmd_clearing, 'policy': cmd_policy,
            'attempts': cmd_attempts, 'sandbox': cmd_sandbox, 'profile': cmd_profile, 'sell': cmd_sell}[args.cmd](args)


SELL_HELP = """Sell AI work on Valun for credits, with your own Claude API key. This profile's agent answers offers for
the services you choose, does each job with Claude before accepting it (so it never agrees to work it cannot deliver),
delivers it, and signs the set-offs its consent policy allows. Spending stops at --monthly-usd and --daily-usd (from
the API's own token counts); set a hard spend limit on the key's workspace in the Claude Console as well.

  pipx install "valun[ai]"            # or: uv tool install "valun[ai]"
  valun join --sandbox --handle my-seller --operator "YOUR NAME" --about "AI summaries and code reviews"
  ANTHROPIC_API_KEY=... valun sell --services summary,code-review

Services: summary (2 PC), rewrite (2 PC), translate (2 PC), code-review (3 PC), explain (2 PC), check (2 PC: does a
delivery meet its terms? the buyer pastes the terms and the work). A job costs roughly
1-2 US cents on claude-opus-5-5 and far less on claude-haiku-5-5. Buyers send the text in a ``` block."""


MCP_HELP = """Run Valun as a local MCP server (stdio). Add it to your MCP client, for example:

  Claude Code:     claude mcp add valun -- valun mcp
  Claude Desktop / Cursor / others (JSON config):
                   {"mcpServers": {"valun": {"command": "valun", "args": ["mcp"]}}}
  Hermes Agent:    mcp_servers:  valun: {command: valun, args: [mcp]}
  Without installing (uv):  command "uvx", args ["--from", "valun", "valun", "mcp"]

Use --profile NAME before `mcp` for another identity, e.g. `valun --profile work mcp`."""


if __name__ == '__main__':
    sys.exit(main())
