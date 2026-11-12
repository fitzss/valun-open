// Ergo transaction JSON exactly as the Basis tracker (tracker v4) and the Ergo node expect it.
//
// An input's context extension is a Scala Map[Byte, Constant]: the node serializes it (and so the bytes every input
// proof signs, and the transaction id) in the iteration order of Scala's immutable HashMap, not in key order. The
// tracker therefore emits the reserve input's extension in that order (basis_offchain::ergo_tx::
// scala_context_extension_order, checked on chain for {0,1,2,3,4,5,6,8}: 0,5,1,6,2,3,8,4), and it binds
// POST /redemption/submit to the exact JSON of the unsigned transaction it built (SHA-256 of its bytes).
//
// JavaScript cannot keep that order: JSON.parse puts integer-like keys ("0".."8") first, in ascending order, and
// JSON.stringify writes them so. Every transaction this server relays is therefore written with toErgoJson, which
// writes each `extension` object in Scala's order and everything else as JSON.stringify does (the other keys keep the
// order they arrived in). Then the redemption a client is given, and the transaction it sends back, are byte for byte
// the tracker's.

// Scala 2.12 HashMap's hash mixing (`improve`) of Byte.hashCode (the byte widened to Int), as unsigned 32-bit.
function improve(h) {
  h = (h + ~(h << 9)) >>> 0;
  h = (h ^ (h >>> 14)) >>> 0;
  h = (h + (h << 4)) >>> 0;
  return (h ^ (h >>> 10)) >>> 0;
}

// The iteration order of a Scala immutable HashMap (HashTrieMap) with these byte keys: grouped by the 5-bit trie index
// at each level in ascending order, colliding keys one level deeper, and at the last level (a HashMapCollision1) in the
// given order. The same model as the tracker's scala_context_extension_order.
export function scalaExtensionOrder(keys) {
  const out = [];
  const build = (level, ks) => {
    const groups = new Map();
    for (const k of ks) {
      const idx = (improve(k) >>> level) & 0x1f;
      if (!groups.has(idx)) groups.set(idx, []);
      groups.get(idx).push(k);
    }
    for (const idx of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(idx);
      if (g.length === 1) out.push(g[0]);
      else if (level >= 30) out.push(...g);
      else build(level + 5, g);
    }
  };
  build(0, keys);
  return out;
}

const BYTE_KEY = /^(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// JSON text of `value` with every `extension` object (all of whose keys are byte values 0-255) in Scala's order.
// Otherwise as JSON.stringify: compact, keys in their own order, undefined members left out.
export function toErgoJson(value) {
  const write = (v, key) => {
    if (v === undefined || typeof v === 'function') return undefined;
    if (v !== null && typeof v.toJSON === 'function') v = v.toJSON();
    if (!isPlain(v) && !Array.isArray(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(x => write(x) ?? 'null').join(',')}]`;
    let keys = Object.keys(v);
    if (key === 'extension' && keys.length && keys.every(k => BYTE_KEY.test(k)))
      keys = scalaExtensionOrder(keys.map(Number)).map(String);
    const parts = [];
    for (const k of keys) {
      const s = write(v[k], k);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  };
  return write(value, undefined);
}
