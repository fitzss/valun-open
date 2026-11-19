"""`valun call TOOL --json-file PATH`, and `-` for standard input (fix inbox #165), against the offline World of
test_agent_circulation (the fake server the CLI tests use).

Fitz's laptop Codex agent, the first-time Windows run of 2026-11-19 (win-first-261118-0052): "the first instruction that
failed was the published PowerShell JSON quoting through this launcher; passing arguments through Python worked."
valun 0.7.1 took a tool's JSON only as a command-line argument. Windows PowerShell 5.1 drops its inner double quotes
('{"deal_id": "X"}' reaches valun as {deal_id: X}), and a launcher that runs the agent's command inside another
`powershell -Command` drops them from any JSON on that command line, whatever escapes it carries (skill.md's `--%` form
included). Now the JSON can come from a file or from standard input, where no shell parses it; the JSON argument is
unchanged.

On Windows, ShellForms runs the documented lines (DOCUMENTED, as python/README.md gives them) through Windows PowerShell
5.1, cmd, PowerShell running the command in another `powershell -Command`, and a launcher that starts `powershell.exe
-Command` itself, and checks what the World received."""
import base64
import codecs
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'src'))
sys.path.insert(0, HERE)
from test_cli_tour import Cli  # noqa: E402

# An offer whose text holds what shells read: both quotes, a backslash, cmd's & | < > ^ % !, PowerShell's $ and `, a
# newline (a JSON escape), and characters that no one Windows code page has (é and 名前).
TRICKY = {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 'text-stats',
          'description': 'it\'s "quoted" & | < > ^ % ! $HOME `t C:\\Users\\Ann café 名前\nsecond line',
          'deliverable': 'the exact text-stats result as JSON', 'price': 1}
# What cmd's echo writes as it is: no %, no escaped quote (a \" leaves cmd's own quotes unbalanced), ASCII only; its
# newline is JSON's \n escape, which no shell reads.
PLAIN = {'counterparty': 'sandbox-exact', 'role': 'payer', 'title': 'text-stats',
         'description': 'Count the words & lines of <this> | that ^ text (twice).\nTEXT: one two three',
         'deliverable': 'the exact text-stats result as JSON', 'price': 1}
SERVICE = ('title', 'description', 'deliverable')

# The lines the docs give (python/README.md; skill.md and /start with the release), for TOOL and its JSON: in
# PowerShell, a single-quoted here-string, which PowerShell takes as written (its '@ must start a line); in cmd, an echo
# into the file; and, for an agent that writes the file with its own file tool, the valun line alone, with no quote for
# any shell or launcher to change.
DOCUMENTED = {
    'powershell': "@'\n{json}\n'@ | Set-Content -Encoding utf8 args.json\nvalun call {tool} --json-file args.json",
    'cmd': '> args.json echo {json}\nvalun call {tool} --json-file args.json',
    'file tool': 'valun call {tool} --json-file args.json',
}
DEAL_JSON = '{"deal_id": "DEAL-ID"}'


def service(args):
    return {k: args[k] for k in SERVICE}


class CallArguments(Cli):
    """In process: where the arguments come from, how a file's bytes are read, and what is refused before anything is
    read from the server or signed."""

    def setUp(self):
        super().setUp()
        self.join()
        self.path = os.path.join(self.home.name, 'args.json')

    def sent(self):
        return [b['terms']['service'] for m, p, b in self.world.log if m == 'POST' and p == '/pilot/v1/deals']

    def write(self, data):
        with open(self.path, 'wb') as f:
            f.write(data)

    def test_a_file_in_utf8_or_as_powershell_writes_it(self):
        text = json.dumps(TRICKY, ensure_ascii=False)
        cases = [('UTF-8', text.encode('utf-8')),
                 ('UTF-8 with a BOM (Set-Content -Encoding utf8 in Windows PowerShell 5.1)', codecs.BOM_UTF8 + text.encode('utf-8')),
                 ("UTF-16 with a BOM (5.1's > and Out-File)", text.encode('utf-16')),
                 ('UTF-16 BE with a BOM', codecs.BOM_UTF16_BE + text.encode('utf-16-be')),
                 ('UTF-32 with a BOM', text.encode('utf-32')),
                 ('CRLF and a line after it, as echo and Set-Content end it', (text + '\r\n').encode('utf-8'))]
        for n, (what, data) in enumerate(cases, 1):
            self.write(data)
            rc, out = self.run_cli('call', 'valun_propose', '--json-file', self.path)
            self.assertEqual(rc, 0, (what, out))
            self.assertEqual(json.loads(out)['status'], 'open', what)
            self.assertEqual(len(self.sent()), n, what)
            self.assertEqual(self.sent()[-1], service(TRICKY), what)

    def test_standard_input_as_the_json_or_as_the_file(self):
        data = codecs.BOM_UTF8 + json.dumps(TRICKY, ensure_ascii=False).encode('utf-8') + b'\r\n'
        for argv in (['-'], ['--json-file', '-']):
            # a pipe on Windows reads in the ANSI code page: the bytes are read as they came, not through it
            stdin = io.TextIOWrapper(io.BytesIO(data), encoding='cp1252')
            with mock.patch.object(sys, 'stdin', stdin):
                rc, out = self.run_cli('call', 'valun_propose', *argv)
            self.assertEqual(rc, 0, (argv, out))
            self.assertEqual(self.sent()[-1], service(TRICKY), argv)
        rc, out = self.run_cli('call', 'valun_propose', '-', stdin=json.dumps(PLAIN))     # a text stream (no buffer)
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.sent()[-1], service(PLAIN))

    def test_the_json_argument_is_as_before(self):
        rc, out = self.run_cli('call', 'valun_propose', json.dumps(TRICKY))
        self.assertEqual(rc, 0, out)
        self.assertEqual(self.sent(), [service(TRICKY)])
        for argv in ([], ['{}'], ['']):
            rc, out = self.run_cli('call', 'valun_status', *argv)
            self.assertEqual(rc, 0, (argv, out))
            self.assertIs(json.loads(out)['connected'], True, argv)

    def refused(self, *argv, stdin=None):
        before = len(self.world.log)
        rc, out = self.run_cli('call', 'valun_propose', *argv, stdin=stdin)
        self.assertEqual(rc, 2, out)
        answer = json.loads(out)
        self.assertEqual(answer['error'], 'bad_arguments', out)
        self.assertEqual(len(self.world.log), before, 'nothing was read from the server or sent')
        return answer['message']

    def test_what_is_refused_before_anything_is_sent(self):
        self.write(json.dumps(PLAIN).encode('utf-8'))
        self.assertIn('give the arguments one way', self.refused('{}', '--json-file', self.path))
        self.assertIn('give the arguments one way', self.refused('-', '--json-file', self.path))
        missing = os.path.join(self.home.name, 'no-such.json')
        self.assertIn(f'the arguments file {missing} cannot be read', self.refused('--json-file', missing))
        self.assertIn('cannot be read', self.refused('--json-file', self.home.name), 'a folder')
        # Set-Content without -Encoding in Windows PowerShell 5.1 writes the ANSI code page: never guessed
        self.write('{"counterparty": "sandbox-exact", "description": "café"}'.encode('cp1252'))
        why = self.refused('--json-file', self.path)
        self.assertIn(f'{self.path} is not UTF-8 text: save it as UTF-8 (in PowerShell, Set-Content -Encoding utf8)', why)
        self.assertIn('Nothing was sent.', why)
        for empty in (b'', b'\r\n', codecs.BOM_UTF8):
            self.write(empty)
            self.assertIn(f'{self.path} holds no JSON', self.refused('--json-file', self.path), empty)
        self.assertIn('standard input holds no JSON', self.refused('-', stdin=''))
        with mock.patch.object(sys, 'stdin', None):        # no standard input at all (a closed descriptor)
            self.assertIn('standard input holds no JSON', self.refused('--json-file', '-'))
        self.write(b'{deal_id: DEAL-ID}')
        self.assertEqual(self.refused('--json-file', self.path),
                         'arguments must be a JSON object: Expecting property name enclosed in double quotes: line 1 '
                         f'column 2 (char 1) (in {self.path})')

    def test_json_whose_quotes_a_shell_dropped_names_the_file_form(self):
        why = self.refused('{deal_id: DEAL-ID}')            # '{"deal_id": "DEAL-ID"}' as Windows PowerShell 5.1 passes it
        self.assertIn('If your shell changed the quotes (Windows PowerShell 5.1 drops the inner ones', why)
        self.assertIn('write the JSON to a file and run `valun --profile s call valun_propose --json-file FILE` instead.', why)
        # a value with spaces: 5.1 drops the quotes and splits the JSON there, which argparse called "unrecognized
        # arguments" after its usage, on stderr
        split = ['{counterparty:', 'sandbox-exact,', 'description:', 'Count', 'the', 'words}']
        why = self.refused(*split)
        self.assertTrue(why.startswith('arguments must be one JSON object, and more came after it: sandbox-exact, '
                                       'description: Count the words}. If your shell changed the quotes'), why)
        self.assertTrue(why.endswith('--json-file FILE` instead. Nothing was sent.'), why)
        # any other command, or a call whose argument is no JSON split: argparse's answer, as before
        for argv in (['status', 'extra'], ['call', 'valun_status', 'not-json', 'extra']):
            err = io.StringIO()
            with mock.patch.object(sys, 'stderr', err), self.assertRaises(SystemExit) as stop:
                self.run_cli(*argv)
            self.assertEqual(stop.exception.code, 2, argv)
            self.assertIn('error: unrecognized arguments: extra', err.getvalue(), argv)

    def test_with_approvals_ask_a_file_keeps_the_question_and_standard_input_cannot(self):
        rc, out = self.run_cli('config', 'approvals', 'ask')
        self.assertEqual(rc, 0, out)
        self.write(json.dumps(PLAIN).encode('utf-8'))
        err = io.StringIO()
        with mock.patch.object(sys, 'stderr', err):
            rc, out = self.run_cli('call', 'valun_propose', '--json-file', self.path, tty=True, answers=['n'])
        self.assertEqual((rc, json.loads(out)['error']), (3, 'owner_declined'), out)
        self.assertIn('Count the words & lines', err.getvalue(), 'the terminal was shown the offer read from the file')
        self.assertEqual(self.sent(), [])
        # the arguments on standard input: the answer would be read from there too, so nothing is asked or signed
        for tty in (False, True):
            err = io.StringIO()
            with mock.patch.object(sys, 'stderr', err):
                rc, out = self.run_cli('call', 'valun_propose', '-', stdin=json.dumps(PLAIN), tty=tty, answers=['y'])
            answer = json.loads(out)
            self.assertEqual((rc, answer['error']), (3, 'approval_unavailable'), out)
            self.assertIn('the arguments came from standard input, where the answer would be read, so this terminal '
                          'cannot ask (pass them with --json-file FILE to be asked here)', answer['message'])
            self.assertEqual(self.sent(), [], tty)
            # typed at a terminal: how to end them is said on stderr, never on stdout (the JSON answer)
            self.assertEqual('Ctrl+Z then Enter on Windows' in err.getvalue(), tty, err.getvalue())


# A child for each `valun ...` line the shells run: `valun` there is this Python running BOOT, which joins a new profile
# on its own World (approvals none), then runs cli.main with the arguments the shell passed, and appends what the World
# received to the report.
BOOT = r'''
import contextlib, io, json, os, sys, tempfile
sys.path.insert(0, {tests!r})
sys.path.insert(0, {src!r})
home = tempfile.mkdtemp(dir={homes!r})
os.environ.update(VALUN_HOME=home, HOME=home, USERPROFILE=home)
from unittest import mock
from test_agent_circulation import CIRC, SERVER, World, routed
from valun import cli, client as vc
world = World(CIRC, s_key=None)
routed(world).start()
mock.patch.object(vc, 'ENROLL_RETRY_S', (0, 0)).start()
with contextlib.redirect_stdout(io.StringIO()):
    joined = cli.main(['--profile', 's', 'join', '--sandbox', '--handle', 'stranger', '--operator', 'Ann', '--approvals',
                       'none', '--server', SERVER, '--owner-token-file', os.path.join(home, 'owner.txt')])
out = io.StringIO()
with contextlib.redirect_stdout(out):
    rc = cli.main(['--profile', 's', *sys.argv[1:]])
sent = [b['terms']['service'] for m, p, b in world.log if m == 'POST' and p == '/pilot/v1/deals']
with open({report!r}, 'a', encoding='utf-8') as f:
    f.write(json.dumps({{'argv': sys.argv[1:], 'joined': joined, 'rc': rc, 'out': out.getvalue(), 'sent': sent}}) + chr(10))
'''


@unittest.skipUnless(os.name == 'nt' and shutil.which('powershell.exe') and shutil.which('cmd.exe'),
                     'Windows PowerShell 5.1 and cmd')
class ShellForms(unittest.TestCase):
    """The documented lines, run by the shells themselves: Windows PowerShell 5.1 (the lines as typed at its prompt:
    -EncodedCommand, which hands it the text as it is), cmd (a batch file of the lines), PowerShell running the line in
    another `powershell -Command '...'` (a launcher inside PowerShell, as Codex's runs an agent's command), and a
    launcher that starts `powershell.exe -Command SCRIPT` itself (the script quoted for the C runtime, as
    CreateProcess-based launchers do). `valun` in each line is this Python running BOOT."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.homes = os.path.join(self.tmp.name, 'homes')
        os.makedirs(self.homes)
        self.report = os.path.join(self.tmp.name, 'report.jsonl')
        self.boot = os.path.join(self.tmp.name, 'boot.py')
        with open(self.boot, 'w', encoding='utf-8') as f:
            f.write(BOOT.format(tests=HERE, src=os.path.join(os.path.dirname(HERE), 'src'), homes=self.homes,
                                report=self.report))
        self.cwd = os.path.join(self.tmp.name, 'work')
        os.makedirs(self.cwd)
        self.env = {k: v for k, v in os.environ.items() if not k.upper().startswith(('VALUN_', 'PYTHON'))}
        self.err = []

    def lines(self, form, args, tool='valun_propose'):
        return DOCUMENTED[form].format(json=json.dumps(args, ensure_ascii=False), tool=tool)

    @staticmethod
    def started_by(text, run):
        """The lines with each `valun ...` command (at a line's start, or after a pipe) started by `run` instead."""
        return re.sub(r'(^|\| )valun ', lambda m: m.group(1) + run, text, flags=re.M)

    def ps_lines(self, text):
        """The lines with `valun` as PowerShell would start this Python running BOOT."""
        return self.started_by(text, "& '{}' '{}' ".format(sys.executable.replace("'", "''"), self.boot.replace("'", "''")))

    def shell(self, argv, what):
        p = subprocess.run(argv, cwd=self.cwd, env=self.env, stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
        err = p.stderr.decode('utf-8', 'replace')
        self.err.append(err)
        self.assertEqual(p.returncode, 0, f'{what}: {p.stdout!r} {err[-2000:]}')
        return p

    def powershell(self, script):
        """Windows PowerShell 5.1, given the script as it is (-EncodedCommand: UTF-16LE, base64)."""
        return self.shell(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                           base64.b64encode(script.encode('utf-16-le')).decode('ascii')], 'powershell')

    def reports(self, count):
        """What each of the `count` valun lines run so far reported (a child that ended in a traceback reports nothing:
        its shell's stderr is shown)."""
        with open(self.report, encoding='utf-8') if os.path.exists(self.report) else io.StringIO() as f:
            got = [json.loads(x) for x in f]
        self.assertEqual(len(got), count, ''.join(self.err)[-3000:])
        return got

    def agent_file(self, args):
        """args.json as an agent's file tool writes it: UTF-8, no BOM."""
        with open(os.path.join(self.cwd, 'args.json'), 'w', encoding='utf-8', newline='') as f:
            json.dump(args, f, ensure_ascii=False)

    def assertSent(self, report, args):
        self.assertEqual((report['joined'], report['rc']), (0, 0), report)
        self.assertEqual(report['sent'], [service(args)], report)

    def test_windows_powershell_5_1(self):
        pipe = self.ps_lines("'" + json.dumps(PLAIN) + "' | valun call valun_propose -")
        old = [self.ps_lines(f"valun call {tool} '{text}'")               # 0.7.1's form, the JSON as an argument
               for tool, text in (('valun_deal', DEAL_JSON), ('valun_propose', json.dumps(PLAIN)))]
        p = self.powershell('\n'.join([self.ps_lines(self.lines('powershell', TRICKY)), pipe, *old,
                                       '$PSVersionTable.PSVersion.Major']))
        self.assertEqual(p.stdout.decode('ascii', 'replace').split()[-1], '5', 'Windows PowerShell 5.1')
        here, piped, dropped, split = self.reports(4)
        self.assertEqual(here['argv'], ['call', 'valun_propose', '--json-file', 'args.json'])
        self.assertSent(here, TRICKY)
        self.assertEqual(piped['argv'], ['call', 'valun_propose', '-'])
        self.assertSent(piped, PLAIN)
        # the JSON argument, as before: 5.1 dropped its inner quotes (and split it at the spaces of a value), and the
        # answer names the file form
        self.assertEqual(dropped['argv'], ['call', 'valun_deal', '{deal_id: DEAL-ID}'])
        self.assertGreater(len(split['argv']), 3, split)
        for before in (dropped, split):
            self.assertEqual((before['rc'], before['sent']), (2, []), before)
            self.assertIn('--json-file FILE` instead', json.loads(before['out'])['message'])

    def test_cmd(self):
        run = f'"{sys.executable}" "{self.boot}" '
        bat = os.path.join(self.tmp.name, 'lines.cmd')
        for text in (self.lines('cmd', PLAIN), DOCUMENTED['file tool'].format(tool='valun_propose')):
            with open(bat, 'w', encoding='ascii', newline='\r\n') as f:
                f.write('@echo off\n' + self.started_by(text, run) + '\n')
            if text.startswith('valun '):       # the agent's own file, with every character: the valun line alone
                self.agent_file(TRICKY)
            self.shell(['cmd.exe', '/d', '/c', bat], text)
        echoed, own = self.reports(2)
        self.assertSent(echoed, PLAIN)
        self.assertSent(own, TRICKY)

    def test_powershell_running_it_in_another_powershell_command(self):
        """A launcher inside PowerShell: `powershell -Command '<the agent's line>'`. Any JSON on that line loses its
        double quotes there, whatever escapes it carries; the file tool's line has none to lose."""
        self.agent_file(TRICKY)
        line = self.ps_lines(DOCUMENTED['file tool'].format(tool='valun_propose'))
        self.powershell("powershell -NoProfile -NonInteractive -Command '" + line.replace("'", "''") + "'")
        (nested,) = self.reports(1)
        self.assertEqual(nested['argv'], ['call', 'valun_propose', '--json-file', 'args.json'])
        self.assertSent(nested, TRICKY)

    def test_a_launcher_that_starts_powershell_command_itself(self):
        """A launcher that starts `powershell.exe -Command SCRIPT` with the script as one argument, quoted for the C
        runtime (CreateProcess; subprocess here): the PowerShell lines as documented, here-string and all."""
        self.shell(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                  self.ps_lines(self.lines('powershell', TRICKY))], 'powershell -Command')
        (launched,) = self.reports(1)
        self.assertSent(launched, TRICKY)


class TheDocsGiveTheseLines(unittest.TestCase):
    def test_python_readme(self):
        with open(os.path.join(os.path.dirname(HERE), 'README.md'), encoding='utf-8') as f:
            readme = f.read()
        for form in ('powershell', 'cmd'):
            self.assertIn('```\n' + DOCUMENTED[form].format(json=DEAL_JSON, tool='valun_deal') + '\n```', readme, form)
        self.assertIn('`valun call TOOL --json-file args.json`', readme)


if __name__ == '__main__':
    unittest.main()
