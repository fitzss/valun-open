// Staging says it is staging (fix inbox #41). valun-staging runs the testnet's image, so it names the testnet's network
// and its pages look like the network's. With VALUN_ENVIRONMENT=staging (fly.staging.toml) GET /pilot/v1/info says
// `environment: "staging"` and every HTML page the server serves opens with a one-line banner that links to
// https://valun.tech; with any other value, or none (the testnet), neither, and every page is the same bytes as the page
// itself (its file in public/, or what its renderer returns). The value is read once, at start (lib/environment.mjs), so
// the server runs in a child process per value (test/fixtures/staging-pages.mjs), as the testnet image runs it. No
// tracker.
import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The banner, word for word: fixed text and the link, with its own stylesheet (the CSP allows no inline style).
const BANNER = '<link rel="stylesheet" href="/staging.css"><p class="valun-staging">Staging: a test copy of Valun for checking '
  + 'changes before they go live. The network is at <a href="https://valun.tech">https://valun.tech</a></p>';
const bytes = b64 => Buffer.from(b64, 'base64'), text = b64 => bytes(b64).toString('utf8');
const named = p => `${p.host ?? ''}${p.route} (${p.pilot ? 'with' : 'without'} a pilot)`;

// The fixture in a process of its own, on the testnet's network, with VALUN_ENVIRONMENT set to `value` (undefined: unset).
function serve(value) {
  const env = {...process.env, PILOT_NETWORK: 'valun-testnet-1'};
  delete env.VALUN_ENVIRONMENT;
  if (value !== undefined) env.VALUN_ENVIRONMENT = value;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'test', 'fixtures', 'staging-pages.mjs')], {cwd: root, env});
    let out = '', err = '';
    c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('error', reject);
    c.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`staging-pages.mjs exited ${code}: ${err}`))));
  });
}
let runs;
before(async () => {
  const [staging, testnet, other] = await Promise.all([serve('staging'), serve(undefined), serve('Staging')]);
  runs = {staging, testnet, other};
});

test('VALUN_ENVIRONMENT: only the exact value "staging" counts, read once at start; the banner goes right after <body>', async () => {
  const saved = process.env.VALUN_ENVIRONMENT;
  const load = (v, tag) => {
    if (v === undefined) delete process.env.VALUN_ENVIRONMENT; else process.env.VALUN_ENVIRONMENT = v;
    return import(`../lib/environment.mjs?${tag}`);
  };
  try {
    const on = await load('staging', 'on');
    assert.equal(on.ENVIRONMENT, 'staging');
    assert.equal(on.STAGING, true);
    assert.equal(on.STAGING_BANNER, BANNER);
    let off;
    for (const [i, v] of [undefined, '', 'Staging', 'STAGING', ' staging', 'staging ', 'staging\n', 'stage', 'staging2', 'production',
      'testnet', '<b>staging</b>'].entries()) {
      off = await load(v, `off-${i}`);
      assert.equal(off.ENVIRONMENT, null, JSON.stringify(v));
      assert.equal(off.STAGING, false, JSON.stringify(v));
    }
    // After the opening <body> tag, its attributes and all; a Buffer reads as UTF-8; a page with no <body> is left alone.
    const page = '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body class="pilot">\n<main>café → ok</main>\n</body>\n</html>\n';
    const want = page.replace('<body class="pilot">', `<body class="pilot">\n${BANNER}`);
    assert.equal(on.withStagingBanner(page), want);
    assert.equal(on.withStagingBanner(Buffer.from(page)), want);
    assert.equal(on.withStagingBanner('<!doctype html><title>t</title><p>no body tag'), '<!doctype html><title>t</title><p>no body tag');
    // Off staging the page itself comes back: the very same string or Buffer.
    const buf = Buffer.from(page);
    assert.equal(off.withStagingBanner(buf), buf);
    assert.equal(off.withStagingBanner(page), page);
    // Read once: a change after start changes nothing either way.
    process.env.VALUN_ENVIRONMENT = 'staging';
    assert.equal(off.withStagingBanner(page), page);
    delete process.env.VALUN_ENVIRONMENT;
    assert.equal(on.withStagingBanner(page), want);
  } finally {
    if (saved === undefined) delete process.env.VALUN_ENVIRONMENT; else process.env.VALUN_ENVIRONMENT = saved;
  }
});

test('staging: GET /pilot/v1/info says environment: "staging", next to the network it copies; nothing else in it changes', () => {
  const {environment, info} = runs.staging;
  assert.equal(environment, 'staging');
  assert.equal(info.environment, 'staging');
  assert.equal(info.network, 'valun-testnet-1');
  assert.deepEqual(Object.keys(info).slice(0, 2), ['network', 'environment']);
  const {environment: _, ...rest} = info;
  assert.deepEqual(rest, runs.testnet.info);
});

test('staging: every HTML page opens with the banner, which links to https://valun.tech; nothing else changes', () => {
  assert.ok(!BANNER.includes('\n'), 'one line');
  assert.ok(BANNER.includes('<a href="https://valun.tech">https://valun.tech</a>'), 'the link to the network');
  assert.doesNotMatch(BANNER, /<style\b|<script\b|\sstyle=|\son[a-z]+=|javascript:/i, 'no inline style or script (the CSP allows none)');
  const {pages} = runs.staging;
  assert.equal(pages.length, runs.testnet.pages.length);
  pages.forEach((p, i) => {
    const t = runs.testnet.pages[i];
    assert.match(p.type, /^text\/html/, named(p));
    assert.deepEqual([p.status, p.type, p.csp], [t.status, t.type, t.csp], `${named(p)}: the testnet's status and headers`);
    const page = text(p.page), open = /<body\b[^>]*>/i.exec(page);
    assert.ok(open, `${named(p)}: has a <body> tag`);
    const at = open.index + open[0].length;
    assert.equal(text(p.body), `${page.slice(0, at)}\n${BANNER}${page.slice(at)}`, `${named(p)}: the page with the banner right after <body>`);
  });
  // Every HTML file of public/ is among the pages checked (a new one is added to test/fixtures/staging-pages.mjs).
  const checked = new Set(pages.map(p => p.file).filter(Boolean));
  for (const f of fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html'))) assert.ok(checked.has(f), `public/${f}`);
  // The banner's stylesheet, from 'self' as the CSP wants, served on staging; in the flow, so it covers nothing.
  const css = fs.readFileSync(path.join(root, 'public', 'staging.css'));
  assert.equal(runs.staging.css.status, 200);
  assert.equal(runs.staging.css.type, 'text/css; charset=utf-8');
  assert.ok(bytes(runs.staging.css.body).equals(css));
  assert.doesNotMatch(css.toString('utf8'), /position\s*:\s*(fixed|absolute|sticky)|url\(|@import/i);
});

test('the testnet (VALUN_ENVIRONMENT unset) and any other value: no environment, no banner, every page the same bytes', () => {
  for (const [name, run] of [['unset', runs.testnet], ['"Staging"', runs.other]]) {
    assert.equal(run.environment, null, name);
    assert.equal(run.info.network, 'valun-testnet-1', name);
    assert.ok(!Object.hasOwn(run.info, 'environment'), `${name}: no environment in /info`);
    assert.equal(run.pages.length, runs.staging.pages.length, name);
    for (const p of run.pages) {
      assert.match(p.type, /^text\/html/, `${name} ${named(p)}`);
      assert.ok(bytes(p.body).equals(bytes(p.page)), `${name} ${named(p)}: the same bytes as the page itself`);
      assert.doesNotMatch(text(p.body), /valun-staging|\/staging\.css/, `${name} ${named(p)}: no banner`);
    }
    assert.equal(run.css.status, 404, `${name}: no /staging.css`);
  }
  assert.deepEqual(runs.other.info, runs.testnet.info, 'any other value: the testnet\'s /info');
});
