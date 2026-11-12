// js/src/ergo.js: settlement on Ergo testnet for the Valun testnet network. The address, the context-extension order,
// the bytes a transaction's proofs sign, the agent's proveDlog proof and every check are plain JavaScript and always
// tested; building a reserve uses ergo-lib (an optional dependency), and ergo-lib also cross-checks the native proof:
// those tests run where ergo-lib-wasm-nodejs is installed and are skipped elsewhere (CI's js job installs nothing).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ergo from '../src/ergo.js';
import * as basis from '../src/basis.js';
import {bytesToHex, hexToBytes} from '../src/bytes.js';

const {publicKey} = basis;

const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const secretOf = n => bytesToHex(Uint8Array.from({length: 32}, (_, i) => (i === 31 ? n : 0x11)));
const pubOf = s => bytesToHex(publicKey(hexToBytes(s)));
const NFT = 'ab'.repeat(32);
let E = null;
try { E = await ergo.ergoLib(); } catch { /* not installed: the signing tests are skipped */ }
const withLib = {skip: E ? false : 'ergo-lib-wasm-nodejs is not installed'};

test('the P2PK address and tree of a key (vectors from ergo-lib)', () => {
  assert.equal(ergo.p2pkAddress(G), '3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsN', 'testnet');
  assert.equal(ergo.p2pkAddress(G, {testnet: false}), '9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV', 'mainnet');
  assert.equal(ergo.p2pkTree(G), `0008cd${G}`);
  for (const bad of ['', '04' + 'aa'.repeat(32), G.toUpperCase(), G.slice(2), null]) assert.throws(() => ergo.p2pkTree(bad), {code: 'invalid_field'});
});

test('context extensions are written in Scala order (the tracker\'s vectors)', () => {
  assert.deepEqual(ergo.scalaExtensionOrder([0, 1, 2, 3, 4, 5, 6, 8]), [0, 5, 1, 6, 2, 3, 8, 4]);
  assert.deepEqual(ergo.scalaExtensionOrder([0, 1, 2, 3, 4, 5, 6, 7, 8]), [0, 5, 1, 6, 2, 7, 3, 8, 4]);
  const ext = JSON.parse(JSON.stringify(Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 8].map(k => [String(k), `0e0${k}`]))));
  const text = ergo.toErgoJson({inputs: [{boxId: 'r', extension: ext}]});
  assert.equal(text, '{"inputs":[{"boxId":"r","extension":{"0":"0e00","5":"0e05","1":"0e01","6":"0e06","2":"0e02","3":"0e03","8":"0e08","4":"0e04"}}]}');
});

test('a reserve request is checked before anything is signed', () => {
  const pk = pubOf(secretOf(1)), nftId = 'cd'.repeat(32);
  const good = {requests: [{address: 'RESERVE', value: 50_000_000, assets: [{token_id: nftId, amount: 1}], registers: {R4: `07${pk}`, R5: '64', R6: `0e20${NFT}`}}]};
  const args = {ergAmount: 50_000_000, nftId, pubkeyHex: pk, trackerNftId: NFT, reserveContract: 'RESERVE'};
  assert.deepEqual(ergo.checkReservePayload(good, args).assets, [{tokenId: nftId, amount: 1}]);
  const bad = (change, re) => {
    const p = structuredClone(good);
    change(p.requests[0], p);
    assert.throws(() => ergo.checkReservePayload(p, args), e => e.code === 'bad_payload' && re.test(e.message));
  };
  bad(r => { r.value = 50_000_001; }, /locks 50000001 nanoERG/);
  bad(r => { r.address = 'OTHER'; }, /reserve contract/);
  bad(r => { r.assets = []; }, /exactly one token/);
  bad(r => { r.assets[0].amount = 2; }, /exactly one token/);
  bad(r => { r.assets[0].token_id = 'ee'.repeat(32); }, /first input/);
  bad(r => { r.registers.R4 = `07${G}`; }, /R4 is not this agent/);
  bad(r => { r.registers.R6 = `0e20${'00'.repeat(32)}`; }, /tracker NFT/);
  bad((r, p) => { p.requests.push(r); }, /exactly one output/);
});

test('the node client: a testnet node only; the address query body is a JSON string', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({url, opts});
    if (url.endsWith('/info')) return new Response(JSON.stringify({network: url.includes('main') ? 'mainnet' : 'testnet', fullHeight: 7}), {status: 200});
    return new Response('[]', {status: 200});
  };
  await ergo.nodeClient('http://test.node:9052', {fetchImpl}).assertTestnet();
  await assert.rejects(ergo.nodeClient('http://main.node', {fetchImpl}).assertTestnet(), {code: 'not_testnet'});
  await ergo.nodeClient('http://test.node:9052/', {fetchImpl}).unspentByAddress('3Wabc');
  assert.equal(calls.at(-1).url, 'http://test.node:9052/blockchain/box/unspent/byAddress?offset=0&limit=100');
  assert.equal(calls.at(-1).opts.body, '"3Wabc"');
  assert.throws(() => ergo.nodeClient('file:///x'), {code: 'invalid_field'});
});

// ---------- with ergo-lib ----------
const HEADERS = [];
const fixtureHeaders = async () => {
  if (HEADERS.length) return HEADERS;
  // Ten consecutive real testnet headers would need a node; ergo-lib only needs well-formed ones: build them from one
  // real header (testnet block 639650) by height.
  const base = {extensionId: '00'.repeat(32), difficulty: '1', votes: '000000', timestamp: 1_731_400_000_000, size: 221, unparsedBytes: '',
    stateRoot: '00'.repeat(33), height: 639_650, nBits: 117_811_961, version: 3, id: '', adProofsRoot: '00'.repeat(32), transactionsRoot: '00'.repeat(32),
    extensionHash: '00'.repeat(32), powSolutions: {pk: G, w: G, n: '0000000000000000', d: 0}, adProofsId: '00'.repeat(32), transactionsId: '00'.repeat(32), parentId: '00'.repeat(32)};
  for (let i = 0; i < 10; i++) HEADERS.push({...base, height: base.height + i, id: (i + 1).toString(16).padStart(64, '0'), parentId: i.toString(16).padStart(64, '0'), timestamp: base.timestamp + i * 120_000});
  return HEADERS;
};
const boxAt = (tree, value, {txId = '11'.repeat(32), index = 0, registers = {}, tokens = []} = {}) => {
  const b = new E.ErgoBoxCandidateBuilder(E.BoxValue.from_i64(E.I64.from_str(String(value))), E.Contract.new(E.ErgoTree.from_base16_bytes(tree)), 639_600);
  for (const [r, hex] of Object.entries(registers)) b.set_register_value(E.NonMandatoryRegisterId[r], E.Constant.decode_from_base16(hex));
  for (const [id, amount] of tokens) b.add_token(E.TokenId.from_str(id), E.TokenAmount.from_i64(E.I64.from_str(String(amount))));
  const box = E.ErgoBox.from_box_candidate(b.build(), E.TxId.from_str(txId), index);
  return {box, json: JSON.parse(box.to_json()), hex: bytesToHex(box.sigma_serialize_bytes())};
};
const AVL = `64${'00'.repeat(33)}0320` + '00';

test('buildReserve: plain boxes at the agent\'s own address, the checked request as output 0, every input proof verifies', withLib, async () => {
  const secret = secretOf(2), pk = pubOf(secret), tree = ergo.p2pkTree(pk);
  const a = boxAt(tree, 300_000_000, {txId: '21'.repeat(32)}), b = boxAt(tree, 40_000_000, {txId: '22'.repeat(32)});
  const tokenBox = boxAt(tree, 900_000_000, {txId: '23'.repeat(32), tokens: [['ef'.repeat(32), 5]]});
  const reserveTree = '10010101d17300';                       // any script will do for the reserve output here
  const reserveAddress = E.Address.recreate_from_ergo_tree(E.ErgoTree.from_base16_bytes(reserveTree)).to_base58(E.NetworkPrefix.Testnet);
  const headers = await fixtureHeaders();
  const byId = new Map([a, b, tokenBox].map(x => [x.json.boxId, x]));
  const node = {
    assertTestnet: async () => ({network: 'testnet'}), lastHeaders: async () => headers,
    unspentByAddress: async addr => { assert.equal(addr, ergo.p2pkAddress(pk)); return [b.json, tokenBox.json, a.json]; },
    boxBinary: async id => byId.get(id).hex,
  };
  let asked = null;
  const payloadFor = async nftId => { asked = nftId; return {requests: [{address: reserveAddress, value: 250_000_000, assets: [{token_id: nftId, amount: 1}],
    registers: {R4: `07${pk}`, R5: AVL, R6: `0e20${NFT}`}}]}; };
  const r = await ergo.buildReserve({secretHex: secret, pubkeyHex: pk, ergAmount: 250_000_000, node, payloadFor, trackerNftId: NFT, reserveContract: reserveAddress});
  assert.equal(asked, a.json.boxId, 'the reserve NFT id is the first input: the largest plain box');
  assert.deepEqual(r.signed.inputs.map(i => i.boxId), [a.json.boxId], 'one box is enough; the token box is never spent');
  const [reserve, fee, change] = r.signed.outputs;
  assert.equal(reserve.ergoTree, reserveTree);
  assert.equal(Number(reserve.value), 250_000_000);
  assert.deepEqual(reserve.assets.map(t => [t.tokenId, Number(t.amount)]), [[a.json.boxId, 1]]);
  assert.equal(reserve.additionalRegisters.R4, `07${pk}`);
  assert.equal(fee.ergoTree, ergo.MINER_FEE_TREE);
  assert.equal(Number(fee.value), ergo.FEE);
  assert.equal(change.ergoTree, tree);
  assert.equal(Number(change.value), 300_000_000 - 250_000_000 - ergo.FEE);
  assert.equal(r.reserve_box_id, reserve.boxId);
  const tx = E.Transaction.from_json(JSON.stringify(r.signed));
  const spent = E.ErgoBoxes.empty(); spent.add(a.box);
  assert.equal(E.verify_tx_input_proof(0, ergo.stateContext(E, headers), tx, spent, E.ErgoBoxes.empty()), true, 'the proof verifies');
  // Not enough in plain boxes: refused before the tracker is asked.
  asked = null;
  await assert.rejects(ergo.buildReserve({secretHex: secret, pubkeyHex: pk, ergAmount: 400_000_000, node, payloadFor, trackerNftId: NFT, reserveContract: reserveAddress}), {code: 'unfunded'});
  assert.equal(asked, null);
  // A request that does not lock the amount: refused, nothing signed.
  await assert.rejects(ergo.buildReserve({secretHex: secret, pubkeyHex: pk, ergAmount: 250_000_000, node, trackerNftId: NFT, reserveContract: reserveAddress,
    payloadFor: async nftId => ({requests: [{address: reserveAddress, value: 250_000_001, assets: [{token_id: nftId, amount: 1}], registers: {R4: `07${pk}`, R6: `0e20${NFT}`}}]})}), {code: 'bad_payload'});
});


// ---------- redemption: the bytes to sign, the proof, the checks (plain JavaScript, no ergo-lib) ----------
// A transaction id computed by ergo-lib 0.28.0 for this exact transaction (tokens, registers, an 8-key context
// extension written in Scala's order, a data input): the native serialization must give the same id.
const VEC_TX = {inputs: [{boxId: 'aa'.repeat(32), extension: {0: '0200', 1: `07${G}`, 2: '0e0101', 3: '0580897a', 4: '05a09c01', 5: '0e0105', 6: '0e00', 8: '0e0108'}},
  {boxId: 'bb'.repeat(32), extension: {}}], dataInputs: [{boxId: 'cc'.repeat(32)}],
  outputs: [{value: 197000000, ergoTree: `0008cd${G}`, creationHeight: 639900, assets: [{tokenId: 'dd'.repeat(32), amount: 1}],
    additionalRegisters: {R4: `07${G}`, R5: `64${'00'.repeat(33)}032000`, R6: `0e20${'ee'.repeat(32)}`}},
  {value: 3000000, ergoTree: `0008cd${G}`, creationHeight: 639900, assets: [], additionalRegisters: {}}]};

test('the bytes a transaction\'s proofs sign: the id ergo-lib computes, whatever order the extension arrives in', () => {
  assert.equal(ergo.txId(VEC_TX), '2590fd5d0448dd3d266b72b52e60c054bf2ea35266c24e1799ad7ef8c63bdd0b');
  assert.equal(ergo.txId(JSON.parse(JSON.stringify(VEC_TX))), ergo.txId(VEC_TX), 'written in Scala order whatever order it arrives in');
  const other = structuredClone(VEC_TX);
  other.outputs[1].value = 3000001;
  assert.notEqual(ergo.txId(other), ergo.txId(VEC_TX));
  for (const [change, re] of [[t => { t.inputs[0].boxId = 'zz'; }, /input box id/], [t => { t.outputs[0].additionalRegisters = {R5: '00'}; }, /R4, R5/],
    [t => { t.inputs[0].extension = {x: '00'}; }, /not a byte/], [t => { t.outputs[0].value = -1; }, /negative/], [t => { t.outputs[0].ergoTree = 'xyz'; }, /not hex/]]) {
    const t = structuredClone(VEC_TX);
    change(t);
    assert.throws(() => ergo.txBytesToSign(t), e => e.code === 'bad_tx' && re.test(e.message), re.source);
  }
});

test('the proveDlog proof over those bytes verifies for the key and the transaction, and for nothing else', () => {
  const secret = secretOf(9), pk = pubOf(secret), msg = ergo.txBytesToSign(VEC_TX);
  const proof = basis.ergoProveDlog(msg, hexToBytes(secret));
  assert.equal(proof.length, 56, 'challenge (24 bytes) and response (32 bytes)');
  assert.equal(basis.ergoVerifyDlog(proof, msg, pk), true);
  assert.equal(basis.ergoVerifyDlog(proof, msg, G), false, 'another key');
  assert.equal(basis.ergoVerifyDlog(proof, ergo.txBytesToSign({...VEC_TX, dataInputs: []}), pk), false, 'another transaction');
  const bent = proof.slice(); bent[30] ^= 1;
  assert.equal(basis.ergoVerifyDlog(bent, msg, pk), false, 'a changed proof');
  assert.notEqual(bytesToHex(basis.ergoProveDlog(msg, hexToBytes(secret))), bytesToHex(proof), 'a fresh nonce every time');
});

test('an address of either network gives its tree; a damaged one is refused', () => {
  assert.equal(ergo.addressToTree('3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsN'), `0008cd${G}`);
  assert.equal(ergo.addressToTree('9fSgJ7BmUxBQJ454prQDQ7fQMBkXPLaAmDnimgTtjym6FYPHjAV'), `0008cd${G}`);
  assert.throws(() => ergo.addressToTree('3WwXpssaZwcNzaGMv3AgxBdTPJQBt5gCmqBsg3DykQ39bYdhJBsM'), {code: 'invalid_field'});
  assert.throws(() => ergo.addressToTree('0OIl'), {code: 'invalid_field'});
});

// A redemption as the tracker builds it (a stand-in reserve tree; the checks read the boxes as the node reports them),
// with its partly signed transaction.
function redemption({amount = 20_000_000} = {}) {
  const issuer = pubOf(secretOf(3)), recipientSecret = secretOf(4), recipient = pubOf(recipientSecret), tracker = pubOf(secretOf(5));
  const reserveTree = `100108cd${recipient}7300`;
  const reserveBox = {boxId: '31'.repeat(32), value: 100_000_000, ergoTree: reserveTree, assets: [{tokenId: '77'.repeat(32), amount: 1}],
    additionalRegisters: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}};
  const feeBox = {boxId: '32'.repeat(32), value: 50_000_000, ergoTree: ergo.p2pkTree(tracker), assets: [], additionalRegisters: {}};
  const ext = {};
  for (const k of [0, 1, 2, 3, 4, 5, 6, 8]) ext[String(k)] = k === 0 ? '0200' : k === 1 ? `07${recipient}` : `0e01${(k * 17).toString(16).padStart(2, '0')}`;
  const unsigned_tx = {inputs: [{boxId: reserveBox.boxId, extension: ext}, {boxId: feeBox.boxId, extension: {}}], dataInputs: [{boxId: '33'.repeat(32)}],
    outputs: [{value: 100_000_000 - amount, ergoTree: reserveTree, creationHeight: 639_650, assets: [{tokenId: '77'.repeat(32), amount: 1}], additionalRegisters: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}},
      {value: amount, ergoTree: ergo.p2pkTree(recipient), creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: ergo.FEE, ergoTree: ergo.MINER_FEE_TREE, creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: 50_000_000 - ergo.FEE, ergoTree: ergo.p2pkTree(tracker), creationHeight: 639_650, assets: [], additionalRegisters: {}}]};
  const id = ergo.txId(unsigned_tx);
  const feeProof = bytesToHex(basis.ergoProveDlog(ergo.txBytesToSign(unsigned_tx), hexToBytes(secretOf(5))));
  const partial_tx = {id, inputs: [{boxId: reserveBox.boxId, spendingProof: {proofBytes: '', extension: ext}}, {boxId: feeBox.boxId, spendingProof: {proofBytes: feeProof, extension: {}}}],
    dataInputs: unsigned_tx.dataInputs, outputs: unsigned_tx.outputs.map((o, i) => ({...o, boxId: String(i).repeat(64).slice(0, 64), transactionId: id, index: i}))};
  // As it reaches a JavaScript client: through JSON.parse (the extension keys sorted).
  const built = JSON.parse(JSON.stringify({issuer: {pubkey: issuer}, unsigned_tx, partial_tx}));
  return {built, issuer, recipient, recipientSecret, reserveTree, amount, inputBoxes: [reserveBox, feeBox], id};
}

test('checkRedemption: the issuer\'s reserve, exactly the amount to this agent, nothing of its own, the transaction the tracker fee-signed', () => {
  const f = redemption();
  const args = {issuerPubkey: f.issuer, recipientPubkey: f.recipient, amount: f.amount, trackerNftId: NFT, reserveTree: f.reserveTree, inputBoxes: f.inputBoxes};
  assert.deepEqual(ergo.checkRedemption(f.built, args), {reserve_box_id: '31'.repeat(32), reserve_value: 100_000_000, paid_nanoerg: f.amount, fee_inputs: 1});
  const refused = (change, re, over = {}) => {
    const b = structuredClone(f.built), boxes = structuredClone(f.inputBoxes);
    change(b, boxes);
    assert.throws(() => ergo.checkRedemption(b, {...args, inputBoxes: boxes, ...over}), e => e.code === 'bad_redemption' && re.test(e.message), re.source);
  };
  const resign = b => { b.partial_tx.id = ergo.txId(b.unsigned_tx); };
  refused(b => { b.unsigned_tx.outputs[1].value = f.amount - 1; }, /fee-signed is not the one/, {}, 'a changed transaction is not the fee-signed one');
  refused(b => { b.unsigned_tx.outputs[1].value = f.amount - 1; resign(b); }, /pays exactly/);
  refused(b => { b.unsigned_tx.outputs[0].value -= 1; resign(b); }, /output 0 is not the reserve/);
  refused(b => { b.unsigned_tx.outputs[0].additionalRegisters.R4 = `07${G}`; resign(b); }, /owner or tracker/);
  refused(b => { b.unsigned_tx.outputs[0].assets = []; resign(b); }, /tokens/);
  refused(b => { b.unsigned_tx.inputs[0].extension['1'] = `07${G}`; resign(b); }, /receiver/);
  refused(b => { b.unsigned_tx.inputs[0].extension['0'] = '0201'; resign(b); }, /redeem action/);
  refused((b, boxes) => { boxes.reverse(); }, /not the box the node reports/);
  refused(() => {}, /not the issuer's reserve/, {issuerPubkey: G});
  refused(() => {}, /tracker/, {trackerNftId: '00'.repeat(32)});
  refused(() => {}, /reserve contract/, {reserveTree: '10010101d17300'});
  // A fee input at this agent's own address would be spent by the agent's proof: refused.
  refused((b, boxes) => { boxes[1] = {...boxes[1], ergoTree: ergo.p2pkTree(f.recipient)}; }, /box of this agent's own/);
});

test('signRedemption: the agent\'s proof over the transaction\'s bytes, spliced into the tracker\'s fee-signed transaction (no ergo-lib)', () => {
  const f = redemption();
  assert.deepEqual(Object.keys(f.built.unsigned_tx.inputs[0].extension), ['0', '1', '2', '3', '4', '5', '6', '8'], 'sorted by JSON.parse');
  const signed = ergo.signRedemption(f.built, f.recipientSecret);
  assert.equal(signed.id, f.id);
  const proof = hexToBytes(signed.inputs[0].spendingProof.proofBytes);
  assert.equal(basis.ergoVerifyDlog(proof, ergo.txBytesToSign(f.built.unsigned_tx), f.recipient), true, 'the receiver\'s proof of this transaction');
  assert.deepEqual(signed.inputs[1], f.built.partial_tx.inputs[1], 'the tracker\'s fee proof is kept');
  assert.equal(f.built.partial_tx.inputs[0].spendingProof.proofBytes, '', 'the given transaction is not changed');
  assert.throws(() => ergo.signRedemption({...f.built, partial_tx: {...f.built.partial_tx, id: 'ff'.repeat(32)}}, f.recipientSecret), {code: 'bad_redemption'});
  assert.throws(() => ergo.signRedemption({...f.built, partial_tx: {...f.built.partial_tx, inputs: f.built.partial_tx.inputs.slice(1)}}, f.recipientSecret), {code: 'bad_redemption'});
});

test('ergo-lib accepts the native proof of a redemption input (a script that reduces to proveDlog(receiver))', withLib, async () => {
  const issuer = pubOf(secretOf(3)), recipientSecret = secretOf(4), recipient = pubOf(recipientSecret), trackerSecret = secretOf(5), tracker = pubOf(trackerSecret);
  const reserveTree = `100108cd${recipient}7300`;
  const reserve = boxAt(reserveTree, 100_000_000, {txId: '31'.repeat(32), registers: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}, tokens: [['77'.repeat(32), 1]]});
  const feeBox = boxAt(ergo.p2pkTree(tracker), 50_000_000, {txId: '32'.repeat(32)});
  const trackerBox = boxAt(ergo.p2pkTree(tracker), 10_000_000, {txId: '33'.repeat(32), tokens: [[NFT, 1]]});
  const ext = {};
  for (const k of [0, 1, 2, 3, 4, 5, 6, 8]) ext[String(k)] = k === 0 ? '0200' : k === 1 ? `07${recipient}` : `0e01${(k * 17).toString(16).padStart(2, '0')}`;
  const unsigned_tx = {inputs: [{boxId: reserve.json.boxId, extension: ext}, {boxId: feeBox.json.boxId, extension: {}}], dataInputs: [{boxId: trackerBox.json.boxId}],
    outputs: [{value: 80_000_000, ergoTree: reserveTree, creationHeight: 639_650, assets: [{tokenId: '77'.repeat(32), amount: 1}], additionalRegisters: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}},
      {value: 20_000_000, ergoTree: ergo.p2pkTree(recipient), creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: ergo.FEE, ergoTree: ergo.MINER_FEE_TREE, creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: 50_000_000 - ergo.FEE, ergoTree: ergo.p2pkTree(tracker), creationHeight: 639_650, assets: [], additionalRegisters: {}}]};
  const unsigned = E.UnsignedTransaction.from_json(ergo.toErgoJson(unsigned_tx));
  assert.equal(ergo.txId(unsigned_tx), unsigned.id().to_str(), 'the native id is ergo-lib\'s');
  const ctx = ergo.stateContext(E, await fixtureHeaders());
  const spend = E.ErgoBoxes.empty(); spend.add(reserve.box); spend.add(feeBox.box);
  const data = E.ErgoBoxes.empty(); data.add(trackerBox.box);
  const ts = new E.SecretKeys(); ts.add(E.SecretKey.dlog_from_bytes(hexToBytes(trackerSecret)));
  const fi = E.Wallet.from_secrets(ts).sign_tx_input(1, ctx, unsigned, spend, data);
  const candidates = unsigned.output_candidates(), outputs = [];
  for (let i = 0; i < candidates.len(); i++) outputs.push(JSON.parse(E.ErgoBox.from_box_candidate(candidates.get(i), unsigned.id(), i).to_json()));
  const partial_tx = {id: unsigned.id().to_str(), inputs: [{boxId: reserve.json.boxId, spendingProof: {proofBytes: '', extension: ext}},
    {boxId: fi.box_id().to_str(), spendingProof: JSON.parse(fi.spending_proof().to_json())}], dataInputs: unsigned_tx.dataInputs, outputs};
  const signed = ergo.signRedemption(JSON.parse(JSON.stringify({issuer: {pubkey: issuer}, unsigned_tx, partial_tx})), recipientSecret);
  const tx = E.Transaction.from_json(ergo.toErgoJson(signed));
  assert.equal(E.verify_tx_input_proof(0, ctx, tx, spend, data), true, 'the agent\'s native proof (input 0)');
  assert.equal(E.verify_tx_input_proof(1, ctx, tx, spend, data), true, 'the tracker\'s fee proof (input 1)');
});
