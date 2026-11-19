"""Private files on Windows (the RC's review, windows-acl lens): what an elevated run writes, how doctor reads and names
permissions, and the SIDs it compares. Each Windows test reads or makes files in a temporary folder only; the elevated
case is checked without elevating, by Windows' own AccessCheck of the descriptor an elevated run leaves (owner
Administrators) against this process's own, normal token. Test data only."""
import contextlib
import ctypes
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
from valun import cli  # noqa: E402
from valun import client as vc  # noqa: E402
from valun import home  # noqa: E402

WINDOWS = unittest.skipUnless(os.name == 'nt', 'Windows permissions')
USERS = 'S-1-5-32-545'
FILE_READ, FILE_ADD = 0x120089, 0x2             # FILE_GENERIC_READ; FILE_ADD_FILE (a folder: make a file in it)


def normal_token_opens(sddl, want):
    """Does this process's own token get `want` from a file with descriptor `sddl` (Windows' AccessCheck)? None where
    this process runs elevated (Administrators then decides, whatever the DACL names: such a check proves nothing)."""
    from ctypes import wintypes
    adv, k32 = ctypes.WinDLL('advapi32', use_last_error=True), ctypes.WinDLL('kernel32', use_last_error=True)
    pv, dw = ctypes.c_void_p, wintypes.DWORD
    adv.OpenProcessToken.argtypes = (wintypes.HANDLE, dw, ctypes.POINTER(wintypes.HANDLE))
    adv.GetTokenInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, pv, dw, ctypes.POINTER(dw))
    adv.DuplicateTokenEx.argtypes = (wintypes.HANDLE, dw, pv, ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE))
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (wintypes.LPCWSTR, dw, ctypes.POINTER(pv), pv)
    adv.AccessCheck.argtypes = (pv, wintypes.HANDLE, dw, pv, pv, ctypes.POINTER(dw), ctypes.POINTER(dw),
                                ctypes.POINTER(wintypes.BOOL))
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.LocalFree.argtypes = (pv,)
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    me = wintypes.HANDLE()
    if not adv.OpenProcessToken(k32.GetCurrentProcess(), 0x0008 | 0x0002, ctypes.byref(me)):    # QUERY, DUPLICATE
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        elevated, n = dw(0), dw(0)
        adv.GetTokenInformation(me, 20, ctypes.byref(elevated), ctypes.sizeof(elevated), ctypes.byref(n))  # TokenElevation
        if elevated.value:
            return None
        imp = wintypes.HANDLE()
        if not adv.DuplicateTokenEx(me, 0x0008 | 0x0004 | 0x0002, None, 2, 2, ctypes.byref(imp)):    # an impersonation copy
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            class Mapping(ctypes.Structure):
                _fields_ = [('r', dw), ('w', dw), ('x', dw), ('a', dw)]
            mapping = Mapping(0x120089, 0x120116, 0x1200A0, 0x1F01FF)
            sd = pv()
            if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                ps = ctypes.create_string_buffer(512)
                psl, granted, status = dw(512), dw(0), wintypes.BOOL(0)
                if not adv.AccessCheck(sd, imp, want, ctypes.byref(mapping), ps, ctypes.byref(psl), ctypes.byref(granted),
                                       ctypes.byref(status)):
                    raise ctypes.WinError(ctypes.get_last_error())
                return bool(status.value)
            finally:
                k32.LocalFree(sd)
        finally:
            k32.CloseHandle(imp)
    finally:
        k32.CloseHandle(me)


def as_an_elevated_run_leaves_it(path):
    """The descriptor `path` has, with the owner an elevated run gives what it creates: Administrators (and a group,
    which AccessCheck wants)."""
    sddl = home._sddl_of(path)
    return 'O:BAG:BA' + sddl[sddl.index('D:'):]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = mock.patch.dict(os.environ, {'VALUN_HOME': os.path.join(self.tmp.name, 'home'), 'HOME': self.tmp.name,
                                           'USERPROFILE': self.tmp.name})
        env.start()
        self.addCleanup(env.stop)
        for k in ('VALUN_PROFILE', 'VALUN_SERVER', 'UV'):
            os.environ.pop(k, None)

    def shared(self, name):
        """A folder whose permissions let Users (BU) change what is in it, as the staging test's home under %TEMP% let
        another group in."""
        folder = os.path.join(self.tmp.name, name)
        os.makedirs(folder)
        subprocess.run(['icacls', folder, '/grant', f'*{USERS}:(OI)(CI)M'], capture_output=True, check=True)
        return folder

    def doctor(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(vc.Client, 'request', side_effect=vc.ValunError('unreachable', 'offline here', None,
                                                                                   {'cause': 'not_connected'})):
            rc = cli.main([*argv, 'doctor'])
        return rc, out.getvalue()


@WINDOWS
class AnElevatedRunsFiles(Base):
    """windows-acl W1 and missed[2]: the owner token file's DACL let its user in only through OWNER RIGHTS, and a file
    an elevated join creates is owned by Administrators, which the same person's normal token holds for deny only: from
    a normal shell they could no longer open their own owner token file; every profile an elevated run saved, which
    inherits the 0o700 profiles folder's OWNER RIGHTS, the same. Now the token file, each profile file and the profiles
    folder name this user's SID."""

    def setUp(self):
        super().setUp()
        if normal_token_opens('O:BAG:BAD:P(A;;FA;;;SY)', FILE_READ) is None:
            self.skipTest('this process runs elevated: Administrators opens everything, so nothing is shown')

    def test_the_owner_token_file_opens_from_a_normal_shell(self):
        path = os.path.join(self.tmp.name, 'owner.txt')
        cli._write_private(path, 'vpo_TEST-ONLY\n')
        self.assertTrue(normal_token_opens(as_an_elevated_run_leaves_it(path), FILE_READ), home._sddl_of(path))

    def test_a_profile_and_its_folder_open_from_a_normal_shell(self):
        path = home.profile_path('elevated')
        store = vc.FileStore(path)
        store.state.update({'server': 'https://valun.example', 'secret': 'ab' * 32})
        store.save()
        self.assertTrue(normal_token_opens(as_an_elevated_run_leaves_it(path), FILE_READ), home._sddl_of(path))
        folder = os.path.dirname(path)
        self.assertTrue(normal_token_opens(as_an_elevated_run_leaves_it(folder), FILE_READ | FILE_ADD), home._sddl_of(folder))
        # each save writes a new file: the next one too
        store.update(lambda st: st.update(check_link_hosts=True))
        self.assertTrue(normal_token_opens(as_an_elevated_run_leaves_it(path), FILE_READ))
        self.assertEqual(home.others_with_access(path), [])

    def test_a_folder_filestore_makes_is_private_and_names_this_user(self):
        folder = os.path.join(self.tmp.name, 'made-by-filestore')
        vc.FileStore(os.path.join(folder, 'p.json')).save()
        self.assertTrue(home._sddl_of(folder).endswith(home.private_sddl(home._user_sid(), folder=True)), home._sddl_of(folder))


@WINDOWS
class DoctorsPermissionLines(Base):
    """windows-acl W3 to W7, missed[0] and missed[1], regressions R2-OTHER-8: doctor's permission lines name accounts,
    say "its folder lets in" only for what a file inherits, never call a file that is not there private, read the owner
    token file the profile records, tell a profile this user may not read apart from a drive that keeps no
    permissions, and compare SIDs, not their SDDL spellings."""

    def profile(self, folder=None, **state):
        path = os.path.join(folder, 's.json') if folder else home.profile_path('s')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(dict({'server': 'https://valun.example', 'participant_id': 'vp_0a0a0a0a0a0a', 'secret': 'ab' * 32,
                            'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1', 'approvals': 'none'}, **state), f)
        return path

    def test_accounts_are_named_and_the_folder_only_for_what_a_file_inherits(self):
        self.assertEqual(home.access_words([USERS]), f'BUILTIN\\Users ({USERS})')
        self.assertEqual(home.access_words(['S-1-5-21-1-2-3-4242']), 'S-1-5-21-1-2-3-4242', 'no name known: the SID')
        folder = self.shared('shared')
        inherited = os.path.join(folder, 'inherited.txt')
        with open(inherited, 'w', encoding='utf-8') as f:
            f.write('x')
        self.assertEqual(home.who_else(home.access_of(inherited)), f'BUILTIN\\Users ({USERS}), whom its folder lets in')
        own = os.path.join(self.tmp.name, 'own.txt')
        cli._write_private(own, 'x')
        subprocess.run(['icacls', own, '/grant', f'*{USERS}:R'], capture_output=True, check=True)
        self.assertEqual(home.who_else(home.access_of(own)), f'BUILTIN\\Users ({USERS}), whom its own permissions let in')

    def test_a_profile_that_is_not_there_yet_is_never_called_private_and_its_folder_is_read(self):
        rc, out = self.doctor('--profile', 'nobody')
        self.assertNotIn('Profile file permissions: private', out)
        self.assertIn('ok    Profile file permissions: no profile file yet (its folder '
                      f"{os.path.join(os.environ['VALUN_HOME'], 'profiles')} lets in only you, SYSTEM and Administrators)", out)
        with mock.patch.dict(os.environ, {'VALUN_HOME': self.shared('shared-home')}):
            os.makedirs(os.path.join(os.environ['VALUN_HOME'], 'profiles'))
            subprocess.run(['icacls', os.path.join(os.environ['VALUN_HOME'], 'profiles'), '/grant', f'*{USERS}:(OI)(CI)M'],
                           capture_output=True, check=True)
            rc, out = self.doctor('--profile', 'nobody')
            folder = os.path.join(os.environ['VALUN_HOME'], 'profiles')
        # an entry of its own, and the one it inherits from shared-home (the RC's review, round 3, WIN3: the fix removes
        # its own entry too)
        self.assertIn(f'FIX   No profile file yet, and its folder {folder} also lets in BUILTIN\\Users ({USERS}), whom its '
                      'own permissions and its folder let in, who could replace the profile valun writes there. Fix: '
                      f'`icacls "{folder}" /inheritance:r /grant:r ', out)
        self.assertIn(f'/remove:g "*{USERS}"`.', out)
        self.assertNotIn('Profile file permissions: private', out)

    def test_the_owner_token_file_the_profile_records_is_read(self):
        token = os.path.join(self.shared('tokens'), 'owner.txt')
        with open(token, 'w', encoding='utf-8') as f:        # as 0.7.1 wrote one: its folder's permissions
            f.write('vpo_TEST-ONLY\n')
        self.profile(owner_token_file=token)
        rc, out = self.doctor('--profile', 's')
        self.assertIn(f'FIX   Your owner token file {token} can also be opened by BUILTIN\\Users ({USERS}), whom its folder '
                      'lets in: move the token into your password manager and delete the file.', out)

    def test_a_profile_this_user_may_not_read_is_named_so_and_never_given_up(self):
        path = home.profile_path('s')
        sa, sd = home._security_attributes('D:P(A;;0x100000;;;OW)')     # its owner may only wait on it: no read
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateFileW.restype = ctypes.c_void_p
        h = k.CreateFileW(path, 0x40000000, 0, ctypes.byref(sa), 1, 0x80, None)
        k.LocalFree.argtypes = (ctypes.c_void_p,)
        k.LocalFree(sd)
        self.assertNotIn(h, (None, ctypes.c_void_p(-1).value), ctypes.get_last_error())
        k.CloseHandle.argtypes = (ctypes.c_void_p,)
        k.CloseHandle(h)
        self.assertEqual(home.access_of(path)['state'], 'denied')
        self.assertIsNone(home.others_with_access(path))
        rc, out = self.doctor('--profile', 's')
        self.assertIn(f'FIX   The profile {path} cannot be read by this user', out)
        self.assertIn('an elevated run (Run as administrator) or another account made it', out)
        self.assertIn(f'`takeown /f "{path}"`, then `icacls "{path}" /grant *{home._user_sid()}:F`', out)
        self.assertNotIn('join again in a new profile', out)
        self.assertNotIn("Windows could not read them for this file's drive", out, 'never blamed on the drive')

    def test_sids_are_compared_not_their_sddl_spellings(self):
        admin = home.sid_string('LA')                   # the built-in Administrator (RID 500), which SDDL writes LA
        self.assertTrue(admin.startswith('S-1-5-21-') and admin.endswith('-500'), admin)
        with mock.patch.object(home, '_user_sid', lambda: admin), \
                mock.patch.object(home, '_sddl_of', lambda p: 'O:BAD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;LA)'), \
                mock.patch.object(home.os.path, 'exists', lambda p: True):
            self.assertEqual(home.others_with_access('x'), [], "that account's own ACE is not someone else's")

    def test_an_owner_who_is_someone_else_is_named_and_a_right_that_opens_nothing_is_not(self):
        other = 'S-1-5-21-1-2-3-1006'
        with mock.patch.object(home, '_sddl_of', lambda p: f'O:{other}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)'), \
                mock.patch.object(home.os.path, 'exists', lambda p: True):
            a = home.access_of('x')
            self.assertEqual((a['owner'], a['others']), (other, []))
            self.assertEqual(home.who_else(a), f'its owner, {other}')
        with mock.patch.object(home, '_sddl_of', lambda p: 'O:BAD:P(A;;0x100000;;;WD)(A;;FA;;;OW)'), \
                mock.patch.object(home.os.path, 'exists', lambda p: True):
            self.assertEqual(home.others_with_access('x'), [], 'SYNCHRONIZE alone opens nothing')
        # FAT32 and exFAT: Windows reports the world's descriptor, which lets everyone in, named as the file's own
        with mock.patch.object(home, '_sddl_of', lambda p: 'O:WDD:NO_ACCESS_CONTROL'), \
                mock.patch.object(home.os.path, 'exists', lambda p: True):
            a = home.access_of('x')
            self.assertEqual(home.who_else(a), 'Everyone (S-1-1-0), whom its own permissions let in')


@WINDOWS
class TheElevatedRunsPythons(Base):
    """The RC's review, round 3 (regressions R3-REG-4): CHANGELOG 0.7.2 said that "on Python 3.12.4 and later" the profiles
    folder 0.7.1 made lets in only SYSTEM, Administrators and its owner (so an elevated run's profile no longer opens
    from a normal shell). The same os.makedirs(folder, mode=0o700) that 0.7.1's home.py calls gives that ACL on the 3.10
    and 3.11 security releases too (the CVE-2024-4030 fix), which the package supports (requires-python >=3.10)."""

    def test_the_changelog_names_this_python_when_its_makedirs_lets_in_only_the_owner(self):
        folder = os.path.join(self.tmp.name, 'made-as-0.7.1-made-it')
        os.makedirs(folder, mode=0o700)                     # 0.7.1's home.py: os.makedirs(folder, mode=0o700, exist_ok=True)
        dacl = home._sddl_of(folder).split('D:', 1)[1]
        owner_only = '(A;OICI;FA;;;OW)' in dacl and home._user_sid() not in dacl     # its user only through OWNER RIGHTS
        with open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'CHANGELOG.md'), encoding='utf-8') as f:
            text = f.read()
        start = text.index('- **On Windows, profiles stay private and open from a normal shell after an elevated run**')
        bullet = ' '.join(text[start:text.index('\n- ', start + 1)].split())
        if owner_only:
            v = sys.version_info
            self.assertTrue(f'{v.major}.{v.minor}.' in bullet or v >= (3, 12, 4),
                            f'Python {v.major}.{v.minor}.{v.micro} makes such a folder: {bullet[:400]}')
        self.assertIn('CVE-2024-4030', bullet, 'the condition, not one version')


def set_dacl(path, sddl):
    """Set `path`'s DACL from an SDDL 'D:...' (protected for 'D:P'), as SetFileSecurityW does."""
    from ctypes import wintypes
    adv, k32 = ctypes.WinDLL('advapi32', use_last_error=True), ctypes.WinDLL('kernel32', use_last_error=True)
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD,
                                                                         ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p)
    adv.SetFileSecurityW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p)
    adv.SetFileSecurityW.restype = wintypes.BOOL
    k32.LocalFree.argtypes = (ctypes.c_void_p,)
    sd = ctypes.c_void_p()
    if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = 0x4 | (0x80000000 if sddl.startswith('D:P') else 0x20000000)     # DACL | PROTECTED_ / UNPROTECTED_DACL
        if not adv.SetFileSecurityW(path, info, sd):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        k32.LocalFree(sd)


@WINDOWS
class AProfilesFolderThisUserMayNotOpen(Base):
    """The RC's review, round 3 (windows-acl WIN4): 0.7.1's first run made elevated (Python with the CVE-2024-4030 fix)
    leaves a profiles folder owned by Administrators that lets in only SYSTEM, Administrators and its owner, which the
    same person's normal token cannot open. From a normal shell the profile in it then looked missing: doctor said "no
    profile file yet" and "Not connected: run ... join --sandbox", status "(not joined)", the tools not_connected with
    the join, and the join that followed made a new participant that could not save its key ("profile_busy"). That
    folder is emulated here with an OWNER RIGHTS entry that grants only WRITE_DAC (this token can neither list the folder
    nor read its permissions, as a normal token gets from the real one; WRITE_DAC lets the test undo it)."""
    LOCKED = 'D:P(A;;0x40000;;;OW)'

    def setUp(self):
        super().setUp()
        self.path = home.profile_path('s')
        self.folder = os.path.dirname(self.path)
        store = vc.FileStore(self.path)
        store.state.update({'server': 'https://valun.example', 'participant_id': 'vp_0a0a0a0a0a0a', 'secret': 'ab' * 32,
                            'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1', 'approvals': 'none'})
        store.save()
        mine = home.private_sddl(home._user_sid())
        set_dacl(self.path, self.LOCKED)
        set_dacl(self.folder, self.LOCKED)
        self.addCleanup(set_dacl, self.path, mine)
        self.addCleanup(set_dacl, self.folder, home.private_sddl(home._user_sid(), folder=True))
        self.assertEqual(home.access_of(self.folder)['state'], 'denied')
        self.assertFalse(os.path.exists(self.path), 'the profile looks missing from here')

    def cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(vc.Client, 'request', side_effect=AssertionError('nothing is sent')) as sent:
            rc = cli.main(['--profile', 's', *argv])
        return rc, out.getvalue(), err.getvalue(), sent.call_count

    def named(self, text):
        self.assertIn(f'This user may not open the profiles folder {self.folder} (access denied)', text)
        self.assertIn('an elevated run (Run as administrator) or another account made that folder', text)
        self.assertIn('never join again for this', text)
        self.assertIn(f'`takeown /f "{self.folder}" /r`, then `icacls "{self.folder}" /grant '
                      f'"*{home._user_sid()}:(OI)(CI)F" /t`', text)
        for wrong in ('no profile file yet', 'Not connected', '(not joined)', 'join --sandbox', 'not_connected'):
            self.assertNotIn(wrong, text)

    def test_doctor_names_the_folder_and_never_a_new_join(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(vc.Client, 'request', side_effect=vc.ValunError('unreachable', 'offline here', None,
                                                                                   {'cause': 'not_connected'})):
            rc = cli.main(['--profile', 's', 'doctor'])
        self.assertEqual(rc, 1)
        self.named(out.getvalue())
        self.assertEqual(out.getvalue().count('This user may not open the profiles folder'), 1, out.getvalue())

    def test_status_and_the_tools_name_the_folder(self):
        rc, out, err, sent = self.cli('status')
        self.assertEqual((rc, sent), (1, 0))
        self.named(out)
        rc, out, err, sent = self.cli('call', 'valun_status')
        self.assertEqual((rc, sent), (1, 0))
        self.named(err)
        self.assertNotIn('not_connected', out)

    def test_a_join_sends_nothing(self):
        rc, out, err, sent = self.cli('join', '--sandbox', '--handle', 'again', '--operator', 'Ann', '--approvals', 'none',
                                      '--server', 'https://valun.example')
        self.assertEqual((rc, sent), (1, 0), out + err)
        self.named(err)

    def test_take_back_folder_runs_in_every_shell(self):
        import re
        folder = os.path.join(self.tmp.name, 'Ann Lee', 'profiles')
        os.makedirs(os.path.join(folder, 'sub'))
        with open(os.path.join(folder, 'a.json'), 'w', encoding='utf-8') as f:
            f.write('{}')
        for shell in shells():
            with self.subTest(shell=shell):
                for c in re.findall(r'`([^`]+)`', home.take_back_folder(folder)):
                    r = run_as_typed(shell, c)
                    self.assertEqual(r.returncode, 0, (shell, c, r.stdout.decode('cp1252', 'replace')))
                with open(os.path.join(folder, 'a.json'), encoding='utf-8') as f:
                    self.assertEqual(f.read(), '{}')


@WINDOWS
class AProfileAnotherProgramHasOpen(Base):
    """The RC's review, round 3 (windows-acl WIN5): a profile another program holds open without sharing it (a backup or
    sync tool, an editor), which Windows reports as a sharing violation and Python as PermissionError, made doctor and
    status say "Restore it from a backup, or move it aside and join again in a new profile", although the profile was
    intact and only open elsewhere (0.7.1 ended in a traceback there)."""

    def test_doctor_and_status_say_to_close_it_never_to_join_again(self):
        path = home.profile_path('s')
        store = vc.FileStore(path)
        store.state.update({'server': 'https://valun.example', 'participant_id': 'vp_0a0a0a0a0a0a', 'secret': 'ab' * 32,
                            'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1', 'approvals': 'none'})
        store.save()
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateFileW.restype = ctypes.c_void_p
        k.CreateFileW.argtypes = (ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                                  ctypes.c_uint32, ctypes.c_void_p)
        k.CloseHandle.argtypes = (ctypes.c_void_p,)
        h = k.CreateFileW(path, 0x80000000, 0, None, 3, 0, None)       # GENERIC_READ, no sharing, OPEN_EXISTING
        self.assertNotIn(h, (None, ctypes.c_void_p(-1).value), ctypes.get_last_error())
        try:
            rc, out = self.doctor('--profile', 's')
            self.assertEqual(rc, 1)
            status = io.StringIO()
            with contextlib.redirect_stdout(status):
                self.assertEqual(cli.main(['--profile', 's', 'status']), 1)
        finally:
            k.CloseHandle(h)
        for text in (out, status.getvalue()):
            self.assertIn(f'The profile {path} is open in another program, which keeps others from reading it', text)
            self.assertIn('Nothing was signed, and the profile is not lost: close that program', text)
            self.assertIn('Never join again for this.', text)
            self.assertNotIn('join again in a new profile', text)
            self.assertNotIn('Restore it from a backup', text)
        with open(path, encoding='utf-8') as f:
            self.assertEqual(json.load(f)['participant_id'], 'vp_0a0a0a0a0a0a', 'intact')


@WINDOWS
class AFolderThisUserMayNotWrite(Base):
    """windows-acl WIN4, the lock: a profile this user may read in a folder it may not add a file to (Windows refuses the
    lock file) was reported, after LOCK_WAIT_S, as profile_busy ("another Valun process is using the profile")."""

    def test_the_lock_names_the_folder(self):
        path = home.profile_path('s')
        folder = os.path.dirname(path)
        store = vc.FileStore(path)
        store.state['server'] = 'https://valun.example'
        store.save()
        set_dacl(folder, f'D:P(A;OICI;FR;;;{home._user_sid()})')          # read only: no new file in it
        self.addCleanup(set_dacl, folder, home.private_sddl(home._user_sid(), folder=True))
        with mock.patch.object(vc.FileStore, 'LOCK_WAIT_S', 0.3), self.assertRaises(vc.ValunError) as e:
            store.update(lambda st: st.update(x=1))
        self.assertEqual(e.exception.code, 'profile_unwritable')
        self.assertIn(f'this user may not create a file in {folder}, the folder of the profile {path}', str(e.exception))
        self.assertNotIn('another Valun process', str(e.exception))


class AValunHomeThisUserMayNotAddAFolderTo(Base):
    """The RC's review, round 3 (windows-acl WINACL-R4-4): with a VALUN_HOME this user may read but not add a folder to
    (a read-only or protected place), and no profiles folder in it yet, every command, doctor included, ended in
    "PermissionError: [WinError 5] Access is denied." with no path (0.7.1 named the folder, in a traceback). Now each
    says in one line which folder it may not make and what to do, and sends nothing. Windows: a DACL that grants this
    user only read (undone afterwards); elsewhere, mode 0500."""

    def setUp(self):
        super().setUp()
        self.home = os.environ['VALUN_HOME']
        self.folder = os.path.join(self.home, 'profiles')
        os.makedirs(self.home)
        if os.name == 'nt':
            set_dacl(self.home, f'D:P(A;OICI;FR;;;{home._user_sid()})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
            self.addCleanup(set_dacl, self.home, home.private_sddl(home._user_sid(), folder=True))
        else:
            os.chmod(self.home, 0o500)
            self.addCleanup(os.chmod, self.home, 0o700)
        try:
            os.mkdir(os.path.join(self.home, 'probe'))
        except PermissionError:
            return
        os.rmdir(os.path.join(self.home, 'probe'))
        self.skipTest('this process may add a folder there anyway (elevated, or root)')

    def test_every_command_names_the_folder_it_may_not_make_and_sends_nothing(self):
        for argv in (['doctor'], ['status'], ['join', '--sandbox', '--handle', 'h-home', '--operator', 'Ann'],
                     ['call', 'valun_status'], ['config', 'server', 'https://valun.example']):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                    mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                    mock.patch.object(vc.Client, 'request', side_effect=AssertionError('nothing is sent')) as sent:
                rc = cli.main(['--profile', 's', *argv])
            text = out.getvalue() + err.getvalue()
            self.assertEqual((rc, sent.call_count), (1, 0), (argv, text))
            self.assertIn(f'This user may not make the profiles folder {self.folder} (', text)
            self.assertIn('Nothing was sent, and no profile was read or changed. Point VALUN_HOME at a folder you can '
                          'write, or unset it to use the default (', text)
            self.assertEqual(text.count('This user may not make the profiles folder'), 1, text)
        self.assertFalse(os.path.exists(self.folder))
        with self.assertRaises(PermissionError) as e:
            home.profile_path('s')
        self.assertEqual(e.exception.filename, self.folder, 'the error names the folder')


class AProfilesFolderThisUserMayListButNotWrite(Base):
    """The RC's review, round 3 (windows-acl WINACL-R4-5): in a profiles folder this user may list but not add a file to
    (a read-only grant, or Windows Security's Controlled folder access), doctor said "no profile file yet (its folder
    ... lets in only you, SYSTEM and Administrators)" and suggested a join, and the join made its participant on the
    server before it found, 5 s later, that it could not save the agent's key. Now the join is refused before anything
    is sent, and doctor says so, both naming the folder and its fix. Windows: a DACL that grants this user only read
    (undone afterwards). Elsewhere, mode 0500 on a folder whose mode this user cannot change, as another account's
    (profile_path makes this user's own folder 0700 again on every command): os.chmod does nothing during the test."""

    def setUp(self):
        super().setUp()
        self.folder = os.path.dirname(home.profile_path('s'))
        if os.name == 'nt':
            set_dacl(self.folder, f'D:P(A;OICI;FR;;;{home._user_sid()})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
            self.addCleanup(set_dacl, self.folder, home.private_sddl(home._user_sid(), folder=True))
        else:
            os.chmod(self.folder, 0o500)
            self.addCleanup(os.chmod, self.folder, 0o700)
            unchanged = mock.patch('os.chmod', lambda *a, **k: None)
            unchanged.start()
            self.addCleanup(unchanged.stop)
        try:
            os.close(os.open(os.path.join(self.folder, 'probe'), os.O_WRONLY | os.O_CREAT | os.O_EXCL))
        except PermissionError:
            return
        os.unlink(os.path.join(self.folder, 'probe'))
        self.skipTest('this process may add a file there anyway (elevated, or root)')

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(cli.urllib.request, 'getproxies', lambda: {}), \
                mock.patch.object(vc.Client, 'request', side_effect=vc.ValunError('unreachable', 'offline here', None,
                                                                                   {'cause': 'not_connected'})) as sent:
            rc = cli.main(['--profile', 's', *argv])
        return rc, out.getvalue() + err.getvalue(), sent

    def test_a_join_is_refused_before_anything_is_sent_and_doctor_says_why(self):
        words = f'this user may not create a file in the profiles folder {self.folder} ('
        for argv in (['join', '--sandbox', '--handle', 'h-readonly', '--operator', 'Ann', '--server', 'https://valun.example'],
                     ['join', '--handle', 'h-readonly', '--operator', 'Ann', '--invite-from-stdin']):
            rc, text, sent = self.run_cli(*argv)
            self.assertEqual((rc, sent.call_count), (1, 0), text)
            self.assertIn(f'Joining refused before anything was sent: {words}', text)
            self.assertIn("so a join could not save its agent's key there. "
                          + ('Fix' if os.name == 'nt' else 'Make it writable for this user'), text)
            self.assertIn('Then run this join again.', text)
        rc, text, sent = self.doctor('--profile', 's')
        self.assertEqual(rc, 1)
        self.assertIn(f'FIX   No profile file yet, and {words}', text)
        self.assertNotIn('lets in only you', text)
        if os.name == 'nt':                 # the fix it names, run as printed, lets a join save there (cmd)
            import re
            fix = re.search(r"Fix: `(icacls [^`]+)`", text).group(1)
            self.assertEqual(run_as_typed('cmd', fix).returncode, 0, fix)
            self.assertIsNone(home.new_file_refused(self.folder))
        self.assertEqual(os.listdir(self.folder), [], 'no probe file is left behind')

    def doctor(self, *argv):
        rc, out = Base.doctor(self, *argv)
        return rc, out, None


def shells():
    """The shells a Windows user types doctor's commands into: cmd, Windows PowerShell and PowerShell 7 (those found)."""
    import shutil
    return ['cmd'] + [ps for ps in ('powershell', 'pwsh') if shutil.which(ps)]


def run_as_typed(shell, command):
    """`command` run in `shell` exactly as printed: after cmd's /c, or as PowerShell's whole command text."""
    import base64
    import shutil
    if shell == 'cmd':
        return subprocess.run('cmd.exe /d /c ' + command, capture_output=True, timeout=120)
    return subprocess.run([shutil.which(shell), '-NoProfile', '-NonInteractive', '-EncodedCommand',
                           base64.b64encode(command.encode('utf-16-le')).decode('ascii')], capture_output=True, timeout=120)


@WINDOWS
class PrintedFixesRunInEveryShell(Base):
    """The RC's review, round 3 (windows-acl WIN2): the icacls command doctor prints to close a folder that lets others in
    did not run in Windows PowerShell, the default shell of Windows 11: it read the unquoted (OI) and (CI) as
    subexpressions ("The term 'OI' is not recognized"), so icacls never ran, the folder kept letting others in, and
    doctor printed the same FIX again. Each command doctor prints (folder_fix, file_fix, take_back) is run here exactly
    as printed, in cmd and in PowerShell, on a folder and a profile that let BUILTIN\\Users in."""

    def setUp(self):
        super().setUp()
        self.vhome = os.path.join(self.tmp.name, 'Ann Lee home')        # a space in the path, as a home folder has
        os.environ['VALUN_HOME'] = self.vhome

    @contextlib.contextmanager
    def shared_profiles(self, with_profile, inherit=True, own_on=None):
        """A profiles folder made beforehand (as by another tool) that inherits BUILTIN\\Users from its parent (unless
        not `inherit`), and with `with_profile` a profile 0.7.1 wrote in it (os.open 0o600: it inherits its folder's
        permissions); own_on 'folder' or 'file': BUILTIN\\Users granted on that one itself, an ACE of its own, not
        inherited. Yields its folder and its path, and removes them after."""
        folder = os.path.join(self.vhome, 'profiles')
        os.makedirs(folder)
        try:
            if inherit:
                subprocess.run(['icacls', self.vhome, '/grant', f'*{USERS}:(OI)(CI)M'], capture_output=True, check=True)
            path = os.path.join(folder, 's.json')
            if own_on == 'folder':
                subprocess.run(['icacls', folder, '/grant', f'*{USERS}:(OI)(CI)M'], capture_output=True, check=True)
            if with_profile:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump({'server': 'https://valun.example', 'participant_id': 'vp_0a0a0a0a0a0a', 'secret': 'ab' * 32,
                               'agent_token': 'vpa_TEST-ONLY', 'network': 'valun-testnet-1', 'approvals': 'none'}, f)
            if own_on == 'file':
                subprocess.run(['icacls', path, '/grant', f'*{USERS}:R'], capture_output=True, check=True)
            self.assertIn(USERS, home.others_with_access(path if with_profile else folder))
            yield folder, path
        finally:
            import shutil
            subprocess.run(['icacls', self.vhome, '/reset', '/t', '/c', '/q'], capture_output=True)
            shutil.rmtree(self.vhome)

    def test_a_folders_own_entry_for_others_is_removed_too(self):
        # windows-acl WIN3: /inheritance:r and /grant:r leave an ACE set on the folder itself for another account, so
        # the folder still let BUILTIN\Users in, and doctor printed the same FIX with the same command, in a loop
        for shell in shells():
            for inherit in (False, True):
                with self.subTest(shell=shell, inherit=inherit), \
                        self.shared_profiles(with_profile=False, inherit=inherit, own_on='folder') as (folder, path):
                    rc, out = self.doctor('--profile', 's')
                    self.assertIn(f'also lets in BUILTIN\\Users ({USERS}), whom its own permissions '
                                  + ('and its folder let in' if inherit else 'let in'), out)
                    self.run_fixes(shell, out)
                    self.assertEqual(home.others_with_access(folder), [], home._sddl_of(folder))
                    rc, out = self.doctor('--profile', 's')
                    self.assertNotIn('FIX   No profile file yet', out)
                    self.still_mine(folder)

    def test_a_profiles_own_entry_for_others_is_removed_too(self):
        # windows-acl WIN3: the profile's own ACE for another account stayed after both printed commands, until a save
        for shell in shells():
            for inherit, own_on in ((False, 'file'), (True, 'file'), (False, 'folder')):
                with self.subTest(shell=shell, inherit=inherit, own_on=own_on), \
                        self.shared_profiles(with_profile=True, inherit=inherit, own_on=own_on) as (folder, path):
                    rc, out = self.doctor('--profile', 's')
                    self.assertIn(f'FIX   {path} can also be opened by BUILTIN\\Users ({USERS})', out)
                    self.run_fixes(shell, out)
                    self.assertEqual(home.others_with_access(path), [], home._sddl_of(path))
                    self.assertEqual(home.others_with_access(folder), [], home._sddl_of(folder))
                    rc, out = self.doctor('--profile', 's')
                    self.assertIn('ok    Profile file permissions: private', out)
                    self.still_mine(folder)

    def fixes(self, out):
        """The commands between backquotes in doctor's FIX lines."""
        import re
        return [c for line in out.splitlines() if line.strip().startswith('FIX') for c in re.findall(r'`([^`]+)`', line)]

    def run_fixes(self, shell, out):
        commands = [c for c in self.fixes(out) if c.startswith('icacls')]
        self.assertTrue(commands, out)
        for c in commands:
            r = run_as_typed(shell, c)
            self.assertEqual(r.returncode, 0, (shell, c, r.stdout.decode('cp1252', 'replace'),
                                               r.stderr.decode('cp1252', 'replace')))

    def still_mine(self, folder):
        """This user can still list the folder and save a profile in it."""
        os.listdir(folder)
        store = vc.FileStore(os.path.join(folder, 'saved.json'))
        store.state['x'] = 1
        store.save()
        os.unlink(store.path)

    def test_the_folder_fix_closes_a_folder_that_inherits_others_in_every_shell(self):
        for shell in shells():
            with self.subTest(shell=shell), self.shared_profiles(with_profile=False) as (folder, path):
                rc, out = self.doctor('--profile', 's')
                self.assertIn('FIX   No profile file yet, and its folder', out)
                self.run_fixes(shell, out)
                self.assertEqual(home.others_with_access(folder), [], home._sddl_of(folder))
                rc, out = self.doctor('--profile', 's')
                self.assertIn(f'ok    Profile file permissions: no profile file yet (its folder {folder} lets in only you, '
                              'SYSTEM and Administrators)', out)
                self.still_mine(folder)

    def test_the_file_and_folder_fixes_close_a_profile_0_7_1_wrote_in_every_shell(self):
        for shell in shells():
            with self.subTest(shell=shell), self.shared_profiles(with_profile=True) as (folder, path):
                rc, out = self.doctor('--profile', 's')
                self.assertIn(f'FIX   {path} can also be opened by BUILTIN\\Users ({USERS}), whom its folder lets in', out)
                self.run_fixes(shell, out)
                self.assertEqual(home.others_with_access(path), [], home._sddl_of(path))
                self.assertEqual(home.others_with_access(folder), [], home._sddl_of(folder))
                rc, out = self.doctor('--profile', 's')
                self.assertIn('ok    Profile file permissions: private', out)
                with open(path, encoding='utf-8') as f:
                    self.assertEqual(json.load(f)['participant_id'], 'vp_0a0a0a0a0a0a')
                self.still_mine(folder)

    def test_take_back_runs_in_every_shell(self):
        # From an elevated shell in use; here on a file this user owns already, which shows the commands run as printed
        import re
        path = os.path.join(self.tmp.name, 'Ann Lee', 's.json')
        os.makedirs(os.path.dirname(path))
        cli._write_private(path, '{}')
        for shell in shells():
            with self.subTest(shell=shell):
                for c in re.findall(r'`([^`]+)`', home.take_back(path)):
                    r = run_as_typed(shell, c)
                    self.assertEqual(r.returncode, 0, (shell, c, r.stdout.decode('cp1252', 'replace')))
                with open(path, encoding='utf-8') as f:
                    self.assertEqual(f.read(), '{}')


if __name__ == '__main__':
    unittest.main()
