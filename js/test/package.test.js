// Packaging: zero dependencies, ESM, the browser entry imports no Node built-in, every runtime export is typed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import * as api from '../src/index.js';
import * as fileStore from '../src/file-store.js';

const root = new URL('../', import.meta.url);
const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('package.json: name, version, ESM, MIT, node >= 18, no dependencies of any kind', () => {
  assert.equal(pkg.name, '@fitzdoud/valun');
  assert.equal(pkg.version, '0.5.2');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.engines.node, '>=18');
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
    assert.ok(!pkg[k] || Object.keys(pkg[k]).length === 0, `no ${k}`);
  }
  assert.equal(pkg.exports['.'].default, './src/index.js');
  assert.equal(pkg.exports['./file-store'].default, './src/file-store.js');
  assert.ok(fs.existsSync(fileURLToPath(new URL('LICENSE', root))));
});

test('the browser entry (src/index.js and everything it imports) uses no Node built-in and no package', () => {
  const seen = new Set();
  const visit = rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = read(rel);
    const specs = [...src.matchAll(/(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] || m[2]);
    for (const s of specs) {
      assert.ok(s.startsWith('./'), `${rel} imports ${s}`);
      visit(`src/${s.slice(2)}`);
    }
    assert.ok(!/['"]node:/.test(src), `${rel} names a node: module`);
  };
  visit('src/index.js');
  assert.ok(seen.has('src/basis.js') && seen.has('src/client.js') && !seen.has('src/file-store.js'));
});

test('every runtime export is declared in the TypeScript types', () => {
  const dts = read('src/index.d.ts');
  for (const name of Object.keys(api)) {
    assert.match(dts, new RegExp(`export (?:class|function|const|namespace|interface|type) ${name}\\b`), `index.d.ts declares ${name}`);
  }
  for (const name of Object.keys(api.basis)) {
    assert.match(dts, new RegExp(`(?:function|const|class) ${name}\\b`), `index.d.ts declares basis.${name}`);
  }
  const nv = dts.slice(dts.indexOf('export namespace novation {'));
  assert.ok(dts.includes('export namespace novation {'), 'index.d.ts declares the novation namespace');
  for (const name of Object.keys(api.novation)) {
    assert.match(nv, new RegExp(`(?:function|const|class) ${name}\\b`), `index.d.ts declares novation.${name}`);
  }
  const fsDts = read('src/file-store.d.ts');
  for (const name of Object.keys(fileStore)) assert.match(fsDts, new RegExp(`export class ${name}\\b`));
});
