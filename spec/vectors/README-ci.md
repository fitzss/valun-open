# Conformance check in CI

`check_python.py` proves that a Python client agrees with the Valun server on every byte it hashes or signs:
canonical JSON and terms hashes, statement texts, Basis note messages and signatures, and a replay of a whole pilot run
(`transcript.json`) through the client's real `Client` methods. The vectors were generated from server release v13
(valun-app commit `6a6a34b`). Run it once per client:

| client | what is checked | where it comes from |
|---|---|---|
| `package` | the framework-neutral `valun` package: `valun/basis.py`, `valun/client.py` (and `agent.py`, read as text) | `python/src` of the valun-open checkout; no install needed, an installed copy is never used |
| `plugin` | the Hermes plugin: `valun_basis.py`, `valun_client.py` (and `tools.py`, read as text) | a checkout of [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun) |

Requirements: Python 3.10 or later, standard library only. No network, no secrets, no server. The script never writes
files (bytecode writing is off).

## Commands

From the root of a valun-open checkout, with hermes-plugin-valun checked out into `hermes-plugin-valun/` inside it:

```sh
python spec/vectors/check_python.py --client package
python spec/vectors/check_python.py --client plugin --plugin-dir hermes-plugin-valun
```

The same commands work in bash, PowerShell and cmd (no environment variables needed). Equivalent environment forms:
`VALUN_CLIENT=package|plugin`, `VALUN_PLUGIN_DIR=<plugin checkout>`, `VALUN_PACKAGE_SRC=<folder containing valun/>`.
Without `--plugin-dir` or `VALUN_PLUGIN_DIR`, the plugin is looked for at `../hermes-plugin-valun` next to the
valun-open checkout.

Exit status: `0` every check in a failing tier agrees; `1` at least one disagreement (listed under
"DISAGREEMENTS"); `2` the client was not found or could not be imported. Results in the tiers `wire`, `refused`, `edge`
and `generic` are informative and never fail the run.

Expected last line of each run against the committed vectors (the counts change only when the vectors are
regenerated):

```
[package] 829 checks: 658 agree, 0 disagreements in failing tiers, 17 informative differences, 154 not applicable.
[plugin] 829 checks: 658 agree, 0 disagreements in failing tiers, 17 informative differences, 154 not applicable.
```

These were obtained locally with Python 3.14.7 against release v13's vectors, with hermes-plugin-valun at commit
`f504d26` (a fresh clone; the commit `.github/workflows/ci.yml` pins) and the package at version `0.3.0.dev0` from
`python/src`. CI runs exactly these two commands on Linux, macOS and Windows with Python 3.10 and 3.13.

## The GitHub Actions job

The `conformance` job in `.github/workflows/ci.yml` is this (its matrix also includes macOS). `ref` pins the plugin
commit the package is held to; a branch name would make the job follow the plugin's changes.

```yaml
  conformance:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.10", "3.13"]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@f548e57e544e1ff5a4c46bf1e1b8685f8e4a348a # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/checkout@f548e57e544e1ff5a4c46bf1e1b8685f8e4a348a # v7.0.1
        with:
          repository: fitzss/hermes-plugin-valun
          ref: f504d2660727bf90ee1375e6b071acd5c6b63de5   # the commit the Hermes plugin catalog pins (0.2.0)
          path: hermes-plugin-valun
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: ${{ matrix.python }}
      - name: Vectors vs the valun package
        run: python spec/vectors/check_python.py --client package
      - name: Vectors vs the Hermes plugin
        run: python spec/vectors/check_python.py --client plugin --plugin-dir hermes-plugin-valun
```

Both steps run even if you install the package first (`pip install ./python`): `--client package` always imports
from `python/src` and exits with status 2 if the import resolves anywhere else.

## Regenerating the vectors (maintainers with the server source only)

CI does not regenerate the vectors: `generate.mjs` runs the server's own code, which is not public. To regenerate,
export the exact server release (never a working tree) and point the generator at it (tested with Node 24.21.0):

```sh
v13="$(mktemp -d)" && git -C ../valun-app archive 6a6a34b --prefix=valun-app-v13/ | tar -x -C "$v13"
VALUN_APP_DIR="$v13/valun-app-v13" node spec/vectors/generate.mjs
git diff --stat -- spec/vectors        # deterministic: no diff unless the server or generate.mjs changed
```

The generator stops before writing anything if one of its assertions about v13 behaviour fails, and labels the output
`UNRECOGNISED server source` if the sources are not release v13's. After regenerating, run both commands above.
