"""Where a participant's state lives, on any OS.

One private JSON file per profile: settings (server, participant id, approval mode), the agent's signing key and
agent token, and its own record of credit notes issued. Default locations:
  Linux and others: $XDG_CONFIG_HOME/valun/profiles/<name>.json (default ~/.config/valun/...)
  macOS:            ~/Library/Application Support/valun/profiles/<name>.json
  Windows:          %APPDATA%\\valun\\profiles\\<name>.json
VALUN_HOME overrides the folder. On POSIX the folder is created 0700 and the file 0600. On Windows, where a file mode is
ignored, the profiles folder this client makes, every profile file it writes and the owner token file join writes get,
as they are created, a protected access list that names SYSTEM, Administrators and this user's own SID (private_sddl):
so a file that an elevated run (Run as administrator) saved, which Administrators then own, still opens from a normal
shell. doctor reads a profile file's owner and access list (access_of), and its folder's when there is no file yet.
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
    private_folder(folder)
    if os.name != 'nt':
        try:
            os.chmod(home_dir(), 0o700)
            os.chmod(folder, 0o700)
        except OSError:
            pass
    return os.path.join(folder, profile + '.json')


# Owner-only files and folders on Windows (the RC's staging test, 2026-11-18): os.open's mode 0o600 and chmod do nothing
# there, so the owner token file took its folder's permissions (in that test, another group could change it). A file or
# folder this client makes private gets, as it is created, a protected DACL (nothing inherited) that lets in only
# SYSTEM, Administrators and this process's user, named by its SID (the RC's review, windows-acl W1 and missed[2]: a DACL
# that named the user only through OWNER RIGHTS, as Python's os.mkdir(path, 0o700) makes one, lets in whoever owns the
# file, and what an elevated run creates is owned by Administrators, which the same person's normal token holds for
# deny only, so their own owner token file and profile no longer opened from a normal shell).
SYSTEM, ADMINISTRATORS, OWNER_RIGHTS, EVERYONE = 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4', 'S-1-1-0'
# The rights that let someone read or change a file, or its permissions (an ACE that grants none of them, SYNCHRONIZE
# alone say, lets nobody in): FILE_READ_DATA, FILE_WRITE_DATA, FILE_APPEND_DATA, DELETE, WRITE_DAC, WRITE_OWNER and the
# generic rights. SDDL writes a mask in hex or as two-letter rights; a right this does not know counts as letting in.
_OPENS = 0x1 | 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000 | 0x80000000
_RIGHTS = {'FA': 0x1F01FF, 'FR': 0x120089, 'FW': 0x120116, 'FX': 0x1200A0, 'GA': 0x10000000, 'GR': 0x80000000,
           'GW': 0x40000000, 'GX': 0x20000000, 'RC': 0x20000, 'SD': 0x10000, 'WD': 0x40000, 'WO': 0x80000,
           'CC': 0x1, 'DC': 0x2, 'LC': 0x4, 'SW': 0x8, 'RP': 0x10, 'WP': 0x20, 'DT': 0x40, 'LO': 0x80, 'CR': 0x100}
# GetFileSecurityW's errors where a file system keeps no permissions to read (WSL's 9P share, \\wsl.localhost):
# ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED. Not FAT32 or exFAT: for them Windows reports the world's descriptor
# (owner Everyone, no DACL), which lets everyone in, and access_of names Everyone.
_NO_ACL_ERRORS = (1, 50)


def private_sddl(sid, folder=False):
    """The SDDL of a file (or folder, whose entries the files and folders made in it inherit) that only SYSTEM,
    Administrators and the user `sid` can open."""
    inherit = 'OICI' if folder else ''
    return f'D:P(A;{inherit};FA;;;SY)(A;{inherit};FA;;;BA)(A;{inherit};FA;;;{sid})'


def _win32():
    """The Win32 security calls used here, through ctypes (standard library only)."""
    import ctypes
    from ctypes import wintypes
    a, k = ctypes.WinDLL('advapi32', use_last_error=True), ctypes.WinDLL('kernel32', use_last_error=True)
    pv, dw = ctypes.c_void_p, wintypes.DWORD
    for fn, args, res in (
            (a.ConvertStringSecurityDescriptorToSecurityDescriptorW, (wintypes.LPCWSTR, dw, ctypes.POINTER(pv), pv), wintypes.BOOL),
            (a.ConvertSecurityDescriptorToStringSecurityDescriptorW, (pv, dw, dw, ctypes.POINTER(pv), pv), wintypes.BOOL),
            (a.GetFileSecurityW, (wintypes.LPCWSTR, dw, pv, dw, ctypes.POINTER(dw)), wintypes.BOOL),
            (a.OpenProcessToken, (wintypes.HANDLE, dw, ctypes.POINTER(wintypes.HANDLE)), wintypes.BOOL),
            (a.GetTokenInformation, (wintypes.HANDLE, ctypes.c_int, pv, dw, ctypes.POINTER(dw)), wintypes.BOOL),
            (a.ConvertSidToStringSidW, (pv, ctypes.POINTER(pv)), wintypes.BOOL),
            (a.ConvertStringSidToSidW, (wintypes.LPCWSTR, ctypes.POINTER(pv)), wintypes.BOOL),
            (a.LookupAccountSidW, (wintypes.LPCWSTR, pv, wintypes.LPWSTR, ctypes.POINTER(dw), wintypes.LPWSTR,
                                   ctypes.POINTER(dw), ctypes.POINTER(dw)), wintypes.BOOL),
            (k.CreateFileW, (wintypes.LPCWSTR, dw, dw, pv, dw, dw, wintypes.HANDLE), wintypes.HANDLE),
            (k.CreateDirectoryW, (wintypes.LPCWSTR, pv), wintypes.BOOL),
            (k.CloseHandle, (wintypes.HANDLE,), wintypes.BOOL),
            (k.GetCurrentProcess, (), wintypes.HANDLE),
            (k.LocalFree, (pv,), pv)):
        fn.argtypes, fn.restype = args, res
    return ctypes, wintypes, a, k


def _win_error(err, path):
    """The OSError for Windows error `err` on `path`, which it names (the RC's review, round 3, windows-acl WINACL-R4-4:
    ctypes.WinError names no path, so a profiles folder this user may not make said only "Access is denied")."""
    import ctypes
    return OSError(None, ctypes.FormatError(err).strip(), os.fspath(path), err)


def _security_attributes(sddl):
    """(a SECURITY_ATTRIBUTES for `sddl`, the descriptor to LocalFree once the call that uses it is done)."""
    ctypes, wintypes, a, k = _win32()

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [('nLength', wintypes.DWORD), ('lpSecurityDescriptor', ctypes.c_void_p), ('bInheritHandle', wintypes.BOOL)]
    sd = ctypes.c_void_p()
    if not a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None):
        raise ctypes.WinError(ctypes.get_last_error())
    return SecurityAttributes(ctypes.sizeof(SecurityAttributes), sd, False), sd


def open_new_private(path):
    """Create `path` as a new file that only this user (SYSTEM and Administrators aside) can open, and return a file
    descriptor open for writing (binary; an existing file is never replaced: FileExistsError). POSIX: O_EXCL with mode
    0600. Windows: CreateFileW with private_sddl(this user's SID), so the file is never open to anyone else, not even
    before its first byte is written, and it opens from a normal shell after an elevated run too. A file system that
    keeps no permissions (WSL's share) keeps none for it either: access_of says so; FAT32 and exFAT let everyone in."""
    if os.name != 'nt':
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
    import msvcrt
    ctypes, wintypes, a, k = _win32()
    sa, sd = _security_attributes(private_sddl(_user_sid()))
    try:
        # GENERIC_WRITE, no sharing, CREATE_NEW (never an existing file), FILE_ATTRIBUTE_NORMAL
        h = k.CreateFileW(os.fspath(path), 0x40000000, 0, ctypes.byref(sa), 1, 0x80, None)
        if h is None or h == ctypes.c_void_p(-1).value:
            err = ctypes.get_last_error()
            if err in (80, 183):                # ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
                raise FileExistsError(17, 'File exists', os.fspath(path))
            raise _win_error(err, path)
    finally:
        k.LocalFree(sd)
    try:
        return msvcrt.open_osfhandle(h, os.O_WRONLY | os.O_BINARY)
    except BaseException:
        k.CloseHandle(h)
        raise


def new_file_refused(folder):
    """Why this user may not create a file in `folder` (the OSError's words: 'Access is denied.'), or None when it may:
    a private probe file is made there (open_new_private) and removed again. A folder this user may list but not add a
    file to (a read-only grant, or Windows Security's Controlled folder access) let doctor say it "lets in only you",
    and a join make its participant before it found it could not save the agent's key (the RC's review, round 3,
    windows-acl WINACL-R4-5)."""
    probe = os.path.join(folder, f'.valun-probe-{os.getpid()}-{os.urandom(4).hex()}.tmp')
    try:
        fd = open_new_private(probe)
    except FileExistsError:                     # that name is taken: the folder takes files
        return None
    except OSError as e:
        return e.strerror or type(e).__name__
    os.close(fd)
    try:
        os.unlink(probe)
    except OSError:
        pass
    return None


def private_folder(path):
    """Make the folder `path` where it is missing (the folders above it as usual), only this user (SYSTEM and
    Administrators aside) able to open it: POSIX mode 0700; Windows private_sddl(this user's SID, folder=True), which
    the files made in it inherit. A folder that exists is left as it is: doctor names one that lets others in."""
    if os.path.isdir(path):
        return
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    if os.name != 'nt':
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        return
    ctypes, wintypes, a, k = _win32()
    sa, sd = _security_attributes(private_sddl(_user_sid(), folder=True))
    try:
        if not k.CreateDirectoryW(os.fspath(path), ctypes.byref(sa)):
            err = ctypes.get_last_error()
            if err != 183 or not os.path.isdir(path):        # ERROR_ALREADY_EXISTS: made meanwhile, by another process
                raise _win_error(err, path)
    finally:
        k.LocalFree(sd)


def _sddl_of(path):
    """The owner and DACL of `path` in SDDL ('O:<sid>D:<flags>(ace)...')."""
    ctypes, wintypes, a, k = _win32()
    info, n = 0x1 | 0x4, wintypes.DWORD(0)         # OWNER_ and DACL_SECURITY_INFORMATION
    a.GetFileSecurityW(os.fspath(path), info, None, 0, ctypes.byref(n))
    if not n.value:
        raise ctypes.WinError(ctypes.get_last_error())
    buf = ctypes.create_string_buffer(n.value)
    if not a.GetFileSecurityW(os.fspath(path), info, buf, n, ctypes.byref(n)):
        raise ctypes.WinError(ctypes.get_last_error())
    s = ctypes.c_void_p()
    if not a.ConvertSecurityDescriptorToStringSecurityDescriptorW(buf, 1, info, ctypes.byref(s), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.wstring_at(s.value)
    finally:
        k.LocalFree(s)


def _user_sid():
    """This process's user, as a SID string (S-1-5-21-...)."""
    ctypes, wintypes, a, k = _win32()
    h = wintypes.HANDLE()
    if not a.OpenProcessToken(k.GetCurrentProcess(), 0x0008, ctypes.byref(h)):     # TOKEN_QUERY
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        n = wintypes.DWORD(0)
        a.GetTokenInformation(h, 1, None, 0, ctypes.byref(n))                       # TokenUser
        buf = ctypes.create_string_buffer(n.value)
        if not n.value or not a.GetTokenInformation(h, 1, buf, n, ctypes.byref(n)):
            raise ctypes.WinError(ctypes.get_last_error())
        s = ctypes.c_void_p()
        if not a.ConvertSidToStringSidW(ctypes.c_void_p.from_buffer(buf).value, ctypes.byref(s)):  # TOKEN_USER.User.Sid
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.wstring_at(s.value)
        finally:
            k.LocalFree(s)
    finally:
        k.CloseHandle(h)


def user_sid_or_placeholder():
    """This process's user's SID, or YOUR-SID where it cannot be read (for a command to copy)."""
    try:
        return sid_string(_user_sid())
    except (OSError, AttributeError, ValueError):
        return 'YOUR-SID'


def sid_string(sid):
    """A SID as SDDL writes it (an alias such as BA or LA, or S-1-...) as its S-1-... string (ConvertStringSidToSidW
    and back), so that two spellings of one SID compare equal (the RC's review, windows-acl missed[0]: the built-in
    Administrator's own ACE, which SDDL writes LA, was named as someone else's); `sid` itself where Windows cannot
    read it."""
    try:
        ctypes, wintypes, a, k = _win32()
        p = ctypes.c_void_p()
        if not a.ConvertStringSidToSidW(sid, ctypes.byref(p)):
            return sid
        try:
            s = ctypes.c_void_p()
            if not a.ConvertSidToStringSidW(p, ctypes.byref(s)):
                return sid
            try:
                return ctypes.wstring_at(s.value)
            finally:
                k.LocalFree(s)
        finally:
            k.LocalFree(p)
    except (OSError, AttributeError, ValueError):
        return sid


def account_name(sid):
    """The account a SID names, as 'DOMAIN\\name' (LookupAccountSidW), or None where this machine knows no name for it."""
    try:
        ctypes, wintypes, a, k = _win32()
        p = ctypes.c_void_p()
        if not a.ConvertStringSidToSidW(sid, ctypes.byref(p)):
            return None
        try:
            name, domain = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
            n, d, use = wintypes.DWORD(256), wintypes.DWORD(256), wintypes.DWORD(0)
            if not a.LookupAccountSidW(None, p, name, ctypes.byref(n), domain, ctypes.byref(d), ctypes.byref(use)):
                return None
            return f'{domain.value}\\{name.value}' if domain.value else name.value
        finally:
            k.LocalFree(p)
    except (OSError, AttributeError, ValueError):
        return None


def access_words(sids):
    """SIDs in words (the RC's review, windows-acl W7: raw SIDs nobody could act on): 'BUILTIN\\Users (S-1-5-32-545),
    S-1-5-21-...', the account each names where this machine knows one, with its SID."""
    out = []
    for sid in sids:
        name = account_name(sid)
        out.append(f'{name} ({sid})' if name else sid)
    return ', '.join(out)


def _mask(rights):
    """An ACE's rights as a number (SDDL: hex, a number, or two-letter rights)."""
    r = rights.strip()
    try:
        if r[:2].lower() == '0x':
            return int(r, 16)
        if r.isdigit():
            return int(r)
    except ValueError:
        return 0xFFFFFFFF
    m = 0
    for i in range(0, len(r), 2):
        m |= _RIGHTS.get(r[i:i + 2], 0xFFFFFFFF)
    return m


def access_of(path):
    """Windows: who besides this user, SYSTEM and Administrators can open `path`, from its owner and DACL. A dict:
    state 'ok' (then others and owner say who: [] and None for no one), 'missing' (no such file), 'no_acl' (a file
    system that keeps no permissions: WSL's share), 'denied' (this user may not read them: what an elevated run or
    another account made), or 'unknown' (anything else, a descriptor this does not read); others: (SID, inherited) for
    each allow ACE that lets someone in (not inherit-only, with a right to read or change it, _OPENS), inherited from
    its folder or its own; owner: its owner when that is not this user, SYSTEM or Administrators (an owner can always
    change the DACL; the RC's review, windows-acl W6). SIDs as S-1-... strings, compared so (sid_string). None on
    POSIX."""
    if os.name != 'nt':
        return None
    if not os.path.exists(path):
        return {'state': 'missing', 'others': [], 'owner': None}
    try:
        me = sid_string(_user_sid())
        sddl = _sddl_of(path)
    except OSError as e:
        code = getattr(e, 'winerror', None)
        state = 'denied' if code == 5 or isinstance(e, PermissionError) else 'no_acl' if code in _NO_ACL_ERRORS else 'unknown'
        return {'state': state, 'others': [], 'owner': None}
    except (AttributeError, ValueError):
        return {'state': 'unknown', 'others': [], 'owner': None}
    m = re.fullmatch(r'O:(?P<owner>S-[0-9-]+|[A-Z]{2})D:(?P<flags>[A-Z_]*)(?P<aces>(?:\([^)]*\))*)', sddl)
    if m is None:
        return {'state': 'unknown', 'others': [], 'owner': None}
    known = {SYSTEM, ADMINISTRATORS, OWNER_RIGHTS, me}
    owner = sid_string(m['owner'])
    owner = None if owner in known else owner
    if 'NO_ACCESS_CONTROL' in m['flags']:       # no DACL lets everyone in (FAT32, exFAT: their owner is a stand-in)
        return {'state': 'ok', 'others': [(EVERYONE, False)], 'owner': None}
    others, own, inherited = [], [], []
    for ace in re.findall(r'\(([^)]*)\)', m['aces']):
        f = ace.split(';')
        if len(f) < 6 or f[0] not in ('A', 'OA', 'XA', 'ZA') or not _mask(f[2]) & _OPENS:
            continue
        sid = sid_string(f[5])
        if sid in known:
            continue
        if 'ID' not in f[1] and sid not in own:
            own.append(sid)         # an entry of its own, inherit-only too: what a fix must remove (own_entries)
        if 'IO' in f[1]:
            continue
        if 'ID' in f[1] and sid not in inherited:
            inherited.append(sid)   # its folder lets them in (an account may have an entry of its own too)
        if sid not in [x for x, _ in others]:
            others.append((sid, 'ID' in f[1]))
    return {'state': 'ok', 'others': others, 'owner': owner, 'own': own, 'inherited': inherited}


def own_entries(access):
    """The accounts besides this user, SYSTEM and Administrators that a file's or folder's own permissions (not what it
    inherits) grant a right to read or change it, or the files made in it (access_of's 'own'), as S-1-... SIDs."""
    return list(access.get('own') or []) if isinstance(access, dict) and access.get('state') == 'ok' else []


def others_with_access(path):
    """access_of's accounts that can open `path` besides this user, SYSTEM and Administrators (its owner first, when
    that is someone else), as S-1-... SIDs; [] for no one; None where that cannot be read (not Windows, no such file, a
    file system that keeps no permissions, permissions this user may not read, or a descriptor this does not read)."""
    a = access_of(path)
    if a is None or a['state'] != 'ok':
        return None
    return ([a['owner']] if a['owner'] else []) + [sid for sid, _ in a['others'] if sid != a['owner']]


def _inherited(access):
    """The accounts access_of's 'ok' dict says its folder lets in (an ACE it inherited), whatever entries of its own
    they have too."""
    if 'inherited' in access:
        return list(access['inherited'])
    return [sid for sid, i in access['others'] if i]


def who_else(access):
    """access_of's 'ok' dict in words: 'its owner X; Y, whom its own permissions let in; Z, whom its folder lets in' (the
    folder only for ACEs it inherited: the RC's review, windows-acl W7), and 'whom its own permissions and its folder
    let in' for an account with both. '' for no one."""
    parts = []
    if access['owner']:
        parts.append(f"its owner, {access_words([access['owner']])}")
    folder = [sid for sid in _inherited(access) if sid != access['owner']]
    own = [sid for sid, inherited in access['others'] if not inherited and sid != access['owner'] and sid not in folder]
    both = [sid for sid, inherited in access['others'] if not inherited and sid != access['owner'] and sid in folder]
    folder = [sid for sid in folder if sid not in both]
    if own:
        parts.append(f'{access_words(own)}, whom its own permissions let in')
    if both:
        parts.append(f'{access_words(both)}, whom its own permissions and its folder let in')
    if folder:
        parts.append(f'{access_words(folder)}, whom its folder lets in')
    return '; '.join(parts)


def _removals(path, access):
    """icacls's /remove:g for each account `path`'s own permissions let in (own_entries of `access`, or of access_of(path)
    when it is None): /inheritance:r drops only what is inherited, and /grant:r replaces only the accounts it names, so
    an entry set on the file or folder itself for another account stayed, and doctor printed the same fix again (the
    RC's review, round 3, windows-acl WIN3)."""
    a = access if access is not None else access_of(path)
    return ''.join(f' /remove:g "*{sid}"' for sid in own_entries(a))


def folder_fix(folder, access=None):
    """The command that makes `folder` owner-only (this user, SYSTEM and Administrators), and what the files made in it
    inherit: icacls, with this user's SID, and the entries of its own that let others in removed (_removals; `access`:
    access_of(folder), read here when it is None). Each grant is in double quotes, so that it runs as printed in cmd and
    in PowerShell, which reads an unquoted (OI) as a command of its own (the RC's review, round 3, windows-acl WIN2: in
    Windows PowerShell, the default shell of Windows 11, icacls never ran)."""
    return (f'icacls "{folder}" /inheritance:r /grant:r "*{user_sid_or_placeholder()}:(OI)(CI)F" "*{SYSTEM}:(OI)(CI)F" '
            f'"*{ADMINISTRATORS}:(OI)(CI)F"' + _removals(folder, access))


def file_fix(path, access=None):
    """The command that makes the file `path` owner-only (this user, SYSTEM and Administrators): icacls, with this
    user's SID, and the entries of its own that let others in removed (_removals; `access`: access_of(path), read here
    when it is None)."""
    return (f'icacls "{path}" /inheritance:r /grant:r *{user_sid_or_placeholder()}:F *{SYSTEM}:F *{ADMINISTRATORS}:F'
            + _removals(path, access))


def take_back(path):
    """The commands that give `path` back to this user, from an elevated shell (an elevated run made it, and owns it)."""
    return f'`takeown /f "{path}"`, then `icacls "{path}" /grant *{user_sid_or_placeholder()}:F`'


def take_back_folder(folder):
    """The commands that give `folder` and the files in it back to this user, from an elevated shell (an elevated run
    made it, and owns it): its grant in double quotes, as folder_fix's (PowerShell)."""
    return (f'`takeown /f "{folder}" /r`, then `icacls "{folder}" /grant "*{user_sid_or_placeholder()}:(OI)(CI)F" /t`')


def open_error(path):
    """Windows: the error Windows gives opening `path` to read it, sharing it with every other open (a Win32 error code:
    5 access denied, 32 ERROR_SHARING_VIOLATION, 33 ERROR_LOCK_VIOLATION), or None when it opens. Python's open()
    says only "Permission denied" for the first three (errno EACCES, no winerror). None elsewhere."""
    if os.name != 'nt':
        return None
    try:
        ctypes, wintypes, a, k = _win32()
        # GENERIC_READ; FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE; OPEN_EXISTING; FILE_ATTRIBUTE_NORMAL
        h = k.CreateFileW(os.fspath(path), 0x80000000, 0x7, None, 3, 0x80, None)
        if h is None or h == ctypes.c_void_p(-1).value:
            return ctypes.get_last_error()
        k.CloseHandle(h)
    except (OSError, AttributeError, ValueError):
        return None
    return None


def folder_denied(path):
    """Windows: does the profile file `path` look missing only because this user may not open its folder (an elevated
    run or another account made it: the RC's review, round 3, windows-acl WIN4)? Its folder is there, and this user may
    not read its permissions, or not list what is in it. False elsewhere, and for a file that is there."""
    if os.name != 'nt' or os.path.exists(path):
        return False
    folder = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(folder):
        return False
    if access_of(folder)['state'] == 'denied':
        return True
    try:
        os.listdir(folder)
    except PermissionError:
        return True
    except OSError:
        return False
    return False


def permission_problem(path):
    """doctor's sentence when the profile file at `path` lets others in, or when this user may not read its
    permissions; else None (a file that is not there, or on a drive that keeps no permissions, is said apart). POSIX:
    its mode. Windows, where a mode is not a permission: its owner and DACL (access_of; the RC's staging test: doctor
    said "private" there without looking). Its fix never names the folder it is in as the place to move it to (the
    RC's review, windows-acl W3): any save rewrites the profile owner-only, and a folder that lets others in too gets
    the command that closes it."""
    if not os.path.exists(path):
        return None
    if os.name == 'nt':
        a = access_of(path)
        if a['state'] == 'denied':
            return (f'This user may not read the permissions of {path} (access denied): an elevated run (Run as '
                    'administrator) or another account made it, and only that one can open it now. The profile itself, '
                    "which holds this agent's key, is not lost: never join again for this. From an elevated shell, give "
                    f'it back to this user: {take_back(path)}; or go on running valun elevated.')
        if a['state'] != 'ok' or not (a['others'] or a['owner']):
            return None
        fix = (f'Fix, from an elevated shell (it is not yours): {take_back(path)}' if a['owner'] else
               f'Fix: `{file_fix(path, a)}`')
        if _inherited(a):
            fix += ('; and close its folder, which lets them in too, or they could still replace the profile: '
                    f'`{folder_fix(os.path.dirname(os.path.abspath(path)))}`')
        return (f"{path} can also be opened by {who_else(a)}, so your agent's key in it is not private. {fix} (valun "
                'also writes the profile owner-only the next time it saves it).')
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077:
        return f'{path} is readable by other users (mode {oct(mode)}). Fix: chmod 600 {path}'
    return None
