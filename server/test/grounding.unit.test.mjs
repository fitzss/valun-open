// lib/pilot/grounding.mjs: the grounded value of IOUs (fix inbox #20, ADVERSARIAL-FINDINGS F3), attacked. Value enters only
// at a reserve or a trusted issuer; the least fixed point leaves chains and rings of unbacked IOUs at 0.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grounded} from '../lib/pilot/grounding.mjs';

const M = 1_000_000;
const row = (issuer, recipient, outstanding, extra = {}) => ({issuer, recipient, outstanding, ...extra});

test('a wash trade with a fresh sybil adds nothing: its IOU has nothing behind it (Basis #20 step 3)', () => {
  const g = grounded({rows: [row('s2a', 'n2', M)]});
  assert.equal(g.ratio('s2a'), 0);
  assert.deepEqual([g.claimsFace('n2'), g.claimsValue('n2')], [M, 0]);
});

test('chains of sybils of any depth stay at 0 (a one-level haircut falls to a chain of two)', () => {
  for (let depth = 1; depth <= 8; depth++) {
    const rows = [];
    for (let i = depth; i > 1; i--) rows.push(row(`s${i}`, `s${i - 1}`, M));
    rows.push(row('s1', 'x', M));
    const g = grounded({rows});
    assert.equal(g.claimsValue('x'), 0, `depth ${depth}`);
  }
  // What a one-level haircut would count for x with a chain of two: s1 holds as much as it owes, so it looks covered.
  const two = [row('s2', 's1', M), row('s1', 'x', M)];
  const oneLevel = Math.min(1, M / M) * M;
  assert.equal(oneLevel, M, 'one level: fooled');
  assert.equal(grounded({rows: two}).claimsValue('x'), 0, 'least fixed point: not fooled');
});

test('a ring of sybils that pay each other is worth nothing, also to an outsider it pays', () => {
  const rows = [row('s1', 's2', M), row('s2', 's3', M), row('s3', 's1', M), row('s1', 'x', M)];
  const g = grounded({rows});
  for (const s of ['s1', 's2', 's3']) assert.equal(g.ratio(s), 0, s);
  assert.equal(g.claimsValue('x'), 0);
  // A ring with a tiny reserve on one member, feeding an outsider: the outsider gets about that reserve, not the ring.
  const tiny = grounded({rows, reserves: new Map([['s1', 10]])});
  assert.ok(tiny.claimsValue('x') <= 10, `got ${tiny.claimsValue('x')}`);
});

test('a reserve grounds its issuer\'s IOUs pro rata; trust grounds them in full', () => {
  const g = grounded({rows: [row('r', 'x', 100), row('t', 'x', 10)], reserves: new Map([['r', 50]]), trusted: new Set(['t'])});
  assert.deepEqual([g.ratio('r'), g.ratio('t'), g.claimsValue('x')], [0.5, 1, 60]);
});

test('honest credit circulates: a claim on an agent that holds grounded claims is worth what they cover', () => {
  // h has a reserve of 100 and owes a 100; a owes b 50 and holds h's 100: a can pay b in full.
  const g = grounded({rows: [row('h', 'a', 100), row('a', 'b', 50)], reserves: new Map([['h', 100]])});
  assert.deepEqual([g.ratio('h'), g.ratio('a'), g.claimsValue('b')], [1, 1, 50]);
  // If a also owes c 150, its 100 of grounded assets cover half of what it owes: b's claim is worth 25.
  const g2 = grounded({rows: [row('h', 'a', 100), row('a', 'b', 50), row('a', 'c', 150)], reserves: new Map([['h', 100]])});
  assert.deepEqual([g2.ratio('a'), g2.claimsValue('b'), g2.claimsValue('c')], [0.5, 25, 75]);
});

test('a ring with real value behind it clears (it nets out), as in a payment network', () => {
  const g = grounded({rows: [row('a', 'b', 10), row('b', 'c', 10), row('c', 'a', 10)], reserves: new Map([['a', 5]])});
  for (const x of ['a', 'b', 'c']) assert.ok(g.ratio(x) > 0.999, `${x} ${g.ratio(x)}`);
});

test('a sybil backer is worth nothing; a backer\'s open caps count against what it can pay (Basis #20 step 5)', () => {
  // s2b holds a wash-traded claim on s2c and offers a cap of 1M: worthless.
  const g = grounded({rows: [row('s2c', 's2b', M)], extraOwes: new Map([['s2b', M]])});
  assert.equal(g.ratio('s2b'), 0);
  // A real backer: holds h's grounded 3M and has an open cap of 1M besides a debt of 1M: it can pay all of it.
  const h = grounded({rows: [row('h', 'bob', 3 * M), row('bob', 'z', M)], reserves: new Map([['h', 3 * M]]), extraOwes: new Map([['bob', M]])});
  assert.equal(h.ratio('bob'), 1);
});

test('claims on edges that do not reconcile count for no one, but still as the issuer\'s debt', () => {
  const g = grounded({rows: [row('t', 'x', 10, {claim: false}), row('x', 'y', 5)], trusted: new Set(['t'])});
  assert.deepEqual([g.claimsFace('x'), g.claimsValue('x'), g.ratio('x')], [0, 0, 0]);
  assert.equal(g.owes('t'), 10);
});

test('degenerate input: self-edges, zero and negative amounts, missing ids are skipped', () => {
  const g = grounded({rows: [row('a', 'a', 5), row('a', 'b', 0), row('a', 'b', -3), {issuer: null, recipient: 'b', outstanding: 2}, null]});
  assert.deepEqual([g.owes('a'), g.claimsFace('b'), g.ratio('zzz')], [0, 0, 0]);
});
