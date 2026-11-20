"""`valun`: join the Valun network and use it from any agent, on any OS.

  valun join            invite -> participant -> agent key generated here -> credentials stored privately
  valun enroll          register a new agent key with an enrollment code from the owner console
  valun status | doctor what this profile is connected to; plain checks with a fix for each problem
  valun console         the OWNER console of this profile's server: its address, where the owner token is, what waits
                        for you there; opens it in your browser (--no-open: print only)
  valun config KEY VAL  approvals (ask|client-prompt|console|none), server, check_link_hosts (on|off),
                        consents.setoff | consents.as_issuer | consents.as_new_creditor (on|off), consents.max_PC N,
                        consent_loop (on|off)
  valun tools           the tool definitions (JSON), for any agent framework
  valun call TOOL JSON  run one tool and print its JSON result (for agents that have a shell); --json-file PATH, or
                        - for standard input, takes the JSON where no shell parses it (PowerShell, cmd)
  valun mcp             run the local MCP server on stdin/stdout (for MCP clients)
  valun clearing status|run|watch   circulating credit: what your client signs by itself, and signing it now
  valun policy show     the consent policy in force (local policy and owner mandate; the stricter applies)
  valun attempts list | resolve DEAL ATTEMPT --not-applied|--applied
                        the payment attempts your client records; the OWNER resolves one whose outcome is unknown
  valun card [WHO] | check PAYER AMOUNT [--deal vd_...] | publish | unpublish
                        budget cards: show one, check a payer against one (--deal: the offer you are deciding on); the
                        OWNER publishes or hides yours
  valun sandbox ...     deterministic sandbox agents: seller, buy, earn, tour
  valun audit --explorer URL | --node URL [--tracker-nft ID] [--mine] [--json]
                        check the operator: the published ledger against its tracker box on Ergo testnet (read only)
Add --profile NAME to keep several identities apart. Secrets are never printed (join writes the owner token to a new
private file, --owner-token-file or $HOME/valun-owner-token-HANDLE.txt, and shows it once only when it cannot).
"""
import argparse
import getpass
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone

from . import __version__
from . import agent as va
from . import audit as vaudit
from . import basis as vb
from . import client as vc
from . import receipts as vr
from . import schemas
from .agent import ValunAgent, error_payload
from .home import (APPROVAL_MODES, DEFAULT_SERVER, access_of, folder_denied, folder_fix, home_dir, new_file_refused,
                   open_error, open_new_private, permission_problem, profile_path, take_back, take_back_folder, who_else)
from .mcp_server import APPROVAL_TEXT, approval_cancelled, not_joined
from .ai_seller import SERVICE_SPECS

# client-prompt relies on the app: the MCP server only flags the signing tools for confirmation (Claude Code's
# requiresUserInteraction), and an app that does not confirm each tool call by itself asks nobody (the onboarding
# review).
CLIENT_PROMPT_CAVEAT = ('This asks only in an app that confirms each tool call itself, as Claude Code is designed to '
                        '(not yet tested with Valun): an app that runs tools without asking asks nobody, so check '
                        'yours first (or choose ask, console or none).')
# What console holds for the owner, and what it never holds, in the owner's words (the approval semantics of 2026-11-17,
# verified on staging): join's console line, `valun config approvals console` and `valun console`.
CONSOLE_HOLDS = ("your agent's offers and counter-offers, its acceptances (taking a job included), its guarantee offers, "
                 'and the note or payment by transfer it signs when it accepts a delivery')
CONSOLE_NEVER = ("honoring a guarantee call (your agent's own note, recorded at once), accepting, calling and releasing "
                 'guarantees, deliveries, declines, withdrawals and disputes, your agent loosening or clearing a limit it '
                 'recorded (never past your mandate), and the consents its client signs by itself')
# What a decision leaves, as the server does it (lib/pilot/core.mjs decideApproval and decidePayByTransfer; agent.
# CONSOLE_APPROVALS says the same to the agent): a rejected offer, acceptance or IOU stays on record, still signed; a
# rejected payment by transfer is purged (only its signatures' hashes are kept). Any other payment of a deal whose IOU
# or payment by transfer was rejected waits until its timestamp + 1 h + 2 min (novation FALLBACK_MARGIN_MS).
CONSOLE_DECIDES = ('Your agent has already signed each one; nothing of it binds anyone or reaches the tracker until you '
                   'approve. Approving signs nothing new: the server releases exactly what your agent signed. Rejecting '
                   'does not unsign it: the server keeps the signed offer, acceptance or note on record, and a rejected '
                   'note (a bound note, which your agent signs on the testnet) could still be recorded by the tracker '
                   'until an hour after your agent signed it, so paying that deal by transfer waits until 1 hour and 2 '
                   "minutes after your agent signed it (your agent's Valun client waits a minute longer than the time "
                   'the owner console shows, as a margin for clocks that differ). A rejected payment by transfer is the '
                   'exception: it is deleted, '
                   'its signatures included (the server keeps only their hashes), and your agent may pay again through '
                   'the same note at once while that note is unchanged. Approve or reject a held note by the deadline its card '
                   'shows, a minute before its hour at the tracker ends: a note still held when that hour ends is never '
                   'recorded and pays nothing, and a server whose card shows the hour itself as the deadline (one from '
                   'before 2026-11-18) still sends a note approved after it, which then fails at the tracker and leaves '
                   'the delivery accepted, unpaid and no longer disputable. Decide a held payment by transfer within 20 '
                   'minutes of your agent signing it.')
# What console holds, approving, rejecting, the deadlines: the joined server's own page, filled in by the same
# .format(server=...) as the console's address in that line (fix inbox #176: 0.7.2 named https://valun.tech/start#approve
# on any server; every Valun server serves /start#approve, the local one too).
CONSOLE_DOC = '{server}/start#approve'
JOIN_APPROVALS = {
    'ask': ('Approvals: ask. Before your agent signs a commitment (an offer, counter-offer or acceptance; accepting a '
            'delivery with its note or a payment by transfer; a guarantee offer; honoring or releasing a guarantee; '
            'loosening a limit it recorded) you are asked: in your MCP app by an approval form, or in this terminal for '
            '`{valun} call`. If you decline, nothing is signed. No interactive app has been verified with that form yet: '
            'where your app cannot show it nothing is signed, and `{valun} --profile {name} config approvals console '
            '--owner-token-file {token_file}`{token_note} lets your agent sign at once and holds its offers, acceptances and '
            'guarantee offers, and the note or payment at each delivery, for you in the owner console '
            '({server}/pilot#owner) instead (never an honor of a guarantee call or a consent).'),
    'client-prompt': ("Approvals: client-prompt. Your MCP app's own tool confirmation is the only approval: whatever it "
                      "lets run is signed at once; never 'always allow' the Valun signing tools. " + CLIENT_PROMPT_CAVEAT),
    # Three lines and a link (the Nov 18 fresh-join run, finding 3: this paragraph was about 400 of join's 614 words):
    # `valun console` says the rest, CONSOLE_DECIDES and CONSOLE_NEVER (_console_words), as /start#approve does.
    'console': ('Approvals: console. Your agent signs at once and asks nobody; Valun\'s server then holds for you in the '
                'owner console ({server}/pilot#owner) ' + CONSOLE_HOLDS + '. Nothing notifies you. `{valun} --profile '
                '{name} console` opens the console and says what approving and rejecting do (' + CONSOLE_DOC + ').'),
    'none': 'Approvals: none. Your agent acts on its own within your limits (at most {per_deal} per deal, {total} owed in total).',
}


class ProfileUnreadable(ValueError):
    """A profile file that is there but cannot be read as a profile: not UTF-8, not JSON, not a JSON object, or not
    readable; or one that looks missing because this user may not open its folder (kind 'folder_denied'). doctor and
    status say so and how to recover, and main() for every other command, never with a traceback; a ValueError, as a
    profile name that profile_path() refuses is."""

    def __init__(self, path, why, kind=None):
        super().__init__(f'{path}: {why}')
        self.path, self.why, self.kind = path, why, kind


def _profile_path(args):
    """profile_path(args.profile), which makes the profiles folder where it is missing. When this user may not make it
    (a VALUN_HOME, or a default folder, in a read-only or protected place), ProfileUnreadable kind 'home_unwritable',
    naming the folder (the RC's review, round 3, windows-acl WINACL-R4-4: every command, doctor too, ended in a
    traceback, "PermissionError: [WinError 5] Access is denied.", that named no path)."""
    try:
        return profile_path(args.profile)
    except OSError as e:
        folder = os.path.join(home_dir(), 'profiles')
        raise ProfileUnreadable(os.path.join(folder, f'{_profile(args)}.json'),
                                f'this user may not make its folder {folder}: {e.strerror or type(e).__name__}',
                                kind='home_unwritable') from None


def _store(args):
    """This profile's store; ProfileUnreadable when its file is there but cannot be read as a profile, or when it looks
    missing only because this user may not open its folder (home.folder_denied: the RC's review, round 3, windows-acl
    WIN4: doctor, status and the tools then said "not joined" and pointed to a join, which made a new participant that
    could not save its key there), or when its folder cannot be made (_profile_path). Every command opens its profile
    here, so none of them sends anything then."""
    path = _profile_path(args)
    try:
        store = vc.FileStore(path)
    except UnicodeDecodeError:
        raise ProfileUnreadable(path, 'it is not UTF-8 text') from None
    except json.JSONDecodeError as e:
        raise ProfileUnreadable(path, f'it is not valid JSON: {e}') from None
    except OSError as e:
        # Windows' sharing and lock violations: another program has the file open without sharing it (round 3, WIN5),
        # which open() reports as "Permission denied" only
        in_use = isinstance(e, PermissionError) and open_error(path) in (32, 33)
        raise ProfileUnreadable(path, f'it cannot be read: {e.strerror or type(e).__name__}',
                                kind='in_use' if in_use else None) from None
    if not isinstance(store.state, dict):
        raise ProfileUnreadable(path, 'it is not a JSON object')
    if not store.state and folder_denied(path):
        raise ProfileUnreadable(path, 'this user may not open its folder', kind='folder_denied')
    return store


def _unreadable_text(args, e):
    """What doctor, status and main() say about a profile that cannot be read: nothing was signed, and how to go on. A
    file this user may not open (an elevated run or another account made it: the RC's review, windows-acl missed[1]),
    or whose folder this user may not open (round 3, WIN4), is given back, never given up for a new join; one another
    program has open (round 3, WIN5: Windows' sharing violation) is to be closed there."""
    if getattr(e, 'kind', None) == 'home_unwritable':
        folder = os.path.dirname(os.path.abspath(e.path))
        why = e.why.rsplit(': ', 1)[-1].rstrip('.')
        default = ('%APPDATA%\\valun' if os.name == 'nt' else '~/Library/Application Support/valun'
                   if sys.platform == 'darwin' else '~/.config/valun')
        return (f'This user may not make the profiles folder {folder} ({why}): it is in a read-only or protected place, '
                "or another account's. Nothing was sent, and no profile was read or changed. Point VALUN_HOME at a "
                'folder you can write' + (f', or unset it to use the default ({default})' if os.environ.get('VALUN_HOME')
                                          else '') + '.')
    if getattr(e, 'kind', None) == 'in_use':
        return (f'The profile {e.path} is open in another program, which keeps others from reading it (Windows: '
                f'{e.why[len("it cannot be read: "):] if e.why.startswith("it cannot be read: ") else e.why}, a sharing '
                'violation): a backup or sync tool, or an editor, say. Nothing was signed, and the profile is not lost: '
                'close that program, or wait until it is done, and run this again. Never join again for this.')
    if getattr(e, 'kind', None) == 'folder_denied':
        folder = os.path.dirname(os.path.abspath(e.path))
        return (f'This user may not open the profiles folder {folder} (access denied), so the profile {e.path} cannot '
                'be read: an elevated run (Run as administrator) or another account made that folder, and only that one '
                "can open it now. Nothing was signed, and the profiles in it, with their agents' keys, are not lost: "
                'never join again for this (a join could not save its key there). From an elevated shell, give the '
                f'folder and its files back to this user: {take_back_folder(folder)}; or go on running valun elevated.')
    if os.name == 'nt' and access_of(e.path)['state'] == 'denied':
        return (f'The profile {e.path} cannot be read by this user ({e.why}): an elevated run (Run as administrator) or '
                "another account made it, and only that one can open it now. Nothing was signed, and the agent's key in "
                f'it is not lost: never join again for this. From an elevated shell, give it back to this user: '
                f'{take_back(e.path)}; or go on running valun elevated.')
    return (f'The profile {e.path} cannot be read ({e.why}). Nothing was signed. Restore it from a backup, or move '
            f'it aside and join again in a new profile (`{_valun()} --profile NAME join --sandbox ...`): this profile '
            "held its agent's key, which only that file or a backup of it has.")


def _profile_state(name):
    """Profile `name`'s state as its file holds it ({} when there is none), or None when it cannot be read."""
    try:
        st = vc.FileStore(profile_path(name)).state
    except Exception:  # noqa: BLE001 - one that cannot be read is not offered
        return None
    return st if isinstance(st, dict) else None


def _rejoin(args, network=vc.TESTNET):
    """How the owner of a profile of the retired pilot network goes on, on `network` (fix inbox #30): its profile
    'testnet' when that one holds an identity there already (skill.md: an identity made on the testnet with --profile
    testnet keeps working with that flag), else a join in a new profile ('testnet' while that name is free), with a new
    owner token file. A clause for doctor's and status's line, and the agent's rejoin_hint."""
    v, name = _valun(), _profile(args)
    st = _profile_state('testnet') if name != 'testnet' else None
    if st and st.get('participant_id') and vc.profile_network(st) == network:
        return (f"use your profile 'testnet', which is on {network}: `{v} --profile testnet doctor` (and "
                f'`{v} --profile testnet mcp` in an MCP app){_with_uvx()}')
    new = 'testnet' if name != 'testnet' and st is not None and not st.get('participant_id') else 'NAME'
    named = 'NAME: a profile name not used yet; ' if new == 'NAME' else ''
    return (f'join in a new profile, in a terminal: `{v} --profile {new} join --sandbox --handle HANDLE --operator '
            f'"YOUR NAME" --owner-token-file FILE` ({named}HANDLE: public and permanent; FILE: a new file for its '
            f'owner token){_with_uvx()}')


def _retired_line(args, server, network):
    """doctor's and status's line for a profile of the retired pilot network whose server serves `network`."""
    return (f'This profile joined the pilot network ({vc.NETWORK}), which was retired on {vc.PILOT_RETIRED_ON}: '
            f'{server} now serves {network}, which knows neither this participant nor its key, so this profile signs '
            f'nothing there. Use a profile on {network}: {_rejoin(args, network)}.')


def _profile(args):
    """This profile's name as profile_path() reads it ('default' for an empty --profile or VALUN_PROFILE), for the
    commands `valun join` and the not-joined hints print (`valun --profile NAME ...`): run elsewhere, whatever
    VALUN_PROFILE says there, each acts on this identity."""
    return (args.profile or 'default').strip().lower()


class BadServer(ValueError):
    """A server setting that is not a server URL (client.server_problem: one with no host, such as `http://`): --server,
    this profile's own (its file's "server", which `valun config server` and join write) or VALUN_SERVER. Its text names
    that setting and how to correct it, and nothing is sent: main() says it on stderr, doctor as a FIX line and status
    under its server line (the RC's review, round 3, transport-security js-hostless-server-url-bypasses-both-guards:
    `valun config server http://` stored 'http:', and the JS client sent that profile's token to http://pilot/...)."""


def _bad_server_text(args, setting, server, why, sent='Nothing was sent.'):
    """BadServer's words for `server`, given by `setting` ('--server', 'profile' or 'VALUN_SERVER'), which
    client.server_problem refuses (`why`). `sent`: what they say of what was sent, for this profile's own server
    (doctor and console, which reach the one --server names, say what went there)."""
    shown = vc.shown_server(server)
    if setting == 'profile':
        return (f"This profile's server must be an http(s) URL with a host, such as {DEFAULT_SERVER}: {shown} {why}. "
                f'{sent} Set it again: `{_valun()} --profile {_profile(args)} config server URL` (URL: your '
                f'Valun server, such as {DEFAULT_SERVER}).')
    return (f'{setting} must be an http(s) URL with a host, such as {DEFAULT_SERVER}: {shown} {why}. Nothing was sent.'
            + (f' Correct it, or unset it for {DEFAULT_SERVER}.' if setting == 'VALUN_SERVER' else ''))


def _server(args, store):
    """The server this command reaches, without its trailing slashes: --server, else this profile's own, else
    VALUN_SERVER, else DEFAULT_SERVER. BadServer, before anything is sent, when the one chosen is not a server URL
    (client.server_problem), naming that setting."""
    for setting, value in (('--server', getattr(args, 'server', None)), ('profile', store.state.get('server')),
                           ('VALUN_SERVER', os.environ.get('VALUN_SERVER'))):
        if value:
            server = value.rstrip('/') if isinstance(value, str) else value
            why = vc.server_problem(server)
            if why is not None:
                raise BadServer(_bad_server_text(args, setting, server, why))
            return server
    return DEFAULT_SERVER


def _own_server(args, store):
    """The server this profile's file names, when --server names another one (client.same_server), else None. A joined
    profile's tokens go only to its own (client.wrong_server_refusal): doctor and console say which is which, and
    print it only when it is a server URL (client.server_problem): else BadServer's words, which never repeat it."""
    given = getattr(args, 'server', None)
    own = getattr(store, 'profile_server', None) if store is not None else None
    if not (isinstance(given, str) and given.strip() and isinstance(own, str) and own):
        return None
    return None if vc.same_server(given.rstrip('/'), own) else own.rstrip('/')


def _run_by_uvx():
    """Is this command running in an environment uvx made for this one run (`uvx --from valun==X valun ...`, skill.md's
    way)? Its prefix is then in an archive-v<N> folder of uv's cache (uv's layout since its first versions), and a later
    shell has no `valun` on its PATH. A tool uv installed (`uv tool install`), a virtual environment or pipx is not."""
    parts = [p.lower() for p in os.path.normpath(sys.prefix).replace('\\', '/').split('/')]
    return 'uv' in parts and any(re.fullmatch(r'archive-v\d+', p) for p in parts)


def _uvx_from():
    """What `uvx --from` names to run this same valun again: `valun==<this version>`, as from an index (skill.md's way);
    or, for a valun installed from a URL (a wheel or folder, file:..., or a git checkout: its direct_url.json, PEP 610),
    that URL (the 0.7.2 review: a release candidate tested from a wheel was told to run the older valun on PyPI)."""
    try:
        from importlib import metadata
        raw = metadata.distribution('valun').read_text('direct_url.json')
        d = json.loads(raw) if raw else None
    except Exception:  # noqa: BLE001 - no metadata to read: the version names it
        d = None
    url = d.get('url') if isinstance(d, dict) else None
    if isinstance(url, str):
        vcs = d.get('vcs_info') if isinstance(d.get('vcs_info'), dict) else None
        if vcs is not None and vcs.get('vcs') == 'git':
            commit = vcs.get('commit_id')
            url = f'git+{url}' + (f'@{commit}' if isinstance(commit, str) else '')
        elif vcs is not None:
            url = None                              # another VCS: not one this hint names
        sub = d.get('subdirectory')
        if url is not None and isinstance(sub, str) and sub:
            url += f'#subdirectory={sub}'
        if url is not None and re.fullmatch(r'[A-Za-z0-9+.:/@#=_%~-]{1,300}', url):
            return url
    return f'valun=={__version__}'


def _valun():
    """The command the hints of this terminal name (fix inbox #88): `uvx --from valun==<this version> valun` where uvx
    runs this one (_run_by_uvx; the source it ran from: _uvx_from), else `valun`."""
    return f'uvx --from {_uvx_from()} valun' if _run_by_uvx() else 'valun'


def _with_uvx():
    """For the end of a next-step hint: where uv started this command some other way (it sets UV for what it runs, as
    `uv run` does) the hint names `valun`, which may not be on the PATH of a later shell, so the uvx form follows:
    ' (with uvx: `uvx --from valun==X valun ...`)'. Else ''."""
    if os.environ.get('UV') and not _run_by_uvx():
        return f' (with uvx: `uvx --from {_uvx_from()} valun ...`)'
    return ''


def _server_flag(server):
    """' --server URL' for a command an owner runs for this profile, when `server` is not the default one (`--server`
    given, VALUN_SERVER, or the profile's own): run in another shell, it then reaches the same server. Else ''."""
    s = (server or '').rstrip('/')
    return f' --server {_shell_word(s, 120)}' if s and s != DEFAULT_SERVER else ''


def _sandbox_join(args, server=None):
    """The sandbox join of this profile, complete as written, for the hints of a profile that has not joined (the 0.7.2
    clean-user test: `valun --profile NAME join` alone asks for an invite code, and has no handle or operator name):
    its owner replaces YOUR-HANDLE (public and permanent) and YOUR NAME. It names no owner token file: join writes the
    token to its own default, $HOME/valun-owner-token-HANDLE.txt, one file per handle that it never replaces (the RC's
    review, regressions R2-OTHER-1: the "$HOME/..." this named reached the join as that very text from Windows cmd, and
    from an agent's tool that runs commands through cmd.exe, so the file could not be made and the token was shown)."""
    name = _profile(args)
    return f'{_valun()} --profile {name} join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME"{_server_flag(server)}'


def _uvx_too():
    """The uvx form after a not-joined hint: ' (with uvx: `uvx --from valun==X valun ...`)', unless uvx runs this one
    (the hint names that form already). Unlike _with_uvx() it follows whether or not uv started this command: the hint
    goes from an app or an agent to an owner whose shell may have no `valun` on its PATH (the 0.7.2 clean-user test)."""
    return '' if _run_by_uvx() else f' (with uvx: `uvx --from {_uvx_from()} valun ...`)'


def _join_hint(args, server=None):
    """What the tools of a profile that has not joined say its owner must do (the agent's setup_hint: not_connected in
    `valun call` and `valun mcp`), and `valun mcp`'s notice: a sandbox join that runs as written, and its uvx form."""
    return f'run `{_sandbox_join(args, server)}` in a terminal{_uvx_too()}'


def _json_text(obj, **kw):
    """obj as JSON for this stdout: its characters as they are where stdout can encode them (UTF-8, a terminal), else
    escaped (\\u...), which is the same JSON. A redirected stdout on Windows writes the ANSI code page, so a character a
    server or a counterparty wrote (an offer's title in valun_inbox) failed the print after the call ran, its answer
    lost (the 0.7.2 review)."""
    text = json.dumps(obj, ensure_ascii=False, **kw)
    try:
        text.encode(getattr(sys.stdout, 'encoding', None) or 'utf-8')
    except UnicodeEncodeError:
        return json.dumps(obj, ensure_ascii=True, **kw)
    except LookupError:
        pass
    return text


def _not_private_note(path):
    """On Windows, ' ...' when the owner token file at `path` is not owner-only after all (a drive that keeps no
    permissions, such as WSL's share, or one that lets everyone in, as FAT32 and exFAT do, or an access list that
    lets others in): move it. '' on POSIX, where it was created 0600, and for a file only its owner can open."""
    if os.name != 'nt':
        return ''
    a = access_of(path)
    if a['state'] == 'ok' and not (a['others'] or a['owner']):
        return ''
    who = (f'it can also be opened by {who_else(a)}' if a['state'] == 'ok' else 'this drive keeps no permissions for it'
           if a['state'] == 'no_acl' else 'its permissions could not be read')
    return f' Windows could not make that file private ({who}), so move it somewhere only you can open.'


def _write_private(path, text):
    """Create `path` as a new private file holding `text`: mode 0600 on POSIX, and on Windows, where a mode is ignored,
    a DACL that lets in only this user (named by its SID), SYSTEM and Administrators, set as it is created
    (home.open_new_private; the RC's staging test, 2026-11-18: it took its folder's permissions there). An existing file
    is never replaced (it may hold another identity's owner token; FileExistsError). If writing fails, the file this
    call created is removed."""
    fd = open_new_private(path)
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
    """The owner-mandate change when approvals switch to or from console. Console has the server hold, for the owner,
    every offer, counter-offer, acceptance and guarantee offer (approve_above 0) and the IOU or payment by transfer the
    agent signs when it accepts a delivery (review_deliveries); nothing holds an honor of a guarantee call, a
    guarantee's acceptance, call or release, or a consent (the approval semantics of 2026-11-17). Leaving console
    restores approve_above only: review_deliveries is the owner's own setting too (it can be chosen in the owner
    console), so it is left as it is and the owner is told how to turn it off."""
    if mode == 'console':
        return {'approve_above': 0, 'review_deliveries': True}
    return {'approve_above': cap}


def _pin(client):
    """Read /info once: the client pins the network's tracker and unit in the profile (a later change is refused).
    Returns the feature tags it lists ([] when it lists none or cannot be read, also when its answer is lost on the way:
    after an enrollment that succeeded, 0.7.1 ended with a traceback there; the Nov 17 tester report)."""
    try:
        return va.features_of(client.info())
    except Exception:  # noqa: BLE001 - not read
        return []


def _on(value):
    """A config value as a boolean: on/off (also true/false, yes/no, 1/0); None for anything else."""
    v = str(value).strip().lower()
    return True if v in ('on', 'true', '1', 'yes') else False if v in ('off', 'false', '0', 'no') else None


def _scaled_policy(policy, store):
    """A default consent policy for this profile's network: its max_PC (written in PC) times the network's scale."""
    p = dict(policy)
    if p.get('max_PC') is not None:
        p['max_PC'] = int(p['max_PC']) * vc.network_of(store.state.get('network') or vc.NETWORK)['scale']
    return p


def _join_settings(store, server, sandbox, approvals):
    """The local settings a join writes in its profile, and an enrollment too (the Nov 17 tester report: 0.7.1's `valun
    enroll` wrote none, so a sandbox participant enrolled that way signed no set-off and the tour stopped at step 3).
    The local consent policy (design 6.6): an invited participant's client signs set-offs and transfers of its own debt
    by itself; a sandbox participant's client also accepts payments by transfer, and its MCP server runs the consent
    loop. The owner's mandate must allow each role too (the stricter applies); `valun policy show` shows both. Console
    approvals are recorded only once the mandate holds what console holds for the owner (approve_above 0,
    review_deliveries on); until then the profile asks."""
    return {'server': server, 'approvals': 'ask' if approvals == 'console' else approvals, 'check_link_hosts': True,
            'consent_policy': _scaled_policy(va.SANDBOX_CONSENT_POLICY if sandbox else va.INVITE_CONSENT_POLICY, store),
            'consent_loop': 'on' if sandbox else 'off'}


def _pending_context(pending):
    """What the join that started a pending enrollment recorded (handle, sandbox, approvals, clearing, expires_at)."""
    ctx = pending.get('context') if isinstance(pending, dict) else None
    return ctx if isinstance(ctx, dict) else {}


def default_approvals(sandbox):
    """The approval mode a join uses when --approvals is not given: None for a sandbox join, which asks whether a person
    will approve (Fitz's decision of 2026-11-20, fix inbox #164 option 3: console, 0.7.2's default since #138, stalled
    every step of an agent nobody watched, and an owner on another machine had no way to approve); ask for an invited
    join, as before (the operator's own participants, whose owners choose)."""
    return None if sandbox else 'ask'


# The question a sandbox join that names no --approvals asks (fix inbox #164 option 3), and its answers. There is no
# default: Enter alone chooses neither none (approvals given up by a keystroke) nor console (#164's stall).
APPROVALS_QUESTION = ("Approvals: will a person approve this agent's commitments?\n"
                      '  yes: console. Your agent signs at once, and the Valun server holds its offers, counter-offers, '
                      'acceptances and guarantee offers, and the note or payment by transfer it signs when it accepts a '
                      'delivery, until that person approves each in the owner console ({server}/pilot#owner). Nothing '
                      'notifies them.\n'
                      "  no: none. Nobody is asked: your agent signs on its own, within this self-serve participant's "
                      'limits.')
APPROVALS_PROMPT = 'Will a person approve? [yes/no]: '
APPROVALS_ANSWERS = {'y': 'console', 'yes': 'console', 'n': 'none', 'no': 'none'}


def _asks_approvals(args):
    """Does this join ask whether a person will approve: a sandbox join that names no --approvals (fix inbox #164)."""
    return bool(args.sandbox) and args.approvals is None


def _ask_approvals(server):
    """The approvals question, at a terminal (_person_at_terminal): 'console' for yes, 'none' for no, asked again until
    the answer is one of them; None when its input ends (no one to answer: the refusal follows)."""
    print(APPROVALS_QUESTION.format(server=server))
    while True:
        try:
            answer = input(APPROVALS_PROMPT).strip().lower()
        except EOFError:
            print()
            return None
        if answer in APPROVALS_ANSWERS:
            return APPROVALS_ANSWERS[answer]
        print('Answer yes or no.')


def _approvals_choices(args, server, handle, operator, lacking=False):
    """The two joins a sandbox join with no --approvals names when it cannot ask (fix inbox #164): this join with
    --approvals console and with --approvals none, as _join_command writes them."""
    def run(mode):
        a = argparse.Namespace(**vars(args))
        a.approvals = a.approvals_given = mode
        return _join_command(a, server, handle, operator, lacking=lacking)
    return [f'  if a person will approve each one in the owner console ({server}/pilot#owner): {run("console")}',
            f'  if nobody will (your agent signs on its own, within the self-serve limits): {run("none")}']


def _approvals_not_asked(args, server, handle, operator):
    """A sandbox join that names no --approvals, with no terminal to ask in (stdin or stdout is not one), or whose input
    ended at the question: both joins to run instead. Nothing was sent. Exit 2, as _join_not_asked."""
    print("Nothing was sent: a sandbox join that names no --approvals asks whether a person will approve your agent's "
          f'commitments, and there is no terminal here to ask in. Run one of these{_with_uvx()}:')
    print('\n'.join(_approvals_choices(args, server, handle, operator)))
    return 2


def default_owner_token_file(handle):
    """Where join writes the owner token when no --owner-token-file is given: $HOME/valun-owner-token-HANDLE.txt, the
    file the commands people copy name (the home folder Python finds: USERPROFILE on Windows). Never an existing file
    (_write_private): join refuses one before anything is sent (_token_file_refusal)."""
    h = str(handle or '').strip().lower()
    name = f'valun-owner-token-{h}.txt' if re.fullmatch(r'[a-z0-9_-]{1,40}', h) else 'valun-owner-token.txt'
    return os.path.join(os.path.expanduser('~'), name)


def _join_lacks(args):
    """What `valun join` would ask for at the terminal: the invite code (an invite join without --invite-from-stdin),
    a handle and an operator name, each when not given."""
    return ([] if args.sandbox or args.invite_from_stdin else ['the invite code']) + \
        ([] if args.handle else ['a handle']) + ([] if args.operator else ['an operator name'])


def _words(items):
    """['a', 'b', 'c'] as 'a, b and c'."""
    return items[0] if len(items) == 1 else ', '.join(items[:-1]) + ' and ' + items[-1]


def _join_not_asked(args, server, lacks):
    """`valun join` that lacks what it would ask for, with no terminal to ask in (the first-tester readiness assessment
    of 2026-11-18: doctor's FIX line, run by a shell agent without its handle, ended in an EOFError traceback at the
    handle prompt, and an invite join waited for a console nobody was at): the command to run, YOUR-HANDLE and "YOUR
    NAME" standing for what it lacks and the invite on its input, and for an invite join the sandbox join. Nothing was
    sent. Exit 2."""
    run = _join_command(args, server, args.handle or 'YOUR-HANDLE', args.operator, lacking=True)
    put = ((['your own handle (public and permanent: 3 to 24 letters, digits, _ or -, starting with a letter)']
            if not args.handle else []) + (['your name (public: who controls this agent)'] if not args.operator else [])
           + (['the invite code on its input (one line)'] if 'the invite code' in lacks else []))
    if _asks_approvals(args):           # the approvals question cannot be asked either (fix inbox #164)
        print(f"Nothing was sent: this join needs {_words(lacks)} and whether a person will approve your agent's "
              f'commitments, and there is no terminal here to ask for them. Run one of these{_with_uvx()}, with '
              f'{_words(put)}:')
        print('\n'.join(_approvals_choices(args, server, args.handle or 'YOUR-HANDLE', args.operator, lacking=True)))
        return 2
    print(f"Nothing was sent: this join needs {_words(lacks)}, and there is no terminal here to ask for "
          f"{'it' if len(lacks) == 1 else 'them'}. Run {run}{_with_uvx()}, with {_words(put)}."
          + ('' if args.sandbox else f' No invite code? Join without one: `{_sandbox_join(args, server)}`.'))
    return 2


def _enroll_not_asked(args, server, participant):
    """`valun enroll` that lacks its participant id or its enrollment code, with no terminal to ask in (the readiness
    assessment of 2026-11-18: an EOFError traceback at the participant prompt): the command to run, the code on its
    input. Nothing was sent. Exit 2."""
    pid = participant.strip() if isinstance(participant, str) and participant.strip() else None
    run = (f'{_valun()} --profile {_profile(args)} enroll --participant {_shell_word(pid, 40) if pid else "vp_..."} '
           f'--code-from-stdin{_server_flag(server)}')
    print(f"Nothing was sent: this enrollment needs {'the enrollment code' if pid else 'the participant id and the enrollment code'} "
          f"from your owner console ({server}/pilot#owner), and there is no terminal here to ask for {'it' if pid else 'them'}. "
          f"Run `{run}`{_with_uvx()}, with " + ('' if pid else 'your participant id in place of vp_... and ')
          + 'the code on its input (one line).')
    return 2


def cmd_join(args):
    # The mode this join uses: --approvals as given (approvals_given; None when it is not), else the default for its
    # kind (default_approvals): ask for an invited join; a sandbox join asks whether a person will approve (below, fix
    # inbox #164), and the answer is then this join's mode as if given. The commands join prints name --approvals only
    # when it was given (or answered) and is not the default.
    args.approvals_given = args.approvals
    args.approvals = args.approvals or default_approvals(args.sandbox)
    store = _store(args)
    if store.state.get('participant_id'):
        print(f"Profile '{args.profile}' is already connected to {store.state['participant_id']}. "
              'Use --profile NAME for a second identity.')
        return 1
    pending = vc.pending_enrollment_of(store.state)
    if pending:
        # A join of this profile stopped after its participant was made and its agent's key saved (the answer to the
        # enrollment was lost): joining again would make no new participant (the handle is taken), so this finishes
        # that one, with the same key and code (the Nov 17 tester report).
        ctx, name, v = _pending_context(pending), _profile(args), _valun()
        handle, pid = ctx.get('handle') if isinstance(ctx.get('handle'), str) else None, pending['participant_id']
        asked = (args.handle or '').strip().lower()
        given = (getattr(args, 'server', None) or '').rstrip('/')
        if (asked and handle and asked != handle) or (given and given != pending['server'].rstrip('/')):
            print(f"Profile '{name}' holds a join that did not finish: participant {_pid_word(pid)}"
                  + (f' ({_shell_word(handle)})' if handle else '') + f" on {pending['server']}, whose agent's key is kept "
                  f"here. Run `{v} --profile {name} join` with no other --handle or --server to finish it, or use "
                  '--profile NAME for a new participant.')
            return 1
        return _finish_pending(args, store, pending)
    server = _server(args, store)
    refused = _folder_refusal(store.path)
    if refused:                         # its key could not be saved: the participant would be made for nothing
        print(f'Joining refused before anything was sent: {refused} Then run this join again.')
        return 1
    lacks = _join_lacks(args)
    # No one to ask: the command to run, with what it lacks (and both approval modes, when the question below could
    # not be asked either: refused before any prompt).
    if lacks and (not _at_terminal() or (_asks_approvals(args) and not _person_at_terminal())):
        return _join_not_asked(args, server, lacks)
    if not args.sandbox and not args.invite_from_stdin:
        given = getattr(args, 'server', None)
        print(f'No invite code? Anyone can join without one: stop here (Ctrl+C) and run `{_valun()} --profile {_profile(args)} '
              f"join --sandbox{f' --server {_shell_word(given, 120)}' if given else ''}`.")
    try:
        invite = None if args.sandbox else (sys.stdin.readline() if args.invite_from_stdin else getpass.getpass('Invite code (not shown): ')).strip()
        handle = args.handle or input('Handle (public, permanent; 3-24 letters, digits, _ or -, starting with a letter): ').strip().lower()
        operator = args.operator or input('Operator (public: who controls this agent, e.g. your name): ').strip()
    except EOFError:                    # its input ended at a prompt: NUL, which Windows calls a terminal
        print()
        return _join_not_asked(args, server, lacks)
    placeholder = _placeholder(handle, operator)
    if placeholder:
        # A command pasted unchanged (the README's, skill.md's, or this command's own next command): refused here, on
        # any server, before anything is sent (valun.tech and staging accepted them, for good).
        print(f'Joining refused before anything was sent: --{placeholder[0]} {placeholder[1]} is the placeholder in the '
              'example commands. Choose your own handle and operator name (both are public, and neither can change '
              'after you join), and join with them.')
        return 1
    if _asks_approvals(args):
        # Fix inbox #164 option 3: whether a person will approve, asked only of a person at a terminal (stdin and stdout
        # both one); else, or when its input ends, both joins to run, and nothing is sent. The answer is recorded as if
        # --approvals had been given: the mandate gets what that flag sends, and every command printed after this names it.
        mode = _ask_approvals(server) if _person_at_terminal() else None
        if mode is None:
            return _approvals_not_asked(args, server, handle, operator)
        args.approvals = args.approvals_given = mode
        args.approvals_answered = True
    refused = _token_file_refusal(args, server, handle, operator)
    if refused:                         # the owner token could not be written: it would end up on screen, or nowhere
        print(refused)
        return 2
    c = vc.Client(store, server)
    # The agent's key is made before the join is sent (or is the one an earlier join of this profile kept): a join whose
    # answer is lost keeps it in this profile for the next join; an answered join enrolls it. Nothing is written before
    # the join is answered or lost.
    key = _kept_join_key(store.state) or vb.generate_secret().hex()
    kept_before = bool(_kept_join_key(store.state) or lost_join_of(store.state))
    try:
        if args.sandbox:   # no invite: a sandbox-only participant (only where the server offers it)
            j = c.join_sandbox(handle, operator, display_name=args.display_name, about=args.about, services=args.services,
                               wants=args.wants)
        else:
            j = c.join(invite, handle, operator, display_name=args.display_name, about=args.about, services=args.services,
                       wants=args.wants)
    except KeyboardInterrupt:
        # Ctrl+C while the join was on its way, which is when a slow join makes people press it (the 0.7.2 review: it
        # skipped all of this): the join may have reached the server, so its answer is lost as far as this profile knows.
        _join_unanswered(args, store, None, handle, operator, server, key)
        return 130
    except vc.ValunError as e:
        if vc.transport_cut(e) or (e.status is not None and e.status >= 500 and e.code == 'http_error'):
            # The request went out and its answer was cut, or a proxy answered for the server: it may have done it.
            return _join_unanswered(args, store, e, handle, operator, server, key)
        if e.code == 'unreachable':                 # the server was not reached: nothing was sent
            return _join_not_sent(args, e, handle, operator, server)
        return _join_refused(args, store, e, handle, operator, server)
    except Exception as e:  # noqa: BLE001 - raised as it is unless the answer was lost on the way
        if not vc.answer_unread(e):
            raise
        return _join_unanswered(args, store, e, handle, operator, server, key)
    owner = j.get('owner_token') if isinstance(j, dict) else None
    if not (isinstance(owner, str) and owner):
        print('Joining failed (bad_response): the server did not answer an owner token.')
        return 1
    # Decision D-3 c: from here on the participant exists, and its owner token is in this answer only. It is handed over
    # first (_hand_over: written to --owner-token-file, or a new file beside it, and never to stdout), before any local
    # write that can fail (the agent's key, the profile, the pins); whatever fails after this, join says what is not
    # done and exits 1.
    handed = _hand_over(args, owner, server, handle, j.get('participant_id'))
    step = ['enroll']
    try:
        finished = _join_steps(args, store, c, j, server, handle, owner, step, key)
    except Exception as e:  # noqa: BLE001 - the owner token is handed over already: say what stopped, never a traceback
        name, pid = _profile(args), _pid_word(j.get('participant_id'))
        print(f'Joining stopped ({_failure(e)}): {_terminal_text(e)}')
        print(f'  Your participant {pid} exists, and '
              + ('your owner token was handed over above' if getattr(args, 'owner_token_written', None) else
                 'join said above what became of your owner token') + '. Not done: '
              + JOIN_NOT_DONE[step[0]].format(name=name, server=server, pid=pid, valun=_valun()) + '.')
        if step[0] == 'mandate' and args.clearing == 'off':
            _no_setoff_after_stop(store, name)
        print(f'Then run `{_valun()} --profile {name} doctor`{_with_uvx()}.')
        finished = False
    if kept_before:
        _forget_join(store)             # this join was answered: what the profile kept of an earlier one is done with
    if not handed:
        written = getattr(args, 'owner_token_written', None)
        print(f'Exit code 1: {args.owner_token_path} was not written'
              + (f': your owner token is in {written}.' if written else '.'))
    return 0 if finished and handed else 1


# A join whose answer is lost (the newcomer tests, 2026-11-17: 0.7.1 ended with a traceback, wrote no owner token, and a
# second join got handle_taken for good). The server may have made the participant: its owner token and enrollment
# code were only in the lost answer, so that participant cannot be finished here, and it keeps its handle taken while it
# is an unfinished join (its agent never enrolled). How long depends on the server. The hold contract (valun-app
# fix/first-use, not yet on valun.tech or staging): joining a handle that a self-serve (join-sandbox) participant which
# never enrolled holds answers 409 handle_taken with held_until (ISO 8601 UTC) and retry_after_ms, and the hold is
# released after a while. A server without it keeps the handle taken, and none releases an invited join's participant:
# the operator who gave the invite can finish it for its owner (a new owner token and enrollment code) or release it.
# The profile keeps the agent's key (JOIN_KEY, made before the join was sent) and what was lost (LOST_JOIN: the handle,
# the server, when, the kind of join and the flags it was run with), for the next join and for doctor.
JOIN_KEY = 'join_key'
LOST_JOIN = 'lost_join'
_HELD_UNTIL_RE = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]00:00)')
# After the command for another handle: NEW-HANDLE is to be replaced (`valun join` refuses it, _placeholder).
NEW_HANDLE_NOTE = ' (replace NEW-HANDLE with a handle of your own: public and permanent)'
# The placeholders of the join commands people copy, by the key valun-app compares names with (letters and digits only,
# lower case), each as the commands show it: valun-app's PLACEHOLDER_HANDLES and PLACEHOLDER_OPERATORS (fix/first-use,
# e422c64). valun.tech and staging accept them, so a block pasted unchanged joined as your-handle, operated by "YOUR
# NAME", for good (the newcomer tests, 2026-11-17), and this command's own next commands name NEW-HANDLE (the 0.7.2
# review): `valun join` refuses them before anything is sent, on any server.
PLACEHOLDER_HANDLES = {'yourhandle': 'YOUR-HANDLE', 'yourbacker': 'YOUR-BACKER', 'backerhandle': 'BACKER-HANDLE',
                       'payerhandle': 'PAYER-HANDLE', 'friendhandle': 'FRIEND-HANDLE', 'theirhandle': 'their-handle',
                       'handle': 'HANDLE', 'myseller': 'my-seller', 'newhandle': 'NEW-HANDLE', 'yourname': 'yourname'}
PLACEHOLDER_OPERATORS = {'yourname': '"YOUR NAME"', 'yourhuman': '"YOUR HUMAN"', 'theirname': '"Their name"',
                         'name': 'NAME'}


def _name_key(s):
    """A name as valun-app compares names: its letters and digits, lower case ('Your_Name' and 'your name' are one)."""
    return ''.join(ch for ch in str(s or '').lower() if ch.isalnum())


def _placeholder(handle, operator):
    """(flag, the placeholder as the commands show it) when the handle or the operator is a placeholder of the example
    commands (PLACEHOLDER_HANDLES, PLACEHOLDER_OPERATORS), else None."""
    if _name_key(handle) in PLACEHOLDER_HANDLES:
        return 'handle', PLACEHOLDER_HANDLES[_name_key(handle)]
    if isinstance(operator, str) and _name_key(operator) in PLACEHOLDER_OPERATORS:
        return 'operator', PLACEHOLDER_OPERATORS[_name_key(operator)]
    return None


def _now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _kept_join_key(state):
    """The agent key an earlier join kept in this profile (JOIN_KEY: hex), or None."""
    rec = state.get(JOIN_KEY) if isinstance(state, dict) else None
    return rec['secret'] if isinstance(rec, dict) and vc._is_secret_hex(rec.get('secret')) else None


def _keep_lost_join(store, key, lost):
    """Keep in the profile (private, as the agent's key is once enrolled) the key the join whose answer was lost made,
    and what was lost, for the next join and for doctor. True when kept; False when the profile cannot be written."""
    rec = {'secret': key, 'pubkey': vb.public_key(bytes.fromhex(key)).hex(), 'since': lost['at']}

    def keep(state):
        if _kept_join_key(state) != key:
            state[JOIN_KEY] = rec
        state[LOST_JOIN] = lost
    try:
        store.update(keep)
    except Exception:  # noqa: BLE001 - not kept: the next join makes another key
        return False
    return _kept_join_key(store.state) == key


def _forget_join(store):
    """A join of this profile was answered: the key an earlier join kept went to its enrollment (which keeps it as its
    pending enrollment before anything is sent), and no lost join is left. Never fails the join."""
    def drop(state):
        state.pop(JOIN_KEY, None)
        state.pop(LOST_JOIN, None)
    try:
        store.update(drop)
    except Exception:  # noqa: BLE001 - left: the next join uses the key again, or replaces it
        pass


def lost_join_of(state):
    """What this profile keeps of a join whose answer was lost ({handle, server, at, sandbox, and the join's flags:
    _lost_record}), or None."""
    rec = state.get(LOST_JOIN) if isinstance(state, dict) else None
    if isinstance(rec, dict) and all(isinstance(rec.get(k), str) and rec[k] for k in ('handle', 'server', 'at')):
        return rec
    return None


# The flags of a join that LOST_JOIN keeps (public texts the join sent, and this machine's own choices), as named in args.
_LOST_FLAGS = ('approvals', 'clearing', 'owner_token_file', 'display_name', 'about', 'services', 'wants')


def _lost_record(args, handle, operator, server):
    """LOST_JOIN for this join: its handle, server and time, whether it was a sandbox join, and what it was run with (the
    operator, approvals, clearing, the owner token file as an absolute path, the public texts), so that doctor prints
    the same join again, with no placeholder for a value it was given (the 0.7.2 review)."""
    rec = {'handle': str(handle).lower(), 'server': server, 'at': _now_iso(), 'sandbox': bool(args.sandbox)}
    if isinstance(operator, str) and operator:
        rec['operator'] = operator
    for k in _LOST_FLAGS:
        # --approvals as it was given (none: the default for the kind of join applies again)
        v = getattr(args, 'approvals_given', getattr(args, k, None)) if k == 'approvals' else getattr(args, k, None)
        if isinstance(v, str) and v:
            rec[k] = os.path.abspath(v) if k == 'owner_token_file' else v
    return rec


def _lost_args(args, lost):
    """The join a LOST_JOIN record names, as the arguments _join_command reads (doctor's next command), in this
    profile. What the record does not name is left out of the command (a record of the first 0.7.2 builds names none)."""
    text = lambda k: lost[k] if isinstance(lost.get(k), str) else ''  # noqa: E731
    sandbox = lost.get('sandbox', True) is not False
    given = lost['approvals'] if lost.get('approvals') in APPROVAL_MODES else None
    return argparse.Namespace(
        profile=args.profile, sandbox=sandbox, display_name=text('display_name'),
        about=text('about'), services=text('services'), wants=text('wants'),
        approvals=given or default_approvals(sandbox), approvals_given=given,
        clearing=lost['clearing'] if lost.get('clearing') in ('auto', 'off') else None,
        owner_token_file=text('owner_token_file') or None)


def _faithful(s, limit):
    """s as one shell word that is exactly s in Windows cmd, PowerShell, bash and zsh: as it is, or in double quotes
    (_shell_word; O'Brien too, and a Windows path such as C:\\Users\\Ann\\owner.txt), or None when no quoting keeps it in
    all of them (more than `limit` characters, a character the terminal cannot show, one stdout cannot write but as a
    \\u escape, such as 名 on a cp1252 pipe: _printable_streams; or what _double_quotable refuses: a " $ ` ! %, a curly
    double quote, a doubled or final backslash), or for an empty value (Windows PowerShell drops an empty "" argument:
    the command then shows its placeholder): the command then names the flag's value apart (the 0.7.2 review: O'Brien
    was replaced with a placeholder; the RC's staging test: single quotes failed in cmd; the RC's review, round 3,
    regressions R3-REG-1: an escape named a file that is not there)."""
    if not isinstance(s, str) or not s or len(s) > limit or not s.isprintable() or not _stdout_encodes(s):
        return None
    w = _shell_word(s, limit)
    return w if w in (s, f'"{s}"') else None


def _join_command(args, server, handle, operator, other_handle=False, lacking=False):
    """The join this command ran, as a command to run again (the next command, as written): this profile, the handle
    (or NEW-HANDLE), the operator, the approvals, clearing and owner token file given, and the server. A value that
    cannot be written as one shell word exactly is named apart ("..., with the same --about as before"). lacking: a
    join that was not given its operator (_join_not_asked), for which "YOUR NAME" stands, nothing "as before"."""
    v, name = _valun(), _profile(args)
    words, apart = [f'{v} --profile {name} join'], []
    if args.sandbox:
        words.append('--sandbox')
    else:
        words.append('--invite-from-stdin')
    words.append('--handle NEW-HANDLE' if other_handle else f'--handle {_shell_word(handle, 40)}')
    op = _faithful(operator, 60)
    words.append(f'--operator {op}' if op else '--operator "YOUR NAME"')
    if not op and (operator or not lacking):
        apart.append('--operator')
    for flag, value in (('--display-name', args.display_name), ('--about', args.about), ('--services', args.services),
                        ('--wants', args.wants)):
        if value:
            shown = _faithful(value, 300)
            if shown:
                words.append(f'{flag} {shown}')
            else:
                apart.append(flag)
    given = getattr(args, 'approvals_given', args.approvals)      # as given; none: the default for the kind of join
    if given is not None and given != default_approvals(args.sandbox):
        words.append(f'--approvals {given}')
    if args.clearing:
        words.append(f'--clearing {args.clearing}')
    if args.owner_token_file:
        f = _faithful(args.owner_token_file, 300)
        words.append(f'--owner-token-file {f}' if f else '--owner-token-file FILE')
        if not f:
            apart.append('--owner-token-file')
    if _server_flag(server):
        words.append(_server_flag(server).strip())
    cmd = '`' + ' '.join(words) + '`'
    if apart:
        cmd += ' (with the same ' + ', '.join(apart) + ' as before)'
    return cmd


def _hold_of(e):
    """The hold a 409 handle_taken names (the hold contract): (held_until, minutes until then) from its held_until and
    retry_after_ms, or None when it names neither (a handle taken by a participant that has enrolled its agent)."""
    x = e.extra if isinstance(e.extra, dict) else {}
    until = x.get('held_until') if isinstance(x.get('held_until'), str) and _HELD_UNTIL_RE.fullmatch(x['held_until']) else None
    ms = x.get('retry_after_ms')
    ms = ms if isinstance(ms, int) and not isinstance(ms, bool) and 0 <= ms <= 30 * 86_400_000 else None
    if until is None and ms is None:
        return None
    return until, (-(-ms // 60_000) if ms is not None else None)


def _when_text(until, minutes):
    """'until 2026-11-18T01:00:00Z (in about 30 minutes)', or the half the hold names."""
    parts = []
    if until:
        parts.append(f'until {until}')
    if minutes is not None:
        parts.append(f"in about {minutes} minute{'' if minutes == 1 else 's'}")
    return parts[0] + (f' ({parts[1]})' if len(parts) > 1 else '') if parts else ''


def _held_words(h, sandbox):
    """What keeps handle `h` taken after a join of it whose answer was lost, by the kind of join (the 0.7.2 review: the
    first RC promised every join a hold that is released, which only a server with the hold contract keeps, and only for
    a sandbox join)."""
    if sandbox:
        return ('nobody can finish it. A server that releases unfinished joins (no agent key was ever enrolled) frees '
                f'{h} after a while, and until then a join as {h} answers handle_taken with the time it is held until; a '
                f'server that does not keeps {h} taken.')
    return ('only the operator who gave you the invite can finish it: at your request they can give you a new owner '
            f'token and enrollment code for it, or release it. Until then {h} stays taken.')


def _join_unanswered(args, store, e, handle, operator, server, key):
    """`valun join` whose request got no answer (the request went out: the Nov 17 tester report's "the first join timed out on
    read"; 0.7.1 ended with a traceback), or that Ctrl+C stopped on its way (e None: it may have reached the server).
    Says what the server may hold now (_held_words, by the kind of join), that this agent's key is kept here, and the
    exact next command; keeps what was lost (LOST_JOIN) for the next join and for doctor."""
    h = _shell_word(handle)
    lost = _lost_record(args, handle, operator, server)
    key = key if _keep_lost_join(store, key, lost) else None
    if e is None:
        print('Joining stopped (Ctrl+C) before an answer to the join arrived: the join may have reached the server.')
    else:
        # what failed, without the write's general advice to read what the server holds first (client.WRITE_SENT): a
        # joiner has nothing to read without the owner token that was only in the lost answer (the RC's staging test)
        print(f'Joining stopped ({_failure(e)}): the join was sent, and no answer to it arrived '
              f'({_terminal_text(vc.unsent_words(e))}).')
    print(f'  The server may now hold a participant {h} made by this join. Its owner token and enrollment code were only '
          'in that answer, so ' + _held_words(h, args.sandbox))
    print("  This agent's key, made here before the join was sent (nothing of it left this machine), is kept in this "
          'profile for the next join.' if key else "  This agent's key could not be kept in this profile (it cannot be "
                                                   'written): the next join makes another; nothing of it left this machine.')
    again = _join_command(args, server, handle, operator)
    other = _join_command(args, server, handle, operator, other_handle=True) + NEW_HANDLE_NOTE
    if args.sandbox:
        print(f'  Next: run the same join again: {again}. If it answers that {h} is held until a time, run it again '
              f'then; if it answers that {h} is taken, join with another handle: {other}.')
    else:
        print(f'  Next: run the same join again: {again} (the invite code may have been used by the join that was lost: '
              'if it is refused, ask for a new one, or join without one, --sandbox). If it answers that '
              f'{h} is taken, ask the operator who gave you the invite to finish or release that participant, or join '
              f'with another handle: {other}.')
    return 1


def _join_not_sent(args, e, handle, operator, server):
    """`valun join` that did not reach the server (unreachable, not_connected): nothing was sent, so it holds nothing."""
    print(f'Joining stopped ({_failure(e)}): {_terminal_text(e)}. Nothing was sent, so the server holds nothing of '
          'this join.')
    print(f'  Next: check the connection with `{_valun()} --profile {_profile(args)} doctor{_server_flag(server)}`, then '
          f'run the same join again: {_join_command(args, server, handle, operator)}.')
    return 1


def _refuses_handle(e):
    """Is this refusal about the handle itself, which no join of it gets past (its shape, a participant id's shape, a
    placeholder: invalid_field of the handle; a reserved handle), so that a join of it whose answer was lost made no
    participant either? A refusal of anything else (the operator, the invite, a rate limit) says nothing of that (the
    0.7.2 review: the first RC forgot the lost join on any 4xx)."""
    x = e.extra if isinstance(e.extra, dict) else {}
    if e.code == 'invalid_field':
        return x.get('field') == 'handle' or str(e).startswith('handle:')
    return e.code == 'handle_taken' and str(e).strip() == 'that handle is reserved'


def _join_refused(args, store, e, handle, operator, server):
    """`valun join` that the server refused: its words, and for handle_taken what holds the handle and the next command
    (the hold contract: a 409 that names held_until and retry_after_ms is a join that did not finish). The lost join of
    this handle that the profile keeps is forgotten only when the refusal is about the handle itself (_refuses_handle)."""
    print(f'Joining failed ({e.code}): {_terminal_text(e, 600)}')
    if e.code == 'redirected':         # nothing was done (client.redirect_error): the same join, at the address it named
        loc = e.extra.get('location') if isinstance(e.extra, dict) else None
        if isinstance(loc, str) and vc.origin_of(loc) == loc:
            print(f'  Next: if {loc} is your Valun server, join it: {_join_command(args, loc, handle, operator)}.')
        return 1
    h, lost = _shell_word(handle), lost_join_of(store.state)
    mine = lost if lost and lost['handle'] == str(handle).lower() and lost['server'] == server else None
    other = _join_command(args, server, handle, operator, other_handle=True) + NEW_HANDLE_NOTE
    if _refuses_handle(e):
        if mine:
            _forget_lost(store)         # no join of this handle gets past this refusal: it made no participant either
        print(f'  Next: join with another handle: {other}.')
        return 1
    mine_at = _terminal_text(mine['at'], 40) if mine else ''
    if e.code == 'invalid_invite' and mine and mine.get('sandbox') is False:
        # The invite was used: most likely by the join whose answer was lost (an invite is used once).
        no_invite = _join_command(argparse.Namespace(**{**vars(args), 'sandbox': True}), server, handle, operator,
                                  other_handle=True) + NEW_HANDLE_NOTE
        print(f"  This profile's join of {h} at {mine_at} got no answer, so it probably used this invite and made that "
              'participant. Its owner token was only in the answer that was lost, so ' + _held_words(h, False))
        print('  Next: ask the operator who gave you the invite to finish or release that participant, or join without an '
              f'invite: {no_invite}.')
        return 1
    if e.code != 'handle_taken':
        return 1
    hold, again = _hold_of(e), _join_command(args, server, handle, operator)
    if hold:
        print(f'  {h} is held for a join that did not finish (its agent never enrolled), {_when_text(*hold)}'
              + (f": this profile's join of {h} at {mine_at} got no answer, so it is probably that one" if mine else '')
              + '.')
        print(f'  Next: run the same join again then: {again}; or join now with another handle: {other}.')
    elif mine and mine.get('sandbox') is False:
        print(f"  This profile's join of {h} at {mine_at} got no answer: the server probably made that participant, and "
              'its owner token was only in the answer that was lost, so ' + _held_words(h, False))
        print(f'  Next: ask the operator who gave you the invite to finish or release that participant, or join with '
              f'another handle: {other}.')
    elif mine:
        print(f"  This profile's join of {h} at {mine_at} got no answer: the server probably made that participant, and "
              'its owner token was only in the answer that was lost, so it cannot be finished here. This server names no '
              f'time it is held until, so it may keep {h} taken.')
        print(f'  Next: join with another handle: {other}.')
    else:
        print(f'  If that participant is yours, from a join that stopped before its agent was enrolled, finish it '
              f'instead: `{_valun()} --profile NAME join` in the profile that ran that join, or, with your owner '
              f'token, an enrollment code from the owner console and `{_valun()} --profile NAME enroll`. Otherwise join '
              f'with another handle: {other}.')
    return 1


def _forget_lost(store):
    try:
        store.update(lambda state: state.pop(LOST_JOIN, None))
    except Exception:  # noqa: BLE001 - left as it is
        pass


# What a join that stopped on an unexpected error (a disk that is full, say) had not done yet, by the step it was in
# (cmd_join; decision D-3 c). Each leaves the profile on the safe side, and says how to finish.
JOIN_NOT_DONE = {
    'enroll': ("registering and storing this agent's key: issue an enrollment code in the owner console "
               '({server}/pilot#owner) with your owner token, then run `{valun} --profile {name} enroll --server {server} '
               '--participant {pid}`'),
    'settings': ("this profile's settings (until they are set it asks before each commitment, and its client signs no "
                 'consent by itself) and your owner mandate (approvals, auto_clear): set them with `{valun} --profile {name} '
                 'config ...` and in the owner console ({server}/pilot#owner)'),
    'mandate': ("your owner mandate's approve_above and auto_clear: set them in the owner console ({server}/pilot#owner) "
                '(with --approvals console this profile asks before each commitment until then)'),
    'approvals': ('console approvals in this profile: it asks before each commitment until you run '
                  '`{valun} --profile {name} config approvals console --owner-token-file FILE` (FILE: the file holding your '
                  'owner token)'),
    'clearing': ('consents.setoff off in this profile, so its client may still sign set-offs by itself: run '
                 '`{valun} --profile {name} config consents.setoff off`'),
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
        print(f'  Not done either ({_failure(e)}): ' + JOIN_NOT_DONE['clearing'].format(name=name, valun=_valun()) + '.')
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


def _join_steps(args, store, c, j, server, handle, owner, step, key=None):
    """`valun join` once its owner token was handed over: register this agent's key (`key`, the one this join kept in
    the profile before it was sent, else a new one), save the profile, pin the network, set the owner mandate, and say
    what is in force. step[0] names the step it is in, for cmd_join's message when an unexpected error stops it.
    Returns True when every step was done; False after saying what is not done and how to finish it (with commands
    that name this profile)."""
    pid = j['participant_id']
    # What `valun join` (again) or `valun enroll` needs to finish this join if the answer to its enrollment is lost:
    # Client.enroll keeps it with the key it saves before sending (the Nov 17 tester report).
    context = {'handle': handle, 'sandbox': bool(args.sandbox), 'approvals': args.approvals, 'clearing': args.clearing}
    if isinstance(j.get('enrollment_expires_at'), str):
        context['expires_at'] = j['enrollment_expires_at']
    # The join was answered: its key goes to this enrollment, which saves it as its pending enrollment before it sends
    # anything (cmd_join then drops what the profile kept of an earlier join).
    try:
        r = c.enroll(pid, j['enrollment_code'], context=context, secret=key)
    except Exception as e:  # noqa: BLE001 - a request refused, or a key that could not be stored (OSError)
        if not _key_stored(args, pid):
            # The profile is not saved (it holds no key), so the command names the server as well as the profile. The
            # participant id is the server's word: printed only when it has a participant id's shape (the 0.7.2 review).
            pid = _pid_word(pid)
            name, v = _profile(args), _valun()
            enroll = f'`{v} --profile {name} enroll --server {server} --participant {pid}`'
            if isinstance(e, vc.ValunError) and e.code == 'enroll_unconfirmed' and e.extra.get('kept_key'):
                # No answer to the enrollment arrived, the same request sent again included: the key and code are kept
                # in this profile, so join (again) or enroll sends it once more.
                until = context.get('expires_at')
                print(f"Your participant {pid} was created, and this agent's key is saved in this profile, but no answer "
                      f"to its enrollment arrived ({e.extra.get('tries')} tries; the last: {_terminal_text(e.extra.get('last'))}).")
                print(f'To finish: run `{v} --profile {name} enroll` (or this join again) while the enrollment code is '
                      f'valid' + (f' (until {_terminal_text(until, 40)})' if until else '') + ': it sends the same '
                      'enrollment again, with no code to give. Once that time is over: in the owner console '
                      f'({server}/pilot#owner), with your owner token, revoke this agent if it shows a key (that gives a '
                      f'new code), or else issue an enrollment code, then run {enroll}.')
                return False
            if isinstance(e, vc.ValunError) and e.code == 'enroll_token_lost':
                print(f"Your participant {pid} was created, and the server registered this agent's key, but its answer, "
                      "the only copy of the agent's token, was lost on the way, and the server answers no token for that "
                      'key again.')
                print(f'To finish: in the owner console ({server}/pilot#owner), with your owner token, revoke this agent, '
                      f'which gives a new enrollment code, then run {enroll}.')
                return False
            # Refused, or never reached the server: no key is registered. wrong_network is the core's check of the
            # server's answer (0.5): the server registered the key, so it is the case below.
            if isinstance(e, vc.ValunError) and e.code != 'wrong_network':
                print(f"Your participant {pid} was created, but this agent's key could not be registered "
                      f'({_failure(e)}): {_terminal_text(e)}')
                if c.pending_enrollment() is not None:      # a 429: the key and the code are kept, the code unused
                    print(f'To finish: run `{v} --profile {name} enroll` in a moment: the key and the enrollment code are '
                          'kept in this profile, so it sends the same enrollment again (no code to give) while the code '
                          f'is valid. Once that time is over: issue an enrollment code in the owner console '
                          f'({server}/pilot#owner) with your owner token, then run {enroll}.')
                else:
                    print(f'To finish: issue an enrollment code in the owner console ({server}/pilot#owner) with your '
                          f'owner token, then run {enroll}.')
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
    # The local settings (_join_settings). Console approvals are recorded only once the mandate holds what console holds
    # for the owner (below: approve_above 0, review_deliveries on); until then this profile asks (the default), so that a
    # mandate step that fails leaves it on the safe side.
    step[0] = 'settings'
    store.state.update(_join_settings(store, server, args.sandbox, args.approvals))
    if getattr(args, 'owner_token_written', None):
        store.state[OWNER_TOKEN_FILE] = args.owner_token_written     # its path only, for `valun console`
    store.save()
    print(f"Joined Valun as {handle} ({_pid_word(pid)}) on {server}. This agent's key was generated here; "
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
    unit = vc.network_of(store.state.get('network') or vc.NETWORK)['unit']
    token_file = getattr(args, 'owner_token_written', None)
    token_word = (_faithful(token_file, 300) if token_file else None) or 'FILE'
    # FILE where the path cannot be printed as one word (not written, or a " $ ` ! % in it), and always said what it is
    # (the RC's review, regressions R2-OTHER-9 c)
    token_note = ' (FILE: the file holding your owner token)' if token_word == 'FILE' else ''
    print(JOIN_APPROVALS[args.approvals].format(server=server, per_deal=vc.amount_text(limits.get('max_issue_per_deal'), unit),
                                                total=vc.amount_text(limits.get('max_issue_outstanding'), unit), valun=_valun(),
                                                name=_profile(args), token_file=token_word, token_note=token_note))
    if getattr(args, 'approvals_answered', False):      # the answer to the approvals question (fix inbox #164)
        lead, other = (('You answered that a person will approve. If nobody will', 'none') if args.approvals == 'console'
                       else ('You answered that nobody will approve. If a person will, in the owner console', 'console'))
        print(f'  {lead}: `{_valun()} --profile {_profile(args)} config approvals {other} --owner-token-file {token_word}`'
              + ('; FILE: the file holding your owner token' if token_note else '') + '.')
    finished, name, v = True, _profile(args), _valun()
    if circulating:
        print(f'Clearing: {clearing}. ' + ('Your Valun client signs set-offs that leave your net position unchanged, and '
                                           'transfers of notes you issued to a new holder, by itself; ' if clearing == 'auto' else
                                           'set-offs are off in your owner mandate; ')
              + (f'it also accepts payments by transfer (notes your owner mandate accepts), and signs them in the '
                 f'background while `{v} --profile {name} mcp` (consent_loop on) or `{v} --profile {name} clearing watch` '
                 'runs. ' if args.sandbox else 'payments to you by transfer are off until you turn them on. ')
              + f'See `{v} --profile {name} policy show`; change it with `{v} --profile {name} config consents.<role> '
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
    print('\n'.join(_next_lines(args, circulating)))
    return finished


def _next_lines(args, circulating):
    """Join's last lines: doctor, then two equal branches, one for an agent in an MCP app and one for an agent that runs
    Valun from a shell (the Nov 18 fresh-join run, finding 3: join ended with the MCP line only, in 0.7.1, and the RC
    put the shell line after it, as an afterthought, and only where the server offers circulating credit; the
    first-tester readiness assessment of 2026-11-18, blocker 7: a shell agent's set-off waited until `valun clearing
    run`). From a shell, `valun call valun_inbox`, run regularly, shows what waits for the agent and, with circulating
    credit, signs the value-safe consents (the agent's consents_on_reads), and `valun clearing watch`, kept running,
    signs all the policy allows. The uvx form follows where uv started this one (_with_uvx), or, for a shell agent's
    later shell, unless uvx runs this one (_uvx_too)."""
    v, name = _valun(), _profile(args)
    shell = (f'  - From a shell: run `{v} --profile {name} call valun_inbox` regularly, which shows what waits for your agent'
             + (', and signs the set-offs and payments to you by transfer that your policy allows; or keep '
                f'`{v} --profile {name} clearing watch` running, which signs all your policy allows' if circulating else '')
             + f'{_uvx_too()}.')
    return [f'Next: run `{v} --profile {name} doctor`{_with_uvx()}, then, for your agent, one of:',
            f'  - In an MCP app: add `{v} --profile {name} mcp` to it (see `{v} mcp --help`).', shell]


def _token_file_refusal(args, server, handle, operator):
    """Before anything is sent: why the owner token file this join would write (--owner-token-file, else the default
    $HOME/valun-owner-token-HANDLE.txt) cannot be made, as join's whole answer ("Nothing was sent: ..."; exit 2), or None
    when it can. The Nov 18 fresh-join run (finding 4): a join that named a token file there already, or one whose folder
    could not take a new file, still sent the join, made the participant and printed its owner token on stdout, in the
    agent's context. It is refused when the file exists already (it may hold another identity's owner token, and join
    never replaces a file), or when its folder is missing, is not a folder, or cannot take a new file
    (home.new_file_refused: a private probe file made there and removed again)."""
    chosen = bool(args.owner_token_file)
    path = args.owner_token_file if chosen else default_owner_token_file(handle)
    folder = os.path.dirname(os.path.abspath(path))
    default = '' if chosen else ' (join writes your owner token there when no --owner-token-file is given)'
    if os.path.lexists(path):
        why = (f'{path} exists already{default}, and join never replaces a file: it may hold another owner token. Name a '
               'new file, one that does not exist yet')
    elif not os.path.isdir(folder):
        why = (f'the folder of {path}{default}, {folder}, does not exist, so your owner token could not be written '
               'there. Name a new file in a folder that exists')
    else:
        denied = new_file_refused(folder)
        if denied is None:
            return None
        why = (f'this user may not create a file in {folder} ({denied.rstrip(".")}), where {path}{default} would go. '
               'Name a new file in a folder you can write')
    retry = argparse.Namespace(**vars(args))
    retry.owner_token_file = 'FILE'
    return (f'Nothing was sent: {why}, and run this join again: {_join_command(retry, server, handle, operator)} (FILE: '
            "a new file for this join's owner token).")


def _token_sibling(path, n):
    """The n-th new file beside `path` for an owner token, when `path` appeared after join checked it: FILE.1.txt,
    FILE.2.txt, ... for FILE.txt (FILE.1 for a FILE with no extension)."""
    base, ext = os.path.splitext(path)
    return f'{base}.{n}{ext}'


TOKEN_SIBLINGS = 20                     # how many new files beside the one named join tries (_token_sibling)


def _hand_over(args, owner, server, handle=None, pid=None):
    """The owner token, to the owner, once: written to a new private file (_write_private: 0600, or on Windows a DACL
    that lets in only this user, SYSTEM and Administrators), --owner-token-file or, when it is not given, the default
    path (default_owner_token_file: $HOME/valun-owner-token-HANDLE.txt), so that it ends up in a file its owner can find
    and out of the output an agent may be reading. It is never printed on stdout (the Nov 18 fresh-join run, finding 4).
    Join refused an existing file, or a folder that could not take one, before anything was sent (_token_file_refusal),
    so what is left is a file that appeared in between (another join, say): it is never replaced (it may hold another
    identity's owner token), and the token goes to a new file beside it (_token_sibling), which join names. When no
    file can be written at all (the folder stopped taking files, the disk filled up), the token is shown on stderr only
    when stderr is a terminal (a person's, not an agent's pipe), and otherwise nowhere: join says how the owner gets a
    new one. False is returned whenever the token is not in the file named (join then exits 1 once its other steps are
    done, so that a script that relies on the file notices); True otherwise. args.owner_token_path: the file it was
    meant for; args.owner_token_written: the absolute path of the file it went to (the profile keeps it for `valun
    console`), else None."""
    chosen = bool(args.owner_token_file)
    path = args.owner_token_file if chosen else default_owner_token_file(handle)
    args.owner_token_path, args.owner_token_written = path, None
    keep = (f'Keep it private; never give it to your agent. Move it into your password manager once you have signed in '
            f'to the owner console ({server}/pilot#owner) with it.')
    try:
        _write_private(path, owner + '\n')
        args.owner_token_written = os.path.abspath(path)
        print(f'Your OWNER token is in {path}'
              + ('' if chosen else ' (no --owner-token-file was given: this is where join writes it)')
              + '. ' + keep + _not_private_note(path))
        return True
    except FileExistsError:
        failed = None
        for n in range(1, TOKEN_SIBLINGS + 1):
            other = _token_sibling(path, n)
            try:
                _write_private(other, owner + '\n')
            except FileExistsError:
                continue
            except OSError as e:
                failed = e
                break
            args.owner_token_written = os.path.abspath(other)
            print(f'{path} appeared after join checked it, and join never replaces a file (it may hold another owner '
                  f'token), so your OWNER token is in a new file beside it: {other}. ' + keep + _not_private_note(other))
            return False
        why = (f'{failed.strerror or failed}' if failed is not None else
               f'{path} and the next {TOKEN_SIBLINGS} names beside it exist already')
    except OSError as e:
        why = f'{e.strerror or e}'
    print(f'Cannot write {path} ({why}).')
    if _stderr_at_terminal():
        sys.stderr.write('Your OWNER token, shown once on this terminal only (never on stdout); keep it in a password '
                         f'manager, never give it to your agent; it opens {server}/pilot#owner where you can change limits '
                         f'or revoke this agent:\n  {owner}\n')
        sys.stderr.flush()
        print('Your owner token was shown once on this terminal (stderr), never on stdout: copy it into your password '
              'manager now.')
        return False
    who = _pid_word(pid) if pid else 'your participant'
    print('Your owner token was not shown either: stderr is not a terminal here, and an agent may be reading it. No copy '
          f'of it is kept, so nobody can sign in to the owner console ({server}/pilot#owner) for {who}, to approve what it '
          'holds for you, change limits or revoke the agent, until the operator of this server issues a new owner token '
          'for it, at your request' + (' (on valun.tech: https://valun.tech/start#report).' if server == DEFAULT_SERVER
                                       else '.'))
    return False


def _stderr_at_terminal():
    """Is stderr a terminal, where a person reads it (not an agent's pipe or a file)? The only place the owner token is
    ever shown, when no file can be written at all (_hand_over)."""
    try:
        return bool(sys.stderr.isatty())
    except (AttributeError, ValueError, OSError):
        return False


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
        written = getattr(args, 'owner_token_written', None)
        token = (_faithful(written, 300) if written else None)
        print('  Approvals: not yet held in the owner console, so this profile asks before each commitment (approvals '
              f'ask) until you run `{_valun()} --profile {name} config approvals console --owner-token-file '
              f"{token or 'FILE'}`" + ('' if token else ' (FILE: the file holding your owner token)') + '.')
    else:
        print(f'  Approvals: {args.approvals}; approve_above in your owner mandate was not set, so the owner console may '
              f'hold some commitments for you until you set it there ({server}/pilot#owner).')
    if circulating and clearing == 'off':
        store.update(_no_setoff)
        print('  Clearing: auto_clear was not turned off, so your client signs no set-off by itself (consents.setoff '
              'off); turn auto_clear off in the owner console too.')
    print(f'Then run `{_valun()} --profile {name} doctor`{_with_uvx()}.')


def cmd_enroll(args):
    """Register this agent's key with an enrollment code (the owner console's, or a join's that did not finish). A
    profile that holds a pending enrollment (a join or enroll whose answer was lost, which kept the key and the code)
    sends that one again, with no code to give. The network signed for is the one the server names (_enroll_network);
    once enrolled, the profile gets the settings a join writes for this kind of participant (_settle_enrolled)."""
    store = _store(args)
    if store.token() and store.secret():
        print(f"Profile '{args.profile}' already holds an agent key. Revoke it in the owner console first, or use --profile.")
        return 1
    server = _server(args, store)
    pending = vc.pending_enrollment_of(store.state)
    if pending and pending['server'].rstrip('/') != server:
        pending = None                  # another server's: a new enrollment here replaces it
    participant = args.participant or (pending['participant_id'] if pending else None)
    asks_code = not args.code_from_stdin and not (pending and (participant or '').strip() == pending['participant_id'])
    if (not participant or asks_code) and not _at_terminal():   # no one to ask: the command to run
        return _enroll_not_asked(args, server, participant)
    try:
        participant = (participant or input('Participant id (vp_..., from your owner console): ')).strip()
        if pending and participant != pending['participant_id']:
            pending = None
        if args.code_from_stdin:
            code = sys.stdin.readline().strip()
        elif pending:
            code = pending['code']
        else:
            code = getpass.getpass('Enrollment code (not shown): ').strip()
    except EOFError:                    # its input ended at a prompt: NUL, which Windows calls a terminal
        print()
        return _enroll_not_asked(args, server, args.participant)
    context = None
    if pending and code == pending['code']:
        context = _pending_context(pending)
        print(f"Finishing the enrollment of {_pid_word(participant)} that this profile started at "
              f"{_terminal_text(pending['since'], 40)}: its agent's key and enrollment code were kept here, and the same "
              'enrollment is sent again.')
    ok, net, server_net = _enroll_network(args, store, server, participant)
    if not ok:
        return 1
    return _enroll_and_settle(args, store, server, participant, code, net, server_net, context)


def _finish_pending(args, store, pending):
    """`valun join` in a profile whose join stopped after its participant was made and its agent's key saved: the same
    enrollment again (Client.enroll sends the kept key and code), then the settings the join would have written."""
    ctx, pid = _pending_context(pending), pending['participant_id']
    handle = ctx.get('handle') if isinstance(ctx.get('handle'), str) else None
    print(f'Finishing the join of ' + (f'{_shell_word(handle)} ({_pid_word(pid)})' if handle else _pid_word(pid))
          + f" that this profile started at {_terminal_text(pending['since'], 40)}: the participant exists, and its "
          "agent's key and enrollment code were kept here, so the same enrollment is sent again (no new participant).")
    server = pending['server'].rstrip('/')
    ok, net, server_net = _enroll_network(args, store, server, pid)
    if not ok:
        return 1
    return _enroll_and_settle(args, store, server, pid, pending['code'], net, server_net, ctx)


def _enroll_network(args, store, server, pid):
    """The network an enrollment signs for (the proof of possession names it, and a server refuses a proof for another
    network: bad_signature, 403). The one the server names (GET /pilot/v1/info): a profile that names another is refused
    here, before anything is signed or sent, since its key would sign for the wrong network. When the server's network
    cannot be read: the profile's own, else the one network (valun-testnet-1), never the client's default, the retired
    pilot's (0.7.1 signed a new profile's enrollment for valun-pilot-1, which valun.tech refuses; the Nov 17 tester report).
    Set in the profile's state in memory (saved with the key). Returns (ok, network, the server's network or None)."""
    server_net = _server_network(server)    # its answer can be lost on the way (the Nov 17 tester report): read again inside
    mine = store.state.get('network')
    mine = mine if isinstance(mine, str) and mine else None
    if mine and server_net and mine != server_net:
        print(f'Enrollment not sent: this profile is on {mine}, and {server} serves {server_net}, so a key enrolled from '
              f'it would sign for the wrong network (the server refuses such a proof: bad_signature). Enroll in a profile '
              f'of its own: `{_valun()} --profile NAME enroll{_server_flag(server)} --participant {_pid_word(pid)}` (NAME: '
              f'a profile name not used yet){_with_uvx()}.')
        return False, None, server_net
    net = mine or server_net or vc.TESTNET
    if not mine and not server_net:
        print(f"({server}'s network could not be read (GET /pilot/v1/info), so this enrollment is signed for "
              f'{vc.TESTNET}, the one network.)')
    store.state['network'] = net
    return True, net, server_net


def _enroll_and_settle(args, store, server, pid, code, net, server_net, context=None):
    """Client.enroll, then the profile's settings (_settle_enrolled); says what happened. 0 when enrolled, else 1."""
    c = vc.Client(store, server)
    try:
        r = c.enroll(pid, code, context=context)
    except vc.ValunError as e:
        for line in _enroll_refusal(args, e, server, pid, net, server_net):
            print(line)
        return 1
    except Exception as e:  # noqa: BLE001 - the answer arrived, but the profile could not be saved (OSError, say)
        print(f'Enrollment stopped ({_failure(e)}): {_terminal_text(e)}')
        print(f"  The server registered this agent's key, but it could not be stored here. To finish: in the owner "
              f'console ({server}/pilot#owner), with your owner token, revoke this agent, which gives a new enrollment '
              f'code, then run `{_valun()} --profile {_profile(args)} enroll{_server_flag(server)} --participant '
              f'{_pid_word(pid)}`.')
        return 1
    print(f"Enrolled {_pid_word(pid)} on {r['network']}. This agent's public key: {r['pubkey'][:16]}... (key stored privately)")
    if r.get('enrolled_again'):
        print('  An earlier request of this enrollment had registered the key, and its answer was lost: the server '
              "answered the agent's token again.")
    for line in _settle_enrolled(args, store, c, server, context or {}):
        print(line)
    return 0


def _enroll_refusal(args, e, server, pid, net, server_net):
    """What an enrollment that was refused, or not confirmed, says: what happened and how to finish, with commands that
    name this profile. A 403 says which of its two causes it is, and what this profile signed for (the Nov 17 tester report:
    a 403 with nothing that said the proof named the retired pilot's network)."""
    v, name, pidw = _valun(), _profile(args), _pid_word(pid)
    again = f'`{v} --profile {name} enroll{_server_flag(server)} --participant {pidw}`'
    console = f'the owner console ({server}/pilot#owner)'
    x = e.extra if isinstance(e.extra, dict) else {}
    if e.code == 'enroll_unconfirmed':
        lines = [f"Enrollment not confirmed: no answer to it arrived ({x.get('tries')} tries; the last: "
                 f"{_terminal_text(x.get('last'))}), so whether the server registered this agent's key is not known."]
        if x.get('kept_key'):
            lines.append(f"  This agent's key and the enrollment code are kept in this profile. To finish: run "
                         f'`{v} --profile {name} enroll` again while the code is valid: it sends the same enrollment, '
                         'with no code to give.')
        return lines
    if e.code == 'enroll_token_lost':
        return ["Enrollment failed (enroll_token_lost): the server registered this agent's key, by a request of this "
                "enrollment whose answer was lost on the way. That answer was the only copy of the agent's token, and "
                'the server answers no token for the key again, so this agent cannot sign in with it.',
                f'To finish: in {console}, with your owner token, revoke this agent, which gives a new enrollment code, '
                f'then run {again} with it.']
    if e.code == 'bad_signature' or (e.code == 'http_error' and e.status == 403):
        nets = (f'this profile signed for {net}, and {server} serves {server_net}' if server_net else
                f"this profile signed for {net}, and {server}'s network could not be read (GET /pilot/v1/info)")
        if e.code == 'bad_signature':
            lines = ['Enrollment failed (bad_signature): the server did not accept the proof that this agent holds its key.',
                     f'  The proof signs the network with the participant, the key and the code: {nets}. Nothing was '
                     'registered, and the code is still valid.']
        else:
            lines = ['Enrollment failed (HTTP 403): the server refused the enrollment, but its explanation did not arrive.',
                     '  A 403 to an enrollment is one of two refusals: the enrollment code is wrong, used or expired '
                     f"(invalid_enrollment), or the proof names another network than the server's (bad_signature: {nets})."]
        if server_net and server_net != net:
            lines.append(f'To finish: enroll in a profile of its own for {server_net}: `{v} --profile NAME enroll'
                         f'{_server_flag(server)} --participant {pidw}` (NAME: a profile name not used yet).')
        elif not server_net:
            lines.append(f'To finish: run {again} again once {server}/pilot/v1/info answers: the enrollment then signs '
                         'for the network it names.')
        elif e.code == 'bad_signature':
            lines.append(f'  The networks match, so the network is not the cause: run `{v} --profile {name} doctor` and '
                         'report what it says.')
        else:
            lines.append(f'To finish: run {again} once more; if it is refused again, issue a new enrollment code in '
                         f'{console} with your owner token and run it with that code.')
        return lines
    if e.code == 'invalid_enrollment':
        return ['Enrollment failed (invalid_enrollment): the server registered no key, because it does not take this '
                'enrollment code: it is wrong, used already, or expired (a code works once, for a short time: the owner '
                'console shows until when).',
                f'To finish: in {console}, with your owner token, issue a new enrollment code (when the console shows an '
                f'agent key, revoke that agent instead: that gives a new code), then run {again} with it.']
    if e.code == 'wrong_network':     # the core's check of the answer: the server registered the key already
        return [f'Enrollment failed ({e.code}): {_terminal_text(e)}',
                "The server registered this key but named another network than this profile's, so the key was not "
                'stored. Use a profile of its own for that network (valun --profile NAME), and in the owner console, '
                'with your owner token, revoke this agent to get a new enrollment code.']
    return [f'Enrollment failed ({e.code}): {_terminal_text(e)}']


def _sandbox_of(c, context):
    """Whether the participant this client just enrolled is a sandbox one (`join --sandbox`): its GET /me says
    (participant.sandbox_only; also the agent's first call, after which it shows as active), else its public record,
    else the join that started this enrollment. None when none of them says."""
    for read in (lambda: c.me().get('participant'), lambda: c.participant(c.participant_id)):
        try:
            p = read()
        except Exception:  # noqa: BLE001 - not read: the next source
            continue
        if isinstance(p, dict) and (p.get('id') or p.get('handle')):
            return p.get('sandbox_only') is True
    s = context.get('sandbox') if isinstance(context, dict) else None
    return s if isinstance(s, bool) else None


def _settle_enrolled(args, store, c, server, context):
    """The settings an enrolled profile gets, as a join writes them for its kind of participant (_join_settings): the
    consent policy and consent loop (when the profile has none of its own), check_link_hosts, the server, and approvals
    (the join's, ask when it was console, which needs the owner token; else the profile's own, else ask). A join whose
    --clearing was off signs no set-off by itself (consents.setoff off), since auto_clear was not set. Then GET /info
    pins the network. Returns the lines to print; never raises (0.7.1 ended with a traceback when /info was lost)."""
    v, name = _valun(), _profile(args)
    sandbox = _sandbox_of(c, context)
    approvals = context.get('approvals') if context.get('approvals') in APPROVAL_MODES else 'ask'
    settings = _join_settings(store, server, bool(sandbox), approvals) if sandbox is not None else None
    wrote = []

    def apply(state):
        wrote.clear()
        state['server'] = server
        state.setdefault('approvals', settings['approvals'] if settings else 'ask')
        if settings:
            for k in ('check_link_hosts', 'consent_loop'):
                state.setdefault(k, settings[k])
            if not isinstance(state.get('consent_policy'), dict):
                state['consent_policy'] = settings['consent_policy']
                wrote.append('consent_policy')
        if context.get('clearing') == 'off':
            _no_setoff(state)
    lines = []
    try:
        store.update(apply)
    except Exception as e:  # noqa: BLE001 - say what is not set, and how
        lines.append(f"Settings not saved ({_failure(e)}): {_terminal_text(e)}. Until they are, this profile asks before "
                     f'each commitment and its client signs no consent by itself: set them with `{v} --profile {name} '
                     'config ...`.')
        settings = None
    features = _pin(c)
    see = f'See `{v} --profile {name} policy show`; change it with `{v} --profile {name} config consents.<role> on|off`.'
    if settings and wrote and sandbox:
        lines.append('Settings, as a sandbox join writes them: your client signs set-offs that leave your net position '
                     'unchanged, transfers of notes you issued to a new holder, and payments to you by transfer by itself, as far as your '
                     f'owner mandate allows, and signs them in the background while `{v} --profile {name} mcp` (consent_loop '
                     f'on) or `{v} --profile {name} clearing watch` runs. ' + see)
    elif settings and wrote:
        lines.append('Settings, as a join writes them: your client signs set-offs that leave your net position unchanged '
                     'and transfers of notes you issued to a new holder by itself, as far as your owner mandate allows; payments to you by '
                     'transfer are off until you turn them on. ' + see)
    elif settings:
        lines.append(f'Settings: the consent policy this profile had is kept. {see}')
    elif sandbox is None:
        lines.append('Settings: whether this participant is a sandbox one could not be read, so no consent policy was '
                     'written, and until one is your client signs no consent by itself: '
                     f'`{v} --profile {name} config consents.setoff on` (and consents.as_issuer, consents.as_new_creditor).')
    if context.get('approvals') == 'console':
        lines.append('Not done: ' + JOIN_NOT_DONE['approvals'].format(name=name, valun=v) + '.')
    if context.get('clearing') == 'off':
        lines.append('Clearing: auto_clear was not turned off, so your client signs no set-off by itself (consents.setoff '
                     f'off); turn auto_clear off in the owner console ({server}/pilot#owner) too.')
    lines.extend(_next_lines(args, va.CIRCULATION in features))
    return lines


def _server_network(server, timeout=10):
    """The network GET /info of `server` names (an unauthenticated read), or None when it cannot be read. One request:
    Client.request sends a read whose answer was cut again itself (the 0.7.2 review: enroll's own three tries around it
    made up to nine requests, about 99 s, to a server that did not answer)."""
    try:
        info = vc.Client(_Mem(), server, timeout=timeout).request('GET', '/pilot/v1/info', auth=False)
    except Exception:  # noqa: BLE001 - not known
        return None
    net = info.get('network') if isinstance(info, dict) else None
    return net if isinstance(net, str) else None


def cmd_status(args):
    """What this profile is connected to, from the profile itself. Only for a profile of the pilot network (fix inbox
    #30) is the server read (GET /info): when it serves another network now, status says so and how to go on."""
    try:
        path = _profile_path(args)
    except ProfileUnreadable as e:      # its folder cannot be made: said in one line, never a traceback
        print(_unreadable_text(args, e))
        return 1
    print(f'profile:          {args.profile} ({path})')
    try:
        store = _store(args)
    except ProfileUnreadable as e:
        print(_unreadable_text(args, e))
        return 1
    st = store.state
    server, network = st.get('server') or DEFAULT_SERVER, vc.profile_network(st)
    bad = vc.server_problem(server.rstrip('/') if isinstance(server, str) else server)    # nothing is sent to it
    retired = None
    if network == vc.NETWORK and bad is None:
        now = _server_network(server)
        if vc.retired_pilot(st, now):
            retired = now if now in vc.NETWORKS else 'another network'     # the server's word: a name this client knows
    shown = (server if bad is None else vc.shown_server(server) if isinstance(server, str)
             else json.dumps(server, ensure_ascii=True)[:120])
    print(f"server:           {shown if shown != 'it' else '(not shown: it has a user name or password)'}")
    if retired:
        print(f'network:          {network}, retired on {vc.PILOT_RETIRED_ON} ({server} now serves {retired})')
    else:
        print(f"network:          {network if st.get('participant_id') or st.get('network') else '(not joined)'}")
    print(f"participant:      {st.get('participant_id') or '(not joined)'}")
    print(f"agent key stored: {'yes' if store.secret() else 'no'};  agent token stored: {'yes' if store.token() else 'no'}")
    # a profile that has not joined has no approval mode yet: its join sets one (the RC's review, R2-OTHER-3)
    print(f"approvals:        {st.get('approvals', 'ask') if st.get('participant_id') else '(not joined)'}")
    if isinstance(st.get('consent_policy'), dict) or 'consent_loop' in st:
        print(f"consents:         {_policy_line(st.get('consent_policy'), _unit_of(st))}; consent loop: {st.get('consent_loop', 'off')}")
    if retired:
        print(_retired_line(args, server, retired))
    if bad is not None:
        print(_bad_server_text(args, 'profile', server.rstrip('/') if isinstance(server, str) else server, bad))
        return 1
    return 0


# The profile's record of the file join wrote the owner token to, or that `valun config approvals` to or from console
# read it from: its absolute path only, never the token, for `valun console`.
OWNER_TOKEN_FILE = 'owner_token_file'


def _console_command(args):
    """The command that opens this profile's owner console (`valun console`), as its owner runs it in a terminal: what
    the answers that wait for the owner name (ValunAgent console_command)."""
    return f'{_valun()} --profile {_profile(args)} console'


def _no_browser():
    """Why no browser can be opened here, or None: a Linux or BSD session with no display (neither DISPLAY nor
    WAYLAND_DISPLAY: a server, or SSH without X forwarding), where webbrowser would start a text browser in this
    terminal, unless BROWSER names the browser to use."""
    if os.environ.get('BROWSER') or sys.platform.startswith('win') or sys.platform == 'darwin':
        return None
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        return 'this machine has no display (headless)'
    return None


def console_holds_all(mandate):
    """Does the owner mandate (GET /me) hold everything console approvals hold: approve_above 0 and review_deliveries on,
    as `valun config approvals console` and a console join set it?"""
    m = mandate if isinstance(mandate, dict) else {}
    above = m.get('approve_above')
    return isinstance(above, int) and not isinstance(above, bool) and above == 0 and m.get('review_deliveries') is True


def _mandate_words(mandate, unit=vc.UNIT):
    """The two settings of the owner mandate that hold commitments, as the owner console names them."""
    m = mandate if isinstance(mandate, dict) else {}
    above = m.get('approve_above')
    shown_above = vc.amount_text(above, unit) if isinstance(above, int) and not isinstance(above, bool) else 'not set'
    return f"Ask me above {shown_above}, Review deliveries {'on' if m.get('review_deliveries') is True else 'off'}"


def _console_words(mode):
    """What waits for the owner in the owner console, by this profile's approval mode, in the owner's words. What the
    console holds is the owner mandate's (Ask me above: approve_above; Review deliveries), which this command does not
    read: the words say what valun set it to and that the console shows what it is now (the 0.7.2 review: a profile
    enrolled with `valun enroll` is 'ask' even where its join set console, and an owner may change it there)."""
    if mode == 'console':
        return (f'Approvals: console. What waits for you there, with the owner mandate console sets (Ask me above 0, '
                f'Review deliveries on; the console shows yours): {CONSOLE_HOLDS}. {CONSOLE_DECIDES} Never held: '
                f'{CONSOLE_NEVER}. Nothing notifies you: your agent tells you, and the console checks again every 30 '
                'seconds while it is open.')
    return (f'Approvals: {mode}. The console holds only what your owner mandate holds, as the console shows it: your '
            "agent's offers, counter-offers, acceptances and guarantee offers priced above Ask me above, and, while Review "
            'deliveries is on, the note or payment by transfer it signs when it accepts a delivery. Where valun set your '
            'mandate (at join, or when this profile left console approvals), Ask me above is your per-deal limit, so '
            'nothing waits there by its price; leaving console keeps Review deliveries on until you untick it there. '
            "There you also change your agent's limits, or revoke it.")


def cmd_console(args):
    """valun console: the owner console of this profile's server (<server>/pilot#owner), where the owner signs in with
    the owner token, approves or rejects what waits for them, changes the agent's limits or revokes it. Prints its
    address, the file the owner token is in when the profile knows it (join wrote it, or `valun config approvals` read
    it; never the token itself), and what waits there in this profile's approval mode; then opens it in the default
    browser (webbrowser), unless --no-open, or there is no browser to open (a headless machine). Reads nothing from the
    server and signs nothing."""
    store = _store(args)
    st, name = store.state, _profile(args)
    url = f'{_server(args, store)}/pilot#owner'
    pid = st.get('participant_id')
    own = _own_server(args, store) if pid else None
    own_bad = vc.server_problem(own) if own else None
    if own_bad is not None:
        # This profile's own server is not a server URL (a user name and password in it, say): never repeated (the RC's
        # review, round 4, wrong-server-words-repeat-profile-server-password: the words below printed its password).
        print(f"Owner console: {url}, which is not this profile's server. " + _bad_server_text(
            args, 'profile', own, own_bad, f'Its owner token works only on its own server: never sign in at {url} with it.'))
    elif own:
        # The address --server names is not where this profile's participant and owner token are (the RC's review):
        # opened as asked, and said so, with where this profile's own console is.
        print(f"Owner console: {url}, which is not this profile's server: its participant {_pid_word(pid)} is on "
              f'{_terminal_text(own, 120)}, whose owner console is {_terminal_text(own, 120)}/pilot#owner. Its owner token '
              f'works only there: never sign in at {url} with it. `{_valun()} --profile {name} console` opens its own.')
    else:
        print(f'Owner console: {url}' + (f' (participant {_pid_word(pid)}, profile {name})' if pid else ''))
    token_file = st.get(OWNER_TOKEN_FILE)
    if own:
        pass                            # nothing of this profile's waits at that address
    elif not pid:
        print(f"Profile '{name}' is not joined yet, so it has no owner token: join first, "
              f'`{_sandbox_join(args, _server(args, store))}`.')
    elif isinstance(token_file, str) and token_file:
        shown_path = _terminal_text(token_file, 400)
        if os.path.isfile(token_file):
            print(f'Sign in with your owner token: it is in {shown_path} (open that file yourself; never paste the token '
                  'into a chat, and never give it to your agent).')
        else:
            print(f'Sign in with your owner token: this profile knows it from {shown_path}, which is no longer there '
                  '(moved into your password manager?): paste it from where you keep it.')
    else:
        print('Sign in with your owner token: join wrote it to the file named with --owner-token-file, or showed it '
              'once; this profile does not record where.')
    if pid and not own:                 # what waits there, in this profile's approval mode
        print(_console_words(st.get('approvals', 'ask')))
    why = 'you passed --no-open' if args.no_open else _no_browser()
    if why:
        print(f'Not opened in a browser ({why}): open the address above in a browser yourself.')
        return 0
    try:
        opened = webbrowser.open(url)
    except Exception:  # noqa: BLE001 - no browser could be started: the address is printed above
        opened = False
    print('Opened it in your default browser.' if opened else
          'No browser could be opened here: open the address above in a browser yourself.')
    return 0


def _policy_line(policy, unit=vc.UNIT):
    """The local consent policy in one line, its cap (consents.max_PC, a whole number of the network's unit) as an amount
    in that unit: '50000000 nanoERG (0.05 tERG)' on the testnet, never '50000000 PC' (the newcomer tests, 2026-11-17)."""
    p = policy if isinstance(policy, dict) else {}
    on = lambda k: 'on' if p.get(k) is True else 'off'  # noqa: E731
    cap = p.get('max_PC')
    return (f"setoff {on('setoff')}, as_issuer {on('as_issuer')}, as_new_creditor {on('as_new_creditor')}, "
            + (f'at most {vc.amount_text(cap, unit)} each (consents.max_PC)' if cap is not None else 'no cap (consents.max_PC none)'))


def _unit_of(state):
    """The unit of the network a profile is on (client.profile_network: the testnet's for one that has not joined)."""
    return vc.NETWORKS.get(vc.profile_network(state), {}).get('unit', vc.UNIT)


def cmd_doctor(args):
    """Plain checks with a fix for each problem. A profile that cannot be read is one (fix: restore it, or join again in
    a new profile), and so is a profile of the retired pilot network whose server serves another network now (fix inbox
    #30: join that one in a new profile, or use the profile 'testnet' that is on it); neither is checked further. The
    agent is not checked against a server that cannot be reached."""
    name = _profile(args)
    ok, problems = [], []
    ok.append(f'Valun {__version__}, Python {sys.version.split()[0]} on {sys.platform}; profiles in {home_dir()}')
    try:
        path = _profile_path(args)
    except ProfileUnreadable as e:      # its folder cannot be made: nothing else can be checked (WINACL-R4-4)
        return _doctor_report(ok, [_unreadable_text(args, e)])
    unreadable = None
    try:
        store = _store(args)
    except ProfileUnreadable as e:
        store, unreadable = None, e
        problems.append(_unreadable_text(args, e))
    perm = permission_problem(path)
    if perm and not (store is None and _access_denied(path)):     # an unreadable profile's own line says that already
        problems.append(perm)
    elif not perm and getattr(unreadable, 'kind', None) != 'folder_denied':     # its line names the folder already
        bad, words = _permissions_line(path)
        (problems if bad else ok).append(words)
    token_file = store.state.get(OWNER_TOKEN_FILE) if store is not None else None
    token_line = _token_file_line(token_file) if isinstance(token_file, str) and token_file else None
    if token_line:
        problems.append(token_line)
    try:
        server = _server(args, store if store is not None else _Mem())
    except BadServer as e:              # nothing is checked against it, and nothing is sent: that setting comes first
        problems.append(str(e))
        return _doctor_report(ok, problems)
    joined = store is not None and bool(store.state.get('participant_id') and store.secret() and store.token())
    own = _own_server(args, store)
    own_bad = vc.server_problem(own) if own else None
    if own_bad is not None:
        # This profile's own server is not a server URL (a user name and password in it, which 0.7.1's config server
        # stored, say): said as status says it, never repeated (the RC's review, round 4: the wrong-server words below
        # printed it, its password included). A joined profile's tokens go to no other server, so none went to --server.
        problems.append(_bad_server_text(args, 'profile', own, own_bad, (
            f'Its tokens go to no other server, so nothing with them was sent to {server}, and this agent was not '
            'checked there.') if store.state.get('participant_id') else 'Nothing was sent to it.'))
    elif own and store.state.get('participant_id'):
        # A joined profile's tokens go only to its own server (client.wrong_server_refusal): the agent is not checked here
        problems.append(f"--server {server} is not this profile's server: its participant "
                        f"{_pid_word(store.state['participant_id'])} is on {_terminal_text(own, 120)}, and its tokens go "
                        f'only there, so nothing with them was sent to {server}, and this agent was not checked there. '
                        f'Check it on its own server: `{_valun()} --profile {name} doctor`; if the profile has moved to '
                        f'{server}: `{_valun()} --profile {name} config server {_shell_word(server, 120)}`.')
    elif own:
        ok.append(f'--server {server}: this profile names {_terminal_text(own, 120)} as its server, and it has not joined '
                  f'yet (a join with --server {_shell_word(server, 120)} joins {server})')
    plain = _plain_http_words(server, name, joined and not own)
    if plain is not None:
        (problems if plain[0] else ok).append(plain[1])
    reachable, retired = False, None
    try:
        info = vc.Client(_Mem(), server).request('GET', '/pilot/v1/info', auth=False)
        kind = 'test coins of Ergo testnet, no monetary value' if info.get('network') == schemas.TESTNET else 'synthetic'
        ok.append(f"Server {server} reachable: {info['network']}, unit {info['unit']} ({kind})")
        reachable = True
        pins = store.state.get('pins') if store is not None else None
        if store is not None and vc.retired_pilot(store.state, info.get('network')):
            retired = info['network'] if info['network'] in vc.NETWORKS else 'another network'
            problems.append(_retired_line(args, server, retired))
        elif isinstance(pins, dict) and pins.get('tracker_nft_id'):
            if (pins.get('tracker_nft_id'), pins.get('denomination')) == (info.get('tracker_nft_id'), info.get('denomination')):
                ok.append('Tracker and unit: the ones pinned in this profile')
            else:
                problems.append('The server names a different tracker or unit than the ones pinned in this profile, so this '
                                'agent signs nothing (tracker_mismatch). Only if you know the network moved: '
                                f'`{_valun()} --profile {name} config server URL` pins it again.')
    except Exception as e:  # noqa: BLE001
        problems.append(_transport_line(server, name, e) or _redirect_line(server, name, e) or _proxy_line(server, name, e)
                        or f'Server {server} not reachable ({e}). Check `{_valun()} --profile {name} config server URL` and '
                        'your connection.' + _proxies_note())
    if store is None or retired:
        pass                    # the line above says how to go on: nothing else of this profile can be checked
    elif store.state.get('participant_id') and store.secret() and store.token():
        if reachable and not own and not (plain is not None and plain[2]):   # else a line above says why not
            _doctor_agent(store, server, name, ok, problems)
    elif vc.pending_enrollment_of(store.state):
        pending = vc.pending_enrollment_of(store.state)
        problems.append(f"Not connected yet: this profile's enrollment of {_pid_word(pending['participant_id'])} (started "
                        f"{_terminal_text(pending['since'], 40)}) did not finish: its agent's key and enrollment code are "
                        f'kept here, but no answer to it arrived. Run `{_valun()} --profile {name} enroll` to send it again '
                        f'(no code to give){_with_uvx()}.')
    elif lost_join_of(store.state):
        # The join that got no answer, run again as it was (_lost_args: its operator, flags and owner token file, never a
        # placeholder for a value it was given), and what may keep its handle taken, by its kind (the 0.7.2 review).
        lost = lost_join_of(store.state)
        h, sandbox = _shell_word(lost['handle']), lost.get('sandbox', True) is not False
        again = _join_command(_lost_args(args, lost), lost['server'], lost['handle'], lost.get('operator'))
        problems.append(f"Not connected yet: this profile's join of {h} on {_terminal_text(lost['server'], 120)} (sent "
                        f"{_terminal_text(lost['at'], 40)}) got no answer, so the server may hold a participant {h} made "
                        'by it, whose owner token was only in the answer that was lost. '
                        + ("This agent's key is kept here. " if _kept_join_key(store.state) else '')
                        + f'Run the join again: {again}'
                        + (f': if {h} is held, it says until when; if it is taken, join with another handle (public and '
                           'permanent)' if sandbox else
                           f": if {h} is taken, ask the operator who gave you the invite to finish or release that "
                           'participant, or join with another handle (public and permanent)')
                        + f'{_uvx_too()}.')
    else:
        v, srv = _valun(), _server_flag(server)
        problems.append(f'Not connected: run `{_sandbox_join(args, server)}` (no invite: sandbox only), '
                        f'`{v} --profile {name} join{srv}` (with an invite) or `{v} --profile {name} enroll{srv}` (with an '
                        f'enrollment code){_uvx_too()}.')
    if store is not None and not joined:
        before = _approvals_before_join(args, store)
        if before:
            ok.append(before)
    elif store is not None:
        mode = store.state.get('approvals', 'ask')
        caveat = (f' {CLIENT_PROMPT_CAVEAT}' if mode == 'client-prompt' else
                  f' `{_console_command(args)}` opens the owner console.' if mode == 'console' else '')
        ok.append(f'Approvals: {mode}. ' + APPROVAL_TEXT.get(mode, '') + caveat)
    return _doctor_report(ok, problems)


def _doctor_report(ok, problems):
    """doctor's lines, the ok ones first, and its exit code: 0 when nothing is to fix, else 1."""
    for line in ok:
        print('  ok    ' + line)
    for line in problems:
        print('  FIX   ' + line)
    print('All set.' if not problems else f'{len(problems)} thing(s) to fix.')
    return 0 if not problems else 1


def _access_denied(path):
    """Windows: may this user not read the permissions of `path` (what an elevated run or another account made)?"""
    a = access_of(path) if os.name == 'nt' else None
    return a is not None and a['state'] == 'denied'


def _permissions_line(path):
    """doctor's line for the profile file's permissions where permission_problem names no problem: (a problem?, its
    words). A file that is not there yet is never called private (the RC's review, windows-acl W4, regressions
    R2-OTHER-8): its folder is read instead, which may let others replace the file valun writes there. A drive that
    keeps no permissions is not checked (WSL's share; FAT32 and exFAT let everyone in, and permission_problem names
    them)."""
    folder = os.path.dirname(os.path.abspath(path))
    if not os.path.exists(path):
        a = access_of(folder) if os.name == 'nt' else None
        if folder_denied(path):         # never "no profile file yet": the one in it may be there (round 3, WIN4)
            return (True, _unreadable_text(None, ProfileUnreadable(path, 'this user may not open its folder',
                                                                     kind='folder_denied')))
        refused = _folder_refusal(path)
        if refused:                     # never "lets in only you" for a folder a join cannot save in (WINACL-R4-5)
            return (True, f'No profile file yet, and {refused}')
        if a is not None and a['state'] == 'ok' and (a['others'] or a['owner']):
            return (True, f'No profile file yet, and its folder {folder} also lets in {who_else(a)}, who could replace the '
                          f'profile valun writes there. Fix: `{folder_fix(folder, a)}`.')
        return (False, 'Profile file permissions: no profile file yet' + (
            f' (its folder {folder} lets in only you, SYSTEM and Administrators)' if a is not None and a['state'] == 'ok'
            else ''))
    a = access_of(path) if os.name == 'nt' else None
    if a is not None and a['state'] == 'no_acl':
        return (False, "Profile file permissions: not checked (this file's drive keeps no permissions, as WSL's share "
                       'does): it is as private as that drive')
    if a is not None and a['state'] != 'ok':
        return (False, 'Profile file permissions: not checked (Windows could not read them)')
    return (False, 'Profile file permissions: private')


def _folder_refusal(path):
    """When this user may not create a file in the folder of the profile `path` (home.new_file_refused: a read-only
    grant, or Windows Security's Controlled folder access), the words that say so and how to fix it; else None. A join
    is refused then, before anything is sent, and doctor says it in its line for a profile not there yet (the RC's
    review, round 3, windows-acl WINACL-R4-5: the join made its participant, and then could not save its key)."""
    folder = os.path.dirname(os.path.abspath(path))
    why = new_file_refused(folder) if os.path.isdir(folder) else None
    if why is None:
        return None
    if os.name == 'nt':
        a = access_of(folder)
        fix = (f'Fix, from an elevated shell (another account owns it): {take_back_folder(folder)}'
               if a['state'] == 'ok' and a['owner'] else
               f'Fix: `{folder_fix(folder, a if a["state"] == "ok" else None)}`')
        fix += (" (if Windows Security's Controlled folder access protects it, allow valun there instead, or point "
                'VALUN_HOME at another folder)')
    else:
        fix = 'Make it writable for this user, or point VALUN_HOME at a folder you can write'
    return (f'this user may not create a file in the profiles folder {folder} ({why.rstrip(".")}), so a join could not '
            f"save its agent's key there. {fix}.")


def _token_file_line(path):
    """doctor's FIX line for the owner token file this profile records (join wrote it, or config approvals read it),
    when others can open it; None otherwise (the RC's review, windows-acl W5: one 0.7.2 records before its join made it
    owner-only, or a file config approvals named, kept its folder's permissions, and nothing read them)."""
    if not os.path.isfile(path):
        return None
    shown = _terminal_text(path, 400)
    if os.name != 'nt':
        mode = os.stat(path).st_mode & 0o777
        return (f'Your owner token file {shown} is readable by other users (mode {oct(mode)}): move the token into your '
                'password manager and delete the file.') if mode & 0o077 else None
    a = access_of(path)
    if a['state'] == 'denied':
        return (f'This user may not read the permissions of your owner token file {shown} (access denied): an elevated '
                f'run made it. From an elevated shell: {take_back(path)}; or move the token into your password manager '
                'and delete the file.')
    if a['state'] == 'ok' and (a['others'] or a['owner']):
        return (f'Your owner token file {shown} can also be opened by {who_else(a)}: move the token into your password '
                'manager and delete the file.')
    return None


def _approvals_before_join(args, store):
    """doctor's approvals line for a profile that has not joined: the mode the join its FIX line names will use, not
    this profile's own (the RC's staging test, 2026-11-18: doctor said "Approvals: ask" and suggested `join --sandbox`,
    which uses console approvals). A lost join: the join it runs again (its --approvals, else the default of its kind of
    join); a profile that never joined: a sandbox join's default and an invited join's. None for an enrollment that did
    not finish: `valun enroll` writes its settings, and says so. doctor prints its ok lines before its FIX lines, so a
    join it names is "the join in the FIX line below", and "not set yet" never reads as the mode none (the RC's review,
    regressions R2-OTHER-3)."""
    lost = lost_join_of(store.state)
    if vc.pending_enrollment_of(store.state) is not None:
        return None
    head = 'Approvals: not set yet (this profile has not joined).'
    if lost:
        again = _lost_args(args, lost)
        if again.approvals is None:     # a sandbox join that named no --approvals asks again (fix inbox #164)
            return (f'{head} The join in the FIX line below asks whether a person will approve them: console if one will, '
                    'none if nobody will.')
        kind = 'a sandbox' if again.sandbox else 'an invited'
        return (f'{head} The join in the FIX line below sets them to {again.approvals}'
                + ('' if again.approvals_given else f", {kind} join's default") + '.')
    return (f"{head} A sandbox join asks whether a person will approve your agent's commitments: console if one will "
            f'(your agent signs at once, and the Valun server holds {CONSOLE_HOLDS} for them in the owner console), none '
            'if nobody will (it signs on its own within the self-serve limits); --approvals answers it beforehand. A join '
            'with an invite uses ask: '
            'you are asked before your agent signs an offer, counter-offer or acceptance, accepts a delivery, offers, '
            'honors or releases a guarantee, or loosens a limit it recorded.')


def _doctor_agent(store, server, name, ok, problems):
    """doctor's check of a joined agent against its server (GET /me)."""
    try:
        cl = vc.Client(store, server)
        me = cl.me()
        m = me['mandate']
        ok.append(f"Agent accepted by the server as {me['participant']['handle']}; limits: at most "
                  f"{vc.amount_text(m['max_issue_per_deal'], cl.unit)} per deal, "
                  f"{vc.amount_text(m['max_issue_outstanding'], cl.unit)} owed in total")
        if me['participant'].get('status') != 'active':
            problems.append('The agent key is not active: ask the owner for an enrollment code, then '
                            f'`{_valun()} --profile {name} enroll`.')
    except Exception as e:  # noqa: BLE001
        cut = _transport_line(server, name, e) or _redirect_line(server, name, e)
        if cut:                 # the network on the way, never this agent: no revoke or enroll is suggested (#132)
            problems.append(cut + ' This agent itself could not be checked.')
        elif isinstance(e, vc.ValunError) and e.status in (401, 403):
            problems.append(f'The server refused this agent ({e.code}): if the owner revoked it, '
                            f'`{_valun()} --profile {name} enroll` again.')
        else:
            problems.append(f'This agent could not be checked ({_failure(e)}: {_terminal_text(e)}). Nothing was signed, '
                            f'and nothing says the server refused it: run `{_valun()} --profile {name} doctor` again in a '
                            'minute.' + (_proxies_note() if isinstance(e, vc.ValunError) and e.code == 'unreachable' else ''))


def _transport_line(server, name, e):
    """doctor's FIX line for a request that reached the server and whose answer was cut, or was not JSON, after the
    client's tries (client.transport_cut); None for anything else. Not a refusal, and not this agent: something between
    this machine and the server ended the connection or answered in its place (fix inbox #132: 0.7.1 said "the server
    refused this agent" and suggested enrolling again)."""
    if not vc.transport_cut(e):
        return None
    tries = 1 + len(vc.READ_RETRY_WAITS)
    if e.extra.get('cause') == 'timed_out':
        # No answer in time (asked once: the 0.7.2 review): the server may be busy; neither a cut nor a refusal.
        s = e.extra.get('timeout_s')
        within = f' within {s:g} s' if isinstance(s, (int, float)) and not isinstance(s, bool) else ''
        return (f'{server} did not answer{within} '
                f"({_terminal_text(e.extra.get('transport_error'), 40)}): it may be busy, or something between this "
                'machine and the server held the answer. Nothing refused this agent. Run '
                f'`{_valun()} --profile {name} doctor` again in a few minutes; if it keeps failing, try another '
                'network.' + _proxies_note())
    if e.extra.get('cause') == 'too_large':
        what = (f'The answer from {server} was too large to read (over {vc.size_text(vc.MAX_ANSWER_BYTES)} once '
                "decompressed): not the server's")
    elif e.code == 'bad_response':
        what = f"The answers from {server} were not JSON ({tries} tries): cut short, or not the server's"
    else:
        what = (f'The connection to {server} was cut before its answer was complete '
                f"({_terminal_text(e.extra.get('transport_error'), 40)}, {tries} tries)")
    return (what + '. The server was reached and nothing refused this agent: something between this machine and the '
            'server (its network, a VPN, antivirus that scans HTTPS, a captive portal or a proxy) ended the connection or '
            f'answered instead. Run `{_valun()} --profile {name} doctor` again; if it keeps failing, try another '
            'network.' + _proxies_note())


def _plain_http_words(server, name, joined):
    """doctor's line for an http:// server (the RC's review: doctor said "reachable" and nothing else while both clients
    sent the tokens over plain http to whatever host the URL named): (a problem?, its words, are tokens refused there?),
    or None for any other server. On this machine (client.loopback_host): an ok line, since nothing leaves it and no
    proxy is used. On another machine: a FIX line, whether this client refuses to send it tokens (without
    client.PLAIN_HTTP_ENV) or sends them in clear text (with it); `joined`: the agent check it then skips is named."""
    try:
        u = urllib.parse.urlsplit(server)
        host = u.hostname
    except ValueError:
        return None
    if u.scheme.lower() != 'http':
        return None
    if vc.loopback_host(host):
        return (False, f'Server {server} is plain http on this machine: its tokens never leave it, and no proxy is used '
                       'for it', False)
    https = vc.https_of(server)
    move = (f'Use its https:// address: `{_valun()} --profile {name} config server {_shell_word(https, 300)}`' if https
            else f'Use its https:// address: `{_valun()} --profile {name} config server URL`')
    if vc.plain_http_allowed():
        return (True, f'{server} is plain http on another machine, and {vc.PLAIN_HTTP_ENV}=1 is set, so this client sends '
                      "this agent's and its owner's tokens there in clear text: anyone on the network between can read "
                      f'them and act as this agent or its owner. {move}, and unset {vc.PLAIN_HTTP_ENV}.', False)
    return (True, f'{server} is plain http on another machine, so this client sends it no token, nor a join or an '
                  'enrollment, whose answers carry one: over plain http a token would cross the network in clear text. '
                  f'{move}. Only on a network you trust, {vc.PLAIN_HTTP_ENV}=1 sends tokens over plain http anyway.'
                  + (' This agent itself was not checked: that takes its token.' if joined else ''), True)


def _redirect_line(server, name, e):
    """doctor's FIX line for a redirect (client.redirect_error: this client follows none): where it pointed, and how to
    use that address if it is the server; never a refusal or a lost connection (the RC's review: a redirect that dropped
    the token came back as a 401, which doctor called a refusal, with enroll again as its fix). None for anything else."""
    if not (isinstance(e, vc.ValunError) and e.code == 'redirected'):
        return None
    loc = e.extra.get('location') if isinstance(e.extra, dict) else None
    loc = loc if isinstance(loc, str) and vc.origin_of(loc) == loc else None
    return (f"{server} answers with a redirect{f' to {loc}' if loc else ''}, and this client follows no redirect, so "
            'nothing was sent on there and nothing refused this agent. '
            + (f'If {loc} is your Valun server, use it: `{_valun()} --profile {name} config server {_shell_word(loc, 300)}`.'
               if loc else f'Check the address: `{_valun()} --profile {name} config server URL`.'))


def _proxy_line(server, name, e):
    """doctor's FIX line for a request this machine's proxy setting stopped before anything was sent (client.ProxyRefused:
    a setting Python cannot use, an https:// proxy URL with a user and password), by its scheme only, never its address
    or credentials (the RC's review, round 3); None for anything else."""
    x = e.extra if isinstance(e, vc.ValunError) and isinstance(e.extra, dict) else {}
    why = x.get('proxy_refused') if x.get('transport_error') == 'ProxyRefused' else None
    if not isinstance(why, str) or not why:
        return None
    return (f'Server {server} was not reached: {_terminal_text(why, 400)}. Nothing was sent. Correct or remove that proxy '
            f'setting, then run `{_valun()} --profile {name} doctor` again.')


def _proxy_host(value):
    """The host name urllib connects to for a proxy setting (a URL, or host:port as Windows Internet Settings write it),
    never its port, user or password; a stand-in for one that has no host name this client prints. Read as urllib's
    ProxyHandler reads it: urllib.request._parse_proxy's host:port, as client.proxy_refusal takes it (after the last @
    of an authority that ends at the first / after its first @), unquoted and split as http.client splits it. Not as
    urlsplit reads a URL (the RC's review, round 4, doctor-proxy-host-prints-proxy-user): it ends the authority at the
    first / ? or #, so for a user name or password with one of them in it unencoded, which urllib uses as meant, doctor
    printed the user name as the proxy's host, or the part of an API key before its /. Where another @ follows that
    authority (a password with an @ and then a / in it), urllib takes part of the password for the host: not printed."""
    parse = getattr(urllib.request, '_parse_proxy', None)
    try:
        hostport = parse(value)[3]
        url = re.match(r'[^/:]+:(//.*)', value, re.S)          # a URL, as _parse_proxy tells one from host:port
        if url and re.search(r'@[^/]*/.*@', url[1][2:], re.S):
            raise ValueError('an @ after the authority urllib reads')
        hostport = urllib.parse.unquote(hostport)              # as ProxyHandler.proxy_open connects to it
        i, j = hostport.rfind(':'), hostport.rfind(']')        # as http.client reads host:port
        h = (hostport[:i] if i > j else hostport).lower()
        h = h[1:-1] if h.startswith('[') and h.endswith(']') else h
    except (ValueError, TypeError, AttributeError):
        h = None
    if isinstance(h, str) and (re.fullmatch(r'[a-z0-9._-]{1,253}', h) or re.fullmatch(r'[0-9a-f:.]{2,45}', h)):
        return h
    return 'a host this client does not print'


def _proxies_note():
    """doctor's note on the proxy Python uses here, when urllib finds one (Windows Internet Settings, macOS System
    Settings, or the environment): curl and Node do not use it by default, so it may be what cuts Python's requests
    only (fix inbox #132). '' when there is none. Each scheme is named with its proxy's host name (_proxy_host), never
    its port, user or password: doctor's output goes into tester reports (the RC's review: getproxies() printed a
    proxy URL's user and password). doctor prints the host names itself (the RC's review, round 3, regressions
    R4-REG-2: the `python -c` command it named instead failed where `python` is not on the PATH, as on stock Ubuntu
    or a uvx install on Windows)."""
    try:
        proxies = urllib.request.getproxies()
        found = sorted(k for k, v in proxies.items() if k != 'no' and v)
        tls = sorted(k for k in found if isinstance(proxies[k], str) and proxies[k].strip().lower().startswith('https://'))
        hosts = ', '.join(f'{k} ({_proxy_host(proxies[k])})' for k in found)
    except Exception:  # noqa: BLE001 - not known
        return ''
    if not found:
        return ''
    note = (f' Python on this machine sends these requests through the proxy it sets for {hosts} (curl and Node do not '
            'use it by default), so that proxy may be what cut them.')
    if tls:
        # urllib reaches every proxy without TLS (the RC's review, round 3: Node reaches an https:// one over TLS)
        note += (f" The proxy URL Python sets for {', '.join(tls)} starts with https://, but Python reaches a proxy "
                 'without TLS: a proxy that speaks only TLS does not answer it (and this client refuses such a URL with a '
                 'user and password, which would cross the network in clear text).')
    return note


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
            # Holding commitments in the console is a server-side setting of the owner's mandate (approve_above). The
            # owner token is read once from --owner-token-file, else asked here, not shown (#136 item 1: the site tells
            # owners to move that file out of their agent's reach once console is set), and never stored.
            if not args.owner_token_file and not _at_terminal():
                print('Switching to or from console approvals changes your owner mandate on the server, which takes your '
                      'owner token: run again with --owner-token-file FILE (the file holding it; read once, not stored), '
                      'or in a terminal, where it is asked for (not shown).')
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
                          f'`{_valun()} --profile NAME config ...` changes another profile.')
                return 1
            server = _server(args, store)
            if val == 'console':
                print(f'Owner mandate updated (approve_above 0, review_deliveries on): {CONSOLE_HOLDS} now wait for you in '
                      f'the owner console ({server}/pilot#owner). {CONSOLE_DECIDES} Never held: {CONSOLE_NEVER}. '
                      f'`{_valun()} --profile {_profile(args)} console` opens the console.')
            else:
                print(f'Owner mandate updated: offers, counter-offers, acceptances and guarantee offers up to '
                      f'{vc.amount_text(cap, _unit(store))} no longer wait in the console.'
                      + (' Accepted deliveries still wait for your review (review_deliveries is on): the note or payment by '
                         'transfer your agent signs when it accepts a delivery is held for you until you approve it. Untick '
                         f'Review deliveries in the owner console ({server}/pilot#owner) if you no longer want it.'
                         if m.get('review_deliveries') else ''))
        changes = {'approvals': val}
        if (val == 'console') != (old == 'console') and args.owner_token_file:
            # Where the owner keeps the owner token, for `valun console` (the path only, never the token).
            changes[OWNER_TOKEN_FILE] = os.path.abspath(args.owner_token_file)
    elif key == 'server':
        why = vc.server_problem(val.rstrip('/'))
        if why is not None:             # 'http://' stored 'http:' (the RC's review, round 3): never a server URL
            print(f'server must be an http(s) URL with a host, such as {DEFAULT_SERVER}: {vc.shown_server(val.rstrip("/"))} '
                  f'{why}. Nothing was changed.')
            return 1
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
        elif val.strip().isdigit() and int(val) <= 100000 * vc.network_of(store.state.get('network') or vc.NETWORK)['scale']:
            changes = {key: int(val)}
        else:
            net = vc.network_of(store.state.get('network') or vc.NETWORK)
            print(f"consents.max_PC must be a whole number of {net['unit']} (0..{100000 * net['scale']}), or none for no cap")
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
              f"({_policy_line(store.state.get('consent_policy'), _unit_of(store.state))})")
        if key == 'consents.as_new_creditor' and changes[key]:
            print('Payments to you by transfer also need your owner mandate to allow them (accept_transfers and '
                  'accept_notes_from, in the owner console); the stricter of the two applies.')
    else:
        print(f'{key} = {store.state[key]}')
        if key == 'consent_loop':
            print(f'The consent loop runs inside `{_valun()} --profile {_profile(args)} mcp` (restart it to start the loop); it '
                  'signs only what your consent policy and owner mandate allow.')
        if key == 'brief_status':
            print('valun_status now answers its ' + ('brief view (for small models); a call can still pass brief=false.'
                                                    if store.state[key] else 'full view; a call can still pass brief=true.')
                  + f' Restart `{_valun()} --profile {_profile(args)} mcp` for your MCP app to use it.')
        if key == 'approvals':              # `valun mcp` reads the mode when it starts; `valun call` at every call
            print(f"Restart `{_valun()} --profile {_profile(args)} mcp` (your MCP app's Valun server) for your MCP app "
                  'to use it.' + (f' {CLIENT_PROMPT_CAVEAT}' if val == 'client-prompt' else ''))
            exposed = _token_file_line(changes[OWNER_TOKEN_FILE]) if OWNER_TOKEN_FILE in changes else None
            if exposed:                     # the file this profile now records for `valun console` (windows-acl W5)
                print(exposed)
    return 0


def _shown_value(v):
    return 'on' if v is True else 'off' if v is False else 'none' if v is None else str(v)


def cmd_tools(args):
    """The tool definitions, in the words of this profile's network (client.profile_network): the testnet's for a
    profile that has not joined yet, the one network it would join (fix inbox #15), and the pilot's only for a profile
    of the pilot."""
    try:
        network = vc.profile_network(_store(args).state)
    except Exception:  # noqa: BLE001 - no readable profile: the one network's words
        network = vc.TESTNET
    print(json.dumps(schemas.for_network(network), indent=1))
    return 0


def _rejoin_hint(args, store):
    """The agent's rejoin_hint for a profile of the pilot network (network_retired; fix inbox #30), else None."""
    return _rejoin(args) if vc.profile_network(store.state) == vc.NETWORK else None


def _agent(args, store):
    """The agent for `valun call`: one tool run, with no consent loop behind it, so before valun_status and valun_inbox
    it also signs the value-safe consents (consents_on_reads; decision D-3 a)."""
    mode, server = store.state.get('approvals', 'ask'), _server(args, store)
    return ValunAgent(store, approvals=APPROVAL_TEXT.get(mode, ''), check_link_hosts=store.state.get('check_link_hosts', True),
                      setup_hint=_join_hint(args, server), server=server,
                      consents_on_reads=True, brief_status=store.state.get('brief_status') is True,
                      rejoin_hint=_rejoin_hint(args, store), console_command=_console_command(args)), mode


# `valun call TOOL -` and `valun call TOOL --json-file PATH` (PATH `-`: standard input) take the tool's arguments where no
# shell parses them (fix inbox #165). Windows PowerShell 5.1 drops the inner double quotes of a JSON argument, and a
# launcher that runs the agent's command inside another `powershell -Command` (Codex on Windows) drops them from any JSON
# on that command line, whatever escapes it carries, the `--%` form included; a file the agent writes with its own file
# tool reaches valun as written.
STDIN_ARGUMENTS = '-'


def _decoded_arguments(raw, where):
    """The text of tool arguments read as bytes from `where` (a file, or standard input): UTF-8, with or without a BOM
    (Set-Content -Encoding utf8 in Windows PowerShell 5.1 writes one), or UTF-16 or UTF-32 by its BOM (5.1's `>` and
    Out-File write UTF-16), as json.detect_encoding tells them apart. Any other encoding is refused, never guessed: text
    read in the wrong code page would be signed as it was misread. (text, None), or (None, why)."""
    try:
        return raw.decode(json.detect_encoding(raw)), None
    except UnicodeDecodeError:
        return None, (f'{where} is not UTF-8 text: save it as UTF-8 (in PowerShell, Set-Content -Encoding utf8), or write '
                      'its other characters as \\u escapes. Nothing was sent.')


def _call_arguments(args):
    """The tool arguments of `valun call` as JSON text, and where they came from (None: the command line): the JSON
    argument as given ({} when there is none), standard input for `-` (as the JSON argument or as --json-file), or the
    file --json-file names. (text, where, None), or (None, where, why)."""
    given, path = args.json, args.json_file
    if path is not None and given is not None:
        return None, None, ('give the arguments one way: as the JSON argument, as - (standard input), or with '
                            '--json-file PATH. Nothing was sent.')
    if path is None and given != STDIN_ARGUMENTS:
        return ('{}' if given is None else given), None, None
    if STDIN_ARGUMENTS in (path, given):
        where = 'standard input'
        if sys.stdin is None:                       # none at all (a closed descriptor): nothing to read
            raw = b''
        else:
            if sys.stdin.isatty():
                print('valun call: reading the arguments from standard input; end them with Ctrl+Z then Enter on '
                      'Windows, Ctrl+D elsewhere.', file=sys.stderr)
            buf = getattr(sys.stdin, 'buffer', None)
            raw = buf.read() if buf is not None else sys.stdin.read()
    else:
        where = path
        try:
            with open(path, 'rb') as f:
                raw = f.read()
        except OSError as e:
            return None, where, f'the arguments file {path} cannot be read ({e.strerror or e}). Nothing was sent.'
    text, why = (raw, None) if isinstance(raw, str) else _decoded_arguments(raw, where)
    if why is None and not text.strip():
        why = (f'{where} holds no JSON: put the arguments there as one JSON object, or leave them out for a tool that '
               'needs none. Nothing was sent.')
    return (None, where, why) if why else (text, where, None)


def _file_form(args):
    """The end of `valun call`'s answer to a JSON argument that a shell changed: the file form, for this profile."""
    return ('If your shell changed the quotes (Windows PowerShell 5.1 drops the inner ones, which also splits the JSON at '
            'its spaces, and so does a launcher that runs your command in another PowerShell), write the JSON to a file '
            f'and run `{_valun()} --profile {_profile(args)} call {args.tool} --json-file FILE` instead.')


def _call_split(args, extra):
    """`valun call` given more than one argument after the tool: what Windows PowerShell 5.1 passes for a JSON argument
    whose values hold spaces (its inner quotes dropped, the rest split there). Said as bad_arguments with the file form,
    exit 2, where argparse printed its usage and "unrecognized arguments"."""
    shown = ' '.join(extra)
    print(json.dumps({'error': 'bad_arguments', 'message': (
        'arguments must be one JSON object, and more came after it: '
        f"{shown if len(shown) <= 200 else shown[:200] + '...'}. {_file_form(args)} Nothing was sent.")}))
    return 2


def cmd_call(args):
    text, where, why = _call_arguments(args)
    if why:
        print(json.dumps({'error': 'bad_arguments', 'message': why}))
        return 2
    try:
        tool_args = json.loads(text) if text else {}
    except ValueError as e:
        # from the command line: what Windows PowerShell 5.1 makes of '{"deal_id": "..."}' is {deal_id: ...}
        message = (f'arguments must be a JSON object: {e} (in {where})' if where is not None else
                   f'arguments must be a JSON object: {e}. {_file_form(args)}')
        print(json.dumps({'error': 'bad_arguments', 'message': message}))
        return 2
    store = _store(args)
    agent, mode = _agent(args, store)
    if mode in ('ask', 'client-prompt') and agent.is_commitment(args.tool, tool_args):   # no app here: this terminal asks
        unjoined = not_joined(agent)
        if unjoined:            # before a join: its hint, as valun_status gives it, not approval commands that need one
            print(_json_text(unjoined, indent=1, default=str))
            return 3
        piped = where == 'standard input'           # the input that would answer the prompt held the arguments
        if piped or not (sys.stdin.isatty() and sys.stdout.isatty()):
            name = _profile(args)
            print(json.dumps({'error': 'approval_unavailable', 'message': (
                'Not signed: this profile asks its owner before every commitment, and ' + (
                    'the arguments came from standard input, where the answer would be read, so this terminal cannot '
                    'ask (pass them with --json-file FILE to be asked here)' if piped else
                    'no person is at this terminal') + '. The owner can '
                f'run `{_valun()} --profile {name} config approvals console --owner-token-file FILE` (the agent then signs at '
                'once, and its offers, acceptances and guarantee offers, and the note or payment at each delivery, wait for '
                f'the owner in the owner console; FILE: the file holding the owner token) or `{_valun()} --profile {name} '
                'config approvals none`.')}))
            return 3
        prepared, refusal = agent.prepare_or_refusal(args.tool, tool_args)   # sign exactly what is shown here, read once
        if refusal:                                     # nothing is signed, and nobody is asked with a generic text
            print(_json_text(refusal, indent=1, default=str))
            return 3
        tool_args = prepared['args']
        if prepared['text'] is not None:                # None: the read prepare() made shows this call commits nothing
            print(prepared['text'], file=sys.stderr)
            try:
                said = input('Approve this commitment? [y/N] ')
            except (EOFError, KeyboardInterrupt):       # the prompt was closed, not answered: no one refused it
                print()
                print(_json_text(approval_cancelled(f'{_valun()} --profile {_profile(args)}', _server(args, store),
                                                    'the approval prompt was closed before it was answered: nothing was '
                                                    'signed'), indent=1))
                return 3
            if said.strip().lower() not in ('y', 'yes'):
                print(json.dumps({'error': 'owner_declined', 'message': 'not approved; nothing was signed'}))
                return 3
    try:
        result = agent.call_safe(args.tool, tool_args)
    except KeyboardInterrupt:
        if args.tool in va.READ_ONLY_TOOLS:
            raise                           # main() says it stopped, as for any command
        # Ctrl+C before the answer to a call that is not read-only came (fix inbox #148): its request may have reached
        # the server, so the answer says what a lost answer says, what to read before sending it again
        print(_json_text({'error': 'interrupted', 'message': f'stopped (Ctrl+C) before the answer to {args.tool} arrived',
                          'outcome': 'unknown', 'what_this_means': va.INTERRUPTED_WORDS}, indent=1))
        print('\nvalun call: stopped (Ctrl+C).', file=sys.stderr)
        return 130
    print(_json_text(result, indent=1, default=str))
    return 1 if 'error' in result else 0


def cmd_mcp(args):
    from .mcp_server import run
    store = _store(args)
    server = _server(args, store)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"valun mcp: profile '{_profile(args)}' is not joined yet; {_join_hint(args, server)} first. "
              'Starting anyway (tools will say so).', file=sys.stderr)
    return run(store, approvals=store.state.get('approvals', 'ask'), server=server,
               check_link_hosts=store.state.get('check_link_hosts', True),
               setup_hint=_join_hint(args, server),
               brief_status=store.state.get('brief_status') is True, command=f'{_valun()} --profile {_profile(args)}',
               rejoin_hint=_rejoin_hint(args, store))


def _connected(args):
    """The profile's store and a client, or (store, None) after saying how to join."""
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret() and store.token()):
        print(f"Profile '{_profile(args)}' is not joined yet; run `{_valun()} --profile {_profile(args)} join` first.")
        return store, None
    return store, vc.Client(store, _server(args, store))


def _decisions(report, unit=vc.UNIT):
    """process_consents() decisions, one line each, amounts in the network's unit."""
    lines = []
    for bucket in ('signed', 'refused', 'waiting'):
        for e in report.get(bucket) or []:
            what = f"{e.get('kind')} {e.get('id')} as {e.get('role')}"
            if e.get('amount') is not None:
                what += (f", {vc.amount_text(e.get('amount'), unit)} (your net change "
                         f"{vc.amount_text(e.get('your_net_change_PC'), unit)})")
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
        signs = va.client_signs(policy, c.unit)
        pos = me.get('position') if isinstance(me.get('position'), dict) else {}
        print('Your Valun client signs by itself: ' + ('; '.join(signs) if signs else 'nothing (every consent role is off)'))
        print(f"Consents waiting for your client: {len([i for i in items if isinstance(i, dict) and i.get('state') == 'collecting'])}")
        u = c.unit
        print(f"Cleared by set-off so far: {vc.amount_text(pos.get('cleared_by_setoff', pos.get('settled', 0)), u)}; you "
              f"hold {vc.amount_text(pos.get('claims_held'), u)} and owe {vc.amount_text(pos.get('owes'), u)} (net "
              f"{vc.amount_text(pos.get('net'), u)}).")
        log = store.state.get('consent_log') if isinstance(store.state.get('consent_log'), list) else []
        if log:
            print('Recent decisions of your client:')
            for e in log[-10:]:
                if isinstance(e, dict):
                    print(f"  {e.get('at')}  {e.get('decision'):8} {e.get('kind')} {e.get('id')} as {e.get('role')}"
                          + (f" ({e.get('code')})" if e.get('code') else ''))
        name = _profile(args)
        print(f"Consent loop in `{_valun()} --profile {name} mcp`: {store.state.get('consent_loop', 'off')}. "
              f'`{_valun()} --profile {name} clearing run` signs now.')
        return 0
    if args.action == 'run':
        try:
            r = c.process_consents()
        except vc.ValunError as e:
            print(json.dumps(error_payload(e)))
            return 1
        lines = _decisions(r, c.unit)
        print('\n'.join(lines) if lines else 'Nothing waits for your client.')
        return 0
    print(f'Signing what your policy allows every {args.interval} s (Ctrl+C to stop).')
    try:
        while True:
            try:
                for line in _decisions(c.process_consents(), c.unit):
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
    print(f'Local consent policy (this profile; `{_valun()} --profile {name} config consents.<role> on|off`): '
          f'{_policy_line(local, _unit_of(store.state))}')
    print(f"Consent loop in `{_valun()} --profile {name} mcp` (`{_valun()} --profile {name} config consent_loop on|off`): "
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
                             ('as_issuer', 'novate_own_debt', 'transfers of notes you issued'),
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
# An attempt the server held for the owner and that never applied, as the client recorded it (Client.
# learn_owner_decisions: server_ended): not applied, on the server's word, the trust console approvals rest on. What
# ended it, one clause per state (the approval's state, novation_expired, or the state of the transfer the deal's
# payment shows): a held one was never sent on; one approved after its hour was sent and refused; a transfer that
# expired (its own state, matched by its id) may have waited for the owner or been collecting signatures.
HELD_ENDED_WHY = {'rejected': 'the server held it for your owner, who rejected it in the owner console, and never sent it on',
                  'void_rejected': 'the server held it for your owner, who rejected it in the owner console, and never sent it on',
                  'void_stale': 'the server held it for your owner and never sent it on: it was out of date when your owner '
                                'approved it',
                  'void_expired': 'the server held it for your owner and never sent it on: its hold expired before your owner '
                                  'decided',
                  'void_key_revoked': "the server held it for your owner and never sent it on: a party's key was revoked",
                  'novation_expired': 'your owner approved it after its hour, and the tracker refused it',
                  'expired': 'it expired before every party had signed it (while it waited for your owner, or while it '
                             'collected signatures), so the server never sent it on',
                  'cancelled': 'your client cancelled it while it collected signatures, so the server never sent it on',
                  'refused': 'the issuer or the payee refused to sign it, so the server never sent it on'}
HELD_ENDED_OTHER = 'the server ended it as {state} before it reached the tracker'
# 'alive' (novation.attempt_outcome: within its window, and its edge not seen past it): what may be signed now, by
# route (decision D-1's one live attempt per deal, with its exemptions, novation.one_live_attempt). After an IOU, a new
# IOU of the deal acknowledging the same state of the pair (at most one of the two can apply); after a payment by
# transfer, a transfer through the same IOU at the same prior state (the same-prior exemption). Anything else waits
# until the attempt's timestamp + 1 h + 2 min (MAX_AGE_MS + FALLBACK_MARGIN_MS), or until its edge moves past it.
HELD_ENDED_NEXT = {'note': ("A new note of this deal can be signed now, while the pair's note is unchanged; paying it by "
                            'transfer waits until after {free} ({margin}), or until your client sees this note move past '
                            'it'),
                   'transfer': ('A payment through the same note at the same prior state can be signed now; your own note '
                                'or any other payment of this deal waits until after {free} ({margin}), or until your '
                                'client sees that note move past it')}
HELD_ENDED = {'alive': 'not applied ({why}). {next}',
              'dead': 'did not apply ({why})'}


def _unit(store):
    """The unit of the network this profile enrolled on (PC for a profile from before 0.5)."""
    return vc.NETWORKS.get(store.state.get('network') or vc.NETWORK, {}).get('unit', vc.UNIT)


def _who_key(c, pk):
    return 'you' if pk == c.pubkey else f'{str(pk)[:16]}...'


def _attempt_line(c, r):
    """One payment attempt of `valun attempts list`, in plain words."""
    i, rcp = (r['edge'].split('>') + [''])[:2]
    when = datetime.fromtimestamp(r['timestamp'] / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    if r['route'] == 'note':
        what = (f"your note to {_who_key(c, rcp)}: its total {r['prior'] if r['prior'] is not None else '?'} -> "
                f"{r['total']} {c.unit}")
    else:
        what = (f"paying with the note of {_who_key(c, i)}: its total {r['prior'] if r['prior'] is not None else '?'} -> "
                f"{r['total']} {c.unit}")
    sid = f", server id {r['attempt_id']}" if r.get('attempt_id') else ''
    held = r.get('server_ended') if isinstance(r.get('server_ended'), dict) else None
    decided = f"; you resolved it: {r['outcome']}" if r.get('outcome') in vc.ATTEMPT_OUTCOMES and r.get('outcome') != 'applied' \
        and held is None else ''
    paid = f"paid by {r['paid_by']}" if r.get('paid_by') else 'recorded as paid'
    ended = r.get('ended_at_server') if r['state'] == 'unknown' else None
    if held is not None and r['state'] in HELD_ENDED:
        why = HELD_ENDED_WHY.get(held.get('state')) or HELD_ENDED_OTHER.format(state=_terminal_text(held.get('state'), 40))
        if r['route'] == 'note' and r['timestamp'] % 1000 != va.nv.BOUND_MS:
            # an ordinary note never expires (novation._expires): only its edge moving past it ends it
            nxt = ("A new note of this deal can be signed now, while the pair's note is unchanged; paying it by transfer "
                   'waits until your client sees this note move past it (an ordinary note has no maximum age)')
        else:
            nxt = HELD_ENDED_NEXT.get(r['route'], HELD_ENDED_NEXT['note']).format(free=va.free_after(r['timestamp']),
                                                                                 margin=va.MARGIN_WORDS)
        state = HELD_ENDED[r['state']].format(why=why, next=nxt)
    elif ended in ENDED_AT_SERVER_WHY:
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
    'note': 'The server holds no payment attempt for a note you issued: only your client\'s records change (your owner '
            'token is checked first, used once and not stored).',
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


def _pid_word(pid):
    """A participant id a server sent, as a command or a sentence names it: the id when it has a participant id's shape
    (vp_ + 12 hex), else PARTICIPANT_ID (the owner console shows it), never the server's text as it is (the 0.7.2
    review: it could hold terminal control sequences or a command of its own)."""
    return pid if isinstance(pid, str) and re.fullmatch(r'vp_[0-9a-f]{12}', pid) else 'PARTICIPANT_ID'


def _double_quotable(s):
    """Is "s" in double quotes exactly s in Windows cmd, PowerShell, bash and zsh alike? Not with a " $ ` ! or % in it
    (each ends the quotes or expands in one of them), nor a curly double quote “ ” or „ (Windows PowerShell takes each
    for a double quote, even inside one: the RC's review, regressions R2-OTHER-2, 'Ann “Ace” Lee' became two
    arguments), a doubled backslash (bash makes it one) or a backslash at the end (it escapes the closing quote in bash,
    and in a Windows program's arguments)."""
    return (not any(ch in s for ch in '"$`!%“”„') and '\\\\' not in s and not s.endswith('\\'))


def _shell_word(s, limit=40):
    """A command argument as it can be pasted into Windows cmd, PowerShell, bash or zsh: as it is when it is only
    letters, digits and _.:/=+-; else in double quotes, which all four read alike for a value _double_quotable allows
    (an attempt's '#n' unquoted starts a comment in bash and PowerShell; the RC's staging test, 2026-11-18: cmd does
    not understand single quotes, so `--operator 'Valun QA rc072'` failed there). A value with a " $ ` ! or % is in single
    quotes, without its own ', as bash, zsh and PowerShell read them (not cmd): _faithful names such a value apart."""
    s = _terminal_text(s, limit)
    if re.fullmatch(r'[A-Za-z0-9_.:/=+-]+', s):
        return s
    if _double_quotable(s):
        return f'"{s}"'
    return "'" + s.replace("'", '') + "'"


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
        f'`{_valun()} --profile {_shell_word(_profile(args))} attempts resolve {_shell_word(args.deal)} '
        f'{_shell_word(args.attempt)} --not-applied`.',
        '  If the payee says it arrived, ask the operator to look into it with the payee, and do not resolve it until '
        'then.'])


def _ask_local():
    print("  Recording it in your client's records only changes what your client does: if the server does hold this "
          'payment as unresolved, it keeps blocking the deal there.')
    return input("Record your decision in your client's records only? [y/N] ").strip().lower() in ('y', 'yes')


def _at_terminal():
    """Can a person answer a hidden prompt here (getpass: stdin is a terminal)?"""
    try:
        return sys.stdin.isatty()
    except (AttributeError, ValueError):     # no stdin, or a closed one
        return False


def _person_at_terminal():
    """Can a person read a question here and answer it: stdin and stdout both terminals, as `valun call`'s approval
    prompt, `attempts resolve` and `sandbox tour` check (join's approvals question, fix inbox #164). A piped stdout (an
    agent's tool, `| tee`) means nobody may see the question. A terminal is not proof of a person: an agent in a
    pseudo-terminal can answer, and the answer is recorded as given."""
    try:
        return sys.stdin.isatty() and sys.stdout.isatty()
    except (AttributeError, ValueError):     # no stdin or stdout, or a closed one
        return False


def _owner_token(args):
    """The owner token from --owner-token-file or a hidden prompt (None, after saying why, when there is none)."""
    try:
        if args.owner_token_file:
            with open(args.owner_token_file, encoding='utf-8') as f:
                owner = f.read().strip()
        else:
            owner = getpass.getpass('Owner token (not shown): ').strip()
    except EOFError:                    # the prompt closed before a token was given
        owner = ''
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
        # First what the owner (or the server) decided about a payment held for the owner: one rejected in the owner
        # console, or void, is recorded as not applied (Client.refresh_owner_decisions; a deal that cannot be read now
        # is shown as the records hold it).
        try:
            c.refresh_owner_decisions()
        except vc.ValunError:
            pass
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
                  f"`{_valun()} --profile {_profile(args)} attempts resolve DEAL ATTEMPT --applied` (it arrived) or "
                  '`--not-applied` (it did not). ATTEMPT is the #n this list shows, written in double quotes ("#1": '
                  'unquoted, a # starts a comment in bash and PowerShell, and cmd keeps single quotes as part of it), or '
                  "the server's id of a transfer (vt_...).")
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
        print(_json_text(error_payload(e)))
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
            print(_json_text(error_payload(e)))
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
            print(_json_text(error_payload(e2)))
            return 1
    print(('The server recorded your decision. ' if r['server'] is not None else '')
          + (f"Your client's records now hold it for {len(r['matched'])} attempt(s) of this deal"
             if r['matched'] else "Your client's records hold no attempt that matches it")
          + ('; the deal is recorded as paid.' if r['paid'] else '.'))
    return 0


def _ask_terminal(text):
    """The tour's approval at this terminal: True only for y or yes. A prompt closed before it was answered (end of
    input) is not a refusal: approval_cancelled, which ends the tour (sandbox.TOUR_STOPS)."""
    print(text)
    try:
        said = input('Approve this commitment? [y/N] ')
    except EOFError:
        print()
        raise vc.ValunError('approval_cancelled', 'the approval prompt was closed before it was answered: nothing was '
                            'signed, and nobody refused it; the tour stops here') from None
    return said.strip().lower() in ('y', 'yes')


def _line_now(line):
    """One line of a command that waits (the tour, `sandbox earn`, `sandbox buy`), printed and flushed at once: through
    a pipe, as an agent reads a command's output, stdout is buffered, and an earn or buy printed nothing until it ended
    (the RC's staging test, 2026-11-18: the line that says the offer waits in the owner console came after the owner
    had approved it). A reader that went away (a pipe closed early: `| head -n 3`) stops nothing: from then on stdout is
    os.devnull and the deal goes on, as with 0.7.1's buffered print (the RC's review, regressions R2-OTHER-5: the next
    line raised OSError, and its traceback stopped buy or earn mid-deal). Windows PowerShell's `| Select-Object -First
    N` is not such a reader: it ends this process once it has N lines, and the deal with it, which nothing here can
    prevent (0.7.1 printed nothing until it ended, so it was not stopped: the RC's review, round 3, R3-REG-2); the
    README and the CHANGELOG say so, and to write the output to a file instead."""
    try:
        print(line, flush=True)
    except (OSError, ValueError):       # BrokenPipeError; Windows says EINVAL; a closed stdout says ValueError
        _stdout_gone()


def _stdout_gone():
    """stdout's reader went away: point stdout (and its file descriptor, which Python flushes at exit) at os.devnull, so
    nothing more fails on it."""
    try:
        devnull = open(os.devnull, 'w', encoding='utf-8')
    except OSError:
        return
    try:
        os.dup2(devnull.fileno(), sys.stdout.fileno())
    except (OSError, ValueError, AttributeError):
        pass
    sys.stdout = devnull


def cmd_sandbox(args):
    from . import sandbox
    store = _store(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{_profile(args)}' is not joined yet; run `{_valun()} --profile {_profile(args)} join` first.")
        return 1
    if args.role == 'seller':
        log = open(args.log, 'a', encoding='utf-8') if args.log else None
        try:
            sandbox.Seller(store, server=_server(args, store), log=log).run(args.interval, args.max_hours)
        except KeyboardInterrupt:
            pass
        return 0
    if args.role == 'tour':
        # Console approvals: the Valun server holds what the tour signs for the owner console, so the tour asks nothing
        # here (asking twice would be one approval too many) and says where it waits; but only while the owner mandate
        # in force holds every step (approve_above 0, review_deliveries on: what console set), which is read here (the
        # 0.7.2 review: an owner who raised Ask me above or unticked Review deliveries since would have had those
        # steps signed with nobody asked). Otherwise the tour asks at this terminal, as in every other mode.
        console = False
        if store.state.get('approvals') == 'console':
            try:
                m = vc.Client(store, _server(args, store)).me().get('mandate')
            except vc.ValunError as e:
                print(f'Cannot read your owner mandate ({e.code}): {e}. Nothing was signed.')
                return 1
            console = console_holds_all(m)
            if not console:
                print('Your profile uses console approvals, but your owner mandate no longer holds every step of the tour '
                      f'for you in the owner console ({_mandate_words(m, _unit(store))}): '
                      + ("with --yes the tour signs at once every commitment its own rules allow, and only what your "
                         'mandate holds waits there.' if args.yes else
                         'the tour asks you here before each commitment instead.'), flush=True)
        yes = args.yes or console
        if not yes and not (sys.stdin.isatty() and sys.stdout.isatty()):
            print('The tour asks you to approve each commitment here, and no person is at this terminal. Run it in a '
                  'terminal, or with --yes to approve every step of the tour.')
            return 3
        if console:
            print(f'Console approvals: the tour asks nothing here. What it signs for your agent waits for you in the owner '
                  f'console ({_server(args, store)}/pilot#owner; `{_console_command(args)}` opens it): its offers and '
                  'acceptances, the notes it pays with (approve each by the deadline its card shows, within the hour), and '
                  'its payments by transfer (steps 2 and 5), which wait only 20 minutes before they end (the tour then '
                  'signs them again). Approve '
                  'each there when the tour says it waits, and the tour goes on by itself.', flush=True)
        try:
            r = sandbox.tour(store, server=_server(args, store), yes=yes, ask=None if yes else _ask_terminal,
                             log=_line_now, console_command=_console_command(args), console=console)
        except vc.ValunError as e:
            print(_json_text(error_payload(e)))
            return 1
        except KeyboardInterrupt:       # #136 item 3: a short message, never a traceback
            print(f'\nThe tour stopped (Ctrl+C). Run `{_valun()} --profile {_profile(args)} sandbox tour'
                  f'{_server_flag(_server(args, store))}` again to go on: it reads where your tour stands from the server '
                  'and goes on from that step (a commitment that was being sent may have been done; the next step '
                  'shows it).')
            return 130
        return 0 if r.get('done') else 1
    try:
        if args.role == 'earn':
            r = sandbox.earn(store, server=_server(args, store), log=_line_now)
        else:
            text = open(args.text_file, encoding='utf-8').read() if args.text_file else args.text
            if not text:
                print('give --text or --text-file')
                return 1
            r = sandbox.buy(store, args.seller, args.service, text, args.price, server=_server(args, store),
                            pay_with=args.pay_with, log=_line_now)
    except vc.ValunError as e:
        print(json.dumps(error_payload(e)))
        return 1
    except KeyboardInterrupt:
        print(f'\nStopped (Ctrl+C). `{_valun()} --profile {_profile(args)} call valun_inbox` shows where the deal stands.')
        return 130
    _line_now(json.dumps(r))            # its last line: a reader gone by then stops nothing either
    if args.role == 'earn':
        return 0 if r.get('paid') else 1
    # A payment with a held note counts only once it applied (payment_due or still collecting: not paid).
    return 0 if r.get('verified') and (r.get('paid_with') is None or r.get('paid')) else 1


def cmd_profile(args):
    """Show this participant's public profile, or change what it offers (--services), what it pays others for (--wants),
    --about, --display-name, or whether its guarantees with agents that also chose it are public (--public-vouches)."""
    store, name = _store(args), _profile(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `{_valun()} --profile {name} join` first.")
        return 1
    server = _server(args, store)
    c = vc.Client(store, server)
    try:
        vouches = None if args.public_vouches is None else args.public_vouches == 'on'
        if args.about is None and args.services is None and args.display_name is None and args.wants is None and vouches is None:
            p, changed = c.me().get('participant') or {}, None
        else:
            r = c.set_profile(display_name=args.display_name, about=args.about, services=args.services, wants=args.wants,
                              public_vouches=vouches)
            p, changed = r.get('participant') or {}, r.get('changed')
    except vc.ValunError as e:
        print(_json_text(error_payload(e)))
        return 1
    out = {k: p.get(k) for k in ('handle', 'display_name', 'about', 'services')}
    out['wants'] = p.get('wants') or ''
    out['public_vouches'] = bool(p.get('public_vouches'))
    if changed is not None:
        out = {'changed': changed, **out}
    print(_json_text({**out, 'page': f"{server}/agent/{p.get('handle')}"}, indent=1))
    return 0


CARD_WORDS = ('check', 'publish', 'unpublish')       # `valun card` sub-commands; any other single word is WHO
CARD_USAGE = 'usage: valun card [WHO] | valun card check PAYER AMOUNT [--deal vd_...] | valun card publish | valun card unpublish'


def _public_card_of(answer):
    """public_card as the server's answer to PUT /owner/mandate shows it, at its top or in its mandate; None when it
    shows none (a server from before budget cards ignores the field)."""
    if isinstance(answer, dict):
        for where in (answer, answer.get('mandate')):
            if isinstance(where, dict) and isinstance(where.get('public_card'), bool):
                return where['public_card']
    return None


def _check_goes_ahead(out):
    """`valun card check`'s exit 0: the step would go ahead on both of its sides, as the server then enforces it. The
    verdict is accept, and so is the payee's own side of the step (payee_side, fix inbox #60), which the server shows
    only to the payee itself, as this check always is: decline there means the server refuses the payee's part of the
    step (its own limits: mandate_exceeded; its own counter-offer still waiting for its owner: counter_pending),
    ask_owner that the payee's owner decides first, as the payer's own ask_owner does.
    - A server with fix inbox #87 (its answer has payer_side) gives the step's verdict from both sides: it is accept
      only when both are, and each side must say so itself too (payer_side and payee_side objects with verdict accept).
      A payer_side of null (a payer without a published card: its side was not checked), or no payee_side, is no
      go-ahead.
    - A server from before #87 gives the payer's verdict: without payee_side (absent or null: a server from before #60,
      which does not check that side) it alone decides, as in 0.7.0.
    A side that is anything but an object with verdict accept fails closed."""
    def accepts(side):
        return isinstance(side, dict) and side.get('verdict') == 'accept'
    side = out.get('payee_side')
    if 'payer_side' in out:
        return out.get('verdict') == 'accept' and accepts(out.get('payer_side')) and accepts(side)
    return out.get('verdict') == 'accept' and (side is None or accepts(side))


def cmd_card(args):
    """valun card [WHO] | check PAYER AMOUNT [--deal vd_...] | publish | unpublish: budget cards. A card of WHO (a handle
    or participant id), which needs no joined profile, or of this profile's own agent. `check` is valun_check_payer with
    this profile's agent as the payee: it prints the tool's answer and exits 0 only when the step would go ahead on both
    sides (_check_goes_ahead: the verdict accept, and each side's own accept where the server shows them);
    --deal names the offer under review (its deal_id, fix inbox #60: the deal whose offer you are deciding on, AMOUNT its
    price). publish and unpublish are the OWNER's: they use the owner token once, in memory (from --owner-token-file or a
    hidden prompt), never stored."""
    words, store, name = list(args.words or []), _store(args), _profile(args)
    kind = words[0] if words and words[0] in CARD_WORDS else 'show'
    deal = getattr(args, 'deal', None)
    if (kind == 'check' and len(words) != 3) or (kind in ('publish', 'unpublish') and len(words) != 1) \
            or (kind == 'show' and len(words) > 1) or (deal is not None and kind != 'check'):
        print(CARD_USAGE)
        return 2
    if not (kind == 'show' and words) and not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `{_valun()} --profile {name} join` first.")
        return 1
    if kind == 'check':
        if not re.fullmatch(r'[0-9]{1,16}', words[2]):
            print(f'AMOUNT must be a whole number of {_unit(store)}, at least 1')
            return 2
        if deal is not None and not re.fullmatch(r'vd_[0-9a-f]{16}', deal):
            print('--deal must be a deal id (vd_ and 16 hex digits, as valun_inbox lists it): the offer you are deciding on')
            return 2
        agent, _mode = _agent(args, store)
        out = agent.call_safe('valun_check_payer', {'payer': words[1], 'amount': int(words[2]),
                                                    **({} if deal is None else {'deal_id': deal})})
        print(_json_text(out, indent=1))
        return 0 if _check_goes_ahead(out) else 1
    c = vc.Client(store, _server(args, store))
    if kind == 'show':
        return _show_card(args, c, words[0] if words else None)
    owner = _owner_token(args)
    if owner is None:
        return 1
    on = kind == 'publish'
    try:
        r = c.set_public_card(on, owner)
    except vc.ValunError as e:
        print(f'Could not change your budget card ({e.code}): {e}')
        if e.code == 'not_owner':
            print(f"  Profile '{name}' needs the owner token of its participant ({store.state.get('participant_id')}); "
                  f'`{_valun()} --profile NAME card ...` acts on another profile.')
        return 1
    if _public_card_of(r) is not on:
        print('The server did not record it (its answer shows no public_card): this server may not offer budget cards.')
        return 1
    if not on:
        print('Your budget card is no longer public: reading it, or checking a payment against it, now answers card_not_public.')
        return 0
    try:
        page = (c.card(c.participant_id) or {}).get('page')
    except vc.ValunError:
        page = None
    print('Your budget card is public' + (f': {_terminal_text(page, 200)}' if isinstance(page, str) and page else '.'))
    print("Anyone can read it (your agent's limits and objective, the room it has left, its public backing and its record) "
          'and check a payment against it. To hide it again: '
          f'`{_valun()} --profile {name} card unpublish --owner-token-file FILE` (FILE: the file holding your owner token).')
    return 0


def _show_card(args, c, who):
    """`valun card [WHO]`: the card as the server shows it (JSON), or why there is none to show (exit 1)."""
    try:
        card = c.card(c.participant_id if who is None else who)
    except vc.ValunError as e:
        if e.code == 'card_not_public' and who is None:
            print('Your budget card is not public. Your owner can publish it: '
                  f'`{_valun()} --profile {_profile(args)} card publish --owner-token-file FILE` (FILE: the file holding your '
                  'owner token).')
        elif e.code == 'card_not_public':
            print(f"{_terminal_text(who, 64)}'s owner has not published a budget card.")
        elif e.code == 'feature_unavailable':
            print(_terminal_text(e))
        else:
            print(_json_text(error_payload(e)))
        return 1
    print(_json_text(card, indent=1))
    return 0


def cmd_verify_check(args):
    """Verify a paid check's receipt (fix inbox #3): the check deal's signed terms, the reviewer's signed delivery, the
    receipt naming that deal and that text, the reviewer's key against the key pinned in this release, and (--work) that
    the text checked holds the work deal's delivery byte for byte. Read only: it signs and sends nothing. Exit 0 when every
    check passes. It says what a passing receipt proves and what it does not (the verdict itself is a model's judgment)."""
    if args.file:
        def load(path):
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        try:
            check = load(args.file)
            work = load(args.work_file) if args.work_file else None
        except (OSError, ValueError) as e:
            print(json.dumps({'error': 'unreadable_record', 'message': str(e)}))
            return 1
        # A saved record does not name its network: by default the one network (since the pilot retired, 2026-11-13).
        network = args.network or schemas.TESTNET
        directory_key = None
    else:
        store, name = _store(args), _profile(args)
        if not (store.state.get('participant_id') and store.secret()):
            print(f"Profile '{name}' is not joined yet; run `{_valun()} --profile {name} join` first (or pass --file with a saved deal record).")
            return 1
        c = vc.Client(store, _server(args, store))
        try:
            check = c.deal(args.deal)
            work = c.deal(args.work) if args.work else None
            payee = ((check.get('current') or {}).get('terms') or {}).get('payee') or {}
            directory_key = (c.participant(payee['id']) or {}).get('pubkey') if payee.get('id') else None
        except vc.ValunError as e:
            print(_json_text(error_payload(e)))
            return 1
        network = c.network
    r = vr.verify_check(check, network=network, work_deal=work, reviewer=args.reviewer, directory_key=directory_key)
    print(_json_text({'ok': r['ok'], 'verdict': r['verdict'], 'network': network, 'checks': r['checks'],
                      'proves': r['proves'], 'does_not_prove': r['does_not_prove']}, indent=1))
    return 0 if r['ok'] else 1


# What `valun audit` gives the audit of this profile's own state: never its key or tokens ('signed': what this client
# signed, by edge and timestamp: an operation and totals, no signature).
AUDIT_STATE_KEYS = ('server', 'participant_id', 'pubkey', 'network', 'pins', 'records', 'signed')
MINE_WORDS = {
    'signed': 'its issuer signed this total: the signature in your records verifies',
    'netted': ('signed by you: the anchored total is the state that set-off gives this edge, and your signature on it, '
               'in your records, verifies'),
    'signature_not_held': 'your records confirm this total, and no longer hold its signature (dropped 30 days after it)',
    'bad_signature': 'your records confirm this total, and the signature they hold for it does not verify',
    'differs': 'your records confirm another total',
    'not_in_records': 'your records hold no state of this edge',
    'not_anchored': 'the anchored rows have no such edge',
}


def cmd_audit(args):
    """valun audit (--explorer URL | --node URL) [--server ORIGIN] [--tracker-nft ID] [--json] [--mine]: check the
    operator (valun.audit, fix inbox #62; the tracker NFT's pin, #66). Read only: GET requests, no token sent, nothing
    signed or written; with --mine (and no --no-refresh), the client's records are first refreshed from the profile's own
    server, as valun_status does (_refresh_for_audit: GET /edges with the agent's token, nothing signed). Without --mine no
    profile is needed.
    Exit codes: valun.audit.exit_code (0 MATCH, 1 MISMATCH, 2 nothing compared, 3 MATCH and an edge of --mine not
    proven), as anchor-audit.mjs's. Exit 1 means a comparison found a MISMATCH and nothing else: a usage error (a
    profile it cannot use among them) is 2, and so is a fault of this command (any exception: UNKNOWN, reason fault),
    never Python's 1."""
    try:
        return _audit_command(args)
    except Exception as e:  # noqa: BLE001 - a fault of this command compared nothing: exit 2, never 1 (MISMATCH)
        why = f'the audit itself failed ({type(e).__name__}: {_terminal_text(e, 300)}), so nothing was compared'
        _print_encodable(json.dumps({'verdict': 'UNKNOWN', 'reason': 'fault', 'message': why}, ensure_ascii=True, indent=1)
                         if getattr(args, 'json', False) else f'UNKNOWN (fault): not checked, so nothing is proven. {why[:1].upper()}{why[1:]}.')
        return vaudit.EXIT_NOTHING_COMPARED


def _audit_command(args):
    """cmd_audit, but for its faults: the usage errors (exit 2: nothing is read) and the audit's own result."""
    name = _profile(args)
    try:
        store = _store(args)
        if not isinstance(store.state, dict):
            raise ValueError('it is not a JSON object')
    except (OSError, ValueError) as e:                  # a profile name it refuses, or a file it cannot read
        _print_encodable(f"Profile '{_terminal_text(name, 40)}' cannot be used ({_terminal_text(e, 300)}): nothing was read or "
                         'compared. Name another profile with --profile NAME.')
        return vaudit.EXIT_USAGE
    if args.mine and not (store.state.get('participant_id') and store.state.get('pubkey')):
        _print_encodable(f"--mine lists your edges, and profile '{_terminal_text(name, 40)}' is not joined yet: run "
                         f"`{_valun()} --profile {_terminal_text(name, 40)} join` first, or name your profile with --profile NAME.")
        return vaudit.EXIT_USAGE
    try:
        server = vaudit.base_url(_server(args, store), '--server')
        source = vaudit.Explorer(args.explorer) if args.explorer is not None else vaudit.Node(args.node)
        tracker_nft = vaudit.tracker_nft_id(args.tracker_nft) if args.tracker_nft is not None else None
        wait = _wait_seconds(args.wait_anchored)
    except ValueError as e:
        _print_encodable(str(e))
        return vaudit.EXIT_USAGE
    if vaudit.same_origin(source.url, server):         # the server's word is what is checked, never a chain source
        _print_encodable(f'The chain source {_terminal_text(source.url, 120)} is the server itself ({_terminal_text(server, 120)}): '
                         'name an Ergo explorer or node that the server does not answer for, such as '
                         'https://api-testnet.ergoplatform.com.')
        return vaudit.EXIT_USAGE
    refreshed = False
    if args.mine and not args.no_refresh:
        refreshed, said = _refresh_for_audit(store, server)
        if said:
            _say_aside(said)
    state = {k: store.state[k] for k in AUDIT_STATE_KEYS if k in store.state}
    r = vaudit.audit(server, source, profile_state=state, mine=args.mine, tracker_nft=tracker_nft, wait_anchored=wait,
                     log=_say_aside)
    # ensure_ascii: the same JSON, and printable on any stdout.
    text = json.dumps(r, ensure_ascii=True, indent=1) if args.json else '\n'.join(_audit_lines(r, args.mine, refreshed))
    code = vaudit.exit_code(r)
    _print_encodable(text)
    return code


def _refresh_for_audit(store, server):
    """`valun audit --mine`, first: bring this profile's records up to date, as valun_status does (fix inbox #86, the
    newcomer tests 2026-11-17: an IOU approved in the owner console was issued after the MCP session had ended, its
    record stayed pending, and --mine said "differs", exit 3, until a valun_status). It reads GET /pilot/v1/edges from
    the profile's own server with this agent's token (Client.sync_edges): every state is checked against its issuer's
    signature on the pinned tracker before it is recorded, so the server cannot put a total in the records that its
    issuer did not sign. Nothing is signed. Only for the profile's own server, and where it shows edges (bound notes or
    circulating credit). Returns (refreshed, the line said aside on stderr or None)."""
    if not vaudit.same_place(server, store.state.get('server') or DEFAULT_SERVER):
        return False, (f'Your records were not refreshed first: {server} is not this profile\'s server, so they are '
                       'compared as they are.')
    if not (store.secret() and store.token()):
        return False, ('Your records were not refreshed first (this profile holds no agent token): they are compared as '
                       'they are.')
    try:
        c = vc.Client(store, server)
        features = va.features_of(c.info())
        if 'bound_notes/1' not in features and va.CIRCULATION not in features:
            return False, None          # a server that shows no edges: the records are all there is
        r = c.sync_edges()
    except vc.ValunError as e:
        return False, (f'Your records could not be refreshed first ({e.code}: {_terminal_text(e, 200)}): they are compared '
                       'as they are; run valun_status, then this audit again.')
    applied = len(r.get('applied') or [])
    return True, (f'Your records were refreshed first from {server} (GET /pilot/v1/edges, each state checked against its '
                  f"issuer's signature), as valun_status does: {applied} pending {'entry' if applied == 1 else 'entries'} "
                  'now confirmed.')


def _wait_seconds(value):
    """--wait-anchored's seconds: None without the flag, the default with no value, else a number of seconds from 1 to
    WAIT_ANCHORED_MAX_S (a day); ValueError for anything else (a usage error: nothing is read)."""
    if value is None or isinstance(value, float):
        return value
    try:
        s = float(value)
    except ValueError:
        s = None
    if s is None or not (1 <= s <= vaudit.WAIT_ANCHORED_MAX_S):
        raise ValueError(f'--wait-anchored takes a number of seconds from 1 to {vaudit.WAIT_ANCHORED_MAX_S:g}, not '
                         f'{_terminal_text(value, 40)!r}')
    return s


def _print_encodable(text):
    """Print text as this stdout can encode it, a character it cannot as '?': a server's, explorer's or node's text may
    hold any character, and a redirected stdout on Windows writes the ANSI code page. A reader that went away (a closed
    pipe) changes no verdict: the caller's exit code stands."""
    enc = getattr(sys.stdout, 'encoding', None) or 'utf-8'
    try:
        text = text.encode(enc, 'replace').decode(enc)
    except LookupError:
        pass
    try:
        print(text)
    except OSError:
        pass


def _say_aside(text):
    """A progress line (valun audit --wait-anchored) on stderr, as it can encode it, never on stdout, whose JSON it would
    break (print(file=None) writes to stdout); nothing when there is no stderr, or it went away (the 0.7.2 review)."""
    err = sys.stderr
    if err is None:
        return
    enc = getattr(err, 'encoding', None) or 'utf-8'
    text = _terminal_text(text, 400)
    try:
        text = text.encode(enc, 'replace').decode(enc)
    except LookupError:
        pass
    try:
        print(text, file=err, flush=True)
    except (OSError, ValueError):
        pass


def _audit_lines(r, mine, refreshed=None):
    """The audit's result as lines for this terminal (--json prints it whole). refreshed: whether --mine refreshed the
    records first (True), did not (False), or None for an audit of records given as they are."""
    t, v, box, rows, src = _terminal_text, r['verdict'], r.get('box'), r.get('rows'), r['chain_source']
    if v == 'MATCH':
        lines = [f"MATCH: the {rows['count']} notes {t(r['server'], 100)} publishes are exactly what its tracker box on Ergo "
                 'testnet commits.']
    elif v == 'MISMATCH':
        why = t(r['message'], 1500)
        lines = [f'MISMATCH: {why[:1].upper()}{why[1:]}']
    else:
        why = t(r['message'], 1500)
        lines = [f"UNKNOWN ({t(r['reason'], 40)}): not checked, so nothing is proven. {why[:1].upper()}{why[1:]}"]
    if box:
        age = f", {r['box_age_blocks']} blocks old at height {r['height']}" if r.get('box_age_blocks') is not None else ''
        lines.append(f"  box       {box['box_id']} (created at height {box['creation_height']}{age})")
        lines.append(f"  R5        {box['digest']}, read from the {src['kind']} {t(src['url'], 120)}")
    if rows:
        lines.append(f"  rebuilt   {rows['digest']} from {rows['count']} rows of GET {rows['from']}")
        lines.append(f"  tracker   NFT {r['tracker_nft_id']}, as GET /pilot/v1/chain names it{_audit_pin_words(r)}")
    if box and r.get('nettings_refused_from_height') is not None:     # none for a box no redemption can use
        lines.append(f"  windows   nettings of anchored edges refused from height {r['nettings_refused_from_height']}; "
                     f"redemption without the tracker from height {r['tracker_less_redemption_from_height']}")
    for w in r.get('warnings') or []:
        lines.append(f'  warning: {t(w, 600)}')
    if v == 'MATCH':
        lines.append('  This proves the cumulative totals as anchored. It does not prove ' + '; '.join(r['does_not_prove']) + '.')
    if mine and 'mine' not in r:
        lines.append('--mine: nothing listed. Only a MATCH shows which totals of yours the chain commits.')
    m = r.get('mine')
    if m is not None:
        known = {'this_agent': 'this agent', 'ledger': 'named by GET /ledger', 'records': 'signed with, by your records'}
        keys = ', '.join(f"{k['pubkey'][:10]}... ({known.get(k['known_from'], '?')})" for k in m['keys'])
        lines.append(f"Your edges (participant {t(m['participant'], 20)}; keys {keys or 'none'}):")
        if m.get('problem'):
            lines.append(f"  none compared ({m['problem']}): {t(m['message'], 600)}")
        elif not m['edges']:
            lines.append('  none: the anchored rows and your records hold no edge of yours.')
        unit = vc.NETWORKS.get(r.get('network'), {}).get('unit')
        for e in m['edges']:
            who = t(e['counterparty'] or (e['counterparty_key'] or '?')[:16], 30)
            if e['role'] in ('issuer', 'recipient'):
                what = ('you owe ' if e['role'] == 'issuer' else 'owed to you by ') + who
            else:                   # both keys yours, or a records edge on keys the audit could not place
                i, _sep, rc = e['edge'].partition('>')
                what = f'edge {t(i, 10)}...>{t(rc, 10)}...' + (' (both keys yours)' if e['role'] else '')
            rec = e['recorded']
            if e['anchored_total'] is None:
                facts = f"your records: {_audit_amount(rec['total'], e['denomination'], unit)}"
            else:
                facts = f"anchored {_audit_amount(e['anchored_total'], e['denomination'], unit)}" + (
                    f", your records: {_audit_amount(rec['total'], e['denomination'], unit)}" if rec and e['status'] == 'differs' else '')
            words = MINE_WORDS.get(e['status'], '')
            if e.get('netted_by'):              # fix inbox #86: a set-off this client signed gave the edge this total
                netted = f"netted by {t(e['netted_by'], 20)}"
                words = f'{netted}, {words}' if e['status'] == 'netted' else f'{words} ({netted}, signed by you)'
            lines.append(f"  {e['status']:<19} {what}: {facts}: {words}")
        how = 'signed, or netted by a set-off you signed' if any(e['status'] == 'netted' for e in m['edges']) else 'signed'
        lines.append(f"  {m['proven']} of {len(m['edges'])} edges proven ({how}). "
                     + ('Your client refreshed its records first (GET /pilot/v1/edges), as valun_status does.' if refreshed
                        else 'Your records are read as they are: they were not refreshed first.' if refreshed is False
                        else 'Your records are read as they are: the audit does not sync them.'))
    return lines


def _audit_pin_words(r):
    """How the audit's tracker NFT was pinned, for its tracker line (valun.audit step 1)."""
    tr = r.get('tracker') or {}
    n = tr.get('reserves_naming_it')
    reserves = (f"{n} reserve box{'' if n == 1 else 'es'} at the pinned reserve contract name{'s' if n == 1 else ''} it"
                if isinstance(n, int) else None)
    by = tr.get('pinned_by')
    if by == 'you':
        return ', and the one you pinned (--tracker-nft)'
    if by == 'profile':
        return ', and the one this profile pinned' + (f'; {reserves}' if reserves else '')
    if by == 'this audit':
        return f", and the one this audit pins for {_terminal_text(vaudit.origin(r['server']), 100)}"
    return f'; not pinned: {reserves}' if reserves else ''


def _audit_amount(n, denomination, unit):
    """An edge's total for this terminal: in the network's unit for its own denomination (erg on the testnet), else with
    the denomination it is in."""
    if denomination == 'erg' and unit:
        return vc.amount_text(n, unit)
    return f'{n} in {_terminal_text(denomination, 22)}...' if isinstance(denomination, str) else str(n)


def cmd_ergo(args):
    """Settlement on Ergo testnet (the Valun testnet network only): this agent's Ergo address, the chain view, the
    reserves, a reserve of its own tERG, and the redemption of a note it holds. A redemption is signed natively; a
    reserve of its own needs ergo-lib (pip install "valun[ergo]"); reserve and redeem send nothing without --broadcast."""
    store, name = _store(args), _profile(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `{_valun()} --profile {name} join` first.")
        return 1
    c = vc.Client(store, _server(args, store))
    try:
        if args.action == 'address':
            out = {'network': c.network, 'address': c.ergo_address(), 'unit': c.unit,
                   'note': 'Ergo TESTNET: test coins (tERG) with no monetary value; send tERG here from a testnet faucet'}
        elif args.action == 'chain':
            out = c.chain()
        elif args.action == 'reserves':
            out = c.reserves()
        elif args.action == 'reserve':
            out = c.create_reserve(args.nano, broadcast=args.broadcast)
            if not args.broadcast:
                out = {k: v for k, v in out.items() if k != 'signed'}
                out['dry_run'] = 'checked and signed here, NOT sent: add --broadcast to send it'
        else:
            out = c.redeem(args.issuer, args.amount, broadcast=args.broadcast)
            if not args.broadcast:
                out = {k: v for k, v in out.items() if k != 'signed'}
                out['dry_run'] = 'checked and signed here, NOT submitted: add --broadcast to submit it'
    except vc.ValunError as e:
        print(_json_text(error_payload(e)))
        return 1
    print(_json_text(out, indent=1))
    return 0


def _sell_held(mandate, services, c, store, name, server):
    """Why `valun sell` must not start, or None: the owner mandate in force (GET /me) holds, for the owner console, an
    acceptance priced above approve_above (console approvals set it to 0), and a service it sells is priced above it.
    The seller does each job with Claude before it accepts the offer (ai_seller.AISeller.answer: the model's cost is
    spent first), so a held acceptance waits for the owner with the money already spent, and is lost if the buyer's
    offer expires first (the 0.7.2 review)."""
    from . import ai_seller as ais
    m = mandate if isinstance(mandate, dict) else {}
    above = m.get('approve_above')
    if not (isinstance(above, int) and not isinstance(above, bool)):
        return None
    scale = getattr(c, 'scale', 1)
    priced = sorted(((ais.SERVICE_SPECS[s]['price'] * scale, s) for s in services), reverse=True)
    if not priced or priced[0][0] <= above:
        return None
    top, which = priced[0]
    unit = getattr(c, 'unit', vc.UNIT)
    console = store.state.get('approvals') == 'console'
    fix = (f'`{_valun()} --profile {name} config approvals none --owner-token-file FILE` (FILE: the file holding your owner '
           'token; it sets Ask me above to your per-deal limit)' if console else
           f'raise Ask me above to at least {vc.amount_text(top, unit)} in the owner console ({server}/pilot#owner)')
    return (f'Not started: your owner mandate holds each acceptance priced above {vc.amount_text(above, unit)} for you in '
            'the owner console (Ask me above' + (', which console approvals set to 0' if console and above == 0 else '')
            + '), and '
            f'{which} is priced {vc.amount_text(top, unit)}. `valun sell` does each job with Claude before it accepts the '
            "offer, so each job's model cost would be spent before you approve it, and lost if the buyer's offer expires "
            f'first. To sell unattended: {fix}; then run this again. Nothing was spent, and nothing was signed.')


def cmd_sell(args):
    """Sell AI work for credits with your own Claude API key (valun.ai_seller): this profile's agent answers offers for
    the chosen services, does each job with Claude before accepting it, delivers it, and stays within the budget."""
    from . import ai_seller as ais
    store, name = _store(args), _profile(args)
    if not (store.state.get('participant_id') and store.secret()):
        print(f"Profile '{name}' is not joined yet; run `{_valun()} --profile {name} join --sandbox` first.")
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
        me_view = c.me()
    except vc.ValunError as e:
        print(_json_text(error_payload(e)))
        return 1
    me = me_view.get('participant') or {}
    held = _sell_held(me_view.get('mandate'), services, c, store, name, server)
    if held:                    # before any model call, and before the public services change (the 0.7.2 review)
        print(held)
        return 2
    handle, offer = me.get('handle') or name, ais.services_text(services, c.unit, c.scale)
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


def _printable_streams():
    """Let stdout and stderr print any text: where a stream's encoding is not UTF-8 (Windows writes the ANSI code page,
    cp1252 say, to a pipe or a file) and its error handler raises for a character it cannot encode ('strict', or
    'surrogateescape', which Python on Windows gives every such stream: the RC's review, round 3, windows-acl WIN1 and
    regressions R3-REG-1, the first fix changed only a strict stream and so did nothing there), that character is
    printed as a \\u escape instead of raising UnicodeEncodeError (the RC's review, windows-acl W2: a home folder named
    outside the code page made `valun join` end in a traceback at the owner token file's line, before the token was
    shown or the agent's key enrolled, and again at "Credentials are stored privately in <profile>"; doctor at "profiles
    in <folder>", status and console likewise). surrogateescape differs only for a lone surrogate, which is then
    escaped too. A printed command never carries such an escape (_faithful names the value apart). JSON output escapes
    such characters itself (_json_text). A stream that cannot be reconfigured (a test's StringIO) is left as it is."""
    for stream in (sys.stdout, sys.stderr):
        try:
            enc = (getattr(stream, 'encoding', None) or '').lower().replace('-', '').replace('_', '')
            if enc not in ('utf8', 'utf8sig') and getattr(stream, 'errors', None) in ('strict', 'surrogateescape'):
                stream.reconfigure(errors='backslashreplace')
        except (AttributeError, ValueError, OSError, LookupError):
            pass


def _stdout_encodes(s):
    """Can stdout write `s` as it is, every character in its encoding (never a \\u escape: _printable_streams)?"""
    enc = getattr(sys.stdout, 'encoding', None) or 'utf-8'
    try:
        s.encode(enc)
    except UnicodeEncodeError:
        return False
    except LookupError:
        return True
    return True


def main(argv=None):
    _printable_streams()
    p = argparse.ArgumentParser(prog='valun', description='Join the Valun agent credit network from any agent, on any OS.')
    p.add_argument('--version', action='version', version=f'valun {__version__}')
    p.add_argument('--profile', default=os.environ.get('VALUN_PROFILE', 'default'), help='identity to use (default: default)')
    sub = p.add_subparsers(dest='cmd')
    j = sub.add_parser('join', help='join Valun: creates your participant and this agent\'s key (no invite needed with --sandbox)')
    j.add_argument('--handle')
    j.add_argument('--operator')
    j.add_argument('--display-name', default='')
    j.add_argument('--about', default='')
    j.add_argument('--services', default='', help='what your agent offers, public (e.g. "PR reviews (3000000 nanoERG)")')
    j.add_argument('--wants', default='', help='the work your agent pays others for, public (e.g. "translations (2000000 '
                                               'nanoERG)")')
    j.add_argument('--server', help='the Valun server to join (default https://valun.tech, the public testnet; also '
                                    'VALUN_SERVER)')
    j.add_argument('--approvals', choices=APPROVAL_MODES, default=None, metavar='MODE',
                   help='who decides before a commitment takes effect. With --sandbox and no --approvals, join asks '
                        "whether a person will approve your agent's commitments (yes: console; no: none); with no "
                        'terminal to ask in (stdin and stdout must both be one), it refuses before anything is sent and '
                        'prints both commands. Without --sandbox the default is ask. A mode given here is used as it is, '
                        'and nothing is asked. '
                        'console: your agent signs at once, and the Valun server holds its offers, counter-offers, '
                        'acceptances and guarantee offers, and the note or payment by transfer it signs when it accepts a '
                        'delivery, until you approve each in the owner console (`valun console` opens it); never an honor '
                        'of a guarantee call, a guarantee release, a consent, or your agent loosening a limit it recorded. '
                        'ask: your MCP app shows you an approval '
                        'form before each commitment is signed (not yet verified in any interactive app; an app without '
                        'forms gets approval_unavailable, and nothing is signed). client-prompt: your app\'s own '
                        'confirmation of each signing tool call; whatever it lets run is signed. none: your agent signs on '
                        'its own, within your limits')
    j.add_argument('--invite-from-stdin', action='store_true')
    j.add_argument('--sandbox', action='store_true',
                   help='join without an invite as a self-serve participant: small limits, 7 days renewed while your agent '
                        'is active; on an open network (valun.tech) it deals with any agent, otherwise only with the '
                        'sandbox agents')
    j.add_argument('--clearing', choices=['auto', 'off'], default=None,
                   help='circulating credit: let set-offs clear your loops of notes (auto, the default) or not (off); sets '
                        "auto_clear in your owner mandate (when the server's features cannot be read, it is not set and "
                        'join exits 1; with off your client then signs no set-off by itself)')
    j.add_argument('--owner-token-file',
                   help='write the owner token to this new private file (default: $HOME/valun-owner-token-HANDLE.txt). It '
                        'is created, never replaced: if it exists already, or its folder cannot take a new file, join '
                        'sends nothing and exits 2. The token is never printed on stdout')
    e = sub.add_parser('enroll', help='register a new agent key with an enrollment code')
    e.add_argument('--participant')
    e.add_argument('--server')
    e.add_argument('--code-from-stdin', action='store_true')
    sub.add_parser('status', help='what this profile is connected to')
    co = sub.add_parser('console', help="the owner console of this profile's server: its address, where your owner token "
                                        'is, what waits for you there; opens it in your browser')
    co.add_argument('--no-open', action='store_true', help='print the address only; do not open a browser')
    co.add_argument('--server')
    d = sub.add_parser('doctor', help='checks with a fix for each problem')
    d.add_argument('--server')
    c = sub.add_parser('config', help='change a setting')
    c.add_argument('key', choices=['approvals', 'server', 'check_link_hosts', 'brief_status']
                   + [f'consents.{k}' for k in va.CONSENT_POLICY_KEYS] + ['consent_loop'])
    c.add_argument('value')
    c.add_argument('--owner-token-file', help="when switching approvals to or from console: the file holding the owner "
                                              "token of this profile's participant (read once, not stored); without it the "
                                              'token is asked for at a terminal (not shown)')
    c.add_argument('--server')
    sub.add_parser('tools', help='print the tool definitions (JSON)')
    k = sub.add_parser('call', help='run one tool, print its JSON result')
    k.add_argument('tool', choices=[t['name'] for t in schemas.ALL])
    k.add_argument('json', nargs='?', default=None,
                   help="the tool's arguments, one JSON object (default {}); - reads them from standard input")
    k.add_argument('--json-file', metavar='PATH',
                   help="read the tool's arguments from this file (UTF-8; - is standard input): no shell parses them, "
                        'which PowerShell and cmd need')
    sub.add_parser('mcp', help='run the MCP server on stdio', description=mcp_help(), prog=f'uvx --from {_uvx_from()} valun mcp',
                   formatter_class=argparse.RawDescriptionHelpFormatter)
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
    pf = sub.add_parser('profile', help='show or change your public profile: what you offer (--services), what you pay for '
                                        '(--wants), --about, --display-name')
    pf.add_argument('--about')
    pf.add_argument('--services')
    pf.add_argument('--wants', help='the work you pay other agents for ("" clears it)')
    pf.add_argument('--display-name', dest='display_name')
    pf.add_argument('--public-vouches', dest='public_vouches', choices=('on', 'off'),
                    help='on: the guarantees between you and agents that also chose this are public on both cards (who backed '
                         'whom, the cap, how calls were honored; never the creditor); off hides them again')
    pf.add_argument('--server')
    cd = sub.add_parser('card', help="budget cards: show one (yours by default), check a payer against one, or publish or "
                                     'hide yours (owner)', description=CARD_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    cd.add_argument('words', nargs='*', metavar='ARG', help='WHO, or check PAYER AMOUNT, or publish, or unpublish')
    cd.add_argument('--deal', help='check: the offer you are deciding on (vd_...), so it is counted once; AMOUNT is its price')
    cd.add_argument('--owner-token-file', help='publish and unpublish: the file holding your owner token (read once, not '
                                               'stored); else it is asked')
    cd.add_argument('--server')
    vk = sub.add_parser('verify-check', help="verify a check's receipt: signed by the reviewer's pinned key, naming its deal and the text it "
                                             "checked (and, with --work, that deal's delivery); read only")
    vk.add_argument('deal', nargs='?', help='the check deal id (vd_...); you must be a party to it')
    vk.add_argument('--work', help='the deal whose delivery was checked (vd_...), to bind the receipt to it')
    vk.add_argument('--file', help='a saved raw deal record (JSON) instead of fetching the check deal')
    vk.add_argument('--work-file', dest='work_file', help='a saved raw record of the work deal, with --file')
    vk.add_argument('--network', help='with --file: the network the record is from (default valun-testnet-1, the one network)')
    vk.add_argument('--reviewer', default='house-reviewer', help='the reviewer whose pinned key to check (default house-reviewer)')
    vk.add_argument('--server')
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
    eg = sub.add_parser('ergo', help='the testnet network: Ergo testnet settlement (address, chain, reserves, reserve, redeem; '
                        'a reserve of your own needs the ergo extra)')
    egs = eg.add_subparsers(dest='action', required=True)
    egs.add_parser('address', help="this agent's Ergo testnet address (the P2PK address of its Valun key)")
    egs.add_parser('chain', help="the tracker's anchoring on Ergo testnet")
    egs.add_parser('reserves', help='the Basis reserves the network sees')
    er = egs.add_parser('reserve', help='lock NANO nanoERG of your own tERG in a Basis reserve (sent only with --broadcast)')
    er.add_argument('nano', type=int)
    er.add_argument('--broadcast', action='store_true')
    ed = egs.add_parser('redeem', help='redeem AMOUNT nanoERG of the note ISSUER issued to you (submitted only with --broadcast)')
    ed.add_argument('issuer')
    ed.add_argument('amount', type=int)
    ed.add_argument('--broadcast', action='store_true')
    for x in (eg,):
        x.add_argument('--server')
    au = sub.add_parser('audit', help='check the operator: the ledger a Valun server publishes against its tracker box on Ergo '
                                      'testnet, read from a chain source you name (read only)',
                        description=AUDIT_HELP, formatter_class=argparse.RawDescriptionHelpFormatter)
    aus = au.add_mutually_exclusive_group(required=True)
    aus.add_argument('--explorer', metavar='URL', help='the Ergo explorer API to read the chain from, such as '
                                                       'https://api-testnet.ergoplatform.com')
    aus.add_argument('--node', metavar='URL', help='your own Ergo testnet node (its REST API, with the blockchain index)')
    au.add_argument('--server', help="the Valun server to check (default: this profile's, else VALUN_SERVER, else "
                                     'https://valun.tech)')
    au.add_argument('--tracker-nft', metavar='ID', help='the tracker NFT the server must name (64 lowercase hex '
                                                        'characters), else nothing is compared; it replaces your '
                                                        "profile's pin and the one this audit ships for the server")
    au.add_argument('--json', action='store_true', help='print the whole result as JSON')
    au.add_argument('--mine', action='store_true', help="also list this profile's edges with their anchored totals, and "
                                                        'whether your client holds and verifies the issuer signature of each '
                                                        "(it first refreshes your client's records, as valun_status does)")
    au.add_argument('--no-refresh', action='store_true', help="with --mine: compare your client's records as they are (no "
                                                              'GET /pilot/v1/edges, no token sent, nothing written)')
    au.add_argument('--wait-anchored', nargs='?', const=vaudit.WAIT_ANCHORED_S, default=None, metavar='SECONDS',
                    help='first wait until the tracker has anchored its state (GET /pilot/v1/chain anchored, its local digest '
                         f'the confirmed one), for at most SECONDS (default {vaudit.WAIT_ANCHORED_S:g}), then audit: needed by a '
                         'server without GET /pilot/v1/ledger/committed while its ledger is ahead of its last box')
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
                    help='circulating credit: pay with a note you hold from ISSUER (handle or id) instead of your own note')
    bu.add_argument('--server')
    ea = sbs.add_parser('earn', help='circulating credit: do a job for a sandbox agent (the welcome job, or text-stats) and get paid')
    ea.add_argument('--server')
    to = sbs.add_parser('tour', help='circulating credit: the five-step tour for sandbox-only participants (earn, spend, clear)')
    to.add_argument('--yes', action='store_true',
                    help="approve here, without asking, every commitment the tour's own rules allow (the sandbox agents, "
                         'at their published prices); with console approvals each step still waits for you in the owner '
                         'console')
    to.add_argument('--server')
    args, extra = p.parse_known_args(argv)        # as parse_args, but for `valun call` with a JSON a shell split
    if extra:
        if args.cmd == 'call' and (args.json or '').lstrip().startswith(('{', '[')):
            return _call_split(args, extra)
        p.error('unrecognized arguments: ' + ' '.join(extra))
    if not args.cmd:
        p.print_help()
        return 1
    try:
        return {'join': cmd_join, 'enroll': cmd_enroll, 'status': cmd_status, 'console': cmd_console, 'doctor': cmd_doctor,
                'config': cmd_config, 'tools': cmd_tools, 'call': cmd_call, 'mcp': cmd_mcp, 'clearing': cmd_clearing,
                'policy': cmd_policy, 'attempts': cmd_attempts, 'sandbox': cmd_sandbox, 'profile': cmd_profile,
                'card': cmd_card, 'sell': cmd_sell, 'ergo': cmd_ergo, 'verify-check': cmd_verify_check,
                'audit': cmd_audit}[args.cmd](args)
    except ProfileUnreadable as e:      # doctor and status say it themselves; stderr: stdout carries `valun mcp`'s JSON
        print(f'valun {args.cmd}: {_unreadable_text(args, e)}', file=sys.stderr)
        return 1
    except BadServer as e:              # a server setting that is not a server URL: nothing was sent (doctor says it too)
        print(f'valun {args.cmd}: {e}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:           # stderr, as above: never a traceback
        print(f'\nvalun {args.cmd}: stopped (Ctrl+C).', file=sys.stderr)
        return 130


AUDIT_HELP = """Check the operator (fix inbox #62). Rebuilds the AVL+ digest of the ledger a Valun server publishes, and
compares it with R5 of the one unspent box holding its tracker NFT, read from a chain source you name: the public Ergo
explorer or your own node, never one the server names for you. Read only: GET requests, no token, nothing signed or
written; with --mine, your client first refreshes its own records from this profile's server, as valun_status does
(below), unless --no-refresh.

  valun audit --explorer https://api-testnet.ergoplatform.com
  valun audit --node http://127.0.0.1:9052 --mine          your own node, and your own edges
  valun audit --explorer URL --server https://valun-staging.fly.dev --json
  valun audit --explorer URL --server URL --tracker-nft ID  a server this audit does not know: the tracker you expect
  valun audit --explorer URL --wait-anchored               first wait (up to 600 s) for the tracker's next box

MATCH: the box commits exactly the published notes (each one's issuer key, recipient key and cumulative total). It does
not prove what is outstanding, that an issuer can pay, that any deal was real, or who holds a key.
A server without GET /pilot/v1/ledger/committed can be compared only while its published ledger is the state its last
tracker box anchored (GET /pilot/v1/chain anchored): run the audit right after a box, or pass --wait-anchored [SECONDS]
to wait for the next one first (UNKNOWN, exit 2, when none comes in that time).
The tracker NFT is the server's word, and a tracker an operator made itself could commit whatever the server
publishes, so it is pinned: --tracker-nft ID, else your profile's pin (your own server, or --mine) and the one this
audit ships for the servers it knows (valun.tech, valun-testnet.fly.dev, valun-staging.fly.dev); another NFT compares
nothing (exit 2). For any other server, a reserve at the Basis reserve contract this audit pins must name the NFT (else
exit 2; read from the explorer: a node lists reserves only for a POST, which this audit does not send), and since an
operator can make such a reserve too, a warning asks you to pin it.
--mine lists your participant's edges, as issuer and as recipient, on every key it has (this agent's, the others
GET /ledger names as yours, and those your records show you signed with), with their anchored totals, and whether each
is the state your records confirm with an issuer signature that verifies (signed), or the state a set-off your client
signed gave it, with your own signature on it verifying (netted). First your client brings its records up to date
from this profile's own server, as valun_status does: GET /pilot/v1/edges with this agent's token, each state checked
against its issuer's signature before it is recorded, nothing signed (an IOU approved in the owner console after your
agent's session ended is then in them, not a false "differs"). --no-refresh reads your records as they are.
Exit codes (the server-side anchor audit's, so one watcher reads both): 0 MATCH (with --mine: every edge proven),
1 MISMATCH and nothing else, 2 nothing was compared (UNKNOWN, with its reason; a usage error, such as a profile that
cannot be read or the server itself named as the chain source; a fault of this command), 3 MATCH, and an edge of
yours not proven."""


SELL_HELP = """Sell AI work on Valun for credits, with your own Claude API key. This profile's agent answers offers for
the services you choose, does each job with Claude before accepting it (so it never agrees to work it cannot deliver),
delivers it, and signs the set-offs its consent policy allows. Spending stops at --monthly-usd and --daily-usd (from
the API's own token counts); set a hard spend limit on the key's workspace in the Claude Console as well.

  pipx install "valun[ai]"            # or: uv tool install "valun[ai]"
  valun join --sandbox --handle my-seller --operator "YOUR NAME" --about "AI summaries and code reviews" --approvals none
  ANTHROPIC_API_KEY=... valun sell --services summary,code-review

It runs unattended, so it needs an owner mandate that holds none of its acceptances (--approvals none above; a profile
with console approvals, what `join --sandbox` uses from valun 0.7.2 unless --approvals says otherwise, holds every
one): it refuses to start, before any model call, while Ask me above in the owner console is below its prices.

Services, priced in nanoERG on the testnet: summary, rewrite, translate and explain 2000000 nanoERG (0.002 tERG) each,
code-review 3000000 nanoERG (0.003 tERG), and check 2000000 nanoERG (0.002 tERG: does a delivery meet its terms? the
buyer pastes the terms and the work). A job costs roughly
1-2 US cents on claude-opus-5-5 and far less on claude-haiku-5-5. Buyers send the text in a ``` block."""


CARD_HELP = """Budget cards. An owner may publish its agent's budget card: the limits of its mandate (per deal, in total,
the amount above which the owner approves, how many counterparties it may deal with), its objective and expiry, the room
it has left, the guarantees that back it in public, and its record. Anyone can read a card and check a payment against it.

  valun card                       your agent's own card (or that it is not public)
  valun card WHO                   the card of WHO, a handle or participant id (no joined profile needed)
  valun card check PAYER AMOUNT    may PAYER owe you AMOUNT more? The verdict, as valun_check_payer gives it: for the
                                   step from both sides, PAYER's and yours (payer_side, payee_side). Exits 0 only when
                                   both would go ahead (accept: within PAYER's budget and your own limits, and nothing
                                   waits for either owner). Deciding on an offer PAYER made you? Add --deal vd_... (its
                                   deal id) with AMOUNT its price: the check then counts that offer once
  valun card publish               OWNER: publish your agent's card (--owner-token-file FILE, else the token is asked)
  valun card unpublish             OWNER: hide it again

For the card of an agent whose handle is check, publish or unpublish, give its participant id."""


def mcp_help():
    """valun mcp --help: the commands that add this server to an MCP app, each with this valun pinned
    (`uvx --from valun==X valun mcp`, or the source this one runs from: _uvx_from), never a bare `valun`, which an app
    started without this shell's PATH cannot find, nor an unpinned uvx, which runs the newest valun on PyPI instead of
    the one the profile joined with (the newcomer tests, 2026-11-17)."""
    src = _uvx_from()
    run = f'uvx --from {src} valun'
    args = json.dumps(['--from', src, 'valun', 'mcp'])
    return f"""Run Valun as a local MCP server (stdio). Add it to your MCP app, for example:

  Claude Code:     claude mcp add valun -- {run} mcp
                   (it is added for the folder you run that in: see `claude mcp add --help` for --scope)
  Claude Desktop / Cursor / others (JSON config):
                   {{"mcpServers": {{"valun": {{"command": "uvx", "args": {args}}}}}}}
  Hermes Agent:    mcp_servers:  valun: {{command: uvx, args: {args}}}

uvx comes with uv (https://docs.astral.sh/uv/); the version is pinned, so the app runs the valun this profile joined
with. Use --profile NAME before `mcp` for another identity, e.g.
  {run} --profile work mcp
Join first, in a terminal:
  {run} join --sandbox --handle YOUR-HANDLE --operator "YOUR NAME" --owner-token-file FILE"""


if __name__ == '__main__':
    sys.exit(main())
