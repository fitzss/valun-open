# Basis binaries used by Valun

Two tracker builds are in use. `dist/bin/` (what the Docker image ships) still holds the first one, Basis 3df7ed93.
Tracker v3.2 is the build circulating credit needs (server release v16); putting it into `dist/bin/` is a deployment
step the owner decides (it has not been done). Tracker v3.1 was never deployed or released and is superseded: its
prior acknowledgments bind only the prior total (audit VS-1).

| build | basis_server sha256 | valun_signer sha256 | used by |
|---|---|---|---|
| Basis `3df7ed93` (upstream source) | `2ab041f7ced2c8b2b0762ec32bd26b89d953a9bc59a939d57a66e08151aac74b` | `8d7bb6eae99d681439a33bce41f2b6444e2731d9d124aba33d35199d8af3da01` | `dist/bin/` (the image), the default of `npm test` and `scripts/start-local.mjs` |
| tracker v3.2, Valun fork commit `43704183e1ba372e1b1788c414dfe4c8b0bc3f2a` | `e13d37b4287ce8d1026eb6a7f10e78a0ef6cc4a4bb55d385d9b286d25292eea5` | `dff60f9d4da03b81e94d8bfdebca5b0926e74d4d743cb676447eca3ff0308d3a` | circulating credit: the only hash pinned in `lib/pilot/pins.mjs` |
| tracker v3.1, Valun fork commit `24675ec1c0f374f29101812caf2fc87ab48468c9` (superseded) | `cc0a6adea0c4b457f7d6b61f76f7e9444c6353eea1b9c1a2b482d71f3c76a0a8` | `314beace9ca1d30d69384ee729b99492075f09b0b4032e52d49d30703ae46700` | nothing: it reports build `valun-circulating-credit/3` (transfer version 3, bound notes version 2, no `prior_ack`), which `lib/pilot/caps.mjs` refuses, so it is no longer pinned and circulation stays off on it |
| tracker v3, Valun fork commit `08f889931906beff6c2b69346965f400d740aa4a` (superseded) | `9eca6480dcb20769a17f74671a13b2ba828ace7147cfca9688a28c44e0ee81f1` | `314beace9ca1d30d69384ee729b99492075f09b0b4032e52d49d30703ae46700` | nothing: it reports `bound_notes` version 1, which `lib/pilot/caps.mjs` refuses, so it is not pinned and circulation stays off on it |

## Basis 3df7ed93 (the build `dist/bin/` holds)

Built 2026-11-05 in WSL `valun-ic1` (Ubuntu 24.04, Rust 1.98.1), offline (`cargo build --frozen --release`), from the
accepted IC-1 source copy: Basis `3df7ed93ee83ddf0d4e8ce567f54cefbbd7255b3` + sigma-rust `8120eddd` (path overlay).
Build folder: `/home/valun/valun-app-bins-20261105T024815Z` (own CARGO_HOME copy; the accepted source folder was only read).

| binary | sha256 | what |
|---|---|---|
| `t/release/basis_server` | `2ab041f7ced2c8b2b0762ec32bd26b89d953a9bc59a939d57a66e08151aac74b` | upstream tracker, unchanged source |
| `t/release/basis_cli` | – | upstream wallet CLI (built; not used, see below) |
| `t/release/examples/valun_signer` | `8d7bb6eae99d681439a33bce41f2b6444e2731d9d124aba33d35199d8af3da01` | `valun_signer.rs` added as an example of `basis_core` |

It needs the `[ergo.node]` config layout (`basis/run-tracker.sh` picks it by itself: `BASIS_CONFIG_LAYOUT=auto`).

## Tracker v3.2 (circulating credit)

**Source.** WSL `valun-ic1`, worktree `ROOT/v32` (`ROOT` = `/home/valun/basis-transfer-20261108T012005Z`), branch
`circulating-credit-v3.2`, commit `43704183e1ba372e1b1788c414dfe4c8b0bc3f2a` (not pushed anywhere). On top of tracker
v3.1 (`24675ec`, below: Basis master `6a6ebfe` + `caa2e86` + `a00233d` and the Valun commits up to `24675ec`), the
Valun commits are `173c19d` (TR-8: `basis_core` `prior_ack_message`, the 105-byte acknowledgment
`basis/prior-ack/1`), `aed2b54` (TR-9: transfers version 4 and bound notes version 3 check their prior slots over it;
optional `from_prior_timestamp`, `to_prior_timestamp` and a bound note's `prior_timestamp`, 409 `stale_prior` when they
differ; GET /capabilities build `valun-circulating-credit/4`), `f0de65e` (TR-10: regression tests for audit VS-1 and
R-17 that fail on v3.1), `15b5b8e` (TR-11: the tracker e2e drivers), and three commits from the independent
review of the v3.2 change: `1a8bfe5` (TR-12: a staged exchange is cancelled when its to-edge's stored timestamp is
not earlier than the staged note's, and a guard before every storage write refuses a timestamp that is not later
than the stored one, so an edge's (total, timestamp) state cannot recur: the premise of the prior acknowledgment),
`3d61eb9` (TR-13: comments; a stored (0, 0) note is the absent state) and `4370418` (TR-14: exchange timestamps
must end in 995 ms; pre-existing exchange code, not reachable in pure-credit mode; see its commit message before
offering it upstream). The capabilities are unchanged apart from `commit`.

The prior acknowledgment (design v3.2 section 2), which `lib/basis.mjs` `priorAckMessage` asks the signer for:

```
PA(I, R, X, p, T) = "basis/prior-ack/1" (17 ASCII bytes) || debtKey(I, R, denomination) (32) || X (u64 BE) || p (u64 BE)
                    || T (u64 BE) || trackerNftId (32)                                                      = 105 bytes
```

X is the edge's stored total, p its note's timestamp (0 and 0 for an edge with no note), T the operation's timestamp.
A transfer's `from_recipient_prior` and `to_recipient_prior` signatures and a bound note's `prior_signature` are over
PA; every other slot (and every set-off slot) is still the 80-byte note message.

Two local changes stay out of the commits, as for v3.1:
- the root `Cargo.toml` `[patch.crates-io]` paths point `ergo-lib`, `ergotree-ir` and `ergotree-interpreter` at the
  sigma-rust copy in `ROOT/sigma-rust`; the edited file's sha256 is
  `4d871873153938c0a65b3aaa067ae90e18839e2b914bccfb96456693a0cfb00c` (the same edit as for v3.1);
- `crates/basis_core/examples/valun_signer.rs` (untracked) is a copy of `basis/valun_signer.rs` (sha256
  `f164d78e9a3556ef94cb4dc89f2a6ca6526cf603e25d8dfc07bfd550059c7d00`, byte for byte), which adds the subcommand
  `prior-ack-message ISSUER RECIPIENT PRIOR_TOTAL PRIOR_TIMESTAMP TIMESTAMP TRACKER_NFT [DENOM]` (it prints
  `{"message_hex","debt_key_hex"}` as `note-message` does, and calls `basis_core::prior_ack_message`).

`basis_core` is no longer byte-identical to Basis 3df7ed93: `git diff 3df7ed93 HEAD -- crates/basis_core` is one file,
`crates/basis_core/src/types.rs`, 137 lines added and none removed (`prior_ack_message`, its tag constant and its unit
tests, which pin the bytes and the length). The change is additive: key derivation, `signing_message` (the 80-byte note
message) and the Schnorr functions are unchanged, so valun_signer signs and verifies note messages exactly as before. A
cross-check against the v3.1 signer passed (the same public keys, identical note messages in erg and token, signatures
accepted both ways; a PA signature verifies under both signers, the same signature does not verify over the 80-byte
M(A,B,X,T), a tampered one is refused), and the signer reproduces the shared vector of design v3.2 section 7.

**Build** (offline, as user `valun`; the tracked tree must be clean apart from the `Cargo.toml` edit):

```
cd ROOT/v32
export PATH=/opt/valun-ic1/rust-1.98.1/bin:/usr/bin:/bin
export CARGO_HOME=ROOT/cargo-home-v32 CARGO_TARGET_DIR=ROOT/target-v32
export BASIS_GIT_COMMIT=$(git rev-parse HEAD)          # GET /capabilities reports it as "commit"
cargo build --release --offline -p basis_server
cargo build --release --offline -p basis_core --example valun_signer
sha256sum $CARGO_TARGET_DIR/release/basis_server $CARGO_TARGET_DIR/release/examples/valun_signer
grep -a -c "$BASIS_GIT_COMMIT" $CARGO_TARGET_DIR/release/basis_server     # 1: the commit is embedded
```

The binaries embed the `CARGO_HOME` path (its registry sources appear in panic locations: `grep -a -c cargo-home-v32`
counts 90 in the staged basis_server and 6 in valun_signer; the target folder's name does not appear), so the two
sha256 values above are reproduced only with `CARGO_HOME=ROOT/cargo-home-v32` at that `ROOT` (keep
`CARGO_TARGET_DIR=ROOT/target-v32` as well, and the same toolchain, sigma-rust copy and `Cargo.toml` edit); another
path gives other hashes, which must then be checked and pinned before circulating credit runs on them. Never
pass `--ignored` or `--include-ignored` to `cargo test` there: those tests contact a public Ergo node.

**Staged** at `/home/valun/valun-app-bins-v3.2-20261110T135332Z/t/release/{basis_server, examples/valun_signer}`, the
layout `VALUN_BINS` names (`test/tracker-harness.mjs`, `scripts/start-local.mjs`); copied from the build folder with
the same sha256 values (read again from the staged files when this file was written).

**What it reports.** `GET /capabilities` (exact): build `valun-circulating-credit/4`, commit `43704183e1ba…`,
`pure_credit` true, reserved residues 995-999, `bound_notes` `{ms: 997, version: 3, max_age_ms: 3600000, prior_ack:
"basis/prior-ack/1"}`, `bound_only_edges` true, transfer `{ms: 999, version: 4, signatures: [the seven names],
prior_ack: "basis/prior-ack/1"}`, set-off version 3 (998 ms, at most 64 edges, per-edge timestamps), maximum age
3 600 000 ms, `onchain_edges` 0, `novations_disabled_reason` null. Circulating credit takes effect only when these
values validate (`lib/pilot/caps.mjs`) **and** the running binary's sha256 is pinned (`lib/pilot/pins.mjs`); the
launchers compute that hash (`PILOT_TRACKER_SHA256`, see below).

**Config layout and storage.** As v3.1 (below): the `[ergo.scanner]` layout with `[server] pure_credit = true`, which
`basis/run-tracker.sh` picks by itself. The storage format is unchanged from v3.1 (no migration); data written by
3df7ed93 opens on it (`test/tracker-compat.test.mjs`).

## Tracker v3.1 (superseded; not pinned)

Kept for the record: tracker v3.2 is built on it, and its staged binaries remain in WSL. It reports build
`valun-circulating-credit/3`, which `lib/pilot/caps.mjs` no longer accepts.

**Source.** WSL `valun-ic1`, worktree `/home/valun/basis-transfer-20261108T012005Z/v3` (below: `ROOT` =
`/home/valun/basis-transfer-20261108T012005Z`), branch `circulating-credit-v3`, commit
`24675ec1c0f374f29101812caf2fc87ab48468c9` (not pushed anywhere). On top of Basis master `6a6ebfe`, `caa2e86` (debt
transfer) and `a00233d` (set-off), the Valun commits are `d9f663c` (residues, bound notes, bound-only edges), `aa39695`
(seven-signature transfers), `ff56240` (set-off v3), `08f8899` (GET /capabilities, pure_credit, roles, redacted
logging), `272ff4a` (e2e drivers only) and `24675ec` (v3.1: bound notes expire after one hour, decision D-1).
Two local changes stay out of the commits:
- the root `Cargo.toml` `[patch.crates-io]` paths point `ergo-lib`, `ergotree-ir` and `ergotree-interpreter` at the
  sigma-rust copy in `ROOT/sigma-rust` (ergo-lib 0.29.0; that copy carries no git metadata, so no commit is named
  here); the edited file's sha256 is `4d871873153938c0a65b3aaa067ae90e18839e2b914bccfb96456693a0cfb00c`;
- `crates/basis_core/examples/valun_signer.rs` is a copy of `basis/valun_signer.rs` (sha256
  `acf25be8a1e095faa4aac3aaa04568755896de85dbcc073e88f91f0b9a0c38a5`, the file as it was before release v16 changed
  the wording of its first comment line; the code and the line numbers are the same).
`basis_core` is byte-identical to Basis 3df7ed93 (`git diff 3df7ed93 HEAD -- crates/basis_core` is empty), so
valun_signer signs exactly as before; a cross-check against the 3df7ed93 signer passed (key derivation, note messages
in erg and token, signatures accepted both ways, tampered signatures refused).

**Build** (offline, as user `valun`; the tracked tree must be clean apart from the `Cargo.toml` edit):

```
cd ROOT/v3
export PATH=/opt/valun-ic1/rust-1.98.1/bin:/usr/bin:/bin
export CARGO_HOME=ROOT/cargo-home CARGO_TARGET_DIR=ROOT/target-v3
export BASIS_GIT_COMMIT=$(git rev-parse HEAD)          # GET /capabilities reports it as "commit"
cargo build --release --offline -p basis_server
cargo build --release --offline -p basis_core --example valun_signer
sha256sum $CARGO_TARGET_DIR/release/basis_server $CARGO_TARGET_DIR/release/examples/valun_signer
grep -a -c "$BASIS_GIT_COMMIT" $CARGO_TARGET_DIR/release/basis_server     # 1: the commit is embedded
```

Never pass `--ignored` or `--include-ignored` to `cargo test` there: those tests contact a public Ergo node.

**Staged** at `/home/valun/valun-app-bins-v3.1-20261108T121350Z/t/release/{basis_server, examples/valun_signer}`, the
layout `VALUN_BINS` names (`test/tracker-harness.mjs`, `scripts/start-local.mjs`). Both sha256 values above were read
again from the staged files when release v16 was documented.

**What it reports.** `GET /capabilities`: build `valun-circulating-credit/3`, commit `24675ec1c0f3…`, `pure_credit`
true, reserved residues 995-999, `bound_notes` `{ms: 997, version: 2, max_age_ms: 3600000}`, transfer version 3 (seven
signatures, 999 ms), set-off version 3 (998 ms, per-edge timestamps), maximum age 3 600 000 ms. Circulating credit
takes effect only when these values validate (`lib/pilot/caps.mjs`) **and** the running binary's sha256 is pinned
(`lib/pilot/pins.mjs`); the launchers compute that hash (`PILOT_TRACKER_SHA256`, see below).

**Config layout.** v3.1 refuses the `[ergo.node]` layout and needs `[ergo.scanner]` with `start_height = 0`, plus
`[server] pure_credit = true`; the 3df7ed93 build refuses the scanner layout. `basis/run-tracker.sh` with
`BASIS_CONFIG_LAYOUT=auto` (what every launcher passes) picks the layout from the binary itself: scanner when it
contains v3's message `rename it to [ergo.scanner]`.

## Why a signer example instead of `basis_cli`

At this pin, `basis_cli note create` reads the tracker NFT id from `GET /tracker/latest-box-id`, which returns 404 until an
on-chain tracker box exists. In pure-credit mode (no chain) the CLI therefore cannot issue notes. `valun_signer` calls only
`basis_core` functions (`generate_keypair`, `signing_message`, `prior_ack_message` (tracker v3.2), `schnorr_sign`,
`schnorr_verify`, `DenomKey::debt_key`); it contains no cryptography of its own, and the tracker verifies every
signature it produces.

## Rebuild and export

3df7ed93: copy the 3df7ed93 version of `valun_signer.rs` (this file before tracker v3.2 added `prior-ack-message`,
which needs `basis_core::prior_ack_message`) to `<source>/crates/basis_core/examples/` in a fresh copy of the source,
then `cargo build --frozen --release --config <overlay> -p basis_server -p basis_core --example valun_signer`.
Tracker v3.2: the commands above (v3.1: its own commands). Rebuilding at another commit (or with another
`BASIS_GIT_COMMIT`, `CARGO_HOME` or target folder) gives another basis_server sha256, which must then be checked and
pinned before circulating credit runs on it.

Export to `dist/bin/` by streaming through `wsl.exe ... /bin/cat` and compare sha256 on both sides. The launchers hash
the binary they start: `scripts/docker-entrypoint.sh` (`sha256sum /opt/valun/bin/basis_server`),
`scripts/start-local.mjs` (`sha256sum` of `$VALUN_BINS/basis_server` through WSL) and `test/tracker-harness.mjs`.
