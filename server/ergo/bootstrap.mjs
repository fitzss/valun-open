// The Valun testnet tracker's on-chain bootstrap, run on the machine that holds the tracker's key (TESTNET only):
//   node ergo/bootstrap.mjs key    --dir DIR      the tracker key: made once in DIR/tracker-key.json (0600), never
//                                                 printed; prints the public key and the testnet address to fund
//   node ergo/bootstrap.mjs status --dir DIR      the address, its unspent boxes and the spend ledger
//   node ergo/bootstrap.mjs mint   --dir DIR --digest HEX [--broadcast]
//        mints the tracker NFT (id = the first input box's id) into the tracker box: P2PK(tracker), 0.01 tERG,
//        R4 = the tracker key, R5 = the AVL+ tree (the tracker's digest), R6 = the NFT id; fee 0.001 tERG; change back
//        to the tracker address. Without --broadcast it only builds and signs (a dry run) and prints the summary.
//        With it: one broadcast, then DIR/tracker-nft-id-onchain and DIR/bootstrap.json are written.
import fs from 'node:fs';
import path from 'node:path';
import {ChainError, FEE, MINER_FEE_TREE, SpendLedger, TRACKER_BOX_VALUE, addressOf, newKey, nodeClient, p2pkTree, pubkeyOf,
  regAvlTree, regCollByte, regGroupElement, signTransaction, stateContext} from './chain.mjs';

const MIN_CHANGE = 1_000_000;   // a change box must hold at least this (well above the minimum box value)

export function loadKey(dir) {
  const k = JSON.parse(fs.readFileSync(path.join(dir, 'tracker-key.json'), 'utf8'));
  if (pubkeyOf(k.secret_hex) !== k.pubkey_hex) throw new ChainError('bad_key_file', 'tracker-key.json: the public key does not match the secret');
  return k;
}

export function makeKey(dir) {
  const f = path.join(dir, 'tracker-key.json');
  if (fs.existsSync(f)) return {created: false, ...loadKey(dir)};
  fs.mkdirSync(dir, {recursive: true});
  const k = newKey();
  fs.writeFileSync(f, JSON.stringify(k) + '\n', {mode: 0o600, flag: 'wx'});
  return {created: true, ...k};
}

// The bootstrap transaction, built from the boxes at the tracker address (newest node data), signed, not sent.
export async function buildMint({key, digest, node, height}) {
  const tree = p2pkTree(key.pubkey_hex);
  const boxes = (await node.unspentByAddress(addressOf(key.pubkey_hex))).filter(b => b.ergoTree === tree)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const need = TRACKER_BOX_VALUE + FEE + MIN_CHANGE;
  const inputs = [];
  let total = 0;
  for (const b of boxes) { inputs.push(b); total += Number(b.value); if (total >= need) break; }
  if (total < need) throw new ChainError('unfunded', `the tracker address holds ${total} nanoERG; the bootstrap needs at least ${need}`, 409);
  const nftId = inputs[0].boxId;
  const carried = new Map();
  for (const b of inputs) for (const a of b.assets || []) carried.set(a.tokenId, (carried.get(a.tokenId) || 0n) + BigInt(a.amount));
  const tx = {
    inputs: inputs.map(b => ({boxId: b.boxId, extension: {}})), dataInputs: [],
    outputs: [
      {value: TRACKER_BOX_VALUE, ergoTree: tree, creationHeight: height, assets: [{tokenId: nftId, amount: 1}],
        additionalRegisters: {R4: regGroupElement(key.pubkey_hex), R5: regAvlTree(digest), R6: regCollByte(nftId)}},
      {value: FEE, ergoTree: MINER_FEE_TREE, creationHeight: height, assets: [], additionalRegisters: {}},
      {value: total - TRACKER_BOX_VALUE - FEE, ergoTree: tree, creationHeight: height,
        assets: [...carried].map(([tokenId, amount]) => ({tokenId, amount: Number(amount)})), additionalRegisters: {}},
    ],
  };
  const inputsRaw = await Promise.all(inputs.map(b => node.boxBinary(b.boxId)));
  const ctx = await stateContext(node);
  const r = signTransaction({tx, inputsRaw, secretHex: key.secret_hex, ctx});
  const out0 = r.signed.outputs[0];
  if (!(out0.assets?.[0]?.tokenId === nftId && Number(out0.assets[0].amount) === 1)) throw new ChainError('mint_shape', 'the tracker box does not hold the new NFT');
  return {signed: r.signed, tx_id: r.id, nft_id: nftId, tracker_box_id: out0.boxId, inputs: inputs.map(b => b.boxId), funded_nano: total,
    fee_nano: FEE, tracker_box_nano: TRACKER_BOX_VALUE, change_nano: total - TRACKER_BOX_VALUE - FEE};
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const dir = arg('--dir');
  if (!dir) throw new ChainError('usage', 'usage: bootstrap.mjs key|status|mint --dir DIR [--digest HEX] [--broadcast]');
  const ledger = new SpendLedger(process.env.SPEND_LEDGER || path.join(dir, 'spend-ledger.jsonl'));
  if (cmd === 'key') {
    const k = makeKey(dir);
    return console.log(JSON.stringify({created: k.created, pubkey: k.pubkey_hex, address: addressOf(k.pubkey_hex), file: path.join(dir, 'tracker-key.json')}));
  }
  const key = loadKey(dir), node = nodeClient();
  if (cmd === 'status') {
    const boxes = await node.unspentByAddress(addressOf(key.pubkey_hex));
    return console.log(JSON.stringify({address: addressOf(key.pubkey_hex), boxes: boxes.length, nano: boxes.reduce((n, b) => n + Number(b.value), 0),
      tokens: boxes.flatMap(b => (b.assets || []).map(a => a.tokenId)), spent_nano: String(ledger.spentNano()), height: await node.height()}));
  }
  if (cmd === 'mint') {
    const digest = arg('--digest');
    await node.assertTestnet();
    if (fs.existsSync(path.join(dir, 'tracker-nft-id-onchain'))) throw new ChainError('already_minted', 'this tracker already has an on-chain NFT (tracker-nft-id-onchain)', 409);
    const height = await node.height();
    const m = await buildMint({key, digest, node, height});
    const summary = {start_height: height, tx_id: m.tx_id, nft_id: m.nft_id, tracker_box_id: m.tracker_box_id, inputs: m.inputs, funded_nano: m.funded_nano, fee_nano: m.fee_nano,
      tracker_box_nano: m.tracker_box_nano, change_nano: m.change_nano};
    if (!rest.includes('--broadcast')) return console.log(JSON.stringify({dry_run: true, ...summary}));
    ledger.check('bootstrap', FEE);
    const sent = await node.broadcast(m.signed);
    if (sent !== m.tx_id) throw new ChainError('broadcast_mismatch', `the node answered ${sent}, not ${m.tx_id}`);
    ledger.record({kind: 'bootstrap', tx_id: m.tx_id, spent_nano: FEE, inputs: m.inputs, outputs: 3, broadcast: true, nft_id: m.nft_id});
    fs.writeFileSync(path.join(dir, 'tracker-nft-id-onchain'), m.nft_id);
    fs.writeFileSync(path.join(dir, 'bootstrap.json'), JSON.stringify({...summary, broadcast_at: new Date().toISOString()}, null, 1) + '\n');
    return console.log(JSON.stringify({broadcast: true, ...summary}));
  }
  throw new ChainError('usage', `unknown command ${cmd}`);
}

if (process.argv[1] && process.argv[1].endsWith('bootstrap.mjs')) {
  main().catch(e => { console.error(JSON.stringify({error: e.code || 'error', message: String(e.message || e)})); process.exit(1); });
}
