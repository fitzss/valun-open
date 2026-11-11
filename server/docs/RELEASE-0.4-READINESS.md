# Valun 0.4 "circulating credit": release readiness

Measured 2026-11-10 (UTC) on the Windows dev machine (Windows 11, WSL `valun-ic1`), task E2E-2 of the final build. Everything here ran
locally: nothing was deployed, pushed, published or posted, and no network service was contacted beyond loopback
servers these runs started. Every figure below is from a run made for this report unless it says otherwise; the logs
are in the session scratchpad of E2E-2 (`e2e2/`; the second round, after verification, in `e2e2a2/`). Deploying, turning circulation on, publishing and opening upstream
PRs remain the owner's decisions (section 7).

**Release v16.1 (section 17, 2026-11-11; local only, not deployed):** the server refuses pilot writes on a downgraded
tracker instead of only alarming (R-18), compacts the edge journal (R-19), and judges next_actions by the payment
routes' own rule; commit `595be89`, with every run of the acceptance list passing there.

**Updated last on 2026-11-10 for tracker v3.2 (section 15):** audit VS-1 is closed at its root, in the tracker, before
0.4.0's signed formats are frozen by a release. The final commits are now valun-app `4032eaa` (code; `lib/` as at
`b7ecca0`) plus this file's commit, valun-open `8aa6586`, the plugin `89a92ed` and tracker v3.2 `4370418` (`basis_server`
`e13d37b4…`, `valun_signer` `dff60f9d…`). Tracker v3.1 (`24675ec`, `cc0a6ade…` / `314beace…`) is superseded and no
longer pinned: on it circulation runs as off. Section 15 has the runs at the final commits and the risk changes (R-17
closed; R-1, R-3, R-22 and owner decision 8 updated). Sections 2-14 keep their measurements as history: they were made
on tracker v3.1, and they say so where it matters.

**Updated 2026-11-10 after the post-audit round (section 14; history):** the final commits were then valun-app `447a103`
(code) plus this file's commit, valun-open `2b4695a` and the plugin `1dbb369` (code `11e7be5`); section 14 has the
re-runs at them on tracker v3.1, including the container rehearsal and memory (R-22) and the vectors regenerated from
the deploy code (R-21).

**Updated 2026-11-10 after the security audit (task PA-DOCS).** Section 1 now lists the final commit of every
repository. Section 11 has the re-runs at those commits (by PA-SV, PA-OPEN and PA-PL), section 12 the audit's 19
confirmed and 5 refuted findings, and section 13 the release steps the fixers flagged. Section 6 has the updated
residual risks. The owner-approved deploy and publishing steps are in docs/DEPLOY-0.4-RUNBOOK.md. Sections 2-5 are
still E2E-2's measurements at the commits it ran, and they say so.

## 1. What was tested

| component | where | measured by E2E-2 (sections 2-5) | final (sections 9-15; section 15 for tracker v3.2) |
|---|---|---|---|
| Valun server v16 | `valun-app`, branch `circulation-v16` | `113eed8` and E2E-2's `c00ade2` and `8622feb` (section 8); this file: `cd409ee` and its update | code: `4032eaa` (on tracker v3.2, section 15: `538075b` V32-SV, `b7ecca0` the pin, `4032eaa` one test; `lib/` is as at `b7ecca0`). Before it: audit fixes `55510a9`, PA-SV `94797c6`, then `fa38334`, `04dc3c8` and `447a103` (section 14), and the docs commit `9bbfe48`. This file's last update: the commit on top of `4032eaa` (docs only) |
| valun 0.4.0 (Python), @fitzdoud/valun 0.4.0 (JS), spec | `valun-open`, branch `circulating-credit` | `03120fd` | `8aa658633b796347f020fbbc824d33f525b77e92` (tracker v3.2, section 15: `2aa318a`, `836750a`, `3f3265b`, `61d26fb`, `8aa6586`; the client sources are as at `836750a`). Before it: `2b4695a` (AUDIT `a6340b8` … `17729e0`, PA-OPEN `6ed0e76`, `0ed93c2`, `2b3b0fc`, then `40cd04c`, `f4017c4`, `e4e53a6`, `2b4695a`: section 14) |
| hermes-plugin-valun 0.4.0 | `valun-release/hermes-plugin-valun`, branch `v0.4.0` | `d0f053e` | `89a92ed36a1ebad62d2dbec61976efe1bb42b2d1` (tracker v3.2, section 15: `84f8b43` the core copied again, `ecbe0bc` test fixtures, `89a92ed` the changelog; the plugin's own code is unchanged). Before it: `1dbb369` (AUDIT `c00c47b`, `8d30d04`, PA-PL `366b4b7`, `553f536`, `2e716f8`, then `11e7be5` and `1dbb369`: section 14). Its `valun_core` is byte-identical to valun-open `836750a` `python/src/valun` (8 modules; unchanged at `8aa6586`) |
| tracker v3.2 | Basis fork, branch `circulating-credit-v3.2` (WSL `valun-ic1`, worktree `ROOT/v32`) | (not measured by E2E-2) | `43704183e1ba372e1b1788c414dfe4c8b0bc3f2a`; `basis_server` sha256 `e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5`, `valun_signer` sha256 `dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a` (section 15) |
| tracker v3.1 (superseded) | Basis fork, branch `circulating-credit-v3` (WSL `valun-ic1`, worktree `ROOT/v3`) | `24675ec1c0f374f29101812caf2fc87ab48468c9`; `basis_server` sha256 `cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8`, `valun_signer` sha256 `314beace9ca1d30d69384ee729b99492075f09b0b4032e52d49d30703ae46700` | superseded by tracker v3.2 and no longer pinned: it reports build `valun-circulating-credit/3`, which `lib/pilot/caps.mjs` refuses, so circulation runs as off on it. It was never deployed. (Sections 2-14 ran on it: no tracker change between E2E-2 and section 14.) |
| tracker in production today | Basis `3df7ed93` | `basis_server` `2ab041f7ced2c8b2b0762ec32bd26b89d953a9bc59a939d57a66e08151aac74b`, `valun_signer` `8d7bb6eae99d681439a33bce41f2b6444e2731d9d124aba33d35199d8af3da01` | unchanged |
| server in production today | release v15, `valun-app` `729a4c1` (branch `main`) | | unchanged: nothing was deployed |

Nothing is pushed. `valun-app` has no git remote: it is deployed from this checkout with `fly deploy`. `valun-open`
`circulating-credit` is 42 commits ahead of `origin/main` (`c75cfb0`). The plugin's `v0.4.0` is 19 commits ahead of
`origin/main` (`5d01fbd`, plugin 0.3.0). Both are fast-forwards (counted again for section 15 from the local refs,
without a fetch).

Staged binaries: tracker v3.2 in `/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release` (signer under
`examples/`; sha256 read again from the staged files when section 15 was written: `e13d37b4…`, `dff60f9d…`), the
3df7ed93 pair in `/home/valun/valun-app-bins-20261105T024815Z/t/release`. The superseded v3.1 pair is still staged in
`/home/valun/valun-app-bins-v3.1-20261108T121350Z/t/release`; nothing uses it now. Runtimes: Node v24.21.0 (Windows
and the WSL rehearsal; the image uses `node:24-trixie-slim`), Python 3.14.7.

`dist/bin/` (what `fly deploy` ships) holds the **3df7ed93** pair. History (E2E-2 and PA-DOCS, tracker v3.1): the v3.1
pair was copied in for E2E-2's first rehearsal (sha256 checked on both sides) and the original files were put back
afterwards (sha256 checked). `dist/` is not tracked by git. The second round's rehearsals (section 5) ran from a scratch
copy (`git archive` of `8622feb`) with the v3.1 pair in the copy's `dist/bin` (sha256 checked on both sides:
`cc0a6ade…`, `314beace…`), so the repository's `dist/bin` was not touched again; PA-DOCS read both again without
changing them. The tracker v3.2 rehearsals (section 15) also ran from scratch copies, with the v3.2 pair in the copy's
`dist/bin` (`e13d37b4…` / `dff60f9d…`). Read again when section 15 was written: `dist/bin` still holds `2ab041f7…` /
`8d7bb6ea…` (3df7ed93). Putting the v3.2 pair there is runbook step 4.

## 2. Test suites

This section has E2E-2's runs, at the commits in section 1's middle column, on tracker v3.1 (history: v3.1 is
superseded). Sections 11 and 14 have the re-runs after the audit, still on v3.1, and section 15 the runs on tracker v3.2
at the final commits, the tracker's own suites included. The skipped tests below needed tracker v3.1 then; they need
tracker v3.2 now.

| suite | command (short) | result |
|---|---|---|
| server, tracker v3.1 | `VALUN_BINS=<v3.1> npm test` (Windows app, WSL trackers) | 330 tests: 328 pass, 0 fail, 0 skipped, 2 todo; exit 0 (at `c00ade2`, and again at `8622feb`, 348 s) |
| server, tracker 3df7ed93 | `VALUN_BINS=<3df7ed93> npm test` | 330 tests: 233 pass, 0 fail, 95 skipped (need tracker v3.1), 2 todo; exit 0 (at `c00ade2`; `8622feb` changes only a test these binaries skip) |
| server, container rehearsal (Linux) | `node scripts/rehearse-container.mjs` with the v3.1 pair in `dist/bin`: first round at `c00ade2` (3 full runs, 1 `--tests-only`); second round at `8622feb` (3 full runs, 2 `--tests-only`) | first round: each run 330 tests, 318 pass, 0 fail, 0 cancelled, 10 skipped (files the image does not copy), 2 todo. **The verification run at `c00ade2` then gave 317 pass, 1 fail**: an intermittent test failure on Linux, fixed in the test (section 2.2). Second round: each full run 330 tests, 318 pass, 0 fail, 0 cancelled, 10 skipped, 2 todo; each `--tests-only` 318 pass, 0 fail, exit 0 |
| Python client | `.venv/Scripts/python -B -m unittest discover -s python/tests` | 385 tests OK |
| JS client | `node --test test/` in `valun-open/js` | 486 tests: 485 pass, 0 fail, 1 skipped (POSIX file modes, Windows) |
| spec vectors, package | `check_python.py --client package --require circulation/1` | 1386 checks: 1188 agree, 0 disagreements in failing tiers, 17 informative, 181 n/a; exit 0 |
| spec vectors, plugin | `check_python.py --client plugin --plugin-dir <plugin> --require circulation/1` | same counts; exit 0 |
| plugin core | `scripts/check_plugin_core.py <plugin>` | valun_core is valun 0.4.0, unchanged (8 files); exit 0 |
| Hermes plugin | `python -B -m unittest discover -s tests` | system Python: 140 tests OK (1 skipped: needs Hermes); Hermes venv: 140 tests OK |
| tracker v3.1 | `cargo test --offline -p basis_store` and `-p basis_server` at `24675ec` | see section 2.1 |
| tracker e2e drivers | `e2e/driver.py --bin <v3.1>`, `e2e/mig_driver.py run --old <3df7ed93> --new <v3.1>` | see section 2.1 |

The 2 todo tests are the documented adversarial findings F1 (original repro, kept; fixed in three layers) and F3
(open design question; docs/ADVERSARIAL-FINDINGS.md). They are counted as todo, not as passes.

### 2.1 Tracker

History: tracker v3.1. Tracker v3.2's suites and drivers at `4370418` are in section 15.

Rerun for this report in WSL at the worktree HEAD `24675ec` (no tracker change in this round; `git status` the same
before and after: the uncommitted Cargo.toml path edit and the untracked signer example, as recorded in basis/BUILD.md),
rust 1.98.1, `--offline`:

- `cargo test -p basis_store`: 353 passed, 0 failed, 3 ignored (network-only tests, `#[ignore]`d upstream; never run
  with `--ignored`).
- `cargo test -p basis_server`: 350 passed, 0 failed, 0 ignored, over 21 result lines (lib, main, the integration test
  binaries and doc-tests).
- `e2e/driver.py` against the staged v3.1 `basis_server` (sha256 checked by the driver, `EXPECT_COMMIT=24675ec…`, port
  3161, the release `seed_onchain_confirmation` for the pure_credit startup refusals): 196 passed, 0 failed, 0 skipped.
  (Without the seed tool: 190 passed, 1 skipped.)
- `e2e/mig_driver.py run --old <3df7ed93> --new <v3.1>`: 100 passed, 0 failed.

These equal TR-7's counts at the same commit. Scratch run folders were removed by the drivers.

### 2.2 An intermittent test failure on Linux (found in verification, fixed)

The independent verification of the first round ran the full rehearsal once more and got **317 pass, 1 fail**:
`test/setoff.test.mjs:890`, "two set-offs that share an edge between server-run members ...", at the assertion that
`pilot.recover()` applies S1 and then S2 (it returned only S1). Two `--tests-only` reruns there passed 318/0, and every
Windows run passed, so the first round's "0 fail" was true of those runs but the test was not reliable on Linux.

- **Cause (in the test, not the server).** S2's server-only edge X>M needs a timestamp with residue 998 ms, at least
  `TIMESTAMP_LAG_MS` (1500 ms) behind the clock and later than every set-off timestamp on X>M, S1's included. Such a
  timestamp exists only about a second after S1's was chosen; until then the server rightly defers S2
  (`refreshSetoff` returns `'waiting'` and the clearing engine retries it). On Windows the steps between take longer
  than that; on Linux they often do not.
- **Fix (`8622feb`, test only).** Before `recover()`, the test waits until the server's own rule
  (`novationTimestamp({now, residue: 998, after: max(edge timestamp, lastSetoffTimestamp(X>M))})`) yields a timestamp.
  Every assertion is kept (S1 applied before S2, S2 at the edge's state after S1, no alarm). No server code changed.
- **Evidence.** That test alone in WSL (`BASIS_RUNNER=direct`, copies of the v3.1 pair): without the fix **6 of 6 runs
  failed** (`S1 first, then S2: ["vs_…:applied"]`; the verifier saw 5 of 8), with it **12 of 12 passed**; the whole
  `test/setoff.test.mjs` with the fix in WSL 4 of 4 runs, 29 of 29 tests each; on Windows the test passes, and the full
  `npm test` at `8622feb` gave 330 / 328 pass / 0 fail / 2 todo. The second round of rehearsals (sections 2 and 5)
  then ran the whole Linux test list five times (3 full runs, 2 `--tests-only`): 318 pass, 0 fail each.

## 3. Tracker compatibility (opt-in test, on copies)

History: measured on tracker v3.1. The same test from 3df7ed93 to tracker v3.2 passed 6 of 6 (section 15).

`VALUN_OLD_BINS=<3df7ed93> VALUN_NEW_BINS=<v3.1> node --test test/tracker-compat.test.mjs`: **6 tests, 6 pass, 0 fail**
(24.8 s; one tracker process at a time; its WSL run folder was removed afterwards).

- (a) seeded through Valun on the 3df7ed93 binary: the pilot (token: several pairs, out-of-order updates, a note at 999
  ms, a 0-total first note then raised) and the demo desk (erg: offers issued out of order, a 0-total first note, two
  acceptance policies);
- (b) the old binary restarted on the same folder: every note, list, policy and key status as before; `local_digest`
  `db60a9f2…` live and after the restart (the reference);
- (c) a copy opened by tracker v3.1 (scanner layout, `pure_credit`): every field identical, the digest equal to the
  reference; Valun reads the same ledger and reconciliation;
- (d) on v3.1 with circulation `on`: bound notes on migrated edges, a payment by transfer of a migrated note, a set-off
  of migrated edges (4 edges, 11 PC); 5 of 10 notes written on v3.1; digest `2e06d903…` after the writes and after a
  restart; every edge reconciles exactly;
- (e) a copy of the v3.1-written folder opened by the 3df7ed93 binary (node layout): the same notes, lists, policies,
  key status and digest; Valun reads the same ledger through it.

So both directions pass: 3df7ed93 data opens on v3.1 unchanged, and v3.1-written data opens on 3df7ed93. The data was
synthetic seed data, not a copy of the live volume (section 6, R-2). The seed data is made anew on every run, so the two
digests differ from run to run (the independent verification run gave `ac7285a1…` and `2190f3e7…`, 6 of 6 pass, 23.7 s);
what repeats is the result: within each run, every digest equals that run's reference.

## 4. Soak in circulation mode

History: measured on tracker v3.1. The soak on tracker v3.2 (seed 20261107) is in section 15.

`SOAK_CIRCULATION=1 SOAK_SEED=<seed> VALUN_BINS=<v3.1> node --test test/soak.test.mjs` (`test/soak.test.mjs` sha256
`406595e7…`, unchanged). 600 random actions each, by 12 participants and the sandbox agents, eight at a time, with
fault injection (crashes before and after tracker calls), clock jumps past the TTLs and the D-1 fallback windows,
refusals, cancellations, held notes, owner resolutions both ways and a key rotation. After every action it checks I1
(no 5xx except the 502 of an injected crash), I2' (tracker total = journal's expected total on every touched edge), I3,
I6 (set-offs net-neutral), I7 (no unapplied transfer or set-off signature in any response, to anyone), I8 (nets sum to
0), I9, I10 (per-issuer caps), I11 (at most one payment per deal) and R (the server never asks a 0.4 client to sign what
its firewall refuses); at the end every edge and the edge journal file (seqs 1..edge_seq) are checked strictly.

| seed | result | wall | invariant checks | responses scanned | novation signatures followed (seen in responses, each after apply) | journal entries | transfers | set-offs | refused attempts | held notes | expected 502s | alarms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 20261107 (default) | pass | 155 s | 614 | 1228 | 91 (85) | 94 | applied 6, resolved not applied 1, void key revoked 1, refused 1, expired 1 | applied 3, refused 2, expired 1 | 5 | 6 | 3 | 3 |
| 4242 | pass | 153 s | 615 | 1220 | 95 (94) | 83 | applied 4, resolved not applied 2, void key revoked 2, refused 2, expired 1 | applied 4, refused 3 | 8 | 14 | 5 | 4 |
| 909091 | pass | 158 s | 616 | 1274 | 116 (137) | 100 | applied 9, resolved not applied 2, void key revoked 1, refused 1 | applied 4, superseded 1, refused 1, void key revoked 1, collecting 1 | 5 | 12 | 5 | 5 |

The counts in this table are one run's. A seed fixes the mix of actions, not their interleaving (eight run at a time),
so the counts vary between runs with the same seed; what repeats is the pass/fail result and the invariants. The
independent verification run, for example, gave 615 / 1203 / 120 / 105 (checks / responses / signatures / journal
entries) for 20261107, 614 / 1227 / 93 / 83 for 4242 and 616 / 1328 / 204 / 110 for 909091, all pass, no violation.

Deals at the end, default seed: 74 note_issued, 6 paid_by_transfer, 19 disputed, 18 declined, 4 rejected_by_owner, 3
agreed, 2 delivered, 1 cancelled, 1 payment_due. The alarms are the server's ALARM log lines, all during injected
faults; the soak passes with them (they are what an operator would see).

## 5. Container rehearsal and memory

History: E2E-2's rehearsals on tracker v3.1. Section 14 measured it again at `447a103` (still v3.1), and section 15 on
tracker v3.2 (`b7ecca0`, and the Linux suite again at `4032eaa`).

`PILOT_CIRCULATION=on PILOT_OPEN_SANDBOX=1 NODE_OPTIONS=--max-old-space-size=128 node scripts/rehearse-container.mjs`
with the v3.1 pair in `dist/bin` (first round: the repository's, at `c00ade2`; second round: a scratch copy of `8622feb`,
section 1). It stages the image's files in WSL, runs the Linux test list there (section 2), then
starts `docker-entrypoint.sh` on 127.0.0.1:8090 with both trackers (demo 3050, pilot 3060) and `VALUN_DEPLOYMENT=hosted`.
NODE_OPTIONS and PILOT_OPEN_SANDBOX are fly.toml's values; PILOT_CIRCULATION=on is not in fly.toml (circulation is off
by default). The entrypoint computed the binary's own sha256 (`cc0a6ade…`), the app logged `circulating credit: on`,
`/pilot/v1/info` listed `bound_notes/1` and `circulation/1`, and `/api/status` `basis.pin` named tracker v3.1 at fork
commit `24675ec…` with no "(binary not pinned)". The demo world was seeded as in production (no `VALUN_SEED`).

Load while measuring: `node scripts/e2e-python-client.mjs --base http://127.0.0.1:8090 --modes on --only
tour,calls,probes` from Windows: the five-step stranger tour of design 9.2 with the real 0.4 CLI, then the scripted tool
calls and the probes (owner approvals, a held and rejected payment by transfer, a same-issuer retry, a payment to the
client by transfer, the D-2 d resolve route). RSS was sampled every 0.5 s from `/proc` (VmRSS), and the peak (VmHWM)
and PSS of the three long-lived processes were read just before the stop.

| run | idle before the load (total) | peak during the load: app / demo tracker / pilot tracker / shells / total | VmHWM app / demo / pilot | PSS app / demo / pilot |
|---|---|---|---|---|
| 1 | 116.8 MiB | 99.6 / 13.9 / 14.7 / 3.5 / **131.5 MiB** | 99.1 / 13.8 / 14.7 MiB | 89.1 / 7.7 / 8.7 MiB |
| 2 | 116.9 MiB | 96.7 / 14.1 / 14.5 / 3.5 / **128.7 MiB** | 96.4 / 13.9 / 14.5 MiB | 94.4 / 7.9 / 8.5 MiB |
| 3 | 117.0 MiB | 98.9 / 14.2 / 14.2 / 3.5 / **130.4 MiB** | 98.3 / 13.9 / 14.2 MiB | 96.3 / 7.9 / 8.2 MiB |
| 4 (second round) | 116.3 MiB | 99.0 / 14.2 / 14.4 / 3.5 / **131.0 MiB** | 99.0 / 14.1 / 14.4 MiB | 96.5 / 7.9 / 8.2 MiB |
| 5 (second round) | 115.9 MiB | 97.4 / 13.8 / 14.6 / 3.5 / **129.3 MiB** | 96.8 / 13.8 / 14.6 MiB | 94.9 / 7.7 / 8.6 MiB |
| 6 (second round) | 117.0 MiB | 97.4 / 14.0 / 14.6 / 3.5 / **129.4 MiB** | 97.0 / 14.0 / 14.6 MiB | 95.0 / 7.8 / 8.5 MiB |

The idle figure is the highest total sampled in the 30 s before the load. VmHWM can read slightly below the sampled peak
(in five of the six runs): the kernel updates the high-water mark lazily, and V8 returns pages with madvise, so the sampled peak is
the figure to use. The independent verification run (first round's code, its own sampler) gave 116.7 MiB idle and a
129.1 MiB peak total (VmHWM app 97.0, trackers 13.8 and 14.4, shell 3.5 MiB).

`valun_signer` runs as a short child per signature and was never caught by the 0.5 s sampler; measured on its own with
`/usr/bin/time` (throwaway key): 2.5 MiB peak, under 10 ms. In the minute after the load the app stayed at 91-98 MiB
(V8 does not hand the heap back at once).

**Headroom on the 256 MB Fly machine.** The measured peak of everything the container runs is at most 131.5 MiB over
the six runs (129.3-131.0 MiB in the second round), about 51% of 256 MiB (268 MB), leaving about 124 MiB, plus the 256 MB swap fly.toml configures. Not measured here: the Fly VM's own
kernel and init, a heap grown over days of real traffic (the app's old space is capped at 128 MiB by NODE_OPTIONS, so
the app's heap could in principle grow toward that cap, plus what Node keeps outside the old space), and state that grows
until the 7-day and 30-day pruning (section 6, R-6). On these numbers the machine leaves headroom for 0.4 with
circulation on at pilot scale; watch the Fly memory metrics after any flag change.

**Result of the end-to-end checks against the rehearsal.** The tour itself completed in all three runs (`valun
sandbox tour --yes` exit 0, every step's own edges and money view exact, every reconciliation row match and exact).

- Run 1: 119 checks ok, 4 FAIL. All four came from one race in the check script, not from the server: the tour prints
  "step 5 done" once the client's own edges are final, and the server-only 2-cycle X<->M of step 5 is applied by the
  server right after (the server's record: proposed 04:15:22.283, applied 04:15:22.544, 173 ms after that line), while
  the script's ledger read was under way. The script now checks the client's own edges in that first snapshot strictly
  and re-reads the public ledger (at most 20 s) until all six totals are design 9.2's, and re-reads `GET /clearing` (cached
  for 10 s) while it lacks that set-off. Run 2 hit the same race and passed with it (cleared 265 ms after the first
  snapshot); run 3 did not hit it.
- Runs 2 and 3: 126 and 122 checks ok, **2 FAIL each, the same two**: "valun attempts list: the approved retry applied;
  the rejected transfer is not counted as the payment" and "Client.resolution_plan: ... matches both records". This is
  a real, value-safe finding (section 6, R-1): the probe's same-issuer retry after the owner rejected the first transfer
  got the **same edge and timestamp T** as the rejected attempt (the client's records show one signed slot at that T);
  the client's firewall allows an identical re-signature (R4), and its attempt record kept the rejected transfer's server
  id (`void_rejected` at the server) and reports it as "applied: the deal is paid by it", while the applied retry's server
  id is in no client record. Run 1 passed both checks (there the retry got a later T), and E2E-1's runs with the server
  on Windows passed them; it depends on whether the two templates fall in the same timestamp window.
- Second round (at `8622feb`, from the scratch copy): the tour completed in all three runs. Run 4: 132 checks ok, 0 FAIL,
  exit 0 (the step-5 race seen and handled: cleared 261 ms after the first snapshot). Run 5: 126 ok, **2 FAIL, the same
  two R-1 checks** (the rejected attempt and the retry were both signed for T 05:55:43 UTC, and the client's one record
  names the rejected transfer's id as applied), exit 1. Run 6: 136 ok, 0 FAIL, exit 0 (race seen, 262 ms). The
  verification run gave 124 ok, 0 FAIL. So R-1 showed in 3 of the 7 rehearsal runs, and only there; nothing else
  failed. The number of checks differs between runs because some checks run only on the path a run takes (for
  example which sandbox deals are delivered while the calls run).
- The changed script on its own stack (`--modes on --only tour,calls,probes`: server on Windows, fresh v3.1 trackers in
  WSL): run on PASS, 132 checks ok, 0 FAIL, exit 0. E2E-1's full five-run result (378 checks ok, 0 FAIL) is the
  reference for the other parts (MCP tour, JS client, Hermes dispatch path, clock and tracker faults); they were not
  rerun here.

## 6. Residual risks and mitigations

| | risk | mitigation / state |
|---|---|---|
| R-1 | (found here) A same-issuer retry of a payment by transfer whose first attempt the owner rejected can get the same (edge, T) as that attempt. The client then keeps one attempt record naming the rejected transfer's server id as applied; `valun attempts list` and `resolution_plan` cannot name the applied transfer. No value is at risk: both attempts are the identical signed operation at the same (edge, T), and the tracker can apply it once; the client judges by tracker state and the deal is marked paid once. Cause, confirmed by reading the code: the server's `transferTemplate` (lib/pilot/core.mjs) computes `after` without the deal's ended (`void_rejected`) attempts, and the client's `apply_write_ahead` (valun-open python/src/valun/novation.py) dedups attempts on (route, edge, prior, total, timestamp), keeping the first record's server id. It shows only when both templates fall in the same timestamp window: seen in 3 of the 7 rehearsal runs (first round 2 of 3, the verification run 0 of 1, second round 1 of 3) and in none of the runs with the server on Windows. | Fixed on the server after this report (section 9): a template's T is later than every earlier payment attempt of the deal (`transferAfter` includes them), and a post at or before one is `409 transfer_stale`; test/audit-fixes.test.mjs "R-1" fails without it. Since PA-SV (section 10), a same-issuer retry after a rejected attempt also waits for that attempt's window, so the probe that showed R-1 no longer makes one. The e2e probes then paid a second deal instead, and the full e2e run at `94797c6` passed (441 checks, 0 FAIL; section 11). **Since tracker v3.2 (section 15)** a same-issuer retry on the same prior state is allowed at once again (the same-prior exemption), and the e2e probes make one again after the owner's rejection: it is a new transfer with its own server id, held and rejected too, and `valun attempts list` lists both attempts of that deal and takes neither as its payment. That check passed in the five e2e runs at `4032eaa` (411 checks, 0 FAIL) and in the container rehearsal at `b7ecca0` (149 checks, 0 FAIL). The client's dedup (valun-open) is unchanged. |
| R-2 | The compatibility test used synthetic seeded data, not a copy of the live volume. | Take a Fly volume snapshot before any tracker change (design 12.4); the owner may run the compat test on a copy of the live tracker folders (needs fetching live data: owner decision). With the flag off, v16 keeps v15 behaviour on tracker v3.2, as it did on v3.1: test/circulation-identity.test.mjs checks it against a real tracker and passes in `VALUN_BINS=<v3.2> npm test` (section 15). The compat test passed from 3df7ed93 to tracker v3.2 too (section 15, synthetic data). |
| R-3 | Memory beyond the rehearsal: Fly VM overhead, heap growth over days, state before pruning. | Peaks measured: 128.3 MiB on tracker v3.2 (section 15); 128.7-131.5 MiB on v3.1 (sections 5 and 14). Swap 256 MB; `--max-old-space-size=128`; records pruned after 7 / 30 days; watch Fly metrics, especially after `sandbox` and `on`. |
| R-4 | An incomplete edge journal (D-3 d) can only be repaired by restoring pilot-edge-log.jsonl with pilot-state.json; a log with entries after counters.edge_seq is not detected (FX3-SV). | The server treats a partial journal as proving nothing dead (D-3 d); back up and restore the two files together. |
| R-5 | D-3 b: a client that withdraws its consent roles does not end set-offs and transfers already collecting for its signature; they expire unsigned after 30 / 20 minutes. | Documented; liveness only, nothing moves without every signature. |
| R-6 | Records that did not apply are kept 7 days, applied ones keep signatures 30 days; the journal tail is capped. | As designed (design 11); measure state size before `on`. |
| R-7 | Design 10.3: a payer colluding with the server can still underpay a payee on the credit-note path; the operator can mint sandbox notes; a modified tracker is outside the trust model; clock skew above 2 minutes weakens R11; old profile backups lose R4/R12 records. | Bound-note receipts, transfers protect the payee fully, sandbox notes labelled operator_run, residue evidence, the tracker's bound-only edges; stated in the spec and READMEs. |
| R-8 | Adversarial finding F3 (open design): coverage counts claims from any issuer. | Documented in docs/ADVERSARIAL-FINDINGS.md; kept as a todo test. |
| R-9 | Not covered end to end (E2E-1): a full owner resolution of an `outcome_unknown` attempt (only the route's refusals). Transfer regeneration no longer exists (section 10). | Covered by unit and HTTP tests and the soak (owner resolutions both ways). |
| R-10 | The owner console has not been seen in a real browser (tested through a minimal DOM). | Look at it once before `on`. |
| R-11 | Plugin: approvals are bound by tool name and exact arguments (two identical commitment calls in one batch, or a hook past Hermes's 30 s timeout, can swap snapshots); Hermes's Plugins page misreads the dotted `consents.*` keys; in a home Hermes reports as `default`, printed commands say `hermes -p default`. | Documented in the plugin README; `hermes valun status` is the reference; upstream Hermes issue not reported (posting is an owner step). |
| R-12 | Client texts: doctor's FIX for a revoked agent names `enroll`, which refuses while the old key is stored; two tool texts name `valun config` without a profile; `valun config consents.max_PC ²` raises ValueError. | Pre-existing, minor; open in valun-open. |
| R-13 | Spec text: `sandbox_next_steps.tour_step` can go back while a step is in progress; a client may stay stricter than the server's D-1 `fallback_after` (Python: T + 1 h + 2 min vs the server's T + 1 h + 60 s). | Spec wording (E2E-1); no behaviour change needed. |
| R-15 | Limits of what "soak passes" shows (recorded by SV-10's verifier): the workload never tries a second payment while a deal's first payment is still live; the I9 case (a set-off revoked) runs only when the random mix happens to produce it; and the end assertions require only one applied set-off. | These paths are covered by the HTTP tests against a real tracker: test/transfer.test.mjs (e), (f), D-1 and D-2 b (a second payment while one is live is refused until its window ends, except, since tracker v3.2, a same-prior retry; two attempts through one issuer apply at most once), test/setoff.test.mjs (a revoked key voids a collecting set-off; several set-offs applied in one test), test/clearing-engine.test.mjs; a follow-up soak workload that forces a concurrent second payment, a set-off revocation and several applied set-offs per run would close the gap. |
| R-16 | (found in verification) Timing-dependent tests: one set-off test assumed a fresh 998 ms timestamp was already available when recovery ran, which holds on Windows but not on a faster Linux run (section 2.2). | Fixed in the test (it now waits by the server's own timestamp rule); the server was right to defer. Other tests that use wall-clock time could hide the same kind of assumption; the WSL rehearsal (Linux timing) is the place they show, so rerun it before a deploy. |
| R-17 | **Closed by tracker v3.2 (section 15).** History, as written for tracker v3.1: (audit VS-1, section 10) The tracker's root cause is unchanged: a transfer's creditor prior acknowledgments carry no prior timestamp, so the server and the 0.4.0 clients keep a deal to one live transfer attempt at a time instead (a same-issuer retry at a new T waits for the earlier attempt's window). Not implemented: the issuer-side twin in the clients (an issuer that co-signs a transfer keeps the new totals, not the prior totals or the amount, so it cannot refuse a later note or novation that brings an edge back to a live transfer's prior). Liveness cost: after any transfer attempt that did not apply, every new payment of the deal waits until T + 1 h + 60 s (clients: + 2 min) unless Valun's edge journal proves the attempt dead; the server no longer makes a transfer again after an edge change. | Then (tracker v3.1): value-safe while the payer's client is a 0.4.0 client with its attempt records: only that client stops the second same-issuer attempt at the tracker. A modified client, or one restored from a backup without its attempt records, can still sign it, and tracker v3.1 will not refuse it (spec 16.2 item 12, valun-open `0ed93c2`). Open then: tracker v3.2 (bind the creditor prior acknowledgments to the prior state's timestamp) and the issuer-side twin in valun-open. The design's overstatement is corrected in its ERRATA section (E-1 to E-3). **Now:** tracker v3.2's prior acknowledgment PA binds the edge's prior total and timestamp, and an edge's (total, timestamp) state never recurs, so attempts on the same prior exclude each other at the tracker, whatever client signed them (a modified or restored client included). A bound note's `prior_signature` is PA too, so the issuer-side twin is no longer needed. The liveness cost is gone for a same-prior retry (section 15); other new payments still wait for the window. |
| R-14 | Rehearsal hygiene: if `wsl.exe` is killed abruptly, trackers the entrypoint started can keep running; 14 staging folders from earlier tasks remain under /home/valun. | Stop the rehearsal with SIGTERM to the entrypoint (done here: staging folder removed, ports free); the old folders are left for the owner. |
| R-18 | (audit MIG-1, merged with MIG-2; fix `55510a9`) **Alarm only, no refusal.** An implicit tracker downgrade starts the 3df7ed93 binary on a volume where circulation ran. That can be an image rollback, or a redeploy from a checkout whose untracked `dist/bin` holds 3df7ed93. That binary has no maximum age and no bound-only edges, so it would apply kept bound-note and novated-edge note signatures that v16 counts as dead. A v16 server whose pilot tracker reports no capabilities raises one `ALARM` and audits `pilot.revivable_signatures {notes, deals, novations}`. It still accepts pilot writes: refusing them would change mode-off behaviour on 3df7ed93. | The downgrade check purges every unapplied note signature (its backup keeps them). Never start the 3df7ed93 binary on such a volume without the drain and the maintenance-mode downgrade check (runbook R1-R4). Check `dist/bin`'s sha256 before every `fly deploy` (runbook step 4), and treat an `ALARM ... revivable` log line as stop-and-roll-forward: put the tracker v3.2 pair back (runbook M, item 3). |
| R-19 | (audit SV-ROB-1, part not done) `pilot-edge-log.jsonl` is never compacted or rotated. Startup streams it, and the per-process index costs about 50 bytes an entry. The startup scan and the index still grow with the file. 150 000 entries (86 MiB) took about 1 s and left a 50 MiB heap under `--max-old-space-size=128` in the fixer's test, and the volume is 1 GB. | Compaction needs a protocol answer for a `since` before a checkpoint (spec 18.14 lets a client page from `since=0`). Watch the file's size (`ls -l /data/pilot/pilot-edge-log.jsonl`, runbook M) and the startup time after restarts. |
| R-20 | Other audit leftovers (section 12). SV-ROB-2: no reuse of one snapshot per engine tick (measured lock time 15-29 ms per poll at 1 001 participants and 3 000 edges). AI-1: three sub-items. SC-1: no hash pinning of `build` / `setuptools` (needs PyPI hashes, no network here), and the rulesets requiring green CI on tags and the environment reviewers are owner steps. SC-2: the plugin's secret still reaches the child Hermes process through its environment (readable by the same user and root). | Documented by each fixer; none moves value. SC-1's token exposure is removed (build tooling runs only in the verify job, which has no id-token). |
| R-21 | **Closed (section 14).** The conformance vectors were pinned to server `cfe698b`, not to the code that will be deployed. valun-open `f4017c4` regenerated them from valun-app `fa38334`, whose server sources (`lib/`) are the deploy commit's (`94797c6`'s): `transcript.json` changed in the 15 steps PA-DOCS found (199, 203-205, 211-215, 222-224, 228-230), the six other files only in `meta`; both clients pass the new set. | If a later deploy commit changes `lib/`, regenerate (runbook P2). |
| R-22 | Partly closed (sections 14 and 15): the container rehearsal and memory were measured again at `447a103` on tracker v3.1 (one full run: peak 129.1 MiB for everything, as before), and the e2e script's five runs passed there; on tracker v3.2, the full rehearsal at `b7ecca0` (peak 128.3 MiB), the Linux suite again at `4032eaa` (346 pass, 0 fail) and the e2e script's five runs at `4032eaa` passed (section 15). Still open: the Fly maintenance procedure (MIG-3) has not been run on Fly, and the rehearsal on a copy of the live volume (runbook step 3) has not run. After a same-claim payment of a second deal, the client still prints "MAY HAVE APPLIED" for an attempt the server ended (`void_rejected`), because it does not read the server's ended state (a valun-open follow-up). | Runbook step 3 rehearses the deploy and the rollback on a copy of the live volume. The client text is liveness only: the owner's resolution is against the client's records. |

## 7. Owner decisions still open

1. **Deploy (v16 with tracker v3.2).** The steps are in docs/DEPLOY-0.4-RUNBOOK.md, each marked APPROVAL REQUIRED:
   - record the live state and take a Fly volume snapshot (steps 0 and 1);
   - re-run the local checks at the deploy commit (step 2), and rehearse on a copy of the live volume (step 3);
   - copy the tracker v3.2 pair into `dist/bin/` and check `e13d37b4…` and `dff60f9d…` (step 4);
   - deploy with `PILOT_CIRCULATION` unset (off) and check byte identity, the pin, persistence and memory (step 5).

   The rollback for each step is next to it, and in section R of the runbook. That section follows docs/PILOT-API.md
   (Operations, "Rollback to release v15").
2. **Flag rollout.** `off` -> `bound` -> `sandbox` -> `on` (design 12.4; runbook steps 6-8), with a volume snapshot before
   each change, checks and a go/no-go after it, and the Fly memory figures (runbook M). PILOT_OPEN_SANDBOX=1 is already
   in fly.toml.
3. **Sandbox numbers.** The live bounds: 200 self-serve joins a day and 3 per address an hour, the 20 PC earn cap, 3
   purchases per stranger a day, 3 welcome jobs a tick, sandbox-exact's 1000 PC `max_issue_outstanding`; and the open
   decision on bounding `deliver_by` for sandbox purchases (for example 48 hours).
4. **Downgrade check and `d.payment`.** Whether `scripts/pilot-downgrade-check.mjs` should set a v16 deal's `payment`
   record aside (and v16 restore it); until then keep its backup.
5. **R-1.** Fixed on the server (section 9). Section 10 made a same-issuer retry wait for the earlier attempt's window;
   since tracker v3.2 (section 15) a same-prior retry is at once again, and the e2e probes show that it gets its own
   transfer and server id. Whether the client should also record a second server id for an identical re-signature is
   open in valun-open.
6. **Publishing.** The steps are in runbook section P:
   - valun 0.4.0 to PyPI, and @fitzdoud/valun 0.4.0 to npm (trusted publisher);
   - the MCP Registry entry;
   - the plugin push, and optionally a hermes-plugin-valun v0.4.0 tag;
   - the valun-open push (its CI pins the plugin's pushed SHA);
   - the release steps in section 13.

   Nothing is pushed.
7. **Upstream PRs.** Updating the Hermes catalog PR #150363 from 0.3.0 to 0.4.0 (a draft is in the plugin checkout,
   untracked, from another task); reporting the Hermes `consents.*` settings issue; whether to offer the Basis fork
   (tracker v3.2, branch `circulating-credit-v3.2`) upstream (see TR-14 in section 15 first).
8. **Payment timing after a failed transfer (audit VS-1, sections 10 and 15).** Section 10 (tracker v3.1) overrode the
   earlier decision "retries with the same issuer are allowed at once" on both sides. **Updated for tracker v3.2:** a
   same-prior retry is at once again, on the server and in the 0.4.0 clients (R11): a new attempt through the same note
   that acknowledges the same prior state of the edge it changes first is not held back, because the tracker lets at
   most one attempt on a prior state apply. That covers a refused, expired, cancelled or owner-rejected attempt whose
   edges did not move. Every other case still waits for the earlier attempt's window: another issuer, another kind of
   payment (an own note), or the same note after its edge moved (a new prior). The server still makes no transfer again
   by itself (no regeneration). Confirm this, or ask for the moved-edge case as a later step (design v3.2, section 4).

## 8. Changes made by E2E-2 (commits `c00ade2` and `8622feb`, and this file)

- `scripts/rehearse-container.mjs`: the entrypoint gets PILOT_CIRCULATION, PILOT_OPEN_SANDBOX and NODE_OPTIONS when they
  are set (none by default, so a plain rehearsal is unchanged; PILOT_TRACKER_SHA256 is never passed); test in
  `test/operations.test.mjs`.
- `scripts/e2e-python-client.mjs`: the step-5 ledger check waits (at most 20 s) for the server-only set-off X<->M after
  checking the client's own edges strictly, and `GET /clearing` is re-read while it lacks that set-off.
- `test/setoff.test.mjs` (`8622feb`, after verification): the set-off recovery test waits, by the server's own timestamp
  rule, for S2's fresh 998 ms timestamp before `recover()`; its assertions are unchanged (section 2.2).
- `docs/PILOT-API.md` (Tests) and this file (`cd409ee`, updated after verification: section 2.2, the second round of
  rehearsals, run-to-run variance of the soak and compat figures, R-1's cause, R-15 and R-16).

## 9. Audit fixes after this report (server, branch `circulation-v16`; not re-measured by E2E-2)

Each has a test in `test/audit-fixes.test.mjs` (stub tracker, in the default `npm test`) that fails on the code this
report measured; the figures below are from those tests and the auditor's scripts, not from a rehearsal.

- **SV-ROB-1** `pilot-edge-log.jsonl` is never read as one string: startup (`repairEdgeLog`) and a one-pass index
  (`lib/pilot/journal.mjs` JournalIndex: per seq the line's offset and the numbers the D-2 e proof and
  `pair_changes_since` need, per edge and per key the seqs) stream it, and a GET /edges page reads only its own lines.
  150 000 entries (86 MiB) under `--max-old-space-size=128`: about 1 s, 50 MiB heap after (the code measured here:
  heap out of memory, exit 134). Not done: compaction or rotation (a `since` before a checkpoint needs a protocol
  answer); the index and the startup scan still grow with the file (docs/PILOT-API.md residual risks).
- **SV-PRIV-1** the public GET /ledger keeps v15's reconciliation rows in every mode (owner decision 9, design 4.9); the
  journal columns stay in `Pilot.reconcile()` (server-side) and a party's `exact` in GET /edges. Spec 18.12 in
  valun-open still names the columns on the public rows (cross-repository follow-up).
- **SV-ROB-2** `ledger()`, `reconcile()` and GET /edges look keys up in one map per read (1 001 participants, 3 000
  edges: `ledger()` 693 ms before, 5 ms after); a consent poll of a member with no edge from it and none to it takes no
  lock and reads no tracker (before: about 0.7-0.8 s under the lock per poll).
- **SV-DOS-1** members that have not signed a set-off since their last unsigned expiry are in at most 1 collecting
  set-off each, set-offs with such a member are at most 40 of the 50, and cycles with a member at its cap are left out
  before the selection. The auditor's scenario (50 never-signing sandbox joiners, two server agents): 50 collecting and
  no proposal for a member that signs before; 25 collecting and a proposal for it after.
- **SV-LIVE-1** an ended transfer attempt holds its to-edge (A->C) only until its `fallback_after`; the payer's own edge
  stays held while the deal is unpaid.
- **SV-AUTH-1** `applied` resolutions need the payee's edge to show the transfer (stored class, else a fresh read):
  otherwise `409 payee_edge_not_applied`.
- **MIG-1** the downgrade check purges every unapplied note signature (sha256 kept; its backup keeps them); a v16 server
  whose pilot tracker reports no capabilities raises one ALARM (and audits `pilot.revivable_signatures`) for signatures
  that tracker would revive.
- **MIG-3** the downgrade check is in the image; `VALUN_MAINTENANCE=downgrade-check[-dry-run]` makes the entrypoint run
  it on the volume before anything starts and exit with its code (docs/PILOT-API.md, Rollback).
- **MIG-4** an unresolved attempt can be resolved in every mode but off.
- **MIG-5** with `trackerCaps` null, ordinary templates ask the tracker for its reserved residues again (at most once a
  minute), so a failed startup read no longer lets ordinary notes end in 995-999 ms on tracker v3.1 (and on tracker
  v3.2, which keeps the same reserved residues).
- **R-1** as in section 6.
- `scripts/e2e-python-client.mjs` checks the public rows for `match` (v15's shape) and the tour participant's own edges
  for `exact` in GET /edges; it was not run after this change (it ran after the change of section 10, and those checks
  pass there).

## 10. The server aligned with the 0.4.0 clients after audit VS-1 (task PA-SV, branch `circulation-v16`)

**History; superseded in part by tracker v3.2 (section 15).** This section is the server at `94797c6` on tracker v3.1.
Since `538075b`, the creditors' prior acknowledgments are the 105-byte PA, which binds the prior total and timestamp,
so VS-1 is closed in the tracker itself. What v3.2 supersedes here: the root cause and R-17 (closed); the rule that a
same-issuer retry at a new T waits for the window (a retry on the same prior state is now allowed at once, the
same-prior exemption); and the e2e probes' workaround below (they make that retry at once again). What stays: no
regeneration; every other new payment of the deal still waits for the earlier attempt's window; an attempt the edge
journal proves dead never blocks.

Audit VS-1 (fixed in the clients by valun-open `a6340b8`): a transfer's creditor prior acknowledgments, M(A,B,X,T) and
M(A,C,Y,T), carry no prior timestamp. Two attempts of a deal through the same held note on the same priors at different
T could therefore both apply, should both edges come back to X and Y (A can raise A->B again without B's signature, and
C can move an amount out of A->C). The 0.4.0 clients no longer sign such a retry while the earlier attempt can still
apply, and no longer re-sign a regenerated transfer as payer (`transfer_window_open` within the window, `stale_quote`
after it). The server now does the same:

- `paymentBlock` / `transferAttemptsBlock` (lib/pilot/core.mjs): an earlier transfer attempt of the deal (recorded, or
  refused when posted, D-2 b) that can still apply holds back every new payment until its `fallback_after`
  (T + 1 h + 60 s), a same-issuer retry at a new T included: the transfer template, `POST /pay-by-transfer`, the held
  transfer's approval re-check and the payment options answer `409 transfer_window_open {retry_after_ms}`. Only the
  identical operation (the same held note, prior and T, posted again) is not held back, because the tracker applies an
  edge's operations at strictly increasing timestamps. An attempt Valun's edge journal proves dead (D-2 e) still never
  blocks.
- No regeneration: a transfer that fails with `edge_changed` (at the apply re-check or at the read-back) ends; the deal
  is `payment_due` with `fallback_after`; no new transfer and no payer consent are made. `regenerated_from` /
  `regenerated_as` stay in the views and errors, always null. The 3-second wait inside the server's lock that
  regeneration could take is gone with it.
- `next_actions`: while an earlier transfer attempt can apply, `pay_by_transfer` is `wait_for_transfer_window` too. The
  pay_by_transfer approval's `if_rejected`, the 409 texts, the `transfer_stale` text after an edge change, the owner
  console's texts and docs/PILOT-API.md (Pay by transfer, steps 8 and 9) no longer say that a transfer may be retried
  at once.
- A consequence: a `409 transfer_stale` carries `template: null` when the refused post was recorded as an attempt, or
  another attempt of the deal can still apply (a fresh template would be a new attempt at a new T).

Tests: two new stub-tracker tests in `test/audit-fixes.test.mjs` ("PA-SV (VS-1)", in the default `npm test`), and the
updated ones in `test/circulation-fixes.test.mjs` (D-2 b), `test/audit-fixes.test.mjs` (R-1 and VS-1),
`test/status-classification.test.mjs`, `test/console.test.mjs`, `test/transfer.test.mjs`, `test/setoff.test.mjs` and
`test/operations.test.mjs`. Run on an export of `55510a9` (the code before this change), the new and updated stub tests
fail for the intended reasons (the retry passes the window; the transfer is made again as `vt_...`; next_actions offer
`pay_by_transfer`; the console texts say "at once"). The tests that made a same-issuer retry at once now make the
earlier attempt on a server clock 62 (or 124) minutes behind, so that its window has passed on the real clock where
the retry is made (the tracker accepts old ordinary notes, and those attempts never reach it). The soak's rule R now
also counts any payer consent item as a violation.

Runs at this tree on tracker v3.1 (same machine, 2026-11-10; logs in the PA-SV scratch folder `pa-sv/`):

| run | result |
|---|---|
| `npm test` (old binaries 3df7ed93) | 347 tests: 250 pass, 0 fail, 95 skipped (need tracker v3.1), 2 todo; 63 s (the final run, `npm-old-final.txt`; an earlier run of the task took 92 s) |
| `VALUN_BINS=<v3.1> npm test` | 347 tests: 345 pass, 0 fail, 0 skipped, 2 todo; 409 s |
| `SOAK_CIRCULATION=1 VALUN_BINS=<v3.1> node --test test/soak.test.mjs` (seed 20261107) | pass, 191 s: 616 invariant checks, 1234 responses scanned, 108 novation signatures followed, 93 journal entries; transfers applied 5, resolved not applied 2, void key revoked 1, expired 1, cancelled 1; set-offs applied 4, refused 2, void key revoked 1; refused attempts 9; held notes 6 |
| `VALUN_OLD_BINS=<3df7ed93> VALUN_NEW_BINS=<v3.1> node --test test/tracker-compat.test.mjs` | 6 tests, 6 pass, 25 s (digests `32cc288f...` old, `ccc72cb4...` after the v3.1 writes, each equal across its restart) |
| `node scripts/e2e-python-client.mjs` (all five runs; Hermes home a 38-character temp folder) | exit 0: sandbox, on (one pause after a 429), mcp, clients and faults PASS; 441 checks, 0 fail; 16.6 min |

What the e2e run needed (`scripts/e2e-python-client.mjs`, `scripts/e2e-hermes-dispatch.py`):

- The probes no longer retry the rejected payment at once: the client refuses the same-issuer retry and the server
  refuses its template (409 `transfer_window_open`, retry_after_ms about an hour); the rejected deal is disputed, and a
  second deal paid with the same note is held, approved and applied (X>S3 and X>M end as before). The invited part
  pays a second deal after the cancelled transfer the same way, and the faults part's D-2 b deal is disputed after the
  same-issuer retry is refused.
- `valun attempts list` advises a resolution (printed once for the list) when an unpaid deal has an attempt the client
  cannot prove dead: here the rejected deal's attempt, since the second deal moved the same claim 3 -> 1, the total
  that attempt would have left. The check for the paid deal now reads only its own lines. The server had ended that
  attempt (`void_rejected`), so the owner's resolution is against the client's records only (a valun-open follow-up:
  the client could take the server's ended state into account).
- Before this change the script could not pass either: run against an export of `55510a9` with the same clients, the
  probes' same-issuer retry failed in the sandbox and on runs (the 0.4.0 client refuses it; in the on run that check
  stops the run before its invited part) and so did the faults run's D-2 b retry (the clients run's Hermes part failed
  there too, only because the Hermes home given was longer than the 44 characters the dispatch script allows).
- The Hermes part: Windows Application Control on this machine refuses to start the Hermes venv's `hermes.exe`
  launcher ("An Application Control policy has blocked this file"); the dispatch script now runs the same CLI entry
  point as `python -m hermes_cli.main` when the launcher cannot be started, and says so in its result.

Residual risks: R-17 (section 6; closed by tracker v3.2, section 15). Owner decision: section 7, item 8 (updated for
tracker v3.2).

## 11. Final commits and the re-runs after the audit (PA-SV, PA-OPEN, PA-PL)

History, on tracker v3.1. The commits were then valun-app `94797c6`, valun-open `2b3b0fc` and the plugin `2e716f8` (as
named in the table); section 1's right-hand column now has the final commits on tracker v3.2. Every run below was made
by the task named, at that commit, on the Windows dev machine on 2026-11-10. The logs are in the session scratchpad, in the folders
given. Nothing was pushed or deployed.

| repository at | run (task) | result | log |
|---|---|---|---|
| valun-app `94797c6` | `npm test` with the old binaries 3df7ed93 (PA-SV) | 347 tests: 250 pass, 0 fail, 0 cancelled, 95 skipped (need tracker v3.1), 2 todo; exit 0; 63 s | `pa-sv/npm-old-final.txt` |
| | `VALUN_BINS=<v3.1> npm test` (PA-SV) | 347 tests: 345 pass, 0 fail, 0 cancelled, 0 skipped, 2 todo; exit 0; 408 s | `pa-sv/npm-v31-final.txt` |
| | `SOAK_CIRCULATION=1 VALUN_BINS=<v3.1> node --test test/soak.test.mjs` (seed 20261107; PA-SV) | 1 test, pass, 191 s; 616 invariant checks, 1234 responses scanned, 108 novation signatures followed, 93 journal entries | `pa-sv/soak1.txt` |
| | `VALUN_OLD_BINS=<3df7ed93> VALUN_NEW_BINS=<v3.1> node --test test/tracker-compat.test.mjs` (PA-SV) | 6 tests, 6 pass, 0 fail; 25 s | `pa-sv/compat1.txt` |
| | `node scripts/e2e-python-client.mjs`, all five runs (PA-SV) | exit 0; runs sandbox, on (one pause after a 429 `rate_limited`), mcp, clients and faults PASS; 441 checks ok, 0 FAIL; 16 min 37 s | `pa-sv/e2e2.txt` |
| valun-open `2b3b0fc` | `.venv/Scripts/python -B -m unittest discover -s python/tests` (PA-OPEN) | 397 tests OK | `paopen2/f-py.log` |
| | `test_sdk_interop` (official MCP SDK) (PA-OPEN) | 5 tests OK | `paopen2/f-sdk.log` |
| | `node --test js/test` (PA-OPEN) | 492 tests: 491 pass, 0 fail, 1 skipped (POSIX file modes, Windows) | `paopen2/f-js.log` |
| | `check_python.py --client package --require circulation/1` (PA-OPEN) | 1389 checks: 1191 agree, 0 disagreements in failing tiers, 17 informative, 181 n/a; exit 0 | `paopen2/f-check.log` |
| | `node spec/vectors/generate.mjs` (pinned to `cfe698b`) (PA-OPEN) | exit 0; all 7 committed vector files reproduced byte for byte | `paopen2/f-gen.log`, `f-cmp.log` |
| plugin `2e716f8` (clean clone; valun-open at `2b3b0fc`) | `python -B -m unittest discover -s tests`, system Python 3.14.7 (PA-PL) | 146 tests OK (skipped=2: the two that need Hermes) | `papl/f-sys.log` |
| | the same in the Hermes venv (Python 3.14.7), with HERMES_HOME an empty folder and an empty `<root>/.hermes/profiles/custom` (PA-PL) | 146 tests OK, none skipped, both times; both folders stayed empty | `papl/f-venv.log`, `f-venv-custom.log` |
| | `scripts/check_plugin_core.py <plugin>` (PA-PL) | valun_core is valun 0.4.0, unchanged (8 files) | `papl/f-core.log` |
| | `check_python.py --client plugin --require circulation/1` (PA-PL) | 1389 checks: 1191 agree, 0 disagreements in failing tiers, 17 informative, 181 n/a; line for line the package's | `papl/f-vec-req.log` |
| | `check_python.py --client plugin` without `--require` (PA-PL) | 1387 checks: 1104 agree, 0, 17 informative, 266 n/a; line for line the package's | `papl/f-vec-noreq.log` |
| | `hermes plugins validate` on a freshly recreated `C:/Users/USER/hv04` (without `--install-deps`, which would use the network) (PA-PL) | Validation passed: 15 checks, security scan safe | `papl/f-validate.log` |
| tracker `24675ec` | not re-run: no tracker change since E2E-2 | section 2.1 | |
| valun-open spec at `2b3b0fc`, server export of `94797c6` | vectors regenerated in a scratch copy, and both clients checked against them (PA-DOCS) | the generator exits 0 and labels the source `UNRECOGNISED`; the differences are in R-21; package and plugin with `--require circulation/1`: 1389 / 1191 / 0 / 17 / 181, exit 0 each | `padocs/gen-94797c6.log`, `chk-pkg-94797c6.log`, `chk-plg-94797c6.log` |

Checks that the new tests fail without the change:
- **PA-SV:** run on an export of `55510a9`, the new and updated stub tests fail for the intended reasons (section 10).
- **PA-OPEN:**
  - with client.py reverted, both new Python tests fail;
  - with cli.py reverted, the CLI test fails;
  - with js/src/client.js and index.js reverted, 5 JS tests fail.
- **PA-PL:**
  - the new plugin test fails with the previous `__init__.py`, and with the previous vendored client.py;
  - before the copy, the plugin at `8d30d04` failed 2 vectors (`payer/same-prior-retry-at-another-timestamp`,
    `bound/payment-attempt`).

Not re-run after the audit:
- the container rehearsal and the memory figures (section 5; R-22);
- the tracker suites (section 2.1; no change);
- PL-2's real-Hermes smoke run against a local v16 server and the sandbox tour (the plugin fixer's note).

## 12. The security audit (2026-11-10): 19 confirmed findings, 5 refuted

**Scope.** Five audit lenses covered:
- value safety and signature binding;
- server authorization, privacy and robustness;
- approval integrity and agent manipulation;
- migration, rollback, deploy and dark mode;
- secrets, private data and the supply chain.

**Outcome.** The lenses raised 26 findings. A challenge pass merged MIG-2 into MIG-1 and SC-4 into SC-1, confirmed 19
(2 medium, 17 low, none high) and refuted 5.

**Who fixed what.** Three fixers made the fixes: server `55510a9`; valun-open `a6340b8`, `b63a1b7`, `2fe3818`,
`6eabde1`, `bfe568b` and `17729e0`; plugin `c00c47b` and `8d30d04`. The post-audit tasks finished the cross-repository
parts: PA-SV `94797c6`, PA-OPEN `6ed0e76`, `0ed93c2` and `2b3b0fc`, and PA-PL `366b4b7`, `553f536` and `2e716f8`.

**Tests.** Each fix has a test that fails without it, unless the row says otherwise. Server tests are in
test/audit-fixes.test.mjs (stub tracker, in the default `npm test`) unless named.

Source: `audit-results.json` in the design folder of the session scratchpad.

| finding | sev. | where | what it was | how it was fixed | still open |
|---|---|---|---|---|---|
| VS-1 | medium | clients, server, tracker | Same-prior transfer retries do not exclude each other at the tracker once both edges return to their acknowledged totals. The creditors' prior acknowledgments bind totals, not timestamps, so I-ONCE did not hold against a dishonest server with colluding parties: the issuer and the payee can make a second attempt apply. | Clients: `one_live_attempt` treats an earlier transfer as excluded only for the identical operation (same edge, prior state and T). A same-issuer retry at a new T is `transfer_window_open` until the earlier attempt is dead (valun-open `a6340b8`; test_novation `VS1SamePriorTransferRetries`). Server: the same rule, and no regeneration (`94797c6`; "PA-SV (VS-1)", section 10). Spec: I-ONCE, 18.6, 16.2 item 12 (`0ed93c2`). Design: ERRATA E-1 to E-3. **Root cause (section 15):** tracker v3.2 `4370418` checks both creditor prior slots and a bound note's `prior_signature` over the 105-byte PA, which binds the prior total and timestamp; server `538075b`, clients valun-open `836750a`, spec `61d26fb`. | **Closed by tracker v3.2** (section 15); R-17 closed with it |
| SV-ROB-1 | medium | server | `pilot-edge-log.jsonl` was never pruned and was read whole per GET /edges and at index build. About 150 000 entries exhausted the 128 MiB heap and crash-looped the server. | Read in 1 MiB chunks; the startup repair streams it with a bitmap; one JournalIndex per process (about 50 bytes an entry); a GET /edges page reads only its own lines. 150 000 entries: about 1 s and 50 MiB heap; before the fix, heap out of memory, exit 134 (`55510a9`; "SV-ROB-1", two tests). | Compaction or rotation (R-19) |
| VS-2 | low | spec | Spec 16.2 item 7 still gave the pre-D-2 a read-back rule (a return to the prior total past T counts as not applied), against R11 and the code. | Rewritten to the D-2 a rule; R11's "the tracker lets only one of them apply" removed (`a6340b8`). Documentation only: the D-2 a tests and vectors already pin the rule. | none |
| SV-PRIV-1 | low | server | The public GET /ledger rows gained cumulative per-edge `transferred_in/out` and `set_off` amounts in modes sandbox and on, against owner decision 9 and design 4.9. | The public rows are v15's in every mode (`reconcile(l, {public: true})`). The journal columns stay internal, and a party's `exact` is in GET /edges (`55510a9`; "SV-PRIV-1"). Spec 14.3, 18.12, 18.14 (`0ed93c2`). | none |
| SV-ROB-2 | low | server | Each clearing member's consent poll ran a full ledger snapshot (participants × notes) under the global lock before checking that the member has an edge at all. | One key map per read. `clearingMayCycle(p)` runs before the lock, so a member without an edge from it and one to it takes no lock and no tracker read. `ledger()` at 1 001 participants and 3 000 edges: 693 ms before, 5 ms after (`55510a9`; "SV-ROB-2"). | Snapshot reuse per tick (R-20) |
| SV-DOS-1 | low | server | Sandbox sybils that never sign could fill the network-wide cap of 50 collecting set-offs and block clearing for everyone for 30-minute stretches. | A member that has not signed since its last unsigned expiry is in at most 1 collecting set-off (`max_collecting_per_unproven`). Set-offs with such members are at most 40 of the 50 (`max_collecting_unproven`) (`55510a9`; "SV-DOS-1", three tests). Spec engine limits, not normative (`0ed93c2`). | none |
| SV-LIVE-1 | low | server | An ended transfer attempt on a `payment_due` deal held the issuer-to-payee edge out of clearing with no time bound. | That to-edge is held only until `fallback_after`. The payer's own edge stays held while the deal is unpaid (`55510a9`; "SV-LIVE-1"). | none |
| SV-AUTH-1 | low | server | The payer's owner could resolve an unknown-outcome transfer as `applied` against the server's own read-back, closing the payee's deal as paid. | `applied` needs the payee's edge to show the transfer, else `409 payee_edge_not_applied {payee_edge}` and nothing changes (`55510a9`; "SV-AUTH-1", transfer.test.mjs D-2 d). The clients explain the 409 (valun-open `6ed0e76`), and so does the plugin (`553f536`). | Confirm with the payee before an `applied` resolution (docs/PILOT-API.md) |
| AI-1 | low | clients | `approved_payments` never expired and was not cleared when the owner rejected a held pay-by-transfer, so the client re-signed that payment as a consent hours later. | A payer consent is signed only for a recorded transfer attempt of the deal, through the same held edge, while its window (T + max age + margin) is open. `approved_payments` can only refuse (`a6340b8`; test_client_circulation "… hours later", now `stale_quote`). | 3 sub-items (R-20) |
| AI-2 | low | clients (MCP) | 2026-07-28 MCP approvals were replayable: `requestState` had no nonce or expiry, so each resend of an approved `valun_propose` signed another offer. | `requestState` = nonce, issued time, HMAC(tool, exact args, nonce, issued). Each is used once, within 600 s (`b63a1b7`; test_agent_safety "… used once and only while fresh"). | none |
| AI-3 | low | clients (CLI) | `valun sandbox tour --yes` approved commitments chosen from unverified inbox fields, without checking the prepared terms against the tour's own rules. | `tour_rules_problem()` checks four things: the counterparty by directory id; the terms read again against the pinned hash; a price at most the published one; a held note that is the other sandbox agent's (`2fe3818`; test_cli_tour `TourYesChecksWhatIsSigned`). | none |
| AI-4 | low | clients (MCP) | In MCP client-prompt mode, a loosening `valun_set_limits` was neither prompted nor flagged, although the core classifies it as a commitment. | `requiresUserInteraction` and `destructiveHint` for `valun_set_limits` too (`b63a1b7`; test_mcp_server, extended). | none |
| MIG-1 (+ MIG-2) | low | server | A rollback to the 3df7ed93 tracker, explicit or implicit (an image rollback, or a `dist/bin` that holds 3df7ed93), revives kept bound-note and novated-edge note signatures that v16 counts as dead. The downgrade check passed, and no startup guard existed. | The downgrade check purges every unapplied note signature (sha256 kept; the backup keeps the signatures). A pilot tracker without capabilities raises one ALARM and the audit line `pilot.revivable_signatures` (`55510a9`; "MIG-1", two tests). | Alarm only, no refusal (R-18) |
| MIG-3 | low | server | The v15 rollback runbook could not be executed on Fly: the check must run with the server stopped, was not in the image, and a run on a copy never prepares the live state. | The script is in the image. The entrypoint's maintenance mode, `VALUN_MAINTENANCE=downgrade-check[-dry-run]`, runs it before anything starts and exits with its code (`55510a9`; "MIG-3"). | Not run on Fly yet (runbook step 3) |
| MIG-4 | low | server | Switching from `on` to `sandbox` stranded the `outcome_unknown` attempts of participants outside the sandbox. | The resolve route exists in every mode but `off` for `outcome_unknown` and `inconsistent` attempts (`55510a9`; "MIG-4"). Spec 18.8 and 18.14 (`0ed93c2`, `2b3b0fc`). | In `off` there is still no route: resolve first (runbook R1) |
| MIG-5 | low | server | One failed capabilities read at startup disabled the 995-999 ms clamp for ordinary notes on tracker v3.1 until a restart (the same would hold on tracker v3.2, which keeps those residues). | While `trackerCaps` is null, `reservedResidues` asks the tracker again, at most once a minute. Circulation stays off until a restart, failing closed (`55510a9`; "MIG-5"). | none |
| SC-1 (+ SC-4) | low | valun-open CI | release.yml published to PyPI and then the MCP Registry on any `v*` tag with no tests, conformance or plugin-core check. It did so in a job that held `id-token: write` and installed build tooling without hashes. | A new verify job (`contents: read`, no id-token) checks the tag against all four versions and `PLUGIN_SHA` against ci.yml's pin. It runs the unit tests, the vectors (package, and plugin at `PLUGIN_SHA`, circulation required), `check_plugin_core` and the node tests, then builds the artifact. pypi only downloads it (`bfe568b`). No CI run was possible: the YAML and the job graph were checked. | Hash pinning, rulesets and environment reviewers (R-20); two action SHAs to check (section 13) |
| SC-2 | low | plugin | The plugin passed the agent's signing secret and token to a subprocess on the command line. | `hermes config set` gets the value through the child's environment (`VALUN_PLUGIN_CONFIG_VALUE`), never its argv (`8d30d04`; tests/test_config_set_040.py, 5 tests). | The environment is readable by the same user and root (R-20) |
| SC-3 | low | valun-open, plugin docs | Stale "not published / version 0.3.1" text would be frozen into the immutable npm 0.4.0 tarball. | js/README.md names 0.4.0 (marked unreleased); README and CHANGELOG updated. The verify job refuses a tag while js/README.md or python/README.md say unreleased, or the CHANGELOG heading does (`bfe568b`, `17729e0`). | The release-docs commits (section 13; runbook P1, P5) |

R-1 (section 6) was fixed in the same server commit, but it was this report's finding, not the audit's. The JS-2
leftovers in valun-open `6eabde1` are not audit findings either: `Client.fresh()` keeps the host's class, and
`agent.client()` follows `declareRoles`.

**Refuted (5)**

| finding | claim | why it was refuted |
|---|---|---|
| SV-ERR-1 | In circulation modes, a failed ordinary credit note still stores and shows the tracker's raw error text to both parties. | Intended and specified, and unchanged from the deployed v15. D-2 f and the spec limit the server's own sentence to failed bound notes, and ordinary notes keep v15's text on purpose. The text goes only to the deal's two parties and carries no signature or secret. |
| MIG-6 | The upgrade runbook has neither the drain that design 11 promises nor a snapshot of the live pilot before the migration. | Not worse than stated. The snapshot is R-2's mitigation, the first step of the deploy. The public `/pilot/v1/ledger`, `/participants` and `/info` can be captured before the deploy. A v15-era held note at 995-999 ms ends `note_failed`, and the payer signs again: liveness only. The runbook now has both (steps 0 and 1). |
| SC-5 | The pinned tracker binary cannot be rebuilt from any committed or identified source, and only `basis_server` is hash-checked at runtime. | Already disclosed in basis/BUILD.md. A rebuild that does not match leaves circulation off, failing closed. `valun_signer`'s basis_core equals 3df7ed93's (on tracker v3.1; v3.2 adds `prior_ack_message` to it, an additive change: basis/BUILD.md), and a wrong signer makes signatures the tracker refuses. |
| SC-6 | The tracker fork's only remote is the upstream BetterMoneyLabs repository. | No defect. The tracker branch is not in the publishing list, BUILD.md says it is not pushed anywhere, and the `valun` user in WSL has no git credentials. Offering it upstream is owner decision 7. |
| SC-7 | The Docker base image is a floating tag, not a digest. | Generic hardening of a pre-existing choice: v15 deploys with the same `FROM node:24-trixie-slim`. The claimed impacts are speculative. |

## 13. Release steps the fixers flagged (owner steps; runbook section P has the commands)

1. **The pushed plugin SHA goes into valun-open's workflows.**
   - Where: `.github/workflows/ci.yml` (the 0.4.0 checkout's `ref:`), `release.yml` `env.PLUGIN_SHA` (the verify job
     greps ci.yml for `ref: $PLUGIN_SHA`), and spec/vectors/README-ci.md.
   - Why: both workflows pin `2b78a0624f6f28ff31f0f32c1b11312ab726f33d` today. That is a local commit that predates the
     audit and the core copy, so CI's `check_plugin_core` and circulation vectors would fail against it.
   - The catalog draft's `<NEW_SHA>` is the same commit.
   - Commands: runbook P4 and P5.
2. **Check the upload-artifact and download-artifact action SHAs**, which were written from memory:
   - `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2`;
   - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0`.

   They are the only action pins not already on `origin/main`, where the others ran green for 0.3.1. Commands: runbook
   P5.2.
3. **The release-docs commits that remove the "unreleased" marks, before tagging.**
   - valun-open: js/README.md:16, CHANGELOG.md:6 and README.md:55. The verify job blocks the tag while js/README.md,
     python/README.md or the `## 0.4.0 ` heading say unreleased.
   - The plugin: CHANGELOG.md's `(unreleased draft)` and `**Not released.**`, before its push, since the catalog pins
     that commit (SC-3).
   - Commands: runbook P1 and P5.3.
4. **Spec follow-ups for PA-SV's server change** (valun-open spec/PROTOCOL.md 18.6, 18.12, `next_actions`, `409
   transfer_stale` with `template: null`): **done** in valun-open `e4e53a6` and `2b4695a` (section 14). The design's own
   overstatement is corrected in its ERRATA section.
5. **The vectors' server pin** (R-21): **done** in valun-open `f4017c4` (section 14).
6. **GitHub settings**: a ruleset that requires green CI on tags, and environment reviewers for `pypi` and `npm`
   (SC-1). Runbook P7.
7. **Docs in valun-app that lag the audit fixes:** **done** in `04dc3c8` (section 14).
   - The header of scripts/pilot-downgrade-check.mjs still says the resolve route exists only in modes sandbox and on.
     Since MIG-4 it exists in every mode but off.
   - docs/PILOT-API.md (Rollback) describes "v15 code on tracker v3.1". The v15 image's basis/run-tracker.sh (`729a4c1`)
     always writes the `[ergo.node]` layout, which tracker v3.1 refuses (basis/BUILD.md), so that combination needs
     v16's launcher. The runbook does not use it. (Since `538075b` PILOT-API.md says the same of tracker v3.2, which
     refuses that layout too.)

## 14. After the post-audit round: the verifiers' remaining points, the vectors, and the re-runs at the final commits (2026-11-10)

History, on tracker v3.1: these were the final commits until section 15, which supersedes them (valun-app `4032eaa`,
valun-open `8aa6586`, the plugin `89a92ed`, tracker v3.2).

The post-audit verifiers passed all four tasks and left minor points. They are fixed here, together with the release
steps of section 13 that needed no owner approval (items 4, 5 and 7). Every commit below is local; nothing was pushed,
deployed or published.

**Commits**

| repository | commit | what |
|---|---|---|
| valun-app | `fa38334` | DEPLOY-0.4-RUNBOOK.md: the plugin push and tag name `refs/heads/` and `refs/tags/` in full (the plugin repository has a branch named `v0.4.0`, so `git push origin v0.4.0` fails as ambiguous once the tag exists); step 5 item 6 gives the persistence compare's real output after the throwaway write (exit 1; one new note, reconciliation row and participant, and the digest; nothing gone) and takes a new baseline; step 3 takes the copy's own baseline (`cap rh-before`), says the copy has none of the live secrets, and sets `URL` back to live. R-21: 15 steps. PILOT-API.md: the fallback rule, decision D-1's first bullets and the history events say what v16 does. public/pilot.js: the owner console's window labels say "Any new payment from" instead of "Another kind of payment from". |
| valun-app | `04dc3c8` | PILOT-API.md step 6 no longer says an `edge_changed` transfer is made again; the downgrade check's header names the resolve route's modes (every mode but off); PILOT-API.md Rollback says the v15 image cannot start v15 code on tracker v3.1 by itself (section 13 item 7). |
| valun-app | `447a103` | Test only. The container rehearsal (Linux) failed MIG-3: the test reads Dockerfile, .dockerignore and scripts/rehearse-container.mjs, which the image's copy of the app does not hold. It now skips there with its reason, as the other repository-file tests do, and still runs (and passes) in the repository. The test was added by the audit fixes, after the last rehearsal (`8622feb`). |
| valun-open | `40cd04c` | `valun attempts resolve` quotes the attempt in the command it prints (`'#1'`; unquoted, bash, zsh and PowerShell read `#1 --not-applied` as a comment), and the list advice says so. For a transfer the server reads as `inconsistent`, the plan says before the question that it is the operator's case, and the `payee_edge_not_applied` refusal names no `--not-applied` command (resolving it as not applied on the payee's word could pay the deal twice). 4 tests fail without it. |
| valun-open | `f4017c4` | The vectors regenerated from valun-app `fa38334` (R-21). |
| valun-open | `e4e53a6`, `2b4695a` | spec/PROTOCOL.md: release v16 as at `fa38334` (no transfer regeneration; any new payment of a deal, a same-issuer retry at a new T included, waits for the earlier attempt's window; `next_actions` `wait_for_transfer_window`; `409 transfer_stale` with `template: null`; the approval texts as the code has them) in 10.4, 14.1, 15.3, 16.2, 17, 18.3-18.16 and Appendix H; README, js/README and the CHANGELOG. |
| plugin | `11e7be5`, `1dbb369` | `hermes valun attempts resolve`: the same two changes as `40cd04c` (3 tests fail without them); the CHANGELOG. `CATALOG-UPDATE-0.4.0.md` (untracked) has the new numbers. |

**Re-runs at the final commits (Windows dev machine, 2026-11-10)**

| at | run | result |
|---|---|---|
| valun-app `447a103` | `npm test` with the 3df7ed93 pair | 347 tests: 250 pass, 0 fail, 95 skipped (need tracker v3.1), 2 todo; 61 s |
| | `VALUN_BINS=<v3.1> npm test` | 347 tests: 345 pass, 0 fail, 0 skipped, 2 todo; 356 s |
| | `node scripts/rehearse-container.mjs --tests-only`, from a scratch copy with the v3.1 pair | 338 pass, 0 fail (the same run at `fa38334` failed MIG-3 only; see `447a103`) |
| | the full container rehearsal (`PILOT_CIRCULATION=on PILOT_OPEN_SANDBOX=1 NODE_OPTIONS=--max-old-space-size=128`), E2E-2's harness and sampler (section 5) | Linux suite 347 tests: 338 pass, 0 fail, 7 skipped (files the image does not hold), 2 todo. `circulating credit: on`; `/pilot/v1/info` lists `bound_notes/1` and `circulation/1`; `basis.pin` names tracker v3.1 at `24675ec…` without "(binary not pinned)". e2e `--modes on --only tour,calls,probes` against it: PASS, 144 checks ok, 0 FAIL. Memory: idle 117.0 MiB total; peak under load 129.1 MiB (app 97.6, demo tracker 14.1, pilot tracker 14.4, shells 3.4); VmHWM app 97.1, trackers 13.6 / 14.3; PSS 95.1 / 7.4 / 8.2 MiB. Section 5's six runs gave 128.7-131.5 MiB. Staging folder removed, ports free. |
| valun-app `fa38334` (code as `447a103` but for that test) | `node scripts/e2e-python-client.mjs`, all five runs (Hermes plugin `11e7be5`, a fresh Hermes home) | exit 0: sandbox, on (one pause after a 429), mcp, clients, faults all PASS; 397 checks ok, 0 FAIL |
| valun-open `40cd04c`-`2b4695a` | Python suite; `test_sdk_interop`; `node --test js/test` | 399 tests OK; 5 OK; 492 tests: 491 pass, 0 fail, 1 skipped |
| | `check_python.py`, package and plugin, with `--require circulation/1` / without | 1389 checks: 1191 agree, 0 disagreements in failing tiers, 17 informative, 181 n/a / 1387: 1104, 0, 17, 266; plugin 0.3.0 (`5d01fbd`) as without |
| | `node spec/vectors/generate.mjs` again | the committed vectors, byte for byte |
| plugin `11e7be5` (a clean clone) | unit tests, system Python 3.14.7 / Hermes venv | 148 OK (2 skipped: need Hermes) / 148 OK |
| | `check_plugin_core.py` (valun-open `2b4695a`) | unchanged (8 files) |
| | `hermes plugins validate` (`python -m hermes_cli.main`: Application Control blocks hermes.exe here), a fresh 19-character home, no network | Validation passed, 15 checks, security scan safe |
| | PL-2's smoke script: `hermes valun join --sandbox`, then the five-step sandbox tour through Hermes's plugin context, against a local v16 (sandbox mode, tracker v3.1) | "The tour is complete" with design 9.2's totals (hold 0, owe 0, 2 PC cleared by set-offs); 9 approvals asked, 12 tool calls ran, 0 blocked; both set-offs signed during `valun_status`; `consents --process` never run |

The throwaway Hermes homes and owner token of these runs were removed afterwards (`C:/Users/USER/hv05`-`hv07`). `hv04`,
which PA-PL left non-empty, was not touched.

**Still open after this section:** VS-1's tracker root cause and the issuer-side transfer twin (R-17; both closed by
tracker v3.2 in section 15), MIG-1's alarm-only behaviour (R-18), journal compaction (R-19), the Fly-side rehearsals
(R-22), the client's "MAY HAVE APPLIED" text for a server-ended attempt (R-22), and the owner decisions of section 7.

## 15. Tracker v3.2: VS-1 closed at the root (2026-11-10)

**Why.** Audit VS-1's root cause was in the tracker. On tracker v3.1, a transfer's creditor prior acknowledgments were
the 80-byte note message of the prior *total* at the new timestamp T, `M(A,B,X,T)`: they covered only the prior total.
Two attempts on the same prior could therefore both apply once the edges came back to the acknowledged totals, so the
0.4.0 clients and the server (section 10) kept a deal to one live attempt at a time. A bound note's prior acknowledgment
had the same gap (R-17's issuer-side twin). It is fixed in the tracker now, before a release freezes 0.4.0's signed
formats. Tracker v3.1 was never deployed or released, so nothing needs to stay compatible with it.

**The fix.** Tracker v3.2's prior acknowledgment is a 105-byte message that no other operation signs:

```
PA(I, R, X, p, T) = "basis/prior-ack/1" (17 ASCII bytes) || debtKey(I, R, denomination) (32) || X (u64 BE)
                    || p (u64 BE) || T (u64 BE) || trackerNftId (32)
```

- X and p are the edge's stored total and its note's timestamp (0 and 0 for an edge with no note). T is the operation's
  timestamp.
- Which slots use it: a transfer's (version 4) `from_recipient_prior` and `to_recipient_prior` signatures and a bound
  note's (version 3) `prior_signature`. The tracker verifies them against the edge's stored (total, timestamp). Every
  other slot, and every set-off slot, is still the 80-byte note message.
- Why that closes VS-1: an edge's (total, timestamp) state never recurs, on any write path (TR-12). So the first attempt
  on a prior state to apply leaves every other attempt on that state dead for good, whatever totals follow, and
  whatever client signed them.
- What it closes: VS-1 at the root, and R-17 (the issuer-side twin is no longer needed).
- What it changes in the rules: the one-live-attempt rule now exempts a same-prior retry (below).

The design is `design/v32-design.md` in the session scratchpad.

**Commits** (all local; nothing was pushed, deployed or published)

| repository | commit | what |
|---|---|---|
| tracker: Basis fork, branch `circulating-credit-v3.2` (WSL `valun-ic1`, `ROOT/v32`), on v3.1 `24675ec` | `173c19d` (TR-8) | `basis_core` `prior_ack_message`: the 105-byte PA, with unit tests that pin its bytes and length |
| | `aed2b54` (TR-9) | transfers version 4 and bound notes version 3 check their prior slots over PA. Optional `from_prior_timestamp`, `to_prior_timestamp` and a bound note's `prior_timestamp` (409 `stale_prior` when they differ). GET /capabilities build `valun-circulating-credit/4` |
| | `f0de65e` (TR-10) | regression tests for VS-1 and R-17 |
| | `15b5b8e` (TR-11) | the tracker e2e drivers |
| | `1a8bfe5` (TR-12) | from an independent review of the v3.2 change (no high or medium findings): no (total, timestamp) state can recur on any write path; a staged exchange is cancelled when its to-edge moved |
| | `3d61eb9` (TR-13) | comments |
| | `43704183e1ba372e1b1788c414dfe4c8b0bc3f2a` (TR-14) | exchange timestamps must end in 995 ms; pre-existing exchange code, not reachable in pure-credit mode; also present on upstream master; handled privately |
| valun-app | `538075b` (V32-SV) | server v16 on tracker v3.2. It uses PA for every prior acknowledgment, the sandbox agents' own included, and adds the `prior_timestamp` fields. GET /info `novation` gains the four contract fields (`tracker_build`, `transfer_version`, `bound_note_version`, `prior_ack`). The same-prior exemption is `samePriorState` (lib/pilot/novation.mjs). A v3.1 tracker runs circulation as off and logs the reason. `lib/` changed: basis.mjs, pilot/caps.mjs, pilot/core.mjs, pilot/novation.mjs, pilot/pins.mjs, pilot/sandbox.mjs. It pinned TR-11's build. |
| | `b7ecca0` | the pin after the review: tracker v3.2 at `4370418`, `basis_server` `e13d37b4…`; basis/BUILD.md |
| | `4032eaa` | test only: a same-prior retry's template may share the refused post's 999 ms slot (found by the container rehearsal on Linux); `lib/` unchanged |
| valun-open | `2aa318a` | `prior_ack_message` / `priorAckMessage` (Python and JS), checked against the design's shared fixed vector |
| | `836750a` | the clients: prior slots signed as PA, the v3.2 contract gate, R11's same-prior exemption |
| | `3f3265b` | the vectors regenerated from valun-app `b7ecca0`, whose `lib/` is the deploy commit's |
| | `61d26fb` | spec/PROTOCOL.md at tracker v3.2 (PA, the contract, the exemption; VS-1 and R-17 closed); changelog |
| | `8aa6586` | docs: the vectors' server commit `b7ecca0` |
| plugin | `84f8b43`, `ecbe0bc`, `89a92ed` | `valun_core` copied again from valun-open `836750a`; test fixtures report the v3.2 contract; the changelog. The plugin's own code is unchanged |

**Binaries.**
- Staged in WSL `valun-ic1`:
  - `/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release/basis_server`, sha256
    `e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5`;
  - `.../examples/valun_signer`, sha256 `dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a`.

  Both were read again when this section was written. `e13d37b4…` is the only hash in `lib/pilot/pins.mjs`.
- basis/BUILD.md has the build recipe. The binaries embed `CARGO_HOME=ROOT/cargo-home-v32`, which is needed to
  reproduce the hashes.
- What it reports: GET /capabilities build `valun-circulating-credit/4`. Bound notes are version 3 and transfers
  version 4, both with `prior_ack` `basis/prior-ack/1`.
- `/api/status` `basis.pin` reads: "Basis tracker v3.2: Valun fork commit 43704183e1ba372e1b1788c414dfe4c8b0bc3f2a
  (branch circulating-credit-v3.2 on Basis 6a6ebfe + caa2e86 + a00233d), as the tracker reports itself".
- Superseded: tracker v3.1's pair (`cc0a6ade…` / `314beace…`) is no longer pinned. On v3.1, circulation runs as off.

**Runs at the final commits** (Windows dev machine, 2026-11-10)

| at | run | result |
|---|---|---|
| tracker `4370418` (WSL, `--offline`) | `cargo test` for `basis_core`, `basis_store` and `basis_server` | 35 passed; 368 passed (3 ignored: network-only, never run with `--ignored`); 350 passed |
| | `e2e/driver.py` against the staged v3.2 `basis_server` | 231 passed |
| | `e2e/mig_driver.py run --old <3df7ed93> --new <v3.2>` | 100 passed |
| | the 7 regression tests, ported to v3.1 | 5 of them fail there (the double-payment cases); all pass on v3.2 |
| valun-app `b7ecca0` | `npm test` with the 3df7ed93 pair | 355 tests: 258 pass, 0 fail, 95 skipped (need tracker v3.2), 2 todo |
| | `VALUN_BINS=<v3.2> npm test` | 355 tests: 353 pass, 0 fail, 0 skipped, 2 todo |
| valun-app `4032eaa` (changes one test file) | `node --test test/transfer.test.mjs` with the v3.2 pair | 35 of 35 pass |
| valun-app `538075b`, see the note under the table | `SOAK_CIRCULATION=1 node --test test/soak.test.mjs` (seed 20261107) | pass. 600 actions, 614 invariant checks, 1202 responses scanned, 120 novation signatures followed, 116 journal entries. Transfers: applied 5, resolved not applied 2, void key revoked 1, cancelled 1. Set-offs: applied 8, refused 1, expired 1 |
| | `VALUN_OLD_BINS=<3df7ed93> VALUN_NEW_BINS=<v3.2> node --test test/tracker-compat.test.mjs` | 6 tests, 6 pass, 0 fail (24 s): (a)-(e) as in section 3, both directions, every digest equal to its run's reference |
| valun-app `b7ecca0`, from a scratch copy with the v3.2 pair in its `dist/bin` | the full container rehearsal (`PILOT_CIRCULATION=on PILOT_OPEN_SANDBOX=1 NODE_OPTIONS=--max-old-space-size=128`), with E2E-2's harness and sampler (section 5) | See the rehearsal list under the table. |
| valun-app `4032eaa`, a scratch copy with the v3.2 pair | `node scripts/rehearse-container.mjs --tests-only` | 346 pass, 0 fail; test run exit code 0 |
| valun-app `4032eaa` | `node scripts/e2e-python-client.mjs`, all five runs (the real plugin `89a92ed`) | exit 0. Runs sandbox, on, mcp, clients and faults all PASS; 411 checks ok, 0 FAIL |
| valun-open `3f3265b`-`8aa6586` (client sources as at `836750a`) | the Python suite; `test_sdk_interop`; `node --test js/test` | 413 tests OK; 5 OK; 507 tests: 506 pass, 0 fail, 1 skipped |
| | `check_python.py` for the package and for the plugin `89a92ed`, with `--require circulation/1` | 1456 checks: 1255 agree, 0 disagreements in failing tiers, 17 informative, 184 n/a |
| | the same, without `--require` | 1454 checks: 1104 agree, 0 disagreements, 17 informative, 333 n/a |
| | `check_python.py --client plugin` at other plugin commits | Plugin 0.3.0 (`5d01fbd`) passes without `--require`. The CI's current plugin pin, `2b78a06`, disagrees on 75 checks. It predates v3.2, and runbook P5 replaces it with the pushed plugin SHA. |
| plugin `89a92ed` | unit tests: system Python 3.14.7, then the Hermes venv | 150 OK (2 skipped: they need Hermes); 150 OK (none skipped) |
| | `check_plugin_core.py` | unchanged |
| | `hermes plugins validate` | passed: 15 checks, security scan safe |
| | the real-Hermes five-step sandbox tour (PL-2's smoke script) against a local v16 in mode sandbox, on tracker v3.2 | "The tour is complete": hold 0, owe 0, 2 PC cleared by set-offs. 11 approvals asked, 16 tool calls ran, 0 blocked. Both set-offs were signed during `valun_status` |

The soak and the compat test in the table ran at `538075b` on TR-11's v3.2 build: fork commit `15b5b8e`,
`basis_server` `52c52681…`, staged in `/home/valun/valun-app-bins-v3.2-20261110T131046Z`, the build `538075b` pinned,
before the review commits TR-12 to TR-14. Both were run again on the final build (below).

**After this section was first written** (2026-11-10, the same day):
- **Soak and compat on the final binaries** (valun-app `4032eaa`, `VALUN_BINS` = the 135332Z folder, basis_server
  `e13d37b4…`): the soak (seed 20261107) passed: 600 actions, 12 participants, 158 s, 621 invariant checks, 1388
  responses scanned, 164 novation signatures followed; tracker-compat 3df7ed93 -> v3.2: 6 tests, 6 pass.
- **A review of the server and client side of v3.2** (read-only, independent) found no high or medium defect and two
  low ones, both fixed in the clients (valun-open `64ba97a`, `95d23c4`, `6c437e0`; plugin `e5fb106`, `17e9be4`):
  - attempt records now say which acknowledgment was signed (`ack: "basis/prior-ack/1"`), and the same-prior exemption
    applies only when both the earlier and the new attempt carry it, so a record written by a build before this fix
    (whose acknowledgment could have been v3.1's 80-byte one) is never exempt: it waits for its window once;
  - the client's same-timestamp record keeps a prior slot's prior state (total and timestamp) and refuses a second,
    different acknowledgment at the same (edge, T, operation), as the server's sandbox signer already did.
  Each has tests that fail without it (Python and JS). The vectors were regenerated (the server pin stays `b7ecca0`,
  whose `lib/` is unchanged): 79 decisions (5 new), only client states changed elsewhere.
- **Re-runs at the final client commits:** valun-open `6c437e0`: Python 415 tests OK; SDK interop 5 OK; JS 509 tests,
  508 pass, 0 fail, 1 skipped; the TypeScript declarations type-check (TypeScript 6.0.3, strict); vectors, package and
  plugin `17e9be4`, with `--require circulation/1`: 1461 checks, 1260 agree, 0 disagreements, 17 informative, 184 n/a
  (without: 1459 / 1104 / 0 / 338 n/a). Plugin `17e9be4`: 150 tests OK on both Pythons; `check_plugin_core` unchanged.
- **End to end at the final commits:** `node scripts/e2e-python-client.mjs`, all five runs, valun-app `4032eaa` with
  valun-open `6c437e0` and the plugin `17e9be4`: sandbox, on (one pause after a 429), mcp, clients and faults all PASS;
  399 checks ok, 0 FAIL. The real-Hermes five-step sandbox tour at `17e9be4` (a clean clone, a fresh Hermes home):
  "The tour is complete", hold 0, owe 0, 2 PC cleared by set-offs; 8 approvals, 10 tool calls, 0 blocked; both
  set-offs signed during `valun_status`.

What the full container rehearsal at `b7ecca0` showed:
- **Linux suite:** 355 tests: 344 pass, 2 fail, 7 skipped (files the image does not hold), 2 todo. The 2 failures are
  the two transfer tests that `4032eaa` fixed.
- **Startup log:** `Pilot: tracker capabilities: basis valun-circulating-credit/4, commit 43704183e1ba, …` and
  `Pilot: circulating credit: on`.
- **`/pilot/v1/info`:** features `bound_notes/1` and `circulation/1`. `novation` has the four contract fields:
  `tracker_build` `valun-circulating-credit/4`, `transfer_version` 4, `bound_note_version` 3 and `prior_ack`
  `basis/prior-ack/1`.
- **`basis.pin`:** the text above, without "(binary not pinned)".
- **e2e against it** (`--modes on --only tour,calls,probes`): PASS, 149 checks ok, 0 FAIL.
- **Memory:**
  - idle: 117.6 MiB total, the highest total in the 30 s before the load;
  - peak under load: 128.3 MiB total. The per-process maxima over the run (app 97.2, demo tracker 14.1, pilot tracker
    14.5, shells 3.5 MiB) were not reached at the same moment;
  - VmHWM: app 96.6, trackers 13.4 / 14.5 MiB;
  - PSS: 94.6 / 7.2 / 8.4 MiB.

  Sections 5 and 14 (v3.1) gave 128.7-131.5 MiB.
- **Afterwards:** staging folder removed, ports free.

**What the same-prior exemption allows, and what still waits**
- **Allowed at once:** a new attempt of a deal through the same note that acknowledges the same prior state (total and
  timestamp) of the edge it changes first. For a transfer that is the same from-edge A->B at the same (total,
  timestamp); for a bound note, the same edge at the same state. This is the common retry, after a refused, expired,
  cancelled or owner-rejected attempt whose edges did not move. The tracker lets at most one of them apply. The server
  (`samePriorState`) and both 0.4.0 clients (R11) apply the same rule.
- **Still waits for the earlier attempt's window** (`409 transfer_window_open {retry_after_ms}` until `fallback_after`,
  T + 1 h + 60 s; the clients add 2 min):
  - another issuer;
  - another kind of payment: an own note, or a transfer after a refused bound note;
  - the same note after its edge moved, which is a new prior.

  Relaxing the moved-edge case is a later step (design v3.2, section 4).
- **Unchanged:**
  - no regeneration: the server makes no transfer again by itself;
  - an attempt the edge journal proves dead never blocks;
  - the identical operation (the same note, prior and T) is not held back.

**Risk changes**
- R-17: **closed** (section 6).
- VS-1 (section 12): closed at the root.
- R-1: updated. The e2e probes make the same-issuer retry at once again, and it is a separate attempt with its own
  server id.
- Owner decision 8 (section 7): a same-prior retry is at once again; every other case still waits for the window.
- R-2: the compat test passed on v3.2, still on synthetic data.
- R-3: 128.3 MiB on v3.2.
- R-22: partly closed on v3.2. Still open:
  - MIG-3 on Fly;
  - the rehearsal on a copy of the live volume (runbook step 3);
  - the client's "MAY HAVE APPLIED" text.
- docs/DEPLOY-0.4-RUNBOOK.md now deploys tracker v3.2.

**Still open after this section:**
- MIG-1's alarm-only behaviour (R-18);
- journal compaction (R-19);
- the Fly-side rehearsals (R-22);
- the client's "MAY HAVE APPLIED" text for a server-ended attempt (R-22);
- the moved-edge case of the exemption (a later step);
- the CI's plugin pin (runbook P5);
- the owner decisions of section 7.

Nothing is pushed, deployed or published.

## 16. Deployed and published (2026-11-10/11, owner-approved: deploy now and turn circulation on in stages as checks pass; publish everything; $5 cap for the rehearsal on a copy)

**Live:** valun-desk.fly.dev runs server release v16 (code `4032eaa`, deploy commit `fe0fd77`) on tracker v3.2
(`43704183e1ba…`, basis_server `e13d37b4…`, valun_signer `dff60f9d…`; Fly release 16, image
`deployment-[redacted]`), with `PILOT_CIRCULATION=on` since 2026-11-11 11:31 UTC. The rollback image is
v15's, `registry.fly.io/valun-desk@sha256:[redacted]`. Captures and
logs: `C:/Users/USER/valun-deploy-20261110T170934Z`.

| step | result |
|---|---|
| 0 | Live state recorded (Fly release v15, one 256 MB machine, volume `vol_[redacted]`, one secret `VALUN_WRITE_TOKEN`); public answers captured twice, byte-identical; persistence baselines after a restart (pilot: 13 notes, 13 rows, 17 participants; demo: 4 notes, 6 offers, 5 participants); held notes 0; MemAvailable 122 MiB. |
| 1 | SNAP1 `vs_[redacted]`; SNAP5 `vs_[redacted]` right before step 5. |
| 2 | Not repeated: run 2026-11-10 at `4032eaa` (section 15); the deploy commit adds docs only. |
| 3 | Rehearsal app `valun-rh-[redacted]` (no public IP), volume from SNAP1: v15 image baseline (only `writeTokenRequired` differed: the copy had no secrets); v16 + v3.2 in mode off: entrypoint hash `e13d37b4…`, capabilities v4, pin text exact, byte identity with v15 apart from `basis.pin`, persistence SAME before and after a restart; then bound, sandbox and on (features, the four contract fields, clearing 200, every row `match`, memory about 85 MiB app); rollback R1 (dry run: OK, nothing to purge), R3 (maintenance mode: prepared, backup written, nothing started), R4 (v15 image on the v3.2-written folders: v15 pin, no features, every row `match`, persistence SAME). Destroyed. |
| 4 | `dist/bin` = the v3.2 pair; the 3df7ed93 pair kept in `dist/bin-3df7ed93/` (`2ab041f7…` / `8d7bb6ea…`). |
| 5 | Deployed (mode off): entrypoint hash, capabilities v4, `circulating credit: off`, image binaries pinned, pin text exact; byte identity with v15 apart from `basis.pin`; persistence SAME before and after a restart; memory 112 MiB available (app 85 MiB). One write in mode off (a throwaway sandbox participant, 3 PC to sandbox-exact, verified exactly): the compare listed exactly one new note, one `match` row and one participant, nothing gone; new baseline `/data/ops/pilot-after5.json`. |
| 6 | `bound`: logs, `['bound_notes/1']`, the four contract fields; a bound note by a throwaway participant (timestamp ending in 997; prior acknowledgment accepted by the live tracker); every row `match`; no ALARM. |
| 7 | `sandbox`: both features, contract fields, `/pilot/v1/clearing` 200, `pilot-admin clearing status` clean; the five-step stranger tour on live with a throwaway participant: "The tour is complete" (6 PC earned, 6 spent: 4 by debt transfer, 2 with its own note; set-offs cancelled 2 PC each way); 17 rows, all `match`; after the tour the app used 100 MiB, 102 MiB available, no ALARM. |
| 8 | `on`: logs, features, contract fields, clearing 200; the engine excludes the 15 participants who joined before circulation (`not_member`, LEGACY mandates) as designed; 17 rows `match`. |

**Deviations from the runbook (all owner-visible, none changed what runs):**
- No 24-hour soak between the stages: the owner chose to turn circulation on as each stage's checks passed.
- SNAP6-SNAP8 were not taken: Fly refused another manual snapshot so soon ("already scheduled"); SNAP5 (before the v16
  deploy) is the newest manual snapshot. Fly's own daily snapshots continue (retention 5 days).
- The local `fly proxy` to the rehearsal copy was stopped by Claude Code under memory pressure on this PC; the copy's
  checks were then made with `fly ssh` (node and `/proc` scripts; the image has no curl or ps), and the e2e script was not
  run against the copy (it ran against the local container rehearsal, section 15).
- Fly's Depot builder could not push to the registry for the copy, and the copy's first image vanished from the
  registry overnight; every later build used Fly's own remote builder (`--depot=false`), including the live deploy.
- Not checked live: step 7 item 4 (participants outside the sandbox see 404 on circulation routes; covered by tests),
  and the owner console in a real browser (R-10).

**Published:** plugin 0.4.0 to fitzss/hermes-plugin-valun `main` (`296b9e5`); valun-open to `main` (`de250c4`, then
`fe9c571` to re-run CI after a macOS runner was never assigned; CI 35/35 green) and tag `v0.4.0` at `fe9c571`: the release
workflow published PyPI `valun` 0.4.0, npm `@fitzdoud/valun` 0.4.0 (latest, with provenance) and the MCP Registry entry
`io.github.fitzss/valun` 0.4.0; a clean `pip install valun==0.4.0` runs. Hermes catalog PR #150363 now pins 0.4.0
(`dd136bc0` on `add-valun`, on top of the maintainer's disclosure commit `bcf26d76`, which it keeps, updated for 0.4.0;
`scripts/validate_plugin_catalog.py` OK).

**Left on the live volume:** `/data/ops` (the v16 persistence checker and the baselines), kept for comparisons while the
new release settles; remove it with `fly ssh console -a valun-desk -C "rm -r /data/ops"` when no longer wanted.

## 17. Release v16.1 (server, 2026-11-11; local only, nothing deployed)

**What changed.** Three server changes on top of the deployed v16 (`4032eaa`), in commit `595be89` (branch
`circulation-v16`; code, tests, docs/PILOT-API.md, two runbook notes). docs/PILOT-API.md has the details.
- **MIG-1: refuse instead of alarm (R-18).**
  - *When:* the pilot tracker's capabilities have been read and do not validate as tracker v3.2's (none at all, as on
    the 3df7ed93 build or after a failed read; a tracker v3.1; anything else), and the state holds circulating-credit
    history: a novated (bound-only) edge, a transfer or set-off record, a recorded bound note, or anything
    `revivableSignatures()` counts.
  - *What:* every pilot write to the tracker is refused before anything is sent or recorded, with `503
    tracker_downgraded {retry_after_ms: 60000}`. That covers `complete`, an owner's approval of a held note or of a held
    payment by transfer (a rejection is allowed), `pay-by-transfer`, consents to transfers and set-offs, the clearing
    engine, and so the sandbox agents.
  - *Recovery and reads:* recovery still reads and records what a read-back decides, but sends nothing. Reads and the
    demo world are unchanged.
  - *Seen by the operator:* `GET /pilot/v1/info` gains `writes_refused {code, since, reason, fix}`. `/pilot/v1/info` was
    chosen because `/api/status` describes the demo world's tracker; the live check already reads `/info` and now FAILs
    on the key.
  - *Logs:* one `ALARM` when the refusal starts (MIG-1's alarm, unchanged in substance) and one line when it lifts,
    audited as `pilot.writes_refused` / `pilot.writes_resumed`.
  - *Lifting:* while refusing, server.mjs's 60 s timer reads the capabilities again (`Basis.refresh`). A tracker v3.2
    answer lifts the refusal, the requested mode applies as at startup, and the clearing engine starts if that mode
    needs it.
  - *A v15 state* is never refused.
- **SV-ROB-1: the edge journal's checkpoint (R-19).**
  - *What:* `pilot-edge-log.jsonl` is compacted: the entries up to a seq K become a checkpoint, written to a new file and
    renamed. The checkpoint is a header, per-edge lines, per-deal sums for `pair_changes_since`, and each edge's last
    entries as of K.
  - *The horizon:* only entries older than 31 days may go, and the cut stops before anything an attempt of an unpaid
    deal, or an unresolved one, could still read (D-2 e). Why 31 days: attempt windows last an hour, records are pruned
    after 7 / 30 days (R-6), and the clients keep theirs 7 / 30 days, so 31 days leaves a day of margin.
  - *When:* at startup and on the timer, at most once a day, only over 16 MiB.
  - *What it keeps correct:*
    - completeness is now "the checkpoint plus every seq from K+1";
    - the index starts after K;
    - `GET /edges` from an older `since` answers 200 with the kept entries (real entries, which the 0.4.0 clients read
      as an ordinary page; their `sync_edges` / `syncEdges` code is byte-identical to the v0.4.0 tag's) and a
      `checkpoint` key;
    - `pair_changes_since` keeps exact per-kind sums;
    - D-2 e is fail-closed where entries were dropped.
- **next_actions by the routes' rule.**
  - *next_actions:* deal views are now judged by `paymentBlock`, with the tracker's state of the notes it needs
    (`dealView`, used for every served deal view). After a note moved outside Valun they no longer offer
    `pay_by_transfer` while the route answers `409 transfer_window_open`.
  - *payment-options:* `edge_busy` is now the transfer route's own check. It used to miss a credit note being issued or
    held for an owner on the edge.
  - *Two existing tests* in test/transfer.test.mjs pinned the old journal-only next_actions, and said so in their
    comments. They were updated: the route's refusal they assert is unchanged.

**lib/ sources changed** (the vector generator pins their sha256; committed bytes at `595be89`):
- `lib/pilot/core.mjs` `bec8eb8b54f629bd8982264edc05fef519febef6f3dbaeb180623b790774e9e0`;
- `lib/pilot/http.mjs` `d3563f544770b48fdf768486e55f932d496a895c9023d2d98ab5afdbda0acc0b`;
- `lib/pilot/journal.mjs` `1993684a60b5e824f95b0baa96d9dea7fa56d8b3d5bc720a05414fbe0eadf43a`.

Every other `lib/` file is as at `4032eaa` (and `b7ecca0`). Outside `lib/`: server.mjs, public/pilot.js (a compacted
`pair_changes_since` item shows its count), scripts/live-check.mjs, and the tests (test/release-v16-1.test.mjs and
test/fixtures/compact-journal.mjs, new).

**Tests that fail without the change.** test/release-v16-1.test.mjs has 10 tests, plus 1 new test in
test/live-check.test.mjs. They were run against a `git archive` of `4a41ab2` with only the new test files copied in:
all 10 fail there.
- The refusal test fails on behaviour: the old server accepts and sends the credit note.
- The next_actions test fails on behaviour: the served view offers `pay_by_transfer`.
- The payment-options test fails on behaviour: `why_not` is null where the route answers `edge_busy`.
- The other seven fail on the API they test, which does not exist there: `writeRefusal`, `recheckTracker`,
  `journalProtection`, `maybeCompactJournal`, and the compacting child process. The v15-state test is a guard that the
  new refusal never triggers without history, so it can fail on the old code only that way.
- The existing MIG-1 alarm and audit tests (test/audit-fixes.test.mjs) pass unchanged.

**Runs at `595be89`** (Windows dev machine, 2026-11-11, one at a time)

| run | result |
|---|---|
| `npm test` with the 3df7ed93 pair (default) | 373 tests: 276 pass, 0 fail, 95 skipped (need tracker v3.2), 2 todo; exit 0; 70 s |
| `VALUN_BINS=<v3.2> npm test` | 373 tests: 371 pass, 0 fail, 0 skipped, 2 todo; exit 0; 467 s (at `4a41ab2`: 362) |
| `SOAK_CIRCULATION=1 VALUN_BINS=<v3.2> node --test test/soak.test.mjs` (seed 20261107) | pass: 600 actions, 12 participants, 147 s; 616 invariant checks, 1258 responses scanned, 125 novation signatures followed, 108 journal entries; transfers applied 9, resolved not applied 2, void key revoked 1; set-offs applied 6, void key revoked 1, expired 1 |
| `VALUN_OLD_BINS=<3df7ed93> VALUN_NEW_BINS=<v3.2> node --test test/tracker-compat.test.mjs` | 6 tests, 6 pass, 0 fail (29 s). Its step (e) now runs with the pilot refusing writes on the 3df7ed93 binary, since the v3.2-written folder has circulation history, and its reads pass |
| `node scripts/e2e-python-client.mjs` (all five runs; `VALUN_BINS=<v3.2>`, `E2E_HERMES_HOME=C:/Users/USER/hv15`) | exit 0: runs sandbox, on, mcp, clients and faults all PASS; 419 checks ok, 0 FAIL, no 429 pause (clients: valun-open checkout `cd04349`, whose `sync_edges` is v0.4.0's; the plugin `042fb55`). The empty Hermes home was removed afterwards |
| valun-open's `spec/vectors/generate.mjs`, copied to a scratch folder and run on a `git archive` of `595be89` (`VALUN_APP_DIR`; valun-open not touched) | exit 0: every assertion pinned to release v16's behaviour holds; all seven vector files equal the committed ones apart from their `meta` (the server source, "not a known release"), so nothing the vectors cover changed on the wire |
| the 150 000-entry journal (test/release-v16-1.test.mjs, child under `--max-old-space-size=128`, entries 40 days old plus 600 recent) | before compaction: the restart and index build took 260 ms, with 6.7 MiB of index arrays and 4.6 MiB of heap added (index capacity 150 601). Compaction: 327 ms, 86.8 MiB to 0.3 MiB, 149 997 entries dropped, 3 kept. After: 3 ms, 0.2 MiB of arrays and 0.4 MiB of heap added (capacity 1 024; 603 indexed entries) |

**Risk changes:** R-18 and R-19 are closed in code by release v16.1, which is **not deployed**: the live server is still
v16 (`4032eaa`), so until a deploy the mitigations in section 6 stand.

**Not done, or for later:**
- No deploy, push or publish; `dist/bin` was not touched. The container rehearsal (Linux) was not run for v16.1.
- The vectors (valun-open) pin v16's `lib/` sha256s, so the generator labels this server "not a known release" until a
  v16.1 release entry with the three sha256 above is added there (runbook P2, R-21). Its output is otherwise the same
  (row above).
- Spec 18.14 does not name the `checkpoint` key, the compacted `pair_changes_since` items or `tracker_downgraded` yet
  (a valun-open follow-up).
- server.mjs's lift path (startClearing after a lifted refusal) is covered by the unit test of `recheckTracker`, not by
  a test that starts server.mjs.
