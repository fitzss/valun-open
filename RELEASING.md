# Releasing valun

A release publishes the Python package `valun` (PyPI), the JavaScript package `@fitzdoud/valun` (npm) and the MCP
Registry entry `io.github.fitzss/valun`, all from one tag. The tag runs `.github/workflows/release.yml`. Its `verify`
job checks the same things as `python scripts/release.py check`, then the publishing jobs run with trusted publishing:
no token exists anywhere. Versions on PyPI and npm are immutable, so check before you tag.

`scripts/release.py` does the mechanical parts:

| Step | Command | What it does |
|---|---|---|
| 1 | `python scripts/release.py bump X.Y.Z` | Every file that names the version: the Python and JS packages, `server.json` (twice), the Claude Code plugin (`plugins/valun`), the house example's `requirements.txt` and `js/README.md`. It refuses if one of them does not name the current version where expected. `--dry-run` lists them. |
| 2 | Write `## X.Y.Z (date)` in `CHANGELOG.md` | What changed, for people. |
| 3 | `python scripts/release.py fixtures --python <CPython 3.14>` | Regenerates the JS client's Python fixtures (CI regenerates them with 3.14 and compares). Needed when `python/src/valun` changed. |
| 4 | The tests | `python -m unittest discover -s python/tests`, `node --test js/test/`, the server tests that need no tracker (`server/`, see `ci.yml`). |
| 5 | If the core changed: `python scripts/release.py vendor-plugin <hermes-plugin-valun checkout> --plugin-version X.Y.Z` | Copies the package's core modules into the plugin's `valun_core/` and sets its version. Then: the plugin's changelog, its tests, `hermes plugins validate`, commit, push. |
| 6 | `python scripts/release.py pin-plugin <plugin commit sha> X.Y.Z` | CI and the release workflow check the plugin at that commit, and the two pins move together. |
| 7 | `python scripts/release.py check --plugin-dir <plugin checkout>` | The release gate, here first. It covers: every version, the changelog heading, no "unreleased" in the READMEs, the plugin pin, SKILL.md's client pins, the protocol vectors against the package and the plugin, and the plugin's core. |
| 8 | Commit, push `main`, wait for `ci` to be green, then `git tag -a vX.Y.Z -m "..."` and push the tag | The release workflow publishes. Check PyPI, npm and the registry afterwards. |

`server/` is the published copy of the Valun server. Its changes arrive as "server/ synced to valun-app <sha>"
commits, with `server/.synced-from` naming the server commit. `SKILL.md` at the root is the server's
`public/skill-testnet.md`.
