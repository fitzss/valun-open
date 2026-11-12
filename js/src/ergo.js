// Settlement on Ergo testnet for the Valun testnet network (valun-testnet-1): reserves and redemptions, signed by the
// agent's own key (its Ergo address is the P2PK address of its Valun key; the server never holds it).
//
// Plain JavaScript here: the P2PK address, the order of a transaction's context extensions, the checks a client makes
// before it signs anything the tracker built. Building and signing Ergo transactions use ergo-lib (sigma-rust, compiled
// to WebAssembly), an OPTIONAL dependency loaded only when a settlement call needs it:
//   npm i ergo-lib-wasm-nodejs@0.28.0
// Ergo TESTNET only: every node this module talks to must say it is a testnet node.
import {blake2b256} from './blake2b.js';
import {bytesToHex, hexToBytes} from './bytes.js';
import {ValunError} from './errors.js';

export const ERGO_LIB = 'ergo-lib-wasm-nodejs';
export const ERGO_LIB_VERSION = '0.28.0';
/** The miner fee of a transaction this client builds, and the smallest change box it leaves (nanoERG). */
export const FEE = 1_000_000, MIN_CHANGE = 1_000_000;
/** The standard miner-fee contract. */
export const MINER_FEE_TREE = '1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304';

let loaded = null;
/** ergo-lib, imported once; a ValunError ergo_lib_missing (with the install line) when it is not installed. */
export async function ergoLib() {
  if (loaded) return loaded;
  let m;
  try { m = await import(ERGO_LIB); } catch {
    throw new ValunError('ergo_lib_missing', `settlement on Ergo testnet signs with ergo-lib, which is not installed: npm i ${ERGO_LIB}@${ERGO_LIB_VERSION}`);
  }
  loaded = m.default && m.default.Wallet ? m.default : m;
  return loaded;
}

// ---------- addresses ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = `1${s}`; }
  return s;
}
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
/** The ErgoTree of the P2PK address of a compressed public key (66 hex): proveDlog(pk). */
export function p2pkTree(pubkeyHex) {
  if (!PUBKEY_RE.test(pubkeyHex)) throw new ValunError('invalid_field', 'a public key is 33 bytes of hex (02.. or 03..)');
  return `0008cd${pubkeyHex}`;
}
/** The P2PK address of a compressed public key, testnet by default (prefix 0x11; mainnet 0x01). */
export function p2pkAddress(pubkeyHex, {testnet = true} = {}) {
  p2pkTree(pubkeyHex);
  const body = new Uint8Array(34);
  body[0] = (testnet ? 0x10 : 0x00) + 0x01;
  body.set(hexToBytes(pubkeyHex), 1);
  const out = new Uint8Array(38);
  out.set(body);
  out.set(blake2b256(body).slice(0, 4), 34);
  return base58(out);
}

// ---------- the order of context extensions ----------
// An input's context extension is a Scala Map[Byte, Constant]: the node serializes it (and so the bytes an input proof
// signs, and the transaction id) in Scala HashMap iteration order, and the Basis tracker binds a redemption submit to
// the exact JSON it built. JSON.parse sorts integer-like keys, so every transaction is written with toErgoJson.
function improve(h) {
  h = (h + ~(h << 9)) >>> 0;
  h = (h ^ (h >>> 14)) >>> 0;
  h = (h + (h << 4)) >>> 0;
  return (h ^ (h >>> 10)) >>> 0;
}
/** Scala 2.12 immutable HashMap iteration order of byte keys ({0,1,2,3,4,5,6,8} -> 0,5,1,6,2,3,8,4). */
export function scalaExtensionOrder(keys) {
  const out = [];
  const build = (level, ks) => {
    const groups = new Map();
    for (const k of ks) {
      const idx = (improve(k) >>> level) & 0x1f;
      if (!groups.has(idx)) groups.set(idx, []);
      groups.get(idx).push(k);
    }
    for (const idx of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(idx);
      if (g.length === 1) out.push(g[0]);
      else if (level >= 30) out.push(...g);
      else build(level + 5, g);
    }
  };
  build(0, keys);
  return out;
}
const BYTE_KEY = /^(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** JSON text with every `extension` object (byte keys) in Scala order; otherwise as JSON.stringify. */
export function toErgoJson(value) {
  const write = (v, key) => {
    if (v === undefined || typeof v === 'function') return undefined;
    if (v !== null && typeof v.toJSON === 'function') v = v.toJSON();
    if (!isPlain(v) && !Array.isArray(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => write(x) ?? 'null').join(',')}]`;
    let keys = Object.keys(v);
    if (key === 'extension' && keys.length && keys.every(k => BYTE_KEY.test(k))) keys = scalaExtensionOrder(keys.map(Number)).map(String);
    const parts = [];
    for (const k of keys) {
      const s = write(v[k], k);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  };
  return write(value, undefined);
}

// ---------- an Ergo testnet node ----------
/** The node's REST API (a testnet node: assertTestnet refuses any other). */
export function nodeClient(base, {fetchImpl = globalThis.fetch, timeoutMs = 30_000} = {}) {
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) throw new ValunError('invalid_field', 'the Ergo node URL is not http(s)');
  const root = base.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    let r;
    try {
      r = await fetchImpl(root + path, {method, headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) { throw new ValunError('node_unreachable', `the Ergo node did not answer: ${e?.name || 'error'}`); }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!r.ok) throw new ValunError('node_error', `the Ergo node refused ${method} ${path.split('?')[0]}: ${(j && (j.detail || j.reason || j.error)) || r.status}`, r.status);
    return j;
  };
  return {
    info: () => call('GET', '/info'),
    async assertTestnet() {
      const i = await call('GET', '/info');
      if (String(i?.network || '').toLowerCase() !== 'testnet') throw new ValunError('not_testnet', 'the Ergo node is not a testnet node; this client settles on Ergo testnet only');
      return i;
    },
    unspentByAddress: address => call('POST', '/blockchain/box/unspent/byAddress?offset=0&limit=100', JSON.stringify(address)),
    boxBinary: async id => (await call('GET', `/utxo/byIdBinary/${id}`)).bytes,
    lastHeaders: n => call('GET', `/blocks/lastHeaders/${n}`),
    broadcast: tx => call('POST', '/transactions', toErgoJson(tx)),
  };
}

/** The state context ergo-lib signs with, from 10 node-format headers (in any order; the newest is the pre-header). */
export function stateContext(E, headers) {
  if (!Array.isArray(headers) || headers.length < 10) throw new ValunError('bad_headers', 'signing needs the last 10 block headers');
  const desc = [...headers].sort((a, b) => b.height - a.height).slice(0, 10);
  const bh = E.BlockHeaders.from_json(desc);
  return new E.ErgoStateContext(E.PreHeader.from_block_header(bh.get(0)), bh, E.Parameters.default_parameters());
}
const boxesOf = (E, hexes) => {
  const out = E.ErgoBoxes.empty();
  for (const h of hexes) out.add(E.ErgoBox.sigma_parse_bytes(hexToBytes(h)));
  return out;
};
const boxJson = (E, hex) => JSON.parse(E.ErgoBox.sigma_parse_bytes(hexToBytes(hex)).to_json());

// ---------- a reserve (the agent's own tERG, locked in the Basis reserve contract) ----------
/**
 * Plain boxes (no tokens) at the key's own address, largest first, enough for `need` nanoERG.
 * Boxes holding tokens are never spent (this client would not know where their tokens go).
 */
export async function pickPlainBoxes(node, pubkeyHex, need) {
  const tree = p2pkTree(pubkeyHex);
  const boxes = (await node.unspentByAddress(p2pkAddress(pubkeyHex))).filter(b => b.ergoTree === tree && !(b.assets || []).length)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const inputs = [];
  let total = 0;
  for (const b of boxes) { inputs.push(b); total += Number(b.value); if (total >= need) break; }
  if (total < need) throw new ValunError('unfunded', `${p2pkAddress(pubkeyHex)} holds ${total} nanoERG in plain boxes; this needs ${need} (the amount, the fee and the change)`);
  return {inputs, total, tree};
}

/**
 * Check the tracker's payment request for a reserve before anything is signed: one output of exactly `ergAmount` at
 * the network's reserve contract, minting one token whose id is `nftId` (the first input), R4 the agent's key, R6 the
 * network's tracker NFT. Returns the request.
 */
export function checkReservePayload(payload, {ergAmount, nftId, pubkeyHex, trackerNftId, reserveContract}) {
  const req = Array.isArray(payload?.requests) ? payload.requests : null;
  if (!req || req.length !== 1) throw new ValunError('bad_payload', 'the reserve request must have exactly one output');
  const r = req[0];
  const fail = why => { throw new ValunError('bad_payload', `refusing to sign the reserve: ${why}`); };
  if (Number(r.value) !== ergAmount) fail(`it locks ${r.value} nanoERG, not the ${ergAmount} asked`);
  if (reserveContract && r.address !== reserveContract) fail('its address is not the network\'s reserve contract');
  const assets = (r.assets || []).map(a => ({tokenId: a.token_id ?? a.tokenId, amount: Number(a.amount)}));
  if (assets.length !== 1 || assets[0].tokenId !== nftId || assets[0].amount !== 1) fail('it must mint exactly one token, its id the first input box');
  if (r.registers?.R4 !== `07${pubkeyHex}`) fail('its R4 is not this agent\'s key');
  if (trackerNftId && r.registers?.R6 !== `0e20${trackerNftId}`) fail('its R6 is not the network\'s tracker NFT');
  return {...r, assets};
}

/**
 * A signed transaction that locks `ergAmount` nanoERG from the key's own address in a Basis ERG reserve: output 0 the
 * reserve (the checked request), then the miner fee and the change back to the key's address. `payloadFor(nftId)`
 * asks the tracker (through the Valun server) for the request.
 */
export async function buildReserve({secretHex, pubkeyHex, ergAmount, node, payloadFor, trackerNftId, reserveContract}) {
  const E = await ergoLib();
  if (!Number.isSafeInteger(ergAmount) || ergAmount < 1) throw new ValunError('invalid_field', 'erg_amount: whole nanoERG');
  const [, headers] = await Promise.all([node.assertTestnet(), node.lastHeaders(10)]);
  const height = Math.max(...headers.map(h => h.height));
  const {inputs, total, tree} = await pickPlainBoxes(node, pubkeyHex, ergAmount + FEE + MIN_CHANGE);
  const nftId = inputs[0].boxId;
  const req = checkReservePayload(await payloadFor(nftId), {ergAmount, nftId, pubkeyHex, trackerNftId, reserveContract});
  const reserveTree = E.Address.from_base58(req.address).to_ergo_tree().to_base16_bytes();
  const outputs = [
    {value: ergAmount, ergoTree: reserveTree, creationHeight: height, assets: req.assets, additionalRegisters: req.registers},
    {value: FEE, ergoTree: MINER_FEE_TREE, creationHeight: height, assets: [], additionalRegisters: {}},
    {value: total - ergAmount - FEE, ergoTree: tree, creationHeight: height, assets: [], additionalRegisters: {}},
  ];
  const unsigned = E.UnsignedTransaction.from_json(JSON.stringify({inputs: inputs.map(b => ({boxId: b.boxId, extension: {}})), dataInputs: [], outputs}));
  const raws = await Promise.all(inputs.map(b => node.boxBinary(b.boxId)));
  const secrets = new E.SecretKeys();
  secrets.add(E.SecretKey.dlog_from_bytes(hexToBytes(secretHex)));
  const signed = E.Wallet.from_secrets(secrets).sign_transaction(stateContext(E, headers), unsigned, boxesOf(E, raws), E.ErgoBoxes.empty());
  const json = JSON.parse(signed.to_json());
  return {signed: json, tx_id: signed.id().to_str(), nft_id: nftId, reserve_box_id: json.outputs[0].boxId, locked_nanoerg: ergAmount};
}

// ---------- a redemption (the agent's claim on an issuer's reserve, paid out to the agent's own address) ----------
const REDEEM_ACTION = '0200';                    // context var #0: Byte 0 (action 0 = redeem, reserve output index 0)
/**
 * Check the redemption the tracker built before the agent's key signs it. The agent's proof makes input 0 (the
 * reserve) spendable, and a proof over these bytes would also spend any box of the agent's own, so it signs only when:
 * input 0 is a reserve of the issuer for this network (the reserve contract, R4 the issuer's key, R6 the tracker NFT);
 * no input is a box at the agent's own address; output 0 is that reserve, `amount` lower, with its registers' key and
 * NFT kept; one output pays exactly `amount` to the agent's own address; the reserve input's context names this agent
 * as receiver (#1) with action 0 (#0). Returns a summary.
 */
export function checkRedemption(E, built, {issuerPubkey, recipientPubkey, amount, trackerNftId, reserveTree = null}) {
  const fail = why => { throw new ValunError('bad_redemption', `refusing to sign the redemption: ${why}`); };
  const tx = built?.unsigned_tx;
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs) || !Array.isArray(built.input_box_binaries)) fail('the tracker\'s answer is not a redemption');
  if (built.input_box_binaries.length !== tx.inputs.length) fail('the input boxes do not match the inputs');
  const boxes = built.input_box_binaries.map(h => boxJson(E, h));
  boxes.forEach((b, i) => { if (b.boxId !== tx.inputs[i].boxId) fail(`input ${i} is not the box given for it`); });
  const reserve = boxes[0];
  const own = p2pkTree(recipientPubkey);
  if (reserveTree && reserve.ergoTree !== reserveTree) fail('input 0 is not at the network\'s reserve contract');
  if (reserve.additionalRegisters?.R4 !== `07${issuerPubkey}`) fail('input 0 is not the issuer\'s reserve');
  if (trackerNftId && reserve.additionalRegisters?.R6 !== `0e20${trackerNftId}`) fail('input 0 is not a reserve of this network\'s tracker');
  if (boxes.some(b => b.ergoTree === own)) fail('it would spend a box of this agent\'s own');
  const out0 = tx.outputs[0];
  if (out0.ergoTree !== reserve.ergoTree || Number(out0.value) !== Number(reserve.value) - amount) fail(`output 0 is not the reserve, ${amount} nanoERG lower`);
  if (out0.additionalRegisters?.R4 !== reserve.additionalRegisters.R4 || out0.additionalRegisters?.R6 !== reserve.additionalRegisters.R6) fail('output 0 changes the reserve\'s owner or tracker');
  const tokens = xs => JSON.stringify((xs || []).map(a => [a.tokenId, String(a.amount)]));
  if (tokens(out0.assets) !== tokens(reserve.assets)) fail('output 0 changes the reserve\'s tokens');
  const paid = tx.outputs.filter(o => o.ergoTree === own);
  if (paid.length !== 1 || Number(paid[0].value) !== amount || (paid[0].assets || []).length) fail(`no single output pays exactly ${amount} nanoERG to this agent`);
  const ext = tx.inputs[0].extension || {};
  if (ext['0'] !== REDEEM_ACTION) fail('the reserve input is not spent by the redeem action into output 0');
  if (ext['1'] !== `07${recipientPubkey}`) fail('the reserve input does not name this agent as the receiver');
  return {reserve_box_id: reserve.boxId, reserve_value: Number(reserve.value), paid_nanoerg: amount, fee_inputs: boxes.length - 1};
}

/**
 * The agent's proof for the reserve input (input 0), over exactly the transaction the tracker built, spliced into the
 * tracker's fee-signed transaction. Returns the signed transaction (JSON value; write it with toErgoJson).
 */
export async function signRedemption(built, secretHex) {
  const E = await ergoLib();
  const unsigned = E.UnsignedTransaction.from_json(toErgoJson(built.unsigned_tx));
  const ctx = stateContext(E, built.headers);
  const secrets = new E.SecretKeys();
  secrets.add(E.SecretKey.dlog_from_bytes(hexToBytes(secretHex)));
  const input = E.Wallet.from_secrets(secrets).sign_tx_input(0, ctx, unsigned, boxesOf(E, built.input_box_binaries), boxesOf(E, built.data_box_binaries || []));
  const boxId = input.box_id().to_str(), proofBytes = bytesToHex(input.spending_proof().proof());
  const signed = structuredClone(built.partial_tx);
  if (!signed?.inputs?.[0]?.spendingProof || signed.inputs[0].boxId !== boxId) throw new ValunError('bad_redemption', 'the partly signed transaction does not start with the reserve input');
  if (!proofBytes) throw new ValunError('bad_redemption', 'no proof for the reserve input');
  signed.inputs[0].spendingProof.proofBytes = proofBytes;
  if (signed.id && signed.id !== unsigned.id().to_str()) throw new ValunError('bad_redemption', 'the partly signed transaction is not the one built');
  return signed;
}

export {bytesToHex};
