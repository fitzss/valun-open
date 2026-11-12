// Ergo TESTNET helpers for the Valun testnet network: the ergo-lib binding, a node client that refuses any network
// but testnet, register encodings the Basis contracts read, P2PK addresses, the signing context, and the spend ledger
// that enforces the owner's caps (20 tERG in all; at most 50 tracker-box signatures a UTC day).
//
// Nothing here holds a key for longer than one call: a secret is passed in, used and dropped.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
export const E = require('ergo-lib-wasm-nodejs');

export const PUBLIC_TESTNET_NODE = 'http://213.239.193.208:9052';   // ergo-testnet-6.0.8, extraIndex (checked 2026-11-12)
export const NANO = 1_000_000_000n;                                   // nanoERG per ERG
export const FEE = 1_000_000;                                         // 0.001 tERG, the node's minimal fee
export const TRACKER_BOX_VALUE = 10_000_000;                          // 0.01 tERG kept in the tracker box
export const MINER_FEE_TREE = '1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304';
export const DEFAULT_CAP_NANO = 20n * NANO;                           // the owner's total cap (2026-11-12)
export const DEFAULT_DAILY_TRACKER_SIGNATURES = 50;                   // the owner's anchoring cap

export class ChainError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// ---------- encodings ----------
export function vlq(n) {
  let v = BigInt(n), out = '';
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v > 0n) b |= 0x80; out += b.toString(16).padStart(2, '0'); } while (v > 0n);
  return out;
}
const isHex = (s, bytes) => typeof s === 'string' && /^[0-9a-f]*$/.test(s) && s.length % 2 === 0 && (bytes === undefined || s.length === bytes * 2);
export function regGroupElement(pkHex) {
  if (!isHex(pkHex, 33) || !/^0[23]/.test(pkHex)) throw new ChainError('bad_pubkey', 'a compressed public key is 33 bytes, 02 or 03 first');
  return '07' + pkHex;
}
export function regCollByte(hex) {
  if (!isHex(hex)) throw new ChainError('bad_bytes', 'hex bytes expected');
  return '0e' + vlq(hex.length / 2) + hex;
}
// An AvlTree register as the Basis tracker writes it (tracker_box_updater.rs): type 0x64, the 33-byte digest, flags 0x03
// (insert and update allowed), key length 32, no fixed value length.
export function regAvlTree(digestHex) {
  if (!isHex(digestHex, 33)) throw new ChainError('bad_digest', 'an AVL+ digest is 33 bytes');
  return '64' + digestHex + '03' + vlq(32) + vlq(0);
}
export function avlDigestOf(registerHex) {
  return isHex(registerHex) && registerHex.startsWith('64') && registerHex.length >= 2 + 66 ? registerHex.slice(2, 68) : null;
}
export const p2pkTree = pkHex => '0008cd' + regGroupElement(pkHex).slice(2);
export const addressOf = (pkHex, prefix = E.NetworkPrefix.Testnet) =>
  E.Address.recreate_from_ergo_tree(E.ErgoTree.from_base16_bytes(p2pkTree(pkHex))).to_base58(prefix);

// ---------- keys ----------
// A new secp256k1 key for the testnet: {secret_hex, pubkey_hex}. Its P2PK address holds the tracker's funds.
export function newKey() {
  const sk = E.SecretKey.random_dlog();
  const secret = Buffer.from(sk.to_bytes()).toString('hex');
  return {secret_hex: secret, pubkey_hex: pubkeyOf(secret)};
}
export function pubkeyOf(secretHex) {
  if (!isHex(secretHex, 32)) throw new ChainError('bad_secret', 'a secret key is 32 bytes');
  const tree = E.SecretKey.dlog_from_bytes(Buffer.from(secretHex, 'hex')).get_address().to_ergo_tree().to_base16_bytes();
  if (!tree.startsWith('0008cd')) throw new ChainError('bad_secret', 'not a P2PK key');
  return tree.slice(6);
}

// ---------- the node ----------
export function nodeClient(base = process.env.ERGO_NODE_URL || PUBLIC_TESTNET_NODE, {fetchImpl = fetch, timeoutMs = 20_000} = {}) {
  base = base.replace(/\/+$/, '');
  let checked = null;
  async function call(p, {method = 'GET', body, raw = false} = {}) {
    let r;
    try {
      r = await fetchImpl(base + p, {method, headers: body === undefined ? {} : {'content-type': 'application/json'},
        body: body === undefined ? undefined : (typeof body === 'string' && raw ? body : JSON.stringify(body)), signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) { throw new ChainError('node_unreachable', `the Ergo node did not answer ${method} ${p}: ${e.message}`, 502); }
    const text = await r.text();
    if (!r.ok) throw new ChainError('node_error', `the Ergo node answered ${r.status} to ${method} ${p}: ${text.slice(0, 300)}`, r.status >= 500 ? 502 : 400);
    return text ? JSON.parse(text) : null;
  }
  // Every write and every signature first checks, once, that the node is a TESTNET node.
  async function assertTestnet() {
    if (checked) return checked;
    const info = await call('/info');
    if (String(info?.network || '').toLowerCase() !== 'testnet') throw new ChainError('not_testnet', `the Ergo node is on ${info?.network}, not testnet: refused`, 403);
    checked = info;
    return info;
  }
  return {base, call, assertTestnet,
    info: () => call('/info'),
    height: async () => (await call('/info')).fullHeight,
    lastHeaders: (n = 10) => call(`/blocks/lastHeaders/${n}`),
    unspentByAddress: async (address, {limit = 100} = {}) => {
      const out = [];
      for (let offset = 0; ; offset += limit) {
        const page = await call(`/blockchain/box/unspent/byAddress?offset=${offset}&limit=${limit}`, {method: 'POST', body: address});
        out.push(...page);
        if (page.length < limit || out.length >= 1000) return out;
      }
    },
    unspentByTokenId: (id, {limit = 20} = {}) => call(`/blockchain/box/unspent/byTokenId/${id}?offset=0&limit=${limit}`),
    boxBinary: async id => (await call(`/utxo/byIdBinary/${id}`)).bytes,
    broadcast: async tx => { await assertTestnet(); return call('/transactions', {method: 'POST', body: tx}); },
  };
}

// The signing context from the node's last 10 headers (the node lists them oldest first; ergo-lib wants newest first).
export async function stateContext(node) {
  const headers = await node.lastHeaders(10);
  if (!Array.isArray(headers) || headers.length !== 10) throw new ChainError('node_error', 'the Ergo node did not give 10 headers', 502);
  const desc = [...headers].sort((a, b) => b.height - a.height);
  const bh = E.BlockHeaders.from_json(desc);
  return new E.ErgoStateContext(E.PreHeader.from_block_header(bh.get(0)), bh, E.Parameters.default_parameters());
}

// Sign a node-format unsigned transaction with ONE secret, spending boxes given as their serialized bytes.
export function signTransaction({tx, inputsRaw, dataInputsRaw = [], secretHex, ctx}) {
  const inputs = inputsRaw.map(b => E.ErgoBox.sigma_parse_bytes(Buffer.from(b, 'hex')));
  const data = dataInputsRaw.map(b => E.ErgoBox.sigma_parse_bytes(Buffer.from(b, 'hex')));
  const unsigned = E.UnsignedTransaction.from_json(JSON.stringify(tx));
  const byId = new Map(inputs.map(b => [b.box_id().to_str(), b]));
  const want = JSON.parse(unsigned.to_json()).inputs.map(i => i.boxId);
  if (want.length !== inputs.length || want.some(id => !byId.has(id))) throw new ChainError('bad_inputs', 'inputsRaw must hold exactly the boxes the transaction spends');
  const ordered = new E.ErgoBoxes(byId.get(want[0]));
  for (const id of want.slice(1)) ordered.add(byId.get(id));
  const dataBoxes = E.ErgoBoxes.empty();
  for (const b of data) dataBoxes.add(b);
  const secrets = new E.SecretKeys();
  secrets.add(E.SecretKey.dlog_from_bytes(Buffer.from(secretHex, 'hex')));
  const signed = E.Wallet.from_secrets(secrets).sign_transaction(ctx, unsigned, ordered, dataBoxes);
  return {signed: JSON.parse(signed.to_json()), id: signed.id().to_str(), inputs: inputs.map(b => JSON.parse(b.to_json()))};
}

// What a transaction takes from our address: inputs we own minus outputs back to us (the fee and anything else that
// leaves count), in nanoERG.
export function spentFrom(ourTree, inputBoxes, outputs) {
  const sum = xs => xs.reduce((n, b) => n + BigInt(b.value), 0n);
  return sum(inputBoxes.filter(b => b.ergoTree === ourTree)) - sum(outputs.filter(o => o.ergoTree === ourTree));
}

// ---------- the spend ledger (one JSON line per signed transaction, on the volume) ----------
export class SpendLedger {
  constructor(file, {capNano = DEFAULT_CAP_NANO, dailySignatures = DEFAULT_DAILY_TRACKER_SIGNATURES, now = () => Date.now()} = {}) {
    this.file = file; this.capNano = BigInt(capNano); this.daily = dailySignatures; this.now = now;
  }
  entries() {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
  }
  spentNano() { return this.entries().reduce((n, e) => n + BigInt(e.spent_nano || 0), 0n); }
  todaySignatures(kind) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.entries().filter(e => e.kind === kind && String(e.t).slice(0, 10) === day).length;
  }
  // Refuses (ChainError) when this signature would pass either cap; else nothing.
  check(kind, spentNano) {
    if (this.spentNano() + BigInt(spentNano) > this.capNano)
      throw new ChainError('cap_reached', `this would bring testnet spending to ${this.spentNano() + BigInt(spentNano)} nanoERG, over the owner's cap of ${this.capNano}`, 403);
    if (kind === 'tracker_box' && this.todaySignatures(kind) >= this.daily)
      throw new ChainError('daily_cap', `the tracker box was already signed ${this.daily} times today (UTC): the owner's daily cap`, 429);
  }
  record(e) {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    fs.appendFileSync(this.file, JSON.stringify({t: new Date(this.now()).toISOString(), ...e, spent_nano: String(e.spent_nano ?? 0)}) + '\n');
  }
}
