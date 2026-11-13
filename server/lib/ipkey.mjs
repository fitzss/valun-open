// The key a per-address limit counts a client under (fix inbox #21). IPv4 (also IPv4-mapped IPv6, ::ffff:a.b.c.d) as it
// is; IPv6 by its first `bits` bits (64 or 48), as '<hextets>::/<bits>', since one host or customer is given a whole
// /64 (often a /48) and can leave from a new address on every connection. Brackets and a zone (%eth0) are dropped. A key
// already cut ('2a09:bac1:76c1:5260::/64') can be cut again, shorter. Anything unreadable is returned as it is.
export function ipKey(addr, bits = 64) {
  let a = String(addr ?? '?').trim();
  if (a.startsWith('[')) a = a.slice(1, a.includes(']') ? a.indexOf(']') : undefined);
  a = a.split('%')[0];
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (v4) return v4[1];
  if (!a.includes(':')) return a;
  if (a.includes('/')) a = a.slice(0, a.indexOf('/'));
  let tail = [];
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);          // an embedded IPv4 in the last 32 bits (NAT64)
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    if (o.some(x => x > 255)) return a;
    tail = [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    a = a.slice(0, -dotted[1].length).replace(/:$/, a.endsWith('::' + dotted[1]) ? ':' : '');
  }
  const halves = a.split('::');
  if (halves.length > 2) return String(addr);
  const head = halves[0] ? halves[0].split(':') : [], rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const given = [...head, ...rest, ...tail];
  if (given.some(h => !/^[0-9a-f]{1,4}$/i.test(h)) || given.length > 8 || (halves.length === 1 && given.length !== 8)) return String(addr);
  const h = [...head, ...Array(8 - given.length).fill('0'), ...rest, ...tail].map(x => parseInt(x, 16).toString(16));
  const n = Math.max(1, Math.min(8, Math.ceil(bits / 16)));
  return `${h.slice(0, n).join(':')}::/${n * 16}`;
}
