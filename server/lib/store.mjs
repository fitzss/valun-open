// Valun's own records: participants, offers, decisions and issuance evidence.
// The Basis tracker remains the authority for cumulative debt; this store never overrides it.
// state.json is rewritten atomically; audit.jsonl is append-only. Demo-custody keys live in keys/ (never served).
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'keys'), {recursive: true});
    this.file = path.join(dir, 'state.json');
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : {version: 1, createdAt: new Date().toISOString(), seq: 0, participants: {}, offers: {}};
  }
  nextId(prefix) { this.state.seq += 1; return `${prefix}-${String(this.state.seq).padStart(4, '0')}`; }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }
  audit(event) {
    const line = JSON.stringify({at: new Date().toISOString(), ...event});
    fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), line + '\n');
  }
  auditTail(n = 200) {
    const f = path.join(this.dir, 'audit.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map(l => JSON.parse(l));
  }
  putSecret(id, secretHex) {
    fs.writeFileSync(path.join(this.dir, 'keys', `${id}.key`), secretHex, {mode: 0o600, flag: 'wx'});
  }
  getSecret(id) { return fs.readFileSync(path.join(this.dir, 'keys', `${id}.key`), 'utf8').trim(); }
}
