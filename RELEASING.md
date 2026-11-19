# Releasing valun

A release publishes the Python package `valun` (PyPI), the JavaScript package `@fitzdoud/valun` (npm) and the MCP
Registry entry `io.github.fitzss/valun`, all from one tag. The tag runs `.github/workflows/release.yml`. Its `verify`
job checks the same things as `python scripts/release.py check`, then the publishing jobs run with trusted publishing:
no token exists anywhere. Versions on PyPI and npm are immutable, so check before you tag.

`scripts/release.py` does the mechanical parts:

| Step | Command | What it does |
|---|---|---|
| 1 | `python scripts/release.py bump X.Y.Z` | Every file that names the version: the Python and JS packages, `server.json` (twice), the Claude Code plugin (`plugins/valun`), the house example's `requirements.txt`, `js/README.md`, and the commands of `README.md` (with the release its install section names) and `docs/GETTING-STARTED.md`. It refuses if one of them does not name the current version where expected. `--dry-run` lists them. |
| 2 | Write `## X.Y.Z (date)` in `CHANGELOG.md` | What changed, for people. |
| 3 | `python scripts/release.py fixtures --python <CPython 3.14>` | Regenerates the JS client's Python fixtures (CI regenerates them with 3.14 and compares). Needed when `python/src/valun` changed. |
| 4 | The tests | `python -m unittest discover -s python/tests`, `node --test js/test/`, the server tests that need no tracker (`server/`, see `ci.yml`). |
| 5 | If the core changed: `python scripts/release.py vendor-plugin <hermes-plugin-valun checkout> --plugin-version X.Y.Z` | Copies the package's core modules into the plugin's `valun_core/` and sets its version. Then: the plugin's changelog, its tests, `hermes plugins validate`, commit, push. |
| 6 | `python scripts/release.py pin-plugin <plugin commit sha> X.Y.Z` | CI and the release workflow check the plugin at that commit, and the two pins move together. |
| 7 | `python scripts/release.py check --plugin-dir <plugin checkout>` | The release gate, here first. It covers: every version, the changelog heading, no "unreleased" in the READMEs, the plugin pin, the client pins of SKILL.md, README.md and docs/GETTING-STARTED.md, the protocol vectors against the package and the plugin, and the plugin's core. |
| 8 | Commit, push `main`, wait for `ci` to be green, then `git tag -a vX.Y.Z -m "..."` and push the tag | The release workflow publishes. Check PyPI, npm and the registry afterwards. |

`server/` is the published copy of the Valun server. Its changes arrive as "server/ synced to valun-app <sha>"
commits, with `server/.synced-from` naming the server commit. `SKILL.md` at the root is the server's
`public/skill-testnet.md`.

## Release gates

- **0.7.2: only after the public testnet runs valun-app da29d10 or later** (e039fb9, which staging runs, has it;
  `GET /info` `build` names what a server runs). 0.7.2's held-IOU texts (`decide_by`, the owner console's deadline a
  minute before the tracker's hour, `MARGIN_WORDS`' "the time the owner console shows") assume a server that ends a
  held IOU's approval a minute before that hour and shows that deadline on its card. The testnet's 1b1f18f does not:
  its card shows the hour itself, and an IOU approved after it is still sent and fails at the tracker. The client
  cannot tell the two apart from its own answers (`decide_by` is only in the owner's approval views), so the texts
  also warn of the older server's late approval, but the deadline they name is the newer server's. Promoting the
  testnet needs Fitz's approval.
