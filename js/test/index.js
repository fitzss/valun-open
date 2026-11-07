// Entry point for `node --test js/test/` (and `npm test`, which runs `node --test test/`).
// Node >= 21 loads a directory argument as a module, which resolves to this file with process.argv[1] = the directory;
// then this file imports every *.test.js here. When a runner discovers this file by itself (Node 18/20 searching the
// directory, or a plain `node --test`), argv[1] is this file's own path and it does nothing, so no test runs twice.
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && path.basename(entry) !== 'index.js' && path.resolve(entry) === path.resolve(here)) {
  for (const f of readdirSync(here).filter(f => f.endsWith('.test.js')).sort()) {
    await import(new URL(f, import.meta.url).href);
  }
}
