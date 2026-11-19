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

    def test_the_docs_pin_the_release_and_a_pin_of_another_version_is_named(self):
        """README.md and docs/GETTING-STARTED.md give commands pinned to the release: a bump moves every pin (SITES),
        and check() names a document with a pin of another version, extras included (the onboarding review)."""
        v = release.current_version()
        self.assertEqual(release.doc_pin_problems(ROOT, v), [])
        for rel in release.PINNED_DOCS:
            self.assertIn(rel, {r for r, _p, _n in release.SITES})
        tmp = copy_tree(list(release.PINNED_DOCS))
        try:
            guide = tmp / 'docs/GETTING-STARTED.md'
            guide.write_text(guide.read_text(encoding='utf-8') + '\n`uvx --from "valun[ergo]==0.6.0" valun`\n',
                             encoding='utf-8')
            self.assertEqual(release.doc_pin_problems(tmp, v),
                             [f'docs/GETTING-STARTED.md pins valun 0.6.0, not {v}: every pin there names the release'])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_readme_names_the_release_its_commands_run_and_a_stale_one_is_a_problem(self):
        """README.md's "Every command here runs valun X.Y.Z with uvx" names the release in words, above the pins: a bump
        moves it with them, and check() refuses it when it names another version (the onboarding review: after a bump
        it still named the release before, and check passed)."""
        v = release.current_version()
        words = 'Every command here runs valun {v} with'
        self.assertIn(words.format(v=v), (ROOT / 'README.md').read_text(encoding='utf-8'))
        tmp = copy_tree(sorted({rel for rel, _p, _n in release.SITES}))
        try:
            readme = tmp / 'README.md'
            readme.write_text(readme.read_text(encoding='utf-8').replace(words.format(v=v), words.format(v='0.6.0')),
                              encoding='utf-8')
            self.assertEqual(release.site_problems(tmp, v),
                             [f'README.md: {words.format(v=v)!r} found 0 time(s), expected 1'])
            readme.write_text(readme.read_text(encoding='utf-8').replace(words.format(v='0.6.0'), words.format(v=v)),
                              encoding='utf-8')
            release.bump('9.9.9', root=tmp)
            self.assertIn(words.format(v='9.9.9'), readme.read_text(encoding='utf-8'))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_marketplace_entry_names_no_version(self):
        """The Claude Code marketplace (.claude-plugin/marketplace.json) describes the plugin without a version, so no
        release has to move it: it is not a site, and it said "valun 0.4.5" from 0.4.5 to 0.7.1 (the onboarding
        review). The plugin's own manifest names the release, and is a site."""
        self.assertNotRegex((ROOT / '.claude-plugin/marketplace.json').read_text(encoding='utf-8'), r'\d+\.\d+\.\d+')
        self.assertIn(('plugins/valun/.claude-plugin/plugin.json', 'valun {v}', 1), release.SITES)

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
