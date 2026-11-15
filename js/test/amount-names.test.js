// Fix inbox #35 (the clients' half of #32), the JavaScript twin of python/tests/test_amount_names.py: every tool's answer
// gives each amount a unit-neutral name next to its deprecated `_PC` alias, with the same value, by the rule the server's
// public answers follow (valun-app lib/pilot/amount-names.mjs): `<name>_PC` gets `<name>` just before it, the `PC` of a
// {count, PC} tally gets `amount`, a name already present is never overwritten. ValunAgent.call() applies it to every
// result. Every result the parity fixtures recorded from Python is checked here for it (agent-parity.test.js compares
// the JavaScript results with them value for value).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {withUnitNeutralNames as N} from '../src/index.js';
import {FIX} from './agent-world.js';

const same = (got, want) => assert.equal(JSON.stringify(got), JSON.stringify(want));

test('every <name>_PC gets <name> just before it, and a tally\'s PC gets amount, with the same value', () => {
  const repayment = {owed_ever_PC: 6, settled: {by_setoff_PC: 4, by_redemption_PC: 1, creditors: 2}, outstanding_PC: 1,
    unpaid_accepted_work: {count: 1, PC: 3}};
  const r = N(repayment);
  assert.deepEqual(Object.keys(r), ['owed_ever', 'owed_ever_PC', 'settled', 'outstanding', 'outstanding_PC', 'unpaid_accepted_work']);
  same(r.settled, {by_setoff: 4, by_setoff_PC: 4, by_redemption: 1, by_redemption_PC: 1, creditors: 2});
  same(r.unpaid_accepted_work, {count: 1, amount: 3, PC: 3});
  assert.deepEqual(repayment.settled, {by_setoff_PC: 4, by_redemption_PC: 1, creditors: 2}, 'the answer given is not changed');
});

test('arrays and nesting; a name already there is never overwritten; other values pass through; __proto__ is a key', () => {
  same(N({unit: 'nanoERG', loops: [{id: 'vs_1', amount_PC: 2000000, each_PC: null, cycles: [{length: 2, each_PC: 1000000}]}]}),
    {unit: 'nanoERG', loops: [{id: 'vs_1', amount: 2000000, amount_PC: 2000000, each: null, each_PC: null, cycles: [{length: 2, each: 1000000,
      each_PC: 1000000}]}]});
  same(N({cleared: 'kept', cleared_PC: 5}), {cleared: 'kept', cleared_PC: 5});
  same(N({cleared_PC: 5, cleared: 'kept'}), {cleared_PC: 5, cleared: 'kept'});
  same(N({amount: 9, PC: 5}), {amount: 9, PC: 5});
  same(N({_PC: 1, x_PCs: 2, PCx: 3, x_pc: 4}), {_PC: 1, x_PCs: 2, PCx: 3, x_pc: 4});
  for (const v of [null, 3, 'a_PC', true, 2.5]) assert.equal(N(v), v);
  const odd = N(JSON.parse('{"__proto___PC": {"polluted": true}, "__proto__": 1}'));
  assert.deepEqual(Object.keys(odd), ['__proto___PC', '__proto__'], 'own keys, the prototype untouched');
  const added = N(JSON.parse('{"__proto___PC": {"polluted": true}}'));
  assert.deepEqual(Object.keys(added), ['__proto__', '__proto___PC'], 'the name the rule adds is an own key too');
  for (const o of [odd, added]) assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.equal(added.polluted, undefined);
  assert.equal(({}).polluted, undefined);
});

test('every recorded tool result names each amount unit-neutrally, next to its _PC alias, with the same value', () => {
  let pairs = 0;
  const names = new Set();
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v === null || typeof v !== 'object') return;
    const keys = Object.keys(v);
    keys.forEach((k, i) => {
      const n = k === 'PC' ? 'amount' : k.length > 3 && k.endsWith('_PC') ? k.slice(0, -3) : null;
      if (n !== null) {
        assert.ok(Object.hasOwn(v, n), `${where}.${k} has ${n}`);
        if (keys[i - 1] === n) {                    // the name the rule added (an older one may stand elsewhere, kept)
          assert.deepEqual(v[n], v[k], `${where}.${n} = ${where}.${k}`);
          pairs++;
          names.add(n);
        }
      }
      walk(v[k], `${where}.${k}`);
    });
  };
  for (const sc of FIX.scenarios) if (!Object.hasOwn(sc.result, 'error')) walk(sc.result, sc.name);
  assert.ok(pairs > 200, `${pairs} names`);
  // the answers fix inbox #35 names: valun_status (brief and full), valun_deal, valun_directory, valun_review_delivery
  for (const n of ['you_hold', 'you_owe', 'net', 'cleared_so_far', 'amount', 'credit_notes_they_hold', 'credit_notes_they_owe',
    'tracker_cumulative_total', 'your_net_change']) assert.ok(names.has(n), n);
  const deal = FIX.scenarios.find(s => s.tool === 'valun_deal' && s.result.credit_note);
  assert.equal(deal.result.credit_note.amount, deal.result.credit_note.amount_PC);
  const brief = FIX.scenarios.find(s => s.tool === 'valun_status' && s.result.brief === true);
  assert.deepEqual([brief.result.you_hold, brief.result.you_owe], [brief.result.you_hold_PC, brief.result.you_owe_PC]);
});
