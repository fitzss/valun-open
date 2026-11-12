// Settlement on Ergo testnet for the Valun testnet network (valun-testnet-1): reserves and redemptions, signed by the
// agent's own key (its Ergo address is the P2PK address of its Valun key; the server never holds it).
//
// Plain JavaScript here: the P2PK address, the order of a transaction's context extensions, the checks a client makes
// before it signs anything the tracker built. Building and signing Ergo transactions use ergo-lib (sigma-rust, compiled
// to WebAssembly), an OPTIONAL dependency loaded only when a settlement call needs it:
//   npm i ergo-lib-wasm-nodejs@0.28.0
// Ergo TESTNET only: every node this module talks to must say it is a testnet node.
import {blake2b256} from './blake2b.js';
import {ergoProveDlog} from './basis.js';
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

/**
 * The ErgoTree (hex) of an address of either network: P2PK (the key's proveDlog tree) or P2S (the script itself). The
 * checksum is checked. ValunError invalid_field for anything else (a P2SH address names only a script's hash).
 */
export function addressToTree(address) {
  if (typeof address !== 'string' || !address) throw new ValunError('invalid_field', 'an address is a base58 string');
  let n = 0n;
  for (const ch of address) {
    const d = B58.indexOf(ch);
    if (d < 0) throw new ValunError('invalid_field', 'an address is base58');
    n = n * 58n + BigInt(d);
  }
  const body = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of address) { if (ch !== '1') break; body.unshift(0); }
  const bytes = Uint8Array.from(body);
  if (bytes.length < 6) throw new ValunError('invalid_field', 'the address is too short');
  const sum = blake2b256(bytes.subarray(0, bytes.length - 4)).subarray(0, 4);
  if (bytesToHex(sum) !== bytesToHex(bytes.subarray(bytes.length - 4))) throw new ValunError('invalid_field', 'the address checksum is wrong');
  const type = bytes[0] & 0x0f, content = bytes.subarray(1, bytes.length - 4);
  if (type === 1 && content.length === 33) return `0008cd${bytesToHex(content)}`;
  if (type === 3) return bytesToHex(content);
  throw new ValunError('invalid_field', 'only P2PK and P2S addresses name a script');
}

// ---------- the bytes a transaction's proofs sign (and its id) ----------
// Ergo's transaction serialization with empty proofs: inputs (box id, an empty proof, the context extension in Scala's
// order), data inputs, the distinct token ids (in order of first appearance in the outputs), outputs (value, ErgoTree,
// creation height, tokens as indexes into that list, registers R4.. in order). ErgoTrees, register values and
// extension values are written as the bytes they are (any ErgoTree version). The transaction id is its blake2b256.
const vlq = v => {
  let n = BigInt(v);
  if (n < 0n) throw new ValunError('bad_tx', 'a negative number in a transaction');
  const out = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
  return out;
};
const HEX32 = /^[0-9a-f]{64}$/, HEXS = /^(?:[0-9a-f]{2})*$/;
function hexBytes(h, what) {
  if (typeof h !== 'string' || !HEXS.test(h)) throw new ValunError('bad_tx', `${what} is not hex`);
  return Array.from(hexToBytes(h));
}
/** The bytes a transaction's input proofs sign (node-format unsigned or signed transaction JSON; proofs ignored). */
export function txBytesToSign(tx) {
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) throw new ValunError('bad_tx', 'a transaction has inputs and outputs');
  const out = [];
  out.push(...vlq(tx.inputs.length));
  for (const i of tx.inputs) {
    if (!HEX32.test(i?.boxId || '')) throw new ValunError('bad_tx', 'an input box id is not 32 bytes of hex');
    out.push(...hexBytes(i.boxId, 'an input box id'), 0x00);          // the box id, an empty proof
    const ext = i.extension ?? i.spendingProof?.extension ?? {};
    const keys = Object.keys(ext);
    if (!keys.every(k => BYTE_KEY.test(k))) throw new ValunError('bad_tx', 'a context extension key is not a byte');
    out.push(keys.length);
    for (const k of scalaExtensionOrder(keys.map(Number))) out.push(k, ...hexBytes(ext[String(k)], 'a context extension value'));
  }
  const data = tx.dataInputs || [];
  out.push(...vlq(data.length));
  for (const d of data) {
    if (!HEX32.test(d?.boxId || '')) throw new ValunError('bad_tx', 'a data input box id is not 32 bytes of hex');
    out.push(...hexBytes(d.boxId, 'a data input box id'));
  }
  const tokenIds = [];
  for (const o of tx.outputs) for (const a of o.assets || []) if (!tokenIds.includes(a.tokenId)) tokenIds.push(a.tokenId);
  out.push(...vlq(tokenIds.length));
  for (const t of tokenIds) {
    if (!HEX32.test(t || '')) throw new ValunError('bad_tx', 'a token id is not 32 bytes of hex');
    out.push(...hexBytes(t, 'a token id'));
  }
  out.push(...vlq(tx.outputs.length));
  for (const o of tx.outputs) {
    out.push(...vlq(o.value), ...hexBytes(o.ergoTree, 'an ErgoTree'), ...vlq(o.creationHeight));
    const assets = o.assets || [];
    out.push(assets.length);
    for (const a of assets) out.push(...vlq(tokenIds.indexOf(a.tokenId)), ...vlq(a.amount));
    const regs = o.additionalRegisters || {};
    const names = Object.keys(regs).sort();
    names.forEach((r, i) => { if (r !== `R${4 + i}`) throw new ValunError('bad_tx', 'registers must be R4, R5, ... in order'); });
    out.push(names.length);
    for (const r of names) out.push(...hexBytes(regs[r], `register ${r}`));
  }
  return Uint8Array.from(out);
}
/** The transaction id (hex): blake2b256 of the bytes to sign. */
export const txId = tx => bytesToHex(blake2b256(txBytesToSign(tx)));

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
    /** An unspent box as the node reports it (node format JSON). */
    box: id => call('GET', `/utxo/byId/${String(id).replace(/[^0-9a-f]/g, '')}`),
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
 * Check the redemption the tracker built before the agent's key signs it. `inputBoxes` are the boxes it spends as the
 * Ergo node reports them (GET /utxo/byId; never the tracker's copies), in input order. The agent's proof makes input 0
 * (the reserve) spendable, and a proof over these bytes would also spend any box of the agent's own, so it signs only
 * when: input 0 is a reserve of the issuer for this network (the reserve contract, R4 the issuer's key, R6 the tracker
 * NFT); no input is a box at the agent's own address; output 0 is that reserve, `amount` lower, with its registers' key
 * and NFT kept; one output pays exactly `amount` to the agent's own address; the reserve input's context names this
 * agent as receiver (#1) with action 0 (#0); and the transaction the tracker fee-signed is this one (same id).
 * Returns a summary.
 */
export function checkRedemption(built, {issuerPubkey, recipientPubkey, amount, trackerNftId, reserveTree = null, inputBoxes}) {
  const fail = why => { throw new ValunError('bad_redemption', `refusing to sign the redemption: ${why}`); };
  const tx = built?.unsigned_tx;
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs) || !Array.isArray(inputBoxes)) fail('the tracker\'s answer is not a redemption');
  if (inputBoxes.length !== tx.inputs.length) fail('the input boxes do not match the inputs');
  const boxes = inputBoxes;
  boxes.forEach((b, i) => { if (b?.boxId !== tx.inputs[i].boxId) fail(`input ${i} is not the box the node reports for it`); });
  if (!built.partial_tx || built.partial_tx.id !== txId(tx)) fail('the transaction the tracker fee-signed is not the one to sign');
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
 * The agent's proof for the reserve input (input 0) over exactly the transaction the tracker built (its bytes to sign,
 * computed here: txBytesToSign), spliced into the tracker's fee-signed transaction. The reserve script reduces to
 * proveDlog(receiver) once its other conditions hold, so the proof is the agent's Schnorr proof over those bytes
 * (basis.ergoProveDlog): no ergo-lib, and any ErgoTree version. Returns the signed transaction (write it with
 * toErgoJson). `options.randomBytes` replaces the nonce source (tests only).
 */
export function signRedemption(built, secretHex, options = {}) {
  const bytes = txBytesToSign(built.unsigned_tx);
  const id = bytesToHex(blake2b256(bytes));
  const signed = structuredClone(built.partial_tx);
  if (!signed?.inputs?.[0]?.spendingProof || signed.inputs[0].boxId !== built.unsigned_tx.inputs[0].boxId)
    throw new ValunError('bad_redemption', 'the partly signed transaction does not start with the reserve input');
  if (signed.id !== id) throw new ValunError('bad_redemption', 'the partly signed transaction is not the one built');
  signed.inputs[0].spendingProof.proofBytes = bytesToHex(ergoProveDlog(bytes, hexToBytes(secretHex), options));
  return signed;
}

export {bytesToHex};
