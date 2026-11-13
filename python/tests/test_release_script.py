"""scripts/release.py: every site that names the version names the same one; a bump changes them all and nothing
else; a plugin pin moves in CI and the release workflow together; the core is copied into a plugin checkout."""
import importlib.util
import pathlib
import shutil
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts' / 'release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def copy_tree(files):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='valun-release-test-'))
    for rel in files:
        (tmp / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, tmp / rel)
    return tmp


class Release(unittest.TestCase):
    def test_every_site_names_the_current_version(self):
        self.assertEqual(release.site_problems(ROOT, release.current_version()), [])

    def test_a_bump_changes_every_site_and_refuses_a_site_out_of_place(self):
        tmp = copy_tree(sorted({rel for rel, _p, _n in release.SITES}))
        try:
            old = release.current_version(tmp)
            with self.assertRaises(SystemExit):
                release.bump(old, root=tmp)                      # the same version
            changed = release.bump('9.9.9', root=tmp)
            self.assertEqual(len(changed), len({rel for rel, _p, _n in release.SITES}))
            self.assertEqual(release.site_problems(tmp, '9.9.9'), [])
            self.assertTrue(release.site_problems(tmp, old), 'no site names the old version any more')
            req = tmp / 'examples/ai-seller/requirements.txt'
            req.write_text('valun[ai,ergo]==1.0.0\n', encoding='utf-8')
            with self.assertRaises(SystemExit):
                release.bump('9.9.10', root=tmp)                 # a site that does not name 9.9.9
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_a_plugin_pin_moves_in_ci_and_the_release_workflow_together(self):
        tmp = copy_tree(['.github/workflows/ci.yml', '.github/workflows/release.yml'])
        try:
            ci = (tmp / '.github/workflows/ci.yml').read_text(encoding='utf-8')
            old = release.re.search(r'^  PLUGIN_SHA: ([0-9a-f]{40})$', (tmp / '.github/workflows/release.yml').read_text(encoding='utf-8'), release.re.M).group(1)
            others = [s for s in release.re.findall(r'ref: ([0-9a-f]{40})', ci) if s != old]
            release.pin_plugin('ab' * 20, '9.9.9', root=tmp)
            for f in ('ci.yml', 'release.yml'):
                text = (tmp / '.github/workflows' / f).read_text(encoding='utf-8')
                self.assertIn('ab' * 20, text)
                self.assertNotIn(old, text)
                self.assertIn('Hermes plugin 9.9.9', text)
            ci = (tmp / '.github/workflows/ci.yml').read_text(encoding='utf-8')
            for s in others:
                self.assertIn(s, ci, 'the other plugin pins (the catalog\'s older one) stay')
            self.assertIn('whose valun_core is valun 9.9.9', ci)
            with self.assertRaises(SystemExit):
                release.pin_plugin('not-a-sha', '9.9.9', root=tmp)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_core_is_copied_into_a_plugin_checkout(self):
        plugin = pathlib.Path(tempfile.mkdtemp(prefix='valun-plugin-test-'))
        try:
            v = release.current_version()
            (plugin / 'valun_core').mkdir()
            (plugin / 'tests').mkdir()
            (plugin / 'valun_core/__init__.py').write_text("__version__ = '0.0.1'\n", encoding='utf-8')
            (plugin / 'valun_core/basis.py').write_text('# an old copy\n', encoding='utf-8')
            (plugin / 'plugin.yaml').write_text('name: valun\nversion: 0.0.1\n', encoding='utf-8')
            (plugin / 'tests/test_manifest_040.py').write_text("r'(?m)^version: 0\\.0\\.1$'\nvalun_core.__version__, '0.0.1'\n", encoding='utf-8')
            (plugin / 'README.md').write_text('the `valun` package 0.0.1, copied\n## Known limits (0.0.1)\n', encoding='utf-8')
            release.vendor_plugin(plugin, plugin_version='9.9.9')
            self.assertEqual((plugin / 'valun_core/basis.py').read_bytes(), (ROOT / 'python/src/valun/basis.py').read_bytes())
            self.assertIn(f"__version__ = '{v}'", (plugin / 'valun_core/__init__.py').read_text(encoding='utf-8'))
            self.assertIn('version: 9.9.9\n', (plugin / 'plugin.yaml').read_text(encoding='utf-8'))
            manifest = (plugin / 'tests/test_manifest_040.py').read_text(encoding='utf-8')
            self.assertIn("^version: 9\\.9\\.9$", manifest)
            self.assertIn(f"valun_core.__version__, '{v}'", manifest)
            readme = (plugin / 'README.md').read_text(encoding='utf-8')
            self.assertIn(f'the `valun` package {v},', readme)
            self.assertIn('## Known limits (9.9.9)', readme)
        finally:
            shutil.rmtree(plugin, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
