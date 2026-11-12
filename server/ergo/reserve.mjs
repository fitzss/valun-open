// Basis reserves on Ergo TESTNET for the Valun testnet network, and sending tERG between our own addresses.
//   buildReserve({secretHex, ergAmount, payloadFor, node, height}): a signed transaction that locks `ergAmount` nanoERG
//     from the key's own P2PK address in a Basis ERG reserve (the tracker's payment request: the reserve contract,
//     R4 = the key, R5 = the empty redemption tree, R6 = the tracker NFT) and mints the reserve's NFT (id = the first input
//     box), with the fee and the change back to the key's address. `payloadFor(nftId)` asks the tracker for the request.
//   buildSend({secretHex, toAddress, nano, node, height}): a signed payment from the key's address to another address.
// Server-held keys only (the tracker, the sandbox agents); a participant's own client builds its own transactions.
//   node ergo/reserve.mjs send    --dir TRACKER_DIR --to ADDRESS --nano N [--broadcast]   (from the tracker's address)
//   node ergo/reserve.mjs reserve --sandbox-keys FILE --handle H --nano N --tracker URL [--broadcast]
import fs from 'node:fs';
import path from 'node:path';
import {E, ChainError, FEE, MINER_FEE_TREE, SpendLedger, addressOf, nodeClient, p2pkTree, pubkeyOf, signTransaction, spentFrom, stateContext} from './chain.mjs';

const MIN_CHANGE = 1_000_000;

async function pick(node, pkHex, need) {
  const tree = p2pkTree(pkHex);
  const boxes = (await node.unspentByAddress(addressOf(pkHex))).filter(b => b.ergoTree === tree && !(b.assets || []).length)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const inputs = [];
  let total = 0;
  for (const b of boxes) { inputs.push(b); total += Number(b.value); if (total >= need) break; }
  if (total < need) throw new ChainError('unfunded', `${addressOf(pkHex)} holds ${total} nanoERG in plain boxes; this needs at least ${need}`, 409);
  return {inputs, total, tree};
}

async function finish({secretHex, inputs, outputs, node}) {
  const ctx = await stateContext(node);
  const inputsRaw = await Promise.all(inputs.map(b => node.boxBinary(b.boxId)));
  return signTransaction({tx: {inputs: inputs.map(b => ({boxId: b.boxId, extension: {}})), dataInputs: [], outputs}, inputsRaw, secretHex, ctx});
}

export async function buildReserve({secretHex, ergAmount, payloadFor, node, height}) {
  const pk = pubkeyOf(secretHex);
  const {inputs, total, tree} = await pick(node, pk, ergAmount + FEE + MIN_CHANGE);
  const nftId = inputs[0].boxId;
  const payload = await payloadFor(nftId);
  const req = (payload?.requests || [])[0];
  if (!req || Number(req.value) !== ergAmount) throw new ChainError('bad_payload', 'the tracker\'s payment request does not lock the amount asked');
  const assets = (req.assets || []).map(a => ({tokenId: a.token_id ?? a.tokenId, amount: Number(a.amount)}));
  if (assets.length !== 1 || assets[0].tokenId !== nftId || assets[0].amount !== 1) throw new ChainError('bad_payload', 'the reserve must mint exactly one NFT, id = the first input');
  if (req.registers?.R4 !== '07' + pk) throw new ChainError('bad_payload', 'the reserve R4 is not this key');
  const reserveTree = E.Address.from_base58(req.address).to_ergo_tree().to_base16_bytes();
  const outputs = [
    {value: ergAmount, ergoTree: reserveTree, creationHeight: height, assets, additionalRegisters: req.registers},
    {value: FEE, ergoTree: MINER_FEE_TREE, creationHeight: height, assets: [], additionalRegisters: {}},
    {value: total - ergAmount - FEE, ergoTree: tree, creationHeight: height, assets: [], additionalRegisters: {}},
  ];
  const r = await finish({secretHex, inputs, outputs, node});
  return {...r, nft_id: nftId, reserve_box_id: r.signed.outputs[0].boxId, owner_pubkey: pk, spent_nano: spentFrom(tree, r.inputs, r.signed.outputs)};
}

export async function buildSend({secretHex, toAddress, nano, node, height}) {
  const pk = pubkeyOf(secretHex);
  const {inputs, total, tree} = await pick(node, pk, nano + FEE + MIN_CHANGE);
  const outputs = [
    {value: nano, ergoTree: E.Address.from_base58(toAddress).to_ergo_tree().to_base16_bytes(), creationHeight: height, assets: [], additionalRegisters: {}},
    {value: FEE, ergoTree: MINER_FEE_TREE, creationHeight: height, assets: [], additionalRegisters: {}},
    {value: total - nano - FEE, ergoTree: tree, creationHeight: height, assets: [], additionalRegisters: {}},
  ];
  const r = await finish({secretHex, inputs, outputs, node});
  return {...r, spent_nano: spentFrom(tree, r.inputs, r.signed.outputs)};
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const node = nodeClient(), broadcast = rest.includes('--broadcast');
  await node.assertTestnet();
  const height = await node.height();
  if (cmd === 'send') {
    const dir = arg('--dir'), to = arg('--to'), nano = Number(arg('--nano'));
    const key = JSON.parse(fs.readFileSync(path.join(dir, 'tracker-key.json'), 'utf8'));
    const ledger = new SpendLedger(process.env.SPEND_LEDGER || path.join(dir, 'spend-ledger.jsonl'));
    const r = await buildSend({secretHex: key.secret_hex, toAddress: to, nano, node, height});
    const summary = {tx_id: r.id, to, nano, spent_nano: String(r.spent_nano), inputs: r.inputs.map(b => b.boxId)};
    if (!broadcast) return console.log(JSON.stringify({dry_run: true, ...summary}));
    ledger.check('transfer', r.spent_nano);
    const sent = await node.broadcast(r.signed);
    ledger.record({kind: 'transfer', tx_id: r.id, spent_nano: r.spent_nano, to, nano, broadcast: true});
    return console.log(JSON.stringify({broadcast: true, sent, ...summary}));
  }
  if (cmd === 'reserve') {
    const keys = JSON.parse(fs.readFileSync(arg('--sandbox-keys'), 'utf8')), handle = arg('--handle'), nano = Number(arg('--nano'));
    const k = keys[handle] || keys.agents?.[handle];
    if (!k?.secret) throw new ChainError('no_key', `no server-held key for ${handle}`);
    const tracker = (arg('--tracker') || 'http://127.0.0.1:3058').replace(/\/+$/, '');
    const ledger = new SpendLedger(process.env.SPEND_LEDGER || '/data/pilot/tracker/spend-ledger.jsonl');
    const payloadFor = async nftId => {
      const res = await fetch(`${tracker}/reserves/create`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({nft_id: nftId, owner_pubkey: k.pubkey, erg_amount: nano})});
      const j = await res.json();
      if (!res.ok || j.success === false) throw new ChainError('tracker_refused', `the tracker refused the reserve: ${j.error || res.status}`);
      return j.data ?? j;
    };
    const r = await buildReserve({secretHex: k.secret, ergAmount: nano, payloadFor, node, height});
    const summary = {tx_id: r.id, handle, owner_pubkey: r.owner_pubkey, reserve_box_id: r.reserve_box_id, nft_id: r.nft_id, nano, spent_nano: String(r.spent_nano)};
    if (!broadcast) return console.log(JSON.stringify({dry_run: true, ...summary}));
    ledger.check('reserve', r.spent_nano);
    const sent = await node.broadcast(r.signed);
    ledger.record({kind: 'reserve', tx_id: r.id, spent_nano: r.spent_nano, handle, reserve_box_id: r.reserve_box_id, broadcast: true});
    return console.log(JSON.stringify({broadcast: true, sent, ...summary}));
  }
  throw new ChainError('usage', 'usage: reserve.mjs send|reserve ...');
}

if (process.argv[1] && process.argv[1].endsWith('reserve.mjs')) {
  main().catch(e => { console.error(JSON.stringify({error: e.code || 'error', message: String(e.message || e)})); process.exit(1); });
}
