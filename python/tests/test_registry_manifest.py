"""server.json (the MCP Registry entry) agrees with the package: name marker in the PyPI README, versions, command."""
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def read(*parts):
    with open(os.path.join(REPO, *parts), encoding='utf-8') as f:
        return f.read()


class RegistryManifest(unittest.TestCase):
    def setUp(self):
        self.server = json.loads(read('server.json'))
        self.version = re.search(r'^version = "([^"]+)"', read('python', 'pyproject.toml'), re.M).group(1)

    def test_versions_match_the_package(self):
        from valun import __version__
        self.assertEqual(self.server['version'], self.version)
        self.assertEqual(self.server['packages'][0]['version'], self.version)
        self.assertEqual(__version__, self.version)

    def test_pypi_ownership_marker(self):
        # The registry checks that the PyPI description (python/README.md) names this server.
        self.assertIn(f"mcp-name: {self.server['name']}", read('python', 'README.md'))
        self.assertTrue(self.server['name'].startswith('io.github.fitzss/'))

    def test_package_and_command(self):
        pkg = self.server['packages'][0]
        self.assertEqual((pkg['registryType'], pkg['identifier'], pkg['transport']['type']), ('pypi', 'valun', 'stdio'))
        self.assertEqual(pkg['runtimeHint'], 'uvx')
        self.assertEqual(pkg['packageArguments'], [{'type': 'positional', 'value': 'mcp'}])   # uvx valun mcp
        self.assertLessEqual(len(self.server['description']), 100)


if __name__ == '__main__':
    unittest.main()
