// Packaging of the agent tools: still zero dependencies and browser-safe (the DNS checker is a separate Node entry,
// "valun/dns", that the main entry never imports), every namespace member typed, and the README example runs as
// written against the offline fake server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as api from '../src/index.js';
import * as dns from '../src/dns.js';
import {scenario, world} from './agent-world.js';

const root = new URL('../', import.meta.url);
const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');

test('"valun/dns" is its own Node entry; the main entry never reaches it (nor node:dns)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.exports['./dns'], {types: './src/dns.d.ts', default: './src/dns.js'});
  const seen = new Set();
  const visit = rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const m of read(rel).matchAll(/(?:import|export)\s[^'";]*?from\s*['"]\.\/([^'"]+)['"]/g)) visit(`src/${m[1]}`);
  };
  visit('src/index.js');
  for (const f of ['src/agent.js', 'src/tools.js', 'src/measure.js', 'src/sandbox.js', 'src/schemas.js', 'src/py.js']) assert.ok(seen.has(f), f);
  assert.ok(!seen.has('src/dns.js'));
  assert.match(read('src/dns.js'), /from 'node:dns\/promises'/);
  assert.equal(typeof dns.resolveHost, 'function');
  assert.match(read('src/dns.d.ts'), /export function resolveHost\b/);
});

test('every member of the schemas, measure and sandbox namespaces is declared in the types', () => {
  const dts = read('src/index.d.ts');
  for (const ns of ['schemas', 'measure', 'sandbox']) {
    const block = dts.slice(dts.indexOf(`export namespace ${ns} {`));
    const body = block.slice(0, block.indexOf('\n}\n'));
    for (const name of Object.keys(api[ns])) assert.match(body, new RegExp(`(?:function|const) ${name}\\b`), `${ns}.${name}`);
  }
});

test('the README example (a plain tool-call loop) runs as written, offline', async () => {
  const readme = read('README.md');
  const code = /<!-- agent-loop-example -->\s*```js\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(code, 'README has the example');
  assert.ok(code.split('\n').length <= 20, 'short');
  // Run it with the offline agent in place of the FileStore one, against a fake model that asks for valun_status and
  // then answers. Only the import lines and the line that builds the agent are left out.
  const body = code.replace(/^import .*$/gm, '').replace(/^const agent = .*$/m, '');
  assert.equal(body.split('\n').filter(l => l.trim()).length, code.split('\n').filter(l => l.trim()).length - 4);
  const sc = scenario('status: full');
  const w = world(sc);
  const replies = [
    {choices: [{message: {role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'valun_status', arguments: '{}'}}]}}]},
    {choices: [{message: {role: 'assistant', content: 'You are connected as alice.'}}]},
  ];
  const seen = [];
  const fetchModel = async (url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify(replies.shift())); };
  const run = new Function('valunTools', 'agent', 'fetch', 'askOwner', 'console', `return (async () => {\n${body}\n})();`);
  const printed = [];
  await run(api.valunTools, w.agent, fetchModel, async () => true, {log: s => printed.push(s)});
  assert.deepEqual(printed, ['You are connected as alice.']);
  assert.equal(seen[0].tools.length, 9);
  assert.equal(seen[0].tools[0].function.name, 'valun_status');
  const toolMsg = seen[1].messages.find(m => m.role === 'tool');
  assert.equal(JSON.parse(toolMsg.content).you.handle, 'alice');
});
