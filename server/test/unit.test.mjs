import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical, sha256, ergToNano, UserError} from '../lib/valun.mjs';
import {createTestnetReader, RECORDED} from '../lib/testnet.mjs';
import {makeSignerRunner, ordinaryTimestamp, capabilitiesFrom, describeCapabilities, Basis, BasisError} from '../lib/basis.mjs';

test('signer runner survives a child that exits without reading stdin (hosted EPIPE crash)', async () => {
  // The child prints its answer and exits at once; 4 MB of stdin cannot fit the pipe, so the write hits EPIPE.
  const run = makeSignerRunner({mode: 'direct', signerPath: process.execPath});
  const out = await run(['-e', 'process.stdout.write(JSON.stringify({ok: 1})); process.exit(0)'], 'x'.repeat(4 << 20));
  assert.deepEqual(out, {ok: 1});
  // Commands without a secret open no stdin at all.
  assert.deepEqual(await run(['-e', 'process.stdout.write(JSON.stringify({ok: 2}))']), {ok: 2});
});

test('ergToNano is exact and strict', () => {
  assert.equal(ergToNano('1.5'), '1500000000');
  assert.equal(ergToNano('0.000000001'), '1');
  assert.equal(ergToNano('2'), '2000000000');
  for (const bad of ['', '-1', '1e3', '0.0000000001', 'abc', '1.2.3', null]) assert.throws(() => ergToNano(bad), UserError);
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonical({b: 1, a: {d: [1, {y: 2, x: 1}], c: null}}), canonical({a: {c: null, d: [1, {x: 1, y: 2}]}, b: 1}));
  assert.notEqual(sha256(canonical({a: 1})), sha256(canonical({a: 2})));
});

test('testnet reader compares every recorded box and reports mismatches', async () => {
  const boxes = Object.fromEntries(RECORDED.boxes.map(b => [b.box, {boxId: b.box, value: b.value, spentTransactionId: b.spentBy, mainChain: true, assets: b.token ? [{tokenId: b.token}] : []}]));
  boxes[RECORDED.boxes[1].box].value -= 1; // continuing reserve changed
  const fake = async url => {
    const p = url.split('/api/v1')[1];
    const body = p === '/networkState' ? {height: 999} : p.startsWith('/boxes/') ? boxes[p.slice(7)] : {id: 'tx', inclusionHeight: 1, numConfirmations: 9, inputs: [], dataInputs: [], outputs: []};
    return {ok: true, json: async () => body};
  };
  const live = await createTestnetReader({fetchImpl: fake})();
  assert.equal(live.allMatch, false);
  assert.deepEqual(live.boxes.filter(b => !b.ok).map(b => b.box), [RECORDED.boxes[1].box]);
  assert.equal(live.boxes[1].checks.value, false);
});

// ---------- Basis driver: tracker v3 support (no tracker needed: a fake fetch and a fake signer) ----------
const NFT = 'ab'.repeat(32), TOKEN = 'token:' + 'cd'.repeat(32);
const V3_CAPS = {tracker: 'basis', build: 'valun-circulating-credit/3', commit: '08f889931906beff6c2b69346965f400d740aa4a', pure_credit: true,
  reserved_ms: [995, 996, 997, 998, 999], bound_notes: {ms: 997, version: 1}, bound_only_edges: true,
  novation: {max_age_ms: 3600000, transfer: {ms: 999, version: 3, signatures: ['issuer_from', 'issuer_to', 'from_recipient_prior', 'from_recipient', 'from_recipient_to', 'to_recipient_prior', 'to_recipient']},
    setoff: {ms: 998, version: 3, max_edges: 64, per_edge_timestamps: true, signatures_per_edge: ['issuer', 'recipient']}},
  onchain_edges: 0, novations_disabled_reason: null};
const unreachable = () => { throw new TypeError('fetch failed', {cause: {code: 'ECONNREFUSED'}}); };
// A fake tracker: answer(method, path, body) gives [status, body] (an object is sent as JSON, a string as text) or throws
// (an unreachable tracker). Every request is recorded.
function driver(answer, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({method: init.method, path: u.pathname, query: u.search, body});
    const [status, out] = await answer(init.method, u.pathname, body);
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), {status});
  };
  const runSigner = async args => args[0] === 'note-message' ? {message_hex: `msg:${args.slice(1).join('|')}`, debt_key_hex: 'dk'} : {signature_hex: `sig(${args[2]})`};
  return {calls, basis: new Basis({trackerUrl: 'http://tracker.test/', trackerNftId: NFT, runSigner, fetchImpl, ...opts})};
}

test('ordinaryTimestamp: residues 995-999 move to the next whole second; 990-994 and 0-5 are unchanged', () => {
  const base = 1_762_592_400_000;                 // a whole second
  for (const r of [990, 991, 992, 993, 994]) assert.equal(ordinaryTimestamp(base + r), base + r, `residue ${r}`);
  for (const r of [995, 996, 997, 998, 999]) assert.equal(ordinaryTimestamp(base + r), base + 1000, `residue ${r}`);
  for (const r of [0, 1, 2, 3, 4, 5]) assert.equal(ordinaryTimestamp(base + r), base + r, `residue ${r}`);
  for (let r = 0; r < 1000; r++) {                // every residue: never a reserved one, never earlier, at most 5 ms later
    const t = base + 7000 + r, o = ordinaryTimestamp(t);
    assert.ok(o % 1000 < 995 && o >= t && o - t <= 5, `residue ${r} gave ${o % 1000}`);
  }
  assert.equal(ordinaryTimestamp(995), 1000);
  assert.equal(ordinaryTimestamp(0), 0);
  for (const bad of [NaN, 1.5, -1, '1995', null, undefined, 2 ** 53]) assert.throws(() => ordinaryTimestamp(bad), TypeError, String(bad));
});

test('capabilitiesFrom: the data of a 200 answer with success and a data object, else null', () => {
  assert.deepEqual(capabilitiesFrom(200, {success: true, data: V3_CAPS}), V3_CAPS);
  for (const [status, json] of [[404, null], [404, {success: true, data: V3_CAPS}], [500, {success: true, data: V3_CAPS}], [200, null], [200, {success: false, data: V3_CAPS}],
    [200, {success: 'true', data: V3_CAPS}], [200, {success: true}], [200, {success: true, data: 'x'}], [200, {success: true, data: []}]])
    assert.equal(capabilitiesFrom(status, json), null, JSON.stringify([status, json]));
});

test('Basis.capabilities: GET /capabilities, read once per instance; refresh() reads again; null for 404 and every other answer', async () => {
  let answer = [200, {success: true, data: V3_CAPS}];
  const {basis, calls} = driver(async () => answer);
  assert.deepEqual(await basis.capabilities(), V3_CAPS);
  assert.deepEqual(await basis.capabilities(), V3_CAPS);
  assert.deepEqual(calls, [{method: 'GET', path: '/capabilities', query: '', body: undefined}], 'one read, kept');
  answer = [404, 'Not Found'];
  assert.deepEqual(await basis.capabilities(), V3_CAPS, 'still the kept answer');
  assert.equal(await basis.refresh(), null, 'refresh() reads again: 404, a tracker before v3');
  assert.equal(await basis.capabilities(), null);
  assert.equal(calls.length, 2);
  for (const a of [[500, {success: false, error: 'x'}], [200, {success: false, data: V3_CAPS}], [200, {success: true, data: null}], [200, 'not json'], [403, {success: true, data: V3_CAPS}]]) {
    answer = a;
    assert.equal(await basis.refresh(), null, JSON.stringify(a));
  }
});

test('Basis.capabilities: an unreachable tracker throws BasisError, and the failed read is not kept', async () => {
  let up = false;
  const {basis, calls} = driver(async () => up ? [200, {success: true, data: V3_CAPS}] : unreachable());
  await assert.rejects(basis.capabilities(), e => e instanceof BasisError && e.code === 'tracker_unavailable' && /ECONNREFUSED/.test(e.message));
  up = true;
  assert.deepEqual(await basis.capabilities(), V3_CAPS);
  assert.equal(calls.length, 2);
});

test('Basis.transfer and Basis.setoff: POST the body as given; the answer as {status, success, code, error, data}; BasisError only when unreachable', async () => {
  const {basis, calls} = driver(async (m, p, b) => {
    if (b.case === 'ok') return [200, {success: true, data: {transferred: true}, error: null}];
    if (b.case === 'stale') return [409, {success: false, data: null, error: 'the prior total is stale', code: 'stale_prior'}];
    if (b.case === 'text') return [422, 'Failed to deserialize the JSON body into the target type: unknown field `case`'];
    return [404, ''];
  });
  assert.deepEqual(await basis.transfer({case: 'ok', amount: 3}), {status: 200, success: true, code: null, error: null, data: {transferred: true}});
  assert.deepEqual(calls.at(-1), {method: 'POST', path: '/notes/transfer', query: '', body: {case: 'ok', amount: 3}});
  assert.deepEqual(await basis.setoff({case: 'stale'}), {status: 409, success: false, code: 'stale_prior', error: 'the prior total is stale', data: null});
  assert.deepEqual(calls.at(-1), {method: 'POST', path: '/notes/setoff', query: '', body: {case: 'stale'}});
  assert.deepEqual(await basis.transfer({case: 'text'}), {status: 422, success: false, code: null, error: 'Failed to deserialize the JSON body into the target type: unknown field `case`', data: null});
  assert.deepEqual(await basis.setoff({case: 'old tracker'}), {status: 404, success: false, code: null, error: null, data: null});
  const down = driver(async () => unreachable()).basis;
  await assert.rejects(down.transfer({}), BasisError);
  await assert.rejects(down.setoff({}), BasisError);
});

test('Basis.proof passes the denomination', async () => {
  const {basis, calls} = driver(async () => [200, {success: true, data: {key: 'k'}}], {denomination: TOKEN});
  assert.deepEqual(await basis.proof('02aa', '03bb'), {key: 'k'});
  assert.equal(calls[0].path, '/tracker/proof');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].query)), {issuer_pubkey: '02aa', recipient_pubkey: '03bb', denomination: TOKEN});
});

test('Basis.issueNote: ordinary timestamps (explicit or default) are clamped; a bound note sends its prior acknowledgment and its timestamp as given', async () => {
  const {basis, calls} = driver(async () => [201, {success: true, data: null, error: null}]);
  const base = 1_762_592_400_000, note = {issuer: '02aa', recipient: '03bb', total: 5, secretHex: 'not-a-secret'};
  const FIELDS = ['issuer_pubkey', 'recipient_pubkey', 'amount', 'timestamp', 'signature', 'tracker_nft_id', 'denomination'];
  let r = await basis.issueNote({...note, timestamp: base + 997});
  assert.equal(r.request.timestamp, base + 1000, 'residue 997 without a prior acknowledgment is an ordinary note: clamped');
  assert.equal(r.message_hex, `msg:02aa|03bb|5|${base + 1000}|${NFT}|erg`, 'the signed message has the clamped timestamp');
  assert.deepEqual(Object.keys(calls.at(-1).body), FIELDS, 'exactly the fields it always had');
  assert.equal(calls.at(-1).body.timestamp, base + 1000);
  r = await basis.issueNote({...note, timestamp: base + 994});
  assert.equal(r.request.timestamp, base + 994);
  const before = Date.now();
  r = await basis.issueNote(note);
  assert.ok(r.request.timestamp % 1000 < 995 && r.request.timestamp >= before && r.request.timestamp <= Date.now() + 5, 'the default (now) is clamped too');
  r = await basis.issueNote({...note, timestamp: base + 997, priorSignature: 'ack-signature', priorTotal: 4});
  assert.deepEqual(calls.at(-1).body, {issuer_pubkey: '02aa', recipient_pubkey: '03bb', amount: 5, timestamp: base + 997, signature: `sig(msg:02aa|03bb|5|${base + 997}|${NFT}|erg)`,
    tracker_nft_id: NFT, denomination: 'erg', prior_signature: 'ack-signature', prior_total: 4});
  assert.deepEqual(r.response, {status: 201, success: true, error: null});
  await assert.rejects(basis.issueNote({...note, priorSignature: 'ack-signature'}), TypeError, 'a bound note needs the timestamp its acknowledgment covers');
  assert.equal(calls.length, 4, 'nothing was sent for the refused call');
});

test('describeCapabilities: one line for the server log', () => {
  assert.equal(describeCapabilities(V3_CAPS), 'basis valun-circulating-credit/3, commit 08f889931906, pure_credit true, reserved_ms 995,996,997,998,999, bound notes at 997 ms v1, ' +
    'transfer at 999 ms v3, set-off at 998 ms v3, max age 3600000 ms, on-chain edges 0, novations enabled');
  assert.match(describeCapabilities(null), /^none \(/);
  const odd = describeCapabilities({...V3_CAPS, build: 'x\ny', novations_disabled_reason: 'rebuild failed\r\nagain'});
  assert.ok(!/[\r\n]/.test(odd) && odd.includes('x?y') && odd.endsWith('novations disabled (rebuild failed??again)'), odd);
  assert.doesNotThrow(() => describeCapabilities({}));
});
