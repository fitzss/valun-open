# Conformance check in CI

`check_python.py` proves that a Python client agrees with the Valun server on every byte it hashes or signs:
canonical JSON and terms hashes, statement texts, Basis note messages and signatures, and a replay of a whole pilot run
(`transcript.json`) through the client's real `Client` methods. Since spec revision v14 it also checks circulating
credit (`circulation.json`, and transcript steps 148 and later): the 80-byte messages of bound notes, transfers and
set-offs, transfer quote digests, the pay statement, and the decisions of the client signing firewall (PROTOCOL.md
15.3). The vectors were generated from server release v16 (valun-app commit `cfe698b`, draft until vectors are
regenerated for the final release). Transcript steps 1-147 run with circulation off and are byte-identical to the
release v13 transcript (valun-app `6a6a34b`); steps 148-236 run with circulation on. Run the check once per client:

| client | what is checked | where it comes from |
|---|---|---|
| `package` | the framework-neutral `valun` package: `valun/basis.py`, `valun/client.py`, `valun/novation.py` (and `agent.py`, read as text) | `python/src` of the valun-open checkout; no install needed, an installed copy is never used |
| `plugin` | the Hermes plugin: `valun_core/` (0.3.0 and later; `novation.py` since 0.4.0), or `valun_basis.py` and `valun_client.py` (earlier; `tools.py` read as text) | a checkout of [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun) |

Requirements: Python 3.10 or later, standard library only. No network, no secrets, no server. The script never writes
files (bytecode writing is off).

## Commands

From the root of a valun-open checkout, with hermes-plugin-valun checked out into `hermes-plugin-valun/` inside it:

```sh
python spec/vectors/check_python.py --client package --require circulation/1
python spec/vectors/check_python.py --client plugin --plugin-dir hermes-plugin-valun
python scripts/check_plugin_core.py hermes-plugin-valun
```

The same commands work in bash, PowerShell and cmd (no environment variables needed). Equivalent environment forms:
`VALUN_CLIENT=package|plugin`, `VALUN_PLUGIN_DIR=<plugin checkout>`, `VALUN_PACKAGE_SRC=<folder containing valun/>`.
Without `--plugin-dir` or `VALUN_PLUGIN_DIR`, the plugin is looked for at `../hermes-plugin-valun` next to the
valun-open checkout. `--vectors-dir DIR` reads the vector files from another folder (a regenerated set, before it is
committed).

**Protocol features.** The circulation checks (tiers `circulation` and `consent`) count for a client that declares
`circulation/1` in `PROTOCOL_FEATURES` (its client or novation module), or when the run is given
`--require circulation/1`; otherwise each of them is `n/a`, so a client released before circulating credit (the plugin
0.3.0 that CI pins) is not failed by them. The package run always passes `--require circulation/1`, so a package that
loses the feature fails the run instead of skipping it. Neither the package 0.4.0 nor the plugin 0.4.0 declares
`PROTOCOL_FEATURES` yet; a plugin 0.4.0 run is held to the circulation checks with `--require circulation/1` as well.
The first output line after the client's name says which features were declared, required and checked.

Exit status: `0` every check in a failing tier agrees (or does not apply); `1` at least one disagreement (listed under
"DISAGREEMENTS"); `2` the client was not found or could not be imported, the vectors folder lacks one of the six files
every vector set has, or the run was given `--require circulation/1` with vectors that have no `circulation.json` or
no transcript steps 148+ (older vectors, or a wrong `--vectors-dir`), so the required checks cannot pass vacuously. A
client that only declares `circulation/1` gets a note instead, and those checks are not made. The failing tiers are
`core`, `terms`, `client_path`, `replay`, `circulation` and `consent`. Results in the tiers `wire`, `refused`, `edge`
and `generic` are informative and never fail the run (`edge` includes the stand-in tracker's outcomes of tracker
requests, which are tracker-side rules).

What the release v16 checks add:
- `transcript.json`, every replayed step (1-147 too): the client sends the step's request exactly once (a second send
  is a disagreement); with exactly the recorded `X-Valun-Features` header, so none where none is recorded (steps 1-147
  ran with circulation off), the roles its records declare after `GET /info` lists `circulation/1`, and
  `consents/1;roles=` when it withdraws them (decision D-3 b, step 231); and with exactly the signatures the recorded
  body carries (every `signature` / `*_signature` key at any depth and every slot of a `signatures` map): none missing
  and none extra, so a signature over anything else is caught.
- `transcript.json`, steps 148+: each `server_verified` entry names the body field that held the signature (`field`, a
  JSON pointer) and, for a Basis note message, its edge; the client's message builder must rebuild every such message
  for its edge. A replayed `client_call` with a `feature` starts from `client_state` (the profile's records before the
  call), sends a body equal to the recorded one signatures aside (every `signature` / `*_signature` key dropped at any
  depth; a `signatures` map keeps its slots), signs exactly the `signature_fields` pointers, each over the message the
  server verified for that field, and holds at least `client_state_after` afterwards (a subset: only the keys given are
  compared).
- `circulation.json`: timestamp residue classes; the 80-byte messages of a bound note and its prior acknowledgment,
  all seven transfer slots and both set-off slots; quote digests (`canonical(Q)` and its sha256, and
  `novation.quote_digest`); the pay statement; the signatures of POST /notes/transfer and /notes/setoff requests, valid
  and refused ones, each over the message the tracker checks for its field; and the firewall's decisions
  (`consents[]`, `payer_templates[]`, `bound_templates[]`: the client's own `novation.evaluate_*` must sign exactly
  the slots given, or refuse with the code given). Every refusal code of PROTOCOL.md 15.3 and decision D-1/D-2 has a
  case.

Expected last line of each run against the committed vectors (the counts change only when the vectors are
regenerated):

```
[package] 1386 checks: 1188 agree, 0 disagreements in failing tiers, 17 informative differences, 181 not applicable.
[plugin] 1384 checks: 1104 agree, 0 disagreements in failing tiers, 17 informative differences, 263 not applicable.
```

The first line is `--client package --require circulation/1` (package 0.4.0 from `python/src`). The second is the
plugin without `--require`: hermes-plugin-valun 0.3.0 at `5d01fbd` (the commit `.github/workflows/ci.yml` pins), and
equally the plugin 0.4.0 (`e2c7640`, local). With `--require circulation/1` the plugin 0.4.0 gives the package's line,
`[plugin] 1386 checks: 1188 agree, ...`. Without `--require`, the package gives the plugin's line. These were obtained
locally with Python 3.14.7 and 3.11.18 on Windows and 3.12.3 on Linux (WSL), from fresh clones of the plugin. CI runs
the commands on Linux, macOS and Windows with Python 3.10 and 3.13.

`scripts/check_plugin_core.py PLUGIN_DIR` compares every module in the plugin's `valun_core/` (each `*.py` but
`__init__.py`: six files in plugin 0.3.0, eight since 0.4.0) with the `valun` package at the version `valun_core`
declares: this working tree when the version is the same, else that release from PyPI. A file counts as unchanged when
its bytes are equal, or equal with the import name read as one on both sides (so novation.py, whose text names
`valun_core/novation.py`, is not flagged).

## The GitHub Actions job

The `conformance` job in `.github/workflows/ci.yml`, as release v16 needs it (its matrix also includes macOS; the file
in the repository still runs the package step without `--require circulation/1` until it is updated for v16, which
passes too, with the circulation checks not applicable). `ref` pins the plugin commit the package is held to; a branch
name would make the job follow the plugin's changes. The job also runs `python scripts/check_plugin_core.py
hermes-plugin-valun`.

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
          ref: 5d01fbdde03ab5ad80f51b6547026fb06cd5e20e   # the commit the Hermes plugin catalog pins (0.3.0)
          path: hermes-plugin-valun
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: ${{ matrix.python }}
      - name: Vectors vs the valun package
        run: python spec/vectors/check_python.py --client package --require circulation/1
      - name: Vectors vs the Hermes plugin
        run: python spec/vectors/check_python.py --client plugin --plugin-dir hermes-plugin-valun
```

Both steps run even if you install the package first (`pip install ./python`): `--client package` always imports
from `python/src` and exits with status 2 if the import resolves anywhere else. When the plugin pin moves to a 0.4.0
commit, its step can take `--require circulation/1` too.

## Regenerating the vectors (maintainers with the server source only)

CI does not regenerate the vectors: `generate.mjs` runs the server's own code, which is not public. The generator
exports the exact server release itself (never a working tree): with a valun-app clone next to valun-open (or
`VALUN_APP_REPO=<clone>`), it runs `git archive cfe698b` into a temporary folder, runs that export, and removes it.
Tested with Node 24.21.0:

```sh
node spec/vectors/generate.mjs
git add spec/vectors && node spec/vectors/generate.mjs
git diff --exit-code -- spec/vectors        # deterministic: no diff unless the server or generate.mjs changed
```

To run an export made by hand instead: `VALUN_APP_DIR=<export> node spec/vectors/generate.mjs`, for example

```sh
v16="$(mktemp -d)" && git -C ../valun-app archive cfe698b --prefix=valun-app-v16/ | tar -x -C "$v16"
VALUN_APP_DIR="$v16/valun-app-v16" node spec/vectors/generate.mjs
```

`VALUN_VECTORS_OUT=<folder>` writes the files there instead of next to the script (to compare two runs, or to check a
set with `check_python.py --vectors-dir` before committing it). An export of release v13 (`6a6a34b`) is still
recognised and gives exactly the v13 vectors (no circulation steps, no circulation.json). The generator stops before
writing anything if one of its assertions about the server's behaviour fails, and labels the output
`UNRECOGNISED server source` if the sources are not a known release's (`RELEASES` in generate.mjs pins the sha256 of
every server source it imports). With `VALUN_VECTORS_DEBUG=1`, a failing circulation step leaves the steps so far and
the server's log lines in `debug-steps.json` in the output folder. After regenerating, run the commands above.
