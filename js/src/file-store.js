// Node-only store: one private JSON file holding settings, the agent's credentials and its own record of credit notes
// issued. Same file layout as the Python client's FileStore (state keys plus "secret" and "agent_token" at the top
// level, 1-space indent), so either client can read the other's file. Imported separately ("@fitzdoud/valun/file-store") so
// that browser bundles of the main entry never pull in node:fs.

import fs from 'node:fs';
import path from 'node:path';
import {ValunError} from './errors.js';

const POSIX = process.platform !== 'win32';

export class FileStore {
  #secret = null;
  #token = null;

  /** Loads `filePath` if it exists. Nothing is created until save(). */
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
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
    const dir = path.dirname(path.resolve(this.path));
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const data = {...this.state};
    delete data.secret;
    delete data.agent_token;
    if (this.#secret !== null) data.secret = this.#secret;
    if (this.#token !== null) data.agent_token = this.#token;
    const tmp = `${this.path}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
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
    fs.renameSync(tmp, this.path);
    if (POSIX) {
      try { fs.chmodSync(this.path, 0o600); } catch { /* best effort, as the Python client */ }
    }
  }
}
