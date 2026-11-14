// GET /info names the commit the server runs (`build`) when its deploy sets VALUN_BUILD_SHA to a full commit id, so a
// promotion can check that it moves what staging tested; anything else is ignored (no `build`).
import {test} from 'node:test';
import assert from 'node:assert/strict';

test('VALUN_BUILD_SHA: a full commit id is the build; anything else is none', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  process.env.VALUN_BUILD_SHA = sha;
  assert.equal((await import('../lib/pilot/http.mjs?build=1')).BUILD_SHA, sha);
  for (const [i, bad] of ['', 'main', sha.slice(0, 7), sha.toUpperCase(), `${sha}0`].entries()) {
    process.env.VALUN_BUILD_SHA = bad;
    assert.equal((await import(`../lib/pilot/http.mjs?bad=${i}`)).BUILD_SHA, null, JSON.stringify(bad));
  }
  delete process.env.VALUN_BUILD_SHA;
});
