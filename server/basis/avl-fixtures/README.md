# avl-fixtures: the Rust reference for lib/avl.mjs

`lib/avl.mjs` recomputes the AVL+ digest a Basis tracker anchors in R5 of its tracker box (fix inbox #62). Its
references come from the Rust crate the tracker itself builds its note tree with, ergo_avltree_rust 0.1.1 as upstream
Basis vendors it (`temp/vendors/ergo_avltree_rust`; tracker v4.4, fork commit 321f09b, has the same crate). This folder
is the source of the tool that computed them: `anchor-audit` (the package keeps its name), a 49-line audit of a
published ledger, extended with the two fixture modes. CI never builds Rust; the fixtures are committed.

| command | what it prints |
|---|---|
| `anchor-audit LEDGER_JSON [EXPECTED ...]` | the audit, unchanged: the digest of a GET /pilot/v1/ledger file's notes (erg keys) in debt-key order and in timestamp order, and MATCH or differs for each expected digest |
| `anchor-audit --random-fixtures` | `test/fixtures/avl-random.json`: 1,350 cases (1,000 inserted in ascending key order, 250 in random order, 100 with keys inserted again) of 0 to 600 entries, stored as seed, size and digest; plus splitmix64 and entry vectors, debt keys in erg and token denominations, explicit rows with tokens and totals up to 2^64 - 1, and the empty tree's digest |
| `anchor-audit --rows FILE` | for `{"rows": [{issuer_pubkey, recipient_pubkey, denomination, total}]}` (total a decimal string): `{"count", "debt_key_order", "given_order"}`, the digest of the rows in ascending debt-key order (what the tracker anchors) and in the order listed. On `test/fixtures/anchor-vectors/<height>.json` it gives `r5_digest` and `timestamp_order_digest` |

The case generator (splitmix64, the byte layout of keys and values, the orders) is stated in the fixture's own `prng`,
`entry` and `orders` fields, and implemented again in `test/avl.unit.test.mjs`. Every digest the fixture modes print is
computed three ways, and the tool panics unless they agree: plain Inserts (what `lib/avl.mjs` ports); as tracker v4.4
applies each note to the tree it rebuilds after every write (TR-19: an Update, then an Insert when the Update fails, the
digest read after every entry); and as upstream `basis_store` applies an insert (`generate_proof` after every Insert).

## Where it is built

In the WSL distro `valun-ic1` (Ubuntu 24.04, Rust 1.98.1 at `/opt/valun-ic1/rust-1.98.1`), in `~/anchor-audit`. That
distro has no `/mnt/c` and no interop, so files move through stdin and stdout. `~/anchor-audit` holds:

- `Cargo.toml`, `Cargo.lock` and `src/main.rs`: this folder's files;
- `ergo_avltree_rust/`: a copy of upstream Basis's `temp/vendors/ergo_avltree_rust`; with LF line ends its sources
  hash (sha256) as in the fork's checkout:

  | file | sha256 (LF line ends) |
  |---|---|
  | `src/authenticated_tree_ops.rs` | `23a86829e3b737dca15bdc6e535eb5e85ae3eb566e49c0d3dbbeb689e46bfe43` |
  | `src/batch_avl_prover.rs` | `e29d8dafd7b05bef5e65ea24dd9cf1b0d9ad97ad77016044ff371b981c65c6f7` |
  | `src/batch_avl_verifier.rs` | `a7e50e83a1cdff7d3175b50216f1ab13ff756507470f1dc8ca6a1c9cf3342a0a` |
  | `src/batch_node.rs` | `fb4b46ab2d6b3d124dd50a957c3724fdf78d508c364da10a0a0c72bd0f140f63` |
  | `src/lib.rs` | `08f3f53fa1c21d65c392906a294fc8fd0f8c2b7a9b98492b9bf0ae75f45107b0` |
  | `src/operation.rs` | `9151ea5f5daf2b6f836a2316c6e17384aa1d7cdbab86651849231a57a213aaba` |
  | `src/persistent_batch_avl_prover.rs` | `d7ae17c898ad17989ea1ffac95625ed7b37d4924b567bc68fcd4946f99930eb8` |
  | `src/versioned_avl_storage.rs` | `d715d138843d618ec05b35c014c3d22cb74575789506b268ed0b2ae504ccbe61` |

- `.cargo-home/`: the `CARGO_HOME`, whose registry cache holds the crates `Cargo.lock` names, so the build runs offline.

## Rebuild and rerun

From this repository's root, in Git Bash on Windows. `wsl.exe` hands its arguments to the distro's shell first, which
expands `$NAME` there (with the distro's values), so a variable meant for the inner `bash` is written `\$NAME`.

```
tar -cf - -C basis/avl-fixtures Cargo.toml Cargo.lock src/main.rs | wsl.exe -d valun-ic1 -- bash -c 'cd ~/anchor-audit && tar -xf -'
wsl.exe -d valun-ic1 -- bash -c 'export PATH=/opt/valun-ic1/rust-1.98.1/bin:$PATH CARGO_HOME=$HOME/anchor-audit/.cargo-home; cd ~/anchor-audit && cargo build --release --offline'

# the random fixtures (the output is deterministic: it must equal the committed file byte for byte)
wsl.exe -d valun-ic1 -- bash -c 'cd ~/anchor-audit && ./target/release/anchor-audit --random-fixtures' > test/fixtures/avl-random.json

# the live vectors' two digests
tar -cf - -C test/fixtures anchor-vectors | wsl.exe -d valun-ic1 -- bash -c 'mkdir -p ~/anchor-audit/vectors && cd ~/anchor-audit/vectors && tar -xf -'
wsl.exe -d valun-ic1 -- bash -c 'cd ~/anchor-audit && for h in 644995 645135 645189; do ./target/release/anchor-audit --rows vectors/anchor-vectors/\$h.json; done'
```

The last command prints, for heights 644995, 645135 and 645189:

```
{"count":250,"debt_key_order":"da212e4773a6894d0cd2131551ae58e315943282f27400efd5fbb23e1e2d772808","given_order":"be6c8c55a438cb145a344bb42e1b2b81a5b946f7742bda3dfd3c2c3e09a41c3809"}
{"count":251,"debt_key_order":"0d60d54d9871d4ecfc1d9eb1dbaf69a2eef75730b92425b24b6ab00104fe7aa508","given_order":"ff315d3eb6143e6664734cce82e2326ddfd1d98e1b5ea89ac97515b93afe5ac009"}
{"count":251,"debt_key_order":"237616c865b69edef051b6b1edc3adf4072bf4d602cc174561fbc74fe8ec64e708","given_order":"02ae4ae527254ffb34c4f60a8152d194e6e80bf2dadf6ebdf196223bc6dcd35709"}
```

## The live vectors

`test/fixtures/anchor-vectors/<height>.json` come from public reads of 2026-11-14: GET /pilot/v1/ledger (the rows),
the Ergo testnet explorer's unspent boxes holding the tracker NFT (exactly one each time: `box_id`, `height`, `tx_id`,
`r5`) and GET /pilot/v1/chain (whose confirmed digest, box and height agree). A row keeps a note's `issuer_pubkey`,
`recipient_pubkey` and `total` (as a decimal string), with `denomination` `erg`; handles, participant ids, timestamps
and redemption fields are left out. The rows are listed in the order of their notes' timestamps (equal timestamps in the
ledger's order), which is how the ledger mode sorts them for its "timestamp order", so `given_order` above is that
digest; the ledger mode, run on the three ledger reads, prints the same three timestamp-order digests.

The vectors are not in the server's public copy (valun-open `server/`): side by side, dated snapshots of every note show
each edge's history, and publishing them is the owner's call. There `test/avl.unit.test.mjs` skips the two tests that
need them; its other tests use the fixture's explicit rows. The R5 digests and heights above are public on the chain.
