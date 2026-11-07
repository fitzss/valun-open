// canonical.json: canonical JSON and terms_hash for every vector. The JS canonical() is the server's own algorithm
// (ECMAScript JSON.parse / JSON.stringify per leaf / default sort), so every tier is expected to agree byte for byte,
// including the informative ones (refused, wire, generic) on which the Python client differs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bytesToHex, canonical, termsHash, utf8} from '../src/index.js';
import {vec} from './helpers.js';

const data = vec('canonical.json');

test('canonical.json has the tiers this suite knows', () => {
  for (const v of data.vectors) assert.ok(['terms', 'refused', 'wire', 'generic'].includes(v.tier), `${v.name}: tier ${v.tier}`);
  assert.ok(data.vectors.length > 0);
});

for (const tier of ['terms', 'refused', 'wire', 'generic']) {
  test(`canonical.json tier "${tier}": canonical text, its UTF-8 bytes and terms_hash equal the server's`, () => {
    for (const v of data.vectors.filter(x => x.tier === tier)) {
      const obj = JSON.parse(v.input_json);
      const c = canonical(obj);
      assert.equal(c, v.canonical, v.name);
      assert.equal(bytesToHex(utf8(c)), v.canonical_utf8_hex, `${v.name} bytes`);
      assert.equal(termsHash(obj), v.terms_hash, `${v.name} hash`);
    }
  });
}

test('canonical.json: what each tier says about the server holds (terms/wire accepted, refused refused with 400)', () => {
  for (const v of data.vectors) {
    if (v.tier === 'terms' || v.tier === 'wire') assert.equal(v.server_validation, 'accepted', v.name);
    if (v.tier === 'refused') {
      assert.equal(typeof v.server_validation, 'object', v.name);
      assert.equal(v.server_validation.status, 400, v.name);
    }
    if (v.tier === 'wire') assert.notEqual(v.input_json, v.canonical, `${v.name}: input is not already canonical`);
  }
});

test('canonical(): no whitespace, keys sorted by UTF-16 code units, arrays keep order', () => {
  assert.equal(canonical({b: 1, a: [3, 1, {d: null, c: true}], '': false}), '{"":false,"a":[3,1,{"c":true,"d":null}],"b":1}');
  assert.equal(canonical({'\u{FF01}': 1, '\u{1F600}': 2}), '{"\u{1F600}":2,"\u{FF01}":1}');
  assert.equal(canonical({z: -0}), '{"z":0}');
  assert.equal(canonical('a\u{2028}b'), JSON.stringify('a\u{2028}b'));
  assert.equal(canonical('a\u{2028}b').length, 5, 'U+2028 is not escaped');
});

test('canonical() refuses values JSON cannot carry instead of guessing', () => {
  for (const bad of [undefined, () => 1, 1n, NaN, Infinity, new Date(0), {a: undefined}, [undefined], new Map(), Symbol('x')]) {
    assert.throws(() => canonical(bad), e => e.code === 'bad_terms');
  }
  assert.equal(canonical(Object.assign(Object.create(null), {b: 2, a: 1})), '{"a":1,"b":2}');
});
