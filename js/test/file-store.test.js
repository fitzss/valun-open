// FileStore (Node only): the Python client's file layout, atomic writes with a fresh 0600 file, never echoing the file
// in errors, and a Client round trip. Temporary files live only in js/test/.tmp-* and are removed afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, mock, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client, NETWORK, ValunError, basis, bytesToHex} from '../src/index.js';
import {FileStore} from '../src/file-store.js';
import {fakeFetch, testKey} from './helpers.js';

const TMP = fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-'));
after(() => fs.rmSync(TMP, {recursive: true, force: true}));
const POSIX = process.platform !== 'win32';
const SECRET = bytesToHex(testKey('valun-open/spec/test-key/alice'));
const TOKEN = 'vpa_TEST-ONLY-file-store-token';
let n = 0;
const file = () => path.join(TMP, `p${n++}`, 'state.json');

test('a missing file gives an empty store and creates nothing until save()', () => {
  const p = file();
  const s = new FileStore(p);
  assert.deepEqual(s.state, {});
  assert.equal(s.secret(), null);
  assert.equal(s.token(), null);
  assert.equal(fs.existsSync(path.dirname(p)), false);
});

test('saveCredentials() writes the Python FileStore layout (state keys + secret + agent_token, 1-space indent) and reads back', () => {
  const p = file();
  const s = new FileStore(p);
  s.state.server = 'http://valun.invalid';
  s.state.issued = {'02aa>03bb': 20};
  s.saveCredentials(SECRET, TOKEN);
  const text = fs.readFileSync(p, 'utf8');
  assert.deepEqual(JSON.parse(text), {server: 'http://valun.invalid', issued: {'02aa>03bb': 20}, secret: SECRET, agent_token: TOKEN});
  assert.equal(text, JSON.stringify(JSON.parse(text), null, 1));
  const again = new FileStore(p);
  assert.deepEqual(again.state, {server: 'http://valun.invalid', issued: {'02aa>03bb': 20}});
  assert.equal(again.secret(), SECRET);
  assert.equal(again.token(), TOKEN);
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ['state.json'], 'no temporary file is left behind');
});

test('reads a state file written by the Python client', () => {
  const p = file();
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.writeFileSync(p, JSON.stringify({server: 'http://valun.invalid', participant_id: 'vp_461ce015dd98', pubkey: '035e', network: NETWORK,
    enrolled_at: '2026-11-06T12:06:00.000Z', issued: {}, secret: SECRET, agent_token: TOKEN}, null, 1));
  const s = new FileStore(p);
  assert.equal(s.secret(), SECRET);
  assert.equal(s.token(), TOKEN);
  assert.equal(s.state.participant_id, 'vp_461ce015dd98');
  assert.equal('secret' in s.state, false);
  assert.equal('agent_token' in s.state, false);
});

test('save() creates a fresh temporary file exclusively with mode 0600, then renames it over the state file', () => {
  const p = file();
  const s = new FileStore(p);
  const open = mock.method(fs, 'openSync');
  const rename = mock.method(fs, 'renameSync');
  try {
    s.saveCredentials(SECRET, TOKEN);
    assert.equal(open.mock.calls.length, 1);
    const [tmp, flags, mode] = open.mock.calls[0].arguments;
    assert.equal(flags, 'wx', 'O_CREAT | O_EXCL: never reuses an existing file');
    assert.equal(mode, 0o600);
    assert.equal(path.dirname(tmp), path.dirname(p));
    assert.deepEqual(rename.mock.calls[0].arguments, [tmp, p]);
  } finally {
    open.mock.restore();
    rename.mock.restore();
  }
});

test('the state file is 0600 and its folder 0700 (POSIX)', {skip: !POSIX && 'file modes are not POSIX permissions on Windows'}, () => {
  const p = file();
  new FileStore(p).saveCredentials(SECRET, TOKEN);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700);
  fs.chmodSync(p, 0o644);
  new FileStore(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'a readable file is tightened when loaded');
});

test('a corrupt file is refused without echoing its contents (which hold the key)', () => {
  const p = file();
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.writeFileSync(p, `{"secret": "${SECRET}", "agent_token": "${TOKEN}",`);
  assert.throws(() => new FileStore(p), e => e instanceof ValunError && e.code === 'bad_store' && !e.message.includes(SECRET) && !e.message.includes(TOKEN));
  fs.writeFileSync(p, '[1,2]');
  assert.throws(() => new FileStore(p), e => e.code === 'bad_store');
});

test('Client + FileStore: enroll writes the key and token to the file; a new client on the same file is connected', async () => {
  const p = file();
  const secret = testKey('valun-open/spec/test-key/bob');
  const f = fakeFetch({'POST /pilot/v1/enroll': {status: 201, body: {participant_id: 'vp_9850bb41e214', agent_token: TOKEN, network: NETWORK}}});
  const c = new Client({store: new FileStore(p), server: 'http://valun.invalid', fetch: f, generateSecret: () => secret.slice()});
  await c.enroll('vp_9850bb41e214', 'vpe_TESTONLY');
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(saved.secret, bytesToHex(secret));
  assert.equal(saved.agent_token, TOKEN);
  assert.equal(saved.pubkey, bytesToHex(basis.publicKey(secret)));
  const c2 = new Client({store: new FileStore(p)});
  assert.equal(c2.connected, true);
  assert.equal(c2.pubkey, saved.pubkey);
  assert.equal(c2.state.server, 'http://valun.invalid');
});
