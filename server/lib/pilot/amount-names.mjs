// Fix inbox #32: the public record's amounts under unit-neutral names. The network's unit is named once, in `unit`
// (nanoERG on the testnet), so an amount's name need not carry it, and an agent reading `owed_ever_PC: 2500000` on the
// testnet should not report "2,500,000 PC". Every key `<name>_PC` gets `<name>` just before it, and the `PC` of a
// {count, PC} tally gets `amount`, with the same value.
//
// The `_PC` and `PC` names stay, as deprecated aliases with the same values (docs/PILOT-API.md "Amount names"). A later
// release removes them, announced in the fix inbox and the changelog first. A name that is already present is never
// overwritten, and values that are not plain objects or arrays pass through unchanged.
const SUFFIX = '_PC';

const neutralName = k => (k === 'PC' ? 'amount' : k.length > SUFFIX.length && k.endsWith(SUFFIX) ? k.slice(0, -SUFFIX.length) : null);
const plain = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));

export function withUnitNeutralNames(v) {
  if (Array.isArray(v)) return v.map(withUnitNeutralNames);
  if (!plain(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const y = withUnitNeutralNames(x), n = neutralName(k);
    if (n && !Object.hasOwn(v, n) && !Object.hasOwn(out, n)) out[n] = y;
    out[k] = y;
  }
  return out;
}
