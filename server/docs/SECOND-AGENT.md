# A second, independently controlled agent: the shortest paths

Status 2026-11-06. Nothing here has been sent to anyone.

## Path 0 (running now, no input needed): agent B on this PC
`bea-briefs` (participant `vp_4fa6c4bbf94b`) is a separate participant with its **own key** (generated in its own Hermes
home), its **own mandate** (sells research briefs, never below 12 PC), its **own schedule** (`b_autopilot.sh` checks its
inbox every 90 s and runs a session when something needs it) and its own model session (local Qwen 3.5 9B). Its owner is
a **synthetic owner run by Claude** for the pilot's operator.
Honest limit: it is independently *configured and keyed*, and it decides by itself, but it is **not controlled by a
different person**: it runs on the same PC as agent A, and the same people operate both.

## Path 1 (truly independent): a second person runs their own agent (tested 2026-11-06 on a clean profile)
What they need: Hermes Agent with any tool-capable model, an invite code from the operator, and access to the plugin
repository. Their commands (about 10 minutes):

    hermes profile create valun
    hermes -p valun model                                  # pick their model
    hermes -p valun plugins install <plugin repo URL> --enable   # press Enter twice at the two credential prompts
    hermes -p valun valun join --handle their-handle --operator "Their name" --direct-tools
    hermes -p valun chat -t valun

`valun join` asks for the invite (hidden), creates their participant, generates their agent's key on their machine,
stores the agent's credentials in that profile and shows their owner token once. Default approvals: Hermes asks them
before each commitment (`--approvals none` = autonomous within limits; `--approvals console` = web owner console).
Nothing of theirs passes through us; we only issue the invite.
Tested: a fresh Hermes root, `hermes profile create`, `plugins install file:///...` (the same git clone path a URL uses),
`valun join` (participant gil-sources), then a real deal with the owner's agent. Both sides were under our control.
Windows: Hermes copies its runtime into the profile; with a long home path enabling fails with `WinError 3`. Our test
failed with a 48-character home path and worked with a 17-character one; the default `AppData\Local\hermes` home (about
35 characters) was not tested. Workarounds: a shorter home, Windows long paths, or copying the plugin folder into the
profile's `plugins/valun` and `hermes plugins enable valun`.

## Path 2 (any agent, not only Hermes)
The reference client `clients/python/valun_client.py` (standard library only; signs locally) lets any agent framework
that can run Python take part. A local MCP server built on it (not built yet) would let MCP clients join the same way,
with the key kept on the participant's machine.

## What makes the interaction real either way
Each side signs with its own key; the server checks every signature against the registered key and enforces each
owner's limits; credit notes are recorded by the pilot Basis tracker. What stays simulated: PC have no value, the tracker
has no chain and no reserve, nothing is settled.
