// The Basis tracker's Ergo node, for the Valun testnet network: a loopback HTTP server the tracker uses as both its
// scanner node and its wallet node. Chain reads and broadcasts go to a public TESTNET node (ERGO_NODE_URL). The wallet
// part is local: /wallet/boxes/unspent lists the boxes at the TRACKER's own P2PK address, and
// /wallet/transaction/sign signs with the one secret the tracker sends in its request (the tracker box updater's
// design), after these checks:
//   - the node is a testnet node (never mainnet);
//   - the request carries exactly one secret, and it is the tracker's key (TRACKER_PUBKEY): nothing else is signed;
//   - every input is a box the tracker owns, and the transaction keeps the tracker NFT in a tracker-owned box;
//   - the spend ledger's caps: 20 tERG in all, at most 50 tracker-box signatures a UTC day.
// Request bodies are never logged (they hold the secret). Usage:
//   TRACKER_PUBKEY=<33-byte hex> TRACKER_NFT_ID=<hex> SPEND_LEDGER=/data/.../spend-ledger.jsonl \
//   ERGO_NODE_URL=http://213.239.193.208:9052 node ergo/wallet-shim.mjs --port 9053
import http from 'node:http';
import {ChainError, SpendLedger, addressOf, nodeClient, p2pkTree, pubkeyOf, signTransaction, spentFrom, stateContext} from './chain.mjs';

const MAX_BODY = 1_000_000;
const PROXY = [/^\/info$/, /^\/blocks\/lastHeaders\/\d{1,2}$/, /^\/blockchain\/box\/unspent\/byTokenId\/[0-9a-f]{64}$/, /^\/blockchain\/box\/unspent\/byAddress$/,
  /^\/blockchain\/box\/byId\/[0-9a-f]{64}$/, /^\/blockchain\/transaction\/byId\/[0-9a-f]{64}$/, /^\/utxo\/byId\/[0-9a-f]{64}$/, /^\/utxo\/byIdBinary\/[0-9a-f]{64}$/,
  /^\/transactions$/, /^\/transactions\/check$/, /^\/transactions\/unconfirmed\/byTransactionId\/[0-9a-f]{64}$/, /^\/blockchain\/indexedHeight$/];

export function createShim({trackerPubkey, trackerNftId = null, ledger, node = nodeClient(), log = m => console.log(m)}) {
  if (!/^0[23][0-9a-f]{64}$/.test(trackerPubkey || '')) throw new Error('TRACKER_PUBKEY must be the tracker key (33 bytes hex)');
  const ourTree = p2pkTree(trackerPubkey), ourAddress = addressOf(trackerPubkey);

  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new ChainError('too_large', 'request too large', 413); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function walletBoxes() {
    const boxes = await node.unspentByAddress(ourAddress);
    return boxes.filter(b => b.ergoTree === ourTree).map(b => ({box: b, confirmationsNum: null, address: b.address, onchain: true,
      creationOutIndex: b.index, inclusionHeight: b.inclusionHeight ?? null, spendingHeight: null, spendingTransaction: null, scans: []}));
  }

  async function sign(bodyText) {
    let req;
    try { req = JSON.parse(bodyText); } catch { throw new ChainError('bad_json', 'the body is not JSON'); }
    const secrets = req?.secrets?.dlog;
    if (!Array.isArray(secrets) || secrets.length !== 1 || typeof secrets[0] !== 'string') throw new ChainError('bad_secrets', 'exactly one dlog secret is expected');
    let pk;
    try { pk = pubkeyOf(secrets[0]); } catch { throw new ChainError('bad_secrets', 'the secret is not a key'); }
    if (pk !== trackerPubkey) throw new ChainError('foreign_key', 'this node signs only for the tracker key', 403);
    await node.assertTestnet();
    const tx = req.tx, inputsRaw = req.inputsRaw, dataInputsRaw = req.dataInputsRaw || [];
    if (!tx || !Array.isArray(tx.outputs) || !Array.isArray(inputsRaw) || !inputsRaw.length) throw new ChainError('bad_tx', 'tx and inputsRaw are required');
    const ctx = await stateContext(node);
    const r = signTransaction({tx, inputsRaw, dataInputsRaw, secretHex: secrets[0], ctx});
    if (r.inputs.some(b => b.ergoTree !== ourTree)) throw new ChainError('foreign_input', 'every input must be a box at the tracker address', 403);
    // The tracker NFT never leaves the tracker: if an input holds it, an output at the tracker address holds it too.
    if (trackerNftId) {
      const holds = b => (b.assets || []).some(a => a.tokenId === trackerNftId);
      if (r.inputs.some(holds) && !r.signed.outputs.some(o => o.ergoTree === ourTree && holds(o))) throw new ChainError('nft_leaves', 'the tracker NFT must stay in a tracker box', 403);
    }
    const spent = spentFrom(ourTree, r.inputs, r.signed.outputs);
    const kind = trackerNftId && r.inputs.some(b => (b.assets || []).some(a => a.tokenId === trackerNftId)) ? 'tracker_box' : 'tracker_wallet';
    ledger.check(kind, spent);
    ledger.record({kind, tx_id: r.id, spent_nano: spent, inputs: r.inputs.map(b => b.boxId), outputs: r.signed.outputs.length, broadcast: false});
    log(`wallet-shim: signed ${kind} ${r.id} (spends ${spent} nanoERG of the tracker's)`);
    return r.signed;
  }

  // Every transaction the tracker broadcasts through this node: when it spends boxes at the tracker address (a tracker
  // box update this adapter signed, or a redemption the tracker fee-signed with its own key), what it takes from the
  // tracker goes through the spend ledger first (a transaction this adapter signed is already recorded: not counted
  // twice). The body is forwarded exactly as it came.
  async function broadcast(bodyText) {
    await node.assertTestnet();
    let tx;
    try { tx = JSON.parse(bodyText); } catch { throw new ChainError('bad_json', 'the body is not JSON'); }
    if (!tx || typeof tx.id !== 'string' || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) throw new ChainError('bad_tx', 'a signed transaction is expected');
    const boxes = await Promise.all(tx.inputs.map(i => node.call(`/utxo/byId/${String(i.boxId).replace(/[^0-9a-f]/g, '')}`)));
    const ours = boxes.filter(b => b?.ergoTree === ourTree);
    const known = ours.length > 0 && ledger.entries().some(e => e.tx_id === tx.id);
    const spent = ours.length ? spentFrom(ourTree, ours, tx.outputs) : 0n;
    if (ours.length && !known) ledger.check('tracker_tx', spent);
    const out = await node.call('/transactions', {method: 'POST', body: bodyText, raw: true});
    if (ours.length && !known) ledger.record({kind: 'tracker_tx', tx_id: tx.id, spent_nano: spent, inputs: ours.map(b => b.boxId), broadcast: true});
    log(`wallet-shim: broadcast ${tx.id}${ours.length ? ` (spends ${spent} nanoERG of the tracker's${known ? ', already recorded' : ''})` : ''}`);
    return out;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && p === '/wallet/boxes/unspent') return send(200, await walletBoxes());
      if (req.method === 'POST' && p === '/wallet/transaction/sign') return send(200, await sign(await readBody(req)));
      if (req.method === 'POST' && p === '/transactions') return send(200, await broadcast(await readBody(req)));
      if (PROXY.some(re => re.test(p)) && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        if (p === '/transactions') await node.assertTestnet();
        const out = await node.call(p + url.search, req.method === 'POST' ? {method: 'POST', body, raw: true} : {});
        if (p === '/transactions' && typeof out === 'string') log(`wallet-shim: broadcast ${out}`);
        return send(200, out);
      }
      return send(404, {error: 404, reason: 'not-found', detail: `not served by the Valun wallet adapter: ${req.method} ${p}`});
    } catch (e) {
      const status = e instanceof ChainError ? e.status : 500;
      return send(status, {error: status, reason: e.code || 'error', detail: String(e.message || e).slice(0, 300)});
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('wallet-shim.mjs')) {
  const port = Number((process.argv.indexOf('--port') > 0 && process.argv[process.argv.indexOf('--port') + 1]) || 9053);
  const ledger = new SpendLedger(process.env.SPEND_LEDGER || '/data/pilot/tracker/spend-ledger.jsonl');
  const handler = createShim({trackerPubkey: process.env.TRACKER_PUBKEY, trackerNftId: process.env.TRACKER_NFT_ID || null, ledger});
  http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`wallet-shim: listening on 127.0.0.1:${port}, node ${nodeClient().base}`));
}
