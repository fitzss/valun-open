// anchor-audit: recompute the Basis tracker's AVL+ digest from a published ledger (GET /pilot/v1/ledger) and compare it
// with a digest the operator claims (GET /pilot/v1/chain) or one read from the chain. Read-only. Usage:
//   anchor-audit LEDGER_JSON [EXPECTED_DIGEST_HEX ...]
//
// It also writes the reference fixtures of lib/avl.mjs, the JavaScript port (fix inbox #62), with the crate tracker
// v4.4 builds its note tree with: ergo_avltree_rust 0.1.1 as upstream Basis vendors it (temp/vendors/ergo_avltree_rust).
//   anchor-audit --random-fixtures   print test/fixtures/avl-random.json: cases generated from seeds (FIXTURE_TEXT says
//                                    how), so the file holds seeds, sizes and this crate's digests, and a few small
//                                    explicit cases (debt keys, rows with token denominations)
//   anchor-audit --rows ROWS_JSON    for {"rows": [{issuer_pubkey, recipient_pubkey, denomination, total}]} (total a
//                                    decimal string, denomination "erg" or "token:<64 hex>", "erg" when absent), print
//                                    the digest of those notes in debt-key order (what the tracker anchors) and in the
//                                    order given
use std::collections::HashSet;

use blake2::{digest::consts::U32, Blake2b, Digest};
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::{AVLTree, LeafNode, Node, NodeHeader};
use ergo_avltree_rust::operation::{ADKey, ADValue, KeyValue, Operation};

fn resolver(_d: &[u8; 32]) -> Node {
    Node::Leaf(LeafNode { hdr: NodeHeader { visited: false, is_new: false, label: None, key: Some(ADKey::from(vec![0u8; 32])) },
        value: ADValue::from(vec![]), next_node_key: ADKey::from(vec![0u8; 32]) })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--random-fixtures") => random_fixtures(),
        Some("--rows") => rows(&args[2]),
        _ => ledger(&args),
    }
}

// The audit of a published ledger, as it was before the fixture modes (unchanged).
fn ledger(args: &[String]) {
    let raw = std::fs::read_to_string(&args[1]).expect("read ledger");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("ledger json");
    let notes = v["notes"].as_array().expect("notes");
    let mut kv: Vec<([u8; 32], u64)> = Vec::new();
    for n in notes {
        let i = hex::decode(n["issuer_pubkey"].as_str().unwrap()).unwrap();
        let r = hex::decode(n["recipient_pubkey"].as_str().unwrap()).unwrap();
        let total = n["total"].as_u64().unwrap();
        let mut h = Blake2b::<U32>::new();
        h.update(&i); h.update(&r);
        kv.push((h.finalize().into(), total));
    }
    let mut run = |order: &str, items: &Vec<([u8; 32], u64)>| -> String {
        let tree = AVLTree::new(resolver, 32, None);
        let mut prover = BatchAVLProver::new(tree, true);
        for (k, t) in items {
            let op = Operation::Insert(KeyValue { key: ADKey::from(k.to_vec()), value: ADValue::from(t.to_be_bytes().to_vec()) });
            prover.perform_one_operation(&op).expect("insert");
        }
        let d = hex::encode(prover.digest().expect("digest"));
        println!("{order:>22}: {d}  ({} notes)", items.len());
        d
    };
    let mut by_key = kv.clone();
    by_key.sort_by(|a, b| a.0.cmp(&b.0));
    let d_key = run("debt-key order", &by_key);
    let mut by_ts: Vec<([u8; 32], u64, u64)> = notes.iter().zip(kv.iter()).map(|(n, (k, t))| (*k, *t, n["timestamp"].as_u64().unwrap_or(0))).collect();
    by_ts.sort_by_key(|x| x.2);
    let d_ts = run("timestamp order", &by_ts.iter().map(|x| (x.0, x.1)).collect());
    for e in &args[2..] {
        println!("expected {e}: debt-key order {}, timestamp order {}", if *e == d_key { "MATCH" } else { "differs" }, if *e == d_ts { "MATCH" } else { "differs" });
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Digests. An entry is (key, value bytes); every function below starts from an empty prover over
// AVLTree::new(resolver, key length 32, value length None), as tracker v4.4 does.

type Entry = ([u8; 32], Vec<u8>);

fn new_prover() -> BatchAVLProver {
    BatchAVLProver::new(AVLTree::new(resolver, 32, None), true)
}

fn key_value(k: &[u8; 32], v: &[u8]) -> KeyValue {
    KeyValue { key: ADKey::from(k.to_vec()), value: ADValue::from(v.to_vec()) }
}

fn hex_digest(p: &BatchAVLProver) -> String {
    hex::encode(p.digest().expect("digest"))
}

// One Operation::Insert per entry, in the order given: the construction lib/avl.mjs ports (insertDigest).
fn digest_inserts(entries: &[Entry]) -> String {
    let mut p = new_prover();
    for (k, v) in entries {
        p.perform_one_operation(&Operation::Insert(key_value(k, v))).expect("insert");
    }
    hex_digest(&p)
}

// As tracker v4.4 applies each note to the tree it rebuilds after every write (TR-19; the fork's basis_trees
// BasisAvlTree::update): an Operation::Update, then an Operation::Insert when the Update fails (the key is absent), and
// the digest read after every entry, so labels are cached while later entries still change nodes in place.
fn digest_tracker_style(entries: &[Entry]) -> String {
    let mut p = new_prover();
    for (k, v) in entries {
        if p.perform_one_operation(&Operation::Update(key_value(k, v))).is_err() {
            p.perform_one_operation(&Operation::Insert(key_value(k, v))).expect("insert");
        }
        let _ = p.digest();
    }
    hex_digest(&p)
}

// As upstream Basis's basis_store AvlTreeState applies inserts: a proof generated for the empty tree and after every
// Insert, which clears the crate's is_new flags, so each later change copies the nodes it touches instead.
fn digest_proof_style(entries: &[Entry]) -> String {
    let mut p = new_prover();
    let _ = p.generate_proof();
    for (k, v) in entries {
        p.perform_one_operation(&Operation::Insert(key_value(k, v))).expect("insert");
        let _ = p.generate_proof();
    }
    hex_digest(&p)
}

// The digest of the entries, after checking that the three ways of applying them agree: the digest depends on the
// operations alone, not on how the crate's in-place updates and label cache were exercised.
fn checked_digest(entries: &[Entry]) -> String {
    let d = digest_inserts(entries);
    assert_eq!(d, digest_tracker_style(entries), "tracker-style application gives another digest");
    assert_eq!(d, digest_proof_style(entries), "proof-style application gives another digest");
    d
}

// Debt key, as upstream basis_core DenomKey::debt_key: blake2b256(issuer || recipient || token id), no token id for erg.
fn debt_key(issuer: &[u8], recipient: &[u8], denomination: &str) -> [u8; 32] {
    let mut h = Blake2b::<U32>::new();
    h.update(issuer);
    h.update(recipient);
    if let Some(t) = denomination.strip_prefix("token:") {
        let id = hex::decode(t).expect("token id hex");
        assert_eq!(id.len(), 32, "a token id is 32 bytes");
        h.update(&id);
    } else {
        assert_eq!(denomination, "erg", "denomination must be erg or token:<64 hex>");
    }
    h.finalize().into()
}

// ---------------------------------------------------------------------------------------------------------------------
// The deterministic generator (FIXTURE_TEXT states it; test/avl.unit.test.mjs implements it again in JavaScript).

// splitmix64 (Steele, Lea and Flood 2014), with its reference constants; all arithmetic mod 2^64.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    // 32 bytes: four outputs, each as 8 big-endian bytes, in order.
    fn key(&mut self) -> [u8; 32] {
        let mut k = [0u8; 32];
        for i in 0..4 {
            k[8 * i..8 * i + 8].copy_from_slice(&self.next().to_be_bytes());
        }
        k
    }

    // A total: one output picks the class (mod 10); the classes that need one take the next output.
    fn value(&mut self) -> u64 {
        match self.next() % 10 {
            0 => 0,
            1 => self.next() % 256,
            2 => self.next() % (1 << 32),
            3 => (1 << 53) - 3 + self.next() % 7,
            4 => (1 << 53) + self.next() % (1 << 53),
            5 => (1 << 63) - 3 + self.next() % 7,
            6 => u64::MAX - self.next() % 4,
            7 => u64::MAX,
            _ => self.next(),
        }
    }

    // A compressed-key-shaped public key: 0x02 or 0x03 (one output's lowest bit), then 32 bytes as key() draws them.
    fn pubkey(&mut self) -> Vec<u8> {
        let mut k = vec![0x02 | (self.next() & 1) as u8];
        k.extend_from_slice(&self.key());
        k
    }
}

// A case's entries, from its seed: for i = 0 .. n-1, the key, then the value. The key is drawn again while it is all
// zero bytes, all 0xff bytes (the tree's two sentinel keys) or a key already drawn in the case. With order "repeats" and
// i > 0, one output is drawn first: if it is 0 mod 4 the entry takes the key of entry (next output mod i) instead.
// "ascending" sorts the entries by key (the keys are distinct); "random" and "repeats" keep the order drawn.
fn entries(seed: u64, n: usize, order: &str) -> Vec<Entry> {
    let mut r = SplitMix64(seed);
    let mut out: Vec<Entry> = Vec::with_capacity(n);
    let mut seen: HashSet<[u8; 32]> = HashSet::new();
    for i in 0..n {
        let key = if order == "repeats" && i > 0 && r.next() % 4 == 0 {
            out[(r.next() % i as u64) as usize].0
        } else {
            loop {
                let k = r.key();
                if k != [0u8; 32] && k != [0xffu8; 32] && !seen.contains(&k) {
                    break k;
                }
            }
        };
        seen.insert(key);
        out.push((key, r.value().to_be_bytes().to_vec()));
    }
    if order == "ascending" {
        out.sort_by(|a, b| a.0.cmp(&b.0));
    }
    out
}

const META_SEED: u64 = 0x7661_6c75_6e2d_6176; // "valun-av": the seeds and sizes of the cases are drawn from it
const ENTRY_VECTOR_SEED: u64 = 0x0123_4567_89ab_cdef;

const FIXTURE_TEXT: &[(&str, &str)] = &[
    ("what", "Reference digests for lib/avl.mjs (fix inbox #62), computed by ergo_avltree_rust 0.1.1 as upstream Basis vendors it (temp/vendors/ergo_avltree_rust), the crate tracker v4.4 builds its note tree with. Written by basis/avl-fixtures (anchor-audit --random-fixtures); its README says how to rebuild and rerun it. CI never builds Rust."),
    ("construction", "An empty BatchAVLProver over AVLTree::new(resolver, key length 32, value length None), then one Operation::Insert per entry, in the order the case gives. digest = the root's label (32 bytes) || the tree's height (1 byte), as hex. The crate's Insert on a key already present replaces its value."),
    ("checked", "Every digest here was computed three ways, which must agree and did: plain Inserts; as tracker v4.4 applies each note to its rebuilt tree (an Update, then an Insert when the Update fails, the digest read after every entry); and as upstream basis_store applies an insert (generate_proof after the empty tree and after every Insert)."),
    ("prng", "splitmix64 over u64 (all arithmetic mod 2^64): state = state + 0x9e3779b97f4a7c15; z = state; z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9; z = (z ^ (z >> 27)) * 0x94d049bb133111eb; output z ^ (z >> 31). A case's generator starts with state = its seed (16 hex digits)."),
    ("entry", "For i = 0 .. n-1, the key, then the value. Key: four outputs, each as 8 big-endian bytes, concatenated (32 bytes), drawn again while it is all zero bytes, all 0xff bytes or a key already drawn in the case; with order repeats and i > 0, one output is drawn first, and if it is 0 mod 4 the entry takes the key of entry (next output mod i) instead of drawing one. Value: a total t as 8 big-endian bytes; one output c picks t by c mod 10: 0: 0; 1: next mod 256; 2: next mod 2^32; 3: 2^53 - 3 + next mod 7; 4: 2^53 + next mod 2^53; 5: 2^63 - 3 + next mod 7; 6: 2^64 - 1 - next mod 4; 7: 2^64 - 1; 8 and 9: next."),
    ("orders", "ascending: the entries sorted by key bytes (the keys are distinct), as the tracker inserts its notes; random: in the order drawn; repeats: in the order drawn, with some keys inserted again with a new value (insert-or-update)."),
    ("explicit", "prng_vectors: the first outputs for a few seeds. entry_vectors: one case's entries ([key hex, value hex]) for each order, after ordering. debt_keys: blake2b256(issuer || recipient || token id for token:<id>), the upstream basis_core DenomKey::debt_key, through the blake2 crate. rows_cases: notes with erg and token denominations and totals up to 2^64 - 1 (decimal strings), with the digest of their debt keys in ascending order (what the tracker anchors) and in the order listed. empty_digest: the tree with no entry."),
];

fn q(s: &str) -> String {
    serde_json::to_string(s).expect("json string")
}

fn row_json(issuer: &[u8], recipient: &[u8], denomination: &str, total: u64) -> String {
    format!("{{\"issuer_pubkey\":\"{}\",\"recipient_pubkey\":\"{}\",\"denomination\":{},\"total\":\"{total}\"}}",
        hex::encode(issuer), hex::encode(recipient), q(denomination))
}

fn random_fixtures() {
    let mut out: Vec<String> = Vec::new();
    for (k, v) in FIXTURE_TEXT {
        out.push(format!("{}: {}", q(k), q(v)));
    }
    out.push(format!("\"empty_digest\": \"{}\"", checked_digest(&[])));

    let prng: Vec<String> = [0u64, 1, META_SEED, u64::MAX].iter().map(|&s| {
        let mut r = SplitMix64(s);
        let o: Vec<String> = (0..4).map(|_| format!("\"{:016x}\"", r.next())).collect();
        format!("  {{\"seed\":\"{s:016x}\",\"outputs\":[{}]}}", o.join(","))
    }).collect();
    out.push(format!("\"prng_vectors\": [\n{}\n]", prng.join(",\n")));

    let ev: Vec<String> = ["ascending", "random", "repeats"].iter().map(|order| {
        let e = entries(ENTRY_VECTOR_SEED, 12, order);
        let list: Vec<String> = e.iter().map(|(k, v)| format!("[\"{}\",\"{}\"]", hex::encode(k), hex::encode(v))).collect();
        format!("  {{\"order\":\"{order}\",\"seed\":\"{ENTRY_VECTOR_SEED:016x}\",\"n\":12,\"digest\":\"{}\",\"entries\":[{}]}}", checked_digest(&e), list.join(","))
    }).collect();
    out.push(format!("\"entry_vectors\": [\n{}\n]", ev.join(",\n")));

    // Debt keys: the upstream unit test's inputs (basis_core types.rs debt_key_namespaces_differ), swapped, and drawn.
    let mut r = SplitMix64(META_SEED ^ 1);
    let (two, three) = (vec![0x02u8; 33], vec![0x03u8; 33]);
    let a5 = format!("token:{}", "a5".repeat(32));
    let a6 = format!("token:{}", "a6".repeat(32));
    let mut dk: Vec<(Vec<u8>, Vec<u8>, String)> = vec![
        (two.clone(), three.clone(), "erg".into()), (two.clone(), three.clone(), a5), (two.clone(), three.clone(), a6), (three.clone(), two.clone(), "erg".into())];
    for i in 0..4 {
        let (a, b) = (r.pubkey(), r.pubkey());
        let d = if i % 2 == 0 { "erg".to_string() } else { format!("token:{}", hex::encode(r.key())) };
        dk.push((a, b, d));
    }
    let dks: Vec<String> = dk.iter().map(|(a, b, d)| format!("  {{\"issuer_pubkey\":\"{}\",\"recipient_pubkey\":\"{}\",\"denomination\":{},\"debt_key\":\"{}\"}}",
        hex::encode(a), hex::encode(b), q(d), hex::encode(debt_key(a, b, d)))).collect();
    out.push(format!("\"debt_keys\": [\n{}\n]", dks.join(",\n")));

    // Rows: (count, size of the key pool, number of token ids besides erg); every (issuer, recipient, denomination)
    // appears once (the tracker holds one note per debt key), issuer and recipient differ.
    let mut r = SplitMix64(META_SEED ^ 2);
    let mut rc: Vec<String> = Vec::new();
    for (n, pool, tokens) in [(1usize, 2usize, 0usize), (8, 3, 1), (40, 6, 2), (150, 20, 3)] {
        let keys: Vec<Vec<u8>> = (0..pool).map(|_| r.pubkey()).collect();
        let mut dens = vec!["erg".to_string()];
        for _ in 0..tokens {
            dens.push(format!("token:{}", hex::encode(r.key())));
        }
        let (mut seen, mut given, mut rows) = (HashSet::new(), Vec::<Entry>::new(), Vec::<String>::new());
        while rows.len() < n {
            let i = (r.next() % pool as u64) as usize;
            let j = (r.next() % pool as u64) as usize;
            let d = dens[(r.next() % dens.len() as u64) as usize].clone();
            let k = debt_key(&keys[i], &keys[j], &d);
            if i == j || !seen.insert(k) {
                continue;
            }
            let t = r.value();
            given.push((k, t.to_be_bytes().to_vec()));
            rows.push(row_json(&keys[i], &keys[j], &d, t));
        }
        let mut sorted = given.clone();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        rc.push(format!("  {{\"debt_key_order\":\"{}\",\"given_order\":\"{}\",\"rows\":[\n    {}\n  ]}}",
            checked_digest(&sorted), checked_digest(&given), rows.join(",\n    ")));
    }
    out.push(format!("\"rows_cases\": [\n{}\n]", rc.join(",\n")));

    // The cases: per order (count, sizes 0 .. small-1 taken in turn first, the last case 600 entries, the others drawn
    // from 0..=600); each case's seed is the next output of the meta generator.
    let mut meta = SplitMix64(META_SEED);
    let mut cases: Vec<String> = Vec::new();
    for (order, count, small) in [("ascending", 1000usize, 65usize), ("random", 250, 33), ("repeats", 100, 17)] {
        for i in 0..count {
            let n = if i < small { i } else if i == count - 1 { 600 } else { (meta.next() % 601) as usize };
            let seed = meta.next();
            let d = checked_digest(&entries(seed, n, order));
            cases.push(format!("  {{\"order\":\"{order}\",\"seed\":\"{seed:016x}\",\"n\":{n},\"digest\":\"{d}\"}}"));
        }
    }
    out.push(format!("\"cases\": [\n{}\n]", cases.join(",\n")));
    println!("{{\n{}\n}}", out.join(",\n"));
}

// The digests of a rows file (an anchor vector, test/fixtures/anchor-vectors/<height>.json, or any {"rows": [...]}).
fn rows(path: &str) {
    let raw = std::fs::read_to_string(path).expect("read rows");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("rows json");
    let mut given: Vec<Entry> = Vec::new();
    for (i, row) in v["rows"].as_array().expect("rows").iter().enumerate() {
        let issuer = pubkey(row["issuer_pubkey"].as_str().expect("issuer_pubkey"));
        let recipient = pubkey(row["recipient_pubkey"].as_str().expect("recipient_pubkey"));
        let denomination = row["denomination"].as_str().unwrap_or("erg");
        let total = row["total"].as_str().expect("total, a decimal string");
        assert!(!total.is_empty() && total.bytes().all(|b| b.is_ascii_digit()), "row {i}: total must be decimal digits");
        let total: u64 = total.parse().expect("total within u64");
        given.push((debt_key(&issuer, &recipient, denomination), total.to_be_bytes().to_vec()));
    }
    let mut sorted = given.clone();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(sorted.windows(2).all(|w| w[0].0 != w[1].0), "two rows have the same debt key");
    println!("{{\"count\":{},\"debt_key_order\":\"{}\",\"given_order\":\"{}\"}}", given.len(), checked_digest(&sorted), checked_digest(&given));
}

fn pubkey(s: &str) -> Vec<u8> {
    let k = hex::decode(s).expect("public key hex");
    assert!(k.len() == 33 && (k[0] == 2 || k[0] == 3), "a public key is 33 bytes, compressed (02 or 03 first)");
    k
}
