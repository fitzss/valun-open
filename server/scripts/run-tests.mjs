// The one test list, for `npm test` and the container rehearsal: every test/*.test.mjs except the opt-in ones, run by
// `node --test` in file-name order. Arguments are passed on to node --test (for example --test-concurrency=1).
// Opt-in, not listed: soak.test.mjs (a long seeded property test) and tracker-compat.test.mjs (needs VALUN_OLD_BINS and
// VALUN_NEW_BINS). Run those with node --test test/<file> directly.
// Usage: node scripts/run-tests.mjs [node --test options]
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPT_IN = new Set(['soak.test.mjs', 'tracker-compat.test.mjs']);
const files = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs') && !OPT_IN.has(f)).sort();
if (!files.length) { console.error('run-tests: no test files found in test/'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files.map(f => `test/${f}`)], {cwd: root, stdio: 'inherit'});
if (r.error) { console.error(`run-tests: could not run node --test: ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
