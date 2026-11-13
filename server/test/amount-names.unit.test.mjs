// Fix inbox #32: unit-neutral amount names next to the deprecated _PC names (lib/pilot/amount-names.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withUnitNeutralNames as N} from '../lib/pilot/amount-names.mjs';

test('every <name>_PC gets <name> just before it, and a tally\'s PC gets amount, with the same value', () => {
  const repayment = {owed_ever_PC: 6, settled: {by_setoff_PC: 4, by_redemption_PC: 1, creditors: 2}, outstanding_PC: 1,
    unpaid_accepted_work: {count: 1, PC: 3}};
  const r = N(repayment);
  assert.deepEqual(Object.keys(r), ['owed_ever', 'owed_ever_PC', 'settled', 'outstanding', 'outstanding_PC', 'unpaid_accepted_work']);
  assert.deepEqual(r.settled, {by_setoff: 4, by_setoff_PC: 4, by_redemption: 1, by_redemption_PC: 1, creditors: 2});
  assert.deepEqual(r.unpaid_accepted_work, {count: 1, amount: 3, PC: 3});
  assert.deepEqual(repayment.settled, {by_setoff_PC: 4, by_redemption_PC: 1, creditors: 2}, 'the input is not changed');
});

test('arrays and nesting; a name already there is never overwritten; other values pass through', () => {
  const loops = {unit: 'nanoERG', loops: [{id: 'vs_1', amount_PC: 2000000, each_PC: null, cycles: [{length: 2, each_PC: 1000000}]}]};
  assert.deepEqual(N(loops), {unit: 'nanoERG', loops: [{id: 'vs_1', amount: 2000000, amount_PC: 2000000, each: null, each_PC: null,
    cycles: [{length: 2, each: 1000000, each_PC: 1000000}]}]});
  assert.deepEqual(N({cleared: 'kept', cleared_PC: 5}), {cleared: 'kept', cleared_PC: 5}, 'an existing name wins');
  assert.deepEqual(N({amount: 9, PC: 5}), {amount: 9, PC: 5});
  assert.deepEqual(N({_PC: 1, x_PCs: 2, PCx: 3}), {_PC: 1, x_PCs: 2, PCx: 3}, 'only a <name>_PC suffix and the exact key PC');
  for (const v of [null, 3, 'a_PC', true]) assert.equal(N(v), v);
  const d = new Date(0);
  assert.equal(N({at: d}).at, d, 'a non-plain object passes through as it is');
});
