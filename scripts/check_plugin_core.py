"""The Hermes plugin carries the `valun` package's core unchanged.

Compares the plugin's valun_core/ files (agent, basis, client, measure, sandbox, schemas; import name aside) with the
`valun` package at the version valun_core declares: this working tree when its version is the same, otherwise that
release downloaded from PyPI. Usage: python scripts/check_plugin_core.py PLUGIN_DIR
"""
import pathlib
import re
import subprocess
import sys
import tempfile
import zipfile

FILES = ('agent', 'basis', 'client', 'measure', 'sandbox', 'schemas')
REPO = pathlib.Path(__file__).resolve().parents[1]


def version(init_text):
    return re.search(r"^__version__ = '([^']+)'", init_text, re.M).group(1)


def text(data):
    return data.decode('utf-8').replace('\r\n', '\n')


def main(plugin_dir):
    core = pathlib.Path(plugin_dir) / 'valun_core'
    want = version((core / '__init__.py').read_text(encoding='utf-8'))
    pkg = REPO / 'python' / 'src' / 'valun'
    if version((pkg / '__init__.py').read_text(encoding='utf-8')) == want:
        source, ref = {f: text((pkg / f'{f}.py').read_bytes()) for f in FILES}, f'this repository (valun {want})'
    else:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([sys.executable, '-m', 'pip', 'download', '--no-deps', '--only-binary', ':all:', '-q',
                            '-d', tmp, f'valun=={want}'], check=True)
            wheel = next(pathlib.Path(tmp).glob('valun-*.whl'))
            with zipfile.ZipFile(wheel) as z:
                source = {f: text(z.read(f'valun/{f}.py')) for f in FILES}
        ref = f'valun {want} from PyPI'
    differ = [f for f in FILES if text((core / f'{f}.py').read_bytes()).replace('valun_core', 'valun') != source[f]]
    if differ:
        print(f"the plugin's valun_core differs from {ref}: {', '.join(differ)}")
        return 1
    print(f"the plugin's valun_core is {ref}, unchanged ({len(FILES)} files)")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
