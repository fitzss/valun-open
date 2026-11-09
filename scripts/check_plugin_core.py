"""The Hermes plugin carries the `valun` package's core unchanged.

Compares every module of the plugin's valun_core/ (each valun_core/*.py except __init__.py: six files in plugin 0.3.0,
agent, basis, client, measure, sandbox and schemas; eight since 0.4.0, which adds novation and records) with the same
module of the `valun` package at the version valun_core declares: this working tree when its version is the same,
otherwise that release downloaded from PyPI. A file is unchanged when its bytes are equal, or equal once the import name
is read as one (valun_core and valun) on both sides, so a file that mentions valun_core in its own text, as novation.py
does, is not flagged. A module the package does not have differs. Usage: python scripts/check_plugin_core.py PLUGIN_DIR
"""
import pathlib
import re
import subprocess
import sys
import tempfile
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[1]


def version(init_text):
    return re.search(r"^__version__ = '([^']+)'", init_text, re.M).group(1)


def text(data):
    return data.decode('utf-8').replace('\r\n', '\n')


def same_module(plugin_bytes, package_bytes):
    """Byte for byte; else after normalising line ends and the import name, on both sides."""
    if package_bytes is None:
        return False
    if plugin_bytes == package_bytes:
        return True
    def norm(b):
        return text(b).replace('valun_core', 'valun')
    return norm(plugin_bytes) == norm(package_bytes)


def core_files(core):
    """The module names in valun_core/ (every *.py file but __init__.py), sorted."""
    return sorted(p.stem for p in core.glob('*.py') if p.name != '__init__.py')


def main(plugin_dir):
    core = pathlib.Path(plugin_dir) / 'valun_core'
    if not (core / '__init__.py').is_file():
        print(f'{plugin_dir} has no valun_core/__init__.py: not a Hermes plugin of version 0.3.0 or later')
        return 2
    files = core_files(core)
    if not files:
        print(f'{core} holds no module besides __init__.py')
        return 2
    want = version((core / '__init__.py').read_text(encoding='utf-8'))
    pkg = REPO / 'python' / 'src' / 'valun'
    if version((pkg / '__init__.py').read_text(encoding='utf-8')) == want:
        source = {f: ((pkg / f'{f}.py').read_bytes() if (pkg / f'{f}.py').is_file() else None) for f in files}
        ref = f'this repository (valun {want})'
    else:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([sys.executable, '-m', 'pip', 'download', '--no-deps', '--only-binary', ':all:', '-q',
                            '-d', tmp, f'valun=={want}'], check=True)
            wheel = next(pathlib.Path(tmp).glob('valun-*.whl'))
            with zipfile.ZipFile(wheel) as z:
                names = set(z.namelist())
                source = {f: (z.read(f'valun/{f}.py') if f'valun/{f}.py' in names else None) for f in files}
        ref = f'valun {want} from PyPI'
    differ = [f for f in files if not same_module((core / f'{f}.py').read_bytes(), source[f])]
    missing = [f for f in differ if source[f] is None]
    if differ:
        print(f"the plugin's valun_core differs from {ref}: {', '.join(differ)}"
              + (f" (not in the package: {', '.join(missing)})" if missing else ''))
        return 1
    print(f"the plugin's valun_core is {ref}, unchanged ({len(files)} files: {', '.join(files)})")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
