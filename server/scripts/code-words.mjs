// Keeps the flags, handles and placeholders of inline code whole on valun.tech's static pages (lib/code-words.mjs has
// the rule and the list of pages). Run it after editing a page's words; the pages are the source, and this only adds
// <span class="nw"> and <wbr> inside their inline <code>, never changing a character a reader sees or copies.
//
// Usage: node scripts/code-words.mjs                  rewrite the pages of lib/code-words.mjs PAGES
//        node scripts/code-words.mjs --check          exit 1, naming them, if any page is not written so
//        node scripts/code-words.mjs [--check] FILE…  the same for these files (paths, e.g. public/start.html)
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {keepCodeWhole, PAGES} from '../lib/code-words.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), check = args.includes('--check');
const files = args.filter(a => a !== '--check');
const targets = files.length ? files.map(f => path.resolve(f)) : PAGES.map(f => path.join(root, 'public', f));
const stale = [];
for (const f of targets) {
  const html = fs.readFileSync(f, 'utf8'), kept = keepCodeWhole(html);
  if (kept === html) continue;
  stale.push(path.relative(root, f).split(path.sep).join('/'));
  if (!check) fs.writeFileSync(f, kept);
}
if (check && stale.length) {
  console.error(`inline code not kept whole in ${stale.join(', ')}: run node scripts/code-words.mjs ${files.length ? files.join(' ') : ''}`.trim());
  process.exit(1);
}
console.log(stale.length ? `${check ? 'stale' : 'written'}: ${stale.join(', ')}` : 'inline code kept whole: nothing to change');
