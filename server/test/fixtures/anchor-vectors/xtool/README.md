# Both anchor auditors on the same reads (fix inbox #66)

`../xtool.json` holds 41 scripted reads of a Valun server and an Ergo explorer, byte for byte what each auditor is
served, and the exit code each must give on them: the verdict table of `docs/PILOT-API.md` ("Committed ledger",
"Verdicts"). The two auditors are this repository's `scripts/ops/anchor-audit.mjs` and the Python client's
`valun audit` (valun-open `python/src/valun/audit.py`). `test/anchor-audit.unit.test.mjs` runs the first on every
scenario. The keys, notes and boxes are synthetic: the test World of the client's `python/tests/test_audit.py`.

| file | what |
|---|---|
| `scenarios.py` | writes the scenarios from the client's test World: `python -I -B scenarios.py <valun-open>/python scen.json` |
| `live_scenarios.py` | six more from the three live anchors (`../<height>.responses.json`), as recorded and with one published total raised by 1 |
| `run_client.py` | the client on a scenario file: `python -I -B run_client.py <valun-open>/python ../xtool.json` (exit 1 when an exit code differs from the table) |
| `run_server_tool.mjs` | `anchor-audit.mjs` on a scenario file: `node run_server_tool.mjs ../../../../scripts/ops/anchor-audit.mjs ../xtool.json` (the same) |
| `compare.py` | the two verdict lists side by side: `python -I -B compare.py c.jsonl s.jsonl` |
| `pack.mjs` | `../xtool.json` from a scenario file and both verdict lists: `node pack.mjs scen.json c.jsonl s.jsonl <valun-open commit> > ../xtool.json`; it refuses when the two exit codes differ anywhere |

Made on 2026-11-15 with the client at valun-open `feat/anchor-audit` 8a0e464 (its scenarios equal the lead's
`fix-audit/xtool` run of 2026-11-14) and `anchor-audit.mjs` of branch `feat/anchor-ship`: all 41 give the same exit
code, and so do the six live scenarios. Before this branch the two differed on 10 of the 41, each a case the client
called UNKNOWN (exit 2) and `anchor-audit.mjs` decided.

From valun 0.7.1 the client pins the tracker NFT (fix inbox #66 item 1), so `run_client.py` passes each scenario's NFT
(`tracker_nft`), as `run_server_tool.mjs` passes `trackerNft`. With the client at valun-open `release/0.7.1` 8c728bc,
all 41 still give the same exit code as `anchor-audit.mjs` and the table (2026-11-15).

To run the client, use a copy of the valun-open tree (`git -C <valun-open> archive <commit> python | tar -x -C <dir>`),
with `-B` so that no bytecode is written into it.
