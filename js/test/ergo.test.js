// js/src/ergo.js: settlement on Ergo testnet for the Valun testnet network. The address, the context-extension order
// and the checks are plain JavaScript and always tested; building and signing use ergo-lib (an optional dependency):
// those tests run where ergo-lib-wasm-nodejs is installed and are skipped elsewhere (CI installs nothing).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as ergo from '../src/ergo.js';
import {publicKey} from '../src/basis.js';
import {bytesToHex, hexToBytes} from '../src/bytes.js';

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

// A redemption as the tracker builds it, with a stand-in reserve script: input 0 the issuer's "reserve" (here guarded
// by proveDlog(receiver), so ergo-lib can prove it without the Basis contract's context), input 1 the tracker's fee box,
// output 0 the reserve `amount` lower, output 1 the payout. The partly signed transaction carries the tracker's fee proof.
async function redemptionFixture({amount = 20_000_000} = {}) {
  const issuer = pubOf(secretOf(3)), recipientSecret = secretOf(4), recipient = pubOf(recipientSecret), trackerSecret = secretOf(5), tracker = pubOf(trackerSecret);
  const reserveTree = `100108cd${recipient}7300`;            // the stand-in reserve script: proveDlog(receiver), segregated
  const reserve = boxAt(reserveTree, 100_000_000, {txId: '31'.repeat(32), registers: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}, tokens: [['77'.repeat(32), 1]]});
  const feeBox = boxAt(ergo.p2pkTree(tracker), 50_000_000, {txId: '32'.repeat(32)});
  const trackerBox = boxAt(ergo.p2pkTree(tracker), 10_000_000, {txId: '33'.repeat(32), tokens: [[NFT, 1]]});
  const ext = {};
  for (const k of [0, 1, 2, 3, 4, 5, 6, 8]) ext[String(k)] = k === 0 ? '0200' : k === 1 ? `07${recipient}` : `0e01${(k * 17).toString(16).padStart(2, '0')}`;
  const unsigned_tx = {inputs: [{boxId: reserve.json.boxId, extension: ext}, {boxId: feeBox.json.boxId, extension: {}}], dataInputs: [{boxId: trackerBox.json.boxId}],
    outputs: [{value: 100_000_000 - amount, ergoTree: reserveTree, creationHeight: 639_650, assets: [{tokenId: '77'.repeat(32), amount: 1}], additionalRegisters: {R4: `07${issuer}`, R5: AVL, R6: `0e20${NFT}`}},
      {value: amount, ergoTree: ergo.p2pkTree(recipient), creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: ergo.FEE, ergoTree: ergo.MINER_FEE_TREE, creationHeight: 639_650, assets: [], additionalRegisters: {}},
      {value: 50_000_000 - ergo.FEE, ergoTree: ergo.p2pkTree(tracker), creationHeight: 639_650, assets: [], additionalRegisters: {}}]};
  const headers = await fixtureHeaders();
  // The tracker fee-signs input 1 over the Scala-ordered bytes and leaves input 0's proof empty.
  const unsigned = E.UnsignedTransaction.from_json(ergo.toErgoJson(unsigned_tx));
  const spend = E.ErgoBoxes.empty(); spend.add(reserve.box); spend.add(feeBox.box);
  const data = E.ErgoBoxes.empty(); data.add(trackerBox.box);
  const ts = new E.SecretKeys(); ts.add(E.SecretKey.dlog_from_bytes(hexToBytes(trackerSecret)));
  const fi = E.Wallet.from_secrets(ts).sign_tx_input(1, ergo.stateContext(E, headers), unsigned, spend, data);
  const feeInput = {boxId: fi.box_id().to_str(), spendingProof: JSON.parse(fi.spending_proof().to_json())};
  const candidates = unsigned.output_candidates(), outputs = [];
  for (let i = 0; i < candidates.len(); i++) outputs.push(JSON.parse(E.ErgoBox.from_box_candidate(candidates.get(i), unsigned.id(), i).to_json()));
  const partial_tx = {id: unsigned.id().to_str(), inputs: [{boxId: reserve.json.boxId, spendingProof: {proofBytes: '', extension: ext}}, feeInput],
    dataInputs: unsigned_tx.dataInputs, outputs};
  // As it reaches a JavaScript client: through JSON.parse (the extension keys sorted).
  const built = JSON.parse(JSON.stringify({issuer: {pubkey: issuer}, unsigned_tx, partial_tx, input_box_binaries: [reserve.hex, feeBox.hex], data_box_binaries: [trackerBox.hex], headers}));
  return {built, issuer, recipient, recipientSecret, reserveTree, amount, spend, data, headers, unsignedId: unsigned.id().to_str()};
}

test('checkRedemption: signs only the issuer\'s reserve paying exactly the amount to this agent, spending nothing of its own', withLib, async () => {
  const f = await redemptionFixture();
  const args = {issuerPubkey: f.issuer, recipientPubkey: f.recipient, amount: f.amount, trackerNftId: NFT, reserveTree: f.reserveTree};
  assert.deepEqual(ergo.checkRedemption(E, f.built, args), {reserve_box_id: f.built.unsigned_tx.inputs[0].boxId, reserve_value: 100_000_000, paid_nanoerg: f.amount, fee_inputs: 1});
  const refused = (change, re, a = args) => {
    const b = structuredClone(f.built);
    change(b);
    assert.throws(() => ergo.checkRedemption(E, b, a), e => e.code === 'bad_redemption' && re.test(e.message), re.source);
  };
  refused(b => { b.unsigned_tx.outputs[1].value = f.amount - 1; }, /pays exactly/);
  refused(b => { b.unsigned_tx.outputs[0].value = 100_000_000 - f.amount - 1; }, /output 0 is not the reserve/);
  refused(b => { b.unsigned_tx.outputs[0].additionalRegisters.R4 = `07${G}`; }, /owner or tracker/);
  refused(b => { b.unsigned_tx.outputs[0].assets = []; }, /tokens/);
  refused(b => { b.unsigned_tx.inputs[0].extension['1'] = `07${G}`; }, /receiver/);
  refused(b => { b.unsigned_tx.inputs[0].extension['0'] = '0201'; }, /redeem action/);
  refused(b => { b.unsigned_tx.inputs.reverse(); }, /not the box given/);
  refused(() => {}, /not the issuer's reserve/, {...args, issuerPubkey: G});
  refused(() => {}, /tracker/, {...args, trackerNftId: '00'.repeat(32)});
  refused(() => {}, /reserve contract/, {...args, reserveTree: '10010101d17300'});
  // A fee input at this agent's own address would be spent by the agent's proof: refused.
  const own = boxAt(ergo.p2pkTree(f.recipient), 5_000_000, {txId: '34'.repeat(32)});
  refused(b => { b.unsigned_tx.inputs[1] = {boxId: own.json.boxId, extension: {}}; b.input_box_binaries[1] = own.hex; }, /box of this agent's own/);
});

test('signRedemption: the proof over the Scala-ordered bytes, spliced into the tracker\'s fee-signed transaction; both inputs verify', withLib, async () => {
  const f = await redemptionFixture();
  assert.deepEqual(Object.keys(f.built.unsigned_tx.inputs[0].extension), ['0', '1', '2', '3', '4', '5', '6', '8'], 'sorted by JSON.parse');
  const signed = await ergo.signRedemption(f.built, f.recipientSecret);
  assert.equal(signed.id, f.unsignedId);
  const sortedId = E.UnsignedTransaction.from_json(JSON.stringify(f.built.unsigned_tx)).id().to_str();
  assert.notEqual(sortedId, f.unsignedId, 'with the keys in sorted order it would be another transaction');
  const tx = E.Transaction.from_json(ergo.toErgoJson(signed));
  assert.equal(tx.id().to_str(), f.unsignedId);
  const ctx = ergo.stateContext(E, f.headers);
  assert.equal(E.verify_tx_input_proof(0, ctx, tx, f.spend, f.data), true, 'the agent\'s proof (input 0)');
  assert.equal(E.verify_tx_input_proof(1, ctx, tx, f.spend, f.data), true, 'the tracker\'s fee proof (input 1)');
  assert.equal(f.built.partial_tx.inputs[0].spendingProof.proofBytes, '', 'the given transaction is not changed');
  await assert.rejects(ergo.signRedemption({...f.built, partial_tx: {...f.built.partial_tx, inputs: f.built.partial_tx.inputs.slice(1)}}, f.recipientSecret), {code: 'bad_redemption'});
});
