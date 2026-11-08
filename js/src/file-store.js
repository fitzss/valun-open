// Node-only store: one private JSON file holding settings, the agent's credentials and its own records of credit notes.
// Same file layout as the Python client's FileStore (state keys plus "secret" and "agent_token" at the top level,
// 1-space indent), so either client can read the other's file. Imported separately ("@fitzdoud/valun/file-store") so
// that browser bundles of the main entry never pull in node:fs.
//
// Several processes may use one profile, and they may be Python and JavaScript ones (an MCP server and a JavaScript
// agent, say). update(fn) changes it as one step they cannot interleave, with the Python FileStore's lock protocol on
// the same files (python/src/valun/client.py FileStore):
//   - the lock is '<path>.lock', created with O_CREAT|O_EXCL; a waiter retries every 5-25 ms (jittered) for at most
//     LOCK_WAIT_MS (5 s), then gives up with profile_busy;
//   - the lock file holds '<pid> <time in s, 3 decimals> <16 random hex>\n', and its holder removes it only while it
//     still holds exactly those bytes (unconditionally if writing them failed);
//   - a lock last modified more than LOCK_STALE_MS (30 s) ago was left by a process that died. Only a waiter holding
//     '<path>.lock.break' (also O_CREAT|O_EXCL) replaces it, after judging its age again under it; a '.break' older than
//     LOCK_STALE_MS was left by a waiter that died and is removed.
// Under the lock, update() reloads the file, applies fn and writes the result atomically.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ValunError} from './errors.js';

const POSIX = process.platform !== 'win32';
// Windows: a file another process is replacing or deleting right now (or has open without FILE_SHARE_DELETE).
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const isBusy = e => !POSIX && BUSY.has(e?.code);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Replace the contents of `target` with those of `source`, keeping the object (callers hold `store.state`). */
function replaceIn(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

export class FileStore {
  /** How long update() waits for another process's lock before profile_busy (Python: LOCK_WAIT_S = 5.0). */
  static LOCK_WAIT_MS = 5000;
  /** A lock older than this was left by a process that died (Python: LOCK_STALE_S = 30.0). */
  static LOCK_STALE_MS = 30_000;

  #secret = null;
  #token = null;

  /** Loads `filePath` if it exists. Nothing is created until save() or update(). */
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('FileStore needs a file path');
    this.path = filePath;
    this.state = {};
    if (!fs.existsSync(filePath)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      // never echo the parser's message: it quotes the file, which holds the key
      throw new ValunError('bad_store', `${filePath} is not a valid Valun state file (not JSON)`);
    }
    if (!isObject(parsed)) {
      throw new ValunError('bad_store', `${filePath} is not a valid Valun state file (not a JSON object)`);
    }
    const {secret = null, agent_token = null, ...state} = parsed;
    this.#secret = secret;
    this.#token = agent_token;
    this.state = state;
    if (POSIX) {
      try {
        if (fs.statSync(filePath).mode & 0o077) fs.chmodSync(filePath, 0o600);   // tighten a file others can read
      } catch { /* best effort */ }
    }
  }

  secret() { return this.#secret; }
  token() { return this.#token; }

  saveCredentials(secretHex, token) {
    this.#secret = secretHex;
    this.#token = token;
    this.save();
  }

  /** Atomic write: a fresh temporary file created with mode 0600 (O_EXCL), then renamed over the state file. */
  save() {
    this.#write(this.state, this.#secret, this.#token);
  }

  /**
   * Under the profile lock: reload the file (another process may have changed it), apply fn(state) and save. fn is
   * synchronous; it gets the non-secret state as it is on disk now and changes it in place. this.state is then updated
   * in place to the saved state (the key and token as on disk too). If fn throws, nothing is saved or changed. Resolves
   * to fn's result. Changes made to this.state without saving are replaced by the file's contents. Rejects with
   * ValunError profile_busy when another process holds the lock for longer than LOCK_WAIT_MS, and records_unreadable
   * when the file exists but cannot be read (it is then never overwritten).
   */
  async update(fn) {
    if (typeof fn !== 'function') throw new TypeError('update(fn) needs a function');
    const release = await this.#lock();
    try {
      const exists = fs.existsSync(this.path);
      const disk = exists ? this.#read() : {state: structuredClone(this.state), secret: this.#secret, token: this.#token};
      const result = fn(disk.state);
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        throw new TypeError('update(fn): fn must be synchronous (it runs while the profile is locked)');
      }
      this.#write(disk.state, disk.secret, disk.token);
      replaceIn(this.state, disk.state);
      this.#secret = disk.secret;
      this.#token = disk.token;
      return result;
    } finally {
      release();
    }
  }

  /** Replace this.state (in place) with the file's current contents, if the file exists (records_unreadable if not readable). */
  reload() {
    if (!fs.existsSync(this.path)) return;
    const disk = this.#read();
    replaceIn(this.state, disk.state);
    this.#secret = disk.secret;
    this.#token = disk.token;
  }

  // ---------- file access ----------
  #readText() {
    for (let attempt = 0; ; attempt++) {
      try {
        return fs.readFileSync(this.path, 'utf8');
      } catch (e) {
        if (!isBusy(e) || attempt === 49) throw e;   // Windows: the file is being replaced by another process right now
        sleepSync(20);
      }
    }
  }

  #read() {
    let parsed;
    try {
      parsed = JSON.parse(this.#readText());
    } catch {                                          // never the parser's message: it quotes the file
      throw new ValunError('records_unreadable', `cannot read the profile ${this.path}; nothing was changed or signed`);
    }
    if (!isObject(parsed)) {
      throw new ValunError('records_unreadable', `the profile ${this.path} is not a JSON object; nothing was changed or signed`);
    }
    const {secret = null, agent_token = null, ...state} = parsed;
    return {state, secret, token: agent_token};
  }

  #write(state, secret, token) {
    const dir = path.dirname(path.resolve(this.path));
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const data = {...state};
    delete data.secret;
    delete data.agent_token;
    if (secret !== null && secret !== undefined) data.secret = secret;
    if (token !== null && token !== undefined) data.agent_token = token;
    // one per write: concurrent writers (in this process or another) never share it
    const tmp = `${this.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      if (POSIX) fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, JSON.stringify(data, null, 1));
      fs.fsyncSync(fd);
    } catch (e) {
      fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw e;
    }
    fs.closeSync(fd);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.path);
        break;
      } catch (e) {
        if (!isBusy(e) || attempt === 99) {             // Windows: another process has the profile open right now
          try { fs.unlinkSync(tmp); } catch { /* already gone */ }
          throw e;
        }
        sleepSync(10);
      }
    }
    if (POSIX) {
      try { fs.chmodSync(this.path, 0o600); } catch { /* best effort, as the Python client */ }
    }
  }

  // ---------- the profile lock (the Python FileStore's protocol) ----------
  /** Wait for the lock; resolves to the function that releases it. */
  async #lock() {
    const lock = this.path + '.lock';
    fs.mkdirSync(path.dirname(path.resolve(this.path)), {recursive: true, mode: 0o700});
    const deadline = performance.now() + this.constructor.LOCK_WAIT_MS;
    let fd;
    for (;;) {
      try {
        fd = fs.openSync(lock, 'wx', 0o600);           // O_CREAT | O_EXCL; Node writes bytes as given (binary)
        break;
      } catch (e) {
        if (e?.code === 'EEXIST') {
          if (this._replaceStale(lock) && performance.now() < deadline) continue;
        } else if (!isBusy(e)) {
          throw e;                                     // e.g. the folder is not writable: say so at once
        }                                              // else (Windows) the holder is deleting the lock right now
      }
      if (performance.now() >= deadline) {
        throw new ValunError('profile_busy', `another Valun process is using the profile ${this.path} (lock file ${lock}); try again`);
      }
      await sleep(5 + Math.random() * 20);
    }
    // this holder's own mark: '<pid> <time> <random>\n', ASCII
    const mark = Buffer.from(`${process.pid} ${(Date.now() / 1000).toFixed(3)} ${crypto.randomBytes(8).toString('hex')}\n`, 'ascii');
    let written;
    try {
      try {
        written = fs.writeSync(fd, mark) === mark.length;
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
      throw e;
    }
    return () => FileStore.#release(lock, written ? mark : null);
  }

  /**
   * Remove the lock, unless it is no longer this holder's: one that held it longer than LOCK_STALE_MS may have been
   * replaced as stale, and the lock file then belongs to another process.
   */
  static #release(lock, mark) {
    if (mark !== null) {
      let held;
      try {
        held = fs.readFileSync(lock);
      } catch {
        return;
      }
      if (!held.equals(mark)) return;
    }
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }

  /**
   * Milliseconds since `p` was last modified; null when it does not exist (or is being deleted right now). Internal (as
   * Python's FileStore._age; tests override it to reproduce races).
   */
  _age(p) {
    try {
      return Date.now() - fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * True when the lock is gone, or was left by a process that died (older than LOCK_STALE_MS) and is now removed.
   * Waiters that find it stale take turns through '<lock>.break' (O_CREAT|O_EXCL) and judge the lock's age again while
   * holding it, so a stale lock is removed once, and a lock that another waiter created after removing it is never
   * removed by mistake. A '.break' older than LOCK_STALE_MS was left by a waiter that died, and is removed. Internal
   * (Python's FileStore._replace_stale).
   */
  _replaceStale(lock) {
    const stale = this.constructor.LOCK_STALE_MS;
    const age = this._age(lock);
    if (age === null) return true;                     // released meanwhile: try again at once
    if (age <= stale) return false;
    const brk = lock + '.break';
    let fd;
    try {
      fd = fs.openSync(brk, 'wx', 0o600);
    } catch {                                          // another waiter is replacing it right now
      const held = this._age(brk);
      if (held !== null && held > stale) {
        try { fs.unlinkSync(brk); } catch { /* already gone */ }
      }
      return false;
    }
    try {
      fs.closeSync(fd);
      const again = this._age(lock);                   // again: the lock may have been replaced since it was judged stale
      if (again !== null && again > stale) fs.unlinkSync(lock);
    } catch {
      // as in Python: an OS error here only means another try
    } finally {
      try { fs.unlinkSync(brk); } catch { /* already gone */ }
    }
    return true;
  }
}
