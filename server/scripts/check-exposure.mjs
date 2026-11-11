// What does the public surface give away? Fetches every readable route and checks that:
//  - no response contains a secret key (compared against the keys directory, when it is readable),
//  - no JSON field is named like a secret,
//  - Basis tracker routes are not reachable through Valun (no passthrough),
//  - changes are refused without the write token (when one is required).
// Usage: node scripts/check-exposure.mjs BASE_URL [--keys-dir DIR] [--mcp]
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), base = args[0].replace(/\/$/, '');
const keysDir = args.includes('--keys-dir') ? args[args.indexOf('--keys-dir') + 1] : null;
const results = [];
const check = (name, ok, detail = '') => { results.push({name, ok, detail}); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`); };

const secrets = keysDir ? fs.readdirSync(keysDir).filter(f => f.endsWith('.key')).map(f => fs.readFileSync(path.join(keysDir, f), 'utf8').trim()) : [];
const bodies = [];
const fetchText = async (p, init) => { const r = await fetch(base + p, init); const t = await r.text(); bodies.push({p, t}); return {status: r.status, text: t}; };

const status = JSON.parse((await fetchText('/api/status')).text);
const offers = JSON.parse((await fetchText('/api/offers')).text);
for (const p of ['/api/participants', '/api/ledger', '/api/audit', '/api/testnet', '/', '/app.js']) await fetchText(p);
for (const o of offers) await fetchText(`/api/offers/${o.id}`);
if (args.includes('--mcp')) {
  const call = (method, params) => fetchText('/mcp', {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  await call('tools/list', {});
  for (const name of ['valun_status', 'list_participants', 'list_offers', 'get_ledger']) await call('tools/call', {name, arguments: {}});
}

check(`responses read: ${bodies.length}`, bodies.length > 8);
if (keysDir) {
  const leaked = secrets.filter(s => bodies.some(b => b.t.includes(s)));
  check(`no secret key appears in any response (${secrets.length} keys compared)`, secrets.length > 0 && leaked.length === 0, leaked.length ? `${leaked.length} leaked` : '');
} else check('secret keys compared', true, 'keys directory not given; only field-name check below');
const badField = bodies.find(b => /"(secret|secret_hex|private_?key|seed|mnemonic|password)"\s*:/i.test(b.t));
check('no secret-like JSON field names', !badField, badField?.p ?? '');

for (const p of ['/notes', '/tracker/state', '/acceptance/policy', '/events', '/redemption/prepare', '/tracker/signature', '/api/../notes', '/key-status/00']) {
  const r = await fetch(base + p, {method: p.includes('signature') || p.includes('prepare') ? 'POST' : 'GET'});
  const t = await r.text();
  check(`tracker route not reachable: ${p}`, r.status === 404 && !/Basis Tracker|success/.test(t), `HTTP ${r.status}`);
}
if (status.writeTokenRequired) {
  const r = await fetch(base + '/api/participants', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"NoToken"}'});
  check('changes refused without the write token', r.status === 401, `HTTP ${r.status}`);
  const r2 = await fetch(base + '/api/participants', {method: 'POST', headers: {'content-type': 'application/json', 'x-valun-token': 'wrong-token-value'}, body: '{"name":"BadToken"}'});
  check('changes refused with a wrong token', r2.status === 401, `HTTP ${r2.status}`);
} else check('write token', true, 'not required on this deployment');
const failed = results.filter(r => !r.ok).length;
console.log(failed ? `${failed} check(s) FAILED` : 'all exposure checks passed');
process.exit(failed ? 1 : 0);
