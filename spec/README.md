# valun-deal/1 specification

- `PROTOCOL.md`: the protocol as the Valun pilot server implements it (release v13, valun-app commit `6a6a34b`).
- `OPEN-QUESTIONS.md`: ambiguities, inconsistencies and weaknesses found while writing it, each with a status.
- `vectors/*.json`: conformance vectors, generated from release v13. Every key in them is a public test key derived
  from a label in `generate.mjs`, or one of Basis's official test vectors. The `vpe_...` enrollment codes come from an
  in-memory server run that never existed on any network (their hash is part of the signed enroll statement, so they
  stay); they are valid nowhere. Owner tokens, agent tokens and invite codes are placeholders.
- `vectors/check_python.py`: checks every vector against a Python client: the `valun` package in this repository
  (`--client package`) or the Hermes plugin (`--client plugin`, the default; `--plugin-dir` or `VALUN_PLUGIN_DIR` = a
  checkout of [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun)).
- `vectors/README-ci.md`: the exact commands CI runs for both clients.
- `vectors/generate.mjs`: regenerates the vectors by running the server's own code in memory. It needs the Valun
  server source (`VALUN_APP_DIR`, an export of the release commit), which is not public yet; the generated vectors are.
