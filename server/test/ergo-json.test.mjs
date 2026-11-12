// lib/ergo-json.mjs: Ergo transaction JSON with each context extension in Scala's ContextExtension order (the order the
// node and the Basis tracker serialize it in), which JSON.parse/JSON.stringify would otherwise sort. The orders are the
// tracker's own test vectors (basis_offchain::ergo_tx, scala_context_extension_order_matches_known_sets); the first one
// was checked on chain against a node-signed redemption.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scalaExtensionOrder, toErgoJson} from '../lib/ergo-json.mjs';
import {Basis} from '../lib/basis.mjs';

const keysInText = (text, marker) => {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, marker);
  const body = text.slice(at + marker.length, text.indexOf('}', at + marker.length));
  return [...body.matchAll(/"(\d+)":/g)].map(m => Number(m[1]));
};
const EXT = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 8].map(k => [String(k), `0e0${k}`]));

test('the Scala HashMap order of the reserve input\'s context extension keys (the tracker\'s vectors)', () => {
  assert.deepEqual(scalaExtensionOrder([0, 1, 2, 3, 4, 5, 6, 8]), [0, 5, 1, 6, 2, 3, 8, 4], 'a first redemption (no #7)');
  assert.deepEqual(scalaExtensionOrder([0, 1, 2, 3, 4, 5, 6, 7, 8]), [0, 5, 1, 6, 2, 7, 3, 8, 4], 'a later redemption (#7 present)');
  assert.deepEqual(scalaExtensionOrder([8, 6, 5, 4, 3, 2, 1, 0]), [0, 5, 1, 6, 2, 3, 8, 4], 'independent of the given order');
  assert.deepEqual(scalaExtensionOrder([3]), [3]);
  assert.deepEqual(scalaExtensionOrder([]), []);
});

test('toErgoJson writes every extension (unsigned inputs and spending proofs) in Scala order and the rest as JSON.stringify', () => {
  const tx = JSON.parse(JSON.stringify({id: 'ab', inputs: [{boxId: 'r', extension: EXT}, {boxId: 'f', extension: {}}],
    dataInputs: [{boxId: 't'}], outputs: [{value: 5, ergoTree: '00', assets: [], additionalRegisters: {R4: '07', R5: '64'}, creationHeight: 7}]}));
  assert.deepEqual(Object.keys(tx.inputs[0].extension), ['0', '1', '2', '3', '4', '5', '6', '8'], 'JSON.parse sorts them');
  const text = toErgoJson(tx);
  assert.deepEqual(keysInText(text, '"extension":{'), [0, 5, 1, 6, 2, 3, 8, 4]);
  assert.deepEqual(JSON.parse(text), tx, 'the same value');
  assert.match(text, /^\{"id":"ab","inputs":\[\{"boxId":"r","extension":\{"0":"0e00","5":"0e05",/, 'compact, the other keys as they arrived');
  assert.ok(text.includes('"extension":{}'), 'an empty extension');
  assert.ok(text.includes('{"value":5,"ergoTree":"00","assets":[],"additionalRegisters":{"R4":"07","R5":"64"},"creationHeight":7}'));
  const signed = {id: 'ab', inputs: [{boxId: 'r', spendingProof: {proofBytes: 'cc', extension: {...EXT, 7: '0e07'}}}]};
  assert.deepEqual(keysInText(toErgoJson(signed), '"extension":{'), [0, 5, 1, 6, 2, 7, 3, 8, 4]);
  // Only an `extension` of byte keys is reordered; any other object keeps JSON.stringify's order.
  assert.equal(toErgoJson({extension: {a: 1, 0: 2}, other: {5: 'x', 0: 'y'}}), '{"extension":{"0":2,"a":1},"other":{"0":"y","5":"x"}}');
  assert.equal(toErgoJson({a: undefined, b: [undefined, 1], c: null, d: 'x"y'}), JSON.stringify({a: undefined, b: [undefined, 1], c: null, d: 'x"y'}));
});

test('the tracker client sends a redemption submit with its extensions in Scala order', async () => {
  let sent = null;
  const fetchImpl = async (url, opts) => { sent = {url, body: opts.body}; return new Response(JSON.stringify({success: true, data: {tx_id: 'ff'}}), {status: 200}); };
  const basis = new Basis({trackerUrl: 'http://tracker.test', trackerNftId: 'ab'.repeat(32), runSigner: null, fetchImpl});
  const unsigned = JSON.parse(JSON.stringify({inputs: [{boxId: 'r', extension: EXT}], dataInputs: [], outputs: []}));
  const out = await basis.redemptionSubmit({signed_tx: {inputs: [{boxId: 'r', spendingProof: {proofBytes: 'cc', extension: EXT}}]}, unsigned_tx: unsigned});
  assert.deepEqual(out, {tx_id: 'ff'});
  assert.equal(sent.url, 'http://tracker.test/redemption/submit');
  const signedAt = sent.body.indexOf('"signed_tx"'), unsignedAt = sent.body.indexOf('"unsigned_tx"');
  assert.deepEqual(keysInText(sent.body.slice(signedAt), '"extension":{'), [0, 5, 1, 6, 2, 3, 8, 4]);
  assert.deepEqual(keysInText(sent.body.slice(unsignedAt), '"extension":{'), [0, 5, 1, 6, 2, 3, 8, 4]);
});
