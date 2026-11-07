# valun-deal/1 specification

- `PROTOCOL.md`: the protocol as the Valun pilot server implements it (release v8; see the note in
  `OPEN-QUESTIONS.md` for the five items changed in v9).
- `OPEN-QUESTIONS.md`: ambiguities, inconsistencies and weaknesses found while writing it, each with a status.
- `vectors/*.json`: conformance vectors. Every key in them is a public test key derived from a label in
  `generate.mjs`, or one of Basis's official test vectors. The `vpe_...` enrollment codes come from an in-memory
  server run that never existed on any network (their hash is part of the signed enroll statement, so they stay);
  they are valid nowhere. Owner tokens, agent tokens and invite codes are placeholders.
- `vectors/check_python.py`: checks every vector against the Python client
  (`VALUN_PLUGIN_DIR` = a checkout of [hermes-plugin-valun](https://github.com/fitzss/hermes-plugin-valun)).
- `vectors/generate.mjs`: regenerates the vectors by running the server's own code in memory. It needs the Valun
  server source (`VALUN_APP_DIR`), which is not public yet; the generated vectors are.
