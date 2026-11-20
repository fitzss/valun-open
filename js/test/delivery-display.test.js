// valun_deal shows a delivery whole up to the server's limit of 32768 bytes (fix inbox #187), as the Python client does
// (python/tests/test_delivery_display.py). 0.7.2 showed the first 16,000 characters and no tool returned the rest, so a
// payer's agent was asked to accept, and sign a note for, work it had seen half of.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DELIVERY_CUT, DELIVERY_MAX_BYTES, deliveryText} from '../src/agent.js';
import {scenario, world} from './agent-world.js';

const utf8 = s => Buffer.byteLength(s);

test('deliveryText: whole up to the server limit', () => {
  for (const content of ['x', 'x'.repeat(16001), 'x'.repeat(32000), 'x'.repeat(32768), 'é'.repeat(16384), '\u{1F600}'.repeat(8192)]) {
    assert.deepEqual(deliveryText(content), [content, true], String(utf8(content)));
  }
});

test('deliveryText: past the limit, cut between code points, and it says so', () => {
  assert.deepEqual(deliveryText('x'.repeat(32769)), ['x'.repeat(32768) + DELIVERY_CUT, false]);
  // 32760 bytes of x, ' ' (32761), U+1F600 (32765), ' ' (32766); the next U+1F600 would make 32770
  const [body, complete] = deliveryText('x'.repeat(32760) + ' \u{1F600}'.repeat(3));
  assert.equal(complete, false);
  assert.equal(body, 'x'.repeat(32760) + ' \u{1F600} ' + DELIVERY_CUT);
  assert.ok(utf8(body.slice(0, -DELIVERY_CUT.length)) <= DELIVERY_MAX_BYTES);
  assert.match(body, /Don't accept work you couldn't read in full/);
});

test('deliveryText: a lone surrogate counts three bytes, as the server counts it', () => {
  const content = 'x'.repeat(32765) + '\ud800';
  assert.equal(utf8(content), 32768);
  assert.deepEqual(deliveryText(content), [content, true]);
  assert.deepEqual(deliveryText(content + 'y'), [content + DELIVERY_CUT, false]);
});

test('valun_deal: a long delivery within the limit reaches the payer whole', async () => {
  const sc = scenario('deal: a long delivery within the server limit is shown whole (fix inbox #187)');
  const r = await world(sc).agent.call(sc.tool, sc.args);
  assert.equal(r.delivery.content_complete, true);
  assert.equal(utf8(r.delivery.content), r.delivery.bytes);
  assert.doesNotMatch(r.delivery.content, /truncated|cut here/);
});

test('valun_deal: a delivery past the limit is cut and says so', async () => {
  const sc = scenario('deal: a delivery past the server limit is cut between code points, and says so (fix inbox #187)');
  const r = await world(sc).agent.call(sc.tool, sc.args);
  assert.equal(r.delivery.content_complete, false);
  assert.ok(r.delivery.content.endsWith(DELIVERY_CUT));
  assert.ok(r.delivery.bytes > DELIVERY_MAX_BYTES);
});
