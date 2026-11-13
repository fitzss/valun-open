"""Where a participant's state lives, on any OS.

One private JSON file per profile: settings (server, participant id, approval mode), the agent's signing key and
agent token, and its own record of credit notes issued. Default locations:
  Linux and others: $XDG_CONFIG_HOME/valun/profiles/<name>.json (default ~/.config/valun/...)
  macOS:            ~/Library/Application Support/valun/profiles/<name>.json
  Windows:          %APPDATA%\\valun\\profiles\\<name>.json
VALUN_HOME overrides the folder. On POSIX the folder is created 0700 and the file 0600; on Windows the per-user
profile folder's default permissions apply.
"""
import os
import re
import stat
import sys

# The one network's server (valun-testnet-1 since 2026-11-13; https://valun-desk.fly.dev, the default before, serves it
# too).
DEFAULT_SERVER = 'https://valun.tech'
APPROVAL_MODES = ('ask', 'client-prompt', 'console', 'none')
_PROFILE_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')


def home_dir():
    if os.environ.get('VALUN_HOME'):
        return os.path.abspath(os.environ['VALUN_HOME'])
    if os.name == 'nt':
        return os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'valun')
    if sys.platform == 'darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'valun')
    return os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(os.path.expanduser('~'), '.config'), 'valun')


def profile_path(profile='default'):
    profile = (profile or 'default').strip().lower()
    if not _PROFILE_RE.match(profile):
        raise ValueError('a profile name is 1-32 lowercase letters, digits, _ or -, starting with a letter or digit')
    folder = os.path.join(home_dir(), 'profiles')
    os.makedirs(folder, mode=0o700, exist_ok=True)
    if os.name != 'nt':
        try:
            os.chmod(home_dir(), 0o700)
            os.chmod(folder, 0o700)
        except OSError:
            pass
    return os.path.join(folder, profile + '.json')


def permission_problem(path):
    """On POSIX: a sentence if the state file is readable by others, else None. Windows: None (ACLs are per-user)."""
    if os.name == 'nt' or not os.path.exists(path):
        return None
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        return f'{path} is readable by other users (mode {oct(mode)}). Fix: chmod 600 {path}'
    return None
