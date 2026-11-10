# valun-deal/1 specification

- `PROTOCOL.md`: the protocol as the Valun pilot server implements it (up to release v15, valun-app commit `495624c`),
  and the contract of release v16, circulating credit (section 18; off by default, turned on by the operator in stages).
- `OPEN-QUESTIONS.md`: ambiguities, inconsistencies and weaknesses found while writing it, each with a status, and the
  owner decisions release v16 still needs.
- `vectors/*.json`: conformance vectors, generated from release v16 (valun-app commit `b7ecca0`, on tracker v3.2;
  transcript steps 1-147 are release v13's run with circulation off, steps 148-236 and `circulation.json` run with it
  on). Every key in them is a public test key derived
  from a label in `generate.mjs`, or one of Basis's official test vectors. The `vpe_...` enrollment codes come from an
  in-memory server run that never existed on any network (their hash is part of the signed enroll statement, so they
  stay); they are valid nowhere. Owner tokens, agent tokens and invite codes are placeholders.
- `vectors/check_python.py`: checks every vector against a Python client: the `valun` package in this repository
  (`--client package`) or the Hermes plugin (`--client plugin`, the default; `--plugin-dir` or `VALUN_PLUGIN_DIR` = a
  checkout of [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun)).
- `vectors/README-ci.md`: the exact commands CI runs for both clients (`--require circulation/1` holds a 0.4 client to
  the circulating-credit vectors).
- `vectors/generate.mjs`: regenerates the vectors by running the server's own code in memory. It needs the Valun
  server source (`VALUN_APP_DIR`, an export of the release commit), which is not public yet; the generated vectors are.
