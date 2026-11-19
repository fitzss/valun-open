# Outsider acceptance checklist: the Valun local image

**Who it's for.** A person with Docker and nothing else, following only the public instructions: the README's local
section, `docs/LOCAL.md`, and the running server's own `/skill.md`. No GitHub token, no `docker login`, no private repo.
The image carries this file, `docs/LOCAL.md` and the README in `/opt/valun`.

**How to use it.** Do the steps in order. Each step says what to do and what must be true to pass.

**Status.** The package is private until its first public version (fix inbox #143), so step 1 fails until then. This
file is the public copy of the checklist the image's CI runs: its outsider job runs these steps, in this order, from
the CI's own copy (private), on linux/amd64 and linux/arm64, from a job with no private access (how it differs from a
person is at the end). The job is dispatched by hand for each release candidate's digest; what a candidate passed is in
that run's summary.

**Placeholders.** `TAG` and `DIGEST` are the release tag and index digest that the docs publish. You pick the handles
`HANDLE-A` to `HANDLE-D`.

## 0. Prepare
1. Open a terminal where `VALUN_SERVER`, `VALUN_PROFILE` and `VALUN_HOME` are not set.
2. If you already use the public testnet on this machine, hash your profile files now. On Linux:
   `sha256sum ~/.config/valun/profiles/*.json`; `docs/LOCAL.md` gives the folder for macOS and Windows. Step 11 checks
   that they never changed.

## 1. Get the image without private access
- **Do:** `docker pull ghcr.io/fitzss/valun-local:TAG`, then `docker buildx imagetools inspect ghcr.io/fitzss/valun-local:TAG`.
- **Pass:**
  - The pull works without logging in.
  - The index digest is DIGEST, and `:latest` names the same digest.
  - Both linux/amd64 and linux/arm64 are listed.

## 2. Install the client while you still have network
- **Do:**
  1. Install uv as the docs say.
  2. Run `uv tool install valun==0.7.1` (or `pipx install valun==0.7.1`), then `valun --version`.
  3. For step 9, build a client image now from a two-line Dockerfile (`FROM python:3.12-slim` and
     `RUN pip install valun==0.7.1`), tagged `valun-client`.
- **Pass:** `valun --version` prints 0.7.1. From here on, type `valun` where the docs say
  `uvx --from valun==0.7.1 valun`; or keep using uvx and set `UV_OFFLINE=1`.

## 3. Set the client tripwire
- **Do:** in bash or zsh, run the line below. In PowerShell, set each variable with `$env:NAME = "value"`.
  ```
  export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost UV_OFFLINE=1
  ```
  Nothing listens on port 9. So any request the client sends to a host other than this machine fails at once, with a
  message that names the host.
- **Control:** run `valun --profile tripwire-check doctor`, deliberately without `--server`. It is read-only, so it
  creates nothing either way. It must report that https://valun.tech is not reachable, which shows the tripwire works.
- **Pass, from here to the end:** apart from the controls, no command fails with "cannot reach https://valun.tech" or
  names another public host. Any such message is a silent fallback that the tripwire has made loud.
- **Limits:** the tripwire covers the Python client's HTTP requests, not DNS lookups. Step 9 covers the rest.

## 4. Start the server exactly as the docs say
- **Do:** run the README's `docker run` line as written, adding `--name valun-local` as `docs/LOCAL.md` suggests:
  ```
  docker run --rm --name valun-local -p 127.0.0.1:8080:8080 -v valun-local:/data -e PILOT_OPEN_SANDBOX=1 -e PILOT_OPEN_NETWORK=1 ghcr.io/fitzss/valun-local:TAG
  ```
- **Pass:**
  - `docker ps` shows `(healthy)` within a minute.
  - The first lines printed include `network valun-pilot-1, local: no chain`.
  - The server's start line names `http://127.0.0.1:8080`, `/skill.md` and `valun --profile local mcp`. It does not
    name `0.0.0.0`, `:3048` or "MCP at /mcp".
  - `curl -s http://127.0.0.1:8080/pilot/v1/info` says `environment: "local"` and network `valun-pilot-1`, lists
    `circulation/1`, and names a build equal to the image's revision label.
  - `curl -s http://127.0.0.1:8080/pilot/v1/chain` answers 404 `no_chain`.

## 5. Read the server the way an agent would
- **Do:** fetch `/skill.md`, `/agents.md`, `/llms.txt`, `/`, `/start`, `/network`, `/pilot`, `/trust`, `/maintainers`
  and `/.well-known/agent-card.json`. Then ask the A2A front door how to join, in both protocol versions (1.0, then
  0.3):
  ```
  curl -s http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"role":"ROLE_USER","messageId":"m1","parts":[{"text":"How do I join?"}]}}}'
  curl -s http://127.0.0.1:8080/a2a -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"message/send","params":{"message":{"kind":"message","role":"user","messageId":"m2","parts":[{"kind":"text","text":"How do I join?"}]}}}'
  ```
  Then search everything you fetched with `grep -nE 'valun\.tech|fly\.dev'`.
- **Pass:**
  - No command, agent prompt, Copy block, link or self-link names a public host. The only matches are sentences that
    say this is not the public network.
  - Every `valun` command shown runs in a named profile (`--profile local`, or the agent's own) and names
    `http://127.0.0.1:8080` wherever the command takes `--server`.
  - Amounts are in PC, and no Claude Code plugin install is offered.

## 6. One agent, as the server's /skill.md says
- **Do:** follow the `/skill.md` you fetched in step 5, as written: its join (here HANDLE-A), its MCP lines, and, as a
  second agent in a client home of its own, its shell path: join, `call valun_status`, doctor, the tour, and the rest
  of its commands. Its lines have this form:
  ```
  valun --profile local join --sandbox --server http://127.0.0.1:8080 --handle HANDLE-A --operator "YOUR NAME" --about "local acceptance" --owner-token-file "$HOME/valun-local-owner-token-HANDLE-A.txt" --approvals console
  valun --profile local call valun_status
  valun --profile local doctor --server http://127.0.0.1:8080
  valun --profile local sandbox tour --yes --server http://127.0.0.1:8080
  ```
  Approve each commitment the console holds at `http://127.0.0.1:8080/pilot#owner`, using the token from that file.
  Then run the README's own join and tour lines, and `docs/LOCAL.md`'s First use lines, each in a client home of its
  own.
- **Pass:**
  - join prints `Joined Valun as HANDLE-A (vp_...) on http://127.0.0.1:8080`.
  - The token file exists, readable only by its owner on Linux and macOS.
  - doctor reports all set.
  - The tour ends with `The tour is complete: ...`.
  - `GET /pilot/v1/loops` lists a set-off that includes HANDLE-A.
  - The tripwire never fired.
  - `docs/LOCAL.md`'s own First use lines give the same result.

## 7. Connect an MCP app (optional)
- **Do:** with the Valun Claude Code plugin disabled, run
  `claude mcp add valun-local -- valun --profile local mcp`, or use the JSON in `docs/LOCAL.md`.
- **Pass:** `valun_status` from the app names HANDLE-A and `http://127.0.0.1:8080`, and no other Valun server's tools
  are loaded.

## 8. A small multi-agent run with your own agents
- **Do:**
  1. **Agents B and C.** Use a separate terminal for each, with its own client home and this server
     (`export VALUN_HOME=$PWD/agent-b VALUN_SERVER=http://127.0.0.1:8080`, and `agent-c` for C) and the step 3
     tripwire set. Join each with step 6's line, using its own handle and token file. Use `--approvals none` if you
     script it.
  2. **Agent D, by invite.** Run `docker exec valun-local node scripts/pilot-admin.mjs invite --uses 1 --code-only`,
     which prints only the `vpi_...` code. Then, in a fourth client home, pipe only that code into:
     `valun --profile local join --invite-from-stdin --server http://127.0.0.1:8080 --handle HANDLE-D --operator "YOUR NAME" --owner-token-file "$HOME/valun-local-owner-token-HANDLE-D.txt" --approvals console`
  3. **A cycle of three jobs.** A hires B, B hires C, and C hires A. Each is a small paid job, delivered and accepted,
     using `valun --profile local call ...` as `docs/LOCAL.md`'s "Drive them from a script" shows.
  4. **Keep A, B and C signing** until a set-off appears: run `valun --profile local call valun_inbox` every so often,
     or `valun --profile local clearing watch --server http://127.0.0.1:8080`.
- **Pass:**
  - Every join prints `on http://127.0.0.1:8080`, and each agent's `call valun_status` names its own handle.
  - `GET /pilot/v1/loops` lists a set-off whose members are exactly A, B and C, with no sandbox agent.
  - `GET /pilot/v1/ledger` reconciles, and A, B and C each have the same net position after the set-off as before it.
  - `docker exec valun-local node scripts/pilot-admin.mjs clearing status --json` answers.
  - The tripwire never fired.

## 9. Network isolation
- **Sealed run.** Start a second server with no network at all. Then run step 6, and step 8's three-job cycle, from
  containers that share its network namespace. Inside that namespace, `http://127.0.0.1:8080` is the sealed server
  and nothing else exists:
  ```
  docker run -d --name valun-sealed --network none -v valun-sealed:/data ghcr.io/fitzss/valun-local:TAG
  docker run --rm --network container:valun-sealed -v "$PWD/sealed:/agents" -e VALUN_HOME=/agents/a valun-client valun --profile local join --sandbox --server http://127.0.0.1:8080 --handle HANDLE-SA --operator "YOUR NAME" --owner-token-file /agents/a-token.txt --approvals none
  ```
  Do the same for agents b and c, then their deals. Keep links out of the deliveries, or run
  `valun --profile local config check_link_hosts off --server http://127.0.0.1:8080` first.
- **Pass for the sealed run:**
  - The join, the tour and the three-agent cycle all pass inside the sealed namespace.
  - `docker exec valun-sealed cat /proc/net/tcp /proc/net/tcp6 /proc/net/udp /proc/net/udp6` shows only loopback
    addresses.
  - A control, `valun --profile probe doctor` run there without `--server`, reports that https://valun.tech is
    unreachable.
- **Host tripwire.** Pass: across steps 4 to 12, no command failed on a public host.

## 10. Limits behave as documented
- **Do:** on a fresh volume, make 13 self-serve joins from this machine within one hour, each in its own client home
  and each with `--server`.
- **Pass:**
  - 12 joins succeed.
  - The 13th is refused: the client prints `Joining failed (rate_limited): ...`, a message that says how many minutes
    to wait and points to invites.
  - The same join as an HTTP request,
    `curl -s http://127.0.0.1:8080/pilot/v1/join-sandbox -H 'content-type: application/json' -d '{}'`, answers 429
    `rate_limited` with `retry_after_ms`, the wait in milliseconds (the client does not show it). It makes nothing.
  - The figures match `docs/LOCAL.md`'s "Many agents on one machine", including the write budget that every agent on
    this machine shares.

## 11. Restart and persistence
- **Do:** press Ctrl-C (or run `docker stop valun-local` from another terminal), then run step 4's line again.
- **Pass:**
  - The server stops within a few seconds and exits 0.
  - `/pilot/v1/info` gives the same tracker id as before.
  - Every agent, loop and pin is still there, and each agent's doctor reports all set.
  - Your testnet profile files from step 0 still have the same hashes.

## 12. Reset
- **Do:** stop the server. Wait until `docker ps -a` no longer lists it. Run `docker volume rm valun-local`, then start
  the server again.
- **Pass:**
  - The volume is removed, with no "volume is in use" error.
  - The server has a new tracker id and no loops.
  - An old profile's doctor reports `tracker_mismatch` and `unauthorized`, as `docs/LOCAL.md` says.
  - After you remove `local.json` **and the token file step 6's join wrote**
    (`$HOME/valun-local-owner-token-HANDLE-A.txt`: valun 0.7.1 never replaces a file that exists), step 6's join works
    again; so does step 6's line in a fresh client home with a new handle and token file.
  - `docs/LOCAL.md`'s own Reset, done as its paragraph says (in the client home its First use lines made in step 6),
    ends with its join line joining the reset server.
  - The tripwire never fired.

## 13. Inspect
- **Pass:**
  - `docker logs valun-local` contains no owner or agent token.
  - The files that `docs/LOCAL.md` lists in `/data/pilot` as there from the first start are there, and
    `sandbox-join-key` (step 12's joins made it). `pilot-edge-log.jsonl` comes with a volume's first IOU and
    `sandbox-records.json` once a practice agent has signed one, so after step 12's reset either may be missing.
  - The build in `/info` matches the image's revision label.

## 14. A second server beside the first (optional)
- **Do:** start a second server with
  `-p 127.0.0.1:9000:8080 -e VALUN_PUBLIC_ORIGIN=http://127.0.0.1:9000 -v valun-local-2:/data --name valun-local-2`,
  with its agents in client homes of their own.
- **Pass:** its `/skill.md` and its A2A answer both name `http://127.0.0.1:9000`, and neither server shows the other's
  agents or loops.

## Verdict
The image is ready for outsiders when all three hold:
- steps 1 to 13 pass;
- the tripwire fired only in the controls;
- the sealed run passed.

## How the image's CI runs it

- **No private access.** The job that runs the checklist has no token, no secret and no `docker login`, and checks that
  at its start: the anonymous registry token request and an anonymous clone of the CI's own repository must fail.
- **Step 1, while the package is private,** is a stand-in: the anonymous pull must fail as `docs/LOCAL.md` says
  (`unauthorized`), and the image comes from an artifact that a separate job pulled by digest; the test job checks
  that what it loads is that digest's platform image. At release, with the package public, the pull itself must work.
- **The docs** are the image's own `/opt/valun/README.md` and `/opt/valun/docs/LOCAL.md`, and the running server's
  `/skill.md`. Their lines run as written, in order: the README's and `docs/LOCAL.md`'s each on a fresh volume, the
  served `/skill.md`'s on `docs/LOCAL.md`'s server. Only the documented placeholders are filled in (`YOUR-HANDLE`
  with a handle of its own for each join, `"YOUR NAME"` and `"YOUR HUMAN"`, `CONTAINER`, `TEXT`, `<revision>`,
  `<index digest>`). Every join
  with `--approvals console` gets an approver, the owner API with its token file, as a person approves at
  `/pilot#owner`. The invited join gets the invite's code on stdin, as a person pastes it.
- **The tripwire** is step 3's, with a logging proxy on port 9 that refuses every request; the runner also points the
  public names at a logger of its own and logs, and drops, new connections off Docker's networks. Apart from the
  controls, nothing may show up.
- **Step 7** runs the MCP server through a scripted MCP client, not an MCP app.
- **Step 12** runs the checklist's line, then `docs/LOCAL.md`'s own Reset, as its paragraph says, in the client home its
  First use lines made in step 6.
- Each step reports `pass`, `fail` (naming the finding) or `stand-in`, with its evidence, in the job summary.
