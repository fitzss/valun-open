"""Release helper for valun-open (see RELEASING.md). Standard library only; Python 3.9 or later.

  python scripts/release.py bump X.Y.Z [--dry-run]           every version this repository names, in one step
  python scripts/release.py fixtures [--python PY314]        regenerate the JS client's Python fixtures (CPython 3.14)
  python scripts/release.py vendor-plugin DIR [--plugin-version X.Y.Z]
                                                             copy the package's core into a Hermes plugin checkout
  python scripts/release.py pin-plugin SHA VERSION           point CI and the release workflow at a plugin commit
  python scripts/release.py check [--plugin-dir DIR] [--no-vectors]
                                                             the release workflow's gate, run here first

`bump` changes each file only where a version is named, and refuses if any is not where it is expected. `check` is
what the release workflow's verify job checks, plus the plugin pin and SKILL.md's client pins. Each exits non-zero
with what is wrong."""
import argparse
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]

# Where a release's version is named: (file, text with {v}, how many times: a number, or None for at least once).
SITES = [
    ('python/pyproject.toml', 'version = "{v}"', 1),
    ('python/src/valun/__init__.py', "__version__ = '{v}'", 1),
    ('js/package.json', '"version": "{v}"', 1),
    ('js/test/package.test.js', "assert.equal(pkg.version, '{v}')", 1),
    ('server.json', '"version": "{v}"', 2),
    ('plugins/valun/.claude-plugin/plugin.json', '"version": "{v}"', 1),
    ('plugins/valun/.claude-plugin/plugin.json', 'valun {v}', 1),
    ('plugins/valun/.mcp.json', 'valun=={v}', 1),
    ('plugins/valun/skills/valun/SKILL.md', 'valun=={v}', None),
    ('plugins/valun/skills/valun/SKILL.md', 'valun[ai]=={v}', None),
    ('examples/ai-seller/requirements.txt', 'valun[ai,ergo]=={v}', 1),
    ('js/README.md', '- Version `{v}`:', 1),
]
VERSION_RE = re.compile(r'^\d+\.\d+\.\d+$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')


def current_version(root=ROOT):
    m = re.search(r'^version = "([^"]+)"', (root / 'python/pyproject.toml').read_text(encoding='utf-8'), re.M)
    if not m:
        sys.exit('python/pyproject.toml names no version')
    return m.group(1)


def read(root, rel):
    return (root / rel).read_text(encoding='utf-8')


def write(root, rel, text):
    (root / rel).write_text(text, encoding='utf-8', newline='\n')


def site_problems(root, v):
    """Where a site does not name version v as expected (an empty list: every site does)."""
    out = []
    for rel, pat, want in SITES:
        text, needle = read(root, rel), pat.format(v=v)
        n = text.count(needle)
        if (want is None and n < 1) or (want is not None and n != want):
            out.append(f'{rel}: {needle!r} found {n} time(s), expected {want if want is not None else "at least 1"}')
    return out


def bump(new, root=ROOT, dry_run=False):
    if not VERSION_RE.match(new):
        sys.exit(f'{new!r} is not a version X.Y.Z')
    old = current_version(root)
    if old == new:
        sys.exit(f'the version is {old} already')
    bad = site_problems(root, old)
    if bad:
        sys.exit(f'not every site names the current version {old}; fix these first:\n  ' + '\n  '.join(bad))
    texts = {}
    for rel, pat, _want in SITES:
        texts[rel] = texts.get(rel, read(root, rel)).replace(pat.format(v=old), pat.format(v=new))
    changed = sorted(rel for rel, text in texts.items() if text != read(root, rel))
    if dry_run:
        print(f'dry run: {old} -> {new} would change {len(changed)} files:\n  ' + '\n  '.join(changed))
        return changed
    for rel in changed:
        write(root, rel, texts[rel])
    bad = site_problems(root, new)
    if bad:
        sys.exit('after the bump, some sites do not name the new version (fix by hand):\n  ' + '\n  '.join(bad))
    print(f'{old} -> {new}: {len(changed)} files changed:\n  ' + '\n  '.join(changed))
    print('next: the CHANGELOG entry (## ' + new + ' (date)), `release.py fixtures`, the tests, `release.py check`')
    return changed


def fixtures(python):
    r = subprocess.run([python, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.strip() != '3.14':
        sys.exit(f'{python} is not CPython 3.14 (it says {r.stdout.strip() or r.stderr.strip()!r}): CI regenerates the '
                 'fixtures with 3.14 and they must be the same; pass --python')
    r = subprocess.run([python, '-B', 'js/test/fixtures/generate_python_fixtures.py'], cwd=ROOT)
    if r.returncode != 0:
        sys.exit('the fixtures generator failed')


def vendor_plugin(plugin_dir, plugin_version=None, root=ROOT):
    plugin = pathlib.Path(plugin_dir).resolve()
    core = plugin / 'valun_core'
    if not (core / '__init__.py').is_file():
        sys.exit(f'{plugin} has no valun_core/__init__.py: not a Hermes plugin checkout')
    v, pkg = current_version(root), root / 'python/src/valun'
    modules = sorted(p.name for p in core.glob('*.py') if p.name != '__init__.py')
    missing = [m for m in modules if not (pkg / m).is_file()]
    if missing:
        sys.exit(f'the package has no {", ".join(missing)}: the plugin core and the package differ in their modules')
    for m in modules:
        shutil.copyfile(pkg / m, core / m)
    init = (core / '__init__.py').read_text(encoding='utf-8')
    init, n = re.subn(r"^__version__ = '[^']+'", f"__version__ = '{v}'", init, flags=re.M)
    if n != 1:
        sys.exit(f'{core / "__init__.py"} names no __version__')
    (core / '__init__.py').write_text(init, encoding='utf-8', newline='\n')
    print(f'valun_core: {len(modules)} modules of the package {v} ({", ".join(m[:-3] for m in modules)})')
    if plugin_version:
        if not VERSION_RE.match(plugin_version):
            sys.exit(f'{plugin_version!r} is not a version X.Y.Z')
        old = re.search(r'^version: (\S+)$', (plugin / 'plugin.yaml').read_text(encoding='utf-8'), re.M).group(1)
        dots = lambda s: s.replace('.', '\\.')  # noqa: E731  (the manifest test writes the version as a regex)
        core_old = re.search(r"valun_core\.__version__, '([^']+)'", (plugin / 'tests/test_manifest_040.py').read_text(encoding='utf-8'))
        edits = [('plugin.yaml', f'version: {old}\n', f'version: {plugin_version}\n'),
                 ('tests/test_manifest_040.py', f'^version: {dots(old)}$', f'^version: {dots(plugin_version)}$'),
                 ('tests/test_manifest_040.py', f"valun_core.__version__, '{core_old.group(1) if core_old else ''}'", f"valun_core.__version__, '{v}'"),
                 ('README.md', re.compile(r'the `valun` package \d+\.\d+\.\d+,'), f'the `valun` package {v},'),
                 ('README.md', re.compile(r'## Known limits \(\d+\.\d+\.\d+\)'), f'## Known limits ({plugin_version})')]
        for rel, a, b in edits:
            path = plugin / rel
            text = path.read_text(encoding='utf-8')
            new = a.sub(b, text) if isinstance(a, re.Pattern) else text.replace(a, b)
            if new == text and (a.pattern if isinstance(a, re.Pattern) else a) and b not in text:
                print(f'note: {rel}: {getattr(a, "pattern", a)!r} not found (edit it by hand)')
            path.write_text(new, encoding='utf-8', newline='\n')
        print(f'plugin {old} -> {plugin_version} (plugin.yaml, its manifest test, README); next: its CHANGELOG entry and tests')
    r = subprocess.run([sys.executable, '-B', str(root / 'scripts/check_plugin_core.py'), str(plugin)], capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip())
    if r.returncode != 0:
        sys.exit(1)


def pin_plugin(sha, version, core=None, root=ROOT):
    if not SHA_RE.match(sha):
        sys.exit(f'{sha!r} is not a full commit sha (40 hex)')
    core = core or version
    ci, rel = '.github/workflows/ci.yml', '.github/workflows/release.yml'
    rtext = read(root, rel)
    m = re.search(r'^  PLUGIN_SHA: ([0-9a-f]{40})$', rtext, re.M)
    if not m:
        sys.exit(f'{rel} names no PLUGIN_SHA')
    old_sha = m.group(1)
    ctext = read(root, ci)
    m = re.search(rf'ref: {old_sha} +# plugin (\S+)', ctext)
    if not m:
        sys.exit(f'{ci} does not pin {old_sha} (the PLUGIN_SHA of {rel}): fix the two by hand')
    old_v = m.group(1)
    old_core = (re.search(r'whose valun_core is valun (\S+?)\.?$', ctext, re.M) or [None, old_v])[1]
    for f, text in ((ci, ctext), (rel, rtext)):
        text = text.replace(old_sha, sha).replace(f'Hermes plugin {old_v}', f'Hermes plugin {version}') \
                   .replace(f'# plugin {old_v}', f'# plugin {version}').replace(f'The plugin {old_v} carries', f'The plugin {version} carries') \
                   .replace(f'whose valun_core is valun {old_core}', f'whose valun_core is valun {core}')
        write(root, f, text)
    print(f'CI and the release workflow pin the plugin {version} ({sha[:7]}; was {old_v}, {old_sha[:7]})')


def check(version=None, plugin_dir=None, vectors=True, root=ROOT):
    v = version or current_version(root)
    problems = []
    import json
    js = json.loads(read(root, 'js/package.json'))['version']
    server = json.loads(read(root, 'server.json'))
    found = {'python/pyproject.toml': current_version(root), 'js/package.json': js, 'server.json': server['version'],
             'server.json packages[0]': server['packages'][0]['version']}
    problems += [f'{k} is {x}, not {v}' for k, x in found.items() if x != v]
    problems += site_problems(root, v)
    heads = [line for line in read(root, 'CHANGELOG.md').splitlines() if line.startswith(f'## {v} ')]
    if not heads:
        problems.append(f'CHANGELOG.md has no "## {v} (date)" heading')
    elif 'unreleased' in heads[0].lower():
        problems.append(f'CHANGELOG.md still marks {v} unreleased')
    for rel in ('js/README.md', 'python/README.md'):
        for n, line in enumerate(read(root, rel).splitlines(), 1):
            if re.search(r'unreleased|not published|not released', line, re.I):
                problems.append(f'{rel}:{n} calls a version unreleased (npm and PyPI keep these files for good)')
    rtext, ctext = read(root, '.github/workflows/release.yml'), read(root, '.github/workflows/ci.yml')
    m = re.search(r'^  PLUGIN_SHA: ([0-9a-f]{40})$', rtext, re.M)
    if not m or f'ref: {m.group(1)}' not in ctext:
        problems.append('PLUGIN_SHA in release.yml is not the plugin pin of ci.yml')
    skill = read(root, 'SKILL.md')
    other = sorted(set(re.findall(r'valun(?:\[[a-z,]+\])?==(\d+\.\d+\.\d+)', skill)) - {v})
    if f'valun=={v}' not in skill or other:
        problems.append(f'SKILL.md (the server\'s skill, published from valun-app) should pin valun=={v}; it pins '
                        f'{", ".join(other) or "nothing of " + v}: update the skill in valun-app and publish it')
    marker = root / 'server/.synced-from'
    print(f'version {v}; server/ synced from valun-app {marker.read_text(encoding="utf-8").strip()[:7] if marker.is_file() else "(no marker)"}')
    if vectors:
        runs = [['--client', 'package', '--require', 'circulation/1']]
        if plugin_dir:
            runs.append(['--client', 'plugin', '--plugin-dir', str(plugin_dir), '--require', 'circulation/1'])
        for args in runs:
            r = subprocess.run([sys.executable, '-B', 'spec/vectors/check_python.py', *args], cwd=root, capture_output=True, text=True)
            last = (r.stdout.strip().splitlines() or [''])[-1]
            print(last)
            if r.returncode != 0 or ' 0 disagreements in failing tiers' not in last:
                problems.append(f'vectors ({args[1]}): {last or r.stderr.strip()[:300]}')
        if plugin_dir:
            r = subprocess.run([sys.executable, '-B', 'scripts/check_plugin_core.py', str(plugin_dir)], cwd=root, capture_output=True, text=True)
            print(r.stdout.strip() or r.stderr.strip())
            if r.returncode != 0:
                problems.append('the plugin\'s valun_core differs from the package')
    if problems:
        print('NOT ready:\n  ' + '\n  '.join(problems))
        return 1
    print(f'ready: tag v{v} on a commit whose CI is green')
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog='release.py', description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    b = sub.add_parser('bump'); b.add_argument('version'); b.add_argument('--dry-run', action='store_true')
    f = sub.add_parser('fixtures'); f.add_argument('--python', default='python3.14')
    p = sub.add_parser('vendor-plugin'); p.add_argument('plugin_dir'); p.add_argument('--plugin-version')
    q = sub.add_parser('pin-plugin'); q.add_argument('sha'); q.add_argument('version'); q.add_argument('--core')
    c = sub.add_parser('check'); c.add_argument('--version'); c.add_argument('--plugin-dir'); c.add_argument('--no-vectors', action='store_true')
    a = ap.parse_args(argv)
    if a.cmd == 'bump':
        bump(a.version, dry_run=a.dry_run)
    elif a.cmd == 'fixtures':
        fixtures(a.python)
    elif a.cmd == 'vendor-plugin':
        vendor_plugin(a.plugin_dir, a.plugin_version)
    elif a.cmd == 'pin-plugin':
        pin_plugin(a.sha, a.version, a.core)
    else:
        return check(a.version, a.plugin_dir, vectors=not a.no_vectors)
    return 0


if __name__ == '__main__':
    sys.exit(main())
