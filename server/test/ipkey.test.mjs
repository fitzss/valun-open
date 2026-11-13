// Fix inbox #21: per-address limits key an IPv6 client by its prefix (lib/ipkey.mjs), so one host that leaves from a
// new address on every connection still counts as one; IPv4 is unchanged.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ipKey} from '../lib/ipkey.mjs';

test('IPv4 and IPv4-mapped IPv6 are kept as they are', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::FFFF:203.0.113.7', 48), '203.0.113.7');
  assert.equal(ipKey('?'), '?');
  assert.equal(ipKey(undefined), '?');
});

test('the addresses Basis joined from share their /64 and /48 keys (the live repro, #21)', () => {
  // Two addresses from one box, in the same /48 2a09:bac1:76c1::/48 as the repro's first one.
  const a = '2a09:bac1:76c1:5260::160:11a', b = '2a09:bac1:76c1:5260:9:8:7:6', c = '2a09:bac1:76c1:77::1';
  assert.equal(ipKey(a), '2a09:bac1:76c1:5260::/64');
  assert.equal(ipKey(a), ipKey(b), 'one /64');
  assert.notEqual(ipKey(a), ipKey(c), 'another /64');
  assert.equal(ipKey(a, 48), ipKey(c, 48), 'one /48');
  assert.equal(ipKey(a, 48), '2a09:bac1:76c1::/48');
  // The repro's second prefix is another /48.
  assert.notEqual(ipKey('2a09:bac5:8db6:188c::272:126', 48), ipKey(a, 48));
});

test('every spelling of one address gives one key: zeros, case, brackets, a zone, an embedded IPv4, a key cut again', () => {
  const k = '2001:db8:0:1::/64';
  for (const s of ['2001:db8:0:1::1', '2001:0db8:0000:0001:0000:0000:0000:0001', '2001:DB8:0:1::1', '[2001:db8:0:1::1]', '2001:db8:0:1::1%eth0',
    '2001:db8:0:1:0:0:192.0.2.1', '2001:db8:0:1::192.0.2.1']) assert.equal(ipKey(s), k, s);
  assert.equal(ipKey(k, 48), '2001:db8:0::/48');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1%en0', 48), 'fe80:0:0::/48');
});

test('what is not an address is returned as it is (never throws)', () => {
  for (const s of ['1:2:3', 'zz::1', '1::2::3', '1:2:3:4:5:6:7:8:9', 'not-an-ip', '2001:db8::1.2.3.999']) assert.equal(typeof ipKey(s), 'string', s);
  assert.equal(ipKey('1::2::3'), '1::2::3');
  assert.equal(ipKey('zz::1'), 'zz::1');
});
