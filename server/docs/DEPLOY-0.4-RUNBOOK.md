# Valun 0.4 deploy runbook: server v16 and tracker v3.2 on Fly, then publishing

Written 2026-11-10 (task PA-DOCS) and brought up to tracker v3.2 the same day. **Nothing in this file has been run.**
Only the owner runs these steps, one at a time. **Every step is APPROVAL REQUIRED**: the owner approves each step on its
own, after reading the previous step's result. Stop at the first no-go and take that step's rollback.

What this runbook takes live:
- server release v16: `valun-app`, branch `circulation-v16`, its HEAD: code `4032eaa` (server sources, `lib/`, as at
  `b7ecca0`; `4032eaa` changed one test) plus the docs commit on top of it;
- tracker v3.2: Basis fork commit `43704183e1ba372e1b1788c414dfe4c8b0bc3f2a` (branch `circulating-credit-v3.2`),
  `basis_server` sha256 `e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5`, `valun_signer` sha256
  `dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a`.

It replaces release v15 (`729a4c1`, branch `main`) and Basis 3df7ed93 (`2ab041f7…` / `8d7bb6ea…`). Tracker v3.1
(`24675ec`, `cc0a6ade…` / `314beace…`) is superseded and no longer pinned: circulation runs as off on it, and this
runbook never uses it. The test evidence is in docs/RELEASE-0.4-READINESS.md: section 15 for tracker v3.2, and sections
2-5, 11 and 14 (on v3.1) for the rest. The audit is in its section 12.

## How the commands were checked

- **Repository commands and files** were read at `94797c6`, checked again at `447a103`, and read again at `4032eaa`
  for tracker v3.2. Of the files below, these changed between `447a103` and `4032eaa`: scripts/e2e-python-client.mjs
  (the probes, and its default `VALUN_BINS`), the texts of pilot-admin.mjs and pilot-downgrade-check.mjs, a comment in
  server.mjs, lib/pilot/caps.mjs, pins.mjs and lib/basis.mjs. Dockerfile, .dockerignore, fly.toml, docker-entrypoint.sh,
  run-tracker.sh, check-persistence.mjs, rehearse-container.mjs, check-exposure.mjs, start-local.mjs and
  lib/pilot/http.mjs did not change. The commands below match these files:
  - Dockerfile, .dockerignore and fly.toml (fly.toml is unchanged since `729a4c1`);
  - scripts/docker-entrypoint.sh and basis/run-tracker.sh (in v16 and in v15 `729a4c1`);
  - scripts/check-persistence.mjs, pilot-downgrade-check.mjs, pilot-admin.mjs, check-exposure.mjs, rehearse-container.mjs,
    e2e-python-client.mjs and start-local.mjs;
  - lib/pilot/caps.mjs and pins.mjs, lib/basis.mjs (`trackerPin`), server.mjs (its startup log lines) and
    lib/pilot/http.mjs (its routes);
  - basis/BUILD.md and docs/PILOT-API.md (Operations).
- **The publishing files** were also read: valun-open .github/workflows/ci.yml and release.yml, spec/vectors/README-ci.md,
  server.json, python/pyproject.toml and js/package.json; the plugin's plugin.yaml, CHANGELOG.md and
  CATALOG-UPDATE-0.4.0.md; and the catalog PR checkout C:/Users/USER/valun-release/hermes-agent-pr.
- **What was run while writing:** only read-only commands, plus one vector regeneration in a scratch copy (readiness R-21).
  The read-only commands were sha256sum, git log / show / diff, and step 4's WSL sha256sum of the staged binaries, run
  again for v3.2: `e13d37b4…` / `dff60f9d…`. For v3.2, the logs of the rehearsal runs in readiness section 15 were also
  read.
- **What was never run:** `fly`, `gh`, `git push`, a deploy or a publish.
- **`fly` commands** are written in flyctl's documented syntax but were not run here, so they are not checked against
  your installed version. Before each one, run `fly <command> --help` and adjust a flag if it differs. The `fly`
  commands that change something are marked **(changes live)**.
- **Shell:** Git Bash on the Windows dev machine. Repository commands run from `C:/Users/USER/valun-app` unless the step says
  otherwise.

Values used below (set them in the shell first):

```sh
APP=valun-desk
URL=https://valun-desk.fly.dev
V32=/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release      # staged tracker v3.2 pair (WSL valun-ic1)
OLD=/home/valun/valun-app-bins-20261105T024815Z/t/release            # staged 3df7ed93 pair (WSL valun-ic1)
B=C:/Users/USER/valun-deploy-$(date -u +%Y%m%dT%H%M%SZ)            # local folder for this deploy's captures
mkdir -p "$B"
```

Two helpers used in several steps (paste them into the same shell):

```sh
# Raw public answers (status line and body), for the byte-identity comparison.
cap() { mkdir -p "$B/$1"; for p in /pilot/v1/info /pilot/v1/participants /pilot/v1/ledger /pilot/v1/clearing /api/offers /api/participants /api/status; do
  f="$B/$1/$(printf %s "$p" | tr / _)"; curl -sS -o "$f.body" -w '%{http_code}\n' "$URL$p" > "$f.code"; done; ls "$B/$1"; }
same() { for f in "$B/$1"/*; do g="$B/$2/$(basename "$f")"; cmp -s "$f" "$g" && echo "SAME $(basename "$f")" || echo "DIFF $(basename "$f")"; done; }
```

Never print or copy `.env` files, owner tokens, `/data/pilot/admin-token` or the downgrade check's backups
(`pilot-state.json.v16-backup-*`). Those backups keep note signatures, so keep them as private as the state.

---

## Step 0. Record the live state (read-only) — APPROVAL REQUIRED

Purpose: the facts every later step and every rollback needs, and the v15 baseline for the byte-identity and
persistence checks. Run this close to step 5. If the live pilot changes in between, take the baseline again. If the
machine is stopped (`auto_stop_machines`), `curl -s "$URL/api/status" > /dev/null` starts it.

1. Record the release that runs now. Its image is v15 code plus the 3df7ed93 pair: the rollback image R4.

   ```sh
   fly status -a $APP              > "$B/status-before.txt"     # machine id, region, image
   fly image show -a $APP          > "$B/image-before.txt"      # registry/repository/tag/digest: keep as V15_IMAGE
   fly releases -a $APP --image    > "$B/releases-before.txt"
   fly volumes list -a $APP        > "$B/volumes.txt"           # the volume id of valun_data: VOL
   fly secrets list -a $APP        > "$B/secrets-before.txt"    # names only; must list neither PILOT_CIRCULATION nor VALUN_MAINTENANCE
   fly scale show -a $APP          > "$B/scale-before.txt"      # shared-cpu-1x, 256 MB
   ```
   Set `V15_IMAGE=registry.fly.io/valun-desk@sha256:<digest from image-before.txt>` and `VOL=<volume id>`.
2. Raw public answers: `cap before`.
3. Persistence baselines. They are taken after a restart, because a tracker's live digest can differ from its startup
   digest (docs/PILOT-API.md). The v15 image's check-persistence.mjs has no `--pilot`, so the v16 script is copied onto
   the volume. It reads only and needs nothing but node.

   ```sh
   fly ssh console -a $APP -C "mkdir -p /data/ops"                                   # (changes live: one folder on the volume)
   fly ssh sftp shell -a $APP      # then, in the sftp shell:  put scripts/check-persistence.mjs /data/ops/check-persistence-v16.mjs
   fly apps restart $APP                                                              # (changes live: a restart)
   fly ssh console -a $APP -C "node /data/ops/check-persistence-v16.mjs snapshot http://127.0.0.1:8080 /data/ops/pilot-before.json --pilot"
   fly ssh console -a $APP -C "node /data/ops/check-persistence-v16.mjs snapshot http://127.0.0.1:8080 /data/ops/demo-before.json"
   ```
   Each prints `snapshot: …`, with the pilot's digest, notes, reconciliation rows and participants, or the demo's notes,
   offers, participants and digest. If this flyctl has no `put` in the sftp shell, copy the file another way. Do not
   use v15's script for the pilot.
4. Held notes from v15 (MIG-6). Once tracker v3.2 runs, a held v15 credit note whose timestamp ends in 995-999 ms ends
   `note_failed` when it is approved, and the payer signs again. That costs liveness only. To count them, open
   `fly ssh console -a $APP` and run:

   ```sh
   node -e 'const s=JSON.parse(require("fs").readFileSync("/data/pilot/pilot-state.json","utf8"));const h=Object.values(s.deals).filter(d=>d.status==="completion_awaiting_owner");console.log("held notes:",h.length,"ending 995-999 ms:",h.filter(d=>(d.credit_note?.note?.timestamp%1000)>=995).length)'
   ```
   It only reads. If any are counted, you may ask those owners to decide them before step 5.
5. Memory baseline on v15: section M, item 1. Record it in `$B/memory-before.txt`.

Go: every file above is written, `V15_IMAGE` and `VOL` are known, and both snapshots printed `snapshot: …`.
Rollback: nothing changed except `/data/ops` (remove it with `fly ssh console -a $APP -C "rm -r /data/ops"` at the
end of the whole deploy).

## Step 1. Fly volume snapshot — APPROVAL REQUIRED (changes live: creates a snapshot)

```sh
fly volumes snapshots create $VOL                      # waits or returns at once; then:
fly volumes snapshots list $VOL > "$B/snapshots.txt"   # the new snapshot's id: SNAP1, and its time
```

Take another snapshot right before step 5 and before each of steps 6, 7 and 8 (SNAP5, SNAP6, …). Readiness R-2 and
design 12.4 ask for it.
Go: the snapshot is listed with a size. Rollback: none needed. Snapshots expire under Fly's retention, so note their
ids.

## Step 2. Local checks at the deploy commit — APPROVAL REQUIRED (local only)

These checks ran on 2026-11-10 with the tracker v3.2 pair (readiness section 15):
- both `npm test` runs at `b7ecca0` (`4032eaa` changed one test file, `test/transfer.test.mjs`, which then passed 35 of
  35 with the v3.2 pair);
- the full container rehearsal, with the e2e run and memory sampling, at `b7ecca0`;
- `--tests-only` again at `4032eaa`;
- the e2e script's five runs at `4032eaa`.

Run them again only if the deploy commit is a later one with code changes. The rehearsal runs from a scratch copy, so
the repository's `dist/bin` stays as it is until step 4.

1. The tree that will be deployed:
   ```sh
   git status --short                       # must print nothing
   git rev-parse HEAD > "$B/deploy-commit.txt"; git log --oneline -3
   git diff --quiet 729a4c1 HEAD -- fly.toml && echo "fly.toml as in v15"
   ```
2. Server tests on both tracker builds (from Git Bash, `MSYS2_ENV_CONV_EXCL=VALUN_` keeps `/home/...` unchanged):
   ```sh
   npm test > "$B/npm-old.txt" 2>&1; tail -9 "$B/npm-old.txt"
   MSYS2_ENV_CONV_EXCL=VALUN_ VALUN_BINS=$V32 npm test > "$B/npm-v32.txt" 2>&1; tail -9 "$B/npm-v32.txt"
   ```
   Expected (readiness section 15):
   - first run: 355 tests, 258 pass, 0 fail, 95 skipped, 2 todo;
   - second run: 355 tests, 353 pass, 0 fail, 0 skipped, 2 todo.
3. The container rehearsal with the tracker v3.2 pair, from a scratch copy of the deploy commit:
   ```sh
   T=$(mktemp -d); git archive HEAD | tar -x -C "$T"; mkdir -p "$T/dist/bin"
   MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/cat $V32/basis_server > "$T/dist/bin/basis_server"
   MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/cat $V32/examples/valun_signer > "$T/dist/bin/valun_signer"
   sha256sum "$T/dist/bin/basis_server" "$T/dist/bin/valun_signer"     # e13d37b4… and dff60f9d…
   (cd "$T" && node scripts/rehearse-container.mjs --tests-only) > "$B/rehearse-tests.txt" 2>&1; tail -5 "$B/rehearse-tests.txt"
   (cd "$T" && PILOT_CIRCULATION=on PILOT_OPEN_SANDBOX=1 NODE_OPTIONS=--max-old-space-size=128 node scripts/rehearse-container.mjs) > "$B/rehearse.txt" 2>&1 &
   # once it serves on 127.0.0.1:8090, in a second shell, from C:/Users/USER/valun-app:
   curl -s http://127.0.0.1:8090/api/status | python -c "import json,sys; print(json.load(sys.stdin)['basis']['pin'])"
   curl -s http://127.0.0.1:8090/pilot/v1/info | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('features')); print({k: d['novation'][k] for k in ('tracker_build','transfer_version','bound_note_version','prior_ack')})"
   node scripts/e2e-python-client.mjs --base http://127.0.0.1:8090 --modes on --only tour,calls,probes > "$B/e2e-rehearsal.txt" 2>&1; tail -12 "$B/e2e-rehearsal.txt"
   ```
   `--tests-only` prints only the pass and fail lines. At `4032eaa` it gave `ℹ pass 346`, `ℹ fail 0` and
   `test run exit code 0`. A `✖ failing tests:` heading with nothing under it follows `ℹ fail 0` there; it is not a
   failure. The full run's suite at `b7ecca0` gave 355 tests: 344 pass, 7 skipped and 2 todo, plus the 2 failures that
   `4032eaa` fixed.
   While the e2e run goes, sample memory in WSL, the same way readiness section 5 did:
   `MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/bash -c 'for f in /proc/[0-9]*/status; do grep -qE "^Name:[[:space:]]+(node|basis_server)$" $f && grep -E "^(Name|VmRSS|VmHWM):" $f; done'`.
   Stop the rehearsal with SIGTERM to its entrypoint, as readiness R-14 says. Then remove `$T`.

Go:
- both `npm test` runs give 0 fail;
- `--tests-only` exits 0 with 0 fail;
- `$B/rehearse.txt` has `Pilot: tracker capabilities: basis valun-circulating-credit/4, commit 43704183e1ba, …` and
  `Pilot: circulating credit: on`;
  - The effective mode is on only when the entrypoint's own sha256 of the staged `basis_server` is pinned, and
    `e13d37b4…` is the only pin.
  - The entrypoint's stderr line (`docker-entrypoint: basis_server sha256 …`) did not reach this redirected log in the
    2026-11-10 rehearsals. Do not wait for it here: the sha256sum above checks the hash, and on Fly it is in the logs
    (step 5).
- the first curl prints step 5 item 2's exact `basis.pin` text, without ` (binary not pinned)`;
- the second curl prints `['bound_notes/1', 'circulation/1']` and
  `{'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3, 'prior_ack': 'basis/prior-ack/1'}`;
- the e2e run ends PASS with 0 FAIL (149 checks ok at `b7ecca0`);
- the memory peak of app + trackers + shells is within about 10% of what the readiness doc measured: 128.3 MiB on
  tracker v3.2 (section 15), and 128.7-131.5 MiB on v3.1 (sections 5 and 14).

No-go: anything else. Read the log before deciding, and do not continue to step 3.
Rollback: none (local). Remove `$T`.

## Step 3. Rehearsal on a copy of the live volume — APPROVAL REQUIRED (changes the Fly account: a second app and volume; costs money)

Purpose: run the transition this runbook makes, both ways, on the real data instead of synthetic seeds. This closes
readiness R-2, and MIG-3's "not rehearsed on Fly". The copy holds the live pilot state, so:
- it gets **no public IP**: it is reached only with `fly proxy` and `fly ssh`;
- it gets an unguessable name;
- it is destroyed at the end.

Real participants' tokens are valid on the copy, so never give its address to anyone.

```sh
RH=valun-rh-$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')           # e.g. valun-rh-1a2b3c4d
fly apps create $RH                                                   # add --org <org> if asked
fly volumes create valun_data -a $RH --snapshot-id <SNAP1> --region iad --size 1 --yes
```
If Fly refuses to restore another app's snapshot into this app, stop step 3. R-2 then stays open, as the readiness doc
says, and the owner decides whether to continue. With no public IP, the Fly proxy may still stop the copy's machine
when it is idle, and `fly proxy` does not start it again. If that happens, run `fly machine list -a $RH`, then
`fly machine start <id> -a $RH`.

1. **v15 on the copy, for the baseline.** Deploy the image recorded in step 0. `HOST=::` makes the app listen on IPv6
   as well, so that `fly proxy` (private network) reaches it. The image and fly.toml's `[env]` match live, but the
   copy has **none of the live secrets**: `fly secrets list -a $RH` is empty, while `$B/secrets-before.txt` lists the
   live names. Without `VALUN_WRITE_TOKEN`, for example, `/api/status` reports `writeTokenRequired: false` and the demo's
   write routes take no token. Either set the same names on `$RH` yourself (`fly secrets set -a $RH NAME=…`, values you
   hold; never print them) before this deploy, or accept those differences. Either way, compare the copy only with its
   own baseline (`rh-before` below), never with the live `before`.
   ```sh
   fly deploy -a $RH --image "$V15_IMAGE" --no-public-ips --ha=false -e HOST=::
   ```
   If the image cannot be used from another app, build v15 from its commit, with the 3df7ed93 pair:
   `V=$(mktemp -d); git archive 729a4c1 | tar -x -C "$V"; mkdir -p "$V/dist/bin"; cp dist/bin/basis_server dist/bin/valun_signer "$V/dist/bin/"`.
   Check the sha256 values: `2ab041f7…` / `8d7bb6ea…`, as long as step 4 has not run yet. Then
   `(cd "$V" && fly deploy -a $RH --no-public-ips --ha=false -e HOST=::)`.
   Then take the copy's baseline, through the private network:
   - run `fly proxy 8090:8080 -a $RH` in another shell, and set `URL=http://127.0.0.1:8090` in this one;
   - step 0's item 2 as `cap rh-before`;
   - step 0's item 3 with `-a $RH`: copy the v16 script, restart, and take both snapshots (they land on the copy's
     volume, so they are the copy's own);
   - step 0's item 5 into `$B/memory-rh-before.txt`.
2. **v16 with tracker v3.2, mode off.** Deploy from the scratch copy of step 2, which holds the v3.2 pair (make it
   again if it was removed): `(cd "$T" && fly deploy -a $RH --no-public-ips --ha=false -e HOST=::)`. Then take every
   check of step 5 on `$RH`, with the proxy and `URL` still set as in sub-step 1:
   - item 3 becomes `cap rh-after5; same rh-before rh-after5` (and `rh-before` / `rh-after5` in its python line);
   - the ssh checks are the same, with `-a $RH`;
   - item 6 makes its throwaway participant on the copy only, so it never reaches the live directory.
3. **The flag ladder.** Take steps 6, 7 and 8 on `$RH` (`fly secrets set -a $RH PILOT_CIRCULATION=…`) with their checks.
   In step 7 the e2e script can also run against the copy:
   `node scripts/e2e-python-client.mjs --base http://127.0.0.1:8090 --modes on --only tour,calls,probes`.
   Its checks expect design 9.2's totals, which assume the sandbox agents' edges of a fresh server. On a copy with
   history, a FAIL can come from that alone. Read each FAIL. The tour must complete, and every public reconciliation
   row must be `match`.
4. **The rollback, all of it.** Take R1 (down to `off`), R2 (the drain), R3 (the maintenance-mode check: dry run, then
   for real) and R4 (the v15 image again, here with `--no-public-ips --ha=false -e HOST=::`) on `$RH`.
   - Expected: v15 starts on the prepared state with the 3df7ed93 tracker on the v3.2-written folders. The pilot
     ledger and participants read as before. This is compatibility test (e), on real data.
   - Record the downgrade check's output: what it purged, and its warnings.
5. **Destroy the copy:** `fly apps destroy $RH` removes its machine and volume. Then `fly apps list` must no longer
   show it. Stop the `fly proxy` shell, and set `URL=https://valun-desk.fly.dev` again: every later step reads live.

Go:
- each sub-step's checks pass as in the live steps;
- the rollback ends on a working v15;
- memory on the copy is within step 5's limits;
- the copy is destroyed.

No-go: anything else. Fix it locally, then repeat steps 2 and 3. Rollback: `fly apps destroy $RH`.

## Step 4. The tracker v3.2 pair into `dist/bin`, with sha pins — APPROVAL REQUIRED (changes what every later `fly deploy` ships)

`dist/` is not tracked by git, and `.dockerignore` lets only `dist/bin/basis_server` and `dist/bin/valun_signer` into
the image, so the backup folder below never ships.

```sh
mkdir -p dist/bin-3df7ed93 && cp -p dist/bin/basis_server dist/bin/valun_signer dist/bin-3df7ed93/
sha256sum dist/bin-3df7ed93/*        # 2ab041f7ced2c8b2b0762ec32bd26b89d953a9bc59a939d57a66e08151aac74b, 8d7bb6eae99d681439a33bce41f2b6444e2731d9d124aba33d35199d8af3da01
MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/bash -c "sha256sum $V32/basis_server $V32/examples/valun_signer"
MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/cat $V32/basis_server > dist/bin/basis_server
MSYS_NO_PATHCONV=1 wsl.exe -d valun-ic1 -u valun --exec /bin/cat $V32/examples/valun_signer > dist/bin/valun_signer
sha256sum dist/bin/basis_server dist/bin/valun_signer
grep -c e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5 lib/pilot/pins.mjs     # 1: the only pinned hash
grep -c cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8 lib/pilot/pins.mjs     # 0: tracker v3.1 (superseded) is not pinned
```

Go: `dist/bin/basis_server` is `e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5` and
`dist/bin/valun_signer` is `dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a`, the same on both sides.
These are the values in basis/BUILD.md (tracker v3.2). The second grep prints 0. The `grep -c` exit status is 1 when it
prints 0, which is expected here.

**Before every later `fly deploy` from this checkout,** run `sha256sum dist/bin/basis_server` again. Once step 5 has run
and any mode other than `off` has been used, an image with the 3df7ed93 pair is an implicit tracker downgrade (audit
MIG-1/MIG-2, readiness R-18). Do it only through R1-R4. (Release v16.1, not deployed: such a server refuses every pilot
write, `503 tracker_downgraded`, until the tracker v3.2 pair is back; docs/PILOT-API.md, Operations.)

Rollback, **before step 5 only:** `cp -p dist/bin-3df7ed93/basis_server dist/bin-3df7ed93/valun_signer dist/bin/`, then
check `2ab041f7…` / `8d7bb6ea…`. After step 5, keep the v3.2 pair in `dist/bin`.

## Step 5. Deploy v16 with circulation off, and verify — APPROVAL REQUIRED (changes live)

Before it: SNAP5 (step 1). `fly secrets list -a $APP` lists neither `PILOT_CIRCULATION` nor `VALUN_MAINTENANCE`
(unset means `off`). `git status --short` prints nothing, and HEAD is `$B/deploy-commit.txt`. Step 4's sha check
passes.

```sh
fly deploy -a $APP                         # from C:/Users/USER/valun-app; builds the Dockerfile with dist/bin = tracker v3.2
```

Checks, in this order:
1. **It runs:** `fly status -a $APP` shows the machine started and the `/api/status` check passing.
   `fly logs -a $APP --no-tail > "$B/logs-5.txt"` holds these lines:
   - `docker-entrypoint: basis_server sha256 e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5; config layout auto`
   - `Pilot: tracker capabilities: basis valun-circulating-credit/4, commit 43704183e1ba, …`
   - `Pilot: circulating credit: off`

   It holds no `ALARM`, no `fail closed`, no `Error` and no restart loop.
2. **Pins in the image:** `fly ssh console -a $APP -C "sha256sum /opt/valun/bin/basis_server /opt/valun/bin/valun_signer"`
   gives `e13d37b4…` and `dff60f9d…`.
   `curl -s "$URL/api/status" | python -c "import json,sys; print(json.load(sys.stdin)['basis']['pin'])"` prints exactly:
   `Basis tracker v3.2: Valun fork commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a (branch circulating-credit-v3.2 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself`
   It must **not** end in ` (binary not pinned)`.
3. **Byte identity with v15:** `cap after5; same before after5`.
   - Expected: SAME for every file except `_api_status.body`, where only `basis.pin` (and perhaps the demo digest)
     differs. Show that with
     `python -c "import json; a=json.load(open('$B/before/_api_status.body')); b=json.load(open('$B/after5/_api_status.body')); print({k:(a['basis'][k],b['basis'][k]) for k in a['basis'] if a['basis'][k]!=b['basis'][k]})"`.
   - `_pilot_v1_info.body` has no `features` key, and `_pilot_v1_clearing.code` is what v15 answered, because with
     circulation off the route does not exist.
   - A DIFF that a participant's action between the two captures explains (a new note, a new participant) is not a
     no-go. The persistence check (next) names exactly what is new or gone.
4. **Persistence** (the image now has the v16 script):
   ```sh
   fly ssh console -a $APP -C "node /opt/valun/app/scripts/check-persistence.mjs compare http://127.0.0.1:8080 /data/ops/pilot-before.json --pilot"
   fly ssh console -a $APP -C "node /opt/valun/app/scripts/check-persistence.mjs compare http://127.0.0.1:8080 /data/ops/demo-before.json"
   fly apps restart $APP
   # the same two compare commands again, after the restart
   ```
   Each prints `SAME after restart: …` and exits 0. Tracker v3.2 opening 3df7ed93's folders must give the same notes,
   reconciliation rows, participants and digest. That is compatibility test (c), on the live data.
5. **Memory:** section M, item 1, at idle and after item 6's write (item 2 for the files' sizes). Record them in `$B/memory-5.txt`.
6. **One real write in mode off.** Use a throwaway sandbox participant made with the 0.4.0 checkout (valun-open
   `circulating-credit` at `6c437e0`, whose client signs circulation operations only for the tracker v3.2 contract),
   since PyPI still serves 0.3.1. It stays in the live directory for its 7 days.
   ```sh
   export VALUN_HOME=$(mktemp -d) PYTHONPATH=C:/Users/USER/valun-open/python/src
   PY=C:/Users/USER/valun-open/.venv/Scripts/python.exe
   $PY -m valun --profile off1 join --sandbox --server $URL --handle <unused-handle> --owner-token-file "$VALUN_HOME/off1.owner"
   $PY -m valun --profile off1 sandbox buy sandbox-exact text-stats --text "hello world"
   ```
   The job is verified exactly, and its credit note appears in `GET $URL/pilot/v1/ledger`. Re-run item 4's pilot
   compare. It now **exits 1**, as it should: the write changed the pilot. Expected output, and nothing else:
   - `DIFFERENT after restart: localDigest, notes, reconciliation, participants` (the digest moves with any new note);
   - `notes: new` exactly once, the note from the new participant's key to `sandbox-exact`'s;
   - `reconciliation: new` exactly once, that note's row, with status `match`;
   - `participants: new` exactly once, `…:<unused-handle>:…`;
   - no line with `gone`.

   Then take a new baseline for the later steps:
   `fly ssh console -a $APP -C "node /opt/valun/app/scripts/check-persistence.mjs snapshot http://127.0.0.1:8080 /data/ops/pilot-after5.json --pilot"`.
7. Optional: `node scripts/check-exposure.mjs $URL` from this checkout (read its header first: it sends GETs, plus
   POSTs that a deployment with a write token refuses). It ends with `all exposure checks passed`.

Go:
- items 1-6 pass;
- the app's VmRSS plus both trackers stays at or below 170 MiB, MemAvailable stays at or above 40 MiB, and the logs show
  no OOM kill. These limits are proposed: readiness section 15 measured 128.3 MiB for everything on tracker v3.2, and
  sections 5 and 14 measured at most 131.5 MiB on v3.1;
- after the soak period the owner chooses (proposed: at least 24 hours in mode off), section M shows no ALARM, no 5xx
  burst and no memory growth.

Rollback:
- **No-go before anything else happened:** R3 then R4. The mode was `off`, so nothing of circulating credit exists. R2's
  wait is not needed, but take R2's dry-run check first: it must print no `REFUSED`.
- **If the deploy fails before the app started** (the logs have no `Pilot: circulating credit` line, because the
  entrypoint or a tracker exited first): run `fly deploy -a $APP --image "$V15_IMAGE"` at once. The v15 image carries
  the 3df7ed93 pair, which reads v3.2-written folders (compatibility test (e), readiness section 15). Mode off never
  wrote a bound note or a novation.
- **If the app started and then failed:** take R3, then R4.

## Step 6. `bound` — APPROVAL REQUIRED (changes live)

Before it: SNAP6 (step 1). Step 5's checks are still green.

```sh
fly secrets set -a $APP PILOT_CIRCULATION=bound            # restarts the machine
```

Checks:
1. `fly logs -a $APP --no-tail` shows `Pilot: circulating credit: bound` and no `fail closed`. `fail closed` would
   mean the capabilities or the pin did not validate: the line gives the reason.
2. `curl -s $URL/pilot/v1/info | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('features')); print({k: d['novation'][k] for k in ('tracker_build','transfer_version','bound_note_version','prior_ack')})"`
   prints `['bound_notes/1']`. It also prints the tracker contract the server enforces:
   `{'tracker_build': 'valun-circulating-credit/4', 'transfer_version': 4, 'bound_note_version': 3, 'prior_ack': 'basis/prior-ack/1'}`.
   The 0.4.0 clients sign prior acknowledgments only for exactly these values. The `description` is still v15's, word
   for word, in this mode.
3. A bound note: with step 5's throwaway profile, `$PY -m valun --profile off1 sandbox buy sandbox-exact text-stats
   --text "hello again"`. The 0.4.0 client issues a bound note when the server lists `bound_notes/1` and names that
   contract. Its prior acknowledgment is tracker v3.2's PA. The new note's `timestamp` in `GET /pilot/v1/ledger` ends
   in `997`. The public reconciliation rows stay `match`.
4. Section M.

Go: items 1-4, then the owner's soak period (proposed: 24 hours) with section M clean.
Rollback: R1 to `off`. Every held bound note must be decided first, so read R1. If needed, then R2-R4.

## Step 7. `sandbox` — APPROVAL REQUIRED (changes live)

Before it: SNAP7. The sandbox numbers are the owner's (readiness section 7, decision 3).

```sh
fly secrets set -a $APP PILOT_CIRCULATION=sandbox
```

Checks:
1. The logs show `Pilot: circulating credit: sandbox`. `/pilot/v1/info` `features` is `['bound_notes/1', 'circulation/1']`.
   It has `novation` with:
   - `transfer_ms` 999, `setoff_ms` 998, `bound_note_ms` 997 and `max_age_ms` 3600000;
   - the four contract fields of step 6, item 2: `tracker_build` `valun-circulating-credit/4`, `transfer_version` 4,
     `bound_note_version` 3 and `prior_ack` `basis/prior-ack/1`.
2. `curl -s $URL/pilot/v1/clearing` answers 200 with the engine's public aggregates.
   `fly ssh console -a $APP -C "node /opt/valun/app/scripts/pilot-admin.mjs clearing status"` prints the engine's
   diagnostics, and never a signature.
3. The stranger tour, with a new throwaway profile (step 5's environment):
   ```sh
   $PY -m valun --profile tour1 join --sandbox --server $URL --handle <unused-handle> --owner-token-file "$VALUN_HOME/tour1.owner"
   $PY -m valun --profile tour1 sandbox tour --yes
   ```
   It exits 0 with "The tour is complete". Every row of `GET /pilot/v1/ledger` `reconciliation` is `match`. Design
   9.2's exact totals assume fresh sandbox agents, so on the live server compare the tour's own edges, not those
   totals.
4. Participants outside the sandbox see nothing new: their circulation routes are the same `404` as an unknown route.
5. Section M, especially memory under the tour (readiness R-3: "watch … especially after `sandbox` and `on`").

Go: items 1-5, and the soak period with section M clean. Publishing (section P) can start here: the catalog PR's
reviewer test needs a server that offers circulating credit.
Rollback: R1 to `bound` or `off`. An `outcome_unknown` or `inconsistent` attempt can still be resolved in `bound`
(MIG-4), but not in `off`.

## Step 8. `on` — APPROVAL REQUIRED (changes live)

Before it: SNAP8. Look at the owner console once in a real browser (readiness R-10).

```sh
fly secrets set -a $APP PILOT_CIRCULATION=on
```

Checks:
1. The logs show `Pilot: circulating credit: on`. The features are as in step 7.
2. Participants who joined before circulation have the LEGACY mandate values: nothing moves, is cleared or is accepted
   for them until their owner opts in (docs/PILOT-API.md, circulation policies). Look at one invited participant's
   owner view.
3. The clearing engine (`pilot-admin.mjs clearing status`) and `GET /pilot/v1/clearing` as in step 7.
4. Section M every day for the first week: memory, ALARM lines, `pilot-edge-log.jsonl` size (readiness R-19) and state
   size (readiness R-6). `node scripts/live-check.mjs $URL --fly $APP --expect-mode on` does all of it.

Go: items 1-4. Rollback: R1 to `sandbox`, or lower.

---

## R. Rollback ladder (each rung APPROVAL REQUIRED; always start at R1)

**R1. Flag down first.** Set a lower mode with `fly secrets set -a $APP PILOT_CIRCULATION=<sandbox|bound|off>`, or go
straight to `off`. Before `off`:
1. Every transfer that is `outcome_unknown` or `inconsistent` is resolved by its payer's owner. The resolve route exists
   in every mode except `off` (MIG-4); in `off` such a deal stays blocked.
2. Every held bound note is decided.

To see what is still under way, run the check in report mode on the running machine. It reads only:

```sh
fly ssh console -a $APP -C "node /opt/valun/app/scripts/pilot-downgrade-check.mjs /data/pilot/pilot-state.json --dry-run"
```

The script's header says the same (since `04dc3c8`): the resolve route exists in every mode except off (MIG-4).

**R2. Drain (needed before R3/R4 once any mode other than `off` ran).**
1. Leave the server in `off` for at least 31 minutes: collecting transfers end after 20, and set-offs after 30.
2. The machine may auto-stop meanwhile. Afterwards, request `$URL/api/status`, which starts it; recovery runs at startup
   and every 60 s. Wait 2 minutes.
3. Run R1's dry-run check. It must not print `REFUSED`. If it does, read the reasons, wait, and repeat.

**R3. Downgrade check in maintenance mode (before any v15 code or the 3df7ed93 binary runs on this volume).**
1. Run `fly secrets set -a $APP VALUN_MAINTENANCE=downgrade-check-dry-run`, then read `fly logs -a $APP --no-tail`.
   The entrypoint runs the check on `/data/pilot/pilot-state.json` before any tracker or the app starts, and exits
   with its code: 0 prepared, 1 refused, 2 unreadable.
2. Then run `fly secrets set -a $APP VALUN_MAINTENANCE=downgrade-check`. The log says `the pilot state is prepared;
   deploy release v15 now (with VALUN_MAINTENANCE unset), nothing was started`. It wrote
   `pilot-state.json.v16-backup-<UTC>` and mapped `payment_due` to `note_failed`. It purged every unapplied note
   signature (MIG-1), kept their sha256, and appended `downgrade.v15_prepared`.
3. On `REFUSED` nothing was written. Run `fly secrets unset -a $APP VALUN_MAINTENANCE`, let v16 drain (R2), and repeat.
   While refusing, the machine may restart and rerun the check, which writes nothing.

**R4. The old release, only after R1-R3.** v15 code with the 3df7ed93 pair is the image recorded in step 0.

```sh
fly deploy -a $APP --image "$V15_IMAGE"
fly secrets unset -a $APP VALUN_MAINTENANCE PILOT_CIRCULATION     # v15 ignores both; unset them anyway
```

If that image is gone, build v15 from `git archive 729a4c1` with `dist/bin` = `dist/bin-3df7ed93/` (check
`2ab041f7…` / `8d7bb6ea…`), and `fly deploy -a $APP` from that folder.

Checks:
- `/api/status` `basis.pin` is v15's text again.
- `/pilot/v1/info` has no `features`.
- The logs show no errors.
- `cap after-r4` reads the ledger and participants.

Keep the downgrade check's backup, privately. It also holds the `d.payment` records (readiness section 7, decision 4).

Two combinations this runbook never uses:
- **v15 code with tracker v3.2.** The v15 image's basis/run-tracker.sh (`729a4c1`) always writes the `[ergo.node]` layout,
  which v3.2 refuses (basis/BUILD.md: the scanner layout, as for v3.1), so that image does not start a v3.2 tracker.
  docs/PILOT-API.md's "v15 code on tracker v3.2" paragraph says that this combination needs v16's launcher.
- **The 3df7ed93 binary under v16 code without R2 and R3.** After circulation ran, that is the implicit downgrade of
  MIG-2. v16 then only raises an ALARM (readiness R-18). Release v16.1 also refuses every pilot write then, with
  `503 tracker_downgraded` and `writes_refused` in `/pilot/v1/info` (readiness section 17).

**R5. Restore a snapshot (last resort; owner decision).** This loses every record made after the snapshot, while the
participants' clients keep theirs. Pilot credits have no value, but the clients' records and the server's will
disagree.
1. Create a volume from the snapshot:
   `fly volumes create valun_data -a $APP --snapshot-id <SNAPn> --region iad --size 1`.
2. Move the machine to the new volume, and destroy or detach the old one, following Fly's "restore from a snapshot"
   procedure for the installed flyctl. Check `fly volumes --help` and `fly machine update --help`.
3. Deploy the release that matches the snapshot's data: v15 for SNAP1/SNAP5, v16 for later ones.

## M. Monitoring commands (read-only)

**All of the below in one command:** `node scripts/live-check.mjs $URL --fly $APP --expect-mode on` (since 2026-11-11).
It reads the public routes, and through `fly ssh` and `fly logs` the memory, the growing files and the recent log
lines; it writes nothing and uses no token. One line per check (OK, WARN, FAIL) against step 5's limits; exit 1 on any
FAIL. Without `--fly` only the public checks run. The commands below are what it does, for reading by hand.

1. **Memory** (in `fly ssh console -a $APP`):
   ```sh
   grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
   for f in /proc/[0-9]*/status; do grep -qE '^Name:[[:space:]]+(node|basis_server)$' "$f" && grep -E '^(Name|Pid|VmRSS|VmHWM):' "$f"; done
   ```
   Fly's own metrics, in the dashboard or Grafana, show the machine's memory and restarts over time.
2. **Files that grow:**
   `ls -l /data/pilot/pilot-state.json /data/pilot/pilot-edge-log.jsonl /data/pilot/pilot-audit.jsonl` (readiness R-6,
   R-19).
3. **Logs:** `fly logs -a $APP --no-tail | grep -E 'ALARM|fail closed|revivable|Error|Out of memory'`. Any `ALARM`
   naming revivable signatures means a tracker without capabilities is running on a volume where circulation ran.
   That is a stop: put the tracker v3.2 pair back (step 4) and redeploy. With release v16.1 the same case also shows as
   `writes_refused` in `/pilot/v1/info`, which `scripts/live-check.mjs` FAILs on.
4. **State:** `/pilot/v1/info` (`features`, `participants`); every public reconciliation row `match`;
   `pilot-admin.mjs clearing status` in modes sandbox and on.

---

## P. Publishing (each step APPROVAL REQUIRED; recommended after step 7)

Order matters. The plugin's pushed SHA goes into valun-open's workflows, and PyPI and npm versions are immutable.
valun-app has no git remote and is not pushed. The tracker branch is not published: whether to offer it upstream is owner
decision 7.

**P1. Plugin release-docs commit (local).** The catalog pins the commit that will be pushed. At `17e9be4` (the branch
`v0.4.0`'s HEAD now: tracker v3.2), the plugin's CHANGELOG.md still says `## 0.4.0 "circulating credit" (unreleased
draft)` and `**Not released.** …` (audit SC-3 names these lines), so change them to say released. Then re-run the
plugin's checks at that commit:
- `python -B -m unittest discover -s tests` in the plugin;
- from valun-open, `python spec/vectors/check_python.py --client plugin --plugin-dir C:/Users/USER/valun-release/hermes-plugin-valun --require circulation/1`
  and `python scripts/check_plugin_core.py C:/Users/USER/valun-release/hermes-plugin-valun`;
- `hermes plugins validate <plugin dir>`.

Expected (readiness section 15, at `17e9be4`):
- unit tests: 150, OK (2 skipped on system Python; none in the Hermes venv);
- vectors: 1461 checks, 1260 agree, 0 disagreements in failing tiers (17 informative, 184 n/a);
- core: unchanged (8 files);
- validate: passed (15 checks, security scan safe).

If valun-open's Python core changes again, copy it into the plugin again first.

**P2. Vectors (done locally at `b7ecca0`; readiness R-21 closed).** valun-open `3f3265b` regenerated the vectors from
valun-app `b7ecca0`, whose server sources (`lib/`) are the deploy commit's: `4032eaa` changed one test. History: before
tracker v3.2, `f4017c4` had regenerated them from `fa38334`. If a later deploy commit changes `lib/`, add it to
`RELEASES` in spec/vectors/generate.mjs and regenerate (`node spec/vectors/generate.mjs`), then re-run every client
against the new set.

**P3. Spec follow-ups (done locally).**
- Tracker v3.2: valun-open `61d26fb`, which covers PA, the contract in GET /info, the same-prior exemption (R11, 18.6),
  and VS-1 and R-17 closed; then `8aa6586` (docs); then, after the review of the server and client side, `64ba97a`,
  `95d23c4` and `6c437e0` (attempt records name the acknowledgment they signed; the same-timestamp record keeps a prior
  slot's prior state; the vectors regenerated; the spec's R4 and R11).
- History, for PA-SV's server change: `e4e53a6` and `2b4695a`. They covered 18.6 (no regeneration), 18.8, 18.9, 18.11,
  18.16, `next_actions` (`wait_for_transfer_window`) and `409 transfer_stale` with `template: null`. They also updated
  the root CHANGELOG: the `payee_edge_not_applied` handling, the quoted resolve command and the regenerated vectors.

**P4. Push the plugin.** `v0.4.0` (HEAD `17e9be4` before P1's commit) is a fast-forward of `origin/main` (`5d01fbd`).
That was checked again from the local refs, without a fetch.
```sh
cd C:/Users/USER/valun-release/hermes-plugin-valun
git fetch origin && git merge-base --is-ancestor origin/main refs/heads/v0.4.0 && git push origin refs/heads/v0.4.0:refs/heads/main
PLUGIN_SHA=$(git rev-parse refs/heads/v0.4.0); echo $PLUGIN_SHA     # the pushed commit: the catalog pin and valun-open's CI pin
```
The plugin repository has a **branch** named `v0.4.0`, so a bare `v0.4.0` is ambiguous once P10 adds the tag of the same
name (`git push` then fails with "src refspec v0.4.0 matches more than one"). Every plugin command here names
`refs/heads/…` or `refs/tags/…` in full.

**P5. valun-open: pins, action SHAs, release docs (local commits on `circulating-credit`).**
1. Replace `2b78a0624f6f28ff31f0f32c1b11312ab726f33d` with `$PLUGIN_SHA` in these places:
   - .github/workflows/ci.yml, the 0.4.0 checkout's `ref:` line (keep the form `ref: <sha>`: release.yml's verify job
     runs `grep -q "ref: $PLUGIN_SHA" .github/workflows/ci.yml`);
   - .github/workflows/release.yml, `env.PLUGIN_SHA`;
   - spec/vectors/README-ci.md, which mentions `2b78a06` and shows the same snippet.

   Also update the comments that call it a local commit. `2b78a06` predates tracker v3.2. Against the vectors
   regenerated from `b7ecca0`, it disagrees on 75 checks (readiness section 15), so CI fails until it is replaced.
2. Check the two action SHAs that were written from memory. They are the only action pins not already on
   `origin/main`; checkout, setup-python, setup-node, pypi-publish and cosign-installer ran green for 0.3.1.
   ```sh
   gh api repos/actions/upload-artifact/commits/v4.6.2 --jq .sha      # release.yml has ea165f8d65b6e75b540449e92b4886f43607fa02
   gh api repos/actions/download-artifact/commits/v4.3.0 --jq .sha    # release.yml has d3f86a106a0bac45b974a628896c90dbdf5c8093
   ```
   Replace either one that differs.
3. **The release-docs commit, before tagging.** Remove the `unreleased` marks:
   - js/README.md:16, ``Version `0.4.0` (unreleased; npm serves `0.3.1`)``;
   - CHANGELOG.md:6, `## 0.4.0 "circulating credit" (unreleased draft)`;
   - README.md:55, `plugin 0.4.0 (unreleased)`, and the table rows README.md:8-10, which say `(unreleased)` for the
     0.4.0 checkout and the spec. The verify job does not check this file, but it would be stale.

   The verify job refuses the tag while js/README.md or python/README.md match `unreleased|not published|not released`,
   or the `## 0.4.0 ` heading says unreleased. Check locally:
   `grep -nEi "unreleased|not published|not released" js/README.md python/README.md; grep -F "## 0.4.0 " CHANGELOG.md`.
4. Run the verify job's checks locally:
   ```sh
   cd C:/Users/USER/valun-open
   .venv/Scripts/python.exe -B -m unittest discover -s python/tests
   python spec/vectors/check_python.py --client package --require circulation/1
   python spec/vectors/check_python.py --client plugin --plugin-dir C:/Users/USER/valun-release/hermes-plugin-valun --require circulation/1
   python scripts/check_plugin_core.py C:/Users/USER/valun-release/hermes-plugin-valun
   node --test js/test/
   ```
   Expected, as in readiness section 15:
   - Python: 415 OK;
   - both vector runs: 1461 checks, 1260 agree, 0 disagreements (the plugin run is against the checkout at P1's
     commit);
   - core: unchanged;
   - JS: 509 tests, 508 pass, 0 fail, 1 skipped. Check that the four versions are 0.4.0: python/pyproject.toml, js/package.json, and server.json `version` and
   `packages[0].version`.

**P6. Push valun-open.** Push from the local branch `public`, which tracks `origin/main`; `circulating-credit` is a
fast-forward of it.
```sh
cd C:/Users/USER/valun-open
git fetch origin && git merge-base --is-ancestor origin/main circulating-credit
git switch public && git merge --ff-only circulating-credit && git push origin public:main
gh run list -R fitzss/valun-open --branch main --limit 3          # then: gh run watch <id>; every job green
```
The unpushed diff and commit messages were scanned for machine paths (C:/Users, AppData, /home/valun, scratchpad), and
none were found. The scan was run again for tracker v3.2, with `git log -p origin/main..circulating-credit` at
`6c437e0` and `origin/main..refs/heads/v0.4.0` in the plugin at `17e9be4` (a commit message that named a local venv
path was reworded before that, so the plugin's two newest commits are `e5fb106` and `17e9be4`). It found no machine path. The only match was
the generic phrase "your per-user AppData" in the client's docs. Repeat that scan for the commits P1-P5 add.

**P7. GitHub settings (owner, recommended by audit SC-1).** A ruleset that requires green CI on `v*` tags, and required
reviewers on the `pypi` and `npm` environments.

**P8. Tag valun-open and release.** Tag only a commit whose CI is green. PyPI and npm versions are immutable.
```sh
git tag -a v0.4.0 -m "valun 0.4.0 circulating credit" && git push origin refs/tags/v0.4.0     # valun-open has no v0.4.0 branch; the full ref keeps it unambiguous anyway
gh run list -R fitzss/valun-open --workflow release.yml --limit 1      # verify, then pypi, npm, mcp-registry
```
- **verify:** has no id-token. It checks the versions, the plugin pin and the docs, runs the tests and the vectors, and
  builds the artifact.
- **pypi:** trusted publisher, environment `pypi`.
- **npm:** `npm publish --provenance --access public`, environment `npm`; it skips a version already on npm.
- **mcp-registry:** waits until PyPI serves the `mcp-name: io.github.fitzss/valun` marker, then runs `mcp-publisher
  validate`, `login github-oidc` and `publish`.

**P9. Check from outside.**
- `uvx --no-cache valun@0.4.0 mcp`: the handshake and the nine tools, as for 0.3.1.
- `npm view @fitzdoud/valun@0.4.0 version`, and `npm audit signatures` in a scratch project that installs it.
- The MCP Registry listing for `io.github.fitzss/valun` at 0.4.0.

**P10. Plugin tag (optional) and the catalog PR #150363 update.**
1. Optionally tag the plugin:
   `git -C C:/Users/USER/valun-release/hermes-plugin-valun tag -a v0.4.0 -m "hermes-plugin-valun 0.4.0" $PLUGIN_SHA && git -C C:/Users/USER/valun-release/hermes-plugin-valun push origin refs/tags/v0.4.0` (the full tag ref: the branch has the same name, see P4).
2. Follow CATALOG-UPDATE-0.4.0.md (untracked, in the plugin checkout):
   - put `$PLUGIN_SHA` where `<NEW_SHA>` stands, and re-run its section 6/7 checks at that SHA;
   - in C:/Users/USER/valun-release/hermes-agent-pr (branch `add-valun`; remotes `fork` = fitzss/hermes-agent and
     `origin` = NousResearch), set `plugin-catalog/valun.yaml` `sha:` and `version: "0.4.0"` as in its section 1;
   - run `python scripts/validate_plugin_catalog.py plugin-catalog/valun.yaml`, commit, and `git push fork add-valun`;
   - add the draft's section 2 to the PR body ("Update: 0.4.0"), for example with `gh pr edit 150363 -R
     NousResearch/hermes-agent --body-file <file>`.

   The draft's reviewer test (its section 6, step 3) needs the public server in mode `sandbox` or `on` (step 7).

After P10, record the pushed SHAs, the release run ids and the published versions in the readiness doc.
