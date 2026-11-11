// valun_signer: a thin command-line wrapper around Basis's own basis_core crypto (Basis 3df7ed9; tracker v3.2 adds
// basis_core's prior_ack_message). It adds no cryptography of its own: keygen, the 80-byte note message, the 105-byte
// prior acknowledgment, Schnorr sign and verify all call basis_core functions. Built as an example of the basis_core
// crate so it links the pinned code unchanged.
//
// Secrets never appear in argv: `sign` reads the 32-byte secret (hex) from stdin.
//
//   valun_signer keygen                                   -> {"secret_hex","pubkey_hex"}
//   valun_signer pubkey            (stdin: secret_hex)    -> {"pubkey_hex"}
//   valun_signer note-message ISSUER RECIPIENT TOTAL TIMESTAMP TRACKER_NFT [DENOM] -> {"message_hex","debt_key_hex"}
//   valun_signer prior-ack-message ISSUER RECIPIENT PRIOR_TOTAL PRIOR_TIMESTAMP TIMESTAMP TRACKER_NFT [DENOM]
//                                                         -> {"message_hex","debt_key_hex"}   (tracker v3.2, 105 bytes)
//   valun_signer sign PUBKEY MESSAGE_HEX (stdin: secret_hex) -> {"signature_hex"}   (verifies its own output)
//   valun_signer verify PUBKEY MESSAGE_HEX SIGNATURE_HEX  -> {"valid":true|false}
use basis_core::{
    generate_keypair, prior_ack_message, pubkey_from_hex, pubkey_to_hex, schnorr_sign, schnorr_verify,
    signature_from_hex, signature_to_hex, signing_message, DenomKey,
};
use std::io::Read;
use std::process::exit;

fn fail(msg: &str) -> ! {
    println!("{{\"error\":{}}}", serde_json::to_string(msg).unwrap());
    exit(2)
}

fn read_secret() -> [u8; 32] {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap_or_else(|_| fail("cannot read stdin"));
    let bytes = hex::decode(s.trim()).unwrap_or_else(|_| fail("secret must be hex"));
    bytes.try_into().unwrap_or_else(|_| fail("secret must be 32 bytes"))
}

fn pk(s: &str) -> [u8; 33] {
    pubkey_from_hex(s).unwrap_or_else(|_| fail("invalid public key"))
}

fn nft_id(s: &str) -> [u8; 32] {
    hex::decode(s)
        .ok()
        .and_then(|b| b.try_into().ok())
        .unwrap_or_else(|| fail("tracker NFT id must be 32 bytes hex"))
}

fn denomination(s: Option<&String>) -> DenomKey {
    DenomKey::parse(s.map(String::as_str).unwrap_or("erg")).unwrap_or_else(|_| fail("invalid denomination"))
}

fn derive_pubkey(secret: &[u8; 32]) -> [u8; 33] {
    let secp = secp256k1::Secp256k1::new();
    let sk = secp256k1::SecretKey::from_slice(secret).unwrap_or_else(|_| fail("invalid secret"));
    secp256k1::PublicKey::from_secret_key(&secp, &sk).serialize()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("keygen") => {
            let (sk, pubkey) = generate_keypair();
            println!("{{\"secret_hex\":\"{}\",\"pubkey_hex\":\"{}\"}}", hex::encode(sk), pubkey_to_hex(&pubkey));
        }
        Some("pubkey") => {
            let sk = read_secret();
            println!("{{\"pubkey_hex\":\"{}\"}}", pubkey_to_hex(&derive_pubkey(&sk)));
        }
        Some("note-message") if a.len() >= 7 => {
            let (issuer, recipient) = (pk(&a[2]), pk(&a[3]));
            let total: u64 = a[4].parse().unwrap_or_else(|_| fail("total must be u64"));
            let ts: u64 = a[5].parse().unwrap_or_else(|_| fail("timestamp must be u64"));
            let nft: [u8; 32] = hex::decode(&a[6])
                .ok()
                .and_then(|b| b.try_into().ok())
                .unwrap_or_else(|| fail("tracker NFT id must be 32 bytes hex"));
            let denom = DenomKey::parse(a.get(7).map(String::as_str).unwrap_or("erg"))
                .unwrap_or_else(|_| fail("invalid denomination"));
            let msg = signing_message(&issuer, &recipient, &denom, total, ts, &nft);
            let key = denom.debt_key(&issuer, &recipient);
            println!("{{\"message_hex\":\"{}\",\"debt_key_hex\":\"{}\"}}", hex::encode(msg), hex::encode(key));
        }
        Some("prior-ack-message") if a.len() >= 8 => {
            // PA(I,R,X,p,T) = "basis/prior-ack/1" || debtKey || X || p || T || trackerNftId (tracker v3.2).
            let (issuer, recipient) = (pk(&a[2]), pk(&a[3]));
            let prior_total: u64 = a[4].parse().unwrap_or_else(|_| fail("prior total must be u64"));
            let prior_ts: u64 = a[5].parse().unwrap_or_else(|_| fail("prior timestamp must be u64"));
            let ts: u64 = a[6].parse().unwrap_or_else(|_| fail("timestamp must be u64"));
            let nft = nft_id(&a[7]);
            let denom = denomination(a.get(8));
            let msg = prior_ack_message(&issuer, &recipient, &denom, prior_total, prior_ts, ts, &nft);
            let key = denom.debt_key(&issuer, &recipient);
            println!("{{\"message_hex\":\"{}\",\"debt_key_hex\":\"{}\"}}", hex::encode(msg), hex::encode(key));
        }
        Some("sign") if a.len() >= 4 => {
            let pubkey = pk(&a[2]);
            let msg = hex::decode(&a[3]).unwrap_or_else(|_| fail("message must be hex"));
            let sk = read_secret();
            if derive_pubkey(&sk) != pubkey {
                fail("secret does not match public key");
            }
            let sig = schnorr_sign(&msg, &sk, &pubkey).unwrap_or_else(|_| fail("signing failed"));
            if schnorr_verify(&sig, &msg, &pubkey).is_err() {
                fail("self-verification failed");
            }
            println!("{{\"signature_hex\":\"{}\"}}", signature_to_hex(&sig));
        }
        Some("verify") if a.len() >= 5 => {
            let pubkey = pk(&a[2]);
            let msg = hex::decode(&a[3]).unwrap_or_else(|_| fail("message must be hex"));
            let sig = signature_from_hex(&a[4]).unwrap_or_else(|_| fail("invalid signature encoding"));
            println!("{{\"valid\":{}}}", schnorr_verify(&sig, &msg, &pubkey).is_ok());
        }
        _ => fail("usage: keygen | pubkey | note-message | prior-ack-message | sign | verify"),
    }
}
